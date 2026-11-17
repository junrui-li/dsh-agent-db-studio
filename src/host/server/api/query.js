/**
 * POST /api/query —— 只读查询路径（工具 db_query 走这里）。
 * server/api/query.py 的移植。
 *
 * 关键设计：
 * - **只读白名单对任何连接都生效**：db_query 不经过 Host 审批，后端是写入的
 *   唯一防线，所以不能按连接的 readonly 开关放行写语句（契约 4.2 的守卫语义）。
 * - 多语句按顺序执行，出错即停，已成功的结果照常返回（失败语句的结果带 error）。
 * - 流式语义：Python 用 SSCursor fetchmany(max_rows+1) 取到上限即停、剩余随连接
 *   丢弃；JS 侧单次 conn.query 缓冲取回后本地按 maxRows 截断（行为等价：超限即
 *   truncated + 连接丢弃），真流式（DbsConn.fetchMany）留给导出路径。
 *   连接上有未读数据（截断）时必须丢弃不还池（否则下一条语句会 "Commands out of sync"）。
 *
 * 与 Python 版的差异：
 * - runStatements 返回对象 {results, error, discard}（Python 是三元组）；
 * - 「连接类错误」（discard=true）的判据：err.fatal（mysql2 连接级）或
 *   err.dbsConnDead（超时 destroy）；语法错/SQL 错不伤连接（discard=false）；
 * - exec 语句走 conn.query（非预处理），OkPacket.affectedRows 取受影响行数，
 *   OkPacket.insertId 对应 Python 的 lastrowid。
 */

import { pool } from '../core/pool.js'
import * as config from '../core/config.js'
import { ApiError, PermissionError } from '../core/errors.js'
import { checkReadonly } from '../core/guard.js'
import { columnMeta, toJsonable } from '../core/jsonconv.js'
import { splitSql } from '../core/sqlsplit.js'
import * as common from './common.js'
import { historyRecord } from './history.js'
import { explainStatements, checkSlowSql } from '../core/plan-guard.js'

// 结果超过上限时，/api/query 认为「截断但成功」；/api/execute 认为事务失败需回滚
const _TRUNCATION_NOTE = '第 {index} 条语句结果超过 {max_rows} 行，已截断，后续语句未执行'

function _truncationNote(index, maxRows) {
  return _TRUNCATION_NOTE
    .replace('{index}', String(index))
    .replace('{max_rows}', String(maxRows))
}

function _statementLabel(stmt) {
  return `第 ${stmt.index} 条语句（原文第 ${stmt.start_line} 行）执行失败: `
}

function _errorResult(stmt, message, elapsedMs = 0) {
  return {
    sql: stmt.sql ?? '',
    kind: 'exec',
    columns: [],
    rows: [],
    rowCount: 0,
    truncated: false,
    affectedRows: null,
    elapsedMs,
    error: message,
  }
}

/** 结果列 → [{name, orgName, orgTable, orgKnown}]（脱敏匹配用，不进出站响应）。
 *
 * mysql2 的字段包带 orgName：`select mobile as m` 的 orgName 仍是 mobile，
 * 按它匹配才能堵住 AS 别名绕过；表达式投影（concat(...)）没有源列，orgName 为空。
 * 取不到字段包时（假 cursor/其它驱动）orgKnown=false，退回按结果列名匹配。
 */
export function maskColumns(fields) {
  const rawFields = fields ?? null
  const orgKnown = rawFields !== null
  const columns = []
  for (const field of rawFields ?? []) {
    columns.push({
      name: String(field?.name ?? ''),
      orgName: String(field?.orgName ?? ''),
      orgTable: String(field?.orgTable ?? ''),
      orgKnown,
    })
  }
  return columns
}

/** 连接类错误（mysql2 err.fatal / 超时 dbsConnDead）→ 连接不可信，必须丢弃。 */
function _isConnError(error) {
  return Boolean(error && (error.fatal || error.dbsConnDead))
}

/** 在给定连接上顺序执行已拆分的语句。
 *
 * 返回 {results, error, discard}：
 * - results：逐条结果（失败的那条带 error 字段）
 * - error：失败原因；null 表示全部成功
 * - discard：连接是否不可信（被截断/连接类错误），调用方必须 destroy 而不是还池
 *
 * masking：connection.masking 配置。**结果是出站前的最后一道工序**：/api/query、
 * /api/execute、工单 actual.results 都走这里，开启脱敏时在这里统一掩码（契约 §3.7），
 * 任何调用方都拿不到未脱敏的行。JS 侧按需动态 import mask.js（未开启时零开销）。
 *
 * 流式语义（与 Python SSCursor 的对齐）：JS 单次 conn.query 缓冲取回（真连接上
 * mysql2 本就整包缓冲），本地按 maxRows 截断；截断即置 discard（缓冲里仍带着
 * 未展示的行，等价 SSCursor 的未读数据），并停止后续语句。
 */
export async function runStatements(conn, statements, maxRows,
  { truncationIsError = false, masking = null } = {}) {
  const results = []
  let error = null
  let discard = false
  for (const stmt of statements) {
    const sql = stmt.sql ?? ''
    // params = 参数化执行（撤销的反向语句走这条路，值绝不拼进 SQL）；普通语句为 null
    const params = stmt.params ?? null
    const label = _statementLabel(stmt)
    const started = common.startClock()
    let execResult = null
    try {
      // 单次执行（对应 Python cur.execute）：有结果集返回 [rows, fields]，
      // exec 返回 [OkPacket, undefined]——分支依据与 cur.description 同构。
      execResult = await conn.query(sql, params === null ? undefined : params)
    } catch (exc) {
      if (_isConnError(exc)) discard = true
      error = label + String(exc?.message ?? exc)
      results.push(_errorResult(stmt, error, common.ms(started)))
      break
    }
    const [pk, fields] = execResult ?? [null, null]
    if (fields !== undefined && fields !== null) { // 有结果集的语句
      const columns = columnMeta(fields)
      const maskColumnsMeta = maskColumns(fields)
      // 上限语义（SSCursor fetchmany(max_rows+1) 等价）：缓冲行本地按 maxRows 截断，
      // 超限 = truncated + 连接丢弃（DbsConn.fetchMany 是流式替身，导出路径用）。
      const rawRows = Array.isArray(pk) ? pk : []
      const truncated = rawRows.length > maxRows
      let selectedRows = rawRows.slice(0, maxRows)
      // 出站前脱敏：在 JSON 化之前做，保留类型信息给表达式 fail-safe 判数值聚合。
      // 未开启脱敏时完全跳过（零开销、行为不变）。
      if (masking && masking.enabled) {
        const maskModule = await import('../core/mask.js')
        // mask.js 导出名兼容：Python 是 `from core.mask import mask_rows as apply_masking`，
        // JS 侧 core/mask.js 的导出名是 maskRows（M2-A）；两个名字都认，缺失按
        // fail-safe 原样放行（列级 fail-safe 在 mask.js 内部，模块级缺失不打断查询）。
        const applyMasking = maskModule?.applyMasking ?? maskModule?.maskRows
        if (typeof applyMasking === 'function') {
          selectedRows = applyMasking(masking, maskColumnsMeta, selectedRows, sql)
        }
      }
      const rows = selectedRows.map((row) => row.map((value) => toJsonable(value)))
      const result = {
        sql,
        kind: 'rows',
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        affectedRows: null,
        elapsedMs: common.ms(started),
        error: null,
      }
      results.push(result)
      if (truncated) {
        discard = true // 流式还有未读数据，连接不能再复用
        if (truncationIsError) {
          result.error = _truncationNote(stmt.index, maxRows)
          error = result.error
        }
        break
      }
    } else { // 无结果集的语句：affectedRows 有意义
      const packet = Array.isArray(pk) ? pk[0] : pk
      const affected = packet === null || packet === undefined ? null : packet.affectedRows
      const result = {
        sql,
        kind: 'exec',
        columns: [],
        rows: [],
        rowCount: 0,
        truncated: false,
        affectedRows: affected !== null && affected !== undefined && Number(affected) >= 0
          ? Math.trunc(Number(affected)) : 0,
        elapsedMs: common.ms(started),
        error: null,
      }
      // lastrowid：INSERT 快照按自增主键回查新行用（非 INSERT 语句为 0/None，快照侧自行判断）
      const insertId = packet === null || packet === undefined ? null : packet.insertId
      if (insertId !== null && insertId !== undefined) {
        const n = Number(insertId)
        if (Number.isFinite(n)) result.lastrowid = Math.trunc(n)
      }
      results.push(result)
    }
  }
  return { results, error, discard }
}

// ---------------------------------------------------------------- 参数

export function databaseOf(body, info) {
  const database = common.textField(body, 'database', '', 'database').trim()
  return database || String(info.database ?? '')
}

export function maxRowsOf(body, info) {
  const raw = body.maxRows
  if (raw === null || raw === undefined || raw === '') {
    return Math.min(Math.trunc(Number(info.maxRows ?? 0)) || config.defaultMaxRows(),
      config.MAX_ROWS_CAP)
  }
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ApiError(400, `maxRows 必须是整数: ${JSON.stringify(raw)}`)
  }
  const value = parsed
  if (value < 1) throw new ApiError(400, `maxRows 必须大于 0: ${value}`)
  return Math.min(value, config.MAX_ROWS_CAP)
}

export function splitOr400(sql) {
  const statements = splitSql(sql)
  if (!statements.length) throw new ApiError(400, '没有可执行的 SQL')
  return statements
}

// ---------------------------------------------------------------- handler

export async function handleQuery(query, body = null, headers = null) {
  const payload = common.bodyOf(body)
  const info = common.getConnection(payload)
  common.requireMysql(info)
  const sql = common.textField(payload, 'sql', '', 'sql')
  if (!sql.trim()) throw new ApiError(400, '缺少 sql')
  const database = databaseOf(payload, info)
  const maxRows = maxRowsOf(payload, info)
  const statements = splitOr400(sql)

  // 只读守卫：任何连接都必须通过白名单（见模块 docstring）
  for (const stmt of statements) {
    try {
      checkReadonly(stmt.sql)
    } catch (exc) {
      if (exc instanceof PermissionError) {
        throw new ApiError(403, exc.message, 'READONLY')
      }
      throw exc
    }
  }

  const started = common.startClock()
  const cid = info.id || '__draft__'
  let conn
  try {
    conn = await pool.borrow(cid, info, database)
  } catch (exc) {
    throw new ApiError(400, `连接失败: ${exc}`)
  }

  let discard = true
  let plans = []
  let runResult = { results: [], error: null, discard: false }
  try {
    // EXPLAIN 计划捕获：agent 走门禁（拦截/放行都返回计划），面板单独体检；
    // 两边都把计划写进执行历史（契约 §3.5 执行详情展示）。
    if (common.actorOf(headers) === 'agent') {
      plans = await checkSlowSql(conn, statements, database)
    } else {
      plans = await explainStatements(conn, statements)
    }
    runResult = await runStatements(conn, statements, maxRows, { masking: info.masking })
    discard = runResult.discard
  } finally {
    pool.giveBack(cid, conn, discard)
  }

  const { results, error } = runResult
  const elapsed = common.ms(started)
  const statementCount = statements.length
  const rowCount = results.reduce((sum, item) => sum + Math.trunc(item.rowCount ?? 0), 0)
  const truncated = results.some((item) => Boolean(item.truncated))
  const purpose = common.textField(payload, 'purpose', '', 'purpose').trim()
  historyRecord(info, sql, error === null, elapsed, error, {
    database,
    source: common.actorOf(headers) === 'agent' ? 'agent' : 'panel',
    kind: 'query',
    statementCount,
    rowCount,
    affectedRows: null,
    truncated,
    explain: plans,
    purpose,
  })
  return { elapsedMs: elapsed, results }
}
