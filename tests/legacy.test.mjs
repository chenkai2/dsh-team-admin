// 老格式会话补全：标题取 session/title，空草稿标记 blank。
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { zstdCompressSync } from 'node:zlib'

import { createLegacyDecorator } from '../src/legacy.mjs'

function writeSession(root, workspace, id, lines) {
  const dir = join(root, workspace, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'session.jsonl.zstd'), zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
  return dir
}

test('createLegacyDecorator：补标题并标记空草稿', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-admin-legacy-'))
  writeSession(root, '--ws--', 'session-titled', [
    JSON.stringify({ type: 'session/title', data: { title: '分析 wecode-cli' } }),
    JSON.stringify({ type: 'turn/start', data: {} }),
  ])
  writeSession(root, '--ws--', 'session-blank', [
    JSON.stringify({ type: 'permission/preset', data: {} }),
    JSON.stringify({ type: 'session/end-seed', data: {} }),
  ])
  writeSession(root, '--ws--', 'session-usermsg', [
    JSON.stringify({ type: 'agent/inbox/spliced', data: { inserted: [{ role: 'user' }] } }),
  ])
  const decorate = createLegacyDecorator({ sessionsRoot: root })
  const value = { items: [
    { sessionId: 'session-titled', title: '', blank: false },
    { sessionId: 'session-blank', title: '', blank: false },
    { sessionId: 'session-usermsg', title: '', blank: false },
    { sessionId: 'session-new', title: '新会话标题', blank: false },
  ] }
  decorate(value)
  assert.strictEqual(value.items[0].title, '分析 wecode-cli')
  assert.strictEqual(value.items[0].blank, false)
  assert.strictEqual(value.items[1].title, '')
  assert.strictEqual(value.items[1].blank, true)
  assert.strictEqual(value.items[2].title, '')
  assert.strictEqual(value.items[2].blank, false)
  assert.strictEqual(value.items[3].title, '新会话标题')
})

test('createLegacyDecorator：新格式会话（有标题且非空白）不做任何读写', () => {
  const decorate = createLegacyDecorator({ sessionsRoot: join(tmpdir(), 'does-not-exist') })
  const value = { items: [{ sessionId: 'session-modern', title: '正常标题', blank: false }] }
  decorate(value)
  assert.strictEqual(value.items[0].title, '正常标题')
  assert.strictEqual(decorate({ items: 'not-an-array' }).items, 'not-an-array')
})
