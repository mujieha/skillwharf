import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ADAPTERS, DEFAULT_AGENTS, agentTarget, isAgentId, linkStatus, targetGroups } from "./agents.js";
import { emptyManifest, loadManifest, makeContext, saveManifest, storePath } from "./manifest.js";
import { addSkill, doctor, removeSkill, syncSkills } from "./ops.js";
import type { AgentId, Context, Manifest } from "./types.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let base: string, home: string, proj: string, outside: string, src: string, ctx: Context;

function writeSkill(dir: string, name: string) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: d\n---\nbody\n`);
}

function useAgents(agents: AgentId[]) {
  saveManifest(ctx, emptyManifest(agents));
}

/** Every file under `dir` whose name ends in .mdc. */
function mdcFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return (fs.readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".mdc"));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skdeck-targets-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  outside = path.join(base, "outside");
  src = path.join(proj, "vendor");
  for (const d of [home, proj, outside]) fs.mkdirSync(d, { recursive: true });
  writeSkill(path.join(src, "alpha"), "alpha");
  ctx = makeContext({ cwd: proj, home });
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe("adapter locations", () => {
  const m: Manifest = emptyManifest([]);
  const expected: Record<AgentId, string> = {
    claude: ".claude/skills/alpha",
    agents: ".agents/skills/alpha",
    codex: ".agents/skills/alpha",
    cursor: ".cursor/skills/alpha",
  };

  it("map every agent to where the tool loads skills in a project", () => {
    for (const [a, rel] of Object.entries(expected) as [AgentId, string][]) {
      expect(agentTarget(ctx, m, a, "alpha")).toBe(path.join(proj, rel));
    }
  });

  it("map every agent to where the tool loads skills globally", () => {
    const g = makeContext({ global: true, home });
    for (const [a, rel] of Object.entries(expected) as [AgentId, string][]) {
      expect(agentTarget(g, m, a, "alpha")).toBe(path.join(home, rel));
    }
  });

  it("no longer knows .codex/skills or .cursor/rules", () => {
    for (const ad of Object.values(ADAPTERS)) {
      for (const p of [ad.projectPath, ad.globalPath]) {
        expect(p).not.toMatch(/^\.codex\b|\.cursor\/rules/);
      }
    }
  });

  it("isAgentId accepts only real agent ids", () => {
    expect(isAgentId("codex")).toBe(true);
    expect(isAgentId("toString")).toBe(false);
  });
});

describe("skillwharf init default", () => {
  it("DEFAULT_AGENTS is claude + agents", () => {
    expect(DEFAULT_AGENTS).toEqual(["claude", "agents"]);
  });

  it("init with no -a writes claude + agents, even when .cursor and .codex exist", () => {
    fs.mkdirSync(path.join(proj, ".cursor"));
    fs.mkdirSync(path.join(proj, ".codex"));
    execFileSync(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "src/cli.ts"), "init"], {
      cwd: proj,
      env: { ...process.env, SKILLWHARF_HOME: home },
      stdio: "pipe",
    });
    expect(loadManifest(ctx)?.agents).toEqual(["claude", "agents"]);
  });
});

describe("codex and agents share one link", () => {
  it("targetGroups collapses them into one location", () => {
    const m = emptyManifest(["claude", "codex", "agents"]);
    const groups = targetGroups(ctx, m, m.agents, "alpha");
    expect(groups.map((g) => g.agents)).toEqual([["claude"], ["codex", "agents"]]);
    expect(groups[1].target).toBe(path.join(proj, ".agents/skills/alpha"));
  });

  it("add links and reports .agents/skills once", () => {
    useAgents(["claude", "codex", "agents"]);
    const [r] = addSkill(ctx, path.join(src, "alpha"));
    expect(r.links.map((l) => l.agents)).toEqual([["claude"], ["codex", "agents"]]);
    expect(r.links.filter((l) => l.target.includes(".agents"))).toHaveLength(1);
    expect(fs.lstatSync(path.join(proj, ".agents/skills/alpha")).isSymbolicLink()).toBe(true);
  });

  it("doctor reports nothing for the shared link, and one issue when it is missing", () => {
    useAgents(["claude", "codex", "agents"]);
    addSkill(ctx, path.join(src, "alpha"));
    expect(doctor(ctx)).toEqual([]);
    fs.unlinkSync(path.join(proj, ".agents/skills/alpha"));
    const issues = doctor(ctx).filter((i) => i.agents?.includes("codex") || i.agents?.includes("agents"));
    expect(issues).toHaveLength(1);
    expect(issues[0].agents).toEqual(["codex", "agents"]);
    expect(issues[0].message).toBe("not installed for codex+agents");
  });

  it("sync relinks the shared location once; remove unlinks it once", () => {
    useAgents(["claude", "codex", "agents"]);
    addSkill(ctx, path.join(src, "alpha"));
    fs.unlinkSync(path.join(proj, ".agents/skills/alpha"));
    const s = syncSkills(ctx);
    expect(s.linked.map((l) => l.link.agents)).toEqual([["codex", "agents"]]);
    const r = removeSkill(ctx, "alpha");
    expect(r.removed.map((g) => g.agents)).toEqual([["claude"], ["codex", "agents"]]);
    expect(r.removedLinks.sort()).toEqual(["agents", "claude", "codex"]);
    expect(fs.existsSync(path.join(proj, ".agents/skills/alpha"))).toBe(false);
  });
});

describe("cursor adapter", () => {
  it("creates a symlink under .cursor/skills and never writes an .mdc file", () => {
    useAgents(["claude", "agents", "cursor"]);
    const [r] = addSkill(ctx, path.join(src, "alpha"));
    const link = path.join(proj, ".cursor/skills/alpha");
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(fs.realpathSync(link)).toBe(fs.realpathSync(storePath(ctx, "alpha")));
    expect(r.links.find((l) => l.agents.includes("cursor"))?.mode).toBe("symlink");
    expect(linkStatus(ctx, loadManifest(ctx)!, "cursor", "alpha", storePath(ctx, "alpha"))).toBe("ok");
    syncSkills(ctx);
    expect(mdcFiles(proj)).toEqual([]);
    expect(fs.existsSync(path.join(proj, ".cursor/rules"))).toBe(false);
    removeSkill(ctx, "alpha");
    expect(fs.existsSync(link)).toBe(false);
  });

  it("creates the global link under ~/.cursor/skills", () => {
    const g = makeContext({ global: true, home });
    saveManifest(g, emptyManifest(["cursor"]));
    addSkill(g, path.join(src, "alpha"));
    expect(fs.lstatSync(path.join(home, ".cursor/skills/alpha")).isSymbolicLink()).toBe(true);
    expect(mdcFiles(home)).toEqual([]);
  });
});

describe("symlinked agent directories are refused", () => {
  for (const [dir, agent] of [
    [".claude", "claude"],
    [".agents", "agents"],
    [".agents", "codex"],
    [".cursor", "cursor"],
  ] as [string, AgentId][]) {
    it(`add refuses a symlinked ${dir} for ${agent}`, () => {
      useAgents([agent]);
      fs.symlinkSync(outside, path.join(proj, dir));
      expect(() => addSkill(ctx, path.join(src, "alpha"))).toThrow(/symlink/);
      expect(fs.readdirSync(outside)).toEqual([]);
      expect(fs.existsSync(storePath(ctx, "alpha"))).toBe(false);
    });

    it(`remove and sync refuse a symlinked ${dir} for ${agent}`, () => {
      useAgents([agent]);
      addSkill(ctx, path.join(src, "alpha"));
      fs.rmSync(path.join(proj, dir), { recursive: true, force: true });
      fs.mkdirSync(path.join(outside, "skills", "alpha"), { recursive: true });
      fs.writeFileSync(path.join(outside, "skills", "alpha", "keep.txt"), "precious");
      fs.symlinkSync(outside, path.join(proj, dir));
      expect(() => syncSkills(ctx)).toThrow(/symlink/);
      expect(() => removeSkill(ctx, "alpha")).toThrow(/symlink/);
      expect(fs.readFileSync(path.join(outside, "skills", "alpha", "keep.txt"), "utf8")).toBe("precious");
    });
  }
});
