// ABOUTME: The two operations that differ per coding agent: deliver a job's text to a live session,
// ABOUTME: and report what state that job's turn is in. Everything else in claude-errands is agent-agnostic.
export type EndedTurn = { kind: 'ended'; status: 'completed' | 'failed'; finalMessage: string | null; error: string | null }
export type TurnState =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'waitingOnApproval' }
  | { kind: 'lost' }
  // The job sits in the queue of a closed thread, so nothing runs it unless that thread is resumed.
  | { kind: 'closed' }
  | EndedTurn

export type TargetActivity =
  | { status: 'idle'; turnStartedAt: null }
  | { status: 'working' | 'needsApproval'; turnStartedAt: string }

export type Target =
  | ({ id: string; readable: true; name: string | null; cwd: string; preview: string } & TargetActivity)
  | { id: string; readable: false; reason: string }

// The target session has closed, so a brief sent to it would not run.
export class TargetClosedError extends Error {
  constructor(target: string) {
    super(`thread ${target} has closed, so nothing would run this brief; pick a live thread with: targets`)
  }
}

export type Transport = {
  send(target: string, jobId: string, text: string): Promise<void>
  poll(target: string, jobId: string): Promise<TurnState>
  // Every live session; one that cannot be read is listed with the reason.
  targets(): Promise<Target[]>
  // The directory the live session behind target works in; throws TargetClosedError when the session has closed.
  liveCwd(target: string): Promise<string>
}
