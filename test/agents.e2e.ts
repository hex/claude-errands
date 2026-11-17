// ABOUTME: End-to-end check of pi/omp detection against the real pi and omp TUIs under a pty, each with this repository's
// ABOUTME: extension, a scratch session folder and a scratch state directory. Writes its log under test/results/.
import assert from 'node:assert/strict'
import { execFile, execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'

type Agent = 'pi' | 'omp'
type Hello = { v: 1; agent: Agent; instance: string; pid: number; sessionId: string; name: string | null; cwd: string; status: string; turnStartedAt: string | null; busy: boolean; pausedOnBackgroundWork: boolean; job: string | null }
type Root = { dir: string; state: string; live: string; work: string; codexHome: string; probeFile: string }
type Tui = { agent: Agent; root: Root; child: ChildProcess; pid: number; socket: string; hello: Hello; startupMs: number }

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')
const EXTENSION = join(import.meta.dirname, '..', 'pi', 'claude-errands.ts')
const PROBE = join(import.meta.dirname, 'agents-e2e-probe.ts')
const SUN_PATH_BYTES = 104
const log: string[] = []
const roots: string[] = []
const started: ChildProcess[] = []
// The recent terminal output of each process the current scenario launched, written to the log when it fails.
const screens = new Map<string, () => string>()
const run = promisify(execFile)

const note = (line: string): void => {
  log.push(line)
  console.log(line)
}
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const until = async <T>(label: string, ms: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${label}`)
    await sleep(100)
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// Under a short /tmp root, because the socket path must fit macOS's 104-byte sun_path.
const makeRoot = (): Root => {
  const dir = realpathSync(mkdtempSync('/tmp/ce-'))
  roots.push(dir)
  const root = { dir, state: join(dir, 'state'), live: join(dir, 'state', 'claude-errands', 'live'), work: join(dir, 'work'), codexHome: join(dir, 'codex'), probeFile: join(dir, 'probe.jsonl') }
  for (const folder of [root.work, root.codexHome, join(dir, 'sessions')]) mkdirSync(folder, { recursive: true })
  return root
}

const rawHello = (path: string, timeoutMs: number): Promise<Hello | { failed: string }> => new Promise(resolve => {
  const socket = createConnection(path)
  let reply = ''
  const timer = setTimeout(() => { socket.destroy(); resolve({ failed: 'timeout' }) }, timeoutMs)
  socket.on('error', error => { clearTimeout(timer); resolve({ failed: error.message }) })
  socket.on('connect', () => socket.write('{"v":1,"op":"hello"}\n'))
  socket.on('data', chunk => { reply += chunk.toString() })
  socket.on('end', () => {
    clearTimeout(timer)
    if (!reply.endsWith('\n')) return resolve({ failed: `closed after ${JSON.stringify(reply)}` })
    try {
      // The extension under test wrote this line; the assertions on its fields check its shape.
      resolve(JSON.parse(reply) as Hello)
    } catch (error) {
      resolve({ failed: `reply ${JSON.stringify(reply)} is not JSON: ${String(error)}` })
    }
  })
})

// Sends text, then reports what came back before the extension closed the connection.
const exchange = (path: string, text: string): Promise<{ reply: string; closed: boolean }> => new Promise(resolve => {
  const socket = createConnection(path)
  let reply = ''
  const timer = setTimeout(() => { socket.destroy(); resolve({ reply, closed: false }) }, 5000)
  socket.on('error', () => {})
  socket.on('connect', () => socket.write(text))
  socket.on('data', chunk => { reply += chunk.toString() })
  socket.on('close', () => { clearTimeout(timer); resolve({ reply, closed: true }) })
})

// Connects, sends nothing, and reports how long the extension kept the connection open.
const silentConnection = (path: string): Promise<number> => new Promise(resolve => {
  const socket = createConnection(path)
  let opened = Date.now()
  socket.on('error', () => {})
  socket.on('connect', () => { opened = Date.now() })
  socket.on('close', () => resolve(Date.now() - opened))
})

const openConnection = (path: string): Promise<import('node:net').Socket> => new Promise(resolve => {
  const socket = createConnection(path)
  socket.on('error', () => {})
  socket.on('connect', () => resolve(socket))
})

const helloOf = async (path: string): Promise<Hello> => {
  const reply = await rawHello(path, 2000)
  if ('failed' in reply) throw new Error(`hello on ${path} failed: ${reply.failed}`)
  return reply
}

const sockets = (root: Root): string[] => existsSync(root.live) ? readdirSync(root.live).filter(name => name.endsWith('.sock')) : []

const cli = async (root: Root, ...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> => {
  const env = { ...process.env, CODEX_HOME: root.codexHome, XDG_STATE_HOME: root.state }
  const result = await run(process.execPath, [CLI, ...args], { env, timeout: 20_000 }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    // execFile rejects with an error carrying the exit code and both outputs when the command exits non-zero.
    (error: { code: number; stdout: string; stderr: string }) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  )
  log.push(`$ cli ${args.join(' ')}\nexit ${result.code}\n${result.stdout}${result.stderr}`)
  return result
}

// Environment variables that could let an agent reach a provider that bills per token.
const CREDENTIALS = /(_API_KEY|_TOKEN|_OAUTH)/
// The one such variable omp's default model on this Mac, google/gemini-4-argon, reads (pi-ai/src/providers/google.ts:26).
const OMP_MODEL_KEY = ['GEMINI_API_KEY']

// script needs a terminal-capable stdin, and Node's piped stdin is a socket pair it rejects; cat in front makes it a pipe.
// kept: credential variables passed on, for a scenario that needs a model's answer; every other one is left out, so the
// agent otherwise runs on its own stored sign-in only.
const launch = (agent: Agent, root: Root, args: string[], env: Record<string, string> = {}, kept: string[] = []): ChildProcess => {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => kept.includes(name) || !CREDENTIALS.test(name)))
  const noExtensions = agent === 'omp' ? '--no-extensions' : '-ne'
  const child = spawn('sh', ['-c', 'cat | exec script -q /dev/null "$@"', 'sh', agent, noExtensions, '-e', EXTENSION, '-e', PROBE, '--session-dir', join(root.dir, 'sessions'), ...args], {
    cwd: root.work, detached: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...inherited, XDG_STATE_HOME: root.state, CE_PROBE_FILE: root.probeFile, CE_LIVE_DIR: root.live, TERM: 'xterm-256color', ...env },
  })
  started.push(child)
  let screen = ''
  const keep = (chunk: Buffer): void => { screen = (screen + chunk.toString()).slice(-4000) }
  child.stdout?.on('data', keep)
  child.stderr?.on('data', keep)
  screens.set(`${agent} ${args.join(' ')} (${child.pid})`, () => screen.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, ''))
  return child
}

const startTui = async (agent: Agent, root: Root, args: string[] = [], env: Record<string, string> = {}, kept: string[] = []): Promise<Tui> => {
  const before = new Set(sockets(root))
  const startedAt = Date.now()
  const child = launch(agent, root, args, env, kept)
  const socket = await until(`${agent} to open its socket`, 20_000, async () => {
    // spawn gave the shell a pid; the socket's name carries the pid of the agent under it.
    const mine = new Set(descendants(child.pid as number))
    for (const name of sockets(root).filter(name => !before.has(name) && name.startsWith(`${agent}-`) && mine.has(Number(name.split('-')[2]?.split('.')[0])))) {
      const reply = await rawHello(join(root.live, name), 1000)
      if (!('failed' in reply)) return join(root.live, name)
    }
    return undefined
  })
  const hello = await helloOf(socket)
  const startupMs = Date.now() - startedAt
  note(`${agent}: hello answered ${startupMs} ms after launch on ${socket} (${Buffer.byteLength(socket)} bytes)`)
  return { agent, root, child, pid: hello.pid, socket, hello, startupMs }
}

const type = async (tui: Tui, text: string): Promise<void> => {
  for (const character of text) {
    tui.child.stdin?.write(character)
    await sleep(40)
  }
  await sleep(400)
  tui.child.stdin?.write('\r')
}

const quit = async (tui: Tui): Promise<void> => {
  for (const key of ['\x03', '\x03', '\x04']) {
    tui.child.stdin?.write(key)
    await sleep(1000)
  }
}

// Every process under a shell this test launched: cat, script, and the agent script runs.
const descendants = (pid: number): number[] => {
  const children = new Map<number, number[]>()
  for (const line of execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).split('\n')) {
    const [child, parent] = line.trim().split(/\s+/).map(Number)
    if (child === undefined || parent === undefined || Number.isNaN(child)) continue
    children.set(parent, [...(children.get(parent) ?? []), child])
  }
  const found: number[] = []
  const queue = [pid]
  while (queue.length > 0) {
    // The loop runs only while the queue is not empty.
    const next = queue.shift() as number
    for (const child of children.get(next) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

// Forgets each process once killed, so a later pass cannot signal a reused pid.
const killStarted = (): void => {
  for (const child of started.splice(0)) {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) continue
    for (const pid of [...descendants(child.pid), child.pid]) if (alive(pid)) process.kill(pid, 'SIGKILL')
  }
}

const listedIds = (stdout: string): string[] => stdout.split('\n').filter(line => line !== '').map(line => line.split('  ')[0] ?? '')

// Items 1, 2, 4, 5, 6 and the run status, on one TUI that ends with a quit.
const lifecycle = async (agent: Agent): Promise<void> => {
  const root = makeRoot()
  // omp's typed prompt must run long enough to be seen working, so it keeps the key its default model uses.
  const tui = await startTui(agent, root, [], {}, agent === 'omp' ? OMP_MODEL_KEY : [])
  assert.ok(tui.startupMs < 5000, `hello first answered ${tui.startupMs} ms after launch`)
  assert.ok(Buffer.byteLength(tui.socket) < SUN_PATH_BYTES, `socket path ${tui.socket} is ${Buffer.byteLength(tui.socket)} bytes`)
  assert.deepEqual({ ...tui.hello, instance: '', pid: 0, sessionId: '' }, { v: 1, agent, instance: '', pid: 0, sessionId: '', name: null, cwd: root.work, status: 'idle', turnStartedAt: null, busy: false, pausedOnBackgroundWork: false, job: null })
  // spawn gave the shell a pid, or startTui would not have found its socket.
  assert.ok(descendants(tui.child.pid as number).includes(tui.pid), `hello pid ${tui.pid} is not a process this test started`)
  assert.equal(basename(tui.socket), `${agent}-${tui.hello.instance}-${tui.pid}.sock`)
  const listed = await cli(root, 'targets')
  assert.deepEqual(listed, { code: 0, stdout: `${agent}:${tui.hello.sessionId}  (unnamed)  ${root.work}\n`, stderr: '' })
  note(`${agent}: item 1, hello within 5 s and listed by targets`)

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const early = createConnection(tui.socket)
    early.on('error', () => {})
    if (attempt % 2 === 0) early.on('connect', () => { early.write('{"v":1,"op":"hello"}\n'); early.destroy() })
    else early.on('connect', () => early.destroy())
  }
  await sleep(1500)
  assert.equal(alive(tui.pid), true, `${agent} exited after clients hung up before the reply`)
  assert.equal((await helloOf(tui.socket)).sessionId, tui.hello.sessionId)
  note(`${agent}: item 2, 20 clients that hung up early left the agent running and answering`)

  for (const [request, error] of [
    ['{"v":1,"op":"stop"}\n', 'unknown op "stop"'],
    ['{"v":1,"op":"hello","job":"x"}\n', 'unexpected field "job"'],
    ['{"v":1,"op":"send","job":"x","session":"s","text":"do this"}\n', 'unexpected field "text"'],
    ['{"v":1,"op":"send","job":1,"session":"s"}\n', 'job 1 is not a string'],
    ['{"v":2,"op":"hello"}\n', 'unsupported version 2, expected 1'],
    ['[1]\n', 'request is not a JSON object: [1]'],
    [`${'x'.repeat(256 * 1024 + 1)}`, 'request is over 262144 bytes'],
  ] as const) {
    assert.deepEqual(await exchange(tui.socket, request), { reply: `${JSON.stringify({ v: 1, error })}\n`, closed: true }, `reply to ${request.slice(0, 40)}`)
  }
  const idleClosedAfter = await silentConnection(tui.socket)
  assert.ok(idleClosedAfter >= 1800 && idleClosedAfter < 4000, `a silent connection closed after ${idleClosedAfter} ms`)
  const held = await Promise.all(Array.from({ length: 8 }, () => openConnection(tui.socket)))
  const ninth = await exchange(tui.socket, '{"v":1,"op":"hello"}\n')
  assert.deepEqual(ninth, { reply: '', closed: true }, 'a ninth connection is closed unanswered')
  for (const socket of held) socket.destroy()
  await sleep(300)
  assert.equal(alive(tui.pid), true)
  assert.equal((await helloOf(tui.socket)).sessionId, tui.hello.sessionId)
  note(`${agent}: bad requests get error replies, a silent connection closes after ${idleClosedAfter} ms, a ninth connection is refused, and the agent still answers`)

  await type(tui, '/ce-block')
  await until('the probe command to block the event loop', 5000, () => readFileSync(root.probeFile, 'utf8').includes('"unblocked"') ? true : rawHello(tui.socket, 300).then(reply => 'failed' in reply ? true : undefined))
  const blocked = await cli(root, 'targets')
  const unblockedAlready = readFileSync(root.probeFile, 'utf8').includes('"unblocked"')
  assert.equal(unblockedAlready, false, 'the event loop unblocked before targets ran')
  assert.deepEqual(blocked, { code: 0, stdout: `${tui.socket.split('/').at(-1)}  (unreadable: not responding)\n`, stderr: '' })
  assert.equal(existsSync(tui.socket), true)
  await until('the event loop to unblock', 10_000, () => readFileSync(root.probeFile, 'utf8').includes('"unblocked"') ? true : undefined)
  assert.equal((await cli(root, 'targets')).stdout, `${agent}:${tui.hello.sessionId}  (unnamed)  ${root.work}\n`)
  note(`${agent}: item 4, a blocked event loop is listed as not responding, kept, and listed again once it unblocks`)

  await type(tui, '/new')
  const renewed = await until('/new to start another session', 15_000, async () => {
    const name = sockets(root).find(file => file.startsWith(`${agent}-`))
    if (name === undefined) return undefined
    const reply = await rawHello(join(root.live, name), 1000)
    return 'failed' in reply || reply.sessionId === tui.hello.sessionId ? undefined : { reply, socket: join(root.live, name) }
  })
  const afterNew = await cli(root, 'targets')
  assert.deepEqual(listedIds(afterNew.stdout), [`${agent}:${renewed.reply.sessionId}`])
  note(`${agent}: item 5, after /new targets lists ${renewed.reply.sessionId} and not ${tui.hello.sessionId}; socket ${renewed.socket === tui.socket ? 'kept' : 'replaced'}`)
  tui.socket = renewed.socket
  tui.hello = renewed.reply

  if (agent === 'pi') {
    await type(tui, '/reload')
    const reloaded = await until('/reload to open a socket for the reloaded extension', 15_000, async () => {
      const name = sockets(root).find(file => join(root.live, file) !== tui.socket)
      if (name === undefined) return undefined
      const reply = await rawHello(join(root.live, name), 1000)
      return 'failed' in reply ? undefined : { reply, socket: join(root.live, name) }
    })
    assert.equal(existsSync(tui.socket), false, 'the socket of the extension instance /reload replaced is gone')
    assert.equal(reloaded.reply.sessionId, tui.hello.sessionId)
    assert.notEqual(reloaded.reply.instance, tui.hello.instance)
    assert.deepEqual(sockets(root), [reloaded.socket.split('/').at(-1)])
    note(`pi: item 6, after /reload instance ${reloaded.reply.instance} answers for the same session and ${tui.hello.instance}'s socket is gone`)
    tui.socket = reloaded.socket
    tui.hello = reloaded.reply
  }

  if (agent === 'pi') {
    // pi's default model may fail at once (this Mac's Anthropic sign-in is stale), so the run's end is what is checked.
    const runsBefore = readFileSync(root.probeFile, 'utf8').split('\n').filter(line => line.includes('"agent_start"')).length
    await type(tui, 'Reply with the single word ok and nothing else. Use no tools.')
    let sawWorking = false
    await until('pi to start a run', 30_000, async () => {
      if ((await helloOf(tui.socket)).status === 'working') sawWorking = true
      return readFileSync(root.probeFile, 'utf8').split('\n').filter(line => line.includes('"agent_start"')).length > runsBefore ? true : undefined
    })
    const idle = await until('pi to report idle after the run', 360_000, async () => {
      const reply = await helloOf(tui.socket)
      if (reply.status === 'working') sawWorking = true
      return reply.status === 'idle' ? reply : undefined
    })
    assert.equal(idle.turnStartedAt, null)
    note(`pi: status, a typed prompt started a run and hello reported idle once it ended (working ${sawWorking ? 'seen' : 'not seen'} in between)`)
  }

  if (agent === 'omp') {
    const typedAt = new Date().toISOString()
    await type(tui, 'Reply with the single word ok and nothing else. Use no tools.')
    const working = await until('omp to report a run in progress', 30_000, async () => {
      const reply = await helloOf(tui.socket)
      return reply.status === 'working' ? reply : undefined
    })
    assert.ok(working.turnStartedAt !== null && working.turnStartedAt >= typedAt && new Date(working.turnStartedAt).toISOString() === working.turnStartedAt, `turnStartedAt ${working.turnStartedAt} is not an ISO time after ${typedAt}`)
    const listedWorking = await cli(root, 'nearby', root.work)
    assert.deepEqual(JSON.parse(listedWorking.stdout).sessions.map((session: { status: string; turnStartedAt: string }) => [session.status, session.turnStartedAt]), [['working', working.turnStartedAt]])
    let ended = 'the run ended on its own'
    // A one-word reply took omp's default model 4 minutes and a dozen tool-using turns once, so the run gets 6.
    const idle = await until('omp to report idle after the run', 360_000, async () => {
      const reply = await helloOf(tui.socket)
      return reply.status === 'idle' ? reply : undefined
    }).catch(async () => {
      ended = 'Escape aborted the run after 6 minutes'
      tui.child.stdin?.write('\x1b')
      return until('omp to report idle after Escape', 20_000, async () => {
        const reply = await helloOf(tui.socket)
        return reply.status === 'idle' ? reply : undefined
      })
    })
    assert.equal(idle.turnStartedAt, null)
    note(`omp: status, working from ${working.turnStartedAt}, idle at ${new Date().toISOString()} (${ended})`)
  }

  await quit(tui)
  await until(`${agent} to exit after the quit keys`, 15_000, () => alive(tui.pid) ? undefined : true)
  assert.deepEqual(sockets(root), [])
  note(`${agent}: item 1, after the quit keys the agent exited and its socket is gone`)
}

// Item 19 with both agents in one folder, then item 3 on each.
const sharedAndKilled = async (): Promise<void> => {
  const root = makeRoot()
  const pi = await startTui('pi', root)
  const omp = await startTui('omp', root)
  // A process whose command line marks it as this Codex home's managed daemon but which holds no daemon socket.
  const daemonDir = join(root.codexHome, 'packages', 'app-server-daemon')
  mkdirSync(daemonDir, { recursive: true })
  const daemon = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', '--', '--managed-daemon'], { argv0: join(daemonDir, 'codex'), stdio: 'ignore' })
  started.push(daemon)
  await sleep(500)
  const near = await cli(root, 'nearby', root.work)
  assert.equal(near.code, 0, near.stderr)
  assert.deepEqual(JSON.parse(near.stdout), {
    sessions: [omp, pi].map(tui => ({ agent: tui.agent, id: `${tui.agent}:${tui.hello.sessionId}`, name: null, cwd: root.work, relativeCwd: '.', status: 'idle', turnStartedAt: null })),
    failed: [{ check: 'codex', reason: `expected one codex-daemon socket held by process ${daemon.pid}, found []` }],
  })
  daemon.kill('SIGKILL')
  note('item 19, nearby reports the failed Codex check and still lists the pi and omp sessions')

  for (const tui of [pi, omp]) {
    process.kill(tui.pid, 'SIGKILL')
    await until(`${tui.agent} to die`, 5000, () => alive(tui.pid) ? undefined : true)
    assert.equal(existsSync(tui.socket), true, 'SIGKILL leaves the socket file')
    const listed = await cli(root, 'targets')
    assert.equal(listed.code, 0, listed.stderr)
    assert.equal(listedIds(listed.stdout).includes(`${tui.agent}:${tui.hello.sessionId}`), false)
    assert.equal(existsSync(tui.socket), false, 'targets removed the stale socket')
    note(`${tui.agent}: item 3, after SIGKILL targets removed the stale socket and did not list the session`)
  }
}

// Item 7: the extension loads in print and rpc runs under a pty, and opens no socket there. A print run is checked
// from inside, when its run starts, because it may end and remove a socket before the test looks; an rpc run waits for input.
const headless = async (agent: Agent, args: string[], awaited: 'session_start' | 'agent_start'): Promise<void> => {
  const root = makeRoot()
  launch(agent, root, args)
  const marker = await until(`${agent} ${args.join(' ')} to reach ${awaited}`, 30_000, () => {
    if (!existsSync(root.probeFile)) return undefined
    const line = readFileSync(root.probeFile, 'utf8').split('\n').find(entry => entry.includes(`"${awaited}"`))
    // The probe extension wrote this line.
    return line === undefined ? undefined : JSON.parse(line) as { pid: number; mode: string; live?: string[] }
  })
  if (awaited === 'agent_start') {
    assert.deepEqual(marker.live, [], 'live/ while the print run is going')
    // Twice, a pi rpc run started right after a killed pi print run did not reach session_start within 30 s; the cause is unknown.
    await until(`the ${agent} print run to end`, 30_000, () => alive(marker.pid) ? undefined : true).catch(() => note(`${agent}: the print run was still going after 30 s and was killed`))
  } else {
    await sleep(2000)
    assert.equal(alive(marker.pid), true, 'the rpc run was still going when the sockets were checked')
    assert.deepEqual(sockets(root), [])
  }
  note(`${agent}: item 7, ${args.join(' ')} ran in mode ${marker.mode} and opened no socket`)
}

// What the probe extension recorded, oldest first.
type ProbeEvent = { event: string; pid: number; at: number; text?: string; source?: string; stopReason?: string }
const probeEvents = (root: Root): ProbeEvent[] => existsSync(root.probeFile)
  // The probe extension wrote each line.
  ? readFileSync(root.probeFile, 'utf8').split('\n').filter(line => line !== '').map(line => JSON.parse(line) as ProbeEvent)
  : []

type AgentJob = { state: string; owner: string; pid: number; sessionId: string; message: string; seq: number; dispatchedAt?: string; merged?: boolean; userIntervened?: boolean; status?: string; finalMessage?: string | null; error?: string | null; reason?: string }
const agentJobFile = (root: Root, job: string): string => join(root.state, 'claude-errands', 'agent-jobs', `${job}.json`)
const agentJob = (root: Root, job: string): AgentJob | undefined => existsSync(agentJobFile(root, job))
  // The extension under test wrote this record; the assertions on its fields check its shape.
  ? JSON.parse(readFileSync(agentJobFile(root, job), 'utf8')) as AgentJob
  : undefined
const cliJobFile = (root: Root, job: string): string => join(root.state, 'claude-errands', 'jobs', `${job}.json`)
const cliJob = (root: Root, job: string): { message: string; target: string; outcome: { kind: string } | null } =>
  // cli.ts wrote this record.
  JSON.parse(readFileSync(cliJobFile(root, job), 'utf8')) as { message: string; target: string; outcome: { kind: string } | null }

// A git repository below the session's folder with a brief for it; one job may hold each at a time.
const repoWithBrief = (root: Root, name: string, work = 'Reply with exactly one line, RESULT: done, and nothing else. Use no tools.'): string => {
  const repo = join(root.work, name)
  mkdirSync(repo, { recursive: true })
  execFileSync('git', ['-C', repo, 'init', '-q', '-b', 'main'])
  execFileSync('git', ['-C', repo, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '--allow-empty', '-m', 'initial'])
  const brief = join(root.dir, `${name}.md`)
  writeFileSync(brief, ['# Job: probe', '## Worktree', repo, 'Branch: main', '', '## Allowed paths', '- src/**', '', '## Test command', '`true`', '', '## Rules', '', '## Work', work, ''].join('\n'))
  return brief
}

const send = async (tui: Tui, brief: string): Promise<string> => {
  const sent = await cli(tui.root, 'send', brief, '--target', `${tui.agent}:${tui.hello.sessionId}`)
  assert.equal(sent.stderr, '', `send to ${tui.agent} failed`)
  assert.match(sent.stdout, /^errand-[0-9a-f-]{36}\n$/)
  return sent.stdout.trim()
}

// A job record as cli.ts writes one, for requests that name a job no send made.
const writeCliJob = (root: Root, job: string, fields: Record<string, unknown>): void => {
  mkdirSync(join(root.state, 'claude-errands', 'jobs'), { recursive: true })
  writeFileSync(cliJobFile(root, job), JSON.stringify({ id: job, transport: 'pi', outcome: null, message: `probe message for ${job}`, ...fields }), { mode: 0o600 })
}

const sendRequest = (path: string, job: unknown, session: unknown): Promise<{ reply: string; closed: boolean }> =>
  exchange(path, `${JSON.stringify({ v: 1, op: 'send', job, session })}\n`)

const jobId = (): string => `errand-${randomUUID()}`

const waitJob = (root: Root, job: string, minutes: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  cli(root, 'wait', job, '--interval', '1', '--timeout', minutes)

const stateOf = (root: Root, job: string, states: string[], ms: number): Promise<AgentJob> =>
  until(`job ${job} to reach ${states.join(' or ')}`, ms, () => {
    const record = agentJob(root, job)
    return record !== undefined && states.includes(record.state) ? record : undefined
  })

// Items 9, 16 and the send half of 5: each refusal names what was wrong, and none leaves an agent-jobs record.
const sendRefusals = async (agent: Agent): Promise<void> => {
  const root = makeRoot()
  const tui = await startTui(agent, root)
  const session = tui.hello.sessionId
  const target = `${agent}:${session}`
  const missing = jobId()
  const elsewhere = jobId()
  const settled = jobId()
  const noMessage = jobId()
  const valid = jobId()
  writeCliJob(root, elsewhere, { target: `${agent}:another-session` })
  writeCliJob(root, settled, { target, outcome: { kind: 'abandoned' } })
  writeCliJob(root, noMessage, { target, message: null })
  writeCliJob(root, valid, { target })
  const refusals: Array<[unknown, unknown, string]> = [
    ['errand-1', session, 'job "errand-1" is not a claude-errands job id'],
    [missing, session, `no job record ${missing} in ${join(root.state, 'claude-errands', 'jobs')}`],
    [elsewhere, session, `job ${elsewhere} is for "${agent}:another-session", and this session is ${target}`],
    [settled, session, `job ${settled} already has an outcome`],
    [noMessage, session, `job record ${noMessage} has no message`],
    [valid, 'another-session', `send names session "another-session", and this session is ${session}`],
  ]
  for (const [job, sessionField, error] of refusals) {
    assert.deepEqual(await sendRequest(tui.socket, job, sessionField), { reply: `${JSON.stringify({ v: 1, error })}\n`, closed: true }, `send of ${String(job)}`)
  }
  assert.equal(existsSync(join(root.state, 'claude-errands', 'agent-jobs')), false, 'no refused send created an agent-jobs record')
  note(`${agent}: items 9 and 16, a send is refused for a malformed id, a job no CLI recorded, another target, an outcome, no message, and another session; no agent-jobs record was made`)

  await type(tui, '/new')
  const renewed = await until('/new to start another session', 15_000, async () => {
    const name = sockets(root).find(file => file.startsWith(`${agent}-`))
    if (name === undefined) return undefined
    const reply = await rawHello(join(root.live, name), 1000)
    return 'failed' in reply || reply.sessionId === session ? undefined : { reply, socket: join(root.live, name) }
  })
  assert.deepEqual(await sendRequest(renewed.socket, valid, session), { reply: `${JSON.stringify({ v: 1, error: `job ${valid} is for "${target}", and this session is ${agent}:${renewed.reply.sessionId}` })}\n`, closed: true })
  const refused = await cli(root, 'send', repoWithBrief(root, 'after-new'), '--target', target)
  assert.deepEqual(refused, { code: 1, stdout: '', stderr: `claude-errands: session ${target} has closed, so nothing would run this brief; pick a live session with: targets\n` })
  note(`${agent}: item 5, after /new a send for the old session id is refused by the CLI and by the session`)
}

// A pi run fails at once here (this Mac's Anthropic sign-in is stale), so these runs cost no model time.
// Items 8, 10, 17 (failed with a provider error) and the duplicate half of 8, then item 11 (an input handler that
// consumes the brief, which wait reports as not appeared until it is abandoned) and 17 (unknown after SIGKILL).
const piQueue = async (): Promise<void> => {
  const root = makeRoot()
  const tui = await startTui('pi', root)
  const target = `pi:${tui.hello.sessionId}`

  const idle = await send(tui, repoWithBrief(root, 'idle'))
  const idleEnded = await stateOf(root, idle, ['ended'], 30_000)
  const idleMessages = probeEvents(root).filter(event => event.event === 'user_message' && event.text === cliJob(root, idle).message)
  assert.equal(idleMessages.length, 1, 'the brief reached the session once, as its exact text')
  assert.deepEqual({ status: idleEnded.status, merged: idleEnded.merged }, { status: 'failed', merged: false })
  assert.match(idleEnded.error ?? '', /invalid_grant|OAuth|refresh/i)
  const waited = await waitJob(root, idle, '1')
  assert.equal(waited.code, 0, waited.stderr)
  assert.match(waited.stdout, new RegExp(`^Job: ${idle}\\nOutcome: failed\\nError: `))
  note(`pi: item 17, a brief sent to an idle session joined its own run once and ended failed with the provider error: ${(idleEnded.error ?? '').slice(0, 80)}`)

  await type(tui, '/ce-hold 12000')
  await sleep(500)
  await type(tui, 'Reply with the single word ok. Use no tools.')
  await until('the person\'s run to be held', 10_000, () => probeEvents(root).some(event => event.event === 'held') ? true : undefined)
  const abandoned = await send(tui, repoWithBrief(root, 'abandoned'))
  const next = await send(tui, repoWithBrief(root, 'next'))
  assert.equal(agentJob(root, abandoned)?.state, 'queued')
  assert.equal(agentJob(root, next)?.state, 'queued')
  const duplicates = await Promise.all([sendRequest(tui.socket, next, tui.hello.sessionId), sendRequest(tui.socket, next, tui.hello.sessionId)])
  assert.deepEqual(duplicates.map(result => result.reply), [`{"v":1,"duplicate":true,"state":"queued"}\n`, `{"v":1,"duplicate":true,"state":"queued"}\n`])
  const fresh = jobId()
  writeCliJob(root, fresh, { target, message: 'never started' })
  const racing = await Promise.all([sendRequest(tui.socket, fresh, tui.hello.sessionId), sendRequest(tui.socket, fresh, tui.hello.sessionId)])
  assert.deepEqual(racing.map(result => result.reply).toSorted(), ['{"v":1,"accepted":true}\n', '{"v":1,"duplicate":true,"state":"queued"}\n'])
  assert.equal((await waitJob(root, next, '0.0001')).stdout, `Job: ${next}\nstill running\n`)
  const abandon = await cli(root, 'abandon', abandoned)
  assert.equal(abandon.code, 0, abandon.stderr)
  // The test's own job record for the racing job is settled too, so it never starts.
  writeCliJob(root, fresh, { target, message: 'never started', outcome: { kind: 'abandoned' } })
  note('pi: item 8, two sends during the person\'s held run stayed queued; concurrent sends of one job were accepted once')

  const nextEnded = await stateOf(root, next, ['ended'], 40_000)
  assert.equal(agentJob(root, abandoned)?.state, 'dropped')
  assert.equal(agentJob(root, abandoned)?.reason, 'abandoned')
  assert.equal(agentJob(root, fresh)?.state, 'dropped')
  const messages = probeEvents(root).filter(event => event.event === 'user_message').map(event => event.text)
  assert.equal(messages.includes(cliJob(root, abandoned).message), false, 'the abandoned job never started')
  assert.equal(messages.includes('never started'), false)
  assert.equal(messages.filter(text => text === cliJob(root, next).message).length, 1, 'the next job started once')
  assert.equal(nextEnded.status, 'failed')
  note('pi: items 8 and 10, the held run ended, the abandoned job was dropped, and the job behind it ran once')

  await type(tui, '/ce-consume')
  await sleep(500)
  const consumed = await send(tui, repoWithBrief(root, 'consumed'))
  await stateOf(root, consumed, ['dispatching'], 10_000)
  await until('the probe to consume the brief', 10_000, () => probeEvents(root).some(event => event.event === 'consumed') ? true : undefined)
  const stalled = await waitJob(root, consumed, '1')
  assert.deepEqual(stalled, { code: 4, stdout: `Job ${consumed} was handed to the session at ${agentJob(root, consumed)?.dispatchedAt} and has not appeared in it yet.\n`, stderr: `claude-errands: job ${consumed}: the brief has not appeared in session ${target} for 5 polls in a row, and that session reports nothing going; look at that pi pane. The job is still open: run wait ${consumed} again, or abandon ${consumed} if it will never run\n` })
  assert.equal(cliJob(root, consumed).outcome, null)
  assert.equal(agentJob(root, consumed)?.state, 'dispatching', 'nothing failed the brief that never appeared')
  const abandonConsumed = await cli(root, 'abandon', consumed)
  assert.equal(abandonConsumed.code, 0, abandonConsumed.stderr)
  note('pi: item 11, a brief an input handler consumed stayed dispatching, wait stopped with exit 4 and left it open, and abandon released it')

  await type(tui, '/ce-hold 20000')
  await sleep(500)
  const killed = await send(tui, repoWithBrief(root, 'killed'))
  const released = await stateOf(root, consumed, ['dropped'], 5000)
  assert.equal(released.reason, 'abandoned', 'the next send released the abandoned brief')
  await until('the brief\'s run to be held', 10_000, () => probeEvents(root).filter(event => event.event === 'held').length >= 2 ? true : undefined)
  assert.equal(agentJob(root, killed)?.state, 'dispatching')
  process.kill(tui.pid, 'SIGKILL')
  await until('pi to die', 5000, () => alive(tui.pid) ? undefined : true)
  const unknown = await waitJob(root, killed, '1')
  assert.equal(unknown.code, 0, unknown.stderr)
  assert.match(unknown.stdout, new RegExp(`^Job: ${killed}\\nOutcome: failed\\nError: the pi session exited while the job ran; whether it finished is unknown\\n`))
  note('pi: item 17, a SIGKILL while the brief\'s run started left its outcome unknown')
}

// Item 11: pi with no credentials refuses the prompt before any run and tells only its own error handler, so the brief
// never appears. The agent folder is empty and every credential variable is left out, so pi finds no provider and makes
// no model call. Nothing fails the job: wait stops with exit 4 and leaves it open, and once it is abandoned the next
// brief sent to the session is dispatched in its place.
const piNoCredentials = async (): Promise<void> => {
  const root = makeRoot()
  const agentDir = join(root.dir, 'pi-agent')
  mkdirSync(agentDir)
  const tui = await startTui('pi', root, [], { PI_CODING_AGENT_DIR: agentDir })
  const target = `pi:${tui.hello.sessionId}`
  const job = await send(tui, repoWithBrief(root, 'no-credentials'))
  await stateOf(root, job, ['dispatching'], 10_000)
  await until('pi to see the brief', 10_000, () => probeEvents(root).some(event => event.event === 'input' && event.text === cliJob(root, job).message) ? true : undefined)
  const stalled = await waitJob(root, job, '1')
  assert.deepEqual(stalled, { code: 4, stdout: `Job ${job} was handed to the session at ${agentJob(root, job)?.dispatchedAt} and has not appeared in it yet.\n`, stderr: `claude-errands: job ${job}: the brief has not appeared in session ${target} for 5 polls in a row, and that session reports nothing going; look at that pi pane. The job is still open: run wait ${job} again, or abandon ${job} if it will never run\n` })
  assert.equal(probeEvents(root).some(event => event.event === 'agent_start'), false, 'no run started')
  assert.equal(agentJob(root, job)?.state, 'dispatching')
  assert.equal(cliJob(root, job).outcome, null)
  note('pi: item 11, with no credentials no run started, the job stayed dispatching, and wait stopped with exit 4 leaving it open')
  const abandoned = await cli(root, 'abandon', job)
  assert.equal(abandoned.code, 0, abandoned.stderr)
  const next = await send(tui, repoWithBrief(root, 'after-abandon'))
  assert.equal((await stateOf(root, job, ['dropped'], 5000)).reason, 'abandoned')
  await stateOf(root, next, ['dispatching'], 10_000)
  note('pi: item 11, after abandon the next brief released the stuck one and was dispatched in its place')
}

// Item 12 in pi: a run starts after the session went idle and before pi took the brief. The probe starts it from the
// brief's input event, which pi awaits before it takes the brief, and holds it 5 s. The brief goes as a follow-up, so pi
// queues it into that run instead of dropping it, and it arrives there after the probe's message: the job is merged.
// omp's side of the race, the brief steered into the person's run, is covered by test/extension.test.ts: omp emits no
// event an extension could start the run from.
const piRace = async (): Promise<void> => {
  const root = makeRoot()
  const tui = await startTui('pi', root)
  await type(tui, '/ce-race-brief Reply with the single word yes. Use no tools.')
  await sleep(500)
  const job = await send(tui, repoWithBrief(root, 'raced'))
  const ended = await stateOf(root, job, ['ended'], 60_000).finally(() => {
    log.push(`pi race events:\n${probeEvents(root).map(event => JSON.stringify({ ...event, text: event.text?.slice(0, 60) })).join('\n')}\nrecord: ${JSON.stringify(agentJob(root, job))}`)
  })
  const users = probeEvents(root).filter(event => event.event === 'user_message').map(event => event.text)
  assert.deepEqual(users, ['Reply with the single word yes. Use no tools.', cliJob(root, job).message], 'the brief joined the probe\'s run after its message')
  assert.equal(probeEvents(root).filter(event => event.event === 'run_end').length, 1, 'one run held both messages')
  assert.equal(ended.merged, true)
  const waited = await waitJob(root, job, '1')
  assert.match(waited.stdout, new RegExp(`^Job: ${job}\\nOutcome: failed\\nError: the brief joined a run the person started; its final answer may not be the agent's answer to the brief\\n`))
  note('pi: item 12, a run that started just before pi took the brief got the brief as a follow-up in that run, and the job ended merged')
}

// A pi session with a stored session file, which another TUI can open with --session.
const storedPiSession = async (root: Root, env: Record<string, string> = {}): Promise<Tui> => {
  const tui = await startTui('pi', root, [], env)
  await type(tui, 'Reply with the single word ok. Use no tools.')
  await until('the first run to end', 30_000, () => probeEvents(root).some(event => event.event === 'run_end' && event.pid === tui.pid) ? true : undefined)
  return tui
}

// Two jobs queued behind a held run of tui, which is then killed: their owner is gone and they stay queued.
const orphanTwoJobs = async (root: Root, tui: Tui): Promise<[string, string]> => {
  await type(tui, '/ce-hold 20000')
  await sleep(500)
  await type(tui, 'Reply with the single word ok. Use no tools.')
  await until('the person\'s run to be held', 10_000, () => probeEvents(root).some(event => event.event === 'held' && event.pid === tui.pid) ? true : undefined)
  const jobs: [string, string] = [await send(tui, repoWithBrief(root, 'first')), await send(tui, repoWithBrief(root, 'second'))]
  process.kill(tui.pid, 'SIGKILL')
  await until('pi to die', 5000, () => alive(tui.pid) ? undefined : true)
  for (const job of jobs) assert.equal(agentJob(root, job)?.state, 'queued')
  return jobs
}

// Items 6 and 14. pi refuses /reload while a run is going ("Wait for the current response to finish before reloading."),
// and an idle session starts a queued job at once, so a reload does not meet a queued job; a restart does. A pi TUI
// killed with two jobs queued, then opened again on its session, adopts both and runs them in order, each once.
const piAdoption = async (): Promise<void> => {
  const root = makeRoot()
  const first = await storedPiSession(root)
  const jobs = await orphanTwoJobs(root, first)
  const reopened = await startTui('pi', root, ['--session', first.hello.sessionId])
  const ended = await Promise.all(jobs.map(job => stateOf(root, job, ['ended'], 60_000)))
  assert.deepEqual(ended.map(record => record.owner), [reopened.hello.instance, reopened.hello.instance])
  const users = probeEvents(root).filter(event => event.event === 'user_message' && event.pid === reopened.pid).map(event => event.text)
  assert.deepEqual(users, jobs.map(job => cliJob(root, job).message), 'the adopted jobs ran in order, each once, with their exact messages')
  assert.deepEqual(readdirSync(join(root.state, 'claude-errands', 'agent-jobs')).filter(name => !name.endsWith('.json')), [])
  note(`pi: items 6 and 14, a TUI reopened on a killed session's id adopted its two queued jobs and ran them in order with their exact messages`)
}

// Item 13: two pi TUIs on one session. A send is refused as ambiguous, and when both open at once on a session whose
// owner died with a job queued, exactly one adopts and runs it.
const piTwins = async (): Promise<void> => {
  const root = makeRoot()
  const first = await storedPiSession(root)
  const second = await startTui('pi', root, ['--session', first.hello.sessionId])
  const target = `pi:${first.hello.sessionId}`
  const refused = await cli(root, 'send', repoWithBrief(root, 'twins'), '--target', target)
  assert.deepEqual(refused, { code: 1, stdout: '', stderr: `claude-errands: session ${target} is open in 2 TUIs, so which one would run the job is ambiguous; close all but one\n` })
  const job = jobId()
  writeCliJob(root, job, { target })
  assert.deepEqual(await sendRequest(first.socket, job, first.hello.sessionId), { reply: `${JSON.stringify({ v: 1, error: `session ${first.hello.sessionId} is also open in pi instance ${second.hello.instance}, so which one would run the job is ambiguous` })}\n`, closed: true })
  note('pi: item 13, a session open in two TUIs is refused as ambiguous by the CLI and by the session')

  process.kill(second.pid, 'SIGKILL')
  await until('the second pi to die', 5000, () => alive(second.pid) ? undefined : true)
  const jobs = await orphanTwoJobs(root, first)
  const [a, b] = await Promise.all([startTui('pi', root, ['--session', first.hello.sessionId]), startTui('pi', root, ['--session', first.hello.sessionId])])
  const ended = await Promise.all(jobs.map(id => stateOf(root, id, ['ended'], 60_000)))
  for (const [index, record] of ended.entries()) assert.ok([a.hello.instance, b.hello.instance].includes(record.owner), `job ${index} owner ${record.owner}`)
  for (const id of jobs) {
    const runs = probeEvents(root).filter(event => event.event === 'user_message' && event.text === cliJob(root, id).message).length
    assert.equal(runs, 1, `job ${id} ran once`)
  }
  note(`pi: item 13, two TUIs opened at once on the session adopted its two orphaned jobs, each exactly once (owners ${ended.map(record => record.owner).join(', ')})`)
}

// Items 17 and 18 in omp, plus the person typing during a job: an approval-gated tool, then Escape; then a brief
// that completes. --config adds a scratch overlay that makes every tool ask, and leaves the person's omp config alone.
const ompOutcomes = async (): Promise<void> => {
  const root = makeRoot()
  const overlay = join(root.dir, 'omp-overlay.yml')
  writeFileSync(overlay, 'tools:\n  approvalMode: always-ask\n')
  // The brief must get an answer from omp's default model.
  const tui = await startTui('omp', root, [`--config=${overlay}`], {}, OMP_MODEL_KEY)
  const gated = await send(tui, repoWithBrief(root, 'gated', 'Run the shell command `true` with your shell tool, then reply with exactly one line, RESULT: done.'))
  await stateOf(root, gated, ['running', 'ended'], 30_000)
  note('omp: a brief sent to an idle session joined a run of its own (no input event; the user message is the admission)')
  await type(tui, 'Also, keep it short.')
  const approval = await until('omp to ask for an approval', 400_000, async () => {
    const hello = await helloOf(tui.socket)
    return hello.status === 'needsApproval' ? hello : agentJob(root, gated)?.state === 'ended' ? hello : undefined
  })
  assert.equal(approval.status, 'needsApproval', `omp ended the job without asking: ${JSON.stringify(agentJob(root, gated))}`)
  assert.equal(approval.job, gated)
  const stopped = await waitJob(root, gated, '5')
  assert.deepEqual(stopped, { code: 3, stdout: `Job ${gated} is waiting on an approval in the agent's pane.\n`, stderr: `claude-errands: job ${gated} has waited on an approval in session omp:${tui.hello.sessionId} for 5 polls in a row; the person must answer it in that omp pane. The job is still open, so running wait ${gated} again after that is safe\n` })
  note('omp: item 18, an approval-gated tool set needsApproval with the job, and wait stopped with exit 3 naming the omp pane')
  // The first Escape may only close the approval prompt; Escape again until the run stops.
  const interrupted = await until('Escape to end the job', 60_000, async () => {
    const record = agentJob(root, gated)
    if (record?.state === 'ended') return record
    tui.child.stdin?.write('\x1b')
    await sleep(3000)
    return undefined
  })
  assert.deepEqual({ status: interrupted.status, error: interrupted.error, userIntervened: interrupted.userIntervened }, { status: 'failed', error: 'interrupted', userIntervened: true })
  const waited = await waitJob(root, gated, '1')
  assert.match(waited.stdout, new RegExp(`^Job: ${gated}\\nOutcome: failed\\nError: interrupted\\nPerson typed into the session during the run: yes\\n`))
  note('omp: item 17, Escape during the job ended it failed, interrupted, with the person\'s typing reported')

  const done = await send(tui, repoWithBrief(root, 'done'))
  const ended = await stateOf(root, done, ['ended'], 400_000)
  note(`omp: the second brief ended ${JSON.stringify({ status: ended.status, merged: ended.merged, error: ended.error, finalMessage: ended.finalMessage })}`)
  if (ended.status !== 'completed') throw new Error(`the brief did not complete: ${JSON.stringify(ended)}`)
  const result = await waitJob(root, done, '1')
  assert.match(result.stdout, new RegExp(`^Job: ${done}\\nOutcome: done\\n`))
  note('omp: item 17, a brief ended completed with RESULT: done')
}

// A brief whose own run takes 20 s to start, held in before_agent_start, stays dispatching, and wait does not stop for
// it: pi counts the session busy from the start of the run, before agent_start, and hello says so.
const piSlowStart = async (): Promise<void> => {
  const root = makeRoot()
  const tui = await startTui('pi', root)
  await type(tui, '/ce-hold 20000')
  await sleep(500)
  const job = await send(tui, repoWithBrief(root, 'slow'))
  await until('the brief\'s run to be held', 10_000, () => probeEvents(root).some(event => event.event === 'held') ? true : undefined)
  assert.equal((await helloOf(tui.socket)).busy, true)
  assert.deepEqual(await waitJob(root, job, '0.15'), { code: 0, stdout: `Job: ${job}\nstill running\n`, stderr: '' }, 'wait kept going for 9 s while the run was held')
  assert.equal(agentJob(root, job)?.state, 'dispatching', 'still waiting while the run is held')
  const ended = await stateOf(root, job, ['ended'], 30_000)
  assert.equal(probeEvents(root).filter(event => event.event === 'user_message' && event.text === cliJob(root, job).message).length, 1)
  assert.equal(ended.merged, false)
  assert.match(ended.error ?? '', /invalid_grant|OAuth|refresh/i)
  note('pi: a brief whose run was held 20 s before it started stayed dispatching, wait did not stop while pi reported itself busy, and it ran in its own run and ended with the provider error')
}

// Item 8 in omp: a brief sent while the person's run goes stays queued, and starts in a run of its own, in the
// end-of-run event, once that run ends (here by Escape).
const ompQueue = async (): Promise<void> => {
  const root = makeRoot()
  // The run must last until Escape, so omp keeps the key its default model uses.
  const tui = await startTui('omp', root, [], {}, OMP_MODEL_KEY)
  await type(tui, 'Reply with the single word ok. Use no tools.')
  await until('omp to report a run in progress', 30_000, async () => (await helloOf(tui.socket)).status === 'working' ? true : undefined)
  const job = await send(tui, repoWithBrief(root, 'queued'))
  assert.equal(agentJob(root, job)?.state, 'queued')
  await sleep(2000)
  assert.equal(agentJob(root, job)?.state, 'queued', 'the brief waits while the person\'s run goes')
  tui.child.stdin?.write('\x1b')
  const started = await stateOf(root, job, ['running', 'ended'], 60_000)
  assert.deepEqual({ state: started.state, merged: started.merged }, { state: 'running', merged: false })
  const users = probeEvents(root).filter(event => event.event === 'user_message').map(event => event.text)
  assert.deepEqual(users, ['Reply with the single word ok. Use no tools.', cliJob(root, job).message])
  const ended = await until('Escape to end the job', 60_000, async () => {
    const record = agentJob(root, job)
    if (record?.state === 'ended') return record
    tui.child.stdin?.write('\x1b')
    await sleep(3000)
    return undefined
  })
  assert.deepEqual({ status: ended.status, error: ended.error }, { status: 'failed', error: 'interrupted' })
  note('omp: item 8, a brief sent during the person\'s run stayed queued and, when Escape ended that run, started in a run of its own')
}

// A brief sent to an idle omp session joins a run of its own: the brief's message is the run's first user message.
// Escape then ends it, interrupted.
const ompAdmission = async (): Promise<void> => {
  const root = makeRoot()
  // The run must last until Escape, so omp keeps the key its default model uses.
  const tui = await startTui('omp', root, [], {}, OMP_MODEL_KEY)
  const job = await send(tui, repoWithBrief(root, 'admitted'))
  const running = await stateOf(root, job, ['running', 'ended'], 30_000).catch((error: unknown) => {
    log.push(`omp admission events:\n${probeEvents(root).map(event => JSON.stringify({ ...event, text: event.text?.slice(0, 60) })).join('\n')}\nrecord: ${JSON.stringify(agentJob(root, job))}`)
    throw error
  })
  assert.deepEqual({ state: running.state, merged: running.merged }, { state: 'running', merged: false })
  const events = probeEvents(root)
  assert.equal(events.some(event => event.event === 'input' && event.source === 'extension'), false, 'omp emitted no input event for the brief')
  assert.deepEqual(events.filter(event => event.event === 'user_message').map(event => event.text), [cliJob(root, job).message])
  const ended = await until('Escape to end the job', 60_000, async () => {
    const record = agentJob(root, job)
    if (record?.state === 'ended') return record
    tui.child.stdin?.write('\x1b')
    await sleep(3000)
    return undefined
  })
  assert.deepEqual({ status: ended.status, error: ended.error }, { status: 'failed', error: 'interrupted' })
  note('omp: a brief sent to an idle session joined a run of its own with no input event, and Escape ended it failed, interrupted')
}

const scenarios: Array<[string, () => Promise<void>]> = [
  ['pi lifecycle', () => lifecycle('pi')],
  ['pi send refusals', () => sendRefusals('pi')],
  ['omp send refusals', () => sendRefusals('omp')],
  ['pi queue', piQueue],
  ['pi no credentials', piNoCredentials],
  ['pi race', piRace],
  ['pi adoption', piAdoption],
  ['pi twins', piTwins],
  ['pi slow start', piSlowStart],
  ['omp admission', ompAdmission],
  ['omp queue', ompQueue],
  ['omp outcomes', ompOutcomes],
  ['omp lifecycle', () => lifecycle('omp')],
  ['shared folder and SIGKILL', sharedAndKilled],
  ['pi print', () => headless('pi', ['-p', 'Reply with ok.'], 'agent_start')],
  ['pi rpc', () => headless('pi', ['--mode', 'rpc'], 'session_start')],
  ['omp print', () => headless('omp', ['-p', 'Reply with ok.'], 'agent_start')],
  ['omp rpc', () => headless('omp', ['--mode', 'rpc'], 'session_start')],
]

// Scenario names given as arguments run only those, for example: node test/agents.e2e.ts 'pi lifecycle'
const chosen = process.argv.slice(2)
const unknown = chosen.filter(name => !scenarios.some(([known]) => known === name))
if (unknown.length > 0) throw new Error(`unknown scenarios ${JSON.stringify(unknown)}; known: ${JSON.stringify(scenarios.map(([name]) => name))}`)

let failures = 0
try {
  for (const [name, scenario] of scenarios.filter(([name]) => chosen.length === 0 || chosen.includes(name))) {
    try {
      await scenario()
      note(`PASS: ${name}`)
    } catch (error) {
      failures += 1
      note(`FAIL: ${name}: ${error instanceof Error ? error.stack : String(error)}`)
      for (const [label, screen] of screens) log.push(`screen of ${label}:\n${screen().slice(-1500)}`)
    } finally {
      killStarted()
      screens.clear()
    }
  }
} finally {
  killStarted()
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
  const results = join(import.meta.dirname, 'results')
  mkdirSync(results, { recursive: true })
  const file = join(results, `${new Date().toISOString().replaceAll(':', '')}-agents-e2e.log`)
  writeFileSync(file, `${log.join('\n\n')}\n`)
  console.log(`${failures === 0 ? 'PASS' : `FAIL (${failures})`}: ${file}`)
  process.exit(failures === 0 ? 0 : 1)
}
