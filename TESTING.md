# Testing claude-errands

- `npm test`: unit tests for the brief parser, outcome classification, change report, job store, the pi/omp listing against real sockets whose peers answer badly, stop accepting connections or have died, two peers holding one session, and each host's session id rule, `send`, `wait` and `abandon` for pi and omp targets against sockets standing in for a session and real `agent-jobs` records (`test/agent-jobs.test.ts`), the extension's admission, merge and failure rules under a stand-in host replaying the event orders measured in pi and omp (`test/extension.test.ts`, about 35 seconds, since two tests wait out the 15-second admission limit), and `setup-pi` against a scratch `HOME`. Real git, no network.
- `npm run protocol`: checks the daemon facts claude-errands depends on ("Protocol notes" in `docs/ARCHITECTURE.md`).
- `npm run e2e`: the seven end-to-end scenarios through the real `send`, `wait` and `nearby`. Writes a log under `test/results/`.
- `npm run agents-e2e`: pi/omp detection and sending against the real pi and omp TUIs (`docs/ARCHITECTURE.md`, "Testing"). Writes a log under `test/results/`. Needs `pi` and `omp` on the `PATH`; tested with pi 1.5.1 and omp 18.18.6. Each TUI runs under `sh -c 'cat | exec script -q /dev/null …'`: `script` refuses Node's piped stdin, which is a socket pair (`tcgetattr/ioctl: Operation not supported on socket`), and `cat` turns it into a pipe. Each run uses `-e pi/claude-errands.ts` and `-e test/agents-e2e-probe.ts`, `--no-extensions` (omp) or `-ne` (pi), a scratch `--session-dir` and a scratch `XDG_STATE_HOME` under a `/tmp/ce-` folder, short enough for the 104-byte socket path limit. Most scenarios start runs with each agent's default model, so they cost model calls. On the machine they were written on pi's Anthropic sign-in is stale, so every pi run ends at once with the provider error the tests expect; with a working sign-in the pi scenarios still pass but make real calls, and `pi queue` checks for that error. `pi no credentials` points pi at an empty agent folder and leaves every variable whose name contains `_API_KEY`, `_TOKEN` or `_OAUTH` out of its environment, since pi otherwise falls back to `ANTHROPIC_API_KEY` and bills per token. omp's default model takes minutes per reply: `omp admission` aborts its brief with Escape once it starts, and `omp outcomes` waits up to 6 minutes each for an approval prompt and for a brief to complete. `omp outcomes` passes `--config` with a scratch `tools.approvalMode: always-ask` overlay, which leaves the person's omp config alone. The typed prompts in the lifecycle scenarios get up to 6 minutes to end; the omp one then gets Escape and the abort is checked instead, and the log says which happened. A print run gets 30 seconds to end on its own and is then killed. The script kills only the processes it started, found by walking down from the shell it spawned, and removes its folders.
- `npm run mod`: checks the hooks module on a copy holding only `hooks/`, `commands/`, `types/` and the manifest, with `mod-test/register.test.tsx` copied into the temporary plugin's `hooks/`: `claude plugin validate` (any error but the reserved-name one fails the check), `claude plugin test`, and `tsc` against the Claude Code API declarations. Claude Code unpacks those declarations under `/private/tmp/claude-<uid>/bundled-skills/<version>/` when a session of that Claude Code version loads the plugin-authoring skill.

The manifest's type contract is `types/index.d.ts`. It keeps the state declarations and domain types in one self-contained file. `claude plugin validate` rejects imports from another file, including `import type` and inline type references. Its output must include `declares state: claude-errands.agentsNearby, claude-errands.agentsTold`.

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
