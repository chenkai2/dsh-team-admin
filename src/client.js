(() => {
  // dsh-team-admin client 半区：全局面板入口（sidebar.panellist「团队管理」+ main 中央页面），
  // 同时保留插件管理页（plugins.bundle.config）与设置页（settings.plugin.item）的配置卡片。
  // 经典 script：IIFE 书挡、零 import/export、无构建；按宿主模块表约定以包名注册 factory。
  //
  // 渲染只有一份实现：createPanelController 用原生 DOM 建树（测试/e2e 可直接 mount），
  // React 侧仅用一个宿主 div 承载同一个 controller，不做第二份 UI。
  // 纯逻辑（状态映射 / 时间格式化 / URL 构造 / 响应校验 / 确认文案）挂到
  // globalThis.__DshTeamAdminTest.helpers，仅在测试开关打开时生效，浏览器里不留全局。

  const PKG_ID = '@chenkai114/dsh-team-admin'
  const SETTINGS_KEY = 'team-admin'
  const API_BASE = '/api/team-admin'
  const STYLE_ID = 'dsh-team-admin-style'
  const DEBOUNCE_MS = 300
  const SECOND_MS = 1000
  const MINUTE_MS = 60 * SECOND_MS
  const HOUR_MS = 60 * MINUTE_MS
  const DAY_MS = 24 * HOUR_MS
  const COPIED_RESET_MS = 1600

  const PANEL_ID = 'team-admin'
  const PANEL_LABEL = '团队管理'
  const PANEL_ORDER = 20

  const CARD_TITLE = '智能体团队管理'
  const CARD_SUMMARY = '选择任意会话，查看团队成员并删除角色。'
  const CARD_DESC = '内置 roster 只增不删；这里的删除 = 停会话 + 会话目录进回收站 + 写入墓碑记录（可随时从回收站恢复）。'
  const ROSTER_NOTE = '内置团队面板仍会显示该成员（宿主 roster 只增不删），这里记录的是本插件的墓碑。'
  const DELETE_HINT = '将中断该成员会话，并把会话目录移入回收站（可恢复）。'
  const MODEL_FALLBACK = '跟随宿主默认'
  const NO_SESSION_TITLE = '（未命名会话）'
  const UNKNOWN_TIME = '未知'

  const MEMBER_PHASES = ['provisioning', 'active', 'failed']
  const MEMBER_STATUSES = ['running', 'inactive', 'provisioning', 'failed']
  const STATUS_META = {
    running: { label: '运行中', tone: 'run' },
    inactive: { label: '未运行', tone: 'idle' },
    provisioning: { label: '创建中', tone: 'warn' },
    failed: { label: '失败', tone: 'bad' },
  }

  const STYLE = `
.ta-root{--ta-bg:var(--dsw-alias-bg-layer-3,#fff);--ta-bg-sub:var(--dsw-alias-bg-layer-2,#f7f7f8);--ta-bg-muted:var(--dsw-alias-bg-module-platform,#f1f1f3);--ta-border:var(--dsw-alias-border-l2,rgba(0,0,0,.1));--ta-border-strong:var(--dsw-alias-border-l3,rgba(0,0,0,.2));--ta-text:var(--dsw-alias-label-primary,#1c1c1e);--ta-text-sub:var(--dsw-alias-label-secondary,#55555c);--ta-text-dim:var(--dsw-alias-label-tertiary,#8a8a92);--ta-accent:var(--dsw-alias-brand-primary,#3b6ef5);--ta-danger:var(--dsw-alias-state-error-primary,#d33b3b);--ta-ok:var(--dsw-alias-state-success-primary,#2f9e5f);--ta-warn:var(--dsw-alias-state-warn-primary,#c98a15);--ta-hover:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));--ta-radius:10px;--ta-radius-sm:6px;display:flex;flex-direction:column;gap:12px;min-width:0;padding:14px 16px;border:1px solid var(--ta-border);border-radius:14px;background:var(--ta-bg);color:var(--ta-text);font-size:13px;line-height:1.5}
.ta-head{display:flex;flex-direction:column;gap:4px;min-width:0}
.ta-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}
.ta-desc{margin:0;font-size:12px;color:var(--ta-text-sub);line-height:1.6}
.ta-body{display:grid;grid-template-columns:minmax(200px,290px) minmax(0,1fr);gap:14px;align-items:start;min-width:0}
.ta-col{display:flex;flex-direction:column;gap:8px;min-width:0}
.ta-col--list{padding-right:14px;border-right:1px solid var(--ta-border)}
.ta-searchbox{display:flex;flex-direction:column;gap:5px;min-width:0}
.ta-label{font-size:12px;font-weight:600;color:var(--ta-text)}
.ta-input,.ta-search{box-sizing:border-box;width:100%;min-width:0;min-height:30px;padding:4px 10px;border:1px solid var(--ta-border-strong);border-radius:8px;background:var(--ta-bg-sub);color:var(--ta-text);font:inherit;font-size:12px}
.ta-input:focus,.ta-search:focus{outline:none;border-color:var(--ta-accent);box-shadow:0 0 0 3px color-mix(in srgb, var(--ta-accent) 18%, transparent)}
.ta-sessions{display:flex;flex-direction:column;gap:4px;max-height:340px;overflow:auto;padding-right:2px}
.ta-session{display:flex;flex-direction:column;gap:2px;min-width:0;padding:7px 9px;border:1px solid transparent;border-radius:8px;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer}
.ta-session:hover{background:var(--ta-hover)}
.ta-session:focus-visible{outline:2px solid color-mix(in srgb, var(--ta-accent) 70%, transparent);outline-offset:1px}
.ta-session--on{border-color:var(--ta-accent);background:color-mix(in srgb, var(--ta-accent) 10%, transparent)}
.ta-session__title{overflow:hidden;font-size:13px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
.ta-session__cwd{overflow:hidden;font-size:11px;color:var(--ta-text-dim);text-overflow:ellipsis;white-space:nowrap}
.ta-session__meta{display:flex;align-items:center;gap:5px;font-size:11px;color:var(--ta-text-sub)}
.ta-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.ta-dot{display:inline-block;flex:none;width:6px;height:6px;border-radius:50%;background:var(--ta-ok)}
.ta-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border-radius:999px;background:var(--ta-bg-muted);color:var(--ta-text-sub);font-size:11px;white-space:nowrap}
.ta-badge--run{background:color-mix(in srgb, var(--ta-ok) 14%, transparent);color:var(--ta-ok)}
.ta-badge--idle{color:var(--ta-text-dim)}
.ta-badge--warn{background:color-mix(in srgb, var(--ta-warn) 14%, transparent);color:var(--ta-warn)}
.ta-badge--bad{background:color-mix(in srgb, var(--ta-danger) 14%, transparent);color:var(--ta-danger)}
.ta-spacer{flex:1}
.ta-detail__head{display:flex;align-items:flex-start;gap:10px;min-width:0}
.ta-detail__title{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.ta-members{display:flex;flex-direction:column;gap:6px}
.ta-member{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:1px solid var(--ta-border);border-radius:var(--ta-radius);background:var(--ta-bg)}
.ta-member--gone{opacity:.55}
.ta-member__top{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}
.ta-member__name{overflow:hidden;font-weight:600;font-size:13px;text-overflow:ellipsis;white-space:nowrap}
.ta-member__meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.ta-desc{margin:0;font-size:12px;color:var(--ta-text-sub);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}
.ta-hint{margin:0;font-size:11px;color:var(--ta-text-dim);line-height:1.5}
.ta-hint--bad{color:var(--ta-danger);word-break:break-word}
.ta-section{display:flex;flex-direction:column;gap:6px;min-width:0}
.ta-section__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.ta-section__title{margin:0;font-size:12px;font-weight:600;color:var(--ta-text)}
.ta-graves{display:flex;flex-direction:column;gap:6px}
.ta-grave{display:flex;flex-direction:column;gap:5px;padding:8px 10px;border:1px dashed var(--ta-border);border-radius:var(--ta-radius);background:var(--ta-bg-sub)}
.ta-grave__head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.ta-trash{display:flex;align-items:center;gap:6px;min-width:0}
.ta-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:28px;padding:0 11px;border:1px solid var(--ta-border-strong);border-radius:8px;background:var(--ta-bg);color:var(--ta-text);font:inherit;font-size:12px;font-weight:500;cursor:pointer;white-space:nowrap;transition:background .15s,border-color .15s,color .15s}
.ta-btn:hover:not(:disabled){background:var(--ta-hover)}
.ta-btn:disabled{cursor:not-allowed;opacity:.55}
.ta-btn:focus-visible{outline:2px solid color-mix(in srgb, var(--ta-accent) 70%, transparent);outline-offset:1px}
.ta-btn--sm{min-height:26px;padding:0 9px;font-size:11px}
.ta-btn--danger{color:var(--ta-danger)}
.ta-btn--danger:hover:not(:disabled){border-color:var(--ta-danger);background:var(--ta-danger);color:var(--ta-bg)}
.ta-status{margin:0;padding:10px 0;font-size:12px;color:var(--ta-text-dim)}
.ta-empty{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:10px 0}
.ta-error{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin:0;padding:6px 10px;border-left:3px solid var(--ta-danger);border-radius:var(--ta-radius-sm);background:var(--ta-bg-sub);color:var(--ta-danger);font-size:12px;word-break:break-word}
.ta-notice{margin:0;padding:6px 10px;border-left:3px solid var(--ta-ok);border-radius:var(--ta-radius-sm);background:var(--ta-bg-sub);color:var(--ta-text);font-size:12px;word-break:break-word}
.ta-confirm{display:flex;flex-direction:column;gap:6px;padding:8px 10px;border:1px solid var(--ta-danger);border-radius:var(--ta-radius);background:color-mix(in srgb, var(--ta-danger) 8%, transparent)}
.ta-confirm__text{display:flex;flex-direction:column;gap:3px;min-width:0;font-size:12px}
.ta-confirm__text strong{font-weight:600;color:var(--ta-text)}
.ta-confirm__actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.ta-summary{font-size:12px;color:var(--ta-text-sub);line-height:1.5}
.ta-host{display:block;min-width:0}
/* 整页面板：宿主 main 槽是 flex column，这里把卡片与左右两栏一路撑满，滚动只发生在内部列表 */
.ta-main{display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;padding:18px;background:var(--dsw-alias-bg-base)}
.ta-main__inner{display:flex;flex-direction:column;flex:1;min-height:0;width:100%;min-width:0}
.ta-main .ta-host{display:flex;flex-direction:column;flex:1;min-height:0}
.ta-main .ta-root{flex:1;min-height:0}
.ta-main .ta-body{flex:1;min-height:0;grid-template-rows:minmax(0,1fr);align-items:stretch}
.ta-main .ta-col{min-height:0}
.ta-main .ta-list-host{display:flex;flex-direction:column;flex:1;min-height:0}
.ta-main .ta-sessions{flex:1;min-height:0;max-height:none}
.ta-main .ta-col--detail{overflow:auto;padding-right:2px}
@media (max-width:760px){.ta-body{grid-template-columns:1fr}.ta-col--list{padding-right:0;padding-bottom:10px;border-right:0;border-bottom:1px solid var(--ta-border)}.ta-sessions{max-height:220px}.ta-main .ta-body{grid-template-rows:minmax(0,1fr) minmax(0,1fr)}}
@media (prefers-reduced-motion:reduce){.ta-btn{transition:none}}
`

  function isRecord(value) {
    return value !== null && typeof value === 'object' && Array.isArray(value) === false
  }

  function pickString(value, fallback) {
    return typeof value === 'string' ? value : fallback
  }

  function pickNumber(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  function pad2(value) {
    return String(value).padStart(2, '0')
  }

  // 状态 → 徽标文案与配色键；未知状态兜底为 muted，不让 UI 掉行
  function statusMeta(status) {
    return STATUS_META[status] || { label: '未知', tone: 'idle' }
  }

  // 相对时间人话：过去式；未来时间（时钟偏差）按「刚刚」处理
  function formatRelativeTime(timestamp, now) {
    if (typeof timestamp !== 'number' || Number.isFinite(timestamp) === false || timestamp <= 0) return UNKNOWN_TIME
    const base = typeof now === 'number' && Number.isFinite(now) ? now : Date.now()
    const delta = base - timestamp
    if (delta < MINUTE_MS) return '刚刚'
    if (delta < HOUR_MS) return Math.floor(delta / MINUTE_MS) + ' 分钟前'
    if (delta < DAY_MS) return Math.floor(delta / HOUR_MS) + ' 小时前'
    if (delta < 30 * DAY_MS) return Math.floor(delta / DAY_MS) + ' 天前'
    return formatDateTime(timestamp)
  }

  // 绝对时间：浏览器本地时区；时间戳缺失回退「未知」
  function formatDateTime(timestamp) {
    if (typeof timestamp !== 'number' || Number.isFinite(timestamp) === false || timestamp <= 0) return UNKNOWN_TIME
    const date = new Date(timestamp)
    return date.getFullYear() + '-' + pad2(date.getMonth() + 1) + '-' + pad2(date.getDate())
      + ' ' + pad2(date.getHours()) + ':' + pad2(date.getMinutes())
  }

  // —— 请求 URL / 请求体 ——
  function sessionsUrl(query) {
    const keyword = typeof query === 'string' ? query.trim() : ''
    return keyword === '' ? API_BASE + '/sessions' : API_BASE + '/sessions?query=' + encodeURIComponent(keyword)
  }

  function teamUrl(sessionId) {
    return API_BASE + '/team?sessionId=' + encodeURIComponent(typeof sessionId === 'string' ? sessionId : '')
  }

  const DISMISS_URL = API_BASE + '/dismiss'
  const DISMISSED_URL = API_BASE + '/dismissed'
  const LIST_FILTER_FLAG = '__dshTeamAdminSessionListFilter__'

  function dismissPayload(sessionId, name) {
    return { sessionId: sessionId, name: name, deleteSession: true }
  }

  // —— 宿主会话列表过滤：把已删除成员从 subagentCatalog 投影里摘掉 ——
  // 宿主 catalog 与 roster 都是 append-only，删会话不会撤销 catalog 事件；
  // 这里在本插件内拦截 /api/session/list 的响应，按墓碑把失效条目过滤掉，
  // 不修改宿主源码，也不需要重编译。
  let dismissedIds = new Set()
  let dismissedReady = null

  function stripDismissedCatalogs(payload, dismissed) {
    if (payload === null || typeof payload !== 'object' || dismissed === undefined || dismissed.size === 0) return payload
    const keep = (entry) => !(entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && dismissed.has(entry.id))
    const visit = (node, depth) => {
      if (node === null || typeof node !== 'object' || depth > 6) return
      // 1) 顶部「子智能体」选择器：宿主 catalog 投影
      if (Array.isArray(node.subagentCatalog)) node.subagentCatalog = node.subagentCatalog.filter(keep)
      // 2) 「智能体团队」面板：宿主 roster 投影（成员数组）
      if (isRecord(node.agentTeam) && Array.isArray(node.agentTeam.members)) node.agentTeam.members = node.agentTeam.members.filter(keep)
      for (const key of Object.keys(node)) {
        if (key === 'subagentCatalog' || key === 'agentTeam') continue
        visit(node[key], depth + 1)
      }
    }
    visit(payload, 0)
    return payload
  }

  async function refreshDismissedIds() {
    try {
      const response = await fetch(DISMISSED_URL, { headers: { accept: 'application/json' } })
      if (response.ok !== true) return dismissedIds
      const payload = await response.json()
      const ids = isRecord(payload) && Array.isArray(payload.ids) ? payload.ids : []
      dismissedIds = new Set(ids.filter((id) => typeof id === 'string' && id !== ''))
    } catch (error) {
      // 墓碑拿不到就放行原始列表：过滤是增强，不是前置条件。
    }
    return dismissedIds
  }

  function installSessionListFilter(win) {
    const scope = win !== undefined ? win : (typeof window === 'undefined' ? null : window)
    if (scope === null || scope === undefined) return false
    if (scope[LIST_FILTER_FLAG] === true) {
      dismissedReady = refreshDismissedIds()
      return false
    }
    const original = scope.fetch
    if (typeof original !== 'function') return false
    scope[LIST_FILTER_FLAG] = true
    dismissedReady = refreshDismissedIds()
    scope.fetch = async function teamAdminAwareFetch(input, init) {
      const url = typeof input === 'string' ? input : (isRecord(input) && typeof input.url === 'string' ? input.url : '')
      if (url.indexOf('/api/session/list') < 0) return await original(input, init)
      if (dismissedReady !== null) await dismissedReady
      const response = await original(input, init)
      if (dismissedIds.size === 0 || response.ok !== true) return response
      try {
        const body = await response.clone().json()
        stripDismissedCatalogs(body, dismissedIds)
        return new Response(JSON.stringify(body), { status: response.status, statusText: response.statusText, headers: response.headers })
      } catch (error) {
        return response
      }
    }
    return true
  }

  // —— 响应校验：缺字段回退默认值，形态不对返回可展示的错误 ——
  function normalizeSessionRow(raw) {
    const row = isRecord(raw) ? raw : {}
    const id = pickString(row.id, '')
    return {
      id: id,
      title: pickString(row.title, '') || id || NO_SESSION_TITLE,
      cwd: pickString(row.cwd, ''),
      createdAt: pickNumber(row.createdAt, 0),
      lastActivityAt: pickNumber(row.lastActivityAt, pickNumber(row.createdAt, 0)),
      live: row.live === true,
    }
  }

  function readSessionsPayload(json) {
    if (isRecord(json) === false || Array.isArray(json.sessions) === false) {
      return { ok: false, error: '服务返回的会话列表格式不正确' }
    }
    const sessions = []
    for (const raw of json.sessions) {
      const row = normalizeSessionRow(raw)
      if (row.id !== '') sessions.push(row)
    }
    return { ok: true, sessions: sessions }
  }

  function normalizeMemberRow(raw) {
    const row = isRecord(raw) ? raw : {}
    const id = pickString(row.id, '')
    return {
      id: id,
      name: pickString(row.name, '') || id,
      phase: MEMBER_PHASES.indexOf(row.phase) === -1 ? 'active' : row.phase,
      status: MEMBER_STATUSES.indexOf(row.status) === -1 ? 'inactive' : row.status,
      description: pickString(row.description, ''),
      provider: pickString(row.provider, ''),
      context: row.context === 'fork' ? 'fork' : 'fresh',
      model: pickString(row.model, ''),
      error: pickString(row.error, ''),
      dismissed: row.dismissed === true,
      sessionExists: row.sessionExists !== false,
      ownedTasks: pickNumber(row.ownedTasks, 0),
      lastActivityAt: pickNumber(row.lastActivityAt, 0) > 0 ? pickNumber(row.lastActivityAt, 0) : null,
    }
  }

  function normalizeDismissedRow(raw) {
    const row = isRecord(raw) ? raw : {}
    const id = pickString(row.id, '')
    return {
      id: id,
      name: pickString(row.name, '') || id,
      dismissedAt: pickNumber(row.dismissedAt, 0),
      sessionDeleted: row.sessionDeleted === true,
      trashPath: pickString(row.trashPath, ''),
      memberStillInRoster: row.memberStillInRoster !== false,
    }
  }

  function readTeamPayload(json) {
    if (isRecord(json) === false || Array.isArray(json.members) === false) {
      return { ok: false, error: '服务返回的团队数据格式不正确' }
    }
    const members = []
    for (const raw of json.members) {
      const row = normalizeMemberRow(raw)
      if (row.id !== '') members.push(row)
    }
    const dismissed = []
    const dismissedSource = Array.isArray(json.dismissed) ? json.dismissed : []
    for (const raw of dismissedSource) {
      const row = normalizeDismissedRow(raw)
      if (row.id !== '') dismissed.push(row)
    }
    return {
      ok: true,
      data: {
        session: isRecord(json.session) ? normalizeSessionRow(json.session) : null,
        members: members,
        dismissed: dismissed,
      },
    }
  }

  function readDismissResult(json, fallback) {
    const source = isRecord(json) ? json : {}
    const base = isRecord(fallback) ? fallback : {}
    return {
      name: pickString(source.name, pickString(base.name, '')),
      id: pickString(source.id, pickString(base.id, '')),
      stopped: source.stopped === true,
      sessionDeleted: source.sessionDeleted === true,
      trashPath: pickString(source.trashPath, ''),
      dismissedAt: pickNumber(source.dismissedAt, 0),
    }
  }

  // 选中项跟随列表：仍存在就保留，被过滤掉/未选则落到第一条
  function pickSessionId(sessions, currentId) {
    if (Array.isArray(sessions) === false || sessions.length === 0) return null
    if (typeof currentId === 'string' && currentId !== '' && sessions.some((row) => row.id === currentId)) return currentId
    return sessions[0].id
  }

  // —— 文案 ——
  function confirmDismissText(name) {
    return '确认删除成员「' + String(name === undefined || name === null ? '' : name) + '」？'
  }

  function dismissResultText(result) {
    const row = isRecord(result) ? result : {}
    const name = pickString(row.name, '') || '该成员'
    let text = '已删除成员「' + name + '」'
    text += row.sessionDeleted === true ? '，会话已移入回收站' : '，会话已保留'
    if (pickString(row.trashPath, '') !== '') text += '：' + row.trashPath
    return text
  }

  function apiErrorText(json, status) {
    if (isRecord(json) && typeof json.error === 'string' && json.error.trim() !== '') return json.error.trim()
    return '请求失败（HTTP ' + String(status) + '）'
  }

  function networkErrorText(error) {
    const detail = error !== null && error !== undefined && typeof error.message === 'string' ? error.message : ''
    return detail === ''
      ? '无法连接本机服务，请确认 dsh web 仍在运行后重试'
      : '无法连接本机服务，请确认 dsh web 仍在运行后重试（' + detail + '）'
  }

  // 网络层：统一 { ok, data | error } 契约，错误一律可展示的中文文案
  async function requestJson(method, url, body) {
    let response = null
    try {
      response = await fetch(url, {
        method: method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      return { ok: false, error: networkErrorText(error) }
    }
    let json = null
    try {
      json = await response.json()
    } catch (error) {
      json = null
    }
    if (response.ok !== true) return { ok: false, error: apiErrorText(json, response.status) }
    return { ok: true, data: json }
  }

  function ensureStyle(doc) {
    if (doc === null || doc === undefined || typeof doc.getElementById !== 'function') return
    if (doc.getElementById(STYLE_ID) !== null) return
    const style = doc.createElement('style')
    style.id = STYLE_ID
    // 插件自注样式必须自带 data-plugin，否则别的插件材质化时会把本样式算到它名下
    style.setAttribute('data-plugin', PKG_ID)
    style.textContent = STYLE
    if (doc.head !== null && doc.head !== undefined) doc.head.appendChild(style)
  }

  async function copyText(text) {
    const value = typeof text === 'string' ? text : String(text === undefined || text === null ? '' : text)
    if (value === '') return false
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard !== undefined && typeof navigator.clipboard.writeText === 'function') {
        await navigator.clipboard.writeText(value)
        return true
      }
    } catch (error) {
      // 剪贴板被浏览器拒绝（非安全上下文/未授权）：继续走兜底
    }
    try {
      if (typeof document === 'undefined' || document === null) return false
      const area = document.createElement('textarea')
      area.value = value
      area.setAttribute('readonly', 'readonly')
      area.style.position = 'fixed'
      area.style.top = '-1000px'
      area.style.opacity = '0'
      document.body.appendChild(area)
      area.select()
      const copied = typeof document.execCommand === 'function' ? document.execCommand('copy') : false
      area.remove()
      return copied === true
    } catch (error) {
      return false
    }
  }

  // —— 原生 DOM 小工具（只在浏览器侧调用） ——
  function makeElement(tag, className, text) {
    const node = document.createElement(tag)
    if (className !== undefined && className !== '') node.className = className
    if (text !== undefined && text !== null) node.textContent = String(text)
    return node
  }

  function appendChildren(parent, children) {
    for (const child of children) {
      if (child !== null && child !== undefined) parent.appendChild(child)
    }
    return parent
  }

  // —— 面板控制器：唯一一份 UI 实现 ——
  // React 槽位与测试/e2e 的 mount 都用它；React 只出一层宿主 div。
  function createPanelController() {
    // 样式随首个实例注入：React 槽位与 mount 两条路径都不依赖调用方记得注入
    ensureStyle(typeof document === 'undefined' ? null : document)
    const state = {
      query: '',
      sessions: null,
      sessionsPhase: 'loading',
      sessionsError: null,
      selectedId: null,
      team: null,
      teamPhase: 'idle',
      teamError: null,
      confirm: null,
      notice: null,
      copiedKey: null,
      copyError: null,
    }
    let sessionSeq = 0
    let teamSeq = 0
    let debounceTimer = null
    let copyTimer = null
    let disposed = false
    let started = false

    const root = makeElement('div', 'ta-root')
    const head = makeElement('header', 'ta-head')
    appendChildren(head, [makeElement('h3', 'ta-title', CARD_TITLE), makeElement('p', 'ta-desc', CARD_DESC)])
    const body = makeElement('div', 'ta-body')
    const listCol = makeElement('div', 'ta-col ta-col--list')
    const searchBox = makeElement('label', 'ta-searchbox')
    const searchInput = makeElement('input', 'ta-search')
    searchInput.type = 'search'
    searchInput.placeholder = '搜索标题 / 目录 / 会话 ID'
    searchInput.setAttribute('aria-label', '搜索会话')
    appendChildren(searchBox, [makeElement('span', 'ta-label', '选择会话'), searchInput])
    const listHost = makeElement('div', 'ta-list-host')
    appendChildren(listCol, [searchBox, listHost])
    const detailCol = makeElement('div', 'ta-col ta-col--detail')
    appendChildren(body, [listCol, detailCol])
    appendChildren(root, [head, body])

    function render() {
      if (disposed) return
      if (searchInput.value !== state.query) searchInput.value = state.query
      renderList()
      renderDetail()
    }

    function statusText(text) {
      const node = makeElement('p', 'ta-status', text)
      node.setAttribute('role', 'status')
      return node
    }

    function errorBox(text, onRetry) {
      const box = makeElement('div', 'ta-error')
      box.setAttribute('role', 'alert')
      box.appendChild(makeElement('span', '', typeof text === 'string' && text !== '' ? text : '加载失败'))
      if (typeof onRetry === 'function') {
        const retry = makeElement('button', 'ta-btn ta-btn--sm', '重试')
        retry.type = 'button'
        retry.addEventListener('click', onRetry)
        box.appendChild(retry)
      }
      return box
    }

    function hintNode(text) {
      return makeElement('p', 'ta-hint', text)
    }

    function renderList() {
      listHost.replaceChildren()
      if (state.sessionsPhase === 'loading' && state.sessions === null) {
        listHost.appendChild(statusText('正在加载会话…'))
        return
      }
      if (state.sessionsPhase === 'error') {
        listHost.appendChild(errorBox(state.sessionsError, () => { void loadSessions(state.query) }))
        return
      }
      if (state.sessions === null || state.sessions.length === 0) {
        const keyword = state.query.trim()
        listHost.appendChild(statusText(keyword === '' ? '还没有任何会话。' : '没有匹配「' + keyword + '」的会话。'))
        return
      }
      const list = makeElement('div', 'ta-sessions')
      for (const row of state.sessions) {
        const active = row.id === state.selectedId
        const button = makeElement('button', 'ta-session' + (active ? ' ta-session--on' : ''))
        button.type = 'button'
        button.setAttribute('aria-pressed', active ? 'true' : 'false')
        const title = makeElement('span', 'ta-session__title', row.title)
        title.title = row.title
        const cwd = makeElement('span', 'ta-session__cwd ta-mono', row.cwd === '' ? '（未知目录）' : row.cwd)
        cwd.title = row.cwd
        const meta = makeElement('span', 'ta-session__meta')
        if (row.live) appendChildren(meta, [makeElement('span', 'ta-dot')])
        meta.appendChild(document.createTextNode((row.live ? '运行中 · ' : '') + '最近活动 ' + formatRelativeTime(row.lastActivityAt, Date.now())))
        appendChildren(button, [title, cwd, meta])
        button.addEventListener('click', () => { selectSession(row.id) })
        list.appendChild(button)
      }
      listHost.appendChild(list)
    }

    function renderDetail() {
      detailCol.replaceChildren()
      if (state.selectedId === null) {
        const noSessions = state.sessions !== null && state.sessions.length === 0
        detailCol.appendChild(statusText(noSessions ? '没有可管理的会话。' : '从左侧选择一个会话，查看它的团队成员。'))
        return
      }
      const selectedRow = state.sessions === null
        ? null
        : (state.sessions.filter((row) => row.id === state.selectedId)[0] || null)
      const teamSession = state.team !== null ? state.team.session : null
      const headTitle = (teamSession !== null && teamSession.title !== '' ? teamSession.title : '')
        || (selectedRow !== null ? selectedRow.title : '')
        || state.selectedId
      const headCwd = teamSession !== null && teamSession.cwd !== ''
        ? teamSession.cwd
        : (selectedRow !== null ? selectedRow.cwd : '')
      const header = makeElement('div', 'ta-detail__head')
      const titleBox = makeElement('div', 'ta-detail__title')
      const titleNode = makeElement('div', 'ta-session__title', headTitle)
      titleNode.title = headTitle
      appendChildren(titleBox, [titleNode])
      if (headCwd !== '') {
        const cwdNode = makeElement('div', 'ta-session__cwd ta-mono', headCwd)
        cwdNode.title = headCwd
        titleBox.appendChild(cwdNode)
      }
      const refresh = makeElement('button', 'ta-btn ta-btn--sm', '刷新')
      refresh.type = 'button'
      refresh.disabled = state.teamPhase === 'loading'
      refresh.addEventListener('click', () => { refreshTeam() })
      appendChildren(header, [titleBox, refresh])
      detailCol.appendChild(header)

      if (state.notice !== null) {
        const notice = makeElement('p', 'ta-notice', state.notice.text)
        notice.setAttribute('role', 'status')
        detailCol.appendChild(notice)
      }
      if (state.teamPhase === 'loading' && state.team === null) {
        detailCol.appendChild(statusText('正在读取团队成员…'))
        return
      }
      if (state.teamPhase === 'error') {
        detailCol.appendChild(errorBox(state.teamError, () => { refreshTeam() }))
        return
      }
      if (state.team === null) return
      if (state.team.members.length === 0 && state.team.dismissed.length === 0) {
        const empty = makeElement('div', 'ta-empty')
        appendChildren(empty, [makeElement('p', '', '该会话没有团队。'), hintNode('先在会话里派一个队友（Agent Teams），再回来刷新。')])
        const reload = makeElement('button', 'ta-btn ta-btn--sm', '刷新')
        reload.type = 'button'
        reload.addEventListener('click', () => { refreshTeam() })
        empty.appendChild(reload)
        detailCol.appendChild(empty)
        return
      }
      detailCol.appendChild(renderMembers(state.team.members))
      detailCol.appendChild(renderDismissed(state.team.dismissed))
    }

    function renderMembers(members) {
      const section = makeElement('section', 'ta-section')
      const sectionHead = makeElement('div', 'ta-section__head')
      appendChildren(sectionHead, [
        makeElement('h4', 'ta-section__title', '团队成员'),
        makeElement('span', 'ta-hint', '共 ' + String(members.length) + ' 人'),
      ])
      const list = makeElement('div', 'ta-members')
      for (const member of members) list.appendChild(renderMember(member))
      appendChildren(section, [sectionHead, list])
      return section
    }

    function renderMember(member) {
      const meta = statusMeta(member.status)
      const gone = member.dismissed === true
      const card = makeElement('div', 'ta-member' + (gone ? ' ta-member--gone' : ''))
      const top = makeElement('div', 'ta-member__top')
      const name = makeElement('span', 'ta-member__name', member.name)
      name.title = member.name
      top.appendChild(name)
      const badge = makeElement('span', 'ta-badge ta-badge--' + meta.tone)
      if (meta.tone === 'run') badge.appendChild(makeElement('span', 'ta-dot'))
      badge.appendChild(document.createTextNode(meta.label))
      top.appendChild(badge)
      if (gone) top.appendChild(makeElement('span', 'ta-badge ta-badge--idle', '已删除'))
      if (member.phase === 'failed') top.appendChild(makeElement('span', 'ta-badge ta-badge--bad', '创建失败'))
      top.appendChild(makeElement('span', 'ta-spacer'))
      top.appendChild(makeElement('span', 'ta-hint', '任务 ' + String(member.ownedTasks)))
      if (gone === false) {
        const remove = makeElement('button', 'ta-btn ta-btn--danger ta-btn--sm', '删除')
        remove.type = 'button'
        remove.addEventListener('click', () => { openConfirm(member) })
        top.appendChild(remove)
      }
      card.appendChild(top)
      if (member.description !== '') {
        const desc = makeElement('p', 'ta-desc', member.description)
        desc.title = member.description
        card.appendChild(desc)
      }
      if (member.error !== '') {
        const err = makeElement('p', 'ta-hint ta-hint--bad', '错误：' + member.error)
        err.title = member.error
        card.appendChild(err)
      }
      const metaLine = makeElement('div', 'ta-member__meta')
      const modelText = member.model !== ''
        ? member.model
        : (member.provider !== '' ? member.provider + ' 默认模型' : MODEL_FALLBACK)
      metaLine.appendChild(makeElement('span', 'ta-hint', '模型 ' + modelText))
      if (member.provider !== '') metaLine.appendChild(makeElement('span', 'ta-hint', 'provider ' + member.provider))
      metaLine.appendChild(makeElement('span', 'ta-hint', member.context === 'fork' ? 'fork 上下文' : 'fresh 上下文'))
      card.appendChild(metaLine)
      if (state.confirm !== null && state.confirm.id === member.id) card.appendChild(renderConfirm(member))
      return card
    }

    function renderConfirm(member) {
      const busy = state.confirm.busy === true
      const box = makeElement('div', 'ta-confirm')
      box.setAttribute('role', 'group')
      box.setAttribute('aria-label', '删除确认')
      const text = makeElement('div', 'ta-confirm__text')
      appendChildren(text, [makeElement('strong', '', confirmDismissText(member.name)), makeElement('span', 'ta-hint', DELETE_HINT)])
      const actions = makeElement('div', 'ta-confirm__actions')
      const confirm = makeElement('button', 'ta-btn ta-btn--danger ta-btn--sm', busy ? '删除中…' : '确认删除')
      confirm.type = 'button'
      confirm.disabled = busy
      confirm.setAttribute('aria-busy', busy ? 'true' : 'false')
      confirm.addEventListener('click', () => { void confirmDismiss() })
      const cancel = makeElement('button', 'ta-btn ta-btn--sm', '取消')
      cancel.type = 'button'
      cancel.disabled = busy
      cancel.addEventListener('click', () => { state.confirm = null; render() })
      appendChildren(actions, [confirm, cancel])
      appendChildren(box, [text, actions])
      if (state.confirm.error !== null) {
        const err = makeElement('p', 'ta-error', state.confirm.error)
        err.setAttribute('role', 'alert')
        box.appendChild(err)
      }
      return box
    }

    function renderDismissed(dismissed) {
      const section = makeElement('section', 'ta-section')
      const sectionHead = makeElement('div', 'ta-section__head')
      appendChildren(sectionHead, [
        makeElement('h4', 'ta-section__title', '已删除成员'),
        makeElement('span', 'ta-badge', String(dismissed.length)),
      ])
      appendChildren(section, [sectionHead, hintNode(ROSTER_NOTE)])
      if (dismissed.length === 0) {
        section.appendChild(hintNode('还没有通过本插件删除的成员。'))
      } else {
        const graves = makeElement('div', 'ta-graves')
        for (const row of dismissed) {
          const grave = makeElement('div', 'ta-grave')
          const graveHead = makeElement('div', 'ta-grave__head')
          appendChildren(graveHead, [
            makeElement('span', 'ta-member__name', row.name),
            makeElement('span', 'ta-hint', '删除于 ' + formatDateTime(row.dismissedAt)),
            makeElement('span', 'ta-badge ' + (row.sessionDeleted ? 'ta-badge--idle' : 'ta-badge--warn'), row.sessionDeleted ? '会话已删除' : '会话仍在'),
          ])
          grave.appendChild(graveHead)
          if (row.trashPath !== '') {
            const trash = makeElement('div', 'ta-trash')
            const input = makeElement('input', 'ta-input ta-mono')
            input.readOnly = true
            input.value = row.trashPath
            input.setAttribute('aria-label', '回收站路径')
            input.addEventListener('focus', () => { input.select() })
            const copy = makeElement('button', 'ta-btn ta-btn--sm', state.copiedKey === row.id ? '已复制' : '复制路径')
            copy.type = 'button'
            copy.addEventListener('click', () => { void copyTrash(row) })
            appendChildren(trash, [input, copy])
            grave.appendChild(trash)
          } else {
            grave.appendChild(hintNode('未保留回收站路径（删除时未移除会话）。'))
          }
          graves.appendChild(grave)
        }
        section.appendChild(graves)
      }
      if (state.copyError !== null) {
        const err = makeElement('p', 'ta-error', state.copyError)
        err.setAttribute('role', 'alert')
        section.appendChild(err)
      }
      return section
    }

    function selectSession(id) {
      state.selectedId = id
      state.confirm = null
      state.notice = null
      state.copyError = null
      state.team = null
      state.teamPhase = 'loading'
      state.teamError = null
      render()
      void loadTeam(id)
    }

    function refreshTeam() {
      if (state.selectedId === null) return
      void loadTeam(state.selectedId)
    }

    function openConfirm(member) {
      state.confirm = { id: member.id, name: member.name, busy: false, error: null }
      state.notice = null
      render()
    }

    async function loadSessions(keyword) {
      sessionSeq += 1
      const seq = sessionSeq
      state.sessionsPhase = 'loading'
      state.sessionsError = null
      render()
      const outcome = await requestJson('GET', sessionsUrl(keyword))
      if (disposed || seq !== sessionSeq) return
      if (outcome.ok !== true) {
        state.sessionsPhase = 'error'
        state.sessionsError = outcome.error
        render()
        return
      }
      const parsed = readSessionsPayload(outcome.data)
      if (parsed.ok !== true) {
        state.sessionsPhase = 'error'
        state.sessionsError = parsed.error
        render()
        return
      }
      const nextId = pickSessionId(parsed.sessions, state.selectedId)
      state.sessions = parsed.sessions
      state.sessionsPhase = 'ready'
      if (nextId !== state.selectedId) {
        state.selectedId = nextId
        state.confirm = null
        state.notice = null
        state.copyError = null
        state.team = null
        state.teamError = null
        state.teamPhase = nextId === null ? 'idle' : 'loading'
        render()
        if (nextId !== null) void loadTeam(nextId)
        return
      }
      render()
    }

    async function loadTeam(sessionId) {
      teamSeq += 1
      const seq = teamSeq
      state.teamPhase = 'loading'
      state.teamError = null
      render()
      const outcome = await requestJson('GET', teamUrl(sessionId))
      if (disposed || seq !== teamSeq) return
      if (outcome.ok !== true) {
        state.team = null
        state.teamPhase = 'error'
        state.teamError = outcome.error
        render()
        return
      }
      const parsed = readTeamPayload(outcome.data)
      if (parsed.ok !== true) {
        state.team = null
        state.teamPhase = 'error'
        state.teamError = parsed.error
        render()
        return
      }
      state.team = parsed.data
      state.teamPhase = 'ready'
      render()
    }

    async function confirmDismiss() {
      if (state.confirm === null || state.confirm.busy === true || state.selectedId === null) return
      const target = state.confirm
      state.confirm = { id: target.id, name: target.name, busy: true, error: null }
      render()
      const outcome = await requestJson('POST', DISMISS_URL, dismissPayload(state.selectedId, target.name))
      if (disposed) return
      if (outcome.ok !== true) {
        state.confirm = { id: target.id, name: target.name, busy: false, error: outcome.error }
        render()
        return
      }
      state.confirm = null
      dismissedReady = refreshDismissedIds()
      state.notice = { text: dismissResultText(readDismissResult(outcome.data, target)) }
      render()
      await loadTeam(state.selectedId)
    }

    async function copyTrash(row) {
      state.copyError = null
      const copied = await copyText(row.trashPath)
      if (disposed) return
      if (copied !== true) {
        state.copyError = '复制失败，请手动选中路径后复制'
        render()
        return
      }
      state.copiedKey = row.id
      render()
      if (copyTimer !== null) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => {
        copyTimer = null
        if (disposed) return
        if (state.copiedKey === row.id) state.copiedKey = null
        render()
      }, COPIED_RESET_MS)
    }

    searchInput.addEventListener('input', () => {
      state.query = searchInput.value
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => {
        debounceTimer = null
        void loadSessions(state.query)
      }, DEBOUNCE_MS)
      render()
    })

    function start() {
      if (started || disposed) return
      started = true
      void loadSessions('')
    }

    function dispose() {
      disposed = true
      if (debounceTimer !== null) clearTimeout(debounceTimer)
      if (copyTimer !== null) clearTimeout(copyTimer)
      debounceTimer = null
      copyTimer = null
    }

    render()
    return { root: root, start: start, dispose: dispose, render: render }
  }

  // 测试 / e2e 直接挂载：不依赖 ctx.slots，也不依赖 React。
  function mount(container) {
    if (container === null || container === undefined || typeof container.appendChild !== 'function') {
      throw new Error('mount(container) 需要一个可挂载的 DOM 元素')
    }
    ensureStyle(typeof document === 'undefined' ? null : document)
    installSessionListFilter()
    const controller = createPanelController()
    container.appendChild(controller.root)
    controller.start()
    return {
      root: controller.root,
      refresh: () => { controller.render() },
      unmount() {
        controller.dispose()
        if (controller.root.parentNode === container) container.removeChild(controller.root)
      },
    }
  }

  function factory(require) {
    let React = null
    try {
      React = require('react')
    } catch (error) {
      // 宿主种子表异常时干净禁用，但必须显式报错，禁止静默
      console.error('[team-admin] react 不可用，团队管理卡片已禁用：', error)
      return { inject: [], apply() {} }
    }
    const h = React.createElement

    // React 只负责一块宿主 div；面板内容由同一个 controller 渲染。
    function TeamAdminPanel() {
      const hostRef = React.useRef(null)
      React.useEffect(() => {
        const container = hostRef.current
        if (container === null || container === undefined || typeof container.appendChild !== 'function') return undefined
        const controller = createPanelController()
        container.appendChild(controller.root)
        controller.start()
        return () => {
          controller.dispose()
          if (controller.root.parentNode === container) container.removeChild(controller.root)
        }
      }, [])
      return h('div', { className: 'ta-host', ref: hostRef })
    }

    // 配置页只给 view（summary | page）：summary 一行说明，page 完整面板
    function TeamAdminCard(props) {
      const view = props !== null && props !== undefined && props.view === 'summary' ? 'summary' : 'page'
      return view === 'summary' ? h('div', { className: 'ta-summary' }, CARD_SUMMARY) : h(TeamAdminPanel, null)
    }

    // 侧栏入口图标：sidebar.panellist 渲染契约组件，宿主传 { size, active }
    function TeamAdminIcon(props) {
      const size = props !== null && props !== undefined && typeof props.size === 'number' ? props.size : 16
      return h('svg', {
        viewBox: '0 0 16 16',
        width: size,
        height: size,
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('circle', { cx: 5.6, cy: 5.4, r: 2.2 }),
      h('path', { d: 'M1.9 13.2c0-2 1.6-3.3 3.7-3.3s3.7 1.3 3.7 3.3' }),
      h('circle', { cx: 11.3, cy: 6.2, r: 1.8 }),
      h('path', { d: 'M9.7 12.4c.3-1.5 1.3-2.3 2.6-2.3 1.4 0 2.4 1 2.6 2.5' }))
    }

    // 中央面板页：整页壳 + 与配置卡同一份 controller（不复制 UI）
    function TeamAdminPage() {
      return h('div', { className: 'ta-main' }, h('div', { className: 'ta-main__inner' }, h(TeamAdminPanel, null)))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        installSessionListFilter()
        const slots = ctx !== null && ctx !== undefined && ctx.slots !== undefined ? ctx.slots : null
        if (slots === null || typeof slots.inject !== 'function' || typeof slots.register !== 'function') {
          console.warn('[team-admin] 宿主未提供 slots 服务，配置卡片未注册')
          return
        }
        ensureStyle(typeof document === 'undefined' ? null : document)
        const effect = typeof ctx.effect === 'function'
          ? (fn, label) => ctx.effect(fn, label)
          : (fn) => {
              const disposer = fn()
              return typeof disposer === 'function' ? disposer : () => {}
            }
        // 全局面板入口：main keyed 条目出中央页面，sidebar.panellist 条目出侧栏入口行；
        // 两者用同一个 id 配对，点击入口由宿主 layout.selectPanel 切换。先注册 main，
        // 侧栏行一旦可点就有页面可切（selectPanel 对未注册 key 会抛错）。
        effect(() => {
          const disposers = []
          disposers.push(slots.inject('main', () => slots.register({
            name: 'main',
            key: PANEL_ID,
          }, TeamAdminPage)))
          disposers.push(slots.inject('sidebar.panellist', () => slots.register({
            name: 'sidebar.panellist',
            id: PANEL_ID,
            order: PANEL_ORDER,
            label: PANEL_LABEL,
          }, TeamAdminIcon)))
          return () => {
            for (const dispose of disposers) {
              if (typeof dispose === 'function') dispose()
            }
          }
        }, 'team-admin: main + sidebar.panellist')
        effect(() => slots.inject('plugins.bundle.config', () => slots.register({
          name: 'plugins.bundle.config',
          key: PKG_ID,
        }, TeamAdminCard)), 'team-admin: plugins.bundle.config')
        // 尽力兼容设置页插件分区：宿主不声明该槽时 inject 挂起、零成本
        effect(() => slots.inject('settings.plugin.item', () => slots.register({
          name: 'settings.plugin.item',
          key: SETTINGS_KEY,
          label: CARD_TITLE,
        }, TeamAdminCard)), 'team-admin: settings.plugin.item')
      },
    }
  }

  if (typeof globalThis !== 'undefined' && globalThis.__DshTeamAdminTestEnabled === true) {
    globalThis.__DshTeamAdminTest = {
      mount: mount,
      helpers: {
        PKG_ID: PKG_ID,
        SETTINGS_KEY: SETTINGS_KEY,
        PANEL_ID: PANEL_ID,
        PANEL_LABEL: PANEL_LABEL,
        PANEL_ORDER: PANEL_ORDER,
        API_BASE: API_BASE,
        DISMISSED_URL: DISMISSED_URL,
        stripDismissedCatalogs: stripDismissedCatalogs,
        installSessionListFilter: installSessionListFilter,
        refreshDismissedIds: refreshDismissedIds,
        DEBOUNCE_MS: DEBOUNCE_MS,
        CARD_TITLE: CARD_TITLE,
        CARD_SUMMARY: CARD_SUMMARY,
        ROSTER_NOTE: ROSTER_NOTE,
        DELETE_HINT: DELETE_HINT,
        statusMeta: statusMeta,
        formatRelativeTime: formatRelativeTime,
        formatDateTime: formatDateTime,
        sessionsUrl: sessionsUrl,
        teamUrl: teamUrl,
        dismissPayload: dismissPayload,
        readSessionsPayload: readSessionsPayload,
        readTeamPayload: readTeamPayload,
        readDismissResult: readDismissResult,
        pickSessionId: pickSessionId,
        confirmDismissText: confirmDismissText,
        dismissResultText: dismissResultText,
        apiErrorText: apiErrorText,
        networkErrorText: networkErrorText,
        copyText: copyText,
      },
      factory: factory,
      createPanelController: createPanelController,
      ensureStyle: ensureStyle,
    }
  }

  // 宿主模块表：以包名注册，factory 返回 { inject, apply }
  if (typeof window !== 'undefined' && window !== null && window.__ModuleLoader__ !== undefined && window.__ModuleLoader__ !== null
    && typeof window.__ModuleLoader__.load === 'function') {
    window.__ModuleLoader__.load({ id: PKG_ID, factory: factory })
  }
})()