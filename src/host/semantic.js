/**
 * 业务语义层（NL2SQL）的 4 个只读 agent 工具（契约 §3.9 / 计划 §6 C2）。
 *
 * 第 51 轮起**恒定注册**（不再看 settings.semanticLayerPath）：域由人在面板里新建或从文档目录导入，
 * 「还没有业务域」是后端 configured=false 的正常状态，不是工具不存在。所有工具：
 *   - 只读：仅 GET /api/semantic/*，不碰任何写接口、不需要审批；
 *   - 超时 15s（语义检索是本地 LIKE 扫描，正常 <1s；15s 是防御上限）；
 *   - output.render 输出中文摘要，完整 JSON 按框架的 output.schema 落盘。
 */
import { clip, fmtCount } from './render.js'

/** 语义层工具统一的请求超时（毫秒）。 */
const SEMANTIC_TIMEOUT_MS = 15_000

function textBlock(text) {
  return [{ type: 'text', text }]
}

function output(properties, required, render) {
  return { schema: { type: 'object', properties, required }, render }
}

/** 后端可能给 role='owner' / 'consumer'，也可能给中文标签；统一成 owner / consumer。 */
function normalizeRole(value) {
  const text = String(value ?? '').trim().toLowerCase()
  if (text === 'owner' || text === '主属' || text === '主属卡') return 'owner'
  if (text === 'consumer' || text === '使用方' || text === '使用方视角') return 'consumer'
  return ''
}

/** domains 响应归一：老后端/还没有域时降级为全 0，不让 schema 对不上。 */
function normalizeDomainsBody(body) {
  const index = body?.index && typeof body.index === 'object' ? body.index : {}
  const domains = Array.isArray(body?.domains) ? body.domains : []
  return {
    // configured 只表示「至少有一个业务域」（第 51 轮口径）；后端没给就按 domains 推。
    configured: typeof body?.configured === 'boolean' ? body.configured : domains.length > 0,
    indexReady: index.ready === true,
    // 第 52 轮：顶部目录是「DB 写出路径」（语义内容从 DB 重建后写到这里）；
    // 没配时无法重建成本地文件，但编辑与检索照常可用。
    exportDir: String(body?.exportDir ?? ''),
    canRebuildFiles: body?.canRebuildFiles === true,
    domains: domains.map(row => ({
      domain: String(row?.domain ?? ''),
      title: String(row?.title ?? ''),
      // origin：doc = 从文档目录导入 / system = 面板新建（系统域）。
      origin: String(row?.origin ?? ''),
      exportDir: String(row?.exportDir ?? ''),
      files: Number.isFinite(Number(row?.files)) ? Number(row.files) : 0,
      tables: Number.isFinite(Number(row?.tables)) ? Number(row.tables) : 0,
      samples: Number.isFinite(Number(row?.samples)) ? Number(row.samples) : 0,
    })),
    usageOrder: Array.isArray(body?.usageOrder) ? body.usageOrder.map(String) : [],
  }
}

/** search 响应归一：hits 字段固定，snippet 截断到后端给的长度内。 */
function normalizeHits(body) {
  const hits = Array.isArray(body?.hits) ? body.hits : []
  return {
    query: String(body?.query ?? ''),
    total: Number.isFinite(Number(body?.total)) ? Number(body.total) : hits.length,
    truncated: body?.truncated === true,
    indexReady: body?.indexReady === true,
    hits: hits.map(row => ({
      domain: String(row?.domain ?? ''),
      file: String(row?.file ?? ''),
      section: String(row?.section ?? ''),
      anchor: String(row?.anchor ?? ''),
      ref: String(row?.ref ?? ''),
      title: String(row?.title ?? ''),
      snippet: String(row?.snippet ?? ''),
      score: Number.isFinite(Number(row?.score)) ? Number(row.score) : 0,
      line: Number.isFinite(Number(row?.line)) ? Number(row.line) : 0,
    })),
  }
}

/** asset 响应归一：不传 section 时后端返回 anchors 目录。 */
function normalizeAsset(body) {
  const anchors = Array.isArray(body?.anchors) ? body.anchors : []
  const value = {
    domain: String(body?.domain ?? ''),
    file: String(body?.file ?? ''),
    anchors: anchors.map(row => ({
      section: String(row?.section ?? ''),
      level: Number.isFinite(Number(row?.level)) ? Number(row.level) : 0,
      line: Number.isFinite(Number(row?.line)) ? Number(row.line) : 0,
    })),
    text: typeof body?.text === 'string' ? body.text : '',
    chars: Number.isFinite(Number(body?.chars)) ? Number(body.chars) : 0,
    truncated: body?.truncated === true,
  }
  if (typeof body?.section === 'string' && body.section) value.section = body.section
  if (typeof body?.anchor === 'string' && body.anchor) value.anchor = body.anchor
  if (Number.isFinite(Number(body?.nextOffset))) value.nextOffset = Number(body.nextOffset)
  return value
}

/** table 响应归一：未建卡 = total 0 + 空 matches + note。role/ownerDomain 是第 51 轮新增。 */
function normalizeTableCard(body) {
  const matches = Array.isArray(body?.matches) ? body.matches : []
  return {
    table: String(body?.table ?? ''),
    total: Number.isFinite(Number(body?.total)) ? Number(body.total) : matches.length,
    matches: matches.map(row => ({
      domain: String(row?.domain ?? ''),
      file: String(row?.file ?? ''),
      section: String(row?.section ?? ''),
      title: String(row?.title ?? ''),
      text: String(row?.text ?? ''),
      chars: Number.isFinite(Number(row?.chars)) ? Number(row.chars) : 0,
      truncated: row?.truncated === true,
      anchor: String(row?.anchor ?? ''),
      ref: String(row?.ref ?? ''),
      // 第 51 轮：同一张表可能既有主属卡也有使用方视角卡，模型必须能区分。
      role: normalizeRole(row?.role),
      ownerDomain: String(row?.ownerDomain ?? ''),
    })),
    note: typeof body?.note === 'string' && body.note ? body.note : '',
  }
}

/** 卡的身份标注：「主属卡」或「使用方视角卡（主属：X）」；后端没给 role 时留空不瞎猜。 */
function roleLabel(card) {
  if (card.role === 'owner') return '主属卡'
  if (card.role === 'consumer') {
    return card.ownerDomain ? `使用方视角卡（主属：${card.ownerDomain}）` : '使用方视角卡'
  }
  return ''
}

/** 锚点引用行：「bill-clearing / table-cards.md §2.3 (anchor 2.3)」。 */
function refLine(hit) {
  const parts = [hit.domain, hit.file].filter(Boolean).join(' / ')
  const section = hit.section ? ` §${hit.section}` : ''
  const anchor = hit.anchor && hit.anchor !== hit.section ? `（anchor ${hit.anchor}）` : ''
  return `${parts}${section}${anchor}`
}

/**
 * 注册 4 个语义层工具。ctx 仅用于 ctx.effect/ctx.tools.register（与 tools.js 同套路）。
 */
export function registerSemanticTools(ctx, { settings, backend }) {
  function register(definition, label) {
    ctx.effect(() => ctx.tools.register(definition), label)
  }

  // ------------------------------------------------ 1. db_list_semantic_domains

  register({
    name: 'db_list_semantic_domains',
    description:
      'List the business semantic layer domains (NL2SQL assets: table cards, glossary, query samples per domain). '
      + 'This is ALWAYS the first step when answering a business/metrics question: pick the domain here, then use '
      + 'db_search_semantics / db_get_semantic_asset / db_get_table_card to read the actual wording, status enums, '
      + 'amount units and join paths before writing any SQL. Domains are created by the user in the panel '
      + '(「语义层」page: + 新建 or 导入文档目录) — an empty layer is a normal state, not a tool that is off. '
      + 'Read-only, no database connection needed.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    isConcurrencySafe: true,
    timeoutMs: SEMANTIC_TIMEOUT_MS,
    output: output(
      {
        configured: { type: 'boolean' },
        indexReady: { type: 'boolean' },
        exportDir: { type: 'string' },
        canRebuildFiles: { type: 'boolean' },
        domains: { type: 'array', items: { type: 'object' } },
        usageOrder: { type: 'array', items: { type: 'string' } },
      },
      ['configured', 'indexReady', 'exportDir', 'canRebuildFiles', 'domains', 'usageOrder'],
      (_args, value) => {
        if (!value.domains.length) {
          // 空域 ≠ 工具没启用：域要在面板里建/导。
          const lines = ['语义层还没有业务域：在面板「语义层」页点 + 新建，或在顶部填文档目录后「保存并导入」。']
          lines.push(value.canRebuildFiles
            ? `DB 写出路径：${value.exportDir}`
            : 'DB 写出路径：未配置（可正常编辑与检索，但无法重建成本地文件）')
          lines.push('在此之前回答业务问题只能退化为 schema 探查，并声明「无业务语义资产，口径未确认」。')
          return textBlock(lines.join('\n'))
        }
        const index = value.indexReady ? '索引就绪' : '索引未就绪（可能正在构建，稍后重试）'
        const lines = [`语义层共 ${value.domains.length} 个业务域 · ${index}：`]
        for (const row of value.domains.slice(0, 15)) {
          const origin = row.origin === 'system' ? ' · 系统域' : (row.origin === 'doc' ? ' · 文档导入' : '')
          lines.push(`· ${row.domain}${row.title ? `（${row.title}）` : ''}${origin} — ${row.files} 个文件 · ${row.tables} 张表卡 · ${row.samples} 条样例`)
        }
        if (value.domains.length > 15) lines.push(`…共 ${value.domains.length} 个，其余见 JSON`)
        lines.push(value.canRebuildFiles
          ? `DB 写出路径：${value.exportDir}`
          : 'DB 写出路径：未配置（可正常编辑与检索，但无法重建成本地文件）')
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(_args, exec) {
      const body = await backend.getJson('/api/semantic/domains', {}, { signal: exec.signal, timeoutMs: SEMANTIC_TIMEOUT_MS })
      return normalizeDomainsBody(body)
    },
  }, 'dsh-db-studio: db_list_semantic_domains tool')

  // ------------------------------------------------ 2. db_search_semantics

  register({
    name: 'db_search_semantics',
    description:
      'Full-text search across the business semantic layer (table cards, glossary, disambiguation notes, query '
      + 'samples). Use it after db_list_semantic_domains to locate which asset answers the question: search Chinese '
      + 'keywords, table names or status words. Returns hits with domain/file/section/anchor so you can read the full '
      + 'section with db_get_semantic_asset. Read-only, no database connection needed.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search keywords (Chinese or table name), e.g. "退款" or "t_trade_order".' },
        domain: { type: 'string', description: 'Restrict to one domain id, e.g. "bill-clearing".' },
        file: { type: 'string', description: 'Restrict to one file name, e.g. "glossary.md".' },
        limit: { type: 'integer', description: 'Max hits to return, 1-20. Default 8.' },
        snippetChars: { type: 'integer', description: 'Snippet length per hit in characters. Backend default 1200.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    timeoutMs: SEMANTIC_TIMEOUT_MS,
    output: output(
      {
        query: { type: 'string' },
        total: { type: 'number' },
        indexReady: { type: 'boolean' },
        truncated: { type: 'boolean' },
        hits: { type: 'array', items: { type: 'object' } },
      },
      ['query', 'total', 'indexReady', 'truncated', 'hits'],
      (args, value) => {
        if (!value.hits.length) {
          return textBlock(`语义层没有命中「${clip(args.query, 60)}」：换关键词、去掉 domain/file 过滤，或改用 db_get_table_card 直接查表卡。`)
        }
        const lines = [`命中 ${value.hits.length} 条（共 ${value.total} 条）：`]
        for (const hit of value.hits.slice(0, 8)) {
          lines.push(`· [${hit.title || hit.section || hit.file}] ${refLine(hit)}${hit.score ? ` · 分数 ${hit.score}` : ''}`)
          if (hit.snippet) lines.push(`  ${clip(hit.snippet.replace(/\s+/g, ' '), 160)}`)
        }
        if (value.hits.length > 8) lines.push(`…其余 ${value.hits.length - 8} 条见 JSON`)
        if (value.truncated) lines.push('⚠ 结果已截断：只返回了部分命中，可缩小关键词或调低 limit。')
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const query = String(args.query ?? '').trim()
      if (!query) throw new Error('db_search_semantics 需要 query（检索关键词，不能为空）。')
      const params = { q: query }
      if (args.domain) params.domain = args.domain
      if (args.file) params.file = args.file
      if (args.limit !== undefined && args.limit !== null) params.limit = args.limit
      if (args.snippetChars !== undefined && args.snippetChars !== null) params.snippetChars = args.snippetChars
      const body = await backend.getJson('/api/semantic/search', params, { signal: exec.signal, timeoutMs: SEMANTIC_TIMEOUT_MS })
      return normalizeHits(body)
    },
  }, 'dsh-db-studio: db_search_semantics tool')

  // ------------------------------------------------ 3. db_get_semantic_asset

  register({
    name: 'db_get_semantic_asset',
    description:
      'Read one semantic-layer asset document (table-cards.md / glossary.md / query-samples.md / ...) in a domain. ' +
      'Without `section` it returns the document outline (anchors) — read the outline first, then fetch the exact ' +
      'section you need. With `section` it returns that section text; truncated=true plus nextOffset means there is ' +
      'more (call again with offset). Glossary disambiguates business terms; query-samples holds golden SQL examples. ' +
      'Read-only, no database connection needed.',
    parameters: {
      type: 'object',
      properties: {
        domain: { type: 'string', description: 'Domain id from db_list_semantic_domains, e.g. "bill-clearing".' },
        file: { type: 'string', description: 'File name in that domain, e.g. "glossary.md" or "table-cards.md".' },
        section: { type: 'string', description: 'Section anchor from the outline (e.g. "2.3" or "S07"). Omit to list the outline.' },
        offset: { type: 'integer', description: 'Character offset into the section for pagination. Default 0.' },
        maxChars: { type: 'integer', description: 'Max characters to return, 500-20000. Default 8000.' },
      },
      required: ['domain', 'file'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    timeoutMs: SEMANTIC_TIMEOUT_MS,
    output: output(
      {
        domain: { type: 'string' },
        file: { type: 'string' },
        section: { type: 'string' },
        anchor: { type: 'string' },
        anchors: { type: 'array', items: { type: 'object' } },
        text: { type: 'string' },
        chars: { type: 'number' },
        truncated: { type: 'boolean' },
        nextOffset: { type: 'number' },
      },
      ['domain', 'file', 'anchors', 'text', 'chars', 'truncated'],
      (args, value) => {
        const head = `${value.domain} / ${value.file}${value.section ? ` §${value.section}` : ''}`
        if (!args.section) {
          // 目录模式：把 anchors 列出来，模型挑小节再取正文。
          if (!value.anchors.length) return textBlock(`${head}：这份文档没有解析出小节目录，可直接带 section 试试，或先用 db_search_semantics 定位。`)
          const lines = [`${head} 的目录（${value.anchors.length} 个小节），用 section 参数取正文：`]
          for (const row of value.anchors.slice(0, 20)) {
            lines.push(`· §${row.section || '(root)'}（level ${row.level}，行 ${row.line}）`)
          }
          if (value.anchors.length > 20) lines.push(`…共 ${value.anchors.length} 个，其余见 JSON`)
          return textBlock(lines.join('\n'))
        }
        if (!value.text) return textBlock(`${head}：小节内容为空，请确认 section 是否存在（先不带 section 看目录）。`)
        const lines = [`${head} · ${value.chars} 字符`]
        lines.push(clip(value.text.replace(/\s+/g, ' ').trim(), 400))
        if (value.truncated) lines.push(`⚠ 正文已截断：还有剩余内容，用 offset=${value.nextOffset} 继续读。`)
        if (value.anchor) lines.push(`锚点：${value.anchor}`)
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const domain = String(args.domain ?? '').trim()
      const file = String(args.file ?? '').trim()
      if (!domain) throw new Error('db_get_semantic_asset 需要 domain（业务域 id，来自 db_list_semantic_domains）。')
      if (!file) throw new Error('db_get_semantic_asset 需要 file（域内文件名，如 glossary.md）。')
      const params = { domain, file }
      if (args.section) params.section = args.section
      if (args.offset !== undefined && args.offset !== null) params.offset = args.offset
      if (args.maxChars !== undefined && args.maxChars !== null) params.maxChars = args.maxChars
      const body = await backend.getJson('/api/semantic/asset', params, { signal: exec.signal, timeoutMs: SEMANTIC_TIMEOUT_MS })
      return normalizeAsset(body)
    },
  }, 'dsh-db-studio: db_get_semantic_asset tool')

  // ------------------------------------------------ 4. db_get_table_card

  register({
    name: 'db_get_table_card',
    description:
      'Fetch the semantic card(s) for one table: canonical columns, status enums, amount units, filter rules and ' +
      'join paths. A table may have multiple cards: one owner card (role="owner", the domain that maintains it) and ' +
      'several consumer-view cards from other domains (role="consumer" + ownerDomain). If the table ' +
      'has no card the tool returns empty matches — fall back to db_search_semantics or schema exploration and say ' +
      'the wording is unconfirmed. Read-only, no database connection needed.',
    parameters: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table name, e.g. "t_trade_order_batch".' },
        domain: { type: 'string', description: 'Restrict to one domain id. Omit to search all domains.' },
        maxChars: { type: 'integer', description: 'Max characters per card, 500-20000. Default 6000.' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    isConcurrencySafe: true,
    timeoutMs: SEMANTIC_TIMEOUT_MS,
    output: output(
      {
        table: { type: 'string' },
        total: { type: 'number' },
        matches: { type: 'array', items: { type: 'object' } },
        note: { type: 'string' },
      },
      ['table', 'total', 'matches', 'note'],
      (_args, value) => {
        if (!value.matches.length) {
          const lines = [`表 ${value.table} 在语义层没有表语义卡。`]
          if (value.note) lines.push(`说明：${clip(value.note, 160)}`)
          lines.push('建议：改用 db_search_semantics 换关键词检索，或退化为 db_list_tables/db_describe_table 探查 schema，并在回答中声明口径未确认。')
          return textBlock(lines.join('\n'))
        }
        const lines = [`表 ${value.table} 有 ${value.total} 张语义卡：`]
        for (const card of value.matches.slice(0, 5)) {
          // 「主属卡」是权威口径；「使用方视角卡」只描述该域怎么用这张表，冲突时以主属卡为准。
          const role = roleLabel(card)
          lines.push(`· [${card.domain} / ${card.file} §${card.section}]${role ? ` · ${role}` : ''}${card.anchor ? `（anchor ${card.anchor}）` : ''} ${card.chars} 字符${card.truncated ? '（已截断）' : ''}`)
          if (card.text) lines.push(`  ${clip(card.text.replace(/\s+/g, ' ').trim(), 200)}`)
        }
        if (value.matches.length > 5) lines.push(`…共 ${value.matches.length} 张卡，其余见 JSON`)
        if (value.matches.some(card => card.role === 'consumer')) {
          lines.push('口径冲突时以**主属卡**为准；使用方视角卡只说明该域怎么用这张表。')
        }
        if (value.note) lines.push(`说明：${clip(value.note, 200)}`)
        return textBlock(lines.join('\n'))
      },
    ),
    async execute(args, exec) {
      const table = String(args.table ?? '').trim()
      if (!table) throw new Error('db_get_table_card 需要 table（表名）。')
      const params = { table }
      if (args.domain) params.domain = args.domain
      if (args.maxChars !== undefined && args.maxChars !== null) params.maxChars = args.maxChars
      const body = await backend.getJson('/api/semantic/table', params, { signal: exec.signal, timeoutMs: SEMANTIC_TIMEOUT_MS })
      return normalizeTableCard(body)
    },
  }, 'dsh-db-studio: db_get_table_card tool')
}
