/**
 * 脱敏 API 层：handleAnalyze / handlePolicies / handleColumns。
 * server/api/masking.py 的移植（V3 去 sidecar），20 条 masking 路由中这 3 条的 handler。
 *
 * 执行时的脱敏由 core/mask.js:maskRows() 三层叠加完成，本接口只负责：
 * 按「表名 / 列名 / 列注释」匹配用户关键字 + 内置五类字段名启发式（姓名/手机号/身份证/
 * 银行卡/邮箱），给出候选字段，供面板勾选/自定义后再 POST /api/connections/save 落库。
 *
 * 依赖接缝（与 common.js 的 hooks 注入同一模式）：
 * - analyze/connectionSchemaKeys 走 core/mask.js 的 `seams` 对象（等价 Python 对
 *   mask_core.analyze_connection / connection_schema_keys 的 monkeypatch 目标）；
 * - replaceMaskingPolicies / maskedView 属 connections 模块（M2-B 移植），经
 *   registerConnectionsSeam 注入；未注入时抛 500（模块未按序装载）。
 */

import { ApiError } from '../core/errors.js'
import { MASK_TYPES, seams as maskSeams } from '../core/mask.js'
import { pool } from '../core/pool.js'
import {
  actorOf, audit, bodyOf, boolField, getConnection, requireMysql, textField,
} from './common.js'

/** connections.js（M2-B）注册点：策略整份替换 + 对外视图。 */
export const hooks = {
  replaceMaskingPolicies: null, // (connectionId, fields, {keywords, hasKeywords}) → conn
  maskedView: null,             // (conn) → 出站连接视图（connections.masked）
}

export function registerConnectionsSeam({ replaceMaskingPolicies = null, maskedView = null } = {}) {
  if (replaceMaskingPolicies) hooks.replaceMaskingPolicies = replaceMaskingPolicies
  if (maskedView) hooks.maskedView = maskedView
}

/** 测试注入接缝：等价 Python monkeypatch masking._load_column_rows。 */
export const seams = { loadColumnRows: null }

function _keywordsOf(body, info) {
  const raw = body.keywords
  if (raw === null || raw === undefined) {
    // 缺省沿用连接里已保存的关键字（方便「重新分析」）
    const saved = (info.masking || {}).keywords
    return Array.isArray(saved) ? [...saved] : []
  }
  if (!Array.isArray(raw)) {
    throw new ApiError(400, 'keywords 必须是字符串数组')
  }
  return raw.map((item) => String(item))
}

export async function handleAnalyze(query, body = null, headers = null) {
  body = bodyOf(body)
  const info = getConnection(body) // 连接不存在 → 404
  requireMysql(info)               // Redis 连接忽略脱敏 → 400 NOT_MYSQL
  const keywords = _keywordsOf(body, info)
  try {
    return await maskSeams.analyzeConnection(info, keywords)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError(400, `分析脱敏字段失败: ${message}`)
  }
}

// ---------------------------------------------------------------- 策略维护（§3.8）

/** Python repr() 的字符串形态（'...'，含 ' 时换 "..."），错误文案逐字对齐用。 */
function _repr(value) {
  if (value === null || value === undefined) return 'None'
  if (typeof value === 'string') {
    const body = value.replace(/\\/g, '\\\\')
    if (body.includes("'") && !body.includes('"')) return `"${body}"`
    return `'${body.replace(/'/g, "\\'")}'`
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/** 校验并归一化策略请求里的 fields（none/缺失=移除；非法 type/缺 table → 400）。 */
function _requestedPolicyFields(body) {
  const rawFields = body.fields
  if (!Array.isArray(rawFields)) {
    throw new ApiError(400, 'fields 必须是数组')
  }
  const requested = []
  for (const item of rawFields) {
    if (!item || typeof item !== 'object' || item instanceof Array) {
      throw new ApiError(400, 'fields 元素必须是对象')
    }
    const table = String(item.table ?? '').trim()
    const column = String(item.column ?? '').trim()
    if (!table || !column) {
      throw new ApiError(400, 'fields 元素缺少 table 或 column')
    }
    const maskType = String(item.type ?? '').trim().toLowerCase()
    if (maskType === 'none') continue // 等价于移除该字段策略
    if (!MASK_TYPES.includes(maskType)) {
      throw new ApiError(400,
        `非法脱敏类型: ${_repr(item.type)}`
        + '（可选 name/phone/idcard/bankcard/email/generic/none）')
    }
    requested.push({
      table,
      column,
      type: maskType,
      reason: String(item.reason ?? '').slice(0, 500),
    })
  }
  return requested
}

export async function handlePolicies(query, body = null, headers = null) {
  body = bodyOf(body)
  const info = getConnection(body) // 404
  requireMysql(info)               // 400 NOT_MYSQL
  const requested = _requestedPolicyFields(body)
  const hasKeywords = 'keywords' in body
  const keywords = body.keywords
  if (hasKeywords && !Array.isArray(keywords)) {
    throw new ApiError(400, 'keywords 必须是字符串数组')
  }

  // 字段存在性校验：schema 查不到就降级为不校验（库连不上不能导致存不了策略）
  let schemaKeys = null
  try {
    schemaKeys = await maskSeams.connectionSchemaKeys(info)
  } catch {
    schemaKeys = null
  }
  if (schemaKeys !== null) {
    const kept = []
    for (const field of requested) {
      const key = `${field.table.toLowerCase()}\u0000${field.column.toLowerCase()}`
      if (schemaKeys.has(key)) kept.push(field)
    }
    requested.length = 0
    requested.push(...kept)
  }

  if (!hooks.replaceMaskingPolicies) {
    throw new ApiError(500, 'connections 模块未就绪')
  }
  const conn = await hooks.replaceMaskingPolicies(
    info.id, requested,
    hasKeywords ? { keywords, hasKeywords: true } : {})
  const masking = conn.masking || {}
  audit(actorOf(headers), 'masking.policies', {
    connectionId: info.id,
    enabled: Boolean(masking.enabled),
    fields: (masking.fields || []).length,
  })
  if (!hooks.maskedView) {
    throw new ApiError(500, 'connections 模块未就绪')
  }
  return { connection: hooks.maskedView(conn) }
}

// ---------------------------------------------------------------- 策略树筛选（§3.8.1）

const _COLUMNS_LIMIT_DEFAULT = 300
const _COLUMNS_LIMIT_MAX = 1000
const _SYSTEM_SCHEMAS_SQL = "('information_schema','mysql','performance_schema','sys')"

/** 把用户关键字转成 LIKE 模式，转义 \ / % / _，用户输入 % 不会变通配符。 */
export function _likePattern(keyword) {
  const escaped = String(keyword)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
  return `%${escaped}%`
}

/** 构造唯一一条 information_schema.COLUMNS 查询（返回 [SQL, params]）。 */
export function _columnsSql(database = '', table = '', keyword = '') {
  const conditions = [`TABLE_SCHEMA NOT IN ${_SYSTEM_SCHEMAS_SQL}`]
  const params = []
  if (database) {
    conditions.push('TABLE_SCHEMA = %s')
    params.push(database)
  }
  if (table) {
    conditions.push('TABLE_NAME = %s')
    params.push(table)
  }
  if (keyword) {
    const pattern = _likePattern(keyword)
    conditions.push("(LOWER(COLUMN_NAME) LIKE LOWER(%s) ESCAPE '\\\\'"
      + " OR LOWER(TABLE_NAME) LIKE LOWER(%s) ESCAPE '\\\\'"
      + " OR LOWER(COALESCE(COLUMN_COMMENT,'')) LIKE LOWER(%s) ESCAPE '\\\\')")
    params.push(pattern, pattern, pattern)
  }
  const sql = 'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, COLUMN_COMMENT '
    + 'FROM information_schema.COLUMNS WHERE ' + conditions.join(' AND ')
    + ' ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME'
  return [sql, params]
}

/** 执行列元数据查询（单条 SQL，不取任何数据行、不做脱敏计算）。 */
async function _loadColumnRows(info, database, table, keyword) {
  const [sql, params] = _columnsSql(database, table, keyword)
  return pool.runWithRetry(info.id || '__draft__', info, '', async (conn) => {
    const [rows] = await conn.query(sql, params)
    return rows
  })
}

/** connection.masking.fields → Map{(table_lower, column_lower): {table, column, policy}}。 */
function _policyMap(info) {
  const result = new Map()
  const masking = info.masking || {}
  for (const field of masking.fields || []) {
    if (!field || typeof field !== 'object' || field instanceof Array) continue
    const table = String(field.table ?? '').trim()
    const column = String(field.column ?? '').trim()
    if (!table || !column) continue
    let maskType = String(field.type ?? 'generic').trim().toLowerCase()
    if (!MASK_TYPES.includes(maskType)) maskType = 'generic'
    const policy = {
      type: maskType,
      mandatory: Boolean(field.mandatory),
      reason: String(field.reason ?? ''),
    }
    const key = `${table.toLowerCase()}\u0000${column.toLowerCase()}`
    const existing = result.get(key)
    // 同一列多条策略时强制项优先（正常的 fields 已去重，这里兜底）
    if (!existing || (policy.mandatory && !existing.policy.mandatory)) {
      result.set(key, { table, column, policy })
    }
  }
  return result
}

/**
 * schema 里已不存在的策略残留（onlyMasked 时返回，inSchema:false）。
 * database 过滤时无法判定残留字段属于哪个库 → 不返回（避免张冠李戴）；
 * keyword / table 过滤按残留字段自身的 table/column 匹配。
 */
function _missingPolicyColumns(policies, seen, keyword, tableFilter, databaseFilter) {
  if (databaseFilter) return []
  const keywordLower = keyword.toLowerCase()
  const tableLower = tableFilter.toLowerCase()
  const missing = []
  for (const [key, item] of policies) {
    if (seen.has(key)) continue
    const { table, column } = item
    if (tableLower && table.toLowerCase() !== tableLower) continue
    if (keywordLower && !table.toLowerCase().includes(keywordLower)
      && !column.toLowerCase().includes(keywordLower)) {
      continue
    }
    missing.push({
      database: '',
      table,
      column,
      dataType: '',
      comment: '',
      policy: { ...item.policy },
      inSchema: false,
    })
  }
  return missing
}

/** 连接级批量列查询（策略树筛选用，与懒加载展开状态无关）。 */
export async function handleColumns(query, body = null, headers = null) {
  const params = query || {}
  const info = getConnection(params) // 404
  requireMysql(info)                 // 400 NOT_MYSQL
  const keyword = textField(params, 'keyword', '', 'keyword').trim()
  const onlyMasked = boolField(params, 'onlyMasked', false)
  const database = textField(params, 'database', '', 'database').trim()
  const table = textField(params, 'table', '', 'table').trim()
  const rawLimit = textField(params, 'limit', '', 'limit').trim()
  let limit
  if (rawLimit) {
    // Python int(raw_limit)：允许正负号；非整数 → 400
    if (!/^[+-]?\d+$/.test(rawLimit)) {
      throw new ApiError(400, `limit 必须是整数: ${_repr(rawLimit)}`)
    }
    limit = Math.trunc(Number(rawLimit))
    limit = Math.max(1, Math.min(limit, _COLUMNS_LIMIT_MAX))
  } else {
    limit = _COLUMNS_LIMIT_DEFAULT
  }

  const policies = _policyMap(info)
  let rows
  try {
    rows = await (seams.loadColumnRows ?? _loadColumnRows)(info, database, table, keyword)
  } catch (error) {
    if (error instanceof ApiError) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiError(400, `读取表结构失败: ${message}`)
  }

  const columns = []
  const seen = new Set()
  for (const row of rows) {
    const databaseName = String(row[0] ?? '')
    const tableName = String(row[1] ?? '')
    const columnName = String(row[2] ?? '')
    const key = `${tableName.toLowerCase()}\u0000${columnName.toLowerCase()}`
    seen.add(key)
    const policyItem = policies.get(key)
    if (onlyMasked && policyItem === undefined) continue
    columns.push({
      database: databaseName,
      table: tableName,
      column: columnName,
      dataType: String(row[3] ?? ''),
      comment: String(row[4] ?? ''),
      policy: policyItem ? { ...policyItem.policy } : null,
      inSchema: true,
    })
  }

  if (onlyMasked) {
    columns.push(..._missingPolicyColumns(policies, seen, keyword, table, database))
  }

  columns.sort((a, b) => {
    const ka = [a.database.toLowerCase(), a.table.toLowerCase(), a.column.toLowerCase()]
    const kb = [b.database.toLowerCase(), b.table.toLowerCase(), b.column.toLowerCase()]
    for (let i = 0; i < 3; i++) {
      if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1
    }
    return 0
  })
  const total = columns.length
  const truncated = total > limit
  return { columns: columns.slice(0, limit), total, truncated }
}
