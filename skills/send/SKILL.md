---
name: send
description: Use when handing a written brief to the user's live Codex session and acting on how its turn ended - sending, waiting in the background, and what to do for each outcome.
---

# Sending a brief and acting on the outcome

`ERRANDS="node ${CLAUDE_PLUGIN_ROOT}/src/cli.ts"`

1. Write the brief (see the `brief` skill).
2. Send it. `$ERRANDS targets` lists loaded threads. If the person approved a plan that names a thread for each brief, use that thread. Otherwise ask the person which thread with AskUserQuestion, one option per open session; never pick one yourself. Run `$ERRANDS send <brief.md> --target <thread id>`. Pass `--target` on every send when more than one Codex session is open. The command prints a job id.
3. Wait in the background, so the harness wakes you when the turn ends: run `$ERRANDS wait <job id>` with the Bash tool's `run_in_background: true` and `timeout: 7200000`. The Bash tool stops a background command after 30 minutes unless you pass that timeout; two hours is its maximum, and claude-errands' own `--timeout` default of 110 minutes stays under it. Do not poll it.
4. Act on the outcome it prints.

| Outcome | What it means | What you do |
|---|---|---|
| `done` | The agent says it finished. This is its claim. | Review the listed commits before telling the user the work is complete. |
| `question` | The agent needs an answer. | Answer with a follow-up brief if you can answer from the spec; otherwise ask the user. |
| `declined` | The agent chose not to do some of the work. | Give the user the agent's reason, verbatim. |
| `unclassified` | No final answer, or no `RESULT` line. | Read the final answer and treat it as a question. |
| `failed` | The turn did not complete. | Report the error to the user. |
| `no-worktree` | The agent was to create the job's worktree, and it is missing, belongs to another repository, is on another branch, or does not descend from the base. | Report the error and the final answer to the user. No change report follows. |

Whatever the outcome: if `Outside allow-list` lists any path, tell the user before reviewing anything else. claude-errands never undoes the agent's work; you undo it only when the user asks.

Do not edit a job's worktree while the job is open. claude-errands reports every change there as the agent's.

Other output:

- `still running`: the wait reached its time limit. Run `wait` again.
- `is waiting on an approval in the agent's pane`: tell the user their Codex pane needs them.
- `delivery of job ... is unknown`: do not send again. Run `wait <job id>`; it reports what the daemon shows.
- `works in ..., which neither holds nor is inside the brief's worktree`: the thread belongs to another project. Run `$ERRANDS targets` and pass the thread whose directory is the brief's worktree, inside it, or a folder that holds it with `--target`.
- `works in ..., which does not hold the repository`, `the worktree` or `the common git directory`: a brief that creates its worktree needs a thread whose folder holds all three. Pick another thread, or another worktree path inside the thread's folder.
- `is at or inside the .git directory of the folder thread ... works in`: Codex keeps that directory read-only, a submodule's git directory in `.git/modules/` included. The brief needs a thread started in a folder above that one.
- `would show as untracked files in the repository`: the new worktree path is inside a work tree that does not ignore it. Ask the user before adding the line the error names to that repository's `.gitignore` or `.git/info/exclude`, or pick a path outside it.
- `is held by job ...`: one job per worktree. Wait for that job, or `$ERRANDS abandon <job id>` for a dead one. Abandoning does not stop the agent.
