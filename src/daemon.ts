// ABOUTME: Finds the managed Codex daemon of the current Codex home and speaks its WebSocket JSON-RPC:
// ABOUTME: queue a prompt into a thread, list the queue, read the turns, list loaded threads.
import { execFile } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { promisify } from 'node:util'
import WebSocket from '#ws'

const run = promisify(execFile)
const CALL_TIMEOUT_MS = 15_000

export const runWithTimeout = async (program: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string }> => {
  const signal = AbortSignal.timeout(timeoutMs)
  try {
    return await run(program, args, { signal, killSignal: 'SIGKILL' })
  } catch (error) {
    if (signal.aborted) throw new Error(`${program} did not finish within ${timeoutMs} ms`, { cause: error })
    throw error
  }
}

export type RawItem = { type: string; clientId?: string | null; text?: string; phase?: string }
export type RawTurn = { id: string; status: string; error: unknown; items: RawItem[] }
export type RawThread = { id: string; name: string | null; cwd: string; preview: string; status: { type: string; activeFlags: string[] }; turns: RawTurn[] }
// ephemeral: a short-lived helper Codex starts during a turn (it names the thread), not a session a person works in.
// threadSource: who opened the thread; 'user' for a person's session, 'subagent' for one a Codex session spawned.
export type ThreadSummary = Omit<RawThread, 'turns'> & { ephemeral: boolean; threadSource: string; recencyAt: number }

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

export const codexHome = (): string => realpathSync(process.env.CODEX_HOME ?? `${homedir()}/.codex`)

const managedDaemonPids = (processes: string, prefix: string): number[] => {
  const pids: number[] = []
  for (const line of processes.split('\n')) {
    const match = /^(\d+) (.*)$/.exec(line.trim())
    if (match === null) continue
    const [, pid, command] = match
    if (pid === undefined || command === undefined) throw new Error(`ps line has no pid and command: ${JSON.stringify(line)}`)
    if (command.startsWith(prefix) && command.includes(' --managed-daemon')) pids.push(Number(pid))
  }
  return pids
}

// No Codex session is open: an observed state, which callers that only look around may report as "none".
export class NoDaemonError extends Error {}

export const discoverDaemon = async (): Promise<{ pid: number; socket: string }> => {
  const prefix = `${codexHome()}/packages/app-server-daemon/`
  const { stdout: processes } = await runWithTimeout('/bin/ps', ['-axo', 'pid=,command='], 5000)
  const pids = managedDaemonPids(processes, prefix)
  if (pids.length === 0) throw new NoDaemonError(`no managed Codex daemon runs under ${prefix}`)
  const [pid] = pids
  if (pids.length !== 1 || pid === undefined) throw new Error(`expected one managed daemon under ${prefix}, found pids ${JSON.stringify(pids)}`)
  const { stdout } = await runWithTimeout('/usr/sbin/lsof', ['-a', '-p', String(pid), '-U', '-Fn'], 5000)
  const sockets = [...new Set(stdout.split('\n').filter(line => line.startsWith('n/private/tmp/codex-daemon-')).map(line => line.slice(1)))]
  const [socket] = sockets
  if (sockets.length !== 1 || socket === undefined) throw new Error(`expected one codex-daemon socket held by process ${pid}, found ${JSON.stringify(sockets)}`)
  return { pid, socket }
}

const parseItem = (raw: unknown, threadId: string): RawItem => {
  if (!isRecord(raw) || typeof raw.type !== 'string') throw new Error(`thread ${threadId} has an item without a type: ${JSON.stringify(raw)}`)
  if (raw.type === 'agentMessage' && typeof raw.text !== 'string') throw new Error(`thread ${threadId} has an agentMessage without text: ${JSON.stringify(raw)}`)
  return {
    type: raw.type,
    ...(typeof raw.clientId === 'string' ? { clientId: raw.clientId } : {}),
    ...(typeof raw.text === 'string' ? { text: raw.text } : {}),
    ...(typeof raw.phase === 'string' ? { phase: raw.phase } : {}),
  }
}

const parseThread = (result: unknown, threadId: string): RawThread => {
  const thread = isRecord(result) ? result.thread : undefined
  if (!isRecord(thread) || !Array.isArray(thread.turns) || !isRecord(thread.status) || typeof thread.status.type !== 'string') {
    throw new Error(`daemon thread/read for ${threadId} returned no thread with turns and status: ${JSON.stringify(result).slice(0, 300)}`)
  }
  return {
    id: threadId,
    name: typeof thread.name === 'string' ? thread.name : null,
    cwd: typeof thread.cwd === 'string' ? thread.cwd : '',
    preview: typeof thread.preview === 'string' ? thread.preview : '',
    // Only an active thread carries flags, such as waitingOnApproval.
    status: { type: thread.status.type, activeFlags: Array.isArray(thread.status.activeFlags) ? thread.status.activeFlags.filter(flag => typeof flag === 'string') : [] },
    turns: thread.turns.map(turn => {
      if (!isRecord(turn) || typeof turn.id !== 'string' || typeof turn.status !== 'string' || !Array.isArray(turn.items)) {
        throw new Error(`thread ${threadId} has a malformed turn: ${JSON.stringify(turn).slice(0, 300)}`)
      }
      return { id: turn.id, status: turn.status, error: turn.error ?? null, items: turn.items.map(item => parseItem(item, threadId)) }
    }),
  }
}

/** An error the daemon answered a call with, keeping its JSON-RPC code so a caller can tell one refusal from another. */
export class DaemonCallError extends Error {
  readonly code: unknown
  readonly daemonMessage: string

  constructor(message: string, error: unknown) {
    super(message)
    this.code = isRecord(error) ? error.code : undefined
    this.daemonMessage = isRecord(error) && typeof error.message === 'string' ? error.message : ''
  }

  isTurnlessThread(): boolean {
    return this.code === -32601 && this.daemonMessage.includes('list_turns')
  }
}

export class Daemon {
  private readonly socket: string

  constructor(socket: string) {
    this.socket = socket
  }

  // initialize -> initialized -> the request. The daemon also pushes notifications; only frames answering ids 1 and 2 matter.
  private call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws+unix://${this.socket}:/`)
      const fail = (error: Error): void => {
        clearTimeout(timer)
        ws.terminate()
        reject(error)
      }
      const timer = setTimeout(() => fail(new Error(`daemon ${method} got no answer within ${CALL_TIMEOUT_MS} ms`)), CALL_TIMEOUT_MS)
      ws.on('error', error => fail(new Error(`daemon ${method} on ${this.socket}: ${error.message}`)))
      ws.on('open', () => ws.send(JSON.stringify({
        id: 1, method: 'initialize',
        params: { clientInfo: { name: 'claude-errands', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } },
      })))
      ws.on('message', bytes => {
        let frame: unknown
        try {
          frame = JSON.parse(String(bytes))
        } catch (error) {
          // A throw here would escape the event callback and leave the promise unsettled.
          return fail(new Error(`daemon ${method} sent a frame that is not JSON: ${String(bytes).slice(0, 200)}`, { cause: error }))
        }
        if (!isRecord(frame) || (frame.id !== 1 && frame.id !== 2)) return
        if (frame.error !== undefined) return fail(new DaemonCallError(`daemon ${frame.id === 1 ? 'initialize' : method} failed: ${JSON.stringify(frame.error)}`, frame.error))
        if (frame.id === 1) {
          ws.send(JSON.stringify({ method: 'initialized' }))
          ws.send(JSON.stringify({ id: 2, method, params }))
          return
        }
        clearTimeout(timer)
        ws.close()
        resolve(frame.result)
      })
    })
  }

  async queueAdd(threadId: string, text: string, clientId: string): Promise<void> {
    await this.call('thread/queue/add', { threadId, input: [{ type: 'text', text }], clientUserMessageId: clientId })
  }

  async queueList(threadId: string): Promise<unknown[]> {
    const result = await this.call('thread/queue/list', { threadId })
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error(`daemon thread/queue/list for ${threadId} returned no data array: ${JSON.stringify(result)}`)
    return result.data
  }

  async readThread(threadId: string): Promise<RawThread> {
    try {
      return parseThread(await this.call('thread/read', { threadId, includeTurns: true }), threadId)
    } catch (error) {
      if (!(error instanceof DaemonCallError && error.isTurnlessThread())) throw error
      // codex-cli 0.162.1 refuses includeTurns for a thread that has never run a turn (measured 2026-10-14):
      // read it without turns, so a fresh session can take its first brief.
      return parseThread(await this.call('thread/read', { threadId, includeTurns: false }), threadId)
    }
  }

  // The thread without its turns: what a listing shows, without the daemon sending, or this parsing, every turn.
  async readThreadSummary(threadId: string): Promise<ThreadSummary> {
    const result = await this.call('thread/read', { threadId, includeTurns: false })
    const thread = parseThread(result, threadId)
    const raw = isRecord(result) && isRecord(result.thread) ? result.thread : {}
    const { ephemeral, threadSource, recencyAt } = raw
    if (typeof ephemeral !== 'boolean') throw new Error(`daemon thread/read for ${threadId} returned no ephemeral flag: ${JSON.stringify(result).slice(0, 300)}`)
    if (typeof threadSource !== 'string') throw new Error(`daemon thread/read for ${threadId} returned no threadSource: ${JSON.stringify(result).slice(0, 300)}`)
    if (typeof recencyAt !== 'number' || !Number.isFinite(new Date(recencyAt * 1000).getTime())) throw new Error(`daemon thread/read for ${threadId} returned invalid recencyAt: ${JSON.stringify(recencyAt)}`)
    return { id: thread.id, name: thread.name, cwd: thread.cwd, preview: thread.preview, status: thread.status, ephemeral, threadSource, recencyAt }
  }

  async loadedThreads(): Promise<string[]> {
    const result = await this.call('thread/loaded/list', { cursor: null, limit: 100 })
    if (!isRecord(result) || !Array.isArray(result.data)) throw new Error(`daemon thread/loaded/list returned no data array: ${JSON.stringify(result)}`)
    return result.data.map(id => {
      if (typeof id !== 'string' || id === '') throw new Error(`daemon thread/loaded/list returned an invalid thread id: ${JSON.stringify(id)}`)
      return id
    })
  }
}
