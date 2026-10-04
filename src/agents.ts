import fs from "node:fs";
import path from "node:path";
import { exists, isDir, isPlainCopyOf, isSymlink, linkOrCopy, removePath, resolveInsideDetailed, resolveLink } from "./fs.js";
import { assertSafeTarget, writeRoot } from "./manifest.js";
import type { AgentId, Context, Manifest } from "./types.js";

export interface AgentAdapter {
  id: AgentId;
  label: string;
  /** Path (relative to project root) where skills live; undefined = unsupported */
  projectPath?: string;
  /** Path relative to $HOME */
  globalPath?: string;
}

/**
 * Where each tool loads skills from. Every adapter installs a skill as a
 * symlink `<dir>/<name>` pointing at the store entry.
 *
 * `.agents/skills` is the cross-tool location read natively by Codex, Cursor
 * and others, so `codex` is an alias for it: enabling both `codex` and
 * `agents` produces one link, not two (see `targetGroups`).
 */
export const ADAPTERS: Record<AgentId, AgentAdapter> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    projectPath: ".claude/skills",
    globalPath: ".claude/skills",
  },
  agents: {
    id: "agents",
    label: "Codex, Cursor and other .agents/skills tools",
    projectPath: ".agents/skills",
    globalPath: ".agents/skills",
  },
  codex: {
    id: "codex",
    label: "OpenAI Codex (.agents/skills)",
    projectPath: ".agents/skills",
    globalPath: ".agents/skills",
  },
  cursor: {
    id: "cursor",
    label: "Cursor-specific placement (.cursor/skills)",
    projectPath: ".cursor/skills",
    globalPath: ".cursor/skills",
  },
};

export const ALL_AGENTS = Object.keys(ADAPTERS) as AgentId[];

/**
 * What `skillwharf init` writes when no agents are given: Claude Code reads
 * `.claude/skills`; Codex and Cursor both read `.agents/skills`.
 */
export const DEFAULT_AGENTS: AgentId[] = ["claude", "agents"];

export function isAgentId(s: string): s is AgentId {
  return Object.prototype.hasOwnProperty.call(ADAPTERS, s);
}

/**
 * Resolve the *parent* of `storeDir` the same way a symlink target is resolved
 * (following every symlink in the path, e.g. macOS `/var` -> `/private/var`),
 * then re-attach the entry name, so both sides of an ownership comparison are
 * on equal footing. The store entry itself is deliberately not resolved: an
 * entry that is a symlink to somewhere else must never compare equal to it.
 */
function realStoreDir(storeDir: string): string {
  const parent = path.dirname(path.resolve(storeDir));
  return path.join(resolveLink(parent) ?? parent, path.basename(storeDir));
}

/** The relative link text linkOrCopy writes for this target. */
function expectedLinkText(target: string, storeDir: string): string {
  return path.relative(path.dirname(target), storeDir);
}

function readLinkText(p: string): string | undefined {
  try {
    return fs.readlinkSync(p);
  } catch {
    return undefined;
  }
}

/** Absolute directory where this agent expects skills, for this context. */
export function agentDir(ctx: Context, m: Manifest, agent: AgentId): string | undefined {
  const ad = ADAPTERS[agent];
  const override = m.agentPaths?.[agent];
  if (ctx.global) {
    const p = override?.globalPath ?? ad.globalPath;
    return p ? path.resolve(ctx.home, p) : undefined;
  }
  const p = override?.projectPath ?? ad.projectPath;
  return p ? path.resolve(ctx.root, p) : undefined;
}

/** Absolute path of the installed link for a skill under an agent. */
export function agentTarget(ctx: Context, m: Manifest, agent: AgentId, name: string): string | undefined {
  const dir = agentDir(ctx, m, agent);
  return dir ? path.join(dir, name) : undefined;
}

/** One install location and every enabled agent that reads it. */
export interface TargetGroup {
  /** In the order they were enabled; the first one is used to link. */
  agents: AgentId[];
  target: string;
}

/**
 * Collapse agents that share an install location (e.g. `codex` and `agents`
 * both map to `.agents/skills`) so each location is linked, checked and
 * reported exactly once. Agents without a location for this context are left out.
 */
export function targetGroups(ctx: Context, m: Manifest, agents: AgentId[], name: string): TargetGroup[] {
  const byTarget = new Map<string, TargetGroup>();
  for (const a of agents) {
    const t = agentTarget(ctx, m, a, name);
    if (!t) continue;
    const key = path.resolve(t);
    const g = byTarget.get(key);
    if (g) {
      if (!g.agents.includes(a)) g.agents.push(a);
    } else {
      byTarget.set(key, { agents: [a], target: t });
    }
  }
  return [...byTarget.values()];
}

/** Display form of a group of agents that share one link, e.g. `codex+agents`. */
export function groupLabel(agents: AgentId[]): string {
  return agents.join("+");
}

export interface LinkResult {
  /** Every agent served by this one link. */
  agents: AgentId[];
  target: string;
  mode: "symlink" | "copy" | "skipped";
}

/**
 * `copyRecorded`: the lockfile says skillwharf made a copy (not a link) at this
 * agent's location. Only then can a real folder there be skillwharf's own.
 */
export interface OwnershipOptions {
  copyRecorded?: boolean;
}

export function linkSkill(
  ctx: Context,
  m: Manifest,
  agent: AgentId,
  name: string,
  storeDir: string,
  opts: { force?: boolean } & OwnershipOptions = {},
): LinkResult {
  const target = agentTarget(ctx, m, agent, name);
  if (!target) return { agents: [agent], target: "", mode: "skipped" };
  // The link itself is replaced, never followed, so only its parents are checked.
  assertSafeTarget(ctx, target, { leaf: false });
  if (isSymlink(storeDir)) throw new Error(`${storeDir} is a symlink; refusing to link it into ${agent}. Remove it and re-run.`);
  // Never silently replace something we did not create.
  if (!opts.force && linkStatus(ctx, m, agent, name, storeDir, opts) === "foreign") {
    throw new Error(
      `${target} already exists and is not managed by skillwharf. Move it away, or re-run with --force to replace it.`,
    );
  }
  const mode = linkOrCopy(storeDir, target);
  return { agents: [agent], target, mode };
}

export function unlinkSkill(
  ctx: Context,
  m: Manifest,
  agent: AgentId,
  name: string,
  storeDir: string,
  opts: OwnershipOptions = {},
): boolean {
  const target = agentTarget(ctx, m, agent, name);
  if (!target) return false;
  assertSafeTarget(ctx, target, { leaf: false });
  if (!exists(target)) return false;
  // Safety: only remove things we own — the exact link we would have written
  // (even if the store is gone), a symlink resolving to our real store dir, or
  // a copied dir whose store twin exists.
  if (isSymlink(target)) {
    // The chain is followed by hand, as text, and only inside the project: a link whose
    // text (at any hop) is absolute or names a network share, or that leaves the project,
    // is never resolved (that would open a place its author chose). Only the exact link
    // we would have written is ours then.
    const resolved = resolveInsideDetailed(writeRoot(ctx), target);
    const ours =
      readLinkText(target) === expectedLinkText(target, storeDir) ||
      ("path" in resolved && !isSymlink(storeDir) && isDir(storeDir) && resolved.path === realStoreDir(storeDir));
    if (!ours) return false;
  } else {
    // A real directory: only remove it if the lockfile says skillwharf made a
    // copy here (the symlink fallback) and it is still exactly what copying our
    // store folder produces: same files, same folders, no .git, no links.
    // Identical content alone proves nothing (a user's own copy or clone of the
    // same skill is identical too); anything else was put there by someone else.
    if (!opts.copyRecorded || !isDir(target) || !isDir(storeDir) || !isPlainCopyOf(target, storeDir)) return false;
  }
  removePath(target);
  return true;
}

export type LinkStatus = "ok" | "missing" | "broken" | "foreign" | "stale-copy";

/** Inspect the state of an agent's install of a skill. */
export function linkStatus(
  ctx: Context,
  m: Manifest,
  agent: AgentId,
  name: string,
  storeDir: string,
  opts: OwnershipOptions = {},
): LinkStatus {
  const target = agentTarget(ctx, m, agent, name);
  if (!target || !exists(target)) return "missing";
  // A store entry that is itself a symlink points somewhere skillwharf did not
  // put it; nothing linked to it counts as installed.
  const storeIsLink = isSymlink(storeDir);
  if (isSymlink(target)) {
    // Followed by hand, inside the project only. A chain that leaves it (absolute or UNC text
    // at any hop, a `..` past the root) is not ours and is never opened; one that stays inside
    // but does not resolve is just broken.
    const resolved = resolveInsideDetailed(writeRoot(ctx), target);
    if ("fail" in resolved) return resolved.fail === "outside" ? "foreign" : "broken";
    return !storeIsLink && resolved.path === realStoreDir(storeDir) ? "ok" : "foreign";
  }
  // A real directory is only "ours" (a copy fallback) if the lockfile records a
  // copy here and it is exactly a copy of the store folder.
  if (opts.copyRecorded && !storeIsLink && isDir(target) && isDir(storeDir) && isPlainCopyOf(target, storeDir)) return "stale-copy";
  return "foreign";
}
