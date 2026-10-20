// ABOUTME: Checks, against an isolated real Codex daemon, the protocol facts claude-errands depends on:
// ABOUTME: a queued job id is visible in the queue listing then on its turn, the agent can commit, a pending approval is flagged.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Daemon, discoverDaemon } from '../src/daemon.ts'
import { startIsolated, until } from './harness.ts'

const queueFacts = async (): Promise<void> => {
  const isolated = await startIsolated({ approval: 'never' })
  try {
    process.env.CODEX_HOME = isolated.home
    const daemon = new Daemon((await discoverDaemon()).socket)
    assert.equal((await daemon.loadedThreads()).includes(isolated.threadId), true)
    const first = `errand-${randomUUID()}`, second = `errand-${randomUUID()}`
    await daemon.queueAdd(isolated.threadId, 'Run the shell command `sleep 20`, then reply with exactly FIRST.', first)
    await daemon.queueAdd(isolated.threadId, 'Reply with exactly SECOND.', second)
    const queued = await daemon.queueList(isolated.threadId)
    console.log('queue entry shape:', JSON.stringify(queued).slice(0, 600))
    assert.equal(JSON.stringify(queued).includes(second), true, 'the second job id is visible in thread/queue/list while the first runs')
    const turn = await until('second turn to end', 240, async () => {
      const thread = await daemon.readThread(isolated.threadId)
      const found = thread.turns.find(candidate => candidate.items.some(item => item.type === 'userMessage' && item.clientId === second))
      return found !== undefined && found.status !== 'inProgress' ? found : undefined
    })
    assert.equal(turn.status, 'completed')
    const finals = turn.items.filter(item => item.type === 'agentMessage' && item.phase === 'final_answer')
    assert.equal(finals.at(-1)?.text?.trim(), 'SECOND')
    assert.equal(JSON.stringify(await daemon.queueList(isolated.threadId)).includes(second), false, 'a started job has left the queue')
    execFileSync('git', ['-C', isolated.repo, 'status', '--porcelain'])
    console.log('PASS queue facts')
  } finally {
    await isolated.stop()
  }
}

const commitFact = async (): Promise<void> => {
  const isolated = await startIsolated({ approval: 'never' })
  try {
    process.env.CODEX_HOME = isolated.home
    const daemon = new Daemon((await discoverDaemon()).socket)
    const job = `errand-${randomUUID()}`
    await daemon.queueAdd(isolated.threadId, 'Create the file note.txt containing the word hello, then run `git add note.txt && git commit -m "add note"`. Reply with exactly COMMITTED or, if the commit failed, the error.', job)
    await until('commit turn to end', 240, async () => {
      const thread = await daemon.readThread(isolated.threadId)
      const found = thread.turns.find(candidate => candidate.items.some(item => item.type === 'userMessage' && item.clientId === job))
      return found !== undefined && found.status !== 'inProgress' ? found : undefined
    })
    const log = execFileSync('git', ['-C', isolated.repo, 'log', '--format=%s'], { encoding: 'utf8' })
    assert.equal(log.includes('add note'), true, `the agent can commit in the scratch repository; git log:\n${log}`)
    console.log('PASS commit fact')
  } finally {
    await isolated.stop()
  }
}

const approvalFact = async (): Promise<void> => {
  const isolated = await startIsolated({ approval: 'on-request' })
  try {
    process.env.CODEX_HOME = isolated.home
    const daemon = new Daemon((await discoverDaemon()).socket)
    const job = `errand-${randomUUID()}`
    await daemon.queueAdd(isolated.threadId, `Run the shell command \`touch ${isolated.root}/approval-probe.txt\`. It is outside your workspace, so request approval for it.`, job)
    await until('the approval prompt on screen', 90, () => (isolated.screen().includes('Would you like to run the following command?') ? true : undefined))
    const thread = await daemon.readThread(isolated.threadId)
    assert.deepEqual(thread.status, { type: 'active', activeFlags: ['waitingOnApproval'] })
    console.log('PASS approval fact')
  } finally {
    await isolated.stop()
  }
}

const FACTS = { queue: queueFacts, commit: commitFact, approval: approvalFact }
const chosen = process.argv.slice(2)
for (const [name, fact] of Object.entries(FACTS)) if (chosen.length === 0 || chosen.includes(name)) await fact()
