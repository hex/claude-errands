// ABOUTME: Tests the change report against real git repositories: what an agent committed or left
// ABOUTME: uncommitted since a job's baseline, split by the brief's allow-list.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { captureBaseline, reportChanges } from '../src/changes.ts'

const scratch = (): { dir: string; write(path: string, text: string): void; run(...args: string[]): void } => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-changes-')))
  const run = (...args: string[]): void => { execFileSync('git', ['-C', dir, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', ...args]) }
  const write = (path: string, text: string): void => {
    mkdirSync(dirname(join(dir, path)), { recursive: true })
    writeFileSync(join(dir, path), text)
  }
  run('init', '-q', '-b', 'main')
  write('README.md', 'scratch\n')
  write('other.txt', 'one\n')
  run('add', '-A')
  run('commit', '-q', '-m', 'initial')
  return { dir, write, run }
}

test('a commit inside the allow-list is clean', () => {
  const repo = scratch()
  const baseline = captureBaseline(repo.dir)
  repo.write('src/a.ts', 'export const a = 1\n')
  repo.run('add', '-A')
  repo.run('commit', '-q', '-m', 'add a')
  const report = reportChanges(repo.dir, baseline, ['src/**'])
  assert.equal(report.commits.length, 1)
  assert.match(report.commits[0] ?? '', / add a$/)
  assert.deepEqual([report.outsideAllowList, report.modifiedBefore, report.uncommitted], [[], [], false])
})
test('a commit outside the allow-list is reported', () => {
  const repo = scratch()
  const baseline = captureBaseline(repo.dir)
  repo.write('docs/x.md', 'x\n')
  repo.run('add', '-A')
  repo.run('commit', '-q', '-m', 'add doc')
  assert.deepEqual(reportChanges(repo.dir, baseline, ['src/**']).outsideAllowList, ['docs/x.md'])
})
test('an uncommitted file outside the allow-list is reported', () => {
  const repo = scratch()
  const baseline = captureBaseline(repo.dir)
  repo.write('notes.txt', 'n\n')
  const report = reportChanges(repo.dir, baseline, ['src/**'])
  assert.deepEqual([report.outsideAllowList, report.uncommitted], [['notes.txt'], true])
})
test('a file modified before the job and untouched since is listed separately', () => {
  const repo = scratch()
  repo.write('other.txt', 'two\n')
  const baseline = captureBaseline(repo.dir)
  const report = reportChanges(repo.dir, baseline, ['src/**'])
  assert.deepEqual([report.outsideAllowList, report.modifiedBefore], [[], ['other.txt']])
})
test('a file modified before the job and changed again is outside the allow-list', () => {
  const repo = scratch()
  repo.write('other.txt', 'two\n')
  const baseline = captureBaseline(repo.dir)
  repo.write('other.txt', 'three\n')
  const report = reportChanges(repo.dir, baseline, ['src/**'])
  assert.deepEqual([report.outsideAllowList, report.modifiedBefore], [['other.txt'], []])
})
test('a file modified before the job and restored since is outside the allow-list', () => {
  const repo = scratch()
  repo.write('other.txt', 'two\n')
  const baseline = captureBaseline(repo.dir)
  repo.run('checkout', '--', 'other.txt')
  assert.deepEqual(reportChanges(repo.dir, baseline, ['src/**']).outsideAllowList, ['other.txt'])
})
test('a rename is reported under both paths, spaces intact', () => {
  const repo = scratch()
  const baseline = captureBaseline(repo.dir)
  mkdirSync(join(repo.dir, 'docs'))
  repo.run('mv', 'README.md', 'docs/READ ME.md')
  repo.run('commit', '-q', '-m', 'rename')
  assert.deepEqual(reportChanges(repo.dir, baseline, ['src/**']).outsideAllowList, ['README.md', 'docs/READ ME.md'])
})
test('an uncommitted rename is reported under both paths', () => {
  const repo = scratch()
  // Whatever the user's git configuration says about rename detection in status.
  repo.run('config', 'status.renames', 'true')
  const baseline = captureBaseline(repo.dir)
  repo.run('mv', 'other.txt', 'moved.txt')
  assert.deepEqual(reportChanges(repo.dir, baseline, ['src/**']).outsideAllowList, ['moved.txt', 'other.txt'])
})
test('a pre-modified file deleted during the job is outside the allow-list', () => {
  const repo = scratch()
  repo.write('other.txt', 'two\n')
  const baseline = captureBaseline(repo.dir)
  rmSync(join(repo.dir, 'other.txt'))
  assert.deepEqual(reportChanges(repo.dir, baseline, ['src/**']).outsideAllowList, ['other.txt'])
})
test('a file committed during the job is outside the allow-list even if it was modified before', () => {
  const repo = scratch()
  repo.write('other.txt', 'two\n')
  const baseline = captureBaseline(repo.dir)
  repo.run('add', 'other.txt')
  repo.run('commit', '-q', '-m', 'commit other')
  const report = reportChanges(repo.dir, baseline, ['src/**'])
  assert.deepEqual([report.outsideAllowList, report.modifiedBefore], [['other.txt'], []])
})
test('a pre-modified file whose staged content changed is outside the allow-list', () => {
  const repo = scratch()
  repo.write('other.txt', 'two\n')
  const baseline = captureBaseline(repo.dir)
  repo.write('other.txt', 'staged\n')
  repo.run('add', 'other.txt')
  repo.write('other.txt', 'two\n')
  const report = reportChanges(repo.dir, baseline, ['src/**'])
  assert.deepEqual([report.outsideAllowList, report.modifiedBefore], [['other.txt'], []])
})
