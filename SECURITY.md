# Security

## Threat model

skillwharf writes into directories that coding agents read as instructions (`.claude/skills`, `.agents/skills`, `.cursor/skills`). A skill is therefore code-equivalent: installing one is like installing a dependency. The tool's job is to make sure that what lands there is exactly what you asked for, and nothing else.

## What skillwharf does

- **Validates every path component.** Skill names, GitHub owners/repos, git refs and repo sub-paths are checked against strict patterns before use, including values read back from `skillwharf.json` and `skillwharf.lock.json` (which teammates may edit by hand). Each folder name in a sub-path may use only letters, digits, `.`, `_` and `-` (no `..`, no `.git`), because sub-paths are echoed in copy-paste commands. An `agentPaths` override must be relative, may not contain `..` or control or bidirectional-override characters, and may not start inside `.skillwharf` or `.git` (compared after Unicode folding). A manifest that would write outside the store or the agent folders is rejected.
- **Never writes through a symlink inside the project.** Before any copy, write, link or delete in the store, an agent folder, the manifest or the lockfile, skillwharf checks every existing path component below the project root (the home directory for `--global`) and refuses if one is a symlink or resolves outside that root. A repository that commits `.skillwharf/skills` or `.claude` as a link cannot redirect writes elsewhere. The project root itself may be reached through a symlink.
- **Checks the lockfile against the manifest.** A lock entry's `resolved` must name the same GitHub owner, repo and sub-path as the manifest source, at a full 40-character commit, or the same local path. Anything else is refused, not fetched.
- **Never passes user input as a git option.** Refs that start with `-` are refused; git is invoked with `execFile` (no shell) and fixed argument order.
- **Never follows a symlink in a fetched repository.** A link anywhere on a GitHub sub-path is refused: the sub-path is walked one component at a time and the result must lie inside the clone. Inside the skill folder, symlinks are not copied into the store and are reported on `add`; `.git` is skipped as well. A `SKILL.md` that is a symlink does not make a folder a skill, so its target is never read. A repo could otherwise reach `~/.ssh` or any local folder through a link.
- **Never replaces files it did not create.** `add` and `sync` refuse to overwrite an existing agent-side folder that skillwharf did not produce; `--force` is required. `add --all` checks every skill (name, store path, agent folders, size) before it writes the first one. A real folder counts as skillwharf's own copy only if it is exactly what copying the store folder produces: the same files byte for byte, the same folders, and no `.git`, symlink or special file anywhere in it. `remove` only deletes the exact link skillwharf would have written, a symlink resolving to the (non-symlink) store folder, or such an exact copy; anything else, including your own clone of the same repository, is left in place. A store entry that is itself a symlink is never treated as installed.
- **Pins what you got.** The lockfile records the full commit sha and a sha256 over file paths, the owner-executable bit and bytes of the regular files in the store folder. `sync` installs a skill that is missing from the store at exactly that commit, and refuses, installing nothing and leaving the lockfile unchanged, if the commit cannot be fetched (unless you pass `--allow-unpinned`), if the content's hash differs from the lockfile, or if the lock entry has no `integrity` hash (unless you pass `--allow-unpinned`, which installs the pinned commit unchecked and writes the hash it computed). A skill that has no lock entry yet is installed from its manifest source as it is now and then pinned. `sync` does not re-check a store folder that is already on disk; `doctor` flags local drift, a missing hash and symlinks in the store.
- **Treats registries as untrusted data.** Index entries are schema-checked, names validated, sources must be GitHub sources (with the sub-path rule above), descriptions truncated, and only the known fields of an entry are kept; plain `http://` registries are refused; redirects are not followed.
- **Sanitises what it prints.** Strings from manifests, lockfiles, registries, SKILL.md files, session logs and file paths are stripped of control characters (C0, C1, DEL) and bidirectional-override characters before they reach the terminal, including the strings in `--json` output.
- **Caps what it installs.** A skill folder with more than 2,000 files and folders or more than 50 MB is refused before anything is copied into the store. `--max-skill-files` and `--max-skill-size` (megabytes) raise the cap.
- **Sends nothing anywhere.** No telemetry, no accounts. `usage` reads Claude Code's local session logs only.

## Known limits

- **It does not review a skill's content.** Read a SKILL.md before installing it, as you would a shell script.
- **A compromised upstream at the ref you asked for is faithfully installed.** Pin commits in the lockfile and read `skillwharf update` output before trusting the result.
- **The lock pins a commit and a content hash, not a repository's history.** GitHub can serve commits that belong to a fork of a repository under the upstream's URL, so a commit sha alone does not prove it sits on that repository's own branches. The `integrity` hash is what ties the lock to the files you reviewed.
- **The size cap covers the installed folder, not the clone.** `git clone --depth 1` fetches the whole repository before the cap is checked on the skill folder inside it.
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
