/**
 * 旧 JSON（connections/history/tickets.json）一次性迁移进 dbs.db。
 * server/store/migrate.py 的逐函数移植（V3 去 sidecar）。
 *
 * 调用方：
 * - runtime 组装时显式调用（对应 app.main 的权威入口，ready 日志打计数）；
 * - store/db.js ensureReady()：懒迁移，覆盖「只调 buildServer」的场景。
 *
 * 规则（与 Python 版一致）：
 * - 每源文件：sha256/size/mtime 对比 import_log，已成功且相同 → skipped:unchanged；
 * - 目标表已有行 → skipped:existing_rows，不覆盖（防「DB 从备份恢复 + JSON 还在」重复导入）；
 * - 每文件一个 BEGIN IMMEDIATE 事务：导入 → 写 import_log → COMMIT → rename 到 .migrated；
 * - 坏 JSON → 回滚 + import_log 记 failed + stderr 一行告警，继续（保持「坏 JSON=空」语义）；
 * - dbs.db 文件损坏 → node:sqlite 抛错向上传播，不删不建（runtime 退出报错）；
 * - 绝不打印任何行内容/密码/异常 repr。
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as config from '../core/config.js'
import * as db from './db.js'

const _TABLES = {
  'connections.json': 'connections',
  'history.json': 'history',
  'tickets.json': 'tickets',
}

const _CONNECTION_LEGACY_KEYS = { max_rows: 'maxRows', created_at: 'createdAt' }
const _CONNECTION_KINDS = new Set(['mysql', 'redis'])
const _HISTORY_SOURCES = new Set(['panel', 'agent', 'ticket'])
const _HISTORY_KINDS = new Set(['query', 'execute'])

// 注意：config 常量在**函数体内**读取（模块顶层读会因 config↔store 循环 import 触发 TDZ）

let _running = false // 防重入（ensureReady 与 runtime 双入口）

function _now() {
  // datetime.now().isoformat(timespec="seconds") → "2026-11-13T17:00:00"（本地时间）
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function _warn(name, reason) {
  process.stderr.write(`[dbs-migrate] ${name}: import failed (${reason}); kept as-is\n`)
}

function _fingerprint(path) {
  const data = readFileSync(path)
  const stat = statSync(path)
  return [createHash('sha256').update(data).digest('hex'), data.length, stat.mtimeMs]
}

function _extractList(data, keys) {
  if (data instanceof Array) return data.filter((item) => item && typeof item === 'object')
  if (data && typeof data === 'object') {
    for (const key of keys) {
      const items = data[key]
      if (items instanceof Array) {
        return items.filter((item) => item && typeof item === 'object')
      }
    }
  }
  return []
}

function _logImport(conn, name, sha, size, mtime, rows, status, error) {
  conn.prepare(
    'INSERT INTO import_log (source, sha256, size_bytes, mtime, rows_imported,'
    + ' status, error, imported_at) VALUES (?,?,?,?,?,?,?,?)'
    + ' ON CONFLICT(source) DO UPDATE SET sha256=excluded.sha256,'
    + ' size_bytes=excluded.size_bytes, mtime=excluded.mtime,'
    + ' rows_imported=excluded.rows_imported, status=excluded.status,'
    + ' error=excluded.error, imported_at=excluded.imported_at',
  ).run(name, sha, size, mtime, rows, status, error, _now())
}

/** 迁移三个旧 JSON → dbs.db。返回 {文件名: 状态字符串}。
 *
 * 状态取值：absent / ok:N / skipped:unchanged / skipped:absent /
 * skipped:existing_rows / failed:bad_json。库文件损坏时 node:sqlite 抛错向上。
 */
export function runMigrations() {
  if (_running) return {}
  _running = true
  try {
    const out = {}
    for (const name of Object.keys(_TABLES)) out[name] = _migrateOne(name)
    return out
  } finally {
    _running = false
  }
}

function _migrateOne(name) {
  const path = join(config.dataDir(), name)
  if (!existsSync(path)) {
    const prior = db.queryOne('SELECT status FROM import_log WHERE source = ?', [name])
    if (prior !== null && prior.status === 'ok') {
      return 'skipped:absent' // 已迁移成功且源文件已改名，无事可做
    }
    return 'absent'
  }
  const table = _TABLES[name]
  let sha, size, mtime
  try {
    ;[sha, size, mtime] = _fingerprint(path)
  } catch {
    return 'absent'
  }
  db.connect() // 确保表已建（含懒迁移入口的递归防护）
  let rows = 0
  let status = ''
  db.transaction((conn) => {
    const prior = conn.prepare(
      'SELECT sha256, size_bytes, mtime, status FROM import_log WHERE source = ?',
    ).get(name)
    if (prior !== undefined && prior.status === 'ok'
      && prior.sha256 === sha && prior.size_bytes === size && prior.mtime === mtime) {
      status = 'skipped:unchanged'
      return
    }
    const existing = conn.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n
    if (existing) {
      _logImport(conn, name, sha, size, mtime, 0, 'skipped', 'existing_rows')
      status = 'skipped:existing_rows'
      return
    }
    let data
    try {
      data = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      _logImport(conn, name, sha, size, mtime, 0, 'failed', 'bad_json')
      _warn(name, 'bad json')
      status = 'failed:bad_json'
      return
    }
    rows = _importRows(conn, table, data)
    _logImport(conn, name, sha, size, mtime, rows, 'ok', null)
    status = 'ok'
  })
  if (status !== 'ok') return status
  renameSync(path, path + '.migrated')
  return `ok:${rows}`
}

// ---------------------------------------------------------------- connections

function _connValues(item, position) {
  const cid = item.id
  if (typeof cid !== 'string' || !cid) return null
  const values = { ...item }
  for (const [legacy, modern] of Object.entries(_CONNECTION_LEGACY_KEYS)) {
    if (!(modern in values) && legacy in values) values[modern] = values[legacy]
  }
  let kind = values.kind
  if (!_CONNECTION_KINDS.has(kind)) kind = 'mysql'
  const masking = values.masking
  return [
    cid, position, _s(values.name), kind, _s(values.host),
    _i(values.port), _s(values.user), _s(values.password),
    _s(values.database), values.readonly ? 1 : 0,
    _i(values.timeout), _i(values.maxRows),
    _s(values.createdAt),
    masking && typeof masking === 'object' && !(masking instanceof Array)
      ? JSON.stringify(masking) : null,
  ]
}

function _importConnections(conn, data) {
  const rows = []
  for (const item of _extractList(data, ['connections', 'items'])) {
    const values = _connValues(item, rows.length)
    if (values !== null) rows.push(values)
  }
  if (rows.length) {
    const stmt = conn.prepare(
      'INSERT INTO connections (id, position, name, kind, host, port, user,'
      + ' password, database_name, readonly, timeout, max_rows, created_at,'
      + ' masking_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (const row of rows) stmt.run(...row)
  }
  return rows.length
}

// ---------------------------------------------------------------- history

function _historyValues(item) {
  const hid = item.id
  if (typeof hid !== 'string' || !hid) return null
  let connName = item.connectionName
  if (typeof connName !== 'string') connName = _s(item.conn)
  let database = item.database
  if (typeof database !== 'string') database = _s(item.db)
  let status
  if ('status' in item) {
    status = item.status === 'error' ? 'error' : 'ok'
  } else {
    status = item.ok === false ? 'error' : 'ok' // 注意：ok 缺省视为 true
  }
  const source = item.source
  const kind = item.kind
  const affected = item.affectedRows
  const error = item.error
  return [
    hid, _s(item.connectionId), connName, database,
    _s(item.sql).slice(0, config.HISTORY_SQL_MAX), status,
    _i(item.elapsedMs), _s(item.time),
    _HISTORY_SOURCES.has(source) ? source : 'panel',
    _HISTORY_KINDS.has(kind) ? kind : 'query',
    _i(item.statementCount, 1), _i(item.rowCount),
    affected === null || affected === undefined ? null : _i(affected),
    item.truncated ? 1 : 0,
    typeof error === 'string' && error ? error.slice(0, 2000) : null,
  ]
}

function _importHistory(conn, data) {
  const rows = []
  for (const item of _extractList(data, ['history', 'items'])) {
    const values = _historyValues(item)
    if (values !== null) rows.push(values)
  }
  rows.reverse() // 文件首条（最新）拿最大 seq → 读侧 ORDER BY seq DESC 与现行为一致
  if (rows.length) {
    const stmt = conn.prepare(
      'INSERT INTO history (id, connection_id, connection_name,'
      + ' database_name, sql, status, elapsed_ms, time, source, kind,'
      + ' statement_count, row_count, affected_rows, truncated, error)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (const row of rows) stmt.run(...row)
  }
  return rows.length
}

// ---------------------------------------------------------------- tickets

function _ticketValues(item) {
  const tid = item.id
  if (typeof tid !== 'string' || !tid) return null
  const estimated = item.estimated
  const actual = item.actual
  const error = item.error
  return [
    tid, _s(item.status) || 'pending', _s(item.connectionId),
    _s(item.connectionName), _s(item.database),
    _s(item.sql), _s(item.title), _s(item.background),
    _s(item.submittedBy), _s(item.createdAt),
    estimated && typeof estimated === 'object' && !(estimated instanceof Array)
      ? JSON.stringify(estimated) : null,
    _s(item.approvedAt) || null, _s(item.approvedBy) || null,
    _s(item.approvalComment), _s(item.executedAt) || null,
    actual !== null && actual !== undefined && typeof actual === 'object'
      ? JSON.stringify(actual) : null,
    typeof error === 'string' && error ? error.slice(0, 2000) : null,
  ]
}

function _importTickets(conn, data) {
  const rows = []
  for (const item of _extractList(data, ['tickets', 'items'])) {
    const values = _ticketValues(item)
    if (values !== null) rows.push(values)
  }
  rows.reverse() // 同 history：文件首条（最新）拿最大 seq
  if (rows.length) {
    const stmt = conn.prepare(
      'INSERT INTO tickets (id, status, connection_id, connection_name,'
      + ' database_name, sql, title, background, submitted_by, created_at,'
      + ' estimated_json, approved_at, approved_by, approval_comment,'
      + ' executed_at, actual_json, error)'
      + ' VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    for (const row of rows) stmt.run(...row)
  }
  return rows.length
}

function _importRows(conn, table, data) {
  const importer = {
    connections: _importConnections,
    history: _importHistory,
    tickets: _importTickets,
  }[table]
  return importer(conn, data)
}

function _s(value) {
  return typeof value === 'string' ? value : ''
}

function _i(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}
