/**
 * 老格式会话（session.jsonl.zstd 等 v1 日志）没有当前的 title、sessionListMetadata 投影，
 * 宿主只能按「无标题」渲染成未命名。这里按需读日志补标题。
 *
 * 只处理**旧文件名**的日志：v4 日志是多帧 zstd（每次追加一帧），Node 的 zstd API 只解出第一帧，
 * 无法据此判断会话是否为空。0.2.2 曾据此把正常会话标成 blank 隐藏，0.2.3 起不再改有标题的会话。
 *
 * @module legacy
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 日志优先级：旧格式优先（宿主没有它们的 title 投影）；v4 只在「小文件」时用于空白判定。 */
const LEGACY_LOG_NAMES = ['session.v3.jsonl.zstd', 'session.jsonl.zstd']
/** v4 日志文件名。 */
const CURRENT_LOG_NAME = 'session.v4.jsonl.zstd'
/** 默认缓存时长：日志很少变化，五分钟足够。 */
const DEFAULT_TTL_MS = 300000
/** 空草稿判定上限：这类日志压缩后只有几百字节到几 KB。 */
const BLANK_MAX_BYTES = 8192

/**
 * 建一个惰性读旧日志的补全器。
 * @param {{ sessionsRoot?: string, ttlMs?: number }} [options] - 会话根目录与缓存时长。
 * @returns {(value: object) => object} 就地补全 list 响应的函数。
 */
export function createLegacyDecorator(options = {}) {
  const sessionsRoot = options.sessionsRoot ?? join(homedir(), '.dsh', 'sessions')
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  let indexAt = 0
  let index = new Map()
  const cache = new Map()

  const rebuild = () => {
    index = new Map()
    let workspaces = []
    try { workspaces = readdirSync(sessionsRoot) } catch { return }
    for (const workspace of workspaces) {
      const dir = join(sessionsRoot, workspace)
      let names = []
      try { names = readdirSync(dir) } catch { continue }
      for (const name of names) if (name.startsWith('session-')) index.set(name, join(dir, name))
    }
    indexAt = Date.now()
  }

  const readInfo = (sessionId) => {
    if (cache.has(sessionId)) return cache.get(sessionId)
    if (Date.now() - indexAt > ttlMs) rebuild()
    const dir = index.get(sessionId)
    if (dir === undefined) return null
    const legacyFile = LEGACY_LOG_NAMES.map((name) => join(dir, name)).find((path) => existsSync(path))
    const currentFile = join(dir, CURRENT_LOG_NAME)
    const file = legacyFile ?? (existsSync(currentFile) ? currentFile : undefined)
    if (file === undefined) return null
    let size = 0
    try { size = statSync(file).size } catch { return null }
    // v4 日志只用来判定「空白草稿」，且必须是小文件：大文件多帧无法完整解码，绝不参与。
    if (legacyFile === undefined && size >= BLANK_MAX_BYTES) return null
    // v1/v3 日志同样是多帧 zstd（每次追加一帧），Node 的 zstd API 只解第一帧，
    // 所以优先用 zstd CLI 解全量；CLI 不可用时退回首帧（只少补标题，不会误判）。
    let text = ''
    try {
      text = execFileSync('zstd', ['-dc', file], { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' })
    } catch {
      try { text = zstdDecompressSync(readFileSync(file)).toString('utf8') } catch { return null }
    }
    if (text === '') return null
    let title = null
    let hasUserMessage = false
    let hasTurn = false
    let parsed = 0
    for (const line of text.split('\n')) {
      if (line === '') continue
      let event = null
      try { event = JSON.parse(line) } catch { continue }
      parsed += 1
      if (event?.type === 'session/title') {
        const value = event?.data?.title
        if (typeof value === 'string' && value.trim() !== '') title = value.trim()
      }
      if (event?.type === 'turn/start') hasTurn = true
      if (!hasUserMessage) {
        const serialized = JSON.stringify(event?.data ?? '')
        if (serialized.includes('"role":"user"') || serialized.includes('"source":{"kind":"user"')) hasUserMessage = true
      }
    }
    if (parsed === 0) return null
    // 只有「小文件 + 没有 turn + 没有用户消息」才当作空草稿；大文件绝不隐藏。
    const blank = size < BLANK_MAX_BYTES && parsed < 20 && hasTurn === false && hasUserMessage === false
    const info = { title, blank }
    cache.set(sessionId, info)
    return info
  }

  return (value) => {
    const items = Array.isArray(value?.items) ? value.items : []
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const sessionId = item.sessionId
      if (typeof sessionId !== 'string') continue
      // 标题在 projections.values.title（0.2.2 误把它当成 item.title，结果每条都当无标题处理）。
      const values = item.projections?.values
      const projectedTitle = values !== undefined && values !== null && typeof values.title === 'string' ? values.title.trim() : ''
      const summaryTitle = typeof item.title === 'string' ? item.title.trim() : ''
      if (projectedTitle !== '' || summaryTitle !== '') continue
      const info = readInfo(sessionId)
      if (info === null) continue
      if (info.title !== null) {
        if (values !== undefined && values !== null) values.title = info.title
        item.title = info.title
      }
      if (info.blank === true) item.blank = true
    }
    return value
  }
}
