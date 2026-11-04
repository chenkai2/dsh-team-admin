// dsh-team-admin 宿主半区入口：给「智能体团队」补管理接口 /api/team-admin/*。
// 只读会话持久化与 live Agent 状态，不依赖内置 agent-team 的私有实现；
// 删除动作 = 停会话 → 子会话目录进回收站 → 写墓碑（内置 roster 是 append-only，记录仍在）。
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createApi } from './api.mjs'
import { dismissMember } from './dismiss.mjs'
import { collectDismissedByTeam, collectDismissedIds, stripDismissedMembers } from './filter.mjs'
import { createLegacyDecorator } from './legacy.mjs'
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
/** roster 预算标记、刷新句柄与统计读取。 */
const ROSTER_MARK = Symbol.for('dsh.team-admin.roster-budget')
const ROSTER_REFRESH = Symbol.for('dsh.team-admin.roster-refresh')
const ROSTER_STATS = Symbol.for('dsh.team-admin.roster-stats')
/** 单值出口：一次请求/一次流的快照。 */
const UNARY_METHODS = ['list', 'projections']
/** 流出口：control 基线携带全部投影，follow 携带单个会话的开场快照。 */
const STREAM_METHODS = ['control', 'follow']
/** 与 package.json 版本保持一致（发布前由测试校验）。 */
const PLUGIN_VERSION = '0.2.2'

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
 * 装配插件：惰性建 store，注册一条 prefix 路由；再给投影出口与成员名额加补丁。
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
  const decorateList = createLegacyDecorator()
  const ensureBudget = () => installRosterBudget(ctx, { getStore, logSystem, silent: true })
  // 诊断用：读当前生效的成员上限与回收结果（按团队）。
  const readRosterBudget = () => {
    const service = typeof ctx.get === 'function' ? ctx.get('agentTeams') : undefined
    const roster = service === null || service === undefined ? undefined : service.roster
    if (roster === undefined || roster === null) return null
    if (typeof roster[ROSTER_STATS] === 'function') return roster[ROSTER_STATS]()
    return typeof roster.maxMembers === 'number' ? { maxMembers: roster.maxMembers, reclaimed: 0, teams: {} } : null
  }
  const handler = createApi({
    ctx,
    getStore,
    version: PLUGIN_VERSION,
    logSystem,
    services: {
      listTeamSessions,
      readTeam,
      dismissMember,
      // 删除成功后按团队重算名额。
      onMemberDismissed: () => { void ensureBudget()?.() },
      readRosterBudget,
    },
  })
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler }),
    'team-admin routes',
  )
  ensureBudget()
  if (typeof ctx.inject === 'function') {
    ctx.inject(['agentTeams'], (sub) => installRosterBudget(sub, { getStore, logSystem }))
  }
  if (!installSessionListFilter(ctx, { getStore, logSystem, decorateList, silent: true }) && typeof ctx.inject === 'function') {
    // 插件可能早于 sessionController 注册；等服务可用后再包一次。
    ctx.inject(['sessionController'], (sub) => installSessionListFilter(sub, { getStore, logSystem, decorateList }))
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
 * 给宿主的 sessionController 出口包一层：把已删除成员从 subagentCatalog / agentTeam.members 里摘掉，
 * 并给老格式会话补标题/空白标记。顶部选择器与团队面板读 `list` 与 `control` 基线，
 * 在宿主出口处理一次即可覆盖所有客户端，不需要改宿主源码，也不用重新编译。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {{ getStore: () => Promise<object>, logSystem: (line: string) => void, decorateList?: (value: object) => object, silent?: boolean }} deps - 存储、日志与列表补全器。
 * @returns {boolean} 至少包上一个方法时返回 true。
 */
export function installSessionListFilter(ctx, { getStore, logSystem, decorateList, silent = false }) {
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
      const value = await strip(await original.apply(this, args))
      return method === 'list' && typeof decorateList === 'function' ? decorateList(value) : value
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

/**
 * 把「已删除成员」占掉的名额还给**它所在的那个团队**：宿主的 `TeamRoster.spawnAdmitted`
 * 用 `journal.state(root).members.length >= this.maxMembers` 判断，roster 只有一个上限字段。
 * 这里在每次 spawn 前按 caller 的 Lead 设置本次生效的额外名额，spawn 结束清零。
 * @param {object} ctx - Cordis 插件上下文。
 * @param {{ getStore: () => Promise<object>, logSystem: (line: string) => void, silent?: boolean }} deps - 存储与日志。
 * @returns {null | (() => Promise<number>)} 刷新名额的函数；宿主没有 agentTeams 时返回 null。
 */
export function installRosterBudget(ctx, { getStore, logSystem, silent = false }) {
  const get = ctx !== null && typeof ctx?.get === 'function' ? ctx.get.bind(ctx) : null
  const service = get === null ? undefined : get('agentTeams')
  const roster = service === null || service === undefined ? undefined : service.roster
  if (roster === undefined || roster === null || typeof roster.maxMembers !== 'number') {
    if (silent !== true) logSystem('team-admin：未找到 agentTeams.roster，跳过名额回收')
    return null
  }
  if (roster[ROSTER_MARK] === true) return roster[ROSTER_REFRESH]
  const base = roster.maxMembers
  const extras = new Map()
  const live = { current: 0, total: 0 }
  Object.defineProperty(roster, 'maxMembers', {
    configurable: true,
    enumerable: true,
    get: () => base + live.current,
  })
  const originalSpawn = roster.spawn
  if (typeof originalSpawn === 'function') {
    roster.spawn = async function teamAdminScopedSpawn(caller, request) {
      let extra = 0
      try { extra = extras.get(this.membership(caller).root.id) ?? 0 } catch (error) { void error }
      live.current = extra
      try {
        return await originalSpawn.call(this, caller, request)
      } finally {
        live.current = 0
      }
    }
  }
  const refresh = async () => {
    try {
      const store = await getStore()
      const teams = collectDismissedByTeam(await store.readAll())
      extras.clear()
      live.total = 0
      for (const [leadId, ids] of teams) {
        extras.set(leadId, ids.size)
        live.total += ids.size
      }
      return live.total
    } catch (error) {
      logSystem(`team-admin：读取墓碑失败，名额不回收（${error instanceof Error ? error.message : String(error)}）`)
      return 0
    }
  }
  roster[ROSTER_MARK] = true
  roster[ROSTER_REFRESH] = refresh
  roster[ROSTER_STATS] = () => ({ maxMembers: base, reclaimed: live.total, teams: Object.fromEntries(extras) })
  void refresh()
  return refresh
}
