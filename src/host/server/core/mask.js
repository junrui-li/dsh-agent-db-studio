/**
 * 连接级数据脱敏引擎（契约 §3.7）——**结果出站前在本进程内完成**。
 * server/core/mask.py 的逐函数移植（V3 去 sidecar），mysql2 字段包形态。
 *
 * 硬规则：agent 工具 / Host / 浏览器拿到的数据行必须已经是掩码后的值；任何调用方
 * 都不允许先拿到原始值再自行脱敏。挂载点是 api/query 的 runStatements（/api/query、
 * /api/execute、工单审批执行 actual.results 三条路径复用这一处）。
 *
 * 执行时按**三层叠加**判定每个单元格（任一命中即掩码，同一列取更严格的类型）：
 * 1. 配置层：connection.masking.fields 里保存的 (column → type)；
 * 2. 列名启发式层（每次查询实时判）：结果列**原始列名 orgName 优先**、结果列名 resultName
 *    兜底，命中内置五类命名 → 对应类型。这一层保证「开启即强制」；
 * 3. 值级兜底层：手机号正则 / 身份证 GB 11643 校验 + 合法出生日期 / 银行卡 Luhn + 真实卡组织
 *    IIN 前缀 / 标准邮箱正则（高精度，宁可漏判不可误伤业务 ID）。
 *
 * 另有**表达式投影 fail-safe**（对应「裸列套函数」绕过）：表达式列（无 orgName）只有在
 * 它所属的顶层 select item 引用了敏感命名时，才把该表达式列上的**字符串值**按 generic 掩码。
 * select 列表含 `*` / item 数与结果列数不一致 / 解析失败时，回退「整条 SQL 含敏感标识符」
 * 的保守判定（宁可多掩也不漏）。
 *
 * 未开启脱敏的连接：maskRows() 直接原样返回 rows，零额外行为。
 *
 * 与 Python 版的差异：
 * - mysql2 字段包是 field.orgName / field.orgTable / field.columnType（数值类型码），
 *   替代 pymysql 的 org_name / org_table / type_code；
 * - 身份证出生日期上限「今天」用本地时区的 new Date()（与 Python date.today() 同语义）；
 * - JS 侧额外暴露 isIdcardValue（供本文件内部判定），名称与 Python is_idcard_value 对应。
 */

import { pool } from './pool.js'

// ---------------------------------------------------------------- 类型与算法

export const MASK_TYPES = ['name', 'phone', 'idcard', 'bankcard', 'email', 'generic']

// 「更严格」的类型优先级：同一列被多层命中时取更高优先级，保证不会因为配置写错而变松
const _TYPE_PRECEDENCE = { idcard: 6, bankcard: 5, email: 4, phone: 3, name: 2, generic: 1 }

export const TYPE_LABELS = {
  name: '姓名',
  phone: '手机号',
  idcard: '身份证',
  bankcard: '银行卡',
  email: '邮箱',
  generic: '通用',
}

/** 姓名：保留姓（首字），其余每个字 *；单字姓名 → *。 */
export function maskName(text) {
  if (!text) return ''
  if (text.length === 1) return '*'
  return text[0] + '*'.repeat(text.length - 1)
}

/** 手机号：11 位保留前 3 后 4；其它长度保留前 3 后 2（不足 6 位全掩）。 */
export function maskPhone(text) {
  const length = text.length
  if (length === 11) return text.slice(0, 3) + '****' + text.slice(-4)
  if (length > 5) return text.slice(0, 3) + '*'.repeat(length - 5) + text.slice(-2)
  return '*'.repeat(length)
}

/** 保留前 head + 后 tail，中间全部 *；长度不够时全掩。 */
function _maskMiddle(text, head, tail) {
  if (text.length <= head + tail) return '*'.repeat(text.length)
  return text.slice(0, head) + '*'.repeat(text.length - head - tail) + text.slice(-tail)
}

/** 身份证：18 位保留前 6 后 4（中间 8 个 *）；15 位保留前 6 后 4（中间 5 个 *）。 */
export function maskIdcard(text) {
  return _maskMiddle(text, 6, 4)
}

/** 银行卡：保留前 6（BIN）+ 后 4，中间全 *；长度 ≤10 全掩。 */
export function maskBankcard(text) {
  if (text.length <= 10) return '*'.repeat(text.length)
  return _maskMiddle(text, 6, 4)
}

/** 通用：保留首尾各 1 个字符，中间 *；长度 ≤2 全 *。 */
export function maskGeneric(text) {
  if (text.length <= 2) return '*'.repeat(text.length)
  return text[0] + '*'.repeat(text.length - 2) + text.slice(-1)
}

/**
 * 邮箱：保留本地部分首字符 + *** + @域名（域名保留，便于识别来源）。
 * 非法邮箱格式（无 @ / 无本地部分 / 无域名）走 generic 兜底——命中脱敏列后
 * 不允许「格式不匹配就原样返回」。
 */
export function maskEmail(text) {
  const index = text.indexOf('@')
  const hasSeparator = index >= 0
  const local = hasSeparator ? text.slice(0, index) : text
  const domain = hasSeparator ? text.slice(index + 1) : ''
  if (hasSeparator && local && domain) {
    return local[0] + '***@' + domain
  }
  return maskGeneric(text)
}

const _MASKS = {
  name: maskName,
  phone: maskPhone,
  idcard: maskIdcard,
  bankcard: maskBankcard,
  email: maskEmail,
  generic: maskGeneric,
}

/** 同列多层命中时取更严格的类型；缺省返回另一个。 */
export function stricterType(first, second) {
  if (!first) return second
  if (!second) return first
  return (_TYPE_PRECEDENCE[first] ?? 0) >= (_TYPE_PRECEDENCE[second] ?? 0) ? first : second
}

/**
 * 按列类型掩码。NULL/空串原样；已含 * 的值视为已掩码（幂等）。
 * 命中脱敏列后**不论值是什么格式都按该列类型兜底掩码**（int 手机号/卡号也转字符串后掩）。
 * bytes（Uint8Array）先尝试按 UTF-8 解码再掩码（TEXT/BINARY 混用时不留可解码的原文）。
 *
 * valueKind：该列到达值的 Python 等价形态（见 _valueKindOf）。int 列上以字符串
 * 到达的 BIGINT 先转回整数文本（等价 Python str(int)）；decimal 列保持字符串
 * （Python str(Decimal) 同型）。掩码只作用于字符串。
 */
export function maskValue(value, maskType, valueKind = 'text') {
  if (!_MASKS[maskType]) maskType = 'generic'
  if (value === null || value === undefined) return value
  if (value instanceof Uint8Array) {
    let text
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(value)
    } catch {
      text = String(value)
    }
    if (text === '' || text.includes('*')) return value
    return _MASKS[maskType](text)
  }
  if (typeof value === 'string') {
    if (value === '' || value.includes('*')) return value // 空值没有可泄露内容；含 * 已掩过
    if (valueKind === 'int') {
      // BIGINT 手机号/卡号在 JS 侧以字符串到达；Python 侧是 int，str() 后无小数点
      const normalized = /^-?\d+$/.test(value) ? String(BigInt(value)) : value
      if (normalized === '' || normalized.includes('*')) return value
      return _MASKS[maskType](normalized)
    }
    return _MASKS[maskType](value) // decimal → str(Decimal) 同为字符串，直接掩
  }
  // 非字符串（JS number 等）：转字符串后按列类型掩码
  const text = String(value)
  if (text === '' || text.includes('*')) return value
  return _MASKS[maskType](text)
}

// ---------------------------------------------------------------- 值级兜底（第 3 层）

const _PHONE_RE = /^1[3-9]\d{9}$/
const _EMAIL_RE = /^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$/
const _EMAIL_MAX_LENGTH = 320 // RFC 5321 上限附近，超长串不参与值级兜底，避免误判/性能问题
const _ID_WEIGHTS = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
const _ID_CHECK_CODES = '10X98765432'

/** GB 11643-1999 18 位身份证校验位（mod 11-2）校验。 */
export function isValidIdcard18(text) {
  if (text.length !== 18) return false
  const body = text.slice(0, 17)
  const last = text[17].toUpperCase()
  if (!/^\d{17}$/.test(body) || !'0123456789X'.includes(last)) return false
  let total = 0
  for (let i = 0; i < 17; i++) total += Number(body[i]) * _ID_WEIGHTS[i]
  return _ID_CHECK_CODES[total % 11] === last
}

/** 身份证值级判定（高精度）：校验位 + 出生日期都合法才算，避免误伤普通 18/15 位数字。 */
export function isIdcardValue(text) {
  if (text.length === 18) return isValidIdcard18(text) && _validBirthdate18(text)
  if (text.length === 15) return /^\d{15}$/.test(text) && _validBirthdate15(text)
  return false
}

function _validDate(year, month, day) {
  const value = new Date(year, month - 1, day)
  if (Number.isNaN(value.getTime())) return false
  if (value.getFullYear() !== year || value.getMonth() !== month - 1 || value.getDate() !== day) {
    return false
  }
  const today = new Date()
  const start = new Date(1900, 0, 1)
  const floor = new Date(today.getFullYear(), today.getMonth(), today.getDate())
  return start <= value && value <= floor
}

/** 18 位身份证第 7~14 位（YYYYMMDD）必须合法且不早于 1900-01-01、不晚于今天。 */
function _validBirthdate18(text) {
  const segment = text.slice(6, 14)
  if (segment.length !== 8 || !/^\d{8}$/.test(segment)) return false
  return _validDate(Number(segment.slice(0, 4)), Number(segment.slice(4, 6)),
    Number(segment.slice(6, 8)))
}

/** 15 位老身份证第 7~12 位（YYMMDD，年份按 19YY）必须合法。 */
function _validBirthdate15(text) {
  const segment = text.slice(6, 12)
  if (segment.length !== 6 || !/^\d{6}$/.test(segment)) return false
  return _validDate(1900 + Number(segment.slice(0, 2)), Number(segment.slice(2, 4)),
    Number(segment.slice(4, 6)))
}

function _luhnValid(text) {
  let total = 0
  const reversed = [...text].reverse()
  for (let index = 0; index < reversed.length; index++) {
    let digit = Number(reversed[index])
    if (index % 2 === 1) {
      digit *= 2
      if (digit > 9) digit -= 9
    }
    total += digit
  }
  return total % 10 === 0
}

// 真实卡组织 IIN 前缀 → 允许的卡号长度（契约 §3.7「高精度」）
const _BANKCARD_SCHEMES = [
  ['34', [15], 'amex'],
  ['37', [15], 'amex'],
  ['35', [16, 17, 18, 19], 'jcb'],
  ['6011', [16, 19], 'discover'],
  ['65', [16, 19], 'discover'],
  ['62', [16, 17, 18, 19], 'unionpay'],
]

function _bankcardScheme(text) {
  if (text.slice(0, 1) === '4') return 'visa'
  if (text.length >= 2 && text[0] === '5' && '12345'.includes(text[1])) {
    return 'mastercard' // 51~55，16 位
  }
  for (const [prefix, _lengths, scheme] of _BANKCARD_SCHEMES) {
    if (text.startsWith(prefix)) return scheme
  }
  return ''
}

/**
 * 银行卡值级判定（高精度）：纯数字 + 合法 IIN 前缀 + 该卡组织长度 + Luhn。
 * 只靠「长度 + Luhn」不够：19 位雪花订单号约 15% 会碰巧通过 Luhn，
 * 必须再校验 IIN 前缀才不会误伤业务 ID。
 */
export function isValidBankcard(text) {
  if (!/^\d+$/.test(text)) return false
  const scheme = _bankcardScheme(text)
  const allowedLengths = {
    visa: [13, 16, 19],
    mastercard: [16],
    amex: [15],
    jcb: [16, 17, 18, 19],
    discover: [16, 19],
    unionpay: [16, 17, 18, 19],
  }[scheme]
  if (!allowedLengths || !allowedLengths.includes(text.length)) return false
  return _luhnValid(text)
}

/**
 * 值级兜底：列没标记/被 ALIAS 绕过时，强特征值同样强制掩码。
 * valueKind='int' 时字符串先归一成整数文本（等价 Python str(int)）；
 * valueKind='decimal' 时原样返回（Python Decimal/float 不走兜底）；
 * 其余只处理整数 number 与字符串。2 开头的 11 位数字不符合 ^1[3-9]\d{9}$，不会误伤。
 */
export function fallbackMask(value, valueKind = 'text') {
  if (value === null || value === undefined || typeof value === 'boolean') return value
  if (valueKind === 'decimal') return value // Decimal/float 列：非文本，不参与兜底
  let text
  if (typeof value === 'number') {
    // Python int 才参与兜底；float（非整数/超安全整数）原样返回
    if (!Number.isInteger(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) return value
    text = String(value)
  } else if (typeof value === 'bigint') {
    text = String(value)
  } else if (typeof value === 'string') {
    if (valueKind === 'int' && /^-?\d+$/.test(value)) {
      text = String(BigInt(value)) // BIGINT 列的字符串形态 → 整数文本
    } else {
      text = value.trim()
    }
    if (!text) return value
  } else {
    return value
  }
  if (text.includes('*')) return value // 幂等：已经是掩码值
  if (_PHONE_RE.test(text)) return maskPhone(text)
  if (isIdcardValue(text)) return maskIdcard(text)
  if (isValidBankcard(text)) return maskBankcard(text)
  if (text.length <= _EMAIL_MAX_LENGTH && _EMAIL_RE.test(text)) return maskEmail(text)
  return value
}

// mysql2 字段包的数值类型码（MySQL 协议，与 pymysql FIELD_TYPE 同源）。
// Python 侧这些列到达时分别是 int（整型）/ Decimal、float（DECIMAL/FLOAT/DOUBLE），
// 决定它们在表达式 fail-safe 与值级兜底里是否按文本处理。
const _INT_COLUMN_TYPES = new Set([1, 2, 3, 8, 9, 13, 16])       // tiny~bigint/int24/year/bit
const _DECIMAL_COLUMN_TYPES = new Set([0, 4, 5, 246])            // decimal/float/double/newdecimal

// ---------------------------------------------------------------- 列名启发式（第 2 层 + analyze 内置规则）

// 内置五类的中英文常见命名；英文用 token 边界匹配（hotel 里的 tel 不算 phone），中文直接子串
const _BUILTIN_PATTERNS = {
  name: ['real_name', 'realname', 'full_name', 'fullname', 'user_name', 'username',
    'true_name', 'contact_name', '姓名', '真实姓名', '联系人'],
  phone: ['mobile', 'mobile_phone', 'phone', 'phone_no', 'phone_number',
    'tel', 'tel_no', 'telephone', 'cellphone', 'msisdn',
    '手机号', '手机号码', '手机', '联系电话', '电话号码', '联系方式'],
  idcard: ['id_card', 'idcard', 'id_no', 'id_number', 'cert_no', 'certificate_no',
    'identity_card', 'identity_no',
    '身份证号', '身份证', '证件号', '证件号码'],
  bankcard: ['card_no', 'cardno', 'card_number', 'card_num', 'bank_card', 'bankcard',
    'bank_card_no', '银行卡号', '银行卡', '卡号'],
  email: ['email', 'e_mail', 'mail', 'email_addr', 'email_address', 'mail_addr',
    '邮件', '邮件地址', '邮箱', '电子邮箱', '电子信箱'],
}

const _BUILTIN_ORDER = ['name', 'phone', 'idcard', 'bankcard', 'email']

/** 列名启发式：命中内置五类返回类型名，否则返回空串。 */
export function builtinColumnType(columnName) {
  const text = String(columnName ?? '').trim()
  if (!text) return ''
  const lowered = text.toLowerCase()
  const normalized = lowered.replace(/[\s\-]+/g, '_')
  for (const maskType of _BUILTIN_ORDER) {
    for (const pattern of _BUILTIN_PATTERNS[maskType]) {
      // Python str.isascii()：全 ASCII 才走 token 边界匹配
      const isAscii = [...pattern].every((ch) => ch.charCodeAt(0) < 128)
      if (isAscii) {
        const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        if (new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(normalized)) {
          return maskType
        }
      } else if (lowered.includes(pattern)) {
        return maskType
      }
    }
  }
  return ''
}

// ---------------------------------------------------------------- SQL 标识符扫描（表达式 fail-safe 用）

/**
 * 提取 SQL 里的标识符 token（跳过字符串字面量与注释；反引号标识符取内部内容）。
 * 只用于「这条 SQL 是否碰了敏感列」的保守判断，不做语法分析。
 */
export function sqlIdentifiers(sql) {
  const tokens = []
  const word = []
  const input = String(sql ?? '')
  const size = input.length
  const flush = () => {
    if (word.length) {
      tokens.push(word.join(''))
      word.length = 0
    }
  }
  let index = 0
  while (index < size) {
    const char = input[index]
    const nxt = index + 1 < size ? input[index + 1] : ''
    if (char === "'" || char === '"') { // 字符串字面量整体跳过（含 '' / \' 转义）
      const quote = char
      index += 1
      while (index < size) {
        if (input[index] === '\\') { index += 2; continue }
        if (input[index] === quote) {
          if (index + 1 < size && input[index + 1] === quote) { index += 2; continue }
          index += 1
          break
        }
        index += 1
      }
      continue
    }
    if (char === '`') { // 反引号标识符：内容当 token
      flush()
      index += 1
      const buf = []
      while (index < size) {
        if (input[index] === '`') {
          if (index + 1 < size && input[index + 1] === '`') {
            buf.push('`')
            index += 2
            continue
          }
          index += 1
          break
        }
        buf.push(input[index])
        index += 1
      }
      if (buf.length) tokens.push(buf.join(''))
      continue
    }
    if (char === '#' || (char === '-' && nxt === '-')) { // 行注释
      const newline = input.indexOf('\n', index)
      index = newline === -1 ? size : newline
      continue
    }
    if (char === '/' && nxt === '*') { // 块注释
      const end = input.indexOf('*/', index + 2)
      index = end === -1 ? size : end + 2
      continue
    }
    if (_isWordChar(char)) {
      word.push(char)
      index += 1
      continue
    }
    flush()
    index += 1
  }
  flush()
  return tokens
}

/** Python str.isalnum() 的 ASCII 近似 + 下划线（标识符收集面与 Python 一致）。 */
function _isWordChar(char) {
  return (char >= '0' && char <= '9') || (char >= 'a' && char <= 'z')
    || (char >= 'A' && char <= 'Z') || char === '_'
}

/**
 * SQL 里是否出现敏感命名（内置五类命名或配置里的脱敏列名），token 边界匹配。
 * excludeAliases=true 时跳过 `AS <ident>` 里的输出别名——别名只是展示名，不是列引用。
 */
export function sqlHasSensitiveIdentifier(sql, configuredColumns = null, excludeAliases = true) {
  const tokens = sqlIdentifiers(sql)
  const aliasIndices = new Set()
  if (excludeAliases) {
    for (let index = 0; index < tokens.length - 1; index++) {
      if (tokens[index].toLowerCase() === 'as') aliasIndices.add(index + 1)
    }
  }
  const configured = new Set(
    (configuredColumns || []).filter(Boolean).map((column) => String(column).toLowerCase()))
  for (let index = 0; index < tokens.length; index++) {
    if (aliasIndices.has(index)) continue
    if (builtinColumnType(tokens[index])) return true
    if (configured.has(tokens[index].toLowerCase())) return true
  }
  return false
}

// 显式输出别名：`... AS alias` / `... AS `alias``
const _SELECT_ALIAS_RE = /\s+as\s+(?:`(?:[^`]|``)*`|[A-Za-z0-9_$]+)\s*$/i

/** 去掉 select item 尾部的显式 `AS <别名>`（隐式别名不做识别，保持保守）。 */
export function stripSelectAlias(item) {
  return String(item ?? '').replace(new RegExp(_SELECT_ALIAS_RE.source, 'is'), '').trim()
}

function _skipString(text, index, quote) {
  index += 1
  const size = text.length
  while (index < size) {
    if (text[index] === '\\') { index += 2; continue }
    if (text[index] === quote) {
      if (index + 1 < size && text[index + 1] === quote) { index += 2; continue }
      return index + 1
    }
    index += 1
  }
  return size
}

function _skipBacktick(text, index) {
  index += 1
  const size = text.length
  while (index < size) {
    if (text[index] === '`') {
      if (index + 1 < size && text[index + 1] === '`') { index += 2; continue }
      return index + 1
    }
    index += 1
  }
  return size
}

/** 把 [start, end) 的 select 列表按顶层逗号切成 item，并标记是否有顶层 `*`。 */
function _splitSelectItems(text, start, end) {
  const items = []
  let hasStar = false
  let itemStart = start
  let index = start
  let depth = 0
  while (index < end) {
    const char = text[index]
    const nxt = index + 1 < end ? text[index + 1] : ''
    if (char === "'" || char === '"') {
      index = Math.min(_skipString(text, index, char), end)
      continue
    }
    if (char === '`') {
      index = Math.min(_skipBacktick(text, index), end)
      continue
    }
    if (char === '#' || (char === '-' && nxt === '-')) {
      const newline = text.indexOf('\n', index)
      index = newline === -1 || newline >= end ? end : newline
      continue
    }
    if (char === '/' && nxt === '*') {
      const commentEnd = text.indexOf('*/', index + 2)
      index = commentEnd === -1 ? end : Math.min(commentEnd + 2, end)
      continue
    }
    if (char === '(') { depth += 1; index += 1; continue }
    if (char === ')') { depth = Math.max(0, depth - 1); index += 1; continue }
    if (depth === 0 && char === ',') {
      items.push(text.slice(itemStart, index).trim())
      itemStart = index + 1
      index += 1
      continue
    }
    if (depth === 0 && char === '*') {
      hasStar = true
      index += 1
      continue
    }
    index += 1
  }
  items.push(text.slice(itemStart, end).trim())
  return { items: items.filter((item) => item), hasStar }
}

/**
 * 解析顶层 `SELECT ... FROM` 的 select 列表，供表达式 fail-safe 精确到 item。
 * 返回 {items, hasStar}；无法可靠解析（不是 SELECT 开头、WITH/EXPLAIN 等 CTE/前缀语句、
 * 括号结构异常）返回 null，调用方回退到「整条 SQL」的保守判定。
 */
export function selectListItems(sql) {
  const text = String(sql ?? '')
  const size = text.length
  let index = 0
  let depth = 0
  let listStart = null
  while (index < size) {
    const char = text[index]
    const nxt = index + 1 < size ? text[index + 1] : ''
    if (char === "'" || char === '"') {
      if (listStart === null) return null
      index = _skipString(text, index, char)
      continue
    }
    if (char === '`') {
      if (listStart === null) return null
      index = _skipBacktick(text, index)
      continue
    }
    if (char === '#' || (char === '-' && nxt === '-')) {
      const newline = text.indexOf('\n', index)
      index = newline === -1 ? size : newline
      continue
    }
    if (char === '/' && nxt === '*') {
      const commentEnd = text.indexOf('*/', index + 2)
      index = commentEnd === -1 ? size : commentEnd + 2
      continue
    }
    if (char === '(') {
      if (listStart === null) return null // 以括号开头（如 (select ...)）→ 保守回退
      depth += 1
      index += 1
      continue
    }
    if (char === ')') {
      depth = Math.max(0, depth - 1)
      index += 1
      continue
    }
    if (_isAlpha(char) || char === '_') {
      const start = index
      while (index < size && (_isWordChar(text[index]))) index += 1
      const token = text.slice(start, index)
      if (listStart === null) {
        if (token.toUpperCase() !== 'SELECT') return null // WITH / EXPLAIN / 其它前缀
        listStart = index
        continue
      }
      if (depth === 0 && token.toUpperCase() === 'FROM') {
        return _splitSelectItems(text, listStart, start)
      }
      continue
    }
    index += 1
  }
  if (listStart === null) return null
  return _splitSelectItems(text, listStart, size)
}

/** Python str.isalpha() 的 ASCII 近似（select/from 关键字扫描面一致）。 */
function _isAlpha(char) {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z')
}

// ---------------------------------------------------------------- 出站掩码（三层叠加 + 表达式 fail-safe）

/** 单列候选类型：配置层 + 列名启发式层，取更严格。 */
function _columnType(configured, columnName) {
  if (!columnName) return null
  const lowered = columnName.toLowerCase()
  return stricterType(configured.get(lowered) ?? null, builtinColumnType(columnName) || null)
}

function _isTextValue(value, valueKind = 'text') {
  if (typeof value === 'string') return valueKind !== 'decimal'
  return value instanceof Uint8Array
}

function _textOf(value) {
  if (typeof value === 'string') return value
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value)
  } catch {
    return String(value)
  }
}

/** 表达式列（无源列名）的保守掩码：只处理字符串值，数值聚合不动。 */
function _expressionFailsafeMask(value) {
  const text = _textOf(value)
  if (text === '' || text.includes('*')) return value
  return maskGeneric(text)
}

/**
 * mysql2 字段包 → 该列到达值的 Python 等价形态：
 * - 'int'：整型列（BIGINT 手机号/卡号以字符串到达，转回数字形态参与兜底）；
 * - 'decimal'：DECIMAL/FLOAT/DOUBLE（Python 的 Decimal/float，非文本，不走兜底）；
 * - 'text'：其它（字符串形态）。
 * 字段包缺失时按 'text'（SQL 文本里到达的量本就是字符串，Python str 同型）。
 */
function _valueKindOf(field) {
  const code = field && typeof field === 'object' && typeof field.columnType === 'number'
    ? field.columnType
    : (field && typeof field === 'object' && typeof field.typeCode === 'number'
      ? field.typeCode : null)
  if (code === null) return 'text'
  if (_INT_COLUMN_TYPES.has(code)) return 'int'
  if (_DECIMAL_COLUMN_TYPES.has(code)) return 'decimal'
  return 'text'
}

/**
 * 对一组结果行做脱敏（契约 §3.7，结果出站前唯一入口）。
 *
 * @param masking connection.masking 配置（enabled/fields…）；未开启时原样返回 rows
 * @param columns 列元信息列表，元素可以是
 *   {name, orgName, orgTable, orgKnown, columnType}（mysql2 字段包，推荐）
 *   或纯字符串/{name}（退回按结果列名匹配，兼容旧调用/测试）
 * @param rows 二维原始值数组（**JSON 化之前**，保留数值类型信息给 fail-safe 判数值聚合）
 * @param sql 该条语句原文（表达式 fail-safe 用来判断是否碰了敏感标识符）
 * @returns 掩码后的二维值数组
 */
export function maskRows(masking, columns, rows, sql = '') {
  if (!masking || typeof masking !== 'object' || masking instanceof Array
    || !masking.enabled) {
    return rows // 未开启：零开销、行为不变
  }

  const configured = new Map()
  for (const field of masking.fields || []) {
    if (!field || typeof field !== 'object' || field instanceof Array) continue
    const column = String(field.column ?? '').trim().toLowerCase()
    if (!column) continue
    let maskType = String(field.type ?? 'generic').trim().toLowerCase()
    if (!_MASKS[maskType]) maskType = 'generic'
    configured.set(column, stricterType(configured.get(column) ?? null, maskType))
  }

  const plans = []
  for (const column of columns || []) {
    let resultName
    let orgName
    let orgKnown
    let valueKind = 'text'
    if (column && typeof column === 'object' && !(column instanceof Array)) {
      resultName = String(column.name ?? '').trim()
      orgName = String(column.orgName ?? '').trim()
      // orgKnown=true 表示驱动给了真实字段包（orgName 为空=表达式）；false=未知，退回结果列名
      orgKnown = 'orgKnown' in column ? Boolean(column.orgKnown) : 'orgName' in column
      valueKind = _valueKindOf(column)
    } else {
      resultName = String(column ?? '').trim()
      orgName = ''
      orgKnown = false
    }
    // 第 1/2 层：orgName 优先；只有「没有真实字段包」时才用结果列名兜底——
    // 真实表达式列的 resultName 是 AS 别名，别名不是列引用，不能拿它做敏感列启发式
    let maskType = orgName ? _columnType(configured, orgName) : null
    if (!maskType && !orgKnown) {
      maskType = _columnType(configured, resultName)
    }
    plans.push({ type: maskType, expression: !orgName, valueKind })
  }

  // 表达式投影 fail-safe（收窄版）：
  //   - 优先按 select 列表 item 精确判定（item 数 == 结果列数且列表无顶层 * 时映射可靠）：
  //     表达式列只在自己的 item 引用了敏感列时才 generic 掩；
  //   - 映射不可靠（含 * / item 数不匹配 / 解析失败）→ 回退「整条 SQL 含敏感标识符」的保守行为；
  //   - 两条路径都会跳过 AS 别名（别名只是展示名，不是列引用）。
  let perColumnFailsafe = null
  let conservativeFailsafe = false
  if (sql) {
    const parsed = selectListItems(sql)
    if (parsed !== null && !parsed.hasStar && parsed.items.length === plans.length) {
      perColumnFailsafe = []
      for (let index = 0; index < parsed.items.length; index++) {
        const expression = index < plans.length ? plans[index].expression : false
        perColumnFailsafe.push(Boolean(
          expression && sqlHasSensitiveIdentifier(
            stripSelectAlias(parsed.items[index]), [...configured.keys()])))
      }
    } else {
      conservativeFailsafe = sqlHasSensitiveIdentifier(sql, [...configured.keys()])
    }
  }

  const maskedRows = []
  for (const row of rows) {
    const maskedRow = []
    for (let index = 0; index < row.length; index++) {
      const value = row[index]
      const plan = index < plans.length
        ? plans[index]
        : { type: null, expression: false, valueKind: 'text' }
      const maskType = plan.type
      if (maskType) {
        maskedRow.push(maskValue(value, maskType, plan.valueKind))
        continue
      }
      let sensitiveExpression = false
      if (plan.expression && _isTextValue(value, plan.valueKind)) {
        if (perColumnFailsafe !== null) {
          sensitiveExpression = index < perColumnFailsafe.length
            && Boolean(perColumnFailsafe[index])
        } else if (conservativeFailsafe) {
          sensitiveExpression = true
        }
      }
      if (sensitiveExpression) {
        maskedRow.push(_expressionFailsafeMask(value))
      } else {
        maskedRow.push(fallbackMask(value, plan.valueKind))
      }
    }
    maskedRows.push(maskedRow)
  }
  return maskedRows
}

// ---------------------------------------------------------------- 结构分析（工单/连接配置用）

const _SYSTEM_SCHEMAS = ['information_schema', 'mysql', 'performance_schema', 'sys']

/** Python `str(value or "")` 的等价物：None/空串 → ""，其余转字符串。 */
function _orEmpty(value) {
  return value ? String(value) : ''
}

/**
 * 从 information_schema 读 [database, table, column, comment]（不取任何数据行）。
 * conn 是 pool 借出的 DbsConn / FakeConn：query(sql, params) → [rows, fields]。
 */
export async function loadSchema(conn, database = '') {
  const sql = database
    ? 'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT '
      + 'FROM information_schema.COLUMNS '
      + "WHERE TABLE_SCHEMA=%s AND TABLE_SCHEMA NOT IN "
      + "('information_schema','mysql','performance_schema','sys') "
      + 'ORDER BY TABLE_NAME, ORDINAL_POSITION'
    : 'SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, COLUMN_COMMENT '
      + 'FROM information_schema.COLUMNS '
      + 'WHERE TABLE_SCHEMA NOT IN '
      + "('information_schema','mysql','performance_schema','sys') "
      + 'ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION'
  const params = database ? [database] : []
  const [rows] = await conn.query(sql, params)
  return (rows || []).map((row) => ({
    database: row[0], table: row[1], column: row[2], comment: _orEmpty(row[3]),
  }))
}

function _keywordHitReason(table, column, comment, keywords) {
  for (const keyword of keywords) {
    const lowered = keyword.toLowerCase()
    if (column.toLowerCase().includes(lowered)) return `关键字命中列名：${keyword}`
    if (table.toLowerCase().includes(lowered)) return `关键字命中表名：${keyword}`
    if (comment.toLowerCase().includes(lowered)) return `关键字命中列注释：${keyword}`
  }
  return ''
}

/**
 * 按 schema 分析候选脱敏字段（不连库，纯计算）。
 * - 内置列名启发式命中的五种 → mandatory:true（只能由后端写）；
 * - 用户关键字命中表名/列名/列注释 → generic，mandatory:false（可增删）；
 * - 同一表列去重；强制项排前面。
 */
export function analyze(schema, keywords = null) {
  const keywordList = []
  const seenKeywords = new Set()
  for (const keyword of keywords || []) {
    if (typeof keyword !== 'string') continue
    const text = keyword.trim()
    if (text && !seenKeywords.has(text.toLowerCase())) {
      seenKeywords.add(text.toLowerCase())
      keywordList.push(text)
    }
  }

  const candidates = new Map()
  const tables = new Set()
  let columnsTotal = 0
  for (const item of schema || []) {
    if (!item || typeof item !== 'object' || item instanceof Array) continue
    const database = String(item.database ?? '')
    const table = String(item.table ?? '')
    const column = String(item.column ?? '')
    const comment = String(item.comment ?? '')
    if (!table || !column) continue
    columnsTotal += 1
    tables.add(`${database}\u0000${table}`)

    const builtin = builtinColumnType(column)
    let candidate = null
    if (builtin) {
      candidate = {
        table, column, type: builtin, mandatory: true,
        reason: `内置：字段名命中${TYPE_LABELS[builtin]}`,
      }
    } else {
      const reason = _keywordHitReason(table, column, comment, keywordList)
      if (reason) {
        candidate = { table, column, type: 'generic', mandatory: false, reason }
      }
    }
    if (candidate === null) continue
    const key = `${table.toLowerCase()}\u0000${column.toLowerCase()}`
    const existing = candidates.get(key)
    if (!existing || (candidate.mandatory && !existing.mandatory)) {
      candidates.set(key, candidate)
    }
  }

  const ordered = [...candidates.values()].sort((a, b) => {
    if (a.mandatory !== b.mandatory) return a.mandatory ? -1 : 1
    const tableCmp = a.table.toLowerCase() < b.table.toLowerCase() ? -1
      : a.table.toLowerCase() > b.table.toLowerCase() ? 1 : 0
    if (tableCmp) return tableCmp
    const colA = a.column.toLowerCase()
    const colB = b.column.toLowerCase()
    return colA < colB ? -1 : colA > colB ? 1 : 0
  })
  return {
    candidates: ordered,
    summary: { tables: tables.size, columns: columnsTotal, masked: ordered.length },
  }
}

/** 连库读 schema 后做分析；数据库不可用会抛异常，由调用方决定是否降级。 */
export async function analyzeConnection(info, keywords = null, database = undefined) {
  const scope = database !== undefined && database !== null
    ? database
    : (info.database || '')
  const schema = await pool.runWithRetry(
    info.id || '__draft__', info, '',
    async (conn) => loadSchema(conn, scope))
  return analyze(schema, keywords)
}

/** 该连接可见的所有 (table, column) 小写集合（扫全部非系统库），键形 "table\u0000column"。 */
export async function connectionSchemaKeys(info) {
  const schema = await pool.runWithRetry(
    info.id || '__draft__', info, '',
    async (conn) => loadSchema(conn, ''))
  return new Set(schema.map((item) =>
    `${String(item.table ?? '').toLowerCase()}\u0000${String(item.column ?? '').toLowerCase()}`))
}

// ---------------------------------------------------------------- 测试注入接缝

/**
 * monkeypatch 目标：Python 测试对 mask_core.analyze_connection /
 * connection_schema_keys 打补丁；ESM 命名导出不可变，改为覆写本对象属性。
 * 默认指向本模块实现；api 层只经 seams 调用这两个函数。
 */
export const seams = {
  analyzeConnection: (info, keywords = null, database = undefined) =>
    analyzeConnection(info, keywords, database),
  connectionSchemaKeys: (info) => connectionSchemaKeys(info),
}
