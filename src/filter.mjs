/**
 * 从会话列表投影里摘掉已删除成员：顶部「子智能体」选择器读 `subagentCatalog`，
 * 内置「智能体团队」面板读 `agentTeam.members`；两者都在 `/api/session/list` 的响应里。
 * 宿主 catalog 与 roster 都是 append-only，删会话不会撤销事件，所以在服务端出口过滤一次。
 *
 * @module filter
 */

/**
 * 判断条目是否属于已删除成员。
 * @param {unknown} entry - 投影里的一个条目。
 * @param {Set<string>} dismissed - 已删除的会话/成员 id 集合。
 * @returns {boolean} 命中墓碑时返回 true（应被过滤）。
 */
function isDismissed(entry, dismissed) {
  return entry !== null && typeof entry === 'object' && typeof entry.id === 'string' && dismissed.has(entry.id)
}

/**
 * 递归过滤一份会话列表载荷（原地修改）。
 * @param {unknown} payload - `/api/session/list` 的返回体（或其中的单个会话行）。
 * @param {Set<string>} dismissed - 已删除的会话/成员 id 集合。
 * @param {number} [maxDepth] - 递归深度上限，防御异常结构。
 * @returns {unknown} 同一个 payload 引用。
 */
export function stripDismissedMembers(payload, dismissed, maxDepth = 6) {
  if (payload === null || typeof payload !== 'object' || !(dismissed instanceof Set) || dismissed.size === 0) return payload
  const visit = (node, depth) => {
    if (node === null || typeof node !== 'object' || depth > maxDepth) return
    if (Array.isArray(node.subagentCatalog)) node.subagentCatalog = node.subagentCatalog.filter((entry) => !isDismissed(entry, dismissed))
    if (node.agentTeam !== null && typeof node.agentTeam === 'object' && Array.isArray(node.agentTeam.members)) {
      node.agentTeam.members = node.agentTeam.members.filter((entry) => !isDismissed(entry, dismissed))
    }
    for (const key of Object.keys(node)) {
      if (key === 'subagentCatalog' || key === 'agentTeam') continue
      visit(node[key], depth + 1)
    }
  }
  visit(payload, 0)
  return payload
}

/**
 * 从持久化状态里收集已删除成员 id。
 * @param {object|null} state - store.readAll() 的返回值。
 * @returns {Set<string>} 墓碑成员 id 集合。
 */
export function collectDismissedIds(state) {
  const ids = new Set()
  const buckets = state !== null && typeof state === 'object' && state.dismissed !== null && typeof state.dismissed === 'object'
    ? state.dismissed
    : {}
  for (const bucket of Object.values(buckets)) {
    if (bucket === null || typeof bucket !== 'object') continue
    for (const memberId of Object.keys(bucket)) ids.add(memberId)
  }
  return ids
}
