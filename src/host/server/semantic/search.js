/**
 * 语义层检索：LIKE + 结构化打分（不依赖分词/FTS，计划 §12 风险 12）
 * server/semantic/search.py 的逐函数移植（V3 去 sidecar）。
 *
 * - token 全部命中（AND，case-insensitive LIKE，% _ \ 转义）；
 * - 打分：表名精确 100 > 术语精确 80 > 标题 40 > 样例问题 30 > 正文 10，跨 token 累加；
 * - domain / kind 过滤；snippet ≤ snippetChars（默认 1200）；每 section 一条命中。
 */

const LIKE_ESCAPE_RE = /[\\%_]/g
const WORD_SPLIT_RE = /\s+/

export const SCORE_TABLE = 100
export const SCORE_TERM = 80
export const SCORE_HEAD = 40
export const SCORE_QUESTION = 30
export const SCORE_BODY = 10

function escapeLike(token) {
  return '%' + token.replace(LIKE_ESCAPE_RE, (m) => '\\' + m) + '%'
}

export function tokensOf(q) {
  return String(q || '').trim().split(WORD_SPLIT_RE).filter((t) => t).map((t) => t.toLowerCase())
}

/** file 过滤的 LIKE 尾串：`%/xxx`（匹配 `domain/xxx` 相对路径）。 */
function fileLikeSuffix(file) {
  return '%/' + String(file).replace(LIKE_ESCAPE_RE, (m) => '\\' + m)
}

/** conn 是 semantic-index.js 的模块级连接（node:sqlite；行是列名对象）。
 * Python 行是元组，这里 SELECT 起别名对齐：s.domain→d0, s.file→f1, s.ord→o2 ... */
function fetchSections(conn, tokens, { domain = '', file = '', kind = '' } = {}) {
  let sql = ('SELECT s.domain AS d0, s.file AS f1, s.ord AS o2, s.anchor AS a3, '
    + 's.heading AS h4, s.level AS l5, s.line AS n6, '
    + 's.kind AS k7, s.body AS b8, s.search_text AS t9 FROM semantic_sections s')
  const where = []
  const args = []
  if (domain) {
    where.push('s.domain = ?')
    args.push(domain)
  }
  if (kind) {
    where.push('s.kind = ?')
    args.push(kind)
  }
  if (file) {
    where.push("(s.file = ? OR s.file LIKE ? ESCAPE '\\')")
    args.push(file)
    args.push(fileLikeSuffix(file))
  }
  for (const token of tokens) {
    where.push("lower(s.search_text) LIKE ? ESCAPE '\\'")
    args.push(escapeLike(token))
  }
  if (where.length) sql += ' WHERE ' + where.join(' AND ')
  sql += ' ORDER BY s.domain, s.file, s.ord'
  return conn.prepare(sql).all(...args)
}

/** (sections 的表名集合, sections 的术语集合) —— 打分用精确命中。 */
function lookupMaps(conn, domain, file) {
  const conds = []
  const args = []
  if (domain) {
    conds.push('domain = ?')
    args.push(domain)
  }
  if (file) {
    conds.push("(file = ? OR file LIKE ? ESCAPE '\\')")
    args.push(file)
    args.push('%/' + file)
  }
  const tail = conds.length ? ' WHERE ' + conds.join(' AND ') : ''
  const tables = new Map()
  for (const row of conn.prepare(
    `SELECT domain, file, ord, table_name FROM semantic_tables${tail}`).all(...args)) {
    const key = `${row.domain}|${row.file}|${row.ord}`
    if (!tables.has(key)) tables.set(key, new Set())
    tables.get(key).add(String(row.table_name).toLowerCase())
  }
  const terms = new Map()
  for (const row of conn.prepare(
    `SELECT domain, file, ord, term FROM semantic_terms${tail}`).all(...args)) {
    const key = `${row.domain}|${row.file}|${row.ord}`
    if (!terms.has(key)) terms.set(key, new Set())
    terms.get(key).add(String(row.term).trim().toLowerCase())
  }
  return [tables, terms]
}

function score(row, tokens, tables, terms) {
  const key = `${row.d0}|${row.f1}|${row.o2}`
  const heading = String(row.h4 || '').toLowerCase()
  const searchText = String(row.t9 || '').toLowerCase()
  const names = tables.get(key) || new Set()
  const termSet = terms.get(key) || new Set()
  let result = 0
  for (const token of tokens) {
    if (names.has(token)) {
      result += SCORE_TABLE
    } else if (termSet.has(token)) {
      result += SCORE_TERM
    } else if (heading.includes(token)) {
      result += SCORE_HEAD
    } else if (searchText.includes(token)) {
      result += SCORE_BODY
    }
  }
  return result
}

function snippet(searchText, tokens, maxChars) {
  const low = searchText.toLowerCase()
  let pos = -1
  for (const token of tokens) {
    const p = low.indexOf(token)
    if (p >= 0 && (pos < 0 || p < pos)) pos = p
  }
  if (pos < 0) return searchText.slice(0, maxChars)
  const start = Math.max(0, pos - 80)
  const end = Math.min(searchText.length, start + maxChars)
  const cut = searchText.slice(start, end)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < searchText.length ? '…' : ''
  return `${prefix}${cut}${suffix}`
}

/** 返回 {total, hits, truncated}; hits 按 score 降序。 */
export function search(conn, q, {
  domain = '', file = '', kind = '', limit = 8, snippetChars = 1200,
} = {}) {
  const tokens = tokensOf(q)
  limit = Math.max(1, Math.min(Number(limit) || 8, 30))
  snippetChars = Math.max(20, Math.min(Number(snippetChars) || 1200, 2000))
  if (!tokens.length) {
    return { total: 0, hits: [], truncated: false }
  }
  const [tables, terms] = lookupMaps(conn, domain, file)
  const rows = fetchSections(conn, tokens, { domain, file, kind })
  const scored = []
  for (const row of rows) {
    const value = score(row, tokens, tables, terms)
    if (value <= 0) continue
    scored.push({ score: value, row })
  }
  scored.sort((a, b) => {
    if (a.score !== b.score) return b.score - a.score
    if (a.row.d0 !== b.row.d0) return a.row.d0 < b.row.d0 ? -1 : 1
    if (a.row.f1 !== b.row.f1) return a.row.f1 < b.row.f1 ? -1 : 1
    return a.row.o2 - b.row.o2
  })
  const total = scored.length
  const hits = []
  for (const { score: value, row } of scored.slice(0, limit)) {
    hits.push({
      domain: row.d0, file: row.f1, section: row.a3, anchor: row.a3,
      ref: `${row.d0}/${row.f1}#${row.a3}`, ord: row.o2,
      title: row.h4, line: row.n6, kind: row.k7, score: value,
      snippet: snippet(row.t9, tokens, snippetChars),
    })
  }
  return { total, hits, truncated: total > hits.length }
}
