#!/usr/bin/env bash
# ABOUTME: Checks the claude-errands mod (hooks/, types/, the manifest) on a copy of its own:
# ABOUTME: claude plugin validate, claude plugin test, then tsc against this build's API declarations.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
claude_bin="$(command -v claude || echo "$HOME/.local/bin/claude")"
version="$("$claude_bin" --version | cut -d' ' -f1)"

shopt -s nullglob
declarations=(/private/tmp/claude-"$(id -u)"/bundled-skills/"$version"/*/plugin-authoring/types/claude-code.d.ts)
shopt -u nullglob
if [ "${#declarations[@]}" -ne 1 ]; then
  echo "check-mod: expected one claude-code.d.ts for Claude Code $version under /private/tmp/claude-$(id -u)/bundled-skills, found ${#declarations[@]}; load the plugin-authoring skill in a session of this version to unpack it" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# A copy holding only the mod, so claude plugin test does not run the node:test files under test/.
plugin="$work/plugin"
mkdir -p "$plugin/.claude-plugin"
cp "$root/.claude-plugin/plugin.json" "$plugin/.claude-plugin/"
cp -R "$root/hooks" "$root/types" "$plugin/"

echo "== claude plugin validate"
validate_status=0
report="$("$claude_bin" plugin validate --json "$plugin")" || validate_status=$?
if [ "$validate_status" -gt 1 ]; then
  echo "check-mod: claude plugin validate exited $validate_status" >&2
  exit 1
fi
if ! jq -e '(.manifest | type) == "object" and (.contents | type) == "array"' <<<"$report" >/dev/null; then
  echo "check-mod: claude plugin validate printed no report: $report" >&2
  exit 1
fi
# The validator refuses the claude- prefix for any plugin outside Anthropic's own marketplaces; renaming
# the copy would make the mod's $.state writes another plugin's, so that one refusal is let through.
jq -r '(.manifest.notes[], .contents[].notes[]) | "note: \(.)"' <<<"$report"
jq -r '(.manifest.warnings[], .contents[].warnings[]) | "warning: \(.path): \(.message)"' <<<"$report"
errors="$(jq -r '
  (.manifest.errors[] | select(.path != "name" or (.message | startswith("Plugin name \"claude-errands\" is reserved") | not))),
  .contents[].errors[]
  | "error: \(.path): \(.message)"' <<<"$report")"
if [ -n "$errors" ]; then
  echo "$errors" >&2
  exit 1
fi
echo "validate: no errors but the reserved name"

echo "== claude plugin test"
"$claude_bin" plugin test "$plugin"

echo "== tsc"
cp "${declarations[0]}" "$work/claude-code.d.ts"
cat >"$work/tsconfig.json" <<'JSON'
{
  "compilerOptions": {
    "target": "es2023", "lib": ["es2023"], "types": [],
    "module": "esnext", "moduleResolution": "bundler",
    "strict": true, "noUncheckedIndexedAccess": true,
    "noEmit": true, "skipLibCheck": true,
    "jsx": "react", "jsxFactory": "h", "jsxFragmentFactory": "Fragment"
  },
  "include": ["claude-code.d.ts", "plugin/hooks", "plugin/types"]
}
JSON
"$root/node_modules/.bin/tsc" -p "$work/tsconfig.json"
echo "tsc: no errors"
