/**
 * agent 只读查询的慢 SQL 硬门禁（契约 §3.3）：server/core/plan_guard.py 的移植。
 *
 * SELECT 执行前逐条 EXPLAIN，两个独立条件**命中任一即拦**（403 SLOW_SQL_RISK）：
 * 1. 执行计划里任何一行是全表扫描（type=ALL）且表数据量达到分档阈值
 *    （information_schema.TABLE_ROWS 近似值 >= DBS_SLOW_SQL_FULL_SCAN_TABLE_ROWS，
 *    默认 500_000）——小表全扫放行；TABLE_ROWS 取不到（视图/无权限）按保守拦；
 *    阈值 <=0 关闭分档，回到 type=ALL 一律拦的旧规则；
 * 2. 任何一行的估算扫描行数超过 DBS_SLOW_SQL_MAX_SCAN_ROWS（默认 100000）。
 *
 * - 只对 X-DBS-Actor: agent 生效（调用方判断）；面板交互查询不拦。
 * - 估算行数阈值 <=0 时整体关闭（测试 / 特殊场景逃生口）。
 * - EXPLAIN 自身失败 → 视为无法证明安全性，按 400 带原因拒绝（fail closed）。
 *
 * JS 侧的 EXPLAIN 对应：conn.query('EXPLAIN ' + sql) 返回 [rows, fields]，
 * rows 是**对象数组**（mysql2 普通 query 返回命名行），直接 r.table/r.type/r.key/
 * r.rows/r.Extra 取。
 */

import * as config from './config.js'
import { ApiError } from './errors.js'

/** JS 侧没有 pymysql.Error 单一基类：所有从 query 里冒出来的 Error 都按
 * 「EXPLAIN 失败」处理（fail closed 语义与 Python 一致）。 */

/** 逐条 SELECT EXPLAIN → 计划列表；failClosed=true 时 EXPLAIN 失败抛 400。
 *
 * 返回 [{index, plans: [{table,type,key,rows,extra}]}]（只含有结果集语句的条目，
 * plans 内放计划行；EXPLAIN 失败且不 failClosed 时 plans=[{error:"..."}]）。
 *
 * 行形态兼容：DbsConn 的 mysql2 连接配 rowsAsArray:true（行=数组，按下标取，
 * 列序 = EXPLAIN 标准列序 id/select_type/table/type/possible_keys/key/rows/...）；
 * 测试假连接可能给对象行（按名取）。真机教训：只按对象取会拿到全空计划、门禁被绕过。
 */
export async function explainStatements(conn, statements, { failClosed = false } = {}) {
  const collected = []
  for (const stmt of statements) {
    const sql = (stmt.sql || '').trim()
    if (!sql.slice(0, 7).toUpperCase().startsWith('SELECT')) {
      continue // 只读白名单里的 SHOW/DESC/EXPLAIN/USE/SET 不做执行计划体检
    }
    let rows
    try {
      const [planRows, fields] = await conn.query('EXPLAIN ' + sql)
      // 列名 → 下标（数组行）；对象行直接按名取
      const names = (fields || []).map((f) => String(f.name || '').toLowerCase())
      const at = (row, name) => {
        const idx = names.indexOf(name.toLowerCase())
        return idx !== -1 && row[idx] !== undefined ? row[idx]
          : (row[name] !== undefined ? row[name] : undefined)
      }
      rows = (planRows ?? []).map((r) => ({
        table: String(at(r, 'table') ?? ''),
        type: String(at(r, 'type') ?? ''),
        key: String(at(r, 'key') ?? ''),
        rows: _planRowsOf(r, at),
        extra: String(at(r, 'extra') ?? at(r, 'Extra') ?? ''),
      }))
    } catch (exc) {
      if (failClosed) {
        throw new ApiError(
          400,
          `第 ${stmt.index} 条语句 EXPLAIN 失败，无法证明其安全性: ${exc}`)
      }
      collected.push({ index: stmt.index, plans: [{ error: String(exc).slice(0, 300) }] })
      continue
    }
    collected.push({ index: stmt.index, plans: rows })
  }
  return collected
}

function _planRowsOf(row, at) {
  try {
    return Math.trunc(Number(at(row, 'rows') ?? 0))
  } catch {
    return 0
  }
}

/** 表近似行数（information_schema.TABLES.TABLE_ROWS，InnoDB 近似值）。
 * 返回 int；取不到（无权限/视图等）返回 null（调用方按保守拦处理）。
 * 行形态兼容见 explainStatements（rowsAsArray 数组行 / 对象行）。 */
async function _tableRowEstimate(conn, database, table, cache) {
  const key = `${database}\u0000${table}`
  if (cache.has(key)) return cache.get(key)
  let result = null
  try {
    const [rows] = await conn.query(
      'SELECT TABLE_ROWS FROM information_schema.TABLES '
      + 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
      [database, table])
    const row = rows && rows.length ? rows[0] : null
    const value = row instanceof Array ? row[0] : (row ? row.TABLE_ROWS : null)
    result = value === null || value === undefined ? null : Math.trunc(Number(value))
  } catch {
    result = null
  }
  cache.set(key, result)
  return result
}

/** 对（已拆分的）语句逐条 EXPLAIN；疑似慢 SQL 抛 ApiError(403, SLOW_SQL_RISK)。
 *
 * database：语句所在库名（type=ALL 分档查 information_schema 用；空串时表行数
 * 取不到 → 全表扫描按保守拦）。返回 explainStatements 收集的计划（供调用方写入执行历史）。
 */
export async function checkSlowSql(conn, statements, database = '') {
  const maxScan = config.slowSqlMaxScanRows()
  if (maxScan <= 0) return []
  const fullScanMin = config.slowSqlFullScanTableRows()
  const captured = await explainStatements(conn, statements, { failClosed: true })
  const offenders = []
  const tableRowsCache = new Map()
  for (const entry of captured) {
    for (const plan of entry.plans ?? []) {
      if (plan.error) continue // failClosed 已拦，正常路径不会到这里
      const scanType = plan.type || ''
      const rows = Math.trunc(Number(plan.rows ?? 0))
      const table = plan.table || '?'
      if (scanType === 'ALL') {
        if (fullScanMin <= 0) {
          // 分档关闭：旧规则，type=ALL 一律拦
          offenders.push(`\`${table}\` 全表扫描（type=ALL，估算行数约 ${rows}）`)
          continue
        }
        const estimate = await _tableRowEstimate(conn, database, table, tableRowsCache)
        if (estimate === null) {
          offenders.push(`\`${table}\` 全表扫描（type=ALL），无法确认表数据量，保守拦截`)
        } else if (estimate >= fullScanMin) {
          offenders.push(
            `\`${table}\` 全表扫描（type=ALL，表数据量约 ${estimate}`
            + ` ≥ 分档阈值 ${fullScanMin}）`)
        }
        // < 阈值：小表全扫放行
      } else if (rows > maxScan) {
        offenders.push(
          `\`${table}\` 扫描类型 ${scanType || '?'}，`
          + `估算行数约 ${rows} 超过阈值 ${maxScan}`)
      }
    }
  }
  if (offenders.length) {
    // Python: list(dict.fromkeys(offenders))[:5] —— 去重保序取前 5
    const detail = [...new Set(offenders)].slice(0, 5).join('；')
    throw new ApiError(
      403,
      '慢 SQL 门禁：EXPLAIN 发现大表全表扫描（type=ALL 且表数据量达分档阈值）'
      + `或估算行数超过 ${maxScan}，命中任一即拦（${detail}）。`
      + '请收窄过滤条件/时间窗、改走有索引的列，或分页限量后重试。',
      'SLOW_SQL_RISK',
    )
  }
  return captured
}
