/**
 * api 层共用小工具：参数解析 / 计时 / 连接对象 / 审计日志。
 * server/api/common.py 的移植。
 *
 * 只做「把 HTTP 语义翻译成普通 JS 值」的事，不碰数据库。
 *
 * 与 Python 版的差异：getConnection 依赖 connections.js 的 requireConnection，
 * ESM 环形 import 下改为 hooks 注入——connections.js 加载时调用
 * `registerRequireConnection(fn)` 注册；为 null 时抛 500（模块未按序装载）。
 */

import { ApiError } from '../core/errors.js'

/** 模块级注入点：connections.js 的 requireConnection 在此注册。 */
export const hooks = { requireConnection: null }

export function registerRequireConnection(fn) {
  hooks.requireConnection = fn
}

/** POST 请求体必须是 JSON 对象。 */
export function bodyOf(body) {
  if (body === null || body === undefined) {
    throw new ApiError(400, '请求体必须是 JSON 对象')
  }
  if (typeof body !== 'object' || body instanceof Array) {
    throw new ApiError(400, '请求体必须是 JSON 对象')
  }
  return body
}

export function requireConnectionId(source) {
  const cid = (source || {}).connectionId
  if (typeof cid !== 'string' || !cid.trim()) {
    throw new ApiError(400, '缺少 connectionId')
  }
  return cid.trim()
}

export function getConnection(source) {
  // 取连接配置；不存在时按契约回 404 CONNECTION_NOT_FOUND。
  if (!hooks.requireConnection) {
    throw new ApiError(500, 'connections 模块未就绪')
  }
  return hooks.requireConnection(requireConnectionId(source))
}

/** SQL 类接口只接受 MySQL 连接，Redis 连接指错接口时给 400。 */
export function requireMysql(info) {
  if ((info.kind || 'mysql') !== 'mysql') {
    throw new ApiError(400, '该连接不是 MySQL 类型', 'NOT_MYSQL')
  }
}

/** Redis 接口只接受 Redis 连接。 */
export function requireRedis(info) {
  if ((info.kind || 'mysql') !== 'redis') {
    throw new ApiError(400, '该连接不是 Redis 类型', 'NOT_REDIS')
  }
}

export function textField(source, key, fallback = '', label = '') {
  if (!source || typeof source !== 'object' || !(key in source)) return fallback
  const value = source[key]
  if (value === null || value === undefined) return fallback
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  throw new ApiError(400, `${label || key} 必须是字符串`)
}

export function intField(source, key, fallback, low, high, label = '') {
  const raw = source && typeof source === 'object' ? source[key] : undefined
  if (raw === null || raw === undefined || raw === '') return Number(fallback)
  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new ApiError(400, `${label || key} 必须是整数: ${JSON.stringify(raw)}`)
  }
  const value = parsed
  if (value < low || value > high) {
    throw new ApiError(400, `${label || key} 超出范围 [${low}, ${high}]: ${value}`)
  }
  return value
}

export function boolField(source, key, fallback = false) {
  const raw = source && typeof source === 'object' ? source[key] : undefined
  if (raw === null || raw === undefined || raw === '') return Boolean(fallback)
  if (typeof raw === 'boolean') return raw
  const text = String(raw).trim().toLowerCase()
  if (text === '1' || text === 'true' || text === 'yes' || text === 'on') return true
  if (text === '0' || text === 'false' || text === 'no' || text === 'off') return false
  throw new ApiError(400, `${key} 必须是布尔值: ${JSON.stringify(raw)}`)
}

/** 毫秒计时（performance.now 与 Python perf_counter 等价，取整毫秒）。 */
export function ms(started) {
  return Math.round(performance.now() - started)
}

/** 计时起点。 */
export function startClock() {
  return performance.now()
}

/** "YYYY-MM-DD HH:MM:SS" 本地时间（Python time.strftime 语义）。 */
export function now() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** X-DBS-Actor: agent|user（缺省 user）；非法值按 user 处理。 */
export function actorOf(headers) {
  let value = null
  if (headers && typeof headers === 'object') {
    const lower = headers['x-dbs-actor']
    const upper = headers['X-DBS-Actor']
    value = lower ?? upper ?? null
  }
  return value === 'agent' || value === 'user' ? value : 'user'
}

/** 写操作审计：只落 stderr，不落业务文件（Host 负责采集子进程日志；V3 直接打 stderr）。 */
export function audit(actor, action, fields = {}) {
  const parts = [`[audit] ${now()} actor=${actor || 'user'} action=${action}`]
  for (const [key, value] of Object.entries(fields)) {
    const text = String(value).replace(/\r/g, ' ').replace(/\n/g, ' ').slice(0, 500)
    parts.push(`${key}=${text}`)
  }
  process.stderr.write(parts.join(' ') + '\n')
}
