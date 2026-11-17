/**
 * 数据库值 → JSON 可序列化值（契约「值 JSON 化」的唯一实现点）。
 * server/core/jsonconv.py 的移植，适配 mysql2 的取值类型。
 *
 * 契约要求（与 Python 版一致的**输出**）：
 * - datetime → ISO 字符串（T 分隔；Python isoformat 语义）
 * - bytes → "base64:" 前缀的 base64 字符串
 * - Decimal → 字符串（mysql2 需配 decimalNumbers:false，DECIMAL 本来就回字符串）
 * - NaN/Infinity → "nan"/"inf"/"-inf" 字符串（Python str() 语义，不是 JS 的 "NaN"）
 * - 其它无法识别的类型 → String()
 *
 * 与 Python 版的差异：
 * - mysql2 需在连接层配 dateStrings:false + supportBigNumbers+bigNumberStrings，
 *   DATE/DATETIME 进来是 Date 对象（本地时区），BIGINT 进来是字符串（防 >2^53 丢精度）；
 *   Python 的 time 列在 mysql2 里本来就是字符串，直接透传。
 * - JS Date 只有毫秒精度；Python datetime 微秒（.123456）在这里降级为毫秒（.123）。
 */

import { Buffer } from 'node:buffer'

function _pad(n, w = 2) {
  return String(n).padStart(w, '0')
}

/** Date → Python datetime.isoformat(timespec='auto') 等价的本地时间字符串。 */
function _dateToIso(d) {
  const base = `${d.getFullYear()}-${_pad(d.getMonth() + 1)}-${_pad(d.getDate())}`
    + `T${_pad(d.getHours())}:${_pad(d.getMinutes())}:${_pad(d.getSeconds())}`
  const ms = d.getMilliseconds()
  return ms ? `${base}.${_pad(ms, 3)}` : base
}

/** 递归把 mysql2 取出的值转成 JSON 安全值。 */
export function toJsonable(value) {
  if (value === null || value === undefined) return null
  const t = typeof value
  if (t === 'boolean' || t === 'string' || (t === 'number' && Number.isFinite(value))) {
    return value
  }
  if (t === 'number') {
    // NaN/Infinity 不是合法 JSON，降级成字符串（Python str() 小写语义）
    if (Number.isNaN(value)) return 'nan'
    return value > 0 ? 'inf' : '-inf'
  }
  if (t === 'bigint') return String(value)
  if (value instanceof Date) return _dateToIso(value)
  if (value instanceof Buffer || value instanceof Uint8Array || value instanceof ArrayBuffer) {
    return 'base64:' + Buffer.from(value).toString('base64')
  }
  if (value instanceof Array) return value.map((v) => toJsonable(v))
  if (value instanceof Map) {
    const out = {}
    for (const [k, v] of value) out[String(k)] = toJsonable(v)
    return out
  }
  if (value instanceof Set) return [...value].map((v) => toJsonable(v))
  if (t === 'object') {
    // Python dict ↔ JS plain object；类实例等其它对象走 str() 兜底
    const proto = Object.getPrototypeOf(value)
    if (proto === Object.prototype || proto === null) {
      const out = {}
      for (const [k, v] of Object.entries(value)) out[String(k)] = toJsonable(v)
      return out
    }
    return String(value)
  }
  return String(value)
}

// MySQL 协议字段类型码（与 pymysql.constants.FIELD_TYPE 同源）→ 人读类型名
const _TYPE_NAMES = {
  0: 'decimal', 1: 'tinyint', 2: 'smallint', 3: 'int', 4: 'float',
  5: 'double', 6: 'null', 7: 'timestamp', 8: 'bigint', 9: 'mediumint',
  10: 'date', 11: 'time', 12: 'datetime', 13: 'year', 14: 'newdate',
  15: 'varchar', 16: 'bit', 245: 'json', 246: 'decimal', 247: 'enum',
  248: 'set', 249: 'tinyblob', 250: 'mediumblob', 251: 'longblob',
  252: 'blob', 253: 'varstring', 254: 'string', 255: 'geometry',
}

/** mysql2 fields 数组 → [{"name","type"}]。
 *
 * description/fields 为空表示语句没有结果集；未知类型码/缺字段的兜底不让
 * 元数据形状问题影响取数流程。mysql2 field 优先取数值 columnType（协议码），
 * 缺失时回退字符串 type（如 "VARCHAR" → 小写）。
 */
export function columnMeta(fields) {
  const out = []
  for (const field of fields || []) {
    let name
    let code = null
    try {
      name = field.name
    } catch {
      name = String(field)
    }
    if (field && typeof field.columnType === 'number') {
      code = field.columnType
    } else if (field && typeof field.type === 'string') {
      code = field.type.toLowerCase()
    }
    const type = typeof code === 'number'
      ? (_TYPE_NAMES[code] ?? String(code))
      : (code ?? '')
    out.push({ name, type })
  }
  return out
}
