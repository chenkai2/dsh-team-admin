import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isLoopbackAddress, createApi } from '../src/api.mjs'
import { AdminError } from '../src/error.mjs'

/** 造一个最小 IncomingMessage 替身：socket + method + url + 可选 JSON body。 */
function makeReq({ method = 'GET', url = '/', address = '127.0.0.1', body } = {}) {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body), 'utf8')]
  return {
    method,
    url,
    socket: { remoteAddress: address },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** 造一个最小 ServerResponse 替身：记录状态码与 JSON。 */
function makeRes() {
  const res = {
    headersSent: false,
    statusCode: 0,
    headers: {},
    payload: undefined,
    writeHead(status, headers) {
      res.headersSent = true
      res.statusCode = status
      res.headers = headers
      return res
    },
    end(text) {
      res.payload = text === undefined ? undefined : JSON.parse(text)
    },
  }
  return res
}

const fakes = {
  listTeamSessions: async () => [],
  readTeam: async () => ({ session: {}, members: [], dismissed: [] }),
  dismissMember: async () => ({}),
}
const base = { ctx: {}, getStore: async () => ({ kind: 'fake' }), version: '0.1.0', logSystem: () => {}, services: fakes }

test('isLoopbackAddress accepts local addresses only', () => {
  for (const address of ['127.0.0.1', '127.8.8.8', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, address)
  }
  for (const address of ['10.0.0.2', '192.168.1.5', '::', undefined]) {
    assert.equal(isLoopbackAddress(address), false, String(address))
  }
})

test('rejects non-loopback callers with 403', async () => {
  const api = createApi(base)
  const res = makeRes()
  await api(makeReq({ url: '/api/team-admin/health', address: '10.0.0.2' }), res)
  assert.equal(res.statusCode, 403)
  assert.match(res.payload.error, /仅允许本机/)
})

test('health reports name and version', async () => {
  const api = createApi(base)
  const res = makeRes()
  await api(makeReq({ url: '/api/team-admin/health' }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.payload, { ok: true, name: 'team-admin', version: '0.1.0' })
})

test('unknown path is 404 and wrong method is 405', async () => {
  const api = createApi(base)
  const missing = makeRes()
  await api(makeReq({ url: '/api/team-admin/nope' }), missing)
  assert.equal(missing.statusCode, 404)

  const wrong = makeRes()
  await api(makeReq({ url: '/api/team-admin/sessions', method: 'POST' }), wrong)
  assert.equal(wrong.statusCode, 405)
})

test('sessions forwards query and clamps limit', async () => {
  const calls = []
  const api = createApi({
    ...base,
    services: { ...fakes, listTeamSessions: async (ctx, args) => { calls.push(args); return [] } },
  })
  const res = makeRes()
  await api(makeReq({ url: '/api/team-admin/sessions?query=abc&limit=9999' }), res)
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls[0], { query: 'abc', limit: 200 })
})

test('team requires sessionId', async () => {
  const api = createApi(base)
  const res = makeRes()
  await api(makeReq({ url: '/api/team-admin/team' }), res)
  assert.equal(res.statusCode, 400)
  assert.match(res.payload.error, /缺少 sessionId/)
})

test('team maps AdminError status and message', async () => {
  const api = createApi({
    ...base,
    services: { ...fakes, readTeam: async () => { throw new AdminError('会话不存在', 'not-found', 404) } },
  })
  const res = makeRes()
  await api(makeReq({ url: '/api/team-admin/team?sessionId=s1' }), res)
  assert.equal(res.statusCode, 404)
  assert.equal(res.payload.error, '会话不存在')
})

test('dismiss validates body, defaults deleteSession true, prefixes ok', async () => {
  const calls = []
  const api = createApi({
    ...base,
    services: {
      ...fakes,
      dismissMember: async (ctx, args) => { calls.push(args); return { name: args.name, id: 'm1', stopped: true, sessionDeleted: true, dismissedAt: 1 } },
    },
  })
  const bad = makeRes()
  await api(makeReq({ url: '/api/team-admin/dismiss', method: 'POST', body: { sessionId: 's1' } }), bad)
  assert.equal(bad.statusCode, 400)

  const ok = makeRes()
  await api(makeReq({ url: '/api/team-admin/dismiss', method: 'POST', body: { sessionId: 's1', name: 'qa' } }), ok)
  assert.equal(ok.statusCode, 200)
  assert.equal(ok.payload.ok, true)
  assert.equal(calls[0].deleteSession, true)

  const keep = makeRes()
  await api(makeReq({ url: '/api/team-admin/dismiss', method: 'POST', body: { sessionId: 's1', name: 'qa', deleteSession: false } }), keep)
  assert.equal(calls[1].deleteSession, false)
})

test('system errors become 500 without leaking internals', async () => {
  const logged = []
  const api = createApi({
    ...base,
    logSystem: (line) => logged.push(line),
    services: { ...fakes, listTeamSessions: async () => { throw new Error('ENOENT /Users/secret') } },
  })
  const res = makeRes()
  await api(makeReq({ url: '/api/team-admin/sessions' }), res)
  assert.equal(res.statusCode, 500)
  assert.equal(res.payload.error, '操作失败（详见服务端日志）')
  assert.equal(logged.length, 1)
})

test('malformed JSON body is rejected', async () => {
  const api = createApi(base)
  const req = {
    method: 'POST',
    url: '/api/team-admin/dismiss',
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from('{nope') },
  }
  const res = makeRes()
  await api(req, res)
  assert.equal(res.statusCode, 400)
  assert.match(res.payload.error, /合法 JSON/)
})