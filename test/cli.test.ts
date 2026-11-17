// ABOUTME: Runs the command line against a disposable Codex home with no managed daemon and a disposable state directory.
// ABOUTME: Checks nearby output, exit codes, the refusal to send to pi or omp, and command-specific option validation.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')
const USAGE = 'claude-errands: usage: cli.ts send <brief> [--target <id>] | wait <jobId> [--interval <seconds>] [--timeout <minutes>] | targets | nearby <dir> [--quiet] | abandon <jobId> | setup-pi\n'

const scratch = (t: TestContext): string => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-errands-cli-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const cli = (t: TestContext, ...args: string[]) => cliIn(t, scratch(t), ...args)

const cliIn = (t: TestContext, home: string, ...args: string[]) =>
  spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, CODEX_HOME: home, XDG_STATE_HOME: join(home, 'state'), CLAUDE_CODE_SESSION_ID: 'test-session' }, encoding: 'utf8', timeout: 10_000,
  })

test('nearby --quiet exits 2 with no stdout when no managed daemon runs and no pi or omp session listens', t => {
  const result = cli(t, 'nearby', import.meta.dirname, '--quiet')
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('nearby prints no sessions and no failed checks when no managed daemon runs and live/ does not exist', t => {
  const result = cli(t, 'nearby', import.meta.dirname)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '{"sessions":[],"failed":[]}\n')
  assert.equal(result.stderr, '')
})

test('nearby reports the pi/omp check as failed when live/ is readable by other users, and --quiet exits 1', t => {
  const home = scratch(t)
  const live = join(home, 'state', 'claude-errands', 'live')
  mkdirSync(live, { recursive: true, mode: 0o755 })
  const uid = process.getuid?.()
  const result = cliIn(t, home, 'nearby', import.meta.dirname)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), {
    sessions: [], failed: [{ check: 'pi/omp', reason: `${live} must be a directory owned by uid ${uid} with mode 700; it is a directory owned by uid ${uid} with mode 755` }],
  })
  const quiet = cliIn(t, home, 'nearby', import.meta.dirname, '--quiet')
  assert.equal(quiet.status, 1)
  assert.equal(quiet.stdout, '')
})

for (const agent of ['pi', 'omp']) {
  test(`send to a ${agent} session that is not open refuses before it writes a job record`, t => {
    const home = scratch(t)
    const repo = join(home, 'repo')
    mkdirSync(repo)
    execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])
    execFileSync('git', ['-C', repo, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial'])
    const brief = join(home, 'brief.md')
    writeFileSync(brief, ['# Job: refused', '## Worktree', repo, 'Branch: main', '', '## Allowed paths', '- src/**', '',
      '## Test command', '`true`', '', '## Rules', '', '## Work', 'Reply.', ''].join('\n'))
    const target = `${agent}:01a1c572-d7a3-74ae-83a7-a81395f4e714`
    const result = cliIn(t, home, 'send', brief, '--target', target)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, `claude-errands: session ${target} has closed, so nothing would run this brief; pick a live session with: targets\n`)
    assert.equal(existsSync(join(home, 'state', 'claude-errands', 'jobs')), false)
  })
}

test('nearby --quiet reports a missing directory on stderr and exits 1', t => {
  const missing = join(import.meta.dirname, 'missing-directory')
  const result = cli(t, 'nearby', missing, '--quiet')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `claude-errands: ENOENT: no such file or directory, lstat '${missing}'\n`)
})

for (const args of [['targets'], ['send', 'brief.md'], ['wait', 'job-id'], ['abandon', 'job-id'], ['setup-pi']]) {
  test(`${args[0]} rejects --quiet with usage`, t => {
    const result = cli(t, ...args, '--quiet')
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, USAGE)
  })
}
