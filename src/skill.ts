import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { isInside } from "./fs.js";
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

/**
 * The SKILL.md in `dir`, only if it is a regular file. A symlinked one is
 * treated as absent: in a fetched repo it could point at any local file, whose
 * contents would then be read and printed as skill metadata.
 */
function skillFile(dir: string): string | undefined {
  const file = path.join(dir, "SKILL.md");
  try {
    return fs.lstatSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Largest SKILL.md that is read; the size cap on the folder comes later, so this one is checked on its own. */
const MAX_SKILL_MD_BYTES = 1024 * 1024;

export function readSkill(dir: string): SkillMeta {
  const file = skillFile(dir);
  if (!file) {
    throw new Error(`No SKILL.md found in ${dir}`);
  }
  if (fs.lstatSync(file).size > MAX_SKILL_MD_BYTES) {
    throw new Error(`SKILL.md in ${dir} is larger than 1 MB; refusing to read it.`);
  }
  return parseSkillMd(fs.readFileSync(file, "utf8"), path.basename(dir));
}

export function isSkillDir(dir: string): boolean {
  return skillFile(dir) !== undefined;
}

/**
 * Like `isSkillDir`, but for a folder inside a fetched repository (`root`): a
 * SKILL.md that is a symlink counts when it resolves to a regular file inside
 * that repository (outside any `.git`). Repositories that mirror one canonical
 * SKILL.md into several agent folders rely on this. One that resolves outside
 * the repository is not a skill, so its target is never read.
 */
export function isSkillDirIn(dir: string, root: string): boolean {
  if (skillFile(dir) !== undefined) return true;
  try {
    const file = path.join(dir, "SKILL.md");
    if (!fs.lstatSync(file).isSymbolicLink()) return false;
    const realRoot = fs.realpathSync(root);
    const real = fs.realpathSync(file);
    return isInside(realRoot, real) && !path.relative(realRoot, real).split(path.sep).includes(".git") && fs.statSync(real).isFile();
  } catch {
    return false;
  }
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
