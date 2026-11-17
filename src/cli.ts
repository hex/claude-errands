// ABOUTME: claude-errands's command line. send queues a validated brief to a live agent session and prints a job id;
// ABOUTME: wait reports how that job's turn ended; targets and nearby list sessions; abandon releases a worktree; setup-pi installs the pi/omp extension.
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { agentsTransport, listAgentSessions, type StrayFile } from './agents.ts'
import { parseBrief } from './brief.ts'
import { codexTransport } from './codex.ts'
import { NoDaemonError } from './daemon.ts'
import { claimWorktree, firstStep, loadJob, openJobFor, rememberTarget, rememberedTarget, recordedWorkspace, resolveWorkspace, saveJob, settleJob, stateDir, threadRefusal, worktreeHolds, type Job, type Outcome } from './job.ts'
import { captureOutcome } from './outcome.ts'
import { SendRefusedError, TargetClosedError, type Target, type Transport } from './transport.ts'

// A target is pi:<session id>, omp:<session id>, or a bare Codex thread id.
const agentOf = (target: string): Job['transport'] => target.startsWith('pi:') ? 'pi' : target.startsWith('omp:') ? 'omp' : 'codex'
const transportFor = (agent: Job['transport']): Transport => agent === 'codex' ? codexTransport : agentsTransport
// Where the person answers an approval.
const PANE: Record<Job['transport'], string> = { codex: 'Codex', pi: 'pi', omp: 'omp' }
const SESSION_NOUN: Record<Job['transport'], string> = { codex: 'thread', pi: 'session', omp: 'session' }
const LOST_POLLS_BEFORE_FAILING = 3
// Codex starts the turn that resumes an interrupted one within a second of ending it (0.02 to 0.97 s in six rollouts).
const INTERRUPTED_MS_BEFORE_FAILING = 5000
// About two minutes at the default 30-second interval: time for a person at the pane to answer before Claude tells them.
const APPROVAL_POLLS_BEFORE_STOPPING = 5
const WAITING_ON_APPROVAL_EXIT = 3
// The same span for a pi or omp brief that was handed over and has not appeared while its session reports nothing going.
const NOT_ADMITTED_POLLS_BEFORE_STOPPING = 5
const NOT_ADMITTED_EXIT = 4

// Ends the command with its own exit code, so a caller can tell this stop from a failure, which exits 1.
class StopError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode: number) {
    super(message)
    this.exitCode = exitCode
  }
}

const messageFor = (job: Omit<Job, 'message'>): string => {
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
  ? `${target.id}  ${target.name ?? '(unnamed)'}  ${target.cwd}${target.preview === null ? '' : `  ${target.preview.split('\n', 1)[0]?.slice(0, 60) ?? ''}`}`
  : `${target.id}  (unreadable: ${target.reason})`

type FailedCheck = { check: 'codex' | 'pi/omp'; reason: string }
type Listing = { targets: Target[]; strays: StrayFile[]; failed: FailedCheck[] }

const oneLine = (error: unknown): string => (error instanceof Error ? error.message : String(error)).split('\n', 1)[0] ?? ''

// Every session of every agent. A check that fails is reported, so its sessions read as unknown, not absent.
const listEverything = async (): Promise<Listing> => {
  const [codex, agents] = await Promise.allSettled([codexTransport.targets(), listAgentSessions()])
  const failed: FailedCheck[] = []
  const targets: Target[] = []
  let strays: StrayFile[] = []
  if (codex.status === 'fulfilled') targets.push(...codex.value)
  else if (!(codex.reason instanceof NoDaemonError)) failed.push({ check: 'codex', reason: oneLine(codex.reason) })
  if (agents.status === 'fulfilled') {
    targets.push(...agents.value.targets)
    strays = agents.value.strays
  } else failed.push({ check: 'pi/omp', reason: oneLine(agents.reason) })
  return { targets, strays, failed }
}

const chooseTarget = async (given: string | undefined): Promise<string> => {
  if (given !== undefined) return given
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID
  const remembered = sessionId === undefined ? undefined : rememberedTarget(sessionId)
  if (remembered !== undefined) return remembered
  const listing = (await listEverything()).targets.map(target => `  ${label(target)}`).join('\n')
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
  const agent = agentOf(target)
  const transport = transportFor(agent)
  const refusal = threadRefusal(workspace, target, await transport.liveCwd(target))
  if (refusal !== null) throw new Error(refusal)
  const id = `errand-${randomUUID()}`
  mkdirSync(join(stateDir(), 'jobs'), { recursive: true })
  const briefCopy = join(stateDir(), 'jobs', `${id}.brief.md`)
  writeFileSync(briefCopy, text)
  const fields: Omit<Job, 'message'> = {
    id, transport: agent, target, briefPath: original, briefCopy, ...recordedWorkspace(workspace), allowedPaths: brief.allowedPaths,
    sessionId: process.env.CLAUDE_CODE_SESSION_ID ?? null, sentAt: new Date().toISOString(), delivery: 'sending', outcome: null,
  }
  const job: Job = { ...fields, message: messageFor(fields) }
  saveJob(job)
  // The record exists before the claim, so a lock whose job has no record is a crashed send, not a live one.
  const holder = claimWorktree(worktree, id)
  if (holder !== undefined) {
    settleJob(id, { kind: 'abandoned', finalMessage: null, error: `worktree held by ${holder}`, changes: null, capturedAt: new Date().toISOString() }, 'refused')
    throw new Error(`worktree ${worktree} is held by job ${holder}, which has no outcome yet; wait for it or run: abandon ${holder}`)
  }
  try {
    await transport.send(target, id, job.message)
  } catch (sendError) {
    if (sendError instanceof TargetClosedError || sendError instanceof SendRefusedError) {
      settleJob(id, { kind: 'abandoned', finalMessage: null, error: sendError.message, changes: null, capturedAt: new Date().toISOString() }, 'refused')
      throw sendError
    }
    // A failed send does not prove the daemon rejected the job; ask it once whether the job is there.
    const state = await transport.poll(target, id).catch(() => ({ kind: 'lost' as const }))
    if (state.kind === 'lost' || state.kind === 'closed') {
      saveJob({ ...loadJob(id), delivery: 'unknown' })
      throw new Error(`delivery of job ${id} is unknown and it was not sent again; check it with: wait ${id}`, { cause: sendError })
    }
  }
  // Only here: a target refused above must not become the next send's default.
  if (job.sessionId !== null) rememberTarget(job.sessionId, target)
  saveJob({ ...loadJob(id), delivery: 'sent' })
  console.log(id)
}

const listed = (heading: string, lines: string[]): string => `${heading}:\n${lines.length === 0 ? '  none' : lines.map(line => `  ${line}`).join('\n')}`

const render = (job: Job, outcome: Outcome): string => [
  `Job: ${job.id}`,
  `Outcome: ${outcome.kind}`,
  ...(outcome.error === null ? [] : [`Error: ${outcome.error}`]),
  ...(outcome.userIntervened === true ? ['Person typed into the session during the run: yes'] : []),
  ...(outcome.resumedAfterRestart === true ? ['Resumed after a Codex server restart: yes'] : []),
  outcome.finalMessage === null ? 'Final answer: none (the turn had no final answer)' : `Final answer:\n${outcome.finalMessage}`,
  ...(outcome.changes === null ? [] : [
    listed('Commits', outcome.changes.commits),
    listed('Outside allow-list', outcome.changes.outsideAllowList),
    ...(outcome.changes.broughtIn === undefined ? [] : [listed(`Brought in from ${outcome.changes.broughtIn.from} at ${outcome.changes.broughtIn.commit}, not counted against the allow-list`, outcome.changes.broughtIn.paths)]),
    listed('Modified before this job', outcome.changes.modifiedBefore),
    `Uncommitted changes: ${outcome.changes.uncommitted ? 'yes' : 'no'}`,
  ]),
].join('\n')

const wait = async (id: string, intervalSeconds: number, timeoutMinutes: number): Promise<void> => {
  const job = loadJob(id)
  if (job.outcome !== null) return console.log(render(job, job.outcome))
  const transport = transportFor(job.transport)
  const deadline = Date.now() + timeoutMinutes * 60_000
  let lostPolls = 0
  let interruptedSince: number | null = null
  let approvalPolls = 0
  let approvalAnnounced = false
  let notAdmittedPolls = 0
  let notAdmittedAnnounced = false
  let backgroundJobAnnounced = false
  const settle = (outcome: Outcome): void => {
    // Another waiter, or abandon, may have settled the job meanwhile; the stored outcome wins.
    const stored = settleJob(id, outcome, 'sent') ? outcome : loadJob(id).outcome
    if (stored === null) throw new Error(`job ${id} has no outcome after settling`)
    console.log(render(job, stored))
  }
  for (;;) {
    const state = await transport.poll(job.target, id)
    if (state.kind === 'ended') return settle(captureOutcome(job, state))
    // The job never ran, so there are no changes to report and no worktree it was to create.
    if (state.kind === 'dropped') return settle({ kind: 'failed', finalMessage: null, error: state.reason, changes: null, capturedAt: new Date().toISOString() })
    if (state.kind === 'closed') throw new Error(`job ${id} has not started and ${state.reason}`)
    interruptedSince = state.kind === 'interrupted' ? interruptedSince ?? Date.now() : null
    if (state.kind === 'interrupted' && interruptedSince !== null && Date.now() - interruptedSince >= INTERRUPTED_MS_BEFORE_FAILING) return settle(captureOutcome(job, state.ended))
    lostPolls = state.kind === 'lost' ? lostPolls + 1 : 0
    if (lostPolls >= LOST_POLLS_BEFORE_FAILING) throw new Error(`job ${id} is in neither the queue nor the turns of ${job.target} on ${LOST_POLLS_BEFORE_FAILING} polls in a row`)
    approvalPolls = state.kind === 'waitingOnApproval' ? approvalPolls + 1 : 0
    if (state.kind === 'waitingOnApproval' && !approvalAnnounced) {
      approvalAnnounced = true
      console.log(`Job ${id} is waiting on an approval in the agent's pane.`)
    }
    if (approvalPolls >= APPROVAL_POLLS_BEFORE_STOPPING) {
      throw new StopError(`job ${id} has waited on an approval in ${SESSION_NOUN[job.transport]} ${job.target} for ${APPROVAL_POLLS_BEFORE_STOPPING} polls in a row; the person must answer it in that ${PANE[job.transport]} pane. The job is still open, so running wait ${id} again after that is safe`, WAITING_ON_APPROVAL_EXIT)
    }
    notAdmittedPolls = state.kind === 'notAdmitted' ? notAdmittedPolls + 1 : 0
    if (state.kind === 'notAdmitted' && !notAdmittedAnnounced) {
      notAdmittedAnnounced = true
      console.log(`Job ${id} was handed to the session at ${state.dispatchedAt} and has not appeared in it yet.`)
    }
    if (notAdmittedPolls >= NOT_ADMITTED_POLLS_BEFORE_STOPPING) {
      throw new StopError(`job ${id}: the brief has not appeared in ${SESSION_NOUN[job.transport]} ${job.target} for ${NOT_ADMITTED_POLLS_BEFORE_STOPPING} polls in a row, and that session reports nothing going; look at that ${PANE[job.transport]} pane. The job is still open: run wait ${id} again, or abandon ${id} if it will never run`, NOT_ADMITTED_EXIT)
    }
    if (state.kind === 'queuedBehindBackgroundJob' && !backgroundJobAnnounced) {
      backgroundJobAnnounced = true
      console.log(`Job ${id} is queued behind a background job in ${SESSION_NOUN[job.transport]} ${job.target}; it starts when that job's result ends the run, or, if the job is killed, after the next run in that pane.`)
    }
    if (Date.now() > deadline) return console.log(`Job: ${id}\nstill running`)
    await new Promise(resolvePause => setTimeout(resolvePause, intervalSeconds * 1000))
  }
}

const abandon = async (id: string): Promise<void> => {
  const job = loadJob(id)
  if (!settleJob(id, { kind: 'abandoned', finalMessage: null, error: null, changes: null, capturedAt: new Date().toISOString() }, 'unknown')) {
    throw new Error(`job ${id} already has outcome ${loadJob(id).outcome?.kind ?? 'none'}`)
  }
  await transportFor(job.transport).abandon(job.target, id)
  console.log(`Job ${id} abandoned; worktree ${job.worktree} is free. The agent was not stopped.`)
}

const positiveNumber = (name: string, text: string): number => {
  const value = Number(text)
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} must be a positive number, got ${JSON.stringify(text)}`)
  return value
}

// Lists readable sessions working in dir or below it as JSON, with the checks that failed, or signals their presence with a quiet exit code.
const nearby = async (dir: string, quiet: boolean): Promise<void> => {
  const root = realpathSync(dir)
  const { targets, failed } = await listEverything()
  const sessions = targets.flatMap(target => target.readable && worktreeHolds(root, target.cwd)
    ? [{ agent: target.agent, id: target.id, name: target.name, cwd: target.cwd, relativeCwd: relative(root, realpathSync(target.cwd)) || '.', status: target.status, turnStartedAt: target.turnStartedAt }]
    : [])
  sessions.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  if (quiet) process.exitCode = sessions.length > 0 ? 0 : failed.length > 0 ? 1 : 2
  else console.log(JSON.stringify({ sessions, failed }))
}

const targets = async (): Promise<void> => {
  const listing = await listEverything()
  for (const target of listing.targets) console.log(label(target))
  for (const stray of listing.strays) console.log(`${stray.path}  (unreadable: ${stray.reason})`)
  if (listing.failed.length === 0) return
  for (const { check, reason } of listing.failed) console.error(`claude-errands: the ${check} check failed: ${reason}`)
  process.exitCode = 1
}

// What setup-pi did for one agent; a refusal leaves the path alone and fails the command.
type Installed = { kind: 'linked' | 'unchanged' | 'skipped' | 'refused'; message: string }

const EXTENSION_SUFFIX = '/pi/claude-errands.ts'

const installFor = (agent: 'pi' | 'omp', extension: string): Installed => {
  const agentDir = join(homedir(), `.${agent}`, 'agent')
  const agentStat = statSync(agentDir, { throwIfNoEntry: false })
  if (agentStat === undefined) return { kind: 'skipped', message: `${agent}: skipped, ${agentDir} does not exist` }
  if (!agentStat.isDirectory()) return { kind: 'refused', message: `${agent}: ${agentDir} is not a directory` }
  mkdirSync(join(agentDir, 'extensions'), { recursive: true })
  const link = join(agentDir, 'extensions', 'claude-errands.ts')
  const existing = lstatSync(link, { throwIfNoEntry: false })
  if (existing === undefined) {
    symlinkSync(extension, link)
    return { kind: 'linked', message: `${agent}: linked ${link} to ${extension}` }
  }
  if (!existing.isSymbolicLink()) {
    return { kind: 'refused', message: `${agent}: ${link} is a ${existing.isDirectory() ? 'directory' : 'file'} that setup-pi did not create; move it away and run setup-pi again` }
  }
  const current = readlinkSync(link)
  if (current === extension) return { kind: 'unchanged', message: `${agent}: ${link} already links to ${extension}` }
  // A link to another copy of this plugin's extension is setup-pi's own, from an install at another path.
  if (!current.endsWith(EXTENSION_SUFFIX)) {
    return { kind: 'refused', message: `${agent}: ${link} is a symlink to ${current} that setup-pi did not create; move it away and run setup-pi again` }
  }
  rmSync(link)
  symlinkSync(extension, link)
  return { kind: 'linked', message: `${agent}: replaced ${link}, which linked to ${current}, with a link to ${extension}` }
}

// Links this plugin's extension into each installed agent's extension folder.
const setupPi = (): void => {
  const extension = resolve(import.meta.dirname, '..', 'pi', 'claude-errands.ts')
  const results = (['pi', 'omp'] as const).map(agent => installFor(agent, extension))
  for (const result of results) {
    if (result.kind === 'refused') console.error(`claude-errands: ${result.message}`)
    else console.log(result.message)
  }
  if (results.some(result => result.kind === 'linked')) console.log('Run /reload in each open pi session and restart each open omp session to load the extension.')
  if (results.some(result => result.kind === 'refused')) process.exitCode = 1
}

const USAGE = 'usage: cli.ts send <brief> [--target <id>] | wait <jobId> [--interval <seconds>] [--timeout <minutes>] | targets | nearby <dir> [--quiet] | abandon <jobId> | setup-pi'

const main = async (): Promise<void> => {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { target: { type: 'string' }, interval: { type: 'string', default: '30' }, timeout: { type: 'string', default: '110' }, quiet: { type: 'boolean' } },
  })
  const [command, argument, ...extra] = positionals
  if (extra.length > 0 || (values.quiet !== undefined && command !== 'nearby')) throw new Error(USAGE)
  if (command === 'targets' && argument === undefined) return targets()
  if (command === 'setup-pi' && argument === undefined) return setupPi()
  if (argument === undefined) throw new Error(USAGE)
  if (command === 'send') return send(argument, values.target)
  if (command === 'wait') return wait(argument, positiveNumber('interval', values.interval), positiveNumber('timeout', values.timeout))
  if (command === 'abandon') return abandon(argument)
  if (command === 'nearby') return nearby(argument, values.quiet === true)
  throw new Error(USAGE)
}

main().catch((error: unknown) => {
  const cause = error instanceof Error && error.cause instanceof Error ? `\ncaused by: ${error.cause.message}` : ''
  console.error(`claude-errands: ${error instanceof Error ? error.message : String(error)}${cause}`)
  process.exit(error instanceof StopError ? error.exitCode : 1)
})
