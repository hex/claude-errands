// ABOUTME: Test-only pi/omp extension for test/agents.e2e.ts: records session, run, input and message events in $CE_PROBE_FILE,
// ABOUTME: and adds commands that block the event loop, hold a run before it starts, consume input, or start a run as a brief arrives.
import { appendFileSync, existsSync, readdirSync } from 'node:fs'

type Context = { mode: string; isIdle(): boolean }
type Event = { source?: string; text?: string; willContinue?: boolean; message?: { role?: string; content?: unknown; stopReason?: string } }
type Host = {
  on(event: string, handler: (event: Event, ctx: Context) => unknown): void
  registerCommand(name: string, options: { description: string; handler: (args: string) => Promise<void> }): void
  sendUserMessage(text: string): unknown
}

const textOf = (content: unknown): string => typeof content === 'string'
  ? content
  : Array.isArray(content) ? content.flatMap(part => typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string' ? [part.text] : []).join('\n') : ''

export default function probe(pi: Host): void {
  const file = process.env.CE_PROBE_FILE
  const live = process.env.CE_LIVE_DIR
  if (file === undefined || live === undefined) throw new Error('CE_PROBE_FILE and CE_LIVE_DIR must be set')
  const record = (entry: object): void => appendFileSync(file, `${JSON.stringify({ ...entry, pid: process.pid, at: Date.now() })}\n`)
  let holdMs = 0
  let consumeNext = false
  let briefRaceText: string | null = null

  pi.on('session_start', (_event, ctx) => record({ event: 'session_start', mode: ctx.mode }))
  // A print run can end and remove a socket before the test looks, so the live/ listing is taken while the run is going.
  pi.on('agent_start', (_event, ctx) => record({ event: 'agent_start', mode: ctx.mode, live: existsSync(live) ? readdirSync(live) : [] }))
  pi.on('input', async event => {
    record({ event: 'input', source: event.source, text: event.text })
    if (consumeNext && event.source === 'extension') {
      consumeNext = false
      record({ event: 'consumed', text: event.text })
      return { action: 'handled', handled: true }
    }
    // pi takes a brief only after its input handlers return, so a run started here begins before the brief arrives.
    if (briefRaceText !== null && event.source === 'extension' && event.text?.startsWith('Read ') === true) {
      const text = briefRaceText
      briefRaceText = null
      record({ event: 'race', text })
      holdMs = 5000
      pi.sendUserMessage(text)
      await new Promise(resolve => setTimeout(resolve, 200))
    }
    return undefined
  })
  pi.on('message_start', event => { if (event.message?.role === 'user') record({ event: 'user_message', text: textOf(event.message.content) }) })
  pi.on('message_end', event => { if (event.message?.role === 'assistant') record({ event: 'assistant_message', stopReason: event.message.stopReason }) })
  pi.on('before_agent_start', async () => {
    const ms = holdMs
    holdMs = 0
    if (ms === 0) return
    record({ event: 'held', ms })
    await new Promise(resolve => setTimeout(resolve, ms))
    record({ event: 'released' })
  })
  const runEnded = (): void => record({ event: 'run_end' })
  pi.on('agent_end', event => { if (process.versions.bun !== undefined && event.willContinue !== true) runEnded() })
  pi.on('agent_settled', runEnded)

  pi.registerCommand('ce-block', {
    description: 'Block the event loop for 3 s',
    handler: async () => {
      const until = Date.now() + 3000
      while (Date.now() < until) { /* the point is to hold the event loop */ }
      record({ event: 'unblocked' })
    },
  })
  pi.registerCommand('ce-hold', {
    description: 'Hold the next run before it starts for the given milliseconds',
    handler: async args => { holdMs = Number(args) },
  })
  pi.registerCommand('ce-consume', {
    description: 'Consume the next input an extension sends',
    handler: async () => { consumeNext = true },
  })
  pi.registerCommand('ce-race-brief', {
    description: 'When a brief arrives as input, first start another run with the given text and hold it 5 s',
    handler: async args => { briefRaceText = args },
  })
}
