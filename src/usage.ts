import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

export interface UsageRecord {
  skill: string;
  count: number;
  lastUsed?: Date;
  firstUsed?: Date;
  projects: Set<string>;
}

export interface UsageOptions {
  home: string;
  /** Only count events newer than this */
  since?: Date;
  /** Restrict to sessions whose cwd starts with this path */
  project?: string;
}

/**
 * Scan Claude Code session logs (~/.claude/projects/**\/*.jsonl) for skill
 * invocations. Two shapes are recognised:
 *   - assistant tool_use blocks with name "Skill" and input.skill
 *   - user turns containing <command-name>/name</command-name> (slash usage)
 * Plugin-qualified names ("pack:skill") are reduced to "skill".
 */
export async function scanClaudeUsage(opts: UsageOptions): Promise<Map<string, UsageRecord>> {
  const root = path.join(opts.home, ".claude", "projects");
  const out = new Map<string, UsageRecord>();
  if (!fs.existsSync(root)) return out;

  const files: string[] = [];
  for (const proj of fs.readdirSync(root, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const pdir = path.join(root, proj.name);
    for (const f of fs.readdirSync(pdir)) {
      if (!f.endsWith(".jsonl")) continue;
      const fp = path.join(pdir, f);
      if (opts.since && fs.statSync(fp).mtime < opts.since) continue;
      files.push(fp);
    }
  }

  for (const fp of files) await scanFile(fp, opts, out);
  return out;
}

async function scanFile(fp: string, opts: UsageOptions, out: Map<string, UsageRecord>): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(fp, "utf8"), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.includes("Skill") && !line.includes("command-name")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = typeof obj.timestamp === "string" ? new Date(obj.timestamp) : undefined;
    if (opts.since && ts && ts < opts.since) continue;
    const cwd = typeof obj.cwd === "string" ? obj.cwd : "";
    if (opts.project && cwd && !cwd.startsWith(opts.project)) continue;

    for (const name of extractSkillNames(obj)) record(out, name, ts, cwd);
  }
}

function extractSkillNames(obj: Record<string, unknown>): string[] {
  const names: string[] = [];
  const msg = obj.message as { content?: unknown } | undefined;
  const content = msg?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && typeof block === "object") {
        const b = block as { type?: string; name?: string; input?: { skill?: string }; text?: string };
        if (b.type === "tool_use" && b.name === "Skill" && typeof b.input?.skill === "string") {
          names.push(stripPlugin(b.input.skill));
        } else if (b.type === "text" && typeof b.text === "string") {
          names.push(...fromCommandTags(b.text));
        }
      }
    }
  } else if (typeof content === "string") {
    names.push(...fromCommandTags(content));
  }
  return names;
}

const CMD_RE = /<command-name>\/?([^<\s]+)<\/command-name>/g;
function fromCommandTags(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CMD_RE)) out.push(stripPlugin(m[1]));
  return out;
}

export function stripPlugin(name: string): string {
  const i = name.lastIndexOf(":");
  return (i >= 0 ? name.slice(i + 1) : name).trim();
}

function record(out: Map<string, UsageRecord>, skill: string, ts: Date | undefined, cwd: string): void {
  let r = out.get(skill);
  if (!r) {
    r = { skill, count: 0, projects: new Set() };
    out.set(skill, r);
  }
  r.count += 1;
  if (cwd) r.projects.add(cwd);
  if (ts && !Number.isNaN(ts.getTime())) {
    if (!r.lastUsed || ts > r.lastUsed) r.lastUsed = ts;
    if (!r.firstUsed || ts < r.firstUsed) r.firstUsed = ts;
  }
}

export function daysAgo(d: Date | undefined, now = new Date()): number | undefined {
  if (!d) return undefined;
  return Math.floor((now.getTime() - d.getTime()) / 86_400_000);
}
