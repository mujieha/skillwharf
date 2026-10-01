import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertWithinLimits, copyDir, isDir, isInside, type SizeLimits } from "./fs.js";
import { isSkillDir } from "./skill.js";
import { assertGitRef, assertGithubOwner, assertGithubRepo, assertSubpath } from "./validate.js";

export type ParsedSource =
  | { kind: "github"; owner: string; repo: string; subpath: string; ref?: string; raw: string }
  | { kind: "path"; path: string; raw: string };

/**
 * Accepted forms:
 *   github:owner/repo
 *   github:owner/repo/sub/dir@ref
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/ref/sub/dir
 *   path:./relative or ./relative, ../x, /abs, ~/x
 */
export function parseSource(raw: string, cwd = process.cwd()): ParsedSource {
  const s = raw.trim();

  if (s.startsWith("github:")) {
    const rest = s.slice("github:".length);
    const [spec, ref] = splitRef(rest);
    const parts = spec.split("/").filter(Boolean);
    if (parts.length < 2) throw new Error(`Invalid github source "${raw}" (need owner/repo)`);
    const [owner, repo, ...sub] = parts;
    return github(owner, repo, sub.join("/"), ref, s);
  }

  const gh = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/);
  if (gh) {
    const [, owner, repoRaw, ref, sub] = gh;
    return github(owner, repoRaw.replace(/\.git$/, ""), (sub ?? "").replace(/\/+$/, ""), ref, s);
  }

  // A path. Relative paths resolve against `cwd`: the working directory for a
  // path the user just typed, the project root for one read from a manifest or
  // lockfile (see parseStoredSource in ops.ts, which also confines those).
  let p = s.startsWith("path:") ? s.slice(5) : s;
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  return { kind: "path", path: path.resolve(cwd, p), raw: s };
}

function github(owner: string, repo: string, subpath: string, ref: string | undefined, raw: string): ParsedSource {
  return {
    kind: "github",
    owner: assertGithubOwner(owner),
    repo: assertGithubRepo(repo),
    subpath: assertSubpath(subpath),
    ref: ref === undefined ? undefined : assertGitRef(ref),
    raw,
  };
}

export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

function splitRef(spec: string): [string, string | undefined] {
  const at = spec.lastIndexOf("@");
  if (at > 0) return [spec.slice(0, at), spec.slice(at + 1)];
  return [spec, undefined];
}

export function formatSource(p: ParsedSource, ref?: string): string {
  if (p.kind === "path") return `path:${p.path}`;
  const base = `github:${p.owner}/${p.repo}${p.subpath ? "/" + p.subpath : ""}`;
  const r = ref ?? p.ref;
  return r ? `${base}@${r}` : base;
}

export interface Fetched {
  /** Directory containing SKILL.md (may be inside a temp dir) */
  dir: string;
  /** Resolved source string with exact commit when known */
  resolved: string;
  /** Call to remove temp files */
  cleanup: () => void;
}

/** Fetch a source into a directory we can read from. */
export function fetchSource(src: ParsedSource): Fetched {
  if (src.kind === "path") {
    if (!isDir(src.path)) throw new Error(`Path not found: ${src.path}`);
    return { dir: src.path, resolved: formatSource(src), cleanup: () => {} };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillwharf-"));
  const url = `https://github.com/${src.owner}/${src.repo}.git`;
  const git = (args: string[]) => execFileSync("git", args, { stdio: ["ignore", "ignore", "pipe"] });
  try {
    if (src.ref && isCommitSha(src.ref)) {
      // Pinned commit (from the lockfile): fetch exactly that object.
      git(["init", "--quiet", tmp]);
      git(["-C", tmp, "remote", "add", "origin", url]);
      git(["-C", tmp, "fetch", "--depth", "1", "--quiet", "origin", src.ref]);
      git(["-C", tmp, "checkout", "--quiet", "FETCH_HEAD"]);
    } else {
      const args = ["clone", "--depth", "1", "--quiet"];
      if (src.ref) args.push("--branch", src.ref);
      args.push(url, tmp);
      git(args);
    }
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`git fetch failed for ${url}${src.ref ? ` @${src.ref}` : ""}: ${msg.split("\n")[0]}`);
  }
  // Always the full sha: hosts (GitHub included) refuse to serve an
  // abbreviated one, so a short pin could never be fetched again.
  let dir: string;
  let sha: string;
  try {
    sha = execFileSync("git", ["-C", tmp, "rev-parse", "HEAD"]).toString().trim();
    dir = resolveSubpath(tmp, src.subpath, `${src.owner}/${src.repo}`);
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return {
    dir,
    resolved: formatSource(src, sha),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

/**
 * `sub` below the clone at `root`, walked one component at a time with lstat.
 * A repository can commit a link anywhere in its tree (`l -> /`), and a plain
 * path.join + stat would follow it out of the clone and copy a local folder
 * into the store. Any link on the way is refused, not followed; the resolved
 * result is also checked to lie inside the clone.
 */
function resolveSubpath(root: string, sub: string, repoLabel: string): string {
  let cur = root;
  for (const part of sub.split("/").filter(Boolean)) {
    cur = path.join(cur, part);
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(cur);
    } catch {
      st = undefined;
    }
    if (st?.isSymbolicLink()) {
      throw new Error(`Sub-path "${sub}" in ${repoLabel} passes through a symlink ("${part}"); symlinks in fetched repositories are never followed.`);
    }
    if (!st?.isDirectory()) throw new Error(`Sub-path "${sub}" not found in ${repoLabel}`);
  }
  if (!isInside(fs.realpathSync(root), fs.realpathSync(cur))) {
    throw new Error(`Sub-path "${sub}" in ${repoLabel} resolves outside the fetched repository; refusing it.`);
  }
  return cur;
}

/**
 * A fetched directory may itself be a skill, or a folder of skills
 * (e.g. a repo root with skills/<name>/SKILL.md). Returns skill dirs found.
 */
export function discoverSkills(dir: string, maxDepth = 2): string[] {
  if (isSkillDir(dir)) return [dir];
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > maxDepth) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const child = path.join(d, e.name);
      if (isSkillDir(child)) found.push(child);
      else walk(child, depth + 1);
    }
  };
  walk(dir, 1);
  return found.sort();
}

/** Copy a skill folder into the store, after checking it is within the size cap. */
export function installToStore(fromDir: string, storeDir: string, limits?: SizeLimits): void {
  assertWithinLimits(fromDir, limits);
  copyDir(fromDir, storeDir);
}
