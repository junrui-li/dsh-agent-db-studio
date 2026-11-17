/**
 * 执行历史 → 语义层样例的候选提取（第 51 轮新增，需求 #2）。
 * server/semantic/distill.py 的逐函数移植（V3 去 sidecar）。
 *
 * 本模块只做**确定性**部分，**完全不碰模型**：
 * 模型调用在 Host 半片（src/host/ai.js 的 distill），因为它需要 DSH 的 llm 服务。
 *
 * 三条硬规则（都有测试守着）：
 * 1. **只收只读查询**：guard.firstKeyword(sql) 必须是 SELECT，且恰好一条语句。
 *    SHOW/DESC/EXPLAIN/SET/USE 与任何写语句一律不进候选。
 * 2. **字面量脱敏**（AGENTS.md 硬规则 4）：发往模型之前把所有字符串字面量与裸数字
 *    替换成 `?`。history 是用户本地数据，但模型调用是出站；仓库硬规则是
 *    「脱敏由后端出站处理」。
 * 3. **归一 + 计频**：空白折叠、参数化之后作为聚类键，按出现次数降序。
 */

import { firstKeyword } from '../core/guard.js'
import { splitSql } from '../core/sqlsplit.js'
import { queryAll } from '../store/db.js'
import { listDomainTables } from './store.js'

// 参与蒸馏的历史来源：panel（人在面板跑的）与 agent（模型跑的）。
// ticket/undo 是写路径的留痕，进来只会污染样例。
const _SOURCES = ['panel', 'agent']
const _MAX_LEN = 64 * 1024
const _MIN_SQL_LEN = 20
export const DEFAULT_LIMIT = 40
const _MAX_LIMIT = 100
// 排除导出类语句：读文件系统，不该成为业务样例。
const _FORBIDDEN_RE = /\b(INTO\s+OUTFILE|INTO\s+DUMPFILE|LOAD_FILE)\b/i

const _WS_RE = /\s+/g
const _IDENT_RE = /[A-Za-z_][A-Za-z0-9_$]*/g
const _TABLE_KEYWORDS = ['FROM', 'JOIN', 'STRAIGHT_JOIN']
// 表名后面出现这些词 = 后面的标识符不是别名（别名要跳过，避免误当表/破坏逗号列表）
const _RESERVED_AFTER_TABLE = new Set([
  'WHERE', 'GROUP', 'ORDER', 'LIMIT', 'HAVING', 'ON', 'USING', 'JOIN',
  'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'FULL', 'NATURAL', 'UNION',
  'SET', 'VALUES', 'AS', 'STRAIGHT_JOIN', 'FORCE', 'USE', 'IGNORE',
  'INTO', 'WINDOW', 'FOR', 'OFFSET', 'EXCEPT', 'INTERSECT', 'WHEN', 'THEN',
])
const _TOKEN_RE = /`[^`]*`|[A-Za-z_][A-Za-z0-9_$]*|\.|\(|\)|,/g

function _isIdentChar(c) {
  return /[A-Za-z0-9_$]/.test(c)
}

/** 单遍扫描：字符串字面量与裸数字 → `?`；反引号标识符原样保留。
 *
 * 不做「占位—还原」（占位符里的数字会被数字正则二次吃掉），直接一遍扫完。
 */
function _scrub(sql) {
  const out = []
  const n = sql.length
  let i = 0
  while (i < n) {
    const c = sql[i]
    if (c === '\'' || c === '"') {
      const quote = c
      i += 1
      while (i < n) {
        if (sql[i] === '\\') {
          i += 2
          continue
        }
        if (sql[i] === quote) {
          if (i + 1 < n && sql[i + 1] === quote) {
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      out.push('?')
      continue
    }
    if (c === '`') {
      let j = i + 1
      while (j < n) {
        if (sql[j] === '`') {
          if (j + 1 < n && sql[j + 1] === '`') {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      out.push(sql.slice(i, j)) // 标识符（可能含数字）原样保留
      i = j
      continue
    }
    if (/[0-9]/.test(c)) {
      // 只吃「裸数字」：前一个字符不是标识符组成字符（避免 t2 / col_3 被切）
      const prev = i > 0 ? sql[i - 1] : ''
      if (prev && (_isIdentChar(prev) || prev === '.' || prev === '_')) {
        out.push(c)
        i += 1
        continue
      }
      let j = i
      while (j < n && (/[0-9]/.test(sql[j]) || sql[j] === '.')) j += 1
      const nxt = j < n ? sql[j] : ''
      if (nxt && (_isIdentChar(nxt) || nxt === '_')) {
        out.push(sql.slice(i, j)) // 后面还接着标识符字符 → 不是裸数字
      } else {
        out.push('?')
      }
      i = j
      continue
    }
    out.push(c)
    i += 1
  }
  return out.join('')
}

/** 公共入口：去注释 → 字面量脱敏 → 空白归一。 */
export function scrubSql(sql) {
  let text = stripComments(sql || '')
  text = _scrub(text)
  return text.replace(_WS_RE, ' ').trim()
}

/** 去掉 -- / # 行注释与块注释（复用 sqlsplit 的扫描规则，但不改字符串）。 */
export function stripComments(sql) {
  const out = []
  const text = sql || ''
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    const nxt = i + 1 < n ? text[i + 1] : ''
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c
      out.push(c)
      i += 1
      while (i < n) {
        out.push(text[i])
        if (text[i] === '\\' && quote !== '`') {
          i += 1
          if (i < n) {
            out.push(text[i])
          }
          i += 1
          continue
        }
        if (text[i] === quote) {
          if (i + 1 < n && text[i + 1] === quote) {
            out.push(text[i + 1])
            i += 2
            continue
          }
          i += 1
          break
        }
        i += 1
      }
      continue
    }
    if ((c === '-' && nxt === '-') || c === '#') {
      const j = text.indexOf('\n', i)
      i = j === -1 ? n : j
      continue
    }
    if (c === '/' && nxt === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 2
      continue
    }
    out.push(c)
    i += 1
  }
  return out.join('')
}

/** 聚类键：脱敏 + 归一 + 去掉 LIMIT 之后的部分（分页参数不该拆成两组）。 */
export function clusterKey(sql) {
  const text = scrubSql(sql).toLowerCase()
  return text.replace(/\s+limit\s+\?.*$/, '').trim()
}

/** 提取 SQL 涉及的表名（保持首次出现顺序，去重）。
 *
 * 用于蒸馏的**严格域过滤**（第 53 轮）：提取不准会把跨域 SQL 放进本域样例，
 * 或把本域 SQL 误伤掉。所以不能再用一行正则，改为在 strip_comments 之后的
 * token 流上识别表引用，覆盖：
 *
 * - ``FROM t`` / ``JOIN t AS alias`` / ``FROM a, b, c``（逗号列表）
 * - ``FROM db.t``（带库名限定，取 ``db.t`` 完整小写形式）
 * - ``FROM (SELECT ...)``（子查询，递归进去）
 * - ``FROM t alias``（裸别名：下一个 token 是普通标识符就跳过它，别误当表）
 *
 * 不覆盖（有测试守着）：
 * - ``FROM (subquery) alias``：括号开头的裸别名会误报为表名 —— 子查询带别名
 *   需要真正的括号配平解析，蒸馏场景用带别名的子查询极少，先记录为已知边界；
 * - 派生表列引用 ``alias.col`` 不算表。
 */
export function tablesOf(sql) {
  const text = stripComments(sql || '')
  // 按位置顺序合并字符串占位：字符串里出现 FROM t 这种会误导提取器，先挖掉。
  const masked = []
  const n = text.length
  let i = 0
  while (i < n) {
    const c = text[i]
    if (c === '\'' || c === '"') {
      let j = i + 1
      while (j < n) {
        if (text[j] === '\\') {
          j += 2
          continue
        }
        if (text[j] === c) {
          if (j + 1 < n && text[j + 1] === c) {
            j += 2
            continue
          }
          j += 1
          break
        }
        j += 1
      }
      masked.push('\x00')
      i = j
      continue
    }
    masked.push(c)
    i += 1
  }
  const maskedText = masked.join('')

  const seen = new Set()
  const out = []
  // token 流保留 `.` 和反引号标识符：限定名 `db.table` 与 `` `weird-t` `` 的
  // 判断都依赖它们（_IDENT_RE 不匹配这两类，不显式保留会退化成碎片 token）。
  const upper = [...maskedText.matchAll(_TOKEN_RE)].map((m) => m[0].toUpperCase())
  const rawTokens = [...maskedText.matchAll(_TOKEN_RE)].map((m) => m[0])
  let index = 0
  while (index < upper.length) {
    const word = upper[index]
    if (_TABLE_KEYWORDS.includes(word)) {
      index += 1
      // 连续吃表引用：FROM a, b JOIN c；括号开头的子查询也进。
      while (index < upper.length) {
        const token = upper[index]
        if (token === '(') {
          index += 1
          // 子查询开头：`(SELECT ...` / `(VALUES ...` 不是表名。
          // 跳过内层 SELECT 的整个投影：只跳到内层 FROM/结束为止。
          let scan = index
          while (scan < upper.length && !['FROM', 'WHERE', 'GROUP', 'ORDER', 'LIMIT',
            'VALUES', 'ON', 'JOIN', ')'].includes(upper[scan])) {
            scan += 1
          }
          if (scan < upper.length && upper[scan] === 'FROM') {
            index = scan + 1 // 从内层 FROM 的下一 token 继续
          } else {
            index = scan // VALUES/空括号等：停在这
          }
          continue
        }
        if (_RESERVED_AFTER_TABLE.has(token) || _TABLE_KEYWORDS.includes(token)
          || token === '.' || token === ')') {
          if (_TABLE_KEYWORDS.includes(token)) {
            break // 交给外层 while 处理下一个 JOIN
          }
          break
        }
        // 这里是表引用本身
        let name = rawTokens[index]
        if (index + 1 < upper.length && upper[index + 1] === '.') {
          if (index + 2 < upper.length && upper[index + 2] !== '.'
            && !_RESERVED_AFTER_TABLE.has(upper[index + 2])) {
            // `` `db`.`t` `` → db.t：拼接时把各段的反引号剥掉
            name = rawTokens[index].replace(/`/g, '') + '.'
              + rawTokens[index + 2].replace(/`/g, '')
            index += 2
          }
        }
        name = name.replace(/`/g, '') // `` `weird-t` `` → weird-t
        if (!seen.has(name.toLowerCase())) {
          seen.add(name.toLowerCase())
          out.push(name)
        }
        // 跳过裸别名：`FROM t alias`（下一个 token 不是保留字/逗号/括号）
        if (index + 1 < upper.length) {
          const nxt = upper[index + 1]
          if (!_RESERVED_AFTER_TABLE.has(nxt) && !_TABLE_KEYWORDS.includes(nxt)
            && nxt !== ',' && nxt !== '(') {
            index += 1 // 吃掉别名
          }
        }
        index += 1
        if (index >= upper.length) {
          break
        }
        const nextToken = upper[index]
        if (nextToken === ',') {
          index += 1
          continue // 逗号列表：继续吃下一张表
        }
        break // 其它情况退出内层循环，外层继续找下一个 FROM/JOIN
      }
    } else {
      index += 1
    }
  }
  return out
}

/** 单条历史是否可进候选 → [ok, reason]。 */
export function isCandidate(row) {
  if ((row.status || null) !== 'ok') return [false, 'status']
  if ((row.kind || 'query') !== 'query') return [false, 'kind']
  if (!_SOURCES.includes(row.source || 'panel')) return [false, 'source']
  const sql = row.sql || ''
  if (sql.trim().length < _MIN_SQL_LEN || sql.length > _MAX_LEN) return [false, 'length']
  if (_FORBIDDEN_RE.test(sql)) return [false, 'forbidden']
  const statements = splitSql(sql)
  if (statements.length !== 1) return [false, 'multi']
  if (firstKeyword(sql) !== 'SELECT') return [false, 'not_select']
  return [true, '']
}

function _timeBound(raw, end = false) {
  /** YYYY-MM-DD → 当天 00:00:00 / 23:59:59；完整时间串原样返回。 */
  const value = String(raw || '').trim()
  if (value.length === 10 && value[4] === '-' && value[7] === '-') {
    return `${value} ${end ? '23:59:59' : '00:00:00'}`
  }
  return value
}

function _localStamp(d) {
  const p = (x) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function _defaultWindow() {
  /** 默认窗口：最近 24 小时。 */
  const end = new Date()
  const start = new Date(end.getTime() - 24 * 3600 * 1000)
  return [_localStamp(start), _localStamp(end)]
}

/** 从 history 提取候选。返回 {scanned, deduped, window, domainFiltered, candidates}。
 *
 * 域过滤（第 53 轮收紧为严格子集，用户裁决）：
 * SQL 涉及的**每一张表**都必须属于该域 —— `FROM 本域表 JOIN 其它域表` 这种
 * 跨域 SQL 不许污染本域样例（旧逻辑是「碰到 ≥1 张本域表就放行」，跨域 SQL 会漏进来）。
 * 表名不带库限定时按裸表名匹配；带库限定（`demo_db.t`）时同时用
 * `demo_db.t` 与裸 `t` 两种形式比对，避免限定名写法被误伤。
 */
export function collect({
  timeFrom = '', timeTo = '', connectionId = '', domain = '', limit = DEFAULT_LIMIT,
} = {}) {
  const [defaultFrom, defaultTo] = _defaultWindow()
  const start = _timeBound(timeFrom) || defaultFrom
  const end = _timeBound(timeTo, true) || defaultTo
  limit = Math.max(1, Math.min(Number(limit) || DEFAULT_LIMIT, _MAX_LIMIT))

  const clauses = ['time >= ?', 'time <= ?']
  const args = [start, end]
  if (connectionId) {
    clauses.push('connection_id = ?')
    args.push(connectionId)
  }
  const rows = queryAll(
    `SELECT * FROM history WHERE ${clauses.join(' AND ')} ORDER BY seq DESC`, args)

  let domainTables = new Set()
  if (domain) {
    try {
      domainTables = new Set(
        listDomainTables(domain).map((row) => String(row.table).toLowerCase()))
    } catch {
      domainTables = new Set() // 域不存在时不过滤（保持旧行为）
    }
  }

  const inDomain = (sqlTables) => {
    if (!domainTables.size) return true
    for (const name of sqlTables) {
      const low = name.toLowerCase()
      if (domainTables.has(low)) continue
      const bare = low.includes('.') ? low.split('.').pop() : low
      if (domainTables.has(bare)) continue
      return false // 有一张表不属于本域 → 整条丢弃
    }
    return true
  }

  const groups = new Map()
  let scanned = 0
  let rejectedByDomain = 0
  for (const row of rows) {
    const [ok] = isCandidate(row)
    if (!ok) continue
    const sql = row.sql || ''
    const tables = tablesOf(sql)
    if (domainTables.size && !inDomain(tables)) {
      rejectedByDomain += 1
      continue
    }
    scanned += 1
    const key = clusterKey(sql)
    if (!key) continue
    const entry = groups.get(key)
    if (entry === undefined) {
      groups.set(key, {
        sqlScrubbed: scrubSql(sql),
        count: 1,
        lastSeen: row.time || '',
        connectionIds: [row.connection_id || ''],
        databases: [row.database_name || ''],
        tables,
        purpose: (row.purpose || '').slice(0, 120),
        historyIds: [row.id || ''],
      })
    } else {
      entry.count += 1
      if ((row.time || '') > entry.lastSeen) entry.lastSeen = row.time || ''
      for (const [field, column] of [['connectionIds', 'connection_id'],
        ['databases', 'database_name']]) {
        const value = row[column] || ''
        if (value && !entry[field].includes(value)) entry[field].push(value)
      }
      if (!entry.purpose && row.purpose) entry.purpose = row.purpose.slice(0, 120)
      entry.historyIds.push(row.id || '')
    }
  }

  const candidates = [...groups.values()].sort((a, b) => {
    if (a.count !== b.count) return b.count - a.count
    if (a.lastSeen !== b.lastSeen) return a.lastSeen < b.lastSeen ? -1 : 1
    return 0
  })
  for (const item of candidates) item.historyIds = item.historyIds.slice(0, 20)
  return {
    scanned,
    deduped: candidates.length,
    window: { from: start, to: end },
    domainFiltered: domain ? rejectedByDomain : null,
    candidates: candidates.slice(0, limit),
  }
}

/** 按字符预算裁剪候选（防 max-tokens 截断），保持频次降序。 */
export function budget(candidates, maxChars = 12000) {
  const out = []
  let used = 0
  for (const item of candidates || []) {
    const size = item.sqlScrubbed.length
    if (out.length && used + size > maxChars) break
    out.push(item)
    used += size
  }
  return out
}
