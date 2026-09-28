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

/** A repo sub-path: relative, no traversal, no leading slash. */
export function assertSubpath(sub: string): string {
  if (sub === "") return sub;
  const parts = sub.split("/");
  for (const p of parts) {
    if (p === "" || p === "." || p === ".." || p.includes("\\") || p.includes("\0")) {
      throw new Error(`Invalid sub-path "${sub}"`);
    }
  }
  return sub;
}
