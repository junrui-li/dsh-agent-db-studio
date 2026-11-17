/**
 * AI 蒸馏 API（契约 §3.10）：候选提取 / run 生命周期 / 应用进 query-samples.md。
 * server/api/semantic_distill.py 的逐函数移植（V3 去 sidecar）。
 *
 * 模型调用在 Host 半片（需要 DSH 的 llm 服务）；后端只负责：
 * - 从 history 确定性提取候选（semantic/distill.js，SQL 已脱敏）；
 * - 存 run 记录（谁在什么窗口、用什么模型、产出了什么）；
 * - 把用户勾选的候选写成 `### Sxx` 小节追加进 query-samples.md。
 *
 * `apply` 是唯一的写路径，且**只追加、不覆盖人工样例**。
 */

import { randomUUID } from 'node:crypto'
import * as common from './common.js'
import { ApiError } from '../core/errors.js'
import { queryAll, queryOne, transaction } from '../store/db.js'
import * as distillEngine from '../semantic/distill.js'
import * as semanticIndex from '../semantic/index.js'
import * as semanticStore from '../semantic/store.js'

const _RUNS_KEEP = 50
const _STATUSES = ['running', 'ready', 'failed', 'applied', 'discarded']

function now() {
  return common.now()
}

function runRow(row) {
  let candidates = []
  if (row.candidates_json) {
    try {
      const parsed = JSON.parse(row.candidates_json)
      if (Array.isArray(parsed)) candidates = parsed
    } catch {
      candidates = []
    }
  }
  return {
    id: row.id, domain: row.domain || '',
    connectionId: row.connection_id || '',
    from: row.time_from || '', to: row.time_to || '',
    trigger: row.trigger_kind || 'manual',
    status: row.status || 'running',
    model: row.model || '',
    scanned: Number(row.scanned) || 0,
    deduped: Number(row.deduped) || 0,
    appliedCount: Number(row.applied_count) || 0,
    candidates,
    error: row.error || '',
    createdAt: row.created_at || '',
    appliedAt: row.applied_at || '',
  }
}

function insertRun(payload) {
  const runId = 'run_' + randomUUID().replace(/-/g, '').slice(0, 12)
  const values = [
    runId,
    String(payload.domain || ''),
    String(payload.connectionId || ''),
    String(payload.from || ''), String(payload.to || ''),
    payload.trigger === 'schedule' ? 'schedule' : 'manual',
    payload.status || 'running',
    String(payload.model || '').slice(0, 120),
    Number(payload.scanned) || 0, Number(payload.deduped) || 0,
    0,
    JSON.stringify(payload.candidates || []).slice(0, 500000),
    (String(payload.error || '').slice(0, 2000)) || null,
    now(), null,
  ]
  transaction((conn) => {
    conn.prepare(
      'INSERT INTO semantic_distill_run (id,domain,connection_id,time_from,'
      + 'time_to,trigger_kind,status,model,input_tokens,scanned,deduped,'
      + 'applied_count,candidates_json,error,created_at,applied_at) '
      + "VALUES (?,?,?,?,?,?,?,?,'',?,?,?,?,?,?,?)").run(...values)
    conn.prepare(
      'DELETE FROM semantic_distill_run WHERE seq <= '
      + '(SELECT MAX(seq) FROM semantic_distill_run) - ?').run(_RUNS_KEEP)
  })
  return getRun(runId) || {}
}

export function getRun(runId) {
  const row = queryOne('SELECT * FROM semantic_distill_run WHERE id=?', [runId])
  return row !== null ? runRow(row) : null
}

// ---------------------------------------------------------------- handlers

export function handleCandidates(_query, body = null, _headers = null) {
  /** POST /api/semantic/distill/candidates —— 确定性候选提取（不调模型）。 */
  const payload = common.bodyOf(body)
  const limit = payload.limit
  let limitInt = 40
  if (limit !== null && limit !== undefined && limit !== '') {
    const parsed = Number(limit)
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
      throw new ApiError(400, `limit 必须是整数: ${JSON.stringify(limit)}`)
    }
    limitInt = parsed
  }
  const domain = String(payload.domain || '').trim()
  if (domain && semanticStore.getDomain(domain) === null) {
    unknownDomain(domain)
  }
  const result = distillEngine.collect({
    timeFrom: String(payload.from || ''),
    timeTo: String(payload.to || ''),
    connectionId: String(payload.connectionId || '').trim(),
    domain,
    limit: limitInt,
  })
  result.candidates = distillEngine.budget(result.candidates)
  return result
}

function unknownDomain(domain) {
  throw new ApiError(404, `未知语义域: ${domain}`, 'SEMANTIC_DOMAIN_UNKNOWN')
}

export function handleRun(_query, body = null, _headers = null) {
  /** POST /api/semantic/distill/run —— 存一次蒸馏结果（模型由 Host 调用）。 */
  const payload = common.bodyOf(body)
  const domain = String(payload.domain || '').trim()
  if (domain && semanticStore.getDomain(domain) === null) {
    unknownDomain(domain)
  }
  const candidates = payload.candidates
  if (!Array.isArray(candidates)) {
    throw new ApiError(400, 'candidates 必须是数组')
  }
  const window = payload.window && typeof payload.window === 'object'
    && !Array.isArray(payload.window) ? payload.window : {}
  let status = payload.status || (candidates.length ? 'ready' : 'failed')
  if (!_STATUSES.includes(status)) status = 'ready'
  const run = insertRun({
    domain,
    connectionId: payload.connectionId,
    from: payload.from || window.from,
    to: payload.to || window.to,
    trigger: payload.trigger,
    status,
    model: payload.model,
    scanned: payload.scanned,
    deduped: payload.deduped,
    candidates,
    error: payload.error,
  })
  return { run }
}

export function handleApply(_query, body = null, _headers = null) {
  /** POST /api/semantic/distill/apply —— 把勾选的候选追加进 query-samples.md。 */
  const payload = common.bodyOf(body)
  const runId = String(payload.runId || '').trim()
  if (!runId) throw new ApiError(400, '缺少 runId')
  const run = getRun(runId)
  if (run === null) {
    throw new ApiError(404, `未知蒸馏运行: ${runId}`, 'SEMANTIC_DISTILL_RUN_UNKNOWN')
  }
  if (run.status === 'applied' || run.status === 'discarded') {
    throw new ApiError(409, `该运行已结束（${run.status}），不能重复应用`,
      'SEMANTIC_DISTILL_RUN_CLOSED')
  }
  const domain = run.domain || String(payload.domain || '').trim()
  if (!domain) {
    throw new ApiError(400, '该蒸馏运行没有绑定业务域，无法写样例')
  }
  if (semanticStore.getDomain(domain) === null) unknownDomain(domain)
  const picks = payload.picks
  if (!Array.isArray(picks) || !picks.length) {
    throw new ApiError(400, 'picks 必须是非空数组')
  }

  const item = semanticStore.getFile(domain, 'query-samples.md')
  if (item === null) {
    throw new ApiError(409, '该域没有 query-samples.md', 'SEMANTIC_FILE_UNKNOWN')
  }
  const startNumber = semanticStore.maxSampleNumber(domain)
  const blocks = []
  let offset = 0
  for (const pick of picks) {
    offset += 1
    if (!pick || typeof pick !== 'object' || Array.isArray(pick)) continue
    const sql = String(pick.sql || '').trim()
    if (!sql) continue
    const number = startNumber + offset
    const question = String(pick.question || '待补充问题').trim()
    const notes = String(pick.notes || '').trim()
    const count = pick.count
    const window = pick.window || `${run.from} ~ ${run.to}`
    const lines = [
      `### S${String(number).padStart(2, '0')} ${question}`, '',
      `**问题**：${question}`, '', '```sql', sql, '```', '',
      `- 考点：${notes || '待补充'}`,
      '- 执行校验状态：AI 蒸馏（待人工核实）',
      `- 来源：${count || 1} 次执行 / ${window}`,
    ]
    blocks.push([`S${String(number).padStart(2, '0')}`, lines.join('\n') + '\n'])
  }
  if (!blocks.length) {
    throw new ApiError(400, 'picks 里没有可用的 SQL')
  }

  let revision
  try {
    [revision] = semanticStore.appendSections(domain, 'query-samples.md', blocks)
  } catch (exc) {
    if (exc?.name === 'SemanticStoreError') throw new ApiError(400, exc.message, exc.code)
    throw exc
  }

  transaction((conn) => {
    conn.prepare(
      "UPDATE semantic_distill_run SET status='applied', applied_count=?,"
      + ' applied_at=? WHERE id=?').run(blocks.length, now(), runId)
  })
  let indexOk = true
  let indexError = ''
  try {
    semanticIndex.ensure('', true)
  } catch (exc) {
    indexOk = false
    indexError = String(exc?.message || exc)
  }
  const out = {
    run: getRun(runId), domain, revision,
    applied: blocks.length, indexOk,
  }
  if (indexError) out.indexError = indexError
  return out
}

export function handleRuns(query, _body = null, _headers = null) {
  /** GET /api/semantic/distill/runs —— 最近运行列表（面板「历史运行」）。 */
  const limit = common.intField(query || {}, 'limit', 20, 1, 100, 'limit')
  const domain = common.textField(query || {}, 'domain', '', 'domain').trim()
  let rows
  if (domain) {
    rows = queryAll(
      'SELECT * FROM semantic_distill_run WHERE domain=? '
      + 'ORDER BY seq DESC LIMIT ?', [domain, limit])
  } else {
    rows = queryAll(
      'SELECT * FROM semantic_distill_run ORDER BY seq DESC LIMIT ?', [limit])
  }
  return { runs: rows.map((row) => runRow(row)) }
}
