/**
 * V3 运行配置（src/host/server/core/config.js）：core/config.py 的逐行移植。
 *
 * 与 Python 版相同的两条纪律：
 * - 不写配置文件；函数实时读环境变量，方便测试用 env 覆盖。
 * - 唯一的兜底默认值只在变量缺失时使用（Host 正常都会注入 DBS_*）。
 *
 * 与 Python 版的差异：
 * - Python 的 _SERVER_DIR 兜底指向 server/；这里兜底指向仓库根的 server/data
 *   （同等位置），由 import.meta.url 推导，不依赖进程 CWD。
 * - 线程相关常量（Python 的 threading）不存在；Node 单线程事件循环内
 *   node:sqlite 调用全部同步，串行语义天然成立。
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as storeDb from '../store/db.js'

// 固定常量（不开放环境变量）——与 core/config.py 保持一致
export const CONNECT_TIMEOUT = 10   // 建连超时（秒），与查询超时解耦
export const POOL_MAX = 4           // 每个连接 id 的池容量（个人工具足够）
export const HISTORY_MAX = 500      // 查询历史保留条数
export const HISTORY_SQL_MAX = 10240 // 单条历史 SQL 截断长度（字符）
export const MAX_ROWS_CAP = 10000   // 单次返回行数硬上限（防误配把内存打爆）

const _HERE = dirname(fileURLToPath(import.meta.url))
const _DEFAULT_DATA_DIR = join(_HERE, '..', '..', '..', '..', 'server', 'data')

function _envStr(name) {
  return (process.env[name] || '').trim()
}

function _envInt(name, fallback) {
  const raw = _envStr(name)
  if (!raw) return fallback
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function dataDir() {
  return _envStr('DBS_DATA_DIR') || _DEFAULT_DATA_DIR
}

/** 业务数据 SQLite 库（连接 / 历史 / 工单 / 语义层）。 */
export function dbPath() {
  return join(dataDir(), 'dbs.db')
}

/** dbs.db meta 读取（store 侧连接未初始化或表缺失时自会返回 default）。 */
function _metaGet(key) {
  try {
    return storeDb.metaGet(key)
  } catch {
    return '' // dbs.db 尚不可用（如极早调用）时退回 env
  }
}

/** 业务语义层（NL2SQL 资产）目录；空 = 未启用语义层。
 *
 * 优先级：面板「保存」的覆盖值（dbs.db meta.semantic_dir，POST /api/semantic/config）
 * > env DBS_SEMANTIC_DIR（插件配置注入）。meta 存空串 = 未覆盖，回退 env。
 */
export function semanticDir() {
  const override = _metaGet('semantic_dir').trim()
  if (override) return override
  return _envStr('DBS_SEMANTIC_DIR')
}

export function semanticMaxChars() {
  return _envInt('DBS_SEMANTIC_MAX_CHARS', 8000)
}

/** 语义层「DB 重建 → 写出到本地文件」的目标路径。
 *
 * 优先级：面板保存的覆盖值（dbs.db meta.semantic_export_dir）
 * > env DBS_SEMANTIC_EXPORT_DIR > env DBS_SEMANTIC_DIR（兼容旧配置）。
 */
export function semanticExportDir() {
  const override = _metaGet('semantic_export_dir').trim()
  if (override) return override
  return _envStr('DBS_SEMANTIC_EXPORT_DIR') || _envStr('DBS_SEMANTIC_DIR')
}

/** 语义层索引 SQLite 库（独立于 dbs.db，可随时删除重建）。 */
export function semanticIndexPath() {
  return join(dataDir(), 'semantic-index.db')
}

/** agent SELECT 的 EXPLAIN 门禁：估算行数超过它就拒绝（<=0 关闭门禁）。 */
export function slowSqlMaxScanRows() {
  return _envInt('DBS_SLOW_SQL_MAX_SCAN_ROWS', 100_000)
}

/** type=ALL（全表扫描）分档阈值：表近似行数 >= 阈值才拦（<=0 关闭分档）。 */
export function slowSqlFullScanTableRows() {
  return _envInt('DBS_SLOW_SQL_FULL_SCAN_TABLE_ROWS', 500_000)
}

/** 工单影响面预估：EXPLAIN 估算 <= 它才追加 SELECT COUNT(*) 精确计数（<=0 关闭）。 */
export function impactCountMaxRows() {
  return _envInt('DBS_IMPACT_COUNT_MAX_ROWS', 100_000)
}

/** 变更前快照的单语句最大行数（<=0 整体关闭快照/撤销）。 */
export function undoMaxRows() {
  return _envInt('DBS_UNDO_MAX_ROWS', 1000)
}

/** undo_log / 快照文件保留条数（超过淘汰最旧）。 */
export function undoKeep() {
  return _envInt('DBS_UNDO_KEEP', 50)
}

/** 一次结构化行写的语句总数上限（每行一条语句）。 */
export function writeRowsMax() {
  return _envInt('DBS_WRITE_ROWS_MAX', 200)
}

/** 快照 JSON 落盘目录：<dataDir>/undo/（含明文行数据，受 gitignore 保护）。 */
export function undoDir() {
  return join(dataDir(), 'undo')
}

/** 导出工单单次最大行数（<=0 视为不限，不建议）。 */
export function exportMaxRows() {
  return _envInt('DBS_EXPORT_MAX_ROWS', 10000)
}

/** 导出取数批次行数（默认 500）。 */
export function exportBatchSize() {
  return _envInt('DBS_EXPORT_BATCH_SIZE', 500)
}

/** 导出文件保留份数（超过按 mtime 淘汰最旧）。 */
export function exportKeep() {
  return _envInt('DBS_EXPORT_KEEP', 20)
}

/** 导出文件落盘目录：<dataDir>/exports/。 */
export function exportDir() {
  return join(dataDir(), 'exports')
}

/** 语义层索引定时全量刷新间隔（小时）；0 = 关闭。 */
export function semanticRefreshHours() {
  return _envInt('DBS_SEMANTIC_REFRESH_HOURS', 0)
}

export function defaultMaxRows() {
  return Math.max(1, _envInt('DBS_MAX_ROWS', 500))
}

export function defaultTimeout() {
  return Math.max(1, _envInt('DBS_TIMEOUT', 60))
}
