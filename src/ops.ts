import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertWithinLimits, copyDir, exists, findSymlinks, hashDir, isDir, isInside, removePath, resolveLink, type SizeLimits } from "./fs.js";
import {
  groupLabel,
  linkSkill,
  linkStatus,
  targetGroups,
  unlinkSkill,
  type LinkResult,
  type LinkStatus,
  type TargetGroup,
} from "./agents.js";
import { LOCKFILE, assertSafeTarget, loadLock, requireManifest, saveLock, saveManifest, storePath } from "./manifest.js";
import { normalizeName, readSkill } from "./skill.js";
import { assertSubpath } from "./validate.js";
import { discoverSkills, fetchSource, installToStore, parseSource, type ParsedSource } from "./source.js";
import type { AgentId, Context, LockEntry, Manifest, SkillMeta, SkillSpec } from "./types.js";

export interface SourceOptions {
  /**
   * Accept `path:` sources from the manifest or lockfile that resolve outside
   * the project root. Off by default: a cloned repository's manifest must not
   * be able to copy arbitrary local folders into the agent's instructions.
   */
  allowOutsidePaths?: boolean;
  /** Override the default size cap for one skill folder. */
  limits?: SizeLimits;
}

const FULL_SHA_RE = /^[0-9a-f]{40}$/;

/**
 * Parse a source read back from the manifest or lockfile (as opposed to one
 * the user just typed). Relative paths resolve against the project root, never
 * the working directory, and in a project they must stay inside it.
 */
export function parseStoredSource(ctx: Context, raw: string, opts: SourceOptions = {}): ParsedSource {
  const p = parseSource(raw, ctx.root);
  if (p.kind === "path" && !ctx.global && !opts.allowOutsidePaths) {
    const real = resolveLink(p.path);
    const realRoot = resolveLink(ctx.root) ?? ctx.root;
    const inside = real ? isInside(realRoot, real) : isInside(ctx.root, p.path);
    if (!inside) {
      throw new Error(
        `Source "${raw}" is outside the project (${ctx.root}). Re-run with --allow-outside-paths if you trust it.`,
      );
    }
  }
  return p;
}

/** True when a lock entry carries a content hash to verify against. */
function hasIntegrity(entry: LockEntry): boolean {
  return typeof entry.integrity === "string" && entry.integrity !== "";
}

/** A lock pin that is well-formed but cannot be fetched as-is (e.g. an abbreviated sha). */
class UnusablePin extends Error {}

/**
 * The exact source the lockfile pins for `name`, after checking that it is the
 * manifest's source at a full commit. Anything else is refused: a lockfile is
 * as editable by a teammate (or a pull request) as the manifest is.
 */
function lockedSource(ctx: Context, name: string, spec: SkillSpec, entry: LockEntry, opts: SourceOptions): ParsedSource {
  const want = parseStoredSource(ctx, spec.source, opts);
  const mismatch = () =>
    new Error(
      `${LOCKFILE}: the entry for "${name}" (${String(entry.resolved)}) does not match the manifest source ${spec.source}. Run \`skillwharf update ${name}\` to re-pin it.`,
    );
  if (entry.source !== spec.source || typeof entry.resolved !== "string") throw mismatch();
  let got: ParsedSource;
  try {
    got = parseSource(entry.resolved, ctx.root);
  } catch {
    throw mismatch();
  }
  if (want.kind === "github") {
    if (got.kind !== "github" || got.owner !== want.owner || got.repo !== want.repo || got.subpath !== want.subpath) {
      throw mismatch();
    }
    if (!got.ref || !FULL_SHA_RE.test(got.ref)) {
      throw new UnusablePin(
        `${LOCKFILE}: "${name}" is pinned to "${String(got.ref)}", not a full 40-character commit sha.`,
      );
    }
    return got;
  }
  if (got.kind !== "path" || got.path !== want.path) throw mismatch();
  return want;
}

/** Refuse before any write if the store entry or an agent target would be reached through a symlink. */
function assertSafeInstall(ctx: Context, m: Manifest, name: string, store: string, agents: AgentId[]): void {
  assertSafeTarget(ctx, store);
  for (const g of targetGroups(ctx, m, agents, name)) assertSafeTarget(ctx, g.target, { leaf: false });
}

/**
 * Refuse a store folder that contains a symlink. Skillwharf never puts one there
 * (copyDir skips them), so one found here was committed or planted, and an
 * agent reading the linked folder would follow it outside the store. The hash
 * ignores symlinks, so the integrity check alone would not notice.
 */
function storeSymlinkProblem(name: string, store: string): string | undefined {
  const links = findSymlinks(store);
  if (links.length === 0) return undefined;
  return `store folder contains symlinks (${links.join(", ")}); an agent would follow them outside the store. Remove them, or run \`skillwharf update ${name}\` to reinstall it.`;
}

function assertStoreHasNoSymlinks(name: string, store: string): void {
  const problem = storeSymlinkProblem(name, store);
  if (problem) throw new Error(`Refusing to link "${name}": ${problem}`);
}

/** Link one location for every agent that shares it; the result names all of them. */
function linkGroup(ctx: Context, m: Manifest, g: TargetGroup, name: string, store: string, force?: boolean): LinkResult {
  return { ...linkSkill(ctx, m, g.agents[0], name, store, { force }), agents: g.agents };
}

export interface AddOptions {
  name?: string;
  agents?: AgentId[];
  /** When a source contains several skills, install all of them */
  all?: boolean;
  /** Replace agent-side files that skillwharf did not create */
  force?: boolean;
  /** Override the default size cap for one skill folder */
  limits?: SizeLimits;
  /** Called for each folder of a multi-skill source that was left out, with the reason. */
  onSkipped?: (skipped: SkippedSkill) => void;
}

export interface AddedSkill {
  name: string;
  meta: SkillMeta;
  lock: LockEntry;
  links: LinkResult[];
  /** Symlinks found in the source and left out of the store */
  skippedSymlinks: string[];
}

/** A folder of a multi-skill source that `add --all` left out, and why. */
export interface SkippedSkill {
  /** Repository-relative path of the folder. */
  dir: string;
  reason: string;
}

/**
 * How a local folder is written into the manifest: project-relative
 * (`path:./skills/x`) when it lies inside the project, so a teammate's checkout
 * at another location resolves the same folder. Undefined when the folder is
 * outside the project (the user asked for it, and `sync` elsewhere will refuse
 * it unless `--allow-outside-paths`) and always for the global manifest, whose
 * path sources are not confined.
 */
function pathSourceFor(ctx: Context, dir: string): string | undefined {
  if (!ctx.global) {
    const pairs: [string | undefined, string | undefined][] = [
      [ctx.root, dir],
      [resolveLink(ctx.root), resolveLink(dir)],
    ];
    for (const [root, d] of pairs) {
      if (root && d && isInside(root, d)) {
        const rel = path.relative(root, d).split(path.sep).join("/");
        return rel === "" ? "path:." : `path:./${rel}`;
      }
    }
  }
  return undefined;
}

export function agentsFor(m: Manifest, name: string): AgentId[] {
  return m.skills[name]?.agents ?? m.agents;
}

export function addSkill(ctx: Context, sourceRaw: string, opts: AddOptions = {}): AddedSkill[] {
  const m = requireManifest(ctx);
  const lock = loadLock(ctx);
  const parsed = parseSource(sourceRaw);
  const fetched = fetchSource(parsed);
  try {
    let dirs = discoverSkills(fetched.dir);
    if (dirs.length === 0) throw new Error(`No SKILL.md found under ${sourceRaw}`);
    if (dirs.length > 1 && !opts.all) {
      const names = dirs.map((d) => readSkill(d).name).join(", ");
      throw new Error(
        `Source contains ${dirs.length} skills (${names}). Point at one sub-folder, or pass --all to install every skill.`,
      );
    }
    if (dirs.length > 1 && opts.name) throw new Error(`--name cannot be used with --all`);

    // Plan every skill first: names, store paths, agent targets, size. A skill
    // that cannot be installed stops the whole run before anything is written,
    // so `--all` never leaves earlier skills linked but unrecorded.
    const multi = dirs.length > 1;
    const skipped: SkippedSkill[] = [];
    const seen = new Set<string>();
    const plan = dirs.flatMap((dir) => {
      // The source recorded for this skill. In a multi-skill source it is built
      // from the folder name, so it has to pass the same checks as a typed one:
      // `skills/x@y` would re-parse as branch `y`, and `skills/my skill` would
      // make every later sync throw. A folder that fails is skipped, not recorded.
      let sourceForManifest: string;
      let resolved = fetched.resolved;
      if (parsed.kind === "path") {
        // A folder inside the project is recorded relative to it, so a teammate's
        // checkout at another location resolves the same skill. Outside it, the
        // path is recorded absolute (a relative one was typed relative to the
        // working directory, so it is made absolute: it is read back against the
        // project root).
        const inside = pathSourceFor(ctx, multi ? dir : parsed.path);
        if (inside) sourceForManifest = inside;
        else if (multi) sourceForManifest = `path:${dir}`;
        else sourceForManifest = path.isAbsolute(parsed.raw.replace(/^path:/, "")) ? parsed.raw : `path:${parsed.path}`;
        resolved = sourceForManifest;
      } else if (multi) {
        const rel = dir.slice(fetched.dir.length).replace(/^[/\\]+/, "").split("\\").join("/");
        const sub = [parsed.subpath, rel].filter(Boolean).join("/");
        try {
          assertSubpath(sub);
        } catch (e) {
          skipped.push({ dir: sub, reason: (e as Error).message });
          opts.onSkipped?.({ dir: sub, reason: (e as Error).message });
          return [];
        }
        const refPart = parsed.ref ? `@${parsed.ref}` : "";
        sourceForManifest = `github:${parsed.owner}/${parsed.repo}/${sub}${refPart}`;
        resolved = resolved.replace(/^github:[^@]+/, `github:${parsed.owner}/${parsed.repo}/${sub}`);
      } else {
        sourceForManifest = parsed.raw;
      }

      const meta = readSkill(dir);
      const name = normalizeName(opts.name ?? meta.name);
      if (seen.has(name)) throw new Error(`Two skills in ${sourceRaw} resolve to the name "${name}". Install them one at a time with --name.`);
      seen.add(name);
      const store = storePath(ctx, name);
      // The agent set is fixed here and used for the check and for the links.
      // `--agents` replaces a skill's own list; without it the list it has
      // (or the manifest's default) is kept as it was.
      const agentList = opts.agents ?? m.skills[name]?.agents;
      const targets = agentList ?? m.agents;
      assertSafeInstall(ctx, m, name, store, targets);
      for (const g of targetGroups(ctx, m, targets, name)) {
        if (!opts.force && linkStatus(ctx, m, g.agents[0], name, store) === "foreign") {
          throw new Error(`${g.target} already exists and is not managed by skillwharf. Move it away, or re-run with --force.`);
        }
      }
      assertWithinLimits(dir, opts.limits);
      return [{ dir, meta, name, store, agentList, targets, sourceForManifest, resolved, skippedSymlinks: findSymlinks(dir) }];
    });
    if (plan.length === 0) {
      throw new Error(
        `None of the skills found under ${sourceRaw} can be installed; skipped: ${skipped.map((s) => `${s.dir} (${s.reason})`).join("; ")}`,
      );
    }

    const results: AddedSkill[] = [];
    for (const { dir, meta, name, store, agentList, targets, sourceForManifest, resolved, skippedSymlinks } of plan) {
      installToStore(dir, store, opts.limits);

      m.skills[name] = { source: sourceForManifest, ...(agentList ? { agents: agentList } : {}) };
      const entry: LockEntry = {
        source: sourceForManifest,
        resolved,
        integrity: hashDir(store),
        version: meta.version,
        installedAt: new Date().toISOString(),
      };
      lock.skills[name] = entry;
      // Record each skill as soon as its store folder is in place, before the
      // links, so the lockfile always describes what the store holds.
      saveManifest(ctx, m);
      saveLock(ctx, lock);
      const links = targetGroups(ctx, m, targets, name).map((g) => linkGroup(ctx, m, g, name, store, opts.force));
      results.push({ name, meta, lock: entry, links, skippedSymlinks });
    }
    return results;
  } finally {
    fetched.cleanup();
  }
}

export interface RemoveResult {
  /** Every agent whose link was removed (agents sharing one link are all listed). */
  removedLinks: AgentId[];
  /** Each removed link once, with the agents it served. */
  removed: TargetGroup[];
  existed: boolean;
}

export function removeSkill(ctx: Context, name: string): RemoveResult {
  const m = requireManifest(ctx);
  const lock = loadLock(ctx);
  const existed = name in m.skills;
  const store = storePath(ctx, name);
  assertSafeInstall(ctx, m, name, store, agentsFor(m, name));
  const removed: TargetGroup[] = [];
  for (const g of targetGroups(ctx, m, agentsFor(m, name), name)) {
    if (unlinkSkill(ctx, m, g.agents[0], name, store)) removed.push(g);
  }
  const removedLinks = removed.flatMap((g) => g.agents);
  removePath(store);
  delete m.skills[name];
  delete lock.skills[name];
  saveManifest(ctx, m);
  saveLock(ctx, lock);
  return { removedLinks, removed, existed };
}

export interface SyncReport {
  fetched: string[];
  linked: { name: string; link: LinkResult }[];
  unchanged: string[];
}

export interface SyncOptions extends SourceOptions {
  force?: boolean;
  /**
   * When the lockfile's pinned commit cannot be fetched, install the manifest
   * source's current state instead (and re-pin). Off by default: a pin that
   * silently falls back is not a pin.
   */
  allowUnpinned?: boolean;
}

/** Bring store + agent dirs in line with the manifest. Fetches skills missing from the store. */
export function syncSkills(ctx: Context, opts: SyncOptions = {}): SyncReport {
  const m = requireManifest(ctx);
  const lock = loadLock(ctx);
  const report: SyncReport = { fetched: [], linked: [], unchanged: [] };

  // Check every committed store folder before linking any of them. Freshly
  // fetched ones cannot contain symlinks: installToStore leaves them out.
  for (const name of Object.keys(m.skills)) {
    const store = storePath(ctx, name);
    if (isDir(store)) {
      assertSafeTarget(ctx, store);
      assertStoreHasNoSymlinks(name, store);
    }
  }

  // A lock entry with no integrity hash pins a commit but cannot verify what
  // that commit contains. Refuse before installing anything unless the user
  // opted in, and say which entries.
  if (!opts.allowUnpinned) {
    const unverifiable = Object.keys(m.skills).filter((name) => {
      const entry = lock.skills[name];
      return entry && !isDir(storePath(ctx, name)) && !hasIntegrity(entry);
    });
    if (unverifiable.length > 0) {
      throw new Error(
        `${LOCKFILE}: no integrity hash for ${unverifiable.map((n) => `"${n}"`).join(", ")}, so the content cannot be verified. ` +
          `Nothing was installed and the lockfile was not changed. Run \`skillwharf update ${unverifiable.join(" ")}\` to pin it, or re-run sync with --allow-unpinned to install it unchecked.`,
      );
    }
  }

  // Phase 1: fetch every missing skill into a staging folder and check it
  // against the lockfile. Nothing touches the store, the agent folders or the
  // lockfile here, so a failure for any skill leaves the project as it was and
  // the `finally` removes every temp clone and the staging folder.
  const staged = new Map<string, StagedSkill>();
  let stagingRoot: string | undefined;
  try {
    for (const [name, spec] of Object.entries(m.skills)) {
      const store = storePath(ctx, name);
      assertSafeInstall(ctx, m, name, store, agentsFor(m, name));
      if (isDir(store)) continue;
      // Install exactly what the lockfile pins. Only an explicit
      // --allow-unpinned falls back to the manifest source.
      const source = parseStoredSource(ctx, spec.source, opts);
      const entry = lock.skills[name];
      let fetched;
      let pinnedIntegrity: string | undefined;
      if (entry) {
        try {
          fetched = fetchSource(lockedSource(ctx, name, spec, entry, opts));
          pinnedIntegrity = hasIntegrity(entry) ? entry.integrity : undefined;
        } catch (e) {
          const pinProblem = e instanceof UnusablePin || /^git fetch failed/.test((e as Error).message);
          if (!pinProblem) throw e;
          if (!opts.allowUnpinned) {
            throw new Error(
              `Cannot install the pinned commit for "${name}": ${(e as Error).message} ` +
                `Nothing was installed and the lockfile was not changed. Run \`skillwharf update ${name}\` to re-pin, or re-run sync with --allow-unpinned to install the manifest source as it is now.`,
            );
          }
          fetched = fetchSource(source);
        }
      } else {
        fetched = fetchSource(source);
      }
      try {
        const dirs = discoverSkills(fetched.dir);
        if (dirs.length !== 1) throw new Error(`Expected exactly one skill at ${spec.source}, found ${dirs.length}`);
        stagingRoot ??= fs.mkdtempSync(path.join(os.tmpdir(), "skillwharf-stage-"));
        const dir = path.join(stagingRoot, name);
        installToStore(dirs[0], dir, opts.limits);
        const integrity = hashDir(dir);
        if (pinnedIntegrity !== undefined && integrity !== pinnedIntegrity) {
          throw new Error(
            `integrity mismatch for "${name}": the pinned content hashes to ${integrity}, the lockfile expects ${pinnedIntegrity}. ` +
              `Nothing was installed and the lockfile was not changed.`,
          );
        }
        staged.set(name, { dir, resolved: fetched.resolved, integrity, version: readSkill(dir).version });
      } finally {
        fetched.cleanup();
      }
    }

    // Phase 2: every skill passed. Put the staged ones in the store and record
    // them, then link. The lockfile is saved before the links, so a link that
    // fails leaves a store and a lockfile that agree.
    for (const [name, spec] of Object.entries(m.skills)) {
      const s = staged.get(name);
      if (!s) continue;
      copyDir(s.dir, storePath(ctx, name));
      lock.skills[name] = {
        source: spec.source,
        resolved: s.resolved,
        integrity: s.integrity,
        version: s.version,
        installedAt: new Date().toISOString(),
      };
      report.fetched.push(name);
    }
    if (staged.size > 0) saveLock(ctx, lock);
  } finally {
    if (stagingRoot) removePath(stagingRoot);
  }

  for (const name of Object.keys(m.skills)) {
    const store = storePath(ctx, name);
    let touched = false;
    for (const g of targetGroups(ctx, m, agentsFor(m, name), name)) {
      const status = linkStatus(ctx, m, g.agents[0], name, store);
      if (status !== "ok") {
        report.linked.push({ name, link: linkGroup(ctx, m, g, name, store, opts.force) });
        touched = true;
      }
    }
    if (!touched && !report.fetched.includes(name)) report.unchanged.push(name);
  }
  saveLock(ctx, lock);
  return report;
}

/** A skill fetched and verified in phase 1 of `syncSkills`, waiting to be installed. */
interface StagedSkill {
  dir: string;
  resolved: string;
  integrity: string;
  version?: string;
}

export interface UpdateResult {
  name: string;
  before?: string;
  after: string;
  changed: boolean;
}

export function updateSkills(ctx: Context, only?: string[], opts: SourceOptions = {}): UpdateResult[] {
  const m = requireManifest(ctx);
  const lock = loadLock(ctx);
  const names = only && only.length ? only : Object.keys(m.skills);
  const out: UpdateResult[] = [];
  for (const name of names) {
    const spec = m.skills[name];
    if (!spec) throw new Error(`Skill "${name}" is not in the manifest`);
    const store = storePath(ctx, name);
    assertSafeInstall(ctx, m, name, store, agentsFor(m, name));
    const parsed = parseStoredSource(ctx, spec.source, opts);
    const fetched = fetchSource(parsed);
    try {
      const dirs = discoverSkills(fetched.dir);
      if (dirs.length !== 1) throw new Error(`Expected exactly one skill at ${spec.source}, found ${dirs.length}`);
      const before = lock.skills[name]?.integrity;
      installToStore(dirs[0], store, opts.limits);
      const after = hashDir(store);
      const meta = readSkill(store);
      lock.skills[name] = {
        source: spec.source,
        resolved: fetched.resolved,
        integrity: after,
        version: meta.version,
        installedAt: new Date().toISOString(),
      };
      assertStoreHasNoSymlinks(name, store);
      for (const g of targetGroups(ctx, m, agentsFor(m, name), name)) linkGroup(ctx, m, g, name, store);
      out.push({ name, before, after, changed: before !== after });
    } finally {
      fetched.cleanup();
    }
  }
  saveLock(ctx, lock);
  return out;
}

export interface DoctorIssue {
  level: "error" | "warn";
  skill?: string;
  /** The first agent of the affected link. */
  agent?: AgentId;
  /** Every agent that shares the affected link. */
  agents?: AgentId[];
  message: string;
  fix?: string;
}

export function doctor(ctx: Context): DoctorIssue[] {
  const m = requireManifest(ctx);
  const lock = loadLock(ctx);
  const issues: DoctorIssue[] = [];

  for (const [name] of Object.entries(m.skills)) {
    const store = storePath(ctx, name);
    try {
      assertSafeInstall(ctx, m, name, store, agentsFor(m, name));
    } catch (e) {
      issues.push({ level: "error", skill: name, message: (e as Error).message });
      continue;
    }
    if (!isDir(store)) {
      issues.push({ level: "error", skill: name, message: "not in store", fix: "skillwharf sync" });
      continue;
    }
    if (!exists(`${store}/SKILL.md`)) {
      issues.push({ level: "error", skill: name, message: "store folder has no SKILL.md", fix: "skillwharf update " + name });
    }
    const symlinkProblem = storeSymlinkProblem(name, store);
    if (symlinkProblem) {
      issues.push({ level: "error", skill: name, message: symlinkProblem, fix: "skillwharf update " + name });
    }
    const entry = lock.skills[name];
    if (entry) {
      try {
        lockedSource(ctx, name, m.skills[name], entry, { allowOutsidePaths: true });
      } catch (e) {
        issues.push({ level: "error", skill: name, message: (e as Error).message, fix: "skillwharf update " + name });
      }
    }
    if (!entry) {
      issues.push({ level: "warn", skill: name, message: "missing from lockfile", fix: "skillwharf update " + name });
    } else if (!hasIntegrity(entry)) {
      issues.push({
        level: "warn",
        skill: name,
        message:
          "lockfile entry has no integrity hash: this folder is installed but unpinned, and sync refuses the entry on a fresh clone (where the folder is absent)",
        fix: "skillwharf update " + name,
      });
    } else if (hashDir(store) !== entry.integrity) {
      issues.push({
        level: "warn",
        skill: name,
        message: "store contents differ from lockfile (edited locally?)",
        fix: `skillwharf update ${name}  # or commit your edits upstream`,
      });
    }
    // Agents sharing one location (codex + agents) are one link: checked and reported once.
    for (const g of targetGroups(ctx, m, agentsFor(m, name), name)) {
      const a = g.agents[0];
      const status: LinkStatus = linkStatus(ctx, m, a, name, store);
      if (status === "ok") continue;
      const target = g.target;
      const msg: Record<Exclude<LinkStatus, "ok">, string> = {
        missing: `not installed for ${groupLabel(g.agents)}`,
        broken: `broken symlink at ${target}`,
        foreign: `${target} exists but is not managed by skillwharf`,
        "stale-copy": `${target} is a copy, not a link (will not follow updates)`,
      };
      issues.push({
        level: status === "foreign" ? "warn" : "error",
        skill: name,
        agent: a,
        agents: g.agents,
        message: msg[status],
        fix: status === "foreign" ? `remove it manually, then skillwharf sync` : "skillwharf sync",
      });
    }
  }
  for (const name of Object.keys(lock.skills)) {
    if (!m.skills[name]) issues.push({ level: "warn", skill: name, message: "in lockfile but not in manifest", fix: "skillwharf remove " + name });
  }
  return issues;
}
