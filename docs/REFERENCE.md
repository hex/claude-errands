# claude-errands reference

Every command, outcome, brief rule, file and limit. The [README](../README.md) covers the first run.

## Codex versions

claude-errands works with codex-cli 0.159.2, 0.162.1 or 0.163.0 with a Codex terminal session open (the e2e harness pins 0.163.0, and the protocol check passes on it): claude-errands talks to the managed daemon that session starts. On 0.162.1 the daemon refuses to list the turns of a session that has never run one, so claude-errands reads such a session without turns and it can take its first brief. Daemon discovery uses `lsof` and the `/private/tmp/codex-daemon-*` socket path, so it runs on macOS only.

## Commands

`node src/cli.ts <command> ...`

| Command | What it does | Exit code |
|---|---|---|
| `send <brief.md> [--target <thread id>]` | Validates the brief, copies it, records the job, queues it to the thread. Prints the job id. | 0 with the job id; 1 on a rejected brief, a held worktree, a missing target, or a daemon error |
| `wait <job id> [--interval <seconds>] [--timeout <minutes>]` | Polls until the job's turn ends, then prints the outcome. Defaults: 30 seconds, 110 minutes. | 0 when it prints an outcome or `still running`; 1 when claude-errands itself fails (no daemon, no job record, job lost) |
| `targets` | Lists the daemon's loaded threads with name, directory and first line of the preview. | 0 |
| `nearby <dir>` | Prints, as one JSON array, the readable threads whose directory is `<dir>` or inside it: `[{"id", "name", "cwd", "relativeCwd", "status", "turnStartedAt"}]`. `status` is `idle`, `working`, or `needsApproval` (a turn waits on an approval in the Codex pane); `turnStartedAt` is the running turn's start as an ISO 8601 time, `null` when idle. Prints `[]` when no managed Codex daemon runs. | 0; 1 on a daemon error |
| `abandon <job id>` | Marks a job's outcome as `abandoned` so its worktree can take another job. Does not stop the agent. | 0; 1 if the job already has an outcome |

`send` refuses a thread whose working directory neither is the brief's worktree, a directory inside it, nor a folder that holds it, so a brief for one repository cannot land in a session working on another. `targets` shows each thread's directory. A brief that asks for a new worktree has stricter rules; see "A worktree Codex creates" below.

`send` without `--target` uses the thread last given with `--target` in the same Claude session (`CLAUDE_CODE_SESSION_ID`). With no remembered thread it fails and prints the `targets` listing. With `CLAUDE_CODE_SESSION_ID` unset, `--target` is required every time.

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

Outcomes: `done`, `question`, `declined` (the agent's declaration on the last line of its final answer), `unclassified` (no final answer or no valid `RESULT:` line), `failed` (the turn did not complete; the error is printed), `no-worktree` (a job whose worktree the agent was to create ended without it, or with one that fails a check; the failed checks are the error, and no change report is printed). `Outside allow-list` lists paths changed since the job's base commit, committed or not, that match no entry of the brief's allow-list. `Modified before this job` lists paths that were already modified at send time and have the same working-tree and index content now.

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

When the turn ends, `wait` checks that the worktree exists and is the root of a git work tree, belongs to the job's repository, is on the job's branch, and descends from the base commit. If any check fails the outcome is `no-worktree`; otherwise it is classified as for any job, with changes reported against the base commit. A follow-up brief for that worktree is an ordinary brief, sent to the same thread.

## Codex sessions in the same folder

The plugin's hooks module (`hooks/register.tsx`) runs `nearby` on the folder the Claude session started in (a `cd` in Claude's shell does not change it) when the session starts, then 5 seconds after each check that found a Codex session busy on a turn, 15 seconds after one that found no Codex session, and 60 seconds after one that found only idle sessions or failed, in every Claude Code session that loads the plugin. A Codex session shows within 15 seconds of opening. One that closes leaves the line only when Codex unloads its thread, which took over 3 minutes in a test on 2026-10-19, so checking faster after a find gains nothing. While a Codex session is busy, the line shows a spinner before its name and how long the turn has run after its folder, for example `⠋ 01a1b2c3 (.) working 2m14s`; one waiting on an approval in its pane shows `needs approval` in the warning color instead. While a Codex session works in that directory or below it:

- A line on the right above the prompt names each session and its folder, for example `Codex session in this folder: 01a1b2c3 (.)`, in OpenAI green, followed by one **↗ Work with Codex** button for all open sessions. What other plugins draw above the prompt stays, above this line. Pressing it starts a turn at once. If you typed something in the prompt, Claude plans how to split that task across the open sessions. With an empty prompt, Claude plans the work in progress, or says nothing is in progress and asks what to work on, offering the likely next tasks as choices. If the work is too small to split, Claude says so. The plan names what each brief covers and what Claude keeps, what can run at once and what must wait, and the rough size of each part. It allows one turn per thread and one job per worktree, with `--target` on every send. Claude shows you the plan, then asks you to choose: send it as planned, change the split, or do it all here. Nothing is sent until you answer. A plugin cannot send pasted text, images or `@file` mentions, and a draft starting with `/` or `!` could run as a command, so the button leaves such a draft in the box and a toast says why. An accepted prompt clears the draft; a dropped prompt leaves it in the box.
- The line shows names and folders on one line: control characters and line breaks become spaces, and a name longer than 40 characters ends in `…`. When two sessions show the same name, each gets the last 8 characters of its thread id.
- Claude gets a hidden note with your next message, naming each thread id and directory. It says you keep these Codex sessions open to split the work with Claude. Claude plans, writes briefs with `claude-errands:brief` and reviews; Codex writes the code. Claude hands implementation work that fits a brief to Codex unless you ask to do it here, sends with `claude-errands:send` and passes `--target <thread id>` on every send. Claude shows you each brief before sending it and never edits a worktree while a Codex job holds it, because claude-errands reports every change there as the agent's.

The note goes out only when the set of open Codex sessions changes, and again after `/clear` or a compaction. When the sessions close, the next message carries a note saying so. A message that does not go through, such as one a `UserPromptSubmit` hook blocks, does not count, and the note goes with the next one. The system prompt stays the same, so opening or closing a Codex session does not invalidate the prompt cache.

When `nearby` fails, the line above the prompt says why, in the warning color (`claude-errands: Codex check failed: <reason>`, the reason cut at 200 characters). If Claude knew of open sessions, its next message carries one note that their state is unknown and that it should do the work itself until a later note names an open session; otherwise Claude gets no note. With no Codex session in the folder, the plugin shows nothing.

Each check runs `node`, `ps` and `lsof`, and reads each loaded Codex thread's name and folder, not its turns. It leaves out the short-lived helper thread Codex starts to name a session, and threads a Codex session's own subagents run in. Three checks on 2026-10-19 took 0.19 to 0.20 seconds each and about 0.2 seconds of CPU. `node` must be on the `PATH` that Claude Code started with.

When an organization manages Claude Code, compaction hooks run only for plugins listed in the managed settings. There Claude is not told again after a compaction until the Codex sessions change.

## State

`${XDG_STATE_HOME:-~/.local/state}/claude-errands/`

- `jobs/<job id>.json`: the job record: target, brief paths, whether the worktree existed or the agent creates it (and then the repository), worktree, branch, base commit, content hashes of paths already modified at send time, allow-list, Claude session id, time sent, delivery state (`sending`, `sent`, `unknown`), and the outcome once captured.
- `jobs/<job id>.brief.md`: the copy of the brief the agent reads.
- `targets/<Claude session id>.json`: the remembered thread for that session.
- `locks/<hash of the worktree path>.json`: which job holds a worktree.

## Limits

- `done` is the agent's claim, not proof. Review the work.
- The outcome is captured up to one polling interval after the turn ends. Edits by anyone else in that window are attributed to the job.
- One job per worktree at a time. `send` refuses while another job on the same worktree has no outcome.
- A pending approval in the Codex pane is reported once as a `waiting on an approval` line while `wait` continues.
- claude-errands cannot tell whether another Claude session is using a thread. Choosing the target explicitly once per session is the guard.
- Two open jobs that create the same new branch at different paths are not caught at send time. The second `git worktree add` fails, and that job ends `no-worktree`.
- Another process that creates a job's new worktree path and branch between the send and the agent's `git worktree add` is not detected: the worktree passes every check, and that process's commits are reported as the job's. The agent's final answer would say its command failed.
- A failed `send` does not prove the daemon rejected the job. The record is kept with delivery state `unknown`, the job is never sent twice, and `wait` reports what the daemon shows.
