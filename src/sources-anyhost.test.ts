import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadLock, loadManifest, makeContext, saveManifest } from "./manifest.js";
import type { Context, Lockfile, Manifest } from "./types.js";

const here = path.dirname(fileURLToPath(import.meta.url));

let base: string, home: string, proj: string, ctx: Context;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "skwf-any-"));
  home = path.join(base, "home");
  proj = path.join(base, "proj");
  for (const d of [home, proj]) fs.mkdirSync(d, { recursive: true });
  ctx = makeContext({ cwd: proj, home });
});
afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

// ------------------------------------------------------------------ S4
describe("S4: 0.1.x manifests and lockfiles load unchanged", () => {
  const fixtureManifest = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v0.1", "manifest.json"), "utf8")) as Manifest;
  const fixtureLock = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "v0.1", "lock.json"), "utf8")) as Lockfile;

  beforeEach(() => {
    fs.copyFileSync(path.join(here, "fixtures", "v0.1", "manifest.json"), path.join(proj, "skillwharf.json"));
    fs.copyFileSync(path.join(here, "fixtures", "v0.1", "lock.json"), path.join(proj, "skillwharf.lock.json"));
  });

  it("loads the 0.1.x manifest and lockfile as they are", () => {
    expect(loadManifest(ctx)).toEqual(fixtureManifest);
    expect(loadLock(ctx)).toEqual(fixtureLock);
  });

  it("saving an unchanged 0.1.x manifest writes no new fields", () => {
    const m = loadManifest(ctx) as Manifest;
    saveManifest(ctx, m);
    const saved = JSON.parse(fs.readFileSync(path.join(proj, "skillwharf.json"), "utf8")) as Manifest;
    expect(Object.keys(saved).sort()).toEqual(Object.keys(fixtureManifest).sort());
    expect(saved.skills).toEqual(fixtureManifest.skills);
    expect(saved.registry).toBe(fixtureManifest.registry);
    expect("registries" in saved).toBe(false);
  });
});
