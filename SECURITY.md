# Security

## Threat model

skillwharf writes into directories that coding agents read as instructions (`.claude/skills`, `.agents/skills`, `.cursor/skills`). A skill is therefore code-equivalent: installing one is like installing a dependency. The tool's job is to make sure that what lands there is exactly what you asked for, and nothing else.

## What skillwharf does

- **Validates every path component.** Skill names, GitHub owners/repos, git refs and repo sub-paths are checked against strict patterns before use, including values read back from `skillwharf.json` and `skillwharf.lock.json` (which teammates may edit by hand). A manifest that would write outside the store or the agent folders is rejected.
- **Never writes through a symlink inside the project.** Before any copy, write, link or delete in the store, an agent folder, the manifest or the lockfile, skillwharf checks every existing path component below the project root (the home directory for `--global`) and refuses if one is a symlink or resolves outside that root. A repository that commits `.skillwharf/skills` or `.claude` as a link cannot redirect writes elsewhere. The project root itself may be reached through a symlink.
- **Checks the lockfile against the manifest.** A lock entry's `resolved` must name the same GitHub owner, repo and sub-path as the manifest source, at a full 40-character commit, or the same local path. Anything else is refused, not fetched.
- **Never passes user input as a git option.** Refs that start with `-` are refused; git is invoked with `execFile` (no shell) and fixed argument order.
- **Drops symlinks from fetched skills.** A repo could otherwise ship a link to `~/.ssh` or another sensitive path into the agent's readable tree. Symlinks are skipped and reported on `add`.
- **Never replaces files it did not create.** `add` and `sync` refuse to overwrite an existing agent-side folder that skillwharf did not produce; `--force` is required. `remove` only deletes the exact link skillwharf would have written, a symlink resolving to the (non-symlink) store folder, or byte-identical copies. A store entry that is itself a symlink is never treated as installed.
- **Pins what you got.** The lockfile records the full commit sha and a sha256 over file paths, the owner-executable bit and bytes. `sync` fetches exactly that commit and refuses, without changing the lockfile, if it cannot be fetched (unless you pass `--allow-unpinned`) or if the content's hash differs from the lockfile. `doctor` flags local drift in folders already present.
- **Treats registries as untrusted data.** Index entries are schema-checked, names validated, sources must be GitHub sources, descriptions truncated; plain `http://` registries are refused; redirects are not followed.
- **Sanitises what it prints.** Strings from manifests, lockfiles, registries, SKILL.md files and logs are stripped of control characters (C0, C1, DEL) and bidirectional-override characters before they reach the terminal.
- **Sends nothing anywhere.** No telemetry, no accounts. `usage` reads Claude Code's local session logs only.

## Known limits

- **It does not review a skill's content.** Read a SKILL.md before installing it, as you would a shell script.
- **A compromised upstream at the ref you asked for is faithfully installed.** Pin commits in the lockfile and read `skillwharf update` output before trusting the result.
- **Copies do not follow updates.** On Windows without Developer Mode, symlinks fall back to copies. `doctor` reports them, but until the link is restored `update` only refreshes the store.
- **Usage tracking covers Claude Code only.** Codex and Cursor do not write comparable local logs, so a skill that fires only there shows as "never used".
- **Local path sources you type are trusted.** A path given to `skillwharf add` is yours by definition; skillwharf copies whatever is there, with symlinks removed, and does not check it further. A `path:` source read back from a project's manifest or lockfile must resolve inside the project (relative paths resolve against the project root); `sync` and `update` refuse one outside it unless you pass `--allow-outside-paths`. The global manifest in `~/.skillwharf` is yours, so its path sources are not confined.
- **Symlinked agent folders are refused, including in your home directory.** If `~/.claude` or `~/.claude/skills` is a symlink (for example from a dotfiles manager), `--global` installs refuse to write through it.
- **The registry index is a list, not an endorsement.** Entries are schema-checked, not reviewed.

If any statement in this file is not true of the code, treat that as a vulnerability and report it.

## Supported versions

Only the latest published release is supported. Please update before reporting, if you can.

## Reporting

Please do not open a public issue for a vulnerability. Use GitHub's private vulnerability reporting on this repository (**Security → Report a vulnerability**) and include a reproduction. You will get an acknowledgement within a few days and a fix or a reasoned answer as fast as the problem warrants.
