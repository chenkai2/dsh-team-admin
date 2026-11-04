# 发布流程（与 dsh-daemon 同构）

## 一次性准备（npm 侧，必须人工）

1. 登录 npm，进入包页面 `@chenkai114/dsh-team-admin` → **Settings → Trusted Publisher → GitHub Actions**
2. 填：
   - Organization/User: `chenkai2`
   - Repository: `dsh-team-admin`
   - Workflow filename: `publish.yml`
   - Environment: `npm-publish`
3. 仓库 Settings → Environments 里确认存在 `npm-publish`（首次创建可留空保护规则）

之后 CI 用 OIDC 直接发布，不需要 `NPM_TOKEN`，也不需要交互式 2FA。

## 每次发布

1. 改 `package.json` 的 `version`，同时改 `src/index.js` 的 `PLUGIN_VERSION`（CI 会校验两者一致）
2. 本地 `npm test` 通过
3. `git commit && git push`
4. 打 tag 并推：`git tag v0.1.0 && git push origin v0.1.0`
5. GitHub → Releases → Draft a new release，选该 tag，发布
6. `publish.yml` 触发：校验 tag/版本 → `npm test` → `npm publish --provenance --access public`

干跑：Actions 页面手动 `Run workflow`，`dry_run=true`。

## 本地验证发布产物

```sh
npm pack --dry-run        # 看 files 列表
npm test
```
