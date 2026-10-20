// ABOUTME: Tests for reading the agent's declared result from its final answer, for turning
// ABOUTME: an ended turn into an outcome kind, and for capturing a create job's outcome against real git.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Job } from '../src/job.ts'
import { captureOutcome, classify, declarationOf } from '../src/outcome.ts'

test('done on the last line', () => assert.equal(declarationOf('All good.\nRESULT: done'), 'done'))
test('question on the last line', () => assert.equal(declarationOf('Which file?\nRESULT: question'), 'question'))
test('declined on the last line', () => assert.equal(declarationOf('Spec says otherwise.\nRESULT: declined'), 'declined'))
test('trailing blank lines are ignored', () => assert.equal(declarationOf('RESULT: done\n\n  \n'), 'done'))
test('a result line that is not last does not count', () => assert.equal(declarationOf('RESULT: done\nAlso I pushed.'), null))
test('a result line in backticks does not count', () => assert.equal(declarationOf('`RESULT: done`'), null))
test('an unknown result word does not count', () => assert.equal(declarationOf('RESULT: finished'), null))
test('lower case does not count', () => assert.equal(declarationOf('result: done'), null))
test('an indented result line does not count', () => assert.equal(declarationOf('  RESULT: done'), null))
test('no final answer has no declaration', () => assert.equal(declarationOf(null), null))
test('a completed turn takes its declaration', () => {
  assert.equal(classify({ kind: 'ended', status: 'completed', finalMessage: 'All good.\nRESULT: done', error: null }), 'done')
})
test('a completed turn without a final answer is unclassified', () => {
  assert.equal(classify({ kind: 'ended', status: 'completed', finalMessage: null, error: null }), 'unclassified')
})
test('a failed turn is failed whatever it declared', () => {
  assert.equal(classify({ kind: 'ended', status: 'failed', finalMessage: 'RESULT: done', error: '{"message":"boom"}' }), 'failed')
})

const temp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-outcome-')))
const git = (dir: string, ...args: string[]): string =>
  execFileSync('git', ['-C', dir, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', ...args], { encoding: 'utf8' })
const createJob = (): Job => {
  const repo = temp()
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'initial')
  return {
    id: 'errand-1', transport: 'codex', target: 'thread-a', briefPath: '/briefs/a.md', briefCopy: '/state/errand-1.brief.md',
    workspace: { kind: 'create', repo }, worktree: join(temp(), 'wt'), branch: 'job', baseline: { baseCommit: git(repo, 'rev-parse', 'HEAD').trim(), dirty: {} },
    allowedPaths: ['src/**'], sessionId: null, sentAt: '2026-10-19T00:00:00.000Z', delivery: 'sent', outcome: null,
  }
}
const declaredDone = { kind: 'ended', status: 'completed', finalMessage: 'Made it.\nRESULT: done', error: null } as const
test('a create job whose worktree was never made ends no-worktree, with no change report', () => {
  const job = createJob()
  const { capturedAt: _, ...outcome } = captureOutcome(job, declaredDone)
  assert.deepEqual(outcome, { kind: 'no-worktree', finalMessage: 'Made it.\nRESULT: done', error: `worktree ${job.worktree} does not exist`, changes: null })
})
test('a create job whose worktree is in place is classified and its changes reported against the base', () => {
  const job = createJob()
  if (job.workspace.kind !== 'create') throw new Error('createJob makes a create job')
  git(job.workspace.repo, 'worktree', 'add', '-q', '-b', 'job', job.worktree, job.baseline.baseCommit)
  writeFileSync(join(job.worktree, 'notes.txt'), 'outside\n')
  git(job.worktree, 'add', '-A')
  git(job.worktree, 'commit', '-q', '-m', 'add notes')
  const { capturedAt: _, changes, ...outcome } = captureOutcome(job, declaredDone)
  assert.deepEqual(outcome, { kind: 'done', finalMessage: 'Made it.\nRESULT: done', error: null })
  assert.deepEqual([changes?.commits.map(commit => commit.split(' ').slice(1).join(' ')), changes?.outsideAllowList], [['add notes'], ['notes.txt']])
})
