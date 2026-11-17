# Changelog

This file lists the notable changes to claude-errands. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses
`YYYY.M.BUILD` versions, where `BUILD` starts again at 1 each month.

## 2026.11.7

### Added
- claude-errands lists live pi and omp TUI sessions beside Codex threads in `targets` and `nearby`. They report themselves through `pi/claude-errands.ts`, an extension pi and omp load, which answers `hello` on a socket in `<state dir>/live/`.
- `send --target pi:<session id>` and `omp:<session id>` send briefs to those sessions, and `wait` and `abandon` work on their jobs as on Codex jobs. The session queues each brief in `<state dir>/agent-jobs/`, starts it when idle, and records how its run ended. A brief that joins a run the person started is reported `failed`; typing into the brief's own run is reported, not counted against it. A brief the session took but has not shown stops `wait` with exit 4 and stays open, since only a rejection from the agent proves it will not run. A TUI opened later on a session whose process died takes over its waiting briefs.
- Job records are written with mode 600 and hold the exact message the agent is sent.
- `setup-pi` links that extension into `~/.pi/agent/extensions/` and `~/.omp/agent/extensions/`. It replaces only its own link and refuses any other file there.
- `npm run agents-e2e` checks detection and sending against the real pi and omp TUIs.
- `wait` says once when an omp job is queued behind a background job in its session, such as a dev server an earlier run started, and keeps waiting. The job starts when that run ends.

### Changed
- `nearby` prints `{"sessions": [...], "failed": [...]}` instead of a bare array. Each session names its `agent`, sessions are sorted by `id`, and a failed Codex or pi/omp check is listed in `failed` while the other check's sessions are still shown. With `--quiet` it exits 1 when nothing is listed because a check failed.
- `targets` lists pi and omp sessions after the Codex threads. When a check fails it prints what the other found, then the failure on stderr, and exits 1. With no managed Codex daemon it no longer fails; it lists what else it finds.
- The footer line shows pi and omp sessions after the Codex ones, each agent's name in its own color. The button reads **↗ Hand off** when a pi or omp session is open, and **↗ Work with Codex** when only Codex sessions are.
- A failed Codex or pi/omp check shows its own warning in the footer and leaves the other check's sessions listed. `Agent check failed` means `nearby` itself failed.
- The approval notification names the agent: `Codex needs approval`, `pi needs approval` or `omp needs approval`.
- Claude's note lists every open session as `<agent> session <target id>`, so Claude offers pi and omp sessions too.
- `wait`'s approval stop names the agent's pane: Codex, pi or omp.

### Fixed
- The change report no longer lists files a rebase or merge brought in as outside the allow-list. A brief that told the agent to rebase onto `main` had every file `main` changed listed under `Outside allow-list`, and `main`'s commits listed as the job's. Those paths are now listed under `Brought in from <branch> at <commit>, not counted against the allow-list`, as long as they are the same as at that commit. A path the agent changed again is still `Outside allow-list`. Only commits a branch already held when the brief was sent count, so files from commits that reached `main` after the send stay under `Outside allow-list`. So does everything when the job's branch had earlier commits of its own that the rebase rewrote. The job record now holds each branch ahead of the base commit and where it pointed, and a job sent before this change reports as before.
- `wait` follows a Codex job through a daemon restart. A restart, such as `codex app-server daemon restart`, interrupts the running turn and Codex continues the work in a new turn; `wait` used to report the job `failed` with `turn status interrupted` while Codex kept working in its worktree. It now waits for the turn that resumed the job, reports how that turn ended, and prints `Resumed after a Codex server restart: yes`. An interrupted turn that nothing resumed is reported `failed` once it has read that way for 5 seconds.
- A failed turn on a job that creates its worktree is reported `failed` with the turn's error and the failed worktree checks; `no-worktree` applies when the turn completed.

## 2026.11.6

### Fixes
- `send` refuses a Codex thread that has closed (status `notLoaded`) and prints no job id. The daemon would accept the job into a queue nothing runs.
- `wait` stops with an error when a job sits in the queue of a closed thread, and says what you can do with it. It reports a job that neither a queue nor a turn holds as lost.
- `wait` exits 3 when an approval stays pending for 5 polls in a row, about two minutes at the default interval. The job stays open, so `wait` can run again once you've answered in the Codex pane.
- `send` remembers a target only after a thread takes the job, so a thread it refused isn't used for the next send.
- `abandon` on a record a crashed `send` left at `sending` now records the delivery as `unknown`.

### Docs
- A closed session's thread stays loaded for about a minute after you quit it (measured on codex 0.167.0, on threads with no turns). `send` still accepts it in that time, and the job runs with nobody at the pane. The README, the reference and the send skill say so now.
- The brief skill says to name the lint diagnostics an agent may run when a brief limits it to the test command.

## 2026.11.5

### Docs
- The README's Privacy section, which 2026.11.4 linked through `privacyPolicyUrl` but left out, is now in the README.

## 2026.11.4

### Docs
- The README has a Privacy section: what stays on your machine and for how long, what goes to OpenAI through your Codex account, and that the plugin has no telemetry. `plugin.json` links it through `privacyPolicyUrl`.

## 2026.11.3

### Docs
- `plugin.json` now links the reference docs through `documentationUrl`, so the Claude directory listing shows them.

## 2026.11.2

### Other
- The footer's animated line now uses a plain `Client` element and the mod's tests live in `mod-test/`, so the plugin passes the Claude directory's checks. Nothing changes in how the plugin works.

### Docs
- The README says which programs the plugin runs and why, what its prompt hooks add, what the **↗ Work with Codex** button's prompt carries, and which environment variables it reads.

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
