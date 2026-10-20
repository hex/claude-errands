---
name: brief
description: Use when writing a brief for another coding agent, to send with claude-errands - the required headings, the allow-list, and the rules that keep the agent's work reviewable.
---

# Writing a brief

A brief is one Markdown file per job. claude-errands' `send` rejects a brief that does not have these headings.

```markdown
# Job: <one line>

## Worktree
<absolute path of the agent's worktree>
Branch: <branch checked out there>

## Allowed paths
- <glob relative to the worktree, one per line>

## Test command
`<the exact command, with set -o pipefail if it pipes>`

## Rules
<see below>

## Work
<numbered findings or tasks, each with file:line where known>
```

claude-errands rejects: a missing or empty section (`Rules` may be empty), a first line that is not `# Job: <title>`, a relative worktree path or one with a `.` or `..` part or a doubled `/`, a `Worktree` section without a `Branch:` line, a repeated heading, an allow-list line that is not `- <glob>`, and an allow-list entry that is absolute or contains `..`. At send time it also checks that the worktree exists, is a git work tree, and is on the stated branch.

## A new worktree for the job

When the Codex session works in a folder above the repository (a cs session root holding `repo/`), the agent can create the job's worktree itself. Name the worktree to create and its new branch, and add the repository and the base:

```markdown
## Worktree
<absolute path of the worktree the agent creates>
Branch: <new branch>
Repo: <absolute path of the repository's root>
Base: <commit, branch or tag to start from>
```

`Repo:` and `Base:` come together or not at all, and `Repo:` follows the worktree path's rules: absolute, with no `.` or `..` part and no doubled `/`. At send time claude-errands refuses the brief when the repository is not a repository root, the base is not a commit, the branch is invalid or already exists, the worktree path exists or passes through a broken symlink, the worktree path sits in a work tree that does not ignore it (the error names the `.gitignore` line to add), or the Codex thread's folder does not hold the repository, the worktree path and the repository's git directory. claude-errands puts the exact `git worktree add` command in the agent's message; do not write it into the brief. A follow-up brief for that worktree is an ordinary brief without `Repo:` and `Base:`.

## Allowed paths

List every path the agent may change, as globs (`src/relay/**`). Keep it disjoint from the paths you edit yourself during the job. When the job ends, claude-errands reports every path the agent changed outside the list.

## Rules that have worked

- One commit per finding. No push, no deploy.
- Test first: quote the failing test line in the final message before the fix.
- Where a finding and the spec disagree, follow the spec and say so.
- Name the paths that are off limits, even though the allow-list implies them.
- The final message lists commit ids, the test count, and anything that did not fit.

Do not write the `RESULT:` instruction yourself. claude-errands adds it to every job.
