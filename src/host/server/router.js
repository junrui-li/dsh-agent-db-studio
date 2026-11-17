/**
 * 进程内路由表：app.py 的 ROUTES + dispatch 语义的移植（V3 去 sidecar 的接缝）。
 *
 * - 路由签名与 Python 一致：(query, body, headers) → dict（同步或 async）。
 * - dispatch 捕获 ApiError 转 {error, code} 状态码；其它异常按 app.py 的兜底语义转 500。
 * - 路由模块按需 import：队友正在移植的模块用懒 require（首次 dispatch 时装载），
 *   未就绪的模块返回 503（而不是让整个 runtime 起不来）——移植期的过渡语义。
 * - 404 形状：app.py 对未知路径回 404 {"error": "..."}，这里保持一致。
 * - /health 免鉴权由 runtime 层处理（不走本表）。
 */

import { ApiError } from './core/errors.js'

/** 懒装载的路由模块注册表：path → () => Promise<handler 集合>。
 * M2/M3 移植完成后逐个填入；未注册的路径按 503 处理（契约错误体 + 中文说明）。 */
const _PENDING = new Map()

/** 注册「尚未移植完成」的懒路由（移植期过渡；M4 清零）。 */
export function pendingRoute(method, path, note) {
  _PENDING.set(`${method} ${path}`, note)
}

function _lazyError(method, path) {
  const note = _PENDING.get(`${method} ${path}`) || '模块移植中'
  return new ApiError(503, `该接口尚未在 V3 内置引擎中启用：${note}`, 'ENGINE_PENDING')
}

/**
 * 组装路由表。routes 参数把「模块 → handler」映射进来（集成时由 runtime 装配，
 * 测试可传部分模块做窄表分发）。每个模块传 null 表示「未就绪」→ dispatch 回 503。
 */
export function createRouter({
  connections = null,
  meta = null,
  queryApi = null,
  executeApi = null,
  writeRows = null,
  redisApi = null,
  historyApi = null,
  tickets = null,
  undo = null,
  masking = null,
  writesWindow = null,
  semantic = null,
  semanticDistill = null,
} = {}) {
  /** (method, path) → {handler, module}；与 app.py ROUTES 一致。 */
  const table = new Map()

  const bind = (module, mapping) => {
    if (!module) return
    for (const [method, path, handlerName, fn] of mapping) {
      table.set(`${method} ${path}`, { handler: fn ?? module[handlerName], module })
    }
  }

  bind(connections, [
    ['GET', '/api/connections', 'handleList'],
    ['POST', '/api/connections/save', 'handleSave'],
    ['POST', '/api/connections/delete', 'handleDelete'],
    ['POST', '/api/connections/test', 'handleTest'],
  ])
  bind(meta, [
    ['GET', '/api/meta/databases', 'handleDatabases'],
    ['GET', '/api/meta/tables', 'handleTables'],
    ['GET', '/api/meta/table', 'handleTable'],
  ])
  bind(queryApi, [['POST', '/api/query', 'handleQuery']])
  bind(executeApi, [['POST', '/api/execute', 'handleExecute']])
  bind(writeRows, [['POST', '/api/write-rows', 'handleWriteRows']])
  bind(redisApi, [
    ['POST', '/api/redis/scan', 'handleScan'],
    ['POST', '/api/redis/key', 'handleKey'],
    ['POST', '/api/redis/command', 'handleCommand'],
  ])
  bind(historyApi, [['GET', '/api/history', 'handleList']])
  bind(tickets, [
    ['POST', '/api/tickets/estimate', 'handleEstimate'],
    ['POST', '/api/tickets', 'handleCreate'],
    ['GET', '/api/tickets', 'handleList'],
    ['GET', '/api/tickets/detail', 'handleDetail'],
    ['POST', '/api/tickets/approve', 'handleApprove'],
    ['POST', '/api/tickets/cancel', 'handleCancel'],
  ])
  bind(undo, [
    ['GET', '/api/undo/preview', 'handlePreview'],
    ['POST', '/api/undo', 'handleUndo'],
    ['GET', '/api/undo/list', 'handleList'],
  ])
  bind(masking, [
    ['POST', '/api/masking/analyze', 'handleAnalyze'],
    ['POST', '/api/masking/policies', 'handlePolicies'],
    ['GET', '/api/masking/columns', 'handleColumns'],
  ])
  bind(writesWindow, [
    ['GET', '/api/writes/window', 'handleGet'],
    ['POST', '/api/writes/window', 'handleSet'],
  ])
  bind(semantic, [
    ['GET', '/api/semantic/domains', 'handleDomains'],
    ['GET', '/api/semantic/search', 'handleSearch'],
    ['GET', '/api/semantic/asset', 'handleAsset'],
    ['GET', '/api/semantic/table', 'handleTable'],
    ['POST', '/api/semantic/refresh', 'handleRefresh'],
    ['POST', '/api/semantic/config', 'handleConfig'],
    ['GET', '/api/semantic/file', 'handleFile'],
    ['POST', '/api/semantic/file/save', 'handleFileSave'],
    ['POST', '/api/semantic/domain/create', 'handleDomainCreate'],
    ['POST', '/api/semantic/domain/update', 'handleDomainUpdate'],
    ['POST', '/api/semantic/domain/delete', 'handleDomainDelete'],
    ['POST', '/api/semantic/domain/tables', 'handleDomainTables'],
    ['GET', '/api/semantic/tables', 'handleTables'],
    ['POST', '/api/semantic/export', 'handleExport'],
    ['POST', '/api/semantic/import', 'handleImport'],
    ['POST', '/api/semantic/backfill', 'handleBackfill'],
  ])
  bind(semanticDistill, [
    ['POST', '/api/semantic/distill/candidates', 'handleCandidates'],
    ['POST', '/api/semantic/distill/run', 'handleRun'],
    ['POST', '/api/semantic/distill/apply', 'handleApply'],
    ['GET', '/api/semantic/distill/runs', 'handleRuns'],
  ])

  /** 二进制下载路由（契约 §3.6）：单独标记，runtime 层直读文件流。 */
  table.set('GET * /api/tickets/export/download', { handler: null, module: 'export-download' })

  /** 分发一次调用。返回 {status, body}（契约错误体）；handler 异常已翻译。
   * headers 用小写键（browser.js 代理层传入前已归一）。 */
  async function dispatch(method, path, { query = {}, body = null, headers = {} } = {}) {
    const key = `${method} ${path}`
    const entry = table.get(key)
    if (!entry || typeof entry.handler !== 'function') {
      if (entry && entry.module === 'export-download') {
        return { status: 503, body: { error: '导出下载在 V3 引擎中的接线位于工单模块（M3）', code: 'ENGINE_PENDING' } }
      }
      if (_PENDING.has(key)) return { status: 503, body: _lazyError(method, path).body() }
      return { status: 404, body: { error: `未知接口: ${method} ${path}` } }
    }
    try {
      const result = await entry.handler(query, body, headers)
      return { status: 200, body: result ?? {} }
    } catch (error) {
      if (error instanceof ApiError) {
        return { status: error.status, body: error.body() }
      }
      // app.py 的兜底：未归类异常回 500（不含异常 repr，防敏感信息外漏）
      const message = error instanceof Error ? error.message : String(error)
      return { status: 500, body: { error: `后端内部错误: ${message.slice(0, 300)}` } }
    }
  }

  return { dispatch, table }
}
