/**
 * Redis 连接池：按 (cid, db) 维度缓存 ioredis 客户端。server/core/redis_pool.py 的移植。
 *
 * 设计对照（Python 源码为唯一规格）：
 * - 指纹 = sha256("host|port|password|{db}")，连接配置变更后旧客户端整体作废重建。
 * - db=None 用连接配置里的默认 db；db 变更会生成新客户端（同指纹复用）。
 * - decode_responses=True 的对应物：ioredis 默认把 bulk string 还原为 JS string、
 *   整数回复为 number（stringNumbers 默认 false），与 redis-py 拿 str 的取值形态一致，
 *   无需显式开关；测试以一条 GET 返回 string 钉住该语义。
 * - protocol: 2（RESP2）关键：新 ioredis 默认 RESP3 握手发 HELLO，Redis < 6.0 会拒。
 *
 * 与 Python 版的差异（JS/驱动形态）：
 * - getClient/dropPool 走 async（ioredis 建连是异步的）；threading.Lock 换成
 *   「in-flight Promise 占位」做并发创建去重。
 * - 旧客户端关闭用 disconnect()（裸断开 socket，等价 redis-py close()）。
 * - ioredis 后台建连失败会 emit 'error'，必须挂 no-op 监听，否则 EventEmitter
 *   会把进程打崩；命令级错误照常经 promise rejection 上抛（api 层统一转 400）。
 * - api/redis.js 按 redis-py 的返回形状编码（scan 关键字参数对象、pipeline.execute
 *   扁平数组且遇错抛出、hscan 配对对象、zrange 元组对、xrange [id, fields 对象]）；
 *   compatWrap 把真 ioredis 的应答形状归一到这套形状（hooks 注入的测试假客户端
 *   本来就按 redis-py 形状实现，不经过包装）。
 * - ioredis 按需懒加载（动态 import）：仓库/运行环境未安装 ioredis 时模块仍可加载，
   真实建连时才解析依赖（缺包错误经 clientFor 转 400）。
 * - 病态边角：Python 对 port/timeout='abc' 这类非数字串 int() 直接抛错；
 *   JS 侧 Number('abc')=NaN 后回退默认值（6379/60）。正常配置两侧行为一致。
 * - 测试接缝：hooks.createClient(info, useDb) 注入假客户端工厂；或测试直接覆写
 *   redisPool.getClient（等价 Python monkeypatch redis_pool.get_client）。
 */

import { createHash } from 'node:crypto'

/** 模块级注入点：测试用它替换真 ioredis 客户端工厂。 */
export const hooks = { createClient: null }

const _clients = new Map() // cid -> { fpByDb: Map<db, [fingerprint, client] | Promise>, info }

/** 配置指纹（与 Python redis_pool.fingerprint 相同的字段序）。 */
export function fingerprint(info, db) {
  const raw = ['host', 'port', 'password']
    .map((k) => String(info?.[k] ?? ''))
    .join('|') + `|${db}`
  return createHash('sha256').update(raw, 'utf8').digest('hex')
}

function _closeQuiet(client) {
  try { client.disconnect() } catch { /* 已经断开就算了 */ }
}

/** 连接配置删除/变更时整体作废（connections.js 调用，等价 redis_pool.drop_pool）。 */
export function dropPool(cid) {
  const entry = _clients.get(cid)
  if (!entry) return
  _clients.delete(cid)
  for (const hit of entry.fpByDb.values()) {
    if (hit && typeof hit.then === 'function') {
      hit.then(_closeQuiet, () => {}) // 建连中的客户端：建成后再关
      continue
    }
    _closeQuiet(hit[1])
  }
}

/** 关闭全部 Redis 客户端（engine.dispose / 插件卸载用）：ioredis 活连接会挂住退出。 */
export function closeAll() {
  for (const cid of [..._clients.keys()]) dropPool(cid)
}

let _RedisCtor = null
let _redisLoad = null

/** 懒加载 ioredis（缺依赖时错误在建连时才出现，模块本身可安全加载）。 */
function _loadRedis() {
  if (_RedisCtor) return Promise.resolve(_RedisCtor)
  if (!_redisLoad) {
    _redisLoad = import('ioredis').then((mod) => {
      _RedisCtor = mod.default
      return _RedisCtor
    })
  }
  return _redisLoad
}

/**
 * ioredis 建连参数（逐项对齐 Python redis.Redis(...)；导出仅供测试/诊断）。
 * password 空串 → undefined（等价 Python password=None，不发 AUTH）。
 */
export function clientOptions(info, useDb) {
  const timeout = Math.trunc(Number(info?.timeout || 0)) || 60
  return {
    host: info?.host,
    port: Math.trunc(Number(info?.port || 0)) || 6379,
    password: info?.password || undefined,
    db: useDb,
    protocol: 2, // RESP2：兼容 Redis < 6.0（默认 RESP3 握手发 HELLO，老版本会拒）
    connectTimeout: 10000, // Python socket_connect_timeout=10
    commandTimeout: timeout * 1000, // Python socket_timeout=int(timeout or 60)
    maxRetriesPerRequest: 1,
    lazyConnect: false,
  }
}

/**
 * 真 ioredis 客户端 → redis-py 形状的兼容面（api/redis.js 只按后者编码）：
 * - scan(cursor, { match, count }) → [cursor, names]
 * - pipeline() → { type, ttl, execute }，execute 扁平数组、遇错抛出（redis-py 语义）
 * - hscan(key, cursor, { count }) → [cursor, {field: value}]
 * - sscan(key, cursor, { count }) → [cursor, members]
 * - zrange(key, start, stop, { withscores }) → [[member, score], ...]（score 转数值）
 * - xrange(key, { count }) → [[id, {field: value}], ...]
 * - memoryUsage(key) → MEMORY USAGE key
 * - executeCommand(*parts) → 任意命令（ioredis call）
 * 其余属性/方法经 Proxy 透传到裸客户端。
 */
export function compatWrap(raw) {
  const wrap = {
    scan(cursor, { match = '*', count = 100 } = {}) {
      return raw.scan(String(cursor), 'MATCH', match, 'COUNT', count)
    },
    pipeline() {
      const pipe = raw.pipeline()
      const wrappedPipe = {
        type: (key) => { pipe.type(key); return wrappedPipe },
        ttl: (key) => { pipe.ttl(key); return wrappedPipe },
        async execute() {
          const pairs = await pipe.exec()
          const out = []
          for (const item of pairs || []) {
            const [err, reply] = item
            if (err) throw err // redis-py execute：任一命令失败即抛
            out.push(reply)
          }
          return out
        },
      }
      return wrappedPipe
    },
    async hscan(key, cursor, { count = 100 } = {}) {
      const [cur, items] = await raw.hscan(key, String(cursor), 'COUNT', count)
      const pairs = {}
      for (let i = 0; i + 1 < items.length; i += 2) pairs[items[i]] = items[i + 1]
      return [String(cur), pairs]
    },
    sscan(key, cursor, { count = 100 } = {}) {
      return raw.sscan(key, String(cursor), 'COUNT', count)
    },
    async zrange(key, start, stop, { withscores = false } = {}) {
      const args = withscores ? [key, String(start), String(stop), 'WITHSCORES'] : [key, String(start), String(stop)]
      const items = await raw.zrange(...args)
      if (!withscores) return items
      const pairs = []
      for (let i = 0; i + 1 < items.length; i += 2) {
        pairs.push([items[i], Number(items[i + 1])])
      }
      return pairs
    },
    async xrange(key, { count = 100 } = {}) {
      const entries = await raw.xrange(key, '-', '+', 'COUNT', count)
      return (entries || []).map(([id, fields]) => {
        const obj = {}
        for (let i = 0; i + 1 < fields.length; i += 2) obj[fields[i]] = fields[i + 1]
        return [id, obj]
      })
    },
    memoryUsage(key) {
      return raw.memory('usage', key)
    },
    executeCommand(...parts) {
      return raw.call(...parts)
    },
  }
  return new Proxy(wrap, {
    get(target, prop) {
      if (prop in target) return target[prop]
      const value = raw[prop]
      return typeof value === 'function' ? value.bind(raw) : value
    },
  })
}

/** 建一个客户端：测试走 hooks 注入；真实路径建 ioredis 并包 compatWrap。 */
async function _createClient(info, useDb) {
  if (hooks.createClient) return await hooks.createClient(info, useDb)
  const Redis = await _loadRedis()
  const client = new Redis(clientOptions(info, useDb))
  client.on('error', () => {}) // 后台建连失败必须有人接住；命令错误仍走 promise rejection
  return compatWrap(client)
}

function _useDb(db, info) {
  const raw = (db !== null && db !== undefined) ? db : (info?.database || 0)
  const num = Math.trunc(Number(raw))
  if (!Number.isFinite(num)) {
    throw new Error(`invalid db: ${JSON.stringify(raw)}`)
  }
  return num
}

/** db=None 用连接配置里的默认 db；db 变更会生成新客户端（同指纹复用）。 */
async function _getClient(cid, info, db = null) {
  const useDb = _useDb(db, info)
  const fp = fingerprint(info, useDb)
  let entry = _clients.get(cid)
  if (!entry) {
    entry = { fpByDb: new Map(), info: { ...info } }
    _clients.set(cid, entry)
  }
  const hit = entry.fpByDb.get(useDb)
  if (hit && typeof hit.then === 'function') return hit // 并发创建去重（等价 Python 锁内复用）
  const old = hit ? hit[1] : null
  if (hit && hit[0] === fp) return hit[1]
  const created = _createClient(info, useDb).then((client) => {
    entry.fpByDb.set(useDb, [fp, client])
    if (old) _closeQuiet(old) // Python 在锁外关闭旧客户端
    return client
  })
  entry.fpByDb.set(useDb, created)
  created.catch(() => {
    // 建连失败：清掉占位让下次重试；错误本身由调用方的 await 拿到
    if (entry.fpByDb.get(useDb) === created) entry.fpByDb.delete(useDb)
  })
  return created
}

/**
 * pool 注入接缝：api 层一律 `redisPool.getClient(cid, info, db)`；测试可覆写方法
 * （等价 Python monkeypatch redis_pool.get_client）。
 */
export const redisPool = {
  fingerprint,
  dropPool,
  getClient: _getClient,
}
