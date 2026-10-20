// ABOUTME: Tests the daemon client against a real local socket server that misbehaves, so a bad frame
// ABOUTME: rejects the call instead of crashing the process.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServer } from 'node:http'
import { WebSocketServer } from '#ws'
import { Daemon, NoDaemonError, discoverDaemon, runWithTimeout } from '../src/daemon.ts'

test('a program that exceeds its timeout rejects with the program and deadline', { timeout: 7000 }, async () => {
  await assert.rejects(runWithTimeout('/bin/sleep', ['5'], 100), { message: '/bin/sleep did not finish within 100 ms' })
})

test('a program that finishes before its timeout returns stdout', { timeout: 7000 }, async () => {
  const { stdout } = await runWithTimeout('/bin/echo', ['ok'], 5000)
  assert.equal(stdout, 'ok\n')
})

test('a frame that is not JSON rejects the call with the method name', async () => {
  const socket = join(realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-daemon-'))), 'sock')
  const http = createServer()
  const server = new WebSocketServer({ server: http })
  server.on('connection', client => client.send('this is not json'))
  await new Promise<void>(resolve => http.listen(socket, resolve))
  try {
    await assert.rejects(new Daemon(socket).queueList('thread-a'), { message: /^daemon thread\/queue\/list sent a frame that is not JSON: this is not json/ })
  } finally {
    server.close()
    http.close()
  }
})

// A daemon that answers initialize, then thread/read the way codex-cli 0.162.1 does for a thread that has
// never run a turn: includeTurns:true is refused with -32601, includeTurns:false answers with no turns.
const freshThreadDaemon = async (reads: unknown[], fields: Record<string, unknown> = {}): Promise<{ socket: string, close: () => void }> => {
  const socket = join(realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-daemon-'))), 'sock')
  const http = createServer()
  const server = new WebSocketServer({ server: http })
  server.on('connection', client => client.on('message', bytes => {
    const frame = JSON.parse(String(bytes))
    if (frame.id === 1) return client.send(JSON.stringify({ id: 1, result: {} }))
    if (frame.id !== 2) return
    reads.push(frame.params)
    if (frame.params.includeTurns) return client.send(JSON.stringify({ id: 2, error: { code: -32601, message: 'list_turns is not supported yet' } }))
    client.send(JSON.stringify({ id: 2, result: { thread: { name: null, cwd: '/work', preview: '', status: { type: 'idle' }, turns: [], ...fields } } }))
  }))
  await new Promise<void>(resolve => http.listen(socket, resolve))
  return { socket, close: () => { server.close(); http.close() } }
}

test('a thread that has never run a turn reads as one with no turns', async () => {
  const reads: unknown[] = []
  const daemon = await freshThreadDaemon(reads)
  try {
    const thread = await new Daemon(daemon.socket).readThread('fresh')
    assert.deepEqual({ cwd: thread.cwd, turns: thread.turns }, { cwd: '/work', turns: [] })
    assert.deepEqual(reads, [{ threadId: 'fresh', includeTurns: true }, { threadId: 'fresh', includeTurns: false }])
  } finally {
    daemon.close()
  }
})

test('a thread summary carries recencyAt in Unix seconds without reading turns', async () => {
  const reads: unknown[] = []
  const daemon = await freshThreadDaemon(reads, { ephemeral: false, threadSource: 'user', recencyAt: 1700000000 })
  try {
    const thread = await new Daemon(daemon.socket).readThreadSummary('fresh')
    assert.equal(thread.recencyAt, 1700000000)
    assert.deepEqual(reads, [{ threadId: 'fresh', includeTurns: false }])
  } finally {
    daemon.close()
  }
})

for (const recencyAt of [undefined, 'recent', null, 1e20]) {
  test(`a thread summary rejects recencyAt ${JSON.stringify(recencyAt)}`, async () => {
    const daemon = await freshThreadDaemon([], { ephemeral: false, threadSource: 'user', recencyAt })
    try {
      await assert.rejects(new Daemon(daemon.socket).readThreadSummary('fresh'), {
        message: `daemon thread/read for fresh returned invalid recencyAt: ${JSON.stringify(recencyAt)}`,
      })
    } finally {
      daemon.close()
    }
  })
}

test('a Codex home with no managed daemon running is told apart from any other discovery failure', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-home-')))
  const previous = process.env.CODEX_HOME
  process.env.CODEX_HOME = home
  try {
    await assert.rejects(discoverDaemon(), (error: unknown) => {
      assert.ok(error instanceof NoDaemonError)
      assert.equal(error.message, `no managed Codex daemon runs under ${home}/packages/app-server-daemon/`)
      return true
    })
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previous
  }
})
