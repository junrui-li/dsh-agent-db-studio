/**
 * 元数据浏览（/api/meta/*）：server/api/meta.py 的移植（MySQL 部分）。
 *
 * - MySQL：库 / 表视图 / 表结构（列、索引、DDL、估算行数、可选精确行数）
 * - Redis：只支持 databases（db 列表，来自 INFO keyspace），契约 3.2
 *   （M2-C 已接线：走 api/redis.js 的 clientFor/redisDb）
 *
 * 元数据查询一律走 pool.runWithRetry（连接被 wait_timeout 掐断时自动重连一次）。
 */

import * as common from './common.js'
import { pool } from '../core/pool.js'
import { ApiError } from '../core/errors.js'
import { quoteIdent } from '../core/guard.js'
import { toJsonable } from '../core/jsonconv.js'

const _SYSTEM_DBS = new Set(['information_schema', 'mysql', 'performance_schema', 'sys'])

async function _run(info, fn) {
  try {
    return await pool.runWithRetry(info.id || '__draft__', info, '', fn)
  } catch (exc) {
    throw new ApiError(400, `查询元数据失败: ${exc}`)
  }
}

// ---------------------------------------------------------------- MySQL

async function _mysqlDatabases(info) {
  return _run(info, async (conn) => {
    const [rows] = await conn.query(
      'SELECT SCHEMA_NAME, DEFAULT_CHARACTER_SET_NAME, DEFAULT_COLLATION_NAME '
      + 'FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME')
    return {
      databases: rows
        .filter((row) => !_SYSTEM_DBS.has(String(row[0]).toLowerCase()))
        .map((row) => ({ name: row[0], charset: row[1], collation: row[2] })),
    }
  })
}

async function _mysqlTables(info, database) {
  return _run(info, async (conn) => {
    const [rows] = await conn.query(
      'SELECT TABLE_NAME, TABLE_TYPE, TABLE_COMMENT, TABLE_ROWS, DATA_LENGTH '
      + 'FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME',
      [database])
    const tables = []
    for (const [name, tableType, comment, estimatedRows, sizeBytes] of rows) {
      tables.push({
        name,
        type: String(tableType || '').toUpperCase() === 'VIEW' ? 'view' : 'table',
        estimatedRows: estimatedRows === null || estimatedRows === undefined
          ? null : Math.trunc(Number(estimatedRows)),
        sizeBytes: sizeBytes === null || sizeBytes === undefined
          ? null : Math.trunc(Number(sizeBytes)),
        comment: comment || '',
      })
    }
    return { tables }
  })
}

async function _loadColumns(conn, database, table) {
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT, '
    + 'EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS '
    + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
    [database, table])
  const columns = []
  for (const [name, dataType, nullable, columnKey, defaultValue, extra, comment] of rows) {
    columns.push({
      name,
      type: dataType || '',
      nullable: String(nullable || '').toUpperCase() === 'YES',
      key: columnKey || '',
      default: toJsonable(defaultValue),
      extra: extra || '',
      comment: comment || '',
    })
  }
  return columns
}

async function _loadIndexes(conn, database, table) {
  const [rows] = await conn.query(
    'SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, INDEX_TYPE '
    + 'FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? '
    + 'ORDER BY INDEX_NAME, SEQ_IN_INDEX',
    [database, table])
  const grouped = new Map()
  for (const [indexName, nonUnique, _seq, column, indexType] of rows) {
    let item = grouped.get(indexName)
    if (item === undefined) {
      let unique = false
      try {
        unique = !Boolean(Math.trunc(Number(nonUnique ?? 0)))
      } catch {
        unique = false
      }
      item = { name: indexName, columns: [], unique, type: indexType || '' }
      grouped.set(indexName, item)
    }
    if (column !== null && column !== undefined) item.columns.push(column)
  }
  return [...grouped.values()]
}

async function _loadDdl(conn, quotedDb, quotedTable) {
  // SHOW CREATE TABLE 优先，视图回退 SHOW CREATE VIEW；拿不到就省略 ddl。
  for (const sql of [`SHOW CREATE TABLE ${quotedDb}.${quotedTable}`,
    `SHOW CREATE VIEW ${quotedDb}.${quotedTable}`]) {
    let row = null
    try {
      const [rows] = await conn.query(sql)
      row = rows && rows.length ? rows[0] : null
    } catch {
      continue
    }
    if (row && row.length > 1) return row[1]
  }
  return null
}

async function _loadEstimatedRows(conn, database, table) {
  const [rows] = await conn.query(
    'SELECT TABLE_ROWS FROM information_schema.TABLES '
    + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
    [database, table])
  const row = rows && rows.length ? rows[0] : null
  if (!row || row[0] === null || row[0] === undefined) return null
  return Math.trunc(Number(row[0]))
}

async function _mysqlTable(info, database, table, exactCount) {
  let quotedDb
  let quotedTable
  try {
    quotedDb = quoteIdent(database)
    quotedTable = quoteIdent(table)
  } catch (exc) {
    throw new ApiError(400, String(exc.message || exc))
  }

  return _run(info, async (conn) => {
    const result = {
      columns: await _loadColumns(conn, database, table),
      indexes: await _loadIndexes(conn, database, table),
    }
    const ddl = await _loadDdl(conn, quotedDb, quotedTable)
    if (ddl !== null) result.ddl = ddl
    const estimated = await _loadEstimatedRows(conn, database, table)
    if (estimated !== null) result.estimatedRows = estimated
    if (exactCount) {
      const [rows] = await conn.query(`SELECT COUNT(*) FROM ${quotedDb}.${quotedTable}`)
      const row = rows && rows.length ? rows[0] : null
      result.exactRows = row && row[0] !== null && row[0] !== undefined
        ? Math.trunc(Number(row[0])) : 0
    }
    return result
  })
}

// ---------------------------------------------------------------- Redis（M2-C 已接线）

// M2-C 完成：keyspace 语义（INFO keyspace → db 列表，空 db0 兜底）收敛到
// api/redis.js 的 redisDatabases（对照 meta.py 的 _redis_databases），
// meta 只按连接类型分流。
async function _redisDatabases(info) {
  const redisApi = await import('./redis.js').catch(() => null)
  if (!redisApi || typeof redisApi.redisDatabases !== 'function') {
    throw new ApiError(400, 'Redis 元数据由 redis 模块提供')
  }
  return redisApi.redisDatabases(info)
}

// ---------------------------------------------------------------- handlers

export async function handleDatabases(query, _body = null, _headers = null) {
  const info = common.getConnection(query)
  if ((info.kind || 'mysql') === 'redis') {
    return _redisDatabases(info)
  }
  common.requireMysql(info)
  return _mysqlDatabases(info)
}

export async function handleTables(query, _body = null, _headers = null) {
  const info = common.getConnection(query)
  common.requireMysql(info)
  const database = common.textField(query, 'database', '', 'database').trim()
  if (!database) throw new ApiError(400, '缺少 database')
  return _mysqlTables(info, database)
}

export async function handleTable(query, _body = null, _headers = null) {
  const info = common.getConnection(query)
  common.requireMysql(info)
  const database = common.textField(query, 'database', '', 'database').trim()
  const table = common.textField(query, 'table', '', 'table').trim()
  if (!database) throw new ApiError(400, '缺少 database')
  if (!table) throw new ApiError(400, '缺少 table')
  const exactCount = common.boolField(query, 'exactCount', false)
  return _mysqlTable(info, database, table, exactCount)
}
