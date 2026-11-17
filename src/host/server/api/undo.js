/**
 * 撤销（V2.2）：读变更前快照 → 生成参数化反向语句 → 复用 /api/execute 的守卫 + 单事务执行。
 * server/api/undo.py 的移植。
 *
 * - 快照由 executeInTransaction 在每次写执行时自动落 <dataDir>/undo/ + undo_log；
 * - 撤销本身也是写：走同一守卫 + 单事务 + 快照，「撤销的撤销」（redo）天然成立；
 * - 反向语句值走参数化（runStatements 支持 stmt.params），绝不拼进 SQL 字符串；
 * - 出站预览只给 `?` 占位符 SQL（结构可见、值不可见），行数据绝不出站；
 * - 并发保护：撤销前 CAS active→undoing 原子占位，第二个撤销请求 409 UNDO_STATE；
 * - 状态机：prepared → active → undone（undoing 是撤销执行期间的瞬态）。
 */

import * as common from './common.js'
import { requireConnection } from './connections.js'
import { executeInTransaction, guardStatements } from './execute.js'
import { maxRowsOf } from './query.js'
import { ensureOpen } from './writes-window.js'
import { pool } from '../core/pool.js'
import * as snapshot from '../core/snapshot.js'
import { ApiError } from '../core/errors.js'
import { historyRecord } from './history.js'
import * as db from '../store/db.js'
import { existsSync } from 'node:fs'

/** undoFile 是服务器本地路径，绝不出站。 */
function _stripFile(item) {
  const out = {}
  for (const [key, value] of Object.entries(item)) {
    if (key !== 'undoFile') out[key] = value
  }
  return out
}

function _resolveEntry(query, bodyId = '') {
  const undoId = bodyId || common.textField(query || {}, 'id', '', 'id').trim()
  const ticketId = common.textField(query || {}, 'ticketId', '', 'ticketId').trim()
  const historyId = common.textField(query || {}, 'historyId', '', 'historyId').trim()
  let entry = null
  if (undoId) {
    entry = db.undoById(undoId)
  } else if (ticketId) {
    // 预览不限状态——条目已撤销时给准确 409（UNDO_STATE），而非 404「没有可撤销」
    entry = db.undoReferenceAny({ ticketId })
  } else if (historyId) {
    entry = db.undoReferenceAny({ historyId })
  } else {
    entry = db.latestActiveUndo()
  }
  if (entry === null) {
    throw new ApiError(404, '没有可撤销的变更', 'UNDO_NOT_FOUND')
  }
  return entry
}

/** 读快照文件；缺失/损坏 → 410（记账行还在但退路已没了，不能再撤销）。
 * 多段形状（v2）与 v1 扁平单段形状兼容读取。 */
function _loadSnap(entry) {
  const path = entry.undoFile || ''
  if (!path || !existsSync(path)) {
    throw new ApiError(410, '快照文件已清理（超过保留条数或被移动），无法撤销',
      'UNDO_SNAPSHOT_GONE')
  }
  let payload
  try {
    payload = snapshot.loadSnapshot(path)
  } catch (error) {
    throw new ApiError(410, `快照文件损坏，无法撤销: ${error}`, 'UNDO_SNAPSHOT_GONE')
  }
  const segments = snapshot.normalizeSegments(payload)
  const snap = {
    snapshotable: true,
    op: payload.op || entry.op || '',
    table: payload.table || '',
    sql: entry.sql || '',
    segments,
    capturedRows: segments.reduce((sum, seg) => sum + (seg.rows || []).length, 0),
  }
  const statements = snapshot.reverseStatements(snap)
  if (!statements.length) {
    throw new ApiError(410, '快照里没有可恢复的行，无法撤销', 'UNDO_SNAPSHOT_GONE')
  }
  return snap
}

/** 按表聚合并脱敏：出站只给 表名 + 计数，绝不带主键值（§3.7 值不出站）。 */
function _aggregateConflicts(conflicts) {
  const order = []
  const counts = {}
  for (const conflict of conflicts) {
    const table = conflict.tableDisplay
    if (!(table in counts)) {
      counts[table] = 0
      order.push(table)
    }
    counts[table] += 1
  }
  return order.map((table) => ({ table, count: counts[table] }))
}

/** 撤销预检借连接；借不到（连接删了/库不可达）返回 [null, null]，调用方降级。 */
async function _borrowForCheck(entry) {
  try {
    const info = requireConnection(entry.connectionId || '')
    common.requireMysql(info)
    const conn = await pool.borrow(info.id || '__draft__', info, entry.database || '')
    return [info, conn]
  } catch {
    return [null, null]
  }
}

/** 撤销成功后联动工单状态机（第 43 轮，终态语义：已撤销的工单不可再执行）。
 * CAS 失败（状态已被并发变更）静默忽略：undo_log 仍是唯一真相源。 */
function _syncTicketStatus(entry) {
  const ticketId = entry.ticketId || ''
  if (ticketId) {
    db.casUpdateTicket(ticketId, 'succeeded', { status: 'undone' })
    return
  }
  if (!entry.undoOf) return
  let root = entry
  const seen = new Set()
  while (root.undoOf && !seen.has(root.undoOf)) {
    seen.add(root.id || '')
    const parent = db.undoById(root.undoOf)
    if (parent === null) return
    root = parent
  }
  if (root.ticketId) {
    db.casUpdateTicket(root.ticketId, 'undone', { status: 'succeeded' })
  }
}

/** 撤销预览：条目信息 + 反向语句占位符（值不出站）+ 原主键占用预检（第 44 轮）。 */
export async function handlePreview(query, _body = null, _headers = null) {
  const entry = _resolveEntry(query || {})
  if (entry.status === 'undone') {
    throw new ApiError(409, '该变更已撤销；如需恢复（重做），请在撤销历史中对恢复快照执行撤销',
      'UNDO_STATE')
  }
  if (entry.status !== 'active' && entry.status !== 'undoing') {
    throw new ApiError(409, `快照当前状态为 ${entry.status}，只有 active 可以撤销`,
      'UNDO_STATE')
  }
  const snap = _loadSnap(entry)
  const statements = snapshot.reverseStatements(snap)
  // 原主键占用预检（只对 DELETE 类段；失败降级为 null）——执行时还有 409 / 主键冲突回滚兜底
  let conflicts = null
  const [info, conn] = await _borrowForCheck(entry)
  if (conn !== null) {
    try {
      conflicts = _aggregateConflicts(await snapshot.detectPkConflicts(conn, snap))
    } catch {
      conflicts = null
    } finally {
      pool.giveBack(info.id || '__draft__', conn, false)
    }
  }
  const item = _stripFile({ ...entry })
  item.reverse = snapshot.reversePreview(statements)
  item.reverseCount = statements.length
  item.capturedRows = snap.capturedRows
  item.pkConflicts = conflicts
  return { undo: item }
}

/** 执行撤销：CAS 占位 → 原主键占用预检 → 反向语句过守卫 → 单事务 + 快照 → 落 undone。
 * force：预检发现原主键被占用时，人工确认后冲突行反向 INSERT 改用自增 id；
 * 未确认则 409 UNDO_PK_CONFLICT。最终兜底 = 事务内主键冲突整体回滚（fail-closed）。 */
export async function handleUndo(query, body = null, headers = null) {
  const payload = common.bodyOf(body)
  const entry = _resolveEntry(query || {}, common.textField(payload, 'id', '', 'id').trim())
  if (entry.status !== 'active') {
    throw new ApiError(409, `快照当前状态为 ${entry.status}，只有 active 可以撤销`,
      'UNDO_STATE')
  }
  const force = common.boolField(payload, 'force', false)
  const undoId = entry.id || ''
  // 并发占位：active → undoing 只有一个请求能成功；失败/回滚时归还 active
  if (!db.casUpdateUndo(undoId, 'active', { status: 'undoing' })) {
    throw new ApiError(409, '快照已被其它请求撤销或状态已变化', 'UNDO_STATE')
  }

  let info = { id: '', name: '' }
  let outcome = null
  let statements = []
  try {
    const snap = _loadSnap(entry) // 快照缺失/损坏也在 try 里：归还 active
    info = requireConnection(entry.connectionId || '')
    common.requireMysql(info)
    ensureOpen() // 闸 1.5：会话写窗口（V2.4）——撤销也是写
    statements = snapshot.reverseStatements(snap)
    guardStatements(info, statements) // 撤销也过三道闸——先守卫再连库预检
    // 原主键占用预检：冲突 + 未确认 → 409；冲突 + force → 冲突行丢主键自增插入
    const conn = await pool.borrow(info.id || '__draft__', info, entry.database || '')
    let rawConflicts
    try {
      rawConflicts = await snapshot.detectPkConflicts(conn, snap)
    } finally {
      pool.giveBack(info.id || '__draft__', conn, false)
    }
    const unforceable = rawConflicts.filter((c) => !c.autoIncrementable)
    const tables = [...new Set(rawConflicts.map((c) => c.tableDisplay))].sort().join('、')
    if (unforceable.length) {
      throw new ApiError(409,
        `撤销被拦下：有 ${unforceable.length} 行的原主键已被新数据占用（${tables}），`
        + '且这些表的主键不是单列自增，无法自动改用新 id——需要人工处理（例如先清理占用行）。',
        'UNDO_PK_CONFLICT')
    }
    if (rawConflicts.length && !force) {
      throw new ApiError(409,
        `撤销被拦下：有 ${rawConflicts.length} 行的原主键已被新数据占用（${tables}）。`
        + '直接撤销会主键冲突；确认后可选择「仍要撤销（冲突行改用自增 id，主键会变化）」。',
        'UNDO_PK_CONFLICT')
    }
    if (rawConflicts.length) {
      const forceRows = {}
      for (const conflict of rawConflicts) {
        if (!(conflict.segment in forceRows)) forceRows[conflict.segment] = new Set()
        forceRows[conflict.segment].add(conflict.row)
      }
      statements = snapshot.reverseStatements(snap, forceRows)
      guardStatements(info, statements) // force 形状变化后重过守卫（INSERT 形状不变，兜底）
    }
    outcome = await executeInTransaction(
      info, entry.database || '', statements, maxRowsOf({}, info),
      { undoMeta: { undoOf: undoId } })
  } catch (error) {
    db.casUpdateUndo(undoId, 'undoing', { status: 'active' }) // 归还：还能再试
    if (error instanceof ApiError) throw error
    throw new ApiError(400, `撤销执行失败（已回滚，原变更仍在）: ${error}`, 'UNDO_EXECUTE_FAILED')
  }
  if (outcome.error) {
    db.casUpdateUndo(undoId, 'undoing', { status: 'active' })
    throw new ApiError(400, `撤销执行失败（已回滚，原变更仍在）: ${outcome.error}`,
      'UNDO_EXECUTE_FAILED')
  }

  const redoId = (outcome.undo || {}).undoId || ''
  if (!db.casUpdateUndo(undoId, 'undoing', {
    status: 'undone', undoneAt: common.now(), redoId,
  })) {
    // 占位被外部清掉（快照淘汰等）：撤销已生效，只差状态行，记审计照常返回
  }
  _syncTicketStatus(entry) // 工单状态机联动（succeeded→undone；redo 回写 succeeded）
  await historyRecord(info, entry.sql || '', true, outcome.elapsedMs, null, {
    database: entry.database || '',
    source: 'undo',
    kind: 'execute',
    statementCount: statements.length,
    rowCount: outcome.rowCount,
    affectedRows: outcome.affectedRows,
    truncated: outcome.truncated,
    undo: { available: Boolean(redoId), reason: redoId ? '' : '无 redo 快照', undoId: redoId },
  })
  const actor = common.actorOf(headers)
  common.audit(actor, 'undo.execute', {
    undoId,
    redoId,
    connectionId: entry.connectionId || '',
    table: entry.table || '',
    affectedRows: outcome.affectedRows,
    ticketId: entry.ticketId || '',
  })
  const updated = db.undoById(undoId) || entry
  return {
    undo: _stripFile(updated),
    results: outcome.results,
    elapsedMs: outcome.elapsedMs,
    affectedRows: outcome.affectedRows,
  }
}

export function handleList(query, _body = null, _headers = null) {
  const params = query || {}
  const limit = common.intField(params, 'limit', 20, 1, 100, 'limit')
  return { undoList: db.undoRows(limit).map((item) => _stripFile(item)) }
}
