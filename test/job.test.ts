// ABOUTME: Tests the job store against a temporary state directory and real git worktrees:
// ABOUTME: records round-trip, the one-open-job-per-worktree lookup, workspace checks before and after a job, the remembered target.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, test } from 'node:test'
import { canonicalWorktree, claimWorktree, createdWorktreeProblems, firstStep, recordedWorkspace, resolveWorkspace, threadRefusal, worktreeAddCommand, loadJob, openJobFor, rememberTarget, rememberedTarget, saveJob, settleJob, stateDir, worktreeHolds, type Job } from '../src/job.ts'

const temp = (): string => realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-job-')))
beforeEach(() => { process.env.XDG_STATE_HOME = temp() })

const job = (overrides: Partial<Job> = {}): Job => ({
  id: 'relay-1', transport: 'codex', target: 'thread-a', briefPath: '/briefs/a.md', briefCopy: '/state/relay-1.brief.md', workspace: { kind: 'existing' },
  worktree: '/work/tree', branch: 'main', baseline: { baseCommit: 'abc', dirty: {} }, allowedPaths: ['src/**'],
  sessionId: 'test-session', sentAt: '2026-10-01T00:00:00.000Z', delivery: 'sent', outcome: null, ...overrides,
})
const repoOn = (branch: string): string => {
  const dir = temp()
  execFileSync('git', ['-C', dir, 'init', '-q', '-b', branch])
  writeFileSync(join(dir, 'f'), 'f')
  execFileSync('git', ['-C', dir, 'add', '-A'])
  execFileSync('git', ['-C', dir, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '-m', 'initial'])
  return dir
}
const brief = (worktree: string, branch: string) => ({ kind: 'existing' as const, worktree, branch })

test('a saved job loads back equal', () => { saveJob(job()); assert.deepEqual(loadJob('relay-1'), job()) })
test('an unknown job is an error naming the directory', () => {
  assert.throws(() => loadJob('relay-missing'), { message: `no job record relay-missing in ${stateDir()}/jobs` })
})
test('the open job for a worktree is the one without an outcome', () => {
  saveJob(job({ id: 'relay-old', outcome: { kind: 'done', finalMessage: 'RESULT: done', error: null, changes: null, capturedAt: '2026-10-01T00:00:00.000Z' } }))
  assert.equal(openJobFor('/work/tree'), undefined)
  saveJob(job({ id: 'relay-new' }))
  assert.equal(openJobFor('/work/tree')?.id, 'relay-new')
})
test('a missing worktree is rejected', () => {
  assert.throws(() => canonicalWorktree(brief('/no/such/dir', 'main')), { message: 'worktree "/no/such/dir" does not exist' })
})
test('a directory outside git is rejected', () => {
  const dir = temp()
  assert.throws(() => canonicalWorktree(brief(dir, 'main')), { message: `worktree "${dir}" is not inside a git work tree` })
})
test('a branch mismatch is rejected', () => {
  const dir = repoOn('main')
  assert.throws(() => canonicalWorktree(brief(dir, 'feature/x')), { message: `worktree "${dir}" is on branch "main", the brief says "feature/x"` })
})
test('lock uses the canonical worktree path', () => {
  const dir = repoOn('main')
  const link = join(temp(), 'link')
  symlinkSync(dir, link)
  assert.equal(canonicalWorktree(brief(`${dir}/`, 'main')), dir)
  assert.equal(canonicalWorktree(brief(link, 'main')), dir)
})
test('a target is remembered per Claude session', () => {
  rememberTarget('test-session', 'thread-a')
  assert.deepEqual([rememberedTarget('test-session'), rememberedTarget('other-session')], ['thread-a', undefined])
})
test('a subdirectory of a repository is rejected as a worktree', () => {
  const dir = repoOn('main')
  mkdirSync(join(dir, 'pkg'))
  assert.throws(() => canonicalWorktree(brief(join(dir, 'pkg'), 'main')), { message: `worktree "${dir}/pkg" is inside the repository at "${dir}"; the brief's worktree must be the repository root` })
})
test('a stored outcome is never replaced', () => {
  const outcome = { kind: 'done' as const, finalMessage: 'RESULT: done', error: null, changes: null, capturedAt: '2026-10-01T00:00:00.000Z' }
  saveJob(job({ id: 'relay-settled', outcome }))
  const later = { ...outcome, kind: 'question' as const, capturedAt: '2026-10-01T00:05:00.000Z' }
  assert.equal(settleJob('relay-settled', later), false)
  assert.deepEqual(loadJob('relay-settled').outcome, outcome)
})
test('the first outcome for an open job is stored', () => {
  saveJob(job({ id: 'relay-open' }))
  const outcome = { kind: 'done' as const, finalMessage: 'RESULT: done', error: null, changes: null, capturedAt: '2026-10-01T00:00:00.000Z' }
  assert.equal(settleJob('relay-open', outcome), true)
  assert.deepEqual(loadJob('relay-open').outcome, outcome)
})
test('a worktree can be claimed once until its job settles', () => {
  const dir = repoOn('main')
  // The record is saved before the claim, so a lock whose job has no record is stale.
  saveJob(job({ id: 'relay-first', worktree: dir }))
  assert.equal(claimWorktree(dir, 'relay-first'), undefined)
  saveJob(job({ id: 'relay-second', worktree: dir }))
  assert.equal(claimWorktree(dir, 'relay-second'), 'relay-first')
  settleJob('relay-first', { kind: 'abandoned', finalMessage: null, error: null, changes: null, capturedAt: '2026-10-01T00:00:00.000Z' })
  assert.equal(claimWorktree(dir, 'relay-second'), undefined)
})
test('a lock whose job record is gone is stale', () => {
  const dir = repoOn('main')
  assert.equal(claimWorktree(dir, 'relay-crashed'), undefined)
  saveJob(job({ id: 'relay-next', worktree: dir }))
  assert.equal(claimWorktree(dir, 'relay-next'), undefined)
})
test('a thread whose cwd is the worktree or inside it belongs to the project', () => {
  const dir = repoOn('main')
  mkdirSync(join(dir, 'pkg'))
  mkdirSync(join(dir, '..x'))
  assert.equal(worktreeHolds(dir, dir), true)
  assert.equal(worktreeHolds(dir, join(dir, 'pkg')), true)
  assert.equal(worktreeHolds(dir, `${dir}/`), true)
  // A child whose name starts with ".." is still a child.
  assert.equal(worktreeHolds(dir, join(dir, '..x')), true)
})
test('a thread whose cwd is elsewhere does not belong to the project', () => {
  const dir = repoOn('main')
  assert.equal(worktreeHolds(dir, temp()), false)
  // A sibling whose name merely starts with the worktree's name is not inside it.
  assert.equal(worktreeHolds(dir, `${dir}-other`), false)
  assert.equal(worktreeHolds(dir, dirname(dir)), false)
  assert.equal(worktreeHolds(dir, '/no/such/place'), false)
})
test('the worktree command quotes every value for a POSIX shell', () => {
  assert.equal(worktreeAddCommand({ repo: '/a b/it\'s', branch: 'job;printf', worktree: '/w t', baseCommit: 'abc' }),
    `git -C '/a b/it'\\''s' worktree add -b 'job;printf' '/w t' 'abc'`)
})
test('the worktree command runs in a shell as one git command', () => {
  const repo = repoOn('main')
  const worktree = join(temp(), "it's a worktree")
  const baseCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const run = spawnSync('/bin/sh', ['-c', worktreeAddCommand({ repo, branch: 'job;printf', worktree, baseCommit })], { encoding: 'utf8' })
  assert.equal(run.status, 0, run.stderr)
  assert.equal(execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }), 'job;printf\n')
})
const create = (repo: string, worktree: string, branch = 'job', base = 'main') => ({ kind: 'create' as const, repo, base, worktree, branch })
test('a create brief needs its repo to be a repository root', () => {
  assert.throws(() => resolveWorkspace(create('/no/such/dir', '/no/such/wt')), { message: 'repo "/no/such/dir" does not exist' })
  const dir = repoOn('main')
  mkdirSync(join(dir, 'pkg'))
  assert.throws(() => resolveWorkspace(create(join(dir, 'pkg'), join(temp(), 'wt'))), { message: `repo "${dir}/pkg" is inside the repository at "${dir}"; the brief's repo must be the repository root` })
})
test('a create brief needs a base that names a commit, and records that commit', () => {
  const dir = repoOn('main')
  assert.throws(() => resolveWorkspace(create(dir, join(temp(), 'wt'), 'job', 'no-such-ref')), { message: `base "no-such-ref" is not a commit in the repository "${dir}"` })
  const head = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const resolved = resolveWorkspace(create(dir, join(temp(), 'wt')))
  assert.equal(resolved.kind === 'create' && resolved.baseCommit, head)
})
test('a create brief needs a new, valid branch name', () => {
  const dir = repoOn('main')
  assert.throws(() => resolveWorkspace(create(dir, join(temp(), 'wt'), 'a b')), { message: `branch "a b" is not a valid branch name` })
  assert.throws(() => resolveWorkspace(create(dir, join(temp(), 'wt'), 'main')), { message: `branch "main" already exists in the repository "${dir}"` })
  // check-ref-format --branch expands @{-1} to the previous branch; the brief's name must be the name itself.
  execFileSync('git', ['-C', dir, 'checkout', '-q', '-b', 'other'])
  execFileSync('git', ['-C', dir, 'checkout', '-q', 'main'])
  assert.throws(() => resolveWorkspace(create(dir, join(temp(), 'wt'), '@{-1}')), { message: `branch "@{-1}" is not a valid branch name` })
})
test('a create brief needs a worktree path that does not exist yet', () => {
  const dir = repoOn('main')
  const taken = temp()
  assert.throws(() => resolveWorkspace(create(dir, taken)), { message: `worktree "${taken}" already exists; the agent creates it` })
  const dangling = join(temp(), 'dangling')
  symlinkSync('/no/such/target', dangling)
  assert.throws(() => resolveWorkspace(create(dir, dangling)), { message: `worktree "${dangling}" already exists; the agent creates it` })
  // A trailing slash makes lstat follow the link, which must not hide it.
  assert.throws(() => resolveWorkspace(create(dir, `${dangling}/`)), { message: `worktree "${dangling}/" already exists; the agent creates it` })
  assert.throws(() => resolveWorkspace(create(dir, join(dangling, 'job'))), { message: `worktree "${dangling}/job" passes through the broken symlink "${dangling}", which points to "/no/such/target"` })
})
test('a new worktree path is made canonical through its nearest existing parent', () => {
  const dir = repoOn('main')
  const parent = temp()
  const link = join(temp(), 'link')
  symlinkSync(parent, link)
  const worktreeOf = (path: string): string => resolveWorkspace(create(dir, path)).worktree
  assert.deepEqual([worktreeOf(`${link}/jobs/wt/`), worktreeOf(join(parent, 'jobs', 'wt'))], [join(parent, 'jobs', 'wt'), join(parent, 'jobs', 'wt')])
})
test('a new worktree inside a work tree must be ignored there', () => {
  const dir = repoOn('main')
  const folder = repoOn('main')
  // A pattern with a trailing slash matches only a directory, which the worktree will be.
  writeFileSync(join(folder, '.gitignore'), '/job1/\n')
  assert.equal(resolveWorkspace(create(dir, join(folder, 'job1'))).worktree, join(folder, 'job1'))
  assert.throws(() => resolveWorkspace(create(dir, join(folder, 'jobs', 'job2'))), {
    message: `worktree "${folder}/jobs/job2" would show as untracked files in the repository "${folder}"; add the line "/jobs/job2/" to ${folder}/.gitignore or ${folder}/.git/info/exclude`,
  })
})
test('a thread may work inside an existing worktree or in a folder that holds it', () => {
  const dir = repoOn('main')
  mkdirSync(join(dir, 'pkg'))
  const workspace = resolveWorkspace(brief(dir, 'main'))
  assert.deepEqual([threadRefusal(workspace, 't', join(dir, 'pkg')), threadRefusal(workspace, 't', dirname(dir))], [null, null])
  const elsewhere = temp()
  assert.equal(threadRefusal(workspace, 't', elsewhere), `thread t works in ${elsewhere}, which neither holds nor is inside the brief's worktree ${dir}; pick a thread with: targets`)
})
test('a thread takes a create job only in a folder that holds the repository, the worktree and the common git directory', () => {
  const folder = temp()
  const repo = join(folder, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial'])
  const workspace = resolveWorkspace(create(repo, join(folder, 'worktrees', 'job1')))
  assert.equal(threadRefusal(workspace, 't', folder), null)
  const outside = resolveWorkspace(create(repo, join(temp(), 'job1')))
  assert.equal(threadRefusal(outside, 't', folder), `thread t works in ${folder}, which does not hold the worktree ${outside.worktree}; Codex can write only inside the folder it works in; pick a thread with: targets`)
  writeFileSync(join(repo, '.gitignore'), '/worktrees/\n')
  const inRepo = resolveWorkspace(create(repo, join(repo, 'worktrees', 'job1')))
  assert.equal(threadRefusal(inRepo, 't', repo), `the common git directory ${repo}/.git is at or inside the .git directory of the folder thread t works in, ${repo}, which Codex keeps read-only; pick a thread working in a folder above it with: targets`)
  const superproject = repoOn('main')
  execFileSync('git', ['-C', superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', repoOn('main'), 'sub'])
  writeFileSync(join(superproject, '.gitignore'), '/worktrees/\n')
  const inSubmodule = resolveWorkspace(create(join(superproject, 'sub'), join(superproject, 'worktrees', 'job1'), 'job', 'HEAD'))
  assert.equal(threadRefusal(inSubmodule, 't', superproject), `the common git directory ${superproject}/.git/modules/sub is at or inside the .git directory of the folder thread t works in, ${superproject}, which Codex keeps read-only; pick a thread working in a folder above it with: targets`)
})
test('a repository whose common git directory lies outside the thread folder is refused', () => {
  const main = repoOn('main')
  const folder = temp()
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', '-b', 'linked', join(folder, 'linked')])
  const workspace = resolveWorkspace(create(join(folder, 'linked'), join(folder, 'job1')))
  assert.equal(threadRefusal(workspace, 't', folder), `thread t works in ${folder}, which does not hold the common git directory ${main}/.git; Codex can write only inside the folder it works in; pick a thread with: targets`)
})
test('a create job is recorded with its repository and a clean baseline at the base commit', () => {
  const repo = repoOn('main')
  const head = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const worktree = join(temp(), 'wt')
  writeFileSync(join(repo, 'dirty.txt'), 'not part of a new worktree\n')
  assert.deepEqual(recordedWorkspace(resolveWorkspace(create(repo, worktree))), { workspace: { kind: 'create', repo }, worktree, branch: 'job', baseline: { baseCommit: head, dirty: {} } })
})
test('an existing job is recorded with the paths already modified in its worktree', () => {
  const repo = repoOn('main')
  writeFileSync(join(repo, 'f'), 'changed')
  const recorded = recordedWorkspace(resolveWorkspace(brief(repo, 'main')))
  assert.deepEqual([recorded.workspace, recorded.worktree, recorded.branch, Object.keys(recorded.baseline.dirty)], [{ kind: 'existing' }, repo, 'main', ['f']])
})
test('a create job starts by creating its worktree; an existing one has no first step', () => {
  const created = job({ workspace: { kind: 'create', repo: '/work/repo' }, worktree: '/work/new tree', branch: 'job;printf', baseline: { baseCommit: 'abc', dirty: {} } })
  assert.equal(firstStep(created), `First create the job's worktree: git -C '/work/repo' worktree add -b 'job;printf' '/work/new tree' 'abc'`)
  assert.equal(firstStep(job()), null)
})
const createdJob = (repo: string, worktree: string): Job => {
  const baseCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  return job({ workspace: { kind: 'create', repo }, worktree, branch: 'job', baseline: { baseCommit, dirty: {} } })
}
test('a created worktree must exist and be a work tree root', () => {
  const repo = repoOn('main')
  const worktree = join(temp(), 'wt')
  assert.deepEqual(createdWorktreeProblems(createdJob(repo, worktree)), [`worktree ${worktree} does not exist`])
  mkdirSync(worktree)
  assert.deepEqual(createdWorktreeProblems(createdJob(repo, worktree)), [`worktree ${worktree} is not the root of a git work tree`])
})
test('an existing job has nothing to check after its turn', () => assert.deepEqual(createdWorktreeProblems(job()), []))
test('a created worktree must belong to the job repository, be on its branch and descend from its base', () => {
  const repo = repoOn('main')
  const worktree = join(temp(), 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'job', worktree])
  assert.deepEqual(createdWorktreeProblems(createdJob(repo, worktree)), [])
  const other = repoOn('main')
  const foreign = join(temp(), 'wt')
  execFileSync('git', ['-C', other, 'worktree', 'add', '-q', '-b', 'elsewhere', '--orphan', foreign])
  writeFileSync(join(foreign, 'g'), 'g')
  execFileSync('git', ['-C', foreign, 'add', '-A'])
  execFileSync('git', ['-C', foreign, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '-m', 'unrelated'])
  const baseCommit = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  assert.deepEqual(createdWorktreeProblems({ ...createdJob(repo, foreign), baseline: { baseCommit, dirty: {} } }), [
    `worktree ${foreign} belongs to the repository whose git directory is ${other}/.git, not to ${repo}`,
    `worktree ${foreign} is on branch "elsewhere", the job's branch is "job"`,
    `worktree ${foreign} does not descend from the base commit ${baseCommit}`,
  ])
})
test('a created worktree of the job repository with unrelated history does not descend from the base', () => {
  const repo = repoOn('main')
  const worktree = join(temp(), 'wt')
  execFileSync('git', ['-C', repo, 'worktree', 'add', '-q', '-b', 'job', '--orphan', worktree])
  writeFileSync(join(worktree, 'g'), 'g')
  execFileSync('git', ['-C', worktree, 'add', '-A'])
  execFileSync('git', ['-C', worktree, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '-m', 'unrelated'])
  const created = createdJob(repo, worktree)
  assert.deepEqual(createdWorktreeProblems(created), [`worktree ${worktree} does not descend from the base commit ${created.baseline.baseCommit}`])
})
