// ABOUTME: Runs send and wait through the command line against a stand-in daemon process, so a job id is printed
// ABOUTME: only for a thread that holds the job, and a job parked on a closed thread is reported instead of waited on.
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { Daemon } from '../src/daemon.ts'
import type { FakeState } from './fake-daemon.ts'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')
const FAKE = join(import.meta.dirname, 'fake-daemon.ts')
const THREAD = 'thread-a'

const temp = (t: TestContext, prefix = join(tmpdir(), 'claude-errands-delivery-')): string => {
  const dir = realpathSync(mkdtempSync(prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const repoWithBrief = (t: TestContext): { worktree: string; brief: string } => {
  const worktree = temp(t)
  execFileSync('git', ['-C', worktree, 'init', '-q', '-b', 'main'])
  writeFileSync(join(worktree, 'f'), 'f')
  execFileSync('git', ['-C', worktree, 'add', '-A'])
  execFileSync('git', ['-C', worktree, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '-m', 'initial'])
  const brief = join(temp(t), 'brief.md')
  writeFileSync(brief, ['# Job: one', '## Worktree', worktree, 'Branch: main', '', '## Allowed paths', '- src/**', '', '## Test command', '`true`', '', '## Rules', 'None.', '', '## Work', 'Reply.', ''].join('\n'))
  return { worktree, brief }
}

// discoverDaemon looks for a process under the Codex home started with --managed-daemon that holds a codex-daemon- socket.
const startDaemon = async (t: TestContext, initial: FakeState) => {
  const home = temp(t)
  const directory = join(home, 'packages', 'app-server-daemon')
  mkdirSync(directory, { recursive: true })
  const node = join(directory, 'node')
  symlinkSync(process.execPath, node)
  const stateFile = join(temp(t), 'state.json')
  const write = (state: FakeState): void => writeFileSync(stateFile, JSON.stringify(state))
  write(initial)
  const socket = join(temp(t, '/private/tmp/codex-daemon-'), 'sock')
  const child = spawn(node, [FAKE, '--managed-daemon', socket, stateFile], { stdio: ['ignore', 'pipe', 'inherit'] })
  t.after(() => new Promise<void>(resolve => { child.once('exit', () => resolve()); child.kill('SIGKILL') }))
  await new Promise<void>((resolve, reject) => {
    child.stdout.once('data', () => resolve())
    child.once('exit', code => reject(new Error(`fake daemon exited with ${code}`)))
  })
  const state = temp(t)
  return {
    daemon: new Daemon(socket), write, state,
    cli: (...args: string[]) => spawnSync(process.execPath, [CLI, ...args], {
      env: { ...process.env, CODEX_HOME: home, XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: 'test-session' }, encoding: 'utf8', timeout: 20_000,
    }),
  }
}

const NOT_LOADED = { type: 'notLoaded' }

type JobRecord = { id: string; delivery: string; outcome: { kind: string; error: string | null } | null }

const records = (state: string): JobRecord[] => readdirSync(join(state, 'claude-errands', 'jobs')).filter(name => name.endsWith('.json'))
  .map(name => JSON.parse(readFileSync(join(state, 'claude-errands', 'jobs', name), 'utf8')) as JobRecord)

const onlyRecord = (state: string): JobRecord => {
  const [record, ...others] = records(state)
  if (record === undefined || others.length > 0) throw new Error(`expected one job record, found ${others.length + (record === undefined ? 0 : 1)}`)
  return record
}

const CLOSED_REFUSAL = `thread ${THREAD} has closed, so nothing would run this brief; pick a live thread with: targets`

test('a target that has closed is refused with no job id, and nothing is recorded or queued', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: NOT_LOADED, turns: [] })
  const result = codex.cli('send', brief, '--target', THREAD)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `claude-errands: thread ${THREAD} has closed, so nothing would run this brief; pick a live thread with: targets\n`)
  assert.equal(result.status, 1)
  assert.equal(existsSync(join(codex.state, 'claude-errands', 'jobs')), false)
  assert.deepEqual(await codex.daemon.queueList(THREAD), [])
})

test('a target that closes after the check is refused with no job id, and the worktree is free again', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [], after: { reads: 1, state: { cwd: worktree, status: NOT_LOADED, turns: [] } } })
  const result = codex.cli('send', brief, '--target', THREAD)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `claude-errands: thread ${THREAD} has closed, so nothing would run this brief; pick a live thread with: targets\n`)
  assert.equal(result.status, 1)
  assert.deepEqual(await codex.daemon.queueList(THREAD), [])
  const refused = onlyRecord(codex.state)
  assert.deepEqual({ delivery: refused.delivery, kind: refused.outcome?.kind, error: refused.outcome?.error }, { delivery: 'refused', kind: 'abandoned', error: CLOSED_REFUSAL })
  codex.write({ cwd: worktree, status: { type: 'idle' }, turns: [] })
  const again = codex.cli('send', brief, '--target', THREAD)
  assert.equal(again.stderr, '')
  assert.match(again.stdout, /^errand-[0-9a-f-]{36}\n$/)
})

test('wait on a job queued to a thread that then closed fails at once, naming the thread and what to do', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const id = codex.cli('send', brief, '--target', THREAD).stdout.trim()
  codex.write({ cwd: worktree, status: NOT_LOADED, turns: [] })
  const result = codex.cli('wait', id, '--interval', '60', '--timeout', '30')
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `claude-errands: job ${id} has not started and thread ${THREAD} has closed; it can run only if that thread is resumed with the job still in its queue. To run it elsewhere: abandon ${id}, then send the brief to a live thread from: targets. Abandon does not remove the queued copy, so the job still runs if that thread is resumed\n`)
})

test('wait leaves a job parked on a closed thread open, since resuming the thread still runs it', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const id = codex.cli('send', brief, '--target', THREAD).stdout.trim()
  codex.write({ cwd: worktree, status: NOT_LOADED, turns: [] })
  assert.equal(codex.cli('wait', id, '--interval', '60', '--timeout', '30').status, 1)
  const record = onlyRecord(codex.state)
  assert.deepEqual({ delivery: record.delivery, outcome: record.outcome }, { delivery: 'sent', outcome: null })
  assert.equal(codex.cli('send', brief, '--target', THREAD).stderr, `claude-errands: worktree ${worktree} is held by job ${id}, which has no outcome yet; wait for it or run: abandon ${id}\n`)
})

test('wait reports a job on a closed thread whose queue does not hold it as lost, not as parked', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const id = codex.cli('send', brief, '--target', THREAD).stdout.trim()
  codex.write({ cwd: worktree, status: NOT_LOADED, turns: [], queueLost: true })
  const result = codex.cli('wait', id, '--interval', '0.01', '--timeout', '30')
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `claude-errands: job ${id} is in neither the queue nor the turns of ${THREAD} on 3 polls in a row\n`)
  assert.equal(result.status, 1)
})

test('a job refused because another job holds the lock is recorded as refused, and nothing is queued', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  // openJobFor misses a holder whose record names another worktree, which stands in for a send that wins the lock between that lookup and the claim.
  const holder = 'errand-holder'
  const stateRoot = join(codex.state, 'claude-errands')
  mkdirSync(join(stateRoot, 'jobs'), { recursive: true })
  mkdirSync(join(stateRoot, 'locks'), { recursive: true })
  writeFileSync(join(stateRoot, 'jobs', `${holder}.json`), JSON.stringify({ id: holder, worktree: '/elsewhere', delivery: 'sending', outcome: null }))
  writeFileSync(join(stateRoot, 'locks', `${createHash('sha256').update(worktree).digest('hex')}.json`), JSON.stringify({ worktree, jobId: holder }))
  const result = codex.cli('send', brief, '--target', THREAD)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, `claude-errands: worktree ${worktree} is held by job ${holder}, which has no outcome yet; wait for it or run: abandon ${holder}\n`)
  assert.equal(result.status, 1)
  assert.deepEqual(await codex.daemon.queueList(THREAD), [])
  const refused = records(codex.state).filter(record => record.id !== holder)
  assert.deepEqual(refused.map(record => ({ delivery: record.delivery, kind: record.outcome?.kind, error: record.outcome?.error })), [{ delivery: 'refused', kind: 'abandoned', error: `worktree held by ${holder}` }])
})

for (const type of ['active', 'systemError']) {
  test(`a loaded thread with status ${type} takes the job`, async t => {
    const { worktree, brief } = repoWithBrief(t)
    const codex = await startDaemon(t, { cwd: worktree, status: { type }, turns: [] })
    const result = codex.cli('send', brief, '--target', THREAD)
    assert.equal(result.stderr, '')
    assert.equal(result.status, 0)
    assert.match(result.stdout, /^errand-[0-9a-f-]{36}\n$/)
    const queued = await codex.daemon.queueList(THREAD) as Array<{ clientUserMessageId: string }>
    assert.deepEqual(queued.map(entry => entry.clientUserMessageId), [result.stdout.trim()])
  })
}

for (const [scenario, state] of [
  ['the daemon rejected the job on a live thread', (worktree: string): FakeState => ({ cwd: worktree, status: { type: 'idle' }, turns: [], queueAddFails: 'rejected' })],
  ['the response was lost and the thread then closed, leaving the job parked', (worktree: string): FakeState => ({
    cwd: worktree, status: { type: 'idle' }, turns: [], queueAddFails: 'accepted', after: { reads: 2, state: { cwd: worktree, status: NOT_LOADED, turns: [] } },
  })],
] as const) {
  test(`a failed queue call is an unknown delivery with no job id when ${scenario}`, async t => {
    const { worktree, brief } = repoWithBrief(t)
    const codex = await startDaemon(t, state(worktree))
    const result = codex.cli('send', brief, '--target', THREAD)
    const record = onlyRecord(codex.state)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, `claude-errands: delivery of job ${record.id} is unknown and it was not sent again; check it with: wait ${record.id}\ncaused by: daemon thread/queue/add failed: {"code":-32000,"message":"queue add failed"}\n`)
    assert.equal(result.status, 1)
    assert.deepEqual({ delivery: record.delivery, outcome: record.outcome }, { delivery: 'unknown', outcome: null })
  })
}

test('a failed queue call whose job reached the queue of a live thread is a send', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [], queueAddFails: 'accepted' })
  const result = codex.cli('send', brief, '--target', THREAD)
  const record = onlyRecord(codex.state)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout, `${record.id}\n`)
  assert.equal(result.status, 0)
  assert.equal(record.delivery, 'sent')
})

for (const [scenario, state] of [
  ['has closed', (worktree: string): FakeState => ({ cwd: worktree, status: NOT_LOADED, turns: [] })],
  ['closes after the check', (worktree: string): FakeState => ({ cwd: worktree, status: { type: 'idle' }, turns: [], after: { reads: 1, state: { cwd: worktree, status: NOT_LOADED, turns: [] } } })],
  ['works on another project', (_worktree: string, elsewhere: string): FakeState => ({ cwd: elsewhere, status: { type: 'idle' }, turns: [] })],
] as const) {
  test(`a target that ${scenario} is not remembered for the next send`, async t => {
    const { worktree, brief } = repoWithBrief(t)
    const codex = await startDaemon(t, state(worktree, temp(t)))
    assert.equal(codex.cli('send', brief, '--target', THREAD).status, 1)
    const next = codex.cli('send', brief)
    assert.equal(next.stdout, '')
    assert.equal(next.stderr, 'claude-errands: --target is required: no target is remembered for this Claude session. Loaded threads:\n\n')
    assert.equal(next.status, 1)
  })
}

test('a target that took a job is remembered for the next send', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const first = codex.cli('send', brief, '--target', THREAD).stdout.trim()
  assert.equal(codex.cli('abandon', first).status, 0)
  const next = codex.cli('send', brief)
  assert.equal(next.stderr, '')
  assert.equal(next.status, 0)
  const queued = await codex.daemon.queueList(THREAD) as Array<{ clientUserMessageId: string }>
  assert.deepEqual(queued.map(entry => entry.clientUserMessageId), [first, next.stdout.trim()])
})

test('a send to a live thread prints the job id, records it as sent, and leaves it in that thread\'s queue', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const result = codex.cli('send', brief, '--target', THREAD)
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.match(result.stdout, /^errand-[0-9a-f-]{36}\n$/)
  const id = result.stdout.trim()
  const record = JSON.parse(readFileSync(join(codex.state, 'claude-errands', 'jobs', `${id}.json`), 'utf8')) as { delivery: string; outcome: unknown }
  assert.deepEqual({ delivery: record.delivery, outcome: record.outcome }, { delivery: 'sent', outcome: null })
  const queued = await codex.daemon.queueList(THREAD) as Array<{ clientUserMessageId: string }>
  assert.deepEqual(queued.map(entry => entry.clientUserMessageId), [id])
})

test('abandoning a job a crashed send left at sending records its delivery as unknown', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const id = codex.cli('send', brief, '--target', THREAD).stdout.trim()
  const path = join(codex.state, 'claude-errands', 'jobs', `${id}.json`)
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), delivery: 'sending' }))
  const result = codex.cli('abandon', id)
  assert.equal(result.stderr, '')
  assert.equal(result.stdout, `Job ${id} abandoned; worktree ${worktree} is free. The agent was not stopped.\n`)
  assert.equal(result.status, 0)
  const record = onlyRecord(codex.state)
  assert.deepEqual({ delivery: record.delivery, kind: record.outcome?.kind }, { delivery: 'unknown', kind: 'abandoned' })
})

test('wait still reports the outcome of a job whose turn ended before its thread closed', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const id = codex.cli('send', brief, '--target', THREAD).stdout.trim()
  codex.write({
    cwd: worktree, status: NOT_LOADED,
    turns: [{ id: 'turn-1', status: 'completed', error: null, items: [{ type: 'userMessage', clientId: id }, { type: 'agentMessage', phase: 'final_answer', text: 'RESULT: done' }] }],
  })
  const result = codex.cli('wait', id, '--interval', '60', '--timeout', '30')
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `Job: ${id}\nOutcome: done\nFinal answer:\nRESULT: done\nCommits:\n  none\nOutside allow-list:\n  none\nModified before this job:\n  none\nUncommitted changes: no\n`)
})

const awaitingApproval = (worktree: string, id: string): FakeState => ({
  cwd: worktree, status: { type: 'active', activeFlags: ['waitingOnApproval'] },
  turns: [{ id: 'turn-1', status: 'inProgress', error: null, items: [{ type: 'userMessage', clientId: id }] }],
})

test('wait stops with exit 3 when the job\'s turn waits on an approval for 5 polls in a row, and leaves the job open', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const id = codex.cli('send', brief, '--target', THREAD).stdout.trim()
  codex.write(awaitingApproval(worktree, id))
  const result = codex.cli('wait', id, '--interval', '0.01', '--timeout', '1')
  assert.equal(result.stdout, `Job ${id} is waiting on an approval in the agent's pane.\n`)
  assert.equal(result.stderr, `claude-errands: job ${id} has waited on an approval in thread ${THREAD} for 5 polls in a row; the person must answer it in that Codex pane. The job is still open, so running wait ${id} again after that is safe\n`)
  assert.equal(result.status, 3)
  assert.deepEqual(onlyRecord(codex.state).outcome, null)
})

test('wait keeps waiting through an approval answered within 4 polls and reports how the turn ended', async t => {
  const { worktree, brief } = repoWithBrief(t)
  const codex = await startDaemon(t, { cwd: worktree, status: { type: 'idle' }, turns: [] })
  const id = codex.cli('send', brief, '--target', THREAD).stdout.trim()
  codex.write({
    ...awaitingApproval(worktree, id),
    after: {
      reads: 4,
      state: { cwd: worktree, status: { type: 'idle' }, turns: [{ id: 'turn-1', status: 'completed', error: null, items: [{ type: 'userMessage', clientId: id }, { type: 'agentMessage', phase: 'final_answer', text: 'RESULT: done' }] }] },
    },
  })
  const result = codex.cli('wait', id, '--interval', '0.01', '--timeout', '1')
  assert.equal(result.stderr, '')
  assert.equal(result.status, 0)
  assert.equal(result.stdout, `Job ${id} is waiting on an approval in the agent's pane.\nJob: ${id}\nOutcome: done\nFinal answer:\nRESULT: done\nCommits:\n  none\nOutside allow-list:\n  none\nModified before this job:\n  none\nUncommitted changes: no\n`)
})
