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
  src/cli.ts                 argument parsing, subcommands: send, wait, targets, abandon
  src/brief.ts               parse a brief file into a Brief, or reject it
  src/transport.ts           the Transport interface and TurnState type
  src/codex.ts               Codex implementation of Transport
  src/daemon.ts              client for the Codex daemon socket
  src/job.ts                 job records and the remembered target
  src/outcome.ts             turn state plus git facts to an Outcome
  src/changes.ts             files changed since the job's base commit, checked against the allow-list
  test/e2e.ts                end-to-end run against a real daemon
  README.md
```

Dependency direction: `cli` depends on everything; `outcome` depends on `transport` types and `changes`; nothing depends on `cli`. Only `codex.ts` and `daemon.ts` know Codex exists.

The one runtime dependency is `ws`, already used by the code this is derived from.

### Transport interface

```ts
type TurnState =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'waitingOnApproval' }
  | { kind: 'lost' }
  | { kind: 'ended'; status: 'completed' | 'failed'; finalMessage: string | null; error: string | null }

type Transport = {
  send(target: string, jobId: string, text: string): Promise<void>
  poll(target: string, jobId: string): Promise<TurnState>
  targets(): Promise<Array<{ id: string; label: string }>>
}
```

Version 1 has one implementation and no registry, flag, or configuration for choosing one. Job records store `transport: "codex"` so they stay readable when a second one exists.

### Codex transport

- **Daemon discovery.** The Codex home is `$CODEX_HOME` when set, otherwise `~/.codex`. Find the one process under `<Codex home>/packages/app-server-daemon/` started with `--managed-daemon`, then the one `codex-daemon-` unix socket it holds. Zero or several of either is an error naming what was found.
- **cwd.** `thread/read` for the thread's `cwd`. `send` refuses a thread whose `cwd` is not the brief's worktree or inside it: a brief for one repository must not reach a session working on another.
- **send.** `thread/read` first, so an unreadable thread fails before anything is queued. Then `thread/queue/add` with the text and `clientUserMessageId` set to the job id.
- **poll.** Read `thread/queue/list` first, then `thread/read`. A job only moves from the queue to the turns, so reading in that order cannot miss a job that started between the two calls.
  - The job is in the queue: `queued`.
  - Not in the queue, and no turn has a `userMessage.clientId` equal to the job id: `lost`.
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

If any check fails, the outcome is `no-worktree`: the final answer verbatim, the failed check as the error, and no change report. Otherwise the outcome is classified as for any job and changes are reported against the base commit.

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

- `jobs/<jobId>.json`: job id, transport, target, original brief path, worktree, branch, base commit, hashes of paths already modified at send time, allow-list, Claude session id, time sent, delivery state, and the outcome once captured.
- `jobs/<jobId>.brief.md`: the brief copy the agent reads.
- `targets/<CLAUDE_CODE_SESSION_ID>.json`: the target last given with `--target` in that Claude session.

The record is written with delivery state `sending` before the transport's `send` is called, and becomes `sent` when it returns.

A failed `send` does not prove the daemon rejected the job: the response can be lost after the daemon accepted it. So the record is never deleted on failure. `send` polls once for the job id. If the job is queued or has a turn, delivery state becomes `sent` and `send` succeeds. Otherwise, including when that poll itself fails, it becomes `unknown`, and `send` exits non-zero printing the job id and the error. claude-errands never sends a job twice; `wait <jobId>` on an `unknown` job reports what the daemon shows. Whether Codex deduplicates on `clientUserMessageId` is not assumed.

One job per worktree at a time. `send` refuses when another job record for the same canonical worktree path has no captured outcome, naming that job. Two jobs editing one worktree cannot be told apart by git, so claude-errands does not allow it. `abandon <jobId>` marks a job's outcome as abandoned so the worktree can be used again; it does not stop the agent.

Job ids are `errand-<uuid>`.

`send` without `--target` uses the remembered target. With no remembered target it fails and prints the `targets` listing, so Claude can ask the person which thread to use. With `CLAUDE_CODE_SESSION_ID` unset, `--target` is required every time.

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
| `no-worktree` | a `create` job's worktree is missing, belongs to another repository, is on another branch, or does not descend from the base commit |

The outcome is stored in the job record the first time it is captured. A later `wait` on the same job prints the stored outcome and gathers nothing again, so edits made after the capture are never attributed to the job. Edits by anyone else between the turn ending and the capture (at most one polling interval) cannot be told apart from the agent's; the README says so.

A `lost` state must be seen on three consecutive polls before `wait` exits non-zero with "job is in neither the queue nor the turns". Waiting forever on a lost job is not acceptable, and neither is giving up on one reading.

The `RESULT` line must be the last non-empty line of the final answer and match `^RESULT: (done|question|declined)$` exactly. Anything else is `unclassified`; claude-errands does not guess from the prose.

Every outcome also prints:

- the final answer verbatim, or a line saying the turn had none;
- the commits on the worktree's branch since the base commit, one line each;
- files changed since the base commit, committed or not, that match no allow-list entry, under the heading `Outside allow-list`;
- whether the worktree has uncommitted changes;
- under `Modified before this job`, any path outside the allow-list that was already modified or untracked at send time and whose content hash is unchanged. If the hash differs, or the path was deleted or restored since, it is listed under `Outside allow-list` like any other change.

Globs are matched with Node's `path.matchesGlob` against paths relative to the worktree root.

While waiting, a change to `waitingOnApproval` is printed once as a line so it shows in the background task's output; the wait continues.

`wait` exits 0 whenever it prints an outcome, whichever one. It exits non-zero only when claude-errands itself fails: daemon gone, job record missing, lost job. With `--timeout <minutes>` (default 110, under the two-hour limit of a background Bash task) it prints `still running` and exits 0; Claude runs `wait` again.

claude-errands reports. It never reverts, resets, or amends the agent's work.

### Skills

- **brief**: the template above, the rules that worked (one commit per finding, quote the failing test line before the fix, "where a finding and the spec disagree, follow the spec and say so", final message lists commit ids and what did not fit), and the instruction to keep Claude's and the agent's allow-lists disjoint.
- **send**: run `send`, start `wait` as a background Bash task, and for each outcome what Claude does next. `question`: answer by sending a follow-up brief or ask the person. `declined`: surface the reason to the person. `unclassified`: read the message and treat it as a question. Any `Outside allow-list` entry: tell the person before reviewing anything else.

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

### Reading a thread

A loaded thread that has no stored message cannot be read: `thread/read` with `includeTurns` fails with `list_turns is not supported yet` or `rollout ... is empty`. During a session's first turn Codex loads a second, short-lived thread, so `thread/loaded/list` can return more than one id for a single TUI.

### Commit under workspace-write

The workspace sandbox keeps the `.git` directory of the folder Codex runs in read-only, so a commit there is blocked unless Codex is started with `--add-dir <repo>/.git`. The `.git` of a repository nested below that folder is writable (measured on 0.163.0 on 2026-10-19 with `codex exec -s workspace-write`).

### Pending approval

While the TUI shows "Would you like to run the following command?", `thread.status` is `{"type":"active","activeFlags":["waitingOnApproval"]}` and the turn is `inProgress`. Without a pending approval an active thread has `"activeFlags":[]`; an idle thread is `{"type":"idle"}`.

### Approval policies

`--ask-for-approval` accepts `on-request` and `never`.
