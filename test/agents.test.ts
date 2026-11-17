// ABOUTME: Runs targets and nearby against real Unix sockets in a scratch live/ directory whose peers answer hello
// ABOUTME: well, badly or not at all, and checks what is listed, what is called unreadable and which files are removed.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection, createServer, type Server, type Socket } from 'node:net'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { test, type TestContext } from 'node:test'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')
const run = promisify(execFile)

type Scratch = { root: string; live: string; work: string }

// A short root under /tmp: a socket path must fit in 104 bytes, and the system temp folder on macOS is long.
const scratch = (t: TestContext): Scratch => {
  const root = realpathSync(mkdtempSync('/tmp/ce-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const live = join(root, 'state', 'claude-errands', 'live')
  mkdirSync(live, { recursive: true, mode: 0o700 })
  const work = join(root, 'work')
  mkdirSync(join(work, 'sub'), { recursive: true })
  return { root, live, work }
}

// The CLI runs asynchronously, so this process's peers can answer it.
const cli = async (s: Scratch, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], { env: { ...process.env, CODEX_HOME: s.root, XDG_STATE_HOME: join(s.root, 'state') }, timeout: 10_000 })
    return { code: 0, stdout, stderr }
  } catch (error) {
    // execFile rejects with an error carrying the exit code and both outputs when the command exits non-zero.
    const failed = error as { code: number; stdout: string; stderr: string }
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr }
  }
}

const peer = async (t: TestContext, path: string, onConnection: (socket: Socket) => void): Promise<Server> => {
  const sockets = new Set<Socket>()
  const server = createServer(socket => {
    sockets.add(socket)
    socket.on('error', () => socket.destroy())
    onConnection(socket)
  })
  await new Promise<void>(resolve => server.listen(path, resolve))
  t.after(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy()
    server.close(() => resolve())
  }))
  return server
}

// Replies to the first line it reads with reply, as given.
const answering = (reply: string) => (socket: Socket): void => {
  socket.once('data', () => socket.end(reply))
}

// A socket name for a peer in this process, which is alive.
const name = (agent: 'pi' | 'omp', instance: string): string => `${agent}-${instance}-${process.pid}.sock`

const hello = (fields: Record<string, unknown>): string => `${JSON.stringify({
  v: 1, agent: 'pi', instance: '0123456789ab', pid: process.pid, sessionId: '01a1c572-d7a3-74ae-83a7-a81395f4e714',
  name: null, cwd: '/', status: 'idle', turnStartedAt: null, busy: false, pausedOnBackgroundWork: false, job: null, ...fields,
})}\n`

test('nearby lists answering sessions below the folder, sorted by id, and leaves out one whose folder is gone', async t => {
  const s = scratch(t)
  await peer(t, join(s.live, name('pi', '0123456789ab')), answering(hello({ sessionId: 'z-session', name: 'Fix tests', cwd: join(s.work, 'sub'), status: 'working', turnStartedAt: '2026-11-10T13:00:00.000Z' })))
  await peer(t, join(s.live, name('pi', 'ffffffffffff')), answering(hello({ instance: 'ffffffffffff', sessionId: 'a-session', cwd: join(s.work, 'sub'), status: 'needsApproval', turnStartedAt: '2026-11-10T12:00:00.000Z' })))
  await peer(t, join(s.live, name('omp', '0123456789ab')), answering(hello({ agent: 'omp', sessionId: 'a-session', cwd: s.work })))
  await peer(t, join(s.live, name('pi', 'ba9876543210')), answering(hello({ instance: 'ba9876543210', sessionId: 'c-session', cwd: join(s.work, 'deleted') })))
  await peer(t, join(s.live, name('pi', 'aaaaaaaaaaaa')), answering(hello({ instance: 'aaaaaaaaaaaa', sessionId: 'd-session', cwd: s.root })))
  const result = await cli(s, 'nearby', s.work)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    sessions: [
      { agent: 'omp', id: 'omp:a-session', name: null, cwd: s.work, relativeCwd: '.', status: 'idle', turnStartedAt: null },
      { agent: 'pi', id: 'pi:a-session', name: null, cwd: join(s.work, 'sub'), relativeCwd: 'sub', status: 'needsApproval', turnStartedAt: '2026-11-10T12:00:00.000Z' },
      { agent: 'pi', id: 'pi:z-session', name: 'Fix tests', cwd: join(s.work, 'sub'), relativeCwd: 'sub', status: 'working', turnStartedAt: '2026-11-10T13:00:00.000Z' },
    ],
    failed: [],
  })
})

// SIGKILL leaves the socket file of a peer in its own process behind, and the exit wait reaps its pid.
const killedPeer = async (t: TestContext, live: string): Promise<{ pid: number; path: string }> => {
  const { pid, path, exited } = await spawnPeer(t, live, 'my-session')
  process.kill(pid, 'SIGKILL')
  await exited
  assert.equal(existsSync(path), true, 'SIGKILL leaves the socket file behind')
  return { pid, path }
}

test('two TUIs on one session are listed once, with the most urgent status and the fields of the lowest instance', async t => {
  const s = scratch(t)
  const twin = { sessionId: 'twin-session' }
  await peer(t, join(s.live, name('pi', '000000000001')), answering(hello({ ...twin, instance: '000000000001', name: 'Lowest', cwd: s.work, status: 'working', turnStartedAt: '2026-11-10T10:00:00.000Z' })))
  await peer(t, join(s.live, name('pi', '000000000002')), answering(hello({ ...twin, instance: '000000000002', name: 'Second', cwd: join(s.work, 'sub'), status: 'needsApproval', turnStartedAt: '2026-11-10T12:00:00.000Z' })))
  await peer(t, join(s.live, name('pi', '000000000003')), answering(hello({ ...twin, instance: '000000000003', name: 'Third', cwd: join(s.work, 'sub'), status: 'needsApproval', turnStartedAt: '2026-11-10T11:00:00.000Z' })))
  await peer(t, join(s.live, name('omp', '000000000004')), answering(hello({ ...twin, agent: 'omp', instance: '000000000004', cwd: s.work })))
  const result = await cli(s, 'nearby', s.work)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), {
    sessions: [
      { agent: 'omp', id: 'omp:twin-session', name: null, cwd: s.work, relativeCwd: '.', status: 'idle', turnStartedAt: null },
      { agent: 'pi', id: 'pi:twin-session', name: 'Lowest', cwd: s.work, relativeCwd: '.', status: 'needsApproval', turnStartedAt: '2026-11-10T11:00:00.000Z' },
    ],
    failed: [],
  })
})

test('twins are listed once: idle when every twin is idle, working when one works and none waits', async t => {
  const s = scratch(t)
  await peer(t, join(s.live, name('pi', '000000000001')), answering(hello({ sessionId: 'idle-twins', instance: '000000000001', cwd: s.work })))
  await peer(t, join(s.live, name('pi', '000000000002')), answering(hello({ sessionId: 'idle-twins', instance: '000000000002', cwd: s.work })))
  await peer(t, join(s.live, name('pi', '000000000003')), answering(hello({ sessionId: 'busy-twins', instance: '000000000003', cwd: s.work })))
  await peer(t, join(s.live, name('pi', '000000000004')), answering(hello({ sessionId: 'busy-twins', instance: '000000000004', cwd: s.work, status: 'working', turnStartedAt: '2026-11-10T09:00:00.000Z' })))
  const result = await cli(s, 'nearby', s.work)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout).sessions, [
    { agent: 'pi', id: 'pi:busy-twins', name: null, cwd: s.work, relativeCwd: '.', status: 'working', turnStartedAt: '2026-11-10T09:00:00.000Z' },
    { agent: 'pi', id: 'pi:idle-twins', name: null, cwd: s.work, relativeCwd: '.', status: 'idle', turnStartedAt: null },
  ])
})

test('a socket whose process died is removed and not listed', async t => {
  const s = scratch(t)
  const { path } = await killedPeer(t, s.live)
  const result = await cli(s, 'targets')
  assert.deepEqual(result, { code: 0, stdout: '', stderr: '' })
  assert.equal(existsSync(path), false)
})

// A session in a process of its own, listening in live/ as the extension does, answering hello for sessionId, and
// printing its socket's path once it listens.
const PEER = `
const { createServer } = require('node:net')
const [live, sessionId] = process.argv.slice(1)
const path = require('node:path').join(live, 'pi-0123456789ab-' + process.pid + '.sock')
createServer(socket => {
  socket.on('error', () => socket.destroy())
  socket.once('data', () => socket.end(JSON.stringify({ v: 1, agent: 'pi', instance: '0123456789ab', pid: process.pid, sessionId, name: null, cwd: '/', status: 'idle', turnStartedAt: null, busy: false, pausedOnBackgroundWork: false, job: null }) + '\\n'))
}).listen(path, () => console.log(path))
`

const spawnPeer = async (t: TestContext, live: string, sessionId: string): Promise<{ pid: number; path: string; exited: Promise<unknown> }> => {
  const child = spawn(process.execPath, ['-e', PEER, live, sessionId], { stdio: ['ignore', 'pipe', 'inherit'] })
  const exited = new Promise(resolve => child.once('exit', resolve))
  // A stopped child never exits on its own.
  t.after(() => { child.kill('SIGKILL') })
  if (child.pid === undefined) throw new Error('the peer did not start')
  const path = await new Promise<string>(resolve => child.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString().trim())))
  return { pid: child.pid, path, exited }
}

// Opens connections the peer does not accept until one is refused, and returns the open ones.
const fillBacklog = async (path: string): Promise<Socket[]> => {
  const held: Socket[] = []
  while (held.length < 1000) {
    const connected = await new Promise<Socket | null>((resolve, reject) => {
      const socket = createConnection(path)
      socket.once('connect', () => resolve(socket))
      socket.once('error', (error: NodeJS.ErrnoException) => error.code === 'ECONNREFUSED' ? resolve(null) : reject(error))
    })
    if (connected === null) return held
    held.push(connected)
  }
  throw new Error(`${path} accepted 1000 connections without refusing one`)
}

test('a stopped session whose backlog is full keeps its socket, is listed as not accepting connections, and is listed again once it runs', async t => {
  const s = scratch(t)
  const { pid, path } = await spawnPeer(t, s.live, 'my-session')
  process.kill(pid, 'SIGSTOP')
  const held = await fillBacklog(path)
  t.after(() => { for (const socket of held) socket.destroy() })
  const stopped = await cli(s, 'targets')
  assert.deepEqual(stopped, { code: 0, stdout: `${basename(path)}  (unreadable: not accepting connections)\n`, stderr: '' })
  assert.equal(existsSync(path), true, 'the socket file is kept')
  for (const socket of held) socket.destroy()
  process.kill(pid, 'SIGCONT')
  const resumed = await cli(s, 'targets')
  assert.deepEqual(resumed, { code: 0, stdout: 'pi:my-session  (unnamed)  /\n', stderr: '' })
})

test('a refusing socket named for a pid another user runs is kept and listed as not accepting connections', async t => {
  const s = scratch(t)
  const { path: killed } = await killedPeer(t, s.live)
  // launchd's pid: kill(1, 0) fails with EPERM for anyone but root.
  const path = join(s.live, 'pi-0123456789ab-1.sock')
  renameSync(killed, path)
  const result = await cli(s, 'targets')
  assert.deepEqual(result, { code: 0, stdout: 'pi-0123456789ab-1.sock  (unreadable: not accepting connections)\n', stderr: '' })
  assert.equal(existsSync(path), true)
})

const unreadable: Array<[string, string, (socket: Socket) => void]> = [
  ['closes without a reply', 'closed the connection without a reply', socket => { socket.once('data', () => socket.end()) }],
  ['never replies', 'not responding', () => {}],
  ['replies with something other than JSON', 'reply is not JSON: Unexpected token \'h\', "hello" is not valid JSON', answering('hello\n')],
  ['replies with an error', 'answered with an error: unknown op "hello"', answering('{"v":1,"error":"unknown op \\"hello\\""}\n')],
  ['names another agent than its file name', 'reply names agent "omp", the socket name says pi', answering(hello({ agent: 'omp' }))],
  ['names another instance than its file name', 'reply names instance "ffffffffffff", the socket name says 0123456789ab', answering(hello({ instance: 'ffffffffffff' }))],
  ['names a session id with a slash', 'reply has session id "../x", which pi does not accept: it must match ^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$', answering(hello({ sessionId: '../x' }))],
  ['names a session id that starts with a dot', 'reply has session id ".x", which pi does not accept: it must match ^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$', answering(hello({ sessionId: '.x' }))],
  ['reports working with no start time', 'reply has status "working" with turnStartedAt null', answering(hello({ status: 'working' }))],
  ['says nothing about being busy', 'reply has busy undefined, not true or false', answering(hello({ busy: undefined }))],
  ['says nothing about a background-work pause', 'reply has pausedOnBackgroundWork undefined, not true or false', answering(hello({ pausedOnBackgroundWork: undefined }))],
]

for (const [behaviour, reason, onConnection] of unreadable) {
  test(`a socket that ${behaviour} is listed as unreadable and kept`, async t => {
    const s = scratch(t)
    const path = join(s.live, name('pi', '0123456789ab'))
    await peer(t, path, onConnection)
    const result = await cli(s, 'targets')
    assert.deepEqual(result, { code: 0, stdout: `${name('pi', '0123456789ab')}  (unreadable: ${reason})\n`, stderr: '' })
    assert.equal(existsSync(path), true)
    const near = await cli(s, 'nearby', '/')
    assert.equal(near.stdout, '{"sessions":[],"failed":[]}\n')
  })
}

test('a file in live/ that is not a pi or omp socket is listed as unreadable and kept', async t => {
  const s = scratch(t)
  writeFileSync(join(s.live, 'notes.txt'), 'x')
  writeFileSync(join(s.live, name('omp', '0123456789ab')), 'x')
  const result = await cli(s, 'targets')
  assert.equal(result.code, 0)
  assert.equal(result.stdout, `${name('omp', '0123456789ab')}  (unreadable: not a socket)\n${join(s.live, 'notes.txt')}  (unreadable: not named <pi|omp>-<12 hex>-<pid>.sock)\n`)
  assert.equal(existsSync(join(s.live, 'notes.txt')), true)
  assert.equal(existsSync(join(s.live, name('omp', '0123456789ab'))), true)
})

test('session ids are listed as each host accepts them: pi with dots and underscores, omp with underscores', async t => {
  const s = scratch(t)
  await peer(t, join(s.live, name('pi', '0123456789ab')), answering(hello({ sessionId: 'my_task.1', cwd: s.work })))
  await peer(t, join(s.live, name('omp', '0123456789ab')), answering(hello({ agent: 'omp', sessionId: '_my_task-1', cwd: s.work })))
  const result = await cli(s, 'nearby', s.work)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout).sessions.map((session: { id: string }) => session.id), ['omp:_my_task-1', 'pi:my_task.1'])
})

test('targets prints the sessions it could list, then the failed check on stderr, and exits 1', async t => {
  const s = scratch(t)
  await peer(t, join(s.live, name('pi', '0123456789ab')), answering(hello({ cwd: s.work })))
  // CODEX_HOME names a missing folder, so the Codex check fails before it looks for a daemon.
  const missing = join(s.root, 'missing')
  const result = await run(process.execPath, [CLI, 'targets'], { env: { ...process.env, CODEX_HOME: missing, XDG_STATE_HOME: join(s.root, 'state') } }).then(
    () => assert.fail('targets exited 0'),
    // execFile's rejection, as above.
    (error: { code: number; stdout: string; stderr: string }) => error,
  )
  assert.equal(result.code, 1)
  assert.equal(result.stdout, `pi:01a1c572-d7a3-74ae-83a7-a81395f4e714  (unnamed)  ${s.work}\n`)
  assert.equal(result.stderr, `claude-errands: the codex check failed: ENOENT: no such file or directory, lstat '${missing}'\n`)
})
