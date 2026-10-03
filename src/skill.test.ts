import { describe, expect, it } from "vitest";
import { normalizeName, parseSkillMd } from "./skill.js";
import { formatSource, isCommitSha, parseSource } from "./source.js";
import { searchRegistry } from "./registry.js";
import { stripPlugin } from "./usage.js";

describe("parseSkillMd", () => {
  it("reads frontmatter", () => {
    const m = parseSkillMd(`---\nname: pdf-tools\ndescription: Read PDFs\nversion: 1.2.0\n---\n# Body\ntext`, "fallback");
    expect(m.name).toBe("pdf-tools");
    expect(m.description).toBe("Read PDFs");
    expect(m.version).toBe("1.2.0");
    expect(m.body.trim()).toBe("# Body\ntext");
  });
  it("falls back to folder name and first paragraph", () => {
    const m = parseSkillMd(`# Title\n\nDoes a thing.\n`, "my-skill");
    expect(m.name).toBe("my-skill");
    expect(m.description).toBe("Does a thing.");
  });
  it("tolerates broken yaml", () => {
    const m = parseSkillMd(`---\nname: [unclosed\n---\nbody`, "x");
    expect(m.name).toBe("x");
  });
});

describe("normalizeName", () => {
  it("slugifies", () => {
    expect(normalizeName("Release Notes")).toBe("release-notes");
    expect(normalizeName("  PDF_Tools!! ")).toBe("pdf-tools");
    expect(() => normalizeName("!!!")).toThrow();
  });
});

describe("parseSource", () => {
  it("parses github shorthand with subpath and ref", () => {
    const p = parseSource("github:acme/skills/tools/pdf@v2");
    expect(p).toMatchObject({ kind: "git", shorthand: "github", host: "github.com", repoPath: "acme/skills", subpath: "tools/pdf", ref: "v2" });
    expect(formatSource(p)).toBe("github:acme/skills/tools/pdf@v2");
    expect(formatSource(p, "abc1234")).toBe("github:acme/skills/tools/pdf@abc1234");
  });
  it("parses github tree URLs", () => {
    const p = parseSource("https://github.com/acme/skills/tree/main/tools/pdf");
    expect(p).toMatchObject({ kind: "git", shorthand: "github", repoPath: "acme/skills", subpath: "tools/pdf", ref: "main" });
    const r = parseSource("https://github.com/acme/skills.git");
    expect(r).toMatchObject({ kind: "git", shorthand: "github", repoPath: "acme/skills", subpath: "" });
  });
  it("parses local paths", () => {
    expect(parseSource("./x", "/proj")).toMatchObject({ kind: "path", path: "/proj/x" });
    expect(parseSource("path:../y", "/proj/a")).toMatchObject({ kind: "path", path: "/proj/y" });
  });
  it("rejects owner-only github", () => {
    expect(() => parseSource("github:acme")).toThrow();
  });
  it("detects commit shas", () => {
    // A commit pin is the full 40 characters: shorter hex is a ref name to git (a branch or tag can be called that).
    expect(isCommitSha("34040c9c568585f6929bedeaad110ad08f079624")).toBe(true);
    expect(isCommitSha("34040c9c5685")).toBe(false);
    expect(isCommitSha("main")).toBe(false);
    expect(isCommitSha("v1.2.0")).toBe(false);
  });
});

describe("searchRegistry", () => {
  const idx = {
    version: 1 as const,
    skills: [
      { name: "pdf-tools", description: "Read and merge PDFs", source: "github:a/b/pdf", tags: ["pdf", "documents"] },
      { name: "release-notes", description: "Draft release notes", source: "github:a/b/rn", tags: ["git"] },
    ],
  };
  it("ranks exact name first and filters non-matches", () => {
    const hits = searchRegistry(idx, "pdf");
    expect(hits.map((h) => h.name)).toEqual(["pdf-tools"]);
    expect(searchRegistry(idx, "notes")[0].name).toBe("release-notes");
    expect(searchRegistry(idx, "zzz")).toHaveLength(0);
  });
});

describe("stripPlugin", () => {
  it("removes plugin prefixes", () => {
    expect(stripPlugin("anthropic-skills:pdf")).toBe("pdf");
    expect(stripPlugin("pdf")).toBe("pdf");
  });
});
