# claude-errands reference

Every command, outcome, brief rule, file and limit. The [README](../README.md) covers the first run.

## Codex versions

claude-errands works with codex-cli 0.159.2, 0.162.1 or 0.163.0 with a Codex terminal session open (the e2e harness pins 0.163.0, and the protocol check passes on it): claude-errands talks to the managed daemon that session starts. On 0.162.1 the daemon refuses to list the turns of a session that has never run one, so claude-errands reads such a session without turns and it can take its first brief. Daemon discovery uses `lsof` and the `/private/tmp/codex-daemon-*` socket path, so it runs on macOS only.

## Commands

`node src/cli.ts <command> ...`

| Command | What it does | Exit code |
|---|---|---|
| `send <brief.md> [--target <target id>]` | Validates the brief, copies it, records the job, queues it to the session. Prints the job id. A target is a Codex thread id, `pi:<session id>` or `omp:<session id>`, as `targets` lists it. | 0 with the job id, once the session read as live and accepted the job; 1 on a rejected brief, a held worktree, a missing target, an unloaded Codex thread (status `notLoaded`), a pi or omp session that is not open, is open in two TUIs or refused the job, or a daemon error |
| `wait <job id> [--interval <seconds>] [--timeout <minutes>]` | Polls until the job's turn ends, then prints the outcome. Defaults: 30 seconds, 110 minutes. | 0 when it prints an outcome or `still running`; 3 when an approval stays pending for 5 polls in a row (the job stays open); 4 when a pi or omp brief has not appeared in its session for 5 polls in a row while that session reports nothing going (the job stays open); 1 when claude-errands itself fails (no daemon, no job record, job lost, job parked on an unloaded thread, a pi or omp job that has not started and whose session is gone) |
| `targets` | Lists the daemon's loaded threads with name, directory and first line of the preview, then the pi and omp sessions with name and directory. A session that cannot be read is listed with the reason, for example `pi-0123456789ab-4242.sock  (unreadable: not responding)`. | 0, including when no managed Codex daemon runs: then no Codex threads are listed. 1 when the Codex check or the pi/omp check failed. The sessions the other check found are printed first, then each failed check on stderr. |
| `nearby <dir> [--quiet]` | Prints one JSON object listing the readable sessions whose directory is `<dir>` or inside it, and the checks that failed. See "nearby output" below. With `--quiet`, prints nothing on stdout. | Without `--quiet`: 0, including when nothing is listed or a check failed; 1 on an error, such as a missing `<dir>`, with the message on stderr. With `--quiet`: 0 when at least one session is listed; 2 when none is and no check failed; 1 when none is and a check failed, or on an error. |
| `setup-pi` | Links the plugin's pi/omp extension into pi and omp. See "pi and omp sessions" below. | 0; 1 when it refused a path for either agent |
| `abandon <job id>` | Marks a job's outcome as `abandoned` so its worktree can take another job. Does not stop the agent. A pi or omp job that has not started never starts: its session drops it, or `abandon` drops it when that session is gone. | 0; 1 if the job already has an outcome |

### nearby output

```json
{
  "sessions": [
    {"agent": "codex", "id": "01a1c577-...", "name": "Fix tests", "cwd": "/abs", "relativeCwd": ".", "status": "working", "turnStartedAt": "2026-11-10T13:00:00.000Z"},
    {"agent": "pi", "id": "pi:01a1c572-d7a3-74ae-83a7-a81395f4e714", "name": null, "cwd": "/abs/sub", "relativeCwd": "sub", "status": "idle", "turnStartedAt": null}
  ],
  "failed": [{"check": "codex", "reason": "<one line>"}]
}
```

- `agent` is `codex`, `pi` or `omp`.
- `id` is what `send --target` takes: a bare Codex thread id, or `pi:<session id>` / `omp:<session id>`.
- `status` is `idle`, `working`, or `needsApproval`: a Codex turn waits on an approval in its pane, an omp tool call waits on an approval or an omp `ask` question is open, or a pi extension dialog is open. `turnStartedAt` is when the running turn or run started, as an ISO 8601 time, `null` when idle.
- Sessions are sorted by `id`, and each `id` appears once. Two pi or omp TUIs open on one session are listed as one: `needsApproval` if either waits, else `working` if either works, else `idle`; `turnStartedAt` is the earliest among those with that status, and the name and directory are those of the TUI whose socket name sorts first. A session whose directory no longer exists is left out. A pi or omp session that does not answer within 1 second, or refuses the connection while its process still runs, is left out until it answers again.
- `failed` names each check that failed, `codex` or `pi/omp`, with its reason on one line, and is `[]` when none failed. A failed check means its sessions are unknown, not absent; the other check's sessions are still listed. No managed Codex daemon, or no `live/` directory, means no sessions of that kind, not a failure.

`send` refuses a thread whose working directory neither is the brief's worktree, a directory inside it, nor a folder that holds it, so a brief for one repository cannot land in a session working on another. `targets` shows each thread's directory. A brief that asks for a new worktree has stricter rules; see "A worktree Codex creates" below.

`send` without `--target` uses the thread that last took a job from the same Claude session (`CLAUDE_CODE_SESSION_ID`). A target given with `--target` that `send` refuses is not remembered. A remembered thread that later closes stays remembered, and `send` refuses it until `--target` names a live thread. With no remembered thread it fails and prints the `targets` listing. With `CLAUDE_CODE_SESSION_ID` unset, `--target` is required every time.

A `wait` on a job whose outcome is already recorded prints the recorded outcome and gathers nothing again. An outcome is stored once: a second `wait` that ends later, or one still running after `abandon`, prints the stored outcome.

When Claude runs `wait` as a background Bash command, it must pass `timeout: 7200000`: the Bash tool's default background limit is 30 minutes, and its maximum is two hours, which the 110-minute default stays under.

`send` holds the worktree with a lock file created exclusively, so two `send`s started at the same moment cannot both take it. A lock whose job has an outcome, or no record, is stale and is replaced.

Sample `wait` output, from a test run:

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

Outcomes: `done`, `question`, `declined` (the agent's declaration on the last line of its final answer), `unclassified` (no final answer or no valid `RESULT:` line), `failed` (the turn did not complete; its error is printed, with any failed checks on a worktree the agent was to create, in which case no change report is printed), `no-worktree` (the turn completed on a job whose worktree the agent was to create, and that worktree is missing or fails a check; the failed checks are the error, and no change report is printed). `Resumed after a Codex server restart: yes` is printed when a restart of the Codex daemon interrupted the job's turn and Codex continued the work in a new turn; the outcome and the final answer are that turn's. A Codex turn that reads interrupted with nothing continuing it is reported `failed` once it has read that way for 5 seconds. `Outside allow-list` lists paths changed since the job's base commit, committed or not, that match no entry of the brief's allow-list. When the job's branch took in commits from another branch, by a rebase or a merge, the paths outside the allow-list that are the same now as at the newest of those commits are listed under `Brought in from <branch> at <commit>, not counted against the allow-list` instead, and `Commits` leaves that branch's commits out. A path the agent changed again, committed or not, stays under `Outside allow-list`. Only commits that a local or remote-tracking branch already held when the brief was sent count, and only when the job's branch had no commits of its own past that branch's history at send time. Files from commits that reached `main` later, or taken in by a branch that had its own earlier commits rewritten by the rebase, stay under `Outside allow-list`. The heading is printed only when it has paths. `Modified before this job` lists paths that were already modified at send time and have the same working-tree and index content now.

## Brief format

```markdown
# Job: <one line>

## Worktree
<absolute path>
Branch: <branch name>

## Allowed paths
- src/relay/**
- test/relay/**

## Test command
`set -o pipefail; npm test 2>&1 | tail -40`

## Rules
<free text; may be empty>

## Work
<free text>
```

`send` rejects a brief when: the first line is not `# Job: <title>`; a section other than `Rules` is missing or empty; a heading appears twice; the worktree path is relative, or has a `.` or `..` part or a doubled `/`; the `Worktree` section has no `Branch:` line; an allow-list line is not `- <glob>`; an allow-list entry is absolute or contains `..`. It also rejects a worktree that does not exist, is not inside a git work tree, is not that repository's root directory (git reports paths from the root, and the globs must mean the same thing), or is on a different branch than the brief states. Uncommitted changes in the worktree are accepted and recorded.

The agent is not sent the brief author's words. It is told to read the job's copy of the brief, to work only in the job's worktree and run every command and git command there, and to end its final message with one of `RESULT: done`, `RESULT: question`, `RESULT: declined`.

### A worktree Codex creates

A Codex session started in a folder that holds more than one repository, such as a cs session root with a nested `repo/`, can take a brief for any of them. The brief then asks the agent to create a fresh git worktree for the job, with two more lines in `## Worktree`:

```markdown
## Worktree
<absolute path of the worktree the agent creates>
Branch: <new branch the agent creates there>
Repo: <absolute path of the repository's root>
Base: <commit, branch or tag the branch starts from>
```

`Repo:` and `Base:` come together or not at all, and `Repo:` must be an absolute path with no `.` or `..` part and no doubled `/`. Before anything is queued, `send` refuses such a brief, naming the value at fault, when:

- `Repo:` does not exist, is not inside a git work tree, or is not that repository's root;
- `Base:` does not name a commit in the repository. The commit id is recorded as the job's base commit, so a branch that moves after the send changes nothing;
- `Branch:` is not a valid branch name or already exists in the repository;
- the worktree path exists, a broken symlink included, or one of its parts is a broken symlink;
- the worktree path lies inside a git work tree that does not ignore it, because the new worktree would show there as untracked files. The error names the line to add to that repository's `.gitignore` or `.git/info/exclude`. claude-errands writes nothing into your repository;
- the thread's directory does not hold the repository, the worktree path, and the repository's common git directory (`git rev-parse --git-common-dir`). The Codex sandbox lets the agent write only inside the folder it works in, and `git worktree add` writes the new branch into the common git directory;
- the common git directory is the `.git` directory directly inside the thread's directory, or lies inside it as a submodule's does (`.git/modules/<name>`). The Codex sandbox keeps that directory read-only.

A worktree path that does not exist yet is made canonical through its nearest existing parent, so a symlink or a trailing slash still leads to the same lock. The job's message starts with the exact command, every value quoted for a POSIX shell:

```text
First create the job's worktree: git -C '<repo>' worktree add -b '<branch>' '<worktree>' '<base commit>'
```

When the turn ends, `wait` checks that the worktree exists and is the root of a git work tree, belongs to the job's repository, is on the job's branch, and descends from the base commit. If any check fails, a turn that failed is reported `failed` with its error and the failed checks, and a turn that completed is reported `no-worktree` with the failed checks as the error, both without a change report; otherwise the outcome is classified as for any job, with changes reported against the base commit. A follow-up brief for that worktree is an ordinary brief, sent to the same thread.

## Agent sessions in the same folder

The plugin's hooks module (`hooks/register.tsx`) runs `nearby` on the Claude session's project root (a `cd` in Claude's shell does not change it; `/cd` does) when the session starts, then 5 seconds after each check that found a session busy on a turn, 15 seconds after one that found no session and no failed check, and 60 seconds after any other: one that found only idle sessions, or one in which a check failed and no session was busy. This runs in every Claude Code session that loads the plugin. A new session shows within 15 seconds of opening when the last check found no session and no check failed, and within 60 seconds otherwise. A Codex session that closes leaves the line only when Codex unloads its thread, which took over 3 minutes in a test on 2026-10-19, so checking faster after a find gains nothing. A pi or omp session removes its socket when it quits, so it leaves the line at the next check, at most 60 seconds later. While a session is busy, the line shows a spinner before its name and how long the turn has run after its folder, for example `⠋ 01a1b2c3 (.) working 2m14s`; one waiting on you shows `needs approval` in the warning color instead, and an idle one shows `idle`, dim. While a Codex, pi or omp session works in that directory or below it:

- At the right end of the prompt footer, after the modes the footer already shows (such as `focus`), a line names each session and its folder. The line groups the sessions by agent in the order Codex, pi, omp, and each group starts with the agent's name in its own color: `Codex` in OpenAI green, `pi` and `omp` in the accent color of their own default dark theme. For example: `Codex 01a1b2c3 (.) idle  pi 01a1c572 (sub) idle, Write the docs (.) idle  omp 3f2a9c1e (web) idle`. One button for all open sessions follows the line: **↗ Work with Codex** while every open session is a Codex one, **↗ Hand off** otherwise. Its label is in the color of the agent when only one agent has sessions open, and in the default text color when more than one has. The footer's own modes stay as Claude Code draws them, and the plugin draws nothing above the prompt. Pressing the button starts a turn at once. If you typed something in the prompt, Claude plans how to split that task across the open sessions. With an empty prompt, Claude plans the work in progress, or says nothing is in progress and asks what to work on, offering the likely next tasks as choices. If the work is too small to split, Claude says so. The plan names what each brief covers and what Claude keeps, what can run at once and what must wait, and the rough size of each part. It allows one turn per session and one job per worktree, with `--target` on every send. Claude shows you the plan, then asks you to choose: send it as planned, change the split, or do it all here. Claude sends nothing until you answer. A plugin cannot send pasted text, images or `@file` mentions, and a draft starting with `/` or `!` could run as a command, so the button leaves such a draft in the box and a toast says why. An accepted prompt clears the draft; a dropped prompt leaves it in the box.
- The line shows names and folders on one line: control characters and line breaks become spaces, and a name or folder longer than 40 characters ends in `…`. A session without a name shows the first 8 characters of its id, after the `pi:` or `omp:` prefix. When two sessions of one agent show the same name, each gets the last 8 characters of its id. Commas separate the sessions of one agent and two spaces separate the agents, for example `Codex ⠋ api (services/api) working 1m02s, web (web) needs approval`. The line and its button appear in the terminal and the desktop app only.
- A click presses the button in the desktop app, and in the terminal only where the terminal reports clicks. No key presses it, because the footer never takes the keyboard focus. From the keyboard, run `/claude-errands:work-with-codex [task]`, described next. A failed check with no session listed shows no button.
- `/claude-errands:work-with-codex [task]` gives Claude the planning prompt the footer's button sends, with the text after the command as the task, for example `/claude-errands:work-with-codex add a --json flag to targets`. Claude Code names a plugin's commands after the plugin, so the command starts with `claude-errands:`. The task skips the button's draft checks, because Claude Code hands it to Claude as the command's own text. With no session listed, Claude says so in one line and does nothing else. It names each check that found no session and gives the reason of each check that failed, cut at 200 characters. Before the first check answers, Claude says so and asks you to run the command again in a few seconds. Each of these answers still takes one Claude turn. If the plugin's hook fails, Claude reads the task as a plain prompt and works on it.
- When a check finds sessions waiting for approval that the previous check did not, Claude Code sends one notification per agent through your notification channel, titled `Codex needs approval`, `pi needs approval` or `omp needs approval`, naming each such session of that agent by the label and folder the line shows for it, without its status, for example `01a1b2c3 (.)`. A session still waiting at the next check does not notify again; one that goes back to work and waits again does. The first check after the session starts, or after a failure of the check that lists a session, counts that session as new if it waits, so a failed check can repeat a notification rather than miss one. When a notification is not sent (notifications off, no terminal) or fails, a toast shows `claude-errands: <agent> needs approval: <sessions>` instead.
- Claude Code adds a plain text note beside your next message, naming each session's agent, target id and directory. It says you keep these sessions open to split the work with Claude. Before starting implementation work, Claude asks you once per task with a choice whether to hand it to one of these sessions or do it here, with the session it would go to first. Claude does not ask when you already said where the work goes, or for questions, reviews and one-line fixes, which it handles itself. Any other change to the code counts as implementation work. When work goes to a session, Claude plans, writes briefs with `claude-errands:brief` and reviews; the agent in that session writes the code. Claude sends with `claude-errands:send` and passes `--target <target id>` on every send. Claude shows you each brief and sends it in the same turn without asking again, because choosing the session is the approval. Claude never edits a worktree while an agent's job holds it, because claude-errands reports every change there as the agent's.

The note goes out only when the set of open sessions changes, and again after `/clear` or a compaction. When the sessions close, the next message carries a note saying so. A message that does not go through, such as one a `UserPromptSubmit` hook blocks, does not count, and the note goes with the next one. The system prompt stays the same, so opening or closing a session does not invalidate the prompt cache.

When a check fails, the prompt footer says why after its own modes and the line, in the warning color: `Codex check failed: <reason>` or `pi/omp check failed: <reason>` for one check, and `Agent check failed: <reason>` when `nearby` itself fails, which leaves every session unknown. Each warning is at most 80 characters. It keeps up to 60 characters of the reason, or 59 after `pi/omp check failed: `, and ends a longer reason in `…`. The button stays while the other check lists a session. With no session listed, `/claude-errands:work-with-codex` has Claude give the reason up to 200 characters. If Claude knew of sessions that the failed check lists, its next message carries a note that their state is unknown, one sentence per failed check, and the other check's sessions stay as named. With no session listed, that note ends with an instruction for Claude to do implementation work itself until a later note names an open session. If Claude knew of no session the failed check lists, it gets no note about the failure. With no session in the folder and no failed check, or before the first check answers, the plugin shows nothing.

Each check runs `node`, `ps` and `lsof`, reads each loaded Codex thread's name and folder, not its turns, and sends `hello` to each pi and omp socket in `live/`, waiting up to 1 second for each (see "pi and omp sessions" below). It leaves out the short-lived helper thread Codex starts to name a session, and threads a Codex session's own subagents run in. Three checks on 2026-10-19, before pi and omp detection, took 0.19 to 0.20 seconds each and about 0.2 seconds of CPU. `node` must be on the `PATH` that Claude Code started with.

When an organization manages Claude Code, compaction hooks run only for plugins listed in the managed settings. There Claude is not told again after a compaction until the open sessions change.

## pi and omp sessions

claude-errands lists live pi and omp sessions and sends them briefs through an extension it ships, `pi/claude-errands.ts`, which pi and omp load into their TUI. Tested with pi 1.5.1 and omp 18.18.6 on macOS.

`setup-pi` installs it. For each of `~/.pi/agent` and `~/.omp/agent` that exists, it creates `extensions/` inside when missing and symlinks `extensions/claude-errands.ts` to the plugin's `pi/claude-errands.ts`. It prints one line per agent:

- `linked`: the link was made, or a link to `pi/claude-errands.ts` at another path, such as an earlier install of the plugin, was replaced;
- `already links to`: the link is already there, and nothing changes;
- `skipped`: the agent's folder does not exist, and nothing is created.

Any other file, directory or symlink at the link path is left alone and named on stderr, and `setup-pi` exits 1 after it has handled the other agent. It has no `--force`; move the file away and run it again. After a change it tells you to run `/reload` in each open pi session and to restart each open omp session: omp has no command that reloads extensions.

The link points into the plugin's folder. Claude Code keeps an installed plugin in a folder named after its version, so after a plugin update the link still points at the earlier version's folder. Run `setup-pi` again after each update: it replaces its own link with one to the current folder.

The extension does nothing unless it runs in a pi or omp TUI with a terminal on stdout, as a main session, not an omp subagent. It does nothing in print, json or rpc runs and in other hosts. In a TUI, at session start it listens on `live/<agent>-<12 hex>-<pid>.sock` in the state directory, where `<pid>` is the agent's process id, and answers `hello` with the session's id, name, real working directory and status. pi's `/reload` and `/new` start a new extension instance on a new socket; omp keeps its socket across `/new`, and its `hello` then names the new session. On quit the extension removes its socket. It refuses to listen, and says why in a notification in the TUI, when `live/` is not a directory owned by you with mode 700, or when the socket path is longer than 103 bytes.

`targets` and `nearby` send `hello` to every socket in `live/` at once and wait 1 second for each answer:

- The connection is refused and the process the file name gives no longer exists, because it died without removing the socket: the file is removed and nothing is listed. Two Claude sessions may both try to remove the same file; that is not an error.
- The connection is refused while that process still exists, for example because it is stopped with Ctrl-Z and its queue of pending connections is full: listed as unreadable, `not accepting connections`, and kept. If a dead session's process id is reused by another process, its file is kept and listed this way until that process exits.
- No answer within 1 second, for example while the agent's event loop is busy: listed as unreadable, `not responding`, and kept.
- A closed connection, an error reply, a malformed reply, a reply naming another agent or instance than the file name, or a session id its agent would not accept: listed as unreadable with the reason, and kept. pi accepts letters, digits, `.`, `_` and `-`, starting and ending with a letter or digit; omp accepts 1 to 128 letters, digits, `_` and `-`.
- A file whose name is not `<pi|omp>-<12 hex>-<pid>.sock`: listed as unreadable with its path, and kept.
- `live/` that is not a directory owned by you with mode 700: the pi/omp check fails.

### Sending to pi and omp

`send --target pi:<session id>` (or `omp:`) checks the brief and the session's directory as for Codex, writes the job record with the exact message the agent gets, then asks the one TUI holding that session to take the job. Only the job id travels over the socket; the session reads the message from the job record, which only you can read. The session refuses, and `send` prints no job id, when the job record is missing, names another session, already has an outcome or has no message, when the session changed (for example after `/new`), or when another TUI has the same session open. Two TUIs on one session are refused before anything is recorded.

The session starts one brief at a time, in the order they arrived, when it is idle. A brief sent while you or another brief keeps it busy waits, and `wait` shows it as running. An omp run that leaves a background job going, such as a dev server or a test run, is not over until that job's result has woken the run and the run ends, so a brief sent meanwhile waits for it too. `wait` then prints "Job <id> is queued behind a background job in session <target>; it starts when that job's result ends the run, or, if the job is killed, after the next run in that pane." once, and keeps waiting. The brief has started once its exact text shows in the session as a user message, however long after it was handed over. It ends `failed` before that only when the agent rejects it, as omp can; it is never sent again. pi's sign-in failing (for example `invalid_grant` from Anthropic) is a failure in the provider: the brief starts and ends `failed` with pi's error.

A brief can be handed over and never show: pi refuses a prompt it has no credentials for and says so only in its own pane, and another extension can take the brief before the agent sees it. claude-errands cannot tell that from a session still preparing the brief, so it fails nothing. When the brief has not shown for 5 polls in a row (about two minutes at the default interval) while the session reports nothing going, `wait` prints "Job <id> was handed to the session at <time> and has not appeared in it yet.", then exits 4 and leaves the job open: "the brief has not appeared in session <target> for 5 polls in a row, and that session reports nothing going; look at that <agent> pane. The job is still open: run wait <job> again, or abandon <job> if it will never run". The session takes no other brief while it holds that one. After `abandon`, it lets go of the brief and starts the next one it has; if the brief shows up later after all, it runs untracked.

A brief the session dropped before it started, for example because the session changed with `/new`, never runs. `wait` reports it `failed` with the reason, and its worktree is free.

You can type into the session at any time. If you start a turn in the instant before the brief starts, both agents add the brief to your turn: omp at the next turn boundary, pi when your turn would stop. `wait` then reports `failed` with the error "the brief joined a run the person started; its final answer may not be the agent's answer to the brief", so check the answer and send the brief again if it is still needed. If you type into the brief's own run, the outcome also prints `Person typed into the session during the run: yes`. That line is a report only: the outcome is still decided by the agent's final message.

The outcome is the last assistant message of the run: completed, or `failed` with the provider's error, `interrupted` after Escape, or `output truncated`. While an omp tool waits for your approval, or an omp `ask` or a pi extension dialog waits for an answer, during the job's run, `wait` prints the waiting line once and exits 3 after 5 polls, naming the agent's pane. If the session's process dies while the brief runs, `wait` reports `failed`, "the <agent> session exited while the job ran; whether it finished is unknown". If it dies before the brief started, `wait` exits 1, saying the job runs only if that session opens again: a pi or omp TUI opened later on the same session (for example `pi --session <id>`) takes over the briefs still waiting and runs them in order. To run it elsewhere, `abandon` it and send again.

A Codex job cannot reach these sockets: Codex's sandbox refuses Unix socket connections unless the person allows the folder (measured with codex-cli 0.167.0).

## State

`${XDG_STATE_HOME:-~/.local/state}/claude-errands/`

- `jobs/<job id>.json`: the job record, mode 600: target, the exact message the agent is sent, brief paths, whether the worktree existed or the agent creates it (and then the repository), worktree, branch, base commit, content hashes of paths already modified at send time, the local and remote-tracking branches that held commits the base commit lacks at send time and the commit each pointed to, allow-list, Claude session id, time sent, delivery state (`sending`, `sent`, `unknown`, or `refused` for a job that never reached the queue call), and the outcome once captured.
- `jobs/<job id>.brief.md`: the copy of the brief the agent reads.
- `targets/<Claude session id>.json`: the remembered thread for that session.
- `locks/<hash of the worktree path>.json`: which job holds a worktree.
- `live/<pi|omp>-<instance>-<pid>.sock`: one Unix socket per open pi or omp TUI session that loaded the extension. The directory has mode 700.
- `agent-jobs/<job id>.json`: a pi or omp session's record of a job it took: its state (`queued`, `dispatching`, `running`, `ended`, `dropped`), the TUI instance that owns it, the message, its place in the queue, and how its run ended. Mode 600, in a directory with mode 700. `agent-jobs/<job id>.adopt` exists only while a TUI takes over a waiting job or `abandon` drops one.

## Limits

- `done` is the agent's claim, not proof. Review the work.
- The outcome is captured up to one polling interval after the turn ends. Edits by anyone else in that window are attributed to the job.
- One job per worktree at a time. `send` refuses while another job on the same worktree has no outcome.
- A pending approval in the agent's pane is reported once as a `waiting on an approval` line while `wait` continues. When the approval is still pending on 5 polls in a row (about two minutes at the default interval), `wait` exits 3 and leaves the job open, so running `wait` again after the person answers is safe.
- A brief queued behind an omp background job waits for that run's end. When the background job ends without waking the run, for example after `/jobs kill`, the brief waits until the session's next run ends.
- A pi or omp brief that never shows in its session is never failed by claude-errands, since it cannot tell that from a brief still being prepared. `wait` exits 4 instead and the job stays open until someone runs `abandon`.
- claude-errands cannot tell whether another Claude session is using a thread. Choosing the target explicitly once per session is the guard.
- Two open jobs that create the same new branch at different paths are not caught at send time. The second `git worktree add` fails, and that job ends `no-worktree`.
- Another process that creates a job's new worktree path and branch between the send and the agent's `git worktree add` is not detected: the worktree passes every check, and that process's commits are reported as the job's. The agent's final answer would say its command failed.
- `send` refuses a thread whose status is `notLoaded`, with no job id: the daemon would accept the job into a queue nothing runs. It refuses no other status. Closing a Codex session does not unload its thread at once: the thread stays loaded and `idle` for about a minute, `send` accepts it, and the job runs with no pane to answer an approval. A thread that unloads in the milliseconds between that check and the queue call gets a job id, and `wait` then reports it as parked on an unloaded thread at its first poll.
- The closed-thread behaviour above is measured only on codex-cli 0.167.0, which is outside the versions this page lists as supported.
- A failed `send` does not prove the daemon rejected the job. The record is kept with delivery state `unknown`, the job is never sent twice, and `wait` reports what the daemon shows. `abandon` on a record a crashed `send` left at `sending` also records `unknown`.
