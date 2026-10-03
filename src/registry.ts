import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertNoSymlinks, isInside, isNetworkPathText, readJson, resolveInsideDetailed, writeJson } from "./fs.js";
import {
  DEFAULT_REGISTRY,
  listsRegistries,
  loadManifest,
  makeContext,
  manifestPath,
  registriesOf,
  requireManifest,
  saveManifest,
  validateManifest,
} from "./manifest.js";
import { DEFAULT_GIT_TIMEOUT_MS } from "./git.js";
import { ShortShaError, fetchSource, parseSource } from "./source.js";
import type { Context, LoadedRegistry, Manifest, RegistryEntry, RegistryIndex, RegistrySpec, SearchHit } from "./types.js";
import { assertSkillName, sanitizeForTerminal } from "./validate.js";

export interface LoadRegistryOptions {
  /** Longest one git call may run, in milliseconds (git locations only). */
  timeoutMs?: number;
  /** An overall limit (epoch milliseconds) for all the git calls of one search (git locations only). */
  deadline?: number;
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
    // and link checks. The clone is read once and removed. A registry is only an
    // index: its submodules are never opened (they could name any host).
    const fetched = fetchSource(src, { timeoutMs: opts.timeoutMs, deadline: opts.deadline, submodules: false });
    try {
      return readIndexFile(path.join(fetched.dir, "index.json"));
    } finally {
      fetched.cleanup();
    }
  }
  // A share or drive is never asked about (on Windows that would open a connection to a
  // host a manifest chose); use a git location, an https URL or a folder path instead.
  if (isNetworkPathText(location)) {
    throw new Error(
      `Registry location "${sanitizeForTerminal(location)}" names a network share or a drive; skillwharf does not read registries from those. Use a git location, an https URL, or a folder path.`,
    );
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
  /** A line to show the user about this entry (it was renamed). */
  note?: string;
}

/**
 * The registries to search for this context, in order: the global manifest's,
 * then the project's. A project entry with the name and location of a global one
 * is the same registry (kept at the global position); with another location the
 * global registry keeps the name and the project's is shown as `project:<name>`
 * (with a note, so the user is told). When
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
        if (clash) {
          // The user's own (global) registry keeps its name: a project manifest, which
          // may come from a cloned repository, cannot take it over. Names cannot hold a
          // colon, so the new name cannot collide with another entry.
          plans.push({
            spec: { ...spec, name: `project:${spec.name}` },
            scope: "project",
            root: ctx.root,
            note: `registry "${spec.name}" in this project is at another location than your global registry of that name; it is shown as project:${spec.name}`,
          });
          continue;
        }
        plans.push({ spec, scope: "project", root: ctx.root });
      }
    }
  }
  if (!anyListed) plans.push({ spec: { name: "default", location: "default" }, scope: "project", root: ctx.root });
  return plans;
}

/** The registries this context searches, as listed (nothing is loaded), the implied public one included. */
export function configuredRegistries(ctx: Context): RegistrySpec[] {
  return planRegistries(ctx).map((p) => p.spec);
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
  // One time limit for the whole search: git calls block, so several slow
  // registries would otherwise each take the full timeout in turn.
  const deadline = Date.now() + (opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
  return Promise.all(
    plans.map(async (p): Promise<LoadedRegistry> => {
      const head = { name: p.spec.name, location: p.spec.location, scope: p.scope, ...(p.note ? { note: p.note } : {}) };
      if (p.error) return { ...head, error: sanitizeForTerminal(p.error) };
      try {
        const where = resolveLocation(p.spec.location, p.root, ctx.home);
        // A relative location in a manifest is read from the folder of that manifest: a link on the
        // way (a cloned repository can commit one) must stay inside it, checked before any stat.
        if (p.scope !== "cli" && where !== "default" && classifyLocation(where) === "path" && !isNetworkPathText(where) && isInside(p.root, where)) {
          const r = resolveInsideDetailed(p.root, where);
          if ("fail" in r && r.fail === "outside") {
            throw new Error(`Registry location "${sanitizeForTerminal(p.spec.location)}" leaves the folder of the manifest that lists it (a link points out of it); refusing it.`);
          }
        }
        const index = await loadRegistry(where, { timeoutMs: opts.timeoutMs, deadline });
        const skipped = index.skippedHexRefs ?? [];
        const hexNote =
          skipped.length > 0
            ? `registry ${p.spec.name}: ${skipped.length} ${skipped.length === 1 ? "entry" : "entries"} skipped: ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? ` and ${skipped.length - 5} more` : ""} (a source ends in a hex ref that is not a full 40-character commit sha; for a tag or branch with that name the registry should write @refs/tags/<name> or @refs/heads/<name>)`
            : undefined;
        const note = [head.note, hexNote].filter(Boolean).join("; ");
        return { ...head, ...(note ? { note } : {}), index };
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
  // Entries that are fine except for a hex ref (a 0.1.x registry may pin a tag called @deadbeef):
  // not installable as written, so they are left out, but the user is told which and what to write.
  const skippedHexRefs = skills
    .filter((e) => e && typeof e.name === "string" && SKILL_NAME_RE.test(e.name) && typeof e.source === "string" && hasHexRef(e.source))
    .map((e) => e.name);
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
    ...(skippedHexRefs.length > 0 ? { skippedHexRefs } : {}),
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

function hasHexRef(s: string): boolean {
  try {
    parseSource(s);
    return false;
  } catch (e) {
    return e instanceof ShortShaError;
  }
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

function scoreEntry(e: RegistryEntry, terms: string[]): number {
  const hay = `${e.name} ${e.description} ${(e.tags ?? []).join(" ")}`.toLowerCase();
  let score = 0;
  for (const t of terms) {
    if (e.name.toLowerCase() === t) score += 10;
    else if (e.name.toLowerCase().includes(t)) score += 5;
    if ((e.tags ?? []).some((tag) => tag.toLowerCase() === t)) score += 4;
    if (hay.includes(t)) score += 1;
  }
  return score;
}

export function searchRegistry(idx: RegistryIndex, query: string): (RegistryEntry & { score: number })[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored = idx.skills.map((e) => ({ ...e, score: scoreEntry(e, terms) }));
  return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/**
 * Search every registry that loaded. Each row names its registry; the same
 * skill name in two registries is two rows. Order: score, then the order the
 * registries are listed in, then name.
 */
export function searchRegistries(registries: LoadedRegistry[], query: string): SearchHit[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const rows: (SearchHit & { order: number })[] = [];
  registries.forEach((r, order) => {
    for (const e of r.index?.skills ?? []) {
      const score = scoreEntry(e, terms);
      if (score > 0) rows.push({ ...e, registry: r.name, score, order });
    }
  });
  rows.sort((a, b) => b.score - a.score || a.order - b.order || a.name.localeCompare(b.name));
  return rows.map(({ order: _order, ...hit }) => hit);
}

/** True for an argument of `add` that names a registry skill: a plain skill-style name, not a path, URL or source. */
export function isRegistryName(arg: string): boolean {
  return SKILL_NAME_RE.test(arg);
}

/**
 * The entry `add <name>` installs. Registries are tried in order; a name two of
 * them list is refused (showing both) unless `from` names the registry.
 */
export function resolveRegistryName(
  registries: LoadedRegistry[],
  name: string,
  from?: string,
): { registry: string; entry: RegistryEntry } {
  if (from !== undefined) {
    const r = registries.find((x) => x.name === from);
    if (!r) throw new Error(`no registry named "${from}"; known: ${registries.map((x) => x.name).join(", ") || "(none)"}`);
    if (!r.index) throw new Error(`registry "${r.name}" could not be loaded: ${r.error ?? "unknown error"}`);
    const entry = r.index.skills.find((e) => e.name === name);
    if (!entry) throw new Error(`"${name}" is not in registry "${r.name}"`);
    return { registry: r.name, entry };
  }
  const hits = registries.flatMap((r) => (r.index?.skills ?? []).filter((e) => e.name === name).map((entry) => ({ registry: r.name, entry })));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) {
    const listed = hits.map((h) => `${h.registry} (${h.entry.source})`);
    const who = listed.length === 2 ? `${listed[0]} and ${listed[1]}` : `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}`;
    throw new Error(`"${name}" is listed by ${who}; pick one with --from <registry>`);
  }
  const failed = registries.filter((r) => r.error !== undefined);
  throw new Error(
    `\`${name}\` is not in any registry; for a local folder use \`./${name}\`` +
      (failed.length > 0 ? ` (registries that could not be loaded: ${failed.map((r) => `${r.name}: ${r.error}`).join("; ")})` : ""),
  );
}

/** The registries a manifest lists, written out as a `registries` list (the implied public one and the old field included). */
function materialize(m: Manifest): RegistrySpec[] {
  return registriesOf(m).map((r) => ({ ...r }));
}

/** A path location as it is written to a manifest: project-relative (`./x`) inside the project, else absolute; other kinds as typed. */
function locationForManifest(ctx: Context, location: string): string {
  if (location === "default" || classifyLocation(location) !== "path" || location.startsWith("~/") || location === "~") return location;
  const abs = path.resolve(process.cwd(), location);
  if (!ctx.global && isInside(ctx.root, abs)) {
    const rel = path.relative(ctx.root, abs).split(path.sep).join("/");
    return rel === "" ? "." : `./${rel}`;
  }
  return abs;
}

/**
 * `registry add`: check the name, load the index once (a typo fails here and
 * nothing is written), then append to the manifest's list. A manifest that
 * listed nothing keeps the public registry in the list; the old `registry`
 * field becomes a list entry named "registry".
 */
export async function addRegistry(
  ctx: Context,
  name: string,
  location: string,
  opts: LoadRegistryOptions = {},
): Promise<{ entries: number }> {
  const m = requireManifest(ctx);
  const list = materialize(m);
  if (name === "default" && location.trim() !== "default") {
    throw new Error(`the name "default" is the public registry; it cannot point at another location (choose another name)`);
  }
  if (list.some((r) => r.name === name)) throw new Error(`registry "${name}" is already listed`);
  const spec: RegistrySpec = { name, location: locationForManifest(ctx, location.trim()) };
  validateManifest({ ...m, registries: [...list, spec], registry: undefined }, manifestPath(ctx));
  const index = await loadRegistry(resolveLocation(location.trim(), process.cwd(), ctx.home), opts);
  const next: Manifest = { ...m, registries: [...list, spec] };
  delete next.registry;
  saveManifest(ctx, next);
  return { entries: index.skills.length };
}

/** `registry remove`: drop one registry from the manifest's list (the last one leaves an explicit empty list). */
export function removeRegistry(ctx: Context, name: string): void {
  const m = requireManifest(ctx);
  const list = materialize(m);
  if (!list.some((r) => r.name === name)) {
    throw new Error(`no registry named "${name}"; known: ${list.map((r) => r.name).join(", ") || "(none)"}`);
  }
  const next: Manifest = { ...m, registries: list.filter((r) => r.name !== name) };
  delete next.registry;
  saveManifest(ctx, next);
}

/** Insert or replace an entry in a local registry checkout's index.json. */
export function publishToRegistry(registryDir: string, entry: RegistryEntry): { created: boolean; file: string } {
  // The name comes from a SKILL.md and is printed and embedded in a suggested
  // shell command; loadRegistry would drop an entry with a bad name anyway.
  assertSkillName(entry.name);
  const file = path.join(registryDir, "index.json");
  // A checkout cloned from someone else's repository may hold index.json as a link;
  // writing would then change a file elsewhere. The checkout folder itself may be a link.
  assertNoSymlinks(registryDir, file);
  const idx = readJson<RegistryIndex>(file) ?? { version: 1, skills: [] };
  const i = idx.skills.findIndex((s) => s.name === entry.name);
  const created = i < 0;
  if (created) idx.skills.push(entry);
  else idx.skills[i] = entry;
  idx.skills.sort((a, b) => a.name.localeCompare(b.name));
  writeJson(file, idx);
  return { created, file };
}
