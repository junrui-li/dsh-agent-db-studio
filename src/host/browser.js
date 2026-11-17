/**
 * 浏览器通道：`/db-studio/**` 一条带鉴权的代理路由。
 *
 * 浏览器半片只跟这里说话：
 *   - 每个请求第一步走 `connection.requestRejection`（Host/Origin + 登录凭证），
 *     拿不到鉴权能力一律 403（fail closed）；
 *   - `/db-studio/api/**` 原样转发到后端 `/api/**`，由 Host 注入 `X-DBS-Token` 与
 *     `X-DBS-Actor: user`——浏览器永远拿不到令牌和连接密码；
 *   - 另有插件自己的探针 `/db-studio/api/health`（契约 §4.1）；
 *   - `/db-studio/api/masking/suggest`（契约 §3.7 Host 侧，脱敏字段 AI 分析建议）由
 *     ai.js 提供：只产候选、不脱敏，模型不可用时回退后端启发式基线；
 *   - `/db-studio/api/semantic/distill` 与 `/semantic/distill/apply`（第 51 轮）由
 *     distill.js 提供：模型只做「挑+整理」，SQL 必须来自后端给的候选（服务端硬校验）。
 */
import { createAiBridge } from './ai.js'
import { createDistillBridge } from './distill.js'

const ROUTE = '/db-studio'
const MAX_BODY = 4_000_000
/** 脱敏 AI 分析的请求体只有连接 id + 关键字，限制小一些，非法/超大请求体在开流前就拒绝。 */
const MAX_AI_BODY = 1_000_000
/** 蒸馏请求体只有域/连接/时间窗/limit；apply 的 picks 也远小于 1MB。 */
const MAX_DISTILL_BODY = 1_000_000

function json(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(JSON.stringify(body))
}

function writeRaw(res, status, contentType, buffer, headOnly) {
  res.statusCode = status
  res.setHeader('content-type', contentType || 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  if (headOnly) {
    res.end()
    return
  }
  res.setHeader('content-length', buffer.length)
  res.end(buffer)
}

function httpError(message, status) {
  return Object.assign(new Error(message), { status })
}

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw httpError(`请求体太大（超过 ${Math.round(limit / 1_000_000)}MB）`, 413)
    chunks.push(chunk)
  }
  return chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0)
}

/** fail closed：没有鉴权能力或鉴权抛错都按拒绝处理。 */
function requestRejection(ctx, req) {
  const connection = ctx.get('connection')
  if (typeof connection?.requestRejection !== 'function') return 403
  try {
    return connection.requestRejection({ headers: req.headers })
  } catch {
    return 403
  }
}

/**
 * @param {object} ctx - Cordis 上下文。
 * @param {{settings:object, supervisor:object, backend:object, name:string}} runtime
 */
export function registerBrowserRoute(ctx, { settings, supervisor, backend, name }) {
  // 脱敏字段 AI 分析：llm / agentDefaultModel 是可选服务，缺了也不会让插件激活失败——
  // bridge 自己降级成基线回退，接口始终 200。
  // dataDir 用于诊断日志 host.log：模型/解析失败的真实原因落盘，响应里只带人话 error。
  const ai = createAiBridge(ctx, { backend, dataDir: settings.dataDir })
  // 语义层 AI 蒸馏（第 51 轮）：同一条诊断日志、同一套模型解析与降级。
  const distill = createDistillBridge(ctx, { backend, dataDir: settings.dataDir })
  // 插件卸载/热重载时把进行中的模型调用 abort 掉，别让旧 fiber 的调用挂在新路由上。
  ctx.effect(() => () => ai.dispose(), 'dsh-agent-db-studio: abort in-flight AI calls')
  ctx.effect(() => () => distill.dispose(), 'dsh-agent-db-studio: abort in-flight distill calls')

  async function pluginHealth(res, method) {
    const status = supervisor.status()
    let connectionsCount = 0
    if (status.ready) {
      const health = await backend.fetchHealth()
      connectionsCount = Number(health?.connections) || 0
    }
    if (method === 'HEAD') {
      writeRaw(res, 200, 'application/json; charset=utf-8', Buffer.alloc(0), true)
      return
    }
    json(res, 200, {
      ok: true,
      plugin: name,
      backend: { ready: status.ready, error: status.error ?? null },
      connectionsCount,
      settings: { allowWrites: settings.allowWrites, maxRows: settings.maxRows, timeout: settings.timeout },
    })
  }

  async function forward(req, res, suffix, search, method) {
    // 面板打开/刷新时懒启动后端；启动失败把原因直接给界面。
    try {
      await backend.ensureReady()
    } catch (error) {
      json(res, 503, { error: error instanceof Error ? error.message : String(error) })
      return
    }
    const controller = new AbortController()
    // 浏览器提前断开才取消后端请求；响应正常写完不算断开。
    const onResponseClose = () => {
      if (!res.writableEnded) controller.abort()
    }
    res.once('close', onResponseClose)
    try {
      const body = method === 'POST' ? await readBody(req, MAX_BODY) : undefined
      const headers = {}
      if (typeof req.headers.accept === 'string' && req.headers.accept) headers.accept = req.headers.accept
      if (method === 'POST' && typeof req.headers['content-type'] === 'string') {
        headers['content-type'] = req.headers['content-type']
      }
      const result = await backend.proxy(suffix + search, {
        method,
        body,
        headers,
        signal: controller.signal,
        actor: 'user',
      })
      writeRaw(res, result.status, result.contentType, result.body, method === 'HEAD')
    } finally {
      res.removeListener('close', onResponseClose)
    }
  }

  async function route(req, res) {
    const method = String(req.method || 'GET').toUpperCase()
    if (!['GET', 'HEAD', 'POST'].includes(method)) {
      res.setHeader('allow', 'GET, HEAD, POST')
      json(res, 405, { error: '不支持的方法' })
      return
    }
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const suffix = url.pathname.slice(ROUTE.length) || '/'
    if (suffix === '/api/health' && (method === 'GET' || method === 'HEAD')) {
      await pluginHealth(res, method)
      return
    }
    // 脱敏字段 AI 分析建议（契约 §3.7 Host 侧）：只产候选，实际脱敏在后端。
    // 它在泛代理之前拦下，但仍走同一条最外层鉴权；模型/后端出问题一律 200 + 基线回退。
    if (suffix === '/api/masking/suggest') {
      if (method !== 'POST') {
        res.setHeader('allow', 'POST')
        json(res, 405, { error: '不支持的方法' })
        return
      }
      const rawBody = await readBody(req, MAX_AI_BODY)
      await ai.suggestMasking(req, res, rawBody)
      return
    }
    // 语义层 AI 蒸馏（第 51 轮）：候选由后端出，模型只挑+整理，SQL 经服务端校验后才落 run。
    // 同样在泛代理之前拦下、仍走最外层鉴权；蒸馏失败一律 200 + 空候选 + 人话 error。
    if (suffix === '/api/semantic/distill') {
      if (method !== 'POST') {
        res.setHeader('allow', 'POST')
        json(res, 405, { error: '不支持的方法' })
        return
      }
      const rawBody = await readBody(req, MAX_DISTILL_BODY)
      await distill.distillSemantic(req, res, rawBody)
      return
    }
    // 应用蒸馏候选（写 query-samples.md）：只接受**人工勾选**的 picks，定时器永远不会走到这里。
    if (suffix === '/api/semantic/distill/apply') {
      if (method !== 'POST') {
        res.setHeader('allow', 'POST')
        json(res, 405, { error: '不支持的方法' })
        return
      }
      const rawBody = await readBody(req, MAX_DISTILL_BODY)
      await distill.applyDistill(res, rawBody)
      return
    }
    if (!suffix.startsWith('/api/')) {
      json(res, 404, { error: '接口不存在' })
      return
    }
    // 其余 /api/semantic/**（含 GET /api/semantic/distill/runs 这类只读接口）
    // 一律走泛代理直达后端，不需要在这里逐条接线。
    await forward(req, res, suffix, url.search, method)
  }

  return ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE,
    handler: async (req, res) => {
      // 鉴权必须是第一步：还没解析 URL、还没碰后端。
      const rejection = requestRejection(ctx, req)
      if (rejection) {
        json(res, rejection, { error: rejection === 401 ? '未登录' : '来源被拒绝' })
        return
      }
      try {
        await route(req, res)
      } catch (error) {
        if (res.headersSent) {
          res.end()
          return
        }
        const status = Number.isInteger(error?.status) ? error.status : 502
        json(res, status, { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }), 'dsh-agent-db-studio: /db-studio routes')
}
