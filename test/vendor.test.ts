// ABOUTME: Checks that the vendored ws under vendor/ws is the version the lockfile pins, so the copy the plugin
// ABOUTME: runs cannot lag behind the dependency npm audit and Dependabot watch.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const root = join(import.meta.dirname, '..')
const json = (path: string): unknown => JSON.parse(readFileSync(join(root, path), 'utf8'))

test('the vendored ws is the version the lockfile pins', () => {
  // Both files are npm's own output, with these shapes.
  const locked = (json('package-lock.json') as { packages: Record<string, { version: string }> }).packages['node_modules/ws']?.version
  const vendored = (json('vendor/ws/package.json') as { version: string }).version
  assert.equal(vendored, locked)
})
