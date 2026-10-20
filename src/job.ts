// ABOUTME: Job records and the per-session remembered target, kept as JSON files under the state directory.
// ABOUTME: Also checks a brief's workspace before sending and a created worktree after the turn, and finds a worktree's open job.
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { Workspace } from './brief.ts'
import { captureBaseline, type Baseline, type ChangeReport } from './changes.ts'
import type { OutcomeKind } from './outcome.ts'

export type Delivery = 'sending' | 'sent' | 'unknown'
export type Outcome = { kind: OutcomeKind | 'abandoned'; finalMessage: string | null; error: string | null; changes: ChangeReport | null; capturedAt: string }
export type Job = {
  id: string; transport: 'codex'; target: string; briefPath: string; briefCopy: string
  workspace: { kind: 'existing' } | { kind: 'create'; repo: string }; worktree: string; branch: string; baseline: Baseline; allowedPaths: string[]
  sessionId: string | null; sentAt: string; delivery: Delivery; outcome: Outcome | null
}

export const stateDir = (): string => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'claude-errands')
const jobsDir = (): string => join(stateDir(), 'jobs')
const targetsDir = (): string => join(stateDir(), 'targets')

const writeAtomically = (path: string, text: string): void => {
  writeFileSync(`${path}.partial`, text)
  renameSync(`${path}.partial`, path)
}

export const saveJob = (job: Job): void => {
  mkdirSync(jobsDir(), { recursive: true })
  writeAtomically(join(jobsDir(), `${job.id}.json`), `${JSON.stringify(job, null, 2)}\n`)
}

export const loadJob = (id: string): Job => {
  const path = join(jobsDir(), `${id}.json`)
  if (!existsSync(path)) throw new Error(`no job record ${id} in ${jobsDir()}`)
  // Job files are written only by saveJob, so their shape is the Job type.
  return JSON.parse(readFileSync(path, 'utf8')) as Job
}

export const openJobFor = (worktree: string): Job | undefined => {
  if (!existsSync(jobsDir())) return undefined
  return readdirSync(jobsDir()).filter(name => name.endsWith('.json'))
    .map(name => loadJob(name.slice(0, -'.json'.length)))
    .find(job => job.worktree === worktree && job.outcome === null)
}

// The repository root at path, resolved through the filesystem; noun names the brief field in errors.
const repositoryRoot = (noun: string, path: string): string => {
  if (!existsSync(path)) throw new Error(`${noun} "${path}" does not exist`)
  const root = realpathSync(path)
  // Exits non-zero outside a repository, and prints "false" inside a .git directory.
  const inside = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') throw new Error(`${noun} "${path}" is not inside a git work tree`)
  // Git reports paths relative to the repository root, and the brief's globs are relative to its worktree; the two must agree.
  const toplevel = realpathSync(execFileSync('git', ['-C', root, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
  if (toplevel !== root) throw new Error(`${noun} "${path}" is inside the repository at "${toplevel}"; the brief's ${noun} must be the repository root`)
  return root
}

export const canonicalWorktree = (workspace: { worktree: string; branch: string }): string => {
  const worktree = repositoryRoot('worktree', workspace.worktree)
  const branch = execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
  if (branch !== workspace.branch) throw new Error(`worktree "${workspace.worktree}" is on branch "${branch}", the brief says "${workspace.branch}"`)
  return worktree
}

// Where git keeps a repository's branches and its worktrees' registrations; a linked worktree's lies outside it.
const commonGitDir = (dir: string): string =>
  realpathSync(execFileSync('git', ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim())

// A brief's workspace with its paths made canonical and checked, ready to be recorded and locked.
export type ResolvedWorkspace =
  | { kind: 'existing'; worktree: string; branch: string }
  | { kind: 'create'; repo: string; worktree: string; branch: string; baseCommit: string; commonDir: string }

// Unlike existsSync, true for a symlink whose target is missing. A trailing slash would make lstat follow the link,
// so it is dropped first.
const entryExists = (path: string): boolean => lstatSync(path.replace(/(.)\/+$/, '$1'), { throwIfNoEntry: false }) !== undefined

// A new worktree path that does not exist yet is resolved through its nearest existing parent, so a symlink or a
// trailing slash still leads to one lock. The brief parser refuses a ".." part, so nothing below that parent exists
// and none of it can be a symlink. A broken symlink on the way would send git somewhere else.
const canonicalPath = (given: string, path = given): string => {
  if (!entryExists(path)) return join(canonicalPath(given, dirname(path)), basename(path))
  if (!existsSync(path)) throw new Error(`worktree "${given}" passes through the broken symlink "${path}", which points to "${readlinkSync(path)}"`)
  return realpathSync(path)
}

// A new worktree inside another work tree that does not ignore it would show there as untracked files.
const refuseUnignored = (given: string, worktree: string): void => {
  let parent = dirname(worktree)
  while (!existsSync(parent)) parent = dirname(parent)
  const inside = spawnSync('git', ['-C', parent, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' })
  if (inside.status !== 0 || inside.stdout.trim() !== 'true') return
  const toplevel = realpathSync(execFileSync('git', ['-C', parent, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim())
  const line = `/${relative(toplevel, worktree)}/`
  // The trailing slash says the path is a directory, which a pattern such as "!dir/*/" treats differently from a file.
  const ignored = spawnSync('git', ['-C', toplevel, 'check-ignore', '--quiet', '--', line.slice(1)], { encoding: 'utf8' })
  if (ignored.status === 0) return
  if (ignored.status !== 1) throw new Error(`git check-ignore failed for "${worktree}" in "${toplevel}": ${ignored.stderr.trim()}`)
  const exclude = execFileSync('git', ['-C', toplevel, 'rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], { encoding: 'utf8' }).trim()
  throw new Error(`worktree "${given}" would show as untracked files in the repository "${toplevel}"; add the line "${line}" to ${toplevel}/.gitignore or ${exclude}`)
}

const resolveCreate = (workspace: Extract<Workspace, { kind: 'create' }>): ResolvedWorkspace => {
  const repo = repositoryRoot('repo', workspace.repo)
  // The commit id is recorded, so a branch named as the base that moves after the send changes nothing.
  const base = spawnSync('git', ['-C', repo, 'rev-parse', '--verify', '--quiet', '--end-of-options', `${workspace.base}^{commit}`], { encoding: 'utf8' })
  if (base.status !== 0) throw new Error(`base "${workspace.base}" is not a commit in the repository "${repo}"`)
  // --branch expands @{-N} to an older branch's name, so the output must be the name the brief gave.
  const format = spawnSync('git', ['-C', repo, 'check-ref-format', '--branch', workspace.branch], { encoding: 'utf8' })
  if (format.status !== 0 || format.stdout.trim() !== workspace.branch) throw new Error(`branch "${workspace.branch}" is not a valid branch name`)
  if (spawnSync('git', ['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${workspace.branch}`]).status === 0) throw new Error(`branch "${workspace.branch}" already exists in the repository "${repo}"`)
  if (entryExists(workspace.worktree)) throw new Error(`worktree "${workspace.worktree}" already exists; the agent creates it`)
  const worktree = canonicalPath(workspace.worktree)
  refuseUnignored(workspace.worktree, worktree)
  return { kind: 'create', repo, worktree, branch: workspace.branch, baseCommit: base.stdout.trim(), commonDir: commonGitDir(repo) }
}

export const resolveWorkspace = (workspace: Workspace): ResolvedWorkspace => {
  switch (workspace.kind) {
    case 'existing': return { kind: 'existing', worktree: canonicalWorktree(workspace), branch: workspace.branch }
    case 'create': return resolveCreate(workspace)
  }
}

export const rememberTarget = (sessionId: string, target: string): void => {
  mkdirSync(targetsDir(), { recursive: true })
  writeAtomically(join(targetsDir(), `${sessionId}.json`), `${JSON.stringify({ target })}\n`)
}

export const rememberedTarget = (sessionId: string): string | undefined => {
  const path = join(targetsDir(), `${sessionId}.json`)
  if (!existsSync(path)) return undefined
  // Target files are written only by rememberTarget.
  return (JSON.parse(readFileSync(path, 'utf8')) as { target: string }).target
}

// A job's outcome is written once. Returns false, and leaves the record alone, when one is already stored.
export const settleJob = (id: string, outcome: Outcome): boolean => {
  const current = loadJob(id)
  if (current.outcome !== null) return false
  saveJob({ ...current, delivery: current.delivery === 'sending' ? 'sent' : current.delivery, outcome })
  return true
}

const locksDir = (): string => join(stateDir(), 'locks')
const lockPath = (worktree: string): string => join(locksDir(), `${createHash('sha256').update(worktree).digest('hex')}.json`)

// Reserves a worktree for a job with an exclusive create, so two concurrent sends cannot both take it.
// Returns the id of the job that holds it, or undefined when the claim succeeded. A holder whose job has an
// outcome, or no record, has released it.
export const claimWorktree = (worktree: string, jobId: string): string | undefined => {
  mkdirSync(locksDir(), { recursive: true })
  const path = lockPath(worktree)
  for (;;) {
    try {
      writeFileSync(path, `${JSON.stringify({ worktree, jobId })}\n`, { flag: 'wx' })
      return undefined
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    }
    // Lock files are written only here.
    const holder = (JSON.parse(readFileSync(path, 'utf8')) as { jobId: string }).jobId
    const holderOpen = existsSync(join(jobsDir(), `${holder}.json`)) && loadJob(holder).outcome === null
    if (holderOpen) return holder
    // Released: remove it and try again, since another sender may be racing for the same release.
    rmSync(path, { force: true })
  }
}

// The part of a job record that comes from its workspace. A worktree the agent creates has nothing modified yet.
export const recordedWorkspace = (workspace: ResolvedWorkspace): Pick<Job, 'workspace' | 'worktree' | 'branch' | 'baseline'> => {
  switch (workspace.kind) {
    case 'existing': return { workspace: { kind: 'existing' }, worktree: workspace.worktree, branch: workspace.branch, baseline: captureBaseline(workspace.worktree) }
    case 'create': return { workspace: { kind: 'create', repo: workspace.repo }, worktree: workspace.worktree, branch: workspace.branch, baseline: { baseCommit: workspace.baseCommit, dirty: {} } }
  }
}

const within = (outer: string, inner: string): boolean => {
  const path = relative(outer, inner)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

// Whether a thread working in cwd is working on this worktree: the same directory, or one inside it.
// Both sides are resolved through the filesystem, so a trailing slash or a symlink does not matter.
// A cwd that no longer exists belongs to nothing.
export const worktreeHolds = (worktree: string, cwd: string): boolean => existsSync(cwd) && within(worktree, realpathSync(cwd))

// Why a thread working in cwd must not take a job for this workspace, or null when it may.
export const threadRefusal = (workspace: ResolvedWorkspace, target: string, cwd: string): string | null => {
  const folderHolds = (path: string): boolean => existsSync(cwd) && within(realpathSync(cwd), path)
  switch (workspace.kind) {
    case 'existing':
      return worktreeHolds(workspace.worktree, cwd) || folderHolds(workspace.worktree)
        ? null
        : `thread ${target} works in ${cwd}, which neither holds nor is inside the brief's worktree ${workspace.worktree}; pick a thread with: targets`
    case 'create': {
      // git worktree add writes the branch and the worktree's registration into the common git directory.
      const needed = [['repository', workspace.repo], ['worktree', workspace.worktree], ['common git directory', workspace.commonDir]] as const
      const missing = needed.find(([, path]) => !folderHolds(path))
      if (missing !== undefined) return `thread ${target} works in ${cwd}, which does not hold the ${missing[0]} ${missing[1]}; Codex can write only inside the folder it works in; pick a thread with: targets`
      // A submodule's lies inside the superproject's, at .git/modules/<name>.
      if (within(join(realpathSync(cwd), '.git'), workspace.commonDir)) return `the common git directory ${workspace.commonDir} is at or inside the .git directory of the folder thread ${target} works in, ${cwd}, which Codex keeps read-only; pick a thread working in a folder above it with: targets`
      return null
    }
  }
}

// Wrapped in ' with each ' written as '\'', so a POSIX shell reads the value as one word and runs nothing in it.
const shellQuoted = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

// The command a create job's agent runs first, with every value from the validated brief quoted.
export const worktreeAddCommand = (fields: { repo: string; branch: string; worktree: string; baseCommit: string }): string =>
  `git -C ${shellQuoted(fields.repo)} worktree add -b ${shellQuoted(fields.branch)} ${shellQuoted(fields.worktree)} ${shellQuoted(fields.baseCommit)}`

// The line a job's message starts with, before the agent reads its brief.
export const firstStep = (job: Job): string | null => {
  switch (job.workspace.kind) {
    case 'existing': return null
    case 'create': return `First create the job's worktree: ${worktreeAddCommand({ repo: job.workspace.repo, branch: job.branch, worktree: job.worktree, baseCommit: job.baseline.baseCommit })}`
  }
}

// What is wrong with the worktree a create job's agent was to make, checked when the turn ends; empty when nothing is.
export const createdWorktreeProblems = (job: Job): string[] => {
  switch (job.workspace.kind) {
    case 'existing': return []
    case 'create': {
      if (!existsSync(job.worktree)) return [`worktree ${job.worktree} does not exist`]
      const toplevel = spawnSync('git', ['-C', job.worktree, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })
      if (toplevel.status !== 0 || realpathSync(toplevel.stdout.trim()) !== realpathSync(job.worktree)) return [`worktree ${job.worktree} is not the root of a git work tree`]
      const problems: string[] = []
      const commonDir = commonGitDir(job.worktree)
      if (commonDir !== commonGitDir(job.workspace.repo)) problems.push(`worktree ${job.worktree} belongs to the repository whose git directory is ${commonDir}, not to ${job.workspace.repo}`)
      const branch = execFileSync('git', ['-C', job.worktree, 'branch', '--show-current'], { encoding: 'utf8' }).trim()
      if (branch !== job.branch) problems.push(`worktree ${job.worktree} is on branch "${branch}", the job's branch is "${job.branch}"`)
      // Exit 1 is "not an ancestor"; any other failure, such as a base commit this repository lacks, says the same.
      const ancestor = spawnSync('git', ['-C', job.worktree, 'merge-base', '--is-ancestor', job.baseline.baseCommit, 'HEAD'])
      if (ancestor.status !== 0) problems.push(`worktree ${job.worktree} does not descend from the base commit ${job.baseline.baseCommit}`)
      return problems
    }
  }
}
