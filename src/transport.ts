// ABOUTME: The two operations that differ per coding agent: deliver a job's text to a live session,
// ABOUTME: and report what state that job's turn is in. Everything else in claude-errands is agent-agnostic.
export type EndedTurn = { kind: 'ended'; status: 'completed' | 'failed'; finalMessage: string | null; error: string | null }
export type TurnState =
  | { kind: 'queued' }
  | { kind: 'running' }
  | { kind: 'waitingOnApproval' }
  | { kind: 'lost' }
  | EndedTurn

export type TargetActivity =
  | { status: 'idle'; turnStartedAt: null }
  | { status: 'working' | 'needsApproval'; turnStartedAt: string }

export type Target =
  | ({ id: string; readable: true; name: string | null; cwd: string; preview: string } & TargetActivity)
  | { id: string; readable: false; reason: string }

export type Transport = {
  send(target: string, jobId: string, text: string): Promise<void>
  poll(target: string, jobId: string): Promise<TurnState>
  // Every live session; one that cannot be read is listed with the reason.
  targets(): Promise<Target[]>
  // The directory the session behind target works in.
  cwd(target: string): Promise<string>
}
