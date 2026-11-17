/**
 * POST /api/execute —— 写入直执行路径（v1 的 db_execute direct 模式走这里）。
 * server/api/execute.py 的移植。
 *
 * 守卫顺序严格照契约 3.3，不可变：
 *   1. 连接不存在            → 404 CONNECTION_NOT_FOUND
 *   2. readonly 连接 + 非白名单 → 403 READONLY
 *   3. UPDATE/DELETE 缺顶层 WHERE → 403 NO_WHERE
 *   4. 以上都过 → 单事务执行，失败整体回滚
 *
 * 「失败整体回滚」包括：任一语句报错、结果集超上限导致后续语句没执行。
 * 工单审批执行（api/tickets.js）复用这里的 guardStatements / executeInTransaction，
 * 保证「直执行」与「审批后执行」走完全相同的守卫与事务逻辑。
 */

import * as common from './common.js'
import { historyRecord } from './history.js'
import { databaseOf, maxRowsOf, runStatements, splitOr400 } from './query.js'
import { ensureOpen } from './writes-window.js'
import { pool } from '../core/pool.js'
import * as snapshot from '../core/snapshot.js'
import { ApiError, PermissionError } from '../core/errors.js'
import { checkReadonly, checkWhereForDml } from '../core/guard.js'
import * as db from '../store/db.js'

/** 契约的三道闸中第 2、3 道（第 1 道由调用方先查连接是否存在）。 */
export function guardStatements(info, statements) {
  if (Boolean(info.readonly)) {
    for (const stmt of statements) {
      try {
        checkReadonly(stmt.sql)
      } catch (error) {
        if (error instanceof PermissionError) throw new ApiError(403, error.message, 'READONLY')
        throw error
      }
    }
  } else {
    for (const stmt of statements) {
      try {
        checkWhereForDml(stmt.sql)
      } catch (error) {
        if (error instanceof PermissionError) throw new ApiError(403, error.message, 'NO_WHERE')
        throw error
      }
    }
  }
}

/** 单事务执行**已过守卫**的语句，返回统一统计。
 *
 * - 执行期 SQL 错误不抛异常：写进返回值 error（与 /api/query 的 200 + results 语义一致）；
 * - 借连接/开事务/提交事务失败抛 ApiError(400)（整个请求失败）；
 * - 失败（含截断）整体回滚；
 * - snapshot（默认 true）：变更前快照——逐条语句「UPDATE/DELETE 先同事务抓旧行 →
 *   执行 → INSERT 按主键回查新行」交错进行，全部成功后落 <dataDir>/undo/ + undo_log；
 *   抓行/落盘失败整体回滚（fail-closed）。语义性不可撤销不阻断，标记进 undo.summary。
 */
export async function executeInTransaction(info, database, statements, maxRows,
  { snapshotEnabled = true, undoMeta = null } = {}) {
  const connectionId = info.id || '__draft__'
  const started = common.startClock()
  let conn
  try {
    conn = await pool.borrow(connectionId, info, database)
  } catch (error) {
    throw new ApiError(400, `连接失败: ${error}`)
  }

  let discard = true
  let error = null
  const results = []
  let snap = null
  try {
    const rollbackQuietly = async () => {
      try { await conn.rollback() } catch { /* 已回滚/连接已死 */ }
    }
    try {
      await conn.beginTransaction() // 闸 4：单事务
    } catch (exc) {
      throw new ApiError(400, `开启事务失败: ${exc}`)
    }
    if (snapshotEnabled && snapshot.enabled()) {
      snap = snapshot.begin(info, database, statements) // 纯分析，绝不抛异常
    }
    let discardAfter = false
    for (const [index, stmt] of statements.entries()) {
      if (snap !== null && snap.snapshotable) {
        try {
          await snapshot.stageSegment(conn, snap, index, database, stmt.params ?? null)
        } catch (exc) {
          await rollbackQuietly()
          discard = true
          throw new ApiError(400, `变更前快照失败，事务已回滚: ${exc}`)
        }
      }
      const { results: part, error: partError, discard: partDiscard } = await runStatements(
        conn, [stmt], maxRows, { truncationIsError: true, masking: info.masking })
      results.push(...part)
      error = partError
      discardAfter = discardAfter || partDiscard
      if (error !== null) break
      if (snap !== null && snap.snapshotable) {
        try {
          await snapshot.stageSegmentAfter(conn, snap, index, part.length ? part[part.length - 1] : null, stmt)
        } catch (exc) {
          await rollbackQuietly()
          snapshot.discard(snap)
          discard = true
          throw new ApiError(400, `变更前快照失败，事务已回滚: ${exc}`)
        }
      }
    }
    discard = discard || discardAfter
    if (error === null) {
      if (snap !== null) snapshot.finalize(snap) // 零匹配降级 + 顶层形状同步
      if (snap !== null && snap.snapshotable) {
        try {
          snapshot.persist(snap, info, database, undoMeta)
        } catch (exc) {
          await rollbackQuietly()
          snapshot.discard(snap)
          discard = true
          throw new ApiError(400, `变更快照落盘失败，事务已回滚: ${exc}`)
        }
      }
      try {
        await conn.commit()
      } catch (exc) {
        discard = true
        if (snap !== null) snapshot.discard(snap) // 清掉 prepared 快照，不留悬挂退路
        throw new ApiError(400, `提交事务失败: ${exc}`)
      }
      discard = false
      if (snap !== null) snapshot.activate(snap)
    } else {
      if (snap !== null) snapshot.discard(snap) // 尚未落盘/已落盘都清掉
      try {
        await conn.rollback() // 失败整体回滚
      } catch {
        discard = true
      }
    }
  } finally {
    pool.giveBack(connectionId, conn, discard)
  }

  const elapsed = common.ms(started)
  const affectedValues = results
    .map((result) => result.affectedRows)
    .filter((value) => value !== null && value !== undefined)
  return {
    results,
    error,
    elapsedMs: elapsed,
    affectedRows: affectedValues.length ? affectedValues.reduce((a, b) => a + b, 0) : null,
    rowCount: results.reduce((sum, result) => sum + Math.trunc(result.rowCount || 0), 0),
    truncated: results.some((result) => Boolean(result.truncated)),
    undo: snap !== null ? snapshot.summary(snap) : null,
  }
}

function _sourceOf(headers) {
  return common.actorOf(headers) === 'agent' ? 'agent' : 'panel'
}

export async function handleExecute(_query, body = null, headers = null) {
  const payload = common.bodyOf(body)
  const info = common.getConnection(payload) // 闸 1：连接不存在 → 404
  common.requireMysql(info)
  const sql = common.textField(payload, 'sql', '', 'sql')
  if (!sql.trim()) throw new ApiError(400, '缺少 sql')
  const database = databaseOf(payload, info)
  const maxRows = maxRowsOf(payload, info)
  ensureOpen() // 闸 1.5：会话写窗口（V2.4，403 WRITES_CLOSED）
  const statements = splitOr400(sql)
  guardStatements(info, statements) // 闸 2、3
  const reason = common.textField(payload, 'reason', '', 'reason')
  const actor = common.actorOf(headers)

  const result = await executeInTransaction(info, database, statements, maxRows)
  const error = result.error
  const elapsed = result.elapsedMs
  const status = error === null ? 'ok' : 'error'
  const historyId = await historyRecord(info, sql, error === null, elapsed, error, {
    database,
    source: _sourceOf(headers),
    kind: 'execute',
    statementCount: statements.length,
    rowCount: result.rowCount,
    affectedRows: result.affectedRows,
    truncated: result.truncated,
    undo: result.undo,
  })
  const undo = result.undo
  if (undo && undo.undoId) {
    db.casUpdateUndo(undo.undoId, 'active', { historyId })
  }
  common.audit(actor, 'sql.execute', {
    connection: info.name || '',
    connectionId: info.id || '',
    status,
    elapsedMs: elapsed,
    reason,
    sql: sql.slice(0, 2000),
  })
  return { elapsedMs: elapsed, results: result.results, undo }
}
