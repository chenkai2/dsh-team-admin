// 删除角色：先停会话（中断 + 轮询等它退出），再把成员会话目录移进
// <dataDir>/trash/<leadSessionId>/<memberId>-<毫秒>/，最后写墓碑。
// 移动而不是删除：可恢复，且 session-query 索引会按「文件消失」自动摘除。
import { cp, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

import { AdminError } from './error.mjs'
import { invalidateSessionListCache, parseRoster, readSessionLog, statSnapshot } from './team-read.mjs'

/** 停止成员的总等待上限（契约固定 15s）。 */
const DEFAULT_INTERRUPT_TIMEOUT_MS = 15_000
/** 轮询成员状态的间隔。 */
const STOP_POLL_MS = 100
/** 回收站目录名。 */
const TRASH_DIR = 'trash'

/** 取宿主服务（可选依赖一律走 ctx.get，避免未声明的 inject 抛错）。 */
function service(ctx, name) {
  if (ctx === null || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      const value = ctx.get(name)
      if (value !== undefined && value !== null) return value
    } catch {
      // 服务未提供：退回属性访问。
    }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/** 普通对象判定。 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 睡一会（仅用于停止轮询）。 */
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * 还原持久化后端对路径片的编码（非安全字符编码成 ~XXXX），用于判断某个目录是否就是该会话的目录。
 * @param {string} segment - 路径片。
 * @returns {string} 还原后的文本。
 */
function decodeSegment(segment) {
  return segment.replace(/~([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(Number.parseInt(hex, 16)))
}

/**
 * 定位要移动的源路径：优先整个会话目录（同一会话的多个 format generation 一起走），
 * 否则只移动该会话的日志文件。
 * @param {string} locationPath - 持久化后端给出的会话产物路径。
 * @param {string} memberId - 成员会话 id。
 * @returns {Promise<{path: string, isDirectory: boolean}|undefined>} 源路径；产物已不存在时为 undefined。
 */
async function resolveSource(locationPath, memberId) {
  const info = await lstat(locationPath).catch(() => undefined)
  if (info === undefined) return undefined
  if (info.isDirectory()) return { path: locationPath, isDirectory: true }
  const parent = dirname(locationPath)
  if (decodeSegment(basename(parent)) === memberId) {
    const parentInfo = await lstat(parent).catch(() => undefined)
    if (parentInfo?.isDirectory() === true) return { path: parent, isDirectory: true }
  }
  return { path: locationPath, isDirectory: false }
}

/**
 * 把一个会话产物移动到回收站目录（rename 优先；跨设备 EXDEV 时复制后删除原路径）。
 * @param {{sourcePath: string, isDirectory?: boolean, trashRoot: string, dirName: string, renameFn?: typeof rename}} options
 *   sourcePath 为源路径；trashRoot 为回收站根；dirName 为本次回收目录名；renameFn 仅供单测注入。
 * @returns {Promise<string>} 回收目录绝对路径。
 */
export async function moveSessionArtifact({ sourcePath, isDirectory = false, trashRoot, dirName, renameFn = rename }) {
  await mkdir(trashRoot, { recursive: true })
  const target = join(trashRoot, dirName)
  if (isDirectory) {
    try {
      await renameFn(sourcePath, target)
      return target
    } catch (error) {
      if (error?.code !== 'EXDEV') throw error
    }
    await cp(sourcePath, target, { recursive: true, force: false, errorOnExist: false })
    // EXDEV 兜底：复制成功后删除原目录（唯一允许删除原目录的分支，绝不用它做常规删除）。
    await rm(sourcePath, { recursive: true, force: true })
    return target
  }
  const finalPath = join(target, basename(sourcePath))
  try {
    await mkdir(target, { recursive: true })
    await renameFn(sourcePath, finalPath)
    return target
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
  }
  await mkdir(target, { recursive: true })
  await cp(sourcePath, finalPath, { force: false, errorOnExist: false })
  await rm(sourcePath, { force: true })
  return target
}

/** 读 live Agent（不可用时 undefined）。 */
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
 * 停掉仍在运行的成员：中断 + 轮询到非 running。
 * @param {object} ctx - 宿主上下文。
 * @param {{leadSessionId: string, memberId: string, timeoutMs: number, logSystem: (line: string) => void}} request - 根会话、成员、等待上限、日志函数。
 * @returns {Promise<boolean>} 是否中断并等到退出（本来就没在运行 → false）。
 * @throws {AdminError} 超过等待上限仍 running（409）。
 */
async function stopMember(ctx, { leadSessionId, memberId, timeoutMs, logSystem }) {
  if (liveAgent(ctx, memberId)?.status !== 'running') return false
  const leadAgent = liveAgent(ctx, leadSessionId)
  const subagents = service(ctx, 'subagents')
  if (subagents !== undefined && typeof subagents.interrupt === 'function') {
    if (leadAgent === undefined) {
      logSystem('[team-admin] 无法中断 ' + memberId + '：Lead Agent 未加载，缺少授权对象')
    } else {
      try {
        subagents.interrupt(memberId, { kind: 'ancestor', agent: leadAgent })
      } catch (error) {
        logSystem('[team-admin] 中断 ' + memberId + ' 失败：' + String(error?.message ?? error))
      }
    }
  }
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (liveAgent(ctx, memberId)?.status !== 'running') return true
    if (Date.now() >= deadline) break
    await delay(STOP_POLL_MS)
  }
  throw new AdminError('成员仍在运行，已尝试中断，请稍后重试', 'running', 409)
}

/**
 * 释放一个子会话的 Activation 注册：宿主 GUI 的子智能体选择器按注册列表渲染，
 * 只删会话文件不会摘掉该条目（点进去报 subagent/not-found）。
 * 宿主没有该方法、Lead Agent 不在线或释放失败都只记日志——删除本身已经生效。
 * @param {object} ctx - 宿主上下文。
 * @param {{leadSessionId: string, memberId: string, logSystem: (line: string) => void}} request - 根会话、成员、日志函数。
 * @returns {Promise<void>} 释放结束（失败已吞并记录）。
 */
async function releaseActivation(ctx, { leadSessionId, memberId, logSystem }) {
  const subagents = service(ctx, 'subagents')
  if (subagents === undefined || typeof subagents.drainChildren !== 'function') return
  const leadAgent = liveAgent(ctx, leadSessionId)
  if (leadAgent === undefined) {
    logSystem('[team-admin] 无法释放 ' + memberId + ' 的子会话激活：Lead Agent 未加载')
    return
  }
  try {
    await subagents.drainChildren(leadAgent, [memberId])
  } catch (error) {
    logSystem('[team-admin] 释放子会话激活 ' + memberId + ' 失败：' + String(error?.message ?? error))
  }
}

/**
 * 删除一个团队成员：停会话 → 子会话目录进回收站 → 释放子会话激活 → 写墓碑。
 * @param {object} ctx - 宿主上下文（sessionPersistence / agents / subagents 均可选）。
 * @param {{sessionId: string, name: string, deleteSession?: boolean}} request - 根会话、成员名、是否清理子会话（默认 true）。
 * @param {{store?: object, now?: number|(() => number), logSystem?: (line: string) => void, interruptTimeoutMs?: number}} [options]
 *   store 为墓碑存储；now 为墓碑时间戳；interruptTimeoutMs 为停止等待上限（默认 15s）。
 * @returns {Promise<{name: string, id: string, stopped: boolean, sessionDeleted: boolean, trashPath?: string, dismissedAt: number}>} 删除结果。
 * @throws {AdminError} not-found / bad-session / lead / provisioning / running / system。
 */
export async function dismissMember(ctx, request, options = {}) {
  const { sessionId, name } = request ?? {}
  const deleteSession = request?.deleteSession !== false
  const { store, logSystem = () => {}, interruptTimeoutMs = DEFAULT_INTERRUPT_TIMEOUT_MS } = options ?? {}
  const stamp = typeof options?.now === 'function' ? Number(options.now()) : Number.isFinite(options?.now) ? Number(options.now) : Date.now()

  if (typeof sessionId !== 'string' || sessionId === '' || typeof name !== 'string' || name === '') {
    throw new AdminError('缺少 sessionId 或 name', 'bad-request', 400)
  }
  if (name === 'lead') throw new AdminError('不能删除 Lead', 'lead', 400)
  if (store === undefined || store === null) throw new AdminError('墓碑存储不可用', 'system', 500)

  const persistence = service(ctx, 'sessionPersistence')
  if (persistence === undefined || typeof persistence.stat !== 'function') {
    throw new AdminError('宿主会话服务不可用，无法删除成员', 'system', 500)
  }
  const snapshot = await statSnapshot(persistence, sessionId)
  if (snapshot === undefined) throw new AdminError('会话不存在', 'not-found', 404)
  if (snapshot.header.parentSession !== undefined) {
    throw new AdminError('只能管理根会话的团队', 'bad-session', 400)
  }

  const log = await readSessionLog(persistence, sessionId)
  const roster = parseRoster(log.events)
  const member = roster.members.find((candidate) => candidate.name === name)
  if (member === undefined) throw new AdminError('团队成员不存在', 'not-found', 404)
  const memberId = String(member.id)

  // 幂等：已墓碑的成员直接复用原记录，不重复中断 / 移动。
  if (typeof store.listDismissed === 'function') {
    const existing = (await store.listDismissed(sessionId)).find((row) => row.id === memberId)
    if (existing !== undefined) {
      return {
        name: existing.name === undefined ? name : existing.name,
        id: memberId,
        stopped: false,
        sessionDeleted: existing.sessionDeleted === true,
        ...typeof existing.trashPath === 'string' ? { trashPath: existing.trashPath } : {},
        dismissedAt: existing.dismissedAt,
      }
    }
  }

  if (member.phase === 'provisioning') {
    throw new AdminError('成员正在创建中，请稍后再试', 'provisioning', 409)
  }

  const stopped = await stopMember(ctx, { leadSessionId: sessionId, memberId, timeoutMs: interruptTimeoutMs, logSystem })

  let sessionDeleted = false
  let trashPath
  if (deleteSession) {
    const child = await statSnapshot(persistence, memberId)
    const locationPath = child?.location?.path
    if (typeof locationPath !== 'string' || locationPath === '') {
      logSystem('[team-admin] 成员 ' + memberId + ' 没有可移动的会话产物（未落盘或已清理）')
    } else {
      const source = await resolveSource(locationPath, memberId)
      if (source === undefined) {
        logSystem('[team-admin] 成员 ' + memberId + ' 的会话产物已不存在：' + locationPath)
      } else {
        try {
          trashPath = await moveSessionArtifact({
            sourcePath: source.path,
            isDirectory: source.isDirectory,
            trashRoot: join(store.dataDir, TRASH_DIR, sessionId),
            dirName: memberId + '-' + stamp,
          })
          sessionDeleted = true
          // 会话文件已消失：让下一轮列表 / 团队详情立刻重扫，而不是等 60s 缓存过期。
          invalidateSessionListCache(ctx)
        } catch (error) {
          logSystem('[team-admin] 移动成员 ' + memberId + ' 的会话失败：' + String(error?.stack ?? error))
          throw new AdminError('成员会话移动失败，请检查服务端日志', 'system', 500)
        }
      }
    }
  }

  // 移动成功后释放该子会话的 Activation 注册；失败只记日志，删除与墓碑照常。
  if (sessionDeleted) await releaseActivation(ctx, { leadSessionId: sessionId, memberId, logSystem })

  const record = await store.record(sessionId, memberId, {
    name: isRecord(member) && typeof member.name === 'string' ? member.name : name,
    dismissedAt: stamp,
    sessionDeleted,
    ...trashPath === undefined ? {} : { trashPath },
  })
  return {
    name: record.name,
    id: memberId,
    stopped,
    sessionDeleted: record.sessionDeleted === true,
    ...typeof record.trashPath === 'string' ? { trashPath: record.trashPath } : {},
    dismissedAt: record.dismissedAt,
  }
}
