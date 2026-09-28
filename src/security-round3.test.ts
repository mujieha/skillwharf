import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeContext, validateManifest } from "./manifest.js";
import { addSkill, doctor, syncSkills, updateSkills } from "./ops.js";
import { publishToRegistry } from "./registry.js";
import type { Context, Manifest } from "./types.js";

let base: string, home: string, proj: string, outside: string, ctx: Context;

function writeSkill(dir: string, name: string, body = "body") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\n${body}\n`);
}

function writeManifest(m: Manifest) {
  fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify(m));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-r3-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  outside = path.join(base, "outside");
  for (const d of [home, proj, outside]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(outside, "creds"), "secret");
  ctx = makeContext({ cwd: proj, home });
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ R3-1
describe("R3-1: a symlink committed inside a store folder is never linked into an agent", () => {
  beforeEach(() => {
    writeSkill(path.join(proj, "src", "s"), "s");
    writeManifest({ version: 1, agents: ["claude"], skills: { s: { source: "path:./src/s" } } });
    syncSkills(ctx);
    fs.rmSync(path.join(proj, ".claude"), { recursive: true, force: true });
    fs.symlinkSync(path.join(outside, "creds"), path.join(proj, ".skillwharf", "skills", "s", "leak"));
  });

  it("doctor reports a store symlink as an error", () => {
    const issues = doctor(ctx).filter((i) => i.level === "error" && /symlink/.test(i.message));
    expect(issues.map((i) => i.skill)).toContain("s");
  });

  it("sync refuses to link a store folder that contains a symlink", () => {
    expect(() => syncSkills(ctx)).toThrow(/symlink/);
    expect(fs.existsSync(path.join(proj, ".claude", "skills", "s"))).toBe(false);
  });

  it("update replaces the store and the symlink is gone", () => {
    updateSkills(ctx, ["s"]);
    expect(fs.existsSync(path.join(proj, ".skillwharf", "skills", "s", "leak"))).toBe(false);
    expect(doctor(ctx).filter((i) => i.level === "error")).toEqual([]);
  });
});

// ------------------------------------------------------------------ R3-2
describe("R3-2: a symlinked manifest or lockfile is refused before anything is written", () => {
  it("add refuses a symlinked skillwharf.json and leaves no store behind", () => {
    fs.writeFileSync(path.join(outside, "m.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {} }));
    fs.symlinkSync(path.join(outside, "m.json"), path.join(proj, "skillwharf.json"));
    writeSkill(path.join(proj, "src", "demo"), "demo");
    expect(() => addSkill(ctx, path.join(proj, "src", "demo"))).toThrow(/symlink/);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".claude"))).toBe(false);
  });

  it("add refuses a symlinked skillwharf.lock.json and leaves no store behind", () => {
    writeManifest({ version: 1, agents: ["claude"], skills: {} });
    fs.writeFileSync(path.join(outside, "l.json"), JSON.stringify({ version: 1, skills: {} }));
    fs.symlinkSync(path.join(outside, "l.json"), path.join(proj, "skillwharf.lock.json"));
    writeSkill(path.join(proj, "src", "demo"), "demo");
    expect(() => addSkill(ctx, path.join(proj, "src", "demo"))).toThrow(/symlink/);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
  });
});

// ------------------------------------------------------------------ R3-3
describe("R3-3: agentPaths may not point into .skillwharf or .git", () => {
  const m = (p: { projectPath?: string; globalPath?: string }): Manifest =>
    ({ version: 1, agents: ["claude"], skills: {}, agentPaths: { claude: p } }) as Manifest;

  it.each([".skillwharf/skills", ".skillwharf", "./.skillwharf/skills", ".SkillWharf/skills", ".git/hooks", ".git"])(
    "rejects projectPath %s",
    (p) => {
      expect(() => validateManifest(m({ projectPath: p }), "skillwharf.json")).toThrow(/agentPaths/);
    },
  );

  it("rejects a globalPath inside .skillwharf", () => {
    expect(() => validateManifest(m({ globalPath: ".skillwharf/skills" }), "skillwharf.json")).toThrow(/agentPaths/);
  });

  it("still accepts an ordinary override", () => {
    expect(() => validateManifest(m({ projectPath: ".mytool/skills" }), "skillwharf.json")).not.toThrow();
  });

  it("add refuses instead of replacing the store with a self-referencing link", () => {
    writeManifest(m({ projectPath: ".skillwharf/skills" }));
    writeSkill(path.join(proj, "src", "demo"), "demo");
    expect(() => addSkill(ctx, path.join(proj, "src", "demo"))).toThrow(/agentPaths/);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
  });
});

// ------------------------------------------------------------------ R3-4
describe("R3-4: publish validates the skill name", () => {
  const entry = (name: string) => ({ name, description: "d", source: "github:o/r/p" });

  it.each(["a$(touch x)", "bad\u001b[31mname", "a;b", "Upper"])("refuses %j", (name) => {
    const reg = path.join(base, "registry");
    expect(() => publishToRegistry(reg, entry(name))).toThrow(/Invalid skill name/);
    expect(fs.existsSync(path.join(reg, "index.json"))).toBe(false);
  });

  it("accepts a valid name", () => {
    const reg = path.join(base, "registry");
    expect(publishToRegistry(reg, entry("good-name")).created).toBe(true);
  });
});
