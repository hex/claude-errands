// ABOUTME: Runs the command line against a disposable Codex home with no managed daemon.
// ABOUTME: Checks nearby output, exit codes and command-specific option validation.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')
const USAGE = 'claude-errands: usage: cli.ts send <brief> [--target <id>] | wait <jobId> [--interval <seconds>] [--timeout <minutes>] | targets | nearby <dir> [--quiet] | abandon <jobId>\n'

const cli = (t: TestContext, ...args: string[]) => {
  const home = mkdtempSync(join(tmpdir(), 'claude-errands-cli-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  return spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, CODEX_HOME: home }, encoding: 'utf8', timeout: 10_000,
  })
}

test('nearby --quiet exits 2 with no stdout when no managed daemon runs', t => {
  const result = cli(t, 'nearby', import.meta.dirname, '--quiet')
  assert.equal(result.status, 2, result.stderr)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('nearby prints an empty JSON array and exits 0 when no managed daemon runs', t => {
  const result = cli(t, 'nearby', import.meta.dirname)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, '[]\n')
  assert.equal(result.stderr, '')
})

test('nearby --quiet reports a missing directory on stderr and exits 1', t => {
  const missing = join(import.meta.dirname, 'missing-directory')
  const result = cli(t, 'nearby', missing, '--quiet')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `claude-errands: ENOENT: no such file or directory, lstat '${missing}'\n`)
})

for (const args of [['targets'], ['send', 'brief.md'], ['wait', 'job-id'], ['abandon', 'job-id']]) {
  test(`${args[0]} rejects --quiet with usage`, t => {
    const result = cli(t, ...args, '--quiet')
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, USAGE)
  })
}
