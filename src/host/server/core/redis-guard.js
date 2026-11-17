/**
 * Redis 命令安全守卫。server/core/redis_guard.py 的移植。
 *
 * - 只读连接：未知命令与已知写命令一律拒绝（安全优先，宁可误拒）。
 * - 可写连接的销毁级命令由 Host 层审批（这里只做「只读」这层硬拦截）。
 * - 分词支持 "..." 与 '...' 引号包参（等价 Python shlex.split(posix=True)）。
 */

import { PermissionError, ValueError } from './errors.js'

// 已知写/危险命令（覆盖常见项，不追求穷尽；只读连接下「未知命令」同样拒绝）
export const WRITE_COMMANDS = new Set([
  // string
  'SET', 'SETNX', 'SETEX', 'PSETEX', 'GETSET', 'GETDEL', 'GETEX', 'SETRANGE',
  'APPEND', 'INCR', 'INCRBY', 'INCRBYFLOAT', 'DECR', 'DECRBY',
  'MSET', 'MSETNX', 'SETBIT', 'BITFIELD', 'BITOP',
  // key
  'DEL', 'UNLINK', 'EXPIRE', 'PEXPIRE', 'EXPIREAT', 'PEXPIREAT', 'PERSIST',
  'RENAME', 'RENAMENX', 'MOVE', 'SWAPDB', 'SORT', 'COPY',
  // hash
  'HSET', 'HSETNX', 'HMSET', 'HDEL', 'HINCRBY', 'HINCRBYFLOAT', 'HPERSIST', 'HEXPIRE',
  // list
  'LPUSH', 'LPUSHX', 'RPUSH', 'RPUSHX', 'LPOP', 'RPOP', 'LSET', 'LINSERT',
  'LREM', 'LTRIM', 'LMPOP', 'BLPOP', 'BLMOVE', 'BRPOPLPUSH', 'BRPOP',
  // set
  'SADD', 'SREM', 'SPOP', 'SMOVE', 'SDIFFSTORE', 'SINTERSTORE', 'SUNIONSTORE',
  // zset
  'ZADD', 'ZINCRBY', 'ZREM', 'ZREMRANGEBYRANK', 'ZREMRANGEBYSCORE', 'ZREMRANGEBYLEX',
  'ZPOPMIN', 'ZPOPMAX', 'ZMPOP', 'BZPOPMIN', 'BZPOPMAX',
  // stream / hyperloglog
  'XADD', 'XDEL', 'XTRIM', 'XGROUP', 'XSETID', 'XAUTOCLAIM',
  'PFADD', 'PFMERGE',
  // server / management
  'FLUSHDB', 'FLUSHALL', 'RESTORE', 'MIGRATE', 'SLAVEOF', 'REPLICAOF',
  'CONFIG', 'SHUTDOWN', 'DEBUG', 'SAVE', 'BGSAVE', 'BGREWRITEAOF',
  'CLIENT', 'SCRIPT', 'EVAL', 'EVALSHA', 'FUNCTION', 'FCALL',
  'ACL', 'MODULE', 'COMMAND', 'LATENCY', 'SLOWLOG', 'WAIT', 'WAITAOF',
])

// 需要 Host/前端二次确认的销毁级命令（可写连接）
export const DESTROY_COMMANDS = new Set(['DEL', 'UNLINK', 'FLUSHDB', 'FLUSHALL', 'SHUTDOWN'])

// 常见只读命令白名单（用于降低「未知命令拒绝」的误伤）
export const READ_COMMANDS = new Set([
  'GET', 'MGET', 'STRLEN', 'EXISTS', 'TTL', 'PTTL', 'TYPE', 'KEYS', 'SCAN',
  'RANDOMKEY', 'DBSIZE', 'INFO', 'PING', 'ECHO', 'SELECT', 'MEMORY', 'OBJECT',
  'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN', 'HSCAN', 'HEXISTS', 'HSTRLEN',
  'LRANGE', 'LLEN', 'LINDEX', 'LPOS',
  'SMEMBERS', 'SCARD', 'SSCAN', 'SISMEMBER', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF',
  'SINTERCARD', 'ZMSCORE', 'LCS', 'GETRANGE',
  'ZRANGE', 'ZREVRANGE', 'ZRANGEBYSCORE', 'ZSCORE', 'ZCARD', 'ZCOUNT', 'ZSCAN',
  'ZRANK', 'ZREVRANK', 'ZLEXCOUNT',
  'XLEN', 'XRANGE', 'XREVRANGE', 'XREAD', 'XINFO',
  'PFCOUNT', 'BITCOUNT', 'GETBIT',
  'DUMP', 'TIME', 'LASTSAVE', 'LOLWUT', 'HELLO',
])

/** Redis 命令行分词：支持 "..." 与 '...' 引号包参。空格分隔。
 * 等价 shlex.split(text, posix=True)：引号包裹成单参数、引号内空格保留、
 * 引号内外可拼接、不完整引号按 ValueError 处理由调用方转译。 */
export function parseCommand(text) {
  const s = (text || '').trim()
  if (!s) return []
  const parts = []
  let cur = ''
  let hasCur = false // shlex 会产出空参数吗？posix 模式下引号包空串会产出 ''；
  let i = 0
  // 实现说明：shlex posix 分词里，未加引号的分隔符切段；引号段拼进当前 token。
  // Python 测试只断言非空参数，这里与 shlex 的差异仅在「空引号参数」是否保留——
  // shlex 保留（'' 产出空参数），redis 命令行里没有合法用途，按 shlex 语义保留。
  while (i < s.length) {
    const c = s[i]
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      if (hasCur) {
        parts.push(cur)
        cur = ''
        hasCur = false
      }
      i += 1
      continue
    }
    if (c === '"' || c === "'") {
      const q = c
      hasCur = true
      i += 1
      let closed = false
      while (i < s.length) {
        const ch = s[i]
        if (ch === '\\' && q === '"' && i + 1 < s.length
          && (s[i + 1] === q || s[i + 1] === '\\')) {
          cur += s[i + 1] // 双引号内的 \" 与 \\ 转义
          i += 2
          continue
        }
        if (ch === q) {
          i += 1 // 吃掉闭引号；相邻引号段拼进同一 token（'a''b' → ab）
          closed = true
          break
        }
        cur += ch
        i += 1
      }
      if (!closed) {
        const err = new Error('No closing quotation')
        err.name = 'ValueError'
        throw err
      }
      continue
    }
    hasCur = true
    cur += c
    i += 1
  }
  if (hasCur) parts.push(cur)
  return parts
}

export function firstWord(text) {
  const parts = parseCommand(text)
  return parts.length ? parts[0].toUpperCase() : ''
}

/** 只读连接：未知命令或写命令都拒绝。 */
export function checkReadonly(text) {
  const cmd = firstWord(text)
  if (!cmd) throw new ValueError('空命令')
  if (WRITE_COMMANDS.has(cmd)) {
    throw new PermissionError(`只读连接拒绝写命令 ${cmd}`)
  }
  if (!READ_COMMANDS.has(cmd)) {
    throw new PermissionError(
      `只读连接拒绝未识别命令 ${cmd}（安全优先；如确需执行请关闭连接的只读开关）`)
  }
}

/** 可写连接：返回是否为销毁级命令（调用方据此弹确认）。 */
export function checkDestroy(text) {
  return DESTROY_COMMANDS.has(firstWord(text))
}
