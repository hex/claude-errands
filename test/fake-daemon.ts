// ABOUTME: A stand-in for Codex's managed daemon, run as its own process so discoverDaemon finds it by command line and socket.
// ABOUTME: Answers the calls send and wait make; each thread read takes its status, cwd and turns from a JSON file the test rewrites.
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { WebSocketServer } from '#ws'
import type { RawTurn } from '../src/daemon.ts'

// queueAddFails: the call answers an error, with the job left out of the queue ('rejected') or put in it ('accepted', the response was lost).
// queueLost: the queue no longer holds what was added.
// after: the state that holds once thread/read has answered `reads` times since the test last wrote the file.
export type FakeState = {
  cwd: string; status: { type: string; activeFlags?: string[] }; turns: RawTurn[]
  queueAddFails?: 'rejected' | 'accepted'; queueLost?: boolean
  after?: { reads: number; state: FakeState }
}
type Queued = { id: string; input: unknown; clientUserMessageId: string }

const [socket, stateFile] = process.argv.slice(3)
if (socket === undefined || stateFile === undefined) throw new Error('usage: fake-daemon.ts --managed-daemon <socket> <state file>')

const queue: Queued[] = []
let written = ''
let reads = 0

const state = (): FakeState => {
  const text = readFileSync(stateFile, 'utf8')
  if (text !== written) {
    written = text
    reads = 0
  }
  const current = JSON.parse(text) as FakeState
  return current.after !== undefined && reads > current.after.reads ? current.after.state : current
}

const answer = (method: string, params: Record<string, unknown>): unknown => {
  switch (method) {
    case 'thread/read': {
      state()
      reads += 1
      const { cwd, status, turns } = state()
      return { thread: { name: null, cwd, preview: '', status, turns } }
    }
    case 'thread/queue/add': {
      const entry = { id: `submission-${queue.length}`, input: params.input, clientUserMessageId: String(params.clientUserMessageId) }
      queue.push(entry)
      return { queuedSubmission: entry }
    }
    case 'thread/loaded/list':
      return { data: [] }
    case 'thread/queue/list': {
      if (state().queueLost === true) return { data: [] }
      // A job leaves the queue when its turn starts.
      const started = new Set(state().turns.flatMap(turn => turn.items.map(item => item.clientId)))
      return { data: queue.filter(entry => !started.has(entry.clientUserMessageId)) }
    }
    default:
      throw new Error(`fake daemon has no method ${method}`)
  }
}

const http = createServer()
new WebSocketServer({ server: http }).on('connection', client => client.on('message', bytes => {
  const frame = JSON.parse(String(bytes)) as { id?: number; method: string; params: Record<string, unknown> }
  if (frame.id === 1) return client.send(JSON.stringify({ id: 1, result: {} }))
  if (frame.id !== 2) return
  const fails = frame.method === 'thread/queue/add' ? state().queueAddFails : undefined
  if (fails === 'accepted') answer(frame.method, frame.params)
  if (fails !== undefined) return client.send(JSON.stringify({ id: 2, error: { code: -32000, message: 'queue add failed' } }))
  client.send(JSON.stringify({ id: 2, result: answer(frame.method, frame.params) }))
}))
http.listen(socket, () => console.log('ready'))
