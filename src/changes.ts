// ABOUTME: Records what a worktree looked like when a job was sent, and reports what changed since:
// ABOUTME: commits, files outside the brief's allow-list, files another branch brought in, and files already modified beforehand.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'

// branchesAtSend: the local and remote-tracking branches that held commits the base commit lacks at send time, by full
// name, with the commit each pointed to then. A record written before they were noted has none, and its report takes
// nothing as brought in.
export type Baseline = { baseCommit: string; dirty: Record<string, string>; branchesAtSend?: Record<string, string> }
// from: the branch the job's branch took commits in from, by rebase or merge; commit: the newest of them, abbreviated;
// paths: those outside the allow-list that are the same now as at that commit.
export type BroughtIn = { from: string; commit: string; paths: string[] }
// broughtIn: present only when it has paths.
export type ChangeReport = { commits: string[]; outsideAllowList: string[]; modifiedBefore: string[]; uncommitted: boolean; broughtIn?: BroughtIn }

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

// A branch whose commits the base already holds can bring nothing in, so it is not recorded. A remote's HEAD is left
// out: it is a second name for one of that remote's branches.
export const branchesAhead = (repository: string, baseCommit: string): Record<string, string> =>
  Object.fromEntries(git(repository, 'for-each-ref', `--no-merged=${baseCommit}`, '--format=%(refname) %(objectname)', 'refs/heads', 'refs/remotes')
    .split('\n').filter(line => line !== '').map(line => line.split(' ') as [string, string]).filter(([name]) => !/^refs\/remotes\/[^/]+\/HEAD$/.test(name)))

export const captureBaseline = (worktree: string): Baseline => {
  const baseCommit = git(worktree, 'rev-parse', 'HEAD').trim()
  return { baseCommit, dirty: Object.fromEntries(dirtyPaths(worktree).map(path => [path, contentHash(worktree, path)])), branchesAtSend: branchesAhead(worktree, baseCommit) }
}

const shortName = (ref: string): string => ref.replace(/^refs\/(heads|remotes)\//, '')

const isAncestor = (worktree: string, ancestor: string, descendant: string): boolean =>
  spawnSync('git', ['-C', worktree, 'merge-base', '--is-ancestor', ancestor, descendant]).status === 0

// The newest commit the job's branch holds since the baseline that a branch pointed at when the job was sent, and
// that branch. Where the branches pointed at send time is what counts, not where they point now: a branch the agent
// creates, moves or pushes onto its own commits brings nothing in. The commit must descend from the base: then all
// between the base and it is the other branch's, and all after it the job's. Without that, as when the job's rebase
// rewrote commits made on the branch before the job, trees cannot tell the two apart, and nothing counts as brought in.
const upstreamTakenIn = (worktree: string, baseline: Baseline): { from: string; commit: string } | undefined => {
  const recorded = Object.entries(baseline.branchesAtSend ?? {})
  // A recorded commit can be gone, after a branch was deleted and pruned; rev-list would refuse the whole list.
  const distinct = [...new Set(recorded.map(([, tip]) => tip))]
  const kinds = execFileSync('git', ['-C', worktree, 'cat-file', '--batch-check=%(objecttype)'], { input: distinct.join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n')
  const tips = distinct.filter((_, index) => kinds[index] === 'commit')
  if (tips.length === 0) return undefined
  const sinceBase = git(worktree, 'rev-list', '--topo-order', `${baseline.baseCommit}..HEAD`).split('\n').filter(commit => commit !== '')
  const notRecorded = new Set(execFileSync('git', ['-C', worktree, 'rev-list', '--stdin'], { input: ['HEAD', `^${baseline.baseCommit}`, ...tips.map(tip => `^${tip}`)].join('\n'), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n'))
  const commit = sinceBase.find(candidate => !notRecorded.has(candidate))
  const from = recorded.find(([, tip]) => tip === commit)
  if (commit === undefined || from === undefined || !isAncestor(worktree, baseline.baseCommit, commit)) return undefined
  return { from: shortName(from[0]), commit }
}

export const reportChanges = (worktree: string, baseline: Baseline, allowedPaths: string[]): ChangeReport => {
  const committed = new Set(nulSeparated(git(worktree, 'diff', '--name-only', '-z', '--no-renames', baseline.baseCommit, 'HEAD')))
  const dirtyNow = new Set(dirtyPaths(worktree))
  const upstream = upstreamTakenIn(worktree, baseline)
  // Everything after the upstream commit is the job's, including a change that puts a path back as the base had it.
  const changedSinceUpstream = upstream === undefined ? null : new Set(nulSeparated(git(worktree, 'diff', '--name-only', '-z', '--no-renames', upstream.commit, 'HEAD')))
  const candidates = [...new Set([...committed, ...(changedSinceUpstream ?? []), ...dirtyNow, ...Object.keys(baseline.dirty)])].sort()
  const outsideAllowList: string[] = []
  const modifiedBefore: string[] = []
  const broughtInPaths: string[] = []
  for (const path of candidates) {
    if (allowedPaths.some(glob => matchesGlob(path, glob))) continue
    const before = baseline.dirty[path]
    const untouched = before !== undefined && !committed.has(path) && contentHash(worktree, path) === before
    const broughtIn = changedSinceUpstream !== null && committed.has(path) && !changedSinceUpstream.has(path) && before === undefined && !dirtyNow.has(path)
    ;(untouched ? modifiedBefore : broughtIn ? broughtInPaths : outsideAllowList).push(path)
  }
  const log = git(worktree, 'log', '--format=%h %s', `${baseline.baseCommit}..HEAD`, ...(upstream === undefined ? [] : [`^${upstream.commit}`])).trim()
  return {
    commits: log === '' ? [] : log.split('\n'), outsideAllowList, modifiedBefore, uncommitted: dirtyNow.size > 0,
    ...(upstream !== undefined && broughtInPaths.length > 0 ? { broughtIn: { from: upstream.from, commit: git(worktree, 'rev-parse', '--short', upstream.commit).trim(), paths: broughtInPaths } } : {}),
  }
}
