/**
 * 13 个 agent 工具的注册与执行（契约 §4.2）。
 *
 * 业务语义层的 4 个只读工具（契约 §3.9）在 semantic.js：只在配置了
 * semanticLayerPath 时才注册，工具表 13 → 17。
 *
 * 统一约定：
 *   - 失败一律 `throw new Error('中文原因')`，模型在工具错误里能直接读懂怎么改；
 *   - 写能力只在 allowWrites=true 时注册（db_execute / db_redis_command），
 *     其中 db_execute 的行为由 config.writeMode 决定：
 *       · 'ticket'（默认）：只提交工单，人在 Web UI 面板审批后才执行，**不调 ctx.approval**；
 *       · 'direct'：退回 v1 行为，先过 ctx.approval 再立即执行。
 *   - 没有任何工具能批准工单：agent 只能提交和查询，审批入口只在浏览器面板（防越权设计）；
 *   - execute 返回的 JSON 就是模型看到的数据，output.render 只给人看一句摘要。
 */
import { resolveModelInfo } from './ai.js'
import { clip, fmtCount, fmtMs, fmtTtl, joinNames, previewTable } from './render.js'

// ---------------------------------------------------------------- schema 片段

const CONNECTION_ID = {
  type: 'string',
  description: 'Connection id from db_list_connections, e.g. "62bfdc5ae60a".',
}
const DATABASE = {
  type: 'string',
  description: 'Database name (MySQL) or numeric db index like "0" (Redis). Omit to use the connection default.',
}

function output(properties, required, render) {
  return { schema: { type: 'object', properties, required }, render }
}

function textBlock(text) {
  return [{ type: 'text', text }]
}

/** 值预览：字符串原样（截断），其余走 JSON。 */
function previewValue(value, max = 300) {
  if (value === null || value === undefined) return 'nil'
  if (typeof value === 'string') return clip(value.replace(/\s+/g, ' '), max)
  try {
    return clip(JSON.stringify(value), max)
  } catch {
    return clip(String(value), max)
  }
}

/** 后端 results[] 归一：缺字段补默认值，保证 output.schema 对得上。 */
function normalizeResults(input) {
  return (Array.isArray(input) ? input : []).map(result => {
    const rows = Array.isArray(result?.rows) ? result.rows : []
    return {
      sql: typeof result?.sql === 'string' ? result.sql : '',
      kind: result?.kind === 'exec' ? 'exec' : 'rows',
      columns: Array.isArray(result?.columns) ? result.columns : [],
      rows,
      rowCount: Number.isFinite(Number(result?.rowCount)) ? Number(result.rowCount) : rows.length,
      truncated: result?.truncated === true,
      affectedRows: Number.isFinite(Number(result?.affectedRows)) ? Number(result.affectedRows) : null,
      elapsedMs: Number.isFinite(Number(result?.elapsedMs)) ? Number(result.elapsedMs) : 0,
      error: typeof result?.error === 'string' && result.error ? result.error : null,
    }
  })
}

/** 「1 条语句 · 12 行 · 8ms」这类摘要共用部分。 */
function describeResults(results) {
  const rows = results.reduce((sum, result) => sum + (Array.isArray(result.rows) ? result.rows.length : 0), 0)
  const affected = results.reduce((sum, result) => sum + (Number.isFinite(result.affectedRows) ? result.affectedRows : 0), 0)
  const parts = [`${results.length} 条语句`]
  if (rows) parts.push(`${fmtCount(rows)} 行`)
  if (affected) parts.push(`影响 ${fmtCount(affected)} 行`)
  return parts.join(' · ')
}

/** 多语句结果的人话预览：摘要 + 前 3 条语句的表/影响行数。 */
function renderResults(args, value, { verb = '查询完成', failure = '语句出错' } = {}) {
  const results = Array.isArray(value.results) ? value.results : []
  const lines = [`${verb} · ${fmtMs(value.elapsedMs)} · ${describeResults(results)}`]
  const failed = results.find(result => result.error)
  if (failed) {
    // 契约 §3.3：出错即停，前面成功的结果照常返回；这里必须让模型看清「不是全成功」。
    lines.push(`⚠ ${failure}：${clip(failed.error, 200)}（出错即停，后续语句未执行）`)
  }
  results.slice(0, 3).forEach((result, index) => {
    if (results.length > 1) lines.push(`— 第 ${index + 1} 条 —`)
    if (result.error) {
      lines.push(`出错：${clip(result.error, 200)}`)
      return
    }
    if (result.kind === 'exec') {
      lines.push(`执行成功，影响 ${fmtCount(result.affectedRows ?? 0)} 行（${fmtMs(result.elapsedMs)}）`)
      return
    }
    const rowCount = Number.isFinite(Number(result.rowCount)) ? Number(result.rowCount) : (Array.isArray(result.rows) ? result.rows.length : 0)
    if (!rowCount && !(Array.isArray(result.rows) && result.rows.length)) {
      lines.push('结果为空（0 行）')
    } else {
      lines.push(previewTable(result.columns, result.rows, { maxRows: 5, maxColumns: 8 }))
    }
    // 契约 §3.3：truncated=true 时 error=null，别让模型以为拿到了全量。
    if (result.truncated) lines.push(`⚠ 已截断：命中 maxRows/${fmtCount(result.rowCount)} 行上限，结果不是全量。`)
  })
  if (results.length > 3) lines.push(`…其余 ${results.length - 3} 条语句的结果见 JSON`)
  return textBlock(lines.join('\n'))
}

// ---------------------------------------------------------------- 工单（契约 §3.6）
//
// 工单模式是「AI 提交、人审批」：工具层只负责建单/查询，绝不能出现「批准」能力。

const TICKET_STATUS_TEXT = {
  pending: '待审批',
  approved: '已批准',
  executing: '执行中',
  succeeded: '已成功',
  failed: '执行失败',
  rejected: '已拒绝',
  cancelled: '已取消',
}
const RISK_TEXT = { low: '低风险', medium: '中风险', high: '高风险' }

function statusText(status) {
  const key = String(status ?? '')
  return TICKET_STATUS_TEXT[key] ?? (key || '未知状态')
}

function riskText(risk) {
  return RISK_TEXT[risk] ?? (risk ? String(risk) : '未知风险')
}

/** counts 缺字段补 0，保证 output.schema 对得上。 */
function normalizeCounts(input) {
  const source = input && typeof input === 'object' ? input : {}
  const counts = {}
  for (const key of ['pending', 'succeeded', 'failed', 'rejected', 'cancelled', 'undone']) {
    counts[key] = Number.isFinite(Number(source[key])) ? Number(source[key]) : 0
  }
  return counts
}

// ---------------------------------------------------------------- 脱敏（契约 §3.7）
//
// 硬规则：脱敏在引擎出站前完成，工具层拿到的已经是掩码值。
// 这里只读 Connection.masking 做「概况/标记」，绝不脱敏、也绝不还原任何值。

/** Connection.masking → 工具层只关心两个数：是否开启、字段数。 */
function normalizeMasking(connection) {
  const masking = connection && typeof connection === 'object' && connection.masking && typeof connection.masking === 'object'
    ? connection.masking
    : null
  if (!masking || masking.enabled !== true) return { enabled: false, fields: 0 }
  const fields = Array.isArray(masking.fields) ? masking.fields.length : 0
  const masked = Number.isFinite(Number(masking.summary?.masked)) ? Number(masking.summary.masked) : 0
  return { enabled: true, fields: fields || masked }
}

/** 一组连接上的脱敏概况；Redis 连接不参与（契约 §3.7：Redis 忽略 masking）。 */
function summarizeMasking(connections) {
  let enabledConnections = 0
  let totalFields = 0
  for (const row of Array.isArray(connections) ? connections : []) {
    if (row?.kind === 'redis') continue
    const masking = normalizeMasking(row)
    if (!masking.enabled) continue
    enabledConnections += 1
    totalFields += masking.fields
  }
  return { enabledConnections, totalFields }
}

/** estimated（影响面预估）归一；affectedRows=null 表示无法预估（DDL/一条都没估出来）。
 *  多语句时 affectedRows 是各条之和，unknownStatements 是估不出行数的条数（契约 §3.6）。 */
function normalizeEstimated(input) {
  const source = input && typeof input === 'object' ? input : {}
  const statements = Array.isArray(source.statements) ? source.statements : []
  const hasRows = source.affectedRows !== null && source.affectedRows !== undefined && Number.isFinite(Number(source.affectedRows))
  const unknownRaw = Number(source.unknownStatements)
  return {
    affectedRows: hasRows ? Number(source.affectedRows) : null,
    rowsExact: source.rowsExact === true,
    statementCount: Number.isFinite(Number(source.statementCount)) ? Number(source.statementCount) : statements.length,
    unknownStatements: Number.isFinite(unknownRaw) && unknownRaw > 0 ? Math.trunc(unknownRaw) : 0,
    risk: typeof source.risk === 'string' && source.risk ? source.risk : 'medium',
    statements: statements.map(row => {
      const statement = {
        kind: String(row?.kind ?? ''),
        table: String(row?.table ?? ''),
        hasWhere: row?.hasWhere === true,
        estimatedRows: row?.estimatedRows !== null && row?.estimatedRows !== undefined && Number.isFinite(Number(row.estimatedRows))
          ? Number(row.estimatedRows)
          : null,
        // exact = 该条是同条件 SELECT COUNT(*) 的精确值（后端只有 COUNT 命中才给 true）。
        exact: row?.exact === true,
      }
      // plan = 该条语句的 EXPLAIN 计划明细（访问类型/命中索引/逐表行数）；有才带。
      if (Array.isArray(row?.plan)) {
        statement.plan = row.plan.map(entry => ({
          accessType: entry?.accessType === null || entry?.accessType === undefined ? null : String(entry.accessType),
          key: entry?.key === null || entry?.key === undefined ? null : String(entry.key),
          rows: Number.isFinite(Number(entry?.rows)) ? Number(entry.rows) : null,
        }))
      }
      // sql = 该条语句的预览（后端给 ≤200 字符）；有才带，避免空字符串污染 schema。
      if (typeof row?.sql === 'string' && row.sql.trim()) statement.sql = String(row.sql)
      return statement
    }),
    notes: (Array.isArray(source.notes) ? source.notes : []).map(note => String(note)),
  }
}

/** 工单归一：字段固定，可选字段只在真有值时出现。 */
function normalizeTicket(input) {
  const source = input && typeof input === 'object' ? input : {}
  const ticket = {
    id: String(source.id ?? ''),
    status: String(source.status ?? 'pending'),
    connectionId: String(source.connectionId ?? ''),
    connectionName: String(source.connectionName ?? ''),
    database: String(source.database ?? ''),
    sql: String(source.sql ?? ''),
    title: String(source.title ?? ''),
    background: String(source.background ?? ''),
    submittedBy: String(source.submittedBy ?? ''),
    createdAt: String(source.createdAt ?? ''),
    estimated: normalizeEstimated(source.estimated),
  }
  if (source.approvedAt) ticket.approvedAt = String(source.approvedAt)
  if (source.approvedBy) ticket.approvedBy = String(source.approvedBy)
  if (typeof source.approvalComment === 'string' && source.approvalComment) ticket.approvalComment = source.approvalComment
  if (source.executedAt) ticket.executedAt = String(source.executedAt)
  if (source.actual && typeof source.actual === 'object') {
    ticket.actual = {
      affectedRows: source.actual.affectedRows !== null && source.actual.affectedRows !== undefined && Number.isFinite(Number(source.actual.affectedRows))
        ? Number(source.actual.affectedRows)
        : null,
      elapsedMs: Number.isFinite(Number(source.actual.elapsedMs)) ? Number(source.actual.elapsedMs) : 0,
    }
    // actual.results = 逐条语句的执行结果；多语句时模型要能看明细，所以原样透传。
    if (Array.isArray(source.actual.results)) ticket.actual.results = source.actual.results
    // undo = 撤销可用性摘要（§3.6a）：available=false 时模型要如实告诉用户「不可撤销+原因」
    if (source.actual.undo && typeof source.actual.undo === 'object') ticket.actual.undo = {
      available: source.actual.undo.available === true,
      reason: String(source.actual.undo.reason ?? ''),
      undoId: String(source.actual.undo.undoId ?? ''),
    }
  }
  if (source.error) ticket.error = String(source.error)
  // rowsPayload = 结构化工单（契约 §3.3b）：参数化语句 + render 人读文本，原样透传。
  if (source.rowsPayload && typeof source.rowsPayload === 'object') ticket.rowsPayload = source.rowsPayload
  return ticket
}

/** 「预估影响约 3 行（精确）· 低风险 · 1 条语句」
 *  多语句时（契约 §3.6）：「共 3 条语句 · 预计影响 9 行（合计）· 低风险 · 其中 1 条无法预估」。
 *  affectedRows 是各条估算之和（null = 一条都估不出来）。 */
function estimatedText(estimated) {
  const parts = []
  const multi = estimated.statementCount > 1
  if (multi) parts.push(`共 ${estimated.statementCount} 条语句`)
  if (estimated.affectedRows === null) {
    parts.push(multi ? '影响行数无法预估（各条均未估算出）' : '影响行数无法预估')
  } else if (multi) {
    parts.push(`预计影响 ${fmtCount(estimated.affectedRows)} 行（合计）${estimated.rowsExact ? '（精确）' : ''}`)
  } else {
    parts.push(`预估影响约 ${fmtCount(estimated.affectedRows)} 行${estimated.rowsExact ? '（精确）' : '（估算）'}`)
  }
  parts.push(riskText(estimated.risk))
  if (!multi) parts.push('1 条语句')
  if (multi && estimated.unknownStatements > 0) parts.push(`其中 ${estimated.unknownStatements} 条无法预估`)
  return parts.join(' · ')
}

/** 多语句工单的执行语义：单事务、全成或全回滚。 */
const MULTI_STATEMENT_NOTE = '多条语句在同一事务里按顺序执行，任一条失败整体回滚（不会部分生效）。'

/** 预估明细里是否含 DDL（CREATE/ALTER/DROP/TRUNCATE/RENAME）：这类写不会纳入撤销快照（第 37 轮）。 */
const DDL_KINDS = new Set(['create', 'alter', 'drop', 'truncate', 'rename'])

function hasDdlStatements(estimated) {
  if (!estimated || !Array.isArray(estimated.statements)) return false
  return estimated.statements.some(row => DDL_KINDS.has(String((row && row.kind) || '').toLowerCase()))
}

/** 检测到 DDL/备份表脚手架时的劝阻提示：模型即时看到，审批人也能在工单/审批文案里看到。 */
const DDL_UNDO_NOTE = '⚠ 含 DDL/辅助语句：这类写不会纳入撤销快照（不可 db_undo）。不要建备份表/临时表——后端在每次写之前已自动快照受影响行，只需提交达成变更的最小 DML。'

/** EXPLAIN 计划明细的一行人读摘要：「ref(PRIMARY) + ALL」（多表计划逐表列出）。 */
function planText(plan) {
  if (!Array.isArray(plan) || !plan.length) return ''
  return ' · ' + plan.map(entry => entry?.key ? `${entry.accessType || '?'}(${entry.key})` : (entry?.accessType || '?')).join(' + ')
}

/** 预估的逐条明细：「第 1 条 · UPDATE users · 3 行（精确） · ref(PRIMARY) · UPDATE users SET ...」。 */
function statementLines(estimated, { limit = 10, sqlWidth = 100 } = {}) {
  const lines = estimated.statements.slice(0, limit).map((row, index) => {
    const rowsText = row.estimatedRows === null
      ? '约 ? 行（无法预估）'
      : `${row.exact ? '' : '约 '}${fmtCount(row.estimatedRows)} 行${row.exact ? '（精确）' : ''}`
    const kind = row.kind || '?'
    const table = row.table ? ` ${row.table}` : ''
    const where = row.hasWhere ? '' : '（无 WHERE）'
    const sqlPreview = row.sql ? ` · ${clip(row.sql, sqlWidth)}` : ''
    return `第 ${index + 1} 条 · ${kind}${table} · ${rowsText}${where}${planText(row.plan)}${sqlPreview}`
  })
  if (estimated.statements.length > limit) lines.push(`…其余 ${estimated.statements.length - limit} 条明细见 JSON`)
  return lines
}

/** 工单状态/预估给人看的一行。 */
function ticketHeadline(ticket) {
  return `${ticket.id}（${statusText(ticket.status)}）· ${estimatedText(ticket.estimated)}${ticket.title ? ` · ${ticket.title}` : ''}`
}

// ---------------------------------------------------------------- 审批

function denialText(outcome) {
  switch (outcome) {
    case 'rejected':
      return '用户拒绝了这次写操作，未执行（数据没有变化）。'
    case 'cancelled':
      return '审批被取消（会话中断或中止），写操作未执行。'
    case 'unavailable':
      return '当前没有可用的审批入口，写操作未执行。请在 DSH 里确认审批服务可用后重试。'
    default:
      return `审批未通过（${outcome}），写操作未执行。`
  }
}

/** 写操作统一审批；只有 'allowed-once' 才算通过。 */
async function requestApproval(ctx, exec, { toolName, zh, en }) {
  if (!exec?.agent) throw new Error('写操作只能由模型会话发起：当前调用没有 agent，已拒绝。')
  let outcome
  try {
    outcome = await ctx.approval.request({
      agent: exec.agent,
      toolName,
      callId: exec.callId,
      reason: zh,
      displayReason: { en, zh },
      signal: exec.signal,
    })
  } catch (error) {
    throw new Error(`审批请求失败，写操作未执行：${error instanceof Error ? error.message : String(error)}`)
  }
  if (outcome !== 'allowed-once') throw new Error(denialText(outcome))
  return outcome
}

/** 审批文案里的人话连接名：拿不到连接列表就退回 id。 */
async function connectionTitle(backend, connectionId, signal) {
  try {
    const body = await backend.getJson('/api/connections', {}, { signal })
    const rows = Array.isArray(body.connections) ? body.connections : []
    const row = rows.find(item => item?.id === connectionId)
    if (!row) return `连接 ${connectionId}`
    const kind = row.kind === 'redis' ? 'Redis' : 'MySQL'
    const address = row.host ? ` ${row.host}${row.port ? `:${row.port}` : ''}${row.database ? `/${row.database}` : ''}` : ''
    return `「${row.name || connectionId}」（${kind}${address}${row.readonly ? '，只读' : ''}）`
  } catch {
    return `连接 ${connectionId}`
  }
}

/** direct 审批前的影响面预估（best-effort）：失败返回 null，绝不阻塞审批。
 *  用工单的 estimate 端点（EXPLAIN 估算 + 估算小时同条件 COUNT(*)），只算不存。 */
async function estimateForApproval(backend, args, settings, signal) {
  try {
    const payload = { connectionId: args.connectionId, sql: args.sql }
    if (args.database) payload.database = args.database
    const body = await backend.postJson('/api/tickets/estimate', payload, {
      signal,
      timeoutMs: settings.timeout * 1000 + 10_000,
    })
    const estimated = normalizeEstimated(body?.estimated)
    return estimated.statements.length ? estimated : null
  } catch {
    return null  // 预估是增强信息：后端老/挂了/连接是 Redis 都静默降级
  }
}

/** 预估的英文一行（displayReason.en 用）：「~3 rows (exact), low risk」。 */
function estimatedLineEn(estimated) {
  const rows = estimated.affectedRows === null
    ? 'impact unknown'
    : `~${fmtCount(estimated.affectedRows)} rows${estimated.rowsExact ? ' (exact)' : ' (estimated)'}`
  const risk = estimated.risk === 'high' ? 'high risk' : (estimated.risk === 'low' ? 'low risk' : 'medium risk')
  return `${rows}, ${risk}`
}

// ---------------------------------------------------------------- Redis 命令分类

/** 只读命令白名单；不在表里的一律按写命令走审批（fail safe）。
 *  刻意不含 CLIENT / MEMORY / DEBUG —— 它们能踢连接或改服务端行为。
 *  未知命令同样按写处理：可写连接上的销毁级命令后端不拦，审批是唯一防线。 */
const REDIS_READONLY = new Set([
  'GET', 'MGET', 'STRLEN', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'EXPIRETIME', 'PEXPIRETIME',
  'SCAN', 'HSCAN', 'SSCAN', 'ZSCAN', 'HGET', 'HMGET', 'HGETALL', 'HKEYS', 'HVALS', 'HLEN',
  'HEXISTS', 'HRANDFIELD', 'LCS', 'LRANGE', 'LLEN', 'LINDEX', 'LPOS', 'SMEMBERS', 'SCARD',
  'SISMEMBER', 'SMISMEMBER', 'SRANDMEMBER', 'SINTER', 'SUNION', 'SDIFF', 'ZRANGE',
  'ZREVRANGE', 'ZRANGEBYSCORE', 'ZREVRANGEBYSCORE', 'ZRANGEBYLEX', 'ZREVRANGEBYLEX',
  'ZSCORE', 'ZMSCORE', 'ZCARD', 'ZCOUNT', 'ZRANK', 'ZREVRANK', 'ZRANDMEMBER', 'BITCOUNT',
  'BITPOS', 'GETRANGE', 'GETBIT', 'XRANGE', 'XLEN', 'XINFO', 'XPENDING', 'INFO', 'DBSIZE',
  'PING', 'ECHO', 'OBJECT', 'DUMP', 'RANDOMKEY', 'COMMAND', 'TIME', 'LASTSAVE',
])

/** 后端明确禁用的 Redis 命令（契约 §3.4：任何连接都 400）。 */
const REDIS_FORBIDDEN = {
  KEYS: 'KEYS 命令被禁用：请改用 db_redis_scan 分页扫描键。',
  SELECT: 'Redis SELECT 命令被禁用：用 database 参数（如 "0"）选择 db。',
}

function redisCommandName(command) {
  return String(command ?? '').trim().split(/\s+/)[0].toUpperCase()
}

// ---------------------------------------------------------------- db_execute 的两种策略

/**
 * ticket 模式（默认，契约 §4.2 / §3.6）：只创建工单，人在面板审批后才执行。
 * 注意这里**不碰 ctx.approval**——审批发生在面板的工单详情里。
 */
function buildTicketExecuteDefinition({ settings, backend }) {
  return {
    name: 'db_execute',
    description:
      'Submit one or more WRITE statements (INSERT/UPDATE/DELETE/DDL) as a change ticket for a human to review in the '
      + 'db-studio panel. This does NOT execute anything: the ticket stays pending until a human approves it in the Web '
      + 'UI, then the backend runs ALL statements in a single transaction — if any statement fails, everything rolls '
      + 'back (no partial execution). Submit ONLY the minimal DML that effects the change — never scaffold '
      + 'backup/temp tables or helper DDL: the backend already snapshots affected rows before every write and '
      + 'single-statement writes can be reverted with db_undo, while extra statements make the ticket '
      + 'multi-statement/DDL and forfeit that undo protection. The estimated impact is the SUM of every statement, '
      + 'with per-statement detail in the result. You cannot approve tickets — never claim a write has been applied. '
      + 'Always tell the user the ticket '
      + 'id, the estimated impact and that they should approve it in the panel. The backend still rejects readonly '
      + 'connections and UPDATE/DELETE without a top-level WHERE at submit time (checked for every statement). '
      + 'If the connection has masking enabled, ticket execution results are masked by the backend as well '
      + '(e.g. 138****5678) — that is by design; never try to reconstruct or infer the original values.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        sql: {
          type: 'string',
          description: 'One or more write statements separated by ";". Minimal DML only — no backup/temp-table '
            + 'scaffolding (it forfeits undo). Multi-statement tickets run in ONE transaction on approval: if any '
            + 'statement fails, everything rolls back. The estimated impact is the sum of all statements.',
        },
        background: {
          type: 'string',
          description: 'Why this change is needed (at least 4 characters). Shown to the human reviewer in the ticket — mandatory.',
        },
        title: { type: 'string', description: 'Short ticket title, e.g. "UPDATE t_check_config". Omit to let the backend generate one.' },
      },
      required: ['connectionId', 'sql', 'background'],
      additionalProperties: false,
    },
    output: output(
      {
        mode: { type: 'string' },
        ticketId: { type: 'string' },
        status: { type: 'string' },
        title: { type: 'string' },
        connectionId: { type: 'string' },
        connectionName: { type: 'string' },
        database: { type: 'string' },
        background: { type: 'string' },
        awaitingApproval: { type: 'boolean' },
        estimated: { type: 'object' },
        message: { type: 'string' },
      },
      ['mode', 'ticketId', 'status', 'background', 'awaitingApproval', 'estimated', 'message'],
      (args, value) => {
        const estimated = value.estimated
        const multi = estimated.statementCount > 1
        const lines = [
          `已提交工单 ${value.ticketId}（${statusText(value.status)}）· 等待人工在 Web UI「数据管理 → 工单」里审批（agent 不能批准）`,
          multi ? `预估：${estimatedText(estimated)}` : `预估影响：${estimatedText(estimated)}`,
        ]
        if (multi) {
          // 多语句：合计在上面，这里先说执行语义再逐条列明细。
          lines.push(`执行方式：${MULTI_STATEMENT_NOTE}`)
          lines.push(...statementLines(estimated))
        }
        if (hasDdlStatements(estimated)) {
          // 模型爱用「先建备份表再写」的脚手架：这会让工单变成多语句/DDL，丧失自动撤销保护（第 37 轮）。
          lines.push(DDL_UNDO_NOTE)
        }
        if (estimated.affectedRows === null) {
          // 无法预估的原因不止 DDL（SELECT、EXPLAIN 失败、连不上都可能），用后端给的 notes 说明真实原因。
          const why = Array.isArray(estimated.notes) && estimated.notes.length
            ? `（${estimated.notes[0]}）`
            : ''
          lines.push(`⚠ 影响行数无法预估${why}，请人工在审批前确认影响范围。`)
        }
        if (estimated.notes.length) lines.push(`提示：${estimated.notes.slice(0, 3).join('；')}`)
        if (value.title) lines.push(`标题：${value.title}`)
        lines.push(`背景：${clip(value.background, 160)}`)
        lines.push(`SQL：${clip(args.sql, 200)}`)
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      // 不在工具层拆 SQL：只拦住空/纯分号输入，拆分与校验都在后端（避免两套语义）。
      const sql = String(args.sql ?? '')
      if (!sql.replace(/[;\s]/g, '')) {
        throw new Error('db_execute 需要至少一条 SQL：sql 不能只有空白或分号；多条语句请用 ";" 分隔。')
      }
      const background = String(args.background ?? '').trim()
      if (background.length < 4) throw new Error('db_execute 需要 background（给人看的变更背景，至少 4 个字符，必填）。')
      const payload = { connectionId: args.connectionId, sql, background }
      if (args.database) payload.database = args.database
      const title = String(args.title ?? '').trim()
      if (title) payload.title = title
      // 创建工单时后端做三道校验（连接/只读/WHERE），失败直接是中文错误。
      const body = await backend.postJson('/api/tickets', payload, {
        signal: exec.signal,
        timeoutMs: settings.timeout * 1000 + 30_000,
      })
      const ticket = normalizeTicket(body?.ticket)
      if (!ticket.id) throw new Error('后端没有返回工单 id：请先调用 db_status 检查后端与工单接口状态。')
      return {
        mode: 'ticket',
        ticketId: ticket.id,
        status: ticket.status,
        title: ticket.title,
        connectionId: ticket.connectionId || args.connectionId,
        connectionName: ticket.connectionName,
        database: ticket.database || args.database || '',
        background,
        awaitingApproval: ticket.status === 'pending',
        estimated: ticket.estimated,
        message: '已提交工单，等待人工在 Web UI「数据管理 → 工单」里审批；agent 不能批准工单。',
      }
    },
  }
}

/** direct 模式（config.writeMode='direct'）：v1 行为，先过一次 ctx.approval 再立即执行。 */
function buildDirectExecuteDefinition(ctx, { settings, backend }) {
  return {
    name: 'db_execute',
    description:
      'Run a write statement (INSERT/UPDATE/DELETE/DDL) on a writable connection. Each call needs one-time user '
      + 'approval plus a short reason. Before the approval prompt the tool estimates the impact (EXPLAIN plan plus '
      + 'a same-condition SELECT COUNT(*) when the estimate is small) and shows it to the user, so keep the sql '
      + 'narrow — the estimate fails on sloppy statements. Guards are pre-validated before anything runs: readonly '
      + 'connections reject non-readonly SQL and UPDATE/DELETE without a top-level WHERE rejects the whole request '
      + '(zero partial execution); the write runs in one transaction, so an error or truncation rolls everything '
      + 'back. Write minimal DML only — never create backup/temp tables: the backend snapshots affected rows '
      + 'automatically, single-statement writes stay revertible via db_undo, and extra statements forfeit that. '
      + 'Only use it when the user explicitly asks to change data. '
      + 'If the connection has masking enabled, returned data rows are already masked by the backend (e.g. 138****5678) '
      + '— that is by design; never try to reconstruct or infer the original values.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        sql: { type: 'string', description: 'One or more write statements, separated by ";". Minimal DML only — no backup/temp tables (they forfeit undo).' },
        reason: { type: 'string', description: 'One sentence shown to the user in the approval prompt: why this write is needed.' },
      },
      required: ['connectionId', 'sql', 'reason'],
      additionalProperties: false,
    },
    output: output(
      {
        connectionId: { type: 'string' },
        database: { type: 'string' },
        reason: { type: 'string' },
        elapsedMs: { type: 'number' },
        results: { type: 'array', items: { type: 'object' } },
      },
      ['connectionId', 'database', 'reason', 'elapsedMs', 'results'],
      (args, value) => renderResults(args, value, { verb: '写入完成（已获批准）', failure: '写入失败（事务已回滚）' }),
    ),
    async execute(args, exec) {
      const reason = String(args.reason ?? '').trim()
      if (!reason) throw new Error('db_execute 需要一句 reason（给用户看的写入原因）。')
      // 先确认后端可用、拿到连接名并预估影响面，再打扰用户审批（预估失败不阻塞）。
      const title = await connectionTitle(backend, args.connectionId, exec.signal)
      const estimated = await estimateForApproval(backend, args, settings, exec.signal)
      const impactZh = estimated ? `；${estimatedText(estimated)}` : ''
      const impactEn = estimated ? `; ${estimatedLineEn(estimated)}` : ''
      // 含 DDL 的写不会纳入撤销快照：审批文案里明示，让人和模型都能看到（第 37 轮）
      const ddlZh = hasDdlStatements(estimated) ? '；⚠ 含 DDL：本次写不会纳入撤销快照（不可 db_undo）' : ''
      const ddlEn = hasDdlStatements(estimated) ? '; DDL detected: this write is not undoable via db_undo' : ''
      const sqlPreview = clip(args.sql, 160)
      await requestApproval(ctx, exec, {
        toolName: 'db_execute',
        zh: `将在${title}执行：${sqlPreview}${impactZh}${ddlZh}（原因：${clip(reason, 100)}）`,
        en: `Run on ${title}: ${sqlPreview}${impactEn}${ddlEn} (reason: ${clip(reason, 100)})`,
      })
      const payload = { connectionId: args.connectionId, sql: args.sql, reason }
      if (args.database) payload.database = args.database
      const body = await backend.postJson('/api/execute', payload, {
        signal: exec.signal,
        timeoutMs: settings.timeout * 1000 + 20_000,
      })
      return {
        connectionId: args.connectionId,
        database: args.database ?? '',
        reason,
        elapsedMs: Number(body.elapsedMs) || 0,
        results: normalizeResults(body.results),
      }
    },
  }
}

// ---------------------------------------------------------------- db_undo_last

/** undo 归一：preview/undo 响应共用；reverse = 占位符反向语句（值不出站，契约 §3.6a）。 */
function normalizeUndo(input) {
  const source = input && typeof input === 'object' ? input : {}
  const undo = {
    id: String(source.id ?? ''),
    status: String(source.status ?? ''),
    connectionId: String(source.connectionId ?? ''),
    connectionName: String(source.connectionName ?? ''),
    database: String(source.database ?? ''),
    sql: String(source.sql ?? ''),
    kind: String(source.kind ?? ''),
    op: String(source.op ?? ''),
    table: String(source.table ?? ''),
    affectedRows: Number.isFinite(Number(source.affectedRows)) ? Number(source.affectedRows) : null,
    undoAvailable: source.undoAvailable === true,
    undoOf: String(source.undoOf ?? ''),
    redoId: String(source.redoId ?? ''),
    createdAt: String(source.createdAt ?? ''),
    undoneAt: String(source.undoneAt ?? ''),
    reverseCount: Number.isFinite(Number(source.reverseCount)) ? Number(source.reverseCount) : 0,
    capturedRows: Number.isFinite(Number(source.capturedRows)) ? Number(source.capturedRows) : null,
  }
  if (Array.isArray(source.reverse)) undo.reverse = source.reverse.map(row => ({
    sql: String(row?.sql ?? ''),
  }))
  return undo
}

/**
 * V2.2 撤销最近一次可撤销变更（契约 §3.6a）。撤销本身也是写：direct 模式走 ctx.approval
 * 后由后端在单事务里执行参数化反向语句（撤销也会被快照 → 可 redo）；ticket 模式下 agent
 * 只能查询并引导人工在面板点「撤销」——审批动作永远由人完成（与 D4/D5 一致）。
 * Redis 不参与快照/撤销（V2 范围约束：仅 MySQL 写路径）。
 */
function buildUndoLastDefinition(ctx, { settings, backend }) {
  return {
    name: 'db_undo_last',
    description:
      'Undo the most recent undoable MySQL write made through db-studio (the backend snapshots affected rows before '
      + 'every write: affected UPDATE/DELETE rows are restored to their old values, DELETEd rows are re-inserted, '
      + 'INSERTed rows are removed; multi-statement DML replays segment-by-segment in reverse order). '
      + 'In writeMode=direct this asks for one-time user approval, then runs the parameterized reverse statements in '
      + 'ONE transaction — the undo itself is snapshotted, so it can be redone. In writeMode=ticket this only reports '
      + 'the pending undo and tells the user to click 撤销 in the db-studio panel; you can never approve or run it '
      + 'yourself. Undo availability depends on the original write: DDL / multi-table statements / multi-row VALUES '
      + 'INSERT / over-limit writes are marked not undoable at execution time. Redis writes are never snapshot-able.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: output(
      {
        mode: { type: 'string' },
        undo: { type: 'object' },
        elapsedMs: { type: 'number' },
        affectedRows: { type: 'number' },
        message: { type: 'string' },
      },
      ['mode', 'undo', 'message'],
      (args, value) => {
        const undo = value.undo
        const lines = [value.message]
        lines.push(`撤销目标：${undo.id}（${undo.op || undo.kind || '?'} ${undo.table} · 影响 ${fmtCount(undo.affectedRows ?? undo.capturedRows ?? 0)} 行 · ${undo.createdAt || ''}）`)
        if (Array.isArray(undo.reverse) && undo.reverse.length) {
          lines.push(`反向语句（${undo.reverse.length} 条，值已参数化不出站）：`)
          for (const statement of undo.reverse.slice(0, 5)) lines.push(`· ${clip(statement.sql, 160)}`)
        }
        if (value.mode === 'ticket') {
          lines.push('请让用户在 Web UI「数据管理 → 工单 / 历史」里点「撤销本次变更」；agent 不能替人撤销。')
        } else if (undo.redoId || undo.status === 'undone') {
          lines.push('撤销已执行（本身也被快照，可在面板再撤销以恢复）。')
        }
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const body = await backend.getJson('/api/undo/preview', {}, {
        signal: exec.signal,
        timeoutMs: settings.timeout * 1000 + 10_000,
      })
      const undo = normalizeUndo(body?.undo)
      if (!undo.id) throw new Error('当前没有可撤销的变更（DDL/多表/多行 INSERT/超限的写执行会被标记为不可撤销）。')
      const title = await connectionTitle(backend, undo.connectionId, exec.signal)
      if (settings.writeMode === 'direct') {
        await requestApproval(ctx, exec, {
          toolName: 'db_undo_last',
          zh: `将撤销${title}上的变更 ${undo.id}（${undo.op} ${undo.table}，恢复 ${fmtCount(undo.capturedRows ?? 0)} 行，反向 ${undo.reverseCount} 条语句）（原因：撤销最近一次写操作，恢复执行前数据）`,
          en: `Undo change ${undo.id} on ${title} (${undo.op} ${undo.table}, restore ${fmtCount(undo.capturedRows ?? 0)} rows, ${undo.reverseCount} reverse statements) (reason: undo the last write)`,
        })
        const result = await backend.postJson('/api/undo', { id: undo.id }, {
          signal: exec.signal,
          timeoutMs: settings.timeout * 1000 + 30_000,
        })
        return {
          mode: 'direct',
          undo: normalizeUndo(result?.undo),
          elapsedMs: Number(result?.elapsedMs) || 0,
          affectedRows: Number(result?.affectedRows) || 0,
          message: '撤销完成：反向语句已在单事务里执行（本身也被快照，可再次撤销以恢复）。',
        }
      }
      return {
        mode: 'ticket',
        undo,
        elapsedMs: 0,
        affectedRows: 0,
        message: `已找到可撤销变更 ${undo.id}（${undo.op} ${undo.table}，影响 ${fmtCount(undo.affectedRows ?? 0)} 行）：等待人工在 Web UI 面板里点「撤销本次变更」（agent 不能撤销）。`,
      }
    },
  }
}

// ---------------------------------------------------------------- db_write_rows

/** rowsPayload 入参归一/上限：工具层只拦明显错误（空表名/空 diff/条数超限），生成在后端。 */
const WRITE_ROWS_MAX = 200

function normalizeRowDiff(args) {
  const table = String(args.table ?? '').trim()
  if (!table) throw new Error('db_write_rows 需要 table（建议带库名，如 "db.bills"）或配 database 参数。')
  const updates = Array.isArray(args.updates) ? args.updates : []
  const inserts = Array.isArray(args.inserts) ? args.inserts : []
  const deletes = Array.isArray(args.deletes) ? args.deletes : []
  const total = updates.length + inserts.length + deletes.length
  if (!total) throw new Error('db_write_rows 至少要有一行变更：updates / inserts / deletes 之一（结构化 diff，不收 SQL 字符串）。')
  if (total > WRITE_ROWS_MAX) throw new Error(`db_write_rows 一次最多 ${WRITE_ROWS_MAX} 行（当前 ${total} 行），请分批提交。`)
  for (const [index, item] of updates.entries()) {
    if (!item || typeof item !== 'object' || !item.keys || !item.set) {
      throw new Error(`updates[${index}] 需要 {keys, set}：keys = 主键定位（如 {"id":3}），set = 要改的列值。`)
    }
  }
  return { table, updates, inserts, deletes, total }
}

/** 结构化 diff 给人看的一行：「1 更新 · 0 插入 · 1 删除（共 2 行）demo_db.bills」。 */
function rowDiffText(diff, table) {
  return `${diff.updates.length} 更新 · ${diff.inserts.length} 插入 · ${diff.deletes.length} 删除（共 ${fmtCount(diff.total)} 行）${table ? ` · ${table}` : ''}`
}

/**
 * V2.3 结构化行写（契约 §3.3b）：让模型说「把 id=3 的 status 改成 archived」，而不是拼 SQL。
 * 后端用主键定位生成参数化 DML（值绝不内联），direct 直执行 / ticket 建结构化工单（审批人看
 * render 文本，执行走参数化）。多行 = 多语句 → 标记不可撤销；写错就再调一次本工具提交反向 diff。
 */
function buildWriteRowsDefinition(ctx, { settings, backend }) {
  const isDirect = settings.writeMode === 'direct'
  return {
    name: 'db_write_rows',
    description:
      'Make structured row changes on a writable MySQL table WITHOUT writing SQL: pass a table plus updates '
      + '({keys, set} located by primary key), inserts (full row objects) and deletes (primary-key objects). The '
      + 'backend generates parameterized DML (values never inlined) and runs it in one transaction with guards and '
      + 'pre-change snapshots — backup tables are never needed. Prefer this over db_execute for small, precise row edits — say "set status of id=3 '
      + `to archived" with keys/set instead of an UPDATE string. Up to ${WRITE_ROWS_MAX} rows per call; the table `
      + 'must have a primary key. Changes are snapshotted for undo like any write — multi-row calls replay '
      + 'segment-by-segment in reverse on undo; only writes over the snapshot row cap lose undo, and to revert those '
      + 'you can call this again with the reverse diff. '
      + (isDirect
        ? 'Each call needs one-time user approval plus a short reason.'
        : 'This submits a structured change ticket for human approval in the db-studio panel (you cannot approve it) '
          + 'and needs a background explaining why.'),
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        table: { type: 'string', description: 'Target table, e.g. "db.bills" (or set database and use "bills").' },
        updates: {
          type: 'array',
          description: 'Rows to update: [{keys: {"id": 3}, set: {"status": "archived"}}]. keys locate the row by primary key.',
          items: { type: 'object' },
        },
        inserts: {
          type: 'array',
          description: 'Rows to insert: [{"name": "x", "status": "draft"}] (omit auto-increment columns).',
          items: { type: 'object' },
        },
        deletes: {
          type: 'array',
          description: 'Rows to delete, located by primary key: [{"id": 9}].',
          items: { type: 'object' },
        },
        background: { type: 'string', description: 'ticket mode: why this change is needed (>=4 chars, mandatory).' },
        reason: { type: 'string', description: 'direct mode: one sentence shown in the approval prompt.' },
        title: { type: 'string', description: 'ticket mode: short ticket title. Omit to auto-generate.' },
      },
      required: ['connectionId', 'table'],
      additionalProperties: false,
    },
    output: output(
      {
        mode: { type: 'string' },
        ticketId: { type: 'string' },
        status: { type: 'string' },
        table: { type: 'string' },
        summary: { type: 'object' },
        rendered: { type: 'array', items: { type: 'string' } },
        elapsedMs: { type: 'number' },
        results: { type: 'array', items: { type: 'object' } },
        undo: { type: 'object' },
        estimated: { type: 'object' },
        message: { type: 'string' },
      },
      ['mode', 'table', 'summary', 'message'],
      (args, value) => {
        const lines = [value.message]
        lines.push(`结构化变更：${rowDiffText(value.summary, value.table)}`)
        const rendered = Array.isArray(value.rendered) ? value.rendered : []
        if (rendered.length) {
          lines.push('生成语句（参数化执行，以下为人读渲染，仅供核对）：')
          for (const text of rendered.slice(0, 6)) lines.push(`· ${clip(text, 160)}`)
          if (rendered.length > 6) lines.push(`…其余 ${rendered.length - 6} 条见 JSON`)
        }
        if (value.mode === 'ticket') {
          lines.push(`已提交工单 ${value.ticketId || ''}（${statusText(value.status)}）：等待人工在 Web UI 审批（agent 不能批准）。`)
          if (value.estimated) lines.push(`预估：${estimatedText(value.estimated)}`)
        } else {
          // 未纳入撤销快照（超限/表无主键等）才提示反向 diff；多语句本身已可撤销（第 38 轮）
          const undoNote = value.undo && value.undo.available === false
            ? `；本次写未纳入撤销快照（${value.undo.reason || '不可撤销'}）——写错请再调 db_write_rows 提交反向 diff。`
            : ''
          lines.push(`执行完成（${fmtCount(value.elapsedMs || 0)} ms）${undoNote}`)
        }
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const diff = normalizeRowDiff(args)
      if (isDirect) {
        const reason = String(args.reason ?? '').trim()
        if (!reason) throw new Error('db_write_rows 需要一句 reason（给用户看的写入原因）。')
        const title = await connectionTitle(backend, args.connectionId, exec.signal)
        await requestApproval(ctx, exec, {
          toolName: 'db_write_rows',
          zh: `将在${title}的 ${diff.table} 上做结构化行变更：${rowDiffText(diff)}（原因：${clip(reason, 100)}）`,
          en: `Structured row changes on ${diff.table} via ${title}: ${diff.updates.length} updates, ${diff.inserts.length} inserts, ${diff.deletes.length} deletes (reason: ${clip(reason, 100)})`,
        })
        const payload = {
          connectionId: args.connectionId, table: diff.table,
          updates: diff.updates, inserts: diff.inserts, deletes: diff.deletes, reason,
        }
        if (args.database) payload.database = args.database
        const body = await backend.postJson('/api/write-rows', payload, {
          signal: exec.signal,
          timeoutMs: settings.timeout * 1000 + 30_000,
        })
        return {
          mode: 'direct',
          table: diff.table,
          summary: body?.summary ?? { updates: diff.updates.length, inserts: diff.inserts.length, deletes: diff.deletes.length, total: diff.total },
          rendered: Array.isArray(body?.rendered) ? body.rendered : [],
          elapsedMs: Number(body?.elapsedMs) || 0,
          results: normalizeResults(body?.results),
          undo: normalizeEstimatedUndo(body?.undo),
          message: `结构化行写完成（已获批准）：${rowDiffText(diff, diff.table)}。`,
        }
      }
      const background = String(args.background ?? '').trim()
      if (background.length < 4) throw new Error('db_write_rows 需要 background（给人看的变更背景，至少 4 个字符，必填）。')
      const payload = {
        connectionId: args.connectionId,
        background,
        rowsPayload: { table: diff.table, updates: diff.updates, inserts: diff.inserts, deletes: diff.deletes },
      }
      if (args.database) payload.database = args.database
      const title = String(args.title ?? '').trim()
      if (title) payload.title = title
      const body = await backend.postJson('/api/tickets', payload, {
        signal: exec.signal,
        timeoutMs: settings.timeout * 1000 + 30_000,
      })
      const ticket = normalizeTicket(body?.ticket)
      if (!ticket.id) throw new Error('后端没有返回工单 id：请先调用 db_status 检查后端与工单接口状态。')
      return {
        mode: 'ticket',
        ticketId: ticket.id,
        status: ticket.status,
        table: diff.table,
        summary: ticket.rowsPayload?.summary
          ?? { updates: diff.updates.length, inserts: diff.inserts.length, deletes: diff.deletes.length, total: diff.total },
        rendered: Array.isArray(ticket.rowsPayload?.rendered) ? ticket.rowsPayload.rendered : [],
        estimated: ticket.estimated,
        message: `已提交结构化工单 ${ticket.id}（${statusText(ticket.status)}）：${rowDiffText(diff, diff.table)}；等待人工在 Web UI「数据管理 → 工单」里审批（agent 不能批准）。`,
      }
    },
  }
}

/** undo 摘要的最小归一（direct 返回值展示用）。 */
function normalizeEstimatedUndo(input) {
  const source = input && typeof input === 'object' ? input : {}
  return {
    available: source.available === true,
    reason: String(source.reason ?? ''),
    op: String(source.op ?? ''),
    undoId: String(source.undoId ?? ''),
  }
}

// ---------------------------------------------------------------- 注册入口

export function registerTools(ctx, { settings, backend, supervisor }) {
  /** 注册一个工具并挂到 ctx.effect 上，插件卸载时自动摘掉。 */
  function register(definition, label, options) {
    ctx.effect(() => ctx.tools.register(definition, options), label)
  }

  /** 写工具只在 allowWrites=true 时注册：模型工具表里根本看不到它们。 */
  const writesVisible = { when: () => settings.allowWrites }

  // -------------------------------------------------------------- 1. db_status

  register({
    name: 'db_status',
    description:
      'Report the dsh-agent-db-studio plugin state: whether the built-in engine is ready, how many database '
      + 'connections are configured, and whether write tools are enabled. It also reports the business semantic '
      + 'layer status (whether any domain exists / index readiness); the 4 NL2SQL tools are always registered, so '
      + '"no domains yet" means the user has to create one in the panel, not that the tools are off. Call this first '
      + 'when another db_* tool fails.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: output(
      {
        ok: { type: 'boolean' },
        backendReady: { type: 'boolean' },
        backendError: { type: 'string' },
        // V3 进程内引擎标记（local-stack status 带出；DSH 校验 required ⊆ properties，声明不可省）
        inProcess: { type: 'boolean' },
        connections: { type: 'number' },
        allowWrites: { type: 'boolean' },
        maxRows: { type: 'number' },
        timeout: { type: 'number' },
        dataDir: { type: 'string' },
        // 脱敏 AI 字段分析（契约 §4.4）是否可用——与 /api/masking/suggest 用同一套判断。
        aiAvailable: { type: 'boolean' },
        aiProvider: { type: 'string' },
        aiModel: { type: 'string' },
        aiError: { type: 'string' },
        // 业务语义层（契约 §3.9）：后端未就绪/老后端没有该字段时降级 configured:false 全 0。
        semantic: {
          type: 'object',
          properties: {
            configured: { type: 'boolean' },
            indexReady: { type: 'boolean' },
            domains: { type: 'number' },
            assets: { type: 'number' },
          },
          required: ['configured', 'indexReady', 'domains', 'assets'],
        },
        // 工单（契约 §3.6）：ticket 模式下 agent 的写操作只是建单，待审批数必须让模型看见。
        writeMode: { type: 'string' },
        tickets: {
          type: 'object',
          properties: { pending: { type: 'number' } },
          required: ['pending'],
        },
        // 连接级脱敏概况（契约 §3.7）：只汇总，不涉及任何数据值。
        masking: {
          type: 'object',
          properties: {
            enabledConnections: { type: 'number' },
            totalFields: { type: 'number' },
          },
          required: ['enabledConnections', 'totalFields'],
        },
        // 会话写窗口（契约 §3.3c）：写执行的时间总闸，后端未就绪/老后端时 unknown。
        writesWindow: {
          type: 'object',
          properties: {
            open: { type: 'boolean' },
            minutesLeft: { type: 'number' },
            openUntil: { type: 'string' },
            unknown: { type: 'boolean' },
          },
          required: ['open', 'minutesLeft', 'unknown'],
        },
      },
      ['ok', 'backendReady', 'backendError', 'inProcess', 'connections', 'allowWrites', 'maxRows', 'timeout', 'aiAvailable', 'semantic', 'writeMode', 'tickets', 'masking', 'writesWindow'],
      (_args, value) => {
        // 脱敏 AI 行要诚实：provider 被删后用 fallback 状态说明「将自动回退」，不再盲报可用。
        const aiError = clip(value.aiError || '', 220)
        const ai = value.aiAvailable
          ? `脱敏 AI 可用（${value.aiProvider && value.aiModel
            ? `${value.aiProvider}/${value.aiModel}${aiError ? `，${aiError}` : ''}`
            : `自动回退${aiError ? `：${aiError}` : ''}`}）`
          : `脱敏 AI 不可用（${value.aiError || '原因未知'}）`
        // 语义层一行：有没有域、索引是否就绪、规模，照实汇报。
        const semantic = value.semantic.configured
          ? `语义层：已配置 · ${fmtCount(value.semantic.domains)} 个域 · ${value.semantic.indexReady ? '索引就绪' : '索引未就绪（可能正在构建）'}（${fmtCount(value.semantic.assets)} 个资产）`
          : '语义层：还没有业务域（4 个语义工具仍可用；在面板「语义层」页 + 新建或导入文档目录）'
        const tickets = value.writeMode === 'ticket'
          ? `待审批工单 ${value.tickets.pending} 个（在 Web UI「数据管理 → 工单」里由人工审批，agent 不能批准）`
          : `待审批工单 ${value.tickets.pending} 个`
        const masking = `脱敏：${value.masking.enabledConnections} 个连接已开启（共 ${value.masking.totalFields} 个字段）`
        if (!value.backendReady) {
          return textBlock(`db-studio 内置引擎未就绪：${value.backendError || '原因未知'}\n${semantic}\n${ai}`)
        }
        const writes = value.allowWrites
          ? (value.writeMode === 'ticket' ? '写操作已开启（提交工单，人工审批后执行）' : '写操作已开启（审批弹窗后立即执行）')
          : '只读模式（写工具未注册）'
        const window = value.writesWindow.unknown
          ? '写窗口：未知（老后端）'
          : (value.writesWindow.open
            ? `写窗口：开启中（剩余约 ${fmtCount(value.writesWindow.minutesLeft)} 分钟${value.writesWindow.openUntil ? `，到 ${value.writesWindow.openUntil} 自动关` : ''}）`
            : '写窗口：已关闭（写执行会被 403 WRITES_CLOSED 拦截；请让用户在面板「临时开闸」）')
        return textBlock(
          `db-studio 内置引擎已就绪（V3 进程内实现） · ${value.connections} 个连接`
          + ` · ${writes}\n${window}\n${tickets}\n${masking}\n${semantic}\n${ai}`,
        )
      },
    ),
    async execute() {
      let status = supervisor.status()
      if (!status.ready) {
        try {
          await supervisor.ensureReady()
        } catch {
          // 失败原因留在 status.error 里，照实汇报即可
        }
        status = supervisor.status()
      }
      let connections = 0
      let tickets = { pending: 0 }
      let masking = { enabledConnections: 0, totalFields: 0 }
      // 语义层状态默认「还没有域、全 0」：后端未就绪/老后端没有 /health.semantic 时照此降级。
      // 第 51 轮起直接信后端的 configured（= 至少有一个业务域），不再叠加插件侧 semanticLayerPath 门禁。
      let semantic = { configured: false, indexReady: false, domains: 0, assets: 0 }
      let writesWindow = { open: false, minutesLeft: 0, openUntil: '', unknown: true }
      if (status.ready) {
        const health = await backend.fetchHealth()
        connections = Number(health?.connections) || 0
        const healthSemantic = health?.semantic && typeof health.semantic === 'object' ? health.semantic : null
        if (healthSemantic) {
          semantic = {
            configured: healthSemantic.configured === true,
            indexReady: healthSemantic.indexReady === true,
            domains: Number(healthSemantic.domains) || 0,
            assets: Number(healthSemantic.assets) || 0,
          }
        }
        // 待审批工单数：工单接口失败就降级 0，不能因为这一项把 db_status 搞挂。
        try {
          const body = await backend.getJson('/api/tickets', { status: 'pending', limit: 1 })
          tickets = { pending: normalizeCounts(body?.counts).pending }
        } catch {
          tickets = { pending: 0 }
        }
        // 脱敏概况：老后端没有 masking 字段时同样降级 0。
        try {
          const body = await backend.getJson('/api/connections', {})
          masking = summarizeMasking(body?.connections)
        } catch {
          masking = { enabledConnections: 0, totalFields: 0 }
        }
        // 会话写窗口（§3.3c）：老后端没有该路由时降级 unknown，不把 db_status 搞挂。
        try {
          const body = await backend.getJson('/api/writes/window', {})
          const win = body?.window && typeof body.window === 'object' ? body.window : null
          writesWindow = win
            ? { open: win.open === true, minutesLeft: Number(win.minutesLeft) || 0,
                openUntil: String(win.openUntil ?? ''), unknown: false }
            : { open: false, minutesLeft: 0, openUntil: '', unknown: true }
        } catch {
          writesWindow = { open: false, minutesLeft: 0, openUntil: '', unknown: true }
        }
      }
      // 和 /api/masking/suggest 用同一个判断函数，避免两处口径不一致。
      const ai = resolveModelInfo(ctx)
      return {
        ok: status.ready,
        backendReady: status.ready,
        backendError: status.error ?? '',
        // V3 内置引擎标记：db_status 渲染据此显示「内置引擎」
        inProcess: status.inProcess === true,
        connections,
        allowWrites: settings.allowWrites,
        maxRows: settings.maxRows,
        timeout: settings.timeout,
        dataDir: settings.dataDir,
        writeMode: settings.writeMode,
        tickets,
        writesWindow,
        masking,
        semantic,
        aiAvailable: ai.available === true,
        aiProvider: ai.provider ?? '',
        aiModel: ai.model ?? '',
        aiError: ai.error ?? '',
      }
    },
  }, 'dsh-agent-db-studio: db_status tool')

  // -------------------------------------------------------------- 2. db_list_connections

  register({
    name: 'db_list_connections',
    description:
      'List the database connections configured in the db-studio panel (MySQL and Redis), without passwords. '
      + 'Returns id, name, kind, host/port/database, readonly flags and whether connection-level masking is enabled '
      + '(maskingEnabled/maskingFields: masked data rows come back already masked from the backend). Use the returned '
      + 'id as `connectionId` for every other db_* tool.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: output(
      {
        count: { type: 'number' },
        connections: { type: 'array', items: { type: 'object' } },
      },
      ['count', 'connections'],
      (_args, value) => {
        const rows = Array.isArray(value.connections) ? value.connections : []
        if (!rows.length) {
          return textBlock('还没有配置数据库连接：在 Web UI 的「数据管理」面板里添加一条连接后重试。')
        }
        const lines = [`${value.count} 个连接：`]
        for (const row of rows.slice(0, 15)) {
          const kind = row.kind === 'redis' ? 'Redis' : 'MySQL'
          const address = row.host
            ? ` ${row.host}${row.port ? `:${row.port}` : ''}${row.database ? `/${row.database}` : ''}`
            : ''
          const flags = [row.readonly ? '只读' : '可写', row.hasPassword === false ? '无密码' : ''].filter(Boolean).join('，')
          const maskingMark = row.maskingEnabled ? ' · 脱敏' : ''
          lines.push(`· ${row.name || row.id} — ${kind}${address}（${flags}）${maskingMark} id=${row.id}`)
        }
        if (rows.length > 15) lines.push(`…共 ${rows.length} 个，其余见 JSON`)
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(_args, exec) {
      const body = await backend.getJson('/api/connections', {}, { signal: exec.signal })
      const rows = Array.isArray(body.connections) ? body.connections : []
      // 只把脱敏的两个汇总值给模型；masking.fields 明细是面板/安全侧的配置，不往工具输出里倒。
      const connections = rows.map(row => {
        const masking = normalizeMasking(row)
        const rest = { ...row }
        delete rest.masking
        return { ...rest, maskingEnabled: masking.enabled, maskingFields: masking.fields }
      })
      return { count: connections.length, connections }
    },
  }, 'dsh-agent-db-studio: db_list_connections tool')

  // -------------------------------------------------------------- 3. db_list_databases

  register({
    name: 'db_list_databases',
    description:
      'List databases on one connection: MySQL schemas, or Redis logical databases (db index plus key count). '
      + 'Use the returned names as `database` in later tools.',
    parameters: {
      type: 'object',
      properties: { connectionId: CONNECTION_ID },
      required: ['connectionId'],
      additionalProperties: false,
    },
    output: output(
      {
        connectionId: { type: 'string' },
        count: { type: 'number' },
        databases: { type: 'array', items: { type: 'object' } },
      },
      ['connectionId', 'count', 'databases'],
      (_args, value) => {
        const rows = Array.isArray(value.databases) ? value.databases : []
        if (!rows.length) return textBlock(`连接 ${value.connectionId} 上没有可见的数据库。`)
        return textBlock(`连接 ${value.connectionId} 有 ${value.count} 个数据库：${joinNames(rows, 20)}`)
      },
    ),
    async execute(args, exec) {
      const body = await backend.getJson('/api/meta/databases', { connectionId: args.connectionId }, { signal: exec.signal })
      const databases = Array.isArray(body.databases) ? body.databases : []
      return { connectionId: args.connectionId, count: databases.length, databases }
    },
  }, 'dsh-agent-db-studio: db_list_databases tool')

  // -------------------------------------------------------------- 4. db_list_tables

  register({
    name: 'db_list_tables',
    description:
      'List tables and views in one MySQL database. Returns name, type ("table"/"view"), estimated row count, '
      + 'size and comment; exact counts are not computed here.',
    parameters: {
      type: 'object',
      properties: { connectionId: CONNECTION_ID, database: DATABASE },
      required: ['connectionId', 'database'],
      additionalProperties: false,
    },
    output: output(
      {
        connectionId: { type: 'string' },
        database: { type: 'string' },
        count: { type: 'number' },
        tables: { type: 'array', items: { type: 'object' } },
      },
      ['connectionId', 'database', 'count', 'tables'],
      (_args, value) => {
        const rows = Array.isArray(value.tables) ? value.tables : []
        if (!rows.length) return textBlock(`库 ${value.database} 里没有表或视图。`)
        const views = rows.filter(row => row.type === 'view').length
        const breakDown = views ? `${rows.length - views} 张表 / ${views} 个视图` : `${rows.length} 张表`
        return textBlock(`库 ${value.database} 有 ${breakDown}：${joinNames(rows, 20)}`)
      },
    ),
    async execute(args, exec) {
      const body = await backend.getJson(
        '/api/meta/tables',
        { connectionId: args.connectionId, database: args.database },
        { signal: exec.signal },
      )
      const tables = Array.isArray(body.tables) ? body.tables : []
      return { connectionId: args.connectionId, database: args.database, count: tables.length, tables }
    },
  }, 'dsh-agent-db-studio: db_list_tables tool')

  // -------------------------------------------------------------- 5. db_describe_table

  register({
    name: 'db_describe_table',
    description:
      'Describe one MySQL table or view: columns (type, nullability, key, default, comment), indexes, row count '
      + 'and DDL. exactCount=true runs COUNT(*) and can be slow on big tables; otherwise the table-statistics '
      + 'estimate is used.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        table: { type: 'string', description: 'Table or view name.' },
        exactCount: { type: 'boolean', description: 'Also run COUNT(*) for an exact row count (slower). Default false.' },
      },
      required: ['connectionId', 'database', 'table'],
      additionalProperties: false,
    },
    output: output(
      {
        connectionId: { type: 'string' },
        database: { type: 'string' },
        table: { type: 'string' },
        columns: { type: 'array', items: { type: 'object' } },
        indexes: { type: 'array', items: { type: 'object' } },
        ddl: { type: 'string' },
        estimatedRows: { type: 'number' },
        exactRows: { type: 'number' },
      },
      ['connectionId', 'database', 'table', 'columns', 'indexes'],
      (_args, value) => {
        const columns = Array.isArray(value.columns) ? value.columns : []
        const indexes = Array.isArray(value.indexes) ? value.indexes : []
        const primary = columns.filter(column => column?.key === 'PRI').map(column => column.name)
        const rowText = value.exactRows !== undefined
          ? `${fmtCount(value.exactRows)} 行（精确）`
          : value.estimatedRows !== undefined
            ? `约 ${fmtCount(value.estimatedRows)} 行`
            : ''
        const lines = [`表 ${value.database}.${value.table}：${columns.length} 列${rowText ? ` · ${rowText}` : ''}`]
        if (primary.length) lines.push(`主键：${primary.join('、')}`)
        if (columns.length) {
          const shown = columns.slice(0, 12).map(column => {
            const flags = [column?.key === 'PRI' ? 'PK' : column?.key === 'UNI' ? 'UNI' : '', column?.nullable === false ? 'NOT NULL' : '', column?.extra ?? ''].filter(Boolean)
            return `${column?.name} ${column?.type ?? ''}${flags.length ? ` ${flags.join(' ')}` : ''}`
          })
          lines.push(`列：${shown.join('、')}${columns.length > 12 ? ` 等 ${columns.length} 列` : ''}`)
        }
        if (indexes.length) {
          const shown = indexes.slice(0, 8).map(index => `${index?.name}(${(index?.columns ?? []).join(',')}${index?.unique ? '，唯一' : ''})`)
          lines.push(`索引：${shown.join('、')}`)
        }
        if (value.ddl) lines.push(`DDL 见 JSON（${value.ddl.length} 字符）`)
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const query = { connectionId: args.connectionId, database: args.database, table: args.table }
      if (args.exactCount === true) query.exactCount = 'true'
      const body = await backend.getJson('/api/meta/table', query, { signal: exec.signal })
      const value = {
        connectionId: args.connectionId,
        database: args.database,
        table: args.table,
        columns: Array.isArray(body.columns) ? body.columns : [],
        indexes: Array.isArray(body.indexes) ? body.indexes : [],
      }
      if (typeof body.ddl === 'string' && body.ddl) value.ddl = body.ddl
      if (body.estimatedRows !== undefined && body.estimatedRows !== null && Number.isFinite(Number(body.estimatedRows))) {
        value.estimatedRows = Number(body.estimatedRows)
      }
      if (body.exactRows !== undefined && body.exactRows !== null && Number.isFinite(Number(body.exactRows))) {
        value.exactRows = Number(body.exactRows)
      }
      return value
    },
  }, 'dsh-agent-db-studio: db_describe_table tool')

  // -------------------------------------------------------------- 6. db_query

  register({
    name: 'db_query',
    description:
      'Run read-only SQL on a connection. Every connection (writable or not) accepts only '
      + 'SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/USE/SET — this tool can never modify data; use db_execute for writes. '
      + 'Multiple statements run in order and stop at the first failure; earlier results are still returned and the '
      + 'last result carries the error (an HTTP 200 can still contain statement errors). Each statement returns at '
      + 'most maxRows rows (plugin default in db_status); truncated=true means the result is partial. '
      + 'If the connection has masking enabled, returned data rows are already masked by the backend (e.g. 138****5678) '
      + '— that is by design; never try to reconstruct or infer the original values. '
      + 'For agent calls every SELECT passes an EXPLAIN plan check before execution: a full table scan '
      + '(type=ALL) on a big table (approx rows >= tier threshold, default 500k) or a huge estimated row count '
      + '(> DBS_SLOW_SQL_MAX_SCAN_ROWS) is refused (SLOW_SQL_RISK, plan attached) — full scans on small tables '
      + 'pass; narrow the filters/time window, use indexed columns, or add LIMIT, then retry.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        sql: { type: 'string', description: 'One or more SQL statements, separated by ";".' },
        maxRows: { type: 'integer', description: 'Per-statement row cap for this call, 1-100000. Defaults to the plugin maxRows.' },
        purpose: {
          type: 'string',
          description: 'One-sentence summary of which business question this query answers (in Chinese). '
            + 'Stored with the execution history so panel users can see which queries belong together.',
        },
      },
      required: ['connectionId', 'sql'],
      additionalProperties: false,
    },
    output: output(
      {
        connectionId: { type: 'string' },
        database: { type: 'string' },
        elapsedMs: { type: 'number' },
        results: { type: 'array', items: { type: 'object' } },
      },
      ['connectionId', 'database', 'elapsedMs', 'results'],
      (args, value) => renderResults(args, value, { verb: '查询完成' }),
    ),
    async execute(args, exec) {
      const payload = { connectionId: args.connectionId, sql: args.sql }
      if (args.database) payload.database = args.database
      if (args.maxRows) payload.maxRows = args.maxRows
      if (args.purpose) payload.purpose = String(args.purpose).slice(0, 200)
      const body = await backend.postJson('/api/query', payload, {
        signal: exec.signal,
        timeoutMs: settings.timeout * 1000 + 10_000,
      })
      return {
        connectionId: args.connectionId,
        database: args.database ?? '',
        elapsedMs: Number(body.elapsedMs) || 0,
        results: normalizeResults(body.results),
      }
    },
  }, 'dsh-agent-db-studio: db_query tool')

  // -------------------------------------------------------------- 7. db_execute
  //
  // 两条策略（契约 §4.2）：ticket（默认）只提交工单、不调 ctx.approval；direct 退回 v1 的
  // 「审批弹窗 + 立即执行」。工具名和可见性开关不变，模型只看到当前策略对应的参数。

  register(
    settings.writeMode === 'direct'
      ? buildDirectExecuteDefinition(ctx, { settings, backend })
      : buildTicketExecuteDefinition({ settings, backend }),
    'dsh-agent-db-studio: db_execute tool',
    writesVisible,
  )

  // -------------------------------------------------------------- 7b. db_undo_last
  // 撤销最近一次可撤销写（V2.2）：direct 审批后执行；ticket 只报告并引导面板人工撤销。

  register(
    buildUndoLastDefinition(ctx, { settings, backend }),
    'dsh-agent-db-studio: db_undo_last tool',
    writesVisible,
  )

  // -------------------------------------------------------------- 7c. db_write_rows
  // 结构化行写（V2.3）：小而精确的行变更优先于拼 SQL；direct 直执行 / ticket 建结构化工单。

  register(
    buildWriteRowsDefinition(ctx, { settings, backend }),
    'dsh-agent-db-studio: db_write_rows tool',
    writesVisible,
  )

  // -------------------------------------------------------------- 8. db_list_tickets
  // 工单是「AI 提交、人审批」：这里只有查询能力，批准入口只在浏览器面板。

  register({
    name: 'db_list_tickets',
    description:
      'List change tickets (write requests submitted by db_execute) together with per-status counts, newest first. '
      + 'Tickets are executed only after a human approves them in the db-studio panel; you can list and inspect them '
      + 'but never approve them. Use this to tell the user which tickets are still pending. '
      + 'Paginated: offset + limit per page, the result reports total — page through older tickets by increasing offset.',
    parameters: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['pending', 'approved', 'executing', 'succeeded', 'failed', 'rejected', 'cancelled', 'undone'],
          description: 'Only return tickets in this status. Omit for all statuses.',
        },
        limit: { type: 'integer', description: 'Page size, 1-200. Default 20.' },
        offset: {
          type: 'integer',
          description: 'Pagination offset: how many tickets to skip (newest first). Default 0. '
            + 'Next page = offset + the number of tickets just returned.',
        },
      },
      additionalProperties: false,
    },
    output: output(
      {
        count: { type: 'number' },
        total: { type: 'number' },
        limit: { type: 'number' },
        offset: { type: 'number' },
        counts: { type: 'object' },
        tickets: { type: 'array', items: { type: 'object' } },
      },
      ['count', 'total', 'limit', 'offset', 'counts', 'tickets'],
      (_args, value) => {
        const counts = value.counts
        const range = value.count > 0
          ? `本页第 ${value.offset + 1}-${value.offset + value.count} 个`
          : '本页无工单（offset 超出总数）'
        const lines = [
          `待审批 ${fmtCount(counts.pending)} 个 · 共 ${value.total} 个工单，${range}（每页 ${value.limit}）`
          + `（pending ${counts.pending} / succeeded ${counts.succeeded} / failed ${counts.failed} / rejected ${counts.rejected} / cancelled ${counts.cancelled} / undone ${counts.undone}）`,
        ]
        if (!value.tickets.length) lines.push('没有符合条件的工单。')
        if (value.offset + value.count < value.total) {
          lines.push(`还有更早的工单未列出，用 offset=${value.offset + value.count} 翻下一页。`)
        }
        for (const ticket of value.tickets.slice(0, 8)) lines.push(`· ${ticketHeadline(ticket)} · ${ticket.createdAt || ''}`)
        if (value.tickets.length > 8) lines.push(`…其余 ${value.tickets.length - 8} 个见 JSON`)
        lines.push('审批只能在 Web UI「数据管理 → 工单」里由人工完成，agent 不能批准。')
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const query = {}
      if (args.status) query.status = args.status
      query.limit = args.limit ?? 20
      query.offset = args.offset ?? 0
      const body = await backend.getJson('/api/tickets', query, { signal: exec.signal })
      const tickets = Array.isArray(body?.tickets) ? body.tickets.map(normalizeTicket) : []
      return {
        count: tickets.length,
        total: Number(body?.total ?? tickets.length),
        limit: Number(body?.limit ?? query.limit),
        offset: Number(body?.offset ?? query.offset),
        counts: normalizeCounts(body?.counts),
        tickets,
      }
    },
  }, 'dsh-agent-db-studio: db_list_tickets tool')

  // -------------------------------------------------------------- 9. db_get_ticket

  register({
    name: 'db_get_ticket',
    description:
      'Read one change ticket: status, SQL, background, estimated impact, approval info, actual execution result and '
      + 'error (if any). You can inspect tickets but never approve them — approval is a human action in the db-studio '
      + 'panel only. If the ticket connection has masking enabled, result rows in actual.results are already masked by '
      + 'the backend (e.g. 138****5678) — that is by design; never try to reconstruct or infer the original values.',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Ticket id, e.g. "tk_7f3a91c2".' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    output: output(
      {
        ticket: { type: 'object' },
      },
      ['ticket'],
      (_args, value) => {
        const ticket = value.ticket
        const lines = [`工单 ${ticket.id}：${statusText(ticket.status)}（${ticket.status}）`]
        if (ticket.title) lines.push(`标题：${ticket.title}`)
        const target = [ticket.connectionName || ticket.connectionId, ticket.database].filter(Boolean).join(' / ')
        lines.push(`连接：${target || '—'}${ticket.submittedBy ? ` · 提交人：${ticket.submittedBy}` : ''}${ticket.createdAt ? ` · ${ticket.createdAt}` : ''}`)
        if (ticket.background) lines.push(`背景：${clip(ticket.background, 200)}`)
        lines.push(`SQL：${clip(ticket.sql, 300)}`)
        const estimated = ticket.estimated
        const multi = estimated.statementCount > 1
        lines.push(`预估：${estimatedText(estimated)}`)
        if (multi) lines.push(`执行方式：${MULTI_STATEMENT_NOTE}`)
        if (estimated.notes.length) lines.push(`预估提示：${estimated.notes.slice(0, 3).join('；')}`)
        if (multi) {
          // 合计在上面，这里给逐条明细（含每条 SQL 预览）。
          lines.push(...statementLines(estimated, { sqlWidth: 120 }))
        } else if (estimated.statements.length) {
          const statements = estimated.statements.slice(0, 5).map(row => `${row.kind || '?'} ${row.table || ''}${row.hasWhere ? '（有 WHERE）' : '（无 WHERE）'}`)
          lines.push(`语句：${statements.join('、')}`)
        }
        if (ticket.actual) {
          lines.push(`实际影响：${ticket.actual.affectedRows === null ? '未知' : `${fmtCount(ticket.actual.affectedRows)} 行`} · ${fmtMs(ticket.actual.elapsedMs)}${ticket.executedAt ? ` · ${ticket.executedAt}` : ''}`)
          const resultCount = Array.isArray(ticket.actual.results) ? ticket.actual.results.length : 0
          if (resultCount > 1) lines.push(`执行结果：共 ${resultCount} 条语句，逐条结果见 JSON。`)
        } else if (ticket.status === 'pending' || ticket.status === 'approved' || ticket.status === 'executing') {
          lines.push('实际影响：尚未执行')
        }
        if (ticket.approvedAt || ticket.approvedBy || ticket.approvalComment) {
          lines.push(`审批：${[ticket.approvedBy, ticket.approvedAt, ticket.approvalComment].filter(Boolean).join(' · ')}`)
        }
        if (ticket.error) lines.push(`⚠ 错误：${clip(ticket.error, 240)}`)
        lines.push('审批只能在 Web UI「数据管理 → 工单」里由人工完成，agent 不能批准。')
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const id = String(args.id ?? '').trim()
      if (!id) throw new Error('db_get_ticket 需要工单 id。')
      try {
        const body = await backend.getJson('/api/tickets/detail', { id }, { signal: exec.signal })
        return { ticket: normalizeTicket(body?.ticket) }
      } catch (error) {
        throw new Error(`读取工单 ${id} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }, 'dsh-agent-db-studio: db_get_ticket tool')

  // -------------------------------------------------------------- 9.5 db_export_query（第 45 轮）

  register({
    name: 'db_export_query',
    description:
      'Submit a data-export ticket: you write ONE SELECT statement into the ticket, a human approves it in the '
      + 'db-studio panel, then the backend re-runs the query fetching rows in batches (DBS_EXPORT_BATCH_SIZE, '
      + 'default 500 rows/batch) and streams them into a data file; the user downloads it from the ticket detail '
      + '(download menu: xlsx / JSON / INSERT). This is the ONLY export path — all exports go through tickets. '
      + 'Export is read-only: it also works on readonly connections and does not need the writes window. '
      + 'Rules: exactly ONE SELECT (no ";"-separated statements; no INTO OUTFILE/DUMPFILE); results over '
      + 'DBS_EXPORT_MAX_ROWS (default 10000) are REJECTED — the ticket fails and nothing is exported; narrow the '
      + 'query first. If the connection has masking enabled, '
      + 'the exported file contains masked values (by design). After submitting, tell the user to approve the ticket '
      + 'in the panel and click "download" on the ticket detail — you cannot approve tickets yourself.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        sql: {
          type: 'string',
          description: 'Exactly ONE SELECT statement. No other statements, no INTO OUTFILE/DUMPFILE.',
        },
        title: { type: 'string', description: 'Short ticket title (optional; defaults from the SQL).' },
        background: {
          type: 'string',
          description: 'Why this export is needed (at least 4 chars), shown to the approver.',
        },
      },
      required: ['connectionId', 'sql', 'background'],
      additionalProperties: false,
    },
    output: output(
      {
        ticketId: { type: 'string' },
        status: { type: 'string' },
        title: { type: 'string' },
      },
      ['ticketId', 'status', 'title'],
      (_args, value) => textBlock(
        `导出工单已提交：${value.ticketId}（${value.title}）· 状态 ${value.status}\n`
        + '等人在「数据管理 → 工单」批准后，程序分批取数导出（上限 1 万行，每批 500 行）；'
        + '批准后在该工单详情点「下载」选 xlsx / JSON / INSERT。agent 不能批准工单。'),
    ),
    async execute(args, exec) {
      const payload = {
        connectionId: args.connectionId,
        sql: args.sql,
        background: args.background,
        export: true,
      }
      if (args.database) payload.database = args.database
      if (args.title) payload.title = args.title
      const body = await backend.postJson('/api/tickets', payload, { signal: exec.signal })
      const ticket = body && body.ticket ? body.ticket : {}
      return {
        ticketId: String(ticket.id || ''),
        status: String(ticket.status || 'pending'),
        title: String(ticket.title || ''),
      }
    },
  }, 'dsh-agent-db-studio: db_export_query tool')

  // -------------------------------------------------------------- 10. db_list_history

  register({
    name: 'db_list_history',
    description:
      'List recent SQL execution history (read queries, direct writes and ticket executions), newest first. Each '
      + 'item has connection, sql, status, timing, source ("panel" | "agent" | "ticket") and row/affected counts; use '
      + 'it to review what has been run and whether it failed.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'integer', description: 'Max history items to return, 1-500. Default 50.' },
        connectionId: { type: 'string', description: 'Only return history for this connection id.' },
        keyword: { type: 'string', description: 'Case-insensitive substring match on the SQL text.' },
      },
      additionalProperties: false,
    },
    output: output(
      {
        count: { type: 'number' },
        history: { type: 'array', items: { type: 'object' } },
      },
      ['count', 'history'],
      (_args, value) => {
        const rows = value.history
        const lines = [`最近 ${value.count} 条执行历史${value.count ? '：' : ''}`]
        if (!rows.length) lines.push('（没有符合条件的记录）')
        for (const row of rows.slice(0, 8)) {
          const status = row.status === 'ok' ? '成功' : '失败'
          // kind=execute 也可能是工单里批准的 SELECT：affectedRows 为空时退回 rowCount。
          const hasAffected = row.affectedRows !== null && row.affectedRows !== undefined && Number.isFinite(Number(row.affectedRows))
          const hasRows = row.rowCount !== null && row.rowCount !== undefined && Number.isFinite(Number(row.rowCount))
          const rowsText = row.kind === 'query'
            ? `${fmtCount(row.rowCount ?? 0)} 行`
            : hasAffected
              ? `影响 ${fmtCount(row.affectedRows)} 行`
              : hasRows ? `返回 ${fmtCount(row.rowCount)} 行` : '影响行数未知'
          const parts = [
            row.time || '',
            `[${row.source ?? 'panel'}/${row.kind ?? 'query'}]`,
            row.ticketId
              ? `工单 ${row.ticketId}（${row.ticketBy === 'user' ? '人工提交' : 'Agent 提交'}）`
              : '',
            row.connectionName || row.connectionId || '',
            status,
            rowsText,
            `${fmtMs(row.elapsedMs)}`,
            clip(row.sql ?? '', 70),
          ].filter(Boolean)
          lines.push(`· ${parts.join(' · ')}${row.error ? ` · 错误：${clip(row.error, 80)}` : ''}`)
        }
        if (rows.length > 8) lines.push(`…其余 ${rows.length - 8} 条见 JSON`)
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const query = {}
      query.limit = args.limit ?? 50
      if (args.connectionId) query.connectionId = args.connectionId
      if (args.keyword) query.keyword = args.keyword
      const body = await backend.getJson('/api/history', query, { signal: exec.signal })
      const history = Array.isArray(body?.history) ? body.history : []
      return { count: history.length, history }
    },
  }, 'dsh-agent-db-studio: db_list_history tool')

  // -------------------------------------------------------------- 11. db_redis_scan

  register({
    name: 'db_redis_scan',
    description:
      'Scan keys on a Redis connection page by page (SCAN under the hood; KEYS is disabled). Start without '
      + 'cursor, then pass the returned cursor until it is "0". Each page returns keys with type and TTL.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        match: { type: 'string', description: 'Glob pattern, e.g. "user:*". Default "*".' },
        cursor: { type: 'string', description: 'Cursor from the previous page. Omit for the first page.' },
        count: { type: 'integer', description: 'Hint for how many keys to return per page (Redis COUNT).' },
      },
      required: ['connectionId'],
      additionalProperties: false,
    },
    output: output(
      {
        connectionId: { type: 'string' },
        database: { type: 'string' },
        cursor: { type: 'string' },
        count: { type: 'number' },
        keys: { type: 'array', items: { type: 'object' } },
      },
      ['connectionId', 'database', 'cursor', 'count', 'keys'],
      (args, value) => {
        const keys = Array.isArray(value.keys) ? value.keys : []
        const done = String(value.cursor) === '0'
        const head = `扫描到 ${value.count} 个键${done ? '（已扫完）' : `（游标 ${value.cursor}，还有更多）`}`
        if (!keys.length) return textBlock(`${head}：没有匹配 ${args.match ?? '*'} 的键。`)
        const shown = keys.slice(0, 10).map(row => `${row?.key}（${row?.type ?? '?'}，${fmtTtl(row?.ttl)}）`)
        return textBlock(`${head}：${shown.join('、')}${keys.length > 10 ? ` 等 ${keys.length} 个` : ''}`)
      },
    ),
    async execute(args, exec) {
      const payload = { connectionId: args.connectionId }
      if (args.database) payload.database = args.database
      if (args.match) payload.match = args.match
      if (args.cursor) payload.cursor = String(args.cursor)
      if (args.count) payload.count = args.count
      const body = await backend.postJson('/api/redis/scan', payload, { signal: exec.signal })
      const keys = Array.isArray(body.keys) ? body.keys : []
      return {
        connectionId: args.connectionId,
        database: args.database ?? '',
        cursor: String(body.cursor ?? '0'),
        count: keys.length,
        keys,
      }
    },
  }, 'dsh-agent-db-studio: db_redis_scan tool')

  // -------------------------------------------------------------- 12. db_redis_key

  register({
    name: 'db_redis_key',
    description:
      'Read one Redis key: type, TTL, memory size and a structured value (hashes as field/value pairs, '
      + 'lists/sets/zsets as arrays, streams as the first 100 entries). Large values are truncated.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        key: { type: 'string', description: 'Redis key name.' },
      },
      required: ['connectionId', 'key'],
      additionalProperties: false,
    },
    output: output(
      {
        connectionId: { type: 'string' },
        database: { type: 'string' },
        key: { type: 'string' },
        type: { type: 'string' },
        ttl: { type: 'number' },
        memoryBytes: { type: 'number' },
        truncated: { type: 'boolean' },
        value: {},
      },
      ['connectionId', 'database', 'key', 'type', 'ttl', 'value'],
      (args, value) => {
        const meta = [`${value.type}`, fmtTtl(value.ttl)]
        if (value.memoryBytes !== undefined) meta.push(`${fmtCount(value.memoryBytes)} 字节`)
        const head = `${value.key}（${meta.join('，')}）`
        const suffix = value.truncated ? '（值已截断，完整内容见 JSON 或缩小范围）' : ''
        return textBlock(`${head}：${previewValue(value.value)}${suffix}`)
      },
    ),
    async execute(args, exec) {
      const payload = { connectionId: args.connectionId, key: args.key }
      if (args.database) payload.database = args.database
      const body = await backend.postJson('/api/redis/key', payload, { signal: exec.signal })
      const value = {
        connectionId: args.connectionId,
        database: args.database ?? '',
        key: String(body.key ?? args.key),
        type: String(body.type ?? 'unknown'),
        ttl: Number.isFinite(Number(body.ttl)) ? Number(body.ttl) : -1,
        value: body.value ?? null,
      }
      if (body.memoryBytes !== undefined && body.memoryBytes !== null && Number.isFinite(Number(body.memoryBytes))) {
        value.memoryBytes = Number(body.memoryBytes)
      }
      if (body.truncated === true) value.truncated = true
      return value
    },
  }, 'dsh-agent-db-studio: db_redis_key tool')

  // -------------------------------------------------------------- 13. db_redis_command

  register({
    name: 'db_redis_command',
    description:
      'Run one raw Redis command. Read-only commands run directly; everything else — including DEL/UNLINK/'
      + 'FLUSHDB/FLUSHALL and unknown commands — requires one-time user approval, and on writable connections that '
      + 'approval is the only guard. KEYS and SELECT are disabled: use db_redis_scan and the database parameter '
      + 'instead. Prefer db_redis_key/db_redis_scan for browsing.',
    parameters: {
      type: 'object',
      properties: {
        connectionId: CONNECTION_ID,
        database: DATABASE,
        command: { type: 'string', description: 'Full Redis command line, e.g. "GET user:1" or "HGETALL user:1".' },
      },
      required: ['connectionId', 'command'],
      additionalProperties: false,
    },
    output: output(
      {
        connectionId: { type: 'string' },
        database: { type: 'string' },
        command: { type: 'string' },
        kind: { type: 'string' },
        reply: {},
      },
      ['connectionId', 'database', 'command', 'kind', 'reply'],
      (_args, value) => textBlock(`${value.command} → ${previewValue(value.reply)}（${value.kind}）`),
    ),
    async execute(args, exec) {
      const command = String(args.command ?? '').trim()
      if (!command) throw new Error('command 不能为空，例如 "GET user:1"。')
      const name = redisCommandName(command)
      const forbidden = REDIS_FORBIDDEN[name]
      if (forbidden) throw new Error(forbidden)
      if (!REDIS_READONLY.has(name)) {
        if (!exec.agent) throw new Error('写命令只能由模型会话发起：当前调用没有 agent，已拒绝。')
        // 先确认后端可用、拿到连接名，再打扰用户审批。
        const title = await connectionTitle(backend, args.connectionId, exec.signal)
        await requestApproval(ctx, exec, {
          toolName: 'db_redis_command',
          zh: `将在${title}执行 Redis 命令：${clip(command, 160)}`,
          en: `Run Redis command on ${title}: ${clip(command, 160)}`,
        })
      }
      const payload = { connectionId: args.connectionId, command }
      if (args.database) payload.database = args.database
      const body = await backend.postJson('/api/redis/command', payload, { signal: exec.signal })
      return {
        connectionId: args.connectionId,
        database: args.database ?? '',
        command,
        kind: String(body.kind ?? 'unknown'),
        reply: body.reply ?? null,
      }
    },
  }, 'dsh-agent-db-studio: db_redis_command tool', writesVisible)
}
