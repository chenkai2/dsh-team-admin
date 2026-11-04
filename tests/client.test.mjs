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

// —— factory / apply：两处槽位 ——

test('factory 返回 { inject: ["slots"], apply }', () => {
  const { registrations } = loadApi()
  const mod = createModule(registrations)
  assert.deepEqual(Array.from(mod.inject), ['slots'])
  assert.strictEqual(typeof mod.apply, 'function')
})

test('apply 注册 plugins.bundle.config（key = 包名）与 settings.plugin.item（key = team-admin）', () => {
  const { registrations } = loadApi()
  const mod = createModule(registrations)
  const injections = []
  const registered = []
  const ctx = {
    slots: {
      inject(name, factory) {
        injections.push({ name, factory })
        return () => {}
      },
      register(options, component) {
        registered.push({ options, component })
        return () => {}
      },
    },
    effect(fn) {
      return fn()
    },
  }
  mod.apply(ctx)
  assert.deepEqual(Array.from(injections, (entry) => entry.name), ['plugins.bundle.config', 'settings.plugin.item'])
  injections[0].factory()
  injections[1].factory()
  assert.strictEqual(registered.length, 2)
  assert.strictEqual(registered[0].options.name, 'plugins.bundle.config')
  assert.strictEqual(registered[0].options.key, '@chenkai114/dsh-team-admin')
  assert.strictEqual(registered[1].options.name, 'settings.plugin.item')
  assert.strictEqual(registered[1].options.key, 'team-admin')
  assert.strictEqual(registered[1].options.label, '智能体团队管理')
  assert.strictEqual(typeof registered[0].component, 'function')
  assert.strictEqual(registered[0].component, registered[1].component)
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
