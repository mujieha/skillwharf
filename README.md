# skillwharf

**One manifest and lockfile, pinned to a full commit sha and a content hash, for the agent
skills (`SKILL.md` folders) your team shares.** `doctor` finds broken, foreign and drifted
installs; `usage` shows which skills Claude Code actually fires. skillwharf installs into
`.claude/skills` and the cross-tool `.agents/skills` (read natively by Codex and Cursor) by
default.

```
npm i -g skillwharf
skillwharf init
skillwharf add github:anthropics/skills/skills/mcp-builder
```

```
✔ mcp-builder  github:anthropics/skills/skills/mcp-builder@34040c9c5685
   claude       symlink  .claude/skills/mcp-builder
   agents       symlink  .agents/skills/mcp-builder
```

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
| `skillwharf add <source> [--name n] [--agents a,b] [--all] [--force]` | Install from `github:owner/repo[/path][@ref]`, a GitHub URL or a local path |
| `skillwharf remove <name>` | Unlink from agents and delete from the store |
| `skillwharf sync [--force]` | Make the store and agent folders match the manifest — run after `git clone` |
| `skillwharf update [names...]` | Re-fetch from source, refresh the lockfile, report what changed |
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
    "release-notes": { "source": "path:../shared-skills/release-notes", "agents": ["claude"] }
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

Add `.skillwharf/` and the agent folders (`.claude/skills`, `.agents/skills`, and `.cursor/skills` if you enabled `cursor`) to `.gitignore` if you prefer teammates to run `skillwharf sync`, which installs exactly the pinned commit and refuses content whose hash differs from the lockfile. If you commit them instead, `skillwharf doctor` reports any store folder that differs from the lockfile; `sync` does not re-check a folder that is already there. Commit real folders: skillwharf refuses to write through a store or agent folder that is a symlink.

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

On Windows without Developer Mode, symlinks fall back to copies; `skillwharf doctor` flags them.

## Usage tracking

`skillwharf usage` reads Claude Code's local session logs (`~/.claude/projects/**/*.jsonl`) and counts `Skill` tool calls and slash-command invocations. Nothing leaves your machine. Codex and Cursor do not expose comparable logs yet; contributions welcome.

## Registries

A registry is any git repo (or URL) serving an `index.json`:

```json
{ "version": 1, "skills": [
  { "name": "mcp-builder", "description": "Guide for creating MCP servers", "source": "github:anthropics/skills/skills/mcp-builder", "tags": ["mcp"] }
]}
```

Point a project at one with `skillwharf init --registry <url>` or `"registry"` in the manifest. The default registry (used when no `--registry` is given and the manifest sets none) may not exist yet — `search` reports that plainly rather than failing silently. Publish with `skillwharf publish ./my-skill --registry ../registry-checkout --source github:me/skills/my-skill`, then commit and push the checkout.

## Sources

| Form | Example |
| --- | --- |
| GitHub shorthand | `github:owner/repo/sub/dir@main` |
| GitHub URL | `https://github.com/owner/repo/tree/main/sub/dir` |
| Local path | `./skills/foo`, `../shared/foo`, `path:/abs/foo` |

GitHub sources are fetched with `git clone --depth 1`, so private repos work if `git` can already reach them.

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
- skillwharf does not review a skill's content — read a `SKILL.md` before installing it, as you would a shell script.

## Security

[SECURITY.md](SECURITY.md) has the threat model, what skillwharf enforces and how to report a problem.
