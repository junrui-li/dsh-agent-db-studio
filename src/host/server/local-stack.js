/**
 * V3 本地引擎的 Host 侧适配层：对 tools.js / browser.js / ai.js / distill.js 提供
 * 与 supervisor+backend 完全相同的接口，内部全部走进程内 router 调用。
 *
 * supervisor 接口（真实消费点）：
 * - status() → { ready, error, engine, inProcess }
 * - ensureReady() → Promise（失败抛错，中文原因）
 * - dispose()
 *
 * backend 接口（真实消费点）：
 * - getJson(path, query, {signal, actor}) / postJson(path, body, {...})
 * - proxy(pathAndQuery, {method, body, headers, signal, actor}) → {status, contentType, body:Buffer}
 * - fetchHealth(timeoutMs) → payload | null
 * - ensureReady()
 *
 * LocalBackend 的实现要点：
 * - getJson/postJson 直接 dispatch 进 router，把 {status, body} 按原 HTTP 语义转成
 *   BackendError（复用 backend.js 的 ERROR_HINTS 翻译）或 JSON 返回；
 * - proxy 同样进 router；二进制导出下载路由单独读文件；
 * - fetchHealth 走 engine.health()；
 * - 超时语义：AbortSignal 照常支持；settings.timeout 不再需要请求级竞速
 *   （DbsConn 层已做查询超时），保留 signal 取消。
 */

import { BackendError } from '../error-hints.js'
import { createEngine } from './runtime.js'
import { readExportData } from './api/tickets.js'
import { ApiError } from './core/errors.js'

/** 把 router 的 {status, body} 按 backend.callJson 的语义抛成 BackendError。 */
function toResultOrError(status, body, path) {
  if (status >= 400) {
    const code = typeof body?.code === 'string' ? body.code : ''
    const reason = typeof body?.error === 'string' && body.error ? body.error : `HTTP ${status}`
    // ERROR_HINTS 的中文指引在 backend.js 里，本地引擎复用同一张表
    return { status, body, code, reason, error: makeBackendError(status, code, reason, path) }
  }
  return { status, body, code: '', reason: '', error: null }
}

import { ERROR_HINTS } from '../error-hints.js'

function makeBackendError(status, code, reason, _path) {
  const hint = ERROR_HINTS[code]
  return new BackendError(
    hint ? `${hint}。后端说明：${reason}` : `后端返回 ${status}：${reason}`,
    { status, code },
  )
}

export function createLocalStack(settings) {
  const engine = createEngine(settings)

  const supervisor = {
    status() {
      // 内置引擎：无子进程、无端口。engine:'node' + inProcess 标记供 db_status 展示。
      return { ready: true, error: null, engine: 'node', inProcess: true }
    },
    async ensureReady() {
      // 进程内引擎：组装即就绪（迁移失败会让 createEngine 抛错，不会走到这）
    },
    dispose() {
      engine.dispose()
    },
  }

  async function dispatchJson(method, path, { query, body, signal, actor = 'agent' } = {}) {
    if (signal?.aborted) throw new BackendError('请求已取消。')
    const headers = { 'x-dbs-actor': actor }
    const [status, responseBody, , , error] = await dispatchRaw(method, path, { query, body, headers, actor })
    void status
    if (error) throw error
    return responseBody
  }

  async function dispatchRaw(method, path, { query, body, headers, actor = 'agent' } = {}) {
    // path 形如 /api/xxx；query 对象 → router 期望的 query 参数。
    // 返回 [status, body, code, reason, error]——error 非 null 时调用方必须抛。
    const result = await engine.router.dispatch(method, path, {
      query: query ?? {},
      body: body ?? null,
      headers: headers ?? { 'x-dbs-actor': actor },
    })
    const { status, body: responseBody, code, reason, error } = toResultOrError(
      result.status, result.body, path)
    return [status, responseBody, code, reason, error]
  }

  const backend = {
    ensureReady: supervisor.ensureReady,
    async getJson(path, query, options = {}) {
      return dispatchJson('GET', path, { ...options, query })
    },
    async postJson(path, body, options = {}) {
      return dispatchJson('POST', path, { ...options, body })
    },
    /** 浏览器通道透传：/api/** 进 router；导出下载走文件读取。 */
    async proxy(pathAndQuery, options = {}) {
      const { method = 'GET', body, headers = {}, signal, actor = 'user' } = options
      if (signal?.aborted) throw new BackendError('请求已取消。')
      const [path, search = ''] = pathAndQuery.split('?')
      // 二进制下载路由（契约 §3.6）：/api/tickets/export/download?id=...
      if (method === 'GET' && path === '/api/tickets/export/download') {
        const params = new URLSearchParams(search)
        try {
          const payload = await readExportData(params.get('id') || '')
          const buffer = Buffer.from(JSON.stringify(payload), 'utf8')
          return {
            status: 200,
            contentType: 'application/json; charset=utf-8',
            body: buffer,
          }
        } catch (error) {
          const status = error instanceof ApiError ? error.status : 500
          return {
            status,
            contentType: 'application/json; charset=utf-8',
            body: Buffer.from(JSON.stringify({ error: error.message }), 'utf8'),
          }
        }
      }
      // 浏览器通道的 POST 是原始字节（sidecar 时代由 Flask 负责解析 JSON；V3 router 不解析）。
      // Buffer 直进 handler 会骗过 bodyOf（typeof 'object'）却取不到任何字段——面板全部 POST 400。
      // 这里归约为 JS 对象：空体/坏 JSON → null（与 request.get_json(silent=True) 同语义）。
      let parsed = body
      if (method === 'POST' && Buffer.isBuffer(body)) {
        const text = body.toString('utf8').trim()
        if (!text) {
          parsed = null
        } else {
          try {
            parsed = JSON.parse(text)
          } catch {
            parsed = null
          }
        }
      }
      const [status, responseBody, , , error] = await dispatchRaw(method, path, {
        query: Object.fromEntries(new URLSearchParams(search)),
        body: parsed, headers, actor,
      })
      if (error) {
        return {
          status: error.status ?? status,
          contentType: 'application/json; charset=utf-8',
          body: Buffer.from(JSON.stringify(responseBody ?? { error: error.message }), 'utf8'),
        }
      }
      return {
        status,
        contentType: 'application/json; charset=utf-8',
        body: Buffer.from(JSON.stringify(responseBody ?? {}), 'utf8'),
      }
    },
    async fetchHealth(_timeoutMs = 1500) {
      try {
        return engine.health()
      } catch {
        return null
      }
    },
  }

  return { supervisor, backend, engine }
}
