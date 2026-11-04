import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openStore } from '../src/store.mjs'

/** 临时数据目录夹具：用后自动清理。 */
async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'team-admin-store-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

test('openStore starts empty and exposes dataDir', async (t) => {
  const dir = await tempDir(t)
  const store = await openStore({ dir })
  assert.equal(store.dataDir, dir)
  assert.deepEqual(await store.readAll(), { version: 1, dismissed: {} })
  assert.deepEqual(await store.listDismissed('lead-1'), [])
})

test('record persists across a reopen', async (t) => {
  const dir = await tempDir(t)
  const store = await openStore({ dir })
  const saved = await store.record('lead-1', 'child-1', { name: 'qa', dismissedAt: 1000, sessionDeleted: true, trashPath: '/trash/x' })
  assert.deepEqual(saved, { id: 'child-1', name: 'qa', dismissedAt: 1000, sessionDeleted: true, trashPath: '/trash/x' })

  const reopened = await openStore({ dir })
  assert.deepEqual(await reopened.listDismissed('lead-1'), [saved])
  const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(file.version, 1)
  assert.deepEqual(file.dismissed['lead-1']['child-1'], { name: 'qa', dismissedAt: 1000, sessionDeleted: true, trashPath: '/trash/x' })
})

test('record is idempotent and keeps the first tombstone', async (t) => {
  const dir = await tempDir(t)
  const store = await openStore({ dir })
  const first = await store.record('lead-1', 'child-1', { name: 'qa', dismissedAt: 1000, sessionDeleted: true })
  const second = await store.record('lead-1', 'child-1', { name: 'qa-2', dismissedAt: 2000, sessionDeleted: false })
  assert.deepEqual(second, first)
  assert.equal((await store.listDismissed('lead-1')).length, 1)
})

test('listDismissed is per lead and newest first', async (t) => {
  const dir = await tempDir(t)
  const store = await openStore({ dir })
  await store.record('lead-1', 'child-1', { name: 'a', dismissedAt: 1000, sessionDeleted: true })
  await store.record('lead-1', 'child-2', { name: 'b', dismissedAt: 3000, sessionDeleted: false })
  await store.record('lead-2', 'child-3', { name: 'c', dismissedAt: 2000, sessionDeleted: true })
  assert.deepEqual((await store.listDismissed('lead-1')).map((row) => row.id), ['child-2', 'child-1'])
  assert.deepEqual((await store.listDismissed('lead-2')).map((row) => row.id), ['child-3'])
  const all = await store.readAll()
  assert.deepEqual(Object.keys(all.dismissed).sort(), ['lead-1', 'lead-2'])
})

test('corrupt JSON is quarantined and the store serves an empty state', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'state.json'), '{not json', 'utf8')
  const store = await openStore({ dir })
  assert.deepEqual(await store.readAll(), { version: 1, dismissed: {} })
  const names = await readdir(dir)
  assert.equal(names.filter((name) => name.startsWith('state.json.corrupt-')).length, 1)
  // 隔离后仍可写入新墓碑
  await store.record('lead-1', 'child-1', { name: 'qa', dismissedAt: 1, sessionDeleted: true })
  assert.equal((await store.listDismissed('lead-1')).length, 1)
})

test('unknown version is treated as corrupt', async (t) => {
  const dir = await tempDir(t)
  await writeFile(join(dir, 'state.json'), JSON.stringify({ version: 99, dismissed: {} }), 'utf8')
  const store = await openStore({ dir })
  assert.deepEqual(await store.readAll(), { version: 1, dismissed: {} })
  assert.equal((await readdir(dir)).filter((name) => name.includes('.corrupt-')).length, 1)
})

test('writes are atomic: parseable state and no tmp residue', async (t) => {
  const dir = await tempDir(t)
  const store = await openStore({ dir })
  await Promise.all([
    store.record('lead-1', 'child-1', { name: 'a', dismissedAt: 1, sessionDeleted: true }),
    store.record('lead-1', 'child-2', { name: 'b', dismissedAt: 2, sessionDeleted: true }),
    store.record('lead-2', 'child-3', { name: 'c', dismissedAt: 3, sessionDeleted: false }),
  ])
  const names = await readdir(dir)
  assert.deepEqual(names.sort(), ['state.json'])
  const parsed = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(Object.keys(parsed.dismissed['lead-1']).sort(), ['child-1', 'child-2'])
  assert.equal(parsed.dismissed['lead-1']['child-1'].trashPath, undefined)
})

test('record drops unknown fields', async (t) => {
  const dir = await tempDir(t)
  const store = await openStore({ dir })
  await store.record('lead-1', 'child-1', { name: 'qa', dismissedAt: 1, sessionDeleted: false, junk: 'x' })
  const file = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.deepEqual(file.dismissed['lead-1']['child-1'], { name: 'qa', dismissedAt: 1, sessionDeleted: false })
})
