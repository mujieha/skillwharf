import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SUPERVISOR_SOURCE, supervisedGit, allowAskpass, allowProtocolsForTests, defaultDeadlineMs, gitEnv, killProcessTree, runGit, setGitExecForTests } from "./git.js";
import { linkStatus } from "./agents.js";
import { copyDir, copyResolvingLinks, hashDir, inGitDir, isAbsoluteLinkText, isInside, resolveInside } from "./fs.js";
import { isSkillDirIn } from "./skill.js";
import { loadLock, loadManifest, makeContext, saveManifest, storePath } from "./manifest.js";
import { addSkill, syncSkills, updateSkills } from "./ops.js";
import { discoverSkills, discoveryBound, fetchSource, formatSource, isCommitSha, parseSource, sourceKey } from "./source.js";
import { innerRepository, placeSubmodules } from "./submodules.js";
import type { Context, Lockfile, Manifest } from "./types.js";

// Every git call goes through runGit; this wrapper records the calls and runs
// the real thing unless a test swaps the implementation.
const realExec = { fn: supervisedGit };
const exec = vi.fn<typeof execFileSync>(supervisedGit);

const here = path.dirname(fileURLToPath(import.meta.url));
const savedEnv = { ...process.env };

let base: string, home: string, proj: string, ctx: Context;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skwf-any-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  for (const d of [home, proj]) fs.mkdirSync(d, { recursive: true });
  ctx = makeContext({ cwd: proj, home });
  setGitExecForTests(exec);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  exec.mockImplementation(realExec.fn);
  exec.mockClear();
  setGitExecForTests(undefined);
  allowProtocolsForTests(["file"]);
  vi.unstubAllGlobals();
  fs.rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers
function writeSkill(dir: string, name: string, body = "body") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
}

/** Plain git for building test repositories (not through the supervisor, which is what is under test elsewhere). */
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    .toString()
    .trim();
}

let repoCount = 0;
/** A bare repository at <base>/srv/<repoPath>.git whose single commit is built by `build`. Returns its sha. */
function makeRepo(repoPath: string, build: (work: string) => void, message = "one"): string {
  const work = path.join(base, "work", String(repoCount++));
  git("init", "--quiet", work);
  build(work);
  git("-C", work, "add", "-A");
  git("-C", work, "commit", "--quiet", "-m", message);
  const bare = path.join(base, "srv", `${repoPath}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git("clone", "--quiet", "--bare", work, bare);
  return git("-C", work, "rev-parse", "HEAD");
}

/** Route these URL prefixes to the bare repositories under <base>/srv through git's own insteadOf config. No network. */
function routeHosts(prefixes: string[], extra: [string, string][] = []): void {
  const entries: [string, string][] = [
    ...prefixes.map((p): [string, string] => [`url.file://${path.join(base, "srv")}/.insteadOf`, p]),
    ["uploadpack.allowAnySHA1InWant", "true"],
    ["protocol.file.allow", "always"],
    ...extra,
  ];
  process.env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = k;
    process.env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
}

const ALL_HOSTS = [
  "https://github.com/",
  "https://gitlab.com/",
  "https://bitbucket.org/",
  "https://git.acme.test/",
  "ssh://git@git.acme.test/",
];

let built = false;
/**
 * Compile the command line into dist/ (as `npm run build` does; CI runs the tests first), so a test can run
 * the shipped code as a child process: no test-only allowance applies there.
 */
function ensureBuilt(): void {
  if (built) return;
  const root = path.resolve(here, "..");
  const r = spawnSync(path.join(root, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`tsc failed:\n${r.stdout}${r.stderr}`);
  built = true;
}

/** An argument list without the `-c key=value` settings every call starts with (see HARDENING in git.ts). */
function withoutHardening(args: string[]): string[] {
  let i = 0;
  while (args[i] === "-c") i += 2;
  return args.slice(i);
}
/** The recorded git invocations (argument lists only, without the hardening settings). */
function gitCalls(): string[][] {
  return exec.mock.calls.filter((c) => c[0] === "git").map((c) => withoutHardening(c[1] as string[]));
}
/** The options of the recorded invocations. */
function gitOptions(): Record<string, unknown>[] {
  return exec.mock.calls.filter((c) => c[0] === "git").map((c) => c[2] as Record<string, unknown>);
}

// ------------------------------------------------------------------ S4
describe("S4: 0.1.x manifests and lockfiles load unchanged", () => {
  const fixtureManifest = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v0.1", "manifest.json"), "utf8")) as Manifest;
  const fixtureLock = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v0.1", "lock.json"), "utf8")) as Lockfile;

  beforeEach(() => {
    fs.copyFileSync(path.join(here, "fixtures", "v0.1", "manifest.json"), path.join(proj, "skillwharf.json"));
    fs.copyFileSync(path.join(here, "fixtures", "v0.1", "lock.json"), path.join(proj, "skillwharf.lock.json"));
  });

  it("loads the 0.1.x manifest and lockfile as they are", () => {
    expect(loadManifest(ctx)).toEqual(fixtureManifest);
    expect(loadLock(ctx)).toEqual(fixtureLock);
  });

  it("saving an unchanged 0.1.x manifest writes no new fields", () => {
    const m = loadManifest(ctx) as Manifest;
    saveManifest(ctx, m);
    const saved = JSON.parse(fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8")) as Manifest;
    expect(Object.keys(saved).sort()).toEqual(Object.keys(fixtureManifest).sort());
    expect(saved.skills).toEqual(fixtureManifest.skills);
    expect(saved.registry).toBe(fixtureManifest.registry);
    expect("registries" in saved).toBe(false);
  });
});

// ------------------------------------------------------------------ S1 grammar
const SHA = "3f2c9a1b3f2c9a1b3f2c9a1b3f2c9a1b3f2c9a1b";

describe("S1.1-S1.12: the source grammar", () => {
  const accepted: [string, Record<string, unknown>][] = [
    ["github:anthropics/skills/skills/pdf@v1", { protocol: "https", host: "github.com", repoPath: "anthropics/skills", subpath: "skills/pdf", ref: "v1", shorthand: "github" }],
    ["github:o/r//skills/pdf", { host: "github.com", repoPath: "o/r", subpath: "skills/pdf", shorthand: "github" }],
    ["github:o/r", { repoPath: "o/r", subpath: "" }],
    ["gitlab:acme/platform/skills//release-notes@main", { protocol: "https", host: "gitlab.com", repoPath: "acme/platform/skills", subpath: "release-notes", ref: "main", shorthand: "gitlab" }],
    ["gitlab:acme/skills", { host: "gitlab.com", repoPath: "acme/skills", subpath: "", shorthand: "gitlab" }],
    ["gitlab:acme/skills//a/b", { repoPath: "acme/skills", subpath: "a/b" }],
    ["bitbucket:acme/skills//pdf", { host: "bitbucket.org", repoPath: "acme/skills", subpath: "pdf", shorthand: "bitbucket" }],
    ["bitbucket:acme/skills/pdf", { host: "bitbucket.org", repoPath: "acme/skills", subpath: "pdf" }],
    [`git+https://git.acme.com/team/skills.git//pdf@${SHA}`, { protocol: "https", host: "git.acme.com", repoPath: "team/skills", subpath: "pdf", ref: SHA, dotGit: true }],
    ["git+ssh://git@git.acme.com/team/skills.git//pdf", { protocol: "ssh", user: "git", host: "git.acme.com", repoPath: "team/skills", subpath: "pdf" }],
    ["git+ssh://git.acme.com:2222/team/skills//pdf", { protocol: "ssh", host: "git.acme.com", port: 2222, repoPath: "team/skills", subpath: "pdf", dotGit: false }],
    ["git+https://git.acme.com:8443/team/skills.git", { host: "git.acme.com", port: 8443, repoPath: "team/skills", subpath: "" }],
    ["git+https://10.0.0.5/team/skills.git", { host: "10.0.0.5" }],
    ["git+https://192.168.1.10/team/skills.git", { host: "192.168.1.10" }],
    ["git+https://[fd00::1]/team/skills.git", { host: "[fd00::1]" }],
    ["git+https://Git.ACME.com/team/skills.git", { host: "git.acme.com" }],
    ["git+https://github.com/acme/skills.git//x", { shorthand: "github", repoPath: "acme/skills", subpath: "x" }],
    ["https://github.com/acme/skills/tree/main/tools/pdf", { shorthand: "github", repoPath: "acme/skills", subpath: "tools/pdf", ref: "main" }],
    ["https://github.com/acme/skills.git", { shorthand: "github", repoPath: "acme/skills", subpath: "" }],
    ["https://gitlab.com/acme/platform/skills/-/tree/main/release-notes", { shorthand: "gitlab", repoPath: "acme/platform/skills", subpath: "release-notes", ref: "main" }],
    ["https://gitlab.com/acme/platform/skills", { shorthand: "gitlab", repoPath: "acme/platform/skills", subpath: "" }],
    ["https://bitbucket.org/acme/skills/src/main/pdf", { shorthand: "bitbucket", repoPath: "acme/skills", subpath: "pdf", ref: "main" }],
    ["http://github.com/acme/skills", { shorthand: "github", repoPath: "acme/skills", protocol: "https" }],
  ];
  it.each(accepted)("accepts %s", (input, expected) => {
    const p = parseSource(input);
    expect(p).toMatchObject({ kind: "git", ...expected });
    expect(p.raw).toBe(input.trim());
  });

  it("a universal URL has no shorthand unless it is one of the three known hosts", () => {
    const p = parseSource("git+https://git.acme.com/team/skills.git");
    expect("shorthand" in p ? p.shorthand : undefined).toBeUndefined();
  });

  const canonical: [string, string][] = [
    ["github:acme/skills/tools/pdf@v2", "github:acme/skills/tools/pdf@v2"],
    ["github:acme/skills", "github:acme/skills"],
    ["github:o/r//x", "github:o/r/x"],
    ["https://github.com/acme/skills/tree/main/tools/pdf", "github:acme/skills/tools/pdf@main"],
    ["git+https://github.com/acme/skills.git//x", "github:acme/skills/x"],
    ["gitlab:acme/platform/skills//release-notes@main", "gitlab:acme/platform/skills//release-notes@main"],
    ["gitlab:acme/platform/skills//", "gitlab:acme/platform/skills//"],
    ["gitlab:acme/skills", "gitlab:acme/skills"],
    ["https://gitlab.com/acme/platform/skills/-/tree/main/rn", "gitlab:acme/platform/skills//rn@main"],
    ["bitbucket:acme/skills//pdf", "bitbucket:acme/skills/pdf"],
    ["git+ssh://git@git.acme.com/team/skills.git//pdf", "git+ssh://git@git.acme.com/team/skills.git//pdf"],
    ["git+https://git.acme.com:8443/team/skills//pdf@v1", "git+https://git.acme.com:8443/team/skills//pdf@v1"],
    ["git+https://Git.ACME.com/team/skills.git", "git+https://git.acme.com/team/skills.git"],
  ];
  it.each(canonical)("formats %s as %s and the result parses back to the same source", (input, want) => {
    const p = parseSource(input);
    expect(formatSource(p)).toBe(want);
    const again = parseSource(formatSource(p));
    expect(sourceKey(again)).toBe(sourceKey(p));
    expect(formatSource(again)).toBe(want);
  });

  it("formats with the full sha in place of the ref", () => {
    expect(formatSource(parseSource("github:acme/skills/tools/pdf@v2"), "abc1234")).toBe("github:acme/skills/tools/pdf@abc1234");
    expect(formatSource(parseSource("gitlab:a/b/c//x@main"), SHA)).toBe(`gitlab:a/b/c//x@${SHA}`);
  });

  const refused: [string, RegExp][] = [
    ["git+https://user:pw@h.example/r.git", /credential helper/],
    ["git+https://tok@h.example/r.git", /credential helper/],
    ["git+ssh://bob@h.example/r.git", /ssh agent/],
    ["git+ssh://git:pw@h.example/r.git", /credential/],
    ["file:///etc/passwd", /unsupported source scheme/],
    ["git+file:///tmp/x", /unsupported source scheme/],
    ["ext::sh -c touch% /tmp/x", /unsupported source scheme/],
    ["git://h.example/r.git", /unsupported source scheme/],
    ["git+http://h.example/r.git", /unsupported source scheme/],
    ["http://git.acme.com/r.git", /unsupported source scheme/],
    ["https://git.acme.com/r.git", /git\+https:\/\//],
    ["foo:bar", /unsupported source scheme/],
    ["git@github.com:o/r.git", /git\+ssh:\/\//],
    ["gitlab:acme/platform/skills/release-notes", /\/\//],
    ["gitlab:acme", /group\/repo/],
    ["github:acme", /owner\/repo/],
    ["bitbucket:acme", /owner\/repo/],
    ["git+https://h.example", /repository/],
    ["git+https://h.example/a/../b.git", /Invalid repository path/],
    ["git+https://h.example/a.git/b.git//x", /Invalid repository path/],
    ["git+https://h.example/skills.git/sub", /Invalid repository path/],
    ["git+https://h.example/skills./x", /Invalid repository path/],
    ["git+https://h.example/x.git.git", /Invalid repository path/],
    ["github:o/r.git/x", /Invalid repository path/],
    ["github:o/r/a/../b", /sub-path/],
    ["github:o/r/sub/x.", /sub-path/],
    ["git+https://h.example/r.git//a/../b", /sub-path/],
    ["git+https://h.example/r.git//.git/x", /sub-path/],
    ["git+https://h.example/r.git?x=1", /forbidden character/],
    ["git+https://h.example/r#x", /forbidden character/],
    ["git+https://h.example/r s", /forbidden character/],
    ["git+https://-h.example/r.git", /Invalid host/],
    ["git+https://h..example/r.git", /Invalid host/],
    ["git+https://h.example./r.git", /Invalid host/],
    ["git+https://hö.example/r", /Invalid host/],
    ["git+https://999.1.1.1/r.git", /Invalid host/],
    ["git+https://h.example:0/r", /Invalid port/],
    ["git+https://h.example:65536/r", /Invalid port/],
    ["git+https://h.example:80a/r", /Invalid port/],
    ["github:o/r@-x", /Invalid git ref/],
    ["git+https://h.example/r.git@-x", /Invalid git ref/],
  ];
  it.each(refused)("refuses %s", (input, re) => {
    expect(() => parseSource(input)).toThrow(re);
  });

  it("still parses local paths", () => {
    expect(parseSource("./x", "/proj")).toMatchObject({ kind: "path", path: "/proj/x" });
    expect(parseSource("path:../y", "/proj/a")).toMatchObject({ kind: "path", path: "/proj/y" });
    expect(parseSource("../y", "/proj/a")).toMatchObject({ kind: "path", path: "/proj/y" });
  });
});

describe("S1.22: lock and manifest are compared on protocol, host, port, repository path and sub-path", () => {
  it("sourceKey ignores the spelling and the case of the host", () => {
    const keys = [
      "github:acme/skills/x",
      "https://github.com/acme/skills/tree/main/x",
      "git+https://github.com/acme/skills.git//x",
      "git+https://GITHUB.com/acme/skills//x",
    ].map((s) => sourceKey(parseSource(s)));
    expect(new Set(keys).size).toBe(1);
  });

  it.each([
    ["git+ssh://git@git.acme.com/team/skills.git//x", "git+https://git.acme.com/team/skills.git//x"],
    ["git+https://git.acme.com/team/skills.git//x", "git+https://git.acme.org/team/skills.git//x"],
    ["git+https://git.acme.com/team/skills.git//x", "git+https://git.acme.com:8443/team/skills.git//x"],
    ["git+https://git.acme.com/team/skills.git//x", "git+https://git.acme.com/team/other.git//x"],
    ["git+https://git.acme.com/team/skills.git//x", "git+https://git.acme.com/team/skills.git//y"],
    ["gitlab:a/b//x", "github:a/b/x"],
  ])("sourceKey differs for %s and %s", (a, b) => {
    expect(sourceKey(parseSource(a))).not.toBe(sourceKey(parseSource(b)));
  });

  it("sync refuses a lock entry pinned to another host", () => {
    fs.writeFileSync(
      path.join(proj, "skillwharf.json"),
      JSON.stringify({ version: 1, agents: ["claude"], skills: { x: { source: "gitlab:a/b//x" } } }),
    );
    fs.writeFileSync(
      path.join(proj, "skillwharf.lock.json"),
      JSON.stringify({
        version: 1,
        skills: { x: { source: "gitlab:a/b//x", resolved: `github:a/b/x@${SHA}`, integrity: "sha256-x", installedAt: "x" } },
      }),
    );
    expect(() => syncSkills(ctx)).toThrow(/does not match/);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
  });

  it("every github source of the 0.1.x fixtures still parses and the lock's resolved forms are unchanged", () => {
    const lock = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v0.1", "lock.json"), "utf8")) as Lockfile;
    for (const e of Object.values(lock.skills)) {
      if (!e.resolved.startsWith("github:")) continue;
      expect(formatSource(parseSource(e.resolved))).toBe(e.resolved);
      expect(formatSource(parseSource(e.source))).toBe(e.source);
    }
    const m = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v0.1", "manifest.json"), "utf8")) as Manifest;
    for (const s of Object.values(m.skills)) expect(() => parseSource(s.source)).not.toThrow();
  });
});

// ------------------------------------------------------------------ S1.13-15 fetch guards
describe("S1.13-S1.15: git is run with fixed arguments, a protocol allowlist and a timeout", () => {
  const hosts: [string, string, string][] = [
    ["github", "github:acme/skills//rn", "https://github.com/acme/skills.git"],
    ["gitlab nested group", "gitlab:acme/platform/skills//rn", "https://gitlab.com/acme/platform/skills.git"],
    ["bitbucket", "bitbucket:acme/skills//rn", "https://bitbucket.org/acme/skills.git"],
    ["universal https", "git+https://git.acme.test/team/skills.git//rn", "https://git.acme.test/team/skills.git"],
    ["universal ssh", "git+ssh://git@git.acme.test/team/skills.git//rn", "ssh://git@git.acme.test/team/skills.git"],
  ];

  it.each(hosts)("clones from %s with a fixed argument list", (_name, source, url) => {
    const repoPath = url.replace(/^[a-z]+:\/\/(git@)?[^/]+\//, "").replace(/\.git$/, "");
    const sha = makeRepo(repoPath, (w) => writeSkill(path.join(w, "rn"), "rn"));
    routeHosts(ALL_HOSTS);
    const f = fetchSource(parseSource(source));
    try {
      expect(fs.existsSync(path.join(f.dir, "SKILL.md"))).toBe(true);
      expect(f.sha).toBe(sha);
      expect(f.resolved).toBe(formatSource(parseSource(source), sha));
      expect(gitCalls()[0]).toEqual(["clone", "--depth", "1", "--quiet", "--no-checkout", "--", url, expect.stringContaining("skillwharf-")]);
      // the checkout comes only after the attributes that switch a repository's filters off are in place
      expect(gitCalls()[1]).toEqual(["-C", expect.stringContaining("skillwharf-"), "checkout", "--quiet", "HEAD"]);
    } finally {
      f.cleanup();
    }
  });

  it("clones a branch with --branch before the separator", () => {
    makeRepo("acme/skills", (w) => writeSkill(path.join(w, "rn"), "rn"));
    routeHosts(ALL_HOSTS);
    const head = git("-C", path.join(base, "srv", "acme", "skills.git"), "rev-parse", "--abbrev-ref", "HEAD");
    const f = fetchSource(parseSource(`github:acme/skills//rn@${head}`));
    f.cleanup();
    expect(gitCalls()[0]).toEqual([
      "clone", "--depth", "1", "--quiet", "--no-checkout", "--branch", head, "--", "https://github.com/acme/skills.git", expect.any(String),
    ]);
  });

  it("a pinned commit is fetched with init, remote add, fetch <sha> and checkout FETCH_HEAD", () => {
    const sha = makeRepo("team/skills", (w) => writeSkill(path.join(w, "rn"), "rn"));
    routeHosts(ALL_HOSTS);
    const f = fetchSource(parseSource(`git+https://git.acme.test/team/skills.git//rn@${sha}`));
    f.cleanup();
    const url = "https://git.acme.test/team/skills.git";
    expect(gitCalls()).toEqual([
      ["init", "--quiet", expect.any(String)],
      ["-C", expect.any(String), "remote", "add", "--", "origin", url],
      ["-C", expect.any(String), "fetch", "--depth", "1", "--quiet", "origin", sha],
      ["-C", expect.any(String), "checkout", "--quiet", "FETCH_HEAD"],
      ["-C", expect.any(String), "rev-parse", "HEAD"],
    ]);
  });

  describe("with git itself stubbed out", () => {
    beforeEach(() => {
      allowProtocolsForTests([]);
      exec.mockImplementation((() => Buffer.from("")) as never);
    });

    it("every call gets GIT_ALLOW_PROTOCOL=https:ssh, GIT_TERMINAL_PROMPT=0, a closed stdin and a 120 s timeout", () => {
      fetchSource(parseSource("gitlab:acme/skills")).cleanup();
      const calls = gitOptions();
      expect(calls.length).toBeGreaterThan(0);
      for (const o of calls) {
        const env = o.env as Record<string, string>;
        expect(env.GIT_ALLOW_PROTOCOL).toBe("https:ssh");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
        expect((o.stdio as string[])[0]).toBe("ignore");
        expect(o.timeout).toBe(120_000);
      }
    });

    it("the same holds for the pinned path", () => {
      fetchSource(parseSource(`git+ssh://git@git.acme.test/team/skills.git@${SHA}`)).cleanup();
      expect(gitCalls().length).toBe(5);
      for (const o of gitOptions()) {
        expect((o.env as Record<string, string>).GIT_ALLOW_PROTOCOL).toBe("https:ssh");
        expect((o.stdio as string[])[0]).toBe("ignore");
      }
    });

    it("uses the timeout it is given", () => {
      fetchSource(parseSource("github:acme/skills"), { timeoutMs: 5000 }).cleanup();
      for (const o of gitOptions()) expect(o.timeout).toBe(5000);
    });

    it("leaves the user's ssh command and credential helper settings alone", () => {
      process.env.GIT_SSH_COMMAND = "ssh -i /somewhere/key";
      process.env.GIT_CONFIG_GLOBAL = "/somewhere/gitconfig";
      process.env.SSH_AUTH_SOCK = "/somewhere/agent";
      fetchSource(parseSource("github:acme/skills")).cleanup();
      for (const o of gitOptions()) {
        const env = o.env as Record<string, string>;
        expect(env.GIT_SSH_COMMAND).toBe("ssh -i /somewhere/key");
        expect(env.GIT_CONFIG_GLOBAL).toBe("/somewhere/gitconfig");
        expect(env.SSH_AUTH_SOCK).toBe("/somewhere/agent");
      }
    });

    it("askpass programs are switched off by default: no prompt a repository can reach", () => {
      process.env.GIT_ASKPASS = "/somewhere/askpass";
      process.env.SSH_ASKPASS = "/somewhere/ssh-askpass";
      process.env.SSH_ASKPASS_REQUIRE = "force";
      fetchSource(parseSource("github:acme/skills")).cleanup();
      for (const o of gitOptions()) {
        const env = o.env as Record<string, string>;
        expect(env.GIT_ASKPASS).toBe("");
        expect(env.SSH_ASKPASS_REQUIRE).toBe("never");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      }
      for (const c of exec.mock.calls.filter((x) => x[0] === "git")) expect(c[1]).toContain("core.askPass=");
    });

    it("--allow-askpass passes the user's askpass settings through for that command", () => {
      process.env.GIT_ASKPASS = "/somewhere/askpass";
      process.env.SSH_ASKPASS = "/somewhere/ssh-askpass";
      allowAskpass(true);
      try {
        fetchSource(parseSource("github:acme/skills")).cleanup();
      } finally {
        allowAskpass(false);
      }
      for (const o of gitOptions()) {
        const env = o.env as Record<string, string>;
        expect(env.GIT_ASKPASS).toBe("/somewhere/askpass");
        expect(env.SSH_ASKPASS).toBe("/somewhere/ssh-askpass");
        expect(env.GIT_TERMINAL_PROMPT).toBe("0");
      }
      for (const c of exec.mock.calls.filter((x) => x[0] === "git")) expect(c[1]).not.toContain("core.askPass=");
    });

    it("an authentication failure says what to configure, and names --allow-askpass", () => {
      exec.mockImplementation((() => {
        throw Object.assign(new Error("Command failed"), {
          stderr: Buffer.from("fatal: could not read Username for 'https://git.acme.test': terminal prompts disabled\n"),
        });
      }) as never);
      expect(() => fetchSource(parseSource("git+https://git.acme.test/team/skills.git"))).toThrow(
        /authentication failed for git\.acme\.test; configure a git credential helper \(`git config --global credential\.helper/,
      );
      expect(() => fetchSource(parseSource("git+https://git.acme.test/team/skills.git"))).toThrow(/--allow-askpass/);
    });

    it("narrows a GIT_ALLOW_PROTOCOL the user set, and never widens it", () => {
      process.env.GIT_ALLOW_PROTOCOL = "https:file";
      fetchSource(parseSource("github:acme/skills")).cleanup();
      for (const o of gitOptions()) expect((o.env as Record<string, string>).GIT_ALLOW_PROTOCOL).toBe("https");
    });

    it("refuses every fetch, naming the variable, when the user's setting allows neither https nor ssh", () => {
      process.env.GIT_ALLOW_PROTOCOL = "file";
      exec.mockClear();
      expect(() => fetchSource(parseSource("github:acme/skills"))).toThrow(/GIT_ALLOW_PROTOCOL/);
      expect(gitCalls()).toEqual([]);
    });

    it("does not leave a temp folder behind when git fails", () => {
      const tmp = path.join(base, "tmp");
      fs.mkdirSync(tmp);
      process.env.TMPDIR = tmp;
      exec.mockImplementation((() => {
        throw Object.assign(new Error("Command failed"), { stderr: Buffer.from("fatal: repository not found\n") });
      }) as never);
      expect(() => fetchSource(parseSource("github:acme/skills"))).toThrow(/git fetch failed for https:\/\/github\.com\/acme\/skills\.git/);
      expect(fs.readdirSync(tmp)).toEqual([]);
    });
  });

  it("a URL rewrite to file:// is refused (the protocol guard is real)", () => {
    makeRepo("acme/skills", (w) => writeSkill(path.join(w, "rn"), "rn"));
    routeHosts(ALL_HOSTS);
    allowProtocolsForTests([]);
    const tmp = path.join(base, "tmp");
    fs.mkdirSync(tmp);
    process.env.TMPDIR = tmp;
    expect(() => fetchSource(parseSource("github:acme/skills//rn"))).toThrow(/transport 'file' not allowed/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  describe.skipIf(process.platform === "win32")("a hung git", () => {
    function fakeGit(script: string): void {
      const bin = path.join(base, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    }

    it("is killed at the timeout and the error names the URL and --git-timeout", () => {
      fakeGit("exec sleep 30");
      const started = Date.now();
      expect(() => fetchSource(parseSource("github:acme/skills"), { timeoutMs: 1000 })).toThrow(
        /https:\/\/github\.com\/acme\/skills\.git.*timed out after 1 s.*--git-timeout/s,
      );
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it("is killed at the timeout even when it left a child holding the pipes, and the child goes with it", async () => {
      const pidFile = path.join(base, "child.pid");
      fakeGit(`sleep 30 &\necho $! > '${pidFile}'\nsleep 30`);
      const started = Date.now();
      expect(() => fetchSource(parseSource("github:acme/skills"), { timeoutMs: 1000 })).toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(10_000);
      const child = Number(fs.readFileSync(pidFile, "utf8"));
      const alive = () => {
        try {
          process.kill(child, 0);
          return true;
        } catch {
          return false;
        }
      };
      for (let i = 0; i < 20 && alive(); i++) await new Promise((r) => setTimeout(r, 100));
      const survived = alive();
      if (survived) process.kill(child, "SIGKILL"); // do not leave it behind, whatever the result
      expect(survived).toBe(false);
    });
  });

  describe("--git-timeout on the command line", () => {
    const repo = path.resolve(here, "..");
    function cli(args: string[]) {
      const r = spawnSync(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "src/cli.ts"), ...args], {
        cwd: proj,
        env: { ...process.env, SKILLWHARF_HOME: home },
        encoding: "utf8",
      });
      return { stdout: r.stdout, stderr: r.stderr, status: r.status };
    }

    it("refuses a value that is not a positive number", () => {
      for (const bad of ["abc", "0", "-5"]) {
        const r = cli(["--git-timeout", bad, "add", "github:acme/skills"]);
        expect(r.status).toBe(1);
        expect(r.stderr).toMatch(/--git-timeout takes a positive number of seconds/);
      }
    });

    it.skipIf(process.platform === "win32")("passes the limit to the fetch: a hung git is killed after that many seconds", () => {
      const bin = path.join(base, "bin");
      fs.mkdirSync(bin);
      fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
      fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
      process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
      const started = Date.now();
      const r = cli(["--git-timeout", "1", "add", "github:acme/skills"]);
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/timed out after 1 s/);
      expect(r.stderr).toContain("https://github.com/acme/skills.git");
      expect(Date.now() - started).toBeLessThan(15_000);
    });
  });

  it("S1.17: adding a git source never calls a host API", async () => {
    makeRepo("acme/platform/skills", (w) => writeSkill(path.join(w, "rn"), "rn"));
    routeHosts(ALL_HOSTS);
    const spy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", spy);
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    const [added] = addSkill(ctx, "gitlab:acme/platform/skills//rn");
    expect(added.name).toBe("rn");
    expect(spy).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ S1.16 / S1.18
function writeManifest(m: Manifest) {
  fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify(m));
}
function writeLock(l: Lockfile) {
  fs.writeFileSync(path.join(proj, "skillwharf.lock.json"), JSON.stringify(l));
}
function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}
/** The host refuses to serve this commit by sha; everything else runs for real. */
function refuseShaFetch(sha: string): void {
  exec.mockImplementation(((file: string, args: string[], options: never) => {
    if (args.includes("fetch") && args.includes(sha)) {
      throw Object.assign(new Error("Command failed: git fetch"), {
        stderr: Buffer.from(`fatal: remote error: upload-pack: not our ref ${sha}\n`),
        status: 128,
      });
    }
    return realExec.fn(file, args, options);
  }) as never);
}
function privateTmp(): string {
  const tmp = path.join(base, "tmp");
  fs.mkdirSync(tmp, { recursive: true });
  process.env.TMPDIR = tmp;
  return tmp;
}
const alphaRepo = (w: string, body = "body") => writeSkill(path.join(w, "alpha"), "alpha", body);
/** The integrity the lockfile would hold for alpha at this commit. */
function integrityAt(source: string): string {
  const f = fetchSource(parseSource(source));
  try {
    return hashDir(f.dir);
  } finally {
    f.cleanup();
  }
}

describe("S1.16: a pinned fetch the host refuses falls back to the recorded ref, and only if HEAD is the pin", () => {
  let sha1: string, sha2: string;
  const lockFor = (sha: string, integrity: string, source = "github:acme/skills/alpha"): Lockfile => ({
    version: 1,
    skills: { alpha: { source, resolved: `${source.replace(/@.*$/, "")}@${sha}`, integrity, installedAt: "x" } },
  });

  describe("the ref still points at the pin", () => {
    beforeEach(() => {
      sha1 = makeRepo("acme/skills", (w) => alphaRepo(w, "first"));
      routeHosts(ALL_HOSTS);
      writeLock(lockFor(sha1, integrityAt(`github:acme/skills/alpha@${sha1}`)));
      exec.mockClear();
      refuseShaFetch(sha1);
    });

    it("installs it from a clone of the default branch when the manifest has no ref", () => {
      writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "github:acme/skills/alpha" } } });
      const r = syncSkills(ctx);
      expect(r.fetched).toEqual(["alpha"]);
      expect(read(path.join(storePath(ctx, "alpha"), "SKILL.md"))).toContain("first");
      expect(loadLock(ctx).skills.alpha.resolved).toBe(`github:acme/skills/alpha@${sha1}`);
      const calls = gitCalls();
      const failedFetch = calls.findIndex((c) => c.includes("fetch"));
      const clone = calls.findIndex((c) => c[0] === "clone");
      expect(failedFetch).toBeGreaterThanOrEqual(0);
      expect(clone).toBeGreaterThan(failedFetch);
      expect(calls[clone]).not.toContain("--branch");
    });

    it("clones the manifest's branch when it names one", () => {
      const head = git("-C", path.join(base, "srv", "acme", "skills.git"), "rev-parse", "--abbrev-ref", "HEAD");
      writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: `github:acme/skills/alpha@${head}` } } });
      const integrity = (JSON.parse(read(path.join(proj, "skillwharf.lock.json"))) as Lockfile).skills.alpha.integrity;
      writeLock(lockFor(sha1, integrity, `github:acme/skills/alpha@${head}`));
      syncSkills(ctx);
      const clone = gitCalls().find((c) => c[0] === "clone") as string[];
      expect(clone).toContain("--branch");
      expect(clone).toContain(head);
    });

    it("leaves no temp folder behind", () => {
      const tmp = privateTmp();
      writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "github:acme/skills/alpha" } } });
      syncSkills(ctx);
      expect(fs.readdirSync(tmp)).toEqual([]);
    });
  });

  describe("the ref has moved past the pin (the host really refuses the old commit)", () => {
    beforeEach(() => {
      sha2 = makeRepo("acme/skills", (w) => {
        alphaRepo(w, "first");
        git("-C", w, "add", "-A");
        git("-C", w, "commit", "--quiet", "-m", "first");
        sha1 = git("-C", w, "rev-parse", "HEAD");
        alphaRepo(w, "second");
      });
      routeHosts(ALL_HOSTS, [["protocol.version", "0"]]);
      writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "github:acme/skills/alpha" } } });
      writeLock(lockFor(sha1, "sha256-x"));
    });

    it("refuses, installs nothing, leaves the lockfile alone and no temp folder", () => {
      const tmp = privateTmp();
      const before = read(path.join(proj, "skillwharf.lock.json"));
      expect(() => syncSkills(ctx)).toThrow(/Cannot install the pinned commit for "alpha"/);
      expect(read(path.join(proj, "skillwharf.lock.json"))).toBe(before);
      expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
      expect(fs.readdirSync(tmp)).toEqual([]);
    });

    it("--allow-unpinned installs the manifest source as it is now and re-pins", () => {
      syncSkills(ctx, { allowUnpinned: true });
      expect(read(path.join(storePath(ctx, "alpha"), "SKILL.md"))).toContain("second");
      expect(loadLock(ctx).skills.alpha.resolved).toBe(`github:acme/skills/alpha@${sha2}`);
    });
  });

  it("does not fall back at all when the manifest ref is itself a commit", () => {
    sha1 = makeRepo("acme/skills", (w) => alphaRepo(w, "first"));
    routeHosts(ALL_HOSTS);
    const source = `github:acme/skills/alpha@${sha1}`;
    writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source } } });
    writeLock(lockFor(sha1, integrityAt(source), source));
    exec.mockClear();
    refuseShaFetch(sha1);
    expect(() => syncSkills(ctx)).toThrow(/Cannot install the pinned commit for "alpha"/);
    expect(gitCalls().some((c) => c[0] === "clone")).toBe(false);
  });

  it("a branch that no longer exists is a refused pin too", () => {
    sha1 = makeRepo("acme/skills", (w) => alphaRepo(w, "first"));
    routeHosts(ALL_HOSTS);
    writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "github:acme/skills/alpha@gone-branch" } } });
    writeLock(lockFor(sha1, integrityAt(`github:acme/skills/alpha@${sha1}`), "github:acme/skills/alpha@gone-branch"));
    refuseShaFetch(sha1);
    expect(() => syncSkills(ctx)).toThrow(/Cannot install the pinned commit for "alpha"/);
  });
});

describe("S1.18: a moved or missing repository", () => {
  const missing = "git+https://git.acme.test/gone/x.git";

  it("sync names update --source when the repository cannot be reached", () => {
    routeHosts(ALL_HOSTS);
    writeManifest({ version: 1, agents: ["claude"], skills: { x: { source: missing } } });
    expect(() => syncSkills(ctx)).toThrow(
      "repository not found or no access at https://git.acme.test/gone/x.git; if it moved, run `skillwharf update x --source <new>`",
    );
  });

  it("the same holds for a pinned entry", () => {
    routeHosts(ALL_HOSTS);
    writeManifest({ version: 1, agents: ["claude"], skills: { x: { source: missing } } });
    writeLock({
      version: 1,
      skills: { x: { source: missing, resolved: `${missing}@${SHA}`, integrity: "sha256-x", installedAt: "x" } },
    });
    expect(() => syncSkills(ctx)).toThrow(/repository not found or no access at https:\/\/git\.acme\.test\/gone\/x\.git; if it moved, run `skillwharf update x --source <new>`/);
  });

  it("add says the repository is unreachable without inventing a skill name", () => {
    routeHosts(ALL_HOSTS);
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    let message = "";
    try {
      addSkill(ctx, missing);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/repository not found or no access at https:\/\/git\.acme\.test\/gone\/x\.git/);
    expect(message).not.toMatch(/update <name>|update undefined/);
  });

  it("a lockfile that does not match the manifest names update --source", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "gitlab:acme/new//alpha" } } });
    writeLock({
      version: 1,
      skills: { alpha: { source: "gitlab:acme/new//alpha", resolved: `github:acme/old/alpha@${SHA}`, integrity: "sha256-x", installedAt: "x" } },
    });
    expect(() => syncSkills(ctx)).toThrow(/does not match.*skillwharf update alpha --source <new>/s);
  });

  describe("update --source", () => {
    beforeEach(() => {
      makeRepo("acme/skills", (w) => alphaRepo(w, "old content"));
      makeRepo("acme/moved", (w) => alphaRepo(w, "new content"));
      routeHosts(ALL_HOSTS);
      fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
      addSkill(ctx, "github:acme/skills/alpha");
    });

    it("rewrites the manifest source and re-pins in one step", () => {
      const res = updateSkills(ctx, ["alpha"], { source: "github:acme/moved/alpha" });
      expect(res[0].changed).toBe(true);
      expect(loadManifest(ctx)!.skills.alpha.source).toBe("github:acme/moved/alpha");
      const entry = loadLock(ctx).skills.alpha;
      expect(entry.source).toBe("github:acme/moved/alpha");
      expect(entry.resolved).toMatch(/^github:acme\/moved\/alpha@[0-9a-f]{40}$/);
      expect(read(path.join(storePath(ctx, "alpha"), "SKILL.md"))).toContain("new content");
      expect(fs.readlinkSync(path.join(proj, ".claude", "skills", "alpha"))).toContain(path.join(".skillwharf", "skills", "alpha"));
      // and a later sync is happy with the pair
      expect(syncSkills(ctx).fetched).toEqual([]);
    });

    it("accepts any host for the new source", () => {
      makeRepo("team/skills", (w) => alphaRepo(w, "on the company server"));
      updateSkills(ctx, ["alpha"], { source: "git+https://git.acme.test/team/skills.git//alpha" });
      expect(loadManifest(ctx)!.skills.alpha.source).toBe("git+https://git.acme.test/team/skills.git//alpha");
      expect(loadLock(ctx).skills.alpha.resolved).toMatch(/^git\+https:\/\/git\.acme\.test\/team\/skills\.git\/\/alpha@[0-9a-f]{40}$/);
    });

    it("leaves the manifest, the lockfile and the store byte-identical when the new source fails", () => {
      const m = read(path.join(proj, "skillwharf.json"));
      const l = read(path.join(proj, "skillwharf.lock.json"));
      const store = hashDir(storePath(ctx, "alpha"));
      expect(() => updateSkills(ctx, ["alpha"], { source: "github:acme/gone/alpha" })).toThrow(/repository not found or no access/);
      expect(read(path.join(proj, "skillwharf.json"))).toBe(m);
      expect(read(path.join(proj, "skillwharf.lock.json"))).toBe(l);
      expect(hashDir(storePath(ctx, "alpha"))).toBe(store);
    });

    it("needs exactly one skill name", () => {
      expect(() => updateSkills(ctx, [], { source: "github:acme/moved/alpha" })).toThrow(/exactly one skill/);
      expect(() => updateSkills(ctx, ["alpha", "beta"], { source: "github:acme/moved/alpha" })).toThrow(/exactly one skill/);
    });

    it("refuses a local source that is the skill's own store", () => {
      expect(() => updateSkills(ctx, ["alpha"], { source: storePath(ctx, "alpha") })).toThrow(/overlap/);
    });

    it("refuses a source that does not parse, before fetching anything", () => {
      exec.mockClear();
      expect(() => updateSkills(ctx, ["alpha"], { source: "git+https://u:p@git.acme.test/x.git" })).toThrow(/credential/);
      expect(gitCalls()).toEqual([]);
    });
  });
});

// ------------------------------------------------------------------ S1.19 submodules
/** A new commit on top of a bare repository's default branch; returns its sha. */
function commitTo(repoPath: string, change: (work: string) => void): string {
  const bare = path.join(base, "srv", `${repoPath}.git`);
  const work = path.join(base, "work", String(repoCount++));
  git("clone", "--quiet", bare, work);
  change(work);
  git("-C", work, "add", "-A");
  git("-C", work, "commit", "--quiet", "-m", "more");
  git("-C", work, "push", "--quiet", "origin", "HEAD");
  return git("-C", work, "rev-parse", "HEAD");
}

/** Declare `p` a submodule of `w` at `sha` (a gitlink in the tree, an entry in .gitmodules), without cloning anything. */
function addGitlink(w: string, p: string, sha: string): void {
  fs.mkdirSync(path.join(w, p), { recursive: true });
  git("-C", w, "update-index", "--add", "--cacheinfo", `160000,${sha},${p}`);
}
function writeGitmodules(w: string, entries: [string, string][]): void {
  fs.writeFileSync(path.join(w, ".gitmodules"), entries.map(([p, u]) => `[submodule "${p}"]\n\tpath = ${p}\n\turl = ${u}\n`).join(""));
}

describe("S1.19: submodules, one level, pinned by the parent's recorded commit", () => {
  const FAKE = "1234567890abcdef1234567890abcdef12345678";
  const parentUrl = (sub: string, repo = "team/parent") => `git+https://git.acme.test/${repo}.git//${sub}`;
  let childSha: string, collectionSha: string, parentSha: string, newerChildSha: string;

  beforeEach(() => {
    childSha = makeRepo("team/child-skill", (w) => writeSkill(w, "cs", "pinned content"));
    collectionSha = makeRepo("team/collection", (w) => {
      writeSkill(path.join(w, "skills", "pdf"), "pdf", "pdf body");
      writeSkill(path.join(w, "skills", "ocr"), "ocr", "ocr body");
    });
    parentSha = makeRepo("team/parent", (w) => {
      writeSkill(path.join(w, "own"), "own");
      addGitlink(w, "vendor/child-skill", childSha);
      addGitlink(w, "vendor/collection", collectionSha);
      writeGitmodules(w, [
        ["vendor/child-skill", "../child-skill.git"],
        ["vendor/collection", "../collection.git"],
      ]);
    });
    // The child moves on; the parent still records the old commit.
    newerChildSha = commitTo("team/child-skill", (w) => writeSkill(w, "cs", "newer content"));
    routeHosts(ALL_HOSTS);
    exec.mockClear();
  });

  function fetched(sub: string, repo?: string) {
    return fetchSource(parseSource(parentUrl(sub, repo)));
  }

  it("a sub-path that is a gitlink installs the child at the commit the parent records, not its newer head", () => {
    expect(newerChildSha).not.toBe(childSha);
    const f = fetched("vendor/child-skill");
    try {
      expect(fs.readFileSync(path.join(f.dir, "SKILL.md"), "utf8")).toContain("pinned content");
      expect(fs.existsSync(path.join(f.dir, ".git"))).toBe(false);
      expect(f.sha).toBe(parentSha);
      expect(f.resolved).toBe(`git+https://git.acme.test/team/parent.git//vendor/child-skill@${parentSha}`);
    } finally {
      f.cleanup();
    }
  });

  it("a sub-path that contains a gitlink finds the child's skills (add --all)", () => {
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    const added = addSkill(ctx, parentUrl("vendor/collection"), { all: true });
    expect(added.map((a) => a.name).sort()).toEqual(["ocr", "pdf"]);
    expect(loadManifest(ctx)!.skills.pdf.source).toBe("git+https://git.acme.test/team/parent.git//vendor/collection/skills/pdf");
  });

  it("a sub-path that passes through a gitlink installs the folder inside the child", () => {
    const f = fetched("vendor/collection/skills/pdf");
    try {
      expect(fs.readFileSync(path.join(f.dir, "SKILL.md"), "utf8")).toContain("pdf body");
    } finally {
      f.cleanup();
    }
  });

  it("sync from the lockfile reinstalls the same content", () => {
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    addSkill(ctx, parentUrl("vendor/collection/skills/pdf"));
    const lock = loadLock(ctx).skills.pdf;
    expect(lock.resolved).toBe(`git+https://git.acme.test/team/parent.git//vendor/collection/skills/pdf@${parentSha}`);
    fs.rmSync(path.join(proj, ".skillwharf"), { recursive: true });
    fs.rmSync(path.join(proj, ".claude"), { recursive: true });
    expect(syncSkills(ctx).fetched).toEqual(["pdf"]);
    expect(hashDir(storePath(ctx, "pdf"))).toBe(lock.integrity);
  });

  it("the child is fetched with the same guards as the parent", () => {
    const f = fetched("vendor/child-skill");
    f.cleanup();
    const childUrl = "https://git.acme.test/team/child-skill.git";
    const calls = exec.mock.calls.filter((c) => (c[1] as string[]).includes(childUrl) || (c[1] as string[]).includes(childSha));
    expect(calls.map((c) => withoutHardening(c[1] as string[]))).toEqual(
      expect.arrayContaining([
        ["-C", expect.any(String), "remote", "add", "--", "origin", childUrl],
        ["-C", expect.any(String), "fetch", "--depth", "1", "--quiet", "origin", childSha],
      ]),
    );
    for (const c of calls) {
      const o = c[2] as Record<string, unknown>;
      expect((o.env as Record<string, string>).GIT_ALLOW_PROTOCOL).toMatch(/^https:ssh/);
      expect((o.env as Record<string, string>).GIT_TERMINAL_PROMPT).toBe("0");
      expect((o.stdio as string[])[0]).toBe("ignore");
      expect(o.timeout).toBe(120_000);
    }
  });

  it("opens no submodule, and runs no extra git, for a repository without .gitmodules", () => {
    makeRepo("team/plain", (w) => writeSkill(path.join(w, "rn"), "rn"));
    exec.mockClear();
    fetched("rn", "team/plain").cleanup();
    expect(gitCalls().some((c) => c.includes("ls-tree"))).toBe(false);
  });

  it("an unreachable commit in the child names the child's URL and leaves no temp folder", () => {
    const tmp = privateTmp();
    makeRepo("team/broken", (w) => {
      writeSkill(path.join(w, "own"), "own");
      addGitlink(w, "vendor/x", FAKE);
      writeGitmodules(w, [["vendor/x", "../child-skill.git"]]);
    });
    expect(() => fetched("vendor/x", "team/broken")).toThrow(/git fetch failed for https:\/\/git\.acme\.test\/team\/child-skill\.git/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  describe("a .gitmodules URL is held to the source grammar", () => {
    let n = 0;
    it.each([
      ["a local path", "/etc/passwd", /only https and ssh/],
      ["file://", "file:///etc/passwd", /only https and ssh/],
      ["git://", "git://git.acme.test/x.git", /only https and ssh/],
      ["http://", "http://git.acme.test/x.git", /only https and ssh/],
      ["ext::", "ext::sh -c touch% /tmp/x", /only https and ssh/],
      ["credentials", "https://user:pw@git.acme.test/x.git", /credential/],
      ["a relative URL that climbs out of the host", "../../../../escape.git", /climbs out/],
      ["an ssh URL whose host is an option for ssh", "ssh://-oProxyCommand=sh/p.git", /Invalid host/],
      ["an scp-style URL with a user other than git", "bob@git.acme.test:team/x.git", /credential/],
    ])("refuses %s", (_name, url, why) => {
      const repo = `team/bad${n++}`;
      makeRepo(repo, (w) => {
        addGitlink(w, "vendor/x", FAKE);
        writeGitmodules(w, [["vendor/x", url]]);
      });
      let message = "";
      try {
        fetched("vendor/x", repo);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).toMatch(/the submodule at "vendor\/x" has the URL/);
      expect(message).toMatch(why);
      expect(message).not.toContain(":pw@");
      expect(gitCalls().some((c) => c.includes("fetch") && c.includes(FAKE))).toBe(false);
    });
  });

  it("refuses a gitlink inside the child, naming the inner repository", () => {
    const outer = makeRepo("team/outer", (w) => {
      writeSkill(w, "outer");
      addGitlink(w, "inner", FAKE);
      writeGitmodules(w, [["inner", "https://git.acme.test/team/inner.git"]]);
    });
    makeRepo("team/with-nested", (w) => {
      addGitlink(w, "vendor/outer", outer);
      writeGitmodules(w, [["vendor/outer", "../outer.git"]]);
    });
    expect(() => fetched("vendor/outer", "team/with-nested")).toThrow(
      /contains another submodule \("inner", https:\/\/git\.acme\.test\/team\/inner\.git\); only one level/,
    );
  });

  it("refuses a gitlink that has no entry in .gitmodules", () => {
    makeRepo("team/noentry", (w) => {
      addGitlink(w, "vendor/x", FAKE);
      addGitlink(w, "vendor/y", FAKE);
      writeGitmodules(w, [["vendor/y", "../child-skill.git"]]);
    });
    expect(() => fetched("vendor/x", "team/noentry")).toThrow(/the submodule at "vendor\/x" has no entry for it in \.gitmodules/);
  });

  it("refuses a .gitmodules that is a symlink", () => {
    // git itself refuses to `add` a symlinked .gitmodules, so the tree is built with plumbing.
    const work = path.join(base, "work", "linked");
    git("init", "--quiet", work);
    writeGitmodules(work, [["x", "../child-skill.git"]]);
    fs.renameSync(path.join(work, ".gitmodules"), path.join(base, "real-modules"));
    fs.writeFileSync(path.join(base, "link-text"), "real-modules");
    const modules = git("-C", work, "hash-object", "-w", path.join(base, "real-modules"));
    const link = git("-C", work, "hash-object", "-w", path.join(base, "link-text"));
    const tree = (
      execFileSync("git", ["-C", work, "mktree", "--missing"], {
        input: `120000 blob ${link}\t.gitmodules\n100644 blob ${modules}\treal-modules\n160000 commit ${FAKE}\tx\n`,
        stdio: ["pipe", "pipe", "pipe"],
      }) as Buffer
    )
      .toString()
      .trim();
    const commit = git("-C", work, "commit-tree", tree, "-m", "one");
    git("-C", work, "update-ref", "HEAD", commit);
    const bare = path.join(base, "srv", "team", "linked.git");
    fs.mkdirSync(path.dirname(bare), { recursive: true });
    git("clone", "--quiet", "--bare", work, bare);
    // Current git refuses to check such a file out at all; either way nothing is installed.
    const tmp = privateTmp();
    expect(() => fetched("x", "team/linked")).toThrow(/invalid path '\.gitmodules'|\.gitmodules is a symlink/);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("placeSubmodules itself refuses a symlinked .gitmodules before running git", () => {
    const root = path.join(base, "plain-tree");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(base, "elsewhere"), "[submodule]");
    fs.symlinkSync(path.join(base, "elsewhere"), path.join(root, ".gitmodules"));
    exec.mockClear();
    expect(() =>
      placeSubmodules(root, "x", { parentUrl: "https://git.acme.test/team/p.git", cloneUrlFor: (u) => u }),
    ).toThrow(/\.gitmodules is a symlink/);
    expect(gitCalls()).toEqual([]);
  });

  it("refuses more than 16 gitlinks under the sub-path", () => {
    makeRepo("team/many", (w) => {
      const entries: [string, string][] = [];
      for (let i = 0; i < 17; i++) {
        addGitlink(w, `vendor/m${i}`, FAKE);
        entries.push([`vendor/m${i}`, "../child-skill.git"]);
      }
      writeGitmodules(w, entries);
    });
    expect(() => fetched("vendor", "team/many")).toThrow(/17 submodules under "vendor".*at most 16/);
  });
});

// ------------------------------------------------------------------ S1.20 symlinks
describe("S1.20: symlinks in a fetched repository", () => {
  let outside: string;
  const addJson = () => fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
  const noStore = () => {
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
    expect(Object.keys(loadManifest(ctx)!.skills)).toEqual([]);
  };

  beforeEach(() => {
    outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "TOP SECRET");
    fs.writeFileSync(path.join(outside, "secret-skill.md"), "---\nname: stolen\ndescription: d\n---\nTOP SECRET\n");
    makeRepo("acme/skills", (w) => {
      writeSkill(path.join(w, "skills", "alpha"), "alpha");
      fs.mkdirSync(path.join(w, "shared", "lib", "sub"), { recursive: true });
      fs.writeFileSync(path.join(w, "shared", "data.sh"), "#!/bin/sh\necho data\n");
      fs.chmodSync(path.join(w, "shared", "data.sh"), 0o755);
      fs.writeFileSync(path.join(w, "shared", "lib", "a.txt"), "a");
      fs.writeFileSync(path.join(w, "shared", "lib", "sub", "b.txt"), "b");
      const a = path.join(w, "skills", "alpha");
      fs.symlinkSync("../../shared/data.sh", path.join(a, "data.sh")); // a file link inside the repository
      fs.symlinkSync("../../shared/lib", path.join(a, "lib")); // a directory link inside the repository
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(a, "leak")); // leaves the repository
      fs.symlinkSync("../../.git/config", path.join(a, "gitconfig")); // into the clone's own .git
      fs.symlinkSync("skills/alpha", path.join(w, "linkdir")); // a link on the sub-path
    });
    routeHosts(ALL_HOSTS);
    addJson();
  });

  it("copies a link to a file inside the repository as that file, with its exec bit", () => {
    addSkill(ctx, "github:acme/skills/skills/alpha");
    const copy = path.join(storePath(ctx, "alpha"), "data.sh");
    expect(fs.lstatSync(copy).isFile()).toBe(true);
    expect(fs.readFileSync(copy, "utf8")).toContain("echo data");
    expect(fs.statSync(copy).mode & 0o100).not.toBe(0);
  });

  it("copies a link to a directory inside the repository as that directory", () => {
    addSkill(ctx, "github:acme/skills/skills/alpha");
    const lib = path.join(storePath(ctx, "alpha"), "lib");
    expect(fs.lstatSync(lib).isDirectory()).toBe(true);
    expect(fs.readFileSync(path.join(lib, "a.txt"), "utf8")).toBe("a");
    expect(fs.readFileSync(path.join(lib, "sub", "b.txt"), "utf8")).toBe("b");
    expect(fs.lstatSync(path.join(lib, "sub")).isSymbolicLink()).toBe(false);
  });

  it("drops a link that leaves the repository or points into .git, and reports both", () => {
    const [added] = addSkill(ctx, "github:acme/skills/skills/alpha");
    expect(added.skippedSymlinks.sort()).toEqual(["gitconfig", "leak"]);
    expect(fs.existsSync(path.join(storePath(ctx, "alpha"), "leak"))).toBe(false);
    expect(fs.existsSync(path.join(storePath(ctx, "alpha"), "gitconfig"))).toBe(false);
    expect(fs.readdirSync(storePath(ctx, "alpha")).sort()).toEqual(["SKILL.md", "data.sh", "lib"]);
  });

  it("the store holds no symlink at all", () => {
    addSkill(ctx, "github:acme/skills/skills/alpha");
    const walk = (d: string): string[] =>
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isSymbolicLink() ? [e.name] : e.isDirectory() ? walk(path.join(d, e.name)) : []));
    expect(walk(storePath(ctx, "alpha"))).toEqual([]);
  });

  it("a link on the sub-path itself is still refused", () => {
    expect(() => addSkill(ctx, "github:acme/skills/linkdir")).toThrow(/symlink/);
    noStore();
  });

  it("refuses a directory link cycle and writes nothing", () => {
    makeRepo("acme/cyc", (w) => {
      writeSkill(path.join(w, "skills", "c"), "c");
      fs.symlinkSync(".", path.join(w, "skills", "c", "loop"));
    });
    expect(() => addSkill(ctx, "github:acme/cyc/skills/c")).toThrow(/symlink cycle at loop/);
    noStore();
  });

  it("refuses a cycle that runs through two folders", () => {
    makeRepo("acme/cyc2", (w) => {
      writeSkill(path.join(w, "a"), "a");
      fs.mkdirSync(path.join(w, "b"));
      fs.symlinkSync("../b", path.join(w, "a", "to-b"));
      fs.symlinkSync("../a", path.join(w, "b", "to-a"));
    });
    expect(() => addSkill(ctx, "github:acme/cyc2/a")).toThrow(/symlink cycle/);
    noStore();
  });

  it("a symlinked SKILL.md that resolves inside the repository counts as a skill", () => {
    makeRepo("acme/mirror", (w) => {
      writeSkill(path.join(w, "canonical"), "mirrored", "canonical body");
      fs.mkdirSync(path.join(w, "skills", "m"), { recursive: true });
      fs.symlinkSync("../../canonical/SKILL.md", path.join(w, "skills", "m", "SKILL.md"));
    });
    const [added] = addSkill(ctx, "github:acme/mirror/skills/m");
    expect(added.name).toBe("mirrored");
    const copy = path.join(storePath(ctx, "mirrored"), "SKILL.md");
    expect(fs.lstatSync(copy).isFile()).toBe(true);
    expect(fs.readFileSync(copy, "utf8")).toContain("canonical body");
  });

  it("a symlinked SKILL.md that points outside the repository is not a skill", () => {
    makeRepo("acme/thief", (w) => {
      fs.mkdirSync(path.join(w, "skills", "t"), { recursive: true });
      fs.symlinkSync(path.join(outside, "secret-skill.md"), path.join(w, "skills", "t", "SKILL.md"));
    });
    expect(() => addSkill(ctx, "github:acme/thief/skills/t")).toThrow(/No SKILL\.md/);
    noStore();
  });

  it("the size cap counts resolved content, so links cannot multiply a folder past it", () => {
    makeRepo("acme/bomb", (w) => {
      writeSkill(path.join(w, "skills", "big"), "big");
      fs.mkdirSync(path.join(w, "shared"));
      fs.writeFileSync(path.join(w, "shared", "blob.bin"), Buffer.alloc(1024 * 1024, 1));
      for (let i = 0; i < 50; i++) fs.symlinkSync("../../shared", path.join(w, "skills", "big", `l${i}`));
    });
    expect(() => addSkill(ctx, "github:acme/bomb/skills/big", { limits: { maxBytes: 10 * 1024 * 1024 } })).toThrow(/more than 10 MB of files/);
    noStore();
    expect(() => addSkill(ctx, "github:acme/bomb/skills/big", { limits: { maxFiles: 20 } })).toThrow(/more than 20 files and folders/);
    noStore();
  });

  it("add --all stages every skill before writing the first: a cycle in the second leaves nothing", () => {
    makeRepo("acme/pack", (w) => {
      writeSkill(path.join(w, "skills", "a-ok"), "a-ok");
      writeSkill(path.join(w, "skills", "b-bad"), "b-bad");
      fs.symlinkSync(".", path.join(w, "skills", "b-bad", "loop"));
    });
    expect(() => addSkill(ctx, "github:acme/pack/skills", { all: true })).toThrow(/symlink cycle/);
    noStore();
  });

  it("path: sources still drop every link, even one that stays inside the folder", () => {
    writeSkill(path.join(proj, "src", "p"), "p");
    fs.writeFileSync(path.join(proj, "src", "p", "real.txt"), "real");
    fs.symlinkSync("real.txt", path.join(proj, "src", "p", "alias.txt"));
    const [added] = addSkill(ctx, path.join(proj, "src", "p"));
    expect(added.skippedSymlinks).toEqual(["alias.txt"]);
    expect(fs.existsSync(path.join(storePath(ctx, "p"), "alias.txt"))).toBe(false);
    expect(fs.existsSync(path.join(storePath(ctx, "p"), "real.txt"))).toBe(true);
  });

  describe("a lock made by 0.1.x, which dropped every link", () => {
    const legacyIntegrity = (): string => {
      // What 0.1.x hashed: the skill folder with every link left out.
      const f = fetchSource(parseSource("github:acme/skills/skills/alpha"));
      try {
        const copy = path.join(base, "legacy-copy");
        copyDir(f.dir, copy);
        return hashDir(copy);
      } finally {
        f.cleanup();
      }
    };
    const lockWith = (integrity: string, sha: string): Lockfile => ({
      version: 1,
      skills: {
        alpha: {
          source: "github:acme/skills/skills/alpha",
          resolved: `github:acme/skills/skills/alpha@${sha}`,
          integrity,
          installedAt: "x",
        },
      },
    });
    let sha: string;
    beforeEach(() => {
      sha = git("-C", path.join(base, "srv", "acme", "skills.git"), "rev-parse", "HEAD");
      writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "github:acme/skills/skills/alpha" } } });
    });

    it("still syncs: the pin decides, and the old rule is the stricter one", () => {
      writeLock(lockWith(legacyIntegrity(), sha));
      syncSkills(ctx);
      expect(fs.readdirSync(storePath(ctx, "alpha")).sort()).toEqual(["SKILL.md"]);
      expect(loadLock(ctx).skills.alpha.integrity).toBe(legacyIntegrity());
    });

    it("a lock made under the new rule installs the resolved links", () => {
      addSkill(ctx, "github:acme/skills/skills/alpha");
      const integrity = loadLock(ctx).skills.alpha.integrity;
      fs.rmSync(path.join(proj, ".skillwharf"), { recursive: true });
      fs.rmSync(path.join(proj, ".claude"), { recursive: true });
      syncSkills(ctx);
      expect(fs.readdirSync(storePath(ctx, "alpha")).sort()).toEqual(["SKILL.md", "data.sh", "lib"]);
      expect(loadLock(ctx).skills.alpha.integrity).toBe(integrity);
    });

    it("an integrity that matches neither rule is still refused", () => {
      writeLock(lockWith("sha256-nope", sha));
      expect(() => syncSkills(ctx)).toThrow(/integrity mismatch for "alpha"/);
      expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
    });
  });
});

// ------------------------------------------------------------------ the one network test
// A real GitLab repository in a nested group, over https. It is skipped when
// gitlab.com cannot be reached; when it can, a failed install is a real failure.
// (If that skill is ever moved or renamed, point this at a fixture repository.)
const online =
  spawnSync("git", ["ls-remote", "https://gitlab.com/gitlab-org/ai/skills.git", "HEAD"], {
    timeout: 20_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).status === 0;

describe.skipIf(!online)("network: a skill from a public GitLab repository", () => {
  it("installs gitlab:gitlab-org/ai/skills//skills/glab and pins the full commit", () => {
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    const [added] = addSkill(ctx, "gitlab:gitlab-org/ai/skills//skills/glab@main");
    expect(added.name).toBe("glab");
    expect(fs.existsSync(path.join(storePath(ctx, "glab"), "SKILL.md"))).toBe(true);
    const entry = loadLock(ctx).skills.glab;
    expect(entry.resolved).toMatch(/^gitlab:gitlab-org\/ai\/skills\/\/skills\/glab@[0-9a-f]{40}$/);
    expect(entry.integrity).toMatch(/^sha256-/);
    expect(loadManifest(ctx)!.skills.glab.source).toBe("gitlab:gitlab-org/ai/skills//skills/glab@main");
  }, 90_000);
});

// ------------------------------------------------------------------ S1.21 discovery
describe("S1.21: add --all finds skills in the layouts real repositories use", () => {
  const names = (dirs: string[], root: string) => dirs.map((d) => path.relative(root, d).split(path.sep).join("/"));
  let tree: string;
  beforeEach(() => {
    tree = path.join(base, "tree");
    fs.mkdirSync(tree);
  });

  it("finds skills/<name>", () => {
    writeSkill(path.join(tree, "skills", "a"), "a");
    writeSkill(path.join(tree, "skills", "b"), "b");
    expect(names(discoverSkills(tree, { root: tree }), tree)).toEqual(["skills/a", "skills/b"]);
  });

  it("finds .agents/skills/<name> and .claude/skills/<name>, dot-folders included", () => {
    writeSkill(path.join(tree, ".agents", "skills", "a"), "a");
    writeSkill(path.join(tree, ".claude", "skills", "b"), "b");
    writeSkill(path.join(tree, ".cursor", "skills", "c"), "c");
    expect(names(discoverSkills(tree, { root: tree }), tree).sort()).toEqual([".agents/skills/a", ".claude/skills/b", ".cursor/skills/c"]);
  });

  it("follows a folder link only when it leads out of the folder being searched", () => {
    writeSkill(path.join(tree, ".agents", "skills", "a"), "a");
    fs.mkdirSync(path.join(tree, ".claude"));
    fs.symlinkSync("../.agents/skills", path.join(tree, ".claude", "skills")); // mirrors .agents/skills: no duplicate
    expect(names(discoverSkills(tree, { root: tree }), tree)).toEqual([".agents/skills/a"]);
  });

  it("follows a folder link out of the searched folder when it stays inside the repository, once per target", () => {
    writeSkill(path.join(tree, "skills", "x"), "x");
    fs.mkdirSync(path.join(tree, ".claude", "skills"), { recursive: true });
    fs.symlinkSync("../../skills/x", path.join(tree, ".claude", "skills", "x"));
    fs.symlinkSync("../../skills/x", path.join(tree, ".claude", "skills", "x-again"));
    const found = discoverSkills(path.join(tree, ".claude", "skills"), { root: tree });
    expect(names(found, tree)).toEqual([".claude/skills/x"]);
  });

  it("does not follow a folder link that leaves the repository", () => {
    const elsewhere = path.join(base, "elsewhere");
    writeSkill(path.join(elsewhere, "stolen"), "stolen");
    fs.symlinkSync(elsewhere, path.join(tree, "out"));
    expect(discoverSkills(tree, { root: tree })).toEqual([]);
  });

  it("goes six folders deep and no further", () => {
    writeSkill(path.join(tree, "a", "b", "c", "d"), "d4");
    writeSkill(path.join(tree, "a1", "b", "c", "d", "e", "f"), "d6");
    writeSkill(path.join(tree, "x", "y", "z", "w", "v", "u", "t"), "d7");
    expect(names(discoverSkills(tree, { root: tree }), tree)).toEqual(["a/b/c/d", "a1/b/c/d/e/f"]);
  });

  it("skips .git and node_modules", () => {
    writeSkill(path.join(tree, ".git", "skills", "g"), "g");
    writeSkill(path.join(tree, "node_modules", "pkg"), "pkg");
    writeSkill(path.join(tree, "real"), "real");
    expect(names(discoverSkills(tree, { root: tree }), tree)).toEqual(["real"]);
  });

  it("does not look inside a folder that is itself a skill", () => {
    writeSkill(path.join(tree, "outer"), "outer");
    writeSkill(path.join(tree, "outer", "examples", "inner"), "inner");
    expect(names(discoverSkills(tree, { root: tree }), tree)).toEqual(["outer"]);
  });

  it("stops at the entry bound and says how to narrow the search", () => {
    for (let i = 0; i < 60; i++) fs.mkdirSync(path.join(tree, `d${i}`));
    expect(() => discoverSkills(tree, { root: tree, maxEntries: 50 })).toThrow(
      /more than 50 entries while looking for skills.*sub-folder.*--max-skill-files/s,
    );
    expect(discoverSkills(tree, { root: tree, maxEntries: 500 })).toEqual([]);
  });

  it("the bound is ten times the per-skill file cap", () => {
    expect(discoveryBound()).toBe(20_000);
    expect(discoveryBound({ maxFiles: 300 })).toBe(3_000);
  });

  it("a local folder keeps the old search: two levels, no dot-folders", () => {
    writeSkill(path.join(tree, "skills", "a"), "a");
    writeSkill(path.join(tree, ".hidden", "h"), "h");
    writeSkill(path.join(tree, "p", "q", "r"), "r");
    expect(names(discoverSkills(tree), tree)).toEqual(["skills/a"]);
  });

  describe("through add --all on a git repository", () => {
    const addJson = () => fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));

    it("installs one copy of a skill that the repository mirrors, and reports the other", () => {
      makeRepo("acme/mirrored", (w) => {
        writeSkill(path.join(w, "skills", "x"), "x", "same");
        writeSkill(path.join(w, ".claude", "skills", "x"), "x", "same");
        writeSkill(path.join(w, ".agents", "skills", "x"), "x", "same");
      });
      routeHosts(ALL_HOSTS);
      addJson();
      const skipped: { dir: string; reason: string }[] = [];
      const added = addSkill(ctx, "github:acme/mirrored", { all: true, onSkipped: (s) => skipped.push(s) });
      expect(added.map((a) => a.name)).toEqual(["x"]);
      expect(loadManifest(ctx)!.skills.x.source).toBe("github:acme/mirrored/skills/x");
      expect(skipped.map((s) => s.dir).sort()).toEqual([".agents/skills/x", ".claude/skills/x"]);
      for (const s of skipped) expect(s.reason).toMatch(/same skill as skills\/x/);
    });

    it("still refuses two different skills with one name", () => {
      makeRepo("acme/clash", (w) => {
        writeSkill(path.join(w, "skills", "x"), "x", "one");
        writeSkill(path.join(w, ".claude", "skills", "x"), "x", "two");
      });
      routeHosts(ALL_HOSTS);
      addJson();
      expect(() => addSkill(ctx, "github:acme/clash", { all: true })).toThrow(/Two skills in github:acme\/clash resolve to the name "x"/);
      expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    });

    it("finds the skills under .agents/skills and a link into the repository from .claude/skills", () => {
      makeRepo("acme/linked", (w) => {
        writeSkill(path.join(w, "skills", "x"), "x");
        fs.mkdirSync(path.join(w, ".claude", "skills"), { recursive: true });
        fs.symlinkSync("../../skills/x", path.join(w, ".claude", "skills", "x"));
      });
      routeHosts(ALL_HOSTS);
      addJson();
      const added = addSkill(ctx, "github:acme/linked/.claude/skills", { all: true });
      expect(added.map((a) => a.name)).toEqual(["x"]);
      // one skill: the source stays the folder it was typed as, which finds it the same way on sync
      expect(loadManifest(ctx)!.skills.x.source).toBe("github:acme/linked/.claude/skills");
      expect(fs.readFileSync(path.join(storePath(ctx, "x"), "SKILL.md"), "utf8")).toContain("name: x");
      fs.rmSync(path.join(proj, ".skillwharf"), { recursive: true });
      fs.rmSync(path.join(proj, ".claude"), { recursive: true });
      expect(syncSkills(ctx).fetched).toEqual(["x"]);
    });

    it("records where a skill really is, not the link it was found through, so sync can fetch it again", () => {
      makeRepo("acme/linked2", (w) => {
        writeSkill(path.join(w, "skills", "x"), "x");
        writeSkill(path.join(w, "skills", "y"), "y");
        fs.mkdirSync(path.join(w, ".claude", "skills"), { recursive: true });
        fs.symlinkSync("../../skills/x", path.join(w, ".claude", "skills", "x"));
        fs.symlinkSync("../../skills/y", path.join(w, ".claude", "skills", "y"));
      });
      routeHosts(ALL_HOSTS);
      addJson();
      addSkill(ctx, "github:acme/linked2/.claude/skills", { all: true });
      const m = loadManifest(ctx)!;
      expect(m.skills.x.source).toBe("github:acme/linked2/skills/x");
      expect(m.skills.y.source).toBe("github:acme/linked2/skills/y");
      expect(loadLock(ctx).skills.x.resolved).toMatch(/^github:acme\/linked2\/skills\/x@[0-9a-f]{40}$/);
      fs.rmSync(path.join(proj, ".skillwharf"), { recursive: true });
      fs.rmSync(path.join(proj, ".claude"), { recursive: true });
      expect(syncSkills(ctx).fetched.sort()).toEqual(["x", "y"]);
    });
  });
});

// ------------------------------------------------------------------ Round A: what git inherits and runs
describe("Round A U1: the git environment of the user's own repository never reaches skillwharf's git", () => {
  const INHERITED = [
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

  it("gitEnv drops them and keeps the settings that are the user's to make", () => {
    const env = gitEnv({
      ...Object.fromEntries(INHERITED.map((k) => [k, "/somewhere"])),
      GIT_SSH_COMMAND: "ssh -i /k",
      GIT_CONFIG_GLOBAL: "/gitconfig",
      SSH_AUTH_SOCK: "/agent",
      PATH: "/bin",
    });
    for (const k of INHERITED) expect(env).not.toHaveProperty(k);
    expect(env).toMatchObject({ GIT_SSH_COMMAND: "ssh -i /k", GIT_CONFIG_GLOBAL: "/gitconfig", SSH_AUTH_SOCK: "/agent", PATH: "/bin" });
  });

  it.each([
    ["a clone", (sha: string) => `github:acme/skills//rn`, false],
    ["a pinned fetch", (sha: string) => `github:acme/skills//rn@${sha}`, true],
  ])("%s run from a git hook (GIT_DIR set) leaves the user's repository untouched", (_name, source) => {
    const sha = makeRepo("acme/skills", (w) => writeSkill(path.join(w, "rn"), "rn"));
    routeHosts(ALL_HOSTS);
    const mine = path.join(base, "mine");
    git("init", "--quiet", mine);
    fs.writeFileSync(path.join(mine, "mine.txt"), "mine");
    git("-C", mine, "add", "-A");
    git("-C", mine, "commit", "--quiet", "-m", "mine");
    const snapshot = () => ({
      config: fs.readFileSync(path.join(mine, ".git", "config"), "utf8"),
      head: fs.readFileSync(path.join(mine, ".git", "HEAD"), "utf8"),
      fetchHead: fs.existsSync(path.join(mine, ".git", "FETCH_HEAD")),
      files: fs.readdirSync(mine).sort(),
    });
    const before = snapshot();
    process.env.GIT_DIR = path.join(mine, ".git");
    process.env.GIT_WORK_TREE = mine;
    process.env.GIT_INDEX_FILE = path.join(mine, ".git", "index");
    let fetched: ReturnType<typeof fetchSource> | undefined;
    let error: unknown;
    try {
      fetched = fetchSource(parseSource(source(sha)));
    } catch (e) {
      error = e;
    }
    // The user's repository first: whatever happened to the fetch, it must not have been touched.
    expect(snapshot()).toEqual(before);
    if (error) throw error;
    try {
      expect(fs.existsSync(path.join((fetched as ReturnType<typeof fetchSource>).dir, "SKILL.md"))).toBe(true);
    } finally {
      fetched?.cleanup();
    }
  });
});

describe("Round A U2: the user's hooks and LFS are not run on a fetched tree", () => {
  it("a global core.hooksPath hook does not run", () => {
    makeRepo("acme/skills", (w) => writeSkill(path.join(w, "rn"), "rn"));
    routeHosts(ALL_HOSTS);
    const hooks = path.join(base, "hooks");
    const marker = path.join(base, "hook-ran");
    fs.mkdirSync(hooks);
    fs.writeFileSync(path.join(hooks, "post-checkout"), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(base, "gitconfig"), `[core]\n\thooksPath = ${hooks}\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(base, "gitconfig");
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    // control: the hook is live for a plain git clone with this configuration
    git("clone", "--quiet", path.join(base, "srv", "acme", "skills.git"), path.join(base, "control"));
    expect(fs.existsSync(marker)).toBe(true);
    fs.rmSync(marker);
    fetchSource(parseSource("github:acme/skills//rn")).cleanup();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("an LFS smudge filter (and one the repository's .gitattributes asks for) does not run", () => {
    // A machine with git-lfs installed has a system-wide `clean` filter that would turn the
    // committed file into a pointer: build the repository with no configuration but our own.
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_GLOBAL = os.devNull;
    makeRepo("acme/skills", (w) => {
      writeSkill(path.join(w, "rn"), "rn");
      fs.writeFileSync(path.join(w, ".gitattributes"), "*.bin filter=lfs\n");
      fs.writeFileSync(path.join(w, "rn", "data.bin"), "pointer-ish\n");
    });
    routeHosts(ALL_HOSTS);
    const marker = path.join(base, "lfs-ran");
    const smudge = path.join(base, "smudge.sh");
    fs.writeFileSync(smudge, `#!/bin/sh\ntouch '${marker}'\ncat\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(base, "gitconfig"), `[filter "lfs"]\n\tsmudge = ${smudge}\n\tclean = cat\n\trequired = true\n`);
    process.env.GIT_CONFIG_GLOBAL = path.join(base, "gitconfig");
    // Only this configuration: a machine with git-lfs installed has its own system-wide filter,
    // which would make the control clone below fail for a different reason.
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    git("clone", "--quiet", path.join(base, "srv", "acme", "skills.git"), path.join(base, "control"));
    expect(fs.existsSync(marker)).toBe(true); // control: the filter is live for a plain clone
    fs.rmSync(marker);
    const f = fetchSource(parseSource("github:acme/skills//rn"));
    try {
      expect(fs.readFileSync(path.join(f.dir, "data.bin"), "utf8")).toBe("pointer-ish\n");
    } finally {
      f.cleanup();
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("Round A U3: links inside a submodule survive being placed into the parent", () => {
  it("a relative link in a submodule is copied as the file it points to", () => {
    const childSha = makeRepo("team/child", (w) => {
      writeSkill(w, "cs");
      fs.writeFileSync(path.join(w, "real.txt"), "real content");
      fs.symlinkSync("real.txt", path.join(w, "alias.txt"));
    });
    makeRepo("team/parent", (w) => {
      addGitlink(w, "vendor/child", childSha);
      writeGitmodules(w, [["vendor/child", "../child.git"]]);
    });
    routeHosts(ALL_HOSTS);
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    addSkill(ctx, "git+https://git.acme.test/team/parent.git//vendor/child");
    const copy = path.join(storePath(ctx, "cs"), "alias.txt");
    expect(fs.readFileSync(copy, "utf8")).toBe("real content");
    expect(fs.lstatSync(copy).isFile()).toBe(true);
  });
});

describe("Round A D4: .git is recognised in any letter case", () => {
  it.each([
    [".git/config", true],
    [".GIT/config", true],
    ["a/.Git/x", true],
    ["a/.gIt", true],
    ["a/x.git/y", false],
    ["a/.github/y", false],
    ["a/git/y", false],
    ["", false],
  ])("inGitDir(%s) is %s", (p, want) => {
    expect(inGitDir(p.split("/").join(path.sep))).toBe(want);
  });

  it("copyResolvingLinks drops a link into .GIT", () => {
    const root = path.join(base, "r");
    fs.mkdirSync(path.join(root, ".GIT"), { recursive: true });
    fs.writeFileSync(path.join(root, ".GIT", "config"), "[core]");
    writeSkill(path.join(root, "skill"), "s");
    fs.symlinkSync("../.GIT/config", path.join(root, "skill", "cfg"));
    const { dropped } = copyResolvingLinks(path.join(root, "skill"), path.join(base, "out"), { root });
    expect(dropped).toEqual(["cfg"]);
    expect(fs.existsSync(path.join(base, "out", "cfg"))).toBe(false);
  });

  it("a link written as .GIT/config to a real .git folder is dropped too, on a case-insensitive file system", (ctxt) => {
    const root = path.join(base, "r");
    fs.mkdirSync(path.join(root, ".git"), { recursive: true });
    fs.writeFileSync(path.join(root, ".git", "config"), "[core]");
    if (fs.existsSync(path.join(root, ".GIT"))) {
      writeSkill(path.join(root, "skill"), "s");
      fs.symlinkSync("../.GIT/config", path.join(root, "skill", "cfg"));
      expect(copyResolvingLinks(path.join(root, "skill"), path.join(base, "out"), { root }).dropped).toEqual(["cfg"]);
    } else {
      ctxt.skip(); // a case-sensitive file system: .GIT is not .git there, and the pure tests above cover the rule
    }
  });

  it("a SKILL.md that links into .GIT is not a skill", () => {
    const root = path.join(base, "r");
    fs.mkdirSync(path.join(root, ".GIT"), { recursive: true });
    fs.writeFileSync(path.join(root, ".GIT", "SKILL.md"), "---\nname: x\ndescription: d\n---\n");
    fs.mkdirSync(path.join(root, "skill"));
    fs.symlinkSync("../.GIT/SKILL.md", path.join(root, "skill", "SKILL.md"));
    expect(isSkillDirIn(path.join(root, "skill"), root)).toBe(false);
  });

  it("discovery does not look inside a folder called .GIT", () => {
    const root = path.join(base, "r");
    writeSkill(path.join(root, ".GIT", "skills", "g"), "g");
    writeSkill(path.join(root, "real"), "real");
    expect(discoverSkills(root, { root }).map((d) => path.relative(root, d))).toEqual(["real"]);
  });
});

describe("Round A D1: a commit pin is exactly 40 hex characters", () => {
  const MSG = /a hex ref must be the full 40-character commit sha; for a tag or branch with that name write @refs\/tags\/<name> or @refs\/heads\/<name>/;

  it.each([
    "github:o/r@abc1234",
    `github:o/r/x@${SHA.slice(0, 39)}`,
    "gitlab:a/b/c//x@ABCDEF1",
    "bitbucket:a/b/x@1a2b3c4",
    "git+https://h.example/r.git//x@abc1234",
    "https://github.com/o/r/tree/abc1234/x",
  ])("refuses %s at parse time", (source) => {
    expect(() => parseSource(source)).toThrow(MSG);
  });

  it("accepts the full sha, and ref names that merely contain hex", () => {
    expect(parseSource(`github:o/r@${SHA}`)).toMatchObject({ ref: SHA });
    expect(parseSource(`github:o/r@${SHA.toUpperCase()}`)).toMatchObject({ ref: SHA.toUpperCase() });
    for (const ref of ["v1234567", "release-1234567", "1234567-fix", "main", "abc123"]) {
      expect(() => parseSource(`github:o/r@${ref}`)).not.toThrow();
    }
  });

  it("isCommitSha is true only for 40 hex characters", () => {
    expect(isCommitSha(SHA)).toBe(true);
    expect(isCommitSha(SHA.slice(0, 39))).toBe(false);
    expect(isCommitSha("abc1234")).toBe(false);
  });

  it("add and update --source refuse a 7-hex ref before any git call", () => {
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: { a: { source: "github:o/r/a" } } }));
    exec.mockClear();
    expect(() => addSkill(ctx, "github:acme/skills/alpha@abc1234")).toThrow(MSG);
    expect(() => updateSkills(ctx, ["a"], { source: "github:acme/skills/alpha@abc1234" })).toThrow(MSG);
    expect(gitCalls()).toEqual([]);
  });

  it("a branch that a repository owner named like a short sha is not installed under a pin", () => {
    // The scenario of the finding: `@1a2b3c4` used to take the pinned path, where git reads short hex as a ref name.
    const sha = makeRepo("acme/skills", (w) => writeSkill(path.join(w, "rn"), "real"));
    git("-C", path.join(base, "srv", "acme", "skills.git"), "branch", "1a2b3c4", sha);
    routeHosts(ALL_HOSTS);
    expect(() => fetchSource(parseSource("github:acme/skills//rn@1a2b3c4"))).toThrow(MSG);
  });

  it("a 0.1.x lock that holds an abbreviated pin is still reported as an unusable pin, not as a mismatch", () => {
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: { a: { source: "github:o/r/a" } } }));
    fs.writeFileSync(
      path.join(proj, "skillwharf.lock.json"),
      JSON.stringify({ version: 1, skills: { a: { source: "github:o/r/a", resolved: "github:o/r/a@34040c9c5685", integrity: "sha256-x", installedAt: "x" } } }),
    );
    expect(() => syncSkills(ctx)).toThrow(/Cannot install the pinned commit for "a".*40-character/s);
  });
});

describe("Round B A1: tags and branches with hex names are written @refs/tags/<name> and @refs/heads/<name>", () => {
  const MSG = /a hex ref must be the full 40-character commit sha; for a tag or branch with that name write @refs\/tags\/<name> or @refs\/heads\/<name>/;

  it.each([`github:o/r@${SHA}0`, `github:o/r@${SHA}${SHA.slice(0, 24)}`, "github:o/r@deadbeef", "github:o/r@abcdef0"])("refuses %s", (s) => {
    expect(() => parseSource(s)).toThrow(MSG);
  });

  it.each(["refs/tags/deadbeef", "refs/heads/1a2b3c4", "refs/tags/v1.2.0", "refs/heads/feature/x"])("accepts @%s and never reads it as a pin", (ref) => {
    const p = parseSource(`github:o/r/x@${ref}`);
    expect(p).toMatchObject({ ref });
    expect(isCommitSha(ref)).toBe(false);
    expect(formatSource(p)).toBe(`github:o/r/x@${ref}`);
  });

  it.each(["refs/tags/", "refs/tags/-x", "refs/tags/a..b", "refs/tags/x.lock", "refs/remotes/origin/x", "refs/tags/x y"])("refuses the malformed %s", (ref) => {
    expect(() => parseSource(`github:o/r/x@${ref}`)).toThrow();
  });

  it("fetches a tag named like a short sha by its full ref, at the tag's commit", () => {
    makeRepo("acme/skills", (w) => {
      writeSkill(path.join(w, "rn"), "rn", "first");
      git("-C", w, "add", "-A");
      git("-C", w, "commit", "--quiet", "-m", "first");
      git("-C", w, "tag", "deadbeef");
      git("-C", w, "branch", "1a2b3c4");
      writeSkill(path.join(w, "rn"), "rn", "second");
    });
    routeHosts(ALL_HOSTS);
    for (const ref of ["refs/tags/deadbeef", "refs/heads/1a2b3c4"]) {
      const f = fetchSource(parseSource(`github:acme/skills//rn@${ref}`));
      try {
        expect(fs.readFileSync(path.join(f.dir, "SKILL.md"), "utf8")).toContain("first");
        expect(f.resolved).toMatch(/^github:acme\/skills\/rn@[0-9a-f]{40}$/);
      } finally {
        f.cleanup();
      }
    }
    const calls = exec.mock.calls.map((c) => withoutHardening(c[1] as string[]).join(" "));
    expect(calls.some((c) => c.includes("fetch --depth 1 --quiet origin refs/tags/deadbeef"))).toBe(true);
    expect(calls.some((c) => c.includes("--branch refs/"))).toBe(false);
  });

  it("add records the full ref and the lock pins the commit; sync reinstalls it", () => {
    makeRepo("acme/skills", (w) => {
      writeSkill(path.join(w, "rn"), "rn", "first");
      git("-C", w, "add", "-A");
      git("-C", w, "commit", "--quiet", "-m", "first");
      git("-C", w, "tag", "deadbeef");
      writeSkill(path.join(w, "rn"), "rn", "second");
    });
    routeHosts(ALL_HOSTS);
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    addSkill(ctx, "github:acme/skills/rn@refs/tags/deadbeef");
    expect(loadManifest(ctx)!.skills.rn.source).toBe("github:acme/skills/rn@refs/tags/deadbeef");
    expect(loadLock(ctx).skills.rn.resolved).toMatch(/^github:acme\/skills\/rn@[0-9a-f]{40}$/);
    fs.rmSync(path.join(proj, ".skillwharf"), { recursive: true });
    fs.rmSync(path.join(proj, ".claude"), { recursive: true });
    expect(syncSkills(ctx).fetched).toEqual(["rn"]);
    expect(fs.readFileSync(path.join(storePath(ctx, "rn"), "SKILL.md"), "utf8")).toContain("first");
  });

  it("a 0.1.x manifest pinned to a hex-named tag makes sync say which skill and what to write, with no git call", () => {
    fs.copyFileSync(path.join(here, "fixtures", "v0.1", "hex-ref-manifest.json"), path.join(proj, "skillwharf.json"));
    exec.mockClear();
    expect(() => syncSkills(ctx)).toThrow(/Skill "tagged": .*a hex ref must be the full 40-character commit sha; for a tag or branch with that name write @refs\/tags\/<name> or @refs\/heads\/<name>/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("update names the skill too", () => {
    fs.copyFileSync(path.join(here, "fixtures", "v0.1", "hex-ref-manifest.json"), path.join(proj, "skillwharf.json"));
    expect(() => updateSkills(ctx, ["tagged"])).toThrow(/Skill "tagged": .*a hex ref must be/);
  });
});

describe("Round A U4: the child's .gitmodules gets the parent's symlink refusal", () => {
  it("a symlinked .gitmodules in a submodule is not read", () => {
    const child = path.join(base, "child-tree");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(base, "elsewhere"), '[submodule "x"]\n\tpath = inner\n\turl = https://example.invalid/x.git\n');
    fs.symlinkSync(path.join(base, "elsewhere"), path.join(child, ".gitmodules"));
    const run = vi.fn(() => "submodule.x.path\ninner\0submodule.x.url\nhttps://example.invalid/x.git\0");
    expect(innerRepository(child, "inner", run)).toBe("");
    expect(run).not.toHaveBeenCalled();
  });

  it("a regular .gitmodules still names the inner repository", () => {
    const child = path.join(base, "child-tree");
    fs.mkdirSync(child);
    fs.writeFileSync(path.join(child, ".gitmodules"), "x");
    const run = vi.fn(() => "submodule.x.path\ninner\0submodule.x.url\nhttps://example.invalid/x.git\0");
    expect(innerRepository(child, "inner", run)).toBe(", https://example.invalid/x.git");
  });
});

describe("Round A U3: a link in a submodule that leaves the submodule is dropped", () => {
  it("is reported and not followed into the parent's files", () => {
    const childSha = makeRepo("team/child", (w) => {
      writeSkill(w, "cs");
      fs.symlinkSync("../parent-secret.txt", path.join(w, "up.txt"));
    });
    makeRepo("team/parent", (w) => {
      addGitlink(w, "vendor/child", childSha);
      writeGitmodules(w, [["vendor/child", "../child.git"]]);
      fs.writeFileSync(path.join(w, "vendor", "parent-secret.txt"), "parent file");
    });
    routeHosts(ALL_HOSTS);
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    const [added] = addSkill(ctx, "git+https://git.acme.test/team/parent.git//vendor/child");
    expect(added.skippedSymlinks).toEqual(["up.txt"]);
    expect(fs.existsSync(path.join(storePath(ctx, "cs"), "up.txt"))).toBe(false);
  });
});

describe("Round A D3/U1/U2/D6: every git call carries the same hardening", () => {
  beforeEach(() => {
    allowProtocolsForTests([]);
    exec.mockImplementation((() => Buffer.from("")) as never);
  });

  it("starts with the five -c settings: no hooks, no redirects, no LFS filter", () => {
    fetchSource(parseSource(`github:acme/skills@${SHA}`)).cleanup();
    fetchSource(parseSource("github:acme/skills")).cleanup();
    const calls = exec.mock.calls.filter((c) => c[0] === "git").map((c) => c[1] as string[]);
    expect(calls.length).toBeGreaterThan(5);
    for (const args of calls) {
      expect(args.slice(0, 12)).toEqual([
        "-c", `core.hooksPath=${os.devNull}`,
        "-c", "http.followRedirects=false",
        "-c", "filter.lfs.smudge=",
        "-c", "filter.lfs.process=",
        "-c", "filter.lfs.required=false",
        "-c", "core.askPass=",
      ]);
    }
  });

  it("sets GIT_LFS_SKIP_SMUDGE=1 and passes none of the inherited repository variables", () => {
    process.env.GIT_DIR = "/somewhere/.git";
    process.env.GIT_WORK_TREE = "/somewhere";
    fetchSource(parseSource("github:acme/skills")).cleanup();
    for (const o of gitOptions()) {
      const env = o.env as Record<string, string>;
      expect(env.GIT_LFS_SKIP_SMUDGE).toBe("1");
      expect(env).not.toHaveProperty("GIT_DIR");
      expect(env).not.toHaveProperty("GIT_WORK_TREE");
    }
  });

  it("an ssh failure about the host key says skillwharf cannot ask, and how to trust the host", () => {
    exec.mockImplementation((() => {
      throw Object.assign(new Error("Command failed"), {
        stderr: Buffer.from("No ED25519 host key is known for git.acme.test and you have requested strict checking.\nHost key verification failed.\nfatal: Could not read from remote repository.\n"),
      });
    }) as never);
    expect(() => fetchSource(parseSource("git+ssh://git@git.acme.test/team/skills.git"))).toThrow(
      /skillwharf runs git without a terminal, so ssh cannot ask.*connect once with ssh/s,
    );
  });

  it("a call whose deadline has passed is refused without running git", () => {
    exec.mockClear();
    expect(() => runGit(["status"], { url: "https://git.acme.test/x.git", deadline: Date.now() - 1 })).toThrow(/time limit/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("a call never gets more time than is left before the deadline", () => {
    runGit(["status"], { url: "https://git.acme.test/x.git", timeoutMs: 120_000, deadline: Date.now() + 3000 });
    const timeout = gitOptions()[0].timeout as number;
    expect(timeout).toBeLessThanOrEqual(3000);
    expect(timeout).toBeGreaterThan(0);
  });
});

describe("Round A: the built command line runs git the way SECURITY.md says", () => {
  const repoRoot = path.resolve(here, "..");
  beforeAll(ensureBuilt, 180_000);

  it.skipIf(process.platform === "win32")("a fake git on PATH sees the protocol allowlist, no prompts and the hardening settings", () => {
    const bin = path.join(base, "bin");
    const dump = path.join(base, "dump.txt");
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, "git"),
      `#!/bin/sh\n{ echo "ARGV:$*"; echo "PGID:$(ps -o pgid= -p $$ | tr -d ' ')"; env; } >> '${dump}'\nexit 1\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    // no test allowance exists in this process: it is the shipped code with the user's environment
    const env = {
      ...process.env,
      SKILLWHARF_HOME: home,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GIT_DIR: "/somewhere/.git",
      GIT_ASKPASS: "/somewhere/askpass",
    } as Record<string, string>;
    delete env.GIT_ALLOW_PROTOCOL;
    const r = spawnSync(process.execPath, [path.join(repoRoot, "dist", "cli.js"), "add", "github:acme/skills"], { cwd: proj, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    const text = fs.readFileSync(dump, "utf8");
    // git runs in a process group of its own, not ours
    const ourGroup = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString().trim();
    const gitGroup = (text.split("\n").find((l) => l.startsWith("PGID:")) ?? "").slice(5);
    expect(gitGroup).not.toBe("");
    expect(gitGroup).not.toBe(ourGroup);
    expect(text.split("\n")).toContain("GIT_ASKPASS=");
    expect(text.split("\n")).toContain("SSH_ASKPASS_REQUIRE=never");
    expect(text).toContain("core.askPass=");
    const argv = (text.split("\n").find((l) => l.startsWith("ARGV:")) ?? "").slice(5);
    for (const s of ["core.hooksPath=", "http.followRedirects=false", "filter.lfs.smudge=", "filter.lfs.process=", "filter.lfs.required=false", "clone"]) {
      expect(argv).toContain(s);
    }
    expect(argv).toContain("-- https://github.com/acme/skills.git");
    const lines = text.split("\n");
    expect(lines).toContain("GIT_ALLOW_PROTOCOL=https:ssh");
    expect(lines).toContain("GIT_TERMINAL_PROMPT=0");
    expect(lines).toContain("GIT_LFS_SKIP_SMUDGE=1");
    expect(lines.some((l) => l.startsWith("GIT_DIR="))).toBe(false);
  }, 60_000);

  it.skipIf(process.platform === "win32")("the pinned path and --allow-askpass: same protocol list, user's askpass passed through", () => {
    const bin = path.join(base, "bin");
    const dump = path.join(base, "dump.txt");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n{ echo "ARGV:$*"; env; } >> '${dump}'\nexit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: { a: { source: "github:acme/skills/a" } } }));
    fs.writeFileSync(
      path.join(proj, "skillwharf.lock.json"),
      JSON.stringify({ version: 1, skills: { a: { source: "github:acme/skills/a", resolved: `github:acme/skills/a@${SHA}`, integrity: "sha256-x", installedAt: "x" } } }),
    );
    const env = { ...process.env, SKILLWHARF_HOME: home, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GIT_ASKPASS: "/somewhere/askpass" } as Record<string, string>;
    delete env.GIT_ALLOW_PROTOCOL;
    const r = spawnSync(process.execPath, [path.join(repoRoot, "dist", "cli.js"), "--allow-askpass", "sync"], { cwd: proj, env, encoding: "utf8" });
    expect(r.status).toBe(1);
    const text = fs.readFileSync(dump, "utf8");
    expect(text).toContain("ARGV:-c");
    expect(text).toContain(" init --quiet ");
    expect(text.split("\n")).toContain("GIT_ALLOW_PROTOCOL=https:ssh");
    expect(text.split("\n")).toContain("GIT_ASKPASS=/somewhere/askpass");
    expect(text).not.toContain("core.askPass=");
  }, 60_000);

  it("--git-deadline takes a positive number of seconds", () => {
    for (const bad of ["abc", "0", "-3"]) {
      const r = spawnSync(process.execPath, [path.join(repoRoot, "dist", "cli.js"), "--git-deadline", bad, "sync"], {
        cwd: proj,
        env: { ...process.env, SKILLWHARF_HOME: home },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/--git-deadline takes a positive number of seconds/);
    }
  });
});

// ------------------------------------------------------------------ Round B
describe("Round B B1: a link is resolved as text, and the file system is asked only about paths inside the clone", () => {
  let root: string;
  const link = (name: string, text: string) => fs.symlinkSync(text, path.join(root, name));

  beforeEach(() => {
    root = path.join(base, "clone");
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "a", "b", "file.txt"), "inside");
    link("ok", "a/b");
    link("hop1", "hop2");
    link("hop2", "a/b/file.txt");
    link("up", "../outside");
    link("deep-up", "a/../../outside");
    link("abs", "/etc/hostname");
    link("unc", "//host/share/x");
    link("backslash-unc", "\\\\host\\share\\x");
    link("drive", "C:/Windows/win.ini");
    link("loop1", "loop2");
    link("loop2", "loop1");
    link("through-dir", "ok/file.txt");
    link("dotdot-after-link", "ok/../b/file.txt"); // ok -> a/b, so ok/.. is a, as the file system reads it
  });

  it.each([
    ["ok", path.join("a", "b")],
    ["hop1", path.join("a", "b", "file.txt")],
    ["through-dir", path.join("a", "b", "file.txt")],
    ["dotdot-after-link", path.join("a", "b", "file.txt")],
  ])("resolveInside follows %s to %s", (name, want) => {
    expect(resolveInside(root, path.join(root, name))).toBe(fs.realpathSync.native(path.join(root, want)));
  });

  it.each(["up", "deep-up", "abs", "unc", "backslash-unc", "drive", "loop1"])("resolveInside refuses %s without touching the file system outside", (name) => {
    expect(resolveInside(root, path.join(root, name))).toBeUndefined();
  });

  it("resolveInside refuses a chain longer than its bound", () => {
    for (let i = 0; i < 40; i++) link(`c${i}`, `c${i + 1}`);
    link("c40", "a/b");
    expect(resolveInside(root, path.join(root, "c0"))).toBeUndefined();
    expect(resolveInside(root, path.join(root, "c20"))).toBe(fs.realpathSync.native(path.join(root, "a", "b")));
  });

  describe("no call that would open a path outside the clone", () => {
    const outsideCalls: string[] = [];
    let realRoot: string;
    const watch = () => {
      realRoot = fs.realpathSync.native(root);
      // What may be asked about: the clone (as given or as it really is) and the folder the copy goes to.
      // `//host/share/x`, `/etc/x` and `../../outside` (next to the clone) must never appear.
      const lstat = fs.lstatSync;
      const readlink = fs.readlinkSync;
      // Would asking the file system about `p` make it follow a link that names an absolute or UNC
      // path, or leaves the clone? (The path passed in is inside the clone either way: it is the
      // link on the way that does the damage.)
      const leaks = (p: string): boolean => {
        const abs = path.resolve(p);
        const rel = [realRoot, root].map((r) => path.relative(r, abs)).find((r) => !r.startsWith("..") && !path.isAbsolute(r));
        if (rel === undefined) return !(isInside(path.join(base, "out"), abs) || abs === path.dirname(root) || abs === fs.realpathSync.native(path.dirname(root)));
        let cur = realRoot;
        for (const part of rel.split(path.sep).filter(Boolean)) {
          cur = path.join(cur, part);
          let st: fs.Stats;
          try {
            st = lstat(cur);
          } catch {
            return false;
          }
          if (st.isSymbolicLink()) {
            const text = readlink(cur);
            if (isAbsoluteLinkText(text) || !isInside(realRoot, path.resolve(path.dirname(cur), text))) return true;
          }
        }
        return false;
      };
      const check = (p: unknown) => {
        if (typeof p === "string" && leaks(p)) outsideCalls.push(p);
      };
      const native = fs.realpathSync.native;
      const plain = fs.realpathSync;
      const stat = fs.statSync;
      vi.spyOn(fs.realpathSync, "native").mockImplementation(((p: string, o?: never) => (check(p), native(p, o))) as never);
      vi.spyOn(fs, "statSync").mockImplementation(((p: string, o?: never) => (check(p), stat(p, o))) as never);
      vi.spyOn(fs, "realpathSync").mockImplementation(Object.assign(((p: string, o?: never) => (check(p), plain(p, o))) as never, { native: fs.realpathSync.native }));
    };
    beforeEach(() => {
      outsideCalls.length = 0;
      writeSkill(path.join(root, "skill"), "s");
      for (const [name, text] of [
        ["l-abs", "/etc/hostname"],
        ["l-unc", "//host/share/x"],
        ["l-up", "../../outside"],
        ["l-ok", "../a/b/file.txt"],
      ]) {
        fs.symlinkSync(text, path.join(root, "skill", name));
      }
      watch();
    });
    afterEach(() => vi.restoreAllMocks());

    it("copyResolvingLinks drops the links that leave and copies the one that stays", () => {
      const { dropped } = copyResolvingLinks(path.join(root, "skill"), path.join(base, "out"), { root });
      expect(dropped).toEqual(["l-abs", "l-unc", "l-up"]);
      expect(fs.readFileSync(path.join(base, "out", "l-ok"), "utf8")).toBe("inside");
      expect(outsideCalls).toEqual([]);
    });

    it("discoverSkills does not follow a folder link out of the clone, or open it", () => {
      for (const [name, text] of [["d-unc", "//host/share/dir"], ["d-abs", "/etc"], ["d-up", "../../outside"]]) fs.symlinkSync(text, path.join(root, name));
      expect(discoverSkills(root, { root }).map((d) => path.relative(root, d))).toEqual(["skill"]);
      expect(outsideCalls).toEqual([]);
    });

    it("isSkillDirIn does not open the target of a SKILL.md link that leaves the clone", () => {
      for (const text of ["//host/share/SKILL.md", "/etc/SKILL.md", "../../outside/SKILL.md"]) {
        const dir = path.join(root, `s-${text.length}`);
        fs.mkdirSync(dir);
        fs.symlinkSync(text, path.join(dir, "SKILL.md"));
        expect(isSkillDirIn(dir, root)).toBe(false);
      }
      expect(outsideCalls).toEqual([]);
    });
  });

  describe("the project side: an agent folder entry that is a link is not opened when its text names another machine or an absolute path", () => {
    it("linkStatus says foreign for an absolute or UNC link without resolving it", () => {
      const store = path.join(proj, ".skillwharf", "skills", "alpha");
      fs.mkdirSync(store, { recursive: true });
      fs.writeFileSync(path.join(store, "SKILL.md"), "---\nname: alpha\ndescription: d\n---\n");
      fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: { alpha: { source: "path:./x" } } }));
      const target = path.join(proj, ".claude", "skills", "alpha");
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const m = JSON.parse(read(path.join(proj, "skillwharf.json"))) as Manifest;
      for (const text of ["//host/share/alpha", "/etc", "\\\\host\\share\\alpha"]) {
        fs.rmSync(target, { force: true });
        fs.symlinkSync(text, target);
        const seen: string[] = [];
        const plain = fs.realpathSync;
        const spy = vi.spyOn(fs, "realpathSync").mockImplementation(Object.assign(((p: string, o?: never) => (seen.push(String(p)), plain(p, o))) as never, { native: plain.native }));
        expect(linkStatus(ctx, m, "claude", "alpha", store)).toBe("foreign");
        spy.mockRestore();
        expect(seen.filter((p) => p === target || p.includes("host"))).toEqual([]);
      }
    });
  });
});

describe("Round B B3: the lock is fetched from the manifest's URL, and a lock for another URL is refused before any git call", () => {
  const lockFor = (source: string, resolved: string): void => {
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: { a: { source } } }));
    fs.writeFileSync(
      path.join(proj, "skillwharf.lock.json"),
      JSON.stringify({ version: 1, skills: { a: { source, resolved, integrity: "sha256-x", installedAt: "x" } } }),
    );
  };

  it.each([
    ["the .git suffix", "git+https://git.acme.test/team/skills.git//a", `git+https://git.acme.test/team/skills//a@${SHA}`],
    ["the .git suffix the other way", "git+https://git.acme.test/team/skills//a", `git+https://git.acme.test/team/skills.git//a@${SHA}`],
    ["the ssh user", "git+ssh://git@git.acme.test/team/skills.git//a", `git+ssh://git.acme.test/team/skills.git//a@${SHA}`],
  ])("differing in %s is a mismatch: zero git calls, and the manifest/lock pair is named", (_what, source, resolved) => {
    lockFor(source, resolved);
    exec.mockClear();
    expect(() => syncSkills(ctx)).toThrow(/does not match the manifest source/);
    expect(exec).not.toHaveBeenCalled();
  });

  it("the same URL spelled the same way is fetched, at the lock's commit, from the manifest's spelling", () => {
    const sha = makeRepo("team/skills", (w) => writeSkill(path.join(w, "a"), "a"));
    routeHosts(ALL_HOSTS);
    const source = "git+https://git.acme.test/team/skills.git//a";
    lockFor(source, `${source}@${sha}`);
    const integrity = integrityAt(`${source}@${sha}`);
    lockFor(source, `${source}@${sha}`);
    const lock = JSON.parse(read(path.join(proj, "skillwharf.lock.json"))) as Lockfile;
    lock.skills.a.integrity = integrity;
    writeLock(lock);
    exec.mockClear();
    expect(syncSkills(ctx).fetched).toEqual(["a"]);
    const urls = exec.mock.calls.map((c) => (c[1] as string[]).join(" ")).join("\n");
    expect(urls).toContain("https://git.acme.test/team/skills.git");
    expect(urls).not.toContain("team/skills ");
  });
});

describe("Round B B5: filter drivers, ident and eol conversion a repository names do not run", () => {
  const FILTER_REPO = (w: string) => {
    writeSkill(path.join(w, "rn"), "rn");
    fs.writeFileSync(path.join(w, ".gitattributes"), "*.txt filter=x ident text eol=crlf\n");
    fs.writeFileSync(path.join(w, "rn", "a.txt"), "hello $Id$\nline2\n");
  };
  let marker: string;

  beforeEach(() => {
    marker = path.join(base, "filter-ran");
    const script = path.join(base, "smudge.sh");
    fs.writeFileSync(script, `#!/bin/sh\ntouch '${marker}'\nsed 's/^/FILTERED:/'\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(base, "gitconfig"), `[filter "x"]\n\tsmudge = ${script}\n\tclean = cat\n\trequired = true\n`);
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_CONFIG_GLOBAL = path.join(base, "gitconfig");
  });

  it.each([
    ["a clone", (_sha: string) => "github:acme/skills//rn"],
    ["a pinned fetch", (sha: string) => `github:acme/skills//rn@${sha}`],
  ])("%s checks files out as committed", (_name, source) => {
    const sha = makeRepo("acme/skills", FILTER_REPO);
    routeHosts(ALL_HOSTS);
    // control: with this configuration a plain clone runs the filter, expands $Id$ and converts line endings
    git("clone", "--quiet", path.join(base, "srv", "acme", "skills.git"), path.join(base, "control"));
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(path.join(base, "control", "rn", "a.txt"), "utf8")).toMatch(/^FILTERED:hello \$Id: [0-9a-f]{40} \$\r\n/);
    fs.rmSync(marker);
    const f = fetchSource(parseSource(source(sha)));
    try {
      expect(fs.readFileSync(path.join(f.dir, "a.txt"), "utf8")).toBe("hello $Id$\nline2\n");
    } finally {
      f.cleanup();
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("a submodule is checked out the same way", () => {
    const childSha = makeRepo("team/child", (w) => {
      writeSkill(w, "cs");
      fs.writeFileSync(path.join(w, ".gitattributes"), "*.txt filter=x\n");
      fs.writeFileSync(path.join(w, "a.txt"), "plain\n");
    });
    makeRepo("team/parent", (w) => {
      addGitlink(w, "vendor/child", childSha);
      writeGitmodules(w, [["vendor/child", "../child.git"]]);
    });
    routeHosts(ALL_HOSTS);
    fs.rmSync(marker, { force: true });
    const f = fetchSource(parseSource("git+https://git.acme.test/team/parent.git//vendor/child"));
    try {
      expect(fs.readFileSync(path.join(f.dir, "a.txt"), "utf8")).toBe("plain\n");
    } finally {
      f.cleanup();
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("the attributes file is written before checkout (stubbed git)", () => {
    allowProtocolsForTests([]);
    let seen = "";
    exec.mockImplementation(((file: string, args: string[]) => {
      const a = withoutHardening(args);
      if (a.includes("checkout")) {
        const dir = a[a.indexOf("-C") + 1];
        seen = fs.readFileSync(path.join(dir, ".git", "info", "attributes"), "utf8");
      }
      return Buffer.from("");
    }) as never);
    fetchSource(parseSource("github:acme/skills")).cleanup();
    expect(seen).toBe("* -filter -ident -text -eol\n");
  });
});

describe("Round B B4/A3: git runs under a supervisor", () => {
  const repoRoot = path.resolve(here, "..");
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const waitFor = async (what: () => boolean, ms = 8000) => {
    const end = Date.now() + ms;
    while (Date.now() < end && !what()) await new Promise((r) => setTimeout(r, 50));
    return what();
  };
  function fakeGit(script: string): string {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, "git"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
    return `${bin}${path.delimiter}${process.env.PATH}`;
  }

  it.skipIf(process.platform === "win32")("git is in a process group of its own", () => {
    const out = path.join(base, "pgid");
    process.env.PATH = fakeGit(`ps -o pgid= -p $$ > '${out}'\nexit 1`);
    expect(() => runGit(["status"], { url: "https://git.acme.test/x.git" })).toThrow();
    const ours = execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)]).toString().trim();
    expect(fs.readFileSync(out, "utf8").trim()).not.toBe(ours);
  });

  it("the supervisor knows how to end a process tree on Windows", () => {
    expect(SUPERVISOR_SOURCE).toContain('"taskkill", ["/T", "/F", "/PID"');
    expect(SUPERVISOR_SOURCE).toContain("windowsHide: true");
  });

  it("killProcessTree ends a group on POSIX and runs taskkill on Windows", () => {
    const kill = vi.fn();
    const run = vi.fn();
    killProcessTree(4242, { platform: "linux", kill, run });
    expect(kill).toHaveBeenCalledWith(-4242, "SIGKILL");
    killProcessTree(4242, { platform: "win32", kill, run });
    expect(run).toHaveBeenCalledWith("taskkill", ["/T", "/F", "/PID", "4242"], expect.objectContaining({ windowsHide: true }));
  });

  describe.skipIf(process.platform === "win32")("an interrupt", () => {
    beforeAll(ensureBuilt, 180_000);
    function startCli(args: string[]) {
      const pidFile = path.join(base, "git.pid");
      const tmp = path.join(base, "tmp");
      fs.mkdirSync(tmp, { recursive: true });
      fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
      const env = { ...process.env, SKILLWHARF_HOME: home, TMPDIR: tmp, PATH: fakeGit(`echo $$ > '${pidFile}'\nexec sleep 60`) };
      // its own group, as a terminal's foreground job is: Ctrl-C reaches everything in it
      const cli = spawn(process.execPath, [path.join(repoRoot, "dist", "cli.js"), ...args], { cwd: proj, env, detached: true, stdio: "ignore" });
      const exited = new Promise<number | null>((resolve) => cli.on("exit", (code) => resolve(code)));
      return { cli, pidFile, tmp, exited };
    }

    it("Ctrl-C ends git with skillwharf, removes the temporary clone and exits 130", async () => {
      const { cli, pidFile, tmp, exited } = startCli(["add", "github:acme/skills"]);
      expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "")).toBe(true);
      const gitPid = Number(fs.readFileSync(pidFile, "utf8"));
      process.kill(-(cli.pid as number), "SIGINT");
      expect(await exited).toBe(130);
      expect(await waitFor(() => !alive(gitPid), 5000)).toBe(true);
      expect(fs.readdirSync(tmp)).toEqual([]);
    }, 60_000);

    it("a SIGTERM to skillwharf alone still ends git", async () => {
      const { cli, pidFile, exited } = startCli(["add", "github:acme/skills"]);
      expect(await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").trim() !== "")).toBe(true);
      const gitPid = Number(fs.readFileSync(pidFile, "utf8"));
      process.kill(cli.pid as number, "SIGTERM");
      await exited;
      expect(await waitFor(() => !alive(gitPid), 8000)).toBe(true);
    }, 60_000);
  });

  it.skipIf(process.platform === "win32")("one deadline covers every fetch of a command (sync of three skills)", async () => {
    makeRepo("acme/skills", (w) => {
      for (const n of ["s1", "s2", "s3"]) writeSkill(path.join(w, n), n);
    });
    routeHosts(ALL_HOSTS);
    const realGit = execFileSync("sh", ["-c", "command -v git"]).toString().trim();
    process.env.PATH = fakeGit(`sleep 0.8\nexec '${realGit}' "$@"`);
    writeManifest({
      version: 1,
      agents: ["claude"],
      skills: Object.fromEntries(["s1", "s2", "s3"].map((n) => [n, { source: `github:acme/skills/${n}` }])),
    });
    const started = Date.now();
    expect(() => syncSkills(ctx, { gitTimeoutMs: 5000, gitDeadlineMs: 3000 })).toThrow(/time limit/);
    expect(Date.now() - started).toBeLessThan(9000);
    // without the limit the same sync succeeds (so the failure above is the deadline, not the fake git)
    expect(syncSkills(ctx, { gitTimeoutMs: 5000, gitDeadlineMs: 120_000 }).fetched).toEqual(["s1", "s2", "s3"]);
  }, 60_000);

  it("the default overall limit is four times --git-timeout", () => {
    expect(defaultDeadlineMs(120_000)).toBe(480_000);
    expect(defaultDeadlineMs(1000)).toBe(4000);
    expect(defaultDeadlineMs(undefined)).toBe(480_000);
  });
});
