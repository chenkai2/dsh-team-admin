// /api/team-admin 路由分发：只做 HTTP 语义（回环校验、JSON 编解码、错误映射），
// 业务在 team-read.mjs / dismiss.mjs。
import { AdminError } from './error.mjs'

/** 请求体上限：64KB。 */
const BODY_MAX_BYTES = 64 * 1024
/** 默认会话列表条数 / 上限。 */
const DEFAULT_SESSIONS_LIMIT = 50
const MAX_SESSIONS_LIMIT = 200

/** 回环来源判定：只有本机可以操作（删除动作不可远程触发）。 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false
  const normalized = address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
  return normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.')
}

/** 写 JSON 响应。 */
function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

/** 读完整请求体并解析 JSON 对象。 */
async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > BODY_MAX_BYTES) {
      throw new AdminError('请求体超过上限', 'body-too-large', 400)
    }
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new AdminError('请求体不是合法 JSON', 'bad-json', 400)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AdminError('请求体不是合法 JSON', 'bad-json', 400)
  }
  return parsed
}

/** 查询串取单值。 */
function queryValue(url, key) {
  const value = url.searchParams.get(key)
  return value === null || value.trim() === '' ? undefined : value.trim()
}

/** 整数查询参数（坏值回退默认）。 */
function queryInt(url, key, fallback) {
  const raw = queryValue(url, key)
  if (raw === undefined) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

/**
 * 建路由处理器。
 * @param {{ctx: object, getStore: () => Promise<object>, version: string, logSystem: (line: string) => void, services?: object}} deps
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createApi({ ctx, getStore, version, logSystem, services }) {
  if (services === undefined) throw new Error('createApi requires services { listTeamSessions, readTeam, dismissMember }')
  return async function handle(req, res) {
    try {
      if (!isLoopbackAddress(req.socket?.remoteAddress)) {
        sendJson(res, 403, { error: '仅允许本机访问' })
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const path = url.pathname
      const method = req.method ?? 'GET'

      if (path === '/api/team-admin/health') {
        if (method !== 'GET') { sendJson(res, 405, { error: '请求方法不支持' }); return }
        const budget = typeof services.readRosterBudget === 'function' ? services.readRosterBudget() : null
        sendJson(res, 200, {
          ok: true,
          name: 'team-admin',
          version,
          maxMembers: budget === null ? null : budget.maxMembers,
          reclaimed: budget === null ? 0 : budget.reclaimed,
          teams: budget === null ? {} : budget.teams,
        })
        return
      }

      if (path === '/api/team-admin/sessions') {
        if (method !== 'GET') { sendJson(res, 405, { error: '请求方法不支持' }); return }
        const query = queryValue(url, 'query') ?? ''
        const limit = Math.min(queryInt(url, 'limit', DEFAULT_SESSIONS_LIMIT), MAX_SESSIONS_LIMIT)
        const sessions = await services.listTeamSessions(ctx, { query, limit })
        sendJson(res, 200, { sessions })
        return
      }

      if (path === '/api/team-admin/dismissed') {
        if (method !== 'GET') { sendJson(res, 405, { error: '请求方法不支持' }); return }
        const store = await getStore()
        const state = await store.readAll()
        const buckets = state !== null && typeof state === 'object' && typeof state.dismissed === 'object' && state.dismissed !== null
          ? state.dismissed
          : {}
        const ids = []
        for (const bucket of Object.values(buckets)) {
          if (bucket === null || typeof bucket !== 'object') continue
          for (const memberId of Object.keys(bucket)) ids.push(memberId)
        }
        sendJson(res, 200, { ids })
        return
      }

      if (path === '/api/team-admin/team') {
        if (method !== 'GET') { sendJson(res, 405, { error: '请求方法不支持' }); return }
        const sessionId = queryValue(url, 'sessionId')
        if (sessionId === undefined) { sendJson(res, 400, { error: '缺少 sessionId' }); return }
        const store = await getStore()
        sendJson(res, 200, await services.readTeam(ctx, { sessionId, store }))
        return
      }

      if (path === '/api/team-admin/dismiss') {
        if (method !== 'POST') { sendJson(res, 405, { error: '请求方法不支持' }); return }
        const body = await readJsonBody(req)
        const sessionId = typeof body.sessionId === 'string' ? body.sessionId.trim() : ''
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (sessionId === '' || name === '') {
          sendJson(res, 400, { error: '缺少 sessionId 或 name' })
          return
        }
        const store = await getStore()
        const result = await services.dismissMember(
          ctx,
          { sessionId, name, deleteSession: body.deleteSession !== false },
          { store, logSystem },
        )
        if (typeof services.onMemberDismissed === 'function') services.onMemberDismissed()
        sendJson(res, 200, { ok: true, ...result })
        return
      }

      sendJson(res, 404, { error: '接口不存在' })
    } catch (error) {
      const status = error instanceof AdminError ? error.status : 500
      const message = error instanceof AdminError ? error.message : '操作失败（详见服务端日志）'
      if (!(error instanceof AdminError)) {
        logSystem('[team-admin] ' + String(error && error.stack || error))
      }
      if (!res.headersSent) sendJson(res, status, { error: message })
    }
  }
}