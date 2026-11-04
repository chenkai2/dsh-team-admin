# 验证分层

| 层 | 命令 | 覆盖 | 依赖 |
|---|---|---|---|
| 单元 | `npm test` | 路由/错误映射、团队读取、删除语义、墓碑存储、打包契约 | 无（node:test） |
| 浏览器 | `node tests/e2e/run.mjs` | 真实 `src/client.js` 在 Chromium 里渲染：会话列表、成员表、删除确认、已删除区、错误态；产出 `tests/e2e/out/*.png` | Playwright + Chromium |
| 真数据 | `node tests/e2e/real-data.mjs` | 用本机真实会话日志（只读）验证 `parseRoster` 的字段与状态映射 | `zstd` CLI + 本机会话 |
| 真组合 | 安装到 profile 后由用户在 GUI 里点开卡片 | 槽位注册、HTTP 路由、删除真实成员 | 运行中的 dsh web |

## 为什么真组合不自动跑

删除动作会移动真实会话目录，且宿主只有一个 web 实例在跑；自动化真组合需要在临时 `DSH_HOME` 里拉起第二套 web 实例（含 pnpm 安装），
不适合塞进单元测试。发布前的冒烟按上面"真组合"一行人工验证，截图留档。
