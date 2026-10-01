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
- **A company with several teams.** Keep shared skills in repositories of your own. Private
  ones work too, as long as each person's `git` can already clone them (for example after
  `gh auth setup-git`). Each team's projects pin the skills they use, so one team can move
  to a new version with `skillwharf update` while another stays where it is. To make skills
  easy to find, keep an `index.json` registry (`skillwharf publish` adds entries to it) and
  point projects at it with `skillwharf init --registry <url>`.

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
| `skillwharf init [-a claude,agents,codex,cursor]` | Write `skillwharf.json`; the default agents are `claude,agents` |
| `skillwharf add <source> [--name n] [--agents a,b] [--all] [--force] [--max-skill-size mb] [--max-skill-files n]` | Install from `github:owner/repo[/path][@ref]`, a GitHub URL or a local path |
| `skillwharf remove <name>` | Unlink from agents and delete from the store |
| `skillwharf sync [--force] [--allow-unpinned] [--allow-outside-paths]` | Make the store and agent folders match the manifest — run after `git clone` |
| `skillwharf update [names...] [--allow-outside-paths]` | Re-fetch from source, refresh the lockfile, report what changed |
| `skillwharf list` | Skills, versions, agents, uses in the last 90 days |
| `skillwharf usage [--days 30] [--all-projects]` | Which skills actually fire, from Claude Code session logs |
| `skillwharf doctor [--stale-days 60]` | Broken links, local drift, skills nobody used |
| `skillwharf search <query> [--registry url]` | Search a registry `index.json` |
| `skillwharf publish <path> --registry <dir> --source <src>` | Add a skill to a registry checkout |
| `skillwharf where <name>` | Print every path a skill is installed at |

Add `-g` to any command to manage `~/.skillwharf` and the agents' global folders instead of a project.

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

On Windows without Developer Mode, symlinks fall back to copies. skillwharf records each copy it makes in the lockfile (`links`), and only a folder the lockfile records as a copy, and that still matches the store exactly, is treated as skillwharf's own; `skillwharf doctor` flags these copies. The `links` record is lockfile data that a teammate can edit: a forged record plus a folder that is byte-identical to the store (and is not the skill's own source) is the one case where a folder skillwharf did not create can be replaced or removed, and its content is recoverable from the store. A copy is recorded only when the skill has a lock entry.

## Usage tracking

`skillwharf usage` reads Claude Code's local session logs (`~/.claude/projects/**/*.jsonl`) and counts `Skill` tool calls and slash-command invocations. Nothing leaves your machine. Codex and Cursor do not expose comparable logs yet; contributions welcome.

## Registries

A registry is any git repo (or URL) serving an `index.json`:

```json
{ "version": 1, "skills": [
  { "name": "mcp-builder", "description": "Guide for creating MCP servers", "source": "github:anthropics/skills/skills/mcp-builder", "tags": ["mcp"] }
]}
```

Point a project at one with `skillwharf init --registry <url>` or `"registry"` in the manifest. The default registry (used when no `--registry` is given and the manifest sets none) is [mujieha/skillwharf-registry](https://github.com/mujieha/skillwharf-registry); if it cannot be reached, `search` says so plainly rather than failing silently. Publish with `skillwharf publish ./my-skill --registry ../registry-checkout --source github:me/skills/my-skill`, then commit and push the checkout.

## Sources

| Form | Example |
| --- | --- |
| GitHub shorthand | `github:owner/repo/sub/dir@main` |
| GitHub URL | `https://github.com/owner/repo/tree/main/sub/dir` |
| Local path | `./skills/foo`, `../shared/foo`, `path:/abs/foo` |

GitHub sources are fetched with `git clone --depth 1`, so private repos work if `git` can already reach them. Each folder name in a sub-path may use only letters, digits, `.`, `_` and `-`, and a symlink anywhere on the sub-path is refused. With `add --all`, a folder whose name cannot be written as a valid sub-path (for example `my skill` or `x@y`) is skipped and reported, and never recorded. A skill folder with more than 2,000 files and folders or more than 50 MB is refused; `--max-skill-files` and `--max-skill-size` (megabytes) raise the cap on `add`, `sync` and `update`.

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
- The default registry is a starter list; it is schema-checked, not reviewed.
- A registry URL is fetched without credentials, so a company registry must be reachable over https without a login, or used from a local checkout (`--registry <path>`).
- The size cap applies to the skill folder that is installed, not to the `git clone` that fetches it.
- There is no central approval or audit step; changes to skills are reviewed through the pull requests that change `skillwharf.json` and the lockfile. If you commit the store folder (`.skillwharf/skills`), a change to it is not in those files: `sync` does not re-check a store folder that is already there, and only `skillwharf doctor` compares it with the lockfile.
- skillwharf looks for `skillwharf.json` upward from the working directory, stops at your home directory (it never finds a manifest there) and does not climb into a folder you do not own. If none is found, the working directory is the project root, so run skillwharf inside the project: with the working directory at `~`, `~` is the root and its store coincides with the global store. A project that lives directly in your home directory is not found from below it.
- skillwharf does not review a skill's content — read a `SKILL.md` before installing it, as you would a shell script.

## Security

[SECURITY.md](SECURITY.md) has the threat model, what skillwharf enforces and how to report a problem.
