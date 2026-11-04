// 宿主侧会话列表过滤：在 sessionController.list 出口摘掉已删除成员。
import assert from 'node:assert'
import test from 'node:test'

import { collectDismissedIds, stripDismissedMembers } from '../src/filter.mjs'
import { installSessionListFilter } from '../src/index.js'

function payload() {
  return {
    items: [{
      sessionId: 'session-lead',
      projections: { values: {
        subagentCatalog: [{ id: 'm1', label: 'deleted' }, { id: 'm2', label: 'alive' }],
        agentTeam: { members: [{ id: 'm1', name: 'client-ui' }, { id: 'm2', name: 'ui-debug' }] },
      } },
    }],
  }
}

test('stripDismissedMembers：catalog 与 roster 一起过滤，其余结构原样', () => {
  const value = payload()
  assert.strictEqual(stripDismissedMembers(value, new Set(['m1'])), value)
  assert.deepStrictEqual(value.items[0].projections.values.subagentCatalog, [{ id: 'm2', label: 'alive' }])
  assert.deepStrictEqual(value.items[0].projections.values.agentTeam.members, [{ id: 'm2', name: 'ui-debug' }])
  const untouched = { items: [] }
  assert.strictEqual(stripDismissedMembers(untouched, new Set()), untouched)
})

test('collectDismissedIds：展平所有 lead 桶的成员 id', () => {
  assert.deepStrictEqual([...collectDismissedIds({ dismissed: { lead1: { a: {}, b: {} }, lead2: { c: {} } } })].sort(), ['a', 'b', 'c'])
  assert.strictEqual(collectDismissedIds(null).size, 0)
})

test('installSessionListFilter：包住 sessionController.list 并过滤', async () => {
  const service = { list: async () => payload() }
  const ctx = { get: (name) => (name === 'sessionController' ? service : undefined) }
  const logs = []
  const ok = installSessionListFilter(ctx, {
    getStore: async () => ({ readAll: async () => ({ dismissed: { lead1: { m1: {} } } }) }),
    logSystem: (line) => logs.push(line),
  })
  assert.strictEqual(ok, true)
  const value = await service.list({}, undefined)
  assert.deepStrictEqual(value.items[0].projections.values.subagentCatalog, [{ id: 'm2', label: 'alive' }])
  assert.deepStrictEqual(value.items[0].projections.values.agentTeam.members, [{ id: 'm2', name: 'ui-debug' }])
  assert.deepStrictEqual(logs, [])
})

test('installSessionListFilter：没有 sessionController 时只记日志', () => {
  const logs = []
  const ok = installSessionListFilter({ get: () => undefined }, { getStore: async () => ({}), logSystem: (line) => logs.push(line) })
  assert.strictEqual(ok, false)
  assert.match(logs[0], /未找到 sessionController/)
})

test('installSessionListFilter：墓碑读取失败时放行原始列表并记日志', async () => {
  const service = { list: async () => payload() }
  const logs = []
  installSessionListFilter({ get: () => service }, {
    getStore: async () => { throw new Error('boom') },
    logSystem: (line) => logs.push(line),
  })
  const value = await service.list({}, undefined)
  assert.strictEqual(value.items[0].projections.values.subagentCatalog.length, 2)
  assert.match(logs[0], /读取墓碑失败/)
})
test('installSessionListFilter：control 流里的基线投影也被过滤', async () => {
  const baseline = {
    type: 'baseline',
    value: { projections: { 'session-lead': { subagentCatalog: [{ id: 'm1' }, { id: 'm2' }] } } },
  }
  const service = {
    list: async () => ({ items: [] }),
    control: async function* () {
      yield baseline
      yield { type: 'projection', sessionId: 'session-lead', key: 'agentTeam', value: { members: [{ id: 'm1' }, { id: 'm2' }] } }
    },
  }
  assert.strictEqual(installSessionListFilter({ get: () => service }, {
    getStore: async () => ({ readAll: async () => ({ dismissed: { lead1: { m1: {} } } }) }),
    logSystem: () => {},
  }), true)
  const frames = []
  for await (const frame of service.control(new AbortController().signal)) frames.push(frame)
  assert.deepStrictEqual(frames[0].value.projections['session-lead'].subagentCatalog, [{ id: 'm2' }])
  assert.deepStrictEqual(frames[1].value.members, [{ id: 'm2' }])
})

test('installSessionListFilter：重复安装不会二次包装', () => {
  const service = { list: async () => ({ items: [] }) }
  const ctx = { get: () => service }
  const deps = { getStore: async () => ({ readAll: async () => ({ dismissed: { lead: { m1: {} } } }) }), logSystem: () => {} }
  assert.strictEqual(installSessionListFilter(ctx, deps), true)
  assert.strictEqual(installSessionListFilter(ctx, deps), false)
})
