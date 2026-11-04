// 墓碑存储：state.json 单文件 + 进程内写链。
// 写 = 同目录临时文件 + rename（原子替换）；坏 JSON / 未知 version 改名 .corrupt-<ts> 后按空状态处理。

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** 当前状态文件格式版本；其他版本一律按损坏处理。 */
const STATE_VERSION = 1
/** 状态文件名（位于 dataDir 下）。 */
const STATE_FILE = 'state.json'

/** 空状态：无任何墓碑。 */
function emptyState() {
  return { version: STATE_VERSION, dismissed: {} }
}

/** 普通对象判定（排除 null / 数组）。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 规范化单条墓碑记录，剔除未知字段并补齐默认值。 */
function normalizeRecord(raw) {
  const row = {
    name: typeof raw.name === 'string' ? raw.name : '',
    dismissedAt: Number.isFinite(raw.dismissedAt) ? raw.dismissedAt : Date.now(),
    sessionDeleted: raw.sessionDeleted === true,
  }
  if (typeof raw.trashPath === 'string' && raw.trashPath !== '') row.trashPath = raw.trashPath
  return row
}

/**
 * 校验并规范化整份状态。
 * @param {unknown} raw - 解析后的 JSON 值。
 * @returns {{version: number, dismissed: Record<string, Record<string, object>>}|undefined} 合法状态，否则 undefined。
 */
function normalizeState(raw) {
  if (!isRecord(raw) || raw.version !== STATE_VERSION) return undefined
  if (!isRecord(raw.dismissed)) return undefined
  const dismissed = {}
  for (const [leadId, bucket] of Object.entries(raw.dismissed)) {
    if (!isRecord(bucket)) continue
    const members = {}
    for (const [memberId, record] of Object.entries(bucket)) {
      if (isRecord(record)) members[memberId] = normalizeRecord(record)
    }
    dismissed[leadId] = members
  }
  return { version: STATE_VERSION, dismissed }
}

/** 深拷贝一条墓碑记录，附带 memberId 作为 id。 */
function toRow(memberId, record) {
  return { id: memberId, ...record }
}

/**
 * 打开（必要时创建）一个墓碑存储。
 * @param {{dir: string}} options - dir 为数据目录（不要求已存在）。
 * @returns {Promise<{readAll: () => Promise<{version: number, dismissed: object}>, listDismissed: (leadId: string) => Promise<object[]>, record: (leadId: string, memberId: string, row: object) => Promise<object>, dataDir: string}>} 存储句柄。
 */
export async function openStore({ dir }) {
  const dataDir = dir
  const file = join(dir, STATE_FILE)
  const tmpFile = file + '.tmp'
  let loadPromise
  let state
  // 写链：同一进程内所有写串行，避免 tmp 文件互踩，并保证磁盘顺序与调用顺序一致。
  let chain = Promise.resolve()

  /** 把损坏文件改名隔离，失败不影响按空状态继续。 */
  async function quarantine() {
    try {
      await rename(file, file + '.corrupt-' + Date.now())
    } catch {
      // 文件已不存在或不可改名：隔离失败时仍按空状态服务，避免整条路由不可用。
    }
  }

  /** 读取 state.json（只加载一次）；缺失 → 空状态，损坏 / 未知版本 → 隔离后空状态。 */
  async function load() {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch (error) {
      if (error.code === 'ENOENT') return emptyState()
      throw error
    }
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      await quarantine()
      return emptyState()
    }
    const normalized = normalizeState(parsed)
    if (normalized === undefined) {
      await quarantine()
      return emptyState()
    }
    return normalized
  }

  /** 惰性加载状态（并发调用共享同一次加载；失败不缓存，下次重试）。 */
  function ensureLoaded() {
    loadPromise ??= load().then((value) => {
      state = value
      return value
    }, (error) => {
      loadPromise = undefined
      throw error
    })
    return loadPromise
  }

  /** 原子落盘：写临时文件后 rename 覆盖。 */
  async function persist() {
    await mkdir(dataDir, { recursive: true })
    await writeFile(tmpFile, JSON.stringify(state, null, 2), 'utf8')
    await rename(tmpFile, file)
  }

  /** 在写链上执行一次「读状态 → 变更 → 落盘」，返回值即调用方结果。 */
  function enqueue(task) {
    const result = chain.then(async () => {
      await ensureLoaded()
      return task()
    })
    chain = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    dataDir,
    /** 读取全部墓碑（按 leadSessionId / memberId 分组，调用方拿到的是副本）。 */
    async readAll() {
      await ensureLoaded()
      const dismissed = {}
      for (const [leadId, bucket] of Object.entries(state.dismissed)) {
        dismissed[leadId] = {}
        for (const [memberId, record] of Object.entries(bucket)) {
          dismissed[leadId][memberId] = toRow(memberId, record)
        }
      }
      return { version: state.version, dismissed }
    },
    /** 列出某根会话下已删除的成员，按删除时间降序。 */
    async listDismissed(leadId) {
      await ensureLoaded()
      const bucket = state.dismissed[leadId]
      if (bucket === undefined) return []
      return Object.entries(bucket)
        .map(([memberId, record]) => toRow(memberId, record))
        .sort((left, right) => right.dismissedAt - left.dismissedAt)
    },
    /**
     * 记录一条墓碑；同一成员已存在时保留原记录（幂等），返回最终生效的记录。
     * @param {string} leadId - 根会话 id。
     * @param {string} memberId - 成员会话 id。
     * @param {{name: string, dismissedAt: number, sessionDeleted: boolean, trashPath?: string}} row - 墓碑内容。
     */
    async record(leadId, memberId, row) {
      return enqueue(async () => {
        const bucket = state.dismissed[leadId] ?? (state.dismissed[leadId] = {})
        const existing = bucket[memberId]
        if (existing !== undefined) return toRow(memberId, existing)
        const normalized = normalizeRecord(row)
        bucket[memberId] = normalized
        await persist()
        return toRow(memberId, normalized)
      })
    },
  }
}
