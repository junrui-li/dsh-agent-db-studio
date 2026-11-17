/**
 * 写窗口（V2.4）：会话级的「临时开闸」时间闸，全局 allowWrites（插件配置 + 工具 when 隐藏）
 * 之外的第二道闸。server/api/writes_window.py 的移植。
 *
 * - 状态存 dbs.db meta 表（`writes_window_open_until`，ISO "YYYY-MM-DD HH:MM:SS"），读时惰性判
 *   过期——不写后台任务，到期即关；
 * - 四个 MySQL 写入口统一检查（/api/execute、工单批准执行、/api/write-rows、/api/undo）：
 *   窗口关闭 → 403 `WRITES_CLOSED`；Redis 路径不受约束（V2 范围约束：Redis 保持现状）；
 * - 设计取舍（ROADMAP ADR D6）：全局 allowWrites 保持 `when` 隐藏作总闸（ADR D4）；会话窗口是
 *   运行时闸——工具注册着，执行时被拦并给出「请让用户在面板临时开闸」的可执行建议。
 */

import * as db from '../store/db.js'
import { ApiError } from '../core/errors.js'
import { actorOf, audit, boolField, bodyOf, intField, now } from './common.js'

const _META_KEY = 'writes_window_open_until'
const _ALLOWED_MINUTES = [15, 30, 60]

/** ISO 字符串 → 可比较的字符串（同格式字典序即时间序）；无效返回 null。 */
function _parseUntil(value) {
  const text = String(value || '').trim()
  if (text.length !== 19 || text[4] !== '-' || text[7] !== '-' || text[10] !== ' ') {
    return null
  }
  return text
}

function _parseStamp(text) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text || '')
  if (!m) return null
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6]))
}

function _formatStamp(d) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    + ` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 同格式时间字符串差（秒）；解析失败返回 0（视为已过期）。 */
function _secondsBetween(nowText, untilText) {
  const a = _parseStamp(nowText)
  const b = _parseStamp(untilText)
  if (!a || !b) return 0
  return Math.trunc((b.getTime() - a.getTime()) / 1000)
}

/** 当前窗口状态：{open, openUntil, minutesLeft}；关闭时 open=false、字段为空。 */
export function windowState() {
  const raw = _parseUntil(db.metaGet(_META_KEY))
  if (raw === null) {
    return { open: false, openUntil: '', minutesLeft: 0 }
  }
  const nowText = now()
  if (nowText >= raw) { // 惰性过期：读到已过期即视为关闭
    return { open: false, openUntil: '', minutesLeft: 0 }
  }
  const secondsLeft = Math.max(0, _secondsBetween(nowText, raw))
  return {
    open: true,
    openUntil: raw,
    minutesLeft: Math.max(1, Math.floor((secondsLeft + 59) / 60)),
  }
}

/** 写入口统一闸门：窗口关闭 → 403 WRITES_CLOSED（带可执行建议）。 */
export function ensureOpen() {
  const state = windowState()
  if (!state.open) {
    throw new ApiError(403,
      '写窗口未开启：这是会话级写总闸（到时自动关）。请让用户在面板「数据管理 → 工单」'
      + '点「临时开闸」（15/30/60 分钟）后再试。',
      'WRITES_CLOSED')
  }
}

export function handleGet(_query, _body = null, _headers = null) {
  return { window: windowState() }
}

/** 开闸/关闸：{minutes: 15|30|60} 或 {close: true}。开闸时若已有窗口则顺延叠加。 */
export function handleSet(_query, body = null, headers = null) {
  const payload = bodyOf(body)
  const actor = actorOf(headers)
  if (boolField(payload, 'close', false)) {
    db.metaSet(_META_KEY, '')
    audit(actor, 'writes_window.close')
    return { window: windowState() }
  }
  let minutes = intField(payload, 'minutes', 0, 0, 720, 'minutes')
  if (!_ALLOWED_MINUTES.includes(minutes)) {
    throw new ApiError(400,
      `minutes 只允许 ${_ALLOWED_MINUTES.join(', ')}`,
      'WRITES_WINDOW_MINUTES')
  }
  const state = windowState()
  if (state.open) {
    // 已有窗口：剩余分钟 + 新分钟（分钟粒度顺延叠加，15 剩余叠 30 = 45）
    minutes = Math.min(720, state.minutesLeft + minutes)
  }
  const base = _parseStamp(now())
  const until = _formatStamp(new Date(base.getTime() + minutes * 60_000))
  db.metaSet(_META_KEY, until)
  audit(actor, 'writes_window.open', minutes, until)
  return { window: windowState() }
}
