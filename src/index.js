// dsh-team-admin 宿主半区入口：给「智能体团队」补管理接口 /api/team-admin/*。
// 只读会话持久化与 live Agent 状态，不依赖内置 agent-team 的私有实现；
// 删除动作 = 停会话 → 子会话目录进回收站 → 写墓碑（内置 roster 是 append-only，记录仍在）。
import { homedir } from 'node:os'
import { join } from 'node:path'

import { createApi } from './api.mjs'
import { dismissMember } from './dismiss.mjs'
import { openStore } from './store.mjs'
import { listTeamSessions, readTeam } from './team-read.mjs'

export const name = 'team-admin'
export const inject = ['webServer']

/** 数据目录环境变量（测试注入临时目录）。 */
const DATA_DIR_ENV = 'DSH_TEAM_ADMIN_DATA_DIR'
/** 路由前缀：webServer 只支持 exact/prefix 注册。 */
const ROUTE_PREFIX = '/api/team-admin'
/** 与 package.json 版本保持一致（发布前由测试校验）。 */
const PLUGIN_VERSION = '0.1.4'

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
}