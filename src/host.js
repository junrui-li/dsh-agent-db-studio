/**
 * dsh-db-studio —— Host 半片（V3：后端收编进本进程，无 Python sidecar）。
 *
 * 三件事：
 *   1. server/（src/host/server/）在本进程内实现全部后端路由（48 条；runtime.js 组装）；
 *   2. tools.js + semantic.js 把数据库能力注册成 17 个 agent 工具（+3 个写工具共 20 个）；
 *   3. browser.js 给浏览器半片一条带鉴权的 `/db-studio/api/**` 代理（浏览器拿不到连接密码）。
 *
 * 配置归一在 config.js，进程内通道适配在 server/local-stack.js，格式化小工具在 render.js。
 * 模块职责与数据流见 src/host/README.md（改动后先 node --check 再保存，插件会热重载）。
 */
import { ensureClientBundle } from './host/clientBuild.js'
import { registerBrowserRoute } from './host/browser.js'
import { REPO_ROOT, normalized } from './host/config.js'
import { runDistillation } from './host/distill.js'
import { createLocalStack } from './host/server/local-stack.js'
import { NL2SQL_PROMPT_SECTION, NL2SQL_PROMPT_TEXT } from './host/nl2sql-prompt.js'
import { registerSemanticTools } from './host/semantic.js'
import { registerTools } from './host/tools.js'

export const name = 'dsh-db-studio'

/** 硬依赖：缺任何一个都不激活，避免半残状态（审批缺失时写工具会 fail closed）。 */
export const inject = ['webServer', 'tools', 'connection', 'approval']

export function apply(ctx, config) {
  createRuntime(ctx, config)
}

/**
 * 组装一个插件实例。overrides 只给测试用（临时 stub 后端仓库），
 * 正常安装时永远走 apply() 的缺省值。
 */
export async function createRuntime(ctx, config = {}, overrides = {}) {
  const repoRoot = overrides.repoRoot ?? REPO_ROOT
  // Client 半片的运行时单文件由 parts 生成（dist/ 不入库）：激活时按需重建，避免面板跑旧代码。
  ensureClientBundle(repoRoot, {
    info: message => { if (typeof console !== 'undefined') console.log(message) },
    warn: message => { if (typeof console !== 'undefined') console.warn(message) },
  })
  const settings = normalized(config, repoRoot)

  // V3 内置引擎：组装即就绪（迁移失败会让 createEngine 抛错 → 插件激活失败，原因可见）。
  // supervisor/backend 与 python sidecar 时代的接口形状相同，tools/browser/ai/distill 零改动。
  const { supervisor, backend } = createLocalStack(settings)

  // 引擎生命周期绑在插件 fiber 上：卸载/热重载时按「外部连接池 → Redis 池 → SQLite」
  // 顺序关闭，不留孤儿句柄（V3 组装即就绪，无子进程概念）。
  ctx.effect(() => () => supervisor.dispose(), 'dsh-db-studio: backend engine')

  registerBrowserRoute(ctx, { settings, supervisor, backend, name })
  registerTools(ctx, { settings, supervisor, backend })

  // 业务语义层（NL2SQL）：4 个只读工具 + 系统提示段**恒定注册**（第 51 轮裁决 Q3）。
  // 语义层的「有没有域」是后端 configured 的状态（域由人在面板新建/导入），不是工具门禁；
  // 「还没有业务域」时工具会给出「去面板 + 新建 / 导入文档目录」的中文指引。
  // systemPrompt 是可选服务（旧运行时没有）：ctx.get 判空，不写硬 inject。
  registerSemanticTools(ctx, { settings, backend })
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt) {
    ctx.effect(() => {
      systemPrompt.section({ ...NL2SQL_PROMPT_SECTION, text: NL2SQL_PROMPT_TEXT })
    }, 'dsh-db-studio: nl2sql prompt section')
  }

  // 语义层 AI 蒸馏定时巡检（默认关闭）：只产 status='ready' 的 run 记录供人在面板勾选，
  // **绝不自动写文件**，也不影响主流程——失败只打日志。
  if (settings.semanticDistillHours > 0) {
    ctx.effect(() => startDistillTimer({ ctx, backend, settings }), 'dsh-db-studio: semantic distill timer')
  }

  return { settings, supervisor, backend }
}

/** 定时器每次触发前的最小间隔保护（防止配置被改成极小值后把后端打满）。 */
const DISTILL_MIN_INTERVAL_MS = 60_000

/** 控制台诊断日志（定时器没有 host.log 的 dataDir 依赖，直接用 console）。 */
function distillLog(level, event, detail) {
  if (typeof console === 'undefined') return
  const suffix = detail === undefined ? '' : ` ${JSON.stringify(detail)}`
  const line = `[dsh-db-studio] semantic distill ${level} ${event}${suffix}`
  if (level === 'error' || level === 'warn') console.warn(line)
  else console.log(line)
}

/**
 * 定时巡检的**一次**执行（导出给测试直接调用；定时器内部也是调它）。
 *
 * 与手动蒸馏的唯一差别是 trigger='scheduled'：**都不写文件**，
 * 「应用候选到 query-samples.md」只能由人在面板里点（走 /api/semantic/distill/apply）。
 * 任何失败都只返回结果/打日志，绝不抛给调用方。
 * @returns {Promise<{runId:string, candidates:Array<object>, error:string|null}>}
 */
export async function runScheduledDistill({ ctx, backend, signal, hostLog = distillLog }) {
  try {
    const result = await runDistillation({
      backend,
      ctx,
      request: {},
      signal,
      trigger: 'scheduled',
      hostLog,
    })
    if (result.error && !result.runId) hostLog('warn', 'tick.empty', { error: result.error })
    else hostLog('info', 'tick.ok', { runId: result.runId, candidates: result.candidates.length })
    return result
  } catch (error) {
    // 定时器的任何失败都只打日志，绝不影响主流程。
    hostLog('error', 'tick.fail', { error: error instanceof Error ? error.message : String(error) })
    return { runId: '', candidates: [], model: null, error: '定时蒸馏失败', scanned: 0, deduped: 0, window: null }
  }
}

/**
 * 起一个 unref 的蒸馏定时器。返回 disposer（卸载/热重载时 clearInterval + abort 进行中的一次）。
 * @param {object} options
 * @param {number} [options.intervalMs] - 仅测试用：直接指定间隔，跳过配置换算与最小间隔保护。
 */
export function startDistillTimer({ ctx, backend, settings, intervalMs: overrideMs, hostLog = distillLog }) {
  const intervalMs = Number.isFinite(overrideMs) && overrideMs > 0
    ? overrideMs
    : Math.max(settings.semanticDistillHours * 3_600_000, DISTILL_MIN_INTERVAL_MS)
  let disposed = false
  let running = false
  let controller = null

  const tick = async () => {
    if (disposed || running) return
    running = true
    controller = new AbortController()
    try {
      await runScheduledDistill({ ctx, backend, signal: controller.signal, hostLog })
    } finally {
      running = false
      controller = null
    }
  }

  const timer = setInterval(tick, intervalMs)
  // unref：定时器不把宿主进程钉住（插件卸载后也不会阻止退出）。
  timer.unref?.()

  return () => {
    disposed = true
    clearInterval(timer)
    try { controller?.abort() } catch { /* 已结束 */ }
  }
}
