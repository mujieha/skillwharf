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
    return normalize((await res.json()) as RegistryIndex);
  }
  const p = fs.existsSync(location) && fs.statSync(location).isDirectory() ? path.join(location, "index.json") : location;
  const idx = readJson<RegistryIndex>(p);
  if (!idx) throw new Error(`Registry index not found at ${p}`);
  return normalize(idx);
}

function normalize(idx: RegistryIndex): RegistryIndex {
  const skills = Array.isArray(idx?.skills) ? idx.skills : [];
  // Keep only well-formed entries; a registry is remote data, not trusted input.
  const clean = skills.filter(
    (e) =>
      e && typeof e.name === "string" && SKILL_NAME_RE.test(e.name) &&
      typeof e.description === "string" && typeof e.source === "string" && e.source.length < 512 &&
      isGithubSource(e.source) &&
      (e.tags === undefined || (Array.isArray(e.tags) && e.tags.every((t) => typeof t === "string" && t.length < 40))),
  );
  return {
    version: 1,
    skills: clean.map((e) => ({
      ...e,
      description: sanitizeForTerminal(e.description.slice(0, 300)),
      tags: e.tags?.map(sanitizeForTerminal),
      version: typeof e.version === "string" ? sanitizeForTerminal(e.version) : undefined,
    })),
  };
}

/** A registry may only point at GitHub; a local path in someone else's index is never an install source. */
function isGithubSource(s: string): boolean {
  try {
    return parseSource(s).kind === "github";
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
