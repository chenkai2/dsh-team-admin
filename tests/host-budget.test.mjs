// 名额回收：roster 的 maxMembers 动态抬到 配置上限 + 墓碑数。
import assert from 'node:assert'
import test from 'node:test'

import { installRosterBudget } from '../src/index.js'

test('installRosterBudget：名额 = 配置上限 + 墓碑数', async () => {
  const roster = { maxMembers: 4 }
  const service = { roster }
  const ctx = { get: (name) => (name === 'agentTeams' ? service : undefined) }
  const refresh = installRosterBudget(ctx, {
    getStore: async () => ({ readAll: async () => ({ dismissed: { lead1: { m1: {} } } }) }),
    logSystem: () => {},
  })
  assert.strictEqual(typeof refresh, 'function')
  await refresh()
  assert.strictEqual(roster.maxMembers, 5)
})

test('installRosterBudget：重复安装返回同一个刷新函数，不重复定义 getter', async () => {
  const roster = { maxMembers: 8 }
  const ctx = { get: () => ({ roster }) }
  const deps = { getStore: async () => ({ readAll: async () => ({ dismissed: { lead1: { a: {}, b: {} } } }) }), logSystem: () => {} }
  const first = installRosterBudget(ctx, deps)
  const second = installRosterBudget(ctx, deps)
  assert.strictEqual(first, second)
  await second()
  assert.strictEqual(roster.maxMembers, 10)
})

test('installRosterBudget：没有 agentTeams.roster 时返回 null 并记日志', () => {
  const logs = []
  const result = installRosterBudget({ get: () => undefined }, { getStore: async () => ({}), logSystem: (line) => logs.push(line) })
  assert.strictEqual(result, null)
  assert.match(logs[0], /未找到 agentTeams\.roster/)
})

test('installRosterBudget：墓碑读取失败时保持原上限', async () => {
  const roster = { maxMembers: 4 }
  const refresh = installRosterBudget({ get: () => ({ roster }) }, {
    getStore: async () => { throw new Error('boom') },
    logSystem: () => {},
  })
  assert.strictEqual(await refresh(), 0)
  assert.strictEqual(roster.maxMembers, 4)
})
