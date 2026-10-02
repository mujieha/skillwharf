import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson } from "./fs.js";
import { DEFAULT_REGISTRY } from "./manifest.js";
import { parseSource } from "./source.js";
import type { RegistryEntry, RegistryIndex } from "./types.js";
import { assertSkillName, sanitizeForTerminal } from "./validate.js";

/** Load a registry index from an http(s) URL, a local index.json, or a directory containing one. */
export async function loadRegistry(location: string): Promise<RegistryIndex> {
  if (/^http:\/\//i.test(location)) throw new Error(`Registry must be served over https: ${location}`);
  if (/^https:\/\//i.test(location)) {
    const res = await fetch(location, { redirect: "error", signal: AbortSignal.timeout(15_000) });
    if (res.status === 404 && location === DEFAULT_REGISTRY) {
      throw new Error("the default registry is not available yet; pass --registry <url|path>");
    }
    if (!res.ok) throw new Error(`Registry fetch failed (${res.status}) for ${location}`);
    return normalize(JSON.parse(await readCapped(res, MAX_REGISTRY_BYTES)) as RegistryIndex);
  }
  const p = fs.existsSync(location) && fs.statSync(location).isDirectory() ? path.join(location, "index.json") : location;
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
