// 名额回收：按团队生效，spawn 期间把该团队已删除成员数加到上限上。
import assert from 'node:assert'
import test from 'node:test'

import { installRosterBudget } from '../src/index.js'

function createRoster(base = 4) {
  return {
    maxMembers: base,
    membership(caller) { return { root: { id: caller.team } } },
    async spawn(caller) { return { limit: this.maxMembers, team: caller.team } },
  }
}

function deps(teams) {
  const dismissed = {}
  for (const [lead, ids] of Object.entries(teams)) {
    dismissed[lead] = Object.fromEntries(ids.map((id) => [id, {}]))
  }
  return {
    getStore: async () => ({ readAll: async () => ({ dismissed }) }),
    logSystem: () => {},
  }
}

test('installRosterBudget：名额只加在被删成员所属的团队上', async () => {
  const roster = createRoster(4)
  const refresh = installRosterBudget({ get: () => ({ roster }) }, deps({ 'team-a': ['m1'], 'team-b': [] }))
  await refresh()
  const a = await roster.spawn({ team: 'team-a' })
  const b = await roster.spawn({ team: 'team-b' })
  assert.strictEqual(a.limit, 5)
  assert.strictEqual(b.limit, 4)
  assert.strictEqual(roster.maxMembers, 4)
})

test('installRosterBudget：统计信息用于 health', async () => {
  const roster = createRoster(8)
  const refresh = installRosterBudget({ get: () => ({ roster }) }, deps({ 'team-a': ['m1', 'm2'] }))
  assert.strictEqual(await refresh(), 2)
  assert.deepStrictEqual(roster[Symbol.for('dsh.team-admin.roster-stats')](), { maxMembers: 8, reclaimed: 2, teams: { 'team-a': 2 } })
})

test('installRosterBudget：非团队成员 spawn 时按 0 额外名额处理', async () => {
  const roster = createRoster(3)
  roster.membership = () => { throw new Error('not a member') }
  installRosterBudget({ get: () => ({ roster }) }, deps({ 'team-a': ['m1'] }))
  const result = await roster.spawn({ team: 'none' })
  assert.strictEqual(result.limit, 3)
})

test('installRosterBudget：重复安装返回同一个刷新函数', () => {
  const roster = createRoster(4)
  const ctx = { get: () => ({ roster }) }
  const first = installRosterBudget(ctx, deps({ 'team-a': ['m1'] }))
  const second = installRosterBudget(ctx, deps({ 'team-a': ['m1'] }))
  assert.strictEqual(first, second)
})

test('installRosterBudget：没有 agentTeams.roster 时返回 null 并记日志', () => {
  const logs = []
  const result = installRosterBudget({ get: () => undefined }, { getStore: async () => ({}), logSystem: (line) => logs.push(line) })
  assert.strictEqual(result, null)
  assert.match(logs[0], /未找到 agentTeams\.roster/)
})

test('installRosterBudget：墓碑读取失败时保持原上限', async () => {
  const roster = createRoster(4)
  const refresh = installRosterBudget({ get: () => ({ roster }) }, {
    getStore: async () => { throw new Error('boom') },
    logSystem: () => {},
  })
  assert.strictEqual(await refresh(), 0)
  const result = await roster.spawn({ team: 'team-a' })
  assert.strictEqual(result.limit, 4)
})
