// ABOUTME: Tests how the Codex transport lists sessions against a real local socket server: a thread the daemon
// ABOUTME: refuses to read is listed as unreadable, a read that breaks fails the whole listing, and turns are never read.
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocketServer } from '#ws'
import { listTargets } from '../src/codex.ts'
import { Daemon } from '../src/daemon.ts'

type Answer = { result: unknown } | { error: unknown }

// Answers initialize, then the one call of each connection by method, thread id and whether turns were asked for.
const fakeDaemon = async (answer: (method: string, threadId: unknown, includeTurns: unknown) => Answer): Promise<{ daemon: Daemon, close: () => void }> => {
  const socket = join(realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-codex-'))), 'sock')
  const http = createServer()
  const server = new WebSocketServer({ server: http })
  server.on('connection', client => client.on('message', bytes => {
    const frame = JSON.parse(String(bytes))
    if (frame.id === 1) return client.send(JSON.stringify({ id: 1, result: {} }))
    if (frame.id === 2) client.send(JSON.stringify({ id: 2, ...answer(frame.method, frame.params?.threadId, frame.params?.includeTurns) }))
  }))
  await new Promise<void>(resolve => http.listen(socket, resolve))
  return { daemon: new Daemon(socket), close: () => { server.close(); http.close() } }
}

const thread = { name: 'Build the parser', cwd: '/work/app', preview: 'Build the parser\nthen test it', status: { type: 'idle', activeFlags: [] }, recencyAt: 1700000000, turns: [], ephemeral: false, threadSource: 'user' }

for (const [status, expected] of [
  [{ type: 'active', activeFlags: [] }, { status: 'working', turnStartedAt: '2023-11-14T22:13:20.000Z' }],
  [{ type: 'active', activeFlags: ['waitingOnApproval'] }, { status: 'needsApproval', turnStartedAt: '2023-11-14T22:13:20.000Z' }],
  [{ type: 'active', activeFlags: ['waitingOnUserInput'] }, { status: 'working', turnStartedAt: '2023-11-14T22:13:20.000Z' }],
  [{ type: 'systemError', activeFlags: ['waitingOnApproval'] }, { status: 'idle', turnStartedAt: null }],
] as const) {
  test(`a thread with status ${status.type} and flags ${JSON.stringify(status.activeFlags)} is ${expected.status}`, async () => {
    const fake = await fakeDaemon(method => method === 'thread/loaded/list'
      ? { result: { data: ['session'] } }
      : { result: { thread: { ...thread, status } } })
    try {
      assert.deepEqual(await listTargets(fake.daemon), [
        { id: 'session', readable: true, name: 'Build the parser', cwd: '/work/app', preview: 'Build the parser\nthen test it', ...expected },
      ])
    } finally {
      fake.close()
    }
  })
}

test('a thread the daemon refuses to read is listed as unreadable beside the readable ones', async () => {
  const fake = await fakeDaemon((method, threadId) => {
    if (method === 'thread/loaded/list') return { result: { data: ['readable', 'ephemeral'] } }
    if (threadId === 'readable') return { result: { thread } }
    return { error: { code: -32600, message: 'ephemeral thread cannot be read' } }
  })
  try {
    assert.deepEqual(await listTargets(fake.daemon), [
      { id: 'readable', readable: true, name: 'Build the parser', cwd: '/work/app', preview: 'Build the parser\nthen test it', status: 'idle', turnStartedAt: null },
      { id: 'ephemeral', readable: false, reason: 'daemon thread/read failed: {"code":-32600,"message":"ephemeral thread cannot be read"}' },
    ])
  } finally {
    fake.close()
  }
})

test('a thread read that breaks fails the listing instead of hiding the thread', async () => {
  const fake = await fakeDaemon((method, threadId) => {
    if (method === 'thread/loaded/list') return { result: { data: ['readable', 'broken'] } }
    if (threadId === 'readable') return { result: { thread } }
    return { result: { unexpected: true } }
  })
  try {
    await assert.rejects(listTargets(fake.daemon), { message: 'daemon thread/read for broken returned no thread with turns and status: {"unexpected":true}' })
  } finally {
    fake.close()
  }
})

test('a listing reads threads without their turns, so a turn it could not parse cannot fail it', async () => {
  const unparseableTurn = { id: 'turn-1', status: 'completed', error: null, items: [{ text: 'an item without a type' }] }
  const fake = await fakeDaemon((method, threadId, includeTurns) => {
    if (method === 'thread/loaded/list') return { result: { data: ['long'] } }
    return { result: { thread: { ...thread, turns: includeTurns === false ? [] : [unparseableTurn] } } }
  })
  try {
    assert.deepEqual(await listTargets(fake.daemon), [
      { id: 'long', readable: true, name: 'Build the parser', cwd: '/work/app', preview: 'Build the parser\nthen test it', status: 'idle', turnStartedAt: null },
    ])
  } finally {
    fake.close()
  }
})

test('an ephemeral helper thread is listed as unreadable even though a read without turns answers', async () => {
  const fake = await fakeDaemon((method, threadId) => {
    if (method === 'thread/loaded/list') return { result: { data: ['readable', 'title-helper'] } }
    if (threadId === 'readable') return { result: { thread } }
    return { result: { thread: { ...thread, name: null, preview: '', ephemeral: true } } }
  })
  try {
    assert.deepEqual(await listTargets(fake.daemon), [
      { id: 'readable', readable: true, name: 'Build the parser', cwd: '/work/app', preview: 'Build the parser\nthen test it', status: 'idle', turnStartedAt: null },
      { id: 'title-helper', readable: false, reason: 'ephemeral helper thread' },
    ])
  } finally {
    fake.close()
  }
})

test('a thread a Codex subagent runs in is listed as unreadable, not as a session', async () => {
  const fake = await fakeDaemon((method, threadId) => {
    if (method === 'thread/loaded/list') return { result: { data: ['readable', 'subagent'] } }
    if (threadId === 'readable') return { result: { thread } }
    return { result: { thread: { ...thread, name: null, threadSource: 'subagent' } } }
  })
  try {
    assert.deepEqual(await listTargets(fake.daemon), [
      { id: 'readable', readable: true, name: 'Build the parser', cwd: '/work/app', preview: 'Build the parser\nthen test it', status: 'idle', turnStartedAt: null },
      { id: 'subagent', readable: false, reason: 'Codex subagent thread' },
    ])
  } finally {
    fake.close()
  }
})
