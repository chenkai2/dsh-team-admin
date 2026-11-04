// 只读半区：列根会话、读某会话的团队（成员快照 + 任务归属 + 实时状态）。
//
// 性能约定（列表页冷启动 / 暖调用）：
// - 会话快照列表 + mtime + live 按 ctx 缓存 60s，同一 ctx 的并发调用共享一次扫描（inFlight 去重）；
//   query 与 limit 都在缓存结果上做，绝不每次调用都重新 list() 一遍整个会话库。
// - 标题优先取宿主的 projection cache（sessionProjectionCache，零 I/O 的已折叠行），
//   其次 sessionQuery 批量折叠，最后按上限读日志前缀；不会为了标题全量解压会话。
import { stat } from 'node:fs/promises'

import { AdminError } from './error.mjs'

/** 默认列表条数与上限（与 src/api.mjs 保持一致）。 */
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
/** 会话快照扫描缓存有效期（列表允许 1 分钟陈旧）。 */
const SCAN_TTL_MS = 60_000
/** 扫描时读 mtime 的并发上限，避免几千个会话同时开 fd。 */
const SCAN_CONCURRENCY = 16
/** 冷扫描超过该耗时打一条 warn，便于从服务端日志定位宿主存储变慢。 */
const COLD_WARN_MS = 2_000
/** 标题缓存有效期（与扫描缓存对齐）。 */
const TITLE_TTL_MS = 60_000
/** 一次 sessionQuery 批量折叠标题的上限（它读日志实现，冷启动时不能放大）。 */
const TITLE_QUERY_LIMIT = 32
/** 一次为标题读日志前缀的会话数上限。 */
const PREFIX_READ_LIMIT = 16
/** 读日志前缀时最多取的事件数。 */
const PREFIX_EVENTS = 80
/** 前缀读取并发上限。 */
const PREFIX_CONCURRENCY = 2

/** 会话扫描缓存与标题缓存都按 ctx 归属，避免跨插件实例 / 跨测试串味。 */
const scanStates = new WeakMap()
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

/** 打一条宿主 warn（日志不可用时静默）。 */
function logWarn(ctx, message) {
  try {
    if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(message)
  } catch {
    // 日志输出失败不影响接口结果。
  }
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

/** 会话产物文件 mtime（未知 → undefined）；用于「最近活动」近似值。 */
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

/** 某个 ctx 的会话扫描缓存槽。 */
function scanState(ctx) {
  let state = scanStates.get(ctx)
  if (state === undefined) {
    state = { at: 0, rows: undefined, headers: undefined, inFlight: undefined }
    scanStates.set(ctx, state)
  }
  return state
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

/**
 * 丢弃某个 ctx 的会话扫描缓存（删除成员后可让列表 / 团队详情立刻反映文件变化）。
 * @param {object} ctx - 宿主上下文。
 */
export function invalidateSessionListCache(ctx) {
  scanStates.delete(ctx)
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
 * 扫一次会话库（含全部会话，不只是根会话），结果按 ctx 缓存。
 * 同一 ctx 的并发冷调用共享同一次扫描；扫描失败且存在旧缓存时先给旧数据。
 * @param {object} ctx - 宿主上下文。
 * @param {object} persistence - ctx.sessionPersistence。
 * @param {{maxAgeMs?: number}} [options] - 缓存有效期覆盖（默认 60s，0 表示强制重扫）。
 * @returns {Promise<{at: number, rows: object[], headers: Map<string, object>}>} 缓存槽（含全部会话行）。
 * @throws {AdminError} 首次扫描失败（无旧缓存可退）。
 */
async function scanSessions(ctx, persistence, { maxAgeMs = SCAN_TTL_MS } = {}) {
  const state = scanState(ctx)
  if (state.rows !== undefined && Date.now() - state.at < maxAgeMs) return state
  if (state.inFlight !== undefined) return state.inFlight

  const started = Date.now()
  state.inFlight = (async () => {
    const snapshots = await persistence.list()
    const rows = []
    const headers = new Map()
    await mapLimited(snapshots, SCAN_CONCURRENCY, async (snapshot) => {
      if (!isRecord(snapshot?.header)) return
      const id = String(snapshot.header.id)
      headers.set(id, snapshot.header)
      rows.push({
        id,
        cwd: typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : '',
        createdAt: Number(snapshot.header.createdAt) || 0,
        lastActivityAt: await lastActivityOf(snapshot),
        live: liveAgent(ctx, id) !== undefined,
        parentSession: snapshot.header.parentSession,
      })
    })
    state.rows = rows
    state.headers = headers
    state.at = Date.now()
    const took = state.at - started
    if (took >= COLD_WARN_MS) {
      logWarn(ctx, '[team-admin] 会话列表冷扫描耗时 ' + took + 'ms（' + rows.length + ' 个会话，缓存 ' + Math.round(SCAN_TTL_MS / 1000) + 's）')
    }
    return state
  })()

  try {
    return await state.inFlight
  } catch (error) {
    if (state.rows !== undefined) {
      logWarn(ctx, '[team-admin] 会话扫描失败，继续使用 ' + Math.round((Date.now() - state.at) / 1000) + 's 前的缓存：' + String(error?.message ?? error))
      return state
    }
    throw error
  } finally {
    state.inFlight = undefined
  }
}

/**
 * 从宿主 projection cache 取已折叠标题（同步零 I/O，与宿主冷列表一致）。
 * @param {object} projections - ctx.sessionProjectionCache。
 * @param {object} header - 会话头部（生命周期身份校验用）。
 * @returns {string|undefined} 标题；无可用行时 undefined。
 */
function projectionTitle(projections, header) {
  if (projections === undefined || header === undefined || typeof projections.cachedSnapshot !== 'function') return undefined
  try {
    const block = projections.cachedSnapshot(header, ['title'])
    const value = block?.values?.title
    return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 折叠一批会话的标题（缓存 → projection cache → sessionQuery 批量 → 日志前缀 → 会话 id）。
 * @param {object} ctx - 宿主上下文。
 * @param {string[]} ids - 需要标题的会话 id。
 * @param {object} persistence - ctx.sessionPersistence（前缀读取兜底用）。
 * @param {Map<string, object>} [headers] - id → 会话头部（projection cache 身份校验用）。
 * @returns {Promise<Map<string, string>>} 标题表（读不到的会话映射为 id）。
 */
async function collectTitles(ctx, ids, persistence, headers = new Map()) {
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

  // 1) 宿主 projection cache：同步命中，冷列表的主要标题来源。
  const projections = service(ctx, 'sessionProjectionCache')
  const unresolved = []
  for (const id of pending) {
    const title = projectionTitle(projections, headers.get(id))
    if (title === undefined) unresolved.push(id)
    else remember(id, title)
  }

  // 2) sessionQuery 批量折叠：它按日志实现，只在剩余量可控时才调用，避免冷启动放大。
  let remaining = unresolved
  const query = service(ctx, 'sessionQuery')
  if (remaining.length > 0 && remaining.length <= TITLE_QUERY_LIMIT
    && query !== undefined && typeof query.readTitleSnapshots === 'function') {
    let results
    try {
      results = await query.readTitleSnapshots(remaining)
    } catch {
      results = undefined
    }
    if (Array.isArray(results)) {
      const stillOpen = []
      for (const [index, item] of results.entries()) {
        const id = typeof item?.sessionId === 'string' ? item.sessionId : remaining[index]
        const title = item?.status === 'fulfilled' ? item.value?.title?.title : undefined
        if (typeof title === 'string' && title.trim() !== '') remember(id, title.trim())
        else stillOpen.push(id)
      }
      remaining = stillOpen
    }
  }

  // 3) 有上限的日志前缀读取：取 session/title 或首条 user/message，绝不整篇解压。
  const prefixIds = remaining.slice(0, PREFIX_READ_LIMIT)
  await mapLimited(prefixIds, PREFIX_CONCURRENCY, async (id) => {
    try {
      const handle = await persistence.open(id, 'read')
      let events
      try {
        const slice = await handle.read(0, PREFIX_EVENTS)
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

  // 4) 兜底：读不到标题的会话按会话 id 记住，避免每次列表都重读同一个坏会话。
  for (const id of pending) if (!titles.has(id)) remember(id, id)
  return titles
}

/** 把内部扫描行换成对外的 SessionRow（只输出契约字段）。 */
function toSessionRow(row, title) {
  return {
    id: row.id,
    title,
    cwd: row.cwd,
    createdAt: row.createdAt,
    lastActivityAt: row.lastActivityAt,
    live: row.live,
  }
}

/** 列表排序：最近活动降序，其次创建时间降序，最后按 id 保证稳定。 */
function compareActivity(left, right) {
  return right.lastActivityAt - left.lastActivityAt
    || right.createdAt - left.createdAt
    || left.id.localeCompare(right.id)
}

/**
 * 列根会话（parentSession 为空），按最近活动降序。
 * @param {object} ctx - 宿主上下文。
 * @param {{query?: string, limit?: number, maxAgeMs?: number}} [options] - 搜索词、条数上限、扫描缓存有效期覆盖。
 * @returns {Promise<object[]>} SessionRow 数组。
 */
export async function listTeamSessions(ctx, { query = '', limit = DEFAULT_LIMIT, maxAgeMs = SCAN_TTL_MS } = {}) {
  const persistence = service(ctx, 'sessionPersistence')
  if (persistence === undefined || typeof persistence.list !== 'function') {
    throw new AdminError('宿主会话服务不可用，无法列出会话', 'system', 500)
  }
  const effectiveLimit = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, MAX_LIMIT) : DEFAULT_LIMIT
  const scan = await scanSessions(ctx, persistence, { maxAgeMs })
  const roots = scan.rows.filter((row) => row.parentSession === undefined)
  roots.sort(compareActivity)

  const needle = typeof query === 'string' ? query.trim().toLowerCase() : ''
  // 搜索要对标题做子串匹配，因此搜索时给全部根会话取标题（标题来源都是缓存/零 I/O，
  // 只有极少数会话才会触发前缀读取）；无搜索时只取将返回的那一段。
  const titleIds = (needle === '' ? roots.slice(0, effectiveLimit) : roots).map((row) => row.id)
  const titles = await collectTitles(ctx, titleIds, persistence, scan.headers)
  const rows = roots.map((row) => toSessionRow(row, titles.get(row.id) ?? row.id))
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
    if (!isRecord(event)) continue
    if (event.type === 'session/title' && isRecord(event.data) && typeof event.data.title === 'string') {
      const text = event.data.title.trim()
      if (text !== '') title = text
      continue
    }
    if (!isRecord(event.data)) continue
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
  const scan = await scanSessions(ctx, persistence)
  const headers = new Map([[sessionId, snapshot.header]])
  const title = roster.title
    ?? (await collectTitles(ctx, [sessionId], persistence, headers)).get(sessionId)
    ?? sessionId
  const session = {
    id: sessionId,
    title,
    cwd: typeof snapshot.header.cwd === 'string' ? snapshot.header.cwd : '',
    createdAt: Number(snapshot.header.createdAt) || 0,
    lastActivityAt: await lastActivityOf(snapshot),
    live: liveAgent(ctx, sessionId) !== undefined,
  }

  const childRows = new Map(scan.rows.map((row) => [row.id, row]))
  const leadAgent = liveAgent(ctx, sessionId)
  const dismissedRows = store === undefined || typeof store.listDismissed !== 'function'
    ? []
    : await store.listDismissed(sessionId)
  const dismissedById = new Map(dismissedRows.map((row) => [row.id, row]))
  // 校验过的 roster 只有 teammate；这里再挡一次 Lead 自身与同名 pseudo-row。
  const teammates = roster.members.filter((member) => member.name !== 'lead' && String(member.id) !== sessionId)
  const memberIds = new Set(teammates.map((member) => member.id))

  const members = teammates.map((member) => {
    const id = String(member.id)
    const live = liveAgent(ctx, id)
    const child = childRows.get(id)
    const phase = member.phase === 'failed' || member.phase === 'provisioning' ? member.phase : 'active'
    const model = live?.options?.model ?? leadAgent?.options?.model
    return {
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
      lastActivityAt: child === undefined ? null : child.lastActivityAt,
    }
  })

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
