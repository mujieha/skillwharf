#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { ADAPTERS, ALL_AGENTS, DEFAULT_AGENTS, groupLabel, isAgentId, targetGroups } from "./agents.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, isDir, type SizeLimits } from "./fs.js";
import {
  MANIFEST,
  emptyManifest,
  loadLock,
  loadManifest,
  makeContext,
  manifestPath,
  requireManifest,
  saveManifest,
  storePath,
  validateManifest,
} from "./manifest.js";
import { addFromRegistry, addSkill, agentsFor, doctor, removeSkill, syncSkills, updateSkills } from "./ops.js";
import {
  addRegistry,
  configuredRegistries,
  isRegistryName,
  loadRegistries,
  publishToRegistry,
  removeRegistry,
  searchRegistries,
} from "./registry.js";
import { readSkill } from "./skill.js";
import { parseSource } from "./source.js";
import type { AgentId, Context, Manifest } from "./types.js";
import { daysAgo, scanClaudeUsage } from "./usage.js";
import { sanitizeForTerminal, toSafeJson } from "./validate.js";
import { REGISTRY_HELP, SOURCES_BLOCK, afterSearch, showHintOnce, usesDefaultOnly } from "./hints.js";

const VERSION = "0.2.0";

const program = new Command()
  .name("skillwharf")
  .description("skillwharf — install, version, sync and track agent skills across Claude Code, Codex, Cursor and more")
  .version(VERSION)
  .option("-g, --global", "operate on ~/.skillwharf instead of the current project")
  .option("--json", "machine-readable output where supported")
  .option("--quiet", "do not print the one-time hint about sources and registries")
  .option("--git-timeout <seconds>", "kill a git call that runs longer than this (default 120)")
  .addHelpText("after", `\nWhere skills come from:\n${indent(SOURCES_BLOCK)}\n`);

/** Two spaces in front of every line, for help text. */
function indent(text: string): string {
  return text.split("\n").map((l) => `  ${l}`).join("\n");
}

function ctxFrom(cmd: Command): Context {
  const opts = cmd.optsWithGlobals() as { global?: boolean };
  return makeContext({ global: opts.global });
}

/** `--git-timeout <seconds>` as milliseconds, or undefined for the default. */
function gitTimeoutMs(cmd: Command): number | undefined {
  const raw = (cmd.optsWithGlobals() as { gitTimeout?: string }).gitTimeout;
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds <= 0) fail(`--git-timeout takes a positive number of seconds, got "${raw}"`);
  return Math.round(seconds * 1000);
}

function parseAgents(s: string | undefined): AgentId[] | undefined {
  if (!s) return undefined;
  const ids = s.split(",").map((x) => x.trim()).filter(Boolean);
  for (const id of ids) if (!isAgentId(id)) fail(`Unknown agent "${id}". Known: ${ALL_AGENTS.join(", ")}`);
  return ids as AgentId[];
}

/** `--max-skill-size <mb>` and `--max-skill-files <n>` as the size cap ops expects. */
function parseLimits(o: { maxSkillSize?: string; maxSkillFiles?: string }): SizeLimits | undefined {
  const limits: SizeLimits = {};
  if (o.maxSkillSize !== undefined) {
    const mb = Number(o.maxSkillSize);
    if (!Number.isFinite(mb) || mb <= 0) fail(`--max-skill-size takes a positive number of megabytes, got "${o.maxSkillSize}"`);
    limits.maxBytes = Math.floor(mb * 1024 * 1024);
  }
  if (o.maxSkillFiles !== undefined) {
    const n = Number(o.maxSkillFiles);
    if (!Number.isInteger(n) || n <= 0) fail(`--max-skill-files takes a positive whole number, got "${o.maxSkillFiles}"`);
    limits.maxFiles = n;
  }
  return Object.keys(limits).length > 0 ? limits : undefined;
}

function fail(msg: string): never {
  console.error(pc.red("error:"), clean(msg));
  process.exit(1);
}

/** Shorthand: every string that came from a manifest, lock, registry, SKILL.md or log goes through this before printing. */
const clean = (s: string | undefined): string => sanitizeForTerminal(s ?? "");

function rel(ctx: Context, p: string): string {
  const r = path.relative(ctx.global ? ctx.home : ctx.root, p);
  return r.startsWith("..") ? p : ctx.global ? `~/${r}` : r;
}

function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  const widths = all[0].map((_, i) => Math.max(...all.map((r) => stripAnsi(r[i] ?? "").length)));
  const fmt = (r: string[]) => r.map((c, i) => c + " ".repeat(widths[i] - stripAnsi(c).length)).join("  ");
  const lines = all.map(fmt);
  if (header) lines.splice(1, 0, widths.map((w) => "─".repeat(w)).join("  "));
  return lines.join("\n");
}
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * `--registry` values for `init`. One bare location is written as the 0.1.x
 * `registry` field (so the manifest is the one 0.1.x wrote); anything named, or
 * more than one, goes into `registries`. `name=` counts only when what comes
 * before the first `=` is a registry name, so a URL with `?a=b` stays a location.
 */
function registriesFromFlags(specs: string[]): Pick<Manifest, "registry" | "registries"> {
  if (specs.length === 0) return {};
  const parsed = specs.map((s) => {
    const eq = s.indexOf("=");
    if (eq > 0 && /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/.test(s.slice(0, eq)) && s.length > eq + 1) {
      return { name: s.slice(0, eq) as string | undefined, location: s.slice(eq + 1) };
    }
    return { name: undefined as string | undefined, location: s };
  });
  if (parsed.length === 1 && parsed[0].name === undefined) return { registry: parsed[0].location };
  if (parsed.filter((p) => p.name === undefined).length > 1) {
    fail("with more than one --registry, give each a name: --registry name=location");
  }
  return { registries: parsed.map((p) => ({ name: p.name ?? "registry", location: p.location })) };
}

// ---------------------------------------------------------------- init
program
  .command("init")
  .description(`create ${MANIFEST} (default agents: ${DEFAULT_AGENTS.join(",")} — covers Claude Code, Codex and Cursor)`)
  .option("-a, --agents <list>", "comma-separated agents: " + ALL_AGENTS.join(","))
  .option(
    "--registry <spec>",
    "a registry for this project: <location>, or <name>=<location>; repeat for several. A location is an https index URL, a git source or a local path",
    (value: string, previous: string[]) => [...previous, value],
    [] as string[],
  )
  .action((opts: { agents?: string; registry: string[] }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    if (loadManifest(ctx)) fail(`${rel(ctx, manifestPath(ctx))} already exists`);
    const agents = parseAgents(opts.agents) ?? [...DEFAULT_AGENTS];
    const m = emptyManifest(agents);
    Object.assign(m, registriesFromFlags(opts.registry));
    try {
      validateManifest(m, MANIFEST);
    } catch (e) {
      fail((e as Error).message);
    }
    fs.mkdirSync(ctx.root, { recursive: true });
    saveManifest(ctx, m);
    console.log(pc.green("✔"), `created ${rel(ctx, manifestPath(ctx))}`);
    console.log("  agents:", agents.map((a) => `${a} (${ADAPTERS[a].label})`).join(", "));
    console.log(pc.dim(`  next: skillwharf add github:owner/repo/path-to-skill`));
    showHintOnce(ctx.home, { quiet: (cmd.optsWithGlobals() as { quiet?: boolean }).quiet });
  });

// ---------------------------------------------------------------- add
interface AddCliOptions {
  name?: string;
  agents?: string;
  all?: boolean;
  from?: string;
  force?: boolean;
  maxSkillSize?: string;
  maxSkillFiles?: string;
}

program
  .command("add <source>")
  .description(
    "install a skill by registry name, or from github:owner/repo[//dir][@ref], gitlab:group/repo//dir, bitbucket:owner/repo//dir, git+https://host/repo.git//dir, git+ssh://git@host/repo.git//dir, a web URL, or a local path",
  )
  .option("-n, --name <name>", "override the skill name")
  .option("-a, --agents <list>", "only link into these agents")
  .option("--all", "install every skill found in the source")
  .option("--from <registry>", "with a skill name: take it from this registry (needed when two registries list the name)")
  .option("--force", "replace agent files that skillwharf did not create")
  .option("--max-skill-size <mb>", `refuse a skill folder over this many megabytes (default ${DEFAULT_MAX_BYTES / 1024 / 1024})`)
  .option("--max-skill-files <n>", `refuse a skill folder with more than this many files and folders (default ${DEFAULT_MAX_FILES})`)
  .action(async (source: string, opts: AddCliOptions, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const timeout = gitTimeoutMs(cmd);
    try {
      const byName = isRegistryName(source);
      if (opts.from !== undefined && !byName) fail("--from is for a skill name (skillwharf add <name> --from <registry>), not a source");
      const addOpts = {
        name: opts.name,
        agents: parseAgents(opts.agents),
        all: opts.all,
        force: opts.force,
        limits: parseLimits(opts),
        gitTimeoutMs: timeout,
        onSkipped: (s: { dir: string; reason: string }) => console.log(pc.yellow("!"), `skipped ${clean(s.dir)}: ${clean(s.reason)}`),
      };
      const added = byName
        ? await addFromRegistry(ctx, source, { ...addOpts, from: opts.from, onWarning: (w) => console.error(pc.yellow("!"), clean(w)) })
        : addSkill(ctx, source, addOpts);
      for (const a of added) {
        console.log(pc.green("✔"), pc.bold(a.name), a.meta.version ? pc.dim(`v${clean(a.meta.version)}`) : "", pc.dim(clean(a.lock.resolved)));
        for (const l of a.links) {
          if (l.mode === "skipped") continue;
          console.log(`   ${groupLabel(l.agents).padEnd(12)} ${pc.dim(l.mode.padEnd(8))} ${clean(rel(ctx, l.target))}`);
        }
        if (a.skippedSymlinks.length) {
          console.log(pc.yellow("   !"), `skipped ${a.skippedSymlinks.length} symlink(s) in source: ${clean(a.skippedSymlinks.slice(0, 3).join(", "))}${a.skippedSymlinks.length > 3 ? ", …" : ""}`);
        }
      }
    } catch (e) {
      fail((e as Error).message);
    }
  });

// ---------------------------------------------------------------- remove
program
  .command("remove <name>")
  .alias("rm")
  .description("unlink a skill from all agents and delete it from the store")
  .action((name: string, _opts: unknown, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    try {
      const r = removeSkill(ctx, name);
      if (!r.existed) console.log(pc.yellow("!"), `${name} was not in the manifest; cleaned up anyway`);
      const unlinked = r.removed.map((g) => groupLabel(g.agents)).join(", ");
      console.log(pc.green("✔"), `removed ${name}`, unlinked ? pc.dim(`(unlinked: ${unlinked})`) : "");
    } catch (e) {
      fail((e as Error).message);
    }
  });

// ---------------------------------------------------------------- sync
program
  .command("sync")
  .description("make the store and every agent directory match the manifest")
  .option("--force", "replace agent files that skillwharf did not create")
  .option(
    "--allow-unpinned",
    "install what the lockfile cannot verify: the manifest source if a pinned commit cannot be fetched, or the pinned commit unchecked if its entry has no integrity hash",
  )
  .option("--allow-outside-paths", "accept path: sources that resolve outside the project")
  .option("--max-skill-size <mb>", `refuse a skill folder over this many megabytes (default ${DEFAULT_MAX_BYTES / 1024 / 1024})`)
  .option("--max-skill-files <n>", `refuse a skill folder with more than this many files and folders (default ${DEFAULT_MAX_FILES})`)
  .action((opts: { force?: boolean; allowUnpinned?: boolean; allowOutsidePaths?: boolean; maxSkillSize?: string; maxSkillFiles?: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const timeout = gitTimeoutMs(cmd);
    try {
      const r = syncSkills(ctx, {
        force: opts.force,
        allowUnpinned: opts.allowUnpinned,
        allowOutsidePaths: opts.allowOutsidePaths,
        limits: parseLimits(opts),
        gitTimeoutMs: timeout,
      });
      for (const n of r.fetched) console.log(pc.green("✔"), "fetched", pc.bold(n));
      for (const l of r.linked) console.log(pc.green("✔"), "linked ", pc.bold(l.name), pc.dim(`→ ${groupLabel(l.link.agents)} (${l.link.mode})`));
      if (r.fetched.length + r.linked.length === 0) console.log(pc.green("✔"), `everything in sync (${r.unchanged.length} skills)`);
    } catch (e) {
      fail((e as Error).message);
    }
  });

// ---------------------------------------------------------------- update
program
  .command("update [names...]")
  .description("re-fetch skills from their sources and refresh the lockfile (--source: the repository moved, point one skill at its new home)")
  .option("--source <source>", "replace the source of the one named skill (a repository that moved) and re-pin it")
  .option("--allow-outside-paths", "accept path: sources that resolve outside the project")
  .option("--max-skill-size <mb>", `refuse a skill folder over this many megabytes (default ${DEFAULT_MAX_BYTES / 1024 / 1024})`)
  .option("--max-skill-files <n>", `refuse a skill folder with more than this many files and folders (default ${DEFAULT_MAX_FILES})`)
  .action((names: string[], opts: { source?: string; allowOutsidePaths?: boolean; maxSkillSize?: string; maxSkillFiles?: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const timeout = gitTimeoutMs(cmd);
    try {
      const res = updateSkills(ctx, names, {
        source: opts.source,
        allowOutsidePaths: opts.allowOutsidePaths,
        limits: parseLimits(opts),
        gitTimeoutMs: timeout,
      });
      for (const r of res) {
        console.log(r.changed ? pc.green("↑") : pc.dim("="), pc.bold(r.name), r.changed ? "updated" : pc.dim("unchanged"));
      }
      if (res.length === 0) console.log(pc.dim("no skills in manifest"));
    } catch (e) {
      fail((e as Error).message);
    }
  });

// ---------------------------------------------------------------- list
program
  .command("list")
  .alias("ls")
  .description("show installed skills, sources, agents and last use")
  .option("--days <n>", "usage window in days", "90")
  .action(async (opts: { days: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const m = requireManifest(ctx);
    const lock = loadLock(ctx);
    const gopts = cmd.optsWithGlobals() as { json?: boolean };
    const since = new Date(Date.now() - Number(opts.days) * 86_400_000);
    const usage = await scanClaudeUsage({ home: ctx.home, since, project: ctx.global ? undefined : ctx.root });

    const rows = Object.keys(m.skills).map((name) => {
      const entry = lock.skills[name];
      const store = storePath(ctx, name);
      let version = entry?.version;
      let description = "";
      if (isDir(store)) {
        try {
          const meta = readSkill(store);
          version = version ?? meta.version;
          description = meta.description;
        } catch {
          /* ignore */
        }
      }
      const u = usage.get(name);
      return {
        name,
        version: version ?? "",
        source: m.skills[name].source,
        resolved: entry?.resolved ?? "",
        agents: agentsFor(m, name),
        uses: u?.count ?? 0,
        lastUsed: u?.lastUsed?.toISOString(),
        description,
        installed: isDir(store),
      };
    });

    if (gopts.json) {
      console.log(toSafeJson(rows));
      return;
    }
    if (rows.length === 0) {
      console.log(pc.dim(`no skills yet — try: skillwharf add github:owner/repo/path`));
      return;
    }
    console.log(
      table(
        rows.map((r) => [
          r.installed ? pc.bold(r.name) : pc.red(r.name),
          r.version ? `v${clean(r.version)}` : pc.dim("-"),
          r.agents.join(","),
          r.uses ? String(r.uses) : pc.dim("0"),
          r.lastUsed ? `${daysAgo(new Date(r.lastUsed))}d ago` : pc.dim("never"),
          pc.dim(shorten(clean(r.source), 48)),
        ]),
        ["skill", "version", "agents", `uses/${opts.days}d`, "last used", "source"],
      ),
    );
  });

function shorten(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// ---------------------------------------------------------------- usage
program
  .command("usage")
  .description("which skills actually fire (from Claude Code session logs)")
  .option("--days <n>", "window in days", "30")
  .option("--all-projects", "include sessions from every project, not just this one")
  .action(async (opts: { days: string; allProjects?: boolean }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const gopts = cmd.optsWithGlobals() as { json?: boolean };
    const since = new Date(Date.now() - Number(opts.days) * 86_400_000);
    const usage = await scanClaudeUsage({
      home: ctx.home,
      since,
      project: ctx.global || opts.allProjects ? undefined : ctx.root,
    });
    const m = loadManifest(ctx);
    const managed = new Set(Object.keys(m?.skills ?? {}));
    const rows = [...usage.values()].sort((a, b) => b.count - a.count);
    const never = [...managed].filter((n) => !usage.has(n));

    if (gopts.json) {
      console.log(
        toSafeJson({
          days: Number(opts.days),
          used: rows.map((r) => ({ skill: r.skill, count: r.count, lastUsed: r.lastUsed, projects: [...r.projects] })),
          neverUsed: never,
        }),
      );
      return;
    }
    if (rows.length === 0) {
      console.log(pc.dim(`no skill invocations found in the last ${opts.days} days (looked in ~/.claude/projects)`));
    } else {
      console.log(
        table(
          rows.map((r) => [
            managed.has(r.skill) ? pc.bold(r.skill) : clean(r.skill),
            String(r.count),
            r.lastUsed ? `${daysAgo(r.lastUsed)}d ago` : pc.dim("?"),
            String(r.projects.size),
            managed.has(r.skill) ? pc.green("managed") : pc.dim("unmanaged"),
          ]),
          ["skill", `uses/${opts.days}d`, "last used", "projects", "status"],
        ),
      );
    }
    if (never.length) {
      console.log();
      console.log(pc.yellow(`never used in ${opts.days} days:`), never.join(", "));
    }
  });

// ---------------------------------------------------------------- doctor
program
  .command("doctor")
  .description("check for broken links, drift and stale skills")
  .option("--stale-days <n>", "flag managed skills unused for this many days", "60")
  .action(async (opts: { staleDays: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    let issues;
    try {
      issues = doctor(ctx);
    } catch (e) {
      fail((e as Error).message);
    }
    const m = requireManifest(ctx);
    const stale = Number(opts.staleDays);
    const usage = await scanClaudeUsage({
      home: ctx.home,
      since: new Date(Date.now() - stale * 86_400_000),
      project: ctx.global ? undefined : ctx.root,
    });
    for (const name of Object.keys(m.skills)) {
      if (!usage.has(name)) issues.push({ level: "warn", skill: name, message: `not used in ${stale} days`, fix: `skillwharf remove ${name}` });
    }
    if (issues.length === 0) {
      console.log(pc.green("✔"), "no problems found");
    }
    for (const i of issues) {
      const tag = i.level === "error" ? pc.red("✖") : pc.yellow("!");
      console.log(tag, i.skill ? pc.bold(i.skill) : "", i.agents ? pc.dim(`[${groupLabel(i.agents)}]`) : "", clean(i.message), i.fix ? pc.dim(`→ ${clean(i.fix)}`) : "");
    }
    // Information, not a problem: it never counts as an issue or changes the exit code.
    if (usesDefaultOnly(configuredRegistries(ctx))) {
      console.log(pc.dim("i registries: only the public registry is configured; to use your own, run `skillwharf registry help`"));
    }
    if (issues.some((i) => i.level === "error")) process.exitCode = 1;
  });

// ---------------------------------------------------------------- search
program
  .command("search <query...>")
  .description("search the registries the manifest lists (default: the public index); results name their registry")
  .option("--registry <url|path>", "search only this registry: an index URL, a git source, an index.json or a directory containing one")
  .action(async (query: string[], opts: { registry?: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const gopts = cmd.optsWithGlobals() as { json?: boolean };
    const timeout = gitTimeoutMs(cmd);
    try {
      const registries = await loadRegistries(ctx, {
        only: opts.registry ? [{ name: "registry", location: opts.registry }] : undefined,
        timeoutMs: timeout,
      });
      for (const r of registries) if (r.error !== undefined) console.error(pc.yellow("!"), `registry ${clean(r.name)}: ${clean(r.error)}`);
      if (registries.length > 0 && registries.every((r) => r.error !== undefined)) fail("no registry could be loaded");
      const hits = searchRegistries(registries, query.join(" "));
      const several = registries.length > 1;
      if (gopts.json) {
        console.log(toSafeJson(hits));
      } else if (hits.length === 0) {
        console.log(pc.dim(`no matches in ${registries.filter((r) => r.index).map((r) => clean(r.name)).join(", ") || "any registry"}`));
      } else {
        console.log(
          table(
            hits.slice(0, 20).map((h) => [
              pc.bold(clean(h.name)),
              ...(several ? [clean(h.registry)] : []),
              shorten(clean(h.description), 60),
              pc.dim(clean(h.source)),
            ]),
            ["skill", ...(several ? ["registry"] : []), "description", "install with: skillwharf add <source>"],
          ),
        );
      }
      // The first search that used the public registry alone: say once that registries are yours to own.
      afterSearch(opts.registry ? [] : registries, { quiet: (cmd.optsWithGlobals() as { quiet?: boolean }).quiet, json: gopts.json }, ctx.home);
    } catch (e) {
      fail((e as Error).message);
    }
  });

// ---------------------------------------------------------------- registry
const registryCmd = program
  .command("registry")
  .description("manage the registries this project searches (add, remove, list); `registry help` explains how to run your own")
  .addHelpCommand(false)
  .addHelpText("after", `\nWhere skills come from:\n${indent(SOURCES_BLOCK)}\n`);

registryCmd
  .command("help")
  .description("the walk-through: where skills come from and how to run a registry of your own")
  .action(() => {
    console.log(REGISTRY_HELP.trimEnd());
  });

registryCmd
  .command("add <name> <location>")
  .description("add a registry: an https index URL, a git source whose repository root holds index.json, or a local path")
  .action(async (name: string, location: string, _opts: unknown, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    try {
      const r = await addRegistry(ctx, name, location, { timeoutMs: gitTimeoutMs(cmd) });
      console.log(pc.green("✔"), `added registry ${pc.bold(clean(name))}`, pc.dim(`(${r.entries} skills)`));
    } catch (e) {
      fail((e as Error).message);
    }
  });

registryCmd
  .command("remove <name>")
  .alias("rm")
  .description("remove a registry from the manifest")
  .action((name: string, _opts: unknown, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    try {
      removeRegistry(ctx, name);
      console.log(pc.green("✔"), `removed registry ${pc.bold(clean(name))}`);
    } catch (e) {
      fail((e as Error).message);
    }
  });

registryCmd
  .command("list")
  .alias("ls")
  .description("show each registry with where it is, how many skills it lists, and whether it loaded")
  .action(async (_opts: unknown, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const gopts = cmd.optsWithGlobals() as { json?: boolean };
    try {
      const registries = await loadRegistries(ctx, { timeoutMs: gitTimeoutMs(cmd) });
      if (gopts.json) {
        return console.log(
          toSafeJson(
            registries.map((r) => ({
              name: r.name,
              location: r.location,
              scope: r.scope,
              entries: r.index ? r.index.skills.length : null,
              status: r.index ? "loaded" : "failed",
              ...(r.error !== undefined ? { error: r.error } : {}),
            })),
          ),
        );
      }
      if (registries.length === 0) return console.log(pc.dim("no registries listed; add one with: skillwharf registry add <name> <location>"));
      console.log(
        table(
          registries.map((r) => [
            pc.bold(clean(r.name)),
            clean(r.location),
            r.index ? String(r.index.skills.length) : pc.dim("-"),
            r.index ? pc.green("loaded") : pc.red(clean(r.error ?? "failed")),
          ]),
          ["name", "location", "skills", "status"],
        ),
      );
    } catch (e) {
      fail((e as Error).message);
    }
  });

// ---------------------------------------------------------------- publish
program
  .command("publish <skillPath>")
  .description("add or update a skill entry in a local registry checkout (then commit and push it)")
  .requiredOption("--registry <dir>", "local checkout of the registry repo")
  .requiredOption("--source <source>", "where the skill is installed from, on any git host: github:owner/repo/path, gitlab:group/repo//path, git+https://host/repo.git//path")
  .option("--tags <list>", "comma-separated tags")
  .action((skillPath: string, opts: { registry: string; source: string; tags?: string }) => {
    try {
      const dir = path.resolve(skillPath);
      const meta = readSkill(dir);
      if (parseSource(opts.source).kind !== "git") {
        throw new Error("a registry entry must be a git source (github:, gitlab:, bitbucket:, git+https:// or git+ssh://), not a local path");
      }
      const r = publishToRegistry(path.resolve(opts.registry), {
        name: meta.name,
        description: meta.description,
        source: opts.source,
        version: meta.version,
        tags: opts.tags ? opts.tags.split(",").map((t) => t.trim()).filter(Boolean) : undefined,
      });
      console.log(pc.green("✔"), r.created ? "added" : "updated", pc.bold(clean(meta.name)), "in", clean(r.file));
      console.log(pc.dim(`  next: cd ${clean(opts.registry)} && git add index.json && git commit -m "publish ${clean(meta.name)}" && git push`));
    } catch (e) {
      fail((e as Error).message);
    }
  });

// ---------------------------------------------------------------- where
program
  .command("where <name>")
  .description("print the store path and every agent path for a skill")
  .action((name: string, _o: unknown, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const m = requireManifest(ctx);
    const groups = targetGroups(ctx, m, agentsFor(m, name), name);
    const width = Math.max(5, ...groups.map((g) => groupLabel(g.agents).length));
    // Paths come from the manifest (agentPaths) and from folder names: print them sanitised.
    console.log("store".padEnd(width), clean(storePath(ctx, name)));
    for (const g of groups) console.log(groupLabel(g.agents).padEnd(width), clean(g.target));
  });

program.parseAsync(process.argv).catch((e: Error) => fail(e.message));
