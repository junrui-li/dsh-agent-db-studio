/**
 * 工具结果的人话摘要工具函数。
 *
 * output.render 只负责「给人看的一两行」，完整 JSON 由框架按 output.schema 落盘。
 * 所以这里所有函数都只做有界格式化（截断、前 N 行/列），绝不拼整份结果。
 */

export function clip(text, max = 80) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, Math.max(0, max - 1))}…`
}

export function cellText(value, max = 22) {
  if (value === null) return 'NULL'
  if (value === undefined) return ''
  if (typeof value === 'string') return clip(value.replace(/\s+/g, ' '), max)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (typeof value === 'bigint') return String(value)
  try {
    return clip(JSON.stringify(value), max)
  } catch {
    return clip(String(value), max)
  }
}

export function fmtCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '0'
  return String(Math.trunc(number)).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function fmtMs(value) {
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1_000) return `${Math.round(ms)}ms`
  return `${(ms / 1_000).toFixed(ms < 10_000 ? 2 : 1)}s`
}

/** Redis TTL：-1 永久、-2 不存在（后端约定同 redis）。 */
export function fmtTtl(ttl) {
  const seconds = Number(ttl)
  if (!Number.isFinite(seconds)) return 'TTL 未知'
  if (seconds === -1) return '永久'
  if (seconds === -2) return '已过期'
  if (seconds < 60) return `TTL ${seconds}s`
  if (seconds < 3_600) return `TTL ${Math.round(seconds / 60)}min`
  return `TTL ${(seconds / 3_600).toFixed(1)}h`
}

/** 名字列表：最多列 limit 个，超出给总数。 */
export function joinNames(items, limit = 12) {
  const names = (Array.isArray(items) ? items : []).map(item => (typeof item === 'string' ? item : item?.name)).filter(Boolean)
  if (!names.length) return '（无）'
  const shown = names.slice(0, limit).join('、')
  return names.length > limit ? `${shown} 等 ${names.length} 个` : shown
}

/**
 * 结果集预览：表头 + 前 maxRows 行、前 maxColumns 列。
 * @param {Array<{name?:string}|string>} columns
 * @param {Array<Array<unknown>>} rows
 */
export function previewTable(columns, rows, { maxRows = 5, maxColumns = 8, cellWidth = 22 } = {}) {
  const headers = (Array.isArray(columns) ? columns : [])
    .map(column => (typeof column === 'string' ? column : column?.name))
    .filter(Boolean)
  const safeRows = Array.isArray(rows) ? rows : []
  if (!headers.length) {
    if (!safeRows.length) return '（没有行）'
    return safeRows.slice(0, maxRows).map(row => (Array.isArray(row) ? row.map(cell => cellText(cell, cellWidth)).join(' | ') : cellText(row))).join('\n')
  }
  const visible = headers.slice(0, maxColumns)
  const lines = [visible.join(' | ')]
  for (const row of safeRows.slice(0, maxRows)) {
    const cells = Array.isArray(row) ? row : []
    lines.push(visible.map((_header, index) => cellText(cells[index], cellWidth)).join(' | '))
  }
  const notes = []
  if (safeRows.length > maxRows) notes.push(`共 ${fmtCount(safeRows.length)} 行，只显示前 ${maxRows} 行`)
  if (headers.length > maxColumns) notes.push(`共 ${headers.length} 列，只显示前 ${maxColumns} 列`)
  if (notes.length) lines.push(`（${notes.join('；')}）`)
  else if (!safeRows.length) lines.push('（没有行）')
  return lines.join('\n')
}
