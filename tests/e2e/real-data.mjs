// 真数据冒烟（只读）：扫描本机 ~/.dsh/sessions 里真实会话，验证 parseRoster 能正确读出团队成员。
// 不写任何文件、不改会话；找不到团队数据时按 skip 处理（退出码 0）。
// 用法：node tests/e2e/real-data.mjs
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)
const sessionsRoot = join(homedir(), '.dsh', 'sessions')

/** 解压并解析一个会话日志（zstd -dc）。 */
async function readSessionLog(file) {
  const { stdout } = await run('zstd', ['-dc', '--no-progress', file], { maxBuffer: 512 * 1024 * 1024 })
  return stdout.split('\n').filter(line => line.trim() !== '').map(line => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
}

/** 找本机所有会话日志文件。 */
async function listLogs() {
  const files = []
  for (const workspace of await readdir(sessionsRoot, { withFileTypes: true })) {
    if (!workspace.isDirectory()) continue
    const workspaceDir = join(sessionsRoot, workspace.name)
    for (const entry of await readdir(workspaceDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const file = join(workspaceDir, entry.name, 'session.v4.jsonl.zstd')
      try {
        await readFile(file)
        files.push(file)
      } catch {
        // 没有日志文件的目录跳过
      }
    }
  }
  return files
}

const { parseRoster } = await import('../../src/team-read.mjs')
const logs = await listLogs()
let teams = 0
let members = 0
let tasks = 0
for (const file of logs) {
  const events = await readSessionLog(file)
  const roster = parseRoster(events)
  if (roster.members.length === 0 && roster.tasks.length === 0) continue
  teams += 1
  members += roster.members.length
  tasks += roster.tasks.length
  const names = roster.members.map(member => member.name + '(' + member.phase + ')').join(', ')
  console.log('team ' + file.split('/').slice(-2)[0].slice(0, 8) + ' | title=' + JSON.stringify(roster.title) + ' | members=' + roster.members.length + ' | ' + names + ' | tasks=' + roster.tasks.length)
  for (const member of roster.members) {
    if (typeof member.id !== 'string' || typeof member.name !== 'string') throw new Error('成员字段缺失: ' + JSON.stringify(member))
    if (!['provisioning', 'active', 'failed'].includes(member.phase)) throw new Error('未知 phase: ' + member.phase)
  }
}
if (teams === 0) {
  console.log('SKIP：本机会话里没有团队数据')
  process.exit(0)
}
console.log('OK：' + teams + ' 个团队 / ' + members + ' 个成员 / ' + tasks + ' 个任务，字段全部合法')
