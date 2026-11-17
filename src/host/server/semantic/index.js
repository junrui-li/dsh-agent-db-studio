/**
 * 语义层索引 SQLite（独立 <dataDir>/semantic-index.db，与业务 dbs.db 生命周期不同）
 * server/semantic/index.py 的逐函数移植（V3 去 sidecar）。
 *
 * 第 51 轮起**事实来源是 dbs.db**（semantic/store.js）：本模块只负责把仓储里的文本
 * 解析成可检索的索引，`semantic-index.db` 随时可删可重建，删了不丢内容。
 *
 * - 模块级单连接（node:sqlite DatabaseSync，同步调用天然串行，无需 RLock）
 *   + WAL（pragma 风格同计划 §4 A1）。不 import store/db.js 的连接，只在重建时读它的数据。
 * - ensure() 按 `semantic_meta.content_version` 签名幂等重建（O(1)，不再扫盘算 sha256）；
 *   失败 ROLLBACK 保留旧索引并抛 SemanticIndexError（api 层转 503 SEMANTIC_INDEX_BUILDING）。
 * - snapshot() 只读 meta，不建索引（/health 零成本用）。
 */

import { mkdirSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import * as config from '../core/config.js'
import { parseDocument } from './parser.js'
import * as store from './store.js'

/**
 * 可测试性接缝：测试用 monkeypatch 语义覆写 _parseDomain（对齐 Python
 * test_ensure_builds_and_idempotent 的计数桩）。生产代码不读不写它。
 */
export const hooks = { _parseDomain: null }

let _conn = null
let _connPath = null
let _stampSeq = 0
let _lastWall = 0

/** 索引重建失败（旧索引已保留）。 */
export class SemanticIndexError extends Error {
  constructor(message) {
    super(String(message))
    this.name = 'SemanticIndexError'
    this.message = String(message)
  }
}

const _DDL = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS semantic_domains (
  domain TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '',
  files INT NOT NULL DEFAULT 0, tables INT NOT NULL DEFAULT 0,
  samples INT NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS semantic_docs (
  domain TEXT NOT NULL, file TEXT NOT NULL, kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '', PRIMARY KEY (domain, file));
CREATE TABLE IF NOT EXISTS semantic_sections (
  domain TEXT NOT NULL, file TEXT NOT NULL, ord INT NOT NULL,
  anchor TEXT NOT NULL, heading TEXT NOT NULL, level INT NOT NULL,
  line INT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL,
  search_text TEXT NOT NULL, PRIMARY KEY (domain, file, ord));
CREATE TABLE IF NOT EXISTS semantic_tables (
  domain TEXT NOT NULL, file TEXT NOT NULL, ord INT NOT NULL,
  anchor TEXT NOT NULL, table_name TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_st_name ON semantic_tables (table_name);
CREATE TABLE IF NOT EXISTS semantic_terms (
  domain TEXT NOT NULL, file TEXT NOT NULL, ord INT NOT NULL,
  anchor TEXT NOT NULL, term TEXT NOT NULL, target TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_term ON semantic_terms (term);
CREATE TABLE IF NOT EXISTS semantic_samples (
  domain TEXT NOT NULL, file TEXT NOT NULL, ord INT NOT NULL,
  anchor TEXT NOT NULL, sid TEXT NOT NULL, title TEXT NOT NULL,
  question TEXT NOT NULL DEFAULT '', sql TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '', line INT NOT NULL DEFAULT 0);
`

const _TABLES = ['semantic_domains', 'semantic_docs', 'semantic_sections',
  'semantic_tables', 'semantic_terms', 'semantic_samples']

function _nowStamp() {
  /** 同秒、同毫秒内两次重建也能区分（第 52 轮加单调序号）。
   *
   * 只到毫秒不够：现代机器上「改内容 → 重建 → 比较 builtAt」整个循环可能
   * 在一毫秒内跑完（真实机器复现过），毫秒级时间戳会撞车。序号在进程内
   * 单调递增，保证任何两次重建的 builtAt 都不同（测试断言依赖这一点）。
   * 形如 `2026-11-13 12:20:47.415-0002`，序号只在同毫秒撞车时才非 0000。
   */
  const nowMs = Date.now()
  const ms = nowMs % 1000
  if (nowMs / 1000 - _lastWall < 0.001) {
    _stampSeq += 1
  } else {
    _stampSeq = 0
  }
  _lastWall = nowMs / 1000
  const d = new Date(nowMs)
  const p = (n, w = 2) => String(n).padStart(w, '0')
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return `${stamp}.${String(ms).padStart(3, '0')}-${String(_stampSeq).padStart(4, '0')}`
}

function _connect(path) {
  const conn = new DatabaseSync(path)
  conn.exec('PRAGMA journal_mode=WAL')
  conn.exec('PRAGMA synchronous=NORMAL')
  conn.exec('PRAGMA busy_timeout=5000')
  return conn
}

function _getConn() {
  /** 按索引路径复用模块级连接；路径变化（测试切 DBS_DATA_DIR）时重开。 */
  const path = config.semanticIndexPath()
  if (_conn !== null && _connPath === path) return _conn
  if (_conn !== null) {
    try { _conn.close() } catch { /* 忽略 */ }
    _conn = null
  }
  mkdirSync(dirname(path), { recursive: true })
  _conn = _connect(path)
  _connPath = path
  _conn.exec(_DDL)
  return _conn
}

/** 测试收尾（Windows 下 rmtree 需先释放句柄）。 */
export function closeAll() {
  if (_conn !== null) {
    try { _conn.close() } catch { /* 忽略 */ }
  }
  _conn = null
  _connPath = null
}

function _metaGet(conn, key) {
  const row = conn.prepare('SELECT value FROM meta WHERE key=?').get(key)
  return row === undefined ? null : row.value
}

/** 索引签名 = 仓储内容版本号（任何语义写操作都会 +1）。
 *
 * 取代第 18~50 轮按磁盘目录算 sha256(relpath,size,mtime) 的做法：
 * 事实来源换成 dbs.db 之后，盘上文件只是导出产物，扫盘既慢又不是真相。
 */
export function contentSignature() {
  try {
    return 'v' + store.contentVersion()
  } catch {
    return ''
  }
}

/** 把仓储里一个域的全部文本解析成与 parser.parseDomain 同形的聚合。
 *
 * 走 parser.parseDocument（同一套解析规则），只是文本来自 DB 而不是磁盘。
 * 导出下划线名：Python 测试 monkeypatch `semantic_index._parse_domain`，JS 对齐。
 */
export function _parseDomain(domain, title, files) {
  const agg = { domain, title: title || '', docs: [], sections: [], tables: [], terms: [], samples: [] }
  for (const [relfile, text] of files) {
    const doc = parseDocument(domain, relfile, text)
    agg.docs.push({ file: doc.file, kind: doc.kind, title: doc.title })
    for (const s of doc.sections) agg.sections.push({ ...s, file: doc.file })
    for (const t of doc.terms) agg.terms.push({ ...t, domain, file: doc.file })
    for (const t of doc.tables) agg.tables.push({ ...t, domain, file: doc.file })
    for (const sec of doc.sections) {
      if (sec.sample) {
        agg.samples.push({ ...sec.sample, domain, file: doc.file, ord: sec.ord, anchor: sec.anchor, line: sec.line })
      }
    }
    if (!agg.title && doc.title) agg.title = doc.title
  }
  return agg
}

/** 单事务全量重建；失败 ROLLBACK 保留旧索引。 */
function _rebuild(conn, signature) {
  const parseFn = typeof hooks._parseDomain === 'function' ? hooks._parseDomain : _parseDomain
  const domains = store.listSources()
    .map(([domain, title, files]) => parseFn(domain, title, files))
  let counts = null
  try {
    conn.exec('BEGIN IMMEDIATE')
    for (const table of _TABLES) conn.exec(`DELETE FROM ${table}`)
    for (const agg of domains) {
      conn.prepare(
        'INSERT INTO semantic_domains (domain,title,files,tables,samples) '
        + 'VALUES (?,?,?,?,?)',
      ).run(agg.domain, agg.title || agg.domain, agg.docs.length, agg.tables.length, agg.samples.length)
      const docStmt = conn.prepare(
        'INSERT INTO semantic_docs (domain,file,kind,title) VALUES (?,?,?,?)')
      for (const d of agg.docs) docStmt.run(agg.domain, d.file, d.kind, d.title)
      const secStmt = conn.prepare(
        'INSERT INTO semantic_sections (domain,file,ord,anchor,heading,'
        + 'level,line,kind,body,search_text) VALUES (?,?,?,?,?,?,?,?,?,?)')
      for (const s of agg.sections) {
        secStmt.run(agg.domain, s.file, s.ord, s.anchor, s.heading,
          s.level, s.line, s.kind, s.body, s.searchText)
      }
      const tabStmt = conn.prepare(
        'INSERT INTO semantic_tables (domain,file,ord,anchor,table_name) '
        + 'VALUES (?,?,?,?,?)')
      for (const t of agg.tables) {
        tabStmt.run(agg.domain, t.file, t.ord, t.anchor, t.table)
      }
      const termStmt = conn.prepare(
        'INSERT INTO semantic_terms (domain,file,ord,anchor,term,target) '
        + 'VALUES (?,?,?,?,?,?)')
      for (const t of agg.terms) {
        termStmt.run(agg.domain, t.file, t.ord, t.anchor, t.term, t.target)
      }
      const sampStmt = conn.prepare(
        'INSERT INTO semantic_samples (domain,file,ord,anchor,sid,title,'
        + 'question,sql,notes,line) VALUES (?,?,?,?,?,?,?,?,?,?)')
      for (const s of agg.samples) {
        sampStmt.run(agg.domain, s.file, s.ord, s.anchor, s.sid,
          s.title, s.question, s.sql, s.notes, s.line)
      }
    }
    counts = {
      domains: domains.length,
      docs: conn.prepare('SELECT COUNT(*) AS n FROM semantic_docs').get().n,
      sections: conn.prepare('SELECT COUNT(*) AS n FROM semantic_sections').get().n,
      tables: conn.prepare('SELECT COUNT(*) AS n FROM semantic_tables').get().n,
      terms: conn.prepare('SELECT COUNT(*) AS n FROM semantic_terms').get().n,
      samples: conn.prepare('SELECT COUNT(*) AS n FROM semantic_samples').get().n,
    }
    const metaStmt = conn.prepare('INSERT OR REPLACE INTO meta (key,value) VALUES (?,?)')
    metaStmt.run('signature', signature)
    metaStmt.run('built_at', _nowStamp())
    metaStmt.run('assets', String(counts.docs))
    metaStmt.run('sections', String(counts.sections))
    metaStmt.run('domains', String(counts.domains))
    conn.exec('COMMIT')
  } catch (error) {
    try { conn.exec('ROLLBACK') } catch { /* 事务可能已回滚 */ }
    throw new SemanticIndexError(`语义层索引重建失败: ${error?.message || error}`)
  }
  return {
    ready: true, builtAt: _metaGet(conn, 'built_at') || '',
    stale: false, assets: counts.docs, ...counts,
  }
}

/** 幂等路径与重建路径返回**同一套 key**（含 docs/tables/terms/samples），
 * 否则调用方按 stats["tables"] 取值时会在「签名没变」的分支上 KeyError。 */
function _stats(conn, signature = '') {
  const counts = {
    docs: conn.prepare('SELECT COUNT(*) AS n FROM semantic_docs').get().n,
    sections: conn.prepare('SELECT COUNT(*) AS n FROM semantic_sections').get().n,
    tables: conn.prepare('SELECT COUNT(*) AS n FROM semantic_tables').get().n,
    terms: conn.prepare('SELECT COUNT(*) AS n FROM semantic_terms').get().n,
    samples: conn.prepare('SELECT COUNT(*) AS n FROM semantic_samples').get().n,
  }
  const domains = conn.prepare('SELECT COUNT(*) AS n FROM semantic_domains').get().n
  const builtAt = _metaGet(conn, 'built_at') || ''
  const stored = _metaGet(conn, 'signature') || ''
  const stale = Boolean(signature) && Boolean(stored) && stored !== signature
  return {
    ready: Boolean(builtAt), builtAt,
    assets: counts.docs,
    sections: counts.sections, domains,
    stale, ...counts,
  }
}

/** 按内容版本签名幂等建索引（Node 单线程内天然无并发）。
 *
 * 第 51 轮起没有「未配置」这一说：事实来源是 dbs.db，0 个域也是一份合法内容
 * （建出空索引，调用方看到 domains=0）。`root` 参数保留只为兼容老调用点，忽略。
 */
export function ensure(root = '', force = false) {
  const conn = _getConn()
  const signature = contentSignature()
  const stored = _metaGet(conn, 'signature') || ''
  if (!force && stored === signature && _metaGet(conn, 'built_at')) {
    return _stats(conn, signature)
  }
  return _rebuild(conn, signature)
}

/** 只读 meta / 计数，绝不触发重建（/health 零成本）。 */
export function snapshot() {
  if (store.isEmpty()) {
    return { configured: false, ready: false, builtAt: '',
      assets: 0, sections: 0, domains: 0, stale: false }
  }
  const signature = contentSignature()
  if (_conn !== null && _connPath === config.semanticIndexPath()) {
    return { configured: true, ..._stats(_conn, signature) }
  }
  const path = config.semanticIndexPath()
  let exists = false
  try {
    exists = statSync(path).isFile()
  } catch {
    exists = false
  }
  if (!exists) {
    return { configured: true, ready: false, builtAt: '',
      assets: 0, sections: 0, domains: 0, stale: false }
  }
  const conn = _connect(path)
  try {
    return { configured: true, ..._stats(conn, signature) }
  } finally {
    conn.close()
  }
}

/** search / api 复用模块级连接（先 ensure 过才安全）。 */
export function connShared() {
  return _getConn()
}
