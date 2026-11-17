// ABOUTME: The two operations that differ per coding agent: deliver a job's text to a live session,
// ABOUTME: and report what state that job's turn is in. Everything else in claude-errands is agent-agnostic.
// userIntervened: the person typed into the session during the job's run; only pi and omp can tell, and they report it, nothing more.
// resumedAfterRestart: a Codex daemon restart interrupted the job's turn and Codex continued the work in another turn, the one reported here.
export type EndedTurn = { kind: 'ended'; status: 'completed' | 'failed'; finalMessage: string | null; error: string | null; userIntervened?: true; resumedAfterRestart?: true }
export type TurnState =
  | { kind: 'queued' }
  // Queued, and the session's run is paused until a background job of its own wakes it; the job starts when that run
  // ends. Only omp reports it.
  | { kind: 'queuedBehindBackgroundJob' }
  | { kind: 'running' }
  | { kind: 'waitingOnApproval' }
  | { kind: 'lost' }
  // The job has not started and nothing will run it as things stand; reason says why and what could still run it.
  | { kind: 'closed'; reason: string }
  // The session took the job and let it go before it started; nothing will run it. reason says why. Only pi and omp report it.
  | { kind: 'dropped'; reason: string }
  // The session was handed the brief at dispatchedAt and reports nothing going, yet the brief has not appeared in it.
  // The session may still run it, so it is reported, not failed. Only pi and omp report it.
  | { kind: 'notAdmitted'; dispatchedAt: string }
  // The job's turn ended interrupted and no turn has continued it. After a daemon restart Codex starts one, so a single
  // sighting does not prove the job is over; ended is how it ends if none appears. Only Codex reports it.
  | { kind: 'interrupted'; ended: EndedTurn }
  | EndedTurn

export type TargetActivity =
  | { status: 'idle'; turnStartedAt: null }
  | { status: 'working' | 'needsApproval'; turnStartedAt: string }

export type AgentKind = 'codex' | 'pi' | 'omp'

// preview: the session's opening text; null for pi and omp, which do not expose one.
export type Target =
  | ({ agent: AgentKind; id: string; readable: true; name: string | null; cwd: string; preview: string | null } & TargetActivity)
  | { agent: AgentKind; id: string; readable: false; reason: string }

// The target session has closed, so a brief sent to it would not run. noun is what the agent calls a session.
export class TargetClosedError extends Error {
  constructor(target: string, noun: 'thread' | 'session' = 'thread') {
    super(`${noun} ${target} has closed, so nothing would run this brief; pick a live ${noun} with: targets`)
  }
}

// The session answered that it did not take the job, so nothing was queued.
export class SendRefusedError extends Error {}

export type Transport = {
  send(target: string, jobId: string, text: string): Promise<void>
  poll(target: string, jobId: string): Promise<TurnState>
  // Every live session; one that cannot be read is listed with the reason.
  targets(): Promise<Target[]>
  // The directory the live session behind target works in; throws TargetClosedError when the session has closed.
  liveCwd(target: string): Promise<string>
  // Called after abandon settles the job, to release what the agent side still holds for it.
  abandon(target: string, jobId: string): Promise<void>
}
