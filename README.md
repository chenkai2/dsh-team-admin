# dsh-team-admin

给 DeepSeek Harness 的「智能体团队（Agent Teams）」补一个**管理面**：在 GUI 里选任意会话，查看它的团队成员，**删除角色并清理该成员的持久会话**。

## 为什么需要

v0.2.x 的内置 Team roster 是 **append-only**：只能 `spawn_teammate` 加人，没有删除 / 改名 / 名字复用（见 `dsh-experimental-agent-team` 的 Known Limitations）。成员上下文耗尽、任务结束或建错时，只能"停手不理会"，名单和名额永久占着。

本插件补上缺失的那一半：

- 列出任意根会话的团队成员（名字、状态、描述、模型、名下任务数）
- 删除成员：中断运行中的会话 → 成员会话目录**移入回收站** → 写墓碑，管理面标记「已删除」
- 已删除成员集中展示，回收站路径可复制
- 删除后**回收成员名额**：roster 仍是 append-only，插件按团队把有效上限抬到「配置上限 + 该团队墓碑数」，删一个就能再加一个（0.2.2 起按团队生效，不再全局加）
- 已删除成员从顶部「子智能体」选择器与内置「智能体团队」面板里消失（在宿主投影出口按墓碑过滤，不改宿主源码）
- **新版智能体团队（0.2.2-rc.1+）**：上游移除了成员/角色列表，插件在会话页头补回一个只读「成员 N」面板，数据来自会话日志里的 `team/member` 事件
- 顺带修老格式会话：没有 title / sessionListMetadata 投影的 v1 会话补标题，空白草稿重新按「新会话」规则隐藏

## 安装

```sh
dsh plugin --profile web add @chenkai114/dsh-team-admin
```

重载后左侧栏会出现 **团队管理** 入口（插件市场里本包的配置卡也保留）。

未发布前用本地源码链接安装：

```sh
dsh plugin --profile web add link:/Users/chenkai2/data1/www/htdocs/dsh-team-admin
```

或在 profile 的 `package.json` 里手动加：
```json
{
  "dependencies": { "@chenkai114/dsh-team-admin": "link:/Users/chenkai2/data1/www/htdocs/dsh-team-admin" },
  "dsh": { "profile": { "bundles": ["...", "@chenkai114/dsh-team-admin"] } }
}
```

左侧栏「团队管理」入口（0.1.1 起）：

![侧栏入口](docs/images/sidebar-entry.png)

打开后是完整管理面板，可直接对真实会话操作：

![团队管理面板](docs/images/team-panel-real.png)

## 用法

1. 搜索并选中一个会话（只列根会话）
2. 面板显示该会话的团队成员
3. 点某个成员的「删除」→ 行内二次确认 → 确认
4. 成员会话进回收站，管理面把它移到「已删除」区

## 删除到底做了什么

| 步骤 | 行为 |
|---|---|
| 停止 | 运行中的成员会被中断，最多等 15s 变 inactive；超时则报错不动数据 |
| 清理会话 | 成员会话目录 `~/.dsh/sessions/.../<memberId>/` 移到 `~/.dsh/team-admin/trash/<leadSessionId>/<memberId>-<ms>/`（**移动，不是删除**，可手工恢复） |
| 墓碑 | 写入 `~/.dsh/team-admin/state.json`，管理面据此显示「已删除」 |

## 适用版本

| DSH 版本 | 智能体团队实现 | 插件行为 |
|---|---|---|
| `0.2.2-alpha.1` / `alpha.2` | `packages/experimental/agent-team`（旧） | 删除 / 名额回收 / 投影过滤全量生效；成员面板用宿主自带的 |
| `0.2.2-rc.1` 起 | `packages/team/agent-team`（新） | roster / `maxMembers` 已移除：名额回收自动跳过；删除与投影过滤继续生效；页头补回只读成员面板 |

插件通过运行时能力探测区分两版（新增 `agentTeams.roster`、`health.maxMembers`），不写死版本号；`package.json` 声明 `dsh.requires.dsh = ">=0.2.2-alpha.1 <0.3.0"`。

## 边界（重要）

- **记录本身不会消失**：宿主 roster 是 append-only，本插件不（也无法）从 Lead 会话日志里抹掉 `team/member` 记录；它只是被墓碑标记，并从投影里过滤掉。管理面与页头成员面板才是"已删除"的真源。
- **名额会回收（旧版团队）**：插件按团队把有效上限抬到「配置上限 + 该团队墓碑数」，所以删一个就能再加一个；`0.2.2-rc.1` 起上游移除了 `maxMembers`，这套机制自动跳过。
- **已删除成员不可调度**：新版智能体团队的成员权威已交给 subagent runtime，历史成员只能看、不能派活 —— 这是上游设计，不是本插件限制。
- **只删成员，不删 Lead**：`lead` 与任意根会话都不受影响。
- **仅本机**：所有接口只接受回环地址；删除动作不会暴露到网络。
- **不做的事**：不改内置团队工具的语义、不写 Lead 会话日志、不碰任务板（成员名下的任务仍留在任务板上，需要时用 `team_task_update` reassign）。

## 配置

| 变量 / 字段 | 默认 | 说明 |
|---|---|---|
| `DSH_TEAM_ADMIN_DATA_DIR` | `~/.dsh/team-admin` | 墓碑与回收站根目录 |

## 开发

```sh
npm test          # node:test，纯本地，不依赖运行中的 dsh
```

模块划分与 HTTP 契约见 [docs/CONTRACT.md](docs/CONTRACT.md)。

## 发布

仓库走 GitHub Actions + npm Trusted Publishing（OIDC），与 dsh-daemon 同构：

1. npm 包页面 → Settings → Trusted Publisher → GitHub Actions，填 `chenkai2` / `dsh-team-admin` / `publish.yml` / `npm-publish`
2. 升 `package.json` 版本（同时改 `src/index.js` 的 `PLUGIN_VERSION`）→ 打 tag `vX.Y.Z` → 发 GitHub Release
3. Actions 自动校验 tag/版本、跑测试、`npm publish --provenance --access public`

## License

MIT