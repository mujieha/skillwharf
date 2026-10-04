/**
 * The only place skillwharf runs git: fixed argument lists (no shell), stdin
 * closed, a protocol allowlist, prompts off, a timeout, and a supervisor that
 * ends git and everything it started when the time is up or when skillwharf is
 * interrupted. The user's own git configuration (credential helpers, ssh
 * config, URL rewrites, GIT_SSH_COMMAND) is left as it is.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sanitizeForTerminal } from "./validate.js";

export const DEFAULT_GIT_TIMEOUT_MS = 120_000;

/** One command (add, sync, update) may spend this many times --git-timeout on git in all, unless --git-deadline says otherwise. */
export const DEADLINE_FACTOR = 4;

/** The overall time limit for one command's git calls, in milliseconds. */
export function defaultDeadlineMs(timeoutMs: number | undefined): number {
  return DEADLINE_FACTOR * (timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS);
}

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

/** `--allow-askpass`: let the user's askpass programs (GIT_ASKPASS, core.askPass, SSH_ASKPASS) prompt during this command. */
let askpassAllowed = false;

export function allowAskpass(on: boolean): void {
  askpassAllowed = on;
}

/**
 * Runs `git` under a small supervisor process (a node one-liner). The supervisor
 * starts git in its own process group (its own session on POSIX, so it has no
 * terminal: ssh cannot ask for a host key or passphrase), kills that whole
 * group when the time is up, when it is interrupted (Ctrl-C reaches it with the
 * rest of the foreground group) and when its parent disappears, and reports how
 * it ended through its exit status: 124 timeout, 130/129/143 interrupted or
 * terminated, 127 git could not be started, otherwise git's own status. On
 * Windows the tree is ended with `taskkill /T /F /PID` (not covered by CI).
 */
export const SUPERVISOR_SOURCE = `
const { spawn, spawnSync } = require("node:child_process");
const [ms, file, ...args] = process.argv.slice(1);
const win = process.platform === "win32";
const parent = process.ppid;
// Its own session on POSIX (no terminal); on Windows a new, hidden console, so git does not share ours.
const child = spawn(file, args, { stdio: ["ignore", "inherit", "inherit"], detached: true, windowsHide: true });
child.on("error", (e) => { process.stderr.write("skillwharf: cannot run git: " + (e && e.message) + "\\n"); process.exit(127); });
// git's own pid, first on stderr, so a parent whose supervisor hung can end git and not a stale pid.
// (git may already have written something, even without a newline: start a line of our own.)
process.stderr.write("\\nSKILLWHARF-GIT-PID " + child.pid + "\\n");
const killTree = () => {
  try {
    if (win) {
      const root = process.env.SystemRoot || process.env.windir || "C:\\\\Windows";
      spawnSync(root + "\\\\System32\\\\taskkill.exe", ["/T", "/F", "/PID", String(child.pid)], { windowsHide: true });
    } else process.kill(-child.pid, "SIGKILL");
  } catch (e) {}
};
const timer = setTimeout(() => { killTree(); process.stderr.write("skillwharf: git timed out\\n"); process.exit(124); }, Number(ms));
// process.ppid never changes on Windows, so ask whether the parent still exists (on POSIX the ppid check is enough, the probe is harmless).
const watch = setInterval(() => {
  let gone = false;
  try { process.kill(parent, 0); } catch (e) { gone = e && e.code === "ESRCH"; }
  if (gone || (!win && process.ppid !== parent)) { killTree(); process.exit(143); }
}, 300);
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]]) {
  process.on(signal, () => { killTree(); process.exit(code); });
}
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  clearInterval(watch);
  process.exit(code === null ? 128 + (require("node:os").constants.signals[signal] || 0) : code);
});
`;

/** `%SystemRoot%\System32\<exe>`: Windows system tools are run by full path, never by a bare name a PATH entry could shadow. */
function windowsTool(exe: string, env: NodeJS.ProcessEnv): string {
  return `${env.SystemRoot || env.windir || "C:\\Windows"}\\System32\\${exe}`;
}

/** End a process and everything it started: its group on POSIX, `taskkill /T /F` (by full path) on Windows. Never throws. */
export function killProcessTree(
  pid: number,
  deps: { platform?: NodeJS.Platform; kill?: (pid: number, signal: NodeJS.Signals) => void; run?: typeof spawnSync; env?: NodeJS.ProcessEnv } = {},
): void {
  const platform = deps.platform ?? process.platform;
  try {
    if (platform === "win32") (deps.run ?? spawnSync)(windowsTool("taskkill.exe", deps.env ?? process.env), ["/T", "/F", "/PID", String(pid)], { windowsHide: true });
    else (deps.kill ?? process.kill.bind(process))(-pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** True when `pid` is a running process whose name is git (so a recycled pid is never signalled). Never throws. */
export function isGitProcess(pid: number): boolean {
  try {
    if (process.platform === "win32") {
      const r = spawnSync(windowsTool("tasklist.exe", process.env), ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
      return /^"git(\.exe)?"/i.test(String(r.stdout).trim());
    }
    const r = spawnSync("ps", ["-p", String(pid), "-o", "comm="], { encoding: "utf8" });
    return /(^|\/)git$/.test(String(r.stdout).trim());
  } catch {
    return false;
  }
}

/** The real way git is run (through the supervisor); exported so a test can wrap it. */
export const supervisedGit = ((file: string, args: string[], options: { timeout?: number }) => {
  const ms = options.timeout ?? DEFAULT_GIT_TIMEOUT_MS;
  // The supervisor enforces the real limit; this one only guards against a supervisor that hangs.
  return execFileSync(process.execPath, ["-e", SUPERVISOR_SOURCE, String(ms), file, ...args], {
    ...options,
    timeout: ms + 10_000,
  } as Parameters<typeof execFileSync>[2]);
}) as unknown as typeof execFileSync;

let spawnGit: typeof execFileSync = supervisedGit;

/** Test hook: run git through this function (to record calls or fake a host). Pass undefined to restore. */
export function setGitExecForTests(fn: typeof execFileSync | undefined): void {
  spawnGit = fn ?? supervisedGit;
  if (fn === undefined) interrupt = undefined; // a test run starts each test with no interrupt on record
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
 * Variables that point git at a repository (or change how its objects and
 * history are read). Set by git itself for its hooks, or by a user, they would
 * make our `init`, `remote add`, `fetch` and `checkout` act on someone's own
 * repository instead of the temp clone.
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
  "GIT_SHALLOW_FILE",
  "GIT_GRAFT_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_QUARANTINE_PATH",
  "GIT_NO_REPLACE_OBJECTS",
];

/**
 * The environment git runs in: the caller's, minus the variables that pick a
 * repository, plus the protocol allowlist, no prompts (git's own, and no askpass
 * program unless `--allow-askpass`) and no LFS downloads. Credential helpers and
 * the rest of the user's ssh settings are left as they are.
 */
export function gitEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const k of REPOSITORY_VARIABLES) delete env[k];
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: [...basePolicy(base), ...extraProtocols].join(":"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    // An askpass program is tried before the terminal prompt and could be reached by
    // any host a repository, submodule or registry names (a credential prompt in
    // an editor's terminal). Empty means "none" to git, and `never` to ssh.
    ...(askpassAllowed ? {} : { GIT_ASKPASS: "", SSH_ASKPASS_REQUIRE: "never" }),
  };
}

/**
 * Settings every call carries, ahead of the subcommand. A fetched tree is
 * hostile data: the user's global `core.hooksPath` hook must not run on it,
 * nor an LFS filter that its `.gitattributes` asks for (which could call an
 * endpoint the repository chose), a server may not redirect us to another host
 * (git follows an initial redirect by default), and no configured askpass
 * program may prompt (unless `--allow-askpass`).
 */
function hardening(): string[] {
  return [
    "-c", `core.hooksPath=${os.devNull}`,
    "-c", "http.followRedirects=false",
    "-c", "filter.lfs.smudge=",
    "-c", "filter.lfs.process=",
    "-c", "filter.lfs.required=false",
    ...(askpassAllowed ? [] : ["-c", "core.askPass="]),
  ];
}

/**
 * Written to `.git/info/attributes` of a temporary clone before checkout. It
 * outranks the repository's own `.gitattributes`, so no `filter=` driver the
 * repository names (or a global driver by that name), no `$Id$` expansion and
 * no line-ending conversion happens: files come out as committed.
 */
export const SAFE_ATTRIBUTES = "* -filter -ident -text -eol\n";

/** Put SAFE_ATTRIBUTES in place in the git repository at `repoDir` (call before the checkout). */
export function writeSafeAttributes(repoDir: string): void {
  const dir = path.join(repoDir, ".git", "info");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "attributes"), SAFE_ATTRIBUTES);
}

export type GitErrorKind = "timeout" | "ref" | "object" | "unreachable" | "interrupted" | "other";

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

let interrupt: "SIGINT" | undefined;

/** The signal that interrupted a git call in this process, if one did (the command line exits 130 for it). */
export function interruptedBy(): "SIGINT" | undefined {
  return interrupt;
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

/** The host part of a clone URL, for messages. */
function hostOf(url: string): string {
  return /^[a-z+]+:\/\/(?:[^/@]*@)?(\[[^\]]+\]|[^/:]+)/i.exec(url)?.[1] ?? url;
}

/** Run `git <args>`; returns stdout. Throws a GitError that names the URL. */
export function runGit(args: string[], opts: RunGitOptions): string {
  let timeoutMs = opts.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  let limitedByDeadline = false;
  const shown = sanitizeForTerminal(opts.url);
  // After Ctrl-C no further git call is started, whatever a caller does with the error it got.
  if (interrupt) throw new GitError(`git fetch failed for ${shown}: interrupted`, "interrupted", opts.url);
  if (opts.deadline !== undefined) {
    const left = opts.deadline - Date.now();
    if (left <= 0) {
      throw new GitError(
        `git fetch failed for ${shown}: the time limit for this command (--git-deadline, four times --git-timeout by default) ran out before git could run. Raise it with --git-deadline <seconds> if the servers are slow.`,
        "timeout",
        opts.url,
      );
    }
    if (left < timeoutMs) {
      timeoutMs = left;
      limitedByDeadline = true;
    }
  }
  if (basePolicy(process.env).length === 0) {
    throw new GitError(
      `git fetch failed for ${shown}: GIT_ALLOW_PROTOCOL in your environment (${sanitizeForTerminal(process.env.GIT_ALLOW_PROTOCOL ?? "")}) allows neither https nor ssh, so skillwharf cannot fetch anything`,
      "other",
      opts.url,
    );
  }
  // At a terminal, Ctrl-C reaches the supervisor too (same foreground group): it ends
  // git and exits 130. This process is blocked until then and cannot run a handler, but
  // having one stops the signal from killing it first, so it can clean up. Without a
  // terminal (an editor's or CI's cancel button signals this pid alone) there is no such
  // group and a handler could never run while blocked, so the default applies: the
  // process ends at once and the supervisor, seeing its parent gone, ends git.
  const hold = () => {};
  const holding = process.stdin.isTTY === true;
  if (holding) process.on("SIGINT", hold);
  try {
    return spawnGit("git", [...hardening(), ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      env: gitEnv(),
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
    } as Parameters<typeof execFileSync>[2]).toString();
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: Buffer | string; signal?: string; pid?: number; status?: number | null };
    // The supervisor's first stderr line is git's own pid; it is not part of git's message.
    const rawStderr = String(err.stderr ?? "");
    const gitPid = Number(/(?:^|\n)SKILLWHARF-GIT-PID (\d+)\n/.exec(rawStderr)?.[1]);
    const stderr = rawStderr.replace(/(?:^|\n)SKILLWHARF-GIT-PID \d+\n/, "").replace(/^\n/, "");
    const first = (stderr || String(err.message ?? "")).split("\n").find((l) => l.trim() !== "") ?? "";
    let reason = sanitizeForTerminal(first.trim() || err.message || "unknown error");
    if (err.status === 130) {
      interrupt = "SIGINT";
      throw new GitError(`git fetch failed for ${shown}: interrupted`, "interrupted", opts.url);
    }
    if (err.status === 127) {
      throw new GitError(`git fetch failed for ${shown}: ${reason}. Is git installed and on your PATH?`, "other", opts.url);
    }
    if (/Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED/i.test(stderr)) {
      reason += ". skillwharf runs git without a terminal, so ssh cannot ask about a host key: connect once with ssh yourself to trust the host, then try again";
    }
    if (/Authentication failed|terminal prompts disabled|could not read (Username|Password)|returned error: 40[13]|HTTP 40[13]|Permission denied \(publickey/i.test(stderr)) {
      reason += `. authentication failed for ${sanitizeForTerminal(hostOf(opts.url))}; configure a git credential helper (\`git config --global credential.helper ...\`) or re-run with --allow-askpass to let your editor ask`;
    }
    if (err.status === 124 || err.code === "ETIMEDOUT" || err.signal === "SIGKILL") {
      // The supervisor ended git's group itself when it reported the timeout (status 124): nothing
      // more to do, and its own pid is gone (it could be reused). Only when the supervisor hung and
      // was killed is git ended here, by git's own pid, and only if that pid is still a git process.
      if (err.status !== 124 && Number.isInteger(gitPid) && gitPid > 1 && isGitProcess(gitPid)) killProcessTree(gitPid);
      const seconds = Math.round((timeoutMs / 1000) * 100) / 100;
      throw new GitError(
        limitedByDeadline
          ? `git fetch failed for ${shown}: the time limit for this command (--git-deadline, four times --git-timeout by default) ran out while git was running. Raise it with --git-deadline <seconds> if the servers are slow.`
          : `git fetch failed for ${shown}: timed out after ${seconds} s. Raise the limit with --git-timeout <seconds> if the server is slow.`,
        "timeout",
        opts.url,
      );
    }
    // "object": the server is there but will not serve this commit by its sha.
    // "ref": the branch or tag is not there. Anything else on first contact
    // means the repository itself could not be reached.
    const kind: GitErrorKind = /not our ref|unadvertised object|does not allow request/i.test(stderr)
      ? "object"
      : /Remote branch .* not found|couldn't find remote ref/i.test(stderr)
        ? "ref"
        : opts.contact
          ? "unreachable"
          : "other";
    throw new GitError(`git fetch failed for ${shown}: ${reason}`, kind, opts.url);
  } finally {
    if (holding) process.off("SIGINT", hold);
  }
}
