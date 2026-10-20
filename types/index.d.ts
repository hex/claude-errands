// ABOUTME: The $.state contract of the claude-errands mod: what it last learned about
// ABOUTME: live Codex sessions working in or below this Claude session's directory.

// relativeCwd is cli.ts nearby's: the cwd relative to the session's directory, symlinks resolved, '.' when equal.
// status is the thread's, whoever started its turn; turnStartedAt is null when idle, and may be when busy.
export type CodexSession = {
  id: string
  name: string | null
  cwd: string
  relativeCwd: string
  status: 'idle' | 'working' | 'needsApproval'
  turnStartedAt: string | null
}

// A session as the band keeps it: a busy one with when its turn began, in ms since the epoch.
export type NearbySession = Omit<CodexSession, 'status' | 'turnStartedAt'> &
  ({ status: 'idle' } | { status: 'working' | 'needsApproval'; busySince: number })

export type CodexNearby =
  | { kind: 'unpolled' }
  | { kind: 'none' }
  | { kind: 'open'; sessions: NearbySession[] }
  | { kind: 'failed'; reason: string }

// The band's sessions text as plain data, drawn by the band's own Text or, while a session works, by
// hooks/sessions.tsx, which animates the spinner and the elapsed time between the band's redraws.
export type LineSegment =
  | { kind: 'text'; key: string; text: string; style: 'plain' | 'brand' | 'dim' | 'warning' }
  | { kind: 'spinner'; key: string }
  | { kind: 'elapsed'; key: string; busySince: number }

// now is the band's clock when it drew, in ms since the epoch.
export type SessionsLineProps = { segments: LineSegment[]; now: number }

declare module 'claude-code' {
  interface PluginState {
    // The thread ids last named to Claude in this conversation, sorted and comma-joined; null for none.
    'claude-errands': { codexNearby: CodexNearby; codexTold: string | null }
  }
}
