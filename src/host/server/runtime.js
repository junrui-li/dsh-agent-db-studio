/**
 * V3 进程内引擎的组装层：app.main() 的移植（不含 HTTP 服务器——调用直接进 router）。
 *
 * 职责：
 * - DBS_DATA_DIR 等环境变量的注入（与 supervisor 注入同源：settings → env）；
 * - runMigrations()（app.main 的权威迁移入口）；
 * - 组装 createRouter（模块按 engine 装配进度渐进挂载，未挂载的路径回 503/404）；
 * - healthPayload()（/health 免鉴权探针的等价物）。
 *
 * 生命周期：宿主插件 fiber 直接持有（无子进程可 kill）；dispose = closeAll()。
 */

import { mkdirSync } from 'node:fs'
import { createRouter } from './router.js'
import { runMigrations } from './store/migrate.js'
import { pool } from './core/pool.js'
import * as redisPool from './core/redis-pool.js'
import * as db from './store/db.js'
import * as connectionsApi from './api/connections.js'
import * as metaApi from './api/meta.js'
import * as queryApi from './api/query.js'
import * as executeApi from './api/execute.js'
import * as writeRowsApi from './api/write-rows.js'
import * as redisApi from './api/redis.js'
import * as historyApi from './api/history.js'
import * as ticketsApi from './api/tickets.js'
import * as undoApi from './api/undo.js'
import * as maskingApi from './api/masking.js'
import * as writesWindowApi from './api/writes-window.js'
import * as semanticApi from './api/semantic.js'
import * as semanticDistillApi from './api/semantic-distill.js'

/** V3 全量挂载（semantic 两件 = M3 后段 e0ef0c5）。 */
function buildRouter() {
  return createRouter({
    connections: connectionsApi,
    meta: metaApi,
    queryApi,
    executeApi,
    writeRows: writeRowsApi,
    redisApi,
    historyApi,
    tickets: ticketsApi,
    undo: undoApi,
    masking: maskingApi,
    writesWindow: writesWindowApi,
    semantic: semanticApi,
    semanticDistill: semanticDistillApi,
  })
}

/** 组装引擎实例。settings：Host 的 normalized 配置（dataDir/timeout/maxRows 等）。 */
export function createEngine(settings) {
  // settings → env（Python supervisor 注入 DBS_* 的等价物；JS 引擎用同一条配置源）
  if (settings?.dataDir) process.env.DBS_DATA_DIR = settings.dataDir
  if (settings?.maxRows) process.env.DBS_MAX_ROWS = String(settings.maxRows)
  if (settings?.timeout) process.env.DBS_TIMEOUT = String(settings.timeout)
  if (settings?.undoMaxRows !== undefined) process.env.DBS_UNDO_MAX_ROWS = String(settings.undoMaxRows)
  if (settings?.undoKeep !== undefined) process.env.DBS_UNDO_KEEP = String(settings.undoKeep)
  if (settings?.semanticLayerPath) process.env.DBS_SEMANTIC_DIR = settings.semanticLayerPath
  if (settings?.semanticMaxChars) process.env.DBS_SEMANTIC_MAX_CHARS = String(settings.semanticMaxChars)
  if (settings?.semanticRefreshHours !== undefined) {
    process.env.DBS_SEMANTIC_REFRESH_HOURS = String(settings.semanticRefreshHours)
  }

  mkdirSync(process.env.DBS_DATA_DIR, { recursive: true })
  const migrations = runMigrations() // app.main 的权威迁移入口（ready 计数打 stderr 由调用方处理）
  const router = buildRouter()

  return {
    router,
    migrations,
    /** /health 等价物：连接数量与语义层概况（计数，不含路径/内容）。 */
    health() {
      let semantic = { configured: false, indexReady: false, domains: 0, assets: 0 }
      try {
        const domains = db.queryAll('SELECT COUNT(*) AS n FROM semantic_domain')[0]?.n ?? 0
        const assets = db.queryAll('SELECT COUNT(*) AS n FROM semantic_doc')[0]?.n ?? 0
        semantic = { configured: true, indexReady: true, domains, assets }
      } catch { /* 表还没建（极早调用）时按未配置 */ }
      return {
        ok: true,
        version: '3-node',
        connections: db.countConnections(),
        semantic,
      }
    },
    /** 预留：connections 模块挂载前的连接数读取。 */
    _connectionsApi: connectionsApi,
    dispose() {
      // 顺序：先断 MySQL/Redis 外部连接（mysql2 空闲连接会挂住事件循环），
      // 再关 SQLite（本地句柄，关不关都不阻塞退出）。
      pool.closeAll()
      redisPool.closeAll()
      db.closeAll()
    },
  }
}
