import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

export function readJson<T>(p: string): T | undefined {
  if (!exists(p)) return undefined;
  return JSON.parse(fs.readFileSync(p, "utf8")) as T;
}

export function writeJson(p: string, data: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n");
}

/** Recursively list files (relative, posix-style, sorted). Skips .git. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const relChild = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(relChild);
      else if (entry.isFile()) out.push(relChild);
    }
  };
  walk("");
  return out.sort();
}

/**
 * Directories and "odd" entries below `dir`, by lstat (links are never followed).
 * Odd means anything `copyDir` never writes: a `.git` entry wherever it is, a
 * symlink, or a file that is neither regular nor a directory.
 */
function scanTree(dir: string): { dirs: string[]; odd: string[] } {
  const dirs: string[] = [];
  const odd: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const relChild = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git" || e.isSymbolicLink()) odd.push(relChild);
      else if (e.isDirectory()) {
        dirs.push(relChild);
        walk(relChild);
      } else if (!e.isFile()) odd.push(relChild);
    }
  };
  walk("");
  return { dirs: dirs.sort(), odd };
}

/**
 * True only when `copy` is what `copyDir(original, copy)` would have produced:
 * the same regular files byte for byte, the same folders, and nothing `copyDir`
 * strips (`.git`, symlinks, sockets). `hashDir` alone ignores all of those, so a
 * user's own `git clone` of the same commit would pass for a copy and be deleted.
 */
export function isPlainCopyOf(copy: string, original: string): boolean {
  try {
    const a = scanTree(copy);
    const b = scanTree(original);
    if (a.odd.length > 0 || b.odd.length > 0) return false;
    if (a.dirs.join("\0") !== b.dirs.join("\0")) return false;
    return hashDir(copy) === hashDir(original);
  } catch {
    return false;
  }
}

/** Largest skill folder skillwharf installs unless told otherwise. */
export const DEFAULT_MAX_FILES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024 * 1024;

export interface SizeLimits {
  /** Files and folders, counted together. */
  maxFiles?: number;
  maxBytes?: number;
}

function formatBytes(n: number): string {
  return n >= 1024 * 1024 ? `${Math.round((n / (1024 * 1024)) * 100) / 100} MB` : `${Math.round((n / 1024) * 100) / 100} KB`;
}

/**
 * Throws when the folder `copyDir` would copy holds more entries or bytes than
 * the cap. Walks without following links and skips what `copyDir` skips, and
 * stops at the first excess, so a hostile tree is refused before one byte of it
 * is written anywhere.
 */
export function assertWithinLimits(dir: string, limits: SizeLimits = {}): void {
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  let entries = 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length > 0) {
    const cur = stack.pop() as string;
    for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
      if (e.name === ".git" || e.isSymbolicLink()) continue;
      const p = path.join(cur, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (!e.isFile()) continue;
      entries += 1;
      if (entries > maxFiles) {
        throw new Error(
          `${path.basename(dir)}: more than ${maxFiles} files and folders; refusing to install it. Raise the cap with --max-skill-files <n> if you trust it.`,
        );
      }
      if (e.isFile()) {
        bytes += fs.lstatSync(p).size;
        if (bytes > maxBytes) {
          throw new Error(
            `${path.basename(dir)}: more than ${formatBytes(maxBytes)} of files; refusing to install it. Raise the cap with --max-skill-size <mb> if you trust it.`,
          );
        }
      }
    }
  }
}

/**
 * sha256 over sorted relative paths, the owner-exec bit, the length and the
 * bytes of every file. Stable across machines. The length prefix keeps one
 * file's bytes from being read as the next file's header.
 */
export function hashDir(dir: string): string {
  const h = createHash("sha256");
  for (const rel of listFiles(dir)) {
    const abs = path.join(dir, rel);
    const bytes = fs.readFileSync(abs);
    const exec = (fs.statSync(abs).mode & 0o100) !== 0 ? "x" : "-";
    h.update(`${rel}\0${exec}\0${bytes.length}\0`);
    h.update(bytes);
  }
  return `sha256-${h.digest("base64")}`;
}

/**
 * Refuse to touch `target` unless every path component from `root` down to it
 * is a real directory (or does not exist yet). `root` itself may be reached
 * through a symlink (e.g. macOS /var -> /private/var, or a symlinked checkout);
 * nothing *inside* it may be. With `leaf: false` the final component is not
 * checked, for agent targets that are symlinks by design.
 *
 * A committed `.skillwharf/skills -> ../..` or `.claude -> ~` would otherwise
 * turn every copy, write and rm -rf into one outside the project.
 */
export function assertNoSymlinks(root: string, target: string, opts: { leaf?: boolean } = {}): void {
  const leaf = opts.leaf ?? true;
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(target);
  const rel = path.relative(absRoot, absTarget);
  if (rel === "" || escapes(rel)) {
    throw new Error(`Refusing to touch ${absTarget}: it is outside ${absRoot}`);
  }
  if (!exists(absRoot)) return; // nothing below a missing root can be a symlink
  const parts = rel.split(path.sep);
  const checked = leaf ? parts : parts.slice(0, -1);
  let cur = absRoot;
  let nearest = absRoot;
  for (const part of checked) {
    cur = path.join(cur, part);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      break; // does not exist yet; nothing below it can either
    }
    if (st.isSymbolicLink()) {
      throw new Error(`Refusing to write through a symlink: ${cur} is a symlink. Remove it and re-run.`);
    }
    nearest = cur;
  }
  const realRoot = fs.realpathSync(absRoot);
  const realNearest = fs.realpathSync(nearest);
  if (escapes(path.relative(realRoot, realNearest))) {
    throw new Error(`Refusing to touch ${absTarget}: it resolves outside ${absRoot}`);
  }
}

/** True when a path.relative() result leaves its base directory. */
export function escapes(rel: string): boolean {
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/** True when `p` is `dir` or lies below it (string comparison on resolved paths). */
export function isInside(dir: string, p: string): boolean {
  return !escapes(path.relative(path.resolve(dir), path.resolve(p)));
}

/**
 * Copy a skill folder. Symlinks are never copied: a skill fetched from a
 * remote repo could otherwise smuggle a link to ~/.ssh or similar into the
 * agent's readable tree. Hidden VCS folders are skipped too.
 */
export function copyDir(src: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, {
    recursive: true,
    dereference: false,
    filter: (p) => {
      const base = path.basename(p);
      if (base === ".git") return false;
      try {
        return !fs.lstatSync(p).isSymbolicLink();
      } catch {
        return false;
      }
    },
  });
}

/** Relative paths of symlinks inside a directory (for diagnostics). */
export function findSymlinks(dir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const relChild = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) out.push(relChild);
      else if (e.isDirectory() && e.name !== ".git") walk(relChild);
    }
  };
  walk("");
  return out;
}

export function removePath(p: string): void {
  fs.rmSync(p, { recursive: true, force: true });
}

/**
 * Create a symlink at `linkPath` pointing to `target`. Replaces an existing
 * link/dir. Falls back to copying when symlinks are not permitted (Windows
 * without Developer Mode). Returns the mode actually used.
 */
export function linkOrCopy(target: string, linkPath: string): "symlink" | "copy" {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  if (exists(linkPath)) fs.rmSync(linkPath, { recursive: true, force: true });
  const rel = path.relative(path.dirname(linkPath), target);
  try {
    fs.symlinkSync(rel, linkPath, process.platform === "win32" ? "junction" : "dir");
    return "symlink";
  } catch {
    copyDir(target, linkPath);
    return "copy";
  }
}

export function resolveLink(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}
