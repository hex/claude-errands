// ABOUTME: Reads the result an agent declared on the last line of its final answer, and turns an ended turn plus the
// ABOUTME: job's worktree into an outcome. The declaration is the agent's claim; nothing here verifies the work.
import { reportChanges } from './changes.ts'
import { createdWorktreeProblems, type Job, type Outcome } from './job.ts'
import type { EndedTurn } from './transport.ts'

export type Declaration = 'done' | 'question' | 'declined'
export type OutcomeKind = Declaration | 'unclassified' | 'failed' | 'no-worktree'

const isDeclaration = (word: string): word is Declaration => word === 'done' || word === 'question' || word === 'declined'

export const declarationOf = (finalMessage: string | null): Declaration | null => {
  if (finalMessage === null) return null
  const last = finalMessage.split(/\r?\n/).filter(line => line.trim() !== '').at(-1)
  const word = last === undefined ? undefined : /^RESULT: (\w+)\s*$/.exec(last)?.[1]
  return word !== undefined && isDeclaration(word) ? word : null
}

export const classify = (turn: EndedTurn): OutcomeKind => {
  if (turn.status === 'failed') return 'failed'
  return declarationOf(turn.finalMessage) ?? 'unclassified'
}

// A worktree the agent was to create is checked first: without it there is nothing to report changes from. A failed
// turn still ends failed, with its error ahead of the failed checks.
export const captureOutcome = (job: Job, turn: EndedTurn): Outcome => {
  const capturedAt = new Date().toISOString()
  const runFacts = { ...(turn.userIntervened === true ? { userIntervened: true as const } : {}), ...(turn.resumedAfterRestart === true ? { resumedAfterRestart: true as const } : {}) }
  const problems = createdWorktreeProblems(job)
  if (problems.length > 0) {
    const kind = turn.status === 'failed' ? 'failed' : 'no-worktree'
    const error = (turn.status === 'failed' && turn.error !== null ? [turn.error, ...problems] : problems).join('; ')
    return { kind, finalMessage: turn.finalMessage, error, changes: null, capturedAt, ...runFacts }
  }
  return { kind: classify(turn), finalMessage: turn.finalMessage, error: turn.error, changes: reportChanges(job.worktree, job.baseline, job.allowedPaths), capturedAt, ...runFacts }
}
