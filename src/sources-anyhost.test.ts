import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowProtocolsForTests, setGitExecForTests } from "./git.js";
import { hashDir } from "./fs.js";
import { loadLock, loadManifest, makeContext, saveManifest, storePath } from "./manifest.js";
import { addSkill, syncSkills, updateSkills } from "./ops.js";
import { fetchSource, formatSource, parseSource, sourceKey } from "./source.js";
import type { Context, Lockfile, Manifest } from "./types.js";

// Every git call goes through runGit; this wrapper records the calls and runs
// the real thing unless a test swaps the implementation.
const realExec = { fn: execFileSync };
const exec = vi.fn<typeof execFileSync>(execFileSync);

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

function git(...args: string[]): string {
  return realExec
    .fn("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
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

/** The recorded git invocations (argument lists only). */
function gitCalls(): string[][] {
  return exec.mock.calls.filter((c) => c[0] === "git").map((c) => c[1] as string[]);
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
      expect(gitCalls()[0]).toEqual(["clone", "--depth", "1", "--quiet", "--", url, expect.stringContaining("skillwharf-")]);
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
      "clone", "--depth", "1", "--quiet", "--branch", head, "--", "https://github.com/acme/skills.git", expect.any(String),
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
      ["-C", expect.any(String), "remote", "add", "origin", url],
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

    it("leaves the user's ssh command and credential settings alone", () => {
      process.env.GIT_SSH_COMMAND = "ssh -i /somewhere/key";
      process.env.GIT_ASKPASS = "/somewhere/askpass";
      process.env.GIT_CONFIG_GLOBAL = "/somewhere/gitconfig";
      fetchSource(parseSource("github:acme/skills")).cleanup();
      for (const o of gitOptions()) {
        const env = o.env as Record<string, string>;
        expect(env.GIT_SSH_COMMAND).toBe("ssh -i /somewhere/key");
        expect(env.GIT_ASKPASS).toBe("/somewhere/askpass");
        expect(env.GIT_CONFIG_GLOBAL).toBe("/somewhere/gitconfig");
      }
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

  it("the product never offers the file transport: with no test allowance a rewritten fetch has only https and ssh", () => {
    allowProtocolsForTests([]);
    exec.mockImplementation((() => Buffer.from("")) as never);
    fetchSource(parseSource("github:acme/skills")).cleanup();
    for (const o of gitOptions()) expect((o.env as Record<string, string>).GIT_ALLOW_PROTOCOL).not.toMatch(/file|ext|git(?!$)/);
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

    it("is killed at the timeout even when it left a child holding the pipes", () => {
      fakeGit("sleep 20 &\nsleep 30");
      const started = Date.now();
      expect(() => fetchSource(parseSource("github:acme/skills"), { timeoutMs: 1000 })).toThrow(/timed out/);
      expect(Date.now() - started).toBeLessThan(10_000);
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
