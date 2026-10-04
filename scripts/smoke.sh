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

echo "== --help names where skills come from"
help_out="$($bin --help)"
grep -q "Where skills come from:" <<< "$help_out"
grep -q "gitlab:group/repo//dir" <<< "$help_out"

echo "== registry help is offline and lists every spelling"
reg_help="$(cd "$tmp" && $bin registry help)"
for spelling in "github:" "gitlab:" "bitbucket:" "git+https://" "git+ssh://" "skillwharf registry add" "index.json"; do
  grep -q -- "$spelling" <<< "$reg_help"
done

echo "== init shows the one-time hint on stderr, once"
init_err="$(cd "$proj" && $bin init -a claude,codex,agents,cursor 2>&1 > /dev/null)"
grep -q "Skills come from any git host" <<< "$init_err"
test -f "$proj/skillwharf.json"
test -f "$SKILLWHARF_HOME/.skillwharf/hints.json"
proj2="$tmp/proj2"
mkdir -p "$proj2"
init_again="$(cd "$proj2" && $bin init -a claude 2>&1 > /dev/null)"
if grep -q "Skills come from any git host" <<< "$init_again"; then
  echo "the hint was shown twice" >&2
  exit 1
fi

echo "== registries you own: add, list, search, publish"
reg="$tmp/registry-checkout"
mkdir -p "$reg"
(cd "$proj" && $bin publish "$src" --registry "$reg" --source "gitlab:acme/platform/skills//demo" > /dev/null)
grep -q '"source": "gitlab:acme/platform/skills//demo"' "$reg/index.json"
(cd "$proj" && $bin registry add mine "$reg" > /dev/null)
reg_list="$(cd "$proj" && $bin --json registry list)"
grep -q '"name": "mine"' <<< "$reg_list"
grep -q '"status": "loaded"' <<< "$reg_list"
(cd "$proj" && $bin registry remove default > /dev/null)
search_out="$(cd "$proj" && $bin --json search demo)"
grep -q '"registry": "mine"' <<< "$search_out"
(cd "$proj" && $bin registry remove mine > /dev/null)

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
# Output is captured first: `cmd | grep -q` can make `cmd` die of SIGPIPE, which
# `pipefail` then reports as a failure.
where_out="$(cd "$proj" && $bin where demo)"
grep -q "^codex+agents" <<< "$where_out"
test "$(grep -c '\.agents/skills' <<< "$where_out")" = 1

echo "== list --json"
list_out="$(cd "$proj" && $bin list --json)"
grep -q '"name": "demo"' <<< "$list_out"

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

echo "== doctor is clean apart from usage (and the registries information line)"
# With --stale-days 0 every skill is "not used"; that and the one information
# line about registries are the only lines allowed.
# Without --allow-outside-paths doctor reports the outside source and does not open it.
doctor_plain="$(cd "$proj" && $bin doctor --stale-days 0 || true)"
grep -q "outside the project" <<< "$doctor_plain"
doctor_out="$(cd "$proj" && $bin doctor --stale-days 0 --allow-outside-paths)"
grep -q "not used" <<< "$doctor_out"
other="$(grep -v -e "not used" -e "registries: only the public registry" <<< "$doctor_out" || true)"
if [ -n "$other" ]; then
  echo "doctor printed more than the usage warning:" >&2
  echo "$other" >&2
  exit 1
fi

echo "== refuses a path source that is its own agent folder, and leaves it alone"
own="$tmp/own"
mkdir -p "$own/.claude/skills/mine"
printf -- '---\nname: mine\ndescription: my own\n---\n# mine\n' > "$own/.claude/skills/mine/SKILL.md"
(cd "$own" && $bin init -a claude > /dev/null)
printf '{"version":1,"agents":["claude"],"skills":{"mine":{"source":"path:./.claude/skills/mine"}}}\n' > "$own/skillwharf.json"
if (cd "$own" && $bin sync > /dev/null 2>&1); then
  echo "expected sync to refuse a source that is its own agent folder" >&2
  exit 1
fi
test -f "$own/.claude/skills/mine/SKILL.md"
test ! -e "$own/.skillwharf"

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
