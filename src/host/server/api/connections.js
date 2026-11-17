/**
 * 连接管理（/api/connections）：server/api/connections.py 的移植（V3 去 sidecar）。
 *
 * 存储：SQLite dbs.db（store/db.js），密码明文（本地单用户工具的取舍，与旧版一致）。
 * 硬规则：读接口一律只回 hasPassword，绝不回 password；写接口才允许带 password。
 * 绝不在持有 DB 事务时做 MySQL 网络 IO（脱敏分析在事务外完成）。
 *
 * 与 Python 版的差异：
 * - 懒 import core/mask.js：M2-A 并行移植中，保存路径按需动态 import（失败按
 *   Python 的 try/except 降级语义处理——分析失败不阻塞保存）。
 * - 连接测试的 MySQL 路径走 pool.borrow/giveBack(broken=true)（Python 是
 *   pool._connect + close 直连直关；JS 池对象没有裸建连接接缝，借还语义等价，
 *   测试同样通过覆写 pool.borrow 注入假连接）。Redis 路径懒 import api/redis.js
 *   （M2-C），未就绪时回连接失败的业务结果。
 * - UPSERT 在本模块内拼行（等价 Python connections.py 里对 db._conn_item_to_row /
 *   db._CONN_COLS 的直接复用），经 db.transaction 单事务执行。
 */

import * as config from '../core/config.js'
import * as db from '../store/db.js'
import { ApiError } from '../core/errors.js'
import { actorOf, audit, ms, now, registerRequireConnection, startClock } from './common.js'
import { pool } from '../core/pool.js'

const _KINDS = new Set(['mysql', 'redis'])
const _MASKING_SUMMARY_KEYS = ['tables', 'columns', 'masked']
const _MASKING_TYPES = new Set(['name', 'phone', 'idcard', 'bankcard', 'email', 'generic'])

/** mask.js 加载注入点（与 common.js hooks 同款接缝）：测试注入假模块用；
 * 默认动态 import（M2-A 的 core/mask.js）。 */
export const maskHooks = { loader: null }

function _loadMask() {
  if (maskHooks.loader) return maskHooks.loader()
  return import('../core/mask.js')
}

// ---------------------------------------------------------------- 存储

/** shim（同名，测试多处调用）：委托 db 层，按 position 返回 camelCase 项。 */
export function loadConnections() {
  return db.loadConnections()
}

/** shim：委托 db 层整表替换（单事务，列表顺序即 position）。 */
export function saveConnections(connections) {
  db.saveConnections(connections)
}

/** /health 用：连接数。 */
export function countConnections() {
  return db.countConnections()
}

export function findConnection(connectionId) {
  if (typeof connectionId !== 'string' || !connectionId) return null
  return loadConnections().find((conn) => conn.id === connectionId) ?? null
}

export function requireConnection(connectionId) {
  const conn = findConnection(connectionId)
  if (conn === null) {
    throw new ApiError(404, `连接不存在: ${connectionId}`, 'CONNECTION_NOT_FOUND')
  }
  return conn
}

// common.js hooks 注入点（getConnection 经此回调 requireConnection）
registerRequireConnection(requireConnection)

// ---------------------------------------------------------------- 归一化 / 脱敏

function _text(value, label) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new ApiError(400, `${label} 必须是字符串`)
}

function _intField(source, key, fallback, label, low, high) {
  const raw = source[key]
  if (raw === null || raw === undefined || raw === '') return Math.trunc(Number(fallback))
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ApiError(400, `${label} 必须是整数: ${JSON.stringify(raw)}`)
  }
  if (parsed < low || parsed > high) {
    throw new ApiError(400, `${label} 超出范围 [${low}, ${high}]: ${parsed}`)
  }
  return parsed
}

// ---------------------------------------------------------------- 脱敏配置（契约 §3.7）

function _defaultMasking() {
  return {
    enabled: false, keywords: [], fields: [],
    analyzedAt: null, summary: { tables: 0, columns: 0, masked: 0 },
  }
}

function _sanitizeKeywords(raw) {
  const keywords = []
  const seen = new Set()
  if (raw instanceof Array) {
    for (const item of raw) {
      if (typeof item !== 'string') continue
      const text = item.trim().slice(0, 50)
      const key = text.toLowerCase()
      if (!text || seen.has(key)) continue
      seen.add(key)
      keywords.push(text)
      if (keywords.length >= 50) break
    }
  }
  return keywords
}

function _sanitizeSummary(raw) {
  const summary = { tables: 0, columns: 0, masked: 0 }
  if (raw && typeof raw === 'object' && !(raw instanceof Array)) {
    for (const key of _MASKING_SUMMARY_KEYS) {
      const parsed = Number(raw[key] ?? 0)
      summary[key] = Math.max(Number.isFinite(parsed) ? Math.trunc(parsed) : 0, 0)
    }
  }
  return summary
}

function _sanitizeMaskingField(raw, keepMandatory = false) {
  if (!raw || typeof raw !== 'object' || raw instanceof Array) return null
  const table = String(raw.table ?? '').trim().slice(0, 128)
  const column = String(raw.column ?? '').trim().slice(0, 128)
  if (!table || !column) return null
  let maskType = String(raw.type ?? 'generic').trim().toLowerCase()
  if (!_MASKING_TYPES.has(maskType)) maskType = 'generic'
  return {
    table,
    column,
    type: maskType,
    // 契约：mandatory 只能由后端写；前端传来的强制标记一律忽略
    mandatory: keepMandatory ? Boolean(raw.mandatory) : false,
    reason: String(raw.reason ?? '').slice(0, 500),
  }
}

function _fieldKey(table, column) {
  return `${String(table ?? '')}\u0000${String(column ?? '')}`.toLowerCase()
}

function _dedupeFields(fields) {
  const result = []
  const seen = new Set()
  for (const field of fields) {
    if (!field || typeof field !== 'object' || field instanceof Array) continue
    const key = _fieldKey(field.table, field.column)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(field)
  }
  return result
}

function _copyMasking(masking) {
  // 拷贝服务端已保存的 masking（保留 mandatory —— 那是后端写入的保护）。
  if (!masking || typeof masking !== 'object' || masking instanceof Array) {
    return _defaultMasking()
  }
  const fields = (masking.fields ?? [])
    .map((field) => _sanitizeMaskingField(field, true))
    .filter(Boolean)
  const analyzedAt = masking.analyzedAt
  return {
    enabled: Boolean(masking.enabled),
    keywords: _sanitizeKeywords(masking.keywords),
    fields: _dedupeFields(fields),
    analyzedAt: typeof analyzedAt === 'string' ? analyzedAt : null,
    summary: _sanitizeSummary(masking.summary),
  }
}

function _sanitizeMasking(raw, fallback) {
  // 前端提交的 masking 归一化；未提交的字段沿用已存配置（避免误清策略/关键字）。
  if (!raw || typeof raw !== 'object' || raw instanceof Array) {
    return _copyMasking(fallback) // 没传 masking：保留服务端已有配置
  }
  const base = fallback && typeof fallback === 'object' && !(fallback instanceof Array)
    ? _copyMasking(fallback)
    : _defaultMasking()

  let enabled
  if ('enabled' in raw) {
    const value = raw.enabled
    enabled = typeof value === 'string'
      ? ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase())
      : Boolean(value)
  } else {
    enabled = base.enabled
  }

  const keywords = 'keywords' in raw ? _sanitizeKeywords(raw.keywords) : base.keywords

  const fields = (raw.fields ?? []).map((field) => _sanitizeMaskingField(field)).filter(Boolean)

  let analyzedAt = raw.analyzedAt
  if (typeof analyzedAt !== 'string') analyzedAt = base.analyzedAt
  let summary = raw.summary
  if (summary === null || summary === undefined) summary = base.summary
  return {
    enabled: Boolean(enabled),
    keywords,
    fields: _dedupeFields(fields),
    analyzedAt,
    summary: _sanitizeSummary(summary),
  }
}

function _storedMandatoryFields(masking) {
  // 已落库的强制保护项（mandatory 只能由后端写）。
  return (masking.fields ?? [])
    .filter((field) => field.mandatory)
    .map((field) => ({ ...field, mandatory: true }))
}

function _mergeMandatoryFields(fields, storedMandatory) {
  // 把已存储的强制项补回/纠正到 fields（契约 §3.8）。
  const mandatoryMap = new Map()
  for (const field of storedMandatory) {
    mandatoryMap.set(_fieldKey(field.table, field.column), field)
  }
  const result = []
  const seen = new Set()
  for (const field of fields ?? []) {
    if (!field || typeof field !== 'object' || field instanceof Array) continue
    const key = _fieldKey(field.table, field.column)
    if (mandatoryMap.has(key)) {
      if (!seen.has(key)) {
        result.push({ ...mandatoryMap.get(key) })
        seen.add(key)
      }
      continue
    }
    if (seen.has(key)) continue
    result.push(field)
    seen.add(key)
  }
  for (const [key, field] of mandatoryMap.entries()) {
    if (!seen.has(key)) {
      result.push({ ...field })
      seen.add(key)
    }
  }
  return result
}

function _mergeMandatorySets(primary, extra) {
  // 合并两组强制项（按 table+column 去重）；primary 优先（已存强制项的类型/理由不变）。
  const result = primary.map((field) => ({ ...field }))
  const seen = new Set(result.map((field) => _fieldKey(field.table, field.column)))
  for (const field of extra ?? []) {
    const key = _fieldKey(field.table, field.column)
    if (seen.has(key)) continue
    result.push({ ...field })
    seen.add(key)
  }
  return result
}

async function _analyzeMasking(conn, keywords) {
  // 当前 schema 分析出的内置 mandatory（含 email）；失败返回 null 供调用方降级。
  try {
    const maskModule = await _loadMask()
    const analysis = await maskModule.analyzeConnection(conn, keywords)
    if (!analysis || typeof analysis !== 'object' || analysis instanceof Array) return null
    const mandatory = []
    for (const candidate of analysis.candidates ?? []) {
      if (!candidate.mandatory) continue
      const field = _sanitizeMaskingField(candidate, true)
      if (field) mandatory.push(field)
    }
    return { mandatory, summary: _sanitizeSummary(analysis.summary), analyzedAt: now() }
  } catch {
    return null
  }
}

async function _finalizeMasking(conn, previous, { hasFields = false } = {}) {
  // 按契约 §3.8 + 内置类型迁移合并保存语义（不再无条件重新分析，避免覆盖人工策略）。
  if ((conn.kind || 'mysql') !== 'mysql') {
    // Redis：忽略脱敏，强制 enabled=false 且不保存策略
    const masking = _copyMasking(conn.masking)
    masking.enabled = false
    masking.fields = []
    masking.keywords = []
    return masking
  }

  const previousMasking = previous && typeof previous === 'object' && !(previous instanceof Array)
    ? _copyMasking(previous.masking)
    : _defaultMasking()
  const current = _copyMasking(conn.masking)
  const storedMandatory = _storedMandatoryFields(previousMasking)
  const enabled = current.enabled
  const keywords = current.keywords
  // 提交了 fields 就用提交值，否则沿用已存策略（只改 enabled / 没带 masking 都不能丢策略）
  const baseFields = hasFields ? current.fields : previousMasking.fields
  let analyzedAt = previousMasking.analyzedAt
  const summary = { ...previousMasking.summary }

  let fields
  if (enabled && !baseFields.length && !previousMasking.fields.length) {
    // 首次开启便利路径：自动分析一次
    const analyzed = await _analyzeMasking(conn, keywords)
    if (analyzed !== null) {
      fields = _mergeMandatoryFields(analyzed.mandatory, storedMandatory)
      Object.assign(summary, analyzed.summary)
      analyzedAt = analyzed.analyzedAt
    } else {
      fields = _mergeMandatoryFields([], storedMandatory)
    }
  } else {
    let mandatory = storedMandatory
    if (enabled && previousMasking.fields.length) {
      // 迁移：已有策略时也合并当前分析出的内置 mandatory（email 等新类型）
      const analyzed = await _analyzeMasking(conn, keywords)
      if (analyzed !== null) {
        mandatory = _mergeMandatorySets(storedMandatory, analyzed.mandatory)
      }
    }
    fields = _mergeMandatoryFields(baseFields, mandatory)
  }

  summary.masked = fields.length
  return {
    enabled: Boolean(enabled),
    keywords,
    fields,
    analyzedAt,
    summary,
  }
}

function _publicMasking(conn) {
  // 读接口返回的 masking 视图（Redis 连接忽略：回 disabled 空配置）。
  if ((conn.kind || 'mysql') !== 'mysql') return _defaultMasking()
  return _copyMasking(conn.masking)
}

function _dropPools(connectionId) {
  // 连接配置变了，旧连接池整体作废。
  pool.dropPool(connectionId)
  // M2-C 已接线：Redis 池一并作废（core/redis-pool.js）
  poolDropRedis(connectionId)
}

/** redis_pool.drop_pool 等价物：动态 import，未就绪时静默（M2-C 兜底）。 */
async function poolDropRedis(cid) {
  try {
    const mod = await import('../core/redis-pool.js')
    mod.redisPool.dropPool(cid)
  } catch { /* redis-pool 未就绪（M2-C 前）忽略 */ }
}

// ---------------------------------------------------------------- 出站视图

export function masked(conn) {
  // 读接口返回的连接视图：字段白名单，password 永不出现（出站脱敏规则）。
  return {
    id: conn.id ?? '',
    name: conn.name ?? '',
    kind: conn.kind || 'mysql',
    host: conn.host ?? '',
    port: Math.trunc(Number(conn.port ?? 0)) || 0,
    user: conn.user ?? '',
    database: conn.database ?? '',
    readonly: Boolean(conn.readonly),
    timeout: Math.trunc(Number(conn.timeout ?? 0)) || config.defaultTimeout(),
    maxRows: Math.trunc(Number(conn.maxRows ?? 0)) || config.defaultMaxRows(),
    hasPassword: Boolean(conn.password),
    createdAt: conn.createdAt ?? '',
    masking: _publicMasking(conn),
  }
}

// ---------------------------------------------------------------- 归一化（请求 → 存储）

function _normalize(raw, existing = null) {
  // 把请求里的 connection 归一化成内部存储结构（校验 + 补默认值）。
  if (!raw || typeof raw !== 'object' || raw instanceof Array) {
    throw new ApiError(400, 'connection 必须是 JSON 对象')
  }
  const conn = { ...(existing ?? {}) }

  const name = _text(raw.name !== undefined ? raw.name : conn.name, 'name').trim()
  if (!name) throw new ApiError(400, 'name 不能为空')
  conn.name = name

  let kind = _text(raw.kind !== undefined ? raw.kind : (conn.kind || 'mysql'), 'kind')
    .trim().toLowerCase() || 'mysql'
  if (!_KINDS.has(kind)) {
    throw new ApiError(400, `kind 只能是 mysql 或 redis: ${JSON.stringify(kind)}`)
  }
  conn.kind = kind

  const host = _text(raw.host !== undefined ? raw.host : conn.host, 'host').trim()
  if (!host) throw new ApiError(400, 'host 不能为空')
  conn.host = host

  const portDefault = kind === 'redis' ? 6379 : 3306
  conn.port = _intField(raw, 'port', conn.port || portDefault, 'port', 1, 65535)
  conn.user = _text(raw.user !== undefined ? raw.user : (conn.user ?? ''), 'user')

  let database = _text(
    raw.database !== undefined ? raw.database : (conn.database ?? ''), 'database').trim()
  if (kind === 'redis' && database) {
    // Redis 的 database 是 db 编号，统一存字符串（契约 Connection.database 为 string）
    const dbNumber = Number(database)
    if (!Number.isFinite(dbNumber) || !Number.isInteger(dbNumber)) {
      throw new ApiError(400, `Redis 的 database 必须是 db 编号: ${JSON.stringify(database)}`)
    }
    if (dbNumber < 0) throw new ApiError(400, `Redis 的 database 不能为负数: ${dbNumber}`)
    database = String(dbNumber)
  }
  conn.database = database

  let readonlyFlag = raw.readonly !== undefined ? raw.readonly : (conn.readonly ?? false)
  if (typeof readonlyFlag !== 'boolean') readonlyFlag = Boolean(readonlyFlag) // 容忍 0/1
  conn.readonly = readonlyFlag

  conn.timeout = _intField(
    raw, 'timeout', conn.timeout || config.defaultTimeout(), 'timeout', 1, 3600)
  conn.maxRows = _intField(
    raw, 'maxRows', conn.maxRows || config.defaultMaxRows(), 'maxRows', 1, 100000)

  // 密码：读接口永远不回密码，所以编辑表单回传空密码时必须视为「不修改」；
  // 真要清空密码时显式传 clearPassword: true。
  if (raw.clearPassword === true) {
    conn.password = ''
  } else if ('password' in raw) {
    const password = raw.password
    if (password !== null && password !== undefined && typeof password !== 'string') {
      throw new ApiError(400, 'password 必须是字符串')
    }
    if (password) {
      conn.password = password
    } else if (existing === null) {
      conn.password = ''
    }
  }
  if (conn.password === undefined) conn.password = ''

  // 脱敏配置：前端可传 enabled/keywords/fields；强制项由保存时后端分析补回
  if ('masking' in raw) {
    conn.masking = _sanitizeMasking(raw.masking, conn.masking)
  } else if (!('masking' in conn)) {
    conn.masking = _defaultMasking()
  }
  return conn
}

// ---------------------------------------------------------------- UPSERT（存储行）

// 与 store/db.js 的 _connItemToRow / _CONN_COLS 同构（Python 版 connections.py
// 也直接复用 db 层的行编码）；here 复制一份以免 store 层开非必要接口。
const _CONN_COLS = ['id', 'position', 'name', 'kind', 'host', 'port', 'user', 'password',
  'database_name', 'readonly', 'timeout', 'max_rows', 'created_at', 'masking_json']

function _connItemToRow(item, position) {
  const masking = item.masking
  const kind = item.kind === 'mysql' || item.kind === 'redis' ? item.kind : 'mysql'
  return [
    String(item.id ?? ''), position, String(item.name ?? ''), kind,
    String(item.host ?? ''), Math.trunc(Number(item.port ?? 0)) || 0,
    String(item.user ?? ''), String(item.password ?? ''),
    String(item.database ?? ''), item.readonly ? 1 : 0,
    Math.trunc(Number(item.timeout ?? 0)) || 0,
    Math.trunc(Number(item.maxRows ?? 0)) || 0,
    String(item.createdAt ?? ''),
    masking && typeof masking === 'object' && !(masking instanceof Array)
      ? JSON.stringify(masking) : null,
  ]
}

/** 单行 UPSERT（等价 Python 的 db.transaction() + _upsert_row）。
 * position：更新保持已存行的位置（行缺失回 404），新增追加到末尾。 */
function _upsertRow(connObj, existingId) {
  db.transaction((tx) => {
    let position
    if (existingId !== null) {
      const row = tx.prepare('SELECT position FROM connections WHERE id = ?')
        .get(existingId)
      if (row === undefined) {
        throw new ApiError(404, `连接不存在: ${existingId}`, 'CONNECTION_NOT_FOUND')
      }
      position = Math.trunc(Number(row.position ?? 0))
    } else {
      const row = tx.prepare('SELECT COALESCE(MAX(position), -1) + 1 AS n FROM connections').get()
      position = Math.trunc(Number(row.n ?? 0))
    }
    const values = _connItemToRow(connObj, position)
    const cols = _CONN_COLS
    const updates = cols.filter((c) => c !== 'id')
      .map((c) => `${c}=excluded.${c}`).join(', ')
    tx.prepare(
      `INSERT INTO connections (${cols.join(', ')})`
      + ` VALUES (${cols.map(() => '?').join(', ')})`
      + ` ON CONFLICT(id) DO UPDATE SET ${updates}`,
    ).run(...values)
  })
}

// ---------------------------------------------------------------- 连接测试

function _newId(connections) {
  const used = new Set(connections.map((c) => c.id))
  for (;;) {
    // uuid4().hex[:12] 等价：12 个 hex 字符
    const bytes = new Uint8Array(6)
    globalThis.crypto.getRandomValues(bytes)
    const candidate = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
    if (!used.has(candidate)) return candidate
  }
}

async function _testConnection(info) {
  const started = startClock()
  try {
    if ((info.kind || 'mysql') === 'redis') {
      // M2-C 接线（对照 Python：redis_pool.get_client("__test__", info, redis_db(None, info))）：
      // 用 __test__ 占位 id 走 clientFor（hooks.createClient 注入优先），测完整池作废。
      const redisApi = await import('./redis.js').catch(() => null)
      if (!redisApi) throw new Error('redis 模块未就绪')
      const dbNumber = redisApi.redisDb(null, info)
      const client = await redisApi.clientFor({ ...info, id: '__test__' }, dbNumber)
      let server = {}
      try {
        server = (await client.info('server')) ?? {}
      } finally {
        try { poolDropRedis('__test__') } catch { /* 忽略 */ }
      }
      const version = server.redis_version ?? '?'
      return { ok: true, elapsedMs: ms(started), version: `Redis ${version}` }
    }
    const cid = info.id || '__draft__'
    const conn = await pool.borrow(cid, info, info.database || '')
    try {
      const [rows] = await conn.query('SELECT VERSION()')
      const version = rows && rows.length ? String(rows[0][0]) : ''
      return { ok: true, elapsedMs: ms(started), version }
    } finally {
      // 测试连接不复用（Python 版 close 直关等价：broken 还池即销毁）
      try { pool.giveBack(cid, conn, true) } catch { /* 忽略 */ }
    }
  } catch (exc) {
    // 连接失败是「业务结果」，不是 500
    return { ok: false, elapsedMs: ms(started), error: `连接失败: ${exc}` }
  }
}

// ---------------------------------------------------------------- handlers

export async function handleList(_query, _body = null, _headers = null) {
  return { connections: loadConnections().map((c) => masked(c)) }
}

export async function handleSave(_query, body = null, headers = null) {
  const raw = (body ?? {}).connection
  if (!raw || typeof raw !== 'object' || raw instanceof Array) {
    throw new ApiError(400, '请求体缺少 connection 对象')
  }
  const connectionId = raw.id
  const rawMasking = raw.masking
  const hasFields = rawMasking !== null && typeof rawMasking === 'object'
    && !(rawMasking instanceof Array) && 'fields' in rawMasking
  const existing = connectionId ? findConnection(connectionId) : null
  if (connectionId && existing === null) {
    throw new ApiError(404, `连接不存在: ${connectionId}`, 'CONNECTION_NOT_FOUND')
  }
  let conn
  if (existing !== null) {
    conn = _normalize(raw, existing)
    conn.id = existing.id || connectionId
    conn.createdAt = existing.createdAt || now()
  } else {
    conn = _normalize(raw, null)
    conn.id = _newId(loadConnections())
    conn.createdAt = now()
  }
  // §3.8：只有「首次开启（fields 为空且无已存策略）」才自动分析；其余情况只合并
  // 已存强制项。分析可能连 MySQL —— 必须在开事务之前完成（硬规则）。
  conn.masking = await _finalizeMasking(conn, existing, { hasFields })
  _upsertRow(conn, existing !== null ? connectionId : null)
  _dropPools(conn.id)
  audit(actorOf(headers), 'connection.save', {
    connectionId: conn.id,
    name: conn.name,
    kind: conn.kind,
    hasPassword: Boolean(conn.password ?? ''),
    maskingEnabled: Boolean((conn.masking ?? {}).enabled),
  })
  return { connection: masked(conn) }
}

export async function handleDelete(_query, body = null, headers = null) {
  const connectionId = (body ?? {}).id
  if (typeof connectionId !== 'string' || !connectionId) {
    throw new ApiError(400, '请求体缺少 id')
  }
  if (!db.deleteConnection(connectionId)) {
    throw new ApiError(404, `连接不存在: ${connectionId}`, 'CONNECTION_NOT_FOUND')
  }
  _dropPools(connectionId)
  audit(actorOf(headers), 'connection.delete', { connectionId })
  return { ok: true }
}

export async function handleTest(_query, body = null, _headers = null) {
  const payload = body ?? {}
  let info
  if (payload.id) {
    info = requireConnection(payload.id)
  } else if (payload.connection !== null && typeof payload.connection === 'object'
    && !(payload.connection instanceof Array)) {
    const raw = payload.connection
    const existing = typeof raw.id === 'string' ? findConnection(raw.id) : null
    info = _normalize(raw, existing)
    // 未保存的草稿没有 id，给个占位 id 以免和已存连接串池
    info.id = info.id || '__draft__'
  } else {
    throw new ApiError(400, '请求体需要 id 或 connection')
  }
  return _testConnection(info)
}
