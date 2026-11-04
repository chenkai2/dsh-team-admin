// 只读半区：列根会话、读某会话的团队（成员快照 + 任务归属 + 实时状态）。
// 标题优先走宿主的 sessionQuery 折叠；不可用时按需读会话日志并做 TTL 缓存，
// 列表页只对真正需要的会话取标题，绝不为了标题全量解压所有会话。
import { stat } from 'node:fs/promises'

import { AdminError } from './error.mjs'

/** 默认列表条数与上限（与 src/api.mjs 保持一致）。 */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** 无 sessionQuery 时最多为多少个会话折叠标题（按最近活动取前 N）。 */
const TITLE_SCAN_LIMIT = 400
/** 标题内存缓存有效期。 */
const TITLE_TTL_MS = 30_000
/** 回退读日志时只取前 N 条事件（用于取首条 user/message）。 */
const TITLE_PREFIX_EVENTS = 80
/** 并发读日志折叠标题的上限。 */
const TITLE_CONCURRENCY = 4

/** 标题缓存按 ctx 归属，避免跨插件实例 / 跨测试串味。 */
const titleCaches = new WeakMap()

/** 取宿主服务（可选依赖用 ctx.get，避免未声明的 inject 抛错）。 */
function service(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    } catch {
      // 服务未提供或严格模式下不可见：退回属性访问。
    }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/** 当前 ctx 的标题缓存。 */
function titleCache(ctx) {
  let cache = titleCaches.get(ctx)
  if (cache === undefined) {
    cache = new Map()
    titleCaches.set(ctx, cache)
  }
  return cache
}

/** 普通对象判定。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 文本块拼成一段纯文本。 */
function contentText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (isRecord(block) && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join(' ').trim()
}

/** 折叠会话标题：最后一条 session/title，缺失回退首条 user/message 的前 40 字。 */
function foldTitleFromEvents(events) {
  let title
  let firstUserText
  for (const event of events ?? []) {
    if (!isRecord(event)) continue
    if (event.type === 'session/title' && isRecord(event.data) && typeof event.data.title === 'string') {
      const text = event.data.title.trim()
      if (text !== '') title = text
      continue
    }
    if (firstUserText === undefined && event.type === 'user/message' && isRecord(event.data)) {
      const text = contentText(event.data.content)
      if (text !== '') firstUserText = text.slice(0, 40)
    }
  }
  return title ?? firstUserText
}

/**
 * 读取一个会话的完整日志。
 * @param {object} persistence - ctx.sessionPersistence。
 * @param {string} sessionId - 会话 id。
 * @returns {Promise<{header: object, events: object[]}>} 头部与全量事件。
 */
export async function readSessionLog(persistence, sessionId) {
  const handle = await persistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(0, undefined)
    return { header: handle.header, events }
  } finally {
    await handle.close()
  }
}

/** 会话文件 mtime（未知 → undefined）；用于「最近活动」近似值。 */
async function artifactMtime(path) {
  if (typeof path !== 'string' || path === '') return undefined
  try {
    const info = await stat(path)
    return Number.isFinite(info.mtimeMs) ? info.mtimeMs : undefined
  } catch {
    return undefined
  }
}

/** 以有限并发跑一批异步任务，保留输入顺序的结果。 */
async function mapLimited(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(undefined).map(async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * 折叠一批会话的标题（缓存 + sessionQuery 批量优先 + 按需读日志兜底）。
 * @param {object} ctx - 宿主上下文。
 * @param {string[]} ids - 需要标题的会话 id。
 * @param {object} persistence - ctx.sessionPersistence。
 * @returns {Promise<Map<string, string>>} 已知标题（缺标题的会话映射为 id）。
 */
async function collectTitles(ctx, ids, persistence) {
  const cache = titleCache(ctx)
  const now = Date.now()
  const titles = new Map()
  const pending = []
  for (const id of ids) {
    const cached = cache.get(id)
    if (cached !== undefined && now - cached.at < TITLE_TTL_MS) titles.set(id, cached.title)
    else pending.push(id)
  }
  if (pending.length === 0) return titles

  const remember = (id, title) => {
    cache.set(id, { title, at: Date.now() })
    titles.set(id, title)
  }

  const query = service(ctx, 'sessionQuery')
  const usable = query !== undefined && typeof query.readTitleSnapshots === 'function'
  const unresolved = []
  let batchWorked = false
  if (usable) {
    let results
    try {
      results = await query.readTitleSnapshots(pending)
    } catch {
      results = undefined
    }
    if (Array.isArray(results)) {
      batchWorked = true
      for (const [index, item] of results.entries()) {
        const id = typeof item?.sessionId === 'string' ? item.sessionId : pending[index]
        const title = item?.status === 'fulfilled' ? item.value?.title?.title : undefined
        if (typeof title === 'string' && title.trim() !== '') remember(id, title.trim())
        else unresolved.push(id)
      }
    } else {
      unresolved.push(...pending)
    }
  } else {
    unresolved.push(...pending)
  }

  // 批量折叠成功说明「没有标题」是权威结论，此时只读前缀找首条用户消息；
  // 批量不可用（无 sessionQuery 或整批失败）才读全量日志折叠最后一条 session/title。
  await mapLimited(unresolved, TITLE_CONCURRENCY, async (id) => {
    try {
      const handle = await persistence.open(id, 'read')
      let events
      try {
        const slice = await handle.read(0, batchWorked ? TITLE_PREFIX_EVENTS : undefined)
        events = slice.events
      } finally {
        await handle.close()
      }
      const title = foldTitleFromEvents(events)
      if (typeof title === 'string' && title !== '') remember(id, title)
    } catch {
      // 会话不可读（已进回收站 / 被打断写坏）：标题回退会话 id，不影响列表。
    }
  })
  // 读不到标题的会话按会话 id 兜底，一并进缓存，避免每次列表都重读同一个坏会话。
  for (const id of unresolved) if (!titles.has(id)) remember(id, id)
  return titles
}

/** 一个会话的最近活动时间（未知回退创建时间）。 */
async function lastActivityOf(snapshot) {
  const mtime = await artifactMtime(snapshot?.location?.path)
  return mtime ?? (Number(snapshot?.header?.createdAt) || 0)
}

/** 实时状态：ctx.agents.get(id) 有值即已加载。 */
function liveAgent(ctx, id) {
  const agents = service(ctx, 'agents')
  if (agents === undefined || typeof agents.get !== 'function') return undefined
  try {
    return agents.get(id)
  } catch {
    return undefined
  }
}

/**
 * 列根会话（parentSession 为空），按最近活动降序。
 * @param {object} ctx - 宿主上下文。
 * @param {{query?: string, limit?: number}} [options] - 搜索词与条数上限。
 * @returns {Promise<object[]>} SessionRow 数组。
 */
export async function listTeamSessions(ctx, { query = '', limit = DEFAULT_LIMIT } = {}) {
  const persistence = service(ctx, 'sessionPersistence')
  if (persistence === undefined || typeof persistence.list !== 'function') {
    throw new AdminError('宿主会话服务不可用，无法列出会话', 'system', 500)
  }
  const effectiveLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const snapshots = (await persistence.list()).filter((snapshot) => isRecord(snapshot?.header) && snapshot.header.parentSession === undefined)

  // mtime 读盘有并发上限：几千个会话时不至于同时开几千个 fd。
  const rows = await mapLimited(snapshots, 16, async (snapshot) => {
    const id = String(snapshot.header.id)
    const createdAt = Number(snapshot.header.createdAt) || 0
    return {
      id,
      title: id,
      cwd: typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : '',
      createdAt,
      lastActivityAt: await lastActivityOf(snapshot),
      live: liveAgent(ctx, id) !== undefined,
    }
  })
  rows.sort((left, right) => right.lastActivityAt - left.lastActivityAt || right.createdAt - left.createdAt)

  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  const titleIds = (needle === '' ? rows.slice(0, effectiveLimit) : rows.slice(0, TITLE_SCAN_LIMIT)).map((row) => row.id)
  const titles = await collectTitles(ctx, titleIds, persistence)
  for (const row of rows) row.title = titles.get(row.id) ?? row.id
  if (needle === '') return rows.slice(0, effectiveLimit)
  return rows
    .filter((row) => row.title.toLowerCase().includes(needle)
      || row.cwd.toLowerCase().includes(needle)
      || row.id.toLowerCase().includes(needle))
    .slice(0, effectiveLimit)
}

/**
 * 纯函数：从 Lead 会话日志折叠团队 roster 与任务板。
 * 同一成员 id 取最后一条快照；同一任务 id 取最大 revision；status='deleted' 的任务视为不存在。
 * @param {readonly object[]} events - Lead 会话事件。
 * @returns {{members: object[], tasks: object[], title?: string}} 成员（创建顺序）、未删除任务、最后一条标题。
 */
export function parseRoster(events) {
  const members = new Map()
  const tasks = new Map()
  let title
  for (const event of events ?? []) {
    if (!isRecord(event) || !isRecord(event.data)) continue
    if (event.type === 'team/member' && isRecord(event.data.member)) {
      const member = event.data.member
      if (typeof member.id === 'string' && member.id !== '') members.set(member.id, { ...member })
      continue
    }
    if (event.type === 'team/task' && isRecord(event.data.task)) {
      const task = event.data.task
      if (typeof task.id !== 'string' || task.id === '') continue
      const revision = Number(task.revision)
      const current = tasks.get(task.id)
      if (current === undefined || (Number.isFinite(revision) && revision >= Number(current.revision))) {
        tasks.set(task.id, { ...task })
      }
      continue
    }
    if (event.type === 'session/title' && typeof event.data.title === 'string' && event.data.title.trim() !== '') {
      title = event.data.title.trim()
    }
  }
  return {
    members: [...members.values()],
    tasks: [...tasks.values()].filter((task) => task.status !== 'deleted'),
    ...title === undefined ? {} : { title },
  }
}

/**
 * 读一个根会话的团队详情。
 * @param {object} ctx - 宿主上下文。
 * @param {{sessionId: string, store: object}} request - 目标会话与墓碑存储。
 * @returns {Promise<{session: object, members: object[], dismissed: object[]}>} 会话行、成员行、已删除记录。
 * @throws {AdminError} 会话不存在（404）或不是根会话（400）。
 */
export async function readTeam(ctx, { sessionId, store }) {
  const persistence = service(ctx, 'sessionPersistence')
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    throw new AdminError('宿主会话服务不可用，无法读取团队', 'system', 500)
  }
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new AdminError('缺少 sessionId', 'bad-request', 400)
  }
  const snapshot = await statSnapshot(persistence, sessionId)
  if (snapshot === undefined) throw new AdminError('会话不存在', 'not-found', 404)
  if (snapshot.header.parentSession !== undefined) {
    throw new AdminError('只能管理根会话的团队', 'bad-session', 400)
  }

  const log = await readSessionLog(persistence, sessionId)
  const roster = parseRoster(log.events)
  const title = roster.title ?? (await collectTitles(ctx, [sessionId], persistence)).get(sessionId) ?? sessionId
  const session = {
    id: sessionId,
    title,
    cwd: typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : '',
    createdAt: Number(snapshot.header.createdAt) || 0,
    lastActivityAt: await lastActivityOf(snapshot),
    live: liveAgent(ctx, sessionId) !== undefined,
  }

  let childSnapshots = new Map()
  if (typeof persistence.list === 'function') {
    try {
      childSnapshots = new Map((await persistence.list()).map((item) => [String(item.header.id), item]))
    } catch {
      childSnapshots = new Map()
    }
  }
  const leadAgent = liveAgent(ctx, sessionId)
  const dismissedRows = store === undefined || typeof store.listDismissed !== 'function'
    ? []
    : await store.listDismissed(sessionId)
  const dismissedById = new Map(dismissedRows.map((row) => [row.id, row]))
  // 校验过的 roster 只有 teammate；这里再挡一次 Lead 自身与同名 pseudo-row。
  const teammates = roster.members.filter((member) => member.name !== 'lead' && String(member.id) !== sessionId)
  const memberIds = new Set(teammates.map((member) => member.id))

  const members = await Promise.all(teammates.map(async (member) => {
    const id = String(member.id)
    const live = liveAgent(ctx, id)
    const child = childSnapshots.get(id)
    const phase = member.phase === 'failed' || member.phase === 'provisioning' ? member.phase : 'active'
    const model = live?.options?.model ?? leadAgent?.options?.model
    const row = {
      name: String(member.name ?? ''),
      id,
      phase,
      status: phase === 'failed' ? 'failed' : phase === 'provisioning' ? 'provisioning' : live?.status === 'running' ? 'running' : 'inactive',
      description: typeof member.description === 'string' ? member.description : '',
      provider: typeof member.provider === 'string' ? member.provider : '',
      context: member.context === 'fork' ? 'fork' : 'fresh',
      ...model === undefined ? {} : { model },
      ...typeof member.error === 'string' ? { error: member.error } : {},
      dismissed: dismissedById.has(id),
      sessionExists: live !== undefined || child !== undefined,
      ownedTasks: roster.tasks.filter((task) => task.ownerId === id).length,
      lastActivityAt: child === undefined ? null : await lastActivityOf(child) ?? null,
    }
    return row
  }))

  const dismissed = dismissedRows.map((row) => ({
    name: row.name,
    id: row.id,
    dismissedAt: row.dismissedAt,
    sessionDeleted: row.sessionDeleted === true,
    ...typeof row.trashPath === 'string' ? { trashPath: row.trashPath } : {},
    memberStillInRoster: memberIds.has(row.id),
  }))

  return { session, members, dismissed }
}

/** stat 包装：不存在返回 undefined，其他 I/O 错误照常抛出。 */
export async function statSnapshot(persistence, sessionId) {
  try {
    return await persistence.stat(sessionId)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.name === 'SessionPersistenceNotFoundError') return undefined
    throw error
  }
}
