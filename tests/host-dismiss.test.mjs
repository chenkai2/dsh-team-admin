import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { AdminError } from '../src/error.mjs'
import { dismissMember, moveSessionArtifact } from '../src/dismiss.mjs'
import { openStore } from '../src/store.mjs'

/** 临时根目录夹具：用后自动清理。 */
async function tempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'team-admin-dismiss-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** 造一个持久化快照。 */
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

/** 假 sessionPersistence。 */
function fakePersistence({ snapshots, logs = new Map() }) {
  const byId = new Map(snapshots.map((item) => [item.header.id, item]))
  return {
    async list() {
      return snapshots.slice()
    },
    async stat(id) {
      return byId.get(id)
    },
    async open(id) {
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
}

/** lead 日志：一个正常成员、一个创建中成员、一个常驻运行成员。 */
function leadEvents() {
  return [
    { type: 'session/title', seq: 1, time: 1, data: { title: '测试团队' } },
    { type: 'team/member', seq: 2, time: 2, data: { version: 2, teamId: 'lead-1', member: { id: 'c1', name: 'qa', description: '验收', provider: 'spawn', context: 'fresh', phase: 'active' } } },
    { type: 'team/member', seq: 3, time: 3, data: { version: 2, teamId: 'lead-1', member: { id: 'c2', name: 'ops', description: '部署', provider: 'spawn', context: 'fresh', phase: 'provisioning' } } },
    { type: 'team/member', seq: 4, time: 4, data: { version: 2, teamId: 'lead-1', member: { id: 'c3', name: 'slow', description: '常驻', provider: 'spawn', context: 'fresh', phase: 'active' } } },
  ]
}

/**
 * 造一套完整夹具：磁盘上的会话目录 + 假 persistence + 假 agents/subagents + 真实墓碑 store。
 * @returns {Promise<object>} 夹具对象。
 */
async function fixture(t) {
  const root = await tempRoot(t)
  const dataDir = join(root, 'data')
  const sessionsRoot = join(root, 'sessions')
  const paths = {}
  for (const id of ['lead-1', 'c1', 'c2', 'c3']) {
    const dir = join(sessionsRoot, 'proj', id)
    await mkdir(dir, { recursive: true })
    paths[id] = join(dir, 'v4.jsonl')
    await writeFile(paths[id], JSON.stringify({ id }) + '\n', 'utf8')
  }
  const persistence = fakePersistence({
    snapshots: [
      snapshot({ id: 'lead-1', path: paths['lead-1'] }),
      snapshot({ id: 'c1', parentSession: 'lead-1', path: paths.c1 }),
      snapshot({ id: 'c2', parentSession: 'lead-1', path: paths.c2 }),
      snapshot({ id: 'c3', parentSession: 'lead-1', path: paths.c3 }),
    ],
    logs: new Map([['lead-1', leadEvents()]]),
  })
  const agents = new Map([
    ['lead-1', { status: 'idle', options: {} }],
    ['c1', { status: 'running', options: {} }],
  ])
  const interruptCalls = []
  const drainCalls = []
  const drainState = { handler: undefined }
  const subagents = {
    interrupt(id, authority) {
      interruptCalls.push({ id, authority })
      const agent = agents.get(id)
      if (agent !== undefined) agent.status = 'idle'
    },
    async drainChildren(parent, childIds) {
      drainCalls.push({ parent, childIds })
      if (drainState.handler !== undefined) await drainState.handler()
    },
  }
  const ctx = {
    get(name) {
      if (name === 'sessionPersistence') return persistence
      if (name === 'agents') return { get: (id) => agents.get(id) }
      if (name === 'subagents') return subagents
      return undefined
    },
  }
  return {
    root,
    dataDir,
    sessionsRoot,
    paths,
    persistence,
    agents,
    interruptCalls,
    drainCalls,
    setDrain(handler) {
      drainState.handler = handler
    },
    subagents,
    ctx,
    store: await openStore({ dir: dataDir }),
  }
}

test('refuses to dismiss the Lead by name', async () => {
  await assert.rejects(
    () => dismissMember({}, { sessionId: 'lead-1', name: 'lead' }, { store: {} }),
    (error) => {
      assert.ok(error instanceof AdminError)
      assert.equal(error.code, 'lead')
      assert.equal(error.status, 400)
      assert.equal(error.message, '不能删除 Lead')
      return true
    },
  )
})

test('rejects unknown, non-root and member-less sessions', async (t) => {
  const f = await fixture(t)
  await assert.rejects(() => dismissMember(f.ctx, { sessionId: 'missing', name: 'qa' }, { store: f.store }), (error) => {
    assert.equal(error.code, 'not-found')
    assert.equal(error.status, 404)
    assert.equal(error.message, '会话不存在')
    return true
  })
  const childCtx = {
    get: (name) => (name === 'sessionPersistence'
      ? { stat: async () => snapshot({ id: 'c1', parentSession: 'lead-1' }) }
      : undefined),
  }
  await assert.rejects(() => dismissMember(childCtx, { sessionId: 'c1', name: 'qa' }, { store: f.store }), (error) => {
    assert.equal(error.code, 'bad-session')
    assert.equal(error.status, 400)
    return true
  })
  await assert.rejects(() => dismissMember(f.ctx, { sessionId: 'lead-1', name: 'nobody' }, { store: f.store }), (error) => {
    assert.equal(error.code, 'not-found')
    assert.equal(error.message, '团队成员不存在')
    return true
  })
})

test('rejects a member still provisioning', async (t) => {
  const f = await fixture(t)
  await assert.rejects(() => dismissMember(f.ctx, { sessionId: 'lead-1', name: 'ops' }, { store: f.store }), (error) => {
    assert.equal(error.code, 'provisioning')
    assert.equal(error.status, 409)
    assert.equal(error.message, '成员正在创建中，请稍后再试')
    return true
  })
  assert.deepEqual(await f.store.listDismissed('lead-1'), [])
  assert.deepEqual((await readdir(f.sessionsRoot)).length > 0, true)
})

test('stops a running member, moves its session directory to trash and records a tombstone', async (t) => {
  const f = await fixture(t)
  const result = await dismissMember(
    f.ctx,
    { sessionId: 'lead-1', name: 'qa' },
    { store: f.store, now: () => 1_700_000_000_000 },
  )

  assert.deepEqual(f.interruptCalls.map((call) => call.id), ['c1'])
  assert.equal(f.interruptCalls[0].authority.kind, 'ancestor')
  assert.equal(result.name, 'qa')
  assert.equal(result.id, 'c1')
  assert.equal(result.stopped, true)
  assert.equal(result.sessionDeleted, true)
  assert.equal(result.dismissedAt, 1_700_000_000_000)
  const expectedTrash = join(f.dataDir, 'trash', 'lead-1', 'c1-1700000000000')
  assert.equal(result.trashPath, expectedTrash)
  assert.deepEqual(await readdir(expectedTrash), ['v4.jsonl'])
  await assert.rejects(() => access(join(f.sessionsRoot, 'proj', 'c1')), { code: 'ENOENT' })
  // 根会话与其它成员的会话不受影响
  assert.equal((await stat(join(f.sessionsRoot, 'proj', 'lead-1', 'v4.jsonl'))).isFile(), true)
  assert.equal((await stat(join(f.sessionsRoot, 'proj', 'c3', 'v4.jsonl'))).isFile(), true)

  assert.deepEqual(await f.store.listDismissed('lead-1'), [{
    id: 'c1',
    name: 'qa',
    dismissedAt: 1_700_000_000_000,
    sessionDeleted: true,
    trashPath: expectedTrash,
  }])

  // 移动成功后释放子会话的 Activation 注册（GUI 子智能体选择器不再残留该条目）
  assert.equal(f.drainCalls.length, 1)
  assert.equal(f.drainCalls[0].parent, f.agents.get('lead-1'))
  assert.deepEqual(f.drainCalls[0].childIds, ['c1'])
})

test('a failing drain keeps the deletion and tombstone intact', async (t) => {
  const f = await fixture(t)
  f.setDrain(async () => {
    throw new Error('drain exploded')
  })
  f.agents.get('c1').status = 'running'
  const logged = []
  const result = await dismissMember(
    f.ctx,
    { sessionId: 'lead-1', name: 'qa' },
    { store: f.store, now: () => 5, logSystem: (line) => logged.push(line) },
  )
  assert.equal(result.sessionDeleted, true)
  assert.equal(f.drainCalls.length, 1)
  await assert.rejects(() => access(join(f.sessionsRoot, 'proj', 'c1')), { code: 'ENOENT' })
  assert.deepEqual(await f.store.listDismissed('lead-1'), [{
    id: 'c1',
    name: 'qa',
    dismissedAt: 5,
    sessionDeleted: true,
    trashPath: join(f.dataDir, 'trash', 'lead-1', 'c1-5'),
  }])
  assert.ok(logged.some((line) => line.includes('释放子会话激活')), 'drain failure must be logged')
})

test('drain is skipped when the host has no drainChildren method', async (t) => {
  const f = await fixture(t)
  f.agents.get('c1').status = 'idle'
  const original = f.ctx.get
  f.ctx.get = (name) => (name === 'subagents' ? {} : original(name))
  const result = await dismissMember(f.ctx, { sessionId: 'lead-1', name: 'qa' }, { store: f.store, now: () => 6 })
  assert.equal(result.sessionDeleted, true)
  assert.equal(f.drainCalls.length, 0)
})

test('the idempotent repeat path does not drain again', async (t) => {
  const f = await fixture(t)
  f.agents.get('c1').status = 'idle'
  await dismissMember(f.ctx, { sessionId: 'lead-1', name: 'qa' }, { store: f.store, now: () => 8 })
  assert.equal(f.drainCalls.length, 1)
  await dismissMember(f.ctx, { sessionId: 'lead-1', name: 'qa' }, { store: f.store, now: () => 9 })
  assert.equal(f.drainCalls.length, 1)
})

test('no drain when the child session was never moved', async (t) => {
  const f = await fixture(t)
  f.agents.get('c1').status = 'idle'
  const result = await dismissMember(
    f.ctx,
    { sessionId: 'lead-1', name: 'qa', deleteSession: false },
    { store: f.store, now: () => 10 },
  )
  assert.equal(result.sessionDeleted, false)
  assert.equal(f.drainCalls.length, 0)
})

test('dismissing twice is idempotent and does not move a second time', async (t) => {
  const f = await fixture(t)
  const first = await dismissMember(f.ctx, { sessionId: 'lead-1', name: 'qa' }, { store: f.store, now: () => 42 })
  const second = await dismissMember(f.ctx, { sessionId: 'lead-1', name: 'qa' }, { store: f.store, now: () => 99 })
  assert.equal(second.dismissedAt, first.dismissedAt)
  assert.equal(second.stopped, false)
  assert.equal(second.sessionDeleted, true)
  assert.equal(second.trashPath, first.trashPath)
  assert.deepEqual(await readdir(join(f.dataDir, 'trash', 'lead-1')), ['c1-42'])
  assert.equal((await f.store.listDismissed('lead-1')).length, 1)
})

test('a member that never stops yields 409 and leaves no tombstone', async (t) => {
  const f = await fixture(t)
  f.subagents_interrupt_noop = true
  f.ctx.get = ((original) => (name) => (name === 'subagents' ? { interrupt() {} } : original(name)))(f.ctx.get)
  await assert.rejects(
    () => dismissMember(f.ctx, { sessionId: 'lead-1', name: 'qa' }, { store: f.store, interruptTimeoutMs: 120 }),
    (error) => {
      assert.equal(error.code, 'running')
      assert.equal(error.status, 409)
      assert.equal(error.message, '成员仍在运行，已尝试中断，请稍后重试')
      return true
    },
  )
  assert.deepEqual(await f.store.listDismissed('lead-1'), [])
  assert.equal((await stat(join(f.sessionsRoot, 'proj', 'c1', 'v4.jsonl'))).isFile(), true)
})

test('deleteSession=false keeps the session and records sessionDeleted false', async (t) => {
  const f = await fixture(t)
  f.agents.get('c1').status = 'idle'
  const result = await dismissMember(
    f.ctx,
    { sessionId: 'lead-1', name: 'qa', deleteSession: false },
    { store: f.store, now: () => 7 },
  )
  assert.equal(result.stopped, false)
  assert.equal(result.sessionDeleted, false)
  assert.equal(result.trashPath, undefined)
  assert.equal((await stat(join(f.sessionsRoot, 'proj', 'c1', 'v4.jsonl'))).isFile(), true)
  assert.deepEqual(await f.store.listDismissed('lead-1'), [{ id: 'c1', name: 'qa', dismissedAt: 7, sessionDeleted: false }])
})

test('a already-missing child session is dismissed without a move', async (t) => {
  const f = await fixture(t)
  f.agents.get('c1').status = 'idle'
  await rm(join(f.sessionsRoot, 'proj', 'c1'), { recursive: true, force: true })
  const result = await dismissMember(f.ctx, { sessionId: 'lead-1', name: 'qa' }, { store: f.store, now: () => 11 })
  assert.equal(result.sessionDeleted, false)
  assert.equal(result.trashPath, undefined)
  assert.equal((await f.store.listDismissed('lead-1'))[0].sessionDeleted, false)
})

test('moveSessionArtifact falls back to copy+remove when rename reports EXDEV', async (t) => {
  const root = await tempRoot(t)
  const source = join(root, 'session')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'v4.jsonl'), 'payload', 'utf8')
  const trashRoot = join(root, 'trash')
  const target = await moveSessionArtifact({
    sourcePath: source,
    isDirectory: true,
    trashRoot,
    dirName: 'c1-1',
    renameFn: async () => {
      throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' })
    },
  })
  assert.equal(target, join(trashRoot, 'c1-1'))
  assert.equal(await readFile(join(target, 'v4.jsonl'), 'utf8'), 'payload')
  await assert.rejects(() => access(source), { code: 'ENOENT' })
})

test('moveSessionArtifact moves a bare artifact file into its own trash directory', async (t) => {
  const root = await tempRoot(t)
  const source = join(root, 'flat', 'c1.jsonl')
  await mkdir(join(root, 'flat'), { recursive: true })
  await writeFile(source, 'payload', 'utf8')
  const target = await moveSessionArtifact({ sourcePath: source, isDirectory: false, trashRoot: join(root, 'trash'), dirName: 'c1-2' })
  assert.deepEqual(await readdir(target), ['c1.jsonl'])
  await assert.rejects(() => access(source), { code: 'ENOENT' })
})
