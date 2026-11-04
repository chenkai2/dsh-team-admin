// Playwright 冒烟：真实浏览器加载 src/client.js + harness 页，按场景截图并断言可见文案。
// 用法：node tests/e2e/run.mjs（需要 playwright 与 chromium 已安装；CI 不跑，本机验证用）
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { serve } from './serve.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const out = join(here, 'out')

/** 解析 playwright：向上找 node_modules，其次 npm 全局目录。 */
async function loadChromium() {
  const { createRequire } = await import('node:module')
  const { execSync } = await import('node:child_process')
  const { existsSync } = await import('node:fs')
  const attempts = []
  let dir = here
  for (let i = 0; i < 8; i += 1) {
    const candidate = join(dir, 'node_modules', 'playwright')
    if (existsSync(candidate)) attempts.push(candidate)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  try {
    attempts.push(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright'))
  } catch {
    // 没有 npm 全局目录就只试本地候选
  }
  for (const candidate of attempts) {
    try {
      const module = createRequire(join(candidate, 'package.json'))(candidate)
      if (module && module.chromium) return module.chromium
    } catch {
      // 继续下一个候选
    }
  }
  throw new Error('未找到 playwright；请先安装（npm i -D playwright && npx playwright install chromium）')
}
const scenarios = [
  ['default', ['智能体团队管理', 'wasm-researcher', 'trial-runner', '删除']],
  ['dismissed', ['已删除', '回收站']],
  ['empty', ['没有']],
  ['error', ['失败']],
]

const chromium = await loadChromium()
await mkdir(out, { recursive: true })
const server = await serve(0)
/** 依次尝试：自带 chromium → 系统 Chrome channel → Chrome 可执行文件。 */
async function launchBrowser() {
  const attempts = [
    () => chromium.launch(),
    () => chromium.launch({ channel: 'chrome' }),
    () => chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }),
  ]
  let lastError
  for (const attempt of attempts) {
    try { return await attempt() } catch (error) { lastError = error }
  }
  throw lastError
}
const browser = await launchBrowser()
const results = []
try {
  for (const [scenario, expectations] of scenarios) {
    const page = await browser.newPage({ viewport: { width: 1180, height: 900 } })
    const failures = []
    page.on('pageerror', error => failures.push(String(error)))
    await page.goto(server.url + '/?scenario=' + scenario, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => globalThis.__harnessReady === true || globalThis.__harnessError !== undefined, { timeout: 20000 })
    const harnessError = await page.evaluate(() => globalThis.__harnessError)
    if (harnessError) throw new Error('harness: ' + harnessError)
    await page.waitForTimeout(scenario === 'default' ? 1200 : 600)
    const text = await page.evaluate(() => document.getElementById('root').innerText)
    for (const expected of expectations) {
      if (!text.includes(expected)) failures.push('缺少文案: ' + expected)
    }
    const file = join(out, scenario + '.png')
    await page.screenshot({ path: file, fullPage: true })
    results.push({ scenario, ok: failures.length === 0, failures, file })
    await page.close()
  }
} finally {
  await browser.close()
  await server.close()
}
for (const row of results) console.log((row.ok ? 'PASS' : 'FAIL') + ' ' + row.scenario + ' → ' + row.file + (row.ok ? '' : ' :: ' + row.failures.join('; ')))
process.exitCode = results.every(row => row.ok) ? 0 : 1