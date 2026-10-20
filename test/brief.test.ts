// ABOUTME: Tests for the brief parser: one valid brief and every way a brief is rejected,
// ABOUTME: with the exact message the author sees.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBrief } from '../src/brief.ts'

const VALID = `# Job: Add the relay
## Worktree
/work/tree
Branch: feature/relay

## Allowed paths
- src/relay/**
- test/relay/**

## Test command
\`npm test\`

## Rules
One commit per finding.

## Work
1. Build it.
`

const without = (heading: string): string => {
  const lines = VALID.split('\n')
  const start = lines.indexOf(heading)
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return [...lines.slice(0, start), ...(next === -1 ? [] : lines.slice(next))].join('\n')
}
const rejects = (text: string, message: string): void => { assert.throws(() => parseBrief(text), { message }) }

test('parses a valid brief', () => {
  assert.deepEqual(parseBrief(VALID), {
    title: 'Add the relay', workspace: { kind: 'existing', worktree: '/work/tree', branch: 'feature/relay' },
    allowedPaths: ['src/relay/**', 'test/relay/**'], testCommand: 'npm test',
    rules: 'One commit per finding.', work: '1. Build it.',
  })
})
test('rejects a missing title', () => rejects(VALID.replace('# Job: Add the relay', '# Add the relay'), 'brief: first line must be "# Job: <title>"'))
test('rejects a missing allow-list', () => rejects(without('## Allowed paths'), 'brief: missing section "## Allowed paths"'))
test('rejects a missing test command', () => rejects(without('## Test command'), 'brief: missing section "## Test command"'))
test('rejects empty work', () => rejects(VALID.replace('1. Build it.\n', ''), 'brief: section "## Work" is empty'))
test('rejects an absolute allowed path', () => rejects(VALID.replace('- src/relay/**', '- /etc/**'), 'brief: allowed path "/etc/**" must be relative to the worktree'))
test('rejects a parent-directory allowed path', () => rejects(VALID.replace('- src/relay/**', '- src/../secrets/**'), 'brief: allowed path "src/../secrets/**" must not contain ".."'))
test('rejects a non-list line in the allow-list', () => rejects(VALID.replace('- src/relay/**', 'src/**'), 'brief: line "src/**" in "## Allowed paths" is not a "- <glob>" entry'))
test('rejects a relative worktree', () => rejects(VALID.replace('/work/tree', 'relative/dir'), 'brief: worktree "relative/dir" must be an absolute path'))
test('rejects a missing branch', () => rejects(VALID.replace('Branch: feature/relay\n', ''), 'brief: section "## Worktree" has no "Branch: <name>" line'))
const CREATE = VALID.replace('Branch: feature/relay\n', 'Branch: feature/relay\nRepo: /work/repo\nBase: main\n')
test('parses a brief that asks for a new worktree', () => {
  assert.deepEqual(parseBrief(CREATE).workspace, { kind: 'create', repo: '/work/repo', base: 'main', worktree: '/work/tree', branch: 'feature/relay' })
})
test('rejects a repo without a base', () => rejects(CREATE.replace('Base: main\n', ''), 'brief: section "## Worktree" has a "Repo:" line but no "Base:" line'))
test('rejects a base without a repo', () => rejects(CREATE.replace('Repo: /work/repo\n', ''), 'brief: section "## Worktree" has a "Base:" line but no "Repo:" line'))
test('rejects a relative repo', () => rejects(CREATE.replace('/work/repo', 'work/repo'), 'brief: repo "work/repo" must be an absolute path'))
test('rejects a worktree or repo path with a "." or ".." part or a doubled "/"', () => {
  const message = (noun: string, path: string): string => `brief: ${noun} "${path}" must be normal, with no "." or ".." part and no doubled "/"`
  for (const path of ['/s/missing/../escape/job', '/work/./tree', '/work//tree']) rejects(CREATE.replace('/work/tree', path), message('worktree', path))
  rejects(CREATE.replace('/work/repo', '/work/x/../repo'), message('repo', '/work/x/../repo'))
})
test('accepts a worktree path with a trailing slash', () => assert.equal(parseBrief(CREATE.replace('/work/tree', '/work/tree/')).workspace.worktree, '/work/tree/'))
test('rejects a repeated section', () => rejects(VALID.replace('## Work', '## Rules\nAgain.\n\n## Work'), 'brief: section "## Rules" appears twice'))
test('accepts CRLF and trailing spaces', () => {
  const windows = VALID.replace('## Worktree', '## Worktree  ').replaceAll('\n', '\r\n')
  assert.deepEqual(parseBrief(windows), parseBrief(VALID))
})
test('keeps other headings inside work', () => {
  assert.equal(parseBrief(VALID.replace('1. Build it.', '1. Build it.\n## Notes\nMind the gap.')).work, '1. Build it.\n## Notes\nMind the gap.')
})
test('allows empty rules', () => assert.equal(parseBrief(VALID.replace('One commit per finding.\n', '')).rules, ''))
