import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyManifest, loadManifest, makeContext, saveManifest, storePath, validateManifest } from "./manifest.js";
import { linkStatus } from "./agents.js";
import { addSkill, removeSkill, syncSkills } from "./ops.js";
import { searchRegistry } from "./registry.js";
import { parseSource } from "./source.js";
import type { Context, Manifest } from "./types.js";
import { assertGitRef, assertGithubOwner, assertSkillName, assertSubpath } from "./validate.js";

let home: string, proj: string, src: string, ctx: Context;

function writeSkill(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-h-"));
  proj = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-p-"));
  src = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-s-"));
  writeSkill(path.join(src, "alpha"), "alpha");
  ctx = makeContext({ cwd: proj, home });
  saveManifest(ctx, emptyManifest(["claude", "cursor"]));
});
afterEach(() => {
  for (const d of [home, proj, src]) fs.rmSync(d, { recursive: true, force: true });
});

describe("validators", () => {
  it("rejects traversal and option-injection", () => {
    expect(() => assertSkillName("../etc")).toThrow();
    expect(() => assertSkillName("a/b")).toThrow();
    expect(() => assertSkillName("-x")).toThrow();
    expect(assertSkillName("ok-name-1")).toBe("ok-name-1");
    expect(() => assertGitRef("--upload-pack=evil")).toThrow();
    expect(() => assertGitRef("a..b")).toThrow();
    expect(assertGitRef("release/v1.2")).toBe("release/v1.2");
    expect(() => assertGithubOwner("-bad")).toThrow();
    expect(() => assertSubpath("../x")).toThrow();
    expect(() => assertSubpath("a//b")).toThrow();
  });
  it("parseSource applies them", () => {
    expect(() => parseSource("github:acme/repo/../../x")).toThrow();
    expect(() => parseSource("github:acme/repo@--flag")).toThrow();
    expect(() => parseSource("https://github.com/acme/repo/tree/-x/y")).toThrow();
  });
});

describe("manifest validation", () => {
  it("rejects names that would escape the store", () => {
    const m = { version: 1, agents: ["claude"], skills: { "../../evil": { source: "path:/x" } } } as unknown as Manifest;
    expect(() => validateManifest(m, "skillwharf.json")).toThrow(/Invalid skill name/);
    fs.writeFileSync(path.join(proj, "skillwharf.json"), JSON.stringify(m));
    expect(() => loadManifest(ctx)).toThrow();
    expect(() => storePath(ctx, "../x")).toThrow();
  });
  it("rejects absolute or traversing agentPaths", () => {
    const m = { version: 1, agents: ["claude"], skills: {}, agentPaths: { claude: { projectPath: "../../.ssh" } } } as Manifest;
    expect(() => validateManifest(m, "f")).toThrow(/agentPaths/);
    const m2 = { version: 1, agents: ["claude"], skills: {}, agentPaths: { claude: { projectPath: "/etc" } } } as Manifest;
    expect(() => validateManifest(m2, "f")).toThrow(/agentPaths/);
  });
});

describe("symlinks in sources", () => {
  it("are not copied into the store and are reported", () => {
    fs.symlinkSync("/etc/hostname", path.join(src, "alpha", "leak"));
    const [r] = addSkill(ctx, path.join(src, "alpha"));
    expect(r.skippedSymlinks).toEqual(["leak"]);
    expect(fs.existsSync(path.join(storePath(ctx, "alpha"), "leak"))).toBe(false);
    expect(fs.existsSync(path.join(storePath(ctx, "alpha"), "SKILL.md"))).toBe(true);
  });
});

describe("foreign files are never clobbered", () => {
  it("add refuses a hand-made folder unless --force", () => {
    writeSkill(path.join(proj, ".claude/skills/alpha"), "mine");
    expect(() => addSkill(ctx, path.join(src, "alpha"))).toThrow(/not managed by skillwharf/);
    // nothing half-installed
    expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
    expect(loadManifest(ctx)?.skills.alpha).toBeUndefined();
    expect(fs.readFileSync(path.join(proj, ".claude/skills/alpha/SKILL.md"), "utf8")).toContain("name: mine");
    addSkill(ctx, path.join(src, "alpha"), { force: true });
    expect(fs.lstatSync(path.join(proj, ".claude/skills/alpha")).isSymbolicLink()).toBe(true);
  });
  it("a hand-made Cursor skill folder is left alone", () => {
    writeSkill(path.join(proj, ".cursor/skills/alpha"), "mine");
    expect(() => addSkill(ctx, path.join(src, "alpha"))).toThrow(/not managed/);
    addSkill(ctx, path.join(src, "alpha"), { agents: ["claude"] });
    removeSkill(ctx, "alpha");
    expect(fs.readFileSync(path.join(proj, ".cursor/skills/alpha/SKILL.md"), "utf8")).toContain("name: mine");
  });
  it("sync refuses too, and passes with force", () => {
    addSkill(ctx, path.join(src, "alpha"));
    fs.unlinkSync(path.join(proj, ".claude/skills/alpha"));
    writeSkill(path.join(proj, ".claude/skills/alpha"), "mine");
    expect(() => syncSkills(ctx)).toThrow(/not managed/);
    expect(syncSkills(ctx, { force: true }).linked).toHaveLength(1);
  });
});

describe("symlinked project paths", () => {
  it("treats its own links as managed when the project path contains a symlink", () => {
    const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-h-real-"));
    const realProj = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-p-real-"));
    const aliasHome = path.join(os.tmpdir(), `skdeck-h-alias-${process.pid}-${Date.now()}`);
    const aliasProj = path.join(os.tmpdir(), `skdeck-p-alias-${process.pid}-${Date.now()}`);
    fs.symlinkSync(realHome, aliasHome);
    fs.symlinkSync(realProj, aliasProj);
    try {
      const aliasCtx = makeContext({ cwd: aliasProj, home: aliasHome });
      saveManifest(aliasCtx, emptyManifest(["claude", "codex", "cursor"]));
      addSkill(aliasCtx, path.join(src, "alpha"));
      const m = loadManifest(aliasCtx) as Manifest;
      const store = storePath(aliasCtx, "alpha");
      expect(linkStatus(aliasCtx, m, "claude", "alpha", store)).toBe("ok");
      expect(linkStatus(aliasCtx, m, "codex", "alpha", store)).toBe("ok");
      const r = removeSkill(aliasCtx, "alpha");
      expect(r.existed).toBe(true);
      expect(r.removedLinks.sort()).toEqual(["claude", "codex", "cursor"]);
    } finally {
      fs.rmSync(aliasHome, { force: true });
      fs.rmSync(aliasProj, { force: true });
      fs.rmSync(realHome, { recursive: true, force: true });
      fs.rmSync(realProj, { recursive: true, force: true });
    }
  });
});

describe("registry sanitising", () => {
  it("drops malformed entries and control characters", async () => {
    const { loadRegistry } = await import("./registry.js");
    const file = path.join(src, "index.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        skills: [
          { name: "ok", description: "fine\u001b[31m red", source: "github:a/b" },
          { name: "../bad", description: "x", source: "github:a/b" },
          { name: "nosource", description: "x" },
          "garbage",
        ],
      }),
    );
    const idx = await loadRegistry(file);
    expect(idx.skills.map((s) => s.name)).toEqual(["ok"]);
    expect(idx.skills[0].description).not.toContain("\u001b");
    expect(searchRegistry(idx, "ok")).toHaveLength(1);
  });
  it("refuses plain http", async () => {
    const { loadRegistry } = await import("./registry.js");
    await expect(loadRegistry("http://example.com/index.json")).rejects.toThrow(/https/);
  });
});
