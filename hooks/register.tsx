// ABOUTME: Polls `cli.ts nearby` for live Codex, pi and omp sessions working in or below this session's directory,
// ABOUTME: shows them at the right of the prompt footer, notifies when one waits for approval, and asks Claude to plan the split.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Agent, AgentSession, AgentsNearby, Check, CheckResult, LineSegment, NearbySession } from '../types'
import { AGENTS, drawLine } from './line'

const nearby = atom({ plugin: 'claude-errands', key: 'agentsNearby' } as const, { kind: 'unpolled' })
const told = atom({ plugin: 'claude-errands', key: 'agentsTold' } as const, null)

// The footer's order of agents, and the send target each lists its sessions under: pi and omp ids carry a prefix.
const AGENT_ORDER: readonly Agent[] = ['codex', 'pi', 'omp']
const TARGET_ID: Record<Agent, { prefix: string; pattern: RegExp }> = {
  codex: { prefix: '', pattern: /^[0-9A-Za-z-]+$/ },
  // Each host's own session id rule, as src/agents.ts checks it.
  pi: { prefix: 'pi:', pattern: /^pi:[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/ },
  omp: { prefix: 'omp:', pattern: /^omp:[A-Za-z0-9_-]{1,128}$/ },
}
// A failed check, 'all' when cli.ts nearby itself failed, which leaves every check's sessions unknown.
type Failure = { check: Check | 'all'; reason: string }
// What each failure is called: leading the footer's warning, within a sentence, and the sessions it leaves unknown.
const FAILURE_NAMES: Record<Failure['check'], { lead: string; name: string; sessions: string }> = {
  codex: { lead: 'Codex', name: 'Codex', sessions: 'Codex sessions' },
  'pi/omp': { lead: 'pi/omp', name: 'pi/omp', sessions: 'pi and omp sessions' },
  all: { lead: 'Agent', name: 'agent', sessions: 'sessions' },
}

const SEARCH_MS = 15_000
// A Codex session once found leaves the list only when Codex unloads its thread, minutes after it closes, so a faster check gains it nothing.
const FOUND_MS = 60_000
// While a session is busy the footer's status and elapsed time follow its turn closely.
const BUSY_MS = 5_000
const RUN_TIMEOUT_MS = 20_000
// Characters that end a line or draw nothing: controls (C0, DEL, C1), format characters, U+2028 and U+2029.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const LABEL_MAX = 40
const REASON_MAX = 200
// A failed check's text, `<check> check failed: ` and its reason, is at most one row of an 80-column terminal.
const FOOTER_FAILURE_MAX = 80

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    void watch($)

    return next(e)
  })

  // The agents line, each failed check and the button at the right end of the prompt footer, after the modes the engine draws there.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const state = await read($, nearby)
    const sessions = openSessions(state)
    const failures = failedChecks(state)
    if (sessions.length === 0 && failures.length === 0) return next(e)

    const footer = await next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const warnings = failures.map(({ check, reason }) => {
      const lead = `${FAILURE_NAMES[check].lead} check failed: `
      return <Text key={`failed-${check}`} color="warning">{`${lead}${displayable(reason, FOOTER_FAILURE_MAX - lead.length)}`}</Text>
    })
    if (sessions.length === 0) {
      return (
        <Box flexDirection="row" justifyContent="flex-end" gap={2}>
          {footer}
          {warnings}
        </Box>
      )
    }

    const button = handOffButton(sessions)
    const segments = lineSegments(sessions)
    const now = await $.clock.now()
    // The terminal and the desktop, the only surfaces that raise SessionMode, both draw a Client.
    const line = segments.some(segment => segment.kind === 'spinner' || segment.kind === 'elapsed')
      ? h('Client', { key: 'sessions', module: './sessions.tsx', props: { segments, now } })
      : drawLine(Text, segments, null, now)

    return (
      <Box flexDirection="row" justifyContent="flex-end" gap={2}>
        {footer}
        {line}
        {warnings}
        <Button key="hand-off" label={button.label} onPress={() => handOff($, button.name, sessions)}>
          <Text color={button.color}>{button.label}</Text>
        </Button>
      </Box>
    )
  })

  // The task skips whyNotSendable, as it reaches Claude as this command's prompt and never as the person's own, so a leading / or ! runs nothing.
  on('skill.prompt', { skill: 'claude-errands:work-with-codex' }, async ($, e) => ({ text: commandPrompt(await read($, nearby), e.text.trim()) }))

  // Claude learns of agent sessions beside a prompt, and only when they change: a system-prompt section
  // would change the cached prefix of the whole conversation each time a session opened or closed.
  on('prompt.submit', async ($, e, next) => {
    const change = await changeForClaude($)
    if (change === null) return next(e)
    const result = await next({ ...e, context: [...(e.context ?? []), change.note] })
    // A prompt that did not enter told Claude nothing, so the note goes with the next one.
    if (result.drop === undefined) await update($, told, () => change.told)
    return result
  })

  // After /clear or a compaction of the main conversation Claude no longer has the note, so it is given again.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') await update($, told, () => null)
    return next(e)
  })
  on('session.compact', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined && !('skip' in result && result.skip !== undefined)) await update($, told, () => null)
    return result
  })
}

async function watch($: EngineInterface) {
  const found = await poll($)
  $.clock.after(nextCheckMs(found), () => void watch($))
}

function nextCheckMs(found: AgentsNearby): number {
  const sessions = openSessions(found)
  if (sessions.some(session => session.status !== 'idle')) return BUSY_MS
  if (found.kind === 'checked' && sessions.length === 0 && failedChecks(found).length === 0) return SEARCH_MS
  return FOUND_MS
}

async function poll($: EngineInterface): Promise<AgentsNearby> {
  const found = await check($).catch((error: unknown): Found => ({ kind: 'failed', reason: withoutPrefix(message(error)) }))
  const now = await $.clock.now()
  const after = (previous: AgentsNearby): AgentsNearby =>
    found.kind === 'failed'
      ? found
      : {
          kind: 'checked',
          codex: tracked(found.codex, previous.kind === 'checked' ? previous.codex : null, now),
          piOmp: tracked(found.piOmp, previous.kind === 'checked' ? previous.piOmp : null, now),
        }
  // Compared with the value this write replaces, as update hands it to the change on every try.
  let waiting: Labelled[] = []
  const recorded = await update($, nearby, previous => {
    const next = after(previous)
    waiting = newlyWaiting(previous, next)
    return next
  }).catch((error: unknown) => {
    $.ui.log(`claude-errands: could not record the agent check: ${withoutPrefix(message(error))}`)
    return null
  })
  if (recorded === null) return after({ kind: 'unpolled' })
  for (const agent of AGENT_ORDER) {
    const own = waiting.filter(({ session }) => session.agent === agent)
    if (own.length > 0) await notifyWaiting($, agent, own)
  }
  return recorded
}

// The sessions of next that wait for approval and, in previous, were absent or had another status, with the
// footer's labels. A check that names no sessions (unpolled, failed) has every one of its sessions absent.
function newlyWaiting(previous: AgentsNearby, next: AgentsNearby): Labelled[] {
  const before = new Map(openSessions(previous).map(session => [session.id, session.status]))
  return groups(openSessions(next))
    .flatMap(({ sessions }) => labelled(sessions))
    .filter(({ session }) => session.status === 'needsApproval' && before.get(session.id) !== 'needsApproval')
}

// One notification for the sessions of one agent that started waiting in the same check.
async function notifyWaiting($: EngineInterface, agent: Agent, waiting: Labelled[]) {
  const title = `${AGENTS[agent].name} needs approval`
  const body = waiting.map(({ session, label }) => `${label} (${displayable(session.relativeCwd, LABEL_MAX)})`).join(', ')
  const sent = await $.ui.notify(body, { title }).catch((error: unknown) => {
    $.ui.log(`claude-errands: could not notify that ${title}: ${withoutPrefix(message(error))}`)
    return null
  })
  // With notifications off, no terminal to show them, or a notification that failed, the person still learns it in the app.
  if (sent === null || !sent.isSent) $.ui.toast(`claude-errands: ${title}: ${body}`)
}

// What one cli.ts nearby run found, before the mod tracks when each busy session's turn began.
type CheckFound<A extends Agent> = { kind: 'listed'; sessions: AgentSession<A>[] } | { kind: 'failed'; reason: string }
type Found = { kind: 'checked'; codex: CheckFound<'codex'>; piOmp: CheckFound<'pi' | 'omp'> } | { kind: 'failed'; reason: string }

async function check($: EngineInterface): Promise<Found> {
  // The project root, not the shell's directory: a `cd` into a subfolder must not hide sessions here.
  const root = await $.session.root()
  // From the plugin's folder, as the engine's default is wherever Claude's shell stands, a directory that may have been removed.
  const ran = await $.process.run(['node', `${$.plugin.root}/src/cli.ts`, 'nearby', root], { cwd: $.plugin.root, timeoutMs: RUN_TIMEOUT_MS })
  if (ran.exitCode !== 0) {
    const firstLine = ran.stderr.split('\n')[0]?.trim()
    return { kind: 'failed', reason: firstLine ? withoutPrefix(firstLine) : `cli.ts nearby exited ${ran.exitCode} with nothing on stderr` }
  }

  return parseNearby(ran.stdout)
}

// cli.ts nearby's `{ sessions, failed }`: each session goes to the check that lists its agent, and a check
// named in failed lists none, as its sessions are unknown.
function parseNearby(stdout: string): Found {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { kind: 'failed', reason: `cli.ts nearby printed something other than JSON: ${JSON.stringify(stdout.slice(0, 80))}` }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { kind: 'failed', reason: `cli.ts nearby printed JSON that is not an object: ${stdout.slice(0, 80)}` }
  const listedSessions = 'sessions' in parsed ? parsed.sessions : undefined
  const listedFailed = 'failed' in parsed ? parsed.failed : undefined
  if (!Array.isArray(listedSessions)) return { kind: 'failed', reason: `cli.ts nearby printed sessions ${JSON.stringify(listedSessions)?.slice(0, 80)}, not an array` }
  if (!Array.isArray(listedFailed)) return { kind: 'failed', reason: `cli.ts nearby printed failed ${JSON.stringify(listedFailed)?.slice(0, 80)}, not an array` }

  const failed = new Map<Check, string>()
  for (const [index, item] of listedFailed.entries()) {
    const failure = parseFailure(item)
    if (typeof failure === 'string') return { kind: 'failed', reason: `cli.ts nearby failed ${index}: ${failure}` }
    if (failed.has(failure.check)) return { kind: 'failed', reason: `cli.ts nearby failed ${index}: check ${JSON.stringify(failure.check)} is listed twice` }
    failed.set(failure.check, failure.reason)
  }

  const codex: AgentSession<'codex'>[] = []
  const piOmp: AgentSession<'pi' | 'omp'>[] = []
  const ids = new Set<string>()
  for (const [index, item] of listedSessions.entries()) {
    const session = parseSession(item)
    if (typeof session === 'string') return { kind: 'failed', reason: `cli.ts nearby session ${index}: ${session}` }
    if (ids.has(session.id)) return { kind: 'failed', reason: `cli.ts nearby session ${index}: id ${JSON.stringify(session.id)} is listed twice` }
    ids.add(session.id)
    const check = checkOf(session.agent)
    if (failed.has(check)) return { kind: 'failed', reason: `cli.ts nearby session ${index}: its ${check} check is listed as failed` }
    const agent = session.agent
    if (agent === 'codex') codex.push({ ...session, agent })
    else piOmp.push({ ...session, agent })
  }

  const result = <A extends Agent>(check: Check, sessions: AgentSession<A>[]): CheckFound<A> => {
    const reason = failed.get(check)
    return reason === undefined ? { kind: 'listed', sessions } : { kind: 'failed', reason }
  }
  return { kind: 'checked', codex: result('codex', codex), piOmp: result('pi/omp', piOmp) }
}

function parseFailure(item: unknown): { check: Check; reason: string } | string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return `${JSON.stringify(item)} is not an object`
  const check = 'check' in item ? item.check : undefined
  const reason = 'reason' in item ? item.reason : undefined
  if (check !== 'codex' && check !== 'pi/omp') return `check ${JSON.stringify(check)} is not codex or pi/omp`
  if (typeof reason !== 'string') return `reason ${JSON.stringify(reason)} is not a string`
  return { check, reason }
}

// One check's sessions as the mod keeps them, sorted by id, each busy one with when its turn began: its
// turnStartedAt, else when a check first saw it busy, which holds until a check sees it idle.
function tracked<A extends Agent>(found: CheckFound<A>, previous: CheckResult<A> | null, now: number): CheckResult<A> {
  if (found.kind === 'failed') return found
  const seen = new Map((previous?.kind === 'listed' ? previous.sessions : []).flatMap(session => (session.status === 'idle' ? [] : [[session.id, session.busySince] as const])))

  return {
    kind: 'listed',
    sessions: found.sessions
      .map(({ status, turnStartedAt, ...session }): NearbySession<A> =>
        status === 'idle'
          ? { ...session, status }
          : { ...session, status, busySince: turnStartedAt === null ? (seen.get(session.id) ?? now) : Date.parse(turnStartedAt) },
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  }
}

function parseSession(item: unknown): AgentSession | string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return `${JSON.stringify(item)} is not an object`
  const agent = 'agent' in item ? item.agent : undefined
  const id = 'id' in item ? item.id : undefined
  const name = 'name' in item ? item.name : undefined
  const cwd = 'cwd' in item ? item.cwd : undefined
  const relativeCwd = 'relativeCwd' in item ? item.relativeCwd : undefined
  if (agent !== 'codex' && agent !== 'pi' && agent !== 'omp') return `agent ${JSON.stringify(agent)} is not codex, pi or omp`
  // The id reaches Claude's note and the planning prompt unquoted, so it must be a target id of this agent's form.
  if (typeof id !== 'string' || !TARGET_ID[agent].pattern.test(id)) return `id ${JSON.stringify(id)} is not a target id for ${agent}`
  if (name !== null && typeof name !== 'string') return `name ${JSON.stringify(name)} is neither a string nor null`
  if (typeof cwd !== 'string') return `cwd ${JSON.stringify(cwd)} is not a string`
  if (typeof relativeCwd !== 'string') return `relativeCwd ${JSON.stringify(relativeCwd)} is not a string`
  const status = 'status' in item ? item.status : undefined
  const turnStartedAt = 'turnStartedAt' in item ? item.turnStartedAt : undefined
  if (status !== 'idle' && status !== 'working' && status !== 'needsApproval') return `status ${JSON.stringify(status)} is not idle, working or needsApproval`
  if (turnStartedAt !== null && !isIsoTime(turnStartedAt)) return `turnStartedAt ${JSON.stringify(turnStartedAt)} is neither an ISO 8601 time nor null`
  if (status === 'idle' && turnStartedAt !== null) return `turnStartedAt ${JSON.stringify(turnStartedAt)} is set, but the session is idle`

  return { agent, id, name, cwd, relativeCwd, status, turnStartedAt }
}

function checkOf(agent: Agent): Check {
  return agent === 'codex' ? 'codex' : 'pi/omp'
}

// The sessions every check listed, in the footer's order: by agent, then by id.
function openSessions(state: AgentsNearby): NearbySession[] {
  if (state.kind !== 'checked') return []
  const sessions: NearbySession[] = [...(state.codex.kind === 'listed' ? state.codex.sessions : []), ...(state.piOmp.kind === 'listed' ? state.piOmp.sessions : [])]
  return groups(sessions).flatMap(group => group.sessions)
}

// Each failed check; cli.ts nearby failing whole is one failure for all of them.
function failedChecks(state: AgentsNearby): Failure[] {
  if (state.kind === 'failed') return [{ check: 'all', reason: state.reason }]
  return checkResults(state).flatMap(([check, result]) => (result.kind === 'failed' ? [{ check, reason: result.reason }] : []))
}

// Each check's own result, none before the first check or when cli.ts nearby itself failed.
function checkResults(state: AgentsNearby): [Check, CheckResult<Agent>][] {
  return state.kind === 'checked' ? [['codex', state.codex], ['pi/omp', state.piOmp]] : []
}

// The sessions of each agent that has any, in the footer's order of agents.
function groups(sessions: NearbySession[]): { agent: Agent; sessions: NearbySession[] }[] {
  return AGENT_ORDER.flatMap(agent => {
    const own = sessions.filter(session => session.agent === agent).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    return own.length === 0 ? [] : [{ agent, sessions: own }]
  })
}

// A date and time with its offset: without one, Date.parse would read it in this machine's zone.
function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value))
}

type Labelled = { session: NearbySession; label: string }

// Each session of one agent with the label the footer shows: its name, or the start of its id after the agent's
// prefix when it has none. Labels that come out equal get the end of the id, so two sessions never read the same.
function labelled(sessions: NearbySession[]): Labelled[] {
  const based = sessions.map(session => ({
    session,
    base: (session.name === null ? '' : displayable(session.name, LABEL_MAX)) || session.id.slice(TARGET_ID[session.agent].prefix.length).slice(0, 8),
  }))
  return based.map(({ session, base }) => ({
    session,
    label: based.filter(other => other.base === base).length > 1 ? `${base} ${session.id.slice(-8)}` : base,
  }))
}

// The footer's agents line: for each agent, its name, then each session's label, folder and status, a spinner
// and the elapsed time for a working one.
function lineSegments(sessions: NearbySession[]): LineSegment[] {
  return groups(sessions).flatMap(({ agent, sessions: own }, groupIndex): LineSegment[] => [
    ...(groupIndex === 0 ? [] : [textSegment(`${agent}-lead`, '  ')]),
    { kind: 'agent', key: agent, agent },
    textSegment(`${agent}-gap`, ' '),
    ...labelled(own).flatMap(({ session, label }, index): LineSegment[] => [
      ...(index === 0 ? [] : [textSegment(`comma-${session.id}`, ', ')]),
      ...(session.status === 'working' ? [{ kind: 'spinner', key: `spinner-${session.id}` } as const] : []),
      textSegment(`name-${session.id}`, label),
      textSegment(`cwd-${session.id}`, ` (${displayable(session.relativeCwd, LABEL_MAX)})`, 'dim'),
      ...statusSegments(session),
    ]),
  ])
}

function statusSegments(session: NearbySession): LineSegment[] {
  switch (session.status) {
    case 'idle':
      return [textSegment(`status-${session.id}`, ' idle', 'dim')]
    case 'working':
      return [textSegment(`status-${session.id}`, ' working '), { kind: 'elapsed', key: `elapsed-${session.id}`, busySince: session.busySince }]
    case 'needsApproval':
      return [textSegment(`gap-${session.id}`, ' '), textSegment(`status-${session.id}`, 'needs approval', 'warning')]
  }
}

function textSegment(key: string, text: string, style: Extract<LineSegment, { kind: 'text' }>['style'] = 'plain'): LineSegment {
  return { kind: 'text', key, text, style }
}

// One line of at most max characters, as the engine draws only text without control characters: controls,
// format characters and line breaks become spaces and runs of whitespace one space.
function displayable(text: string, max: number): string {
  const line = text.replace(INVISIBLE, ' ').replace(/\s+/g, ' ').trim()
  const characters = Array.from(line)
  return characters.length <= max ? line : `${characters.slice(0, max - 1).join('')}…`
}

// The footer's one button: Work with Codex while every open session is Codex's, Hand off otherwise, in the
// color of the one agent whose sessions alone are open.
function handOffButton(sessions: NearbySession[]): { name: string; label: string; color: string | undefined } {
  const agents = new Set(sessions.map(session => session.agent))
  const only = agents.size === 1 ? [...agents][0] : undefined
  const name = only === 'codex' ? 'Work with Codex' : 'Hand off'
  return { name, label: `↗ ${name}`, color: only === undefined ? undefined : AGENTS[only].color }
}

// Starts a turn asking Claude to plan the split across all open agent sessions and wait for approval, the
// draft in the prompt box as the task, and empties the box once the prompt entered.
async function handOff($: EngineInterface, name: string, sessions: NearbySession[]) {
  const draft = (await $.prompt.read()).text.trim()
  const why = whyNotSendable(draft)
  if (why !== null) {
    $.ui.toast(`claude-errands: ${name} left your draft in the box: ${why}.`)
    return
  }
  const result = await $.prompt.submit({ text: planningPrompt(sessions, draft), asUser: true })
  // A refused prompt never entered, so the draft stays; the engine shows the person why.
  if (draft !== '' && result.drop === undefined) await $.prompt.fill({ text: '', mode: 'replace' })
}

// The prompt asking Claude to plan how the task splits across the open agent sessions and to wait for
// approval; with no task, to say whether anything is in progress and ask what to work on.
function planningPrompt(sessions: NearbySession[], task: string): string {
  // Quoted, as in the note, so a directory name holding a newline cannot add a line to the person's prompt.
  const open = sessions.map(session => `${AGENTS[session.agent].name} session ${session.id} in ${quoted(session.cwd)}`).join(', ')
  const plan = 'If the work is too small to split, say so. Otherwise plan the split: what each brief covers and what you keep; what can run at once (one turn per session, one job per worktree, --target on every send) and what has to wait; the rough size of each part. Show me the plan, then ask me with AskUserQuestion whether to send it as planned, change the split, or do it all here. Send nothing until I answer.'
  if (task === '') return `Agent sessions open here: ${open}. If nothing is in progress, say so and ask me with AskUserQuestion what to work on, offering the likely next tasks. ${plan}`
  return `${task}\n\nPlan how we split this task with the agent sessions open here: ${open}. ${plan}`
}

// How a check that listed no session says so: no <these> session is open.
const NONE_OPEN: Record<Check, string> = { codex: 'Codex', 'pi/omp': 'pi or omp' }

function commandPrompt(state: AgentsNearby, task: string): string {
  if (state.kind === 'unpolled') return 'I ran /claude-errands:work-with-codex before the first agent check finished. Say so in one line, tell me to run it again in a few seconds, and do nothing else.'
  const sessions = openSessions(state)
  if (sessions.length > 0) return planningPrompt(sessions, task)

  const empty = checkResults(state).flatMap(([check, result]) => (result.kind === 'listed' ? [check] : []))
  const why = [
    ...(empty.length === 0 ? [] : [`no ${empty.map(check => NONE_OPEN[check]).join(', ')} session is open in this folder`]),
    ...failedChecks(state).map(({ check, reason }) => `the ${FAILURE_NAMES[check].name} check failed: ${quoted(displayable(reason, REASON_MAX))}`),
  ]
  return `I ran /claude-errands:work-with-codex, but ${why.join(' and ')}. Say so in one line and do nothing else.`
}

// Why a draft cannot go out as a plugin's prompt, or null when it can: such a prompt expands neither pastes
// nor @file mentions, and a draft starting with / or ! could run as a command. The placeholder shapes are
// what the composer shows for a paste; the engine's types do not name them.
function whyNotSendable(draft: string): string | null {
  if (/\[(Pasted text|Image) #\d+[^\]]*\]/.test(draft)) return 'it holds a pasted block or image, which a plugin cannot send'
  if (/(^|\s)@\S/.test(draft)) return 'it mentions a file with @, which a plugin cannot send'
  if (/^[/!]/.test(draft)) return 'it starts with / or !, which could run as a command'
  return null
}

// The note Claude needs beside this prompt and what Claude has been told once it enters, or null when what it
// was last told still holds. A failed check makes the sessions of its own named earlier unknown, and Claude is
// told so once; the other check's sessions stay as named.
async function changeForClaude($: EngineInterface): Promise<{ note: string; told: string | null } | null> {
  const state = await read($, nearby)
  if (state.kind === 'unpolled') return null
  const last = await read($, told)
  const named = last === null ? [] : last.split(',')
  const failures = failedChecks(state)
  const unknown = failures
    .filter(({ check }) => named.some(id => covers(check, id)))
    .map(({ check }) => `The ${FAILURE_NAMES[check].name} check failed, so it is unknown whether the ${FAILURE_NAMES[check].sessions} named earlier in this conversation are still open.`)
  const sessions = openSessions(state)
  const ids = sessions.length > 0 ? sessions.map(session => session.id).sort().join(',') : null
  if (unknown.length === 0 && ids === last) return null

  const stillNamed = named.filter(id => !failures.some(({ check }) => covers(check, id))).join(',')
  const note =
    sessions.length > 0
      ? // Claude still holds the sessions as named, so only what became unknown is news.
        [...unknown, ...(ids === stillNamed ? [] : [promptText(sessions)])].join('\n')
      : unknown.length > 0
        ? `${unknown.join(' ')} Do implementation work yourself until a later note names an open session.`
        : 'The agent sessions named earlier in this conversation are no longer open in your working directory. Do implementation work yourself.'
  return { note, told: ids }
}

// Whether the failure leaves the session of this target id unknown. Only ids a check listed reach the told
// state, so each matches one agent's form.
function covers(check: Failure['check'], id: string): boolean {
  if (check === 'all') return true
  const agent = AGENT_ORDER.find(candidate => TARGET_ID[candidate].pattern.test(id))
  if (agent === undefined) throw new Error(`claude-errands: told id ${JSON.stringify(id)} is no agent's target id`)
  return checkOf(agent) === check
}

function promptText(sessions: NearbySession[]): string {
  return [
    'Live agent sessions are open inside your working directory:',
    // Quoted, so a directory name holding a newline stays one line of data, not an instruction.
    ...sessions.map(session => `- ${AGENTS[session.agent].name} session ${session.id}, cwd ${quoted(session.cwd)}`),
    'The person keeps these sessions open to split the work with you. When work goes to one of them, you plan, write briefs and review, and the agent in that session writes the code.',
    'Before starting implementation work, ask the person once per task with AskUserQuestion whether to hand it to one of these sessions or do it here, with the session it would go to as the first option. Do not ask when the person already said where the work goes, or for questions, reviews and one-line fixes, which you handle here. Any other change to the code counts as implementation work, however small it looks.',
    'When the person picks a session, write the brief with the claude-errands:brief skill and send it with the claude-errands:send skill, passing --target <target id> on every send, the id as listed above.',
    "Show the person each brief, then send it in the same turn without asking again: choosing the session is the approval. Never edit a worktree while an agent's job holds it: claude-errands reports every change there as the agent's.",
  ].join('\n')
}

// JSON-quoted, with the characters JSON leaves raw that still end a line or hide (DEL, C1, U+2028, U+2029,
// format characters) escaped as \uXXXX too, astral ones as their surrogate pair.
function quoted(text: string): string {
  return JSON.stringify(text).replace(INVISIBLE, character =>
    Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''),
  )
}

// The plugin's name, which cli.ts and the engine both lead their messages with: each place that shows a reason has its own lead-in.
function withoutPrefix(reason: string): string {
  return reason.startsWith('claude-errands: ') ? reason.slice('claude-errands: '.length) : reason
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
