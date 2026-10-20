# Testing claude-errands

- `npm test`: unit tests for the brief parser, outcome classification, change report and job store. Real git, no network.
- `npm run protocol`: checks the daemon facts claude-errands depends on ("Protocol notes" in `docs/ARCHITECTURE.md`).
- `npm run e2e`: the seven end-to-end scenarios through the real `send`, `wait` and `nearby`. Writes a log under `test/results/`.
- `npm run mod`: checks the hooks module on a copy holding only `hooks/`, `types/` and the manifest: `claude plugin validate` (any error but the reserved-name one fails the check), `claude plugin test` on `hooks/register.test.tsx`, and `tsc` against the Claude Code API declarations. Claude Code unpacks those declarations under `/private/tmp/claude-<uid>/bundled-skills/<version>/` when a session of that Claude Code version loads the plugin-authoring skill.

The last two start real Codex on an isolated daemon under a temporary Codex home (`e2e` starts two in turn: one in the repository for scenarios 1 to 6, one in a git folder holding the repository, with no extra writable directory, for scenario 7), copy `~/.codex/auth.json` into it (mode 600, directory mode 700), use Codex quota, and stop every process under that home before deleting it. They never touch the live daemon.

## Working on the plugin

The repository is its own marketplace, `claude-errands-local`. Install from a clone:

```sh
claude plugin marketplace add /path/to/claude-errands
claude plugin install claude-errands@claude-errands-local
```

Claude Code then reads the plugin from the clone's working tree, and `/reload-plugins` picks up edits. The program itself is `node src/cli.ts`. Only the tests and the type check need `npm install`.

## Releasing

`scripts/release.sh` bumps the version, commits and tags. It needs `jq` and the macOS `sed`.

1. It stops if you have staged changes, because the version commit takes the whole index.
2. It runs `npm test` and `npm run check` and stops if either fails.
3. It stops if `.claude-plugin/plugin.json` and `package.json` name different versions.
4. It sets the new version in both files. Versions are `YYYY.M.BUILD`: `BUILD` goes up by one within a month and starts at 1 in a new month.
5. It commits the two files as `Bump version to <version>` and tags `v<version>`. It does not push; it prints the commands that do.

## Updating ws

The plugin runs `ws` from `vendor/ws` through the `#ws` import in `package.json`, so a marketplace install needs no `npm install`. `ws` also stays in `dependencies`, so `npm audit` and Dependabot see it. A Dependabot pull request that bumps `ws` fails `test/vendor.test.ts` until someone copies `vendor/ws` again with step 2. To move to another version:

1. Change the `ws` version in `package.json` and run `npm install`.
2. Replace `vendor/ws` with a copy of `node_modules/ws`: `rm -rf vendor/ws && cp -R node_modules/ws vendor/ws`.
3. Run `npm test`. `test/vendor.test.ts` fails while `vendor/ws/package.json` names a different version than `package-lock.json`.
