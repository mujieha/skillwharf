import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertWithinLimits, copyDir, isDir, isInside, type SizeLimits } from "./fs.js";
import { isSkillDir } from "./skill.js";
import {
  assertGitRef,
  assertGithubOwner,
  assertGithubRepo,
  assertHost,
  assertNoForbiddenSourceChars,
  assertPort,
  assertRepoPath,
  assertSubpath,
  credentialsError,
  sanitizeForTerminal,
} from "./validate.js";

export type Shorthand = "github" | "gitlab" | "bitbucket";

/** A repository on any git host, reached over https or ssh. */
export interface GitSource {
  kind: "git";
  protocol: "https" | "ssh";
  /** Lowercased; an IPv6 literal keeps its brackets. */
  host: string;
  port?: number;
  /** The literal `git` user of an ssh URL, when it was written. */
  user?: "git";
  /** Group(s) and repository, without the `.git` suffix. */
  repoPath: string;
  /** The repository was written with a `.git` suffix (universal form only). */
  dotGit: boolean;
  /** Set when this is https on github.com, gitlab.com or bitbucket.org: the canonical form is the shorthand. */
  shorthand?: Shorthand;
  subpath: string;
  ref?: string;
  raw: string;
}

export type ParsedSource = GitSource | { kind: "path"; path: string; raw: string };

const SHORTHAND_HOSTS: Record<Shorthand, string> = {
  github: "github.com",
  gitlab: "gitlab.com",
  bitbucket: "bitbucket.org",
};

/**
 * Accepted forms:
 *   github:owner/repo[//dir | /dir][@ref]
 *   gitlab:group[/subgroup...]/repo[//dir][@ref]        (`//` required before a folder)
 *   bitbucket:owner/repo[//dir | /dir][@ref]
 *   git+https://host[:port]/path/repo.git[//dir][@ref]
 *   git+ssh://[git@]host[:port]/path/repo.git[//dir][@ref]
 *   web URLs of the three hosts (GitHub tree, GitLab /-/tree, Bitbucket src)
 *   path:./relative or ./relative, ../x, /abs, ~/x
 * Anything with another scheme (file, ext, git, http, ...) is refused here.
 */
export function parseSource(raw: string, cwd = process.cwd()): ParsedSource {
  const s = raw.trim();

  for (const name of ["github", "gitlab", "bitbucket"] as const) {
    if (s.startsWith(`${name}:`)) return parseShorthand(name, s.slice(name.length + 1), s);
  }
  if (s.startsWith("git+https://")) return parseUniversal("https", s.slice("git+https://".length), s);
  if (s.startsWith("git+ssh://")) return parseUniversal("ssh", s.slice("git+ssh://".length), s);

  const web = parseWebUrl(s);
  if (web) return web;
  if (/^https:\/\//i.test(s)) {
    throw new Error(
      `Invalid source "${sanitizeForTerminal(s)}": plain https URLs are understood only in the GitHub, GitLab and Bitbucket web forms. For any other server write git+https://host/path/repo.git//folder`,
    );
  }
  if (/^[A-Za-z0-9._-]+@[^\s/:]+:/.test(s)) {
    throw new Error(
      `Invalid source "${sanitizeForTerminal(s)}": scp-style git URLs are not supported. Write git+ssh://git@host/path/repo.git//folder`,
    );
  }
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]+):/.exec(s);
  if (scheme && scheme[1].toLowerCase() !== "path") {
    throw new Error(
      `Invalid source "${sanitizeForTerminal(s)}": unsupported source scheme "${sanitizeForTerminal(scheme[1])}:". skillwharf fetches over https or ssh only: use github:, gitlab:, bitbucket:, git+https:// or git+ssh://, or a local path.`,
    );
  }

  // A path. Relative paths resolve against `cwd`: the working directory for a
  // path the user just typed, the project root for one read from a manifest or
  // lockfile (see parseStoredSource in ops.ts, which also confines those).
  let p = s.startsWith("path:") ? s.slice(5) : s;
  if (p.startsWith("~")) p = path.join(os.homedir(), p.slice(1));
  return { kind: "path", path: path.resolve(cwd, p), raw: s };
}

/** `github:`, `gitlab:` and `bitbucket:` sources; `spec` is what follows the prefix. */
function parseShorthand(kind: Shorthand, spec: string, raw: string): GitSource {
  const [body, ref] = splitRef(spec);
  const need = kind === "gitlab" ? "group/repo" : "owner/repo";
  const tooShort = () => new Error(`Invalid ${kind} source "${sanitizeForTerminal(raw)}" (need ${need})`);
  let repoParts: string[];
  let sub: string;
  const dbl = body.indexOf("//");
  if (dbl >= 0) {
    repoParts = body.slice(0, dbl).split("/");
    sub = body.slice(dbl + 2).replace(/\/+$/, "");
    if (repoParts.length < 2) throw tooShort();
    if (kind !== "gitlab" && repoParts.length !== 2) throw tooShort();
  } else {
    const parts = body.split("/").filter(Boolean);
    if (parts.length < 2) throw tooShort();
    if (kind === "gitlab") {
      if (parts.length > 2) {
        throw new Error(
          `Invalid gitlab source "${sanitizeForTerminal(raw)}": GitLab groups nest, so put // between the repository and the folder, for example gitlab:group/subgroup/repo//folder`,
        );
      }
      repoParts = parts;
      sub = "";
    } else {
      repoParts = parts.slice(0, 2);
      sub = parts.slice(2).join("/");
    }
  }
  return makeSource({ protocol: "https", host: SHORTHAND_HOSTS[kind], repoParts, dotGit: false, shorthand: kind, sub, ref, raw });
}

/** `git+https://` and `git+ssh://` sources; `rest` is what follows the scheme. */
function parseUniversal(protocol: "https" | "ssh", rest: string, raw: string): GitSource {
  assertNoForbiddenSourceChars(raw);
  const slash = rest.indexOf("/");
  const authority = slash < 0 ? rest : rest.slice(0, slash);
  const pathPart = slash < 0 ? "" : rest.slice(slash + 1);

  let hostPort = authority;
  let user: "git" | undefined;
  const at = authority.lastIndexOf("@");
  if (at >= 0) {
    if (protocol === "ssh" && authority.slice(0, at) === "git") user = "git";
    else throw credentialsError(raw);
    hostPort = authority.slice(at + 1);
  }
  let hostText = hostPort;
  let port: number | undefined;
  if (hostPort.startsWith("[")) {
    const end = hostPort.indexOf("]");
    if (end < 0) throw new Error(`Invalid host "${sanitizeForTerminal(hostPort)}"`);
    hostText = hostPort.slice(0, end + 1);
    const after = hostPort.slice(end + 1);
    if (after !== "") {
      if (!after.startsWith(":")) throw new Error(`Invalid host "${sanitizeForTerminal(hostPort)}"`);
      port = assertPort(after.slice(1));
    }
  } else {
    const colon = hostPort.lastIndexOf(":");
    if (colon >= 0) {
      hostText = hostPort.slice(0, colon);
      port = assertPort(hostPort.slice(colon + 1));
    }
  }
  const host = assertHost(hostText);

  const [body, ref] = splitRef(pathPart);
  const dbl = body.indexOf("//");
  const repoText = (dbl < 0 ? body : body.slice(0, dbl)).replace(/\/$/, "");
  const sub = dbl < 0 ? "" : body.slice(dbl + 2).replace(/\/+$/, "");
  if (repoText === "") throw new Error(`Invalid source "${sanitizeForTerminal(raw)}": it needs a repository path after the host`);
  const repoParts = repoText.split("/");
  const last = repoParts[repoParts.length - 1];
  let dotGit = false;
  if (last.length > 4 && last.toLowerCase().endsWith(".git")) {
    repoParts[repoParts.length - 1] = last.slice(0, -4);
    dotGit = true;
  }

  let shorthand: Shorthand | undefined;
  if (protocol === "https" && port === undefined && user === undefined) {
    if (host === "github.com" && repoParts.length === 2) shorthand = "github";
    else if (host === "gitlab.com" && repoParts.length >= 2) shorthand = "gitlab";
    else if (host === "bitbucket.org" && repoParts.length === 2) shorthand = "bitbucket";
  }
  return makeSource({ protocol, host, port, user, repoParts, dotGit: shorthand ? false : dotGit, shorthand, sub, ref, raw });
}

/** The GitHub tree, GitLab `/-/tree` and Bitbucket `src` web URLs, converted to the shorthand. */
function parseWebUrl(s: string): GitSource | undefined {
  const gh = s.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/]+)(?:\/(.*))?)?\/?$/i);
  if (gh) {
    const [, owner, repoRaw, ref, sub] = gh;
    return makeSource({
      protocol: "https", host: "github.com", repoParts: [owner, repoRaw.replace(/\.git$/, "")], dotGit: false,
      shorthand: "github", sub: (sub ?? "").replace(/\/+$/, ""), ref, raw: s,
    });
  }
  const gl = s.match(/^https?:\/\/gitlab\.com\/([^#?]+?)\/-\/tree\/([^/#?]+)(?:\/([^#?]*))?$/i) ?? s.match(/^https?:\/\/gitlab\.com\/([^#?]+?)\/?$/i);
  if (gl) {
    const [, repoText, ref, sub] = gl;
    const repoParts = repoText.split("/");
    if (repoParts.includes("-")) {
      throw new Error(`Invalid source "${sanitizeForTerminal(s)}": use the GitLab tree URL (.../-/tree/<ref>/<folder>) or gitlab:group/repo//folder`);
    }
    const last = repoParts[repoParts.length - 1];
    if (last.toLowerCase().endsWith(".git")) repoParts[repoParts.length - 1] = last.slice(0, -4);
    return makeSource({
      protocol: "https", host: "gitlab.com", repoParts, dotGit: false, shorthand: "gitlab",
      sub: (sub ?? "").replace(/\/+$/, ""), ref, raw: s,
    });
  }
  const bb = s.match(/^https?:\/\/bitbucket\.org\/([^/]+)\/([^/#?]+)(?:\/src\/([^/#?]+)(?:\/([^#?]*))?)?\/?$/i);
  if (bb) {
    const [, owner, repoRaw, ref, sub] = bb;
    return makeSource({
      protocol: "https", host: "bitbucket.org", repoParts: [owner, repoRaw.replace(/\.git$/, "")], dotGit: false,
      shorthand: "bitbucket", sub: (sub ?? "").replace(/\/+$/, ""), ref, raw: s,
    });
  }
  return undefined;
}

/** The one place a GitSource is built: every part is validated here. */
function makeSource(a: {
  protocol: "https" | "ssh";
  host: string;
  port?: number;
  user?: "git";
  repoParts: string[];
  dotGit: boolean;
  shorthand?: Shorthand;
  sub: string;
  ref?: string;
  raw: string;
}): GitSource {
  const repoPath = assertRepoPath(a.repoParts, a.repoParts.join("/"));
  if (a.shorthand && a.repoParts.length < 2) {
    throw new Error(`Invalid ${a.shorthand} source "${sanitizeForTerminal(a.raw)}" (need ${a.shorthand === "gitlab" ? "group" : "owner"}/repo)`);
  }
  if (a.shorthand === "github") {
    assertGithubOwner(a.repoParts[0]);
    assertGithubRepo(a.repoParts[1]);
  }
  const src: GitSource = {
    kind: "git",
    protocol: a.protocol,
    host: a.host,
    ...(a.port !== undefined ? { port: a.port } : {}),
    ...(a.user ? { user: a.user } : {}),
    repoPath,
    dotGit: a.dotGit,
    ...(a.shorthand ? { shorthand: a.shorthand } : {}),
    subpath: assertSubpath(a.sub),
    ref: a.ref === undefined ? undefined : assertGitRef(a.ref),
    raw: a.raw,
  };
  return src;
}

export function isCommitSha(ref: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(ref);
}

function splitRef(spec: string): [string, string | undefined] {
  const at = spec.lastIndexOf("@");
  if (at > 0) return [spec.slice(0, at), spec.slice(at + 1)];
  return [spec, undefined];
}

/**
 * The canonical spelling: the shorthand when one exists, else the universal
 * form. `ref` replaces the source's own ref (the lockfile passes the full sha).
 * A `github:` source formats exactly as it did in 0.1.x.
 */
export function formatSource(p: ParsedSource, ref?: string): string {
  if (p.kind === "path") return `path:${p.path}`;
  const r = ref ?? p.ref;
  const tail = r ? `@${r}` : "";
  if (p.shorthand === "gitlab") {
    const folder = p.subpath ? `//${p.subpath}` : p.repoPath.split("/").length > 2 ? "//" : "";
    return `gitlab:${p.repoPath}${folder}${tail}`;
  }
  if (p.shorthand) return `${p.shorthand}:${p.repoPath}${p.subpath ? "/" + p.subpath : ""}${tail}`;
  const authority = `${p.user ? p.user + "@" : ""}${p.host}${p.port !== undefined ? ":" + p.port : ""}`;
  return `git+${p.protocol}://${authority}/${p.repoPath}${p.dotGit ? ".git" : ""}${p.subpath ? "//" + p.subpath : ""}${tail}`;
}

/**
 * What a lock entry is compared on: protocol, host, port, repository path and
 * sub-path (host lowercased, paths as written), or the folder for a local path.
 * The ref and the spelling are not part of it.
 */
export function sourceKey(p: ParsedSource): string {
  if (p.kind === "path") return `path:${p.path}`;
  return `git:${p.protocol}://${p.host}${p.port !== undefined ? ":" + p.port : ""}/${p.repoPath}//${p.subpath}`;
}

/** The URL handed to `git clone` / `git remote add`. */
export function cloneUrl(p: GitSource): string {
  if (p.shorthand) return `https://${p.host}/${p.repoPath}.git`;
  const authority = `${p.user ? p.user + "@" : ""}${p.host}${p.port !== undefined ? ":" + p.port : ""}`;
  return `${p.protocol}://${authority}/${p.repoPath}${p.dotGit ? ".git" : ""}`;
}

/** How a repository is named in messages. */
function repoLabel(p: GitSource): string {
  return p.shorthand === "github" ? p.repoPath : `${p.host}/${p.repoPath}`;
}

export interface Fetched {
  /** Directory containing SKILL.md (may be inside a temp dir) */
  dir: string;
  /** The root of the fetched repository (git sources only) */
  root?: string;
  /** The full commit sha that was checked out (git sources only) */
  sha?: string;
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
  const url = cloneUrl(src);
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
    dir = resolveSubpath(tmp, src.subpath, repoLabel(src));
  } catch (e) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return {
    dir,
    root: tmp,
    sha,
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
function resolveSubpath(root: string, sub: string, label: string): string {
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
      throw new Error(`Sub-path "${sub}" in ${label} passes through a symlink ("${part}"); a symlink on the sub-path is never followed.`);
    }
    if (!st?.isDirectory()) throw new Error(`Sub-path "${sub}" not found in ${label}`);
  }
  if (!isInside(fs.realpathSync(root), fs.realpathSync(cur))) {
    throw new Error(`Sub-path "${sub}" in ${label} resolves outside the fetched repository; refusing it.`);
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
