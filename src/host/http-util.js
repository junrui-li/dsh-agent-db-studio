/**
 * Host 侧几个小到不值得单独成模块、但 AI 通道（ai.js）与蒸馏通道（distill.js）
 * 必须共用同一份行为的 HTTP / 错误小工具。
 *
 * 抽出来的唯一理由：两条通道的降级口径必须一致——**永远 200 + 人话 error**，
 * 绝不白屏、绝不 5xx。两处各写一份很容易漂移。
 */
import { clip } from './render.js'

/** 带 HTTP 状态码的请求错误（400 请求体不合法 / 413 太大）。 */
export function httpError(status, message) {
  return Object.assign(new Error(message), { status })
}

export function messageOf(error) {
  if (error instanceof Error && error.message) return error.message
  return String(error ?? '未知错误')
}

/** 一句话的错误摘要：折叠空白 + 截断（写进 error 字段给面板/日志看）。 */
export function shortError(error) {
  return clip(messageOf(error).replace(/\s+/g, ' '), 160)
}

export function jsonResult(res, status, body) {
  if (res.headersSent || res.writableEnded) {
    if (!res.writableEnded) res.end()
    return
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(body))
}

export function jsonError(res, status, message) {
  jsonResult(res, status, { error: message })
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 请求体（Buffer/string）→ JSON 对象；空体/坏 JSON 一律 400。 */
export function parseBody(rawBody) {
  const text = typeof rawBody === 'string'
    ? rawBody
    : Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '')
  if (!text.trim()) throw httpError(400, '请求体为空：需要一个 JSON 对象')
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw httpError(400, '请求体不是合法 JSON')
  }
  return body
}
