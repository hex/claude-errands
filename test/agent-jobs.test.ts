// ABOUTME: Runs send, wait and abandon for pi and omp targets through the command line, against real sockets standing in
// ABOUTME: for the session and real agent-jobs records, and checks what each record and owner state is reported as.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test, type TestContext } from 'node:test'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')
const SESSION = 'test-session-1'
const INSTANCE = '0123456789ab'
const DISPATCHED_AT = '2026-11-10T12:00:01.000Z'
const MERGED = 'the brief joined a run the person started; its final answer may not be the agent\'s answer to the brief'
const NO_CHANGES = 'Commits:\n  none\nOutside allow-list:\n  none\nModified before this job:\n  none\nUncommitted changes: no\n'
const run = promisify(execFile)

type Agent = 'pi' | 'omp'
type Scratch = { root: string; state: string; live: string; agentJobs: string; repo: string; brief: string }
type Result = { code: number; stdout: string; stderr: string }

// A short root under /tmp: a socket path must fit in 104 bytes, and the system temp folder on macOS is long.
const scratch = (t: TestContext): Scratch => {
  const root = realpathSync(mkdtempSync('/tmp/ce-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const state = join(root, 'state')
  const live = join(state, 'claude-errands', 'live')
  mkdirSync(live, { recursive: true, mode: 0o700 })
  const repo = join(root, 'repo')
  mkdirSync(repo)
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial'])
  const brief = join(root, 'brief.md')
  writeFileSync(brief, ['# Job: one', '## Worktree', repo, 'Branch: main', '', '## Allowed paths', '- src/**', '', '## Test command', '`true`', '', '## Rules', '', '## Work', 'Reply.', ''].join('\n'))
  return { root, state, live, agentJobs: join(state, 'claude-errands', 'agent-jobs'), repo, brief }
}

// The CLI runs asynchronously, so this process's sockets can answer it.
const cli = async (s: Scratch, ...args: string[]): Promise<Result> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, CODEX_HOME: s.root, XDG_STATE_HOME: s.state }, timeout: 20_000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    // execFile rejects with an error carrying the exit code and both outputs when the command exits non-zero.
    const failed = error as { code: number; stdout: string; stderr: string }
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr }
  }
}

const helloLine = (agent: Agent, fields: Record<string, unknown> = {}): string => `${JSON.stringify({
  v: 1, agent, instance: INSTANCE, pid: process.pid, sessionId: SESSION, name: null, cwd: '/', status: 'idle', turnStartedAt: null, busy: false, pausedOnBackgroundWork: false, job: null, ...fields,
})}\n`

// A socket in live/ named for this process, standing in for a session's extension. reply gets each request line and
// returns the reply line, or null to stay silent. It returns the request lines it read.
const session = async (t: TestContext, s: Scratch, agent: Agent, reply: (request: Record<string, unknown>) => string | null, instance = INSTANCE): Promise<{ requests: string[]; close: () => Promise<void> }> => {
  const requests: string[] = []
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    socket.once('data', (chunk: Buffer) => {
      const line = chunk.toString('utf8').split('\n', 1)[0] ?? ''
      requests.push(line)
      const answer = reply(JSON.parse(line) as Record<string, unknown>)
      if (answer !== null) socket.end(answer)
    })
  })
  await new Promise<void>(resolve => server.listen(join(s.live, `${agent}-${instance}-${process.pid}.sock`), resolve))
  let closed = false
  const close = (): Promise<void> => new Promise(resolve => {
    if (closed) return resolve()
    closed = true
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  })
  t.after(close)
  return { requests, close }
}

const accepting = (agent: Agent) => (request: Record<string, unknown>): string =>
  request.op === 'send' ? '{"v":1,"accepted":true}\n' : helloLine(agent, { cwd: '/' })

// A job sent through the real send, to a session that took it; the session is closed again afterwards.
const sentJob = async (t: TestContext, s: Scratch, agent: Agent): Promise<string> => {
  const peer = await session(t, s, agent, accepting(agent))
  const sent = await cli(s, 'send', s.brief, '--target', `${agent}:${SESSION}`)
  assert.equal(sent.stderr, '')
  await peer.close()
  return sent.stdout.trim()
}

const writeAgentJob = (s: Scratch, id: string, agent: Agent, fields: Record<string, unknown>): void => {
  mkdirSync(s.agentJobs, { recursive: true, mode: 0o700 })
  writeFileSync(join(s.agentJobs, `${id}.json`), JSON.stringify({
    agent, owner: INSTANCE, pid: process.pid, sessionId: SESSION, message: 'the message', seq: 1, acceptedAt: '2026-11-10T12:00:00.000Z', ...fields,
  }))
}

test('send hands a pi or omp session only the job id and session, and the record it reads holds the message', async t => {
  for (const agent of ['pi', 'omp'] as const) {
    const s = scratch(t)
    const peer = await session(t, s, agent, accepting(agent))
    const sent = await cli(s, 'send', s.brief, '--target', `${agent}:${SESSION}`)
    assert.equal(sent.stderr, '')
    assert.equal(sent.code, 0)
    const id = sent.stdout.trim()
    assert.match(id, /^errand-[0-9a-f-]{36}$/)
    assert.deepEqual(peer.requests.slice(-1), [JSON.stringify({ v: 1, op: 'send', job: id, session: SESSION })])
    const path = join(s.state, 'claude-errands', 'jobs', `${id}.json`)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    const record = JSON.parse(readFileSync(path, 'utf8')) as { transport: string; target: string; message: string; delivery: string }
    assert.deepEqual({ transport: record.transport, target: record.target, delivery: record.delivery }, { transport: agent, target: `${agent}:${SESSION}`, delivery: 'sent' })
    assert.ok(record.message.includes(`This is job ${id}.`), record.message)
  }
})

test('a send the session refuses prints no job id, records the refusal, and frees the worktree', async t => {
  const s = scratch(t)
  await session(t, s, 'omp', request => request.op === 'send' ? '{"v":1,"error":"send names session \\"x\\", and this session is y"}\n' : helloLine('omp'))
  const result = await cli(s, 'send', s.brief, '--target', `omp:${SESSION}`)
  assert.equal(result.stdout, '')
  assert.match(result.stderr, new RegExp(`^claude-errands: the omp session omp:${SESSION} refused job errand-[0-9a-f-]{36}: send names session "x", and this session is y\\n$`))
  assert.equal(result.code, 1)
  const again = await cli(s, 'send', s.brief, '--target', `omp:${SESSION}`)
  assert.match(again.stderr, /refused job/, 'the worktree was free for a second send')
})

test('a session open in two TUIs is refused as ambiguous before a job is recorded', async t => {
  const s = scratch(t)
  await session(t, s, 'pi', accepting('pi'))
  await session(t, s, 'pi', () => helloLine('pi', { instance: 'ba9876543210' }), 'ba9876543210')
  const result = await cli(s, 'send', s.brief, '--target', `pi:${SESSION}`)
  assert.equal(result.stderr, `claude-errands: session pi:${SESSION} is open in 2 TUIs, so which one would run the job is ambiguous; close all but one\n`)
  assert.equal(result.code, 1)
  assert.equal(existsSync(join(s.state, 'claude-errands', 'jobs')), false)
})

type Owner = { kind: 'answering'; status: string; busy?: true; job: 'this' | 'other' | null } | { kind: 'unresponsive' } | { kind: 'gone' }
// timeout: wait's --timeout in minutes; the default lets one poll run.
type Row = { name: string; agent: Agent; record: Record<string, unknown> | null; owner: Owner; timeout?: string; expect: (id: string) => Result }

const stillRunning = (id: string): Result => ({ code: 0, stdout: `Job: ${id}\nstill running\n`, stderr: '' })
const ended = (id: string, lines: string[]): Result => ({ code: 0, stdout: `Job: ${id}\n${lines.join('\n')}\n${NO_CHANGES}`, stderr: '' })
const gone: Owner = { kind: 'gone' }

const rows: Row[] = [
  { name: 'queued with its owner answering is still waiting', agent: 'pi', record: { state: 'queued' }, owner: { kind: 'answering', status: 'working', job: null }, expect: stillRunning },
  { name: 'queued with its owner not answering is still waiting', agent: 'omp', record: { state: 'queued' }, owner: { kind: 'unresponsive' }, expect: stillRunning },
  {
    name: 'queued with its owner gone has not started and says what to do', agent: 'pi', record: { state: 'queued' }, owner: gone,
    expect: id => ({ code: 1, stdout: '', stderr: `claude-errands: job ${id} has not started and the pi session pi:${SESSION} that queued it is gone; it runs only if that session opens again with claude-errands loaded. To run it elsewhere: abandon ${id}, then send the brief to a live session from: targets\n` }),
  },
  { name: 'running with its owner answering is running', agent: 'omp', record: { state: 'running' }, owner: { kind: 'answering', status: 'working', job: 'this' }, expect: stillRunning },
  { name: 'dispatching with its owner not answering is running', agent: 'pi', record: { state: 'dispatching', dispatchedAt: DISPATCHED_AT }, owner: { kind: 'unresponsive' }, expect: stillRunning },
  { name: 'dispatching while the session is busy with no run, as while it prepares one, is running', agent: 'pi', record: { state: 'dispatching', dispatchedAt: DISPATCHED_AT }, owner: { kind: 'answering', status: 'idle', busy: true, job: 'this' }, expect: stillRunning },
  { name: 'dispatching while the session runs, as with the brief queued into the person\'s run, is running', agent: 'omp', record: { state: 'dispatching', dispatchedAt: DISPATCHED_AT }, owner: { kind: 'answering', status: 'working', busy: true, job: 'this' }, expect: stillRunning },
  { name: 'running while the session waits on an approval for another job is running', agent: 'omp', record: { state: 'running' }, owner: { kind: 'answering', status: 'needsApproval', job: 'other' }, expect: stillRunning },
  {
    name: 'dispatching with its owner gone failed, and whether it finished is unknown', agent: 'pi', record: { state: 'dispatching' }, owner: gone,
    expect: id => ended(id, ['Outcome: failed', 'Error: the pi session exited while the job ran; whether it finished is unknown', 'Final answer: none (the turn had no final answer)']),
  },
  {
    name: 'running with its owner gone failed, and whether it finished is unknown', agent: 'omp', record: { state: 'running' }, owner: gone,
    expect: id => ended(id, ['Outcome: failed', 'Error: the omp session exited while the job ran; whether it finished is unknown', 'Final answer: none (the turn had no final answer)']),
  },
  {
    name: 'ended completed is reported as recorded, even with its owner gone', agent: 'pi', record: { state: 'ended', status: 'completed', finalMessage: 'Did it.\nRESULT: done', error: null }, owner: gone,
    expect: id => ended(id, ['Outcome: done', 'Final answer:\nDid it.\nRESULT: done']),
  },
  {
    name: 'ended failed carries the provider error', agent: 'pi', record: { state: 'ended', status: 'failed', finalMessage: null, error: 'OAuth refresh failed for anthropic' }, owner: { kind: 'answering', status: 'idle', job: null },
    expect: id => ended(id, ['Outcome: failed', 'Error: OAuth refresh failed for anthropic', 'Final answer: none (the turn had no final answer)']),
  },
  {
    name: 'ended merged into the person\'s run is failed with the merged error', agent: 'omp', record: { state: 'ended', status: 'completed', merged: true, finalMessage: 'ok\nRESULT: done', error: null }, owner: { kind: 'answering', status: 'idle', job: null },
    expect: id => ended(id, ['Outcome: failed', `Error: ${MERGED}`, 'Final answer:\nok\nRESULT: done']),
  },
  {
    name: 'ended with the person typing during the run says so and keeps the outcome', agent: 'omp', record: { state: 'ended', status: 'completed', userIntervened: true, finalMessage: 'RESULT: done', error: null }, owner: gone,
    expect: id => ended(id, ['Outcome: done', 'Person typed into the session during the run: yes', 'Final answer:\nRESULT: done']),
  },
  {
    name: 'a missing record is lost after three polls', agent: 'pi', record: null, owner: gone, timeout: '5',
    expect: id => ({ code: 1, stdout: '', stderr: `claude-errands: job ${id} is in neither the queue nor the turns of pi:${SESSION} on 3 polls in a row\n` }),
  },
]

for (const row of rows) {
  test(`wait: ${row.name}`, async t => {
    const s = scratch(t)
    const id = await sentJob(t, s, row.agent)
    if (row.record !== null) writeAgentJob(s, id, row.agent, row.record)
    const { owner } = row
    if (owner.kind === 'answering') {
      await session(t, s, row.agent, () => helloLine(row.agent, { status: owner.status, turnStartedAt: owner.status === 'idle' ? null : '2026-11-10T12:00:00.000Z', busy: owner.busy === true, job: owner.job === 'this' ? id : owner.job === 'other' ? 'errand-00000000-0000-0000-0000-000000000000' : null }))
    }
    if (owner.kind === 'unresponsive') await session(t, s, row.agent, () => null)
    assert.deepEqual(await cli(s, 'wait', id, '--interval', '0.01', '--timeout', row.timeout ?? '0.0001'), row.expect(id))
  })
}

test('wait stops with exit 3 when the session waits on an approval for this job, naming the agent\'s pane', async t => {
  const s = scratch(t)
  const id = await sentJob(t, s, 'omp')
  writeAgentJob(s, id, 'omp', { state: 'running' })
  await session(t, s, 'omp', () => helloLine('omp', { status: 'needsApproval', turnStartedAt: '2026-11-10T12:00:00.000Z', job: id }))
  assert.deepEqual(await cli(s, 'wait', id, '--interval', '0.01', '--timeout', '5'), {
    code: 3,
    stdout: `Job ${id} is waiting on an approval in the agent's pane.\n`,
    stderr: `claude-errands: job ${id} has waited on an approval in session omp:${SESSION} for 5 polls in a row; the person must answer it in that omp pane. The job is still open, so running wait ${id} again after that is safe\n`,
  })
})

// wait on a dispatched pi job whose brief has not appeared: exit 4, the job left open and its worktree still held.
const stopsNotAdmitted = async (s: Scratch, id: string): Promise<void> => {
  assert.deepEqual(await cli(s, 'wait', id, '--interval', '0.01', '--timeout', '5'), {
    code: 4,
    stdout: `Job ${id} was handed to the session at ${DISPATCHED_AT} and has not appeared in it yet.\n`,
    stderr: `claude-errands: job ${id}: the brief has not appeared in session pi:${SESSION} for 5 polls in a row, and that session reports nothing going; look at that pi pane. The job is still open: run wait ${id} again, or abandon ${id} if it will never run\n`,
  })
  const record = JSON.parse(readFileSync(join(s.state, 'claude-errands', 'jobs', `${id}.json`), 'utf8')) as { outcome: unknown }
  assert.equal(record.outcome, null)
  const again = await cli(s, 'send', s.brief, '--target', `pi:${SESSION}`)
  assert.deepEqual(again, { code: 1, stdout: '', stderr: `claude-errands: worktree ${s.repo} is held by job ${id}, which has no outcome yet; wait for it or run: abandon ${id}\n` })
}

test('wait stops with exit 4 when the brief has not appeared and the session reports nothing going, and leaves the job open', async t => {
  const s = scratch(t)
  const id = await sentJob(t, s, 'pi')
  writeAgentJob(s, id, 'pi', { state: 'dispatching', dispatchedAt: DISPATCHED_AT })
  await session(t, s, 'pi', () => helloLine('pi', { job: id }))
  await stopsNotAdmitted(s, id)
})

// The dialog may belong to anything in the session; a brief that has not appeared is not what it waits on.
test('wait stops with exit 4, not 3, when the brief has not appeared while a pi dialog is open', async t => {
  const s = scratch(t)
  const id = await sentJob(t, s, 'pi')
  writeAgentJob(s, id, 'pi', { state: 'dispatching', dispatchedAt: DISPATCHED_AT })
  await session(t, s, 'pi', () => helloLine('pi', { status: 'needsApproval', turnStartedAt: '2026-11-10T12:00:00.000Z', job: id }))
  await stopsNotAdmitted(s, id)
})

test('wait says once that a job is queued behind an omp background job, keeps waiting, and exits 0', async t => {
  const s = scratch(t)
  const id = await sentJob(t, s, 'omp')
  writeAgentJob(s, id, 'omp', { state: 'queued' })
  const owner = await session(t, s, 'omp', () => helloLine('omp', { status: 'working', turnStartedAt: '2026-11-10T12:00:00.000Z', busy: true, pausedOnBackgroundWork: true }))
  assert.deepEqual(await cli(s, 'wait', id, '--interval', '0.01', '--timeout', '0.02'), {
    code: 0,
    stdout: `Job ${id} is queued behind a background job in session omp:${SESSION}; it starts when that job's result ends the run, or, if the job is killed, after the next run in that pane.\nJob: ${id}\nstill running\n`,
    stderr: '',
  })
  assert.ok(owner.requests.length > 1, `wait polled ${owner.requests.length} times, too few to show the line is printed once`)
})

test('wait settles a job the session dropped before it started as failed with the reason, which frees the worktree', async t => {
  const s = scratch(t)
  const id = await sentJob(t, s, 'omp')
  writeAgentJob(s, id, 'omp', { state: 'dropped', reason: 'session changed' })
  await session(t, s, 'omp', accepting('omp'))
  assert.deepEqual(await cli(s, 'wait', id, '--interval', '0.01', '--timeout', '5'), {
    code: 0,
    stdout: `Job: ${id}\nOutcome: failed\nError: the omp session omp:${SESSION} dropped it before it started: session changed\nFinal answer: none (the turn had no final answer)\n`,
    stderr: '',
  })
  assert.equal((await cli(s, 'wait', id)).stdout, `Job: ${id}\nOutcome: failed\nError: the omp session omp:${SESSION} dropped it before it started: session changed\nFinal answer: none (the turn had no final answer)\n`, 'the outcome is stored')
  const again = await cli(s, 'send', s.brief, '--target', `omp:${SESSION}`)
  assert.equal(again.stderr, '')
  assert.match(again.stdout, /^errand-[0-9a-f-]{36}\n$/)
})

test('abandon drops a queued job whose session is gone, so no later session adopts it', async t => {
  const s = scratch(t)
  const id = await sentJob(t, s, 'pi')
  writeAgentJob(s, id, 'pi', { state: 'queued' })
  const result = await cli(s, 'abandon', id)
  assert.equal(result.stderr, '')
  assert.equal(result.code, 0)
  const record = JSON.parse(readFileSync(join(s.agentJobs, `${id}.json`), 'utf8')) as { state: string; reason: string; seq: number; message: string }
  assert.deepEqual({ state: record.state, reason: record.reason, seq: record.seq, message: record.message }, { state: 'dropped', reason: 'abandoned', seq: 1, message: 'the message' })
  assert.equal(existsSync(join(s.agentJobs, `${id}.adopt`)), false)
})

test('abandon leaves a queued job whose session answers to that session, which drops it when it reaches the job', async t => {
  const s = scratch(t)
  const id = await sentJob(t, s, 'omp')
  writeAgentJob(s, id, 'omp', { state: 'queued' })
  await session(t, s, 'omp', () => helloLine('omp', { status: 'working', turnStartedAt: '2026-11-10T12:00:00.000Z' }))
  assert.equal((await cli(s, 'abandon', id)).code, 0)
  assert.equal((JSON.parse(readFileSync(join(s.agentJobs, `${id}.json`), 'utf8')) as { state: string }).state, 'queued')
})
