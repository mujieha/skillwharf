/**
 * The only place skillwharf runs git: fixed argument lists (execFile, no
 * shell), stdin closed, a protocol allowlist, prompts off and a timeout. The
 * user's own git configuration (credential helpers, ssh config, URL rewrites,
 * GIT_SSH_COMMAND) is left as it is.
 */
import { execFileSync } from "node:child_process";
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

/** The environment git runs in: the caller's, plus the protocol allowlist and no terminal prompts. */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_ALLOW_PROTOCOL: [...basePolicy(base), ...extraProtocols].join(":"),
    GIT_TERMINAL_PROMPT: "0",
  };
}

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
  /** What a failure means: the first contact with the server (clone, fetch) or a local call. */
  contact?: boolean;
}

/** Run `git <args>`; returns stdout. Throws a GitError that names the URL. */
export function runGit(args: string[], opts: RunGitOptions): string {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  const shown = sanitizeForTerminal(opts.url);
  if (basePolicy(process.env).length === 0) {
    throw new GitError(
      `git fetch failed for ${shown}: GIT_ALLOW_PROTOCOL in your environment (${sanitizeForTerminal(process.env.GIT_ALLOW_PROTOCOL ?? "")}) allows neither https nor ssh, so skillwharf cannot fetch anything`,
      "other",
      opts.url,
    );
  }
  try {
    return spawnGit("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    }).toString();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string; signal?: string };
    const first = String(err.stderr ?? err.message ?? "").split("\n").find((l) => l.trim() !== "") ?? "";
    const reason = sanitizeForTerminal(first.trim() || err.message || "unknown error");
    if (err.code === "ETIMEDOUT" || err.signal === "SIGKILL") {
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
