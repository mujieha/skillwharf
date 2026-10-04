/**
 * The words that tell a new user where skills come from and that registries are
 * theirs to run: a hint shown once per machine, the block in `--help`, and the
 * `registry help` walk-through. All of it is constant text; nothing here
 * touches the network.
 */
import fs from "node:fs";
import path from "node:path";
import { assertNoSymlinks, writeJson } from "./fs.js";

export const GUIDE_URL = "https://github.com/mujieha/skillwharf#your-own-registry";

/** The three lines `--help` shows under "Where skills come from". */
export const SOURCES_BLOCK = [
  "Skills come from any git host: github:owner/repo//dir, gitlab:group/repo//dir,",
  "or git+https://your-server/repo.git//dir. Search uses the public registry until",
  "you add your own: skillwharf registry add <name> <location>.",
].join("\n");

/** The one-time hint: the block, then where to see it again. */
export const HINT = `${SOURCES_BLOCK}\nRun \`skillwharf registry help\` to see this again. Guide: ${GUIDE_URL}`;

/** What `skillwharf registry help` prints. */
export const REGISTRY_HELP = `Where skills come from, and how to run a registry of your own

SOURCES

  A skill is installed from a git repository on any host, over https or ssh:

    github:anthropics/skills/skills/pdf                    GitHub (the repository is the first two parts)
    gitlab:acme/platform/skills//release-notes@main        GitLab (groups nest, so // marks where the folder starts)
    bitbucket:acme/skills//pdf                             Bitbucket (the // is optional)
    git+https://git.acme.com/team/skills.git//pdf          any server, over https
    git+ssh://git@git.acme.com/team/skills.git//pdf        any server, over ssh

  An @ref at the end picks a branch, a tag or a commit. The web URLs of the three
  hosts also work (GitHub .../tree/<ref>/<dir>, GitLab .../-/tree/<ref>/<dir>,
  Bitbucket .../src/<ref>/<dir>). A local folder is ./path or path:/abs/path.

  Credentials come from git itself (your credential helper for https, your ssh
  agent for ssh) and never from skillwharf. A URL that contains a password or a
  token is refused.

REGISTRIES

  A registry is an index.json that \`skillwharf search\` reads and
  \`skillwharf add <name>\` looks names up in. Until you list one of your own, the
  public registry is used.

  1. Make a git repository on your own server with an index.json at its root:

       { "version": 1, "skills": [
         { "name": "release-notes", "description": "Draft release notes",
           "source": "git+https://git.acme.com/team/skills.git//release-notes" } ] }

  2. Put skills in it from a checkout of that repository, then commit and push:

       skillwharf publish ./release-notes --registry ./registry-checkout --source git+https://git.acme.com/team/skills.git//release-notes

  3. Use it:

       skillwharf registry add acme git+https://git.acme.com/team/registry.git

  4. Share it: the registry is saved in skillwharf.json. Commit that file, and a
     teammate's \`skillwharf search\` and \`skillwharf add <name>\` use the same
     registry, with their own git credentials.

  5. Keep or drop the public registry. Adding a registry keeps it in the list;
     \`skillwharf registry remove default\` drops it.

  A registry location is a git source whose repository root holds index.json (add
  //folder for a subfolder), an https URL of an index.json, or a local index.json or
  folder. \`skillwharf registry list\` shows which of them loaded. When two registries
  list the same name, \`add\` refuses and shows both: choose with
  \`skillwharf add <name> --from <registry>\`. A registry you add is trusted to its
  schema, not reviewed: read a skill before you install it.

Guide: ${GUIDE_URL}
`;

export interface HintFlags {
  /** --quiet */
  quiet?: boolean;
  /** --json */
  json?: boolean;
  /** Where the hint goes (stderr by default, so piped output stays clean). */
  print?: (text: string) => void;
}

/** The registry list `search` used was the public registry and nothing else. */
export function usesDefaultOnly(registries: { name: string; location: string }[]): boolean {
  return registries.length === 1 && registries[0].name === "default" && registries[0].location === "default";
}

/**
 * Print the hint the first time on this machine, and never again. The marker
 * (`~/.skillwharf/hints.json`) is written first, through the same no-symlink
 * check as every other write, and the hint is shown only if that worked, so a
 * failure to remember means silence, not a hint on every run. No network.
 * Returns whether the hint was printed.
 */
export function showHintOnce(home: string, flags: HintFlags = {}): boolean {
  if (flags.quiet || flags.json) return false;
  const marker = path.join(home, ".skillwharf", "hints.json");
  try {
    assertNoSymlinks(home, marker); // a symlinked ~/.skillwharf (or marker) is never read or written through
  } catch {
    return false;
  }
  let shown: Record<string, string> = {};
  try {
    const state = JSON.parse(fs.readFileSync(marker, "utf8")) as { shown?: Record<string, string> };
    if (state.shown && typeof state.shown === "object") shown = state.shown;
    if (typeof shown.sources === "string") return false;
  } catch {
    // No marker yet, or one that does not parse: write a fresh one.
  }
  try {
    writeJson(marker, { version: 1, shown: { ...shown, sources: new Date().toISOString() } });
  } catch {
    return false;
  }
  (flags.print ?? ((t: string) => console.error(t)))(HINT);
  return true;
}

/** After a search: show the hint if only the public registry was used. */
export function afterSearch(registries: { name: string; location: string }[], flags: HintFlags, home: string): boolean {
  return usesDefaultOnly(registries) ? showHintOnce(home, flags) : false;
}
