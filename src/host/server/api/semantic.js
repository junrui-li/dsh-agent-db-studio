/**
 * 语义层 API（第 51 轮重写：dbs.db 为事实来源，面板可编辑）
 * server/api/semantic.py 的逐函数移植（V3 去 sidecar）。
 *
 * 分层：
 * - semantic/store.js    仓储（dbs.db）
 * - semantic/index.js    从仓储重建检索索引（semantic-index.db，可随时删）
 * - semantic/templates.js 新建域的 4 个骨架文件（.tmpl 内联）
 * - semantic/skeleton.js  关联表 → table-cards.md 骨架小节
 * - semantic/exporter.js  导出 / 导入（唯一的磁盘读写面）
 *
 * 约定：
 * - 只读接口（domains/search/asset/table）在没有任何域时返回 `configured:false` 风格，
 *   形状保持不变，老客户端不会因为新增字段而崩。
 * - 写接口一律「先落库、再重建索引、最后（有条件）写盘」：索引/写盘失败不回滚 DB，
 *   而是在响应里如实标注 `indexOk` / `writeError`，绝不谎报成功。
 */

import { resolve } from 'node:path'
import { statSync } from 'node:fs'
import * as common from './common.js'
import * as config from '../core/config.js'
import { ApiError } from '../core/errors.js'
import { metaSet } from '../store/db.js'
import * as exporter from '../semantic/exporter.js'
import * as semanticIndex from '../semantic/index.js'
import * as parser from '../semantic/parser.js'
import * as search from '../semantic/search.js'
import * as skeleton from '../semantic/skeleton.js'
import * as store from '../semantic/store.js'
// Python api 层静态 import templates.render_all；JS 侧同样静态依赖（templates.js
// 同时把 renderAll 挂到 storeHooks.templates，保持 M3-S 预留接缝可用）。
import * as templates from '../semantic/templates.js'

export const USAGE_ORDER = [
  'db_list_semantic_domains 先看有哪些域',
  'db_search_semantics 定位资产与表名',
  'db_get_semantic_asset(glossary) 消歧',
  'db_get_table_card 定表/JOIN 路径',
  'db_get_semantic_asset(query-samples) 参考金标样例',
  'db_query 只读执行（写走 db_execute 工单）',
]

// 单文件正文上限（字符）：512KB 量级的 markdown 已远超任何真实语义资产。
export const MAX_FILE_CHARS = 512 * 1024

// ---------------------------------------------------------------- 公共小工具

function nowStamp() {
  return common.now()
}

function indexPayload(stats, stale = false) {
  return {
    ready: Boolean(stats?.ready),
    builtAt: stats?.builtAt ?? '',
    assets: Number(stats?.assets) || 0,
    sections: Number(stats?.sections) || 0,
    stale: Boolean(stale),
  }
}

function notConfigured(extra = {}) {
  return { configured: false, ...extra }
}

function requireDomain(domain) {
  if (!domain) throw new ApiError(400, '缺少 domain')
  const item = store.getDomain(domain)
  if (item === null) {
    const known = store.listDomains().map((row) => row.domain)
    const hint = known.length ? known.slice(0, 20).join('/') : '（还没有任何业务域）'
    throw new ApiError(404, `未知语义域: ${domain}（可用: ${hint}）`, 'SEMANTIC_DOMAIN_UNKNOWN')
  }
  return item
}

function rebuildAfterWrite() {
  /** 写操作后重建索引。返回 {ok, stats?, error?}（不抛，调用方如实上报）。 */
  try {
    const stats = semanticIndex.ensure('', true)
    return { ok: true, stats }
  } catch (exc) {
    if (exc instanceof semanticIndex.SemanticIndexError
      || exc?.name === 'SemanticIndexError') {
      return { ok: false, error: String(exc.message) }
    }
    return { ok: false, error: `${exc?.name || 'Error'}: ${exc?.message || exc}` }
  }
}

function writeBack(domainItem, filename, text) {
  /** 保存后写回本地文件。
   *
   * 目标路径优先级（第 52 轮，AGENTS.md 硬规则 6）：该域自己的 `exportDir` >
   * 顶部「DB 写出路径」。两者都没有 → 只写 DB，并回 `noTarget:true` 让面板提示。
   */
  const domain = domainItem?.domain || ''
  const target = domainItem?.exportDir || config.semanticExportDir()
  if (!target) return { wrote: false, noTarget: true }
  try {
    const path = exporter.writeFile(target, domain, filename, text)
    return { wrote: true, path }
  } catch (exc) {
    return { wrote: false, error: String(exc?.message || exc) }
  }
}

function intParam(query, key, fallback, low, high) {
  return common.intField(query, key, fallback, low, high, key)
}

function domainView(item) {
  /** 域列表里的一项：文件列表返回对象数组（含 kind/chars/revision/source）。 */
  const domain = item.domain
  const files = store.listFiles(domain)
  const counts = domainCounts(domain)
  return {
    domain,
    title: item.title || domain,
    origin: item.origin || 'system',
    exportDir: item.exportDir || '',
    originDir: item.originDir || '',
    files: files.length,
    fileList: files.map((f) => ({
      file: f.file, kind: f.kind || '',
      chars: Number(f.chars) || 0,
      revision: Number(f.revision) || 1,
      source: f.source || 'template',
    })),
    tables: counts.tables,
    samples: counts.samples,
    domainTables: counts.domainTables,
  }
}

function domainCounts(domain) {
  /** 从索引里取该域的表卡/样例数；索引没建好时降级为 0（不触发重建）。 */
  let tables = 0
  let samples = 0
  try {
    const conn = semanticIndex.connShared()
    const row = conn.prepare(
      'SELECT tables, samples FROM semantic_domains WHERE domain=?').get(domain)
    if (row !== undefined) {
      tables = Number(row.tables) || 0
      samples = Number(row.samples) || 0
    }
  } catch { /* 计数是展示用，拿不到就不显示 */ }
  let domainTables = 0
  try {
    domainTables = store.listDomainTables(domain).length
  } catch { /* 忽略 */ }
  return { tables, samples, domainTables }
}

// ---------------------------------------------------------------- 只读：domains

export function handleDomains(query, _body = null, _headers = null) {
  const domains = store.listDomains()
  const exportDir = config.semanticExportDir()
  // 没填写出路径 → 明确告诉面板「无法重建成本地文件」（DB 内容照常可编辑）
  const rebuildHint = exportDir ? '' : (
    '没有配置「DB 写出路径」：语义内容可以正常编辑，但无法重建成本地文件。'
    + '在顶部填写路径并保存即可。')
  if (!domains.length) {
    return {
      configured: false, exportDir,
      canRebuildFiles: Boolean(exportDir),
      rebuildHint,
      index: indexPayload({ ready: false }),
      domains: [], usageOrder: [],
      error: '还没有任何业务域：点「+ 新建」建一个，或在顶部填「DB 写出路径」后「保存并导入」',
    }
  }
  let error = ''
  let stats
  try {
    stats = semanticIndex.ensure()
  } catch (exc) {
    stats = { ready: false }
    error = String(exc?.message || exc)
  }
  const out = {
    configured: true,
    exportDir,
    canRebuildFiles: Boolean(exportDir),
    rebuildHint,
    index: indexPayload(stats, Boolean(stats.stale)),
    domains: domains.map((item) => domainView(item)),
    usageOrder: USAGE_ORDER,
  }
  if (error) out.error = error
  return out
}

// ---------------------------------------------------------------- 只读：search / asset / table

export function handleSearch(query, _body = null, _headers = null) {
  const q = common.textField(query, 'q', '', 'q').trim()
  const base = { query: q, total: 0, hits: [], truncated: false, indexReady: false }
  if (store.isEmpty()) return notConfigured(base)
  requireReadyOrRaise()
  if (!q) throw new ApiError(400, '缺少 q')
  const domain = common.textField(query, 'domain', '', 'domain').trim()
  const file = common.textField(query, 'file', '', 'file').trim()
  const kind = common.textField(query, 'kind', '', 'kind').trim()
  const limit = intParam(query, 'limit', 8, 1, 30)
  const snippetChars = intParam(query, 'snippetChars', 1200, 100, 2000)
  const conn = semanticIndex.connShared()
  if (domain) requireDomain(domain)
  const result = search.search(conn, q, {
    domain, file, kind, limit, snippetChars,
  })
  result.query = q
  result.configured = true
  result.indexReady = true
  return result
}

function requireReadyOrRaise() {
  try {
    return semanticIndex.ensure()
  } catch (exc) {
    if (exc instanceof semanticIndex.SemanticIndexError
      || exc?.name === 'SemanticIndexError') {
      throw new ApiError(503, String(exc.message), 'SEMANTIC_INDEX_BUILDING')
    }
    throw exc
  }
}

export function handleAsset(query, _body = null, _headers = null) {
  const domain = common.textField(query, 'domain', '', 'domain').trim()
  const file = common.textField(query, 'file', '', 'file').trim()
  const base = {
    domain, file, anchors: [], text: '', chars: 0,
    truncated: false, nextOffset: null, anchor: '',
  }
  if (store.isEmpty()) return notConfigured(base)
  requireReadyOrRaise()
  requireDomain(domain)
  // file 兼容两种写法：域内相对名（table-cards.md）与全相对路径（pay/table-cards.md）
  const name = file.startsWith(`${domain}/`) ? file.slice(domain.length + 1) : file
  const relfile = `${domain}/${name}`
  if (!name || store.getFile(domain, name) === null) {
    const known = store.listFiles(domain).map((f) => f.file)
    const hint = known.slice(0, 20).join(' / ') || '（无文档）'
    throw new ApiError(404, `未知语义文件: ${file}（${domain} 可用: ${hint}）`,
      'SEMANTIC_FILE_UNKNOWN')
  }
  const maxChars = intParam(query, 'maxChars',
    Math.max(500, Math.min(config.semanticMaxChars(), 20000)), 500, 20000)
  const offset = intParam(query, 'offset', 0, 0, 10 ** 9)
  const section = common.textField(query, 'section', '', 'section').trim()

  const conn = semanticIndex.connShared()
  const anchors = conn.prepare(
    'SELECT anchor, level, line FROM semantic_sections '
    + 'WHERE domain=? AND file=? ORDER BY ord').all(domain, relfile)
    .map((r) => ({ section: r.anchor, level: Number(r.level), line: Number(r.line) }))
  const out = { configured: true, domain, file: relfile, anchors }
  if (!section) {
    Object.assign(out, {
      section: null, anchor: '', text: '', chars: 0,
      truncated: false, nextOffset: null,
    })
    return out
  }

  const row = conn.prepare(
    'SELECT anchor, heading, level, body FROM semantic_sections '
    + 'WHERE domain=? AND file=? '
    + 'AND (anchor=? OR CAST(ord AS TEXT)=?) ORDER BY ord').get(domain, relfile, section, section)
  if (row === undefined) {
    const preview = anchors.slice(0, 20).map((a) => a.section).join(' / ') || '（无 section）'
    throw new ApiError(404,
      `未知 section: ${section}（${relfile} 前二十大节: ${preview}）`,
      'SEMANTIC_SECTION_UNKNOWN')
  }
  const anchor = row.anchor
  const heading = row.heading || ''
  const level = Number(row.level) || 1
  const bodyText = row.body || ''
  // 正文首行带原标题：anchor 常是纯编号（如 2.1），不带标题会让 agent 丢掉
  // 「这一节讲哪张表」的上下文（标题往往就是表名）。
  const fullText = heading ? `${'#'.repeat(level)} ${heading}\n${bodyText}` : bodyText
  const sliced = fullText.slice(offset, offset + maxChars)
  const truncated = offset + sliced.length < fullText.length
  Object.assign(out, {
    section, anchor, text: sliced,
    chars: sliced.length, truncated,
    nextOffset: truncated ? offset + sliced.length : null,
    ref: `${domain}/${relfile}#${anchor}`,
  })
  return out
}

export function handleTable(query, _body = null, _headers = null) {
  const table = common.textField(query, 'table', '', 'table').trim()
  const domain = common.textField(query, 'domain', '', 'domain').trim()
  const base = { table, total: 0, matches: [], note: '语义层未配置' }
  if (store.isEmpty()) return notConfigured(base)
  requireReadyOrRaise()
  if (!table) throw new ApiError(400, '缺少 table')
  const conn = semanticIndex.connShared()
  if (domain) requireDomain(domain)
  const maxChars = intParam(query, 'maxChars', 6000, 200, 20000)
  let cond = 'lower(t.table_name)=lower(?)'
  const args = [table]
  if (domain) {
    cond += ' AND t.domain=?'
    args.push(domain)
  }
  const rows = conn.prepare(
    'SELECT t.domain, t.file, s.anchor, s.heading, s.body, t.ord '
    + 'FROM semantic_tables t JOIN semantic_sections s '
    + 'ON s.domain=t.domain AND s.file=t.file AND s.ord=t.ord '
    + `WHERE ${cond} ORDER BY t.domain, t.file, t.ord`).all(...args)
  // 多域归属（第 51 轮）：卡片所在域如果是该表的主属域 → owner，否则看关联表里
  // 是否以 consumer 登记（使用方视角卡）。
  const refs = new Map()
  for (const row of store.listAllDomainTables()) {
    if (String(row.table || '').toLowerCase() === table.toLowerCase()) {
      refs.set(row.domain, row)
    }
  }
  const matches = []
  for (const row of rows) {
    const text = (row.body || '').slice(0, maxChars)
    const ref = refs.get(row.domain) || null
    const role = ref?.role || 'owner'
    let ownerDomain = ''
    if (role === 'consumer') {
      for (const r of refs.values()) {
        if (r.role === 'owner') {
          ownerDomain = r.domain
          break
        }
      }
    }
    matches.push({
      domain: row.domain, file: row.file, section: row.anchor, anchor: row.anchor,
      title: row.heading, text, chars: text.length,
      truncated: (row.body || '').length > text.length,
      ref: `${row.domain}/${row.file}#${row.anchor}`,
      role, ownerDomain,
    })
  }
  const out = { configured: true, table, total: matches.length, matches }
  if (!matches.length) out.note = '未建卡；可用 db_search_semantics 全文检索该表名'
  return out
}

// ---------------------------------------------------------------- 文件读写

export function handleFile(query, _body = null, _headers = null) {
  /** GET /api/semantic/file —— 编辑器取全文（不是分页的小节正文）。 */
  const domain = common.textField(query, 'domain', '', 'domain').trim()
  const file = common.textField(query, 'file', '', 'file').trim()
  requireDomain(domain)
  if (!file) throw new ApiError(400, '缺少 file')
  const item = store.getFile(domain, file)
  if (item === null) {
    throw new ApiError(404, `未知语义文件: ${file}（${domain}）`, 'SEMANTIC_FILE_UNKNOWN')
  }
  const out = { ...item }
  out.domain = domain
  out.kind = parserKind(file, out)
  return out
}

export function parserKind(file, item) {
  const kind = item.kind || ''
  return kind || parser.fileKind(file)
}

export function handleFileSave(query, body = null, _headers = null) {
  /** POST /api/semantic/file/save —— 先落库，再重建索引，再（有条件）写盘。 */
  const payload = common.bodyOf(body)
  const domain = common.textField(payload, 'domain', '', 'domain').trim()
  const file = common.textField(payload, 'file', '', 'file').trim()
  const text = common.textField(payload, 'text', '', 'text')
  const domainItem = requireDomain(domain)
  if (!file) throw new ApiError(400, '缺少 file')
  if (text.length > MAX_FILE_CHARS) {
    throw new ApiError(413, `文件过大：${text.length} 字符（上限 ${MAX_FILE_CHARS}）`,
      'SEMANTIC_FILE_TOO_LARGE')
  }
  const expected = payload.expectedRevision
  const force = Boolean(payload.force)
  let expectedInt = null
  if (expected !== null && expected !== undefined && expected !== '') {
    const parsed = Number(expected)
    if (!Number.isInteger(parsed)) {
      throw new ApiError(400, `expectedRevision 必须是整数: ${JSON.stringify(expected)}`)
    }
    expectedInt = parsed
  }
  let ok
  let current
  try {
    [ok, current] = store.saveFile(domain, file, text, expectedInt, force)
  } catch (exc) {
    if (exc?.name === 'SemanticStoreError') throw new ApiError(400, exc.message, exc.code)
    throw exc
  }
  if (!ok) {
    throw new ApiError(409, '文件已被其它窗口修改，请重新加载或覆盖保存',
      'SEMANTIC_FILE_CONFLICT')
  }
  const out = {
    domain, file, revision: Number(current.revision), savedAt: nowStamp(),
  }
  const indexResult = rebuildAfterWrite()
  out.indexOk = indexResult.ok
  if (!indexResult.ok) out.indexError = indexResult.error || ''
  const wrote = writeBack(domainItem, file, text)
  out.wrote = Boolean(wrote.wrote)
  out.writePath = wrote.path || ''
  if (wrote.noTarget) out.writeNoTarget = true // 没配写出路径 → 面板提示
  if (wrote.error) out.writeError = wrote.error
  return out
}

// ---------------------------------------------------------------- 域增删改

export function handleDomainCreate(query, body = null, _headers = null) {
  const payload = common.bodyOf(body)
  const domain = common.textField(payload, 'domain', '', 'domain').trim()
  const title = common.textField(payload, 'title', '', 'title').trim()
  if (!domain) throw new ApiError(400, '缺少 domain')
  const files = templates.renderAll(domain, title || domain)
  let item
  try {
    item = store.createDomain(domain, title || domain, 'system', files)
  } catch (exc) {
    if (exc?.name === 'SemanticStoreError') {
      const status = exc.code === 'SEMANTIC_DOMAIN_EXISTS' ? 409 : 400
      throw new ApiError(status, exc.message, exc.code)
    }
    throw exc
  }
  const indexResult = rebuildAfterWrite()
  const out = { domain: domainView(item), createdAt: item.createdAt || '' }
  out.indexOk = indexResult.ok
  if (!indexResult.ok) out.indexError = indexResult.error || ''
  return out
}

export function handleDomainUpdate(query, body = null, _headers = null) {
  const payload = common.bodyOf(body)
  const domain = common.textField(payload, 'domain', '', 'domain').trim()
  requireDomain(domain)
  const title = payload.title
  let exportDir = payload.exportDir
  if (exportDir !== null && exportDir !== undefined) {
    const raw = String(exportDir || '').trim()
    if (raw) {
      const resolved = resolve(raw)
      let isDir = false
      try { isDir = statIsDir(resolved) } catch { isDir = false }
      if (!isDir) throw new ApiError(400, `导出目录不存在: ${resolved}`)
      exportDir = resolved
    }
  }
  let item
  try {
    item = store.updateDomain(
      domain,
      title === null || title === undefined ? null : String(title),
      exportDir === undefined ? null : exportDir)
  } catch (exc) {
    if (exc?.name === 'SemanticStoreError') throw new ApiError(404, exc.message, exc.code)
    throw exc
  }
  return { domain: domainView(item) }
}

function statIsDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

export function handleDomainDelete(query, body = null, _headers = null) {
  const payload = common.bodyOf(body)
  const domain = common.textField(payload, 'domain', '', 'domain').trim()
  if (payload.confirm !== true) throw new ApiError(400, '删除语义域需要 confirm:true')
  requireDomain(domain)
  const item = store.getDomain(domain) || {}
  const deleted = store.deleteDomain(domain)
  if (!deleted) {
    throw new ApiError(404, `未知语义域: ${domain}`, 'SEMANTIC_DOMAIN_UNKNOWN')
  }
  const indexResult = rebuildAfterWrite()
  const out = {
    deleted: true, domain,
    exportDir: item.exportDir || '',
    note: '只删除了数据库记录，导出目录里的文件未改动',
  }
  out.indexOk = indexResult.ok
  return out
}

// ---------------------------------------------------------------- 关联数据表

async function loadColumns(connectionId, database, table) {
  /** 尽力预填字段字典；失败返回 null（不阻断关联）。 */
  if (!connectionId || !database || !table) return null
  try {
    const metaApi = await import('./meta.js')
    const info = common.getConnection({ connectionId })
    const detail = await metaApi.handleTable({ connectionId, database, table })
    return detail.columns || null
  } catch {
    return null // 预填是增值项，任何失败都退回空骨架
  }
}

async function tableComment(connectionId, database, table) {
  try {
    const metaApi = await import('./meta.js')
    const info = common.getConnection({ connectionId })
    const listing = await metaApi.handleTables({ connectionId, database })
    for (const row of listing.tables || []) {
      if (row.name === table) return String(row.comment || '')
    }
  } catch { /* 忽略 */ }
  return ''
}

export async function handleDomainTables(query, body = null, _headers = null) {
  /** POST /api/semantic/domain/tables —— 同步关联表 + 一次性插骨架。 */
  const payload = common.bodyOf(body)
  const domain = common.textField(payload, 'domain', '', 'domain').trim()
  requireDomain(domain)
  const add = payload.add || []
  const remove = payload.remove || []
  if (!Array.isArray(add) || !Array.isArray(remove)) {
    throw new ApiError(400, 'add/remove 必须是数组')
  }
  const prefill = payload.prefill !== false
  const force = payload.force === true

  let ownerConflict = null
  const prepared = []
  let prefillError = ''
  for (const item of add) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new ApiError(400, 'add 的元素必须是对象')
    }
    const table = String(item.table || '').trim()
    const connId = String(item.connectionId || '').trim()
    const database = String(item.database || '').trim()
    if (!table) throw new ApiError(400, 'add 的元素缺少 table')
    const owner = store.ownerOf(connId, database, table)
    let role = item.role || (owner && owner !== domain ? 'consumer' : 'owner')
    if (owner && owner !== domain && role === 'owner' && !force) {
      ownerConflict = { table, ownerDomain: owner }
      role = 'consumer'
    }
    let columns = null
    let comment = ''
    if (prefill && role === 'owner') {
      columns = await loadColumns(connId, database, table)
      if (columns === null) {
        prefillError = `没能读到 ${table} 的列信息（连接不可用或无权限），已生成空骨架，请手工补字段字典`
      }
      comment = await tableComment(connId, database, table)
    }
    prepared.push({
      table, connectionId: connId, database,
      role, note: String(item.note || ''),
      columns, tableComment: comment,
    })
  }

  let synced
  try {
    synced = store.syncDomainTables(
      domain,
      prepared.map((p) => ({
        connectionId: p.connectionId, database: p.database,
        table: p.table, role: p.role, note: p.note,
      })),
      remove)
  } catch (exc) {
    if (exc?.name === 'SemanticStoreError') throw new ApiError(400, exc.message, exc.code)
    throw exc
  }

  const inserted = []
  let revision = null
  const addedNames = new Set(synced.added)
  const toInsert = prepared.filter((p) => addedNames.has(p.table))
  if (toInsert.length) {
    const item = store.getFile(domain, 'table-cards.md')
    if (item === null) {
      throw new ApiError(409, '该域没有 table-cards.md，无法插入表卡骨架',
        'SEMANTIC_FILE_UNKNOWN')
    }
    const cards = []
    for (const card of toInsert) {
      let ownerDomain = ''
      let ownerAnchor = ''
      if (card.role === 'consumer') {
        ownerDomain = store.ownerOf(card.connectionId, card.database, card.table)
        ownerAnchor = await ownerAnchorOf(ownerDomain, card.table)
      }
      cards.push({ ...card, ownerDomain, ownerAnchor })
    }
    const [newText, placed] = skeleton.insertCards(item.text, cards)
    let saved
    try {
      const [ok, current] = store.saveFile(domain, 'table-cards.md', newText, null, true)
      if (!ok) throw new Error('unreachable: force save')
      saved = current
    } catch (exc) {
      if (exc?.name === 'SemanticStoreError') throw new ApiError(400, exc.message, exc.code)
      throw exc
    }
    revision = Number(saved.revision)
    inserted.push(...placed)
  }

  const indexResult = rebuildAfterWrite()
  const out = {
    domain, added: synced.added, removed: synced.removed,
    inserted, revision,
    indexOk: indexResult.ok,
  }
  if (ownerConflict) out.ownerConflict = ownerConflict
  if (prefillError) out.prefillError = prefillError
  if (!indexResult.ok) out.indexError = indexResult.error || ''
  return out
}

async function ownerAnchorOf(ownerDomain, table) {
  /** 主属域的卡锚点（用于使用方视角卡里的交叉引用）。 */
  if (!ownerDomain) return ''
  try {
    const conn = semanticIndex.connShared()
    const row = conn.prepare(
      'SELECT anchor FROM semantic_tables WHERE domain=? AND '
      + 'lower(table_name)=lower(?) ORDER BY ord LIMIT 1').get(ownerDomain, table)
    return row !== undefined ? String(row.anchor) : ''
  } catch {
    return ''
  }
}

export function handleTables(query, _body = null, _headers = null) {
  /** GET /api/semantic/tables —— 该库每张表被哪些域引用（多域反查）。
   *
   * 可选 `domain`：额外回 `bound:true` 标出「已与该域登记」的表 —— 面板勾选直接用它，
   * 不必自己比对维度（`backfill` 回填的占位行 connectionId/database 都是空串）。
   */
  const connectionId = common.textField(query, 'connectionId', '', 'connectionId').trim()
  const database = common.textField(query, 'database', '', 'database').trim()
  if (!connectionId) throw new ApiError(400, '缺少 connectionId')
  if (!database) throw new ApiError(400, '缺少 database')
  const domain = common.textField(query, 'domain', '', 'domain').trim()
  if (domain) requireDomain(domain)
  const refs = store.tableRefs(connectionId, database)
  const bound = domain ? store.domainTableNames(domain) : null
  const tables = []
  for (const name of Object.keys(refs).sort()) {
    const item = { table: name, refs: refs[name] }
    if (domain) item.bound = bound.has(name.toLowerCase())
    tables.push(item)
  }
  const out = { connectionId, database, tables }
  if (domain) {
    out.boundTotal = bound.size
    // 该域登记了、但这次反查没覆盖到的表（表不在这个库里，或维度不匹配）
    const seen = new Set(Object.keys(refs).map((n) => n.toLowerCase()))
    out.boundMissing = [...bound].filter((n) => !seen.has(n)).sort().slice(0, 50)
  }
  return out
}

// ---------------------------------------------------------------- 回填（第 52 轮）

export function backfillCards({ dryRun = true, domainFilter = '' } = {}) {
  /** 把已有 table-cards.md 里的表卡重新关联到各业务域（用户需求 #6）。
   *
   * 背景：第 51 轮之前的资产是纯 markdown，`semantic_domain_table` 一直是 0 行，
   * 于是「关联数据表」弹窗里没有任何表被打勾。这里从每个域的 `table-cards.md`
   * 解析出 `### 2.N \`表名\``（含 demo-base-data 的分组式），补登记域↔表关系。
   *
   * 关键取舍：**只登记关系，不碰正文**。
   * - 不插入任何卡骨架（表卡本来就在文件里）；
   * - 不重编号、不改 content_version 之外的任何东西（避免索引无谓重建）。
   * connectionId/database 是必填维度，这里统一记成占位值 `""`：资产里没有可靠的
   * 库名信息（`归属库` 多为散文），强行猜库名会让「关联数据表」弹窗对不上。
   */
  const domains = store.listDomains()
  const report = []
  const planned = []
  for (const item of domains) {
    const name = item.domain
    if (domainFilter && name !== domainFilter) continue
    const fileItem = store.getFile(name, 'table-cards.md')
    if (fileItem === null) continue
    const cards = skeleton.cardsOf(fileItem.text)
    if (!cards.length) continue
    const existing = new Set(
      store.listDomainTables(name).map((row) => row.table.toLowerCase()))
    const fresh = cards.filter((card) => !existing.has(card.table.toLowerCase()))
    report.push({
      domain: name, cards: cards.length, added: fresh.length,
      tables: fresh.map((card) => card.table),
    })
    planned.push(...fresh.map((card) => [name, card]))
  }

  if (dryRun || !planned.length) {
    return {
      dryRun, domains: report,
      added: report.reduce((n, row) => n + row.added, 0),
    }
  }

  // owner 冲突按字典序先到先得：同一张表多个域自称 owner 时，第一个赢、
  // 其余降级为 consumer（与 handleDomainTables 的软约束口径一致）。
  const claimed = new Map()
  // 先把库里已登记的 owner 算进去，避免回填抢走既有归属
  for (const row of store.listAllDomainTables()) {
    if (row.role === 'owner') {
      const key = String(row.table || '').toLowerCase()
      if (!claimed.has(key)) claimed.set(key, row.domain)
    }
  }

  const byDomain = new Map()
  for (const [name, card] of planned) {
    const key = card.table.toLowerCase()
    let role = card.role
    const owner = claimed.get(key)
    if (role === 'owner') {
      if (owner !== undefined && owner !== name) {
        role = 'consumer' // 已被别的域主属 → 降级
      } else {
        claimed.set(key, name)
      }
    }
    if (!byDomain.has(name)) byDomain.set(name, [])
    byDomain.get(name).push({
      connectionId: '', database: '', table: card.table, role,
      note: card.ownerDomain ? `使用方视角（主属 ${card.ownerDomain}）` : '',
    })
  }

  for (const [name, adds] of byDomain.entries()) {
    store.syncDomainTables(name, adds, [])
  }
  const indexResult = rebuildAfterWrite()
  const out = {
    dryRun: false, domains: report,
    added: report.reduce((n, row) => n + row.added, 0),
    indexOk: indexResult.ok,
  }
  if (!indexResult.ok) out.indexError = indexResult.error || ''
  return out
}

export function handleBackfill(query, body = null, _headers = null) {
  /** POST /api/semantic/backfill —— 从现有 table-cards.md 回填域↔表关联。
   *
   * body: {dryRun?:bool（默认 true，只报告不写）, domain?:string}
   */
  const payload = body ? common.bodyOf(body) : {}
  const dryRun = payload.dryRun !== false
  const domain = String(payload.domain || '').trim()
  if (domain) requireDomain(domain)
  return backfillCards({ dryRun, domainFilter: domain })
}

// ---------------------------------------------------------------- 导出 / 导入

export function handleExport(query, body = null, _headers = null) {
  const payload = common.bodyOf(body)
  const domain = common.textField(payload, 'domain', '', 'domain').trim()
  const item = requireDomain(domain)
  const rawDir = String(payload.dir || '').trim()
  // 目标路径优先级：本次显式 dir > 该域的 exportDir > 全库写出路径（第 52 轮）
  const target = rawDir
    ? resolve(rawDir)
    : (item.exportDir || config.semanticExportDir())
  if (!target) {
    throw new ApiError(400,
      '没有写出路径：先在顶部填「DB 写出路径」并保存，或给该域单独绑定导出目录',
      'SEMANTIC_EXPORT_DIR_MISSING')
  }
  let wrote
  try {
    wrote = exporter.exportDomain(target, domain, store.listFiles(domain), store.getFile)
  } catch (exc) {
    // OSError 等价：JS 文件系统错误统一转 400
    throw new ApiError(400, `导出失败: ${exc?.message || exc}`)
  }
  if (resolve(item.exportDir || '') !== resolve(target)) {
    try {
      store.updateDomain(domain, null, target)
    } catch { /* 绑定失败不影响导出结果 */ }
  }
  return { domain, dir: target, wrote }
}

export function handleImport(query, body = null, _headers = null) {
  const payload = common.bodyOf(body)
  const rawDir = common.textField(payload, 'dir', '', 'dir').trim()
  if (!rawDir) throw new ApiError(400, '缺少 dir')
  const target = resolve(rawDir)
  if (!isDir(target)) throw new ApiError(400, `目录不存在: ${target}`)
  const overwrite = payload.overwrite === true
  const force = payload.force === true
  let scanned
  try {
    scanned = exporter.scanDomainDir(target)
  } catch (exc) {
    throw new ApiError(400, `读取目录失败: ${exc?.message || exc}`)
  }
  if (!Object.keys(scanned).length) {
    throw new ApiError(400, '该目录下没有发现任何语义域（需要含 table-cards.md 或 glossary.md 的子目录）')
  }
  const clashes = exporter.clashReport(scanned, store.getDomain, store.listFiles)
  if (clashes.length && !force && !overwrite) {
    throw new ApiError(409, `导入会覆盖已有域；确认请带 overwrite:true（受影响文件 ${clashes.length} 个）`,
      'SEMANTIC_IMPORT_WOULD_CLOBBER')
  }
  const edited = clashes.filter((row) => row.edited)
  if (edited.length && !force) {
    throw new ApiError(409,
      `导入会覆盖面板里改过的文件；确认请带 force:true（被覆盖 ${edited.length} 个）`,
      'SEMANTIC_IMPORT_WOULD_CLOBBER')
  }
  const imported = exporter.applyImport(scanned, target, store, overwrite)
  const indexResult = rebuildAfterWrite()
  const out = { imported, dir: target, indexOk: indexResult.ok }
  if (!indexResult.ok) out.indexError = indexResult.error || ''
  return out
}

function isDir(path) {
  return statIsDir(path)
}

// ---------------------------------------------------------------- refresh / config

export function handleRefresh(_query, _body = null, _headers = null) {
  /** POST /api/semantic/refresh —— 强制从 DB 重建检索索引。 */
  const started = performance.now()
  if (store.isEmpty()) {
    return {
      configured: false, index: indexPayload({ ready: false }),
      domains: 0, tookMs: 0,
      error: '还没有任何业务域（无需重建索引）',
    }
  }
  let stats
  try {
    stats = semanticIndex.ensure('', true)
  } catch (exc) {
    if (exc instanceof semanticIndex.SemanticIndexError
      || exc?.name === 'SemanticIndexError') {
      throw new ApiError(503, String(exc.message), 'SEMANTIC_INDEX_BUILDING')
    }
    throw exc
  }
  return {
    configured: true, index: indexPayload(stats),
    domains: store.listDomains().length,
    tookMs: Math.round(performance.now() - started),
  }
}

export function handleConfig(query, body = null, _headers = null) {
  /** POST /api/semantic/config —— 保存「DB 写出路径」并按需从 path 导入一次。
   *
   * 第 52 轮语义（用户裁决）：顶上的目录**不再是独立的导入源**，它统一成为
   * 「全库重建 → 写出到本地文件」的目标路径。保存路径时不强制目录已存在（导出时创建）；
   * 显式传 `import:true` 时才顺带把该目录当成语义资产读进来。
   *
   * 兼容：老客户端仍可传 `semanticDir`，等价于 `exportDir`。
   */
  const payload = common.bodyOf(body)
  let raw = common.textField(payload, 'exportDir', '', 'exportDir').trim()
  if (!raw) raw = common.textField(payload, 'semanticDir', '', 'semanticDir').trim()
  const path = raw ? resolve(raw) : ''
  if (path && payload.mustExist === true && !isDir(path)) {
    throw new ApiError(400, `目录不存在: ${path}`)
  }
  metaSet('semantic_export_dir', path)
  const out = {
    configured: store.listDomains().length > 0,
    exportDir: config.semanticExportDir(),
    dirSource: path ? 'panel' : 'env',
  }
  if (path && payload.import === true) {
    try {
      const scanned = exporter.scanDomainDir(path)
      out.imported = exporter.applyImport(scanned, path, store, false)
      const indexResult = rebuildAfterWrite()
      out.indexOk = indexResult.ok
    } catch (exc) {
      out.importError = String(exc?.message || exc) // 保存路径成功即可，导入失败如实上报
    }
  }
  out.domains = store.listDomains().length
  return out
}

export function healthSemantic() {
  /** /health 用：零成本（不建索引、不解析资产），不泄露绝对路径。 */
  const snap = semanticIndex.snapshot()
  return {
    configured: Boolean(snap.configured),
    indexReady: Boolean(snap.ready),
    domains: Number(snap.domains) || 0,
    assets: Number(snap.assets) || 0,
  }
}

// ---------------------------------------------------------------- 首次升级补种

export function seedFromSourceDir() {
  /** 老用户升级防线：库里 0 个域且配置了导入源目录 → 自动导入一次。
   *
   * 幂等：`semantic_meta.seeded` 记一次，之后即使又删光域也不会反复回灌。
   */
  if (store.metaGet('seeded')) return { seeded: false, reason: 'already' }
  const root = config.semanticDir()
  if (!root || !isDir(root)) return { seeded: false, reason: 'no_source' }
  if (!store.isEmpty()) {
    store.metaSet('seeded', nowStamp())
    return { seeded: false, reason: 'has_domains' }
  }
  let scanned
  try {
    scanned = exporter.scanDomainDir(root)
  } catch (exc) {
    return { seeded: false, reason: `scan_failed: ${exc?.message || exc}` }
  }
  if (!Object.keys(scanned).length) return { seeded: false, reason: 'no_domains_found' }
  const imported = exporter.applyImport(scanned, root, store, false)
  store.metaSet('seeded', nowStamp())
  try {
    semanticIndex.ensure('', true)
  } catch { /* 索引失败不影响补种结果 */ }
  return { seeded: true, imported }
}
