/**
 * 老格式会话（session.jsonl.zstd / v1）没有当前的 title、sessionListMetadata 投影，
 * 宿主只能按「无标题」渲染成未命名，也认不出空白草稿。这里按需读日志补齐：
 * 标题取最后一条 session/title，空草稿标记 blank，让侧栏表现和当前格式一致。
 *
 * @module legacy
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

/** 已知的会话日志文件名，新到旧。 */
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd', 'session.jsonl.zstd']
/** 默认缓存时长：日志很少变化，五分钟足够。 */
const DEFAULT_TTL_MS = 300000

/**
 * 建一个惰性读老日志的补全器。
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
    const file = LOG_NAMES.map((name) => join(dir, name)).find((path) => existsSync(path))
    if (file === undefined) return null
    let text = ''
    try { text = zstdDecompressSync(readFileSync(file)).toString('utf8') } catch { return null }
    let title = null
    let hasUserMessage = false
    let hasTurn = false
    for (const line of text.split('\n')) {
      if (line === '') continue
      if (line.includes('"session/title"')) {
        try {
          const event = JSON.parse(line)
          const value = event?.data?.title
          if (typeof value === 'string' && value.trim() !== '') title = value.trim()
        } catch { /* 坏行忽略 */ }
      }
      if (line.includes('"turn/start"')) hasTurn = true
      if (!hasUserMessage && line.includes('"role":"user"')) hasUserMessage = true
    }
    const info = { title, hasUserMessage, hasTurn }
    cache.set(sessionId, info)
    return info
  }

  return (value) => {
    const items = Array.isArray(value?.items) ? value.items : []
    for (const item of items) {
      if (item === null || typeof item !== 'object') continue
      const sessionId = item.sessionId
      if (typeof sessionId !== 'string') continue
      const titled = typeof item.title === 'string' && item.title.trim() !== ''
      // 新格式会话（有标题且非空白）不需要补
      if (titled && item.blank === false) continue
      const info = readInfo(sessionId)
      if (info === null) continue
      if (!titled && info.title !== null) item.title = info.title
      if (info.hasTurn === false && info.hasUserMessage === false) item.blank = true
    }
    return value
  }
}
