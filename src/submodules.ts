/**
 * Submodules, one level, pinned. A fetched repository can vendor other
 * repositories as gitlinks. skillwharf never runs `git submodule` or
 * `--recurse-submodules`: it reads the gitlinks and `.gitmodules` from the
 * fetched commit, validates the URL with the same grammar as a typed source,
 * fetches the child at exactly the commit the parent records, with the same
 * guards, and places its files where the gitlink was.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_FILES, assertNoSymlinks, copyResolvingLinks, exists } from "./fs.js";
import { runGit } from "./git.js";
import { sanitizeForTerminal } from "./validate.js";

/** Most gitlinks one fetch will open; more means the sub-path should be narrower. */
export const MAX_SUBMODULES = 16;

export interface SubmoduleContext {
  /** The clone URL of the repository that was fetched (for relative `.gitmodules` URLs and error messages). */
  parentUrl: string;
  timeoutMs?: number;
  deadline?: number;
  /**
   * Validate an absolute `.gitmodules` URL (already in the universal
   * `git+https://` / `git+ssh://` spelling) with the source grammar and return
   * the URL to clone. Throws for anything the grammar refuses.
   */
  cloneUrlFor(universal: string): string;
}

interface Gitlink {
  path: string;
  sha: string;
}

/** Safe to print: control characters stripped, and a password or token in a URL's user info hidden. */
const shown = (s: string) => sanitizeForTerminal(s).replace(/(\/\/)[^/@\s]*@/g, "$1***@");

/**
 * Fetch and place every submodule the requested sub-path touches: a gitlink
 * that is the sub-path, lies under it, or that the sub-path passes through.
 * Does nothing (and runs no git) when the repository has no `.gitmodules`.
 */
export function placeSubmodules(root: string, subpath: string, ctx: SubmoduleContext): string[] {
  const dropped: string[] = [];
  const modulesFile = path.join(root, ".gitmodules");
  if (!exists(modulesFile)) return dropped;
  if (fs.lstatSync(modulesFile).isSymbolicLink()) {
    throw new Error(`${shown(ctx.parentUrl)}: .gitmodules is a symlink; refusing to read it.`);
  }

  const relevant = listGitlinks(root, ctx).filter(
    (l) => subpath === "" || l.path === subpath || l.path.startsWith(`${subpath}/`) || subpath.startsWith(`${l.path}/`),
  );
  if (relevant.length === 0) return dropped;
  if (relevant.length > MAX_SUBMODULES) {
    throw new Error(
      `${shown(ctx.parentUrl)} holds ${relevant.length} submodules under "${shown(subpath)}"; skillwharf opens at most ${MAX_SUBMODULES} at once. Point at a narrower sub-path.`,
    );
  }

  const urls = readSubmoduleUrls(root, ctx);
  for (const link of relevant) {
    const raw = urls.get(link.path);
    if (raw === undefined) {
      throw new Error(`${shown(ctx.parentUrl)}: the submodule at "${shown(link.path)}" has no entry for it in .gitmodules; refusing it.`);
    }
    const url = childUrl(raw, link.path, ctx);
    for (const d of fetchChild(root, link, url, ctx)) dropped.push(`${link.path}/${d}`);
  }
  return dropped;
}

/** Gitlinks (mode 160000) in the fetched commit, with their recorded sha. */
function listGitlinks(root: string, ctx: SubmoduleContext): Gitlink[] {
  const out = runGit(["-C", root, "ls-tree", "-r", "-z", "HEAD"], { url: ctx.parentUrl, timeoutMs: ctx.timeoutMs, deadline: ctx.deadline });
  const links: Gitlink[] = [];
  for (const rec of out.split("\0")) {
    if (rec === "") continue;
    const tab = rec.indexOf("\t");
    if (tab < 0) continue;
    const [mode, , sha] = rec.slice(0, tab).split(" ");
    if (mode !== "160000") continue;
    const p = rec.slice(tab + 1);
    const parts = p.split("/");
    if (parts.some((s) => s === "" || s === "." || s === ".." || s.toLowerCase() === ".git") || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`${shown(ctx.parentUrl)}: the submodule path "${shown(p)}" is not a safe path; refusing it.`);
    }
    links.push({ path: p, sha });
  }
  return links;
}

/** path → url for every `[submodule "x"]` section of the committed `.gitmodules`. */
function readSubmoduleUrls(root: string, ctx: SubmoduleContext): Map<string, string> {
  const opts = { url: ctx.parentUrl, timeoutMs: ctx.timeoutMs, deadline: ctx.deadline };
  const entry = runGit(["-C", root, "ls-tree", "-z", "HEAD", "--", ".gitmodules"], opts).split("\0")[0];
  const [mode, type, oid] = entry.slice(0, Math.max(entry.indexOf("\t"), 0)).split(" ");
  if (!entry || type !== "blob" || mode !== "100644" || !/^[0-9a-f]{40}$/.test(oid ?? "")) {
    throw new Error(`${shown(ctx.parentUrl)}: .gitmodules is not a regular committed file; refusing to read it.`);
  }
  const text = runGit(["-C", root, "config", "--blob", oid, "--null", "--get-regexp", "^submodule\\."], opts);
  const sections = new Map<string, { path?: string; url?: string }>();
  for (const rec of text.split("\0")) {
    const nl = rec.indexOf("\n");
    if (nl < 0) continue;
    const key = rec.slice("submodule.".length, nl);
    const value = rec.slice(nl + 1);
    const dot = key.lastIndexOf(".");
    const name = key.slice(0, dot);
    const variable = key.slice(dot + 1).toLowerCase();
    const section = sections.get(name) ?? {};
    if (variable === "path") section.path = value;
    if (variable === "url") section.url = value;
    sections.set(name, section);
  }
  const byPath = new Map<string, string>();
  for (const s of sections.values()) if (s.path !== undefined && s.url !== undefined) byPath.set(s.path, s.url);
  return byPath;
}

/** A `.gitmodules` URL as a validated clone URL: relative ones resolve against the parent's, the rest go through the source grammar. */
function childUrl(raw: string, at: string, ctx: SubmoduleContext): string {
  const bad = (why: string) =>
    new Error(`${shown(ctx.parentUrl)}: the submodule at "${shown(at)}" has the URL "${shown(raw)}", which skillwharf refuses (${why}).`);
  let absolute = raw;
  if (raw.startsWith("./") || raw.startsWith("../")) {
    const resolved = resolveRelative(ctx.parentUrl, raw);
    if (!resolved) throw bad("a relative URL that climbs out of the host");
    absolute = resolved;
  }
  let universal: string;
  if (/^https:\/\//.test(absolute) || /^ssh:\/\//.test(absolute)) universal = `git+${absolute}`;
  else {
    const scp = /^([A-Za-z0-9._-]+)@([^\s/:]+):(.+)$/.exec(absolute);
    if (!scp) throw bad("only https and ssh URLs are fetched");
    universal = `git+ssh://${scp[1]}@${scp[2]}/${scp[3].replace(/^\//, "")}`;
  }
  try {
    return ctx.cloneUrlFor(universal);
  } catch (e) {
    throw bad((e as Error).message.replace(/^Invalid source "[^"]*": /, ""));
  }
}

/** git's rule for relative submodule URLs: each `../` drops one component of the parent's URL. */
function resolveRelative(parentUrl: string, rel: string): string | undefined {
  const m = /^([a-z+]+:\/\/[^/]+)(\/.*)?$/i.exec(parentUrl.replace(/\/+$/, ""));
  if (!m) return undefined;
  const parts = (m[2] ?? "").split("/").filter(Boolean);
  let rest = rel;
  for (;;) {
    if (rest.startsWith("./")) rest = rest.slice(2);
    else if (rest.startsWith("../")) {
      if (parts.length === 0) return undefined;
      parts.pop();
      rest = rest.slice(3);
    } else break;
  }
  return `${m[1]}/${[...parts, rest].filter(Boolean).join("/")}`;
}

/** Fetch `link.sha` from `url` (no fallback: it is exactly the commit the parent records) and place it at the gitlink. */
function fetchChild(root: string, link: Gitlink, url: string, ctx: SubmoduleContext): string[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "skillwharf-sub-"));
  try {
    const run = (args: string[], contact = false) => runGit(args, { url, timeoutMs: ctx.timeoutMs, deadline: ctx.deadline, contact });
    run(["init", "--quiet", tmp]);
    run(["-C", tmp, "remote", "add", "--", "origin", url]);
    run(["-C", tmp, "fetch", "--depth", "1", "--quiet", "origin", link.sha], true);
    run(["-C", tmp, "checkout", "--quiet", "FETCH_HEAD"]);

    // One level only: a gitlink inside the child is refused, naming the repository it points at.
    const inner = run(["-C", tmp, "ls-tree", "-r", "-z", "HEAD"])
      .split("\0")
      .filter((r) => r.startsWith("160000 "))
      .map((r) => r.slice(r.indexOf("\t") + 1));
    if (inner.length > 0) {
      throw new Error(
        `The submodule at "${shown(link.path)}" (${shown(url)}) contains another submodule ("${shown(inner[0])}"${innerRepository(tmp, inner[0], run)}); ` +
          `only one level of submodules is supported.`,
      );
    }

    const target = path.join(root, ...link.path.split("/"));
    assertNoSymlinks(root, target);
    const st = fs.lstatSync(target, { throwIfNoEntry: false });
    if (!st || !st.isDirectory() || fs.readdirSync(target).length > 0) {
      throw new Error(`${shown(ctx.parentUrl)}: the submodule path "${shown(link.path)}" is not an empty folder after checkout; refusing to place files into it.`);
    }
    // The same copy as the parent's skill folder gets: a link inside the
    // submodule is followed, one that leaves it is dropped, `.git` is left
    // out. (A plain recursive copy would rewrite a relative link to an
    // absolute path into the temp folder that is deleted below.) The
    // submodule is not capped like a skill folder, since only part of it is
    // installed, but a link bomb still hits a bound.
    return copyResolvingLinks(tmp, target, {
      root: tmp,
      limits: { maxFiles: 10 * DEFAULT_MAX_FILES, maxBytes: 10 * DEFAULT_MAX_BYTES },
    }).dropped;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** ", <url>" of the inner repository when the child's own `.gitmodules` says it, else "". */
export function innerRepository(childRoot: string, innerPath: string, run: (args: string[]) => string): string {
  try {
    // The child's .gitmodules gets the same refusal of a symlink as the parent's.
    const file = path.join(childRoot, ".gitmodules");
    if (!exists(file) || fs.lstatSync(file).isSymbolicLink()) return "";
    const text = run(["-C", childRoot, "config", "--file", ".gitmodules", "--null", "--get-regexp", "^submodule\\..*\\.(path|url)$"]);
    const byName = new Map<string, { path?: string; url?: string }>();
    for (const rec of text.split("\0")) {
      const nl = rec.indexOf("\n");
      if (nl < 0) continue;
      const key = rec.slice("submodule.".length, nl);
      const dot = key.lastIndexOf(".");
      const s = byName.get(key.slice(0, dot)) ?? {};
      if (key.slice(dot + 1) === "path") s.path = rec.slice(nl + 1);
      else s.url = rec.slice(nl + 1);
      byName.set(key.slice(0, dot), s);
    }
    for (const s of byName.values()) if (s.path === innerPath && s.url) return `, ${shown(s.url)}`;
  } catch {
    /* the child's .gitmodules is missing or unreadable: the path alone names it */
  }
  return "";
}
