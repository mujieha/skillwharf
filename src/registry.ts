import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, writeJson } from "./fs.js";
import { DEFAULT_REGISTRY, listsRegistries, loadManifest, makeContext, registriesOf } from "./manifest.js";
import { fetchSource, parseSource } from "./source.js";
import type { Context, LoadedRegistry, RegistryEntry, RegistryIndex, RegistrySpec } from "./types.js";
import { assertSkillName, sanitizeForTerminal } from "./validate.js";

export interface LoadRegistryOptions {
  /** Longest one git call may run, in milliseconds (git locations only). */
  timeoutMs?: number;
}

/** What a registry location is: the words `default`, an https index URL, a git source, or a local path. */
export function classifyLocation(location: string): "https" | "http" | "git" | "path" {
  if (/^http:\/\//i.test(location)) return "http";
  if (/^https:\/\//i.test(location)) return "https";
  if (/^(github|gitlab|bitbucket):/.test(location) || /^git\+(https|ssh):\/\//.test(location)) return "git";
  return "path";
}

/**
 * Load a registry index from the public default (`default`), an https URL, a
 * git repository whose root (or `//folder`) holds `index.json`, a local
 * index.json, or a directory containing one. Whatever the source, the index
 * goes through the same schema check.
 */
export async function loadRegistry(location: string, opts: LoadRegistryOptions = {}): Promise<RegistryIndex> {
  if (location === "default") location = DEFAULT_REGISTRY;
  const kind = classifyLocation(location);
  if (kind === "http") throw new Error(`Registry must be served over https: ${location}`);
  if (kind === "https") {
    let credentials = false;
    try {
      const u = new URL(location);
      credentials = u.username !== "" || u.password !== "";
    } catch {
      /* fetch reports a URL that does not parse */
    }
    if (credentials) {
      throw new Error("A registry URL with credentials is refused: skillwharf sends none. Use a git location (credentials come from git) or a local checkout.");
    }
    const res = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (res.status === 404 && location === DEFAULT_REGISTRY) {
      throw new Error("the default registry is not available yet; pass --registry <url|path>");
    }
    if (!res.ok) throw new Error(`Registry fetch failed (${res.status}) for ${location}`);
    return normalize(JSON.parse(await readCapped(res, MAX_REGISTRY_BYTES)) as RegistryIndex);
  }
  if (kind === "git") {
    const src = parseSource(location);
    if (src.kind !== "git") throw new Error(`Registry location ${location} is not a git source`);
    // The same fetch as a skill: protocol allowlist, no prompts, timeout, sub-path
    // and link checks. The clone is read once and removed.
    const fetched = fetchSource(src, { timeoutMs: opts.timeoutMs });
    try {
      return readIndexFile(path.join(fetched.dir, "index.json"));
    } finally {
      fetched.cleanup();
    }
  }
  const p = fs.existsSync(location) && fs.statSync(location).isDirectory() ? path.join(location, "index.json") : location;
  return readIndexFile(p);
}

/** Read an index.json that is a regular file of at most 5 MB (links, devices and pipes are refused). */
function readIndexFile(p: string): RegistryIndex {
  // lstat before reading: a device file (/dev/zero) or a named pipe would
  // otherwise be read until memory runs out or forever.
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    throw new Error(`Registry index not found at ${p}`);
  }
  if (!st.isFile()) throw new Error(`Registry index ${p} is not a regular file; refusing to read it.`);
  if (st.size > MAX_REGISTRY_BYTES) throw tooBigError(MAX_REGISTRY_BYTES);
  return normalize(JSON.parse(fs.readFileSync(p, "utf8")) as RegistryIndex);
}

/** A registry to load, with the folder a relative path location is read from. */
interface RegistryPlan {
  spec: RegistrySpec;
  scope: LoadedRegistry["scope"];
  root: string;
  /** Set when the entry could not even be planned (an unreadable global manifest). */
  error?: string;
}

/**
 * The registries to search for this context, in order: the global manifest's,
 * then the project's. A project entry with the name and location of a global one
 * is the same registry (kept at the global position); with another location the
 * project keeps the name and the global one is shown as `global:<name>`. When
 * neither manifest lists any, the public registry.
 */
function planRegistries(ctx: Context): RegistryPlan[] {
  const globalCtx = ctx.global ? ctx : makeContext({ global: true, home: ctx.home });
  const plans: RegistryPlan[] = [];
  try {
    const gm = loadManifest(globalCtx);
    if (listsRegistries(gm)) {
      for (const spec of registriesOf(gm!)) plans.push({ spec, scope: "global", root: globalCtx.root });
    }
  } catch (e) {
    plans.push({
      spec: { name: "global manifest", location: path.join(globalCtx.root, "skillwharf.json") },
      scope: "global",
      root: globalCtx.root,
      error: (e as Error).message,
    });
  }
  let anyListed = plans.length > 0;
  if (!ctx.global) {
    const pm = loadManifest(ctx);
    if (listsRegistries(pm)) {
      anyListed = true;
      for (const spec of registriesOf(pm!)) {
        const clash = plans.find((p) => p.scope === "global" && p.spec.name === spec.name);
        if (clash && clash.spec.location === spec.location) continue;
        if (clash) clash.spec = { ...clash.spec, name: `global:${clash.spec.name}` };
        plans.push({ spec, scope: "project", root: ctx.root });
      }
    }
  }
  if (!anyListed) plans.push({ spec: { name: "default", location: "default" }, scope: "project", root: ctx.root });
  return plans;
}

/** A path location as a path: `~/` expands, a relative path is read from `root`. */
function resolveLocation(location: string, root: string, home: string): string {
  if (location === "default" || classifyLocation(location) !== "path") return location;
  if (location === "~" || location.startsWith("~/")) return path.join(home || os.homedir(), location.slice(1));
  return path.resolve(root, location);
}

/**
 * Load every registry that applies, concurrently. A registry that fails to load
 * is reported by name with the reason and does not hide the others. `only`
 * replaces the manifests' lists (the `--registry` flag).
 */
export async function loadRegistries(
  ctx: Context,
  opts: { only?: RegistrySpec[]; timeoutMs?: number } = {},
): Promise<LoadedRegistry[]> {
  const plans: RegistryPlan[] = opts.only
    ? opts.only.map((spec) => ({ spec, scope: "cli" as const, root: process.cwd() }))
    : planRegistries(ctx);
  return Promise.all(
    plans.map(async (p): Promise<LoadedRegistry> => {
      const head = { name: p.spec.name, location: p.spec.location, scope: p.scope };
      if (p.error) return { ...head, error: sanitizeForTerminal(p.error) };
      try {
        const index = await loadRegistry(resolveLocation(p.spec.location, p.root, ctx.home), { timeoutMs: opts.timeoutMs });
        return { ...head, index };
      } catch (e) {
        return { ...head, error: sanitizeForTerminal((e as Error).message) };
      }
    }),
  );
}

/** Largest registry index that is read; a remote server could otherwise stream without end. */
const MAX_REGISTRY_BYTES = 5 * 1024 * 1024;

/** The response body as text, refusing to read more than `max` bytes. */
function tooBigError(max: number): Error {
  return new Error(`Registry index is larger than ${max / (1024 * 1024)} MB; refusing to read it.`);
}

async function readCapped(res: Response, max: number): Promise<string> {
  const tooBig = () => tooBigError(max);
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) throw tooBig();
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooBig();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function normalize(idx: RegistryIndex): RegistryIndex {
  const skills = Array.isArray(idx?.skills) ? idx.skills : [];
  // Keep only well-formed entries; a registry is remote data, not trusted input.
  const clean = skills.filter(
    (e) =>
      e && typeof e.name === "string" && SKILL_NAME_RE.test(e.name) &&
      typeof e.description === "string" && typeof e.source === "string" && e.source.length < 512 &&
      e.source === e.source.trim() &&
      isGitSource(e.source) &&
      (e.tags === undefined || (Array.isArray(e.tags) && e.tags.every((t) => typeof t === "string" && t.length < 40))),
  );
  return {
    version: 1,
    // Known fields only: whatever else an entry carries is not ours to pass on.
    skills: clean.map((e) => {
      const entry: RegistryEntry = {
        name: e.name,
        description: sanitizeForTerminal(e.description.slice(0, 300)),
        source: e.source,
      };
      if (e.tags) entry.tags = e.tags.map(sanitizeForTerminal);
      if (typeof e.version === "string") entry.version = sanitizeForTerminal(e.version);
      return entry;
    }),
  };
}

/** A registry entry must name a git source on any host; a local path in someone else's index is never an install source. */
function isGitSource(s: string): boolean {
  try {
    return parseSource(s).kind === "git";
  } catch {
    return false;
  }
}

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

export function searchRegistry(idx: RegistryIndex, query: string): (RegistryEntry & { score: number })[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = idx.skills.map((e) => {
    const hay = `${e.name} ${e.description} ${(e.tags ?? []).join(" ")}`.toLowerCase();
    let score = 0;
    for (const t of terms) {
      if (e.name.toLowerCase() === t) score += 10;
      else if (e.name.toLowerCase().includes(t)) score += 5;
      if ((e.tags ?? []).some((tag) => tag.toLowerCase() === t)) score += 4;
      if (hay.includes(t)) score += 1;
    }
    return { ...e, score };
  });
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/** Insert or replace an entry in a local registry checkout's index.json. */
export function publishToRegistry(registryDir: string, entry: RegistryEntry): { created: boolean; file: string } {
  // The name comes from a SKILL.md and is printed and embedded in a suggested
  // shell command; loadRegistry would drop an entry with a bad name anyway.
  assertSkillName(entry.name);
  const file = path.join(registryDir, "index.json");
  const idx = readJson<RegistryIndex>(file) ?? { version: 1, skills: [] };
  const i = idx.skills.findIndex((s) => s.name === entry.name);
  const created = i < 0;
  if (created) idx.skills.push(entry);
  else idx.skills[i] = entry;
  idx.skills.sort((a, b) => a.name.localeCompare(b.name));
  writeJson(file, idx);
  return { created, file };
}
