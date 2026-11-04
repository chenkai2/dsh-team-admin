// e2e 静态服务器：把真实 src/client.js 装进 harness 页，并用假 /api/team-admin/* 提供数据。
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sessions, teams, dismissedState } from './mock-data.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const scenarioOf = (url) => url.searchParams.get('scenario') || 'default'

/** 读完整请求体（JSON 对象；非 JSON 当空对象）。 */
async function readBody(req) {
  if (req.method !== 'POST') return {}
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  try { return JSON.parse(text) } catch { return {} }
}

/** 返回该 scenario 下的 JSON 响应。 */
function respond(url, scenario, body) {
  if (scenario === 'error') return { status: 500, body: { error: '操作失败（详见服务端日志）' } }
  const path = url.pathname
  if (path === '/api/team-admin/health') return { status: 200, body: { ok: true, name: 'team-admin', version: '0.1.0' } }
  if (path === '/api/team-admin/sessions') {
    if (scenario === 'empty') return { status: 200, body: { sessions: [] } }
    const q = (url.searchParams.get('query') || '').toLowerCase()
    const rows = sessions.filter(row => q === '' || row.title.toLowerCase().includes(q) || row.cwd.toLowerCase().includes(q))
    return { status: 200, body: { sessions: rows } }
  }
  if (path === '/api/team-admin/team') {
    const id = url.searchParams.get('sessionId')
    const team = teams[id]
    if (!team) return { status: 404, body: { error: '会话不存在' } }
    if (scenario === 'dismissed') {
      const dismissed = dismissedState()[id] || {}
      return {
        status: 200,
        body: {
          session: team.session,
          members: team.members.map(member => dismissed[member.id] ? { ...member, dismissed: true, sessionExists: false } : member),
          dismissed: Object.entries(dismissed).map(([memberId, row]) => ({ id: memberId, name: row.name, dismissedAt: row.dismissedAt, sessionDeleted: row.sessionDeleted, trashPath: row.trashPath, memberStillInRoster: true })),
        },
      }
    }
    return { status: 200, body: team }
  }
  if (path === '/api/team-admin/dismiss') {
    const name = typeof body?.name === 'string' ? body.name : ''
    const id = name === 'mine-migrator' ? 'child-3' : (name === 'wasm-researcher' ? 'child-1' : 'child-2')
    return { status: 200, body: { ok: true, name, id, stopped: false, sessionDeleted: true, dismissedAt: Date.now() } }
  }
  return { status: 404, body: { error: '接口不存在' } }
}

/**
 * 启动 e2e 服务器。
 * @param {number} [port] - 0 表示系统分配。
 * @returns {Promise<{url: string, close: () => Promise<void>}>}
 */
export async function serve(port = 0) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(await readFile(join(here, 'harness.html')))
      return
    }
    if (url.pathname === '/__plugin/client.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' })
      res.end(await readFile(join(root, 'src', 'client.js')))
      return
    }
    const body = await readBody(req)
    const { status, body: payload } = respond(url, scenarioOf(url), body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(payload))
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    url: 'http://127.0.0.1:' + actualPort,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { url } = await serve(Number(process.env.PORT || 0))
  console.log('e2e harness: ' + url + '?scenario=default')
}