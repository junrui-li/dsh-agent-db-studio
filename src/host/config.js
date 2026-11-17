/**
 * 配置归一（V3：引擎收编进 Host 后不再有 pythonPath / engine 配置；旧配置残留被静默忽略）。
 *
 * 为什么不声明 `export const Config`：本插件只需要几个标量配置，自己归一可以
 * 少依赖一层 schema 投影；缺省值、类型转换、非法值的中文报错都收在这里，
 * tools / 浏览器通道拿到的永远是「已经能直接用」的 settings。
 */
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** src/host/config.js → 仓库根。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

export const DEFAULTS = {
  dataDir: '',
  allowWrites: false,
  /** 写操作策略：'ticket'（默认，对标 DMS 工单，人审批后才执行）| 'direct'（审批弹窗后立即执行）。 */
  writeMode: 'ticket',
  maxRows: 500,
  timeout: 60,
  /** 变更前快照单语句最大行数（V2.2）：<=0 关闭快照/撤销；超限的写标记「不可撤销」照常执行。 */
  undoMaxRows: 1000,
  /** undo_log / 快照文件保留条数（超过淘汰最旧）。 */
  undoKeep: 50,
  /** 业务语义层（NL2SQL 资产）文档导入源目录；留空 = 面板里没有可导入的文档源（语义工具照常注册）。 */
  semanticLayerPath: '',
  /** 语义资产单次返回的最大字符数（asset 接口 500-20000）。 */
  semanticMaxChars: 8000,
  /** 语义层索引定时全量刷新间隔（小时）；0 = 关闭（默认，刷新走面板手动按钮）。 */
  semanticRefreshHours: 0,
  /**
   * 语义层「AI 蒸馏」定时巡检间隔（小时）；0 = 关闭（默认）。
   * 只产 status='ready' 的 run 记录供人在面板勾选应用，**绝不自动写文件**。
   */
  semanticDistillHours: 0,
}

function invalid(label, value, expectation) {
  return new Error(`配置 ${label} 不合法：${JSON.stringify(value)}（${expectation}）`)
}

function toBoolean(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  const text = String(value).trim().toLowerCase()
  if (['true', '1', 'yes', 'on'].includes(text)) return true
  if (['false', '0', 'no', 'off'].includes(text)) return false
  throw invalid(label, value, '应为 true/false')
}

function toInteger(value, fallback, { min, max, label }) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isFinite(number)) throw invalid(label, value, '应为数字')
  const integer = Math.trunc(number)
  if (integer < min || integer > max) throw invalid(label, value, `应在 ${min}-${max} 之间`)
  return integer
}

function resolveDataDir(value, repoRoot) {
  const text = String(value ?? '').trim()
  if (!text) return join(repoRoot, 'server', 'data')
  return isAbsolute(text) ? resolve(text) : resolve(repoRoot, text)
}

/** 语义层文档导入源目录：空 = 面板里没有可导入的文档源；相对路径按 repoRoot 解析成绝对路径（env 传给后端必须是绝对的）。 */
function resolveSemanticPath(value, repoRoot) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return isAbsolute(text) ? resolve(text) : resolve(repoRoot, text)
}

/** writeMode 只认 ticket / direct；拼错就报中文错，别静默退回某个策略。 */
function toWriteMode(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  const text = String(value).trim().toLowerCase()
  if (text === 'ticket' || text === 'direct') return text
  throw invalid('writeMode', value, "应为 'ticket'（默认，人工审批工单）或 'direct'（审批后立即执行）")
}

/**
 * config 逐字段覆盖缺省值（空串/null 视为「没配」）。
 * 兼容：旧配置里的 engine/pythonPath 残留被静默忽略（V3 收编后引擎只有进程内一条路）。
 * @returns {typeof DEFAULTS & {dataDir:string}}
 */
export function normalized(config, repoRoot = REPO_ROOT) {
  const raw = config && typeof config === 'object' ? config : {}
  const merged = { ...DEFAULTS }
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key]
    if (value !== undefined && value !== null && value !== '') merged[key] = value
  }
  return {
    maxRows: toInteger(merged.maxRows, DEFAULTS.maxRows, { min: 1, max: 100_000, label: 'maxRows' }),
    timeout: toInteger(merged.timeout, DEFAULTS.timeout, { min: 1, max: 3600, label: 'timeout' }),
    undoMaxRows: toInteger(merged.undoMaxRows, DEFAULTS.undoMaxRows, {
      min: 0, max: 10_000_000, label: 'undoMaxRows',
    }),
    undoKeep: toInteger(merged.undoKeep, DEFAULTS.undoKeep, {
      min: 1, max: 500, label: 'undoKeep',
    }),
    allowWrites: toBoolean(merged.allowWrites, DEFAULTS.allowWrites, 'allowWrites'),
    writeMode: toWriteMode(merged.writeMode, DEFAULTS.writeMode),
    dataDir: resolveDataDir(merged.dataDir, repoRoot),
    semanticLayerPath: resolveSemanticPath(merged.semanticLayerPath, repoRoot),
    semanticMaxChars: toInteger(merged.semanticMaxChars, DEFAULTS.semanticMaxChars, {
      min: 500, max: 20_000, label: 'semanticMaxChars',
    }),
    semanticRefreshHours: toInteger(merged.semanticRefreshHours, DEFAULTS.semanticRefreshHours, {
      min: 0, max: 720, label: 'semanticRefreshHours',
    }),
    semanticDistillHours: toInteger(merged.semanticDistillHours, DEFAULTS.semanticDistillHours, {
      min: 0, max: 720, label: 'semanticDistillHours',
    }),
    /**
     * 语义层「文档导入源目录」是否配置：第 51 轮起**不再作为工具门禁**
     * （4 个语义工具与 NL2SQL 提示段恒定注册），只用来告诉面板有没有可导入的文档源。
     */
    semanticEnabled: Boolean(resolveSemanticPath(merged.semanticLayerPath, repoRoot)),
  }
}
