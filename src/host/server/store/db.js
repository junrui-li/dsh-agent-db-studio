/**
 * SQLite 持久化层（dbs.db）：server/store/db.py 的逐函数移植（V3 去 sidecar）。
 *
 * 设计要点：
 * - 模块级单连接：本地单用户、每表 ≤500 行，全局串行成本可忽略。
 * - PRAGMA：journal_mode=WAL、synchronous=NORMAL、busy_timeout=5000、secure_delete=ON。
 * - connect() 内 ensureReady()（进程内 once、按 db 路径缓存；路径变了重置缓存并重建表），
 *   其中懒调用 migrate.runMigrations()，覆盖「只调 buildServer」的场景。
 * - transaction()：BEGIN IMMEDIATE / 异常 ROLLBACK / 成功 COMMIT。
 * - 硬规则：绝不在持有 DB 事务时做 MySQL 网络 IO。
 * - 库文件损坏（SQLITE_NOTADB）：不删不建，向上抛错（runtime 负责退出报错）。
 *
 * 与 Python 版的差异：
 * - 并发模型：Python 用 threading.RLock 保护多线程；Node 单线程事件循环内
 *   node:sqlite 调用全部同步执行、中途不 yield，天然串行，无需锁。
 * - 连接句柄：node:sqlite 的 DatabaseSync 打开时就绑定路径；读行返回普通对象
 *   （列名 → 值），`row.keys()` 对应 Object.keys(row)。
 */

import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import * as config from '../core/config.js'
import { runMigrations } from './migrate.js'

const _SCHEMA_VERSION = '2'

/** ValueError 等价物：参数形状错误（对应 Python 的 ValueError）。 */
export class ValueError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValueError'
  }
}

let _conn = null
let _connPath = null
const _ready = new Set() // 已建表 + 已跑过懒迁移的 db 路径
let _ensureRunning = false // 防 ensureReady → migrate → connect 递归

const _DDL = `
CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS import_log (
    source TEXT PRIMARY KEY, sha256 TEXT, size_bytes INT, mtime REAL,
    rows_imported INT, status TEXT CHECK (status IN ('ok','skipped','failed')),
    error TEXT, imported_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS connections (
    id TEXT PRIMARY KEY, position INT, name TEXT,
    kind TEXT CHECK (kind IN ('mysql','redis')),
    host TEXT, port INT, user TEXT, password TEXT, database_name TEXT,
    readonly INT, timeout INT, max_rows INT, created_at TEXT, masking_json TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS history (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, connection_id TEXT,
    connection_name TEXT, database_name TEXT, sql TEXT,
    status TEXT CHECK (status IN ('ok','error')), elapsed_ms INT, time TEXT,
    source TEXT, kind TEXT, statement_count INT, row_count INT,
    affected_rows INT, truncated INT, error TEXT,
    explain_json TEXT, purpose TEXT, undo_json TEXT,
    ticket_id TEXT, ticket_by TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS tickets (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE, status TEXT,
    connection_id TEXT, connection_name TEXT, database_name TEXT, sql TEXT,
    title TEXT, background TEXT, submitted_by TEXT, created_at TEXT,
    estimated_json TEXT, approved_at TEXT, approved_by TEXT,
    approval_comment TEXT, executed_at TEXT, actual_json TEXT, error TEXT,
    rows_json TEXT, kind TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS undo_log (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE,
    connection_id TEXT, connection_name TEXT, database_name TEXT,
    ticket_id TEXT, history_id TEXT, sql TEXT,
    kind TEXT, table_name TEXT, op TEXT, undo_file TEXT,
    affected_rows INT, undo_available INT, unavailable_reason TEXT,
    status TEXT CHECK (status IN ('prepared','active','undoing','undone','discarded')),
    undo_of TEXT, redo_id TEXT, created_at TEXT, undone_at TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS idx_history_connection ON history(connection_id, seq);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status, seq);
CREATE INDEX IF NOT EXISTS idx_undo_status ON undo_log(status, seq);

/* ------------------------------------------------ 第 51 轮：语义层 DB 化
   语义层内容以 dbs.db 为唯一事实来源（第 51 轮裁决 Q2=C）：
   semantic-index.db 只是从这几张表派生的检索缓存。全部 IF NOT EXISTS，
   存量库启动时自动补建，不需要 ALTER。 */
CREATE TABLE IF NOT EXISTS semantic_domain (
    domain      TEXT PRIMARY KEY,
    title       TEXT NOT NULL DEFAULT '',
    origin      TEXT NOT NULL CHECK (origin IN ('doc','system')),
    origin_dir  TEXT NOT NULL DEFAULT '',
    export_dir  TEXT NOT NULL DEFAULT '',
    position    INT  NOT NULL DEFAULT 0,
    created_at  TEXT, updated_at TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS semantic_doc (
    domain      TEXT NOT NULL,
    file        TEXT NOT NULL,
    kind        TEXT NOT NULL,
    body        TEXT NOT NULL,
    source      TEXT NOT NULL CHECK (source IN ('imported','template','edited')),
    revision    INT  NOT NULL DEFAULT 1,
    updated_at  TEXT,
    PRIMARY KEY (domain, file)
) STRICT;
CREATE TABLE IF NOT EXISTS semantic_domain_table (
    domain        TEXT NOT NULL,
    connection_id TEXT NOT NULL,
    database_name TEXT NOT NULL,
    table_name    TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'consumer' CHECK (role IN ('owner','consumer')),
    note          TEXT NOT NULL DEFAULT '',
    position      INT  NOT NULL DEFAULT 0,
    added_at      TEXT,
    PRIMARY KEY (domain, connection_id, database_name, table_name)
) STRICT;
CREATE INDEX IF NOT EXISTS ix_sdt_table
    ON semantic_domain_table (connection_id, database_name, table_name);
CREATE TABLE IF NOT EXISTS semantic_meta (
    key TEXT PRIMARY KEY, value TEXT
) STRICT;
CREATE TABLE IF NOT EXISTS semantic_distill_run (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE,
    domain TEXT NOT NULL DEFAULT '', connection_id TEXT NOT NULL DEFAULT '',
    time_from TEXT NOT NULL DEFAULT '', time_to TEXT NOT NULL DEFAULT '',
    trigger_kind TEXT NOT NULL DEFAULT 'manual',
    status TEXT NOT NULL DEFAULT 'running'
        CHECK (status IN ('running','ready','failed','applied','discarded')),
    model TEXT NOT NULL DEFAULT '', input_tokens TEXT NOT NULL DEFAULT '',
    scanned INT NOT NULL DEFAULT 0, deduped INT NOT NULL DEFAULT 0,
    applied_count INT NOT NULL DEFAULT 0,
    candidates_json TEXT, error TEXT,
    created_at TEXT, applied_at TEXT
) STRICT;
`

// ---------------------------------------------------------------- 基础设施

/** JS 值 → SQLite 绑定值（undefined→NULL、boolean→0/1；其余原样）。 */
function _params(params) {
  return (params ?? []).map((value) => {
    if (value === undefined) return null
    if (value === true) return 1
    if (value === false) return 0
    return value
  })
}

function _s(value) {
  return value === null || value === undefined ? '' : String(value)
}

function _i(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

function _applyPragmas(conn) {
  conn.exec('PRAGMA journal_mode=WAL')
  conn.exec('PRAGMA synchronous=NORMAL')
  conn.exec('PRAGMA busy_timeout=5000')
  conn.exec('PRAGMA secure_delete=ON')
}

function _open(path) {
  mkdirSync(config.dataDir(), { recursive: true })
  const conn = new DatabaseSync(path)
  _applyPragmas(conn)
  return conn
}

function _ensureReady(path) {
  if (_ready.has(path)) return
  const conn = _conn
  conn.exec(_DDL)
  _migrateHistoryColumns(conn)
  _migrateTicketColumns(conn)
  const first = !_ensureRunning
  _ensureRunning = true
  try {
    if (first) runMigrations() // 懒迁移，覆盖「只调 buildServer」的场景
  } finally {
    _ensureRunning = false
  }
  conn.prepare(
    "INSERT INTO meta(key, value) VALUES('schema_version', ?)"
    + ' ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(_SCHEMA_VERSION)
  // node:sqlite 的 DatabaseSync 默认 autocommit：上面每条语句即已落库，
  // 不需要（也不能）像 Python 那样再 conn.commit()。
  _ready.add(path)
}

function _migrateHistoryColumns(conn) {
  // v1 旧库补 history.explain_json / purpose 等（STRICT 表 ALTER 即可）。
  const have = new Set(
    conn.prepare('PRAGMA table_info(history)').all().map((row) => row.name),
  )
  for (const column of ['explain_json', 'purpose', 'undo_json', 'ticket_id', 'ticket_by']) {
    if (!have.has(column)) conn.exec(`ALTER TABLE history ADD COLUMN ${column} TEXT`)
  }
}

function _migrateTicketColumns(conn) {
  // 补列迁移：rows_json（V2.3 结构化工单）、kind（第 45 轮导出工单，存量默认 'write'）。
  const have = new Set(
    conn.prepare('PRAGMA table_info(tickets)').all().map((row) => row.name),
  )
  if (!have.has('rows_json')) conn.exec('ALTER TABLE tickets ADD COLUMN rows_json TEXT')
  if (!have.has('kind')) {
    conn.exec('ALTER TABLE tickets ADD COLUMN kind TEXT')
    conn.exec("UPDATE tickets SET kind = 'write' WHERE kind IS NULL")
  }
}

function _handle() {
  const path = config.dbPath()
  if (_conn !== null && _connPath !== path) {
    try { _conn.close() } catch { /* 关不掉就交给 GC */ }
    _conn = null
    _ready.delete(_connPath) // 路径变了：缓存重置，新库重建表 + 重迁移
  }
  if (_conn === null) {
    _conn = _open(path)
    _connPath = path
  }
  _ensureReady(path)
  return _conn
}

/** 返回进程级共享连接（自动建表 + 懒迁移）。 */
export function connect() {
  return _handle()
}

/** 串行写事务：BEGIN IMMEDIATE / 异常 ROLLBACK / 成功 COMMIT。
 * fn 提前 return 也会 COMMIT（与 Python contextmanager 语义一致）。 */
export function transaction(fn) {
  const conn = connect()
  conn.exec('BEGIN IMMEDIATE')
  try {
    const result = fn(conn)
    conn.exec('COMMIT')
    return result
  } catch (error) {
    try { conn.exec('ROLLBACK') } catch { /* 事务可能已回滚 */ }
    throw error
  }
}

/** 关闭共享连接（测试 teardown 用，防 Windows 句柄残留在 rmtree 下）。 */
export function closeAll() {
  if (_conn !== null) {
    try { _conn.close() } catch { /* 忽略 */ }
    _conn = null
  }
}

/** 转义 LIKE 通配符（% _ \），配合 ``LIKE ? ESCAPE '\'`` 保持子串语义。 */
export function escapeLike(value) {
  return _s(value).replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

/** 加锁执行单行只读查询（供 migrate / api 轻量读取）；无行返回 null。 */
export function queryOne(sql, params = []) {
  const conn = connect()
  const row = conn.prepare(sql).get(..._params(params))
  return row === undefined ? null : row
}

/** 加锁执行多行只读查询（供语义层仓储等上层模块复用连接）。 */
export function queryAll(sql, params = []) {
  const conn = connect()
  return conn.prepare(sql).all(..._params(params))
}

// ---------------------------------------------------------------- connections

const _CONN_COLS = ['id', 'position', 'name', 'kind', 'host', 'port', 'user', 'password',
  'database_name', 'readonly', 'timeout', 'max_rows', 'created_at', 'masking_json']

function _connItemToRow(item, position) {
  const masking = item.masking
  const kind = item.kind === 'mysql' || item.kind === 'redis' ? item.kind : 'mysql'
  return [
    _s(item.id), position, _s(item.name), kind,
    _s(item.host), _i(item.port || 0),
    _s(item.user), _s(item.password),
    _s(item.database), item.readonly ? 1 : 0,
    _i(item.timeout || 0), _i(item.maxRows || 0),
    _s(item.createdAt),
    masking && typeof masking === 'object' && !(masking instanceof Array)
      ? JSON.stringify(masking) : null,
  ]
}

function _connRowToItem(row) {
  let masking = {}
  if (row.masking_json) {
    try {
      const parsed = JSON.parse(row.masking_json)
      if (parsed && typeof parsed === 'object' && !(parsed instanceof Array)) masking = parsed
    } catch {
      masking = {}
    }
  }
  return {
    id: row.id, name: row.name || '',
    kind: row.kind || 'mysql', host: row.host || '',
    port: _i(row.port || 0), user: row.user || '',
    password: row.password || '', database: row.database_name || '',
    readonly: !!row.readonly, timeout: _i(row.timeout || 0),
    maxRows: _i(row.max_rows || 0), createdAt: row.created_at || '',
    masking,
  }
}

/** 契约顺序：ORDER BY position。含明文 password（出站脱敏由 api 层负责）。 */
export function loadConnections() {
  const conn = connect()
  const rows = conn.prepare('SELECT * FROM connections ORDER BY position').all()
  return rows.map((row) => _connRowToItem(row))
}

/** 整表替换：列表顺序即 position（单事务，替代 JSON 整文件写回）。 */
export function saveConnections(items) {
  const rows = []
  for (const item of items || []) {
    if (item && typeof item === 'object' && item.id) {
      rows.push(_connItemToRow(item, rows.length))
    }
  }
  const placeholders = _CONN_COLS.map(() => '?').join(', ')
  transaction((conn) => {
    conn.exec('DELETE FROM connections')
    if (rows.length) {
      const stmt = conn.prepare(
        `INSERT INTO connections (${_CONN_COLS.join(', ')}) VALUES (${placeholders})`)
      for (const row of rows) stmt.run(...row)
    }
  })
}

export function countConnections() {
  const conn = connect()
  return _i(conn.prepare('SELECT COUNT(*) AS n FROM connections').get().n)
}

export function deleteConnection(connectionId) {
  return transaction((conn) =>
    conn.prepare('DELETE FROM connections WHERE id = ?').run(_s(connectionId)).changes === 1)
}

// ---------------------------------------------------------------- history / meta

const _HISTORY_MAX = 500
const _HISTORY_SOURCES = new Set(['panel', 'agent', 'ticket', 'undo'])
const _HISTORY_KINDS = new Set(['query', 'execute', 'export'])

/** dbs.db meta 读取（连接未初始化或表缺失时返回 default）。 */
export function metaGet(key, fallback = '') {
  try {
    const row = connect().prepare('SELECT value FROM meta WHERE key=?').get(_s(key))
    return row !== undefined && row.value !== null && row.value !== undefined
      ? String(row.value) : fallback
  } catch {
    return fallback
  }
}

export function metaSet(key, value) {
  transaction((conn) => {
    conn.prepare(
      'INSERT INTO meta(key, value) VALUES(?, ?)'
      + ' ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(_s(key), _s(value))
  })
}

function _loadJsonText(value) {
  if (!value) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function _historyRowToItem(row) {
  const item = {
    id: row.id, connectionId: row.connection_id || '',
    connectionName: row.connection_name || '',
    database: row.database_name || '', sql: row.sql || '',
    status: row.status || 'ok', elapsedMs: _i(row.elapsed_ms || 0),
    time: row.time || '', source: row.source || 'panel',
    kind: row.kind || 'query',
    statementCount: _i(row.statement_count || 1),
    rowCount: _i(row.row_count || 0),
    affectedRows: row.affected_rows === null || row.affected_rows === undefined
      ? null : _i(row.affected_rows),
    truncated: !!row.truncated,
  }
  if (row.error) item.error = row.error
  const plans = _loadJsonText(row.explain_json)
  if (plans) item.explain = plans
  if (row.purpose) item.purpose = row.purpose
  const undo = _loadJsonText(row.undo_json)
  if (undo && typeof undo === 'object' && !(undo instanceof Array) && Object.keys(undo).length) {
    item.undo = undo // 撤销可用性摘要（available/reason），预判撤销按钮
  }
  if (row.ticket_id) item.ticketId = row.ticket_id // 工单执行的来源工单（第 27 轮）
  if (row.ticket_by) item.ticketBy = row.ticket_by // 工单发起者：agent | user
  return item
}

/** 插入一条历史并淘汰到最多 500 条（读侧 seq DESC = 最新在前）。 */
export function recordHistory(item) {
  if (!item || typeof item !== 'object' || !item.id) {
    throw new ValueError('history item requires id')
  }
  const affected = item.affectedRows
  const explain = item.explain
  const undo = item.undo
  const values = [
    _s(item.id), _s(item.connectionId || ''),
    _s(item.connectionName || ''), _s(item.database || ''),
    _s(item.sql || ''),
    item.status === 'error' ? 'error' : 'ok',
    _i(item.elapsedMs || 0), _s(item.time || ''),
    _HISTORY_SOURCES.has(item.source) ? item.source : 'panel',
    _HISTORY_KINDS.has(item.kind) ? item.kind : 'query',
    _i(item.statementCount || 1), _i(item.rowCount || 0),
    affected === null || affected === undefined ? null : _i(affected),
    item.truncated ? 1 : 0,
    item.error ? String(item.error).slice(0, 2000) : null,
    explain instanceof Array && explain.length
      ? JSON.stringify(explain).slice(0, 8000) : null,
    _s(item.purpose || '').slice(0, 200) || null,
    undo && typeof undo === 'object' && !(undo instanceof Array) && Object.keys(undo).length
      ? JSON.stringify(undo).slice(0, 2000) : null,
    _s(item.ticketId || '').slice(0, 64) || null,
    _s(item.ticketBy || '').slice(0, 16) || null,
  ]
  transaction((conn) => {
    conn.prepare(
      'INSERT INTO history (id, connection_id, connection_name,'
      + ' database_name, sql, status, elapsed_ms, time, source, kind,'
      + ' statement_count, row_count, affected_rows, truncated, error,'
      + ' explain_json, purpose, undo_json, ticket_id, ticket_by)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(...values)
    conn.prepare(
      'DELETE FROM history WHERE seq <= (SELECT MAX(seq) FROM history) - ?',
    ).run(_HISTORY_MAX)
  })
}

/** seq DESC 读取；keyword 走 LIKE + escape_like 转义（保持子串语义）。 */
export function historyRows({ connectionId = null, keyword = null, limit = null } = {}) {
  const clauses = []
  const params = []
  if (connectionId) {
    clauses.push('connection_id = ?')
    params.push(_s(connectionId))
  }
  if (keyword) {
    clauses.push(`(sql LIKE ? ESCAPE '\\' OR ticket_id LIKE ? ESCAPE '\\')`)
    params.push(`%${escapeLike(String(keyword))}%`)
    params.push(`%${escapeLike(String(keyword))}%`)
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const limitSql = limit ? ` LIMIT ${Math.trunc(Number(limit))}` : ''
  const conn = connect()
  const rows = conn.prepare(
    `SELECT * FROM history${where} ORDER BY seq DESC${limitSql}`,
  ).all(..._params(params))
  return rows.map((row) => _historyRowToItem(row))
}

// ---------------------------------------------------------------- tickets

const _TICKETS_MAX = 500

function _ticketRowToItem(row) {
  return {
    id: row.id, status: row.status || 'pending',
    kind: row.kind || 'write',
    connectionId: row.connection_id || '',
    connectionName: row.connection_name || '',
    database: row.database_name || '', sql: row.sql || '',
    title: row.title || '', background: row.background || '',
    submittedBy: row.submitted_by || '',
    createdAt: row.created_at || '',
    estimated: _loadJsonText(row.estimated_json),
    actual: _loadJsonText(row.actual_json),
    rowsPayload: _loadJsonText(row.rows_json),
    approvedAt: row.approved_at, approvedBy: row.approved_by,
    approvalComment: row.approval_comment || '',
    executedAt: row.executed_at, error: row.error,
  }
}

function _ticketValues(ticket) {
  const estimated = ticket.estimated
  const actual = ticket.actual
  return [
    _s(ticket.id), _s(ticket.status || 'pending'),
    _s(ticket.connectionId || ''),
    _s(ticket.connectionName || ''),
    _s(ticket.database || ''), _s(ticket.sql || ''),
    _s(ticket.title || ''), _s(ticket.background || ''),
    _s(ticket.submittedBy || ''), _s(ticket.createdAt || ''),
    estimated && typeof estimated === 'object' && !(estimated instanceof Array)
      ? JSON.stringify(estimated) : null,
    ticket.approvedAt ? _s(ticket.approvedAt) : null,
    ticket.approvedBy ? _s(ticket.approvedBy) : null,
    _s(ticket.approvalComment || ''),
    ticket.executedAt ? _s(ticket.executedAt) : null,
    actual !== null && actual !== undefined && typeof actual === 'object'
      ? JSON.stringify(actual) : null,
    ticket.error ? String(ticket.error).slice(0, 2000) : null,
    ticket.rowsPayload && typeof ticket.rowsPayload === 'object'
      && !(ticket.rowsPayload instanceof Array)
      ? JSON.stringify(ticket.rowsPayload).slice(0, 1_000_000) : null,
    _s(ticket.kind || 'write'),
  ]
}

/** INSERT + 淘汰到最多 500 条（读侧 seq DESC = 最新在前）。 */
export function insertTicket(ticket) {
  if (!ticket || typeof ticket !== 'object' || !ticket.id) {
    throw new ValueError('ticket requires id')
  }
  transaction((conn) => {
    conn.prepare(
      'INSERT INTO tickets (id, status, connection_id, connection_name,'
      + ' database_name, sql, title, background, submitted_by, created_at,'
      + ' estimated_json, approved_at, approved_by, approval_comment,'
      + ' executed_at, actual_json, error, rows_json, kind)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(..._ticketValues(ticket))
    conn.prepare(
      'DELETE FROM tickets WHERE seq <= (SELECT MAX(seq) FROM tickets) - ?',
    ).run(_TICKETS_MAX)
  })
}

export function ticketById(ticketId) {
  const conn = connect()
  const row = conn.prepare('SELECT * FROM tickets WHERE id = ?').get(_s(ticketId))
  return row === undefined ? null : _ticketRowToItem(row)
}

export function ticketRows({ status = null, connectionId = null, limit = null, offset = null } = {}) {
  const clauses = []
  const params = []
  if (status) {
    clauses.push('status = ?')
    params.push(_s(status))
  }
  if (connectionId) {
    clauses.push('connection_id = ?')
    params.push(_s(connectionId))
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const limitSql = limit ? ` LIMIT ${Math.trunc(Number(limit))}` : ''
  const offsetSql = offset ? ` OFFSET ${Math.trunc(Number(offset))}` : ''
  const conn = connect()
  const rows = conn.prepare(
    `SELECT * FROM tickets${where} ORDER BY seq DESC${limitSql}${offsetSql}`,
  ).all(..._params(params))
  return rows.map((row) => _ticketRowToItem(row))
}

export function ticketCount(status = null) {
  const clauses = []
  const params = []
  if (status) {
    clauses.push('status = ?')
    params.push(_s(status))
  }
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''
  const conn = connect()
  const row = conn.prepare(`SELECT COUNT(*) AS n FROM tickets${where}`).get(..._params(params))
  return _i(row.n)
}

export function ticketCounts() {
  const conn = connect()
  const rows = conn.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all()
  const out = {}
  for (const row of rows) out[row.status] = _i(row.n)
  return out
}

const _TICKET_SETTABLE = {
  status: 'status', approvedAt: 'approved_at', approvedBy: 'approved_by',
  approvalComment: 'approval_comment', executedAt: 'executed_at',
  error: 'error', estimated: 'estimated_json', actual: 'actual_json',
  rowsPayload: 'rows_json',
}

/** CAS：UPDATE ... WHERE id=? AND status=?（并发双审批只成功一次）。 */
export function casUpdateTicket(ticketId, expectedStatus, updates) {
  if (!updates || !Object.keys(updates).length) return false
  const sets = []
  const params = []
  for (const [key, raw] of Object.entries(updates)) {
    const column = _TICKET_SETTABLE[key]
    if (column === undefined) throw new ValueError('unsupported ticket field')
    let value = raw
    if (key === 'estimated' || key === 'actual' || key === 'rowsPayload') {
      value = raw !== null && raw !== undefined && typeof raw === 'object'
        ? JSON.stringify(raw) : null
    }
    sets.push(`${column} = ?`)
    params.push(value)
  }
  params.push(_s(ticketId), expectedStatus)
  return transaction((conn) =>
    conn.prepare(
      `UPDATE tickets SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
    ).run(...params).changes === 1)
}

// ---------------------------------------------------------------- undo_log（V2.2 变更前快照索引）

const _UNDO_KEEP_MAX = 500

function _undoRowToItem(row) {
  const item = {
    id: row.id, connectionId: row.connection_id || '',
    connectionName: row.connection_name || '',
    database: row.database_name || '',
    ticketId: row.ticket_id || '', historyId: row.history_id || '',
    sql: row.sql || '', kind: row.kind || '',
    table: row.table_name || '', op: row.op || '',
    affectedRows: row.affected_rows === null || row.affected_rows === undefined
      ? null : _i(row.affected_rows),
    undoAvailable: !!row.undo_available,
    unavailableReason: row.unavailable_reason || '',
    status: row.status || 'prepared',
    undoOf: row.undo_of || '', redoId: row.redo_id || '',
    createdAt: row.created_at || '', undoneAt: row.undone_at || '',
  }
  if (row.undo_file) item.undoFile = row.undo_file // 服务器本地路径；api 层出站前剥离
  return item
}

const _UNDO_COLS = ['id', 'connection_id', 'connection_name', 'database_name', 'ticket_id',
  'history_id', 'sql', 'kind', 'table_name', 'op', 'undo_file',
  'affected_rows', 'undo_available', 'unavailable_reason', 'status',
  'undo_of', 'redo_id', 'created_at', 'undone_at']

function _undoValues(entry) {
  const affected = entry.affectedRows
  return [
    _s(entry.id), _s(entry.connectionId || ''),
    _s(entry.connectionName || ''), _s(entry.database || ''),
    _s(entry.ticketId || ''), _s(entry.historyId || ''),
    _s(entry.sql || '').slice(0, 10240), _s(entry.kind || ''),
    _s(entry.table || ''), _s(entry.op || ''),
    _s(entry.undoFile || ''),
    affected === null || affected === undefined ? null : _i(affected),
    entry.undoAvailable ? 1 : 0,
    _s(entry.unavailableReason || ''),
    _s(entry.status || 'prepared'),
    _s(entry.undoOf || ''), _s(entry.redoId || ''),
    _s(entry.createdAt || ''), _s(entry.undoneAt || ''),
  ]
}

/** INSERT undo_log + 淘汰最旧；返回被淘汰条目的快照文件路径（调用方删文件）。 */
export function insertUndo(entry) {
  const keep = Math.max(1, Math.min(_i(config.undoKeep() || 1), _UNDO_KEEP_MAX))
  return transaction((conn) => {
    conn.prepare(
      `INSERT INTO undo_log (${_UNDO_COLS.join(', ')})`
      + ` VALUES (${_UNDO_COLS.map(() => '?').join(', ')})`,
    ).run(..._undoValues(entry))
    const stale = conn.prepare(
      'SELECT undo_file FROM undo_log WHERE seq <= (SELECT MAX(seq) FROM undo_log) - ?',
    ).all(keep)
    conn.prepare(
      'DELETE FROM undo_log WHERE seq <= (SELECT MAX(seq) FROM undo_log) - ?',
    ).run(keep)
    return stale.map((row) => row.undo_file).filter(Boolean)
  })
}

export function undoById(undoId) {
  const conn = connect()
  const row = conn.prepare('SELECT * FROM undo_log WHERE id = ?').get(_s(undoId))
  return row === undefined ? null : _undoRowToItem(row)
}

/** 按工单 / 历史 id 找最近一条 active 快照（面板「撤销本次变更」按钮用）。 */
export function undoByReference({ ticketId = '', historyId = '' } = {}) {
  const clause = ticketId ? 'ticket_id = ?' : 'history_id = ?'
  const param = ticketId || historyId
  const conn = connect()
  const row = conn.prepare(
    `SELECT * FROM undo_log WHERE ${clause} AND status IN ('active','undoing')`
    + ' ORDER BY seq DESC LIMIT 1',
  ).get(param)
  return row === undefined ? null : _undoRowToItem(row)
}

/** 按工单 / 历史 id 找最近一条快照（**不限状态**，第 43 轮）。
 *
 * 撤销预览用：条目已被撤销（undone）时给出准确 409，而不是 404「没有可撤销的变更」。
 */
export function undoReferenceAny({ ticketId = '', historyId = '' } = {}) {
  const clause = ticketId ? 'ticket_id = ?' : 'history_id = ?'
  const param = ticketId || historyId
  const conn = connect()
  const row = conn.prepare(
    `SELECT * FROM undo_log WHERE ${clause} ORDER BY seq DESC LIMIT 1`,
  ).get(param)
  return row === undefined ? null : _undoRowToItem(row)
}

/** 按 history_id / ticket_id 批量查 undo_log 最新状态（第 43 轮，历史列表按钮联动）。
 *
 * 返回 {"h:<historyId>": status, "t:<ticketId>": status}；无关联条目的键不出现。
 * seq ASC 遍历、后写覆盖 = 取每个引用的最新一条。
 */
export function undoStatusByRefs(historyIds, ticketIds) {
  const out = {}
  const conn = connect()
  for (const [prefix, column, ids] of [
    ['h', 'history_id', historyIds],
    ['t', 'ticket_id', ticketIds],
  ]) {
    const unique = [...new Set((ids || []).filter(Boolean).map(String))].sort()
    if (!unique.length) continue
    const marks = unique.map(() => '?').join(',')
    const rows = conn.prepare(
      `SELECT ${column} AS ref, status FROM undo_log `
      + `WHERE ${column} IN (${marks}) ORDER BY seq ASC`,
    ).all(...unique)
    for (const row of rows) out[`${prefix}:${row.ref}`] = row.status || ''
  }
  return out
}

export function latestActiveUndo() {
  const conn = connect()
  const row = conn.prepare(
    "SELECT * FROM undo_log WHERE status IN ('active','undoing') ORDER BY seq DESC LIMIT 1",
  ).get()
  return row === undefined ? null : _undoRowToItem(row)
}

export function undoRows(limit = 20) {
  const limitSql = ` LIMIT ${Math.max(1, Math.trunc(Number(limit)))}`
  const conn = connect()
  const rows = conn.prepare('SELECT * FROM undo_log ORDER BY seq DESC' + limitSql).all()
  return rows.map((row) => _undoRowToItem(row))
}

const _UNDO_SETTABLE = {
  status: 'status', undoneAt: 'undone_at', redoId: 'redo_id',
  historyId: 'history_id', ticketId: 'ticket_id',
}

/** CAS：UPDATE ... WHERE id=? AND status=?（并发撤销只成功一次）。 */
export function casUpdateUndo(undoId, expectedStatus, updates) {
  if (!updates || !Object.keys(updates).length) return false
  const sets = []
  const params = []
  for (const [key, value] of Object.entries(updates)) {
    const column = _UNDO_SETTABLE[key]
    if (column === undefined) throw new ValueError('unsupported undo field')
    sets.push(`${column} = ?`)
    params.push(value === null || value === undefined ? null : _s(value))
  }
  params.push(_s(undoId), expectedStatus)
  return transaction((conn) =>
    conn.prepare(
      `UPDATE undo_log SET ${sets.join(', ')} WHERE id = ? AND status = ?`,
    ).run(...params).changes === 1)
}

/** 删除一条记账行（prepared 提交失败 / 执行回滚时清账）。 */
export function deleteUndo(undoId) {
  transaction((conn) => {
    conn.prepare('DELETE FROM undo_log WHERE id = ?').run(_s(undoId))
  })
}
