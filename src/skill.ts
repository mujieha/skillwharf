import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import type { SkillMeta } from "./types.js";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillMd(text: string, fallbackName: string): SkillMeta {
  const m = text.match(FM_RE);
  let fm: Record<string, unknown> = {};
  let body = text;
  if (m) {
    try {
      fm = (YAML.parse(m[1]) as Record<string, unknown>) ?? {};
    } catch {
      fm = {};
    }
    body = m[2];
  }
  const name = typeof fm.name === "string" && fm.name.trim() ? fm.name.trim() : fallbackName;
  const description =
    typeof fm.description === "string" ? fm.description.trim() : firstParagraph(body);
  const version = typeof fm.version === "string" || typeof fm.version === "number" ? String(fm.version) : undefined;
  return { name, description, version, frontmatter: fm, body };
}

function firstParagraph(body: string): string {
  const lines = body.split(/\r?\n/).map((l) => l.trim());
  const para = lines.find((l) => l && !l.startsWith("#"));
  return para ?? "";
}

export function readSkill(dir: string): SkillMeta {
  const file = path.join(dir, "SKILL.md");
  if (!fs.existsSync(file)) {
    throw new Error(`No SKILL.md found in ${dir}`);
  }
  return parseSkillMd(fs.readFileSync(file, "utf8"), path.basename(dir));
}

export function isSkillDir(dir: string): boolean {
  return fs.existsSync(path.join(dir, "SKILL.md"));
}

/** Valid skill folder / registry names: lowercase, digits, dashes. */
export function normalizeName(raw: string): string {
  const n = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!n) throw new Error(`Cannot derive a valid skill name from "${raw}"`);
  return n;
}
