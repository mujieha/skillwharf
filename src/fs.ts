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
