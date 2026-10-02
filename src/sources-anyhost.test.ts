import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLock, loadManifest, makeContext, saveManifest } from "./manifest.js";
import { syncSkills } from "./ops.js";
import { formatSource, parseSource, sourceKey } from "./source.js";
import type { Context, Lockfile, Manifest } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

let base: string, home: string, proj: string, ctx: Context;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skwf-any-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  for (const d of [home, proj]) fs.mkdirSync(d, { recursive: true });
  ctx = makeContext({ cwd: proj, home });
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

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
