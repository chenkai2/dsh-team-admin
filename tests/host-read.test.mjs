import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdminError } from '../src/error.mjs'
import { listTeamSessions, parseRoster, readTeam } from '../src/team-read.mjs'

/** 临时根目录夹具：用后自动清理。 */
async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'team-admin-read-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 造一个持久化快照（header + location）。 */
function snapshot({ id, cwd = '/work', createdAt = 1, parentSession, path }) {
  return {
    header: {
      version: 4,
      id,
      createdAt,
      cwd,
      isSeeded: false,
      delegationDepth: parentSession === undefined ? 0 : 1,
      ...parentSession === undefined ? {} : { parentSession },
    },
    revision: 'r1',
    location: path === undefined ? undefined : { kind: 'jsonl', path },
  }
}

/** 假 sessionPersistence：list/stat/open 三者足够本模块使用（listCalls 用于断言缓存命中）。 */
function fakePersistence({ snapshots, logs = new Map(), opens = [] }) {
  const byId = new Map(snapshots.map((item) => [item.header.id, item]))
  const api = {
    listCalls: 0,
    async list() {
      api.listCalls += 1
      return snapshots.slice()
    },
    async stat(id) {
      return byId.get(id)
    },
    async open(id) {
      opens.push(id)
      const found = byId.get(id)
      if (found === undefined) {
        const error = new Error('session not found: ' + id)
        error.name = 'SessionPersistenceNotFoundError'
        throw error
      }
      const events = logs.get(id) ?? []
      return {
        header: found.header,
        async read(offset = 0, length) {
          return { events: events.slice(offset, length === undefined ? undefined : offset + length) }
        },
        async close() {},
      }
    },
  }
  return api
}

/** 假 agents 服务。 */
function fakeAgents(agents = new Map()) {
  return {
    agents,
    service: { get: (id) => agents.get(id) },
  }
}

/** 假 ctx：可选服务都经 ctx.get 取。 */
function fakeCtx({ persistence, agents, sessionQuery, projections }) {
  const services = { sessionPersistence: persistence }
  if (agents !== undefined) services.agents = agents
  if (sessionQuery !== undefined) services.sessionQuery = sessionQuery
  if (projections !== undefined) services.sessionProjectionCache = projections
  return { get: (name) => services[name] }
}

/** 在磁盘上造一个文件并设定 mtime，返回值路径。 */
async function touch(path, mtimeMs) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '{}\n', 'utf8')
  const when = new Date(mtimeMs)
  await utimes(path, when, when)
  return path
}

test('parseRoster folds the last member snapshot, the max task revision and the last title', () => {
  const events = [
    { type: 'team/member', seq: 1, time: 1, data: { version: 2, teamId: 'lead-1', member: { id: 'c1', name: 'qa', description: 'd1', provider: 'spawn', context: 'fresh', phase: 'provisioning' } } },
    { type: 'team/task', seq: 2, time: 2, data: { version: 2, teamId: 'lead-1', task: { id: 't1', revision: 1, subject: 's1', description: 'd', status: 'in_progress', ownerId: 'c1', blockedBy: [], writeScopes: [] } } },
    { type: 'session/title', seq: 3, time: 3, data: { title: '旧标题' } },
    { type: 'team/member', seq: 4, time: 4, data: { version: 2, teamId: 'lead-1', member: { id: 'c1', name: 'qa', description: 'd2', provider: 'spawn', context: 'fresh', phase: 'active' } } },
    { type: 'team/task', seq: 5, time: 5, data: { version: 2, teamId: 'lead-1', task: { id: 't1', revision: 3, subject: 's3', description: 'd', status: 'completed', ownerId: 'c1', blockedBy: [], writeScopes: ['src/'] } } },
    { type: 'team/task', seq: 6, time: 6, data: { version: 2, teamId: 'lead-1', task: { id: 't2', revision: 1, subject: 'gone', description: 'd', status: 'deleted', blockedBy: [], writeScopes: [] } } },
    { type: 'session/title', seq: 7, time: 7, data: { title: '新标题' } },
    { type: 'user/message', seq: 8, time: 8, data: { content: [{ type: 'text', text: '先别用这条' }] } },
    { type: 'team/member', seq: 9, time: 9, data: { teamId: 'lead-1' } },
    null,
    { type: 'team/member', seq: 10, time: 10, data: null },
  ]
  const roster = parseRoster(events)
  assert.equal(roster.title, '新标题')
  assert.equal(roster.members.length, 1)
  assert.equal(roster.members[0].phase, 'active')
  assert.equal(roster.members[0].description, 'd2')
  assert.deepEqual(roster.tasks.map((task) => [task.id, task.revision, task.status]), [['t1', 3, 'completed']])
  assert.deepEqual(parseRoster([]), { members: [], tasks: [] })
})

test('listTeamSessions lists roots only, newest activity first, titles from sessionQuery', async (t) => {
  const root = await tempRoot(t)
  const leadA = await touch(join(root, 'proj', 'lead-a', 'v4.jsonl'), Date.now() - 10_000)
  const leadB = await touch(join(root, 'proj', 'lead-b', 'v4.jsonl'), Date.now() - 1_000)
  const child = await touch(join(root, 'proj', 'child-1', 'v4.jsonl'), Date.now())
  const persistence = fakePersistence({
    snapshots: [
      snapshot({ id: 'lead-a', createdAt: 100, cwd: '/tmp/alpha', path: leadA }),
      snapshot({ id: 'lead-b', createdAt: 200, cwd: '/tmp/beta', path: leadB }),
      snapshot({ id: 'child-1', createdAt: 300, parentSession: 'lead-a', path: child }),
    ],
  })
  const queries = []
  const sessionQuery = {
    async readTitleSnapshots(ids) {
      queries.push(ids.slice())
      return ids.map((id) => ({ sessionId: id, status: 'fulfilled', value: { title: { title: id === 'lead-a' ? 'Alpha 团队' : 'Beta 团队' } } }))
    },
  }
  const agents = new Map([['lead-b', { status: 'running', options: {} }]])
  const ctx = fakeCtx({ persistence, agents: fakeAgents(agents).service, sessionQuery })

  const rows = await listTeamSessions(ctx, {})
  assert.deepEqual(rows.map((row) => row.id), ['lead-b', 'lead-a'])
  assert.deepEqual(rows.map((row) => row.title), ['Beta 团队', 'Alpha 团队'])
  assert.equal(rows[0].cwd, '/tmp/beta')
  assert.equal(rows[0].live, true)
  assert.equal(rows[1].live, false)
  assert.equal(rows[1].createdAt, 100)
  assert.ok(rows[0].lastActivityAt > rows[1].lastActivityAt)
  assert.deepEqual(queries[0].sort(), ['lead-a', 'lead-b'])

  const filtered = await listTeamSessions(ctx, { query: 'ALPHA' })
  assert.deepEqual(filtered.map((row) => row.id), ['lead-a'])
  const byCwd = await listTeamSessions(ctx, { query: 'beta' })
  assert.deepEqual(byCwd.map((row) => row.id), ['lead-b'])
  const byId = await listTeamSessions(ctx, { query: 'lead-a' })
  assert.deepEqual(byId.map((row) => row.id), ['lead-a'])
  assert.deepEqual(await listTeamSessions(ctx, { query: 'nope' }), [])

  const limited = await listTeamSessions(ctx, { limit: 1 })
  assert.deepEqual(limited.map((row) => row.id), ['lead-b'])
  const clamped = await listTeamSessions(ctx, { limit: 9999 })
  assert.equal(clamped.length, 2)
})

test('listTeamSessions folds titles from logs when sessionQuery is absent and caches them', async (t) => {
  const root = await tempRoot(t)
  const leadA = await touch(join(root, 'proj', 'lead-a', 'v4.jsonl'), Date.now())
  const leadB = await touch(join(root, 'proj', 'lead-b', 'v4.jsonl'), Date.now() - 5_000)
  const leadC = await touch(join(root, 'proj', 'lead-c', 'v4.jsonl'), Date.now() - 6_000)
  const logs = new Map([
    ['lead-a', [{ type: 'session/title', seq: 1, time: 1, data: { title: '日志里的标题' } }]],
    ['lead-b', [{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: '这是第一条用户消息，用来兜底标题的四十字以内文本内容' }] } }]],
    ['lead-c', []],
  ])
  const persistence = fakePersistence({
    snapshots: [
      snapshot({ id: 'lead-a', path: leadA }),
      snapshot({ id: 'lead-b', path: leadB }),
      snapshot({ id: 'lead-c', path: leadC }),
    ],
    logs,
  })
  const ctx = fakeCtx({ persistence })
  const rows = await listTeamSessions(ctx, {})
  assert.deepEqual(rows.map((row) => row.title), ['日志里的标题', '这是第一条用户消息，用来兜底标题的四十字以内文本内容', 'lead-c'])
  assert.deepEqual([...logs.keys()].sort(), ['lead-a', 'lead-b', 'lead-c'])

  // 第二次调用走 TTL 缓存：没有新的 open
  const opens = []
  persistence.open = (id) => { opens.push(id); return Promise.reject(new Error('should not reopen')) }
  const again = await listTeamSessions(ctx, {})
  assert.deepEqual(again.map((row) => row.title), ['日志里的标题', '这是第一条用户消息，用来兜底标题的四十字以内文本内容', 'lead-c'])
  assert.deepEqual(opens, [])
})

test('listTeamSessions rejects a ctx without sessionPersistence', async () => {
  await assert.rejects(() => listTeamSessions({ get: () => undefined }, {}), (error) => {
    assert.ok(error instanceof AdminError)
    assert.equal(error.status, 500)
    return true
  })
})

test('readTeam maps members, tasks and tombstones', async (t) => {
  const root = await tempRoot(t)
  const leadPath = await touch(join(root, 'proj', 'lead-1', 'v4.jsonl'), Date.now())
  const childPath = await touch(join(root, 'proj', 'child-1', 'v4.jsonl'), Date.now() - 60_000)
  const leadEvents = [
    { type: 'session/title', seq: 1, time: 1, data: { title: '作战团队' } },
    { type: 'team/member', seq: 2, time: 2, data: { version: 2, teamId: 'lead-1', member: { id: 'child-1', name: 'qa', description: '验收', provider: 'spawn', context: 'fork', phase: 'active' } } },
    { type: 'team/member', seq: 3, time: 3, data: { version: 2, teamId: 'lead-1', member: { id: 'child-2', name: 'ops', description: '部署', provider: 'spawn', context: 'fresh', phase: 'failed', error: '创建失败' } } },
    { type: 'team/member', seq: 4, time: 4, data: { version: 2, teamId: 'lead-1', member: { id: 'child-3', name: 'slow', description: '慢', provider: 'spawn', context: 'fresh', phase: 'active' } } },
    { type: 'team/task', seq: 5, time: 5, data: { version: 2, teamId: 'lead-1', task: { id: 't1', revision: 1, subject: 's', description: 'd', status: 'in_progress', ownerId: 'child-1', blockedBy: [], writeScopes: [] } } },
    { type: 'team/task', seq: 6, time: 6, data: { version: 2, teamId: 'lead-1', task: { id: 't2', revision: 2, subject: 's', description: 'd', status: 'completed', ownerId: 'child-1', blockedBy: [], writeScopes: [] } } },
    { type: 'team/task', seq: 7, time: 7, data: { version: 2, teamId: 'lead-1', task: { id: 't3', revision: 1, subject: 's', description: 'd', status: 'deleted', ownerId: 'child-2', blockedBy: [], writeScopes: [] } } },
  ]
  const persistence = fakePersistence({
    snapshots: [
      snapshot({ id: 'lead-1', createdAt: 100, cwd: '/tmp/team', path: leadPath }),
      snapshot({ id: 'child-1', parentSession: 'lead-1', path: childPath }),
    ],
    logs: new Map([['lead-1', leadEvents]]),
  })
  const agents = new Map([['child-1', { status: 'running', options: { model: 'deepseek-flash' } }]])
  const store = {
    async listDismissed(leadId) {
      assert.equal(leadId, 'lead-1')
      return [{ id: 'child-3', name: 'slow', dismissedAt: 900, sessionDeleted: true, trashPath: '/trash/child-3' }]
    },
  }
  const ctx = fakeCtx({ persistence, agents: fakeAgents(agents).service })
  const team = await readTeam(ctx, { sessionId: 'lead-1', store })

  assert.equal(team.session.title, '作战团队')
  assert.equal(team.session.cwd, '/tmp/team')
  assert.equal(team.session.live, false)
  assert.deepEqual(team.members.map((member) => member.name), ['qa', 'ops', 'slow'])
  const [qa, ops, slow] = team.members
  assert.equal(qa.status, 'running')
  assert.equal(qa.phase, 'active')
  assert.equal(qa.model, 'deepseek-flash')
  assert.equal(qa.sessionExists, true)
  assert.equal(qa.ownedTasks, 2)
  assert.equal(qa.dismissed, false)
  assert.ok(qa.lastActivityAt > 0)
  assert.equal(ops.status, 'failed')
  assert.equal(ops.error, '创建失败')
  assert.equal(ops.sessionExists, false)
  assert.equal(ops.lastActivityAt, null)
  assert.equal(slow.status, 'inactive')
  assert.equal(slow.dismissed, true)
  assert.deepEqual(team.dismissed, [{ name: 'slow', id: 'child-3', dismissedAt: 900, sessionDeleted: true, trashPath: '/trash/child-3', memberStillInRoster: true }])
})

test('readTeam rejects unknown and non-root sessions', async (t) => {
  const root = await tempRoot(t)
  const leadPath = await touch(join(root, 'proj', 'lead-1', 'v4.jsonl'), Date.now())
  const persistence = fakePersistence({
    snapshots: [
      snapshot({ id: 'lead-1', path: leadPath }),
      snapshot({ id: 'child-1', parentSession: 'lead-1' }),
    ],
    logs: new Map([['lead-1', []]]),
  })
  const ctx = fakeCtx({ persistence })
  await assert.rejects(() => readTeam(ctx, { sessionId: 'missing' }), (error) => {
    assert.ok(error instanceof AdminError)
    assert.equal(error.code, 'not-found')
    assert.equal(error.status, 404)
    assert.equal(error.message, '会话不存在')
    return true
  })
  await assert.rejects(() => readTeam(ctx, { sessionId: 'child-1' }), (error) => {
    assert.ok(error instanceof AdminError)
    assert.equal(error.code, 'bad-session')
    assert.equal(error.status, 400)
    assert.equal(error.message, '只能管理根会话的团队')
    return true
  })
})
test('listTeamSessions caches the scan: repeat calls skip persistence.list and still filter correctly', async (t) => {
  const root = await tempRoot(t)
  const leadA = await touch(join(root, 'proj', 'lead-a', 'v4.jsonl'), Date.now())
  const leadB = await touch(join(root, 'proj', 'lead-b', 'v4.jsonl'), Date.now() - 5_000)
  const persistence = fakePersistence({
    snapshots: [
      snapshot({ id: 'lead-a', createdAt: 100, cwd: '/tmp/alpha', path: leadA }),
      snapshot({ id: 'lead-b', createdAt: 200, cwd: '/tmp/beta', path: leadB }),
    ],
  })
  const projections = {
    cachedSnapshot(header) {
      const titles = { 'lead-a': 'Alpha 团队', 'lead-b': 'Beta 团队' }
      return { asOfSeq: 1, values: { title: titles[header.id] ?? null } }
    },
  }
  const ctx = fakeCtx({ persistence, projections })

  const first = await listTeamSessions(ctx, {})
  assert.equal(persistence.listCalls, 1)
  assert.deepEqual(first.map((row) => row.id), ['lead-a', 'lead-b'])
  assert.deepEqual(first.map((row) => row.title), ['Alpha 团队', 'Beta 团队'])

  // 命中缓存：不再 list()，limit 在缓存结果上应用
  const limited = await listTeamSessions(ctx, { limit: 1 })
  assert.equal(persistence.listCalls, 1)
  assert.deepEqual(limited.map((row) => row.id), ['lead-a'])

  // 命中缓存：query 也在缓存结果上过滤
  const filtered = await listTeamSessions(ctx, { query: 'beta' })
  assert.equal(persistence.listCalls, 1)
  assert.deepEqual(filtered.map((row) => row.id), ['lead-b'])
  const byTitle = await listTeamSessions(ctx, { query: 'ALPHA' })
  assert.equal(persistence.listCalls, 1)
  assert.deepEqual(byTitle.map((row) => row.id), ['lead-a'])
})

test('concurrent cold calls share one scan', async (t) => {
  const root = await tempRoot(t)
  const leadA = await touch(join(root, 'proj', 'lead-a', 'v4.jsonl'), Date.now())
  const persistence = fakePersistence({
    snapshots: [snapshot({ id: 'lead-a', path: leadA })],
  })
  const ctx = fakeCtx({ persistence })
  const [one, two, three] = await Promise.all([
    listTeamSessions(ctx, {}),
    listTeamSessions(ctx, {}),
    listTeamSessions(ctx, {}),
  ])
  assert.equal(persistence.listCalls, 1)
  assert.deepEqual(one.map((row) => row.id), ['lead-a'])
  assert.deepEqual(two.map((row) => row.id), ['lead-a'])
  assert.deepEqual(three.map((row) => row.id), ['lead-a'])
})

test('expired scan cache is rescanned', async (t) => {
  const root = await tempRoot(t)
  const leadA = await touch(join(root, 'proj', 'lead-a', 'v4.jsonl'), Date.now())
  const persistence = fakePersistence({
    snapshots: [snapshot({ id: 'lead-a', path: leadA })],
  })
  const ctx = fakeCtx({ persistence })
  await listTeamSessions(ctx, {})
  assert.equal(persistence.listCalls, 1)
  await listTeamSessions(ctx, { maxAgeMs: 0 })
  assert.equal(persistence.listCalls, 2)
  await listTeamSessions(ctx, {})
  assert.equal(persistence.listCalls, 2)
})

test('titles come from the host projection cache without reading logs', async (t) => {
  const root = await tempRoot(t)
  const opens = []
  const leadA = await touch(join(root, 'proj', 'lead-a', 'v4.jsonl'), Date.now())
  const leadB = await touch(join(root, 'proj', 'lead-b', 'v4.jsonl'), Date.now() - 1_000)
  const persistence = fakePersistence({
    snapshots: [
      snapshot({ id: 'lead-a', path: leadA }),
      snapshot({ id: 'lead-b', path: leadB }),
    ],
    opens,
  })
  const seen = []
  const projections = {
    cachedSnapshot(header, keys) {
      seen.push(header.id)
      assert.deepEqual(keys, ['title'])
      const titles = { 'lead-a': '投影里的标题', 'lead-b': '另一条投影标题' }
      return { asOfSeq: 1, values: { title: titles[header.id] ?? null } }
    },
  }
  const ctx = fakeCtx({ persistence, projections })
  const rows = await listTeamSessions(ctx, {})
  assert.deepEqual(rows.map((row) => row.title), ['投影里的标题', '另一条投影标题'])
  assert.deepEqual(seen.sort(), ['lead-a', 'lead-b'])
  assert.deepEqual(opens, [])
})

test('readTeam exposes sizes and reuses the cached scan for member sessions', async (t) => {
  const root = await tempRoot(t)
  const leadPath = await touch(join(root, 'proj', 'lead-1', 'v4.jsonl'), Date.now())
  const childPath = await touch(join(root, 'proj', 'c1', 'v4.jsonl'), Date.now() - 30_000)
  const persistence = fakePersistence({
    snapshots: [
      snapshot({ id: 'lead-1', path: leadPath }),
      snapshot({ id: 'c1', parentSession: 'lead-1', path: childPath }),
    ],
    logs: new Map([['lead-1', [
      { type: 'team/member', seq: 1, time: 1, data: { version: 2, teamId: 'lead-1', member: { id: 'c1', name: 'qa', description: '验收', provider: 'spawn', context: 'fresh', phase: 'active' } } },
    ]]]),
  })
  const ctx = fakeCtx({ persistence })
  const store = { async listDismissed() { return [] } }
  const team = await readTeam(ctx, { sessionId: 'lead-1', store })
  assert.equal(team.members[0].sessionExists, true)
  assert.ok(team.members[0].lastActivityAt > 0)
  // 团队详情与之后的列表共用同一次扫描
  await listTeamSessions(ctx, {})
  assert.equal(persistence.listCalls, 1)
})
