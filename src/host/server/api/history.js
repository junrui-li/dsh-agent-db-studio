/**
 * 执行历史（契约 §3.5）：server/api/history.py 的移植。
 *
 * - 存 SQLite dbs.db 的 history 表（store/db.js），最多 config.HISTORY_MAX 条，
 *   最新在前（ORDER BY seq DESC）。
 * - HistoryItem 字段：id/connectionId/connectionName/database/sql/status/elapsedMs/
 *   time/source(panel|agent|ticket)/kind(query|execute)/statementCount/rowCount/
 *   affectedRows/truncated/error(仅 status=error)。
 *
 * 与 Python 版的差异：
 * - record 返回 Promise<string>（historyId）——M3 写面（execute/tickets/undo）
 *   await 它拿 id；同步 SQLite 调用实际立即完成。
 * - handleList 的过滤下推：time 范围与 status/connectionId 下推 SQL；keyword 用
 *   LIKE + escapeLike 转义 % _ \（保持子串语义）。
 */

import * as config from '../core/config.js'
import * as db from '../store/db.js'
import { ApiError } from '../core/errors.js'
import * as common from './common.js'

const _SOURCES = new Set(['panel', 'agent', 'ticket', 'undo'])
const _KINDS = new Set(['query', 'execute', 'export'])

/** 记录一次已执行（或执行中途失败）的 SQL 请求；返回 historyId（撤销快照按
 * historyId 反查，api/undo.js）。返回 Promise 以便 async 调用方 await。
 *
 * 调用方按契约传 source（panel/agent/ticket）与 kind（query/execute）；
 * 默认值是为了兼容旧调用点/测试。explain = EXPLAIN 计划列表（§3.5 执行详情），
 * purpose = agent 查询目的摘要（分组展示，§4.2 db_query.purpose）。
 */
export async function historyRecord(info, sql, ok, elapsedMs, error = null, options = {}) {
  const {
    database = '',
    source = 'panel',
    kind = 'query',
    statementCount = 1,
    rowCount = 0,
    affectedRows = null,
    truncated = false,
    explain = null,
    purpose = '',
    undo = null,
    ticketId = '',
    ticketBy = '',
  } = options
  const item = {
    id: _newId(),
    connectionId: info.id ?? '',
    connectionName: info.name ?? '',
    database: database || '',
    sql: (sql || '').slice(0, config.HISTORY_SQL_MAX),
    status: ok ? 'ok' : 'error',
    elapsedMs: Math.trunc(Number(elapsedMs ?? 0)),
    time: common.now(),
    source: _SOURCES.has(source) ? source : 'panel',
    kind: _KINDS.has(kind) ? kind : 'query',
    statementCount: Math.trunc(Number(statementCount ?? 1)),
    rowCount: Math.trunc(Number(rowCount ?? 0)),
    affectedRows: affectedRows === null || affectedRows === undefined
      ? null : Math.trunc(Number(affectedRows)),
    truncated: Boolean(truncated),
  }
  if (error) item.error = String(error).slice(0, 2000)
  if (explain instanceof Array && explain.length) item.explain = explain
  if (purpose) item.purpose = String(purpose).slice(0, 200)
  if (undo && typeof undo === 'object' && !(undo instanceof Array) && Object.keys(undo).length) {
    item.undo = undo // 撤销可用性摘要（V2.2/§3.6a），历史详情据此预判撤销按钮
  }
  if (ticketId) item.ticketId = String(ticketId).slice(0, 64) // 来源工单（第 27 轮）
  if (ticketBy) item.ticketBy = String(ticketBy).slice(0, 16) // 工单发起者：agent | user
  db.recordHistory(item) // 单事务 INSERT + 按 seq 淘汰到 HISTORY_MAX
  return item.id
}

// 旧导出名别名：M2-B 任务说明用 record，M3 写面用 historyRecord——两个都保留。
export const record = historyRecord

function _newId() {
  const bytes = new Uint8Array(6) // uuid4().hex[:12] 等价：12 个 hex 字符
  globalThis.crypto.getRandomValues(bytes)
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** YYYY-MM-DD → 补全为当天 00:00:00 / 23:59:59；完整时间串原样返回。 */
function _timeBound(raw, end = false) {
  const value = String(raw ?? '').trim()
  if (value.length === 10 && value[4] === '-' && value[7] === '-') {
    return `${value} ${end ? '23:59:59' : '00:00:00'}`
  }
  return value
}

export async function handleList(query, _body = null, _headers = null) {
  const params = query ?? {}
  const rawLimit = params.limit
  let limit
  if (rawLimit === null || rawLimit === undefined || String(rawLimit).trim() === '') {
    limit = 500 // 面板默认一页 500 条（契约 §3.5）
  } else {
    const parsed = Number(rawLimit)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ApiError(400, `limit 必须是整数: ${JSON.stringify(rawLimit)}`)
    }
    limit = parsed
  }
  limit = Math.max(1, Math.min(limit, config.HISTORY_MAX))

  const rawOffset = params.offset
  let offset
  if (rawOffset === null || rawOffset === undefined || String(rawOffset).trim() === '') {
    offset = 0
  } else {
    const parsed = Number(rawOffset)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ApiError(400, `offset 必须是整数: ${JSON.stringify(rawOffset)}`)
    }
    offset = parsed
  }
  offset = Math.max(0, offset)

  const connectionId = common.textField(params, 'connectionId', '', 'connectionId').trim()
  const statusFilter = common.textField(params, 'status', '', 'status').trim()
  const keyword = common.textField(params, 'keyword', '', 'keyword').trim().toLowerCase()
  const timeFrom = _timeBound(common.textField(params, 'from', '', 'from'))
  const timeTo = _timeBound(common.textField(params, 'to', '', 'to'), true)

  // 过滤下推 SQL：connection_id / status 精确匹配，keyword 用 LIKE + escapeLike
  // 转义 % _ \（保持旧 Python 子串语义；SQLite LIKE 对 ASCII 不区分大小写）；
  // time 为 "YYYY-MM-DD HH:MM:SS"，字符串比较即时间比较。
  const clauses = []
  const values = []
  if (connectionId) {
    clauses.push('connection_id = ?')
    values.push(connectionId)
  }
  if (statusFilter) {
    clauses.push('status = ?')
    values.push(statusFilter)
  }
  if (keyword) {
    // 关键字同时匹配 SQL 原文与工单号（第 27 轮：历史页搜 tk_xxx 可筛出工单执行）
    clauses.push(`(sql LIKE ? ESCAPE '\\' OR ticket_id LIKE ? ESCAPE '\\')`)
    values.push(`%${db.escapeLike(keyword)}%`)
    values.push(`%${db.escapeLike(keyword)}%`)
  }
  if (timeFrom) {
    clauses.push('time >= ?')
    values.push(timeFrom)
  }
  if (timeTo) {
    clauses.push('time <= ?')
    values.push(timeTo)
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const conn = db.connect()
  const total = Math.trunc(Number(
    conn.prepare(`SELECT COUNT(*) AS n FROM history${where}`).get(...values)?.n ?? 0))
  const rows = conn.prepare(
    `SELECT * FROM history${where} ORDER BY seq DESC LIMIT ? OFFSET ?`,
  ).all(...values, limit, offset)
  const items = rows.map((row) => _historyRowToItem(row))
  // 撤销实时状态（第 43 轮）：undo_json 是执行时冻结的摘要，撤销后历史行感知不到；
  // 按 historyId/ticketId 关联 undo_log 最新条目状态，前端据此禁用已撤销记录的撤销按钮
  const live = db.undoStatusByRefs(
    items.map((item) => item.id),
    items.map((item) => item.ticketId ?? ''),
  )
  for (const item of items) {
    item.undoLive = live[`h:${item.id}`] || live[`t:${item.ticketId ?? ''}`] || ''
  }
  return { history: items, total, limit, offset }
}

/** 与 store/db.js 的 _historyRowToItem 同构（Python history.py 直接调 db 层私有
 * 函数）；JS 侧复制一份保持 store 层封装，字段序与 db 层一致。 */
function _historyRowToItem(row) {
  const item = {
    id: row.id,
    connectionId: row.connection_id || '',
    connectionName: row.connection_name || '',
    database: row.database_name || '',
    sql: row.sql || '',
    status: row.status || 'ok',
    elapsedMs: Math.trunc(Number(row.elapsed_ms ?? 0)),
    time: row.time || '',
    source: row.source || 'panel',
    kind: row.kind || 'query',
    statementCount: Math.trunc(Number(row.statement_count ?? 1)),
    rowCount: Math.trunc(Number(row.row_count ?? 0)),
    affectedRows: row.affected_rows === null || row.affected_rows === undefined
      ? null : Math.trunc(Number(row.affected_rows)),
    truncated: Boolean(row.truncated),
  }
  if (row.error) item.error = row.error
  const plans = _loadJsonText(row.explain_json)
  if (plans) item.explain = plans
  if (row.purpose) item.purpose = row.purpose
  const undo = _loadJsonText(row.undo_json)
  if (undo && typeof undo === 'object' && !(undo instanceof Array) && Object.keys(undo).length) {
    item.undo = undo
  }
  if (row.ticket_id) item.ticketId = row.ticket_id
  if (row.ticket_by) item.ticketBy = row.ticket_by
  return item
}

function _loadJsonText(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}
