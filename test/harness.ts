// ABOUTME: Starts real Codex in a tmux session against a disposable Codex home and a scratch git repository, or a git folder
// ABOUTME: holding one, so end-to-end tests never touch the live daemon. stop() ends every process under the home, then deletes it.
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { Daemon, discoverDaemon } from '../src/daemon.ts'

// The codex on PATH, as an absolute path: tmux starts it with the tmux server's PATH, not this process's.
const CODEX = execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8' }).trim()

export type Isolated = {
  root: string; home: string; repo: string; state: string; session: string; threadId: string
  // Where Codex runs: the repository, or the git folder that holds it.
  codexDir: string
  env: NodeJS.ProcessEnv; screen(): string; stop(): Promise<void>
}

const sh = (file: string, args: string[], options: { cwd?: string } = {}): string =>
  execFileSync(file, args, { encoding: 'utf8', ...options })

export const until = async <T>(label: string, seconds: number, probe: () => T | undefined | Promise<T | undefined>): Promise<T> => {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const value = await probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${seconds} s waiting for ${label}`)
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
}

// Every process whose executable lives under the isolated home: the managed daemon and the helpers it starts.
const ownedProcesses = (home: string): Array<{ pid: number; command: string }> =>
  sh('/bin/ps', ['-axo', 'pid=,command=']).split('\n').flatMap(line => {
    const match = /^(\d+) (.*)$/.exec(line.trim())
    if (match === null) return []
    const [, pid, command] = match
    return pid !== undefined && command !== undefined && command.startsWith(`${home}/`) ? [{ pid: Number(pid), command }] : []
  })
const ownedPids = (home: string): number[] => ownedProcesses(home).map(owned => owned.pid)
const ownedDaemonPids = (home: string): number[] =>
  ownedProcesses(home).filter(owned => owned.command.includes(' --managed-daemon')).map(owned => owned.pid)

// With parentFolder, Codex runs with no extra writable directory in a git folder of that name, which holds the
// repository and ignores it and a worktrees/ directory.
export const startIsolated = async (options: { approval: 'never' | 'on-request'; parentFolder?: string }): Promise<Isolated> => {
  const version = sh(CODEX, ['--version']).trim()
  if (version !== 'codex-cli 0.163.0') throw new Error(`${CODEX} is ${version}, expected codex-cli 0.163.0`)
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-e2e-')))
  chmodSync(root, 0o700)
  const folder = options.parentFolder === undefined ? undefined : join(root, options.parentFolder)
  const home = join(root, 'home'), repo = join(folder ?? root, 'repo'), state = join(root, 'state')
  if (folder !== undefined) {
    mkdirSync(folder)
    sh('git', ['init', '-q', '-b', 'main'], { cwd: folder })
    writeFileSync(join(folder, '.gitignore'), '/repo/\n/worktrees/\n')
    sh('git', ['add', '-A'], { cwd: folder })
    sh('git', ['-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '-m', 'initial'], { cwd: folder })
  }
  for (const dir of [home, repo, state]) mkdirSync(dir)
  copyFileSync(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'))
  chmodSync(join(home, 'auth.json'), 0o600)
  sh('git', ['init', '-q', '-b', 'main'], { cwd: repo })
  writeFileSync(join(repo, 'README.md'), 'scratch\n')
  sh('git', ['add', '-A'], { cwd: repo })
  sh('git', ['-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '-m', 'initial'], { cwd: repo })
  sh('git', ['config', 'user.name', 'alice'], { cwd: repo })
  sh('git', ['config', 'user.email', 'alice@example.com'], { cwd: repo })

  const session = `claude-errands-e2e-${process.pid}`
  const codexDir = folder ?? repo
  // Trusted up front: the trust prompt sometimes swallows the Enter that answers it, and the session never loads.
  writeFileSync(join(home, 'config.toml'), `[projects.${JSON.stringify(codexDir)}]\ntrust_level = "trusted"\n`)
  sh('tmux', ['new-session', '-d', '-s', session, '-x', '200', '-y', '50',
    'env', `CODEX_HOME=${home}`, CODEX, '--no-alt-screen', '-s', 'workspace-write', '-a', options.approval,
    // The workspace sandbox keeps the .git of the folder Codex runs in read-only; jobs that commit there need it writable.
    ...(folder === undefined ? ['--add-dir', join(repo, '.git')] : []), '-C', codexDir])
  const screen = (): string => sh('tmux', ['capture-pane', '-p', '-J', '-t', session])
  const keys = (...args: string[]): void => { sh('tmux', ['send-keys', '-t', session, ...args]) }
  const stop = async (): Promise<void> => {
    // The session may already be gone; its absence is the state stop() wants.
    spawnSync('tmux', ['kill-session', '-t', session], { stdio: 'ignore' })
    // The daemon and its helpers outlive the TUI and keep writing into the home, so they must be gone before it is deleted.
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const pid of ownedPids(home)) {
        try {
          process.kill(pid, signal)
        } catch (error) {
          // The process exited between the listing and the signal.
          if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error
        }
      }
      for (let tenths = 0; tenths < 50 && ownedPids(home).length > 0; tenths++) await new Promise(resolve => setTimeout(resolve, 100))
      if (ownedPids(home).length === 0) break
    }
    const survivors = ownedPids(home)
    if (survivors.length > 0) throw new Error(`processes under ${home} survived SIGKILL: ${JSON.stringify(survivors)}; the home was not deleted`)
    rmSync(root, { recursive: true, force: true })
    // startIsolated pointed this process at the isolated home, which no longer exists.
    if (process.env.CODEX_HOME === home) delete process.env.CODEX_HOME
  }

  try {
    process.env.CODEX_HOME = home
    // The folder-trust prompt can replace the composer seconds after it first shows, so it is answered whenever it is
    // on screen. Before its first message the session's thread is the only one loaded; Codex loads a second,
    // short-lived one during the first turn.
    const threadId = await until('the session thread to load', 120, async () => {
      if (screen().includes('Trust this folder?')) { keys('Enter'); return undefined }
      if (ownedDaemonPids(home).length === 0) return undefined
      const socket = await discoverDaemon().then(found => found.socket, (error: unknown) => {
        // A daemon that has started but not yet opened its socket.
        if (error instanceof Error && error.message.includes('expected one codex-daemon socket')) return undefined
        throw error
      })
      if (socket === undefined) return undefined
      const loaded = await new Daemon(socket).loadedThreads()
      if (loaded.length > 1) throw new Error(`isolated daemon has more than one loaded thread before any message: ${JSON.stringify(loaded)}`)
      return loaded[0]
    })
    await until('composer', 60, () => {
      const text = screen()
      return text.includes('Ask Codex to do anything') && !text.includes('Trust this folder?') ? true : undefined
    })
    // The daemon cannot read a thread's turns until its first message is stored, so a first turn runs here.
    keys('-l', 'Reply with exactly READY and nothing else.')
    keys('Enter')
    await until('first turn end', 180, async () => {
      const turns = await new Daemon((await discoverDaemon()).socket).readThread(threadId).then(thread => thread.turns, (error: unknown) => {
        if (error instanceof Error && /list_turns is not supported yet|is empty/.test(error.message)) return []
        throw error
      })
      const last = turns.at(-1)
      return last !== undefined && last.status !== 'inProgress' ? true : undefined
    })
    const env = { ...process.env, CODEX_HOME: home, XDG_STATE_HOME: state, CLAUDE_CODE_SESSION_ID: 'test-session' }
    return { root, home, repo, state, session, threadId, codexDir, env, screen, stop }
  } catch (error) {
    // The session may have died, which is itself the failure; then there is no screen to show.
    const last = spawnSync('tmux', ['capture-pane', '-p', '-J', '-t', session], { encoding: 'utf8' })
    console.error(`harness failed; last screen:\n${last.status === 0 ? last.stdout : `(no tmux session: ${last.stderr.trim()})`}`)
    await stop()
    throw error
  }
}
