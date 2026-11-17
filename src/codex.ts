// ABOUTME: Drives a live Codex thread through the managed daemon: queues a job's text with the job id as the
// ABOUTME: client message id, and reports the state of the turn that job started.
import { Daemon, DaemonCallError, discoverDaemon, type RawThread, type RawTurn } from './daemon.ts'
import { TargetClosedError, type EndedTurn, type Target, type TargetActivity, type Transport, type TurnState } from './transport.ts'

const daemon = async (): Promise<Daemon> => new Daemon((await discoverDaemon()).socket)

// A closed thread still answers thread/read from its rollout and still takes thread/queue/add, into a queue nothing runs until the thread is resumed.
const isClosed = (thread: RawThread): boolean => thread.status.type === 'notLoaded'

const poll = async (target: string, jobId: string): Promise<TurnState> => {
  const codex = await daemon()
  // Queue before turns: a job only moves from the queue to the turns, so this order cannot miss one that just started.
  const queue = await codex.queueList(target)
  const thread = await codex.readThread(target)
  const sent = thread.turns.find(candidate => candidate.items.some(item => item.type === 'userMessage' && item.clientId === jobId))
  // A daemon restart ends the running turn as interrupted, and Codex then continues the work in a new turn that names
  // the interrupted one as its root (measured on codex 0.169.0, 2026-11-15). The last such turn is where the job stands.
  // A turn that resumes a resumed turn was seen naming the first one; one naming the turn before it is followed too.
  const followed = new Set(sent?.status === 'interrupted' ? [sent.id] : [])
  let continuation: RawTurn | undefined
  for (const candidate of thread.turns) {
    if (followed.has(candidate.id) || candidate.rootTurnId === undefined || !followed.has(candidate.rootTurnId)) continue
    followed.add(candidate.id)
    continuation = candidate
  }
  const turn = continuation ?? sent
  const resumed = continuation === undefined ? {} : { resumedAfterRestart: true as const }
  const queued = JSON.stringify(queue).includes(jobId)
  if (isClosed(thread) && turn === undefined && queued) {
    return { kind: 'closed', reason: `thread ${target} has closed; it can run only if that thread is resumed with the job still in its queue. To run it elsewhere: abandon ${jobId}, then send the brief to a live thread from: targets. Abandon does not remove the queued copy, so the job still runs if that thread is resumed` }
  }
  if (queued) return { kind: 'queued' }
  if (turn === undefined) return { kind: 'lost' }
  if (turn.status === 'inProgress') return thread.status.activeFlags.includes('waitingOnApproval') ? { kind: 'waitingOnApproval' } : { kind: 'running' }
  const finalMessage = turn.items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer').at(-1)?.text ?? null
  if (turn.status === 'completed') return { kind: 'ended', status: 'completed', finalMessage, error: null, ...resumed }
  const failed: EndedTurn = { kind: 'ended', status: 'failed', finalMessage, error: `turn status ${turn.status}: ${JSON.stringify(turn.error)}`, ...resumed }
  return turn.status === 'interrupted' ? { kind: 'interrupted', ended: failed } : failed
}

export const listTargets = async (codex: Daemon): Promise<Target[]> =>
  Promise.all((await codex.loadedThreads()).map(id => codex.readThreadSummary(id).then(
    (thread): Target => {
      if (thread.ephemeral) return { agent: 'codex', id, readable: false, reason: 'ephemeral helper thread' }
      // A brief goes to the session a person opened, which runs its own subagents.
      if (thread.threadSource === 'subagent') return { agent: 'codex', id, readable: false, reason: 'Codex subagent thread' }
      const activity: TargetActivity = thread.status.type === 'active'
        ? { status: thread.status.activeFlags.includes('waitingOnApproval') ? 'needsApproval' : 'working', turnStartedAt: new Date(thread.recencyAt * 1000).toISOString() }
        : { status: 'idle', turnStartedAt: null }
      return { agent: 'codex', id, readable: true, name: thread.name, cwd: thread.cwd, preview: thread.preview, ...activity }
    },
    (error: unknown): Target => {
      // The daemon refuses to read a short-lived helper thread; it is listed as such. Any other failure is not a fact about the thread.
      if (!(error instanceof DaemonCallError)) throw error
      return { agent: 'codex', id, readable: false, reason: error.message }
    },
  )))

export const codexTransport: Transport = {
  async send(target, jobId, text) {
    const codex = await daemon()
    // Fails for a thread the daemon cannot read, or one that has closed, before anything is queued.
    if (isClosed(await codex.readThread(target))) throw new TargetClosedError(target)
    await codex.queueAdd(target, text, jobId)
  },
  poll,
  async liveCwd(target) {
    const thread = await (await daemon()).readThread(target)
    if (isClosed(thread)) throw new TargetClosedError(target)
    return thread.cwd
  },
  async targets() {
    return listTargets(await daemon())
  },
  // The daemon offers no call that removes a queued submission, so the queued copy stays.
  async abandon() {},
}
