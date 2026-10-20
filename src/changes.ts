// ABOUTME: Records what a worktree looked like when a job was sent, and reports what changed since:
// ABOUTME: commits, files outside the brief's allow-list, and files that were already modified beforehand.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'

export type Baseline = { baseCommit: string; dirty: Record<string, string> }
export type ChangeReport = { commits: string[]; outsideAllowList: string[]; modifiedBefore: string[]; uncommitted: boolean }

export const git = (worktree: string, ...args: string[]): string =>
  execFileSync('git', ['-C', worktree, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })

const nulSeparated = (output: string): string[] => output.split('\0').filter(entry => entry !== '')

// Porcelain v1 with -z: each entry is "XY path". With --no-renames a rename is a deletion and an addition,
// so both of its paths are listed and no entry carries a second path.
const dirtyPaths = (worktree: string): string[] =>
  nulSeparated(git(worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames')).map(entry => entry.slice(3))

// Working tree and index together: a path counts as untouched only when neither changed since the baseline.
const contentHash = (worktree: string, path: string): string => {
  const working = existsSync(join(worktree, path)) ? git(worktree, 'hash-object', '--', path).trim() : 'deleted'
  const staged = git(worktree, 'ls-files', '--stage', '-z', '--', path).split('\0').filter(entry => entry !== '').map(entry => entry.split(/\s+/, 2).join(' ')).join(',')
  return `${working} index:${staged === '' ? 'absent' : staged}`
}

export const captureBaseline = (worktree: string): Baseline => ({
  baseCommit: git(worktree, 'rev-parse', 'HEAD').trim(),
  dirty: Object.fromEntries(dirtyPaths(worktree).map(path => [path, contentHash(worktree, path)])),
})

export const reportChanges = (worktree: string, baseline: Baseline, allowedPaths: string[]): ChangeReport => {
  const committed = new Set(nulSeparated(git(worktree, 'diff', '--name-only', '-z', '--no-renames', baseline.baseCommit, 'HEAD')))
  const dirtyNow = dirtyPaths(worktree)
  const candidates = [...new Set([...committed, ...dirtyNow, ...Object.keys(baseline.dirty)])].sort()
  const outsideAllowList: string[] = []
  const modifiedBefore: string[] = []
  for (const path of candidates) {
    if (allowedPaths.some(glob => matchesGlob(path, glob))) continue
    const before = baseline.dirty[path]
    const untouched = before !== undefined && !committed.has(path) && contentHash(worktree, path) === before
    ;(untouched ? modifiedBefore : outsideAllowList).push(path)
  }
  const log = git(worktree, 'log', '--format=%h %s', `${baseline.baseCommit}..HEAD`).trim()
  return { commits: log === '' ? [] : log.split('\n'), outsideAllowList, modifiedBefore, uncommitted: dirtyNow.length > 0 }
}
