#!/usr/bin/env bash
# Exercises the built CLI end to end with a local skill source and a throwaway
# HOME. Fails on the first unexpected result. Run after `npm run build`.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
bin="node $root/dist/cli.js"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export SKILLWHARF_HOME="$tmp/home"
mkdir -p "$SKILLWHARF_HOME/.claude"

src="$tmp/src/demo"
mkdir -p "$src"
printf -- '---\nname: demo\ndescription: smoke test skill\nversion: 0.1\n---\n# demo\n' > "$src/SKILL.md"

proj="$tmp/proj"
mkdir -p "$proj/.cursor"

echo "== --help"
$bin --help > /dev/null

echo "== init"
(cd "$proj" && $bin init -a claude,codex,agents,cursor > /dev/null)
test -f "$proj/skillwharf.json"

echo "== add"
(cd "$proj" && $bin add "$src" > /dev/null)
test -f "$proj/.skillwharf/skills/demo/SKILL.md"
test -f "$proj/.claude/skills/demo/SKILL.md"
test -L "$proj/.agents/skills/demo"
test -L "$proj/.cursor/skills/demo"
test ! -e "$proj/.codex"
test ! -e "$proj/.cursor/rules"
grep -q '"integrity": "sha256-' "$proj/skillwharf.lock.json"

echo "== where lists .agents/skills once for codex+agents"
(cd "$proj" && $bin where demo | grep -q "^codex+agents")
test "$(cd "$proj" && $bin where demo | grep -c '\.agents/skills')" = 1

echo "== list --json"
(cd "$proj" && $bin list --json | grep -q '"name": "demo"')

echo "== sync restores a fresh clone"
rm -rf "$proj/.skillwharf" "$proj/.claude" "$proj/.agents"
# the demo source lives outside the project, which a manifest may only use with explicit opt-in
if (cd "$proj" && $bin sync > /dev/null 2>&1); then
  echo "expected sync to refuse a path source outside the project" >&2
  exit 1
fi
(cd "$proj" && $bin sync --allow-outside-paths > /dev/null)
test -f "$proj/.claude/skills/demo/SKILL.md"
test -f "$proj/.agents/skills/demo/SKILL.md"

echo "== doctor is clean apart from usage"
(cd "$proj" && $bin doctor --stale-days 0 | grep -q "not used")

echo "== refuses a manifest that escapes the store"
cp "$proj/skillwharf.json" "$proj/skillwharf.json.bak"
sed 's/"demo"/"..\/..\/evil"/' "$proj/skillwharf.json.bak" > "$proj/skillwharf.json"
if (cd "$proj" && $bin list > /dev/null 2>&1); then
  echo "expected list to refuse the bad manifest" >&2
  exit 1
fi
mv "$proj/skillwharf.json.bak" "$proj/skillwharf.json"

echo "== remove"
(cd "$proj" && $bin remove demo > /dev/null)
test ! -e "$proj/.claude/skills/demo"
test ! -e "$proj/.agents/skills/demo"
test ! -e "$proj/.cursor/skills/demo"

echo "smoke: ok"
