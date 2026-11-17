/**
 * 网格编辑 → DML 生成（参数化）。server/core/sqlgen.py 的移植。
 *
 * 与 Python 版的差异：占位符从 pymysql 的 `%s` 换成 mysql2 的 `?`（执行层直接可用）；
 * render 的逐位替换逻辑与人读输出保持一致。
 *
 * - WHERE 只用主键列（NOT NULL，天然规避 NULL 语义坑）。
 * - 值一律走参数化 `?`，绝不拼值；仅表名/列名做标识符校验后反引号包裹。
 * - render：把参数化 SQL 渲染成人读文本，仅供确认弹窗展示，与执行逐字对应。
 */

import { quoteIdent } from './guard.js'
import { ValueError } from './errors.js'

function _q(dbName, table) {
  return `${quoteIdent(dbName)}.${quoteIdent(table)}`
}

/** 列元数据查询（api 层传入 mysql2 连接）。
 * mysql2 配 rowsAsArray:true → 行是数组，按下标取（与 Python pymysql 元组行同构）。 */
export async function tableColumns(conn, dbName, table) {
  const [rows] = await conn.query(
    'SELECT COLUMN_NAME, IS_NULLABLE, EXTRA FROM information_schema.COLUMNS '
    + 'WHERE TABLE_SCHEMA=? AND TABLE_NAME=? ORDER BY ORDINAL_POSITION',
    [dbName, table])
  return rows.map((r) => ({
    name: r[0],
    nullable: r[1] === 'YES',
    auto_increment: String(r[2] || '').toLowerCase().includes('auto_increment'),
  }))
}

/** 主键列（有序）；无主键回退全 NOT NULL 唯一索引；都无返回 []。 */
export async function resolveKeyColumns(conn, dbName, table) {
  const [rows] = await conn.query(
    "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE "
    + "WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND CONSTRAINT_NAME='PRIMARY' "
    + 'ORDER BY ORDINAL_POSITION',
    [dbName, table])
  if (rows.length) return rows.map((r) => r[0])

  // 回退：唯一索引（STATISTICS），要求所有列 NOT NULL
  const [idxRows] = await conn.query(
    'SELECT INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS '
    + 'WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND NON_UNIQUE=0 '
    + 'ORDER BY INDEX_NAME, SEQ_IN_INDEX',
    [dbName, table])
  const colsMeta = await tableColumns(conn, dbName, table)
  const colNullable = new Map(colsMeta.map((c) => [c.name, c.nullable]))
  const candidate = new Map()
  for (const row of idxRows) {
    if (!candidate.has(row[0])) candidate.set(row[0], [])
    candidate.get(row[0]).push(row[1])
  }
  const names = [...candidate.keys()].sort()
  for (const name of names) {
    const cols = candidate.get(name)
    if (cols.length && cols.every((c) => colNullable.get(c) === false)) return cols
  }
  return []
}

/** 值 → 人读文本（与执行逐字对应）。 */
export function renderValue(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'boolean') return v ? '1' : '0'
  if (typeof v === 'number' || typeof v === 'bigint') return String(v)
  if (v instanceof Date) {
    const pad = (n, w = 2) => String(n).padStart(w, '0')
    const date = `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
    const time = `${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`
    return `'${date} ${time}'`
  }
  if (typeof v === 'string') {
    // 与 Python 版一致：字符串值也要做 SQL 人读转义（反斜杠 + 单引号）
    const s = v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
    return `'${s}'`
  }
  if (typeof v === 'object' && typeof v.length === 'number') { // Buffer/TypedArray
    const hex = [...new Uint8Array(v)].map((b) => b.toString(16).padStart(2, '0')).join('')
    return `0x${hex}`
  }
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

/** `?` 参数化 SQL → 人读文本（仅供展示，执行仍走参数化）。 */
export function render(sql, params) {
  const out = []
  const parts = sql.split('?')
  for (let i = 0; i < parts.length; i++) {
    out.push(parts[i])
    if (i < parts.length - 1) {
      const v = i < params.length ? params[i] : null
      out.push(renderValue(v))
    }
  }
  return out.join('')
}

function _wherePk(pkCols, pk) {
  if (!pkCols || !pkCols.length) {
    throw new ValueError('该表无主键/唯一键，不支持网格编辑')
  }
  const conds = []
  const params = []
  for (const c of pkCols) {
    if (!(c in pk) || pk[c] === null || pk[c] === undefined) {
      throw new ValueError(`主键列 ${c} 值缺失，无法定位行`)
    }
    conds.push(`${quoteIdent(c)} = ?`)
    params.push(pk[c])
  }
  return [conds.join(' AND '), params]
}

export function buildUpdate(dbName, table, pkCols, pk, sets) {
  if (!sets || !Object.keys(sets).length) {
    throw new ValueError('没有需要更新的列')
  }
  const [where, wparams] = _wherePk(pkCols, pk)
  const setCols = Object.keys(sets)
  const colSql = setCols.map((c) => `${quoteIdent(c)} = ?`).join(', ')
  const params = [...setCols.map((c) => sets[c]), ...wparams]
  const sql = `UPDATE ${_q(dbName, table)} SET ${colSql} WHERE ${where}`
  return { op: 'UPDATE', sql, params, render: render(sql, params) }
}

export function buildDelete(dbName, table, pkCols, pk) {
  const [where, wparams] = _wherePk(pkCols, pk)
  const sql = `DELETE FROM ${_q(dbName, table)} WHERE ${where}`
  return { op: 'DELETE', sql, params: wparams, render: render(sql, wparams) }
}

/** 显式列名 INSERT；值为空的 auto_increment 列排除，交数据库生成。 */
export function buildInsert(dbName, table, colsMeta, row) {
  const use = colsMeta
    .filter((c) => c.name in row && !(c.auto_increment && row[c.name] === null))
    .map((c) => c.name)
  if (!use.length) {
    throw new ValueError('INSERT 至少需要一个非空列')
  }
  const colSql = use.map((c) => quoteIdent(c)).join(', ')
  const ph = use.map(() => '?').join(', ')
  const params = use.map((c) => row[c])
  const sql = `INSERT INTO ${_q(dbName, table)} (${colSql}) VALUES (${ph})`
  return { op: 'INSERT', sql, params, render: render(sql, params) }
}
