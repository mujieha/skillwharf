/**
 * Input validation. Everything that ends up in a filesystem path or a git
 * argument passes through here, including values read back from the
 * manifest and lockfile (which a teammate may have edited by hand).
 */

const SKILL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const GH_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const GH_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/;

export function assertSkillName(name: string): string {
  if (!SKILL_NAME_RE.test(name)) {
    throw new Error(`Invalid skill name "${name}": use lowercase letters, digits and dashes (max 64 chars)`);
  }
  return name;
}

export function assertGithubOwner(owner: string): string {
  if (!GH_OWNER_RE.test(owner)) throw new Error(`Invalid GitHub owner "${owner}"`);
  return owner;
}

export function assertGithubRepo(repo: string): string {
  if (!GH_REPO_RE.test(repo) || repo === "." || repo === "..") throw new Error(`Invalid GitHub repo "${repo}"`);
  return repo;
}

/** A git ref that is safe to pass as a positional argument (never starts with "-"). */
export function assertGitRef(ref: string): string {
  if (!GIT_REF_RE.test(ref) || ref.includes("..") || ref.endsWith(".lock") || ref.endsWith("/")) {
    throw new Error(`Invalid git ref "${ref}"`);
  }
  return ref;
}

// C0 controls, DEL, C1 controls, and the bidi embedding/override/isolate
// characters that can make a terminal show text other than what is there.
// eslint-disable-next-line no-control-regex
const TERMINAL_UNSAFE_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;

/**
 * Strip characters that can drive a terminal (escape sequences, cursor moves,
 * bell) or reorder what it displays. Apply to every string that came from a
 * manifest, lockfile, registry, SKILL.md or log before printing it.
 */
export function sanitizeForTerminal(s: string): string {
  return String(s).replace(TERMINAL_UNSAFE_RE, "");
}

/** True when `s` holds a character `sanitizeForTerminal` would strip. */
export function hasTerminalUnsafe(s: string): boolean {
  return sanitizeForTerminal(s) !== s;
}

/**
 * A copy of `value` as JSON text with every string (and key) sanitised.
 * JSON.stringify escapes only C0 controls, so C1 controls and bidi overrides
 * would otherwise reach a terminal or a log viewer through `--json` output.
 */
export function toSafeJson(value: unknown): string {
  const scrub = (v: unknown): unknown => {
    if (typeof v === "string") return sanitizeForTerminal(v);
    if (Array.isArray(v)) return v.map(scrub);
    if (v !== null && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [sanitizeForTerminal(k), scrub(x)]));
    }
    return v;
  };
  // Round-trip first so Dates and anything else with toJSON become plain data.
  return JSON.stringify(scrub(JSON.parse(JSON.stringify(value))), null, 2);
}

const SUBPATH_PART_RE = /^[A-Za-z0-9._-]+$/;

/**
 * A repo sub-path: relative, no traversal, no leading slash, and every folder
 * name limited to letters, digits, `.`, `_` and `-`, none ending in `.` (some
 * file systems drop the dot, so `x.` would name the folder `x`). The sub-path is
 * shown as a copy-paste `skillwharf add` command, so shell metacharacters and
 * spaces have no business in it.
 */
export function assertSubpath(sub: string): string {
  if (sub === "") return sub;
  for (const p of sub.split("/")) {
    if (!SUBPATH_PART_RE.test(p) || p === "." || p === ".." || p.endsWith(".") || p.toLowerCase() === ".git") {
      throw new Error(`Invalid sub-path "${sub}": folder names may use only letters, digits, ".", "_" and "-", and may not end in "."`);
    }
  }
  return sub;
}

const HOST_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV6_RE = /^\[[0-9a-f:.]+\]$/;
const PORT_RE = /^[0-9]{1,5}$/;

/**
 * A git host: a lowercase DNS name, an IPv4 address or a bracketed IPv6 literal.
 * Returned lowercased. Private-range addresses are fine (company servers);
 * userinfo and ports are split off before this is called.
 */
export function assertHost(host: string): string {
  const h = host.toLowerCase();
  const bad = () => new Error(`Invalid host "${host}": use a DNS name, an IP address or a bracketed IPv6 address`);
  if (IPV6_RE.test(h) && h.includes(":")) return h;
  if (h.length === 0 || h.length > 253) throw bad();
  if (/^[0-9.]+$/.test(h)) {
    const quad = h.split(".");
    if (quad.length !== 4 || quad.some((q) => q === "" || !/^[0-9]{1,3}$/.test(q) || Number(q) > 255)) throw bad();
    return h;
  }
  if (!h.split(".").every((label) => HOST_LABEL_RE.test(label))) throw bad();
  return h;
}

/** A TCP port, 1 to 65535. */
export function assertPort(port: string): number {
  const n = Number(port);
  if (!PORT_RE.test(port) || n < 1 || n > 65535) throw new Error(`Invalid port "${port}"`);
  return n;
}

/**
 * The components of a repository path (the `.git` suffix already removed from
 * the last one): letters, digits, `.`, `_` and `-`, not `.` or `..`, not ending
 * in `.`, and no `.git` anywhere (it may only end the repository).
 */
export function assertRepoPath(parts: string[], shown: string): string {
  const bad = () =>
    new Error(
      `Invalid repository path "${shown}": use letters, digits, ".", "_" and "-" in each name, no name may end in "." or ".git", and ".git" may only end the repository`,
    );
  if (parts.length === 0) throw bad();
  for (const p of parts) {
    if (!SUBPATH_PART_RE.test(p) || p === "." || p === ".." || p.endsWith(".") || p.toLowerCase().endsWith(".git")) throw bad();
  }
  return parts.join("/");
}

/** Characters that never belong in a source: query and fragment markers, percent escapes, backslashes, whitespace and controls. */
// eslint-disable-next-line no-control-regex
const SOURCE_FORBIDDEN_RE = /[?#%\\\s\u0000-\u001f\u007f-\u009f]/;

export function assertNoForbiddenSourceChars(raw: string): void {
  if (SOURCE_FORBIDDEN_RE.test(raw)) {
    throw new Error(`Invalid source "${sanitizeForTerminal(raw)}": it contains a forbidden character (whitespace, ?, #, %, a backslash or a control character)`);
  }
}

/** The error for a URL that carries a user name or password. */
export function credentialsError(raw: string): Error {
  return new Error(
    `Invalid source "${sanitizeForTerminal(raw)}": URLs with credentials are refused. Credentials belong in the git credential helper (https) or the ssh agent (ssh); only the user "git" may be written in an ssh URL.`,
  );
}
