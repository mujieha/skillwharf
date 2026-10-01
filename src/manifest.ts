import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoSymlinks, exists, readJson, resolveLink, writeJson } from "./fs.js";
import type { AgentId, Context, LockEntry, Lockfile, Manifest } from "./types.js";
import { assertSkillName, hasTerminalUnsafe } from "./validate.js";

const KNOWN_AGENTS = new Set(["claude", "codex", "agents", "cursor"]);
/** Directory names an agentPaths override may never use (compared lowercase, after Unicode folding). */
const RESERVED_DIRS = new Set([".skillwharf", ".git"]);
/** The agent folders an agentPaths override must stay inside (the folders ADAPTERS in agents.ts use). */
const AGENT_DIRS = [".claude", ".agents", ".cursor"];
const AGENT_PART_RE = /^[A-Za-z0-9._-]+$/;

export const MANIFEST = "skillwharf.json";
export const LOCKFILE = "skillwharf.lock.json";
export const STORE_DIR = ".skillwharf/skills";
export const DEFAULT_REGISTRY =
  "https://raw.githubusercontent.com/mujieha/skillwharf-registry/main/index.json";

/**
 * The directory everything skillwharf writes must stay under: the project root,
 * or the home directory for --global (store in ~/.skillwharf, agents in ~/.claude
 * and friends).
 */
export function writeRoot(ctx: Context): string {
  return ctx.global ? ctx.home : ctx.root;
}

/** Throws unless `p` is inside the write root with no symlinked component on the way. */
export function assertSafeTarget(ctx: Context, p: string, opts: { leaf?: boolean } = {}): string {
  assertNoSymlinks(writeRoot(ctx), p, opts);
  return p;
}

export function makeContext(opts: { global?: boolean; cwd?: string; home?: string }): Context {
  const home = opts.home ?? process.env.SKILLWHARF_HOME ?? os.homedir();
  if (opts.global) {
    return { root: path.join(home, ".skillwharf"), global: true, home };
  }
  const start = opts.cwd ?? process.cwd();
  return { root: findProjectRoot(start, home) ?? start, global: false, home };
}

/**
 * Walk up from `start` looking for skillwharf.json. The walk never uses the
 * home directory or anything above it as a project root, and does not climb
 * into a folder the current user does not own (a manifest planted in a shared
 * /tmp would otherwise become the project of anyone working below it).
 */
export function findProjectRoot(start: string, home: string = os.homedir()): string | undefined {
  const homes = new Set([path.resolve(home), resolveLink(home)].filter((h): h is string => h !== undefined));
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  let dir = path.resolve(start);
  for (;;) {
    if (homes.has(dir) || homes.has(resolveLink(dir) ?? dir)) return undefined;
    if (exists(path.join(dir, MANIFEST))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    if (uid !== undefined && uid !== 0) {
      try {
        if (fs.statSync(parent).uid !== uid) return undefined;
      } catch {
        return undefined;
      }
    }
    dir = parent;
  }
}

export function manifestPath(ctx: Context): string {
  return path.join(ctx.root, MANIFEST);
}
export function lockPath(ctx: Context): string {
  return path.join(ctx.root, LOCKFILE);
}
export function storePath(ctx: Context, name?: string): string {
  const base = ctx.global ? path.join(ctx.root, "skills") : path.join(ctx.root, STORE_DIR);
  return name ? path.join(base, assertSkillName(name)) : base;
}

export function emptyManifest(agents: AgentId[]): Manifest {
  return { version: 1, agents, skills: {} };
}

export function loadManifest(ctx: Context): Manifest | undefined {
  // A symlinked manifest would be read here and only refused at saveManifest,
  // after the store and agent links were already written.
  const m = readJson<Manifest>(assertSafeTarget(ctx, manifestPath(ctx)));
  return m ? validateManifest(m, manifestPath(ctx)) : undefined;
}

/** Reject hand-edited manifests that would write outside the store or agent dirs. */
export function validateManifest(m: Manifest, file: string): Manifest {
  const bad = (msg: string) => new Error(`${file}: ${msg}`);
  if (m.version !== 1) throw bad(`unsupported manifest version ${String(m.version)}`);
  if (!Array.isArray(m.agents)) throw bad(`"agents" must be an array`);
  for (const a of m.agents) if (!KNOWN_AGENTS.has(a)) throw bad(`unknown agent "${String(a)}"`);
  if (typeof m.skills !== "object" || m.skills === null || Array.isArray(m.skills)) throw bad(`"skills" must be an object`);
  for (const [name, spec] of Object.entries(m.skills)) {
    try {
      assertSkillName(name);
    } catch (e) {
      throw bad((e as Error).message);
    }
    if (!spec || typeof spec.source !== "string" || !spec.source.trim()) throw bad(`skill "${name}" needs a "source"`);
    for (const a of spec.agents ?? []) if (!KNOWN_AGENTS.has(a)) throw bad(`skill "${name}": unknown agent "${String(a)}"`);
  }
  for (const [agent, o] of Object.entries(m.agentPaths ?? {})) {
    if (!KNOWN_AGENTS.has(agent)) throw bad(`agentPaths: unknown agent "${agent}"`);
    for (const p of [o?.projectPath, o?.globalPath]) {
      if (p === undefined) continue;
      if (typeof p !== "string" || path.isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
        throw bad(`agentPaths.${agent}: paths must be relative and may not contain ".."`);
      }
      if (hasTerminalUnsafe(p)) {
        throw bad(`agentPaths.${agent}: paths may not contain control or bidirectional-override characters`);
      }
      // Linking into skillwharf's own store (or into .git) would replace the
      // store with a link to itself, or plant files git executes. Compared
      // after Unicode folding: a case-insensitive volume folds U+017F to "s".
      const first = p
        .split(/[\\/]/)
        .find((s) => s !== "" && s !== ".")
        ?.normalize("NFKC")
        .toLowerCase();
      if (first !== undefined && RESERVED_DIRS.has(first)) {
        throw bad(`agentPaths.${agent}: paths may not point inside ${first}`);
      }
      const problem = agentPathProblem(p);
      if (problem) throw bad(`agentPaths.${agent}: ${problem}`);
    }
  }
  return m;
}

/**
 * An override may only move skills between the known agent folders' own
 * subfolders. Anywhere else in the project is a place something else reads as
 * code (`node_modules`, `scripts`, `.husky`) or a name some file system aliases
 * (`GIT~1`, trailing dots, ignorable code points). The ASCII charset and the
 * allowlist leave none of those expressible.
 */
function agentPathProblem(p: string): string | undefined {
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.length < 2 || !AGENT_DIRS.includes(parts[0])) {
    return `paths must be inside one of ${AGENT_DIRS.map((d) => `${d}/`).join(", ")} (for example ".claude/custom")`;
  }
  for (const part of parts) {
    if (!AGENT_PART_RE.test(part) || part.endsWith(".") || RESERVED_DIRS.has(part.normalize("NFKC").toLowerCase())) {
      return `"${part}" is not allowed: use only letters, digits, ".", "_" and "-" in each folder name, no name may end in ".", and none may be .git or .skillwharf`;
    }
  }
  return undefined;
}

export function requireManifest(ctx: Context): Manifest {
  const m = loadManifest(ctx);
  if (!m) {
    throw new Error(
      `No ${MANIFEST} found in ${ctx.root}. Run \`skillwharf init\` first${ctx.global ? "" : " (or use --global)"}.`,
    );
  }
  return m;
}

export function saveManifest(ctx: Context, m: Manifest): void {
  const sorted: Manifest = { ...m, skills: sortKeys(m.skills) };
  writeJson(assertSafeTarget(ctx, manifestPath(ctx)), sorted);
}

export function loadLock(ctx: Context): Lockfile {
  const l = readJson<Lockfile>(assertSafeTarget(ctx, lockPath(ctx))) ?? { version: 1, skills: {} };
  if (typeof l.skills !== "object" || l.skills === null) throw new Error(`${lockPath(ctx)}: "skills" must be an object`);
  for (const [name, entry] of Object.entries(l.skills)) {
    assertSkillName(name);
    // Only a recorded copy of a known agent means anything; drop the rest.
    if (entry && typeof entry === "object" && "links" in entry) {
      const raw = entry.links as unknown;
      const kept =
        raw && typeof raw === "object"
          ? Object.entries(raw).filter(([a, v]) => KNOWN_AGENTS.has(a) && v === "copy")
          : [];
      if (kept.length > 0) entry.links = Object.fromEntries(kept) as LockEntry["links"];
      else delete entry.links;
    }
  }
  return l;
}

export function saveLock(ctx: Context, l: Lockfile): void {
  writeJson(assertSafeTarget(ctx, lockPath(ctx)), { ...l, skills: sortKeys(l.skills) });
}

function sortKeys<T>(obj: Record<string, T>): Record<string, T> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}
