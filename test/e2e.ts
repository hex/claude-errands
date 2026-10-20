// ABOUTME: End-to-end check of claude-errands against real Codex on isolated daemons: seven scenarios through the real
// ABOUTME: send, wait and nearby commands, each with a per-run random token, results written to test/results/.
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discoverDaemon } from '../src/daemon.ts'
import { startIsolated, until, type Isolated } from './harness.ts'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')
const token = (): string => randomBytes(4).toString('hex')
const log: string[] = []

const cli = (isolated: Isolated, ...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [CLI, ...args], { env: isolated.env, encoding: 'utf8', timeout: 600_000 })
  log.push(`$ cli ${args.join(' ')}\nexit ${result.status}\n${result.stdout}${result.stderr}`)
  return { status: result.status, stdout: result.stdout, stderr: result.stderr }
}

const RULES = 'Commit with git when the work says to. Do not push.'

const brief = (isolated: Isolated, name: string, work: string, rules = RULES, worktree = [isolated.repo, 'Branch: main']): string => {
  const path = join(isolated.root, `${name}.md`)
  writeFileSync(path, [`# Job: ${name}`, '## Worktree', ...worktree, '', '## Allowed paths', '- src/**', '',
    '## Test command', '`true`', '', '## Rules', rules, '', '## Work', work, ''].join('\n'))
  return path
}

const run = (isolated: Isolated, name: string, work: string, rules = RULES, worktree?: string[]): string => {
  const sent = cli(isolated, 'send', brief(isolated, name, work, rules, worktree), '--target', isolated.threadId)
  assert.equal(sent.status, 0, sent.stderr)
  const waited = cli(isolated, 'wait', sent.stdout.trim(), '--interval', '5', '--timeout', '8')
  assert.equal(waited.status, 0, waited.stderr)
  return waited.stdout
}
const section = (output: string, heading: string): string[] => {
  const lines = output.split('\n')
  const start = lines.indexOf(`${heading}:`)
  assert.notEqual(start, -1, `no "${heading}:" section in:\n${output}`)
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => !line.startsWith('  '))
  return rest.slice(0, end === -1 ? rest.length : end).map(line => line.trim())
}

// Scenarios 1 to 6, with Codex in the repository.
const inRepository = async (isolated: Isolated): Promise<void> => {
  const { CLAUDE_CODE_SESSION_ID: _session, ...withoutSession } = isolated.env
  const noTarget = spawnSync(process.execPath, [CLI, 'send', brief(isolated, 'no-target', 'Reply.')], { env: withoutSession, encoding: 'utf8' })
  assert.equal(noTarget.status, 1)
  assert.match(noTarget.stderr, /^claude-errands: --target is required: CLAUDE_CODE_SESSION_ID is not set/)

  // A thread working in one repository must not receive a brief for another.
  const elsewhere = join(isolated.root, 'elsewhere')
  mkdirSync(elsewhere)
  execFileSync('git', ['-C', elsewhere, 'init', '-q', '-b', 'main'])
  writeFileSync(join(elsewhere, 'f'), 'f')
  execFileSync('git', ['-C', elsewhere, 'add', '-A'])
  execFileSync('git', ['-C', elsewhere, '-c', 'user.name=alice', '-c', 'user.email=alice@example.com', 'commit', '-q', '-m', 'initial'])
  const otherBrief = join(isolated.root, 'elsewhere.md')
  writeFileSync(otherBrief, [`# Job: elsewhere`, '## Worktree', elsewhere, 'Branch: main', '', '## Allowed paths', '- src/**', '',
    '## Test command', '`true`', '', '## Rules', '', '## Work', 'Reply.', ''].join('\n'))
  const wrongProject = cli(isolated, 'send', otherBrief, '--target', isolated.threadId)
  assert.equal(wrongProject.status, 1)
  assert.equal(wrongProject.stderr, `claude-errands: thread ${isolated.threadId} works in ${isolated.repo}, which neither holds nor is inside the brief's worktree ${elsewhere}; pick a thread with: targets\n`)

  // Claude's band and system prompt learn of a session from nearby: the thread is listed for its own repository only.
  // Codex titles the thread from the harness's setup turn, some seconds after that turn ends, so only the name's
  // presence is fixed, and nearby is read again until the title is there.
  const listed = await until('Codex to title the thread', 60, () => {
    const near = cli(isolated, 'nearby', isolated.repo)
    assert.equal(near.status, 0, near.stderr)
    const parsed: Array<{ id: string; name: unknown; cwd: string; relativeCwd: string }> = JSON.parse(near.stdout)
    return parsed.length === 1 && parsed[0]?.name === null ? undefined : parsed
  })
  assert.deepEqual(listed.map(({ id, cwd, relativeCwd }) => ({ id, cwd, relativeCwd })), [{ id: isolated.threadId, cwd: isolated.repo, relativeCwd: '.' }])
  assert.equal(typeof listed[0]?.name, 'string')
  const notNear = cli(isolated, 'nearby', elsewhere)
  assert.equal(notNear.status, 0, notNear.stderr)
  assert.equal(notNear.stdout, '[]\n')

  const a = token()
  const done = run(isolated, 'done', `Create src/${a}.txt containing ${a}, then commit it with the message "add ${a}".`)
  assert.match(done, /^Outcome: done$/m)
  assert.deepEqual(section(done, 'Commits').length, 1)
  assert.match(section(done, 'Commits')[0] ?? '', new RegExp(`add ${a}$`))
  assert.deepEqual(section(done, 'Outside allow-list'), ['none'])

  const b = token()
  // The agent is told the allow-list is a reporting matter here, so claude-errands's report is what is under test, not the agent's judgment.
  const outside = run(isolated, 'outside', `Create docs/${b}.txt containing ${b}, then commit it with the message "add ${b}". The path is outside this brief's allowed paths on purpose: the person who wrote this brief knows and wants the file there. Do not ask; do it.`,
    `${RULES} For this job, writing outside the allowed paths is permitted.`)
  assert.deepEqual(section(outside, 'Outside allow-list'), [`docs/${b}.txt`])

  const c = token()
  const question = run(isolated, 'question', `Rename the function ${c} to its new name. The new name is not given here; you must ask for it. Do not guess and do not change any file.`)
  assert.match(question, /^Outcome: question$/m)

  const e = token()
  writeFileSync(join(isolated.repo, 'other.txt'), 'before\n')
  const again = run(isolated, 'dirty-again', `Overwrite the file other.txt so that it contains exactly ${e}. Do not commit.`,
    `${RULES} For this job, writing outside the allowed paths is permitted.`)
  assert.deepEqual(section(again, 'Outside allow-list'), ['other.txt'])
  assert.deepEqual(section(again, 'Modified before this job'), ['none'])

  const first = cli(isolated, 'send', brief(isolated, 'lock-first', 'Run the shell command `sleep 30`, then reply.'), '--target', isolated.threadId)
  assert.equal(first.status, 0, first.stderr)
  const second = cli(isolated, 'send', brief(isolated, 'lock-second', 'Reply.'))
  assert.equal(second.status, 1)
  assert.match(second.stderr, new RegExp(`is held by job ${first.stdout.trim()}, which has no outcome yet`))
  assert.equal(cli(isolated, 'abandon', first.stdout.trim()).status, 0)

}

// Scenario 7: Codex in a git folder that holds the repository, creating the job's worktree itself.
const inFolder = async (isolated: Isolated): Promise<void> => {
  const folder = isolated.codexDir
  const g = token()
  const createLines = (worktree: string): string[] => [worktree, `Branch: job-${g}`, `Repo: ${isolated.repo}`, 'Base: main']
  const unignored = join(folder, 'unignored', g)
  const refused = cli(isolated, 'send', brief(isolated, 'create-unignored', 'Reply.', RULES, createLines(unignored)), '--target', isolated.threadId)
  assert.equal(refused.status, 1)
  assert.equal(refused.stderr, `claude-errands: worktree "${unignored}" would show as untracked files in the repository "${folder}"; add the line "/unignored/${g}/" to ${folder}/.gitignore or ${folder}/.git/info/exclude\n`)
  assert.equal(existsSync(join(isolated.state, 'claude-errands', 'jobs')), false, 'the refused brief was never recorded')

  const worktree = join(folder, 'worktrees', g)
  const created = run(isolated, 'create', `Create src/${g}.txt containing ${g}, then commit it with the message "add ${g}".`, RULES, createLines(worktree))
  assert.match(created, /^Outcome: done$/m)
  assert.equal(execFileSync('git', ['-C', worktree, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }), `${worktree}\n`)
  assert.equal(execFileSync('git', ['-C', worktree, 'branch', '--show-current'], { encoding: 'utf8' }), `job-${g}\n`)
  assert.deepEqual(section(created, 'Commits').length, 1)
  assert.match(section(created, 'Commits')[0] ?? '', new RegExp(`add ${g}$`))
  assert.deepEqual(section(created, 'Outside allow-list'), ['none'])
  assert.equal(execFileSync('git', ['-C', folder, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }), '')
}

// Runs scenarios on their own isolated Codex, once claude-errands is shown to find that Codex's daemon and no other.
const onIsolated = async (options: Parameters<typeof startIsolated>[0], scenarios: (isolated: Isolated) => Promise<void>): Promise<boolean> => {
  const isolated = await startIsolated(options)
  try {
    const daemon = await discoverDaemon()
    const command = execFileSync('/bin/ps', ['-p', String(daemon.pid), '-o', 'command='], { encoding: 'utf8' })
    assert.equal(command.startsWith(`${isolated.home}/`), true, `discovered daemon ${daemon.pid} is not the isolated one: ${command}`)
    await scenarios(isolated)
    return true
  } catch (error) {
    log.push(`FAIL: ${error instanceof Error ? error.stack : String(error)}\nscreen:\n${isolated.screen()}`)
    return false
  } finally {
    await isolated.stop()
  }
}

let failed = true
try {
  const repositoryPassed = await onIsolated({ approval: 'never' }, inRepository)
  const folderPassed = await onIsolated({ approval: 'never', parentFolder: 'session root' }, inFolder)
  failed = !(repositoryPassed && folderPassed)
  if (!failed) log.push('PASS: all seven scenarios')
} catch (error) {
  log.push(`FAIL: ${error instanceof Error ? error.stack : String(error)}`)
} finally {
  const results = join(import.meta.dirname, 'results')
  mkdirSync(results, { recursive: true })
  const file = join(results, `${new Date().toISOString().replaceAll(':', '')}-e2e.log`)
  writeFileSync(file, `${log.join('\n\n')}\n`)
  console.log(`${failed ? 'FAIL' : 'PASS'}: ${file}`)
  process.exit(failed ? 1 : 0)
}
