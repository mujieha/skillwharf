import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GUIDE_URL, HINT, REGISTRY_HELP, SOURCES_BLOCK, afterSearch, showHintOnce, usesDefaultOnly } from "./hints.js";
import type { LoadedRegistry } from "./types.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let base: string, home: string, proj: string, marker: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skwf-hint-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  for (const d of [home, proj]) fs.mkdirSync(d, { recursive: true });
  marker = path.join(home, ".skillwharf", "hints.json");
});
afterEach(() => {
  vi.unstubAllGlobals();
  fs.rmSync(base, { recursive: true, force: true });
});

function cli(args: string[], cwd = proj) {
  const r = spawnSync(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "src/cli.ts"), ...args], {
    cwd,
    env: { ...process.env, SKILLWHARF_HOME: home },
    encoding: "utf8",
  });
  return { stdout: r.stdout, stderr: r.stderr, status: r.status };
}
// eslint-disable-next-line no-control-regex
const plain = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const FIRST_LINE = "Skills come from any git host: github:owner/repo//dir, gitlab:group/repo//dir,";

describe("S3.1: a hint that appears once", () => {
  it("is the four lines the design gives", () => {
    expect(HINT).toBe(
      [
        "Skills come from any git host: github:owner/repo//dir, gitlab:group/repo//dir,",
        "or git+https://your-server/repo.git//dir. Search uses the public registry until",
        "you add your own: skillwharf registry add <name> <location>.",
        "Run `skillwharf registry help` to see this again. Guide: https://github.com/mujieha/skillwharf#your-own-registry",
      ].join("\n"),
    );
    expect(HINT.startsWith(SOURCES_BLOCK)).toBe(true);
  });

  it("init prints it, on stderr, and writes the marker", () => {
    const r = cli(["init", "-a", "claude"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain(FIRST_LINE);
    expect(r.stderr).toContain("Run `skillwharf registry help` to see this again.");
    expect(r.stdout).not.toContain("Skills come from any git host");
    const m = JSON.parse(fs.readFileSync(marker, "utf8")) as { version: number; shown: Record<string, string> };
    expect(m.version).toBe(1);
    expect(Date.parse(m.shown.sources)).not.toBeNaN();
  });

  it("is not printed again, in this project or another", () => {
    cli(["init", "-a", "claude"]);
    const other = path.join(base, "other");
    fs.mkdirSync(other);
    const r = cli(["init", "-a", "claude"], other);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("Skills come from any git host");
  });

  it("--quiet suppresses it and writes no marker", () => {
    const r = cli(["--quiet", "init", "-a", "claude"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("Skills come from any git host");
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("is never printed with --json", () => {
    const err = vi.fn();
    expect(showHintOnce(home, { json: true, print: err })).toBe(false);
    expect(err).not.toHaveBeenCalled();
    expect(fs.existsSync(marker)).toBe(false);
  });

  it("makes no network request", () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    showHintOnce(home, { print: () => {} });
    expect(spy).not.toHaveBeenCalled();
  });

  it("is written before it is shown, so a failed write means no hint", () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(home, ".skillwharf")); // a symlinked ~/.skillwharf is never written through
    const print = vi.fn();
    expect(showHintOnce(home, { print })).toBe(false);
    expect(print).not.toHaveBeenCalled();
    expect(fs.readdirSync(outside)).toEqual([]);
    const r = cli(["init", "-a", "claude"]);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain("Skills come from any git host");
  });

  it("an unreadable marker is replaced, and the hint shows once more", () => {
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, "{not json");
    const print = vi.fn();
    expect(showHintOnce(home, { print })).toBe(true);
    expect(showHintOnce(home, { print })).toBe(false);
    expect(print).toHaveBeenCalledTimes(1);
  });

  describe("after a search", () => {
    const reg = (name: string, location: string): LoadedRegistry => ({ name, location, scope: "project", index: { version: 1, skills: [] } });

    it("usesDefaultOnly is true for the public registry alone, and for nothing else", () => {
      expect(usesDefaultOnly([reg("default", "default")])).toBe(true);
      expect(usesDefaultOnly([])).toBe(false);
      expect(usesDefaultOnly([reg("registry", "https://example.invalid/i.json")])).toBe(false);
      expect(usesDefaultOnly([reg("default", "default"), reg("team", "./t.json")])).toBe(false);
    });

    it("the first search that used the public registry alone shows it, once", () => {
      const print = vi.fn();
      expect(afterSearch([reg("default", "default")], { print }, home)).toBe(true);
      expect(afterSearch([reg("default", "default")], { print }, home)).toBe(false);
      expect(print).toHaveBeenCalledTimes(1);
      expect(print).toHaveBeenCalledWith(HINT);
    });

    it("init and search share one marker: a hint shown by init is not shown again by search", () => {
      cli(["init", "-a", "claude"]);
      const print = vi.fn();
      expect(afterSearch([reg("default", "default")], { print }, home)).toBe(false);
      expect(print).not.toHaveBeenCalled();
    });

    it("a search with a registry of your own shows nothing", () => {
      const print = vi.fn();
      expect(afterSearch([reg("team", "./t.json")], { print }, home)).toBe(false);
      expect(fs.existsSync(marker)).toBe(false);
    });

    it("--quiet and --json show nothing", () => {
      const print = vi.fn();
      expect(afterSearch([reg("default", "default")], { quiet: true, print }, home)).toBe(false);
      expect(afterSearch([reg("default", "default")], { json: true, print }, home)).toBe(false);
      expect(print).not.toHaveBeenCalled();
    });

    it("a real search with a registry of your own prints no hint", () => {
      fs.writeFileSync(path.join(base, "i.json"), JSON.stringify({ version: 1, skills: [] }));
      const r = cli(["search", "x", "--registry", path.join(base, "i.json")]);
      expect(r.stderr).not.toContain("Skills come from any git host");
      expect(fs.existsSync(marker)).toBe(false);
    });
  });
});

describe("S3.2: --help and registry --help carry a Where skills come from block", () => {
  it.each([["--help"], ["registry", "--help"]])("skillwharf %s", (...args) => {
    const r = cli(args);
    expect(r.status).toBe(0);
    const out = plain(r.stdout);
    expect(out).toContain("Where skills come from:");
    for (const line of SOURCES_BLOCK.split("\n")) expect(out).toContain(line);
  });

  it("the add help names every spelling", () => {
    const out = plain(cli(["add", "--help"]).stdout);
    for (const s of ["github:", "gitlab:", "bitbucket:", "git+https://", "git+ssh://", "--from <registry>"]) expect(out).toContain(s);
  });
});

describe("S3.3: registry help is the walk-through, offline", () => {
  it("prints REGISTRY_HELP, outside any project", () => {
    const r = cli(["registry", "help"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd()).toBe(REGISTRY_HELP.trimEnd());
    expect(r.stderr).toBe("");
  });

  it("shows the four spellings with an example per host", () => {
    for (const s of [
      "github:anthropics/skills/skills/pdf",
      "gitlab:acme/platform/skills//release-notes@main",
      "bitbucket:acme/skills//pdf",
      "git+https://git.acme.com/team/skills.git//pdf",
      "git+ssh://git@git.acme.com/team/skills.git//pdf",
    ]) {
      expect(REGISTRY_HELP).toContain(s);
    }
  });

  it("walks through creating, adding, sharing and linking the guide", () => {
    for (const s of [
      "index.json",
      "skillwharf publish",
      "skillwharf registry add",
      "skillwharf.json",
      "registry remove default",
      "credentials",
      "https://github.com/mujieha/skillwharf#your-own-registry",
    ]) {
      expect(REGISTRY_HELP).toContain(s);
    }
  });

  it("is built from constants: no registry is loaded and no request is made", () => {
    const spy = vi.fn();
    vi.stubGlobal("fetch", spy);
    expect(REGISTRY_HELP.length).toBeGreaterThan(500);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("S3.4: doctor mentions registries once, as information", () => {
  const INFO = "registries: only the public registry is configured";

  it("prints one info line when the project uses the public registry alone", () => {
    cli(["--quiet", "init", "-a", "claude"]);
    const r = cli(["doctor", "--stale-days", "36500"]);
    expect(r.status).toBe(0);
    const lines = plain(r.stdout).split("\n").filter((l) => l.includes(INFO));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("skillwharf registry help");
    expect(lines[0]).not.toMatch(/^!|✖/);
  });

  it("prints nothing about it when the project lists a registry of its own", () => {
    cli(["--quiet", "init", "-a", "claude", "--registry", "team=./team.json"]);
    const r = cli(["doctor", "--stale-days", "36500"]);
    expect(plain(r.stdout)).not.toContain(INFO);
  });
});

describe("S3.6/S3.7: the README and SECURITY.md name what the code does", () => {
  const readme = fs.readFileSync(path.join(repo, "README.md"), "utf8");
  const security = fs.readFileSync(path.join(repo, "SECURITY.md"), "utf8");

  it("the README has the guide section the hint links to", () => {
    expect(readme).toContain("## Your own registry");
    expect(GUIDE_URL.endsWith("#your-own-registry")).toBe(true);
    expect(readme).toContain("## Sources");
  });

  it("the README names every spelling and the moved-repository command", () => {
    for (const s of ["github:", "gitlab:", "bitbucket:", "git+https://", "git+ssh://", "skillwharf update <name> --source <new>", "--git-timeout", "--from"]) {
      expect(readme).toContain(s);
    }
  });

  it.each(["init", "add", "remove", "sync", "update", "list", "usage", "doctor", "search", "registry add", "registry remove", "registry list", "registry help", "publish", "where"])(
    "the README's command table lists skillwharf %s",
    (command) => {
      expect(readme).toContain(`\`skillwharf ${command}`);
    },
  );

  it("SECURITY.md states the git guards, the link rule, submodules and the new limits", () => {
    for (const s of [
      "GIT_ALLOW_PROTOCOL=https:ssh",
      "GIT_TERMINAL_PROMPT=0",
      "credentials",
      "does not disable certificate or host-key checks, ever",
      "is copied as that file or folder",
      "Pins submodules by the parent's commit",
      "trusted to its schema",
      "Git's own configuration is honoured",
      "--git-timeout",
      "core.hooksPath",
      "http.followRedirects=false",
      "GIT_LFS_SKIP_SMUDGE=1",
      "GIT_DIR",
      "full 40 characters",
      "without your terminal",
      "--allow-askpass",
      "--git-deadline",
      "* -filter -ident -text -eol",
      "@refs/tags/<name>",
      "taskkill /T /F",
      "Windows is implemented but not covered by CI",
      "UNC",
      "2,000,000 seconds",
      "System32\\taskkill.exe",
      "`core.autocrlf=true`",
      "any configured registry failed to load",
    ]) {
      expect(security).toContain(s);
    }
  });

  it("the README describes the project:<name> rename, the short-sha refusal and the ambiguous bare name", () => {
    for (const s of ["project:<name>", "full 40-character sha", "ambiguous", "its own session", "--allow-askpass", "--git-deadline", "@refs/tags/<name>", "Windows is not covered by CI"]) {
      expect(readme).toContain(s);
    }
  });

  it("Round D D8: the cancel and Windows limits are stated as the code behaves", () => {
    for (const s of [
      "only when stdin is a terminal",
      "only while a git call is running",
      "`skillwharf-*` folder in your temp folder",
      "between git calls",
      "unknown ssh host hangs until the timeout",
      "reused within about 300 ms",
    ]) {
      expect(security).toContain(s);
    }
    for (const s of ["only when stdin is a terminal", "between git calls", "`skillwharf-*`", "unknown ssh host hangs until the timeout"]) {
      expect(readme).toContain(s);
    }
    // no sentence claims that Ctrl-C always cleans up
    expect(security).not.toContain("skillwharf holds the signal, ends git, removes its temporary clone and exits 130. Elsewhere");
    expect(readme).not.toContain("Ctrl-C at a terminal cleans up.");
  });

  it("Round D D8: the drive-letter rule is the same in README and SECURITY.md", () => {
    for (const doc of [readme, security]) {
      expect(doc).toContain("share text");
      expect(doc).toContain("drive-letter");
      expect(doc).toContain("--allow-outside-paths");
    }
    expect(security).toContain("global manifest");
    expect(readme).not.toContain("A registry or `path:` source on a network share or a drive letter is refused; use a relative path or a git location.");
  });

  it("Round E E3: the docs name the registry-location rule, the Windows ssh caveat and when the 0.1.x sentence can appear", () => {
    for (const doc of [readme, security]) {
      expect(doc).toContain("relative path below the project");
      expect(doc).toContain("hangs until the timeout on Windows");
    }
    expect(readme).toContain("a project's manifest may list a local registry only as a relative path below the project");
    expect(readme).toContain("while a git call is running");
    expect(readme).toContain("is refused in a project's manifest unless you pass `--allow-outside-paths`");
    expect(readme).not.toContain("is refused on every platform, and a project's links");
    expect(security).toContain("an entry it never linked");
    expect(security).toContain("an absolute one (`/net/host/x`, `~/x`)");
    // the cannot-ask sentence is qualified for Windows everywhere it is made
    expect(security).not.toContain("so a first connection to an unknown ssh host fails instead of asking; trust");
    expect(readme).not.toContain("so a first connection to an unknown ssh host fails instead of asking: trust");
  });

  it("SECURITY.md no longer claims that symlinks in a fetched repository are never followed", () => {
    expect(security).not.toContain("Never follows a symlink in a fetched repository");
  });
});

describe("release: the version is 0.2.0 everywhere it is written", () => {
  it("package.json, package-lock.json and --version agree", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { version: string };
    const lock = JSON.parse(fs.readFileSync(path.join(repo, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(pkg.version).toBe("0.2.0");
    expect(lock.version).toBe("0.2.0");
    expect(lock.packages[""].version).toBe("0.2.0");
    expect(cli(["--version"]).stdout.trim()).toBe("0.2.0");
  });
});

describe("S3.5: the package has no script that runs on install", () => {
  it("package.json lists no preinstall, install, postinstall or prepare script", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repo, "package.json"), "utf8")) as { scripts: Record<string, string> };
    for (const s of ["preinstall", "install", "postinstall", "prepare", "preprepare", "postprepare"]) expect(pkg.scripts).not.toHaveProperty(s);
  });
});
