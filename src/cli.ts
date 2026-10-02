#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import pc from "picocolors";
import { ADAPTERS, ALL_AGENTS, DEFAULT_AGENTS, groupLabel, isAgentId, targetGroups } from "./agents.js";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, isDir, type SizeLimits } from "./fs.js";
import {
  DEFAULT_REGISTRY,
  MANIFEST,
  emptyManifest,
  loadLock,
  loadManifest,
  makeContext,
  manifestPath,
  requireManifest,
  saveManifest,
  storePath,
} from "./manifest.js";
import { addSkill, agentsFor, doctor, removeSkill, syncSkills, updateSkills } from "./ops.js";
import { loadRegistry, publishToRegistry, searchRegistry } from "./registry.js";
import { readSkill } from "./skill.js";
import { parseSource } from "./source.js";
import type { AgentId, Context } from "./types.js";
import { daysAgo, scanClaudeUsage } from "./usage.js";
import { sanitizeForTerminal, toSafeJson } from "./validate.js";

const VERSION = "0.1.2";

const program = new Command()
  .name("skillwharf")
  .description("skillwharf — install, version, sync and track agent skills across Claude Code, Codex, Cursor and more")
  .version(VERSION)
  .option("-g, --global", "operate on ~/.skillwharf instead of the current project")
  .option("--json", "machine-readable output where supported")
  .option("--git-timeout <seconds>", "kill a git call that runs longer than this (default 120)");

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

// ---------------------------------------------------------------- init
program
  .command("init")
  .description(`create ${MANIFEST} (default agents: ${DEFAULT_AGENTS.join(",")} — covers Claude Code, Codex and Cursor)`)
  .option("-a, --agents <list>", "comma-separated agents: " + ALL_AGENTS.join(","))
  .option("--registry <url>", "default registry index URL")
  .action((opts: { agents?: string; registry?: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    if (loadManifest(ctx)) fail(`${rel(ctx, manifestPath(ctx))} already exists`);
    const agents = parseAgents(opts.agents) ?? [...DEFAULT_AGENTS];
    const m = emptyManifest(agents);
    if (opts.registry) m.registry = opts.registry;
    fs.mkdirSync(ctx.root, { recursive: true });
    saveManifest(ctx, m);
    console.log(pc.green("✔"), `created ${rel(ctx, manifestPath(ctx))}`);
    console.log("  agents:", agents.map((a) => `${a} (${ADAPTERS[a].label})`).join(", "));
    console.log(pc.dim(`  next: skillwharf add github:owner/repo/path-to-skill`));
  });

// ---------------------------------------------------------------- add
interface AddCliOptions {
  name?: string;
  agents?: string;
  all?: boolean;
  force?: boolean;
  maxSkillSize?: string;
  maxSkillFiles?: string;
}

program
  .command("add <source>")
  .description("install a skill from github:owner/repo[/path][@ref], a GitHub URL, or a local path")
  .option("-n, --name <name>", "override the skill name")
  .option("-a, --agents <list>", "only link into these agents")
  .option("--all", "install every skill found in the source")
  .option("--force", "replace agent files that skillwharf did not create")
  .option("--max-skill-size <mb>", `refuse a skill folder over this many megabytes (default ${DEFAULT_MAX_BYTES / 1024 / 1024})`)
  .option("--max-skill-files <n>", `refuse a skill folder with more than this many files and folders (default ${DEFAULT_MAX_FILES})`)
  .action((source: string, opts: AddCliOptions, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const timeout = gitTimeoutMs(cmd);
    try {
      const added = addSkill(ctx, source, {
        name: opts.name,
        agents: parseAgents(opts.agents),
        all: opts.all,
        force: opts.force,
        limits: parseLimits(opts),
        gitTimeoutMs: timeout,
        onSkipped: (s) => console.log(pc.yellow("!"), `skipped ${clean(s.dir)}: ${clean(s.reason)}`),
      });
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
  .description("re-fetch skills from their sources and refresh the lockfile")
  .option("--allow-outside-paths", "accept path: sources that resolve outside the project")
  .option("--max-skill-size <mb>", `refuse a skill folder over this many megabytes (default ${DEFAULT_MAX_BYTES / 1024 / 1024})`)
  .option("--max-skill-files <n>", `refuse a skill folder with more than this many files and folders (default ${DEFAULT_MAX_FILES})`)
  .action((names: string[], opts: { allowOutsidePaths?: boolean; maxSkillSize?: string; maxSkillFiles?: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const timeout = gitTimeoutMs(cmd);
    try {
      const res = updateSkills(ctx, names, { allowOutsidePaths: opts.allowOutsidePaths, limits: parseLimits(opts), gitTimeoutMs: timeout });
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
      return;
    }
    for (const i of issues) {
      const tag = i.level === "error" ? pc.red("✖") : pc.yellow("!");
      console.log(tag, i.skill ? pc.bold(i.skill) : "", i.agents ? pc.dim(`[${groupLabel(i.agents)}]`) : "", clean(i.message), i.fix ? pc.dim(`→ ${clean(i.fix)}`) : "");
    }
    if (issues.some((i) => i.level === "error")) process.exitCode = 1;
  });

// ---------------------------------------------------------------- search
program
  .command("search <query...>")
  .description("search a registry index (default: manifest.registry or the public index)")
  .option("--registry <url|path>", "registry index URL, index.json or a directory containing one")
  .action(async (query: string[], opts: { registry?: string }, cmd: Command) => {
    const ctx = ctxFrom(cmd);
    const gopts = cmd.optsWithGlobals() as { json?: boolean };
    const reg = opts.registry ?? loadManifest(ctx)?.registry ?? DEFAULT_REGISTRY;
    try {
      const idx = await loadRegistry(reg);
      const hits = searchRegistry(idx, query.join(" "));
      if (gopts.json) return console.log(toSafeJson(hits));
      if (hits.length === 0) return console.log(pc.dim(`no matches in ${clean(reg)}`));
      console.log(
        table(
          hits.slice(0, 20).map((h) => [pc.bold(clean(h.name)), shorten(clean(h.description), 60), pc.dim(clean(h.source))]),
          ["skill", "description", "install with: skillwharf add <source>"],
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
  .requiredOption("--source <source>", "public install source, e.g. github:owner/repo/path")
  .option("--tags <list>", "comma-separated tags")
  .action((skillPath: string, opts: { registry: string; source: string; tags?: string }) => {
    try {
      const dir = path.resolve(skillPath);
      const meta = readSkill(dir);
      parseSource(opts.source); // validate
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
