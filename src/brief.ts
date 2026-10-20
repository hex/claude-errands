// ABOUTME: Parses a brief file's text into a Brief. A brief is Markdown with fixed headings; anything
// ABOUTME: malformed is rejected with a message naming the heading or entry at fault.
import { posix } from 'node:path'

// An existing worktree, or one the agent creates from Repo and Base; Repo and Base come together or not at all.
export type Workspace =
  | { kind: 'existing'; worktree: string; branch: string }
  | { kind: 'create'; repo: string; base: string; worktree: string; branch: string }
export type Brief = { title: string; workspace: Workspace; allowedPaths: string[]; testCommand: string; rules: string; work: string }

const SECTIONS = ['## Worktree', '## Allowed paths', '## Test command', '## Rules', '## Work'] as const
type Section = typeof SECTIONS[number]
const isSection = (line: string): line is Section => (SECTIONS as readonly string[]).includes(line)

const fail = (message: string): never => { throw new Error(`brief: ${message}`) }

// A path with no "." or ".." part and no doubled "/". Below its nearest existing parent a new worktree path is not
// resolved through the filesystem, and a ".." there could step back through a symlink that was never followed.
const requireNormal = (noun: string, path: string): void => {
  if (posix.normalize(path) !== path) fail(`${noun} "${path}" must be normal, with no "." or ".." part and no doubled "/"`)
}

const sectionBodies = (lines: string[]): Map<Section, string> => {
  const bodies = new Map<Section, string[]>()
  let current: Section | undefined
  for (const line of lines) {
    const heading = line.trimEnd()
    // Work is free text and comes last, so headings after it belong to it.
    if (current !== '## Work' && isSection(heading)) {
      if (bodies.has(heading)) fail(`section "${heading}" appears twice`)
      bodies.set(heading, [])
      current = heading
      continue
    }
    if (current !== undefined) bodies.get(current)?.push(line)
  }
  return new Map([...bodies].map(([section, body]) => [section, body.join('\n').trim()]))
}

export const parseBrief = (text: string): Brief => {
  const [first = '', ...rest] = text.replaceAll('\r\n', '\n').split('\n')
  const title = /^# Job: (.+)$/.exec(first.trimEnd())?.[1]?.trim()
  if (title === undefined || title === '') return fail('first line must be "# Job: <title>"')
  const bodies = sectionBodies(rest)
  const body = (section: Section): string => bodies.get(section) ?? fail(`missing section "${section}"`)
  const required = (section: Section): string => body(section) || fail(`section "${section}" is empty`)
  const nonEmptyLines = (section: Section): string[] => required(section).split('\n').map(line => line.trim()).filter(line => line !== '')

  const worktreeLines = nonEmptyLines('## Worktree')
  const field = (name: string): string | undefined => worktreeLines.map(line => new RegExp(`^${name}: (.+)$`).exec(line)?.[1]).find(found => found !== undefined)
  const branch = field('Branch')
  if (branch === undefined) return fail('section "## Worktree" has no "Branch: <name>" line')
  const worktree = worktreeLines.find(line => !/^(Branch|Repo|Base):/.test(line)) ?? ''
  if (!worktree.startsWith('/')) fail(`worktree "${worktree}" must be an absolute path`)
  requireNormal('worktree', worktree)
  const repo = field('Repo')
  const base = field('Base')
  if (repo !== undefined && base === undefined) fail('section "## Worktree" has a "Repo:" line but no "Base:" line')
  if (base !== undefined && repo === undefined) fail('section "## Worktree" has a "Base:" line but no "Repo:" line')
  if (repo !== undefined && !repo.startsWith('/')) fail(`repo "${repo}" must be an absolute path`)
  if (repo !== undefined) requireNormal('repo', repo)
  const workspace: Workspace = repo === undefined || base === undefined ? { kind: 'existing', worktree, branch } : { kind: 'create', repo, base, worktree, branch }
  const allowedPaths = nonEmptyLines('## Allowed paths').map(line => {
    if (!line.startsWith('- ')) fail(`line "${line}" in "## Allowed paths" is not a "- <glob>" entry`)
    const glob = line.slice(2).trim()
    if (glob.startsWith('/')) fail(`allowed path "${glob}" must be relative to the worktree`)
    if (glob.split('/').includes('..')) fail(`allowed path "${glob}" must not contain ".."`)
    return glob
  })
  const testCommand = required('## Test command').replace(/^`([\s\S]*)`$/, '$1').trim()
  return { title, workspace, allowedPaths, testCommand, rules: body('## Rules'), work: required('## Work') }
}
