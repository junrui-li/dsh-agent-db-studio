/**
 * DMS 式工单（契约 §3.6）：非查询语句走「预估 → 人工审批 → 单事务执行」。
 * server/api/tickets.py 的移植。
 *
 * 状态机（其它迁移一律 409 TICKET_STATE）：
 *     pending ──approve──► executing ──► succeeded | failed
 *        ├──reject──► rejected
 *        └──cancel──► cancelled
 *
 * 并发保护：approve 用 CAS（UPDATE ... WHERE id=? AND status='pending'）把 pending
 * 原子切成 executing 后再去做耗时的执行；第二个审批请求 CAS 不中，重读状态得到
 * 非 pending，直接 409，不会双执行。
 *
 * 数据落在 SQLite dbs.db 的 tickets 表（store/db.js），最多 500 条（超了淘汰最旧）。
 * 审批/执行之间的 MySQL 网络 IO 全部在 DB 事务外完成。
 */

import { existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync, createWriteStream, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import * as common from './common.js'
import { requireConnection } from './connections.js'
import { executeInTransaction, guardStatements } from './execute.js'
import { databaseOf, maskColumns, runStatements, splitOr400 } from './query.js'
import * as writeRows from './write-rows.js'
import { ensureOpen } from './writes-window.js'
import { historyRecord } from './history.js'
import * as config from '../core/config.js'
import { pool } from '../core/pool.js'
import { ApiError } from '../core/errors.js'
import { columnMeta, toJsonable } from '../core/jsonconv.js'
import { maskRows as applyMasking } from '../core/mask.js'
import { explainStatements } from '../core/plan-guard.js'
import { splitSql } from '../core/sqlsplit.js'
import * as db from '../store/db.js'
import { sqlPreview, statementMeta, estimate as impactEstimate } from '../core/impact.js'

/** impact.estimate 的命名别名（模块内保持 Python 形状的调用点）。 */
const impact = { estimate: impactEstimate }

const MAX_TICKETS = 500

const _COUNT_KEYS = ['pending', 'succeeded', 'failed', 'rejected', 'cancelled', 'undone']

// 导出工单：禁止 INTO OUTFILE / DUMPFILE（文件由本程序生成，防服务端文件逃逸）
const _INTO_FILE_RE = /\bINTO\s+(OUTFILE|DUMPFILE)\b/i

// ---------------------------------------------------------------- 存储

/** 兼容旧工单（本轮之前创建的没有 unknownStatements / statements[].sql）。
 * 旧字段缺失时：statements[].sql 从整张工单的 sql 重新拆分补齐预览；
 * unknownStatements 按 estimatedRows 为 None 的条数统计。只读补全，不改落盘格式。 */
export function _normalizeTicket(ticket) {
  const estimated = ticket.estimated
  if (!estimated || typeof estimated !== 'object' || estimated instanceof Array) {
    return ticket
  }
  const statements = estimated.statements instanceof Array ? estimated.statements : []
  let rawStatements = []
  try {
    rawStatements = splitSql(ticket.sql || '').map((s) => s.sql)
  } catch { // pragma: no cover - splitSql 基本不抛
    rawStatements = []
  }
  const fixedStatements = []
  for (const [index, item] of statements.entries()) {
    if (!item || typeof item !== 'object' || item instanceof Array) continue
    const fixed = { ...item }
    if (!fixed.sql && index < rawStatements.length) {
      fixed.sql = sqlPreview(rawStatements[index])
    }
    if (!fixed.sql) fixed.sql = ''
    fixedStatements.push(fixed)
  }
  const normalized = { ...estimated }
  if (fixedStatements.length) normalized.statements = fixedStatements
  if (!('unknownStatements' in normalized)) {
    normalized.unknownStatements = fixedStatements
      .filter((item) => item.estimatedRows === null || item.estimatedRows === undefined).length
  }
  return { ...ticket, estimated: normalized }
}

function _newId() {
  return 'tk_' + randomUUID().replaceAll('-', '').slice(0, 8)
}

/** 过滤前的全量状态计数（SQL GROUP BY）。 */
function _counts() {
  const raw = db.ticketCounts()
  const out = {}
  for (const key of _COUNT_KEYS) out[key] = Math.trunc(raw[key] ?? 0)
  return out
}

// ---------------------------------------------------------------- 辅助

function _audit(headers, action, fields) {
  common.audit(common.actorOf(headers), action, fields)
}

/** 缺省标题：首关键字 + 表名；多语句再加条数（契约 §3.6「多语句时带条数」）。 */
function _defaultTitle(statements) {
  const meta = statements.length ? statementMeta(statements[0].sql) : {}
  const kind = meta.kind || ''
  const table = meta.table || ''
  const head = kind && table ? `${kind} ${table}` : (kind || 'SQL')
  if (statements.length > 1) return `${head} 等 ${statements.length} 条语句`
  return head !== 'SQL' ? head : 'SQL 工单'
}

function _maxRowsOfConnection(info) {
  return Math.min(Math.trunc(info.maxRows || config.defaultMaxRows()), config.MAX_ROWS_CAP)
}

function _degradedEstimate(statements, note) {
  const statementsMeta = statements.map((statement) => {
    const meta = statementMeta(statement.sql || '')
    return { ...meta, estimatedRows: null, exact: false, sql: sqlPreview(statement.sql || '') }
  })
  return {
    affectedRows: null,
    rowsExact: false,
    statementCount: statements.length,
    unknownStatements: statements.length,
    risk: 'medium',
    statements: statementsMeta,
    notes: [note],
  }
}

/** 预估是增强信息：任何意外都降级，绝不因此让建单失败。 */
async function _estimate(info, statements, database) {
  try {
    return await impact.estimate(info, statements, database)
  } catch (error) { // pragma: no cover - impact.estimate 内部已兜底，这是双保险
    return _degradedEstimate(statements, `预估失败，影响行数未知: ${error}`)
  }
}

/** 结构化工单预估：主键定位逐行精确（rowsExact=true，每行一条语句影响 1 行）。 */
function _rowsEstimate(statements, rendered, summary) {
  const count = statements.length
  const risk = count > 1000 ? 'high' : (count > 100 || count > 3 ? 'medium' : 'low')
  return {
    affectedRows: count,
    rowsExact: true,
    statementCount: count,
    unknownStatements: 0,
    risk,
    statements: statements.map((statement, index) => ({
      kind: statement.op,
      table: summary.table,
      hasWhere: statement.op !== 'INSERT',
      estimatedRows: 1,
      exact: true,
      sql: sqlPreview(rendered[index]),
    })),
    notes: [],
  }
}

function _matchesKeyword(ticket, keyword) {
  const haystack = ['id', 'title', 'sql', 'background', 'connectionName', 'database']
    .map((field) => String(ticket[field] || '')).join(' ')
  return haystack.toLowerCase().includes(keyword)
}

// ---------------------------------------------------------------- 预估（不落库）

export async function handleEstimate(_query, body = null, _headers = null) {
  const payload = common.bodyOf(body)
  const info = common.getConnection(payload) // 连接不存在 → 404
  common.requireMysql(info) // Redis 连接 → 400 NOT_MYSQL
  const sql = common.textField(payload, 'sql', '', 'sql')
  if (!sql.trim()) throw new ApiError(400, '缺少 sql')
  const database = databaseOf(payload, info)
  const statements = splitOr400(sql)
  return { estimated: await _estimate(info, statements, database) }
}

// ---------------------------------------------------------------- 创建

export async function handleCreate(_query, body = null, headers = null) {
  const payload = common.bodyOf(body)
  const info = common.getConnection(payload) // 校验 1：连接存在（404）且为 MySQL（400）
  common.requireMysql(info)
  const background = common.textField(payload, 'background', '', 'background').trim()
  if (background.length < 4) {
    throw new ApiError(400, 'background 至少 4 个字符：说明为什么要执行这条语句', 'TICKET_BACKGROUND')
  }
  const database = databaseOf(payload, info)
  const actor = common.actorOf(headers)
  // 导出工单（第 45 轮）：Agent 把 SELECT 写进工单，人工批准后由程序执行导出
  const isExport = common.boolField(payload, 'export', false)

  // 结构化行写（V2.3）：rowsPayload 存在时走参数化生成——sql 存 render 人读文本
  const rowsPayload = payload.rowsPayload
  let sql
  let statements
  let estimated
  let rowsArchive = null
  if (isExport) {
    if (rowsPayload && typeof rowsPayload === 'object' && !(rowsPayload instanceof Array)) {
      throw new ApiError(400, '导出工单不接受 rowsPayload', 'TICKET_EXPORT_SQL_ONLY')
    }
    const rawSql = common.textField(payload, 'sql', '', 'sql')
    statements = splitOr400(rawSql)
    if (statements.length !== 1) {
      throw new ApiError(400, '导出工单只接受一条 SELECT 语句', 'TICKET_EXPORT_SINGLE')
    }
    const statementSql = statements[0].sql.trim()
    if (!statementSql.toUpperCase().startsWith('SELECT')) {
      throw new ApiError(400, '导出工单只接受 SELECT 语句', 'TICKET_EXPORT_SELECT_ONLY')
    }
    if (_INTO_FILE_RE.test(statementSql)) {
      throw new ApiError(400, '导出工单不允许 INTO OUTFILE / DUMPFILE（文件由本程序生成）',
        'TICKET_EXPORT_NO_OUTFILE')
    }
    guardStatements(info, statements) // 只读白名单校验（SELECT 天然通过）
    sql = statementSql
    // 导出条件计数：建单时先数结果集行数，超上限直接拒绝建单——不让「批准后必然
    // 失败」的工单占用人审批注意力。计数失败降级放行，执行时仍有超限拒绝兜底。
    const exportLimit = config.exportMaxRows()
    if (exportLimit > 0) {
      const counted = await _countExportRows(info, database, statementSql)
      if (counted !== null && counted > exportLimit) {
        throw new ApiError(400,
          `导出预估 ${counted} 行，超过导出上限 ${exportLimit} 行，不允许创建导出工单——`
          + '请收窄查询范围（加过滤条件/分页）后重试',
          'TICKET_EXPORT_OVER_LIMIT')
      }
      estimated = _exportEstimate(statements, counted)
    } else {
      estimated = await _estimate(info, statements, database)
    }
  } else if (rowsPayload && typeof rowsPayload === 'object' && !(rowsPayload instanceof Array)) {
    const [statementsBuilt, rendered, summary] =
      await writeRows.buildRowChanges(info, database, rowsPayload)
    statements = statementsBuilt
    guardStatements(info, statements) // 校验 2/3：只读白名单、DML 缺 WHERE（失败不落库）
    sql = rendered.join('\n')
    estimated = _rowsEstimate(statements, rendered, summary)
    rowsArchive = writeRows.rowsPayloadOf(statements, rendered, summary)
  } else {
    sql = common.textField(payload, 'sql', '', 'sql')
    if (!sql.trim()) throw new ApiError(400, '缺少 sql')
    statements = splitOr400(sql)
    guardStatements(info, statements) // 校验 2/3：只读白名单、DML 缺 WHERE（失败不落库）
    estimated = await _estimate(info, statements, database)
  }

  let title = common.textField(payload, 'title', '', 'title').trim().slice(0, 200)
  if (!title) title = _defaultTitle(statements)

  const ticket = {
    id: _newId(),
    status: 'pending',
    kind: isExport ? 'export' : 'write',
    connectionId: info.id || '',
    connectionName: info.name || '',
    database,
    sql,
    title,
    background,
    submittedBy: actor === 'agent' ? 'agent' : 'user',
    createdAt: common.now(),
    estimated,
    approvedAt: null,
    approvedBy: null,
    approvalComment: '',
    executedAt: null,
    actual: null,
    error: null,
  }
  if (rowsArchive !== null) ticket.rowsPayload = rowsArchive
  db.insertTicket(ticket) // 单事务 INSERT + 淘汰到 500 条
  _audit(headers, 'ticket.create', {
    ticketId: ticket.id, connectionId: ticket.connectionId,
    title: ticket.title, risk: estimated.risk, sql: sql.slice(0, 2000),
  })
  return { ticket: _publicTicket(ticket) }
}

// ---------------------------------------------------------------- 列表 / 详情

export function handleList(query, _body = null, _headers = null) {
  const params = query || {}
  const statusFilter = common.textField(params, 'status', '', 'status').trim()
  const keyword = common.textField(params, 'keyword', '', 'keyword').trim().toLowerCase()
  const limit = common.intField(params, 'limit', 50, 1, MAX_TICKETS, 'limit')
  const offset = common.intField(params, 'offset', 0, 0, MAX_TICKETS, 'offset')

  // 计数在过滤前（全量 GROUP BY status）
  const counts = _counts()
  let tickets
  let total
  if (keyword) {
    // keyword 匹配多字段（含工单号 id）：先全量取出再过滤（≤500 行），内存分页
    tickets = db.ticketRows({ status: statusFilter || null })
      .filter((ticket) => _matchesKeyword(ticket, keyword))
    total = tickets.length
    tickets = tickets.slice(offset, offset + limit)
  } else {
    // WHERE status / ORDER BY seq DESC / LIMIT+OFFSET 全部下推 SQL
    total = db.ticketCount(statusFilter || null)
    tickets = db.ticketRows({ status: statusFilter || null, limit, offset })
  }
  tickets = tickets.map((ticket) => _publicTicket(_normalizeTicket(ticket)))
  return { tickets, counts, total, limit, offset }
}

export function handleDetail(query, _body = null, _headers = null) {
  const ticketId = common.textField(query || {}, 'id', '', 'id').trim()
  if (!ticketId) throw new ApiError(400, '缺少 id')
  let ticket = db.ticketById(ticketId)
  if (ticket === null) {
    throw new ApiError(404, `工单不存在: ${ticketId}`, 'TICKET_NOT_FOUND')
  }
  ticket = _normalizeTicket(ticket)
  if (ticket.status === 'undone') {
    // 撤销时间在 undo_log（第 43 轮状态机）：详情按工单号反查最新条目补时间
    const entry = db.undoReferenceAny({ ticketId })
    if (entry) ticket.undoneAt = entry.undoneAt || ''
  }
  return { ticket: _publicTicket(ticket) }
}

// ---------------------------------------------------------------- 审批 / 取消

/** CAS 更新；rowcount=0 时重读一行区分 404 / 409。 */
function _casOr404Or409(ticketId, updates) {
  if (db.casUpdateTicket(ticketId, 'pending', updates)) {
    return db.ticketById(ticketId)
  }
  const ticket = db.ticketById(ticketId)
  if (ticket === null) {
    throw new ApiError(404, `工单不存在: ${ticketId}`, 'TICKET_NOT_FOUND')
  }
  throw new ApiError(409,
    `工单当前状态为 ${ticket.status}，只有 pending 可以操作`,
    'TICKET_STATE')
}

export async function handleApprove(_query, body = null, headers = null) {
  const payload = common.bodyOf(body)
  const ticketId = common.textField(payload, 'id', '', 'id').trim()
  if (!ticketId) throw new ApiError(400, '缺少 id')
  if (!('approve' in payload)) throw new ApiError(400, '缺少 approve')
  const approve = common.boolField(payload, 'approve', false)
  const comment = common.textField(payload, 'comment', '', 'comment').trim().slice(0, 1000)
  const actor = common.actorOf(headers)

  const ticket = db.ticketById(ticketId)
  if (ticket === null) {
    throw new ApiError(404, `工单不存在: ${ticketId}`, 'TICKET_NOT_FOUND')
  }
  if (ticket.status !== 'pending') {
    throw new ApiError(409,
      `工单当前状态为 ${ticket.status}，只有 pending 可以审批`,
      'TICKET_STATE')
  }
  const stamp = { approvedAt: common.now(), approvedBy: actor, approvalComment: comment }
  // CAS：UPDATE ... WHERE id=? AND status='pending'（并发双审批只成功一次）
  if (!approve) {
    const settled = _casOr404Or409(ticketId, { ...stamp, status: 'rejected' })
    _audit(headers, 'ticket.reject', {
      ticketId, connectionId: ticket.connectionId || '', comment,
    })
    return { ticket: _publicTicket(settled) }
  }

  if (ticket.kind !== 'export') {
    // 闸 1.5：会话写窗口——批准执行也是写；导出工单是只读动作，不受写窗口约束
    ensureOpen()
  }
  _casOr404Or409(ticketId, { ...stamp, status: 'executing' })
  _audit(headers, 'ticket.approve', {
    ticketId, connectionId: ticket.connectionId || '', comment,
  })
  return { ticket: await _executeTicket(ticket, actor) }
}

/** 同步执行已批准工单：复用 /api/execute 的守卫 + 单事务 + 失败回滚。
 * 执行失败不抛 HTTP 错误（工单状态置 failed + error 字段），只有审批本身才 4xx。 */
async function _executeTicket(ticket, actor) {
  if (ticket.kind === 'export') {
    return _executeExportTicket(ticket, actor)
  }
  const started = common.startClock()
  let info = { id: ticket.connectionId || '', name: ticket.connectionName || '' }
  let statements = []
  let results = []
  let error = null
  let affectedRows = null
  let rowCount = 0
  let truncated = false
  let elapsed = 0
  let undo = null
  try {
    info = requireConnection(ticket.connectionId || '')
    common.requireMysql(info)
    // 结构化工单（V2.3）：执行走存档的参数化语句（不走 splitSql/render 文本）
    const storedRows = ticket.rowsPayload
    if (storedRows && typeof storedRows === 'object' && storedRows.statements instanceof Array) {
      statements = storedRows.statements
        .filter((statement) => statement && typeof statement === 'object' && statement.sql)
        .map((statement) => ({ sql: statement.sql, params: statement.params ?? null }))
    } else {
      // 先拆分：即使连接后来没了/被改成只读，历史里的 statementCount 也应反映工单内容
      statements = splitSql(ticket.sql || '')
    }
    if (!statements.length) throw new ApiError(400, '工单 SQL 为空')
    guardStatements(info, statements) // 审批时再校验：连接可能已被改/被删
    const outcome = await executeInTransaction(
      info, ticket.database || '', statements, _maxRowsOfConnection(info),
      { undoMeta: { ticketId: ticket.id || '' } })
    results = outcome.results
    error = outcome.error
    elapsed = outcome.elapsedMs
    affectedRows = outcome.affectedRows
    rowCount = outcome.rowCount
    truncated = outcome.truncated
    undo = outcome.undo
  } catch (exc) {
    if (exc instanceof ApiError) {
      error = exc.message
    } else {
      error = `执行失败: ${exc}` // 兜底：工单执行失败也要落到 failed，不能给审批人 500
    }
    elapsed = common.ms(started)
  }

  const status = error === null ? 'succeeded' : 'failed'
  const actual = { affectedRows, elapsedMs: elapsed, results }
  if (undo !== null && undo !== undefined) {
    actual.undo = undo // 撤销可用性摘要，面板据此预判撤销按钮
  }
  const executedAt = common.now()
  const updates = { status, executedAt, actual, error }
  let updated
  if (db.casUpdateTicket(ticket.id, 'executing', updates)) {
    updated = db.ticketById(ticket.id) || { ...ticket, ...updates }
  } else { // 没有删除工单的接口，理论上不会发生
    updated = { ...ticket, ...updates }
  }

  // 工单执行也记一条执行历史（独立事务，与工单状态更新不互相回滚）
  const historyId = await historyRecord(
    info, ticket.sql || '', error === null, elapsed, error, {
      database: ticket.database || '',
      source: 'ticket',
      kind: 'execute',
      statementCount: statements.length,
      rowCount,
      affectedRows,
      truncated,
      undo,
      ticketId: ticket.id || '',
      ticketBy: ticket.submittedBy || '',
    })
  if (undo && undo.undoId) {
    db.casUpdateUndo(undo.undoId, 'active', { historyId })
  }
  common.audit(actor, 'ticket.execute', {
    ticketId: ticket.id || '',
    connectionId: ticket.connectionId || '',
    status,
    elapsedMs: elapsed,
    error: error || '',
  })
  return _publicTicket(updated)
}

// ---------------------------------------------------------------- 导出工单（第 45 轮）

/** 按导出条件计数：原 SELECT 包裹成派生表 COUNT（GROUP BY/UNION/DISTINCT 都包得住）。
 * 返回 int；任何失败返回 null（调用方降级放行）。只取 1 行 1 值，内存安全。 */
async function _countExportRows(info, database, statementSql) {
  const countSql = `SELECT COUNT(*) AS n FROM (${statementSql.replace(/[;\s]+$/, '')}) _cnt`
  let conn = null
  let discard = false
  try {
    conn = await pool.borrow(info.id || '__draft__', info, database)
    const { results, error: runError } = await runStatements(
      conn, [{ sql: countSql }], 1, { masking: null })
    if (runError !== null) return null
    const rows = (results.length ? results[0].rows : null) || []
    if (!rows.length) return null
    return Math.trunc(Number.parseInt(rows[0][0], 10))
  } catch {
    return null
  } finally {
    if (conn !== null) pool.giveBack(info.id || '__draft__', conn, discard)
  }
}

/** 导出工单预估：计数成功 → 精确行数（rowsExact）；失败 → 走通用降级。 */
function _exportEstimate(statements, counted) {
  if (counted === null) {
    return _degradedEstimate(statements, '导出行数预估失败，批准执行时若超上限会被拒绝')
  }
  const estimate = _degradedEstimate(statements, '')
  estimate.affectedRows = counted
  estimate.rowsExact = true
  estimate.unknownStatements = 0
  estimate.risk = 'low'
  estimate.notes = []
  for (const item of estimate.statements) {
    item.estimatedRows = counted
    item.exact = true
  }
  return estimate
}

/** 导出数据流式落盘（第 46 轮分批导出）：JSON {"columns":[...],"rows":[[...]...]}，
 * 按 exportBatchSize 行/批增量写 tmp，finish 时 rename 原子收尾；abort 清 tmp。
 * 行值经 _exportCell 兜底转 hex。 */
class _ExportFileWriter {
  constructor(ticketId, columns) {
    const directory = config.exportDir()
    mkdirSync(directory, { recursive: true })
    this.path = join(directory, `export_${ticketId}.json`)
    this._tmp = this.path + '.tmp'
    this._firstRow = true
    this._handle = createWriteStream(this._tmp, { encoding: 'utf8' })
    this._handle.write('{"columns":' + JSON.stringify([...columns]) + ',"rows":[')
  }

  writeBatch(rows) {
    for (const row of rows) {
      if (this._firstRow) this._firstRow = false
      else this._handle.write(',')
      this._handle.write(JSON.stringify(row.map((value) => _exportCell(value))))
    }
  }

  finish() {
    this._handle.write(']}')
    return new Promise((resolve) => {
      this._handle.end(() => {
        renameSync(this._tmp, this.path)
        _pruneExports()
        resolve(this.path)
      })
    })
  }

  abort() {
    try { this._handle.end() } catch { /* 尽力而为 */ }
    try { if (existsSync(this._tmp)) unlinkSync(this._tmp) } catch { /* 尽力而为 */ }
  }
}

function _exportCell(value) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return Buffer.from(value).toString('hex')
  }
  return value
}

/** 导出工单执行：SELECT 分批流式取数 → 逐批落 <dataDir>/exports/。
 * 只读路径，不走 executeInTransaction（无快照/回滚语义）；EXPLAIN 体检只记录不拦截；
 * 脱敏管线与 runStatements 同序（JSON 化之前按批掩码，§3.7）。行数上限 exportMaxRows；
 * 恰好等于上限允许，取满上限后仍能再取到一行 = 超限 → 不落文件、工单 failed，连接丢弃。 */
async function _executeExportTicket(ticket, actor) {
  const started = common.startClock()
  let info = { id: ticket.connectionId || '', name: ticket.connectionName || '' }
  let statements = []
  let plans = null
  let columnsMeta = []
  let totalRows = 0
  let batchCount = 0
  let truncated = false
  let exportFile = ''
  let error = null
  let resultError = null // 取数本身抛的错，进 actual.results[0].error
  let conn = null
  let discard = false
  try {
    info = requireConnection(ticket.connectionId || '')
    common.requireMysql(info)
    statements = splitSql(ticket.sql || '')
    if (!statements.length) throw new ApiError(400, '工单 SQL 为空')
    guardStatements(info, statements) // 审批时再校验：连接可能已被改/被删
    conn = await pool.borrow(ticket.connectionId, info, ticket.database || '')
    plans = await explainStatements(conn, statements) // 只记录，不拦截
    const limit = config.exportMaxRows()
    const batchSize = Math.max(Math.trunc(config.exportBatchSize()), 1)
    const cap = limit > 0 ? limit : 1_000_000_000 // <=0 视为不限
    const statementSql = statements[0].sql
    const masking = info.masking
    let maskCols = [] // fields 到达时构建（脱敏按 orgName 匹配）
    let writer = null
    let fetchError = null
    await conn.fetchEach(statementSql, null, (row) => {
      if (error !== null || fetchError !== null) return
      if (totalRows >= cap) {
        // 恰好等于上限后再取到一行 = 超限（第 45 轮口径）
        truncated = true
        discard = true
        error = `导出结果超过导出上限 ${limit} 行，不允许导出——`
          + '请收窄查询范围（加过滤条件/分页）后重新发起'
        return
      }
      if (writer === null) {
        writer = new _ExportFileWriter(ticket.id || '', columnsMeta.map((c) => c.name))
      }
      let rows = [row]
      if (masking && masking.enabled && maskCols.length) {
        rows = applyMasking(masking, maskCols, rows, statementSql)
      }
      writer.writeBatch([rows.map((value) => toJsonable(value))])
      totalRows += 1
      batchCount = Math.ceil(totalRows / batchSize)
    }, (fields) => {
      // fields 事件（首行前）：建列元数据（columnMeta 吃 mysql2 字段包数组）
      columnsMeta = columnMeta(fields || [])
      if (masking && masking.enabled) maskCols = maskColumns(fields)
    }).catch((exc) => {
      // fetchEach reject = 取数失败（连接级/超时/SQL 错）；流错误不抛出循环外
      fetchError = exc
      if (error === null) {
        discard = true
        resultError = error = `导出取数失败: ${exc}`
      }
    })
    if (writer !== null) {
      if (error === null && fetchError === null) exportFile = await writer.finish()
      else writer.abort()
    }
  } catch (exc) {
    if (exc instanceof ApiError) error = exc.message
    else error = `导出失败: ${exc}` // 兜底：导出失败也落到 failed，不给审批人 500
  } finally {
    var elapsed = common.ms(started)
    // discard（未读数据/连接异常）时连接按 broken 归还由池丢弃
    if (conn !== null) pool.giveBack(ticket.connectionId, conn, discard)
  }

  const status = error === null ? 'succeeded' : 'failed'
  // 行不进 actual（大结果集会把 JSON 撑爆），只留列名/计数
  const publicResult = {
    sql: statements.length ? statements[0].sql : '',
    kind: 'rows',
    columns: columnsMeta,
    rows: [],
    rowCount: totalRows,
    truncated,
    affectedRows: null,
    elapsedMs: elapsed,
    error: resultError,
  }
  const actual = {
    affectedRows: error === null ? totalRows : null,
    elapsedMs: elapsed,
    results: [publicResult],
    exportRows: error === null ? totalRows : 0,
    exportBatches: batchCount,
  }
  if (exportFile) actual.exportFile = exportFile // 服务器本地路径；出站由 _publicTicket 剥离
  const executedAt = common.now()
  const updates = { status, executedAt, actual, error }
  let updated
  if (db.casUpdateTicket(ticket.id, 'executing', updates)) {
    updated = db.ticketById(ticket.id) || { ...ticket, ...updates }
  } else {
    updated = { ...ticket, ...updates }
  }

  await historyRecord(info, ticket.sql || '', error === null, elapsed, error, {
    database: ticket.database || '',
    source: 'ticket',
    kind: 'export',
    statementCount: statements.length,
    rowCount: totalRows,
    affectedRows: error === null ? totalRows : null,
    truncated,
    explain: plans,
    ticketId: ticket.id || '',
    ticketBy: ticket.submittedBy || '',
  })
  common.audit(actor, 'ticket.execute', {
    ticketId: ticket.id || '',
    connectionId: ticket.connectionId || '',
    status,
    elapsedMs: elapsed,
    error: error || '',
    exportRows: totalRows,
  })
  return _publicTicket(updated)
}

/** 导出文件保留 exportKeep 份（按 mtime 淘汰最旧）；只动 export_*.json。 */
function _pruneExports() {
  const keep = Math.max(Math.trunc(config.exportKeep()), 1)
  const directory = config.exportDir()
  let files
  try {
    files = readdirSync(directory)
      .filter((name) => name.startsWith('export_') && name.endsWith('.json'))
      .map((name) => join(directory, name))
  } catch {
    return
  }
  files.sort((a, b) => {
    const ma = existsSync(a) ? statSync(a).mtimeMs : 0
    const mb = existsSync(b) ? statSync(b).mtimeMs : 0
    return mb - ma
  })
  for (const path of files.slice(keep)) {
    try { unlinkSync(path) } catch { /* 尽力而为 */ }
  }
}

/** 出站剥离：exportFile 是服务器本地路径，绝不出站（同 undoFile 先例）。 */
function _publicTicket(ticket) {
  const actual = ticket.actual
  if (actual && typeof actual === 'object' && actual.exportFile) {
    const cleaned = {}
    for (const [key, value] of Object.entries(actual)) {
      if (key !== 'exportFile') cleaned[key] = value
    }
    return { ...ticket, actual: cleaned }
  }
  return ticket
}

/** 下载用：读回导出数据（columns + rows，JSON）。只认本程序落盘路径
 * （目录校验 + tk_ 前缀），缺失 → 404。 */
export async function readExportData(ticketIdRaw) {
  const ticketId = (ticketIdRaw || '').trim()
  if (!ticketId.startsWith('tk_') || /[\\/..]/.test(ticketId.replace(/^tk_/, ''))) {
    throw new ApiError(400, '非法工单号', 'TICKET_EXPORT_BAD_ID')
  }
  const ticket = db.ticketById(ticketId)
  if (ticket === null) {
    throw new ApiError(404, `工单不存在: ${ticketId}`, 'TICKET_NOT_FOUND')
  }
  const actual = ticket.actual || {}
  const path = actual.exportFile || ''
  if (!path || join(path, '..') !== config.exportDir() || !existsSync(path)) {
    throw new ApiError(404, '导出文件不存在（可能已被清理），请重新发起导出', 'EXPORT_GONE')
  }
  let payload
  try {
    payload = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new ApiError(404, '导出文件损坏，请重新发起导出', 'EXPORT_GONE')
  }
  if (!payload || typeof payload !== 'object' || !('rows' in payload)) {
    throw new ApiError(404, '导出文件损坏，请重新发起导出', 'EXPORT_GONE')
  }
  payload.filenameBase = ticketId
  return payload
}

export async function handleCancel(_query, body = null, headers = null) {
  const payload = common.bodyOf(body)
  const ticketId = common.textField(payload, 'id', '', 'id').trim()
  if (!ticketId) throw new ApiError(400, '缺少 id')
  const ticket = db.ticketById(ticketId)
  if (ticket === null) {
    throw new ApiError(404, `工单不存在: ${ticketId}`, 'TICKET_NOT_FOUND')
  }
  if (ticket.status !== 'pending') {
    throw new ApiError(409,
      `工单当前状态为 ${ticket.status}，只有 pending 可以取消`,
      'TICKET_STATE')
  }
  const settled = _casOr404Or409(ticketId, { status: 'cancelled' })
  _audit(headers, 'ticket.cancel', {
    ticketId, connectionId: settled.connectionId || '',
  })
  return { ticket: _publicTicket(settled) }
}
