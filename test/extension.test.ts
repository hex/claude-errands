// ABOUTME: Loads the pi/omp extension in this process with a stand-in host that replays the event orders measured in the
// ABOUTME: real TUIs, and checks how a dispatched job is admitted, merged, kept waiting for a late delivery, or failed.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer } from 'node:net'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

type Handler = (event: Record<string, unknown>, ctx: unknown) => unknown
type AgentJob = { state: string; merged?: boolean; status?: string; error?: string | null; finalMessage?: string | null; reason?: string }

const SESSION = 'test-session-1'
// The instance of another TUI on the session, which keeps its own jobs.
const OTHER_INSTANCE = 'bbbbbbbbbbbb'
// The admission limit the approved design named; tests wait past it to show that time alone fails no job.
const ADMISSION_MS = 15_000

// The extension serves only a TUI with a terminal on stdout, as pi.
process.env.PI_CODING_AGENT = 'true'
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

type Agent = 'pi' | 'omp'

type HostOptions = {
  // Which host the extension takes this one for; pi by default.
  agent?: Agent
  // Runs on the state directory before session_start, as files a previous instance left.
  before?: (state: string) => void
  // What the host's sendUserMessage does with a message; it records it and returns nothing, as pi, by default.
  send?: (text: string) => unknown
}

// A host that records the extension's handlers, what it sent and what it notified, and is idle unless a run is going.
const host = async (t: TestContext, options: HostOptions = {}) => {
  const agent = options.agent ?? 'pi'
  const root = realpathSync(mkdtempSync('/tmp/ce-'))
  const previousState = process.env.XDG_STATE_HOME
  process.env.XDG_STATE_HOME = join(root, 'state')
  const state = join(root, 'state', 'claude-errands')
  const notes: string[] = []
  t.after(() => {
    handlers.get('session_shutdown')?.forEach(handler => handler({}, ctx))
    process.env.XDG_STATE_HOME = previousState
    rmSync(root, { recursive: true, force: true })
    assert.deepEqual(notes, [], 'the extension notified nothing the test did not expect')
  })
  options.before?.(state)
  const handlers = new Map<string, Handler[]>()
  const sent: string[] = []
  let busy = false
  let sessionId = SESSION
  const ctx = {
    mode: 'tui',
    isIdle: () => !busy,
    ui: { notify: (message: string) => { notes.push(message) } },
    sessionManager: { getSessionId: () => sessionId, getSessionName: () => undefined, getCwd: () => root },
  }
  // The host's own idea of whether it is busy, apart from the events: pi is busy while a run is being prepared, before
  // agent_start, and idle again before it emits agent_settled to the extensions in turn. omp is idle at every
  // agent_end, one that pauses the run included.
  const setBusy = (value: boolean): void => { busy = value }
  const emit = (event: string, fields: Record<string, unknown> = {}): void => {
    if (event === 'agent_start') busy = true
    if (event === 'agent_settled' || event === 'agent_end') busy = false
    for (const handler of handlers.get(event) ?? []) handler({ type: event, ...fields }, ctx)
  }
  const { default: claudeErrands } = await import(`../pi/claude-errands.ts?instance=${Math.random()}`) as { default: (pi: unknown) => void }
  // The extension tells omp by its Bun runtime, which it reads when the host calls it.
  if (agent === 'omp') Object.defineProperty(process.versions, 'bun', { value: 'stand-in', configurable: true })
  try {
    claudeErrands({
      on: (event: string, handler: Handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
      sendUserMessage: (text: string) => {
        sent.push(text)
        return options.send?.(text)
      },
    })
  } finally {
    Reflect.deleteProperty(process.versions, 'bun')
  }
  emit('session_start', { reason: 'startup' })
  // The server listens once the event loop turns; adoption may still be running when it does.
  const live = join(state, 'live')
  for (let waited = 0; !(readdirSync(live, { withFileTypes: true }).some(entry => entry.name.startsWith(`${agent}-`) && entry.isSocket() && !entry.name.includes(OTHER_INSTANCE))); waited += 1) {
    if (waited > 2000) throw new Error('the extension did not listen within 2 s')
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  // omp keeps the extension across /new and /resume, so the same instance sees the session id change.
  const switchSession = (id: string): void => { sessionId = id }
  return { agent, state, sent, notes, emit, setBusy, switchSession, socketDir: join(state, 'live') }
}

type Host = Awaited<ReturnType<typeof host>>

const request = (path: string, line: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = createConnection(path)
  let reply = ''
  socket.on('error', reject)
  socket.on('connect', () => socket.write(`${line}\n`))
  socket.on('data', chunk => { reply += chunk.toString() })
  socket.on('end', () => resolve(reply))
})

const socketOf = (h: Host): string => {
  const [name] = readdirSync(h.socketDir).filter(file => file.startsWith(`${h.agent}-`) && !file.includes(OTHER_INSTANCE))
  if (name === undefined) throw new Error('the extension is not listening')
  return join(h.socketDir, name)
}

const jobOf = (n: number): { id: string; message: string } => {
  const id = `errand-00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
  return { id, message: `Read the brief of job ${id}.` }
}

// The job record cli.ts writes before it sends.
const writeCliJob = (state: string, n: number, outcome: object | null = null, agent: Agent = 'pi'): void => {
  const { id, message } = jobOf(n)
  mkdirSync(join(state, 'jobs'), { recursive: true })
  writeFileSync(join(state, 'jobs', `${id}.json`), JSON.stringify({ id, target: `${agent}:${SESSION}`, message, outcome }), { mode: 0o600 })
}

// A job recorded as cli.ts records one, then sent; returns its id and message.
const accepted = async (h: Host, n: number): Promise<{ id: string; message: string }> => {
  writeCliJob(h.state, n, null, h.agent)
  const job = jobOf(n)
  assert.equal(await request(socketOf(h), JSON.stringify({ v: 1, op: 'send', job: job.id, session: SESSION })), '{"v":1,"accepted":true}\n')
  return job
}

const record = (h: Host, id: string): AgentJob => JSON.parse(readFileSync(join(h.state, 'agent-jobs', `${id}.json`), 'utf8')) as AgentJob
const outcome = (h: Host, id: string): Pick<AgentJob, 'state' | 'status' | 'merged' | 'error' | 'finalMessage'> => {
  const { state, status, merged, error, finalMessage } = record(h, id)
  return { state, status, merged, error, finalMessage }
}

const userMessage = (text: string): Record<string, unknown> => ({ message: { role: 'user', content: [{ type: 'text', text }] } })
const assistant = (stopReason: string, text: string): Record<string, unknown> => ({ message: { role: 'assistant', stopReason, content: [{ type: 'text', text }] } })
const tick = (ms = 20): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

// Waits until the host has been sent anything, so a loaded machine slowing adoption cannot fail the order check.
const firstSend = async (h: Host, limitMs: number): Promise<void> => {
  const deadline = Date.now() + limitMs
  while (h.sent.length === 0 && Date.now() < deadline) await tick()
}

// Waits until condition holds, polling, and fails naming what it waited for once limitMs has passed.
const until = async (what: string, condition: () => boolean, limitMs: number): Promise<void> => {
  const deadline = Date.now() + limitMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} did not happen within ${limitMs} ms`)
    await tick()
  }
}

// A whole run whose first user message is text, ending with answer.
const runOf = (h: Host, text: string, answer = 'RESULT: done'): void => {
  h.emit('agent_start')
  h.emit('message_start', userMessage(text))
  h.emit('message_end', assistant('stop', answer))
  h.emit('agent_settled')
}

test('a job sent to an idle session is admitted by its message as the first user message of its own run, with no input event (omp\'s order)', { timeout: 10_000 }, async t => {
  const h = await host(t)
  const job = await accepted(h, 1)
  await tick()
  assert.deepEqual(h.sent, [job.message])
  assert.equal(record(h, job.id).state, 'dispatching')
  h.emit('agent_start')
  h.emit('message_start', userMessage(job.message))
  assert.deepEqual({ state: record(h, job.id).state, merged: record(h, job.id).merged }, { state: 'running', merged: false })
  h.emit('message_end', assistant('stop', 'RESULT: done'))
  h.emit('agent_settled')
  assert.deepEqual(outcome(h, job.id), { state: 'ended', status: 'completed', merged: false, error: null, finalMessage: 'RESULT: done' })
})

test('a job whose message arrives as the second user message of a run started after dispatch is merged, and stays dispatching past 15 s until it lands (omp\'s steer)', { timeout: ADMISSION_MS + 10_000 }, async t => {
  const h = await host(t)
  const job = await accepted(h, 2)
  await tick()
  h.emit('agent_start')
  h.emit('message_start', userMessage('A person\'s prompt.'))
  await tick(ADMISSION_MS + 1000)
  assert.equal(record(h, job.id).state, 'dispatching', 'the run that started after dispatch keeps the job waiting')
  h.emit('message_start', userMessage(job.message))
  assert.deepEqual({ state: record(h, job.id).state, merged: record(h, job.id).merged }, { state: 'running', merged: true })
  h.emit('message_end', assistant('stop', 'yes'))
  h.emit('agent_settled')
  assert.deepEqual(outcome(h, job.id), { state: 'ended', status: 'completed', merged: true, error: null, finalMessage: 'yes' })
})

test('a run that started after dispatch and ended without the brief, as when the person aborts with the brief steered (omp), leaves the job dispatching, and the brief is admitted when it arrives later', { timeout: 10_000 }, async t => {
  const h = await host(t)
  const job = await accepted(h, 3)
  await tick()
  h.emit('agent_start')
  h.emit('message_start', userMessage('A person\'s prompt.'))
  const next = await accepted(h, 4)
  h.emit('message_end', assistant('aborted', ''))
  h.emit('agent_settled')
  await tick()
  assert.equal(record(h, job.id).state, 'dispatching', 'a run that ends without the brief proves nothing about it')
  assert.deepEqual(h.sent, [job.message], 'the next job waits for the one still dispatching')
  runOf(h, job.message)
  assert.deepEqual(outcome(h, job.id), { state: 'ended', status: 'completed', merged: false, error: null, finalMessage: 'RESULT: done' })
  assert.deepEqual(h.sent, [job.message, next.message], 'the next job was dispatched in the end-of-run event')
  assert.equal(record(h, next.id).state, 'dispatching')
})

test('a dispatched job whose run has not started 16 s later, with the host idle, stays dispatching and is admitted when it starts (pi awaiting its input handlers and sign-in)', { timeout: ADMISSION_MS + 10_000 }, async t => {
  const h = await host(t)
  const job = await accepted(h, 5)
  await tick()
  h.emit('input', { source: 'extension', text: job.message })
  await tick(ADMISSION_MS + 1000)
  assert.equal(record(h, job.id).state, 'dispatching')
  runOf(h, job.message)
  assert.deepEqual(outcome(h, job.id), { state: 'ended', status: 'completed', merged: false, error: null, finalMessage: 'RESULT: done' })
})

test('jobs sent during a run are not started while the host is idle and this extension has not seen the run end (pi awaiting an earlier extension\'s agent_settled)', { timeout: 10_000 }, async t => {
  const h = await host(t)
  h.emit('agent_start')
  h.emit('message_start', userMessage('A person\'s prompt.'))
  const first = await accepted(h, 6)
  const second = await accepted(h, 7)
  h.emit('message_end', assistant('stop', 'the person\'s answer'))
  h.setBusy(false)
  // The drain retries every 2 s.
  await tick(2300)
  assert.deepEqual(h.sent, [], 'nothing was dispatched before this extension saw the run end')
  h.emit('agent_settled')
  assert.deepEqual(h.sent, [first.message])
  runOf(h, first.message, 'first done')
  assert.deepEqual(outcome(h, first.id), { state: 'ended', status: 'completed', merged: false, error: null, finalMessage: 'first done' })
  assert.deepEqual(h.sent, [first.message, second.message])
  runOf(h, second.message, 'second done')
  assert.deepEqual(outcome(h, second.id), { state: 'ended', status: 'completed', merged: false, error: null, finalMessage: 'second done' })
})

test('a job sent after the host went idle but before the run\'s late end event waits for it, then runs as its own with its own answer (omp\'s detached agent_end)', { timeout: 10_000 }, async t => {
  const h = await host(t)
  h.emit('agent_start')
  h.emit('message_start', userMessage('A person\'s prompt.'))
  h.emit('message_end', assistant('stop', 'the person\'s answer'))
  h.setBusy(false)
  const job = await accepted(h, 8)
  await tick()
  assert.deepEqual(h.sent, [])
  assert.equal(record(h, job.id).state, 'queued')
  h.emit('agent_settled')
  assert.deepEqual(h.sent, [job.message])
  runOf(h, job.message, 'the brief\'s answer')
  assert.deepEqual(outcome(h, job.id), { state: 'ended', status: 'completed', merged: false, error: null, finalMessage: 'the brief\'s answer' })
})

test('a job whose sendUserMessage rejects ends failed with what the host said, and the next job then starts (omp\'s PromptDroppedError)', { timeout: 10_000 }, async t => {
  const dropped = Object.assign(new Error('the prompt was dropped before dispatch'), { name: 'PromptDroppedError' })
  let calls = 0
  const h = await host(t, { send: () => (calls += 1) === 1 ? Promise.reject(dropped) : undefined })
  const job = await accepted(h, 9)
  const next = await accepted(h, 10)
  await tick()
  assert.deepEqual(outcome(h, job.id), {
    state: 'ended', status: 'failed', merged: false, finalMessage: null,
    error: 'the pi session did not take the brief: sendUserMessage failed: PromptDroppedError: the prompt was dropped before dispatch',
  })
  assert.deepEqual(h.sent, [job.message, next.message])
  assert.equal(record(h, next.id).state, 'dispatching')
})

test('a queued job is dropped, never started, when the session changed before it reached the head (omp\'s /new)', { timeout: 10_000 }, async t => {
  const h = await host(t)
  h.emit('agent_start')
  const job = await accepted(h, 11)
  h.switchSession('test-session-2')
  h.emit('session_switch')
  h.emit('agent_settled')
  await tick()
  assert.deepEqual({ state: record(h, job.id).state, reason: record(h, job.id).reason }, { state: 'dropped', reason: 'session changed' })
  assert.deepEqual(h.sent, [])
})

test('a dispatched job the CLI abandons before its brief appears is dropped, and the job queued behind it then starts', { timeout: 10_000 }, async t => {
  const h = await host(t)
  const job = await accepted(h, 12)
  const next = await accepted(h, 13)
  await tick()
  assert.deepEqual(h.sent, [job.message])
  writeCliJob(h.state, 12, { kind: 'abandoned' })
  // The drain retries every 2 s while a job waits behind one that has not appeared.
  await tick(2300)
  assert.deepEqual({ state: record(h, job.id).state, reason: record(h, job.id).reason }, { state: 'dropped', reason: 'abandoned' })
  assert.deepEqual(h.sent, [job.message, next.message])
  runOf(h, job.message, 'the abandoned brief ran after all')
  assert.equal(record(h, next.id).state, 'dispatching', 'the abandoned brief appearing is not the next job\'s admission')
  runOf(h, next.message)
  assert.deepEqual(outcome(h, next.id), { state: 'ended', status: 'completed', merged: false, error: null, finalMessage: 'RESULT: done' })
})

test('a CLI job record that cannot be read while a dispatched job holds the queue is reported once, and the retry goes on until the abandon shows', { timeout: 20_000 }, async t => {
  const h = await host(t)
  const job = await accepted(h, 14)
  const next = await accepted(h, 15)
  await tick()
  assert.deepEqual(h.sent, [job.message])
  writeFileSync(join(h.state, 'jobs', `${job.id}.json`), '{not json')
  await until('the unreadable record being reported', () => h.notes.length > 0, 5000)
  // Two more retries meet the same error.
  await tick(4500)
  const [note, ...others] = h.notes.splice(0)
  assert.deepEqual(others, [], 'the same error is reported once')
  assert.match(note ?? '', /^claude-errands: starting a queued job failed: /)
  writeCliJob(h.state, 14, { kind: 'abandoned' })
  await until('the next job being dispatched', () => h.sent.length === 2, 10_000)
  assert.deepEqual({ state: record(h, job.id).state, reason: record(h, job.id).reason }, { state: 'dropped', reason: 'abandoned' })
  assert.deepEqual(h.sent, [job.message, next.message])
})

test('a job sent while omp\'s run waits on a background job stays queued, hello says so, and it starts when the run ends (omp\'s agent_end awaiting async work)', { timeout: 10_000 }, async t => {
  const h = await host(t, { agent: 'omp' })
  const hello = async (): Promise<{ busy: boolean; pausedOnBackgroundWork: boolean }> => {
    const { busy, pausedOnBackgroundWork } = JSON.parse(await request(socketOf(h), '{"v":1,"op":"hello"}')) as { busy: boolean; pausedOnBackgroundWork: boolean }
    return { busy, pausedOnBackgroundWork }
  }
  h.emit('agent_start')
  h.emit('message_start', userMessage('Start the dev server in the background.'))
  h.emit('message_end', assistant('stop', 'Started.'))
  h.emit('agent_end', { willContinue: true, awaitingAsyncWork: true })
  const job = await accepted(h, 16)
  await tick()
  assert.deepEqual(h.sent, [], 'the paused run holds the queue')
  assert.equal(record(h, job.id).state, 'queued')
  assert.deepEqual(await hello(), { busy: true, pausedOnBackgroundWork: true })
  // The background job's result wakes the run, which pauses again on another one.
  h.emit('agent_start')
  assert.equal((await hello()).pausedOnBackgroundWork, false, 'the woken run is working, not paused')
  h.emit('message_end', assistant('stop', 'The server is up; started the tests in the background.'))
  h.emit('agent_end', { willContinue: true, awaitingAsyncWork: true })
  assert.equal((await hello()).pausedOnBackgroundWork, true)
  assert.deepEqual(h.sent, [])
  h.emit('agent_start')
  h.emit('message_end', assistant('stop', 'Tests pass.'))
  h.emit('agent_end', {})
  assert.deepEqual(h.sent, [job.message], 'dispatched within the run\'s last agent_end')
  assert.deepEqual(await hello(), { busy: false, pausedOnBackgroundWork: false })
})

// A queued record a previous instance on this session left, whose owner's socket is gone.
const orphan = (state: string, n: number, seq: number, owner = 'aaaaaaaaaaaa', pid = 1): void => {
  writeCliJob(state, n)
  const { id, message } = jobOf(n)
  mkdirSync(join(state, 'agent-jobs'), { recursive: true, mode: 0o700 })
  writeFileSync(join(state, 'agent-jobs', `${id}.json`), JSON.stringify({ state: 'queued', agent: 'pi', owner, pid, sessionId: SESSION, message, seq, acceptedAt: '2026-11-10T12:00:00.000Z' }), { mode: 0o600 })
}

test('an unreadable agent-jobs record is reported and left in place, and the other queued jobs are still adopted and run', { timeout: 10_000 }, async t => {
  const bad = join('agent-jobs', `${jobOf(20).id}.json`)
  const h = await host(t, {
    before: state => {
      orphan(state, 21, 1)
      writeFileSync(join(state, bad), '{"state": "queued", "agent"', { mode: 0o600 })
    },
  })
  await tick()
  assert.deepEqual(h.sent, [jobOf(21).message])
  assert.equal(readFileSync(join(h.state, bad), 'utf8'), '{"state": "queued", "agent"')
  const [note, ...others] = h.notes.splice(0)
  assert.deepEqual(others, [])
  assert.match(note ?? '', new RegExp(`^claude-errands: cannot read ${join(h.state, bad).replaceAll('.', '\\.')}, so it is not adopted: `))
})

test('jobs adopted at start run before a job accepted while adoption is still going', { timeout: 20_000 }, async t => {
  const others: Array<{ close: () => void }> = []
  t.after(() => { for (const other of others) other.close() })
  const h = await host(t, {
    before: state => {
      // Jobs of another TUI open on this session: adoption asks that TUI's socket about each, and leaves them to it.
      const live = join(state, 'live')
      mkdirSync(live, { recursive: true, mode: 0o700 })
      const server = createServer(socket => {
        // Adoption connects and hangs up at once; the other TUI ignores that, as the extension does.
        socket.on('error', () => socket.destroy())
        socket.once('data', () => socket.end(`${JSON.stringify({ v: 1, agent: 'pi', instance: OTHER_INSTANCE, pid: process.pid, sessionId: 'test-session-other' })}\n`))
      })
      server.listen(join(live, `pi-${OTHER_INSTANCE}-${process.pid}.sock`))
      others.push(server)
      for (let n = 100; n < 400; n += 1) orphan(state, n, n, OTHER_INSTANCE, process.pid)
      orphan(state, 900, 1)
    },
  })
  const fresh = await accepted(h, 950)
  await firstSend(h, 10_000)
  assert.deepEqual(h.sent, [jobOf(900).message], 'the adopted job started first')
  runOf(h, jobOf(900).message)
  assert.deepEqual(h.sent, [jobOf(900).message, fresh.message])
})
