/**
 * SQL 安全拦截（所有执行入口单点必经）：server/core/guard.py 的逐行移植。
 *
 * - 只读路径：白名单词法扫描，首个有效 token 必须是只读词。
 * - 可写路径：直执行的 UPDATE / DELETE 缺顶层 WHERE 时拦截。
 * - 扫描跳过引号内与注释内的内容，避免字符串里出现 where 误判。
 */

import { PermissionError, ValueError } from './errors.js'

const _READONLY_KEYWORDS = new Set(['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'USE', 'SET'])

const _ID_RE = /^[A-Za-z0-9_$]+$/

/** 标识符校验 + 反引号包裹。元数据虽来自 information_schema，仍兜底校验。 */
export function quoteIdent(name) {
  if (!_ID_RE.test(name || '')) {
    throw new ValueError(`非法标识符: ${JSON.stringify(name)}`)
  }
  return `\`${name}\``
}

/** 跳过注释与引号字面量的逐字符扫描，产出 [字符, 位置]。
 * 导出给 impact.js 复用（Python 版 impact.py 同样引用 guard 的私有 _scan）。 */
export function* _scan(sql) {
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    const nxt = i + 1 < n ? sql[i + 1] : ''
    if (c === "'" || c === '"') { // 字符串字面量（含 '' 与 \' 转义）
      const q = c
      i += 1
      while (i < n) {
        if (sql[i] === '\\') { i += 2; continue }
        if (sql[i] === q) {
          if (i + 1 < n && sql[i + 1] === q) { i += 2; continue }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (c === '`') { // 标识符字面量，MySQL 用双反引号转义
      i += 1
      while (i < n) {
        if (sql[i] === '`') {
          if (i + 1 < n && sql[i + 1] === '`') { i += 2; continue }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if (c === '#' || (c === '-' && nxt === '-')) {
      while (i < n && sql[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && nxt === '*') {
      const end = sql.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    yield [c, i]
    i += 1
  }
}

/** 去掉前导注释与空白（导出给 impact.js 复用）。 */
export function _stripLeadingComments(sql) {
  // 去掉前导注释与空白，用于取首关键字（条件注释 /*!... */ 保留）。
  let s = sql
  for (;;) {
    const t = s.replace(/^\s+/, '')
    if (!t) return s
    if (t.startsWith('--')) {
      const nl = t.indexOf('\n')
      s = nl === -1 ? '' : t.slice(nl + 1)
      continue
    }
    if (t.startsWith('#')) {
      const nl = t.indexOf('\n')
      s = nl === -1 ? '' : t.slice(nl + 1)
      continue
    }
    if (t.startsWith('/*') && !t.startsWith('/*!')) {
      const end = t.indexOf('*/')
      s = end === -1 ? '' : t.slice(end + 2)
      continue
    }
    return t
  }
}

/** 首个有效关键字（大写）。条件注释（`/*!` 开头）视为其内部语句。 */
export function firstKeyword(sql) {
  let s = _stripLeadingComments(sql)
  if (s.startsWith('/*!')) {
    s = s.replace(/^\/\*!\d*\s*/, '')
  }
  const m = s.match(/^[A-Za-z]+/)
  return m ? m[0].toUpperCase() : ''
}

/** 只读路径：首关键字白名单外一律拒绝。 */
export function checkReadonly(sql) {
  const kw = firstKeyword(sql)
  if (!_READONLY_KEYWORDS.has(kw)) {
    throw new PermissionError(
      `只读连接拒绝执行 ${kw || '空'} 语句（仅允许 SELECT/SHOW/DESC/EXPLAIN/USE/SET）`)
  }
}

/** 引号/注释感知地判断语句是否存在顶层（括号深度 0 的）WHERE。 */
export function hasTopLevelWhere(sql) {
  let depth = 0
  let buf = ''
  const tokens = []
  for (const [c] of _scan(sql)) {
    if (c === '(') { depth += 1; continue }
    if (c === ')') { depth -= 1; continue }
    if (depth === 0 && (/[a-zA-Z]/.test(c) || c === '_')) {
      buf += c
    } else {
      if (buf) {
        tokens.push(buf.toUpperCase())
        buf = ''
      }
    }
  }
  if (buf) tokens.push(buf.toUpperCase())
  return tokens.includes('WHERE')
}

/** 可写路径直执行的 UPDATE / DELETE 必须带顶层 WHERE。 */
export function checkWhereForDml(sql) {
  const kw = firstKeyword(sql)
  if ((kw === 'UPDATE' || kw === 'DELETE') && !hasTopLevelWhere(sql)) {
    throw new PermissionError(`${kw} 语句缺少 WHERE 子句，已拦截（如确需全表操作请补 WHERE 1=1）`)
  }
}
