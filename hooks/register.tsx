// ABOUTME: Polls `cli.ts nearby` for live Codex sessions working in or below this session's directory,
// ABOUTME: shows them in the band above the prompt and asks Claude to plan how to split the work with them.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CodexNearby, CodexSession, LineSegment, NearbySession } from '../types'
import { OPENAI_GREEN, drawLine } from './line'

const nearby = atom({ plugin: 'claude-errands', key: 'codexNearby' } as const, { kind: 'unpolled' })
const told = atom({ plugin: 'claude-errands', key: 'codexTold' } as const, null)

const SEARCH_MS = 15_000
// A session once found leaves the list only when Codex unloads its thread, minutes after it closes, so a faster check gains nothing.
const FOUND_MS = 60_000
// While a session is busy the band's status and elapsed time follow its turn closely.
const BUSY_MS = 5_000
const RUN_TIMEOUT_MS = 20_000
// Characters that end a line or draw nothing: controls (C0, DEL, C1), format characters, U+2028 and U+2029.
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu
const LABEL_MAX = 40
const REASON_MAX = 200

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // The session's own folder, not the shell's current one: a `cd` into a subfolder must not hide Codex sessions here.
    void watch($, e.cwd)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const state = await read($, nearby)
    if (e.props.hasSurvey || state.kind === 'unpolled' || state.kind === 'none') return next(e)

    // The band shares the slot: what other plugins and the engine draw beneath this hook stays, above this row.
    const beneath = await next(e)
    const elements = $.ui.resolve(e)
    const { Box, Button, Text } = elements
    if (state.kind === 'failed') {
      return (
        <Box flexDirection="column">
          {beneath}
          <Text color="warning">{`claude-errands: Codex check failed: ${displayable(state.reason, REASON_MAX)}`}</Text>
        </Box>
      )
    }

    const segments = lineSegments(state.sessions)
    const now = await $.clock.now()
    // Only the terminal and desktop draw a Client; elsewhere the band shows the time as of its last redraw.
    const Client = 'Client' in elements ? elements.Client : undefined
    const line = Client !== undefined && segments.some(segment => segment.kind !== 'text')
      ? <Client key="sessions" module="./sessions.tsx" props={{ segments, now }} />
      : drawLine(Text, segments, null, now)

    return (
      <Box flexDirection="column">
        {beneath}
        <Box flexDirection="row" justifyContent="flex-end" gap={2}>
          {line}
          <Button key="work-with-codex" label="↗ Work with Codex" onPress={() => workWithCodex($, state.sessions)}>
            <Text color={OPENAI_GREEN}>↗ Work with Codex</Text>
          </Button>
        </Box>
      </Box>
    )
  })

  // Claude learns of Codex sessions beside a prompt, and only when they change: a system-prompt section
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

async function watch($: EngineInterface, root: string) {
  const found = await poll($, root)
  $.clock.after(nextCheckMs(found), () => void watch($, root))
}

function nextCheckMs(found: CodexNearby): number {
  if (found.kind === 'none') return SEARCH_MS
  if (found.kind === 'open' && found.sessions.some(session => session.status !== 'idle')) return BUSY_MS
  return FOUND_MS
}

async function poll($: EngineInterface, root: string): Promise<CodexNearby> {
  const listed = await check($, root).catch((error: unknown): Listed => ({ kind: 'failed', reason: withoutPrefix(message(error)) }))
  const now = await $.clock.now()
  const after = (previous: CodexNearby): CodexNearby => (listed.kind === 'failed' ? listed : tracked(listed.sessions, previous, now))
  return update($, nearby, after).catch((error: unknown) => {
    $.ui.log(`claude-errands: could not record the Codex check: ${message(error)}`)
    return after({ kind: 'unpolled' })
  })
}

type Listed = { kind: 'listed'; sessions: CodexSession[] } | { kind: 'failed'; reason: string }

async function check($: EngineInterface, root: string): Promise<Listed> {
  const ran = await $.process.run(['node', `${$.plugin.root}/src/cli.ts`, 'nearby', root], { timeoutMs: RUN_TIMEOUT_MS })
  if (ran.exitCode !== 0) {
    const firstLine = ran.stderr.split('\n')[0]?.trim()
    return { kind: 'failed', reason: firstLine ? withoutPrefix(firstLine) : `cli.ts nearby exited ${ran.exitCode} with nothing on stderr` }
  }

  return parseSessions(ran.stdout)
}

function parseSessions(stdout: string): Listed {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return { kind: 'failed', reason: `cli.ts nearby printed something other than JSON: ${JSON.stringify(stdout.slice(0, 80))}` }
  }
  if (!Array.isArray(parsed)) return { kind: 'failed', reason: `cli.ts nearby printed JSON that is not an array: ${stdout.slice(0, 80)}` }

  const sessions: CodexSession[] = []
  for (const [index, item] of parsed.entries()) {
    const session = parseSession(item)
    if (typeof session === 'string') return { kind: 'failed', reason: `cli.ts nearby session ${index}: ${session}` }
    sessions.push(session)
  }

  return { kind: 'listed', sessions }
}

// The sessions as the band keeps them, sorted by id, each busy one with when its turn began: its
// turnStartedAt, else when the band first saw it busy, which holds until the band sees it idle.
function tracked(sessions: CodexSession[], previous: CodexNearby, now: number): CodexNearby {
  if (sessions.length === 0) return { kind: 'none' }
  const seen = new Map((previous.kind === 'open' ? previous.sessions : []).flatMap(session => (session.status === 'idle' ? [] : [[session.id, session.busySince] as const])))

  return {
    kind: 'open',
    sessions: sessions
      .map(({ status, turnStartedAt, ...thread }): NearbySession =>
        status === 'idle'
          ? { ...thread, status }
          : { ...thread, status, busySince: turnStartedAt === null ? (seen.get(thread.id) ?? now) : Date.parse(turnStartedAt) },
      )
      .sort((a, b) => (a.id < b.id ? -1 : 1)),
  }
}

function parseSession(item: unknown): CodexSession | string {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return `${JSON.stringify(item)} is not an object`
  const id = 'id' in item ? item.id : undefined
  const name = 'name' in item ? item.name : undefined
  const cwd = 'cwd' in item ? item.cwd : undefined
  const relativeCwd = 'relativeCwd' in item ? item.relativeCwd : undefined
  if (typeof id !== 'string' || !/^[0-9A-Za-z-]+$/.test(id)) return `id ${JSON.stringify(id)} is not a thread id`
  if (name !== null && typeof name !== 'string') return `name ${JSON.stringify(name)} is neither a string nor null`
  if (typeof cwd !== 'string') return `cwd ${JSON.stringify(cwd)} is not a string`
  if (typeof relativeCwd !== 'string') return `relativeCwd ${JSON.stringify(relativeCwd)} is not a string`
  const status = 'status' in item ? item.status : undefined
  const turnStartedAt = 'turnStartedAt' in item ? item.turnStartedAt : undefined
  if (status !== 'idle' && status !== 'working' && status !== 'needsApproval') return `status ${JSON.stringify(status)} is not idle, working or needsApproval`
  if (turnStartedAt !== null && !isIsoTime(turnStartedAt)) return `turnStartedAt ${JSON.stringify(turnStartedAt)} is neither an ISO 8601 time nor null`
  if (status === 'idle' && turnStartedAt !== null) return `turnStartedAt ${JSON.stringify(turnStartedAt)} is set, but the session is idle`

  return { id, name, cwd, relativeCwd, status, turnStartedAt }
}

// A date and time with its offset: without one, Date.parse would read it in this machine's zone.
function isIsoTime(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value))
}

// Each session with the label the band shows: its name, or its id's start when it has none. Labels that
// come out equal get the end of the id, so two sessions never read the same.
function labelled(sessions: NearbySession[]): { session: NearbySession; label: string }[] {
  const based = sessions.map(session => ({
    session,
    base: (session.name === null ? '' : displayable(session.name, LABEL_MAX)) || session.id.slice(0, 8),
  }))
  return based.map(({ session, base }) => ({
    session,
    label: based.filter(other => other.base === base).length > 1 ? `${base} ${session.id.slice(-8)}` : base,
  }))
}

// The band's sessions text: each session's label and folder, a spinner and the elapsed time for a working one.
function lineSegments(sessions: NearbySession[]): LineSegment[] {
  return [
    textSegment('codex', 'Codex', 'brand'),
    textSegment('in-folder', ` ${sessions.length === 1 ? 'session' : 'sessions'} in this folder: `),
    ...labelled(sessions).flatMap(({ session, label }, index): LineSegment[] => [
      ...(index === 0 ? [] : [textSegment(`comma-${session.id}`, ', ')]),
      ...(session.status === 'working' ? [{ kind: 'spinner', key: `spinner-${session.id}` } as const] : []),
      textSegment(`name-${session.id}`, label),
      textSegment(`cwd-${session.id}`, ` (${displayable(session.relativeCwd, LABEL_MAX)})`, 'dim'),
      ...statusSegments(session),
    ]),
  ]
}

function statusSegments(session: NearbySession): LineSegment[] {
  switch (session.status) {
    case 'idle':
      return []
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

// Starts a turn asking Claude to plan the split across all open Codex sessions and wait for approval.
async function workWithCodex($: EngineInterface, sessions: NearbySession[]) {
  // Quoted, as in the note, so a directory name holding a newline cannot add a line to the person's prompt.
  const open = sessions.map(session => `${session.id} in ${quoted(session.cwd)}`).join(', ')
  const plan = 'If the work is too small to split, say so. Otherwise plan the split: what each brief covers and what you keep; what can run at once (one turn per thread, one job per worktree, --target on every send) and what has to wait; the rough size of each part. Show me the plan, then ask me with AskUserQuestion whether to send it as planned, change the split, or do it all here. Send nothing until I answer.'
  const draft = (await $.prompt.read()).text.trim()
  const why = whyNotSendable(draft)
  if (why !== null) {
    $.ui.toast(`claude-errands: Work with Codex left your draft in the box: ${why}.`)
    return
  }
  if (draft === '') {
    await $.prompt.submit({ text: `Codex sessions open here: ${open}. If nothing is in progress, say so and ask me with AskUserQuestion what to work on, offering the likely next tasks. ${plan}`, asUser: true })
    return
  }
  const result = await $.prompt.submit({ text: `${draft}\n\nPlan how we split this task with the Codex sessions open here: ${open}. ${plan}`, asUser: true })
  // A refused prompt never entered, so the draft stays; the engine shows the person why.
  if (result.drop === undefined) await $.prompt.fill({ text: '', mode: 'replace' })
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
// was last told still holds. A failed check makes the sessions named earlier unknown, and Claude is told so once.
async function changeForClaude($: EngineInterface): Promise<{ note: string; told: string | null } | null> {
  const state = await read($, nearby)
  if (state.kind === 'unpolled') return null
  const last = await read($, told)
  if (state.kind === 'failed') {
    if (last === null) return null
    return {
      note: 'The Codex check failed, so it is unknown whether the Codex sessions named earlier in this conversation are still open. Do implementation work yourself until a later note names an open session.',
      told: null,
    }
  }
  const ids = state.kind === 'open' ? state.sessions.map(session => session.id).join(',') : null
  if (ids === last) return null
  return {
    note: state.kind === 'open'
      ? promptText(state.sessions)
      : 'The Codex sessions named earlier in this conversation are no longer open in your working directory. Do implementation work yourself.',
    told: ids,
  }
}

function promptText(sessions: NearbySession[]): string {
  return [
    'Live Codex sessions are open inside your working directory:',
    // Quoted, so a directory name holding a newline stays one line of data, not an instruction.
    ...sessions.map(session => `- thread ${session.id}, cwd ${quoted(session.cwd)}`),
    'The person keeps these Codex sessions open to split the work with you: you plan, write briefs and review; Codex writes the code.',
    'Hand implementation work that fits a brief to Codex unless the person says to do it here. Write briefs with the claude-errands:brief skill and send them with the claude-errands:send skill, passing --target <thread id> on every send.',
    "Show the person each brief before sending it. Never edit a worktree while a Codex job holds it: claude-errands reports every change there as the agent's.",
  ].join('\n')
}

// JSON-quoted, with the characters JSON leaves raw that still end a line or hide (DEL, C1, U+2028, U+2029,
// format characters) escaped as \uXXXX too, astral ones as their surrogate pair.
function quoted(text: string): string {
  return JSON.stringify(text).replace(INVISIBLE, character =>
    Array.from({ length: character.length }, (_, index) => `\\u${character.charCodeAt(index).toString(16).padStart(4, '0')}`).join(''),
  )
}

// The band already names the plugin; cli.ts and the engine both lead their messages with it.
function withoutPrefix(reason: string): string {
  return reason.startsWith('claude-errands: ') ? reason.slice('claude-errands: '.length) : reason
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
