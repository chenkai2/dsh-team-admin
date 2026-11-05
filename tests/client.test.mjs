// client 半区单测：不依赖 DOM / 浏览器。
// src/client.js 是经典 script（IIFE、无 import/export），这里读文件后用 vm 求值，
// 断言纯逻辑面（状态映射 / 时间格式化 / URL 构造 / 响应校验 / 确认文案）
// 与插件形态（宿主模块表注册、槽位注册、测试挂载点）。
import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const CLIENT_URL = new URL('../src/client.js', import.meta.url)
const SOURCE = readFileSync(CLIENT_URL, 'utf8')

// 在独立 vm 上下文里求值一次经典 script；window 桩只记录 __ModuleLoader__.load。
function loadClient(options = {}) {
  const registrations = []
  const logs = []
  const sandbox = {
    console: {
      log: (...args) => logs.push(['log', args]),
      warn: (...args) => logs.push(['warn', args]),
      error: (...args) => logs.push(['error', args]),
    },
    window: { __ModuleLoader__: { load: (registration) => registrations.push(registration) } },
  }
  if (options.testHook === true) sandbox.__DshTeamAdminTestEnabled = true
  if (options.withWindow === false) delete sandbox.window
  runInNewContext(SOURCE, sandbox, { filename: 'src/client.js' })
  return { sandbox, registrations, logs }
}

function loadApi() {
  const loaded = loadClient({ testHook: true })
  assert.strictEqual(typeof loaded.sandbox.__DshTeamAdminTest, 'object', '测试可见面应挂载')
  return loaded
}

function createModule(registrations, logs) {
  const react = {
    createElement: () => null,
    useRef: () => ({ current: null }),
    useEffect: () => {},
  }
  return registrations[0].factory((specifier) => {
    assert.strictEqual(specifier, 'react')
    return react
  })
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

// —— 形态：经典 script、宿主模块表注册 ——

test('经典 script：IIFE 书挡、顶层零 import/export、可按脚本解析', () => {
  assert.match(SOURCE.trimStart(), /^\(\(\)\s*=>\s*\{/)
  assert.doesNotMatch(SOURCE, /^\s*(import|export)\s/m)
  assert.doesNotThrow(() => new Function(SOURCE))
  assert.doesNotMatch(SOURCE, /setInterval\s*\(/)
  assert.doesNotMatch(SOURCE, /(@import|url\(\s*['"]?https?:)/)
})

test('以包名向宿主模块表注册 factory', () => {
  const { registrations } = loadClient()
  assert.strictEqual(registrations.length, 1)
  assert.strictEqual(registrations[0].id, '@chenkai114/dsh-team-admin')
  assert.strictEqual(typeof registrations[0].factory, 'function')
})

test('没有宿主模块表时静默不注册', () => {
  const { registrations } = loadClient({ withWindow: false })
  assert.strictEqual(registrations.length, 0)
})

test('测试可见面只在 __DshTeamAdminTestEnabled === true 时挂载', () => {
  const on = loadClient({ testHook: true })
  assert.strictEqual(typeof on.sandbox.__DshTeamAdminTest, 'object')
  const off = loadClient()
  assert.strictEqual(off.sandbox.__DshTeamAdminTest, undefined)
})

test('测试可见面提供 mount(container) 与 helpers，且不依赖 ctx.slots', () => {
  const { sandbox } = loadApi()
  const api = sandbox.__DshTeamAdminTest
  assert.strictEqual(typeof api.mount, 'function')
  assert.strictEqual(typeof api.helpers, 'object')
  assert.strictEqual(typeof api.helpers.statusMeta, 'function')
  assert.strictEqual(typeof api.helpers.sessionsUrl, 'function')
  assert.throws(() => api.mount(null), /需要一个可挂载的 DOM 元素/)
})

test('helpers 暴露全局面板入口常量（id / label / order）', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(helpers.PANEL_ID, 'team-admin')
  assert.strictEqual(helpers.PANEL_LABEL, '团队管理')
  assert.strictEqual(helpers.PANEL_ORDER, 20)
})

// —— factory / apply：全局面板入口 + 两处配置卡片 ——

test('factory 返回 { inject: ["slots"], apply }', () => {
  const { registrations } = loadApi()
  const mod = createModule(registrations)
  assert.deepEqual(Array.from(mod.inject), ['slots'])
  assert.strictEqual(typeof mod.apply, 'function')
})

// apply 的运行台：记录注入、注册与 effect 交付的清理器，供各断言复用
function applyModule(module) {
  const injections = []
  const registered = []
  const disposed = []
  const effects = []
  const ctx = {
    slots: {
      inject(name, factory) {
        injections.push({ name, factory })
        return () => disposed.push(name)
      },
      register(options, component) {
        registered.push({ options, component })
        return () => disposed.push('register:' + String(options.key || options.id))
      },
    },
    effect(fn) {
      const disposer = fn()
      effects.push(disposer)
      return disposer
    },
  }
  module.apply(ctx)
  return { ctx, injections, registered, disposed, effects }
}

test('apply 注册 main + sidebar.panellist 全局面板入口，两者用同一 id 配对', () => {
  const { registrations } = loadApi()
  const { injections, registered, effects } = applyModule(createModule(registrations))

  assert.deepEqual(Array.from(injections, (entry) => entry.name), [
    'main',
    'sidebar.panellist',
    'conversation.session.header.actions',
    'plugins.bundle.config',
    'settings.plugin.item',
  ])
  for (const entry of injections) assert.strictEqual(typeof entry.factory, 'function')
  assert.strictEqual(effects.length, 4)

  for (const entry of injections) entry.factory()
  assert.strictEqual(registered.length, 5)

  assert.deepEqual(JSON.parse(JSON.stringify(registered[0].options)), { name: 'main', key: 'team-admin' })
  assert.strictEqual(typeof registered[0].component, 'function')
  assert.deepEqual(JSON.parse(JSON.stringify(registered[1].options)), {
    name: 'sidebar.panellist',
    id: 'team-admin',
    order: 20,
    label: '团队管理',
  })
  assert.strictEqual(typeof registered[1].component, 'function')
  // 宿主按 id === main key 配对，两个组件必须是不同构件
  assert.strictEqual(registered[1].options.id, registered[0].options.key)
  assert.notStrictEqual(registered[1].component, registered[0].component)
})

test('apply 保留 plugins.bundle.config 与 settings.plugin.item 配置卡片', () => {
  const { registrations } = loadApi()
  const { injections, registered } = applyModule(createModule(registrations))
  for (const entry of injections) entry.factory()

  const byName = (name) => registered.find((entry) => entry.options.name === name)
  assert.strictEqual(byName('plugins.bundle.config').options.key, '@chenkai114/dsh-team-admin')
  assert.strictEqual(byName('settings.plugin.item').options.key, 'team-admin')
  assert.strictEqual(byName('settings.plugin.item').options.label, '智能体团队管理')
  assert.strictEqual(typeof byName('plugins.bundle.config').component, 'function')
  assert.strictEqual(byName('plugins.bundle.config').component, byName('settings.plugin.item').component)
})

test('全局面板入口的 effect 交付组合清理器，回收两个注入', () => {
  const { registrations } = loadApi()
  const { effects, disposed } = applyModule(createModule(registrations))
  disposed.length = 0
  const disposePanel = effects[0]
  assert.strictEqual(typeof disposePanel, 'function')
  disposePanel()
  assert.deepEqual(disposed, ['main', 'sidebar.panellist'])
})

test('main 页面挂整页壳、侧栏图标按宿主 size 渲染', () => {
  const { registrations } = loadApi()
  // 这里需要真实的元素树，换成返回对象树的 createElement 桩
  const tree = (type, props, ...children) => ({ type, props, children })
  const mod = registrations[0].factory((specifier) => {
    assert.strictEqual(specifier, 'react')
    return { createElement: tree, useRef: () => ({ current: null }), useEffect: () => {} }
  })
  const { injections, registered } = applyModule(mod)
  for (const entry of injections) entry.factory()

  const page = registered[0].component({})
  assert.strictEqual(page.type, 'div')
  assert.strictEqual(page.props.className, 'ta-main')

  const icon = registered[1].component({ size: 18, active: false })
  assert.strictEqual(icon.type, 'svg')
  assert.strictEqual(icon.props.width, 18)
  assert.strictEqual(icon.props['aria-hidden'], 'true')
})

test('宿主缺 slots 服务时告警降级、不抛错', () => {
  const { registrations, logs } = loadApi()
  const mod = createModule(registrations)
  assert.doesNotThrow(() => mod.apply({}))
  assert.ok(logs.some(([level, args]) => level === 'warn' && String(args[0]).includes('slots')))
})

test('react 缺席时干净禁用并显式报错', () => {
  const { registrations, logs } = loadApi()
  const mod = registrations[0].factory(() => {
    throw new Error('no react')
  })
  assert.deepEqual(Array.from(mod.inject), [])
  assert.strictEqual(typeof mod.apply, 'function')
  assert.ok(logs.some(([level]) => level === 'error'))
})

// —— 纯逻辑：状态映射 ——

test('statusMeta 覆盖四种成员状态并兜底未知值', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.statusMeta('running'))), { label: '运行中', tone: 'run' })
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.statusMeta('inactive'))), { label: '未运行', tone: 'idle' })
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.statusMeta('provisioning'))), { label: '创建中', tone: 'warn' })
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.statusMeta('failed'))), { label: '失败', tone: 'bad' })
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.statusMeta('whatever'))), { label: '未知', tone: 'idle' })
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.statusMeta(undefined))), { label: '未知', tone: 'idle' })
})

// —— 纯逻辑：时间格式化 ——

test('formatRelativeTime 给过去时间的人话，并对未来/非法值兜底', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  const now = 1_700_000_000_000
  assert.strictEqual(helpers.formatRelativeTime(now - 500, now), '刚刚')
  assert.strictEqual(helpers.formatRelativeTime(now + 1_000, now), '刚刚')
  assert.strictEqual(helpers.formatRelativeTime(now - 60_000, now), '1 分钟前')
  assert.strictEqual(helpers.formatRelativeTime(now - 5 * 60_000, now), '5 分钟前')
  assert.strictEqual(helpers.formatRelativeTime(now - 3 * 3_600_000, now), '3 小时前')
  assert.strictEqual(helpers.formatRelativeTime(now - 2 * 86_400_000, now), '2 天前')
  assert.strictEqual(helpers.formatRelativeTime(now - 40 * 86_400_000, now), helpers.formatDateTime(now - 40 * 86_400_000))
  assert.strictEqual(helpers.formatRelativeTime(0, now), '未知')
  assert.strictEqual(helpers.formatRelativeTime(null, now), '未知')
  assert.strictEqual(helpers.formatRelativeTime(Number.NaN, now), '未知')
})

test('formatDateTime 按本地时区输出 YYYY-MM-DD HH:mm，非法值回退未知', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  const timestamp = Date.UTC(2024, 0, 2, 3, 4, 5)
  const date = new Date(timestamp)
  const expected = date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
    + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  assert.strictEqual(helpers.formatDateTime(timestamp), expected)
  assert.strictEqual(helpers.formatDateTime(0), '未知')
  assert.strictEqual(helpers.formatDateTime(null), '未知')
  assert.strictEqual(helpers.formatDateTime('2024-01-01'), '未知')
})

// —— 纯逻辑：URL / 请求体 ——

test('sessionsUrl 省略空 query 并转义关键词', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(helpers.sessionsUrl(), '/api/team-admin/sessions')
  assert.strictEqual(helpers.sessionsUrl(''), '/api/team-admin/sessions')
  assert.strictEqual(helpers.sessionsUrl('   '), '/api/team-admin/sessions')
  assert.strictEqual(helpers.sessionsUrl(' abc '), '/api/team-admin/sessions?query=abc')
  assert.strictEqual(helpers.sessionsUrl('a b&c'), '/api/team-admin/sessions?query=a%20b%26c')
  assert.strictEqual(helpers.sessionsUrl('智能体'), '/api/team-admin/sessions?query=' + encodeURIComponent('智能体'))
})

test('teamUrl / dismissPayload 构造请求', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(helpers.teamUrl('s/1'), '/api/team-admin/team?sessionId=s%2F1')
  assert.strictEqual(helpers.teamUrl(undefined), '/api/team-admin/team?sessionId=')
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.dismissPayload('s1', '小 A'))), {
    sessionId: 's1',
    name: '小 A',
    deleteSession: true,
  })
  assert.strictEqual(helpers.DEBOUNCE_MS, 300)
})

// —— 纯逻辑：响应校验 ——

test('readSessionsPayload 校验收口并补默认值', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  const bad = helpers.readSessionsPayload(null)
  assert.strictEqual(bad.ok, false)
  assert.strictEqual(bad.error, '服务返回的会话列表格式不正确')
  assert.strictEqual(helpers.readSessionsPayload({ sessions: 'nope' }).ok, false)

  const empty = helpers.readSessionsPayload({ sessions: [] })
  assert.strictEqual(empty.ok, true)
  assert.strictEqual(empty.sessions.length, 0)

  const parsed = helpers.readSessionsPayload({
    sessions: [
      { id: 'a' },
      { id: 'b', title: '标题', cwd: '/tmp/x', createdAt: 5, lastActivityAt: 9, live: true },
      { title: '没有 id 的行会被丢掉' },
    ],
  })
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.sessions.length, 2)
  assert.strictEqual(parsed.sessions[0].id, 'a')
  assert.strictEqual(parsed.sessions[0].title, 'a')
  assert.strictEqual(parsed.sessions[0].cwd, '')
  assert.strictEqual(parsed.sessions[0].live, false)
  assert.strictEqual(parsed.sessions[1].title, '标题')
  assert.strictEqual(parsed.sessions[1].lastActivityAt, 9)
  assert.strictEqual(parsed.sessions[1].live, true)
})

test('pickSessionId 保留仍存在的选中项，否则落到第一条', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  const sessions = [{ id: 'a' }, { id: 'b' }]
  assert.strictEqual(helpers.pickSessionId(sessions, 'b'), 'b')
  assert.strictEqual(helpers.pickSessionId(sessions, 'gone'), 'a')
  assert.strictEqual(helpers.pickSessionId(sessions, null), 'a')
  assert.strictEqual(helpers.pickSessionId([], 'a'), null)
  assert.strictEqual(helpers.pickSessionId(null, 'a'), null)
})

test('readTeamPayload 校验 members 并规范化成员/墓碑行', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(helpers.readTeamPayload(null).ok, false)
  assert.strictEqual(helpers.readTeamPayload({}).ok, false)
  assert.strictEqual(helpers.readTeamPayload({ members: 'nope' }).ok, false)

  const minimal = helpers.readTeamPayload({ members: [] })
  assert.strictEqual(minimal.ok, true)
  assert.strictEqual(minimal.data.session, null)
  assert.strictEqual(minimal.data.members.length, 0)
  assert.strictEqual(minimal.data.dismissed.length, 0)

  const parsed = helpers.readTeamPayload({
    session: { id: 'lead', title: '主会话', cwd: '/w' },
    members: [
      { id: 'm1' },
      {
        id: 'm2',
        name: '小 A',
        phase: 'failed',
        status: 'running',
        description: '写代码',
        provider: 'deepseek',
        context: 'fork',
        model: 'deepseek-chat',
        error: 'boom',
        dismissed: true,
        sessionExists: false,
        ownedTasks: 3,
        lastActivityAt: 7,
      },
      { id: 'm3', phase: 'nonsense', status: 'nonsense', context: 'nonsense' },
    ],
    dismissed: [
      { id: 'd1', name: '小 B', dismissedAt: 11, sessionDeleted: true, trashPath: '/trash/x' },
      { notAnId: true },
    ],
  })
  assert.strictEqual(parsed.ok, true)
  assert.strictEqual(parsed.data.session.title, '主会话')
  assert.strictEqual(parsed.data.members.length, 3)
  assert.strictEqual(parsed.data.members[0].name, 'm1')
  assert.strictEqual(parsed.data.members[0].phase, 'active')
  assert.strictEqual(parsed.data.members[0].status, 'inactive')
  assert.strictEqual(parsed.data.members[0].context, 'fresh')
  assert.strictEqual(parsed.data.members[0].dismissed, false)
  assert.strictEqual(parsed.data.members[0].sessionExists, true)
  assert.strictEqual(parsed.data.members[0].ownedTasks, 0)
  assert.strictEqual(parsed.data.members[0].lastActivityAt, null)
  assert.strictEqual(parsed.data.members[1].model, 'deepseek-chat')
  assert.strictEqual(parsed.data.members[1].error, 'boom')
  assert.strictEqual(parsed.data.members[1].dismissed, true)
  assert.strictEqual(parsed.data.members[1].sessionExists, false)
  assert.strictEqual(parsed.data.members[1].ownedTasks, 3)
  assert.strictEqual(parsed.data.members[1].context, 'fork')
  assert.strictEqual(parsed.data.members[2].phase, 'active')
  assert.strictEqual(parsed.data.members[2].status, 'inactive')
  assert.strictEqual(parsed.data.dismissed.length, 1)
  assert.strictEqual(parsed.data.dismissed[0].name, '小 B')
  assert.strictEqual(parsed.data.dismissed[0].dismissedAt, 11)
  assert.strictEqual(parsed.data.dismissed[0].sessionDeleted, true)
  assert.strictEqual(parsed.data.dismissed[0].trashPath, '/trash/x')
  assert.strictEqual(parsed.data.dismissed[0].memberStillInRoster, true)
})

test('readDismissResult 收口可空响应并保留 fallback 名字', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  const fallback = helpers.readDismissResult(null, { name: '小 A', id: 'm1' })
  assert.strictEqual(fallback.name, '小 A')
  assert.strictEqual(fallback.id, 'm1')
  assert.strictEqual(fallback.stopped, false)
  assert.strictEqual(fallback.sessionDeleted, false)
  assert.strictEqual(fallback.trashPath, '')
  assert.strictEqual(fallback.dismissedAt, 0)

  const parsed = helpers.readDismissResult({
    ok: true,
    name: '小 B',
    id: 'm2',
    stopped: true,
    sessionDeleted: true,
    trashPath: '/trash/y',
    dismissedAt: 12,
  }, null)
  assert.strictEqual(parsed.name, '小 B')
  assert.strictEqual(parsed.id, 'm2')
  assert.strictEqual(parsed.stopped, true)
  assert.strictEqual(parsed.sessionDeleted, true)
  assert.strictEqual(parsed.trashPath, '/trash/y')
  assert.strictEqual(parsed.dismissedAt, 12)
})

// —— 纯逻辑：确认/结果/错误文案 ——

test('confirmDismissText 带成员名', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(helpers.confirmDismissText('小 A'), '确认删除成员「小 A」？')
  assert.strictEqual(helpers.confirmDismissText(null), '确认删除成员「」？')
})

test('dismissResultText 说明会话去向与回收站路径', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(
    helpers.dismissResultText({ name: '小 A', sessionDeleted: true, trashPath: '/trash/x' }),
    '已删除成员「小 A」，会话已移入回收站：/trash/x',
  )
  assert.strictEqual(helpers.dismissResultText({ name: '小 B', sessionDeleted: false }), '已删除成员「小 B」，会话已保留')
  assert.strictEqual(helpers.dismissResultText(null), '已删除成员「该成员」，会话已保留')
})

test('apiErrorText 优先透传服务端 error，缺失时给 HTTP 状态', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(helpers.apiErrorText({ error: '成员正在创建中，请稍后再试' }, 409), '成员正在创建中，请稍后再试')
  assert.strictEqual(helpers.apiErrorText({ error: '   ' }, 400), '请求失败（HTTP 400）')
  assert.strictEqual(helpers.apiErrorText(null, 500), '请求失败（HTTP 500）')
})

test('networkErrorText 给人话兜底并保留原始错误摘要', () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(helpers.networkErrorText(null), '无法连接本机服务，请确认 dsh web 仍在运行后重试')
  assert.strictEqual(
    helpers.networkErrorText(new Error('Failed to fetch')),
    '无法连接本机服务，请确认 dsh web 仍在运行后重试（Failed to fetch）',
  )
})

test('copyText 在没有剪贴板/文档时安全返回 false', async () => {
  const { helpers } = loadApi().sandbox.__DshTeamAdminTest
  assert.strictEqual(await helpers.copyText(''), false)
  assert.strictEqual(await helpers.copyText('/trash/x'), false)
})

test('ensureStyle 只注入一次，且用宿主令牌而非硬编码颜色', () => {
  const { sandbox } = loadApi()
  const style = {
    id: '',
    textContent: '',
    setAttribute(name, value) {
      this[name] = value
    },
  }
  const appended = []
  const doc = {
    head: { appendChild: (node) => appended.push(node) },
    getElementById: () => (appended.length === 0 ? null : appended[0]),
    createElement: () => style,
  }
  sandbox.__DshTeamAdminTest.ensureStyle(doc)
  sandbox.__DshTeamAdminTest.ensureStyle(doc)
  assert.strictEqual(appended.length, 1)
  assert.strictEqual(style.id, 'dsh-team-admin-style')
  assert.strictEqual(style['data-plugin'], '@chenkai114/dsh-team-admin')
  assert.match(style.textContent, /var\(--dsw-alias-label-primary/)
  assert.match(style.textContent, /\.ta-root/)
})

test('整页面板撑满：卡片与左右两栏一路 flex:1，列表不再固定高度封顶', () => {
  const { sandbox } = loadApi()
  const style = { id: '', textContent: '', setAttribute(name, value) { this[name] = value } }
  const appended = []
  const doc = {
    head: { appendChild: (node) => appended.push(node) },
    getElementById: () => (appended.length === 0 ? null : appended[0]),
    createElement: () => style,
  }
  sandbox.__DshTeamAdminTest.ensureStyle(doc)
  // 外层 main 壳自身是 flex 列容器，不靠内容撑高
  assert.match(style.textContent, /\.ta-main\{display:flex;flex-direction:column;flex:1;min-height:0/)
  assert.match(style.textContent, /\.ta-main__inner\{display:flex;flex-direction:column;flex:1;min-height:0;width:100%/)
  // 宽度不再被 max-width 收窄（用户要求占满）
  assert.doesNotMatch(style.textContent, /\.ta-main__inner\{[^}]*max-width/)
  // 卡片、两栏、会话列表逐级撑满，列表靠内部滚动而不是 max-height
  assert.match(style.textContent, /\.ta-main \.ta-root\{flex:1;min-height:0\}/)
  assert.match(style.textContent, /\.ta-main \.ta-body\{[^}]*flex:1;min-height:0/)
  assert.match(style.textContent, /\.ta-main \.ta-sessions\{[^}]*max-height:none/)
  // 小屏断点仍在
  assert.match(style.textContent, /@media \(max-width:760px\)/)
})

// —— 宿主会话列表过滤（不改宿主源码，插件内拦截 fetch） ——

test('stripDismissedCatalogs：按墓碑摘掉 subagentCatalog 失效条目，其余原样', () => {
  const { sandbox } = loadApi()
  const api = sandbox.__DshTeamAdminTest.helpers
  const payload = { items: [{ projections: { values: { subagentCatalog: [{ id: 'm1', label: 'A' }, { id: 'm2', label: 'B' }] } } }] }
  const returned = api.stripDismissedCatalogs(payload, new Set(['m1']))
  assert.strictEqual(returned, payload)
  assert.deepStrictEqual(payload.items[0].projections.values.subagentCatalog, [{ id: 'm2', label: 'B' }])
  assert.strictEqual(api.stripDismissedCatalogs(null, new Set(['m1'])), null)
  const untouched = { value: 1 }
  assert.strictEqual(api.stripDismissedCatalogs(untouched, new Set()), untouched)
  const roster = { projections: { values: { agentTeam: { members: [{ id: 'm1', name: 'client-ui' }, { id: 'm2', name: 'ui-debug' }] } } } }
  api.stripDismissedCatalogs(roster, new Set(['m1']))
  assert.deepStrictEqual(roster.projections.values.agentTeam.members, [{ id: 'm2', name: 'ui-debug' }])
  const unrelated = { items: [{ values: { subagentCatalog: 'not-an-array' } }] }
  assert.deepStrictEqual(api.stripDismissedCatalogs(unrelated, new Set(['m1'])), unrelated)
})

test('installSessionListFilter：只包装一次、只改 /api/session/list 响应、失败放行', async () => {
  const { sandbox } = loadApi()
  const api = sandbox.__DshTeamAdminTest.helpers
  const calls = []
  const response = (payload) => ({
    ok: true, status: 200, statusText: 'OK', headers: {},
    json: async () => JSON.parse(JSON.stringify(payload)),
    clone() { return { json: async () => JSON.parse(JSON.stringify(payload)) } },
  })
  sandbox.Response = class {
    constructor(body, init) { this.body = body; this.status = init === undefined ? 200 : init.status }
  }
  sandbox.fetch = async (url) => {
    calls.push(url)
    if (url === api.DISMISSED_URL) return response({ ids: ['m1'] })
    if (url === '/api/session/list') return response({ items: [{ subagentCatalog: [{ id: 'm1' }, { id: 'm2' }] }] })
    return response({ other: true })
  }
  assert.strictEqual(api.installSessionListFilter(sandbox), true)
  assert.strictEqual(api.installSessionListFilter(sandbox), false)
  const filtered = await sandbox.fetch('/api/session/list')
  assert.deepStrictEqual(JSON.parse(filtered.body).items[0].subagentCatalog, [{ id: 'm2' }])
  const other = await sandbox.fetch('/api/other')
  assert.strictEqual(other.status, 200)
  assert.ok(calls.includes(api.DISMISSED_URL))
})
test('模块加载阶段就安装列表过滤器（早于 apply）', () => {
  const registrations = []
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: {
      __ModuleLoader__: { load: (registration) => registrations.push(registration) },
      fetch: async () => ({ ok: true, json: async () => ({ ids: [] }) }),
    },
  }
  runInNewContext(SOURCE, sandbox, { filename: 'src/client.js' })
  assert.strictEqual(sandbox.window.__dshTeamAdminSessionListFilter__, true)
  assert.match(String(sandbox.window.fetch), /teamAdminAwareFetch/)
  assert.strictEqual(registrations.length, 1)
})
test('stripDismissedCatalogs：按墓碑摘掉 subagentCatalog 与 agentTeam.members 里的失效条目', () => {
  const { sandbox } = loadApi()
  const api = sandbox.__DshTeamAdminTest.helpers
  const payload = { items: [{ projections: { values: {
    subagentCatalog: [{ id: 'm1', label: 'A' }, { id: 'm2', label: 'B' }],
    agentTeam: { members: [{ id: 'm1', name: 'client-ui' }, { id: 'm2', name: 'ui-debug' }] },
  } } }] }
  assert.strictEqual(api.stripDismissedCatalogs(payload, new Set(['m1'])), payload)
  assert.deepStrictEqual(payload.items[0].projections.values.subagentCatalog, [{ id: 'm2', label: 'B' }])
  assert.deepStrictEqual(payload.items[0].projections.values.agentTeam.members, [{ id: 'm2', name: 'ui-debug' }])
  assert.strictEqual(api.stripDismissedCatalogs(null, new Set(['m1'])), null)
})

test('installSessionListFilter：只包装一次、相对路径也命中、其余请求直通', async () => {
  const { sandbox } = loadApi()
  const api = sandbox.__DshTeamAdminTest.helpers
  const response = (payload) => ({
    ok: true, status: 200, statusText: 'OK', headers: {},
    json: async () => JSON.parse(JSON.stringify(payload)),
    clone() { return { json: async () => JSON.parse(JSON.stringify(payload)) } },
  })
  sandbox.Response = class { constructor(body, init) { this.body = body; this.status = init === undefined ? 200 : init.status } }
  sandbox.fetch = async (url) => {
    if (url === api.DISMISSED_URL) return response({ ids: ['m1'] })
    if (url === 'api/session/list') return response({ items: [{ subagentCatalog: [{ id: 'm1' }, { id: 'm2' }] }] })
    return response({ other: true })
  }
  assert.strictEqual(api.installSessionListFilter(sandbox), true)
  assert.strictEqual(api.installSessionListFilter(sandbox), false)
  const filtered = await sandbox.fetch('api/session/list')
  assert.deepStrictEqual(JSON.parse(filtered.body).items[0].subagentCatalog, [{ id: 'm2' }])
  assert.strictEqual((await sandbox.fetch('/api/other')).status, 200)
})

test('模块加载阶段就安装过滤器（早于 apply）', () => {
  const registrations = []
  const sandbox = {
    console: { log() {}, warn() {}, error() {} },
    window: {
      __ModuleLoader__: { load: (registration) => registrations.push(registration) },
      fetch: async () => ({ ok: true, json: async () => ({ ids: [] }) }),
    },
  }
  runInNewContext(SOURCE, sandbox, { filename: 'src/client.js' })
  assert.strictEqual(sandbox.window.__dshTeamAdminSessionListFilter__, true)
  assert.match(String(sandbox.window.fetch), /teamAdminAwareFetch/)
  assert.strictEqual(registrations.length, 1)
})

test('installResponseFilter：宿主绕过 window.fetch 时，解析 JSON 的消费方也拿到过滤后数据', async () => {
  const { sandbox } = loadApi()
  const api = sandbox.__DshTeamAdminTest.helpers
  sandbox.fetch = async () => ({ ok: true, json: async () => ({ ids: ['m1'] }) })
  await api.refreshDismissedIds()
  class FakeResponse {
    constructor(body) { this.body = body }
    async json() { return JSON.parse(this.body) }
    async text() { return this.body }
  }
  const scope = { Response: FakeResponse }
  assert.strictEqual(api.installResponseFilter(scope), true)
  assert.strictEqual(api.installResponseFilter(scope), false)
  const parsed = await new FakeResponse(JSON.stringify({ values: { subagentCatalog: [{ id: 'm1' }, { id: 'm2' }] } })).json()
  assert.deepStrictEqual(parsed.values.subagentCatalog, [{ id: 'm2' }])
  const text = await new FakeResponse(JSON.stringify({ values: { agentTeam: { members: [{ id: 'm1' }, { id: 'm3' }] } } })).text()
  assert.deepStrictEqual(JSON.parse(text).values.agentTeam.members, [{ id: 'm3' }])
})
test('apply 注册页头成员动作（新版宿主恢复旧版成员列表）', () => {
  const { registrations } = loadApi()
  const { injections, registered } = applyModule(createModule(registrations))
  assert.ok(injections.some((entry) => entry.name === 'conversation.session.header.actions'))
  const headerInjection = injections.find((entry) => entry.name === 'conversation.session.header.actions')
  assert.ok(headerInjection !== undefined, '应注入页头成员动作')
  headerInjection.factory()
  const header = registered.find((entry) => entry.options.name === 'conversation.session.header.actions')
  assert.ok(header !== undefined, '应注册页头成员动作')
  assert.strictEqual(header.options.id, 'team-admin-members')
})