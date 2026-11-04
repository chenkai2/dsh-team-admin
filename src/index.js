// dsh-team-admin 宿主半区入口：给「智能体团队」补管理接口 /api/team-admin/*。
// 只读会话持久化与 live Agent 状态，不依赖内置 agent-team 的私有实现；
// 删除动作 = 停会话 → 子会话目录进回收站 → 写墓碑（内置 roster 是 append-only，记录仍在）。
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createApi } from './api.mjs'
import { dismissMember } from './dismiss.mjs'
import { collectDismissedIds, stripDismissedMembers } from './filter.mjs'
import { openStore } from './store.mjs'
import { listTeamSessions, readTeam } from './team-read.mjs'

export const name = 'team-admin'
export const inject = ['webServer']

/** 数据目录环境变量（测试注入临时目录）。 */
const DATA_DIR_ENV = 'DSH_TEAM_ADMIN_DATA_DIR'
/** 路由前缀：webServer 只支持 exact/prefix 注册。 */
const ROUTE_PREFIX = '/api/team-admin'
/** 墓碑 id 缓存时长：过滤发生在每次投影响应/帧上，短缓存足够。 */
const DISMISSED_TTL_MS = 2000
/** 包装标记：apply 与延迟注入可能都执行一次，避免重复包装。 */
const FILTER_MARK = Symbol.for('dsh.team-admin.projection-filter')
/** 单值出口：一次请求/一次流的快照。 */
const UNARY_METHODS = ['list', 'projections']
/** 流出口：control 基线携带全部投影，follow 携带单个会话的开场快照。 */
const STREAM_METHODS = ['control', 'follow']
/** 与 package.json 版本保持一致（发布前由测试校验）。 */
const PLUGIN_VERSION = '0.1.9'

/**
 * 解析插件数据目录。
 * @param {NodeJS.ProcessEnv} [env] - 进程环境。
 * @param {string} [home] - 用户主目录。
 * @returns {string} 数据目录绝对路径。
 */
export function resolveDataDir(env = process.env, home = homedir()) {
  const override = env[DATA_DIR_ENV]
  if (typeof override === 'string' && override.trim() !== '') return override.trim()
  return join(home, '.dsh', 'team-admin')
}

/**
 * 装配插件：惰性建 store，注册一条 prefix 路由，并给投影出口加过滤。
 * @param {object} ctx - Cordis 插件上下文。
 */
export function apply(ctx) {
  const dataDir = resolveDataDir()
  let storePromise = null
  const getStore = () => {
    if (storePromise === null) {
      storePromise = openStore({ dir: dataDir }).catch((error) => {
        storePromise = null
        throw error
      })
    }
    return storePromise
  }
  const logSystem = (line) => {
    if (typeof ctx.logger?.warn === 'function') ctx.logger.warn(line)
  }
  const handler = createApi({
    ctx,
    getStore,
    version: PLUGIN_VERSION,
    logSystem,
    services: { listTeamSessions, readTeam, dismissMember },
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'team-admin routes',
  )
  if (!installSessionListFilter(ctx, { getStore, logSystem, silent: true }) && typeof ctx.inject === 'function') {
    // 插件可能早于 sessionController 注册；等服务可用后再包一次。
    ctx.inject(['sessionController'], (sub) => installSessionListFilter(sub, { getStore, logSystem }))
  }
}

/**
 * 建一个带短缓存的墓碑 id 读取器。
 * @param {() => Promise<object>} getStore - 惰性打开的状态存储。
 * @param {(line: string) => void} logSystem - 系统日志。
 * @returns {() => Promise<Set<string>>} 读取已删除成员 id。
 */
function createDismissedIds(getStore, logSystem) {
  let cached = { at: 0, ids: new Set() }
  return async () => {
    if (Date.now() - cached.at < DISMISSED_TTL_MS) return cached.ids
    let ids = new Set()
    try {
      const store = await getStore()
      ids = collectDismissedIds(await store.readAll())
    } catch (error) {
      logSystem(`team-admin：读取墓碑失败，本次不过滤投影（${error instanceof Error ? error.message : String(error)}）`)
    }
    cached = { at: Date.now(), ids }
    return ids
  }
}

/**
 * 给宿主的 sessionController 出口包一层：把已删除成员从 subagentCatalog / agentTeam.members 里摘掉。
 * 顶部「子智能体」选择器读 `list` 与 `control` 基线，内置「智能体团队」面板读同一批投影，
 * 因此在宿主出口过滤一次即可覆盖所有客户端，不需要改宿主源码，也不用重编译。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {{ getStore: () => Promise<object>, logSystem: (line: string) => void, silent?: boolean }} deps - 存储与日志。
 * @returns {boolean} 至少包上一个方法时返回 true。
 */
export function installSessionListFilter(ctx, { getStore, logSystem, silent = false }) {
  const get = ctx !== null && typeof ctx?.get === 'function' ? ctx.get.bind(ctx) : null
  const service = get === null ? undefined : get('sessionController')
  if (service === null || service === undefined) {
    if (silent !== true) logSystem('team-admin：未找到 sessionController，跳过投影过滤')
    return false
  }
  if (service[FILTER_MARK] === true) return false
  const dismissedIds = createDismissedIds(getStore, logSystem)
  const strip = async (value) => {
    try {
      const ids = await dismissedIds()
      return ids.size === 0 ? value : stripDismissedMembers(value, ids, 10)
    } catch (error) {
      logSystem(`team-admin：过滤投影失败（${error instanceof Error ? error.message : String(error)}）`)
      return value
    }
  }
  let wrapped = 0
  for (const method of UNARY_METHODS) {
    const original = service[method]
    if (typeof original !== 'function') continue
    service[method] = async function teamAdminFilteredUnary(...args) {
      return await strip(await original.apply(this, args))
    }
    wrapped += 1
  }
  for (const method of STREAM_METHODS) {
    const original = service[method]
    if (typeof original !== 'function') continue
    service[method] = async function* teamAdminFilteredStream(...args) {
      for await (const frame of original.apply(this, args)) yield await strip(frame)
    }
    wrapped += 1
  }
  if (wrapped === 0) {
    if (silent !== true) logSystem('team-admin：sessionController 上没有可过滤的方法，跳过投影过滤')
    return false
  }
  service[FILTER_MARK] = true
  return true
}
