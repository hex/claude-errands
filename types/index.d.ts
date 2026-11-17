// ABOUTME: The $.state contract of the claude-errands mod: what it last learned about live Codex, pi and
// ABOUTME: omp sessions working in or below this Claude session's directory, and what Claude was told of them.

export type Agent = 'codex' | 'pi' | 'omp'

// The checks cli.ts nearby runs: one asks the Codex daemon, the other every pi and omp session's socket.
export type Check = 'codex' | 'pi/omp'

// One session as cli.ts nearby lists it. id is the send target: a bare Codex thread id, or pi:<session id> or
// omp:<session id>. relativeCwd is the cwd relative to the session's directory, symlinks resolved, '.' when equal.
// status is the session's, whoever started its turn; turnStartedAt is null when idle, and may be when busy.
export type AgentSession<A extends Agent = Agent> = {
  agent: A
  id: string
  name: string | null
  cwd: string
  relativeCwd: string
  status: 'idle' | 'working' | 'needsApproval'
  turnStartedAt: string | null
}

// A session as the mod keeps it: a busy one with when its turn began, in ms since the epoch.
export type NearbySession<A extends Agent = Agent> = Omit<AgentSession<A>, 'status' | 'turnStartedAt'> &
  ({ status: 'idle' } | { status: 'working' | 'needsApproval'; busySince: number })

// What one check found: the sessions it listed, or why it failed, which leaves its sessions unknown.
export type CheckResult<A extends Agent> = { kind: 'listed'; sessions: NearbySession<A>[] } | { kind: 'failed'; reason: string }

export type AgentsNearby =
  | { kind: 'unpolled' }
  // cli.ts nearby itself failed, so no check's sessions are known.
  | { kind: 'failed'; reason: string }
  | { kind: 'checked'; codex: CheckResult<'codex'>; piOmp: CheckResult<'pi' | 'omp'> }

// The footer's agents line as plain data, drawn by the footer's own Text or, while a session works, by
// hooks/sessions.tsx, which animates the spinner and the elapsed time between the footer's redraws.
export type LineSegment =
  | { kind: 'agent'; key: string; agent: Agent }
  | { kind: 'text'; key: string; text: string; style: 'plain' | 'dim' | 'warning' }
  | { kind: 'spinner'; key: string }
  | { kind: 'elapsed'; key: string; busySince: number }

// now is the footer's clock when it drew, in ms since the epoch.
export type SessionsLineProps = { segments: LineSegment[]; now: number }

declare module 'claude-code' {
  interface PluginState {
    // The target ids of the sessions last named to Claude in this conversation, sorted and comma-joined; null for none.
    'claude-errands': { agentsNearby: AgentsNearby; agentsTold: string | null }
  }
}
