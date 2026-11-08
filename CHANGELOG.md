# Changelog

This file lists the notable changes to claude-errands. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
`YYYY.M.BUILD` versions, where `BUILD` starts again at 1 each month.

## 2026.11.1

### Features
- The Codex line and the **↗ Work with Codex** button are now at the bottom right of the prompt footer: `Codex 01a1b2c3 (.) idle  ↗ Work with Codex`. A working session shows a spinner and its turn time, and one waiting on you shows `needs approval`.
- When a Codex session starts waiting for approval, you get a native notification, or a toast if Claude Code can't send one.
- `/claude-errands:work-with-codex [task]` starts the same planning turn as the button, from the keyboard.
- With a Codex session open, Claude asks whether to hand implementation work to Codex or do it here. Pick Codex and it shows you the brief and sends it in the same turn. It doesn't ask for questions, reviews or one-line fixes, or when you already said where the work goes.
- `nearby <dir> --quiet` prints nothing and exits 0 when a session is open, 2 when none is, and 1 on an error.

### Fixes
- The Codex check no longer fails with `ENOENT` when Claude's shell is in a directory that no longer exists.
- `/reload-plugins` no longer hides open Codex sessions when Claude's shell is in a subfolder.

### Docs
- The README has examples, troubleshooting, support, the full text of the note Claude gets, and what leaves your machine. The banner shows the footer line.

### Removed
- The line above Claude's prompt. claude-errands draws nothing there now.

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
