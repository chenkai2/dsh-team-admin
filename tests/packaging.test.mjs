import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

test('bundle patch is declared, exists, and inserts this package by id', async () => {
  const patchPath = join(root, pkg.dsh?.bundle?.patch ?? 'MISSING')
  assert.equal(existsSync(patchPath), true, 'cordis.patch.yml missing')
  const patch = await readFile(patchPath, 'utf8')
  assert.match(patch, new RegExp('id: team-admin'))
  assert.match(patch, new RegExp("name: '" + pkg.name + "'"))
})

test('main and client exports are declared and exist', async () => {
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './src/client.js')
  assert.equal(existsSync(join(root, 'src/index.js')), true)
  assert.equal(existsSync(join(root, 'src/client.js')), true)
  assert.equal(pkg.dsh?.client?.platform, 'web')
})

test('published files cover runtime sources', () => {
  assert.ok(Array.isArray(pkg.files))
  for (const entry of ['src', 'cordis.patch.yml', 'README.md']) assert.ok(pkg.files.includes(entry), entry)
})

test('PLUGIN_VERSION stays in sync with package.json', async () => {
  const source = await readFile(join(root, 'src/index.js'), 'utf8')
  const match = source.match(/PLUGIN_VERSION = '([^']+)'/)
  assert.ok(match, 'PLUGIN_VERSION not found')
  assert.equal(match[1], pkg.version)
})

test('dsh compatibility range admits current harness line', () => {
  assert.match(pkg.dsh?.requires?.dsh ?? '', />=0\.2\.0/)
})

test('client bundle registers through the host module loader', async () => {
  const source = await readFile(join(root, 'src/client.js'), 'utf8')
  assert.match(source, /__ModuleLoader__/)
  assert.match(source, new RegExp("id: '" + pkg.name + "'"))
  assert.doesNotMatch(source, /^\s*(import|export)\s/m)
})
