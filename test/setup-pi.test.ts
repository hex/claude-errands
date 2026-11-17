// ABOUTME: Runs setup-pi against a scratch HOME on the real filesystem: links the extension into pi's and omp's
// ABOUTME: extension folders, does nothing on a rerun, replaces only its own links, refuses anything else, skips a missing agent.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'

const CLI = join(import.meta.dirname, '..', 'src', 'cli.ts')
const EXTENSION = realpathSync(join(import.meta.dirname, '..', 'pi', 'claude-errands.ts'))
const RELOAD = 'Run /reload in each open pi session and restart each open omp session to load the extension.\n'

const home = (t: TestContext, agents: string[]): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-errands-setup-')))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  for (const agent of agents) mkdirSync(join(dir, `.${agent}`, 'agent'), { recursive: true })
  return dir
}

const setup = (dir: string) => spawnSync(process.execPath, [CLI, 'setup-pi'], { env: { ...process.env, HOME: dir }, encoding: 'utf8', timeout: 10_000 })
const link = (dir: string, agent: string): string => join(dir, `.${agent}`, 'agent', 'extensions', 'claude-errands.ts')

test('setup-pi links the extension into both agents, creating extensions/ where it is missing, and a rerun changes nothing', t => {
  const dir = home(t, ['pi', 'omp'])
  mkdirSync(join(dir, '.pi', 'agent', 'extensions'))
  const first = setup(dir)
  assert.equal(first.stderr, '')
  assert.equal(first.status, 0)
  assert.equal(first.stdout, `pi: linked ${link(dir, 'pi')} to ${EXTENSION}\nomp: linked ${link(dir, 'omp')} to ${EXTENSION}\n${RELOAD}`)
  for (const agent of ['pi', 'omp']) assert.equal(readlinkSync(link(dir, agent)), EXTENSION)
  const again = setup(dir)
  assert.equal(again.status, 0, again.stderr)
  assert.equal(again.stdout, `pi: ${link(dir, 'pi')} already links to ${EXTENSION}\nomp: ${link(dir, 'omp')} already links to ${EXTENSION}\n`)
})

test('setup-pi replaces its own link to an earlier install path, even a dangling one', t => {
  const dir = home(t, ['pi'])
  const earlier = '/no/such/plugin/pi/claude-errands.ts'
  mkdirSync(join(dir, '.pi', 'agent', 'extensions'))
  symlinkSync(earlier, link(dir, 'pi'))
  const result = setup(dir)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `pi: replaced ${link(dir, 'pi')}, which linked to ${earlier}, with a link to ${EXTENSION}\nomp: skipped, ${join(dir, '.omp', 'agent')} does not exist\n${RELOAD}`)
  assert.equal(readlinkSync(link(dir, 'pi')), EXTENSION)
})

test('setup-pi refuses a regular file or a foreign symlink at the link path, leaves it alone, and still links the other agent', t => {
  const dir = home(t, ['pi', 'omp'])
  mkdirSync(join(dir, '.pi', 'agent', 'extensions'))
  mkdirSync(join(dir, '.omp', 'agent', 'extensions'))
  writeFileSync(link(dir, 'pi'), 'my own extension\n')
  const result = setup(dir)
  assert.equal(result.status, 1)
  assert.equal(result.stdout, `omp: linked ${link(dir, 'omp')} to ${EXTENSION}\n${RELOAD}`)
  assert.equal(result.stderr, `claude-errands: pi: ${link(dir, 'pi')} is a file that setup-pi did not create; move it away and run setup-pi again\n`)
  assert.equal(readFileSync(link(dir, 'pi'), 'utf8'), 'my own extension\n')

  rmSync(link(dir, 'pi'))
  symlinkSync('/somewhere/else.ts', link(dir, 'pi'))
  const foreign = setup(dir)
  assert.equal(foreign.status, 1)
  assert.equal(foreign.stdout, `omp: ${link(dir, 'omp')} already links to ${EXTENSION}\n`)
  assert.equal(foreign.stderr, `claude-errands: pi: ${link(dir, 'pi')} is a symlink to /somewhere/else.ts that setup-pi did not create; move it away and run setup-pi again\n`)
  assert.equal(readlinkSync(link(dir, 'pi')), '/somewhere/else.ts')
})

test('setup-pi skips an agent whose folder does not exist and creates nothing for it', t => {
  const dir = home(t, [])
  const result = setup(dir)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stdout, `pi: skipped, ${join(dir, '.pi', 'agent')} does not exist\nomp: skipped, ${join(dir, '.omp', 'agent')} does not exist\n`)
  assert.equal(lstatSync(join(dir, '.pi'), { throwIfNoEntry: false }), undefined)
  assert.equal(lstatSync(join(dir, '.omp'), { throwIfNoEntry: false }), undefined)
})
