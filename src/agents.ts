// ABOUTME: The transport for live pi and omp TUI sessions: lists them by asking every socket in <stateDir>/live for hello,
// ABOUTME: sends a job by its id over the session's socket, and reads the job's state from <stateDir>/agent-jobs.
import { lstatSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join } from 'node:path'
import { loadJob, stateDir } from './job.ts'
import { SendRefusedError, TargetClosedError, type Target, type TargetActivity, type Transport, type TurnState } from './transport.ts'

export type AgentName = 'pi' | 'omp'
// A file in live/ whose name is not <pi|omp>-<12 hex>-<pid>.sock, so no agent can be named for it.
export type StrayFile = { path: string; reason: string }
export type AgentListing = { targets: Target[]; strays: StrayFile[] }

const HELLO_TIMEOUT_MS = 1000
// The session asks every other socket for hello before it accepts, each for up to a second.
const SEND_TIMEOUT_MS = 5000
const JOB_ID = /^errand-[0-9a-f-]{36}$/
const MAX_REPLY_BYTES = 64 * 1024
// The pid starts with 1 to 9 and has at most 7 digits: kill(0) would signal this process group, and a larger value throws.
const SOCKET_NAME = /^(pi|omp)-([0-9a-f]{12})-([1-9][0-9]{0,6})\.sock$/
// The session ids each host accepts, and no wider: the id reaches Claude's note unquoted. pi checks its rule in
// assertValidSessionId (dist/core/session-manager.js); omp mints UUIDv7 ids and checks this rule on imported sessions.
const SESSION_ID: Record<AgentName, RegExp> = {
  pi: /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/,
  omp: /^[A-Za-z0-9_-]{1,128}$/,
}

type ReadableTarget = Extract<Target, { readable: true }>
// A socket's entry with the instance its name gives, which orders twins, and its path.
type SocketEntry = { instance: string; path: string; pid: number; target: Target }

type Probe = { kind: 'reply'; line: string } | { kind: 'gone' } | { kind: 'unreadable'; reason: string }
// busy: the session runs, prepares a run or compacts, any of which may yet take a brief it was handed.
// pausedOnBackgroundWork: omp's run waits on a background job to wake it, and holds the queue meanwhile.
type Hello = { session: ReadableTarget; job: string | null; busy: boolean; pausedOnBackgroundWork: boolean }

export const liveDir = (): string => join(stateDir(), 'live')

// Throws when live/ is not this user's private directory: a socket there could belong to anyone.
const checkLiveDir = (dir: string): boolean => {
  const stat = lstatSync(dir, { throwIfNoEntry: false })
  if (stat === undefined) return false
  const uid = process.getuid?.()
  const mode = stat.mode & 0o777
  if (!stat.isDirectory() || stat.uid !== uid || mode !== 0o700) {
    throw new Error(`${dir} must be a directory owned by uid ${uid} with mode 700; it is ${stat.isDirectory() ? 'a directory' : 'not a directory'} owned by uid ${stat.uid} with mode ${mode.toString(8)}`)
  }
  return true
}

// EPERM means a process of another user holds the pid, so it exists.
const processGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'ESRCH'
  }
}

// Sends one request line and reads one reply line, waiting up to timeoutMs.
const exchange = (path: string, pid: number, request: string, timeoutMs: number): Promise<Probe> => new Promise(resolve => {
  const socket = createConnection(path)
  let buffered = Buffer.alloc(0)
  let settled = false
  const finish = (result: Probe): void => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    socket.destroy()
    resolve(result)
  }
  const timer = setTimeout(() => finish({ kind: 'unreadable', reason: 'not responding' }), timeoutMs)
  socket.on('connect', () => socket.write(request))
  socket.on('error', error => {
    const code = 'code' in error && typeof error.code === 'string' ? error.code : 'error'
    if (code === 'ECONNREFUSED') {
      // macOS also refuses while a live listener's backlog is full, as when its process is stopped, so only a gone pid
      // proves the file stale. Another Claude session may remove it first.
      if (!processGone(pid)) return finish({ kind: 'unreadable', reason: 'not accepting connections' })
      rmSync(path, { force: true })
      return finish({ kind: 'gone' })
    }
    if (code === 'ENOENT') return finish({ kind: 'gone' })
    finish({ kind: 'unreadable', reason: `${code} on the socket: ${error.message}` })
  })
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk])
    const newline = buffered.indexOf(10)
    if (newline !== -1) return finish({ kind: 'reply', line: buffered.subarray(0, newline).toString('utf8') })
    if (buffered.length > MAX_REPLY_BYTES) finish({ kind: 'unreadable', reason: `reply over ${MAX_REPLY_BYTES} bytes` })
  })
  socket.on('end', () => finish({ kind: 'unreadable', reason: 'closed the connection without a reply' }))
})

const probe = (path: string, pid: number): Promise<Probe> => exchange(path, pid, '{"v":1,"op":"hello"}\n', HELLO_TIMEOUT_MS)

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

const isIsoTime = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value

// The hello reply, checked field by field: anything off makes the session unreadable, with the reason.
const parseHello = (line: string, agent: AgentName, instance: string): Hello | { reason: string } => {
  let reply: unknown
  try {
    reply = JSON.parse(line)
  } catch (error) {
    return { reason: `reply is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(reply)) return { reason: `reply is not a JSON object: ${line.slice(0, 200)}` }
  if (typeof reply.error === 'string') return { reason: `answered with an error: ${reply.error}` }
  if (reply.v !== 1) return { reason: `reply has version ${JSON.stringify(reply.v)}, expected 1` }
  if (reply.agent !== agent) return { reason: `reply names agent ${JSON.stringify(reply.agent)}, the socket name says ${agent}` }
  if (reply.instance !== instance) return { reason: `reply names instance ${JSON.stringify(reply.instance)}, the socket name says ${instance}` }
  if (typeof reply.sessionId !== 'string' || !SESSION_ID[agent].test(reply.sessionId)) return { reason: `reply has session id ${JSON.stringify(reply.sessionId)}, which ${agent} does not accept: it must match ${SESSION_ID[agent].source}` }
  if (reply.name !== null && typeof reply.name !== 'string') return { reason: `reply has name ${JSON.stringify(reply.name)}, not a string or null` }
  if (typeof reply.cwd !== 'string' || !reply.cwd.startsWith('/')) return { reason: `reply has cwd ${JSON.stringify(reply.cwd)}, not an absolute path` }
  if (reply.job !== null && (typeof reply.job !== 'string' || !JOB_ID.test(reply.job))) return { reason: `reply has job ${JSON.stringify(reply.job)}, not a job id or null` }
  if (typeof reply.busy !== 'boolean') return { reason: `reply has busy ${JSON.stringify(reply.busy)}, not true or false` }
  if (typeof reply.pausedOnBackgroundWork !== 'boolean') return { reason: `reply has pausedOnBackgroundWork ${JSON.stringify(reply.pausedOnBackgroundWork)}, not true or false` }
  let activity: TargetActivity
  if (reply.status === 'idle' && reply.turnStartedAt === null) activity = { status: 'idle', turnStartedAt: null }
  else if ((reply.status === 'working' || reply.status === 'needsApproval') && isIsoTime(reply.turnStartedAt)) activity = { status: reply.status, turnStartedAt: reply.turnStartedAt }
  else return { reason: `reply has status ${JSON.stringify(reply.status)} with turnStartedAt ${JSON.stringify(reply.turnStartedAt)}` }
  return { session: { agent, id: `${agent}:${reply.sessionId}`, readable: true, name: reply.name, cwd: reply.cwd, preview: null, ...activity }, job: reply.job, busy: reply.busy, pausedOnBackgroundWork: reply.pausedOnBackgroundWork }
}

const listSocket = async (dir: string, file: string): Promise<SocketEntry | StrayFile | null> => {
  const path = join(dir, file)
  const match = SOCKET_NAME.exec(file)
  if (match === null) return { path, reason: 'not named <pi|omp>-<12 hex>-<pid>.sock' }
  const [, agentText, instance, pidText] = match
  if (instance === undefined || pidText === undefined) throw new Error(`socket name pattern matched ${file} without an instance or pid`)
  const agent: AgentName = agentText === 'omp' ? 'omp' : 'pi'
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return null
  const pid = Number(pidText)
  if (!stat.isSocket()) return { instance, path, pid, target: { agent, id: file, readable: false, reason: 'not a socket' } }
  const result = await probe(path, pid)
  switch (result.kind) {
    case 'gone': return null
    case 'unreadable': return { instance, path, pid, target: { agent, id: file, readable: false, reason: result.reason } }
    case 'reply': {
      const parsed = parseHello(result.line, agent, instance)
      return { instance, path, pid, target: 'session' in parsed ? parsed.session : { agent, id: file, readable: false, reason: parsed.reason } }
    }
  }
}

const URGENCY: readonly TargetActivity['status'][] = ['needsApproval', 'working', 'idle']

const activityOf = (target: ReadableTarget): TargetActivity =>
  target.status === 'idle' ? { status: 'idle', turnStartedAt: null } : { status: target.status, turnStartedAt: target.turnStartedAt }

// Two TUIs can hold one session. It is listed once: its most urgent status, the earliest turn start among the
// twins with that status, and the lowest instance's other fields.
const mergeTwins = (entries: SocketEntry[]): Target[] => {
  const merged = new Map<string, ReadableTarget>()
  const unreadable: Target[] = []
  for (const { target } of entries.toSorted((a, b) => a.instance < b.instance ? -1 : a.instance > b.instance ? 1 : 0)) {
    if (!target.readable) {
      unreadable.push(target)
      continue
    }
    const kept = merged.get(target.id)
    if (kept === undefined) {
      merged.set(target.id, target)
      continue
    }
    const keptRank = URGENCY.indexOf(kept.status)
    const twinRank = URGENCY.indexOf(target.status)
    const earlier = twinRank === keptRank && target.turnStartedAt !== null && kept.turnStartedAt !== null && target.turnStartedAt < kept.turnStartedAt
    if (twinRank < keptRank || earlier) merged.set(target.id, { ...kept, ...activityOf(target) })
  }
  return [...merged.values(), ...unreadable]
}

const listSockets = async (): Promise<Array<SocketEntry | StrayFile>> => {
  const dir = liveDir()
  if (!checkLiveDir(dir)) return []
  return (await Promise.all(readdirSync(dir).map(file => listSocket(dir, file)))).filter(entry => entry !== null)
}

const isSocketEntry = (entry: SocketEntry | StrayFile): entry is SocketEntry => 'target' in entry

export const listAgentSessions = async (): Promise<AgentListing> => {
  const listed = await listSockets()
  return {
    targets: mergeTwins(listed.filter(isSocketEntry)),
    strays: listed.filter((entry): entry is StrayFile => !isSocketEntry(entry)),
  }
}

// A pi or omp target: <agent>:<session id>.
const parseTarget = (target: string): { agent: AgentName; sessionId: string } => {
  const match = /^(pi|omp):(.+)$/.exec(target)
  const agent = match?.[1]
  const sessionId = match?.[2]
  if ((agent !== 'pi' && agent !== 'omp') || sessionId === undefined) throw new Error(`target ${target} is not pi:<session id> or omp:<session id>`)
  if (!SESSION_ID[agent].test(sessionId)) throw new Error(`target ${target} names session id ${JSON.stringify(sessionId)}, which ${agent} does not accept: it must match ${SESSION_ID[agent].source}`)
  return { agent, sessionId }
}

// The one live instance whose hello names the target's session.
const resolve = async (target: string): Promise<SocketEntry & { target: ReadableTarget }> => {
  parseTarget(target)
  const holders = (await listSockets()).filter((entry): entry is SocketEntry & { target: ReadableTarget } => isSocketEntry(entry) && entry.target.readable && entry.target.id === target)
  const [holder, ...others] = holders
  if (holder === undefined) throw new TargetClosedError(target, 'session')
  if (others.length > 0) throw new SendRefusedError(`session ${target} is open in ${holders.length} TUIs, so which one would run the job is ambiguous; close all but one`)
  return holder
}

type JobState = 'queued' | 'dispatching' | 'running' | 'ended' | 'dropped'
// <stateDir>/agent-jobs/<job>.json, as the extension writes it; only the fields claude-errands reads.
type AgentJob = {
  state: JobState; agent: AgentName; owner: string; pid: number; dispatchedAt: string | null
  merged: boolean; userIntervened: boolean; status: 'completed' | 'failed' | null; finalMessage: string | null; error: string | null; reason: string | null
}

const agentJobPath = (jobId: string): string => join(stateDir(), 'agent-jobs', `${jobId}.json`)

const optional = <T>(record: Record<string, unknown>, field: string, is: (value: unknown) => value is T, jobId: string): T | null => {
  const value = record[field]
  if (value === undefined || value === null) return null
  if (!is(value)) throw new Error(`agent job record ${jobId} has ${field} ${JSON.stringify(value)}`)
  return value
}
const isString = (value: unknown): value is string => typeof value === 'string'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isStatus = (value: unknown): value is 'completed' | 'failed' => value === 'completed' || value === 'failed'

// Missing is null; a record that is there but malformed fails loudly with the field at fault.
const readAgentJob = (jobId: string): AgentJob | null => {
  let text: string
  try {
    text = readFileSync(agentJobPath(jobId), 'utf8')
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null
    throw error
  }
  const record: unknown = JSON.parse(text)
  if (!isRecord(record)) throw new Error(`agent job record ${jobId} is not a JSON object`)
  const { state, agent, owner, pid } = record
  if (state !== 'queued' && state !== 'dispatching' && state !== 'running' && state !== 'ended' && state !== 'dropped') throw new Error(`agent job record ${jobId} has state ${JSON.stringify(state)}`)
  if (agent !== 'pi' && agent !== 'omp') throw new Error(`agent job record ${jobId} has agent ${JSON.stringify(agent)}`)
  if (typeof owner !== 'string' || !/^[0-9a-f]{12}$/.test(owner)) throw new Error(`agent job record ${jobId} has owner ${JSON.stringify(owner)}`)
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1 || pid > 9_999_999) throw new Error(`agent job record ${jobId} has pid ${JSON.stringify(pid)}`)
  return {
    state, agent, owner, pid,
    dispatchedAt: optional(record, 'dispatchedAt', isIsoTime, jobId),
    merged: optional(record, 'merged', isBoolean, jobId) ?? false,
    userIntervened: optional(record, 'userIntervened', isBoolean, jobId) ?? false,
    status: optional(record, 'status', isStatus, jobId),
    finalMessage: optional(record, 'finalMessage', isString, jobId),
    error: optional(record, 'error', isString, jobId),
    reason: optional(record, 'reason', isString, jobId),
  }
}

type Owner = { kind: 'answering'; status: TargetActivity['status']; job: string | null; busy: boolean; pausedOnBackgroundWork: boolean } | { kind: 'unresponsive' } | { kind: 'gone' }

const ownerOf = async (record: AgentJob): Promise<Owner> => {
  const path = join(liveDir(), `${record.agent}-${record.owner}-${record.pid}.sock`)
  if (lstatSync(path, { throwIfNoEntry: false }) === undefined) return { kind: 'gone' }
  const result = await probe(path, record.pid)
  if (result.kind === 'gone') return { kind: 'gone' }
  if (result.kind === 'unreadable') return { kind: 'unresponsive' }
  const hello = parseHello(result.line, record.agent, record.owner)
  return 'session' in hello ? { kind: 'answering', status: hello.session.status, job: hello.job, busy: hello.busy, pausedOnBackgroundWork: hello.pausedOnBackgroundWork } : { kind: 'unresponsive' }
}

export const MERGED_ERROR = 'the brief joined a run the person started; its final answer may not be the agent\'s answer to the brief'

const turnState = (target: string, jobId: string, record: AgentJob, owner: Owner): TurnState => {
  switch (record.state) {
    case 'queued':
      if (owner.kind === 'gone') return { kind: 'closed', reason: `the ${record.agent} session ${target} that queued it is gone; it runs only if that session opens again with claude-errands loaded. To run it elsewhere: abandon ${jobId}, then send the brief to a live session from: targets` }
      return owner.kind === 'answering' && owner.pausedOnBackgroundWork ? { kind: 'queuedBehindBackgroundJob' } : { kind: 'queued' }
    case 'dispatching':
    case 'running':
      if (owner.kind === 'gone') return { kind: 'ended', status: 'failed', finalMessage: null, error: `the ${record.agent} session exited while the job ran; whether it finished is unknown` }
      // Before the approval check: a brief that has not appeared cannot be what an open dialog waits on.
      if (record.state === 'dispatching' && owner.kind === 'answering' && owner.job === jobId && !owner.busy) {
        if (record.dispatchedAt === null) throw new Error(`agent job record ${jobId} is dispatching with no dispatchedAt`)
        return { kind: 'notAdmitted', dispatchedAt: record.dispatchedAt }
      }
      if (owner.kind === 'answering' && owner.status === 'needsApproval' && owner.job === jobId) return { kind: 'waitingOnApproval' }
      return { kind: 'running' }
    case 'dropped':
      return { kind: 'dropped', reason: `the ${record.agent} session ${target} dropped it before it started: ${record.reason ?? 'no reason recorded'}` }
    case 'ended': {
      if (record.status === null) throw new Error(`agent job record ${jobId} has ended with no status`)
      const intervened = record.userIntervened ? { userIntervened: true as const } : {}
      if (record.merged) return { kind: 'ended', status: 'failed', finalMessage: record.finalMessage, error: MERGED_ERROR, ...intervened }
      return { kind: 'ended', status: record.status, finalMessage: record.finalMessage, error: record.error, ...intervened }
    }
  }
}

// Read, ask the owner, read again: the second read decides, so a run that ends and exits while the owner is asked
// is reported as it ended, not as lost with its session. A new owner after an adoption is asked in turn.
const poll = async (target: string, jobId: string): Promise<TurnState> => {
  let record = readAgentJob(jobId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (record === null) return { kind: 'lost' }
    const owner = await ownerOf(record)
    const again = readAgentJob(jobId)
    if (again === null) return { kind: 'lost' }
    if (again.owner === record.owner) return turnState(target, jobId, again, owner)
    record = again
  }
  throw new Error(`agent job record ${jobId} changed owner on 3 reads in a row`)
}

const send = async (target: string, jobId: string, message: string): Promise<void> => {
  const { sessionId } = parseTarget(target)
  // The session reads the message from the job record, never from the socket; it must be the one claude-errands built.
  if (loadJob(jobId).message !== message) throw new Error(`job record ${jobId} holds another message than the one to send`)
  const holder = await resolve(target)
  const result = await exchange(holder.path, holder.pid, `${JSON.stringify({ v: 1, op: 'send', job: jobId, session: sessionId })}\n`, SEND_TIMEOUT_MS)
  if (result.kind === 'gone') throw new TargetClosedError(target, 'session')
  if (result.kind === 'unreadable') throw new Error(`the ${holder.target.agent} session ${target} did not answer the send: ${result.reason}`)
  const reply: unknown = JSON.parse(result.line)
  if (!isRecord(reply)) throw new Error(`the ${holder.target.agent} session ${target} answered the send with ${result.line}`)
  if (typeof reply.error === 'string') throw new SendRefusedError(`the ${holder.target.agent} session ${target} refused job ${jobId}: ${reply.error}`)
  if (reply.accepted === true || reply.duplicate === true) return
  throw new Error(`the ${holder.target.agent} session ${target} answered the send with ${result.line}`)
}

// A queued job whose owner is gone is dropped here, under the lock an adopter takes, so no later session adopts it.
// A live owner sees the abandoned outcome when the job reaches the head of its queue and drops it itself.
const abandon = async (_target: string, jobId: string): Promise<void> => {
  const record = readAgentJob(jobId)
  if (record === null || record.state !== 'queued' || (await ownerOf(record)).kind !== 'gone') return
  const lock = join(stateDir(), 'agent-jobs', `${jobId}.adopt`)
  try {
    writeFileSync(lock, 'abandon\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    // A session adopting the job holds the lock; once it owns the job it reads the abandoned outcome and drops it.
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return
    throw error
  }
  try {
    const locked = readAgentJob(jobId)
    if (locked === null || locked.state !== 'queued' || locked.owner !== record.owner) return
    const current: unknown = JSON.parse(readFileSync(agentJobPath(jobId), 'utf8'))
    if (!isRecord(current)) throw new Error(`agent job record ${jobId} is not a JSON object`)
    const tmp = `${agentJobPath(jobId)}.abandon.tmp`
    writeFileSync(tmp, `${JSON.stringify({ ...current, state: 'dropped', reason: 'abandoned' }, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, agentJobPath(jobId))
  } finally {
    rmSync(lock, { force: true })
  }
}

export const agentsTransport: Transport = {
  send,
  poll,
  async targets() {
    return (await listAgentSessions()).targets
  },
  async liveCwd(target) {
    return (await resolve(target)).target.cwd
  },
  abandon,
}
