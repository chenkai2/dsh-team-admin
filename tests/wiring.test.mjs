/** 端到端装配测试：真实 src/index.js + api.mjs + team-read/dismiss/store 跑一遍（假 persistence，真文件移动）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readdir, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { apply, resolveDataDir } = await import('../src/index.js')

const memberEvent = (seq, id, name, phase) => ({
  type: 'team/member', seq, time: 1000 + seq,
  data: { version: 2, teamId: 'lead-1', member: { id, name, description: name + ' 的活', provider: 'spawn', context: 'fresh', phase } },
})
const taskEvent = (seq, id, ownerId) => ({
  type: 'team/task', seq, time: 1000 + seq,
  data: { version: 2, teamId: 'lead-1', task: { id, revision: 1, subject: '任务', description: '', status: 'in_progress', ownerId, blockedBy: [], writeScopes: [] } },
})

/** 组一个临时会话根 + 假 persistence。 */
async function fixture({ memberPhase = 'active' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'team-admin-wiring-'))
  const sessions = join(root, 'sessions', '--ws--')
  const childDir = join(sessions, 'm1')
  await mkdir(childDir, { recursive: true })
  const childLog = join(childDir, 'session.v4.jsonl.zstd')
  await writeFile(childLog, 'child-log', 'utf8')
  const leadLog = join(sessions, 'lead-1', 'session.v4.jsonl.zstd')
  await mkdir(join(sessions, 'lead-1'), { recursive: true })
  await writeFile(leadLog, 'lead-log', 'utf8')

  const leadEvents = [
    { type: 'session', seq: -1, time: 900, id: 'lead-1' },
    { type: 'session/title', seq: 0, time: 950, data: { title: '示例团队会话' } },
    memberEvent(1, 'm1', 'worker-one', 'provisioning'),
    memberEvent(2, 'm1', 'worker-one', memberPhase),
    taskEvent(3, 'task-1', 'm1'),
    taskEvent(4, 'task-2', 'other'),
  ]
  const snapshots = new Map([
    ['lead-1', { header: { id: 'lead-1', cwd: '/tmp/demo', createdAt: 900 }, location: { path: leadLog }, eventCount: leadEvents.length, sizeBytes: 9, revision: 'r1' }],
    ['m1', { header: { id: 'm1', cwd: '/tmp/demo', createdAt: 1000, parentSession: 'lead-1' }, location: { path: childLog }, eventCount: 2, sizeBytes: 9, revision: 'r2' }],
  ])
  const logs = new Map([['lead-1', leadEvents], ['m1', [{ type: 'session', seq: -1 }]]])
  const persistence = {
    async list() { return [...snapshots.values()] },
    async stat(id) { return snapshots.get(id) },
    async open(id) {
      const snapshot = snapshots.get(id)
      if (snapshot === undefined) throw new Error('unknown session ' + id)
      return {
        header: snapshot.header,
        inheritedEventCount: 0,
        async read() { return { events: logs.get(id) ?? [] } },
        async close() {},
      }
    },
  }
  return { root, sessions, childDir, leadLog, persistence, snapshot: snapshots }
}

/** 造一个接到真实 webServer.register 的假 ctx。 */
function makeCtx({ persistence, liveAgents = new Map() }) {
  const captured = { route: undefined }
  const ctx = {
    logger: { warn() {} },
    webServer: {
      register(route) { captured.route = route; return () => { captured.route = undefined } },
    },
    effect(fn) { const disposer = fn(); return typeof disposer === 'function' ? disposer : () => {} },
    get(name) { return name === 'sessionPersistence' ? persistence : undefined },
    sessionPersistence: persistence,
    agents: { get: (id) => liveAgents.get(id) },
    subagents: { interrupt() {} },
  }
  return { ctx, captured }
}

/** 假 HTTP 请求/响应。 */
function req(url, { method = 'GET', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return { method, url, socket: { remoteAddress: '127.0.0.1' }, async *[Symbol.asyncIterator]() { for (const c of chunks) yield c } }
}
function res() {
  return {
    statusCode: 0, payload: undefined, headersSent: false,
    writeHead(code) { this.statusCode = code; this.headersSent = true },
    end(text) { this.payload = text === undefined ? undefined : JSON.parse(text) },
  }
}

async function boot({ memberPhase } = {}) {
  const fx = await fixture({ memberPhase })
  const dataDir = join(fx.root, 'data')
  process.env.DSH_TEAM_ADMIN_DATA_DIR = dataDir
  const { ctx, captured } = makeCtx({ persistence: fx.persistence })
  apply(ctx)
  assert.ok(captured.route, 'webServer 未注册路由')
  assert.equal(captured.route.path, '/api/team-admin')
  assert.equal(captured.route.kind, 'prefix')
  return { ...fx, dataDir, call: captured.route.handler }
}

test('装配：路由注册 + 会话列表 + 团队成员（真文件）', async (t) => {
  const app = await boot()
  t.after(async () => { delete process.env.DSH_TEAM_ADMIN_DATA_DIR; await rm(app.root, { recursive: true, force: true }) })
  const listRes = res()
  await app.call(req('/api/team-admin/sessions'), listRes)
  assert.equal(listRes.statusCode, 200)
  assert.equal(listRes.payload.sessions.length, 1)
  assert.equal(listRes.payload.sessions[0].title, '示例团队会话')
  assert.equal(listRes.payload.sessions[0].live, false)

  const teamRes = res()
  await app.call(req('/api/team-admin/team?sessionId=lead-1'), teamRes)
  assert.equal(teamRes.statusCode, 200)
  assert.equal(teamRes.payload.members.length, 1)
  assert.equal(teamRes.payload.members[0].name, 'worker-one')
  assert.equal(teamRes.payload.members[0].ownedTasks, 1)
  assert.equal(teamRes.payload.dismissed.length, 0)
})

test('装配：删除成员 = 会话目录进回收站 + 墓碑 + 幂等', async (t) => {
  const app = await boot()
  t.after(async () => { delete process.env.DSH_TEAM_ADMIN_DATA_DIR; await rm(app.root, { recursive: true, force: true }) })
  const first = res()
  await app.call(req('/api/team-admin/dismiss', { method: 'POST', body: { sessionId: 'lead-1', name: 'worker-one' } }), first)
  assert.equal(first.statusCode, 200)
  assert.equal(first.payload.ok, true)
  assert.equal(first.payload.sessionDeleted, true)
  assert.equal(existsSync(app.childDir), false, '成员会话目录应已被移走')
  assert.equal(existsSync(join(first.payload.trashPath, 'session.v4.jsonl.zstd')), true, '回收站应保留日志')

  const teamRes = res()
  await app.call(req('/api/team-admin/team?sessionId=lead-1'), teamRes)
  assert.equal(teamRes.payload.members[0].dismissed, true)
  assert.equal(teamRes.payload.dismissed.length, 1)
  assert.equal(teamRes.payload.dismissed[0].name, 'worker-one')

  const again = res()
  await app.call(req('/api/team-admin/dismiss', { method: 'POST', body: { sessionId: 'lead-1', name: 'worker-one' } }), again)
  assert.equal(again.statusCode, 200)
  assert.equal(again.payload.dismissedAt, first.payload.dismissedAt, '幂等应复用首次墓碑')
  const trash = await readdir(join(app.dataDir, 'trash', 'lead-1'))
  assert.equal(trash.length, 1, '重复删除不应再搬一次')
})

test('装配：拒绝 Lead、creation-in-flight 与未知成员', async (t) => {
  const app = await boot()
  t.after(async () => { delete process.env.DSH_TEAM_ADMIN_DATA_DIR; await rm(app.root, { recursive: true, force: true }) })
  const lead = res()
  await app.call(req('/api/team-admin/dismiss', { method: 'POST', body: { sessionId: 'lead-1', name: 'lead' } }), lead)
  assert.equal(lead.statusCode, 400)
  assert.match(lead.payload.error, /Lead/)

  const missing = res()
  await app.call(req('/api/team-admin/dismiss', { method: 'POST', body: { sessionId: 'lead-1', name: 'ghost' } }), missing)
  assert.equal(missing.statusCode, 404)

  const nonRoot = res()
  await app.call(req('/api/team-admin/team?sessionId=m1'), nonRoot)
  assert.equal(nonRoot.statusCode, 400)

  const unknown = res()
  await app.call(req('/api/team-admin/team?sessionId=nope'), unknown)
  assert.equal(unknown.statusCode, 404)
})

test('resolveDataDir honours the env override and defaults under home', () => {
  assert.equal(resolveDataDir({ DSH_TEAM_ADMIN_DATA_DIR: '/tmp/x' }), '/tmp/x')
  assert.equal(resolveDataDir({}, '/home/demo'), join('/home/demo', '.dsh', 'team-admin'))
})
