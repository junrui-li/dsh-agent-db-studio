/**
 * 语义层领域仓储（第 51 轮）：dbs.db 是语义内容的**唯一事实来源**。
 * server/semantic/store.py 的逐函数移植（V3 去 sidecar）。
 *
 * 依赖链：api → semantic.index → semantic.store → store/db.js（无环）。
 * `semantic-index.db` 只是从本模块读出的文本派生的检索缓存，可随时删除重建。
 *
 * 设计要点（与 Python 版一致）：
 * - 每个写操作在同一事务里 bumpVersion()：`semantic_meta.content_version` 自增，
 *   索引层拿它当签名（O(1)，不再扫盘算 sha256）。
 * - 文件写入用 `revision` 乐观锁（跨标签页并发保存 → 409），`force` 可显式覆盖。
 * - 域↔表是多对多，带 role（owner 主属 / consumer 使用方视角）。owner 唯一性是
 *   **API 层软约束**，DB 不建 UNIQUE：真实资产里存在归属争议，硬约束会挡住导入。
 *
 * 与 Python 版的差异：
 * - row["col"]（sqlite3.Row）→ node:sqlite 返回的普通对象 row.col；
 *   row[0]（元组）→ 查询里起别名后取属性。
 * - Python 返回 2 元组的函数（save_file / append_sections）→ JS 返回二元数组，
 *   调用方 `const [ok, current] = saveFile(...)` 解构。
 * - STRICT 表 CHECK 约束照抄 store/db.js 的 _DDL（非法 role/source 插入直接抛
 *   node:sqlite 错误，与 Python sqlite3.IntegrityError 等价的失败形态）。
 * - template 模块（templates.py）不在 M3-S 范围：新建域的默认文件由 hooks.templates
 *   注入（形如 templates.render_all(domain, title) → [(name, body, source)]），
 *   默认 null = 与 Python「无模板」行为一致（调用方自己传 files）。
 */

import * as storeDbAlias from '../store/db.js'
import { fileKind, iterHeadingsTuples } from './parser.js'

/**
 * 测试 / 装配接缝：template 模块（templates.py + templates/ 目录）不在 M3-S 范围。
 * Python 里 store.create_domain 的 files 由 api 层调 templates.render_all() 传入，
 * store 本身不依赖模板；这里保留 hooks 作为 M3 后段 api/semantic.js 的注入点：
 * hooks.templates 形如 (domain, title) => [[name, body, source], ...]，
 * 默认 null = 与 Python「无模板」行为一致（调用方自己传 files）。
 */
export const hooks = { templates: null }

/** 仓储层业务错误（api 层翻译成 ApiError）。等价 SemanticStoreError。 */
export class SemanticStoreError extends Error {
  constructor(message, code = '') {
    super(String(message))
    this.name = 'SemanticStoreError'
    this.message = String(message)
    this.code = code || ''
  }
}

export const VALID_DOMAIN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/
export const VALID_FILE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\.md$/
export const SAMPLE_HEADING_RE = /^(S\d+)(?:\s|$)/
export const ROLES = ['owner', 'consumer']
export const KEY = 'content_version'

export function validDomain(domain) {
  return VALID_DOMAIN_RE.test(String(domain || ''))
}

/** 只接受 basename：**不允许路径分隔符**（防目录穿越）。 */
export function validFile(name) {
  return VALID_FILE_RE.test(String(name || ''))
}

function _s(value) {
  return value === null || value === undefined ? '' : String(value)
}

function _i(value, fallback = 0) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.trunc(parsed) : fallback
}

/** 与 api/common.now() 同格式（不反向依赖 api 层，保持依赖链单向）。 */
export function now() {
  const d = new Date()
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

// ---------------------------------------------------------------- meta / version

export function contentVersion() {
  const row = storeDbAlias.queryOne('SELECT value FROM semantic_meta WHERE key=?', [KEY])
  return row !== null && row.value !== null && row.value !== undefined
    ? String(row.value) : '0'
}

export function bumpVersion(conn) {
  const row = conn.prepare('SELECT value FROM semantic_meta WHERE key=?').get(KEY)
  const current = row !== undefined && row.value !== null && row.value !== undefined
    ? _i(row.value) : 0
  const value = String(current + 1)
  conn.prepare(
    'INSERT INTO semantic_meta(key, value) VALUES(?, ?)'
    + ' ON CONFLICT(key) DO UPDATE SET value=excluded.value',
  ).run(KEY, value)
  return value
}

export function metaGet(key, fallback = '') {
  const row = storeDbAlias.queryOne('SELECT value FROM semantic_meta WHERE key=?', [key])
  return row !== null && row.value !== null && row.value !== undefined
    ? String(row.value) : fallback
}

export function metaSet(key, value) {
  storeDbAlias.transaction((conn) => {
    conn.prepare(
      'INSERT INTO semantic_meta(key, value) VALUES(?, ?)'
      + ' ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(String(key), String(value))
  })
}

// ---------------------------------------------------------------- 域

function domainRow(row) {
  return {
    domain: row.domain, title: row.title || '',
    origin: row.origin || 'system',
    originDir: row.origin_dir || '',
    exportDir: row.export_dir || '',
    position: _i(row.position || 0),
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  }
}

export function listDomains() {
  const rows = storeDbAlias.queryAll('SELECT * FROM semantic_domain ORDER BY position, domain')
  const counts = new Map(storeDbAlias.queryAll(
    'SELECT domain, COUNT(*) AS n FROM semantic_doc GROUP BY domain',
  ).map((r) => [r.domain, _i(r.n)]))
  const out = []
  for (const row of rows) {
    const item = domainRow(row)
    item.files = counts.get(item.domain) ?? 0
    out.push(item)
  }
  return out
}

export function getDomain(domain) {
  const row = storeDbAlias.queryOne('SELECT * FROM semantic_domain WHERE domain=?', [domain])
  if (row === null) return null
  const item = domainRow(row)
  const count = storeDbAlias.queryOne('SELECT COUNT(*) AS n FROM semantic_doc WHERE domain=?', [domain])
  item.files = count !== null ? _i(count.n) : 0
  return item
}

/** 建域 + 一次性写入若干文件（模板或导入内容）。files=[[name, body, source], ...]。
 *
 * 与 Python 的差异：JS 没有关键字参数，originDir / exportDir 以 options 对象传入
 * （createDomain(domain, title, origin, files, { originDir, exportDir })），
 * 位置参数兼容旧调用（第 5 参为字符串时按 origin_dir 处理，对齐 Python 签名顺序）。 */
export function createDomain(domain, title, origin, files, originDirOrOpts = '', exportDirArg = '') {
  let originDir = ''
  let exportDir = ''
  if (originDirOrOpts !== null && typeof originDirOrOpts === 'object') {
    originDir = originDirOrOpts.originDir || ''
    exportDir = originDirOrOpts.exportDir || ''
  } else {
    originDir = originDirOrOpts || ''
    exportDir = exportDirArg || ''
  }
  if (!validDomain(domain)) {
    throw new SemanticStoreError(
      '域 id 只能是小写字母/数字/点/下划线/中划线，且以字母或数字开头（≤64 字符）',
      'SEMANTIC_DOMAIN_INVALID')
  }
  if (origin !== 'doc' && origin !== 'system') {
    throw new SemanticStoreError('origin 必须是 doc 或 system')
  }
  for (const entry of files || []) {
    const name = Array.isArray(entry) ? entry[0] : entry?.name
    if (!validFile(name)) {
      throw new SemanticStoreError(`非法文件名: ${name}`, 'SEMANTIC_FILE_UNKNOWN')
    }
  }
  const stamp = now()
  storeDbAlias.transaction((conn) => {
    if (conn.prepare('SELECT 1 FROM semantic_domain WHERE domain=?').get(domain)
      !== undefined) {
      throw new SemanticStoreError(`语义域已存在: ${domain}`, 'SEMANTIC_DOMAIN_EXISTS')
    }
    const position = conn.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM semantic_domain',
    ).get().p
    conn.prepare(
      'INSERT INTO semantic_domain (domain,title,origin,origin_dir,'
      + 'export_dir,position,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
    ).run(domain, title || domain, origin, originDir, exportDir,
      _i(position || 0), stamp, stamp)
    const stmt = conn.prepare(
      'INSERT INTO semantic_doc (domain,file,kind,body,source,revision,'
      + 'updated_at) VALUES (?,?,?,?,?,1,?)')
    for (const [name, body, source] of files || []) {
      stmt.run(domain, name, fileKind(name), body ?? '', source, stamp)
    }
    bumpVersion(conn)
  })
  return getDomain(domain)
}

export function updateDomain(domain, title = null, exportDir = null) {
  const sets = []
  const args = []
  if (title !== null) {
    sets.push('title = ?')
    args.push(String(title).trim() || domain)
  }
  if (exportDir !== null) {
    sets.push('export_dir = ?')
    args.push(String(exportDir || '').trim())
  }
  if (!sets.length) return getDomain(domain)
  sets.push('updated_at = ?')
  args.push(now())
  args.push(domain)
  storeDbAlias.transaction((conn) => {
    const cur = conn.prepare(
      `UPDATE semantic_domain SET ${sets.join(', ')} WHERE domain = ?`).run(...args)
    if (cur.changes !== 1) {
      throw new SemanticStoreError(`未知语义域: ${domain}`, 'SEMANTIC_DOMAIN_UNKNOWN')
    }
    bumpVersion(conn)
  })
  return getDomain(domain)
}

/** 只删 DB 记录，**不动导出目录里的文件**。 */
export function deleteDomain(domain) {
  return storeDbAlias.transaction((conn) => {
    const cur = conn.prepare('DELETE FROM semantic_domain WHERE domain=?').run(domain)
    if (cur.changes !== 1) return false
    conn.prepare('DELETE FROM semantic_doc WHERE domain=?').run(domain)
    conn.prepare('DELETE FROM semantic_domain_table WHERE domain=?').run(domain)
    bumpVersion(conn)
    return true
  })
}

// ---------------------------------------------------------------- 文件

function fileRow(row, withBody = false) {
  const item = {
    domain: row.domain, file: row.file, kind: row.kind || '',
    source: row.source || 'template',
    revision: _i(row.revision || 1),
    updatedAt: row.updated_at || '',
  }
  if (withBody) {
    item.text = row.body || ''
    item.chars = item.text.length
  }
  return item
}

export function listFiles(domain) {
  const rows = storeDbAlias.queryAll(
    'SELECT domain,file,kind,source,revision,updated_at,LENGTH(body) AS n '
    + 'FROM semantic_doc WHERE domain=? ORDER BY file', [domain])
  const out = []
  for (const row of rows) {
    const item = fileRow(row)
    item.chars = _i(row.n || 0)
    out.push(item)
  }
  return out
}

export function getFile(domain, file) {
  const row = storeDbAlias.queryOne(
    'SELECT * FROM semantic_doc WHERE domain=? AND file=?', [domain, file])
  return row !== null ? fileRow(row, true) : null
}

/** 写文件。返回 [ok, current]。ok=false 表示版本冲突，current 是最新内容。
 *
 * expectedRevision=null 且 force=false 时不做冲突检查（新建/无并发语义）。
 */
export function saveFile(domain, file, body, expectedRevision = null, force = false) {
  if (!validFile(file)) {
    throw new SemanticStoreError(`非法文件名: ${file}`, 'SEMANTIC_FILE_UNKNOWN')
  }
  if (expectedRevision !== null && expectedRevision !== undefined && expectedRevision !== ''
    && !Number.isInteger(Number(expectedRevision))) {
    throw new TypeError(`invalid literal for int() with base 10: ${JSON.stringify(expectedRevision)}`)
  }
  const stamp = now()
  let conflict = null
  storeDbAlias.transaction((conn) => {
    const row = conn.prepare(
      'SELECT body, revision FROM semantic_doc WHERE domain=? AND file=?',
    ).get(domain, file)
    if (row === undefined) {
      throw new SemanticStoreError(
        `未知语义文件: ${file}（${domain}）`, 'SEMANTIC_FILE_UNKNOWN')
    }
    const currentRevision = _i(row.revision || 1)
    if (!force && expectedRevision !== null && expectedRevision !== undefined
      && Number(expectedRevision) !== currentRevision) {
      conflict = { revision: currentRevision, text: row.body || '' }
      return
    }
    conn.prepare(
      "UPDATE semantic_doc SET body=?, source='edited', revision=?, "
      + 'updated_at=? WHERE domain=? AND file=?',
    ).run(body || '', currentRevision + 1, stamp, domain, file)
    conn.prepare(
      'UPDATE semantic_domain SET updated_at=? WHERE domain=?').run(stamp, domain)
    bumpVersion(conn)
  })
  if (conflict !== null) return [false, conflict]
  return [true, getFile(domain, file)]
}

/** 把若干 `### ...` 小节追加到文件末尾（蒸馏应用/骨架插入共用）。
 *
 * sections = [[anchor, markdown], ...]；返回 [newRevision, [[anchor, offset], ...]]。
 */
export function appendSections(domain, file, sections) {
  const stamp = now()
  let revisionOut = 0
  let places = []
  storeDbAlias.transaction((conn) => {
    const row = conn.prepare(
      'SELECT body, revision FROM semantic_doc WHERE domain=? AND file=?',
    ).get(domain, file)
    if (row === undefined) {
      throw new SemanticStoreError(
        `未知语义文件: ${file}（${domain}）`, 'SEMANTIC_FILE_UNKNOWN')
    }
    const text = row.body || ''
    let filled = text
    const computed = []
    for (const [anchor, block] of sections || []) {
      const piece = block.trim()
      if (!filled.endsWith('\n')) filled += '\n'
      const offset = filled.length + 1 // 下一行开头（+1 跳过上面补的换行）
      filled += '\n' + piece + '\n'
      computed.push([anchor, offset])
    }
    conn.prepare(
      "UPDATE semantic_doc SET body=?, source='edited', revision=?, "
      + 'updated_at=? WHERE domain=? AND file=?',
    ).run(filled, _i(row.revision || 1) + 1, stamp, domain, file)
    conn.prepare(
      'UPDATE semantic_domain SET updated_at=? WHERE domain=?').run(stamp, domain)
    bumpVersion(conn)
    revisionOut = _i(row.revision || 1) + 1
    places = computed
  })
  return [revisionOut, places]
}

/** query-samples.md 里现有最大的 Sxx 编号（新增样例接着编号）。
 *
 * 走 parser.iterHeadings：模板的「写法示例」里有一个 ``` 围栏包着的 `### S01`，
 * 不跳过围栏会让第一条真实样例被编成 S02。
 */
export function maxSampleNumber(domain) {
  const item = getFile(domain, 'query-samples.md')
  if (!item) return 0
  const numbers = []
  for (const [, , heading] of iterHeadingsTuples(item.text)) {
    const match = SAMPLE_HEADING_RE.exec(heading)
    if (match) numbers.push(Number.parseInt(match[1].slice(1), 10))
  }
  return numbers.length ? Math.max(...numbers) : 0
}

// ---------------------------------------------------------------- 域 ↔ 表

function dtRow(row) {
  return {
    domain: row.domain, connectionId: row.connection_id,
    database: row.database_name, table: row.table_name,
    role: row.role || 'consumer', note: row.note || '',
    position: _i(row.position || 0), addedAt: row.added_at || '',
  }
}

export function listDomainTables(domain) {
  const rows = storeDbAlias.queryAll(
    'SELECT * FROM semantic_domain_table WHERE domain=? '
    + 'ORDER BY position, table_name', [domain])
  return rows.map((row) => dtRow(row))
}

export function listAllDomainTables() {
  const rows = storeDbAlias.queryAll(
    'SELECT * FROM semantic_domain_table ORDER BY domain, position')
  return rows.map((row) => dtRow(row))
}

/** 反查：该库里每张表被哪些域引用 → {table: [{domain, role, note, unbound}]}。
 *
 * 同时返回两类关系（第 52 轮修复，AGENTS.md 硬规则 8）：
 * - **精确维度**（connection_id + database 都匹配）—— 面板里手工关联出来的；
 * - **未绑定维度的全局关系**（两个维度都是空串）—— `backfill` 从 table-cards.md
 *   回填出来的（资产里没有可靠的库名信息，只能记占位值）。
 *
 * 不把后者带上，回填出来的 64 张表在任何真实库反查里都查不到，弹窗就永远不可能打勾。
 */
export function tableRefs(connectionId, database) {
  const rows = storeDbAlias.queryAll(
    'SELECT * FROM semantic_domain_table WHERE '
    + "(connection_id=? AND database_name=?) "
    + "OR (connection_id='' AND database_name='') "
    + 'ORDER BY domain, table_name',
    [connectionId, database])
  const out = new Map()
  for (const row of rows) {
    const item = dtRow(row)
    if (!out.has(item.table)) out.set(item.table, [])
    out.get(item.table).push({
      domain: item.domain, role: item.role, note: item.note,
      unbound: !item.connectionId && !item.database,
    })
  }
  return Object.fromEntries(out)
}

/** 该域已登记的表名（小写 Set），供面板打勾时避开维度陷阱。 */
export function domainTableNames(domain) {
  const rows = storeDbAlias.queryAll(
    'SELECT table_name FROM semantic_domain_table WHERE domain=?', [domain])
  return new Set(rows.map((row) => String(row.table_name).toLowerCase()))
}

/** 该表的主属域（没有则空串）。owner 唯一是软约束：多条时取字典序最小。 */
export function ownerOf(connectionId, database, table) {
  const row = storeDbAlias.queryOne(
    "SELECT domain FROM semantic_domain_table WHERE connection_id=? "
    + "AND database_name=? AND table_name=? AND role='owner' "
    + 'ORDER BY domain LIMIT 1', [connectionId, database, table])
  return row !== null ? String(row.domain) : ''
}

/** 增删关联表。add/remove 元素：{connectionId, database, table, role?, note?}。 */
export function syncDomainTables(domain, add, remove) {
  const stamp = now()
  const added = []
  const removed = []
  storeDbAlias.transaction((conn) => {
    for (const item of remove || []) {
      const cur = conn.prepare(
        'DELETE FROM semantic_domain_table WHERE domain=? AND connection_id=? '
        + 'AND database_name=? AND table_name=?',
      ).run(domain, item.connectionId ?? '', item.database ?? '', item.table ?? '')
      if (cur.changes) removed.push(item.table ?? '')
    }
    const position = conn.prepare(
      'SELECT COALESCE(MAX(position), -1) + 1 AS p FROM semantic_domain_table '
      + 'WHERE domain=?', [domain]).get().p
    let offset = 0
    for (const item of add || []) {
      let role = item.role || 'consumer'
      if (!ROLES.includes(role)) role = 'consumer'
      const key = [domain, item.connectionId ?? '', item.database ?? '', item.table ?? '']
      const exists = conn.prepare(
        'SELECT 1 FROM semantic_domain_table WHERE domain=? AND '
        + 'connection_id=? AND database_name=? AND table_name=?',
      ).get(...key) !== undefined
      conn.prepare(
        'INSERT INTO semantic_domain_table (domain,connection_id,'
        + 'database_name,table_name,role,note,position,added_at) '
        + 'VALUES (?,?,?,?,?,?,?,?) '
        + 'ON CONFLICT(domain,connection_id,database_name,table_name) '
        + 'DO UPDATE SET role=excluded.role, note=excluded.note',
      ).run(...key, role, item.note || '', _i(position || 0) + offset, stamp)
      if (!exists) added.push(item.table ?? '')
      offset += 1
    }
    if (added.length || removed.length) {
      conn.prepare('UPDATE semantic_domain SET updated_at=? WHERE domain=?')
        .run(stamp, domain)
      bumpVersion(conn)
    }
  })
  return { added, removed }
}

// ---------------------------------------------------------------- 索引输入

/** 索引层唯一取数入口：[[domain, title, [[relfile, text], ...]], ...]，按 position 排序。
 *
 * relfile 形如 `pay/table-cards.md`（与 parser.parseDomain 的聚合口径一致）。
 */
export function listSources() {
  const rows = storeDbAlias.queryAll(
    'SELECT d.domain, d.title, f.file, f.body FROM semantic_domain d '
    + 'JOIN semantic_doc f ON f.domain = d.domain '
    + 'ORDER BY d.position, d.domain, f.file')
  const grouped = new Map()
  for (const row of rows) {
    const domain = row.domain
    const title = row.title
    if (!grouped.has(domain)) grouped.set(domain, { title: '', files: [] })
    const entry = grouped.get(domain)
    if (!entry.title && title) entry.title = title
    entry.files.push([`${domain}/${row.file}`, row.body || ''])
  }
  return [...grouped.entries()].map(([domain, entry]) => [domain, entry.title, entry.files])
}

export function isEmpty() {
  const row = storeDbAlias.queryOne('SELECT COUNT(*) AS n FROM semantic_domain')
  return Boolean(row) && _i(row.n) === 0
}
