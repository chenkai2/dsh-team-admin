/** e2e 用的假团队数据（形状与 docs/CONTRACT.md 一致）。 */

const now = Date.now()

export const sessions = [
  { id: 'session-lead-a', title: '组队试炼自动化（示例会话）', cwd: '/Users/demo/yxmys-farm', createdAt: now - 86400000 * 3, lastActivityAt: now - 60000, live: false },
  { id: 'session-lead-b', title: '无团队的普通会话', cwd: '/Users/demo/other', createdAt: now - 86400000, lastActivityAt: now - 3600000, live: false },
]

export const teams = {
  'session-lead-a': {
    session: sessions[0],
    members: [
      { name: 'wasm-researcher', id: 'child-1', phase: 'active', status: 'inactive', description: '实证 WASM 接管方案', provider: 'spawn', context: 'fresh', model: 'deepseek-flash', dismissed: false, sessionExists: true, ownedTasks: 0, lastActivityAt: now - 7200000 },
      { name: 'trial-runner', id: 'child-2', phase: 'active', status: 'running', description: '组队试炼执行者', provider: 'spawn', context: 'fresh', model: 'deepseek-flash', dismissed: false, sessionExists: true, ownedTasks: 2, lastActivityAt: now - 30000 },
      { name: 'mine-migrator', id: 'child-3', phase: 'failed', status: 'failed', description: '挖矿迁移（创建失败）', provider: 'spawn', context: 'fresh', dismissed: false, sessionExists: false, ownedTasks: 0, lastActivityAt: null, error: 'provisioning did not leave a resumable child Session' },
    ],
    dismissed: [],
  },
  'session-lead-b': { session: sessions[1], members: [], dismissed: [] },
}

export function dismissedState() {
  return {
    'session-lead-a': {
      'child-3': { name: 'mine-migrator', dismissedAt: now - 120000, sessionDeleted: true, trashPath: '/Users/demo/.dsh/team-admin/trash/session-lead-a/child-3' },
    },
  }
}
