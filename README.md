<img src="https://raw.githubusercontent.com/hex/claude-errands/main/assets/banner.svg" width="100%" alt="A terminal split into Claude Code and Codex: Claude hands a brief to Codex, Codex works in its own worktree and commits, and Claude wakes up to the outcome">

# claude-errands

A Claude Code plugin that hands a written brief to a live Codex session, waits for that turn to end, and reports how it ended. Claude plans and reviews. Codex does the work in its own session, where you see it and answer its approvals. For one-shot headless Codex tasks, use the `codex` plugin instead.

[Quick start](#quick-start) · [What it writes](#what-it-writes-and-what-it-never-does) · [Reference](docs/REFERENCE.md) · [Architecture](docs/ARCHITECTURE.md) · [Testing](TESTING.md)

## Quick start

You need macOS, git, Node 25 or newer on the `PATH` Claude Code starts with, and codex-cli 0.163.0.

1. Install the plugin in Claude Code:

   ```
   /plugin marketplace add hex/claude-marketplace
   /plugin install claude-errands
   ```

2. Start `codex` in the folder Claude Code runs in, or in a folder below it, and leave it open.

3. Within 15 seconds a line shows up above Claude's prompt:

   ```
   Codex session in this folder: 01a1b2c3 (.)  [ ↗ Work with Codex ]
   ```

   Press **↗ Work with Codex**, or ask Claude to hand a task to Codex.

## What happens next

Claude plans how to split the work: what goes to Codex, what Claude keeps, and what can run at the same time. It shows you the plan and asks before sending anything. If you typed something in the prompt before pressing the button, that is the task. If the work is too small to split, Claude says so.

Each part that goes to Codex becomes a brief: the worktree and branch to work in, the paths Codex may change, the test command, and the work. A brief can also ask Codex to create a fresh worktree for the job. Claude shows you each brief, sends it, and waits in the background.

While Codex works, the line above the prompt shows a spinner and how long the turn has run, or `needs approval` when Codex waits on you in its own pane. When the turn ends, Claude gets the outcome and reviews the work. From a test run:

```text
Job: errand-d6d4ad13-1a34-45a4-9242-d20cfc77e305
Outcome: done
Final answer:
Created `src/7e2f1224.txt` containing `7e2f1224` and committed as `1834ba1` with message `add 7e2f1224`. Test command passed. Nothing pushed.

RESULT: done
Commits:
  1834ba1 add 7e2f1224
Outside allow-list:
  none
Modified before this job:
  none
Uncommitted changes: no
```

The outcome is `done`, `question` or `declined` when Codex says so on the last line of its answer. `done` is Codex's claim, so Claude still reviews the commits. Every command, outcome and brief rule is in the [reference](docs/REFERENCE.md).

## What it writes and what it never does

- It keeps its job records, a copy of each brief, the thread each Claude session sends to, and worktree locks under `${XDG_STATE_HOME:-~/.local/state}/claude-errands/`.
- It writes nothing into your repositories. Codex makes the changes, in the worktree the brief names.
- It talks only to the Codex daemon on this machine, over its local socket. Codex itself works as it always does.
- In every Claude Code session that loads it, it runs `node`, `ps` and `lsof` every 5 to 60 seconds to look for Codex sessions in that folder.
- When Codex sessions open or close, your next message carries a hidden note to Claude with each thread id and folder.
- The plugin tells Claude to show you every brief before it sends one.
- It never sends a job twice and never stops a Codex turn. `abandon` only frees the worktree for another job.

## More

- [docs/REFERENCE.md](docs/REFERENCE.md): every command, outcome, brief rule, file and limit.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): how it works and the Codex daemon facts it depends on.
- [TESTING.md](TESTING.md): the test suites, working on the plugin, and releasing.

A second transport for Google's `agy`, through its `Stop` lifecycle hook, does not exist yet. See "Second transport: agy" in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#second-transport-agy).

## License

MIT. See [LICENSE](LICENSE).
