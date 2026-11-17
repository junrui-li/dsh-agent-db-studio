/**
 * SQL 脚本切分器：单遍字符扫描状态机。server/core/sqlsplit.py 的逐行移植。
 *
 * 处理：-- 与 # 行注释、块注释（含 `/*!50000` 条件注释）、单/双引号与反引号字面量
 * （含 '' 与 \' 转义）、DELIMITER 自定义分隔符（须独占一行，大小写不敏感）。
 * 只有注释/空白的段不产生语句、不计入序号。
 * 输出 [{index, sql, start_line}]，start_line 为语句首个非注释字符所在行。
 */

const _DELIM_RE = /^delimiter\s+(\S+)\s*$/i

export function splitSql(text) {
  const statements = []
  let delim = ';'
  let buf = [] // 当前语句字符
  let bufHasCode = false // 自上次 emit 后是否出现过非注释非空白字符
  let bufLine = 0 // 语句起始行
  let line = 1
  let atLineStart = true // 本行内尚未出现任何语句内容（DELIMITER 须在行首）
  const n = text.length
  let i = 0

  function emit() {
    if (bufHasCode) {
      statements.push({
        index: statements.length + 1,
        sql: buf.join('').trim(),
        start_line: bufLine,
      })
    }
    buf = []
    bufHasCode = false
    bufLine = 0
  }

  while (i < n) {
    const c = text[i]
    const nxt = i + 1 < n ? text[i + 1] : ''

    // 行首 DELIMITER 指令：切换分隔符，该行不参与语句
    if (atLineStart && c !== '\r' && c !== '\n' && !bufHasCode) {
      const j = text.indexOf('\n', i)
      const lineText = j === -1 ? text.slice(i) : text.slice(i, j + 1)
      const m = _DELIM_RE.exec(lineText.replace(/[\r\n]+$/, ''))
      if (m) {
        line += (lineText.match(/\n/g) || []).length
        i += lineText.length
        delim = m[1]
        atLineStart = true
        continue
      }
    }

    if (c === '\n') {
      line += 1
      atLineStart = true
      if (bufHasCode) buf.push(c)
      i += 1
      continue
    }
    if ((c === ' ' || c === '\t' || c === '\r') && !bufHasCode) {
      i += 1
      continue
    }

    if ((c === '-' && nxt === '-') || c === '#') { // 行注释
      const j = text.indexOf('\n', i)
      i = j === -1 ? n : j
      continue
    }
    if (c === '/' && nxt === '*') { // 块注释（内容整体跳过，不计语句边界）
      const end = text.indexOf('*/', i + 2)
      const segEnd = end === -1 ? n : end + 2
      if (bufHasCode) buf.push(text.slice(i, segEnd))
      line += (text.slice(i, segEnd).match(/\n/g) || []).length
      i = segEnd
      continue
    }

    if (c === "'" || c === '"') { // 字符串字面量
      if (!bufHasCode) {
        bufHasCode = true
        bufLine = line
        atLineStart = false
      }
      buf.push(c)
      i += 1
      while (i < n) {
        if (text[i] === '\\') {
          buf.push(text.slice(i, i + 2))
          i += 2
          continue
        }
        if (text[i] === '\n') line += 1
        buf.push(text[i])
        if (text[i] === c) {
          if (i + 1 < n && text[i + 1] === c) {
            buf.push(text[i + 1])
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
    if (c === '`') { // 标识符字面量（双反引号转义）
      if (!bufHasCode) {
        bufHasCode = true
        bufLine = line
        atLineStart = false
      }
      buf.push(c)
      i += 1
      while (i < n) {
        if (text[i] === '`') {
          if (i + 1 < n && text[i + 1] === '`') {
            buf.push('``')
            i += 2
            continue
          }
          buf.push('`')
          i += 1
          break
        }
        if (text[i] === '\n') line += 1
        buf.push(text[i])
        i += 1
      }
      continue
    }

    // 语句正文 / 分隔符
    if (!bufHasCode) {
      bufHasCode = true
      bufLine = line
      atLineStart = false
    }
    atLineStart = false
    if (delim && text.startsWith(delim, i)) {
      buf.push(delim)
      emit()
      i += delim.length
      continue
    }
    buf.push(c)
    i += 1
  }

  emit()
  return statements
}
