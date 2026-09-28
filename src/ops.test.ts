import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { linkStatus } from "./agents.js";
import { emptyManifest, loadLock, loadManifest, makeContext, saveManifest, storePath } from "./manifest.js";
import { addSkill, doctor, removeSkill, syncSkills, updateSkills } from "./ops.js";
import { scanClaudeUsage } from "./usage.js";
import type { Context } from "./types.js";

let home: string;
let proj: string;
let src: string;
let ctx: Context;

function writeSkill(dir: string, name: string, extra = "") {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} desc\nversion: 1.0\n---\n# ${name}\n${extra}\n`);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-home-"));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-proj-"));
  src = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-src-"));
  writeSkill(path.join(src, "alpha"), "alpha");
  writeSkill(path.join(src, "beta"), "Beta Skill");
  ctx = makeContext({ cwd: proj, home });
  saveManifest(ctx, emptyManifest(["claude", "codex", "cursor"]));
});

afterEach(() => {
  for (const d of [home, proj, src]) fs.rmSync(d, { recursive: true, force: true });
});

describe("addSkill", () => {
  it("installs to the store and links into every agent", () => {
    const [r] = addSkill(ctx, path.join(src, "alpha"));
    expect(r.name).toBe("alpha");
    expect(fs.existsSync(path.join(proj, ".skillwharf/skills/alpha/SKILL.md"))).toBe(true);
    expect(fs.lstatSync(path.join(proj, ".claude/skills/alpha")).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(path.join(proj, ".claude/skills/alpha"))).toBe(fs.realpathSync(storePath(ctx, "alpha")));
    expect(fs.existsSync(path.join(proj, ".agents/skills/alpha/SKILL.md"))).toBe(true);
    expect(fs.lstatSync(path.join(proj, ".cursor/skills/alpha")).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(proj, ".codex"))).toBe(false);
    expect(loadManifest(ctx)?.skills.alpha.source).toBe(path.join(src, "alpha"));
    expect(loadLock(ctx).skills.alpha.integrity).toMatch(/^sha256-/);
  });

  it("refuses multi-skill sources without --all, installs all with it", () => {
    expect(() => addSkill(ctx, src)).toThrow(/2 skills/);
    const all = addSkill(ctx, src, { all: true });
    expect(all.map((a) => a.name).sort()).toEqual(["alpha", "beta-skill"]);
    expect(loadManifest(ctx)?.skills["beta-skill"].source).toBe(`path:${path.join(src, "beta")}`);
  });

  it("honours --name and per-skill agents", () => {
    addSkill(ctx, path.join(src, "alpha"), { name: "renamed", agents: ["claude"] });
    expect(fs.existsSync(path.join(proj, ".claude/skills/renamed"))).toBe(true);
    expect(fs.existsSync(path.join(proj, ".agents/skills/renamed"))).toBe(false);
    expect(loadManifest(ctx)?.skills.renamed.agents).toEqual(["claude"]);
  });
});

describe("removeSkill", () => {
  it("removes links, store, manifest and lock entries", () => {
    addSkill(ctx, path.join(src, "alpha"));
    const r = removeSkill(ctx, "alpha");
    expect(r.existed).toBe(true);
    expect(r.removedLinks.sort()).toEqual(["claude", "codex", "cursor"]);
    expect(fs.existsSync(path.join(proj, ".claude/skills/alpha"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".cursor/skills/alpha"))).toBe(false);
    expect(fs.existsSync(path.join(proj, ".agents/skills/alpha"))).toBe(false);
    expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
    expect(loadManifest(ctx)?.skills.alpha).toBeUndefined();
    expect(loadLock(ctx).skills.alpha).toBeUndefined();
  });

  it("does not delete a foreign directory with the same name", () => {
    addSkill(ctx, path.join(src, "alpha"), { agents: ["codex"] });
    fs.rmSync(path.join(proj, ".claude"), { recursive: true, force: true });
    writeSkill(path.join(proj, ".claude/skills/alpha"), "hand-made");
    const m = loadManifest(ctx)!;
    m.skills.alpha.agents = ["claude", "codex"];
    saveManifest(ctx, m);
    removeSkill(ctx, "alpha");
    expect(fs.existsSync(path.join(proj, ".claude/skills/alpha/SKILL.md"))).toBe(true);
  });
});

describe("syncSkills", () => {
  it("restores a fresh clone from manifest + lock", () => {
    addSkill(ctx, path.join(src, "alpha"));
    fs.rmSync(path.join(proj, ".skillwharf"), { recursive: true });
    fs.rmSync(path.join(proj, ".claude"), { recursive: true });
    // the fixture source lives outside the project, which a manifest may only use with explicit opt-in
    const r = syncSkills(ctx, { allowOutsidePaths: true });
    expect(r.fetched).toEqual(["alpha"]);
    expect(fs.existsSync(path.join(proj, ".claude/skills/alpha/SKILL.md"))).toBe(true);
  });

  it("repairs broken links and reports unchanged skills", () => {
    addSkill(ctx, path.join(src, "alpha"));
    fs.unlinkSync(path.join(proj, ".agents/skills/alpha"));
    const r = syncSkills(ctx);
    expect(r.linked.map((l) => l.link.agents)).toEqual([["codex"]]);
    expect(syncSkills(ctx).unchanged).toEqual(["alpha"]);
  });
});

describe("updateSkills + doctor", () => {
  it("detects upstream changes and local drift", () => {
    addSkill(ctx, path.join(src, "alpha"));
    const outside = { allowOutsidePaths: true };
    expect(updateSkills(ctx, ["alpha"], outside)[0].changed).toBe(false);
    fs.appendFileSync(path.join(src, "alpha/SKILL.md"), "more\n");
    expect(updateSkills(ctx, [], outside)[0].changed).toBe(true);
    expect(doctor(ctx)).toEqual([]);

    fs.appendFileSync(storePath(ctx, "alpha") + "/SKILL.md", "local edit\n");
    const issues = doctor(ctx);
    expect(issues.some((i) => /differ from lockfile/.test(i.message))).toBe(true);

    fs.unlinkSync(path.join(proj, ".claude/skills/alpha"));
    expect(linkStatus(ctx, loadManifest(ctx)!, "claude", "alpha", storePath(ctx, "alpha"))).toBe("missing");
    expect(doctor(ctx).some((i) => i.agent === "claude" && i.level === "error")).toBe(true);
  });
});

describe("scanClaudeUsage", () => {
  it("counts Skill tool calls and slash commands, scoped to a project", async () => {
    const logDir = path.join(home, ".claude/projects/-p");
    fs.mkdirSync(logDir, { recursive: true });
    const now = new Date();
    const line = (o: unknown) => JSON.stringify(o) + "\n";
    fs.writeFileSync(
      path.join(logDir, "s.jsonl"),
      line({ timestamp: now.toISOString(), cwd: proj, message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "pack:alpha" } }] } }) +
        line({ timestamp: now.toISOString(), cwd: proj, message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "alpha" } }] } }) +
        line({ timestamp: now.toISOString(), cwd: "/elsewhere", message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "alpha" } }] } }) +
        line({ timestamp: now.toISOString(), cwd: proj, message: { content: "<command-name>/commit</command-name>" } }) +
        "not json\n",
    );
    const all = await scanClaudeUsage({ home });
    expect(all.get("alpha")?.count).toBe(3);
    expect(all.get("commit")?.count).toBe(1);
    const scoped = await scanClaudeUsage({ home, project: proj });
    expect(scoped.get("alpha")?.count).toBe(2);
    expect(scoped.get("alpha")?.projects.size).toBe(1);
  });
});
