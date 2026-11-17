# claude-errands: architecture

First written 2026-10-01; sections added later carry their own date.

## Purpose

Claude plans and reviews. A second coding agent builds in its own live, visible session. claude-errands is a Claude Code plugin that hands that agent a written brief, wakes Claude when the agent's turn ends, and tells Claude what kind of ending it was.

Version 1 drives Codex. The design keeps the Codex-specific part behind one small interface so a second agent (Google's `agy`) can be added without touching the rest.

## Success criteria

1. One command queues a brief to a named live Codex thread and returns a job id.
2. A second command, run as a background Bash task, ends when the job's turn ends and prints one of five outcomes with the agent's final answer verbatim.
3. A turn is reported as `done` only when the agent's final answer says so on its last line. `done` is the agent's declaration, not proof; Claude still reviews the work. A turn with no final answer, or no valid last line, is never reported as `done`.
4. Files the agent changed outside the brief's allow-list are listed in the outcome.
5. A brief missing its allow-list or test command is rejected before anything is queued.

## Out of scope

- Headless one-shot Codex runs. The installed `codex` plugin (1.0.6) already does these.
- Status posts to chat tools. If the agent should post one, the brief says so.
- The `agy` transport. Its shape is recorded under "Second transport" so the interface is designed against two real agents, but no `agy` code ships.
- Answering the agent's questions automatically, merging, pushing, or reverting anything.

## Facts measured before design

Codex 0.159.2, managed daemon, read-only probes on 2026-10-01:

- `thread/read` with `includeTurns` returns every turn with `status`, `error`, and `items`.
- A turn's `userMessage` item carries the `clientId` given to `thread/queue/add`.
- `agentMessage` items carry `text` and `phase`. Observed phases: `commentary` and `final_answer`.
- Observed turn statuses: `completed` and `inProgress`.
- No item type marks a question to the user. A question is prose in the final message.
- The thread object has a `status` field. Observed value: `{"type":"idle"}`. Other values are not yet observed.
- Node 25.1.0 runs `.ts` files directly.
- `CLAUDE_CODE_SESSION_ID` is present in the environment of Claude's Bash tool.
- Claude's Bash tool stops a background command after 30 minutes by default and after two hours at most (`timeout: 7200000`); the `send` skill passes that maximum.

## Architecture

One repository, one plugin. A command-line program does the work; two skills teach Claude to use it.

```
claude-errands/
  .claude-plugin/plugin.json
  skills/brief/SKILL.md      how to write a brief, with the template
  skills/send/SKILL.md       how to send, wait, and act on each outcome
  src/cli.ts                 argument parsing, subcommands: send, wait, targets, nearby, abandon, setup-pi
  src/brief.ts               parse a brief file into a Brief, or reject it
  src/transport.ts           the Transport interface and TurnState type
  src/codex.ts               Codex implementation of Transport
  src/daemon.ts              client for the Codex daemon socket
  src/agents.ts              pi and omp implementation of Transport, through their extension sockets and agent-jobs/
  pi/claude-errands.ts       extension pi and omp load: answers hello and send on a socket in live/, runs queued jobs
  src/job.ts                 job records and the remembered target
  src/outcome.ts             turn state plus git facts to an Outcome
  src/changes.ts             files changed since the job's base commit, checked against the allow-list
  test/e2e.ts                end-to-end run against a real daemon
  test/agents.e2e.ts         end-to-end run against the real pi and omp TUIs
  README.md
```

Dependency direction: `cli` depends on everything; `outcome` depends on `transport` types and `changes`; nothing depends on `cli`. Only `codex.ts` and `daemon.ts` know Codex exists, and only `agents.ts` and the extension know pi and omp exist. `pi/claude-errands.ts` imports nothing from `src/`: pi and omp load it alone, through a symlink, with two different loaders (pi on Node, omp on Bun), so it repeats `stateDir()`'s two-line rule.

The one runtime dependency is `ws`, already used by the code this is derived from.

### Transport interface

```ts
type TurnState =
  | { kind: 'queued' }
  | { kind: 'queuedBehindBackgroundJob' }
  | { kind: 'running' }
  | { kind: 'waitingOnApproval' }
  | { kind: 'lost' }
  | { kind: 'closed'; reason: string }
  | { kind: 'dropped'; reason: string }
  | { kind: 'notAdmitted'; dispatchedAt: string }
  | { kind: 'ended'; status: 'completed' | 'failed'; finalMessage: string | null; error: string | null; userIntervened?: true }

type Transport = {
  send(target: string, jobId: string, text: string): Promise<void>
  poll(target: string, jobId: string): Promise<TurnState>
  targets(): Promise<Target[]>
  liveCwd(target: string): Promise<string>
  abandon(target: string, jobId: string): Promise<void>
}
```

Two implementations: `codex.ts` and `agents.ts`. `send` picks one from the target: `pi:<session id>` and `omp:<session id>` go to `agents.ts`, a bare thread id to Codex. The job record stores `transport` (`codex`, `pi` or `omp`), and `wait` and `abandon` pick the implementation from it. A `closed` state carries the sentence `wait` prints after "has not started and", since what would still run the job differs per agent. Only `agents.ts` returns `dropped`, a job its session let go before it started, and `notAdmitted`, a brief its session holds and has not shown while reporting nothing going (see "Poll" under "pi and omp sessions"), and `queuedBehindBackgroundJob`, a job queued in an omp session whose run waits on a background job. `abandon` is called after the job's outcome is settled; Codex's does nothing, because the daemon cannot remove a queued submission.

### Codex transport

- **Daemon discovery.** The Codex home is `$CODEX_HOME` when set, otherwise `~/.codex`. Find the one process under `<Codex home>/packages/app-server-daemon/` started with `--managed-daemon`, then the one `codex-daemon-` unix socket it holds. Zero or several of either is an error naming what was found.
- **liveCwd.** `thread/read` for the thread's `cwd`, throwing `TargetClosedError` when the thread's status is `notLoaded`. `send` makes this check before it records a job, and refuses a thread whose `cwd` is not the brief's worktree or inside it: a brief for one repository must not reach a session working on another.
- **send.** `thread/read` first, so an unreadable or unloaded (`notLoaded`) thread fails before anything is queued. Then `thread/queue/add` with the text and `clientUserMessageId` set to the job id.
- **poll.** Read `thread/queue/list` first, then `thread/read`. A job only moves from the queue to the turns, so reading in that order cannot miss a job that started between the two calls.
  - The thread's status is `notLoaded`, no turn has the job and the job is in the queue: `closed`. Nothing runs it unless the thread is resumed.
  - The job is in the queue: `queued`.
  - Not in the queue, and no turn has a `userMessage.clientId` equal to the job id: `lost`, on a `notLoaded` thread too, since resuming it would not run the job.
  - Turn status `inProgress`: `running`.
  - Turn status `completed`: `ended` with `status: 'completed'`.
  - Any other turn status: `ended` with `status: 'failed'` and the turn's `error` serialized.
  - `finalMessage` is the text of the last `agentMessage` with phase `final_answer` in that turn, or `null` when the turn has none. Commentary is never used in its place.
- **targets.** `thread/loaded/list`, then `thread/read` per thread for `name`, `cwd`, and `preview`.
- **waitingOnApproval.** The Codex transport returns it only if the first implementation task finds a thread or turn status value that marks a pending approval. That task triggers an approval prompt on a throwaway thread and records the `thread.status` and turn values seen. If no value marks it, the Codex transport never returns `waitingOnApproval` and the README says so.

`daemon.ts` is a small client for the managed daemon's protocol, about 150 lines, with no dependency beyond `ws`.

### Brief

A brief is a Markdown file with fixed headings. `brief.ts` parses it into a `Brief` value or throws with the heading at fault. No other code reads the file.

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
<free text: commit granularity, no push, paths that are off limits, and so on>

## Work
<free text: numbered findings or tasks>
```

Rejected before sending, each with a message naming the problem:

- a missing or empty `Job`, `Worktree`, `Allowed paths`, `Test command`, or `Work` section;
- a worktree path with a `.` or `..` part or a doubled `/` (a trailing `/` is accepted). Below its nearest existing parent a new worktree path is not resolved through the filesystem, and a `..` there could step back through a symlink that was never followed;
- a worktree path that does not exist, is not inside a git work tree, is not that repository's root (git reports paths from the root, so the brief's globs must be relative to it), or is on a different branch than the brief states;
- an allow-list entry that is absolute or contains `..`.

`Rules` may be empty.

A worktree with uncommitted changes is accepted, because a follow-up brief after a `question` outcome often starts from the agent's unfinished work. For each path that is modified or untracked at send time, the job record stores a content hash (`git hash-object`), or a marker that the path is deleted.

### A worktree Codex creates

Ruled 2026-10-19. A Codex session started in a folder that holds several repositories (a cs session root with a nested `repo/`) can take a brief for any of them. The agent creates a fresh git worktree for the job and works there. A brief that names an existing worktree keeps working as above.

Measured on codex-cli 0.163.0 with `codex exec -s workspace-write -C <session root>`, where the session root is a git repository and `repo/` is a nested one: `git -C repo worktree add ../worktrees/job1 -b job1`, then a write, `git add` and `git commit` inside `worktrees/job1`, all exit 0. The workspace sandbox keeps the `.git` of the folder Codex runs in read-only, not the `.git` of a repository nested below it.

A brief asks for a new worktree with two more lines in `## Worktree`:

```markdown
## Worktree
<absolute path of the worktree the agent creates>
Branch: <new branch the agent creates there>
Repo: <absolute path of the repository's root>
Base: <commit, branch or tag the branch starts from>
```

`Repo:` and `Base:` come together or not at all. The parsed brief holds a union, so code that needs the repository cannot run on a brief that has none:

```ts
type Workspace =
  | { kind: 'existing'; worktree: string; branch: string }
  | { kind: 'create'; repo: string; base: string; worktree: string; branch: string }
```

`send` checks a `create` brief before anything is queued, and refuses with the value at fault when:

- `Repo:` has a `.` or `..` part or a doubled `/`, does not exist, is not inside a git work tree, or is not that repository's root;
- `Base:` does not name a commit in the repository (`git rev-parse --verify <base>^{commit}`); otherwise the commit id is recorded as the job's base commit, so a branch that moves after the send changes nothing;
- `Branch:` is not a valid branch name (`git check-ref-format --branch`) or already exists in the repository;
- the worktree path exists, a symlink whose target is missing included, or one of its parts is such a broken symlink, which would send `git worktree add` somewhere else. The error names the symlink;
- the worktree path lies inside a git work tree where it is not ignored. A new worktree there would show up as untracked files in that repository. The check runs `git check-ignore` on the path with a trailing `/`, because the worktree will be a directory and a pattern such as `!dir/*/` treats a directory and a file differently; exit 1 is "not ignored", and any exit other than 0 or 1 is an error. The error names the repository and the line to add to its `.gitignore` or `.git/info/exclude`. claude-errands writes nothing into the user's repository;
- the target thread's directory does not hold the repository, the worktree path, and the repository's common git directory (`git rev-parse --git-common-dir`). The sandbox lets the agent write only at or below its own folder, and `git worktree add` writes the branch and the worktree's registration into the common git directory. A repository that is itself a linked worktree can keep that directory somewhere else;
- the common git directory is the `.git` directory directly inside the thread's directory, or lies inside it, as a submodule's does (`.git/modules/<name>`). The sandbox keeps that directory read-only (measured 2026-10-01 with Codex started inside the repository). The submodule case follows from that and was not measured.

A path that does not exist yet is made canonical through its nearest existing parent, so a symlink or a trailing slash still leads to one lock.

For an `existing` brief the thread check is relaxed the same way: the thread's directory may be inside the worktree, as before, or hold it. A follow-up brief for a worktree Codex created is an `existing` brief, sent to the same thread in the folder above.

The job record gets a `workspace` field: `{ kind: 'existing' }` or `{ kind: 'create', repo }`. A `create` job's baseline is the base commit with no modified paths, because a fresh worktree has none. The lock and the one-open-job rule use the worktree path for both kinds.

The message for every job names the worktree, because a thread above it starts in the wrong repository:

```
Work only in <worktree>; run every command and git command there.
```

A `create` job's message starts with the exact command, built by claude-errands from the validated fields:

```
First create the job's worktree: git -C <repo> worktree add -b <branch> <worktree> <base commit>
```

Every argument in it is quoted for a POSIX shell (wrapped in `'`, each `'` inside written as `'\''`). A path with spaces stays one argument, and a branch name git accepts, such as `job;printf`, is not run as a command.

When the turn ends, `wait` checks a `create` job's worktree before it reports changes. Each check that fails is named in the error:

- the path exists and is the root of a git work tree;
- that work tree belongs to the job's repository (`git rev-parse --git-common-dir` resolves to the repository's);
- it is on the job's branch;
- the base commit is an ancestor of its `HEAD`.

If any check fails, a turn that failed is reported `failed` with its error and the failed checks, and a turn that completed is reported `no-worktree` with the failed checks as the error; either way the final answer is kept verbatim and there is no change report. Otherwise the outcome is classified as for any job and changes are reported against the base commit.

Not covered: two open `create` jobs that name the same new branch at different paths. The second `git worktree add` fails, and that job ends `no-worktree`.

Not covered: another process that creates the same path and branch between the send and the agent's `git worktree add`. The agent's command then fails, yet the worktree passes every check, and the other process's commits are reported as the job's. This is the trust model claude-errands already has for an existing worktree, where edits by anyone else during a job cannot be told apart from the agent's. The agent's final answer would say the command failed.

`send` copies the validated brief to `jobs/<jobId>.brief.md` and the agent is pointed at that copy. The job record is built from the same copy, so the brief the agent reads is the brief that was validated, even if the author edits or deletes the original afterwards.

### What the agent is told

claude-errands sends this text, not the brief author's words, so the result protocol cannot be forgotten:

```
Read <absolute path of the job's brief copy> in full and do exactly what it says. This is job <jobId>.
End your final message with exactly one of these lines, alone on the last line:
RESULT: done
RESULT: question
RESULT: declined
Use "question" if you need an answer before you can finish, and "declined" if you chose not to do some or all of the work; in both cases say why above the line.
```

### Jobs and the remembered target

State lives under `${XDG_STATE_HOME:-~/.local/state}/claude-errands/`.

- `jobs/<jobId>.json`, mode 600: job id, transport, target, the exact message the agent is sent, original brief path, worktree, branch, base commit, hashes of paths already modified at send time, the branches ahead of the base commit at send time and the commits they pointed to, allow-list, Claude session id, time sent, delivery state, and the outcome once captured.
- `jobs/<jobId>.brief.md`: the brief copy the agent reads.
- `targets/<CLAUDE_CODE_SESSION_ID>.json`: the target last given with `--target` in that Claude session.

The record is written with delivery state `sending` before the transport's `send` is called, and becomes `sent` when it returns. A job refused before the queue call is settled with delivery state `refused`.

A failed `send` does not prove the daemon rejected the job: the response can be lost after the daemon accepted it. So the record is never deleted on failure. `send` polls once for the job id. If the job is in a live thread's queue or has a turn, delivery state becomes `sent` and `send` succeeds. Otherwise, including when the job is parked on a closed thread or that poll itself fails, it becomes `unknown`, and `send` exits non-zero printing the job id and the error. claude-errands never sends a job twice; `wait <jobId>` on an `unknown` job reports what the daemon shows. Whether Codex deduplicates on `clientUserMessageId` is not assumed.

A thread found closed (status `notLoaded`) is a refusal, not an unknown delivery: `thread/queue/add` accepts a job for a closed thread, so the `send` path has to look at the status itself. Found before the job is recorded, nothing is written. Found by the transport's read just before the queue call, the job is settled as `abandoned` with delivery state `refused`, which frees its worktree, and `send` exits non-zero with no job id. `notLoaded` is the only status refused: after its TUI exits, codex-cli 0.167.0 keeps the thread loaded and `idle` for about a minute (measured 2026-11-09 on threads with no turns, three runs, 49 to 63 s, the same after `/quit` and `kill -9`), and a job sent to it in that time runs with no pane to answer an approval. The daemon does not report whether a client has the thread open, and a TUI's command line and working directory do not identify its thread (`codex -C <dir>` keeps the launch folder as its process directory), so `send` does not try to tell. `wait`'s approval stop is what surfaces such a job. The status check and `thread/queue/add` are separate calls, so a thread that closes between them still gets a job id; `wait` reports that job as parked at its first poll.

One job per worktree at a time. `send` refuses when another job record for the same canonical worktree path has no captured outcome, naming that job. Two jobs editing one worktree cannot be told apart by git, so claude-errands does not allow it. `abandon <jobId>` marks a job's outcome as abandoned so the worktree can be used again; it does not stop the agent.

Job ids are `errand-<uuid>`.

`send` without `--target` uses the remembered target, which is written only after a thread takes the job, so a target `send` refuses with `--target` is not remembered. A remembered target whose thread later closes stays remembered, and `send` refuses it until `--target` names a live thread. With no remembered target it fails and prints the `targets` listing, so Claude can ask the person which thread to use. With `CLAUDE_CODE_SESSION_ID` unset, `--target` is required every time.

claude-errands cannot tell whether another session owns a thread. Choosing the target explicitly once per Claude session is the guard.

### Outcome

`wait <jobId>` polls every 30 seconds. When the turn state is `ended` it gathers git facts from the job's worktree and prints one outcome:

| Outcome | When |
|---|---|
| `done` | turn completed, last line is `RESULT: done` |
| `question` | turn completed, last line is `RESULT: question` |
| `declined` | turn completed, last line is `RESULT: declined` |
| `unclassified` | turn completed, no final answer or no valid `RESULT` line |
| `failed` | turn status was not `completed` |
| `no-worktree` | turn completed, and a `create` job's worktree is missing, belongs to another repository, is on another branch, or does not descend from the base commit |

The outcome is stored in the job record the first time it is captured. A later `wait` on the same job prints the stored outcome and gathers nothing again, so edits made after the capture are never attributed to the job. Edits by anyone else between the turn ending and the capture (at most one polling interval) cannot be told apart from the agent's; the README says so.

A `lost` state must be seen on three consecutive polls before `wait` exits non-zero with "job is in neither the queue nor the turns". Waiting forever on a lost job is not acceptable, and neither is giving up on one reading. A `closed` state is a definite reading, so `wait` exits non-zero on the first one, naming the thread.

A Codex daemon restart, such as `codex app-server daemon restart` or a daemon update, ends the running turn as `interrupted`. Codex then continues the work in a new turn, which holds no user message and names the interrupted turn as its `rootTurnId`. `poll` reports the last turn that names the job's turn, or a turn already followed from it, as its root in place of the job's own turn, so `wait` follows the job to the end of the turn that resumed it, takes the final answer from there, and prints `Resumed after a Codex server restart: yes`. An interrupted turn that nothing has continued is either one the person stopped or one whose continuation has not started yet, so `wait` reports it `failed` only once it has read that way, on every poll, for 5 seconds. A person who resumes an interrupted turn by hand starts a turn that is its own root; `wait` does not follow that one, and reports the job `failed`. The outcome is written once and frees the worktree, so a job reported `failed` while Codex still worked on it would let the next brief into the same worktree.

The `RESULT` line must be the last non-empty line of the final answer and match `^RESULT: (done|question|declined)$` exactly. Anything else is `unclassified`; claude-errands does not guess from the prose.

Every outcome also prints:

- the final answer verbatim, or a line saying the turn had none;
- the commits on the worktree's branch since the base commit, one line each;
- files changed since the base commit, committed or not, that match no allow-list entry, under the heading `Outside allow-list`;
- under `Brought in from <branch> at <commit>, not counted against the allow-list`, files outside the allow-list that came with another branch's commits. `send` records each local and remote-tracking branch that holds commits the base commit lacks, with the commit it points to. At capture, the upstream commit is the newest commit on the job's branch since the base that one of those recorded commits already held. It counts only when a recorded branch pointed at that very commit and the commit descends from the base commit. Then everything between the base and it is the other branch's and everything after it is the job's: a path that differs between the upstream commit and `HEAD` is a candidate for `Outside allow-list`, and a path that differs between the base and `HEAD` but is the same at the upstream commit and `HEAD` is listed here, unless it has an uncommitted change or was already modified at send time. Trees are compared, not commits, so an edit the agent makes inside a merge commit, on top of an upstream change, or to delete an upstream file stays under `Outside allow-list`, and the commits list leaves out the commits the upstream commit holds. Nothing counts as brought in, and every changed path is reported as before, when: the branches recorded hold none of the job's commits; the commits reached a branch after the send, since nothing in the commit graph tells a fetch from a push; the job sits on part of a recorded branch and not at the commit it pointed to; or the base commit is no ancestor of the upstream commit, as when the job's rebase rewrote commits made on the branch before the job, or the job merged a branch that forked before the base. In those last cases trees cannot separate the job's changes from the other branch's, and reporting too much is the safe side. A branch the agent creates, moves or pushes onto its own commits brings nothing in. A job record without recorded branches reports every changed path as before;
- whether the worktree has uncommitted changes;
- under `Modified before this job`, any path outside the allow-list that was already modified or untracked at send time and whose content hash is unchanged. If the hash differs, or the path was deleted or restored since, it is listed under `Outside allow-list` like any other change.

Globs are matched with Node's `path.matchesGlob` against paths relative to the worktree root.

While waiting, a change to `waitingOnApproval` is printed once as a line so it shows in the background task's output; the wait continues. When the turn is still waiting on 5 polls in a row, about two minutes at the default 30-second interval, `wait` exits 3 with a message naming the job and the thread, because a line in a background task's output reaches nobody until the task ends. The job stays open and `wait` can be run again.

`wait` exits 0 whenever it prints an outcome, whichever one. It exits 3 for the approval stop, 4 for a pi or omp brief that has not appeared in its session (see "pi and omp sessions"), and 1 when claude-errands itself fails: daemon gone, job record missing, lost job. With `--timeout <minutes>` (default 110, under the two-hour limit of a background Bash task) it prints `still running` and exits 0; Claude runs `wait` again.

claude-errands reports. It never reverts, resets, or amends the agent's work.

### Skills

- **brief**: the template above, the rules that worked (one commit per finding, quote the failing test line before the fix, "where a finding and the spec disagree, follow the spec and say so", final message lists commit ids and what did not fit), and the instruction to keep Claude's and the agent's allow-lists disjoint.
- **send**: run `send`, start `wait` as a background Bash task, and for each outcome what Claude does next. `question`: answer by sending a follow-up brief or ask the person. `declined`: surface the reason to the person. `unclassified`: read the message and treat it as a question. Any `Outside allow-list` entry: tell the person before reviewing anything else.

### pi and omp sessions

pi and omp offer no socket or file that names a live TUI session (measured on pi 1.5.1 and omp 18.18.6: pi listens on nothing, omp's daemon client records name no session and survive SIGKILL). claude-errands ships its own extension, which both load with the same extension API, and `setup-pi` links it into their extension folders. The extension lists the session and takes briefs for it.

**Activation.** The extension knows its host at load: omp when `process.versions.bun` is set, pi when `PI_CODING_AGENT=true`; anything else, it registers nothing. At `session_start` it opens its socket only when `ctx.mode` is `tui`, stdout is a terminal, and, in omp, `ctx.agent.kind` is `main`. omp runs extensions for subagents too, so every event handler checks the same three facts before it touches the session's state.

**The live/ directory.** `<stateDir>/live/`, created with mode 0700. An existing one must be a directory owned by this uid with mode 0700, or the extension refuses to listen and `agents.ts` fails the pi/omp check: another user's socket there would let them impersonate a session. Each extension instance listens on `<agent>-<12 random hex>-<pid>.sock`, a name new on every listen, so an instance never meets `EADDRINUSE` on a path an earlier one used, even one a SIGKILL left behind. The pid is its host process's, so `agents.ts` can tell a dead session from a live one that refuses connections. Paths stay near 80 bytes under `~/.local/state`; macOS allows 103, and a longer one is refused with a notification in the TUI. On `session_shutdown` the instance closes its server and removes only its own socket.

**Protocol.** One request per connection, one newline-terminated JSON line each way. The request is `{"v":1,"op":"hello"}` or `{"v":1,"op":"send","job":"<job id>","session":"<session id>"}`; any other field, version or op, a field of the wrong type, a line that is not JSON, or more than 256 KiB without a newline gets `{"v":1,"error":"<what was wrong>"}` and the connection closes. The `hello` reply:

```json
{"v":1,"agent":"omp","instance":"0123456789ab","pid":123,"sessionId":"<host session id>","name":null,"cwd":"/realpath","status":"idle","turnStartedAt":null,"busy":false,"pausedOnBackgroundWork":false,"job":null}
```

`sessionId`, `name` (from `getSessionName()`) and `cwd` are read from the session manager when the reply is written, so omp's `/new`, which keeps the extension instance, shows without an event of its own. `job` is the job this instance has handed to its host, from dispatch until its run ends, or `null`; `wait` reads it to tell whether an approval belongs to its job. `busy` is true while a run is going, as this extension has seen it, or while the host says it is not idle (`ctx.isIdle()` false: pi from the start of a run, before `agent_start`, and while it compacts). It says the session may still take a brief it was handed; `wait` reads it to tell a stalled brief from one the session is preparing. `pausedOnBackgroundWork` is true while omp's run waits on a background job of its own: its last `agent_end` had `willContinue` and `awaitingAsyncWork` (`agent-session.ts:5379-5381`), and no `agent_start` has come since. omp is idle then (`isStreaming` false), yet the run is not over, so the extension holds its queue; `wait` reads the field to say why a queued job has not started. pi always reports `false`.

**Hardening.** The server and every connection carry `unref()`, so an open socket never keeps the agent from quitting, and an `'error'` listener: in the spike, a client that hung up before the reply raised an `EPIPE` with no listener, and omp exited. Socket callbacks run outside the host's handler guard, so the `'data'` handler, which parses and answers the request, catches any error and answers with it. Each connection has a 2-second idle timeout, and at most 8 are served at once; a ninth is closed.

**Status.** `working` from the first `agent_start` of a run until the run ends, which in pi is `agent_settled` and in omp is `agent_end` with `willContinue` not `true`. `agent_end` alone is not the end in either: both start further low-level runs for retries and follow-ups. `needsApproval` while an omp `tool_approval_requested` has no matching `tool_approval_resolved` (per `toolCallId`), an omp `ask` tool call has not ended, or a pi extension dialog is open (`ui_prompt_start` to `ui_prompt_end`); pi's built-in waits are invisible to extensions. `turnStartedAt` is the run's first `agent_start`, or for a pi dialog outside a run, when the dialog opened.

**Why hello, not connect.** With the event loop blocked, connect still succeeds at once: the kernel accepts into the backlog. In the spike a `hello` with a 1-second timeout timed out and answered after about 1.8 seconds. A dead process is the other way round: after SIGKILL the socket file stays, and connect fails at once with `ECONNREFUSED`. `ECONNREFUSED` alone is not proof the process is gone: on macOS a live listener that stops accepting, because its process is stopped (Ctrl-Z, SIGSTOP) or blocked long enough, also refuses once its accept backlog (128) fills with probes that timed out. Treating it as proof removed a stopped session's socket after about 130 probes, and after SIGCONT the session was never listed again. So `agents.ts` checks the pid in the file name: it removes the file when `kill(pid, 0)` fails with `ESRCH`, ignoring `ENOENT` when another Claude session removed it first. When the pid exists, or belongs to another user (`EPERM`), it lists the socket as unreadable, `not accepting connections`, and keeps it. A timeout is a live but busy session it must not remove either. The cost is accepted: when a dead session's pid is reused by another process, its stale file stays listed as unreadable until that process exits.

**Sending.** The request carries no text: any client that can connect could otherwise supply its own instructions under a valid job id. `cli.ts` writes the exact message into its own job record (`jobs/<job>.json`, mode 600) before it connects, and the extension reads it from there, so a forger needs write access to the state directory, not just the socket. `agents.ts` resolves the target to the one live instance whose `hello` names that session id; none is `TargetClosedError`, two or more is a refusal as ambiguous. The extension then checks, in order, and answers each failure with its own error:

1. `job` matches `^errand-[0-9a-f-]{36}$`.
2. The job record exists, has no outcome and a string `message`, and its `target` is `<agent>:<current session id>`.
3. `session` is the current session id, which catches a `/new` between list and send.
4. No other live instance answers `hello` with this session id: two pi TUIs can open one session with no lock.
5. It creates `agent-jobs/<job>.json` exclusively. The record is written to a file of its own name and hard-linked into place, so `link`'s `EEXIST` is the at-most-once claim and no reader sees a half-written record. If the file exists the reply is `{"v":1,"duplicate":true,"state":"<state>"}`, otherwise `{"v":1,"accepted":true}`.

A refusal is a `SendRefusedError` in `cli.ts`: the job is settled `abandoned` with delivery `refused`, which frees the worktree, and no job id is printed.

**The agent-jobs record.** `<stateDir>/agent-jobs/<job>.json`, mode 600, in a directory created with mode 700:

```json
{"state":"queued","agent":"pi","owner":"0123456789ab","pid":123,"sessionId":"…","message":"…","seq":1794322876757,"acceptedAt":"…"}
```

`state` moves `queued` → `dispatching` → `running` → `ended`, or from `queued` to `dropped` with a `reason` (`abandoned`, `session changed`, `the job record is gone`). `dispatching` goes straight to `ended`, `failed`, only when the host rejects the brief, and to `dropped` (`abandoned` or `the job record is gone`) when the CLI lets go of a job whose brief has not appeared. `dispatching` adds `dispatchedAt`, `running` adds `startedAt` and `merged`, and `ended` adds `endedAt`, `status` (`completed` or `failed`), `finalMessage`, `error`, `merged` and `userIntervened`. `message` is copied from the CLI's record, so a new owner can run the job without the CLI. `seq` orders the queue: the acceptance time in milliseconds, raised by one when two jobs share a millisecond. Only the record's `owner` updates it, by a temporary file and a rename that keep every other field, with two exceptions taken under the `agent-jobs/<job>.adopt` lock (created with `wx`, removed afterwards): a new owner adopting a queued job, and `abandon` dropping a queued job whose owner is gone.

**Dispatch.** The extension keeps a queue of the jobs it owns that are still `queued`, in `seq` order. It drains the head right after accepting a job, and within the end-of-run event itself, so the session is not left idle between one job and the next:

- If the CLI's job record has an outcome (`abandon` set one) or is gone, the head becomes `dropped` and draining goes on.
- If the session id is not the one the job was accepted for, the head becomes `dropped`, `session changed`. omp keeps the extension across `/new` and `/resume`, so this happens.
- If `ctx.isIdle()` is false, or this extension has seen a run start and not yet end, it tries again in 2 seconds: pi counts compaction as busy, and no end of run follows a compaction. Both checks are needed. pi clears its run flag before it awaits each extension's `agent_settled` handler in turn (`agent-session.js:739-745`), and omp's `agent_end` reaches extensions as a detached notification after `isStreaming` went false (`agent-session.ts:5921`). A job dispatched in either gap was failed by that run's end, then ran.
- Otherwise it writes `dispatching` and calls `sendUserMessage(message)`, in pi with `deliverAs: "followUp"` (see "The steer race"). Neither host expands prompt templates for an extension's message.

A dispatched job holds the queue until its brief appears and its run ends. If the CLI's job record gets an outcome first (`abandon`), or is gone, the job becomes `dropped` with that reason and the next job starts; while jobs wait behind it, the extension checks every 2 seconds. Its brief may still appear later; it then runs untracked, as any agent does after `abandon`. While `session_start`'s adoption runs, the queue does not drain, so adopted jobs keep their place ahead of a job accepted meanwhile. A drain that fails, as on a CLI job record that is not JSON, is reported in the TUI and tried again in 2 seconds, until one succeeds; the same error is reported once.

**Admission.** The job is `running` only once its exact text arrives as a user `message_start`. That is the one signal both hosts emit for an extension's message (measured 2026-11-10 on pi 1.5.1 and omp 18.18.6 under the pty harness):

- pi: `input` (source `extension`, the exact text), `agent_start`, then the user `message_start`.
- omp: `agent_start`, then the user `message_start`; no `input` event at all. omp emits `input` only for typed text (`modes/controllers/input-controller.ts:1089`) and rpc prompts (`modes/rpc/rpc-mode.ts:1905`), never from `sendUserMessage`. The approved design asked for `input` with source `extension` followed by `agent_start`; that cannot happen in omp, so the message is the signal and pi's `input` is kept as evidence for the error text only. Alex ruled this on 2026-11-10.

The job is `merged: false` only when its message is the first user message of a run whose `agent_start` came after dispatch; otherwise it joined a run already going, `merged: true`. Since the queue dispatches only when this extension has seen every run end, a run that began after dispatch is one whose `agent_start` it counted after dispatch.

Before admission, a job is never failed on absence of evidence: no timer and no end of run fails a `dispatching` job. It ends `failed` only when the host rejects the brief:

- omp's `sendUserMessage` promise rejects (`PromptDroppedError`, or a collab guest): "the <agent> session did not take the brief: sendUserMessage failed: <name>: <message>";
- `sendUserMessage` throws: "… sendUserMessage threw: <message>".

Any other dispatched job waits for its message, however late, and is admitted when it appears. This departs from the approved design, which said a job with no `agent_start` 15 seconds after dispatch ends `failed`. That rule, and a later one that failed the job when a run that began after dispatch ended without its message, were replaced on 2026-11-10 after a review reproduced, with a stand-in host replaying each host's source, a job ending `failed` and then running:

- Both hosts stay idle while they prepare a prompt. omp awaits `waitForMaintenanceCleanup()`, a whole compaction, before it counts as streaming (`agent-session.ts:8731`, `session-maintenance.ts:2156-2165`). pi sets `_isAgentRunActive` only in `_startRun` (`agent-session.js:1488`), after it awaited the `input` handlers (1736) and `checkAuth` (1767).
- omp keeps a message an extension steered into a run across an Escape abort (`agent-session.ts:11087-11094`) and delivers it in a later turn, after that run ended without it.

pi reports its own refusals, such as no credentials, only to its error handler (`emitError`), which extensions do not see. Such a brief stays `dispatching`, and `wait` stops on it with exit 4 (see "Poll") so the person can look at the pane, wait again, or abandon it.

**The steer race.** Neither host starts a run only if idle, so a run can begin between the `isIdle()` check and the host taking the brief. The two hosts then differ (measured 2026-11-10):

- The extension passes no `deliverAs` to omp, so omp's `sendUserMessage` prompts with `streamingBehavior: "steer"` and queues the brief into that run. The promise settles at once, and the brief arrives as the run's second user message at the next turn boundary, with no `agent_start` of its own. In the spike it landed 3 seconds after it was sent, when the person's first turn ended. The job is `merged`. omp is never given a `deliverAs`: with one, its `sendUserMessage` queues the message without starting a run even when the session is idle (`agent-session.ts:11017-11061`).
- Without `deliverAs`, pi drops it: with a run going, `_preparePrompt` throws "Agent is already processing" (`dist/core/agent-session.js:1749-1752`), after the `input` handlers ran (1736), and the runtime hands the error to `emitError`. So the extension passes `deliverAs: "followUp"` to pi. Measured with the `pi race` scenario on pi 1.5.1: the probe started a run from the brief's own `input` event and held it 5 seconds; pi queued the brief as a follow-up; the probe's message got its answer (here the stale sign-in error), then pi continued the same run, with a second `agent_start` and one `agent_settled`, and the brief arrived as its second user message. The job ended `merged`. pi delivers a follow-up only when the run would stop (`pi-agent-core/dist/agent-loop.js:196-202`, and `_handlePostAgentRun` in `agent-session.js` for a run that ended on an error); a follow-up on an idle pi is not queued, since the option applies only while a run is going.

When the person aborts a run with a steered brief still queued, omp keeps it and delivers it in a later turn. The abort no longer fails the job, so that delivery admits it. Which run it lands in, and so whether it is `merged`, is not measured.

`wait` reports a merged job as `failed` with the error "the brief joined a run the person started; its final answer may not be the agent's answer to the brief". The person can check and send the brief again. A person who types into the job's own run (an `input` not from an extension, or another user message during the run) sets `userIntervened: true`. It is reported only (`Person typed into the session during the run: yes`) and does not change the outcome; Alex has not ruled on changing it.

**Outcome.** The job's run is the one its message joined, through its automatic continuations, and it ends as the status says above: `agent_settled` in pi, `agent_end` without `willContinue` in omp. The outcome is the last assistant message of the run: `stop` is `completed`; `error` is `failed` with its `errorMessage`; `aborted` is `failed`, `interrupted`; `length` is `failed`, `output truncated`; any other stop reason is `failed` naming it; no assistant message is `failed`, "the run ended without an assistant message". `finalMessage` is that message's text.

**Adoption.** On `session_start` an instance looks for `queued` records for its agent and session id whose owner is gone: the owner's socket file is missing, or it refuses while no process holds its pid. It takes each under the `.adopt` lock, rewrites `owner` and `pid`, and queues it by `seq`. An owner that answers may be another TUI on the session and keeps its jobs, and so does one that neither connects nor refuses within 1 second. A record it cannot read is reported in the TUI and left in place, and the others are still adopted. `dispatching` and `running` records are never adopted. pi refuses `/reload` while a run is going ("Wait for the current response to finish before reloading.", `interactive-mode.js:5484`), and an idle session starts a queued job at once, so a reload practically never meets a queued job. A restart does: a pi or omp TUI opened with `--session <id>` after the owner died adopts its queued jobs. omp never reloads extensions.

**Poll.** `poll` reads the record, asks its owner for `hello` (1 second), and reads it again. The second read decides, so a run that ends and exits during the `hello` is reported as it ended. If the second read names another owner, an adoption happened and the new owner is asked. The owner is answering (a reply), unresponsive (connected but no reply in time, or a malformed reply), or gone (no socket file, or refused with its pid gone). The first row that matches decides, so a brief that has not appeared is `notAdmitted` even while a pi dialog is open:

| Record | Owner | Turn state |
|---|---|---|
| missing | | `lost` |
| `queued` | answering, `pausedOnBackgroundWork` true | `queuedBehindBackgroundJob` |
| `queued` | answering or unresponsive, otherwise | `queued` |
| `queued` | gone | `closed`: the session that queued it is gone; it runs only if that session opens again with claude-errands loaded |
| `dispatching` / `running` | gone | `ended`, `failed`: "the <agent> session exited while the job ran; whether it finished is unknown" |
| `dispatching` | answering, `job` is this job, `busy` false | `notAdmitted`, with `dispatchedAt` |
| `dispatching` / `running` | answering, `needsApproval`, `job` is this job | `waitingOnApproval` |
| `dispatching` / `running` | answering or unresponsive, otherwise | `running` |
| `dropped` | | `dropped`: "the <agent> session <target> dropped it before it started: <reason>" |
| `ended` | | `ended`, as recorded; `merged` makes it `failed` with the merged error |

`wait` handles `notAdmitted` as it handles an approval: it prints "Job <id> was handed to the session at <dispatchedAt> and has not appeared in it yet." once, and after 5 polls in a row it exits 4, leaving the job open and its worktree held, with "job <id>: the brief has not appeared in session <target> for 5 polls in a row, and that session reports nothing going; look at that <agent> pane. The job is still open: run wait <id> again, or abandon <id> if it will never run". A `dropped` job never ran, so `wait` settles it `failed` with that reason and no change report, which frees the worktree. For `queuedBehindBackgroundJob` `wait` prints "Job <id> is queued behind a background job in session <target>; it starts when that job's result ends the run, or, if the job is killed, after the next run in that pane." once and goes on waiting, with no stop of its own. When the background job's result wakes the run, the job starts once that run ends with nothing for a person to do; a killed background job sends extensions no end of run, so the job then waits for the person's next run in that pane (see Known limits).

`abandon` on a `queued` job whose owner is gone writes `dropped`, `abandoned`, so no session that opens later adopts it. A live owner drops it itself when the job reaches the head of its queue. A job already dispatched keeps running: `abandon` never stops an agent.

**Sandboxed clients.** A Codex job runs under Codex's seatbelt. Measured 2026-11-10 with codex-cli 0.167.0 and an isolated `CODEX_HOME`: `codex sandbox -P :workspace` and `-P :read-only` both deny `connect` on a Unix socket with `EPERM`, for a socket under the state directory and for one inside the workspace alike; `--allow-unix-socket <dir>` opens it. A Codex job therefore cannot reach `live/*.sock` unless the person allows that directory. `codex exec -s workspace-write`, which the design named for this check, stopped with "Your workspace is out of credits" before running anything; its sandbox listing (`workspace-write [workdir, /tmp, $TMPDIR]`) agrees with the `:workspace` profile. omp's own sandbox was not measured.

**Listing.** `agents.ts` reads `live/`, and for each `<pi|omp>-<12 hex>-<pid>.sock` that is a socket sends `hello` with a 1-second timeout, all at once. The reply is parsed field by field into a `Target`; anything off, including an agent or instance that differs from the file name or a session id its host would not accept (it becomes part of a send target and reaches Claude's note unquoted), makes the session unreadable with the reason. pi's rule is its own `assertValidSessionId`, `^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$`. omp mints UUIDv7 ids and states a rule only for imported sessions, `^[A-Za-z0-9_-]{1,128}$`, which `agents.ts` applies to every omp id; omp loads a local session file whatever its id, and such a session is listed as unreadable. Two TUIs can hold one session id, and the hooks would draw, name and notify such a session twice, so `agents.ts` lists it once: the most urgent status of its twins (`needsApproval`, then `working`, then `idle`), the earliest `turnStartedAt` among the twins with that status, and the other fields of the twin with the lowest instance. Other files are reported apart, as stray files, because no agent can be named for them. `cli.ts` runs the Codex check and this one together and reports a failure of either in `nearby`'s `failed` list, so one failing does not hide the other's sessions.

**Known limits.** Open as of 2026-11-10. Alex chose to document the first five rather than fix them:

- After `abandon` drops a dispatched job, its brief can still appear. When it joins the run of the next job, that job can end with the abandoned brief's answer as its own: `completed`, `merged: false`, and only `userIntervened: true` hints at it.
- A `dispatching` job whose owner is gone is settled `failed`, "whether it finished is unknown". With no 15-second admission limit a job can stay `dispatching` for long, so this comes up more often, and the brief can still run after the job is settled: omp keeps a steered brief across Escape and delivers it when the person resumes, and pi can put it back in the editor, where Enter runs it.
- When omp drops the brief with `PromptDroppedError`, the job ends `failed`, and omp puts the brief's text back in an empty editor (`restoreDroppedPrompt`, `interactive-mode.ts:4132-4153`). One Enter from the person runs it untracked.
- An abandoned dispatched job with no job queued behind it keeps `job` in `hello` until the next send, end of run or omp session switch, since the 2-second retry runs only while jobs wait.
- `parseHello` requires `busy` and `pausedOnBackgroundWork`. A TUI still running an older copy of the extension is listed as unreadable until pi's `/reload` or an omp restart.
- The run's last `agent_end` releases a queue held behind an omp background job. When the background job ends without its result waking the run, for example after `/jobs kill` or with its delivery suppressed, omp tears the run down in its UI only (`#finishWhenRunSettles` in `event-controller.ts`) and sends extensions no further `agent_end`, so the queue waits for the end of the session's next run. Read from omp's source, not measured.

## Error handling

- Every error names the operation and the offending value: the path, the thread id, the process ids found.
- No fallbacks. A missing daemon, an ambiguous daemon, an unreadable thread, a malformed brief, or a lost job stops the command with a non-zero exit.
- Daemon responses are validated where they arrive in `daemon.ts`; the rest of the code trusts the parsed types.
- Git is run with argument arrays, never a shell string. The brief path reaches the agent as text only.

## Testing

End-to-end against real Codex, never the live thread. `test/e2e.ts` starts its own managed daemon under a temporary Codex home and runs `send` and `wait` as subprocesses with `CODEX_HOME` set to that home. Before sending anything it checks that the daemon process claude-errands discovers is the one it started, and stops if not. It creates a scratch git repository and runs these jobs:

1. A brief asking for one file inside the allow-list: outcome `done`, one commit, nothing outside the allow-list.
2. A brief that instructs a change outside its own allow-list: the file is listed under `Outside allow-list`.
3. A brief whose work cannot be done without an answer: outcome `question`.
4. A brief that tells the agent to end without a `RESULT` line: outcome `unclassified`.
5. A file outside the allow-list is modified before sending, and the brief instructs the agent to change it again: the file is listed under `Outside allow-list`, not under `Modified before this job`.
6. A second `send` to the same worktree while the first job has no outcome: refused, naming the first job.
7. Codex started in a git folder that holds a nested repository, with no extra writable directories. A `create` brief asking for one committed file: outcome `done`, the worktree exists at the named path on the named branch, one commit since the base, and the folder's own repository shows nothing untracked. The same brief with a worktree path the folder does not ignore is refused before sending. The repository path contains a space, so the quoted command is exercised by the real agent.

`test/agents.e2e.ts` runs the real pi and omp TUIs, each under a pty from `script`, with the repository's extension, `--no-extensions` (omp) or `-ne` (pi), a scratch `--session-dir` and a scratch `XDG_STATE_HOME` under `/tmp`. A test-only extension, `test/agents-e2e-probe.ts`, records session starts, runs, `input` events and user messages, and adds commands that block the event loop for 3 seconds, hold a run before it starts, consume the next extension input, and start a run as a brief arrives. It checks that `hello` answers within 5 seconds of launch and the session is listed; that 20 clients hanging up early leave the agent running; that malformed and oversize requests get error replies, a silent connection closes after 2 seconds, and a ninth open connection is closed unanswered; that a blocked event loop is listed as not responding and kept; that after `/new` only the new session id is listed; that after pi's `/reload` the new instance answers and the old socket is gone; that omp reports `working` with `turnStartedAt` while a typed prompt runs, and both agents report `idle` once the run ends; that quitting removes the socket and the agent exits; that after SIGKILL `targets` removes the stale socket; that `nearby` lists both agents while a Codex check fails; and that print and rpc runs under a pty start a session but open no socket. For sending it checks the socket's refusals (a malformed id, a job no CLI recorded, another target, an outcome, no message, another session, and a stale session after `/new`); that briefs sent during a held run stay queued, an abandoned one never starts and the one behind it runs once, and two concurrent sends of one job are accepted once; that a brief an `input` handler consumes, and one a pi with no credentials refuses, stay `dispatching` while `wait` stops with exit 4 and leaves the job open, and that after `abandon` the next brief sent is dispatched in its place; pi's side of the race, where a run started from the brief's own `input` event gets the brief as a follow-up and the job ends merged; a pi brief whose run is held 20 seconds before it starts staying `dispatching` while `hello` reports the session busy and `wait` keeps going, then running as its own; omp taking a brief into a run of its own with no `input` event, and Escape ending it interrupted; an omp brief sent during the person's run staying queued and starting in a run of its own when that run ends; a pi TUI reopened on a killed session's id adopting its queued jobs in order, and two reopened at once adopting each job once; that a session open twice is refused as ambiguous; pi's provider error, unknown after SIGKILL, and in omp an approval-gated tool (`--config` with a scratch `tools.approvalMode: always-ask` overlay) stopping `wait` with exit 3, Escape ending the job interrupted with the person's typing reported, and a brief completing with `RESULT: done`. omp's side of the race is not run against the real TUI: omp emits no event between its idle check and taking the brief that a test extension could start a run from. One attempt that started a run in the probe's end-of-run handler, loaded before the extension, got the brief dispatched behind it once; the brief then did not show as a user message in 400 seconds while omp's model ran a dozen tool turns, and the event log of that run was not kept. A second attempt lost the race and the brief stayed queued. Every pi scenario, and every omp scenario that needs no model, runs the agent without the environment's credential variables (`*_API_KEY`, `*_TOKEN`, `*_OAUTH`), so pi meets only its stored sign-in, which fails at once here. omp's lifecycle, admission, queue and outcomes scenarios keep only `GEMINI_API_KEY`, which omp's default model on this Mac (`google/gemini-4-argon`) reads: they need a run that lasts until Escape, or an answer, from that model. omp's own stored sign-ins stay in reach of every omp scenario. `test/extension.test.ts` loads the extension with a stand-in host that replays the measured event orders: omp's admission without `input`; a brief that arrives as the second user message of a run started after dispatch (merged, and `dispatching` past 15 seconds until it does); a run that started after dispatch and ended without the brief leaving the job `dispatching` until a later run admits it; a brief whose run has not started 16 seconds after dispatch, with the host idle, admitted when it starts; jobs not dispatched while the host is idle before this extension's end-of-run event, as pi's `agent_settled` and omp's detached `agent_end` allow, then each running as its own; a rejected `sendUserMessage` failing the job and the next job starting; a dispatched job the CLI abandons dropped so the next starts; a CLI job record that is not JSON reported once while the retry goes on, so the abandon is seen once the record is readable; an omp run paused on a background job, through a wake and a second pause, holding a job queued while `hello` reports `pausedOnBackgroundWork`, and dispatching it within the run's last `agent_end` (the stand-in reports a Bun version, so the extension takes it for omp); an unreadable record skipped and reported while the others are adopted; adopted jobs running before a job accepted during adoption; and a queued job dropped after omp's `/new` changed the session. The 1-second limit on asking a gone owner is not tested: on macOS a Unix socket connect either succeeds into the backlog or is refused at once, so no test here can make it hang. `test/agent-jobs.test.ts` runs `send`, `wait` and `abandon` against sockets standing in for a session and real `agent-jobs` records, for each row of the poll table, including `wait`'s exit 4 with the job left open and its worktree still held, exit 4 rather than 3 while a pi dialog is open, the background-job line printed once, and a dropped job settled so its worktree is free. `test/agents.test.ts` covers the listing against sockets whose peers answer badly, a stopped peer whose backlog is full, dead and foreign pids, twins on one session, and each host's session id rule.

Each expected marker is a random token generated per run, so a cached answer cannot pass. The script exits non-zero on any mismatch and writes its outcomes to a file that can be compared between runs.

`brief.ts` and the `RESULT` line parser are pure and are tested in isolation. Their failure lists are the rejection list under "Brief" and the table under "Outcome"; each test is written before the code it covers, one at a time.

## Build order

1. Measure Codex's approval and queue-list shapes on a throwaway thread; then `daemon.ts`, `codex.ts`, `job.ts`, `send`, `wait` with outcome classification. Usable from here.
2. `brief.ts` and the `brief` skill.
3. `changes.ts` and the allow-list report.
4. `send` skill, README, end-to-end script covering all four jobs.

## Second transport: agy

Not built in version 1. Measured on agy 1.2.14 on 2026-10-01, to check the interface holds:

- A workspace `.agents/hooks.json` `Stop` hook fires at every turn end. It receives the conversation id, the termination reason, and the path of a JSONL transcript whose `PLANNER_RESPONSE` entries hold the reply text.
- A `Stop` hook that answers `{"decision":"continue","reason":"<text>"}` makes the agent act on that text in the visible session. No keystrokes are involved.
- agy has no client message id, which is why the job id travels in the message text for every transport.
- `agy agentapi send-message` is refused from outside the session (`missing CSRF token`). That is deliberate authentication and is not worked around.

Mapping: the target is a workspace with the hook installed; `send` writes a queue file the hook picks up; `poll` reads what the hook logged and the transcript.

Open before agy can be built: an idle agy session fires no hook, so a job that arrives while it waits at its prompt needs a wake. Candidates are a `Stop` hook that blocks until a job arrives, or one keystroke through tmux. Neither is tested.

## Protocol notes (codex-cli 0.159.2, measured 2026-10-01)

Measured with `npm run protocol` against an isolated daemon. Rerun it after a Codex upgrade.

Rerun on codex-cli 0.163.0 on 2026-10-19: all three facts hold, and the e2e harness now pins 0.163.0.

### Queue listing

`thread/queue/list` returns entries of this shape:

```json
[{"id":"01a0f66e-b8e1-7dc1-b35e-7738f353090a","input":[{"type":"text","text":"Reply with exactly SECOND.","text_elements":[]}],"clientUserMessageId":"relay-bc5d2311-23c6-420d-9a93-e7c92e678c6a"}]
```

### Job id visibility

A queued job id appears in `thread/queue/list` as `clientUserMessageId` while an earlier turn runs. It leaves the queue when its own turn starts, and then appears as `clientId` on that turn's `userMessage` item.

### Closed threads (codex-cli 0.167.0, measured 2026-11-09)

Measured against the live daemon with read-only calls, and against an isolated `codex app-server` with no credentials. To repeat it: point `CODEX_HOME` and `HOME` at empty directories, start `codex app-server --listen unix://<socket>`, call `thread/start`, `thread/queue/add`, kill and restart the server, then call `thread/read`, `thread/queue/add` and `thread/resume` on that thread. No model call succeeds without credentials, and none is needed:

- `thread/read` on a thread that is no longer loaded still answers, from the rollout, with `status: {"type":"notLoaded"}`. `thread/loaded/list` does not list it.
- `thread/queue/add` on a `notLoaded` thread answers with a `queuedSubmission` like any other. The entry stays in `thread/queue/list`, across a daemon restart too, and no turn starts.
- A loaded thread's queue is drained by the daemon whether or not any client is connected: a job added to an idle thread with no subscriber started a turn within a second.
- `thread/resume` on a `notLoaded` thread with a queued entry starts it. A parked job is not dead.
- A turn in progress when the daemon is killed reads as `interrupted` after a restart, not `inProgress`.
- After `codex app-server daemon restart`, the daemon continues each interrupted turn in a new turn (measured on codex 0.169.0, 2026-11-14 and 2026-11-15). The rollout records `turn_aborted` with reason `interrupted`, then a `task_started` whose `turn_trigger` is `daemon_recovery`, 0.02 to 0.97 s later in the six pairs checked. In `thread/read` the new turn's `rootTurnId` is the interrupted turn's id, and every other turn's `rootTurnId` is its own id. The new turn has no `userMessage` item.

### Reading a thread

A loaded thread that has no stored message cannot be read: `thread/read` with `includeTurns` fails with `list_turns is not supported yet` or `rollout ... is empty`. During a session's first turn Codex loads a second, short-lived thread, so `thread/loaded/list` can return more than one id for a single TUI.

### Commit under workspace-write

The workspace sandbox keeps the `.git` directory of the folder Codex runs in read-only, so a commit there is blocked unless Codex is started with `--add-dir <repo>/.git`. The `.git` of a repository nested below that folder is writable (measured on 0.163.0 on 2026-10-19 with `codex exec -s workspace-write`).

### Pending approval

While the TUI shows "Would you like to run the following command?", `thread.status` is `{"type":"active","activeFlags":["waitingOnApproval"]}` and the turn is `inProgress`. Without a pending approval an active thread has `"activeFlags":[]`; an idle thread is `{"type":"idle"}`.

### Approval policies

`--ask-for-approval` accepts `on-request` and `never`.
