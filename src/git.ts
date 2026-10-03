/**
 * The only place skillwharf runs git: fixed argument lists (execFile, no
 * shell), stdin closed, a protocol allowlist, prompts off and a timeout. The
 * user's own git configuration (credential helpers, ssh config, URL rewrites,
 * GIT_SSH_COMMAND) is left as it is.
 */
import { execFileSync } from "node:child_process";
import os from "node:os";
import { sanitizeForTerminal } from "./validate.js";

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** The transports skillwharf lets git use. */
const BASE_PROTOCOLS = ["https", "ssh"];

/** Extra transports a test run allows on top of https and ssh (see vitest.setup.ts). Empty in the product. */
let extraProtocols: string[] = [];

/**
 * Test hook: let git use these transports in addition to https and ssh in this
 * process, so a test can point a host name at a local bare repository. It is
 * not reachable from the command line, the manifest, the lockfile or the environment.
 */
export function allowProtocolsForTests(extra: string[]): void {
  extraProtocols = [...extra];
}

let spawnGit: typeof execFileSync = execFileSync;

/** Test hook: run git through this function (to record calls or fake a host). Pass undefined to restore. */
export function setGitExecForTests(fn: typeof execFileSync | undefined): void {
  spawnGit = fn ?? execFileSync;
}

/**
 * https and ssh, narrowed (never widened) by a GIT_ALLOW_PROTOCOL the user
 * already has in the environment. Empty when the user's setting allows neither.
 */
function basePolicy(env: NodeJS.ProcessEnv): string[] {
  const mine = env.GIT_ALLOW_PROTOCOL;
  if (mine === undefined) return [...BASE_PROTOCOLS];
  const theirs = mine.split(":");
  return BASE_PROTOCOLS.filter((p) => theirs.includes(p));
}

/**
 * Variables that point git at a repository. Set by git itself for its hooks, or
 * by a user, they would make our `init`, `remote add`, `fetch` and `checkout`
 * act on someone's own repository instead of the temp clone.
 */
const REPOSITORY_VARIABLES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

/**
 * The environment git runs in: the caller's, minus the variables that pick a
 * repository, plus the protocol allowlist, no terminal prompts and no LFS
 * downloads. Credential helpers, ssh settings and the rest are left as they are.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of REPOSITORY_VARIABLES) delete env[k];
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: [...basePolicy(base), ...extraProtocols].join(":"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

/**
 * Settings every call carries, ahead of the subcommand. A fetched tree is
 * hostile data: the user's global `core.hooksPath` hook must not run on it,
 * nor an LFS filter that its `.gitattributes` asks for (which could call an
 * endpoint the repository chose), and a server may not redirect us to another
 * host (git follows an initial redirect by default).
 */
const HARDENING = [
  "-c", `core.hooksPath=${os.devNull}`,
  "-c", "http.followRedirects=false",
  "-c", "filter.lfs.smudge=",
  "-c", "filter.lfs.process=",
  "-c", "filter.lfs.required=false",
];

export type GitErrorKind = "timeout" | "ref" | "object" | "unreachable" | "other";

export class GitError extends Error {
  constructor(
    message: string,
    readonly kind: GitErrorKind,
    readonly url: string,
  ) {
    super(message);
    this.name = "GitError";
  }
}

export interface RunGitOptions {
  /** The repository the call talks to; named in every error. */
  url: string;
  timeoutMs?: number;
  /** An overall limit (epoch milliseconds) for a command that makes several calls: a call gets at most the time left. */
  deadline?: number;
  /** What a failure means: the first contact with the server (clone, fetch) or a local call. */
  contact?: boolean;
}

/** Run `git <args>`; returns stdout. Throws a GitError that names the URL. */
export function runGit(args: string[], opts: RunGitOptions): string {
  let timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const shown = sanitizeForTerminal(opts.url);
  if (opts.deadline !== undefined) {
    const left = opts.deadline - Date.now();
    if (left <= 0) {
      throw new GitError(
        `git fetch failed for ${shown}: the time limit for this command (--git-timeout) ran out before git could run. Raise it with --git-timeout <seconds> if the servers are slow.`,
        "timeout",
        opts.url,
      );
    }
    timeoutMs = Math.min(timeoutMs, left);
  }
  if (basePolicy(process.env).length === 0) {
    throw new GitError(
      `git fetch failed for ${shown}: GIT_ALLOW_PROTOCOL in your environment (${sanitizeForTerminal(process.env.GIT_ALLOW_PROTOCOL ?? "")}) allows neither https nor ssh, so skillwharf cannot fetch anything`,
      "other",
      opts.url,
    );
  }
  try {
    return spawnGit("git", [...HARDENING, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      // Its own process group (on POSIX, its own session), so that a timeout can
      // end git's children (git-remote-https, ssh, index-pack) too, not just git.
      detached: process.platform !== "win32",
    } as Parameters<typeof execFileSync>[2]).toString();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string; signal?: string; pid?: number };
    const first = String(err.stderr ?? err.message ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
    let reason = sanitizeForTerminal(first.trim() || err.message || "unknown error");
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(String(err.stderr ?? ""))) {
      reason += ". skillwharf runs git without a terminal, so ssh cannot ask about a host key: connect once with ssh yourself to trust the host, then try again";
    }
    if (err.code === "ETIMEDOUT" || err.signal === "SIGKILL") {
      // The timeout killed git alone; end the rest of its group (a hung transport) too.
      if (typeof err.pid === "number" && process.platform !== "win32") {
        try {
          process.kill(-err.pid, "SIGKILL");
        } catch {
          /* the group is already gone */
        }
      }
      const seconds = Math.round((timeoutMs / 1000) * 100) / 100;
      throw new GitError(
        `git fetch failed for ${shown}: timed out after ${seconds} s. Raise the limit with --git-timeout <seconds> if the server is slow.`,
        "timeout",
        opts.url,
      );
    }
    const all = String(err.stderr ?? "");
    // "object": the server is there but will not serve this commit by its sha.
    // "ref": the branch or tag is not there. Anything else on first contact
    // means the repository itself could not be reached.
    const kind: GitErrorKind = /not our ref|unadvertised object|does not allow request/i.test(all)
      ? "object"
      : /Remote branch .* not found|couldn't find remote ref/i.test(all)
        ? "ref"
        : opts.contact
          ? "unreachable"
          : "other";
    throw new GitError(`git fetch failed for ${shown}: ${reason}`, kind, opts.url);
  }
}
