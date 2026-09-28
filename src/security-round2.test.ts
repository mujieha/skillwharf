import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkStatus } from "./agents.js";
import { hashDir } from "./fs.js";
import { DEFAULT_REGISTRY, loadLock, makeContext, saveLock, storePath } from "./manifest.js";
import { addSkill, removeSkill, syncSkills, updateSkills } from "./ops.js";
import { loadRegistry } from "./registry.js";
import { fetchSource, parseSource } from "./source.js";
import type { Context, Lockfile, Manifest } from "./types.js";
import * as validate from "./validate.js";

let base: string, home: string, proj: string, outside: string, ctx: Context;

function writeSkill(dir: string, name: string, body = "body") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
}

function writeManifest(m: Manifest) {
  fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify(m));
}

function writeLock(l: Lockfile) {
  fs.writeFileSync(path.join(proj, "skillwharf.lock.json"), JSON.stringify(l));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-r2-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  outside = path.join(base, "outside");
  for (const d of [home, proj, outside]) fs.mkdirSync(d, { recursive: true });
  ctx = makeContext({ cwd: proj, home });
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ F1
describe("F1: never writes or deletes through a symlinked store or agent directory", () => {
  beforeEach(() => {
    // victim folder outside the project, named like the skill
    fs.mkdirSync(path.join(outside, "myapp"), { recursive: true });
    fs.writeFileSync(path.join(outside, "myapp", "important.txt"), "precious");
    writeSkill(path.join(proj, "payload", "myapp"), "myapp");
    writeManifest({ version: 1, agents: ["claude"], skills: { myapp: { source: `path:${path.join(proj, "payload", "myapp")}` } } });
  });

  it("update refuses a store directory that is a symlink out of the project", () => {
    fs.mkdirSync(path.join(proj, ".skillwharf"));
    fs.symlinkSync(outside, path.join(proj, ".skillwharf", "skills"));
    expect(() => updateSkills(ctx, ["myapp"])).toThrow(/symlink/);
    expect(fs.readFileSync(path.join(outside, "myapp", "important.txt"), "utf8")).toBe("precious");
    expect(fs.existsSync(path.join(outside, "myapp", "SKILL.md"))).toBe(false);
  });

  it("remove refuses a store directory that is a symlink out of the project", () => {
    fs.mkdirSync(path.join(proj, ".skillwharf"));
    fs.symlinkSync(outside, path.join(proj, ".skillwharf", "skills"));
    expect(() => removeSkill(ctx, "myapp")).toThrow(/symlink/);
    expect(fs.readFileSync(path.join(outside, "myapp", "important.txt"), "utf8")).toBe("precious");
  });

  it("sync refuses when .skillwharf itself is a symlink", () => {
    fs.mkdirSync(path.join(outside, "skills"));
    fs.symlinkSync(outside, path.join(proj, ".skillwharf"));
    expect(() => syncSkills(ctx)).toThrow(/symlink/);
    expect(fs.existsSync(path.join(outside, "skills", "myapp"))).toBe(false);
  });

  it("add refuses to link into an agent directory that is a symlink out of the project", () => {
    fs.symlinkSync(outside, path.join(proj, ".claude"));
    expect(() => addSkill(ctx, path.join(proj, "payload", "myapp"))).toThrow(/symlink/);
    expect(fs.existsSync(path.join(outside, "skills"))).toBe(false);
  });

  it("refuses to write the lockfile through a symlink", () => {
    const victim = path.join(outside, "rc");
    fs.writeFileSync(victim, "keep");
    fs.symlinkSync(victim, path.join(proj, "skillwharf.lock.json"));
    expect(() => saveLock(ctx, { version: 1, skills: {} })).toThrow(/symlink/);
    expect(fs.readFileSync(victim, "utf8")).toBe("keep");
  });
});

// ------------------------------------------------------------------ F2
describe("F2: a store entry that is itself a symlink is never treated as installed", () => {
  it("sync does not link a symlinked store entry into agent directories", () => {
    writeSkill(path.join(outside, "secrets"), "notes");
    fs.mkdirSync(path.join(proj, ".skillwharf", "skills"), { recursive: true });
    fs.symlinkSync(path.join(outside, "secrets"), path.join(proj, ".skillwharf", "skills", "notes"));
    writeManifest({ version: 1, agents: ["claude"], skills: { notes: { source: "github:a/b" } } });
    expect(() => syncSkills(ctx)).toThrow(/symlink/);
    expect(fs.existsSync(path.join(proj, ".claude", "skills", "notes"))).toBe(false);
  });

  it("linkStatus reports a link to a symlinked store entry as foreign", () => {
    writeSkill(path.join(outside, "secrets"), "notes");
    fs.mkdirSync(path.join(proj, ".skillwharf", "skills"), { recursive: true });
    fs.mkdirSync(path.join(proj, ".claude", "skills"), { recursive: true });
    const store = path.join(proj, ".skillwharf", "skills", "notes");
    fs.symlinkSync(path.join(outside, "secrets"), store);
    fs.symlinkSync("../../.skillwharf/skills/notes", path.join(proj, ".claude", "skills", "notes"));
    const m: Manifest = { version: 1, agents: ["claude"], skills: { notes: { source: "github:a/b" } } };
    expect(linkStatus(ctx, m, "claude", "notes", store)).toBe("foreign");
  });
});

// ------------------------------------------------------------------ F3
describe("F3: the lockfile pin is honoured exactly", () => {
  let gh: string, sha1: string, sha2: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    // A local "GitHub": https://github.com/<owner>/<repo>.git is rewritten to a
    // file:// bare repo for this test only, via git's own insteadOf config.
    gh = path.join(base, "gh");
    const work = path.join(base, "work");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
        stdio: ["ignore", "pipe", "pipe"],
      })
        .toString()
        .trim();
    git("init", "--quiet", work);
    writeSkill(path.join(work, "alpha"), "alpha", "first");
    git("-C", work, "add", "-A");
    git("-C", work, "commit", "--quiet", "-m", "one");
    sha1 = git("-C", work, "rev-parse", "HEAD");
    writeSkill(path.join(work, "alpha"), "alpha", "second");
    git("-C", work, "commit", "--quiet", "-am", "two");
    sha2 = git("-C", work, "rev-parse", "HEAD");
    fs.mkdirSync(path.join(gh, "acme"), { recursive: true });
    git("clone", "--quiet", "--bare", work, path.join(gh, "acme", "skills.git"));
    process.env.GIT_CONFIG_COUNT = "3";
    process.env.GIT_CONFIG_KEY_0 = `url.file://${gh}/.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
    process.env.GIT_CONFIG_KEY_1 = "uploadpack.allowAnySHA1InWant";
    process.env.GIT_CONFIG_VALUE_1 = "true";
    process.env.GIT_CONFIG_KEY_2 = "protocol.file.allow";
    process.env.GIT_CONFIG_VALUE_2 = "always";
    writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "github:acme/skills/alpha" } } });
  });
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("GIT_CONFIG_")) delete process.env[k];
    Object.assign(process.env, savedEnv);
  });

  function pinnedLock(sha: string, integrity: string): Lockfile {
    return {
      version: 1,
      skills: {
        alpha: { source: "github:acme/skills/alpha", resolved: `github:acme/skills/alpha@${sha}`, integrity, installedAt: "x" },
      },
    };
  }

  it("records the full 40-character commit sha", () => {
    const f = fetchSource(parseSource("github:acme/skills/alpha"));
    try {
      expect(f.resolved).toBe(`github:acme/skills/alpha@${sha2}`);
    } finally {
      f.cleanup();
    }
  });

  it("sync installs the pinned commit, not the branch head, and keeps the full pin", () => {
    const f = fetchSource(parseSource(`github:acme/skills/alpha@${sha1}`));
    const integrity = hashDir(f.dir);
    f.cleanup();
    writeLock(pinnedLock(sha1, integrity));
    syncSkills(ctx);
    expect(fs.readFileSync(path.join(storePath(ctx, "alpha"), "SKILL.md"), "utf8")).toContain("first");
    expect(loadLock(ctx).skills.alpha.resolved).toBe(`github:acme/skills/alpha@${sha1}`);
  });

  it("sync fails loudly when the pinned commit cannot be fetched", () => {
    const missing = "0123456789abcdef0123456789abcdef01234567";
    writeLock(pinnedLock(missing, "sha256-x"));
    const before = fs.readFileSync(path.join(proj, "skillwharf.lock.json"), "utf8");
    expect(() => syncSkills(ctx)).toThrow(/pinned/);
    expect(fs.readFileSync(path.join(proj, "skillwharf.lock.json"), "utf8")).toBe(before);
    expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
    // explicit opt-in falls back to the manifest source
    syncSkills(ctx, { allowUnpinned: true });
    expect(loadLock(ctx).skills.alpha.resolved).toBe(`github:acme/skills/alpha@${sha2}`);
  });

  it("sync refuses content whose hash differs from the lock integrity and leaves the lock untouched", () => {
    writeLock(pinnedLock(sha1, "sha256-THIS-IS-NOT-THE-HASH-OF-ANYTHING="));
    const before = fs.readFileSync(path.join(proj, "skillwharf.lock.json"), "utf8");
    expect(() => syncSkills(ctx)).toThrow(/integrity/);
    expect(fs.readFileSync(path.join(proj, "skillwharf.lock.json"), "utf8")).toBe(before);
    expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
  });

  it("sync refuses an abbreviated pin instead of falling back", () => {
    writeLock(pinnedLock(sha1.slice(0, 12), "sha256-x"));
    expect(() => syncSkills(ctx)).toThrow(/40/);
    expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
  });
});

// ------------------------------------------------------------------ F4
describe("F4: manifest and lock sources are validated", () => {
  it("lock resolved must match the manifest source (no local path smuggled into a github entry)", () => {
    writeSkill(path.join(outside, "skill"), "x");
    fs.writeFileSync(path.join(outside, "skill", "secret.txt"), "AWS_SECRET=abc");
    writeManifest({ version: 1, agents: ["claude"], skills: { pdf: { source: "github:anthropics/skills/skills/pdf" } } });
    writeLock({
      version: 1,
      skills: { pdf: { source: "github:anthropics/skills/skills/pdf", resolved: "../outside/skill", integrity: "x", installedAt: "x" } },
    });
    expect(() => syncSkills(ctx)).toThrow(/does not match/);
    expect(fs.existsSync(path.join(storePath(ctx, "pdf"), "secret.txt"))).toBe(false);
  });

  it("path sources from the manifest must resolve inside the project unless explicitly allowed", () => {
    writeSkill(path.join(outside, "skill"), "x");
    writeManifest({ version: 1, agents: ["claude"], skills: { x: { source: "path:../outside/skill" } } });
    expect(() => syncSkills(ctx)).toThrow(/outside the project/);
    expect(() => updateSkills(ctx)).toThrow(/outside the project/);
    expect(fs.existsSync(storePath(ctx, "x"))).toBe(false);
    syncSkills(ctx, { allowOutsidePaths: true });
    expect(fs.existsSync(path.join(storePath(ctx, "x"), "SKILL.md"))).toBe(true);
  });

  it("relative path sources resolve against the project root, not the working directory", () => {
    writeSkill(path.join(proj, "vendor", "alpha"), "alpha");
    writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "path:vendor/alpha" } } });
    expect(process.cwd()).not.toBe(proj);
    syncSkills(ctx);
    expect(fs.existsSync(path.join(storePath(ctx, "alpha"), "SKILL.md"))).toBe(true);
  });
});

// ------------------------------------------------------------------ F5
describe("F5: documentation examples are accepted by the code", () => {
  it("the README lockfile example pins a full commit sha", () => {
    const readme = fs.readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const m = readme.match(/"resolved": "github:[^"]*@([0-9a-f]+)"/);
    expect(m).not.toBeNull();
    expect(m![1]).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ------------------------------------------------------------------ F6
describe("F6: untrusted strings are sanitised before reaching the terminal", () => {
  it("sanitizeForTerminal strips C0, C1, DEL and bidi overrides", () => {
    const s = validate.sanitizeForTerminal("a\u001b[31mb\u009bc\u007fd‮e⁦f\u0007g\n");
    expect(s).toBe("a[31mbcdefg");
  });

  it("registry entries with a non-GitHub source or bidi/C1 characters are dropped or cleaned", async () => {
    const file = path.join(base, "index.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        skills: [
          { name: "ok", description: "fine‮gnp.exe\u009b2J", source: "github:a/b" },
          { name: "local", description: "x", source: "path:/etc" },
          { name: "rel", description: "x", source: "../secrets" },
        ],
      }),
    );
    const idx = await loadRegistry(file);
    expect(idx.skills.map((s) => s.name)).toEqual(["ok"]);
    expect(idx.skills[0].description).not.toMatch(/[‮\u009b]/);
  });
});

// ------------------------------------------------------------------ F7
describe("F7: remove only deletes symlinks skillwharf would have written", () => {
  it("leaves a foreign symlink in place when the store is missing", () => {
    writeSkill(path.join(outside, "mine"), "mine");
    fs.mkdirSync(path.join(proj, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(path.join(outside, "mine"), path.join(proj, ".claude", "skills", "alpha"));
    writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "github:a/b" } } });
    const r = removeSkill(ctx, "alpha");
    expect(r.removedLinks).toEqual([]);
    expect(fs.lstatSync(path.join(proj, ".claude", "skills", "alpha")).isSymbolicLink()).toBe(true);
  });

  it("still removes its own dangling link when the store is missing", () => {
    fs.mkdirSync(path.join(proj, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(path.join("..", "..", ".skillwharf", "skills", "alpha"), path.join(proj, ".claude", "skills", "alpha"));
    writeManifest({ version: 1, agents: ["claude"], skills: { alpha: { source: "github:a/b" } } });
    expect(removeSkill(ctx, "alpha").removedLinks).toEqual(["claude"]);
  });
});

// ------------------------------------------------------------------ F8
describe("F8: integrity covers the executable bit", () => {
  it.skipIf(process.platform === "win32")("hashDir changes when only the owner-exec bit changes", () => {
    const d = path.join(base, "h");
    writeSkill(d, "h");
    fs.writeFileSync(path.join(d, "run.sh"), "echo hi\n");
    fs.chmodSync(path.join(d, "run.sh"), 0o644);
    const before = hashDir(d);
    fs.chmodSync(path.join(d, "run.sh"), 0o755);
    expect(hashDir(d)).not.toBe(before);
  });
});

// ------------------------------------------------------------------ F9
describe("F9: the default registry lives under the owner's account", () => {
  it("DEFAULT_REGISTRY points at mujieha/skillwharf-registry", () => {
    expect(DEFAULT_REGISTRY).toBe("https://raw.githubusercontent.com/mujieha/skillwharf-registry/main/index.json");
  });

  it("a 404 from the default registry gives a clear message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("Not Found", { status: 404 })));
    await expect(loadRegistry(DEFAULT_REGISTRY)).rejects.toThrow(
      "the default registry is not available yet; pass --registry <url|path>",
    );
  });
});
