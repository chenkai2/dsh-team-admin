// 老格式会话补全：只读旧文件名日志，补标题；只为「小且无消息」的日志标记 blank。
import assert from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { zstdCompressSync } from 'node:zlib'

import { createLegacyDecorator } from '../src/legacy.mjs'

function writeLog(root, workspace, id, fileName, lines) {
  const dir = join(root, workspace, id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, fileName), zstdCompressSync(Buffer.from(lines.join('\n') + '\n')))
}

function jsonLine(value) { return JSON.stringify(value) }

test('旧格式日志：补标题，有 turn 的会话不会被标 blank', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-admin-legacy-'))
  writeLog(root, '--ws--', 'session-titled', 'session.jsonl.zstd', [
    jsonLine({ type: 'session/title', data: { title: '分析 wecode-cli' } }),
    jsonLine({ type: 'turn/start', data: {} }),
    jsonLine({ type: 'turn/start', data: {} }),
  ])
  const decorate = createLegacyDecorator({ sessionsRoot: root })
  const value = { items: [{ sessionId: 'session-titled', projections: { values: {} }, title: '', blank: false }] }
  decorate(value)
  assert.strictEqual(value.items[0].projections.values.title, '分析 wecode-cli')
  assert.strictEqual(value.items[0].blank, false)
})

test('旧格式小日志：没有 turn 也没有用户消息才标 blank', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-admin-legacy-'))
  writeLog(root, '--ws--', 'session-blank', 'session.jsonl.zstd', [
    jsonLine({ type: 'permission/preset', data: {} }),
    jsonLine({ type: 'session/end-seed', data: {} }),
  ])
  const decorate = createLegacyDecorator({ sessionsRoot: root })
  const value = { items: [{ sessionId: 'session-blank', title: '', blank: false }] }
  decorate(value)
  assert.strictEqual(value.items[0].blank, true)
})

test('有标题的会话一律不动（0.2.2 的回归点）', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-admin-legacy-'))
  writeLog(root, '--ws--', 'session-modern', 'session.v4.jsonl.zstd', [jsonLine({ type: 'session' })])
  const decorate = createLegacyDecorator({ sessionsRoot: root })
  const value = { items: [{ sessionId: 'session-modern', title: '正常标题', blank: false }] }
  decorate(value)
  assert.strictEqual(value.items[0].title, '正常标题')
  assert.strictEqual(value.items[0].blank, false)
})

test('v4 多帧日志不参与补全：无标题时保持原样，不会被隐藏', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-admin-legacy-'))
  writeLog(root, '--ws--', 'session-v4', 'session.v4.jsonl.zstd', [jsonLine({ type: 'session' })])
  const decorate = createLegacyDecorator({ sessionsRoot: root })
  const value = { items: [{ sessionId: 'session-v4', title: '', blank: false }] }
  decorate(value)
  assert.strictEqual(value.items[0].title, '')
  assert.strictEqual(value.items[0].blank, false)
})

test('大体积旧日志即使只解出第一帧也不会被标 blank', () => {
  const root = mkdtempSync(join(tmpdir(), 'team-admin-legacy-'))
  const filler = randomBytes(20000).toString('base64')
  writeLog(root, '--ws--', 'session-big', 'session.jsonl.zstd', [jsonLine({ type: 'session', pad: filler })])
  const decorate = createLegacyDecorator({ sessionsRoot: root })
  const value = { items: [{ sessionId: 'session-big', title: '', blank: false }] }
  decorate(value)
  assert.strictEqual(value.items[0].blank, false)
})

test('非数组输入原样返回', () => {
  const decorate = createLegacyDecorator({ sessionsRoot: join(tmpdir(), 'does-not-exist') })
  const value = { items: 'not-an-array' }
  decorate(value)
  assert.strictEqual(value.items, 'not-an-array')
})
