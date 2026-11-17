// ABOUTME: claude-errands's extension for the pi and omp TUIs. It answers hello and send on a Unix socket in the state directory,
// ABOUTME: queues each accepted job in <stateDir>/agent-jobs, starts it when the session is idle, and records how its run ended.
import { randomBytes } from 'node:crypto'
import { linkSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { homedir } from 'node:os'
import { join } from 'node:path'

type Agent = 'pi' | 'omp'
type Status = 'idle' | 'working' | 'needsApproval'

// The parts of the host API this file uses. pi and omp both provide them under these names.
type Context = {
  mode: string
  sessionManager: { getSessionId(): string; getSessionName(): string | undefined; getCwd(): string }
  ui: { notify(message: string, type?: 'info' | 'warning' | 'error'): void }
  isIdle(): boolean
  // omp only: which agent a context serves, since omp runs extensions for its subagents too.
  agent?: { kind: 'main' | 'sub' }
}
type HostMessage = { role?: string; content?: unknown; stopReason?: string; errorMessage?: string }
type HostEvent = { willContinue?: boolean; awaitingAsyncWork?: boolean; toolCallId?: string; toolName?: string; source?: string; text?: string; message?: HostMessage }
type Host = {
  on(event: string, handler: (event: HostEvent, ctx: Context) => void): void
  // pi returns nothing; omp returns a promise that rejects when it drops the message.
  sendUserMessage(text: string, options?: { deliverAs: 'followUp' }): unknown
}

type JobState = 'queued' | 'dispatching' | 'running' | 'ended' | 'dropped'
// <stateDir>/agent-jobs/<job>.json. Only the owner instance writes it, except that a new owner adopts a queued job
// whose owner is gone, and abandon drops one, each under the job's .adopt lock.
type AgentJob = {
  state: JobState; agent: Agent; owner: string; pid: number; sessionId: string; message: string; seq: number; acceptedAt: string
  dispatchedAt?: string; startedAt?: string; merged?: boolean; userIntervened?: boolean
  endedAt?: string; status?: 'completed' | 'failed'; finalMessage?: string | null; error?: string | null; reason?: string
}
type Request = { op: 'hello' } | { op: 'send'; job: string; session: string }
// The job this instance has handed to the host, from sendUserMessage until its run ends.
type Active = {
  job: string; message: string; phase: 'dispatching' | 'running'
  // Runs started before dispatch, so a run numbered above it began after.
  runsAtDispatch: number; userIntervened: boolean; merged: boolean
}
type LastAssistant = { stopReason: string | undefined; errorMessage: string | undefined; text: string }

const MAX_REQUEST_BYTES = 256 * 1024
const IDLE_TIMEOUT_MS = 2000
const MAX_CONNECTIONS = 8
// macOS's sun_path holds 104 bytes, including the terminating NUL.
const MAX_SOCKET_PATH_BYTES = 103
const HELLO_TIMEOUT_MS = 1000
const DRAIN_RETRY_MS = 2000
const JOB_ID = /^errand-[0-9a-f-]{36}$/
const SOCKET_NAME = /^(pi|omp)-([0-9a-f]{12})-([1-9][0-9]{0,6})\.sock$/

// The hosts load this file alone through a symlink, so it cannot import src/job.ts. This is stateDir()'s rule from there.
const stateDir = (): string => join(process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state'), 'claude-errands')
const liveDir = (): string => join(stateDir(), 'live')
const agentJobsDir = (): string => join(stateDir(), 'agent-jobs')
const agentJobPath = (job: string): string => join(agentJobsDir(), `${job}.json`)

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)
const errorCode = (error: unknown): string | undefined =>
  error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined

const liveDirProblem = (dir: string): string | null => {
  const uid = process.getuid?.()
  if (uid === undefined) return 'this platform reports no user id'
  const stat = lstatSync(dir)
  if (!stat.isDirectory()) return `${dir} is not a directory`
  if (stat.uid !== uid) return `${dir} is owned by uid ${stat.uid}, not by this user (uid ${uid})`
  const mode = stat.mode & 0o777
  if (mode !== 0o700) return `${dir} has mode ${mode.toString(8)}, not 700`
  return null
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const parseRequest = (line: string): Request | { error: string } => {
  let request: unknown
  try {
    request = JSON.parse(line)
  } catch (error) {
    return { error: `request is not JSON: ${describe(error)}` }
  }
  if (!isRecord(request)) return { error: `request is not a JSON object: ${line.slice(0, 200)}` }
  if (request.v !== 1) return { error: `unsupported version ${JSON.stringify(request.v)}, expected 1` }
  const fields = request.op === 'hello' ? ['v', 'op'] : request.op === 'send' ? ['v', 'op', 'job', 'session'] : null
  if (fields === null) return { error: `unknown op ${JSON.stringify(request.op)}` }
  const extra = Object.keys(request).find(key => !fields.includes(key))
  if (extra !== undefined) return { error: `unexpected field ${JSON.stringify(extra)}` }
  if (request.op === 'hello') return { op: 'hello' }
  if (typeof request.job !== 'string') return { error: `job ${JSON.stringify(request.job)} is not a string` }
  if (typeof request.session !== 'string') return { error: `session ${JSON.stringify(request.session)} is not a string` }
  return { op: 'send', job: request.job, session: request.session }
}

// Files in agent-jobs are written only by this extension and by claude-errands's abandon, so their shape is AgentJob.
const readAgentJob = (job: string): AgentJob | null => {
  try {
    return JSON.parse(readFileSync(agentJobPath(job), 'utf8')) as AgentJob
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null
    throw error
  }
}

// What the CLI's job record says, read at send and before dispatch. Its writer is claude-errands's saveJob.
const readCliJob = (job: string): { found: false } | { found: true; outcome: unknown; message: unknown; target: unknown } => {
  let text: string
  try {
    text = readFileSync(join(stateDir(), 'jobs', `${job}.json`), 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { found: false }
    throw error
  }
  const record: unknown = JSON.parse(text)
  if (!isRecord(record)) throw new Error(`job record ${job} is not a JSON object`)
  return { found: true, outcome: record.outcome, message: record.message, target: record.target }
}

const textOf = (message: HostMessage | undefined): string => {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(part => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []).join('\n')
}

// The run's outcome from its last assistant message.
const outcomeOf = (last: LastAssistant | null): Pick<AgentJob, 'status' | 'finalMessage' | 'error'> => {
  if (last === null) return { status: 'failed', finalMessage: null, error: 'the run ended without an assistant message' }
  const finalMessage = last.text === '' ? null : last.text
  switch (last.stopReason) {
    case 'stop': return { status: 'completed', finalMessage, error: null }
    case 'error': return { status: 'failed', finalMessage, error: last.errorMessage ?? 'the run ended with an error and no error message' }
    case 'aborted': return { status: 'failed', finalMessage, error: 'interrupted' }
    case 'length': return { status: 'failed', finalMessage, error: 'output truncated' }
    default: return { status: 'failed', finalMessage, error: `the run ended with stop reason ${JSON.stringify(last.stopReason)}` }
  }
}

// One hello to a socket: its reply line, or null when it refuses, fails or stays silent for HELLO_TIMEOUT_MS.
const helloLine = (path: string): Promise<{ line: string } | { failed: string }> => new Promise(resolve => {
  const socket = createConnection(path)
  socket.unref()
  let buffered = ''
  let settled = false
  const finish = (result: { line: string } | { failed: string }): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.destroy()
    resolve(result)
  }
  const timer = setTimeout(() => finish({ failed: 'not responding' }), HELLO_TIMEOUT_MS)
  timer.unref()
  socket.on('error', error => finish({ failed: errorCode(error) ?? error.message }))
  socket.on('connect', () => socket.write('{"v":1,"op":"hello"}\n'))
  socket.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    const newline = buffered.indexOf('\n')
    if (newline !== -1) finish({ line: buffered.slice(0, newline) })
  })
  socket.on('end', () => finish({ failed: 'closed without a reply' }))
})

const processGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return errorCode(error) === 'ESRCH'
  }
}

// An owner is gone when its socket file is missing, or refuses while no process holds its pid. One that neither
// connects nor refuses within HELLO_TIMEOUT_MS is not proven gone, so its jobs stay with it.
const ownerGone = (agent: Agent, owner: string, pid: number): Promise<boolean> => new Promise(resolve => {
  const path = join(liveDir(), `${agent}-${owner}-${pid}.sock`)
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return resolve(true)
  const socket = createConnection(path)
  socket.unref()
  const finish = (gone: boolean): void => {
    clearTimeout(timer)
    socket.destroy()
    resolve(gone)
  }
  const timer = setTimeout(() => finish(false), HELLO_TIMEOUT_MS)
  timer.unref()
  socket.on('connect', () => finish(false))
  socket.on('error', error => {
    const code = errorCode(error)
    finish(code === 'ENOENT' || (code === 'ECONNREFUSED' && processGone(pid)))
  })
})

export default function claudeErrands(pi: Host): void {
  const agent: Agent | null = process.versions.bun !== undefined ? 'omp' : process.env.PI_CODING_AGENT === 'true' ? 'pi' : null
  if (agent === null) return

  let ctx: Context | null = null
  let listening: { server: Server; path: string; instance: string } | null = null
  let shutDown = false
  let connections = 0
  let runStartedAt: string | null = null
  // omp only: the run's last agent_end paused it until a background job's result wakes it, and it has not since.
  // The run is not over, so it holds the queue; hello says so, since nothing else in the session shows it.
  let pausedOnBackgroundWork = false
  let runs = 0
  let userMessagesThisRun = 0
  let lastAssistant: LastAssistant | null = null
  let active: Active | null = null
  let lastSeq = 0
  let drainRetry: ReturnType<typeof setTimeout> | null = null
  // The error the last failed drain reported, until a drain succeeds.
  let drainFailure: string | null = null
  // True while session_start's adoption runs, so a job accepted meanwhile cannot start before an older adopted one.
  let adopting = false
  // Jobs this instance owns that are still queued, in seq order.
  let queue: Array<{ job: string; seq: number }> = []
  // What the session waits on the person for, keyed by kind and call id, with when each wait began.
  const waits = new Map<string, string>()

  const serves = (candidate: Context): boolean =>
    candidate.mode === 'tui' && process.stdout.isTTY === true && (candidate.agent === undefined || candidate.agent.kind === 'main')

  const notify = (message: string): void => {
    ctx?.ui.notify(`claude-errands: ${message}; this session will not be listed`, 'error')
  }
  const warn = (message: string): void => {
    ctx?.ui.notify(`claude-errands: ${message}`, 'warning')
  }

  // Timers and socket callbacks run outside the host's handler guard, so nothing may escape them.
  const guarded = (what: string, work: () => void): void => {
    try {
      work()
    } catch (error) {
      warn(`${what} failed: ${describe(error)}`)
    }
  }

  const activity = (): { status: Status; turnStartedAt: string | null } => {
    const earliestWait = [...waits.values()].sort()[0]
    if (earliestWait !== undefined) return { status: 'needsApproval', turnStartedAt: runStartedAt ?? earliestWait }
    if (runStartedAt !== null) return { status: 'working', turnStartedAt: runStartedAt }
    return { status: 'idle', turnStartedAt: null }
  }

  const hello = (session: Context, instance: string): object => ({
    v: 1, agent, instance, pid: process.pid,
    sessionId: session.sessionManager.getSessionId(),
    name: session.sessionManager.getSessionName() ?? null,
    cwd: realpathSync(session.sessionManager.getCwd()),
    ...activity(),
    // A run, or the host preparing one or compacting: something that may yet take a dispatched brief.
    busy: runStartedAt !== null || !session.isIdle(),
    pausedOnBackgroundWork,
    job: active?.job ?? null,
  })

  const writeAgentJob = (job: string, record: AgentJob, instance: string): void => {
    const tmp = `${agentJobPath(job)}.${instance}.tmp`
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, agentJobPath(job))
  }

  // Owner-only: a record another instance adopted, or one already gone, is left alone. seq and the rest are kept.
  const update = (job: string, change: Partial<AgentJob>): boolean => {
    if (listening === null) return false
    const current = readAgentJob(job)
    if (current === null || current.owner !== listening.instance) return false
    writeAgentJob(job, { ...current, ...change }, listening.instance)
    return true
  }

  const finish = (change: Pick<AgentJob, 'status' | 'finalMessage' | 'error'>): void => {
    if (active === null) return
    const ended = active
    active = null
    update(ended.job, { state: 'ended', endedAt: new Date().toISOString(), merged: ended.merged, userIntervened: ended.userIntervened, ...change })
    scheduleDrain(0)
  }

  // The host said it will not run the brief. Nothing else fails a dispatched job: a host can take the brief long after
  // dispatch, or after a run that ended without it, so silence and timing prove nothing.
  const reject = (job: string, what: string): void => {
    if (active?.job !== job || active.phase !== 'dispatching') return
    finish({ status: 'failed', finalMessage: null, error: `the ${agent} session did not take the brief: ${what}` })
  }

  // Why the CLI no longer wants a job that has not started: abandon gave it an outcome, or its record is gone.
  const unwanted = (job: string): string | null => {
    const cli = readCliJob(job)
    if (!cli.found) return 'the job record is gone'
    return cli.outcome === null ? null : 'abandoned'
  }

  // Does nothing when the record is no longer this instance's to start.
  const dispatch = (job: string, message: string): void => {
    if (!update(job, { state: 'dispatching', dispatchedAt: new Date().toISOString() })) return
    active = { job, message, phase: 'dispatching', runsAtDispatch: runs, userIntervened: false, merged: false }
    let sent: unknown
    try {
      // A run can start between the idle check and the host taking the brief. pi then throws the brief away unless
      // it is told how to queue it; as a follow-up it joins that run when the run would stop. omp steers it into
      // that run by itself, and with an explicit deliverAs it would not start a run when idle.
      sent = agent === 'pi' ? pi.sendUserMessage(message, { deliverAs: 'followUp' }) : pi.sendUserMessage(message)
    } catch (error) {
      return reject(job, `sendUserMessage threw: ${describe(error)}`)
    }
    if (sent instanceof Promise) {
      sent.catch((error: unknown) => guarded('the dispatch', () => {
        reject(job, `sendUserMessage failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`)
      }))
    }
  }

  const drain = (): void => {
    if (shutDown || adopting || ctx === null || listening === null) return
    for (;;) {
      if (active !== null) {
        if (active.phase === 'running') return
        // A brief that has not appeared holds the session until it does, or until the CLI abandons it; the retry
        // notices an abandon while jobs wait behind it.
        const reason = unwanted(active.job)
        if (reason === null) return queue.length > 0 ? scheduleDrain(DRAIN_RETRY_MS) : undefined
        update(active.job, { state: 'dropped', reason })
        active = null
      }
      const head = queue[0]
      if (head === undefined) return
      const record = readAgentJob(head.job)
      if (record === null || record.owner !== listening.instance || record.state !== 'queued') {
        queue.shift()
        continue
      }
      const reason = unwanted(head.job)
      if (reason !== null) {
        update(head.job, { state: 'dropped', reason })
        queue.shift()
        continue
      }
      if (record.sessionId !== ctx.sessionManager.getSessionId()) {
        update(head.job, { state: 'dropped', reason: 'session changed' })
        queue.shift()
        continue
      }
      // Compaction keeps pi busy without a run, so no end of run follows it; the retry covers that. The host can also
      // be idle before this extension has seen the run end, so both must agree.
      if (!ctx.isIdle() || runStartedAt !== null) return scheduleDrain(DRAIN_RETRY_MS)
      queue.shift()
      dispatch(head.job, record.message)
    }
  }

  // Never throws into the host. A failed drain tries again, since a record that cannot be read now may be readable
  // later and nothing else would retry; the same error is reported once, not every 2 seconds.
  const drainOrRetry = (): void => {
    try {
      drain()
      drainFailure = null
    } catch (error) {
      const message = describe(error)
      if (message !== drainFailure) warn(`starting a queued job failed: ${message}`)
      drainFailure = message
      if (!shutDown && drainRetry === null) scheduleDrain(DRAIN_RETRY_MS)
    }
  }

  const scheduleDrain = (ms: number): void => {
    if (drainRetry !== null) clearTimeout(drainRetry)
    drainRetry = setTimeout(() => {
      drainRetry = null
      drainOrRetry()
    }, ms)
    drainRetry.unref()
  }

  const nextSeq = (): number => {
    lastSeq = Math.max(Date.now(), lastSeq + 1)
    return lastSeq
  }

  const refusal = (error: string): object => ({ v: 1, error })

  // Another live instance on this session, found by asking every other socket for hello.
  const twinOf = async (sessionId: string, ownPath: string): Promise<string | null> => {
    const names = readdirSync(liveDir()).filter(name => SOCKET_NAME.test(name) && join(liveDir(), name) !== ownPath)
    const replies = await Promise.all(names.map(name => helloLine(join(liveDir(), name))))
    for (const reply of replies) {
      if (!('line' in reply)) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(reply.line)
      } catch {
        continue
      }
      if (isRecord(parsed) && parsed.agent === agent && parsed.sessionId === sessionId && typeof parsed.instance === 'string') return parsed.instance
    }
    return null
  }

  // The five checks, in order. Text never arrives here: the message comes from the CLI's own job record.
  const accept = async (job: string, session: string): Promise<object> => {
    if (ctx === null || listening === null) return refusal('no session has started')
    const self = listening
    if (!JOB_ID.test(job)) return refusal(`job ${JSON.stringify(job)} is not a claude-errands job id`)
    const current = ctx.sessionManager.getSessionId()
    const cli = readCliJob(job)
    if (!cli.found) return refusal(`no job record ${job} in ${join(stateDir(), 'jobs')}`)
    if (cli.outcome !== null) return refusal(`job ${job} already has an outcome`)
    if (typeof cli.message !== 'string') return refusal(`job record ${job} has no message`)
    if (cli.target !== `${agent}:${current}`) return refusal(`job ${job} is for ${JSON.stringify(cli.target)}, and this session is ${agent}:${current}`)
    if (session !== current) return refusal(`send names session ${JSON.stringify(session)}, and this session is ${current}`)
    const twin = await twinOf(current, self.path)
    if (twin !== null) return refusal(`session ${current} is also open in ${agent} instance ${twin}, so which one would run the job is ambiguous`)
    if (shutDown || listening !== self) return refusal('this extension instance has shut down')
    mkdirSync(agentJobsDir(), { recursive: true, mode: 0o700 })
    const seq = nextSeq()
    const record: AgentJob = { state: 'queued', agent, owner: self.instance, pid: process.pid, sessionId: current, message: cli.message, seq, acceptedAt: new Date().toISOString() }
    // link fails with EEXIST when the file exists, so exactly one send creates it, and no reader sees it half written.
    const tmp = `${agentJobPath(job)}.${self.instance}.tmp`
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
    try {
      linkSync(tmp, agentJobPath(job))
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw error
      return { v: 1, duplicate: true, state: readAgentJob(job)?.state ?? null }
    } finally {
      rmSync(tmp, { force: true })
    }
    queue.push({ job, seq })
    scheduleDrain(0)
    return { v: 1, accepted: true }
  }

  const respond = (socket: Socket, reply: object): void => {
    if (!socket.destroyed) socket.end(`${JSON.stringify(reply)}\n`)
  }

  const answer = (socket: Socket, instance: string, line: string): void => {
    const request = parseRequest(line)
    if ('error' in request) return respond(socket, refusal(request.error))
    if (ctx === null) return respond(socket, refusal('no session has started'))
    if (request.op === 'hello') return respond(socket, hello(ctx, instance))
    accept(request.job, request.session).then(
      reply => respond(socket, reply),
      (error: unknown) => respond(socket, refusal(`cannot accept job ${request.job}: ${describe(error)}`)),
    )
  }

  const serve = (socket: Socket, instance: string): void => {
    socket.unref()
    // A client that hangs up before the reply raises EPIPE here; without a listener that error kills the host.
    socket.on('error', () => socket.destroy())
    if (connections >= MAX_CONNECTIONS) return void socket.destroy()
    connections += 1
    socket.on('close', () => { connections -= 1 })
    socket.setTimeout(IDLE_TIMEOUT_MS, () => socket.destroy())
    let buffered = Buffer.alloc(0)
    let answered = false
    socket.on('data', (chunk: Buffer) => {
      if (answered) return
      try {
        buffered = Buffer.concat([buffered, chunk])
        const newline = buffered.indexOf(10)
        if (newline === -1 && buffered.length <= MAX_REQUEST_BYTES) return
        answered = true
        if (newline === -1 || newline > MAX_REQUEST_BYTES) return respond(socket, refusal(`request is over ${MAX_REQUEST_BYTES} bytes`))
        answer(socket, instance, buffered.subarray(0, newline).toString('utf8'))
      } catch (error) {
        respond(socket, refusal(`cannot answer: ${describe(error)}`))
      }
    })
  }

  const listen = (): void => {
    const live = liveDir()
    try {
      mkdirSync(live, { recursive: true, mode: 0o700 })
    } catch (error) {
      return notify(`cannot create ${live}: ${describe(error)}`)
    }
    const problem = liveDirProblem(live)
    if (problem !== null) return notify(problem)
    const instance = randomBytes(6).toString('hex')
    const path = join(live, `${agent}-${instance}-${process.pid}.sock`)
    const length = Buffer.byteLength(path)
    if (length > MAX_SOCKET_PATH_BYTES) return notify(`socket path ${path} is ${length} bytes, over the ${MAX_SOCKET_PATH_BYTES} a Unix socket allows`)
    const server = createServer(socket => serve(socket, instance))
    server.on('error', error => {
      if (listening?.server !== server) return
      listening = null
      server.close()
      notify(`cannot listen on ${path}: ${error.message}`)
    })
    server.listen(path)
    server.unref()
    listening = { server, path, instance }
  }

  // After a pi /reload the previous instance is gone and its queued jobs for this session wait for a new owner.
  // Only a gone owner's job is taken: one that answers may be another TUI on this session. The .adopt lock,
  // created exclusively, makes one adopter win.
  const adopt = async (): Promise<void> => {
    if (ctx === null || listening === null) return
    const self = listening
    const current = ctx.sessionManager.getSessionId()
    const names = (() => {
      try {
        return readdirSync(agentJobsDir()).filter(name => name.endsWith('.json'))
      } catch (error) {
        if (errorCode(error) === 'ENOENT') return []
        throw error
      }
    })()
    for (const name of names) {
      const job = name.slice(0, -'.json'.length)
      let record: AgentJob | null
      try {
        record = readAgentJob(job)
      } catch (error) {
        // One unreadable record must not stop the others from being adopted; it is left in place for a person to read.
        warn(`cannot read ${agentJobPath(job)}, so it is not adopted: ${describe(error)}`)
        continue
      }
      if (record === null || record.state !== 'queued' || record.agent !== agent || record.sessionId !== current || record.owner === self.instance) continue
      if (!(await ownerGone(record.agent, record.owner, record.pid))) continue
      const lock = join(agentJobsDir(), `${job}.adopt`)
      try {
        writeFileSync(lock, `${self.instance}\n`, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (errorCode(error) === 'EEXIST') continue
        throw error
      }
      try {
        const locked = readAgentJob(job)
        if (locked === null || locked.state !== 'queued' || locked.owner !== record.owner || shutDown || listening !== self) continue
        writeAgentJob(job, { ...locked, owner: self.instance, pid: process.pid }, self.instance)
        queue.push({ job, seq: locked.seq })
      } finally {
        rmSync(lock, { force: true })
      }
    }
    queue = queue.toSorted((a, b) => a.seq - b.seq)
    lastSeq = Math.max(lastSeq, ...queue.map(entry => entry.seq))
  }

  const close = (): void => {
    shutDown = true
    if (drainRetry !== null) clearTimeout(drainRetry)
    if (listening === null) return
    const { server, path } = listening
    listening = null
    server.close()
    try {
      rmSync(path, { force: true })
    } catch (error) {
      warn(`cannot remove ${path}: ${describe(error)}`)
    }
  }

  // Every handler first checks the context, so a subagent's or a print run's events never touch this session's state.
  const on = (event: string, handler: (event: HostEvent) => void): void => {
    pi.on(event, (hostEvent, candidate) => {
      if (!serves(candidate)) return
      ctx = candidate
      handler(hostEvent)
    })
  }
  const endRun = (): void => {
    runStartedAt = null
    pausedOnBackgroundWork = false
    for (const key of waits.keys()) if (!key.startsWith('dialog')) waits.delete(key)
    if (active?.phase === 'running') finish(outcomeOf(lastAssistant))
    // Within the end-of-run event, not on a timer, so the session is not left idle between one job and the next.
    drainOrRetry()
  }

  on('session_start', () => {
    if (listening !== null || shutDown) return
    listen()
    adopting = true
    adopt()
      .catch((error: unknown) => warn(`adopting queued jobs failed: ${describe(error)}`))
      .finally(() => {
        adopting = false
        scheduleDrain(0)
      })
  })
  on('session_shutdown', close)
  on('agent_start', () => {
    // Before the guard: a run that a background job's result wakes starts again while runStartedAt is still set.
    pausedOnBackgroundWork = false
    if (runStartedAt !== null) return
    runStartedAt = new Date().toISOString()
    runs += 1
    userMessagesThisRun = 0
    lastAssistant = null
  })
  on('input', event => {
    if (active !== null && event.source !== 'extension') active.userIntervened = true
  })
  // Admission is the job's exact text arriving as a user message. It is the job's own run only when it opens a run
  // that began after dispatch; otherwise it joined a run the person started.
  on('message_start', event => {
    if (event.message?.role !== 'user') return
    const text = textOf(event.message)
    if (active?.phase === 'dispatching' && text === active.message) {
      active.phase = 'running'
      active.merged = !(runStartedAt !== null && runs > active.runsAtDispatch && userMessagesThisRun === 0)
      update(active.job, { state: 'running', startedAt: new Date().toISOString(), merged: active.merged })
    } else if (active?.phase === 'running') {
      // Another user message in the job's run, including one typed before dispatch that reached the run as a steer.
      active.userIntervened = true
    }
    userMessagesThisRun += 1
  })
  on('message_end', event => {
    if (event.message?.role !== 'assistant') return
    lastAssistant = { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage, text: textOf(event.message) }
  })
  if (agent === 'omp') {
    // omp keeps this instance across /new and /resume; the switch only refreshes the stored context.
    on('session_switch', () => scheduleDrain(0))
    on('agent_end', event => {
      if (event.willContinue !== true) return endRun()
      pausedOnBackgroundWork = event.awaitingAsyncWork === true
    })
    on('tool_approval_requested', event => { waits.set(`approval:${event.toolCallId}`, new Date().toISOString()) })
    on('tool_approval_resolved', event => { waits.delete(`approval:${event.toolCallId}`) })
    on('tool_execution_start', event => { if (event.toolName === 'ask') waits.set(`ask:${event.toolCallId}`, new Date().toISOString()) })
    on('tool_execution_end', event => { waits.delete(`ask:${event.toolCallId}`) })
  } else {
    on('agent_settled', endRun)
    on('ui_prompt_start', () => { waits.set('dialog', new Date().toISOString()) })
    on('ui_prompt_end', () => { waits.delete('dialog') })
  }
}
