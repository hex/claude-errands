// ABOUTME: claude-errands's command line. send queues a validated brief to a live agent session and prints a job id;
// ABOUTME: wait reports how that job's turn ended; targets and nearby list sessions; abandon releases a worktree.
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { parseBrief } from './brief.ts'
import { codexTransport } from './codex.ts'
import { NoDaemonError } from './daemon.ts'
import { claimWorktree, firstStep, loadJob, openJobFor, rememberTarget, rememberedTarget, recordedWorkspace, resolveWorkspace, saveJob, settleJob, stateDir, threadRefusal, worktreeHolds, type Job, type Outcome } from './job.ts'
import { captureOutcome } from './outcome.ts'
import type { Target, Transport } from './transport.ts'

const transport: Transport = codexTransport
const LOST_POLLS_BEFORE_FAILING = 3

const messageFor = (job: Job): string => {
  const step = firstStep(job)
  return [
    ...(step === null ? [] : [step]),
    `Read ${job.briefCopy} in full and do exactly what it says. This is job ${job.id}.`,
    // A thread in the folder above the worktree starts in the wrong repository.
    `Work only in ${job.worktree}; run every command and git command there.`,
    'End your final message with exactly one of these lines, alone on the last line:',
    'RESULT: done',
    'RESULT: question',
    'RESULT: declined',
    'Use "question" if you need an answer before you can finish, and "declined" if you chose not to do some or all of the work; in both cases say why above the line.',
  ].join('\n')
}

const label = (target: Target): string => target.readable
  ? `${target.id}  ${target.name ?? '(unnamed)'}  ${target.cwd}  ${target.preview.split('\n', 1)[0]?.slice(0, 60) ?? ''}`
  : `${target.id}  (unreadable: ${target.reason})`

const chooseTarget = async (given: string | undefined): Promise<string> => {
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  if (given !== undefined) {
    if (sessionId !== undefined) rememberTarget(sessionId, given)
    return given
  }
  const remembered = sessionId === undefined ? undefined : rememberedTarget(sessionId)
  if (remembered !== undefined) return remembered
  const listing = (await transport.targets()).map(target => `  ${label(target)}`).join('\n')
  throw new Error(sessionId === undefined
    ? `--target is required: CLAUDE_CODE_SESSION_ID is not set, so no target can be remembered. Loaded threads:\n${listing}`
    : `--target is required: no target is remembered for this Claude session. Loaded threads:\n${listing}`)
}

const send = async (briefPath: string, givenTarget: string | undefined): Promise<void> => {
  const original = resolve(briefPath)
  // Read once: the copy the agent reads is these exact validated bytes.
  const text = readFileSync(original, 'utf8')
  const brief = parseBrief(text)
  const workspace = resolveWorkspace(brief.workspace)
  const { worktree } = workspace
  const open = openJobFor(worktree)
  if (open !== undefined) throw new Error(`worktree ${worktree} is held by job ${open.id}, which has no outcome yet; wait for it or run: abandon ${open.id}`)
  const target = await chooseTarget(givenTarget)
  const refusal = threadRefusal(workspace, target, await transport.cwd(target))
  if (refusal !== null) throw new Error(refusal)
  const id = `errand-${randomUUID()}`
  mkdirSync(join(stateDir(), 'jobs'), { recursive: true })
  const briefCopy = join(stateDir(), 'jobs', `${id}.brief.md`)
  writeFileSync(briefCopy, text)
  const job: Job = {
    id, transport: 'codex', target, briefPath: original, briefCopy, ...recordedWorkspace(workspace), allowedPaths: brief.allowedPaths,
    sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, sentAt: new Date().toISOString(), delivery: 'sending', outcome: null,
  }
  saveJob(job)
  // The record exists before the claim, so a lock whose job has no record is a crashed send, not a live one.
  const holder = claimWorktree(worktree, id)
  if (holder !== undefined) {
    settleJob(id, { kind: 'abandoned', finalMessage: null, error: `worktree held by ${holder}`, changes: null, capturedAt: new Date().toISOString() })
    throw new Error(`worktree ${worktree} is held by job ${holder}, which has no outcome yet; wait for it or run: abandon ${holder}`)
  }
  try {
    await transport.send(target, id, messageFor(job))
  } catch (sendError) {
    // A failed send does not prove the daemon rejected the job; ask it once whether the job is there.
    const state = await transport.poll(target, id).catch(() => ({ kind: 'lost' as const }))
    if (state.kind === 'lost') {
      saveJob({ ...loadJob(id), delivery: 'unknown' })
      throw new Error(`delivery of job ${id} is unknown and it was not sent again; check it with: wait ${id}`, { cause: sendError })
    }
  }
  saveJob({ ...loadJob(id), delivery: 'sent' })
  console.log(id)
}

const listed = (heading: string, lines: string[]): string => `${heading}:\n${lines.length === 0 ? '  none' : lines.map(line => `  ${line}`).join('\n')}`

const render = (job: Job, outcome: Outcome): string => [
  `Job: ${job.id}`,
  `Outcome: ${outcome.kind}`,
  ...(outcome.error === null ? [] : [`Error: ${outcome.error}`]),
  outcome.finalMessage === null ? 'Final answer: none (the turn had no final answer)' : `Final answer:\n${outcome.finalMessage}`,
  ...(outcome.changes === null ? [] : [
    listed('Commits', outcome.changes.commits),
    listed('Outside allow-list', outcome.changes.outsideAllowList),
    listed('Modified before this job', outcome.changes.modifiedBefore),
    `Uncommitted changes: ${outcome.changes.uncommitted ? 'yes' : 'no'}`,
  ]),
].join('\n')

const wait = async (id: string, intervalSeconds: number, timeoutMinutes: number): Promise<void> => {
  const job = loadJob(id)
  if (job.outcome !== null) return console.log(render(job, job.outcome))
  const deadline = Date.now() + timeoutMinutes * 60_000
  let lostPolls = 0
  let approvalAnnounced = false
  for (;;) {
    const state = await transport.poll(job.target, id)
    if (state.kind === 'ended') {
      const outcome = captureOutcome(job, state)
      // Another waiter, or abandon, may have settled the job meanwhile; the stored outcome wins.
      const stored = settleJob(id, outcome) ? outcome : loadJob(id).outcome
      if (stored === null) throw new Error(`job ${id} has no outcome after settling`)
      return console.log(render(job, stored))
    }
    lostPolls = state.kind === 'lost' ? lostPolls + 1 : 0
    if (lostPolls >= LOST_POLLS_BEFORE_FAILING) throw new Error(`job ${id} is in neither the queue nor the turns of ${job.target} on ${LOST_POLLS_BEFORE_FAILING} polls in a row`)
    if (state.kind === 'waitingOnApproval' && !approvalAnnounced) {
      approvalAnnounced = true
      console.log(`Job ${id} is waiting on an approval in the agent's pane.`)
    }
    if (Date.now() > deadline) return console.log(`Job: ${id}\nstill running`)
    await new Promise(resolvePause => setTimeout(resolvePause, intervalSeconds * 1000))
  }
}

const abandon = (id: string): void => {
  const job = loadJob(id)
  if (!settleJob(id, { kind: 'abandoned', finalMessage: null, error: null, changes: null, capturedAt: new Date().toISOString() })) {
    throw new Error(`job ${id} already has outcome ${loadJob(id).outcome?.kind ?? 'none'}`)
  }
  console.log(`Job ${id} abandoned; worktree ${job.worktree} is free. The agent was not stopped.`)
}

const positiveNumber = (name: string, text: string): number => {
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number, got ${JSON.stringify(text)}`)
  return value
}

// Prints, as JSON, the readable sessions working in dir or below it; none when no Codex daemon runs.
const nearby = async (dir: string): Promise<void> => {
  const root = realpathSync(dir)
  const targets = await transport.targets().catch((error: unknown) => {
    if (error instanceof NoDaemonError) return []
    throw error
  })
  const inside = targets.flatMap(target => target.readable && worktreeHolds(root, target.cwd)
    ? [{ id: target.id, name: target.name, cwd: target.cwd, relativeCwd: relative(root, realpathSync(target.cwd)) || '.', status: target.status, turnStartedAt: target.turnStartedAt }]
    : [])
  console.log(JSON.stringify(inside))
}

const USAGE = 'usage: cli.ts send <brief> [--target <id>] | wait <jobId> [--interval <seconds>] [--timeout <minutes>] | targets | nearby <dir> | abandon <jobId>'

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { target: { type: 'string' }, interval: { type: 'string', default: '30' }, timeout: { type: 'string', default: '110' } },
  })
  const [command, argument, ...extra] = positionals
  if (extra.length > 0) throw new Error(USAGE)
  if (command === 'targets' && argument === undefined) {
    for (const target of await transport.targets()) console.log(label(target))
    return
  }
  if (argument === undefined) throw new Error(USAGE)
  if (command === 'send') return send(argument, values.target)
  if (command === 'wait') return wait(argument, positiveNumber('interval', values.interval), positiveNumber('timeout', values.timeout))
  if (command === 'abandon') return abandon(argument)
  if (command === 'nearby') return nearby(argument)
  throw new Error(USAGE)
}

main().catch((error: unknown) => {
  const cause = error instanceof Error && error.cause instanceof Error ? `\ncaused by: ${error.cause.message}` : ''
  console.error(`claude-errands: ${error instanceof Error ? error.message : String(error)}${cause}`)
  process.exit(1)
})
