/**
 * 工单的影响面预估（契约 §3.6）——best-effort，绝不因为预估失败让建单失败。
 * server/core/impact.js（impact.py 的移植）。
 *
 * - UPDATE / DELETE：跑 `EXPLAIN <sql>` 取 `rows` 列；多表（多行计划）取各表 rows 的
 *   乘积，封顶 1e9。EXPLAIN 估算 ≤ impactCountMaxRows() 时再追加「同条件
 *   SELECT COUNT(*)」精确计数（只对带顶层 WHERE 的单表语句改写；COUNT 失败/超限
 *   一律退回估算值）。精确命中的语句 exact=True，全部语句都精确时 rowsExact=true。
 * - 计划明细：EXPLAIN 每行的访问类型 / 命中索引 / 行数进 statements[].plan。
 * - INSERT：数 VALUES 后的 (...) 元组个数；解析不出来再退回 EXPLAIN。
 * - DDL：affectedRows=null + notes「结构变更，无法预估行数」。
 * - 任何一步异常都降级成估算/null + notes 说明（本函数保证不抛异常）。
 */

import * as config from './config.js'
import { pool } from './pool.js'
import { _scan, _stripLeadingComments, firstKeyword, hasTopLevelWhere }
  from './guard.js'

export const MAX_ESTIMATE = 10 ** 9
export const DDL_KINDS = new Set(['CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'RENAME'])
const _RISK_HIGH_KINDS = new Set(['DROP', 'TRUNCATE'])

// 表名识别：``db`.`table`` / `table` / db.table / table
// 导出给 snapshot.js 复用（Python 版 snapshot.py 同样引用 impact 的私有表模式）
export const _IDENT = '(?:`[^`]+`|[A-Za-z0-9_$]+)(?:\\.(?:`[^`]+`|[A-Za-z0-9_$]+))?'
export const _TABLE_PATTERNS = {
  UPDATE: new RegExp(`^\\s*UPDATE\\s+(?:LOW_PRIORITY\\s+|IGNORE\\s+)*(${_IDENT})`, 'is'),
  DELETE: new RegExp(
    `^\\s*DELETE\\s+(?:LOW_PRIORITY\\s+|QUICK\\s+|IGNORE\\s+)*(?:FROM\\s+)?(${_IDENT})`, 'is'),
  INSERT: new RegExp(
    `^\\s*INSERT\\s+(?:LOW_PRIORITY\\s+|DELAYED\\s+|HIGH_PRIORITY\\s+|IGNORE\\s+)*`
    + `(?:INTO\\s+)?(${_IDENT})`, 'is'),
  CREATE: new RegExp(
    `^\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TEMPORARY\\s+)?`
    + `(?:TABLE|INDEX|VIEW|DATABASE|SCHEMA|PROCEDURE|FUNCTION|TRIGGER|EVENT)\\s+`
    + `(?:IF\\s+NOT\\s+EXISTS\\s+)?(${_IDENT})`, 'is'),
  ALTER: new RegExp(`^\\s*ALTER\\s+(?:TABLE|DATABASE|SCHEMA|VIEW)\\s+(${_IDENT})`, 'is'),
  DROP: new RegExp(
    `^\\s*DROP\\s+(?:TEMPORARY\\s+)?`
    + `(?:TABLE|INDEX|VIEW|DATABASE|SCHEMA|PROCEDURE|FUNCTION|TRIGGER|EVENT)\\s+`
    + `(?:IF\\s+EXISTS\\s+)?(${_IDENT})`, 'is'),
  TRUNCATE: new RegExp(`^\\s*TRUNCATE\\s+(?:TABLE\\s+)?(${_IDENT})`, 'is'),
  RENAME: new RegExp(`^\\s*RENAME\\s+(?:TABLE\\s+)?(${_IDENT})`, 'is'),
}

// ---------------------------------------------------------------- 语句元信息

/** 归一化标识符（剥反引号；导出给 snapshot.js 复用）。 */
export function _normalizeIdent(ident) {
  if (!ident) return ''
  return String(ident).replace(/`/g, '').trim()
}

/** 粗略提取语句操作的表名（best-effort，给工单列表/标题/明细展示用）。 */
export function tableOf(sql) {
  const kind = firstKeyword(sql)
  const pattern = _TABLE_PATTERNS[kind]
  if (!pattern) return ''
  const text = _stripLeadingComments(sql || '')
  const match = pattern.exec(text)
  return match ? _normalizeIdent(match[1]) : ''
}

export function statementMeta(sql) {
  const kind = firstKeyword(sql)
  const hasWhere = kind === 'UPDATE' || kind === 'DELETE' ? hasTopLevelWhere(sql) : false
  return { kind, table: tableOf(sql), hasWhere }
}

// ---------------------------------------------------------------- COUNT(*) 改写

/** 顶层（括号深度 0）WHERE 关键字在原文中的起始位置；没有返回 -1。 */
export function topLevelWhere(sql) {
  const text = sql || ''
  let depth = 0
  let word = ''
  let start = -1
  for (const [char, position] of _scan(text)) {
    if (char === '(') {
      if (word && word.toUpperCase() === 'WHERE') return start
      depth += 1
      word = ''
      continue
    }
    if (char === ')') {
      if (word && word.toUpperCase() === 'WHERE') return start
      depth = Math.max(0, depth - 1)
      word = ''
      continue
    }
    if (depth === 0 && (/[a-zA-Z]/.test(char) || char === '_')) {
      if (!word) start = position
      word += char
    } else {
      if (word && word.toUpperCase() === 'WHERE') return start
      word = ''
    }
  }
  return word && word.toUpperCase() === 'WHERE' ? start : -1
}

export function multiTablePrefix(sql, whereAt, kind) {
  /** 判断表名到顶层 WHERE 之间是否多表语法：JOIN / USING，或 UPDATE 的 SET 之前
   * 出现顶层逗号、DELETE 的任意顶层逗号。多表语句无法用单表 COUNT 精确计数。 */
  let depth = 0
  let word = ''
  let setSeen = false
  for (const [char] of _scan((sql || '').slice(0, whereAt))) {
    if (char === '(') {
      depth += 1
      word = ''
      continue
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1)
      word = ''
      continue
    }
    if (char === ',') {
      if (depth === 0) {
        if (kind === 'UPDATE') {
          if (!setSeen) return true // SET 列表前的逗号 = UPDATE a, b 多表写法
        } else {
          return true // DELETE 在 WHERE 前出现顶层逗号即多表
        }
      }
      word = ''
      continue
    }
    if (depth === 0 && (/[a-zA-Z]/.test(char) || char === '_')) {
      word += char
      continue
    }
    if (word) {
      const upper = word.toUpperCase()
      if (upper === 'JOIN' || upper === 'USING' || upper === 'STRAIGHT_JOIN') return true
      if (upper === 'SET') setSeen = true
      word = ''
    }
  }
  return false
}

/** UPDATE/DELETE → 同条件 SELECT COUNT(*)；不适合精确计数的语句返回 null。
 * 导出给测试直调（Python 版 test_impact.py 同样访问 impact._count_sql）。 */
export function _countSql(sql, meta) {
  /** UPDATE/DELETE → 同条件 SELECT COUNT(*)；不适合精确计数的语句返回 null。
   *
   * - WHERE 之后的原文（含 ORDER BY / LIMIT）原样拼接：LIMIT 语义与影响行数一致；
   * - 表名用语句里的原文（含反引号），别用归一化后的（剥了反引号会拼坏特殊表名）。
   */
  if ((meta.kind !== 'UPDATE' && meta.kind !== 'DELETE') || !meta.hasWhere) return null
  const whereAt = topLevelWhere(sql)
  if (whereAt < 0 || multiTablePrefix(sql, whereAt, meta.kind)) return null
  let tail = (sql || '').slice(whereAt).trim()
  while (tail.endsWith(';')) tail = tail.slice(0, -1).trim()
  if (!tail) return null
  const match = _TABLE_PATTERNS[meta.kind].exec(_stripLeadingComments(sql || ''))
  if (!match) return null
  return `SELECT COUNT(*) FROM ${match[1]} ${tail}`
}

/** 数 INSERT ... VALUES 后的顶层元组个数；解析不出来返回 null（交由 EXPLAIN 兜底）。 */
export function countInsertTuples(sql) {
  const chars = []
  for (const [char] of _scan(sql || '')) chars.push(char)
  // 先定位顶层 VALUES 关键字（括号内的列清单不参与）
  let depth = 0
  let word = ''
  let valuesAt = null
  for (let position = 0; position < chars.length; position++) {
    const char = chars[position]
    if (char === '(') {
      depth += 1
      word = ''
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
      word = ''
    } else if (depth === 0 && (/[a-zA-Z]/.test(char) || char === '_')) {
      word += char
    } else {
      if (word) {
        if (word.toUpperCase() === 'VALUES') {
          valuesAt = position
          break
        }
        word = ''
      }
    }
  }
  if (valuesAt === null) return null

  // VALUES 之后按「( ... ), ( ... )」数顶层元组，遇到非逗号内容即停（跳过 ON DUPLICATE...）
  let tuples = 0
  let index = valuesAt + 1
  const size = chars.length
  while (index < size) {
    while (index < size && /\s/.test(chars[index])) index += 1
    if (index >= size || chars[index] !== '(') break
    depth = 0
    while (index < size) {
      const char = chars[index]
      if (char === '(') depth += 1
      else if (char === ')') {
        depth -= 1
        if (depth === 0) {
          tuples += 1
          index += 1
          break
        }
      }
      index += 1
    }
    while (index < size && /\s/.test(chars[index])) index += 1
    if (index < size && chars[index] === ',') {
      index += 1
      continue
    }
    break
  }
  return tuples || null
}

// ---------------------------------------------------------------- EXPLAIN

function _explainSql(sql) {
  let text = _stripLeadingComments((sql || '').trim()).trim()
  while (text.endsWith(';')) text = text.slice(0, -1).trim()
  return text
}

function _addNote(notes, text) {
  if (text && !notes.includes(text)) notes.push(text)
}

/** EXPLAIN 单行 → 计划明细；缺列/空值一律 null。rowsAt 为 rows 列下标。
 * names/row 均为数组形态（rowsAsArray）。 */
function _planEntry(names, row, rowsAt) {
  const cell = (name) => {
    const idx = names.indexOf(name)
    if (idx === -1) return null
    const value = row[idx]
    return value !== null && value !== undefined && String(value) !== ''
      ? String(value) : null
  }
  const value = row[rowsAt]
  return {
    accessType: cell('type'),
    key: cell('key'),
    rows: value === null || value === undefined ? null : Number.parseInt(value, 10),
  }
}

/** 对指定语句逐条 EXPLAIN，把 rows 乘积写回 perStatement；单条失败只记 note。
 * EXPLAIN 通过后，对可安全 COUNT 的 UPDATE/DELETE 追加精确计数（估算 ≤ 上限才跑）。
 */
async function _explainIndices(info, database, statements, indices,
  perStatement, notes, metas, exactFlags, plans) {
  await pool.runWithRetry(info.id || '__draft__', info, database, async (conn) => {
    const threshold = config.impactCountMaxRows()
    for (const index of indices) {
      try {
        const sql = _explainSql(statements[index].sql)
        const [rows, fields] = await conn.query('EXPLAIN ' + sql)
        const names = (fields || []).map((f) => String(f.name || '').toLowerCase())
        if (!names.includes('rows')) {
          throw new Error('EXPLAIN 结果没有 rows 列')
        }
        const column = names.indexOf('rows')
        let product = 1
        let seen = false
        plans[index] = rows.map((row) => _planEntry(names, row, column))
        for (const row of rows) {
          const value = row[column]
          if (value === null || value === undefined) continue
          seen = true
          product *= Math.max(Number.parseInt(value, 10) || 0, 0)
        }
        perStatement[index] = seen ? Math.min(product, MAX_ESTIMATE) : 0
        // 同条件 COUNT(*)：只对带顶层 WHERE 的单表 UPDATE/DELETE、估算 ≤ 上限时才跑
        const countSql = threshold > 0 ? _countSql(statements[index].sql, metas[index]) : null
        if (countSql === null || perStatement[index] > threshold) continue
        try {
          const [countRows] = await conn.query(countSql)
          if (countRows && countRows.length && countRows[0][0] !== null
            && countRows[0][0] !== undefined) {
            perStatement[index] = Math.max(Number.parseInt(countRows[0][0], 10) || 0, 0)
            exactFlags[index] = true
          }
        } catch (exc) {
          _addNote(notes, `第 ${index + 1} 条语句精确计数失败，退回 EXPLAIN 估算: ${exc}`)
        }
      } catch (exc) { // 单条语句预估失败不拖累其它语句
        _addNote(notes, `第 ${index + 1} 条语句 EXPLAIN 失败: ${exc}`)
      }
    }
  })
}

// ---------------------------------------------------------------- 入口

export const PREVIEW_MAX = 200

/** 语句预览（契约 §3.6）：压缩空白成一行，超过 limit 截断并以「…」结尾（总长 ≤ limit）。 */
export function sqlPreview(sql, limit = PREVIEW_MAX) {
  const text = (sql || '').replace(/\s+/g, ' ').trim()
  if (text.length <= limit) return text
  return text.slice(0, limit - 1) + '…'
}

/** 返回契约里的 Estimated 对象；本函数保证不抛异常（best-effort）。
 *
 * 多语句：逐条估算，known 的求和（封顶 1e9）作为 estimated.affectedRows；
 * 估不出来的条数记 unknownStatements，不参与求和；一条都估不出来时 affectedRows=null。
 * rowsExact=true 仅当全部语句都精确（COUNT(*) 命中）；逐条精确看 statements[].exact。
 */
export async function estimate(info, statements, database = '') {
  const metas = statements.map((statement) => statementMeta(statement.sql || ''))
  const perStatement = statements.map(() => null)
  const exactFlags = statements.map(() => false)
  const plans = statements.map(() => null)
  const notes = []
  const pendingExplain = []

  for (const [index, meta] of metas.entries()) {
    const kind = meta.kind
    const sql = statements[index].sql || ''
    if (DDL_KINDS.has(kind)) {
      _addNote(notes, '结构变更，无法预估行数')
    } else if (kind === 'INSERT') {
      const count = countInsertTuples(sql)
      if (count !== null) {
        perStatement[index] = Math.min(count, MAX_ESTIMATE)
      } else {
        pendingExplain.push(index) // INSERT ... SELECT 等解析不出来时退回 EXPLAIN
      }
    } else if (kind === 'UPDATE' || kind === 'DELETE') {
      pendingExplain.push(index)
    } else {
      _addNote(notes, `${kind || '未知'} 语句无法预估影响行数`)
    }
  }

  if (pendingExplain.length) {
    try {
      await _explainIndices(info, database, statements, pendingExplain,
        perStatement, notes, metas, exactFlags, plans)
    } catch (exc) {
      _addNote(notes, `EXPLAIN 预估失败，影响行数未知: ${exc}`)
    }
  }

  const known = []
  for (const [index, value] of perStatement.entries()) {
    if (value !== null) known.push([value, exactFlags[index]])
  }
  const unknownCount = perStatement.length - known.length
  if (known.length && unknownCount) {
    _addNote(notes, `${unknownCount} 条语句无法预估行数`)
  }
  const affectedRows = known.length
    ? Math.min(known.reduce((sum, [value]) => sum + value, 0), MAX_ESTIMATE)
    : null
  // 全部语句都精确（COUNT 命中）时才叫精确预估；INSERT 元组计数、EXPLAIN 估算都不算
  const rowsExact = known.length > 0 && unknownCount === 0
    && known.every(([, flag]) => flag)

  const kinds = metas.map((meta) => meta.kind)
  let risk
  if (kinds.some((kind) => _RISK_HIGH_KINDS.has(kind))) {
    risk = 'high'
  } else if (affectedRows === null) {
    risk = 'medium' // 契约：null 预估按 medium
  } else if (affectedRows > 1000) {
    risk = 'high'
  } else if (affectedRows > 100 || statements.length > 3) {
    risk = 'medium'
  } else {
    risk = 'low'
  }

  const entries = []
  for (const [index, meta] of metas.entries()) {
    const entry = {
      kind: meta.kind,
      table: meta.table,
      hasWhere: meta.hasWhere,
      estimatedRows: perStatement[index],
      exact: perStatement[index] !== null ? Boolean(exactFlags[index]) : false,
      sql: sqlPreview(statements[index].sql || ''),
    }
    if (plans[index] !== null) entry.plan = plans[index]
    entries.push(entry)
  }

  return {
    affectedRows,
    rowsExact,
    statementCount: statements.length,
    unknownStatements: unknownCount,
    risk,
    statements: entries,
    notes,
  }
}
