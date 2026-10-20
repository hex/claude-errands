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

// A worktree the agent was to create is checked first: without it there is nothing to report changes from.
export const captureOutcome = (job: Job, turn: EndedTurn): Outcome => {
  const capturedAt = new Date().toISOString()
  const problems = createdWorktreeProblems(job)
  if (problems.length > 0) return { kind: 'no-worktree', finalMessage: turn.finalMessage, error: problems.join('; '), changes: null, capturedAt }
  return { kind: classify(turn), finalMessage: turn.finalMessage, error: turn.error, changes: reportChanges(job.worktree, job.baseline, job.allowedPaths), capturedAt }
}
