/**
 * Redis 数据源（/api/redis/*）。server/api/redis.py 的移植。
 *
 * - scan：SCAN 分页浏览键（契约禁用全量 KEYS），每页顺手给 type/ttl
 * - key：键详情，按类型给结构化数据；集合类型只取前 100 条 + 全量长度
 * - command：执行任意 Redis 命令；只读连接写/未知命令一律 403 READONLY
 *
 * 安全边界与 Python 版一致：只读连接由后端硬拦截；可写连接的销毁级命令由 Host 层
 * 先走审批，后端不再重复确认（契约 3.4）。
 *
 * 与 Python 版的差异（JS/驱动形态）：
 * - 处理器全 async；客户端方法返回 Promise（真 ioredis 经 redis-pool 的 compatWrap
 *   归一到 redis-py 的应答形状：scan 关键字参数对象、pipeline.execute 扁平数组遇错抛出、
 *   hscan/sscan 配对、zrange withscores 元组对、xrange [id, fields 对象]）。
 * - 测试接缝：hooks.createClient(info, useDb) 注入假客户端（server/tests 里
 *   monkeypatch redis_pool.get_client 的等价物）；不注入则走真 ioredis 池。
 * - bytes → utf8 解码失败时回退 "base64:..."（TextDecoder fatal 模式对齐 Python 的
 *   UnicodeDecodeError 分支）；其余命令返回值形状逐字对照 _jsonable_reply。
 */

import { ApiError, PermissionError, ValueError } from '../core/errors.js'
import { READ_COMMANDS, checkReadonly, parseCommand } from '../core/redis-guard.js'
import { redisPool } from '../core/redis-pool.js'
import * as common from './common.js'

const VALUE_PAGE = 100 // 集合类型单页条数
const STR_MAX = 100 * 1024 // string 值展示上限（字符）

/** 测试注入点：存在时 clientFor 直接用它造客户端（传 (info, useDb)）。 */
export const hooks = { createClient: null }

/** Python str(exc) 的等价物：Error 取 message，其余 String()。 */
function _excText(exc) {
  return exc instanceof Error ? exc.message : String(exc)
}

// ---------------------------------------------------------------- 连接/参数

/** 取 Redis 客户端；连接类型不对或建连失败按 400 报。 */
export async function clientFor(info, db) {
  if ((info?.kind || 'mysql') !== 'redis') {
    throw new ApiError(400, '该连接不是 Redis 类型', 'NOT_REDIS')
  }
  try {
    if (hooks.createClient) {
      return await hooks.createClient(info, db)
    }
    return await redisPool.getClient(info?.id || '__draft__', info, db)
  } catch (exc) {
    if (exc instanceof ApiError) throw exc
    throw new ApiError(400, `连接 Redis 失败: ${_excText(exc)}`)
  }
}

/** database 允许缺省（用连接配置里的 db）或传 "0"/0。 */
export function redisDb(value, info) {
  let raw = value
  if (raw === null || raw === undefined
    || (typeof raw === 'string' && raw.trim() === '')) {
    raw = info?.database || 0
  }
  const num = Number(raw)
  if (!Number.isFinite(num)) {
    throw new ApiError(400, `database 必须是 db 编号: ${_reprLike(raw)}`)
  }
  const db = Math.trunc(num)
  if (db < 0) {
    throw new ApiError(400, `database 不能为负数: ${db}`)
  }
  return db
}

/** Python f"{raw!r}" 的近似：字符串带单引号，其余 JSON 形态（仅用于错误文案）。 */
function _reprLike(value) {
  return typeof value === 'string' ? `'${value}'` : JSON.stringify(value)
}

/** Redis 可选命令/能力缺失时降级，不让整个响应挂掉。 */
async function _safe(fn, fallback, ...args) {
  try {
    return await fn(...args)
  } catch {
    return fallback
  }
}

/** string 值像 JSON 时给个结构化副本（与 Python 版行为一致，只认对象/数组）。 */
function _tryJson(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return parsed !== null && typeof parsed === 'object' ? parsed : null
}

// ---------------------------------------------------------------- 响应渲染

/** Redis 命令返回值 → JSON 安全值（dict 转 [[field, value], ...]，保持协议顺序）。 */
function _jsonableReply(reply) {
  if (reply instanceof Map) {
    return [...reply.entries()].map(([k, v]) => [_jsonableReply(k), _jsonableReply(v)])
  }
  if (reply instanceof Set) {
    return [...reply].map((v) => _jsonableReply(v))
  }
  if (reply instanceof Array) {
    return reply.map((v) => _jsonableReply(v))
  }
  if (reply !== null && typeof reply === 'object'
    && !(reply instanceof Buffer) && !(reply instanceof Uint8Array)) {
    return Object.entries(reply).map(([k, v]) => [_jsonableReply(k), _jsonableReply(v)])
  }
  if (typeof reply === 'boolean') {
    return reply ? 1 : 0
  }
  if (reply instanceof Buffer || reply instanceof Uint8Array) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(reply)
    } catch {
      return 'base64:' + Buffer.from(reply).toString('base64')
    }
  }
  if (reply === null || reply === undefined || typeof reply === 'number'
    || typeof reply === 'string' || typeof reply === 'bigint') {
    return reply
  }
  return String(reply)
}

/** 契约的 {reply, kind}：kind ∈ string | array | number | nil。 */
export function replyPayload(reply) {
  const value = _jsonableReply(reply)
  if (reply === null || reply === undefined) {
    return [value, 'nil']
  }
  if (reply instanceof Array || reply instanceof Map || reply instanceof Set
    || (reply !== null && typeof reply === 'object'
      && !(reply instanceof Buffer) && !(reply instanceof Uint8Array))) {
    return [value, 'array']
  }
  if (typeof reply === 'boolean' || typeof reply === 'number' || typeof reply === 'bigint') {
    return [value, 'number']
  }
  if (typeof reply === 'string' || reply instanceof Buffer || reply instanceof Uint8Array) {
    return [value, 'string']
  }
  return [String(value), 'string']
}

// ---------------------------------------------------------------- handlers

export async function handleScan(query, body = null, headers = null) {
  body = common.bodyOf(body)
  const info = common.getConnection(body)
  common.requireRedis(info)
  const db = redisDb(body.database, info)
  const client = await clientFor(info, db)

  const cursor = common.intField(body, 'cursor', 0, 0, 2 ** 63 - 1, 'cursor')
  const count = common.intField(body, 'count', 100, 10, 500, 'count')
  const match = common.textField(body, 'match', '*', 'match') || '*'
  let newCursor
  let names
  try {
    ;[newCursor, names] = await client.scan(cursor, { match, count })
  } catch (exc) {
    throw new ApiError(400, `SCAN 失败: ${_excText(exc)}`)
  }

  const keys = []
  if (names && names.length) {
    const pipe = client.pipeline()
    for (const name of names) {
      pipe.type(name)
      pipe.ttl(name)
    }
    let replies
    try {
      replies = await pipe.execute()
    } catch (exc) {
      throw new ApiError(400, `读取键类型失败: ${_excText(exc)}`)
    }
    names.forEach((name, index) => {
      const keyType = replies[2 * index]
      const ttl = replies[2 * index + 1]
      if (keyType === null || keyType === undefined || keyType === 'none') {
        return // 扫描期间被删除/过期的键，跳过
      }
      keys.push({
        key: name,
        type: keyType,
        ttl: ttl === null || ttl === undefined ? -1 : Math.trunc(ttl),
      })
    })
  }
  return { cursor: String(newCursor), keys }
}

async function _keyDetail(client, key) {
  const keyType = (await _safe(() => client.type(key), 'none')) || 'none'
  const detail = {
    key,
    type: keyType,
    ttl: -1,
    memoryBytes: await _safe(() => client.memoryUsage(key), null),
    value: null,
    truncated: false,
  }
  if (keyType === 'none') {
    detail.ttl = -2
    return detail
  }
  detail.ttl = Math.trunc((await _safe(() => client.ttl(key), -1)) || -1)

  if (keyType === 'string') {
    let raw = await _safe(() => client.get(key), '')
    raw = raw === null || raw === undefined ? '' : String(raw)
    detail.length = raw.length
    if (raw.length > STR_MAX) {
      detail.value = raw.slice(0, STR_MAX)
      detail.truncated = true
    } else {
      detail.value = raw
      const parsed = _tryJson(raw)
      if (parsed !== null) {
        detail.json = parsed
      }
    }
    return detail
  }

  if (keyType === 'hash') {
    const length = Math.trunc((await _safe(() => client.hlen(key), 0)) || 0)
    const pairs = (await _safe(() => client.hscan(key, 0, { count: VALUE_PAGE }), [0, {}]))[1] || {}
    detail.length = length
    detail.value = Object.entries(pairs).map(([field, value]) => ({ field, value }))
    detail.truncated = length > Object.keys(pairs).length
    return detail
  }

  if (keyType === 'list') {
    const length = Math.trunc((await _safe(() => client.llen(key), 0)) || 0)
    const values = (await _safe(() => client.lrange(key, 0, VALUE_PAGE - 1), [])) || []
    detail.length = length
    detail.value = [...values]
    detail.truncated = length > values.length
    return detail
  }

  if (keyType === 'set') {
    const length = Math.trunc((await _safe(() => client.scard(key), 0)) || 0)
    const members = (await _safe(() => client.sscan(key, 0, { count: VALUE_PAGE }), [0, []]))[1] || []
    const list = [...(members || [])]
    detail.length = length
    detail.value = list
    detail.truncated = length > list.length
    return detail
  }

  if (keyType === 'zset') {
    const length = Math.trunc((await _safe(() => client.zcard(key), 0)) || 0)
    const pairs = (await _safe(() => client.zrange(key, 0, VALUE_PAGE - 1, { withscores: true }), [])) || []
    detail.length = length
    detail.value = pairs.map(([member, score]) => ({ member, score }))
    detail.truncated = length > pairs.length
    return detail
  }

  if (keyType === 'stream') {
    const length = Math.trunc((await _safe(() => client.xlen(key), 0)) || 0)
    const entries = (await _safe(() => client.xrange(key, { count: VALUE_PAGE }), [])) || []
    detail.length = length
    detail.value = entries.map(([id, fields]) => ({ id, fields }))
    detail.truncated = length > entries.length
    return detail
  }

  // 模块自定义类型等：给个占位说明，不报错
  detail.value = null
  detail.note = `暂不支持渲染 ${keyType} 类型`
  return detail
}

export async function handleKey(query, body = null, headers = null) {
  body = common.bodyOf(body)
  const info = common.getConnection(body)
  common.requireRedis(info)
  const key = common.textField(body, 'key', '', 'key')
  if (!key) {
    throw new ApiError(400, '缺少 key')
  }
  const db = redisDb(body.database, info)
  const client = await clientFor(info, db)
  try {
    return await _keyDetail(client, key)
  } catch (exc) {
    if (exc instanceof ApiError) throw exc
    throw new ApiError(400, `读取键失败: ${_excText(exc)}`)
  }
}

export async function handleCommand(query, body = null, headers = null) {
  body = common.bodyOf(body)
  const info = common.getConnection(body)
  common.requireRedis(info)
  const command = common.textField(body, 'command', '', 'command')
  if (!command.trim()) {
    throw new ApiError(400, '缺少 command')
  }
  const parts = parseCommand(command)
  if (!parts.length) {
    throw new ApiError(400, '空命令')
  }
  const verb = parts[0].toUpperCase()
  if (verb === 'KEYS') {
    throw new ApiError(400, '禁用 KEYS（会阻塞 Redis），请使用 /api/redis/scan 分页扫描',
      'KEYS_DISABLED')
  }
  if (verb === 'SELECT') {
    throw new ApiError(400, '切库请用 database 参数，不要执行 SELECT', 'SELECT_DISABLED')
  }

  const readonly = Boolean(info?.readonly)
  if (readonly) {
    try {
      checkReadonly(command)
    } catch (exc) {
      if (exc instanceof PermissionError) {
        throw new ApiError(403, exc.message, 'READONLY')
      }
      if (exc instanceof ValueError) {
        throw new ApiError(400, exc.message)
      }
      throw exc
    }
  }

  const db = redisDb(body.database, info)
  const client = await clientFor(info, db)
  const started = common.startClock()
  let reply
  try {
    reply = await client.executeCommand(...parts)
  } catch (exc) {
    throw new ApiError(400, `ERR ${_excText(exc)}`)
  }
  if (!readonly && !READ_COMMANDS.has(verb)) {
    common.audit(common.actorOf(headers), 'redis.command', {
      connection: info?.name ?? '',
      connectionId: info?.id ?? '',
      command: parts.join(' '),
    })
  }
  const elapsed = common.ms(started)
  const [value, kind] = replyPayload(reply)
  return { reply: value, kind, elapsedMs: elapsed }
}

// ---------------------------------------------------------------- meta 接线

/**
 * meta.handle_databases 的 Redis 分支（server/api/meta.py::_redis_databases 的移植）。
 * keyspace 缺 db0 时补一个空 db0（空 db0 也出现在列表里）。
 */
export async function redisDatabases(info) {
  const client = await clientFor(info, redisDb(null, info))
  let keyspace
  try {
    keyspace = (await client.info('keyspace')) || {}
  } catch (exc) {
    throw new ApiError(400, `获取 Redis keyspace 失败: ${_excText(exc)}`)
  }
  const databases = []
  for (const [name, stat] of Object.entries(keyspace || {})) {
    const text = String(name)
    if (!text.startsWith('db')) {
      continue
    }
    if (!/^-?\d+$/.test(text.slice(2))) {
      continue
    }
    const number = Number(text.slice(2))
    const keys = stat && typeof stat === 'object' && !(stat instanceof Array)
      ? Math.trunc(Number(stat?.keys ?? 0)) || 0
      : 0
    databases.push({ name: String(number), keys })
  }
  databases.sort((a, b) => Number(a.name) - Number(b.name))
  if (!databases.some((item) => item.name === '0')) {
    databases.unshift({ name: '0', keys: 0 }) // 空 db0 也出现在列表里
  }
  return { databases }
}
