// dsh-team-admin 宿主半区入口：给「智能体团队」补管理接口 /api/team-admin/*。
// 只读会话持久化与 live Agent 状态，不依赖内置 agent-team 的私有实现；
// 删除动作 = 停会话 → 子会话目录进回收站 → 写墓碑（内置 roster 是 append-only，记录仍在）。
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createApi } from './api.mjs'
import { collectDismissedIds, stripDismissedMembers } from './filter.mjs'
import { dismissMember } from './dismiss.mjs'
import { openStore } from './store.mjs'
import { listTeamSessions, readTeam } from './team-read.mjs'

export const name = 'team-admin'
export const inject = ['webServer']

/** 数据目录环境变量（测试注入临时目录）。 */
const DATA_DIR_ENV = 'DSH_TEAM_ADMIN_DATA_DIR'
/** 路由前缀：webServer 只支持 exact/prefix 注册。 */
const ROUTE_PREFIX = '/api/team-admin'
/** 墓碑 id 缓存时长：过滤发生在每次会话列表响应上，短缓存足够。 */
const DISMISSED_TTL_MS = 2000
/** 与 package.json 版本保持一致（发布前由测试校验）。 */
const PLUGIN_VERSION = '0.1.7'

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
 * 装配插件：惰性建 store，注册一条 prefix 路由。
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
 * 给宿主的 sessionController.list 包一层：把已删除成员从 subagentCatalog / agentTeam.members 里摘掉。
 * 顶部「子智能体」选择器与内置「智能体团队」面板都读这份响应，在源头过滤一次即可覆盖所有客户端，
 * 不需要改宿主源码，也不用重编译。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {{ getStore: () => Promise<object>, logSystem: (line: string) => void }} deps - 数据目录与日志。
 * @returns {boolean} 成功包上返回 true；宿主没有该服务时返回 false。
 */
export function installSessionListFilter(ctx, { getStore, logSystem, silent = false }) {
  const get = ctx !== null && typeof ctx?.get === 'function' ? ctx.get.bind(ctx) : null
  const service = get === null ? undefined : get('sessionController')
  if (service === null || service === undefined || typeof service.list !== 'function') {
    if (silent !== true) logSystem('team-admin：未找到 sessionController.list，跳过会话列表过滤')
    return false
  }
  const original = service.list
  let cached = { at: 0, ids: new Set() }
  const dismissedIds = async () => {
    if (Date.now() - cached.at < DISMISSED_TTL_MS) return cached.ids
    let ids = new Set()
    try {
      const store = await getStore()
      ids = collectDismissedIds(await store.readAll())
    } catch (error) {
      logSystem(`team-admin：读取墓碑失败，本次不过滤会话列表（${error instanceof Error ? error.message : String(error)}）`)
    }
    cached = { at: Date.now(), ids }
    return ids
  }
  service.list = async function teamAdminFilteredList(request, signal) {
    const value = await original.call(this, request, signal)
    try {
      const ids = await dismissedIds()
      return ids.size === 0 ? value : stripDismissedMembers(value, ids)
    } catch (error) {
      logSystem(`team-admin：过滤会话列表失败（${error instanceof Error ? error.message : String(error)}）`)
      return value
    }
  }
  return true
}