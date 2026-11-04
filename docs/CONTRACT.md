# dsh-team-admin 内部契约（v0.1.0）

插件给「智能体团队（Agent Teams）」补一个管理面：选任意会话 → 看它的团队成员 → 删除角色并清理该成员的持久会话。
宿主半区（Node）提供 HTTP API；客户端半区（浏览器、无构建）渲染管理卡片。

## 目录与归属

| 文件 | 归属 | 说明 |
|---|---|---|
| `src/index.js` | Lead | 插件入口：注入 `webServer`，建 store，注册 prefix 路由 |
| `src/api.mjs` | Lead | 路由分发、JSON 编解码、错误映射、回环校验 |
| `src/team-read.mjs` | host-core | 列会话、读团队（成员快照 + 任务归属 + 状态） |
| `src/dismiss.mjs` | host-core | 删除角色：停会话 → 子会话目录进回收站 → 写墓碑 |
| `src/store.mjs` | host-core | 墓碑存储（原子写） |
| `src/client.js` | client-ui | 浏览器半区 UI（无构建，经典 script/IIFE，参考 cron-board） |
| `tests/host-*.test.mjs` | host-core | node:test，临时目录夹具 |
| `tests/client*.test.mjs` | client-ui | 纯函数/请求层单测 |
| `tests/api.test.mjs` | Lead | 路由与错误映射 |

跨人边界只通过本文件的契约 + 上面模块的导出函数名。不要改别人的文件。

## 数据来源（宿主持有）

- 会话持久化：`ctx.sessionPersistence`（`open(id,'read')` → `handle.read(0, undefined)`；`stat(id)` 返回含 `path` 的元数据；`list()` 列会话）。参考 `packages/experimental/agent-team/src/persisted.ts`。
- 团队记录：Lead 会话日志里的 `team/member` 事件，`data.member = { id, name, description, provider, context, phase: 'provisioning'|'active'|'failed', error? }`（同名成员只取最后一条快照）。
- 任务记录：同一日志里的 `team/task`，`data.task = { id, revision, subject, description, status: 'pending'|'in_progress'|'completed'|'deleted', ownerId?, blockedBy, writeScopes }`（取每个 taskId 的最大 revision；status='deleted' 视为不存在）。
- 会话标题：`session/title` 事件（`data.title`）；缺失时回退首条 `user/message` 的前 40 字；再缺回退 session id。
- 实时能力：`ctx.agents.get(sessionId)` 拿 live Agent；`ctx.subagents.interrupt(id, { kind: 'ancestor', agent: leadAgent })` 中断；成员停止等待用轮询 `agent.status !== 'running'`。
- 根会话判定：header.parentSession === undefined。

## HTTP API（base `/api/team-admin`，仅回环）

所有响应 JSON；错误统一 `{ "error": "中文文案" }` + 4xx/5xx。非回环来源（`req.socket.remoteAddress` 非 127.0.0.1/::1）→ 403。

### GET /health
`200 { "ok": true, "name": "team-admin", "version": "0.1.0" }`

### GET /sessions?query=&limit=
`200 { "sessions": SessionRow[] }`，按 `lastActivityAt` 降序、其次 `createdAt` 降序。
`query` 对 title/cwd/id 做大小写不敏感子串过滤；`limit` 默认 50、上限 200。

```ts
interface SessionRow {
  id: string
  title: string
  cwd: string
  createdAt: number        // epoch ms
  lastActivityAt: number   // epoch ms，取最后一条事件的 time；未知回退 createdAt
  live: boolean            // ctx.agents.get(id)?.status === 'running' 或会话已加载
}
```

**只列根会话**（parentSession 为空）。成员列表要按需读；列表页不要为了判断"是否含团队"去全量解压每个会话日志。

### GET /team?sessionId=
`200 { "session": SessionRow, "members": MemberRow[], "dismissed": DismissedRow[] }`

```ts
interface MemberRow {
  name: string
  id: string               // 成员 Session id
  phase: 'provisioning' | 'active' | 'failed'
  status: 'running' | 'inactive' | 'provisioning' | 'failed'
  description: string
  provider: string
  context: 'fresh' | 'fork'
  model?: string
  error?: string
  dismissed: boolean       // 墓碑存在
  sessionExists: boolean   // 子会话仍在 store（live 或持久化）
  ownedTasks: number       // 非 deleted 且 ownerId === id 的任务数
  lastActivityAt: number | null
}
interface DismissedRow {
  name: string
  id: string
  dismissedAt: number
  sessionDeleted: boolean
  trashPath?: string
  memberStillInRoster: boolean  // 内置 roster 仍保留该记录（宿主限制，恒 true）
}
```

- 不含 Lead 行；不存在/非根会话 → 404 `{error:'会话不存在'}` / 400 `{error:'只能管理根会话的团队'}`。
- 内置 roster 是 append-only，删除后记录仍在：`dismissed=true` 表示"已由本插件删除"，UI 必须把这类成员折进「已删除」区并说明内置面板仍会显示。

### POST /dismiss
body `{ "sessionId": string, "name": string, "deleteSession"?: boolean }`（`deleteSession` 默认 true）

`200 { "ok": true, "name": string, "id": string, "stopped": boolean, "sessionDeleted": boolean, "trashPath"?: string, "dismissedAt": number }`

语义（顺序固定）：
1. 校验根会话 + 成员存在且不是 Lead；`name == 'lead'` → 400 `{error:'不能删除 Lead'}`。
2. 成员 `phase === 'provisioning'` → 409 `{error:'成员正在创建中，请稍后再试'}`。
3. 该成员 Agent 存活且 running：`ctx.subagents.interrupt` 后用 `leadAgent` 授权；最多等 15s 变 inactive；仍 running → 409 `{error:'成员仍在运行，已尝试中断，请稍后重试'}`。
4. `deleteSession !== false` 且子会话存在：把子会话目录**移动**到 `<dataDir>/trash/<leadSessionId>/<memberId>-<epochMs>/`（`rename`，EXDEV 时 copy+rm）。移动而不是 `rm -rf`：可恢复、且 session-query 索引会按"文件消失"自动摘除。
5. 写墓碑（store 原子写），返回结果。
6. 幂等：已墓碑成员再次 dismiss → 200，复用原记录。

### 错误码约定
| 场景 | 状态 | error |
|---|---|---|
| 非回环来源 | 403 | 仅允许本机访问 |
| body 不是 JSON / 超 64KB | 400 | 请求体不合法 |
| 会话不存在 | 404 | 会话不存在 |
| 非根会话 | 400 | 只能管理根会话的团队 |
| 成员不存在 | 404 | 团队成员不存在 |
| 删除 lead | 400 | 不能删除 Lead |
| 创建中 | 409 | 成员正在创建中，请稍后再试 |
| 仍在运行 | 409 | 成员仍在运行，已尝试中断，请稍后重试 |
| 系统错误 | 500 | 操作失败（详见服务端日志） |

## 存储

`dataDir` = `process.env.DSH_TEAM_ADMIN_DATA_DIR` 或 `<home>/.dsh/team-admin`。
`state.json`（版本 1，原子写 tmp+rename）：
```json
{ "version": 1, "dismissed": { "<leadSessionId>": { "<memberId>": { "name": "...", "dismissedAt": 0, "sessionDeleted": true, "trashPath": "..." } } } }
```
坏 JSON / 未知 version：不抛给 UI，按空状态处理并把损坏文件改名 `.corrupt-<ts>`。

## 模块导出契约

`src/team-read.mjs`
- `export async function listTeamSessions(ctx, { query, limit })` → `SessionRow[]`
- `export async function readTeam(ctx, { sessionId, store })` → `{ session, members, dismissed }`；不存在抛 `AdminError`
- `export function parseRoster(events)` → `{ members: MemberSnapshot[], tasks: TaskSnapshot[], title?: string }`（纯函数，供单测）

`src/dismiss.mjs`
- `export async function dismissMember(ctx, { sessionId, name, deleteSession }, { store, now })` → 结果对象；错误抛 `AdminError`（带 `code`: 'not-found'|'bad-session'|'lead'|'provisioning'|'running'|'system'）

`src/store.mjs`
- `export async function openStore({ dir })` → `{ readAll(), listDismissed(leadId), record(leadId, memberId, row), dataDir }`

`src/api.mjs`
- `export function createApi(deps)` → `(req, res) => Promise<void>`，只处理 `/api/team-admin` 前缀，路径不符回 404；错误经 `AdminError` 映射。

## 客户端契约（src/client.js）

- 形态：经典 script IIFE（`(() => { ... })()`），无 import/构建；参考 `~/.dsh/profiles/web/node_modules/@mzzsfy/dsh-cron-board/src/client.js`。
- 注册两处（都指向同一组件工厂）：
  1. `plugins.bundle.config`，`key === '@chenkai114/dsh-team-admin'`
  2. `settings.plugin.item`，`key === 'team-admin'`（若该槽需要 settings 命名空间才生效，就只保留第 1 处并在 README 说明）
- 组件：会话搜索框（防抖 300ms）+ 会话列表（title/cwd/最近活跃）→ 选中后展示成员表（name/status/description/model/任务数）+ 每行「删除」按钮 + 二次确认（输入成员名或点确认）+ 已删除区（墓碑说明）+ 空态/错误态/加载态。
- 删除成功后就地刷新；失败显示 `error` 文案，不清空列表。
- 样式：自注入 `<style>`，用宿主设计令牌（`var(--dsw-*)`）与 `dsw-alias` 值，自带深色主题适配；不要引入外部资源。
- 文案中文；所有网络错误都要有人话兜底。
- 不要轮询；加载/操作后按需 refresh。

## 验证

- `npm test`（node:test，不依赖本机 dsh 状态）。
- 真机验证：临时 DSH home + 独立 web 实例（另一个端口）装本插件，Playwright 打开「插件管理 → dsh-team-admin」卡片截图；不碰用户正在跑的 3080 实例，不改 `~/.dsh/profiles/web`。
