/**
 * 变更前快照（V2.2 起；第 38 轮起支持多语句 DML）：写执行前把受影响行落 JSON 到
 * <dataDir>/undo/，供撤销（api/undo.js）。server/core/snapshot.py 的移植。
 *
 * 范围（不满足即标记「不可撤销」继续执行，诚实声明）：
 * - DML（UPDATE / DELETE / INSERT）多语句可用：每条语句一个 segment，执行时逐条
 *   「抓行 → 执行 → INSERT 回查」交错进行；撤销按 segment 倒序逐段回放反向语句；
 * - 任一条语句不可快照（DDL / 多表 / 多行 VALUES 的 INSERT / INSERT..SELECT /
 *   缺顶层 WHERE）→ 整体标记不可撤销（all-or-nothing，reason 带第几条）；
 * - UPDATE / DELETE：执行前在同一事务里按同条件 SELECT 旧行；表无主键不可撤销；
 * - INSERT：执行后按主键回查新行（lastrowid 路径 / 反向 INSERT 的 _pkValues 路径）；
 * - 累计受影响行数 > undoMaxRows() → 标记不可撤销，不阻断执行；
 * - 全部段都没有匹配行 → 标记「没有匹配行，无需撤销」。
 *
 * fail-closed：快照 SELECT / 回查 / 落盘 / 记账失败 → 整体回滚。
 * 快照文件含明文行数据，只落本地 <dataDir>/undo/（不入库、不出站）；
 * undo/preview 出站只给参数化占位符 SQL。
 *
 * 与 Python 版的差异：占位符从 pymysql 的 %s 换成 mysql2 的 ?（含 tail 的参数计数）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import * as config from './config.js'
import { _TABLE_PATTERNS, _normalizeIdent, countInsertTuples, multiTablePrefix, statementMeta, topLevelWhere }
  from './impact.js'
import { quoteIdent, _stripLeadingComments } from './guard.js'
import { resolveKeyColumns, tableColumns } from './sqlgen.js'
import { now } from '../api/common.js'
import * as storeDb from '../store/db.js'

// 可纳入撤销快照的语句类型（按 statement 首动词识别）
const _DML_KINDS = new Set(['UPDATE', 'DELETE', 'INSERT'])

export function newUndoId() {
  return 'undo_' + randomBytes(6).toString('hex')
}

/** 快照整体开关：DBS_UNDO_MAX_ROWS <= 0 时关闭（执行响应也不带 undo 段）。 */
export function enabled() {
  return config.undoMaxRows() > 0
}

/** bytes → {"__hex__": ...} 包装（JSON 无法直接存二进制；恢复时还原）。 */
function _jsonable(value) {
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return { __hex__: Buffer.from(value).toString('hex') }
  }
  return value
}

function _fromJsonable(value) {
  if (value && typeof value === 'object' && typeof value.__hex__ === 'string') {
    try {
      return Buffer.from(value.__hex__, 'hex')
    } catch {
      return value
    }
  }
  return value
}

// ---------------------------------------------------------------- 计划分析

/** 语句里的表原文（保反引号）补全库名限定：`db`.`t` / db.t → 原样；`t` → `db`.`t`。 */
function _qualifiedTable(database, tableRaw) {
  if (tableRaw.includes('.')) return tableRaw
  return database ? `\`${database}\`.${tableRaw}` : tableRaw
}

/** `(db.)t` 原文 → [db, t] 纯名（给 information_schema / sqlgen 用）。 */
function _normalizeTable(tableRaw) {
  const parts = _normalizeIdent(tableRaw).split('.')
  if (parts.length === 2) return [parts[0], parts[1]]
  return ['', parts[0]]
}

function _emptySnap() {
  return {
    snapshotable: false, reason: '', op: '', sql: '',
    table: '', tableDisplay: '', pkColumns: [], columns: [],
    rows: [], capturedRows: 0, tail: '', segments: [],
  }
}

/** 单语句可快照性分析（纯词法，不连库）；不可快照给 reason，绝不抛异常。 */
function _prepareOne(sql, database) {
  const seg = {
    snapshotable: false, reason: '', op: '', sql,
    table: '', tableDisplay: '', pkColumns: [], columns: [],
    rows: [], capturedRows: 0, tail: '',
  }
  const meta = statementMeta(sql)
  const kind = meta.kind
  if (!_DML_KINDS.has(kind)) {
    seg.reason = 'DDL / 其它语句不可撤销'
    return seg
  }
  seg.op = kind
  let tableRaw
  if (kind === 'INSERT') {
    if (countInsertTuples(sql) !== 1) {
      seg.reason = '多行 INSERT / INSERT..SELECT 暂不支持撤销'
      return seg
    }
    const match = _TABLE_PATTERNS.INSERT.exec(_stripLeadingComments(sql))
    if (!match) {
      seg.reason = '无法识别目标表'
      return seg
    }
    tableRaw = match[1]
  } else {
    const whereAt = topLevelWhere(sql)
    if (whereAt < 0) {
      seg.reason = '语句缺顶层 WHERE'
      return seg
    }
    if (multiTablePrefix(sql, whereAt, kind)) {
      seg.reason = '多表语句暂不支持撤销'
      return seg
    }
    const match = _TABLE_PATTERNS[kind].exec(_stripLeadingComments(sql))
    if (!match) {
      seg.reason = '无法识别目标表'
      return seg
    }
    tableRaw = match[1]
    let tail = sql.slice(whereAt).trim()
    while (tail.endsWith(';')) tail = tail.slice(0, -1).trim()
    seg.tail = tail
  }
  seg.table = _qualifiedTable(database, tableRaw)
  const [dbName, tableName] = _normalizeTable(tableRaw)
  seg.tableDisplay = [dbName || database, tableName].filter(Boolean).join('.')
  seg.snapshotable = true
  return seg
}

/** segment 状态同步到顶层：单语句沿用 v1 扁平形状（op/table/rows/...），多语句聚合。 */
function _syncTop(snap) {
  const segments = snap.segments || []
  if (segments.length === 1) {
    const seg = segments[0]
    for (const key of ['op', 'table', 'tableDisplay', 'pkColumns', 'columns', 'rows',
      'capturedRows', 'tail']) {
      snap[key] = key === 'tail' ? (seg[key] || '') : seg[key]
    }
    return
  }
  const displays = []
  for (const seg of segments) {
    const display = seg.tableDisplay || ''
    if (display && !displays.includes(display)) displays.push(display)
  }
  snap.op = 'MULTI'
  snap.table = segments.length ? (segments[0].table || '') : ''
  snap.tableDisplay = displays.slice(0, 3).join('、') + (displays.length > 3 ? '等' : '')
  snap.rows = []
  snap.capturedRows = segments.reduce((sum, seg) => sum + Math.trunc(seg.capturedRows || 0), 0)
}

/** 全量语句可快照性分析（纯词法，不连库）；不可快照给 reason，绝不抛异常。
 * 全部语句都是可快照的 DML 才整体 snapshotable，任一条不可快照 → 整体标记。 */
export function prepare(statements, database) {
  const segments = []
  let blocked = ''
  for (const [i, statement] of statements.entries()) {
    const seg = _prepareOne(statement.sql || '', database)
    seg.index = i + 1
    segments.push(seg)
    if (!seg.snapshotable && !blocked) {
      blocked = statements.length > 1
        ? `第 ${i + 1} 条语句：${seg.reason}`
        : seg.reason
    }
  }
  const snap = _emptySnap()
  snap.segments = segments
  snap.sql = segments.map((seg) => seg.sql).join('; ')
  if (blocked) {
    snap.reason = blocked
    return snap
  }
  snap.snapshotable = true
  _syncTop(snap)
  if (segments.length === 1) {
    snap.op = segments[0].op
    snap.table = segments[0].table
    snap.tableDisplay = segments[0].tableDisplay
    snap.tail = segments[0].tail || ''
    snap.sql = segments[0].sql
  }
  return snap
}

/** 抓行阶段的语义性降级：整体不可撤销（执行不受影响，继续跑完）。 */
function _markBlocked(snap, seg, message) {
  snap.snapshotable = false
  if ((snap.segments || []).length > 1) {
    snap.reason = `第 ${seg.index} 条语句：${message}`
  } else {
    snap.reason = message
  }
}

// ---------------------------------------------------------------- 抓行（事务内，逐段交错）

/** 执行前编排第一步：纯词法分析（不连库、不抛异常）。 */
export function begin(info, database, statements) {
  return prepare(statements, database)
}

/** 执行第 index 条语句**之前**：UPDATE/DELETE 段在同一事务抓旧行。
 * 基础设施失败抛异常（调用方回滚）；语义性降级只标记，绝不阻断执行。 */
export async function stageSegment(conn, snap, index, database, params = null) {
  if (!snap.snapshotable) return // 已整体降级：剩余语句照常执行，不再抓行
  const seg = snap.segments[index]
  if (seg.op !== 'UPDATE' && seg.op !== 'DELETE') return // INSERT 等执行后回查
  await _captureUpdateDelete(conn, seg, snap, database, params)
  _syncTop(snap)
}

/** 第 index 条语句执行成功**之后**：INSERT 段按主键回查新行。 */
export async function stageSegmentAfter(conn, snap, index, result, stmt = null) {
  if (!snap.snapshotable) return
  const seg = snap.segments[index]
  if (seg.op !== 'INSERT') return
  await _captureInsert(conn, seg, snap, result, stmt)
  _syncTop(snap)
}

/** 执行循环收尾：全部段零匹配 → 整体降级；顶层形状同步（persist/summary 前调用）。 */
export function finalize(snap) {
  if (!snap.snapshotable) return
  if (Math.trunc(snap.capturedRows || 0) <= 0) {
    snap.snapshotable = false
    snap.reason = '没有匹配行，无需撤销'
  }
  _syncTop(snap)
}

/** 同事务抓行（快照专用，不走 runStatements 的脱敏/截断语义）。
 * 返回 [names, rows]；rows 为数组形态（rowsAsArray）。 */
async function _fetchRows(conn, sql, params = null, limit = 0) {
  const [rows, fields] = await conn.query(sql, params ?? undefined)
  const names = (fields || []).map((f) => String(f.name || ''))
  const selected = limit ? rows.slice(0, limit + 1) : rows
  return [names, selected]
}

/** 执行前抓旧行：同条件 SELECT *；预算 = 全局上限 − 已抓行数，超预算 → 整体降级。
 * 语句 SQL 含 ? 占位（撤销反向语句 / db_write_rows 生成的参数化 DML）时，
 * 同条件 SELECT 必须带 WHERE 参数执行。UPDATE 的 params = SET 值 + WHERE 值
 * （WHERE 参数在尾部，取末 n 个）；DELETE 全是 WHERE 值。 */
async function _captureUpdateDelete(conn, seg, snap, database, params = null) {
  const limit = Math.max(Math.trunc(config.undoMaxRows()), 0)
  if (limit <= 0) {
    _markBlocked(snap, seg, '快照已关闭（DBS_UNDO_MAX_ROWS<=0）')
    return
  }
  const remaining = limit - Math.trunc(snap.capturedRows || 0)
  const [dbName, tableName] = _normalizeTable(seg.table)
  const pkColumns = await resolveKeyColumns(conn, dbName || database, tableName)
  if (!pkColumns.length) {
    _markBlocked(snap, seg, '表无主键/唯一键，无法恢复行')
    return
  }
  const tail = seg.tail || ''
  let whereParams = null
  if (params !== null && params !== undefined && tail.includes('?')) {
    const n = (tail.match(/\?/g) || []).length
    const list = [...params]
    whereParams = seg.op === 'UPDATE' ? list.slice(-n) : list
    if (whereParams.length !== n) {
      throw new Error('快照 SELECT 的 WHERE 参数与占位符数量不匹配')
    }
  }
  const [names, rows] = await _fetchRows(
    conn, `SELECT * FROM ${seg.table} ${tail}`.trim(), whereParams, remaining)
  if (rows.length > remaining) {
    _markBlocked(snap, seg, `影响超过快照上限 ${limit} 行（累计），执行后不可撤销`)
    return
  }
  seg.pkColumns = pkColumns
  seg.columns = names
  seg.rows = rows.map((row) => row.map((value) => _jsonable(value)))
  seg.capturedRows = rows.length
  snap.capturedRows = Math.trunc(snap.capturedRows || 0) + rows.length
}

/** 执行后回查新行进快照（redo 用），两条定位路径：反向 INSERT 的 _pkValues /
 * 普通 INSERT 的 lastrowid（仅单 VALUES + 单列自增主键）。 */
async function _captureInsert(conn, seg, snap, result, stmt = null) {
  const limit = Math.max(Math.trunc(config.undoMaxRows()), 0)
  if (limit <= 0) {
    _markBlocked(snap, seg, '快照已关闭（DBS_UNDO_MAX_ROWS<=0）')
    return
  }
  const pkColumns = seg.pkColumns || []
  const pkValues = stmt && typeof stmt === 'object' ? stmt._pkValues : null
  const pkNames = stmt && typeof stmt === 'object' ? stmt._pkColumns : null
  if (pkValues && pkNames && pkValues.length === pkNames.length) {
    // 反向 INSERT：主键列名/值随语句走 → 按主键回查（复合主键也能定位）
    const whereSql = pkNames.map((c) => `${quoteIdent(c)} = ?`).join(' AND ')
    const [names, rows] = await _fetchRows(
      conn, `SELECT * FROM ${seg.table} WHERE ${whereSql}`,
      pkValues.map((v) => _fromJsonable(v)), limit)
    if (!rows.length) {
      _markBlocked(snap, seg, '回查插入行失败（行已不存在？）')
      return
    }
    seg.pkColumns = [...pkNames]
    seg.columns = names
    seg.rows = rows.map((row) => row.map((value) => _jsonable(value)))
    seg.capturedRows = rows.length
    snap.capturedRows = Math.trunc(snap.capturedRows || 0) + rows.length
    return
  }
  let lastrowid = null
  if (result && typeof result === 'object' && result.lastrowid !== null
    && result.lastrowid !== undefined) {
    const parsed = Number.parseInt(result.lastrowid, 10)
    lastrowid = Number.isFinite(parsed) ? parsed : null
  }
  if (!lastrowid || lastrowid <= 0) {
    _markBlocked(snap, seg, '无法定位插入行（非自增主键的 INSERT 暂不支持撤销）')
    return
  }
  const [dbName, tableName] = _normalizeTable(seg.table)
  const columnsMeta = await tableColumns(conn, dbName, tableName)
  const autoPkColumns = await resolveKeyColumns(conn, dbName, tableName)
  if (autoPkColumns.length !== 1) {
    _markBlocked(snap, seg, '复合主键 / 无主键的 INSERT 暂不支持撤销')
    return
  }
  const pkMeta = columnsMeta.find((c) => c.name === autoPkColumns[0]) || null
  if (!pkMeta || !pkMeta.auto_increment) {
    _markBlocked(snap, seg, '无法定位插入行（主键非自增，lastrowid 不可信）')
    return
  }
  const [names, rows] = await _fetchRows(
    conn, `SELECT * FROM ${seg.table} WHERE ${quoteIdent(autoPkColumns[0])} = ?`,
    [lastrowid], limit)
  if (!rows.length) {
    _markBlocked(snap, seg, '回查插入行失败（行已不存在？）')
    return
  }
  seg.pkColumns = autoPkColumns
  seg.columns = names
  seg.rows = rows.map((row) => row.map((value) => _jsonable(value)))
  seg.capturedRows = rows.length
  snap.capturedRows = Math.trunc(snap.capturedRows || 0) + rows.length
}

// ---------------------------------------------------------------- 反向语句

/** 单段快照 → 参数化反向语句 [{sql(? 占位), params}]。
 * UPDATE → 全列恢复旧值；DELETE → 原行插回；INSERT → 按主键删除。
 * forceRows：行索引集合——这些行的反向 INSERT 省略主键列（自增分配新 id）；
 * 普通行 INSERT 附带 _pkColumns/_pkValues 元数据（仅供 redo 抓行，不出站）。 */
function _reverseSegment(seg, forceRows = null) {
  const op = seg.op
  const table = seg.table || ''
  const columns = seg.columns || []
  const pkColumns = seg.pkColumns || []
  const rows = seg.rows || []
  const statements = []
  if (!rows.length) return statements
  const pkIndexes = pkColumns
    .map((c) => columns.indexOf(c))
    .filter((idx) => idx !== -1)
  const isForced = (i) => (forceRows instanceof Set
    ? forceRows.has(i)
    : (forceRows || []).includes(i))
  if (op === 'DELETE') {
    for (const [rowIndex, row] of rows.entries()) {
      if (forceRows && isForced(rowIndex)) {
        // 冲突行：丢主键自增插入（redo 走 lastrowid 老路径）
        const keep = columns.map((_, i) => i).filter((i) => !pkIndexes.includes(i))
        const colSql = keep.map((i) => quoteIdent(columns[i])).join(', ')
        const placeholders = keep.map(() => '?').join(', ')
        statements.push({
          sql: `INSERT INTO ${table} (${colSql}) VALUES (${placeholders})`,
          params: keep.map((i) => _fromJsonable(row[i])),
        })
        continue
      }
      const colSql = columns.map((c) => quoteIdent(c)).join(', ')
      const placeholders = columns.map(() => '?').join(', ')
      statements.push({
        sql: `INSERT INTO ${table} (${colSql}) VALUES (${placeholders})`,
        params: row.map((value) => _fromJsonable(value)),
        _pkColumns: pkIndexes.map((i) => columns[i]),
        _pkValues: pkIndexes.map((i) => _fromJsonable(row[i])),
      })
    }
  } else if (op === 'UPDATE') {
    const setSql = columns.map((c) => `${quoteIdent(c)} = ?`).join(', ')
    const whereSql = pkColumns.map((c) => `${quoteIdent(c)} = ?`).join(' AND ')
    for (const row of rows) {
      statements.push({
        sql: `UPDATE ${table} SET ${setSql} WHERE ${whereSql}`,
        params: [...row.map((value) => _fromJsonable(value)),
          ...pkIndexes.map((i) => _fromJsonable(row[i]))],
      })
    }
  } else if (op === 'INSERT') {
    for (const row of rows) {
      const whereSql = pkColumns.map((c) => `${quoteIdent(c)} = ?`).join(' AND ')
      const params = pkColumns.map((c) => _fromJsonable(row[columns.indexOf(c)]))
      statements.push({
        sql: `DELETE FROM ${table} WHERE ${whereSql}`,
        params,
      })
    }
  }
  return statements
}

/** 快照 → 参数化反向语句；多语句按 segment **倒序**逐段回放（后写的先撤）。
 * forceRows：{segment 正序数组序: 行索引集合}——冲突行反向 INSERT 省略主键。 */
export function reverseStatements(snap, forceRows = null) {
  const segments = snap.segments
  if (segments === null || segments === undefined) {
    // 兼容 v1 扁平形状 / undo.js 构造的单段 snap
    return _reverseSegment(snap, forceRows ? forceRows[0] : null)
  }
  const statements = []
  for (let pos = segments.length - 1; pos >= 0; pos--) {
    statements.push(..._reverseSegment(segments[pos], forceRows ? forceRows[pos] : null))
  }
  return statements
}

/** 该段主键是否为单列自增（决定冲突行能否「改用自增 id」安全插回）。 */
async function _pkAutoinc(conn, seg) {
  const pkColumns = seg.pkColumns || []
  if (pkColumns.length !== 1) return false
  const [dbName, tableName] = _normalizeTable(seg.table || '')
  try {
    const columnsMeta = await tableColumns(conn, dbName, tableName)
    const pkMeta = columnsMeta.find((c) => c.name === pkColumns[0]) || null
    return Boolean(pkMeta && pkMeta.auto_increment)
  } catch {
    return false
  }
}

/** 撤销预检（第 44 轮）：反向 INSERT 的原主键值当前是否已被其它行占用。
 * 只检查 op=DELETE 的段。返回 [{segment, row, table, tableDisplay, pkColumns,
 * autoIncrementable}]。连库失败抛异常，由调用方降级。 */
export async function detectPkConflicts(conn, snap) {
  const conflicts = []
  for (const [segIndex, seg] of (snap.segments || []).entries()) {
    if (seg.op !== 'DELETE') continue
    const columns = seg.columns || []
    const pkColumns = seg.pkColumns || []
    if (!pkColumns.length) continue
    const pkIndexes = pkColumns
      .map((c) => columns.indexOf(c))
      .filter((idx) => idx !== -1)
    if (pkIndexes.length !== pkColumns.length) continue
    const whereSql = pkColumns.map((c) => `${quoteIdent(c)} = ?`).join(' AND ')
    for (const [rowIndex, row] of (seg.rows || []).entries()) {
      const params = pkIndexes.map((i) => _fromJsonable(row[i]))
      const [, rows] = await _fetchRows(
        conn, `SELECT 1 FROM ${seg.table} WHERE ${whereSql} LIMIT 1`, params, 1)
      if (rows.length) {
        conflicts.push({
          segment: segIndex,
          row: rowIndex,
          table: seg.table || '',
          tableDisplay: seg.tableDisplay || seg.table || '',
          pkColumns: [...pkColumns],
          autoIncrementable: await _pkAutoinc(conn, seg),
        })
      }
    }
  }
  return conflicts
}

/** 出站预览：只给占位符 SQL（结构可见、值不可见，绕不开脱敏硬规则）。 */
export function reversePreview(reverseList) {
  return reverseList.map((statement) => ({ sql: statement.sql }))
}

// ---------------------------------------------------------------- 落盘 / 记账

function _filePath(undoId) {
  return join(config.undoDir(), `${undoId}.json`)
}

function _writeFile(path, payload) {
  mkdirSync(join(path, '..'), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(payload), 'utf8')
  renameSync(tmp, path) // 原子替换，避免半截文件
}

/** 快照落盘 + 记账（status=prepared）；提交成功后由 activate() 转正。 */
export function persist(snap, info, database, meta = null) {
  if (!snap.snapshotable || !Math.trunc(snap.capturedRows || 0)) {
    return // 双保险：降级后的空快照绝不落盘
  }
  const undoId = newUndoId()
  const path = _filePath(undoId)
  const segments = (snap.segments || []).map((seg) => ({
    op: seg.op, table: seg.table,
    pkColumns: seg.pkColumns || [], columns: seg.columns || [],
    rows: seg.rows || [],
  }))
  const payload = {
    version: 2, id: undoId, segments,
    // v1 扁平字段镜像（单语句 = 唯一段；多语句置空）：老读方 / 人工排查兼容
    op: snap.op || '', table: snap.table || '',
    pkColumns: snap.pkColumns || [], columns: snap.columns || [],
    rows: snap.rows || [],
  }
  _writeFile(path, payload)
  const entry = {
    id: undoId,
    connectionId: info.id ?? '',
    connectionName: info.name ?? '',
    database: database || '',
    ticketId: meta?.ticketId ?? '',
    sql: snap.sql || '',
    kind: snap.op,
    table: snap.tableDisplay ?? '',
    op: snap.op,
    undoFile: path,
    affectedRows: snap.capturedRows || 0,
    undoAvailable: true,
    status: 'prepared',
    undoOf: meta?.undoOf ?? '',
    createdAt: now(),
  }
  let staleFiles = []
  try {
    staleFiles = storeDb.insertUndo(entry)
  } catch (error) {
    try { unlinkSync(path) } catch { /* 尽力而为 */ }
    throw error
  }
  for (const stale of staleFiles) { // 淘汰的旧快照文件顺手清掉
    try { unlinkSync(stale) } catch { /* 尽力而为 */ }
  }
  snap.undoId = undoId
  snap.undoFile = path
}

/** 提交成功：prepared → active（可撤销）。 */
export function activate(snap) {
  if (snap.undoId) {
    storeDb.casUpdateUndo(snap.undoId, 'prepared', { status: 'active' })
  }
}

/** 提交失败 / 执行失败：删文件 + 删 prepared 记账行（尽力而为，不留悬挂快照）。 */
export function discard(snap) {
  if (!snap.undoId) return
  try { storeDb.deleteUndo(snap.undoId) } catch { /* 尽力而为 */ }
  try { unlinkSync(snap.undoFile || _filePath(snap.undoId)) } catch { /* 尽力而为 */ }
}

/** 执行响应里的 undo 摘要（可撤销时带 id，面板按 ticketId/historyId 反查）。 */
export function summary(snap) {
  return {
    available: Boolean(snap.snapshotable),
    reason: snap.snapshotable ? '' : (snap.reason || '不可撤销'),
    op: snap.op || '',
    table: snap.tableDisplay || '',
    rows: snap.capturedRows || 0,
    undoId: snap.undoId || '',
  }
}

/** 快照文件 → segments（undo.js 用）：v2 读 segments；v1 扁平形状包成单段。 */
export function normalizeSegments(payload) {
  const segments = payload.segments
  if (segments instanceof Array && segments.length) {
    return segments.map((seg) => ({ ...seg }))
  }
  return [{
    op: payload.op || '', table: payload.table || '',
    pkColumns: payload.pkColumns || [], columns: payload.columns || [],
    rows: payload.rows || [],
  }]
}

/** 读快照文件（api/undo.js 用）；文件缺失/损坏抛异常由调用方转 4xx。 */
export function loadSnapshot(undoFile) {
  if (!existsSync(undoFile)) {
    throw new Error(`快照文件不存在: ${undoFile}`)
  }
  const payload = JSON.parse(readFileSync(undoFile, 'utf8'))
  if (!payload || typeof payload !== 'object' || payload instanceof Array) {
    throw new Error('快照文件为空或损坏')
  }
  const hasRows = Boolean((payload.rows || []).length)
    || (payload.segments || []).some((seg) => (seg.rows || []).length)
  if (!hasRows) {
    throw new Error('快照文件为空或损坏')
  }
  return payload
}
