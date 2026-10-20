# Changelog

This file lists the notable changes to claude-errands. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
`YYYY.M.BUILD` versions, where `BUILD` starts again at 1 each month.

## 2026.10.2

First public release.

### Features
- `send` checks a brief, records the job and queues it to a live Codex session. `wait` waits for that turn to end and prints the outcome: `done`, `question`, `declined`, `unclassified`, `failed` or `no-worktree`, with the job's commits, the changed paths outside the brief's allow-list, and whether the agent left anything uncommitted.
- `targets` lists the Codex sessions the daemon has loaded, `nearby <dir>` lists the ones working in a folder as JSON, and `abandon` frees a worktree held by a job.
- A brief with `Repo:` and `Base:` lines asks Codex to create a fresh worktree for the job. `send` refuses a worktree path that would show up as untracked files in a repository that does not ignore it, and names the line to add.
- The `brief` and `send` skills teach Claude to write a brief and to act on each outcome.
- A line above Claude's prompt names the Codex sessions open in the session's folder, with a **↗ Work with Codex** button. Pressing it has Claude plan how to split the work with those sessions and ask you before sending anything.
- While a Codex session works, that line shows a spinner and how long the turn has run, or `needs approval` when Codex waits on you. Other plugins' lines above the prompt still show.
- Claude gets a hidden note naming the open Codex sessions with your next message, only when they change, so the system prompt and its cache stay the same.
- `ws` ships inside the plugin, so it runs without `npm install`.
- Finding the Codex daemon stops after 5 seconds when `ps` or `lsof` hangs.
