# skillwharf

**One manifest and lockfile, pinned to a full commit sha and a content hash, for the agent
skills (`SKILL.md` folders) your team shares.** `doctor` finds broken, foreign and drifted
installs; `usage` shows which skills Claude Code actually fires. skillwharf installs into
`.claude/skills` and the cross-tool `.agents/skills` (read natively by Codex and Cursor) by
default.

<p align="center">
  <a href="https://github.com/mujieha/skillwharf/blob/main/docs/media/skillwharf-intro.mp4"><img src="https://raw.githubusercontent.com/mujieha/skillwharf/main/docs/media/skillwharf-intro.gif" width="720" alt="skillwharf in 28 seconds: why copied skills drift, then init, add pinned to a full commit sha, sync, doctor and usage in a terminal, and who it is for: one developer, a small team, a company"></a>
</p>

```
npm i -g skillwharf
skillwharf init
skillwharf add github:anthropics/skills/skills/mcp-builder
```

```
✔ mcp-builder  github:anthropics/skills/skills/mcp-builder@34040c9c568585f6929bedeaad110ad08f079624
   claude       symlink  .claude/skills/mcp-builder
   agents       symlink  .agents/skills/mcp-builder
```

## Why

Agent skills are folders with a `SKILL.md` that teach a coding agent a task: filling in
PDFs, building an MCP server, your team's release checklist. They are easy to write and
easy to lose track of.

- **The same skill ends up copied everywhere.** Claude Code reads `.claude/skills`, Codex
  and Cursor read `.agents/skills`, and every teammate has their own copies. Copies drift,
  and nobody can say which one is current.
- **Nothing pins them.** A skill taken from someone's repository last month may have
  changed since, so a fresh clone of your project can get a different skill from the one
  you tested with, or none at all.
- **Nobody knows which ones are used.** Skills pile up; some fire every day and others
  never do.

skillwharf treats skills the way a package manager treats dependencies. `skillwharf.json`
says which skills a project wants, and `skillwharf.lock.json` pins each one to a full
commit sha and a content hash. One copy lives in `.skillwharf/skills`, and each agent's
folder gets a link to it. Commit the two files, and a teammate who clones the project runs
`skillwharf sync` to get the same skills: it fetches each missing one at its pinned commit
and checks all of them before it installs any, so a hash that differs from the lockfile (or
a lockfile entry with no hash, unless you pass `--allow-unpinned`) stops the run with nothing
installed. A skill with no lockfile entry yet is installed from its manifest source as it
is now, then pinned.
`skillwharf doctor` reports broken links, drift from the lockfile, folders
skillwharf did not create, and skills nobody has used lately. `skillwharf usage` reads
Claude Code's local session logs to show which skills actually fire.

## Who it's for

- **One developer.** `skillwharf -g` keeps your personal skills in `~/.skillwharf` and links
  them into the agents' global folders, so every project on your machine sees the same
  versions.
- **A small team.** Commit `skillwharf.json` and `skillwharf.lock.json` next to your code.
  Everyone who clones the repository runs `skillwharf sync` and gets the same skills at the
  same commits, and `skillwharf doctor` tells each person when their copy has drifted.
- **A company with several teams.** Keep shared skills in repositories of your own, on
  GitHub, GitLab, Bitbucket or any server you run. Private ones work too, as long as each
  person's `git` can already clone them (for example after `gh auth setup-git`, or with an
  ssh key). Each team's projects pin the skills they use, so one team can move to a new
  version with `skillwharf update` while another stays where it is. To make skills easy to
  find, keep a registry of your own (see [Your own registry](#your-own-registry)) next to
  the public one, and share it by committing `skillwharf.json`.

## Install

```
npm install -g skillwharf
```

Requires Node 22.12 or newer.

## Quick start

```
skillwharf init                                            # writes skillwharf.json
skillwharf add github:anthropics/skills/skills/mcp-builder  # install a skill
skillwharf sync                                             # after a fresh git clone
```

## Commands

| Command | Does |
| --- | --- |
| `skillwharf init [-a claude,agents,codex,cursor] [--registry [name=]location]...` | Write `skillwharf.json`; the default agents are `claude,agents`; `--registry` may be repeated |
| `skillwharf add <source or name> [--name n] [--agents a,b] [--all] [--from registry] [--force] [--max-skill-size mb] [--max-skill-files n]` | Install from any [source](#sources), or by name from the registries (`--from` picks the registry when two list the name) |
| `skillwharf remove <name>` | Unlink from agents and delete from the store |
| `skillwharf sync [--force] [--allow-unpinned] [--allow-outside-paths]` | Make the store and agent folders match the manifest — run after `git clone` |
| `skillwharf update [names...] [--source <new>] [--allow-outside-paths]` | Re-fetch from source, refresh the lockfile, report what changed; `--source` points one skill at a repository that moved |
| `skillwharf list` | Skills, versions, agents, uses in the last 90 days |
| `skillwharf usage [--days 30] [--all-projects]` | Which skills actually fire, from Claude Code session logs |
| `skillwharf doctor [--stale-days 60]` | Broken links, local drift, skills nobody used |
| `skillwharf search <query> [--registry location]` | Search every registry the manifest lists; each row names its registry |
| `skillwharf registry add <name> <location>` | Load the registry once (a typo fails here) and add it to the manifest |
| `skillwharf registry remove <name>` | Remove a registry from the manifest |
| `skillwharf registry list` | Each registry with its location, how many skills it lists, and whether it loaded |
| `skillwharf registry help` | The walk-through for running your own registry (offline) |
| `skillwharf publish <path> --registry <dir> --source <src>` | Add a skill to a registry checkout; `--source` may be on any git host |
| `skillwharf where <name>` | Print every path a skill is installed at |

Add `-g` to any command to manage `~/.skillwharf` and the agents' global folders instead of a project. `--git-timeout <seconds>` (default 120) kills a git call that runs longer, and names the repository. `--quiet` silences the one-time hint described under [Your own registry](#your-own-registry). `--json` prints machine-readable output for `list`, `usage`, `search` and `registry list`.

## Files you commit

`skillwharf.json` — what you want:

```json
{
  "version": 1,
  "agents": ["claude", "agents"],
  "skills": {
    "mcp-builder": { "source": "github:anthropics/skills/skills/mcp-builder" },
    "release-notes": { "source": "path:./skills/release-notes", "agents": ["claude"] }
  }
}
```

`skillwharf.lock.json` — what you got, pinned to a full commit sha and a content hash:

```json
{
  "version": 1,
  "skills": {
    "mcp-builder": {
      "source": "github:anthropics/skills/skills/mcp-builder",
      "resolved": "github:anthropics/skills/skills/mcp-builder@34040c9c568585f6929bedeaad110ad08f079624",
      "integrity": "sha256-LixwBf2oorcuDKJo/vb+jIOdkMTHyGbu4GR8yxvqVGk=",
      "installedAt": "2026-09-23T21:57:22.045Z"
    }
  }
}
```

A `path:` source in a project manifest is relative to the project root and must stay inside the project; `sync` and `update` refuse one outside it unless you pass `--allow-outside-paths`. When you `add` a folder that is inside the project, skillwharf records it relative (`path:./skills/x`), so a teammate's checkout at another location resolves the same folder; a folder outside the project is recorded as an absolute path, and `sync` and `update` refuse it on any machine, yours included, unless you pass `--allow-outside-paths`. A `path:` source may not be, contain or lie inside the skill store or the skill's own agent folders (so `path:./.claude/skills/foo` is refused: move that folder to, say, `skills/foo` first). The global manifest (`-g`, in `~/.skillwharf`) is yours, and its `path:` sources are not confined to a project.

`add` refuses to replace a skill that is already managed from a different source (for example a pack whose `SKILL.md` says `name: pdf`); pass `--force` to replace it. `update` fetches and checks every skill before it replaces any store folder, like `sync`.

Add `.skillwharf/` and the agent folders (`.claude/skills`, `.agents/skills`, and `.cursor/skills` if you enabled `cursor`) to `.gitignore` if you prefer teammates to run `skillwharf sync`, which installs the pinned commit and refuses content whose hash differs from the lockfile. If you commit them instead, `skillwharf doctor` reports any store folder that differs from the lockfile; `sync` does not re-check a folder that is already there. Commit real folders: skillwharf refuses to write through a store or agent folder that is a symlink.

## Supported agents

Every adapter installs a skill as a symlink to its store folder (paths from `src/agents.ts`):

| Agent | Project | Global (`-g`) | Read by |
| --- | --- | --- | --- |
| `claude` (default) | `.claude/skills/<name>` | `~/.claude/skills/<name>` | Claude Code; Cursor also reads it |
| `agents` (default) | `.agents/skills/<name>` | `~/.agents/skills/<name>` | Codex, Cursor and other tools that follow the `.agents/skills` convention |
| `codex` | `.agents/skills/<name>` | `~/.agents/skills/<name>` | Same location as `agents`; accepted so a manifest can name Codex explicitly |
| `cursor` (opt-in) | `.cursor/skills/<name>` | `~/.cursor/skills/<name>` | Cursor |

The default `claude,agents` covers Claude Code, Codex and Cursor with two links. When `codex` and `agents` are both enabled, skillwharf writes, checks and reports their shared link once (shown as `codex+agents`). You only need `cursor` if you want Cursor-specific placement; Cursor already reads `.agents/skills` and `.claude/skills`.

Override a path in the manifest:

```json
"agentPaths": { "agents": { "projectPath": ".agents/custom-skills" } }
```

An override must sit inside one of the agent folders `.claude`, `.agents` or `.cursor` (at least one level below it, such as `.claude/custom`), and each folder name may use only letters, digits, `.`, `_` and `-`. Anything else, such as `node_modules` or `scripts`, is refused; there is no flag to relax this.

On Windows without Developer Mode, symlinks fall back to copies. skillwharf records each copy it makes in the lockfile (`links`), and only a folder the lockfile records as a copy, and that still matches the store exactly, is treated as skillwharf's own; `skillwharf doctor` flags these copies. The `links` record is lockfile data that a teammate can edit: a forged record plus a folder that is byte-identical to the store (and is not the skill's own source) is the one case where a folder skillwharf did not create can be replaced or removed, and its content survives in the skill's source or in git, not in the store, which `remove` deletes in the same run. A copy is recorded only when the skill has a lock entry.

## Usage tracking

`skillwharf usage` reads Claude Code's local session logs (`~/.claude/projects/**/*.jsonl`) and counts `Skill` tool calls and slash-command invocations. Nothing leaves your machine. Codex and Cursor do not expose comparable logs yet; contributions welcome.

## Registries

A registry is an `index.json` that `skillwharf search` reads and `skillwharf add <name>` looks names up in:

```json
{ "version": 1, "skills": [
  { "name": "mcp-builder", "description": "Guide for creating MCP servers", "source": "github:anthropics/skills/skills/mcp-builder", "tags": ["mcp"] }
]}
```

A manifest lists the registries it uses, in order:

```json
"registries": [
  { "name": "default", "location": "default" },
  { "name": "acme", "location": "git+https://git.acme.com/team/registry.git" }
]
```

A `location` is `default` (the public registry, [mujieha/skillwharf-registry](https://github.com/mujieha/skillwharf-registry)), an https URL of an `index.json`, a git source whose repository root holds `index.json` (add `//folder` for a subfolder), or a local path to an `index.json` or a folder with one (relative paths are read from the folder of the manifest that lists them). A manifest that lists nothing uses the public registry; an explicit empty list (`"registries": []`) means none. The 0.1.x `"registry": "<url>"` field still works and is read as a registry named `registry`. The global manifest (`-g`) may list registries too: its list comes first and the project's follows. A project entry with the same name and the same location as a global one is the same registry; with another location the project keeps the name and the global one is shown as `global:<name>`.

Every index goes through the same checks: entry names are validated, descriptions are cut to 300 characters, only the known fields are kept, and an entry whose source is a local path, is not a git source, or fails the source rules is dropped. A registry that fails to load (a typo, a server that is down) is reported by name on stderr and the others still answer; `search` fails only when every registry failed.

`search` shows each result with the registry it came from; the same skill name in two registries is two rows, ordered by score and then by the order of the list. `add <name>` (a plain skill name, no scheme and no slash) looks the name up in the registries and installs the source the entry gives; the manifest records that source, not the name. When two registries list the name, `add` refuses and shows both; choose with `--from <registry>`. If no registry lists it, the error says so and reminds you that a local folder is written `./<name>`.

## Your own registry

Skills do not have to be public, and the registry that finds them does not either. To run one for a team:

1. **Make a git repository** on GitHub, GitLab, Bitbucket or your own server, with an `index.json` at its root (the shape is above).
2. **Add skills to it.** In a checkout of that repository, run `skillwharf publish ./release-notes --registry . --source git+https://git.acme.com/team/skills.git//release-notes`, then commit and push. `--source` is where the skill is installed from, on any git host.
3. **Use it:** `skillwharf registry add acme git+https://git.acme.com/team/registry.git`. skillwharf loads the index once, so a mistyped location fails right away, and then writes it to `skillwharf.json`.
4. **Share it.** Commit `skillwharf.json`; a teammate's `search` and `add <name>` use the same registry, fetched with their own git credentials.
5. **Keep or drop the public registry.** When the manifest listed nothing, `registry add` writes `default` first and yours after it, so the public registry stays; `skillwharf registry remove default` drops it.

`skillwharf registry list` shows which registries loaded and how many skills each lists. To use one for every project on your machine, add it to the global manifest (`skillwharf -g init`, then `skillwharf -g registry add ...`).

The first time you run `skillwharf init`, and the first time a `search` uses the public registry alone, skillwharf prints a short hint on stderr that skills come from any git host and that registries are yours to own. It appears once per machine (the marker is `~/.skillwharf/hints.json`; there is no network involved), never with `--json`, and not at all with `--quiet`. `skillwharf registry help` prints the same walk-through offline, and `skillwharf doctor` mentions it in one information line (never a warning) while a project uses the public registry alone. The package has no install-time script.

## Sources

A skill is installed from a git repository on any host, over https or ssh:

| Spelling | Example |
| --- | --- |
| GitHub | `github:anthropics/skills/skills/pdf@v1` (the repository is the first two parts; `//` before the folder is optional) |
| GitLab | `gitlab:acme/platform/skills//release-notes@main` (groups nest, so `//` is required before a folder) |
| Bitbucket | `bitbucket:acme/skills//pdf` (the repository is the first two parts; `//` is optional) |
| Any server | `git+https://git.acme.com/team/skills.git//pdf` or `git+ssh://git@git.acme.com/team/skills.git//pdf` (`.git` ends the repository, `//` starts the folder; a port may follow the host) |
| Web URLs | GitHub `https://github.com/o/r/tree/main/dir`, GitLab `https://gitlab.com/g/r/-/tree/main/dir`, Bitbucket `https://bitbucket.org/o/r/src/main/dir`, converted to the shorthand |
| Local path | `./skills/foo`, `../shared/foo`, `path:/abs/foo` |

`@ref` goes last and is a branch, a tag or a commit. The lockfile records the canonical spelling (the shorthand when there is one) with the full 40-character commit; `github:` sources and 0.1.x lockfiles are unchanged.

**Credentials come from git, never from skillwharf.** Use your git credential helper for https and your ssh agent or ssh config for ssh. A URL that contains a user name or password is refused (only the user `git` may be written in an ssh URL), and so is any scheme other than https and ssh (`http`, `git://`, `file:`, `ext::`). skillwharf does not call any host's API, only `git`: it runs with `GIT_ALLOW_PROTOCOL` limited to `https:ssh` (never widened if you set it yourself), with terminal prompts off and standard input closed, and kills a git call after 120 seconds (`--git-timeout <seconds>`). Your git configuration, credential helpers, ssh configuration and URL rewrites are honoured and are yours to manage.

Each folder name in a sub-path and in a repository path may use only letters, digits, `.`, `_` and `-`, none may end in `.`, and `.git` may only end the repository. A symlink anywhere on the sub-path is refused. A skill folder with more than 2,000 files and folders or more than 50 MB is refused; `--max-skill-files` and `--max-skill-size` (megabytes) raise the cap on `add`, `sync` and `update`.

**Links inside a fetched repository.** A symlink that points to a file or folder inside the same repository is copied as that file or folder; a link that leaves the repository, points into `.git`, or is broken is dropped and reported by `add`. A folder link that leads back into a folder being copied is a cycle and is refused. The size cap counts the content after links are resolved. A `SKILL.md` that is a link to a file inside the repository counts as a skill (repositories that mirror one canonical `SKILL.md` into `.claude/` and `.agents/` rely on this); one that points outside does not. Local `path:` sources keep the stricter rule: every symlink is dropped.

**Submodules, one level.** If the sub-path is a submodule, contains one or runs through one, skillwharf reads `.gitmodules` from the fetched commit, validates the submodule's URL with the rules above (a relative URL resolves against the parent's), fetches it at exactly the commit the parent records, and places its files where the submodule was. The lockfile records the parent. A submodule that has its own submodules is refused, naming the inner repository, and so is a source that touches more than 16 submodules.

**Finding skills.** `add --all` on a git source searches up to six folders deep, dot-folders such as `.agents/skills` and `.claude/skills` included, and skips `.git` and `node_modules`; it gives up after ten times `--max-skill-files` entries (20,000 by default) and says how to narrow the search. A skill that the repository mirrors in several places is installed once, from the plainest path. A local folder keeps the narrower search (two levels, no dot-folders). With `add --all`, a folder whose name cannot be written as a valid sub-path (for example `my skill` or `x@y`) is skipped and reported, and never recorded.

**Pins and moved repositories.** `sync` installs the commit the lockfile pins. If the host refuses to serve a commit by its hash, skillwharf clones the branch or tag the manifest names (the default branch if it names none) and accepts the result only if HEAD is exactly the pinned commit; otherwise it refuses (a manifest that names a commit itself has no fallback). A lockfile written by 0.1.x for a skill that contains links inside its repository still syncs: if the content with links resolved does not match the pinned hash, skillwharf tries the 0.1.x rule (links left out) and installs that if it matches. If a repository moved, skillwharf does not follow redirects: when it cannot be reached it says "repository not found or no access at <url>" and names the fix, `skillwharf update <name> --source <new>`, which points one skill at its new home and re-pins it.

## Development

```
npm install
npm run dev -- list      # run from source
npm test
npm run build
```

MIT

## Known limits

- Usage tracking reads Claude Code's local logs only; Codex and Cursor do not expose comparable ones.
- Windows without Developer Mode falls back to copying instead of symlinking; `doctor` flags the copies.
- The default registry is a starter list; it is schema-checked, not reviewed. So is any registry you add: it is trusted to its schema, not reviewed.
- An https registry URL is fetched without credentials. A registry that needs a login belongs in a git location (git fetches it with your credentials) or in a local checkout.
- skillwharf runs `git` and honours your git configuration: credential helpers, ssh configuration (including host-key prompts, which come from ssh) and URL rewrites are yours to manage. In an ssh URL only the user `git` may be written; any other user comes from your ssh configuration.
- A repository that moved is not followed through redirects; use `skillwharf update <name> --source <new>`.
- Submodules are followed one level only; a submodule that has submodules of its own is refused.
- A git call that runs longer than 120 seconds (`--git-timeout`) is killed.
- The size cap applies to the skill folder that is installed, not to the `git clone` (or a submodule fetch) that fetches it.
- There is no central approval or audit step; changes to skills are reviewed through the pull requests that change `skillwharf.json` and the lockfile. If you commit the store folder (`.skillwharf/skills`), a change to it is not in those files: `sync` does not re-check a store folder that is already there, and only `skillwharf doctor` compares it with the lockfile.
- skillwharf looks for `skillwharf.json` upward from the working directory, stops at your home directory (it never finds a manifest there) and does not climb into a folder you do not own. If none is found, the working directory is the project root, so run skillwharf inside the project: with the working directory at `~`, `~` is the root and its store coincides with the global store. A project that lives directly in your home directory is not found from below it.
- skillwharf does not review a skill's content — read a `SKILL.md` before installing it, as you would a shell script.

## Security

[SECURITY.md](SECURITY.md) has the threat model, what skillwharf enforces and how to report a problem.
