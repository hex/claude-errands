#!/bin/bash
# ABOUTME: Bumps the plugin version in plugin.json and package.json, commits, and tags the release.
# ABOUTME: Refuses a pre-staged index, a red unit suite, or a type check failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${SCRIPT_DIR}/.."

PLUGIN_JSON=".claude-plugin/plugin.json"
PACKAGE_JSON="package.json"

# The version-bump commit carries the whole index, so an unrelated staged change would be swept into it.
if ! git diff --cached --quiet; then
    echo "Error: staged changes present. Commit or unstage them before releasing." >&2
    exit 1
fi

# Never tag a release on a red suite.
echo "Running unit tests and the type check before release..."
if ! npm test || ! npm run check; then
    echo "Error: tests or type check failed; aborting release." >&2
    exit 1
fi

CURRENT_VERSION=$(jq -r '.version' "$PLUGIN_JSON")
PACKAGE_VERSION=$(jq -r '.version' "$PACKAGE_JSON")
if [[ "$CURRENT_VERSION" != "$PACKAGE_VERSION" ]]; then
    echo "Error: $PLUGIN_JSON says $CURRENT_VERSION but $PACKAGE_JSON says $PACKAGE_VERSION." >&2
    exit 1
fi
echo "Current version: $CURRENT_VERSION"

# YYYY.M.BUILD: BUILD resets to 1 when the month rolls over.
TODAY_YEAR=$(date +%Y)
TODAY_MONTH=$(date +%-m)
IFS='.' read -r YEAR MONTH BUILD <<< "$CURRENT_VERSION"
if [[ "$YEAR.$MONTH" == "$TODAY_YEAR.$TODAY_MONTH" ]]; then
    NEW_VERSION="${YEAR}.${MONTH}.$((BUILD + 1))"
else
    NEW_VERSION="${TODAY_YEAR}.${TODAY_MONTH}.1"
fi
echo "New version: $NEW_VERSION"

# A one-line replacement keeps each file's own formatting.
for file in "$PLUGIN_JSON" "$PACKAGE_JSON"; do
    sed -i '' "s/\"version\": \"${CURRENT_VERSION}\"/\"version\": \"${NEW_VERSION}\"/" "$file"
    if [[ "$(jq -r '.version' "$file")" != "$NEW_VERSION" ]]; then
        echo "Error: could not set the version in $file." >&2
        exit 1
    fi
done

git add "$PLUGIN_JSON" "$PACKAGE_JSON"
git commit -m "Bump version to ${NEW_VERSION}"
git tag "v${NEW_VERSION}"

echo ""
echo "Released v${NEW_VERSION}: committed and tagged. Push with: git push && git push origin v${NEW_VERSION}"
