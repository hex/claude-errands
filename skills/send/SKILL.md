---
name: send
description: Use when handing a written brief to the user's live Codex, pi or omp session and acting on how its turn ended - sending, waiting in the background, and what to do for each outcome.
---

# Sending a brief and acting on the outcome

`ERRANDS="node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts"`

1. Write the brief (see the `brief` skill).
2. Send it. `$ERRANDS targets` lists open sessions: a bare id is a Codex thread, `pi:<session id>` and `omp:<session id>` are pi and omp sessions. If the person approved a plan that names a session for each brief, use that session. Otherwise ask the person which session with AskUserQuestion, one option per open session; never pick one yourself. Run `$ERRANDS send <brief.md> --target <target id>`. Pass `--target` on every send when more than one session is open. For pi and omp, a brief sent while the session is busy waits until it is idle; `wait` shows it as running. The command prints a job id only after the thread's status was not `notLoaded` and the daemon accepted the job, so there is no need to check the thread's rollout file. Codex keeps a closed session's thread loaded and `idle` for about a minute: `send` accepts it, and the job runs with no pane to answer an approval. If the thread unloads in the moment after the check, `wait` reports it at its first poll.
3. Wait in the background, so the harness wakes you when the turn ends: run `$ERRANDS wait <job id>` with the Bash tool's `run_in_background: true` and `timeout: 7200000`. The Bash tool stops a background command after 30 minutes unless you pass that timeout; two hours is its maximum, and claude-errands' own `--timeout` default of 110 minutes stays under it. Do not poll it.
4. Act on the outcome it prints.

| Outcome | What it means | What you do |
|---|---|---|
| `done` | The agent says it finished. This is its claim. | Review the listed commits before telling the user the work is complete. |
| `question` | The agent needs an answer. | Answer with a follow-up brief if you can answer from the spec; otherwise ask the user. |
| `declined` | The agent chose not to do some of the work. | Give the user the agent's reason, verbatim. |
| `unclassified` | No final answer, or no `RESULT` line. | Read the final answer and treat it as a question. |
| `failed` | The turn did not complete. On a job whose worktree the agent was to create, `Error` carries the turn's error and any failed worktree checks, and no change report follows when a check failed. | Report the error to the user. |
| `no-worktree` | The turn completed on a job whose worktree the agent was to create, and the worktree is missing, belongs to another repository, is on another branch, or does not descend from the base. | Report the error and the final answer to the user. No change report follows. |

Whatever the outcome: if `Outside allow-list` lists any path, tell the user before reviewing anything else. `Brought in from <branch> at <commit>` lists files that came with another branch's commits, through a rebase or merge, and that the agent left as that branch has them. Check that the brief asked for that branch to be rebased in or merged; if it did not, tell the user as you would for `Outside allow-list`. claude-errands never undoes the agent's work; you undo it only when the user asks.

Do not edit a job's worktree while the job is open. claude-errands reports every change there as the agent's.

Other output:

- `still running`: the wait reached its time limit. Run `wait` again.
- `is waiting on an approval in the agent's pane`: tell the user that agent's pane needs them.
- `wait` exits 3 with `has waited on an approval`: nobody answered for 5 polls. Tell the user the pane the message names needs them, or that the session may be closed if they no longer have that pane. The job is still open: run `wait <job id>` in the background again once they have answered.
- `is queued behind a background job in session ...`: an omp run started a background job and waits for its result before it ends; the brief starts after that. Keep waiting. A background job stopped before it delivers its result, for example with `/jobs kill`, does not release the brief: it then starts only after the next prompt the user runs in that pane ends.
- `was handed to the session at ... and has not appeared in it yet`: a pi or omp session took the brief and has not shown it as a message yet. Keep waiting.
- `wait` exits 4 with `the brief has not appeared`: the pi or omp session holds the brief, shows nothing running, and has not shown it for 5 polls. Tell the user to look at the pane the message names; it may show an error, such as a missing sign-in. Do not send the brief again: the session may still run it. The job is still open: once the user says the session is ready, run `wait <job id>` in the background again; if the user says it will never run, run `$ERRANDS abandon <job id>`, then send it again if it is still wanted.
- `has closed, so nothing would run this brief`: Codex has unloaded that thread (its status is `notLoaded`), and the brief did not reach its queue. Run `$ERRANDS targets` and send to a live thread.
- `has not started and thread ... has closed`: Codex unloaded the thread after the send, the job is still in its queue, and nothing runs it. Tell the user that resuming that Codex session runs it. To send it elsewhere, run `$ERRANDS abandon <job id>` and send to a live thread; abandon does not remove the queued copy, so resuming that session later still runs it.
- `the brief joined a run the person started`: a pi or omp session took the brief into a turn the user had just started, so its answer may be to both. Show the user the final answer and ask whether to send the brief again.
- `the omp session did not take the brief` (or `pi`): the agent rejected the brief, with the reason given, and will not run it. Ask the user to check that pane, then send it again once the session is idle.
- `Person typed into the session during the run: yes`: the user steered the agent during the job. The outcome stands; mention it when you report.
- `Resumed after a Codex server restart: yes`: the Codex daemon restarted during the job and Codex continued the work in a new turn. The outcome stands. Codex may have repeated a step it had already done, so check the commits for duplicates, and mention the restart when you report.
- `has not started and the pi session ... that queued it is gone` (or `omp`): the TUI died before the brief started. Opening that session again in a TUI runs it. To send it elsewhere, run `$ERRANDS abandon <job id>`, which stops it from ever starting, and send to a live session.
- `dropped it before it started`: the outcome is `failed` and the brief never ran, for the reason given. Send it again if it is still wanted.
- `the ... session exited while the job ran; whether it finished is unknown`: review the worktree before sending anything again.
- `is open in 2 TUIs`: two TUIs hold one pi session. Ask the user to close all but one.
- `refused job`: the session refused it for the reason given, and no job id was printed. Run `$ERRANDS targets` and send again.
- `is in neither the queue nor the turns`: the thread does not hold the job, so nothing will run it, even if that thread is resumed. Run `$ERRANDS abandon <job id>` and send the brief again.
- Any other error from `wait`, such as a daemon call that failed: one failed poll ends `wait` with exit 1 and leaves the job as it was. Running `wait <job id>` again is safe.
- `delivery of job ... is unknown`: do not send again. Run `wait <job id>`; it reports what the daemon shows.
- `works in ..., which neither holds nor is inside the brief's worktree`: the thread belongs to another project. Run `$ERRANDS targets` and pass the thread whose directory is the brief's worktree, inside it, or a folder that holds it with `--target`.
- `works in ..., which does not hold the repository`, `the worktree` or `the common git directory`: a brief that creates its worktree needs a thread whose folder holds all three. Pick another thread, or another worktree path inside the thread's folder.
- `is at or inside the .git directory of the folder thread ... works in`: Codex keeps that directory read-only, a submodule's git directory in `.git/modules/` included. The brief needs a thread started in a folder above that one.
- `would show as untracked files in the repository`: the new worktree path is inside a work tree that does not ignore it. Ask the user before adding the line the error names to that repository's `.gitignore` or `.git/info/exclude`, or pick a path outside it.
- `is held by job ...`: one job per worktree. Wait for that job, or `$ERRANDS abandon <job id>` for a dead one. Abandoning does not stop the agent.
