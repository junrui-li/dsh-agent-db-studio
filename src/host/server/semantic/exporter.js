/**
 * 语义资产导出 / 导入：本项目**唯一**的磁盘读写面（第 51 轮）。
 * server/semantic/exporter.py 的逐函数移植（V3 去 sidecar）。
 *
 * 方向约定（裁决 Q2=C）：
 * - 出站：exportDomain() / writeFile() —— 把 DB 内容写成 `<dir>/<domain>/<file>.md`。
 * - 入站：scanDomainDir() / applyImport() —— 把某个目录的域读进 DB。
 * - **盘上文件被外部改动不会自动回流**；只能显式「从目录重新导入」。
 * - 写盘目标优先级（第 52 轮，AGENTS.md 硬规则 6）：该域 export_dir > 顶部
 *   「DB 写出路径」（DBS_SEMANTIC_EXPORT_DIR / meta.semantic_export_dir）；
 *   都没有则只写 DB 并回 writeNoTarget（判断在 api 层，本模块只负责写盘）。
 *
 * 安全：
 * - 域名与文件名都经过 semantic/store.js 的白名单正则（无路径分隔符）；
 * - 写盘前 realpath 断言目标仍在导出根目录下（防目录穿越/符号链接逃逸）；
 * - 原子写：先写 `.tmp` 再 rename，避免半截文件被当成真资产。
 */

import {
  mkdirSync, openSync, closeSync, writeSync, readFileSync, readdirSync,
  realpathSync, renameSync, statSync, fstatSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import * as store from './store.js'

/** 导出/导入业务错误（等价 exporter.ExportError）。 */
export class ExportError extends Error {
  constructor(message) {
    super(String(message))
    this.name = 'ExportError'
    this.message = String(message)
  }
}

// ---------------------------------------------------------------- 出站

/** 校验并返回最终绝对路径（断言仍在 root 下）。
 *
 * Python os.path.realpath：对**每个路径分量**做符号链接解析，不存在分量原样保留。
 * Node 的 realpathSync 要求全链存在；这里按 deepest-existing ancestor 分段解析
 * 对齐 Python 语义（导出目录首次导出时才创建，写盘前可能还不存在）。 */
function pythonRealpath(p) {
  let abs = resolve(p)
  const driveMatch = /^([A-Za-z]:)(?:$|\\)/.exec(abs)
  let head = ''
  let rest = abs
  if (driveMatch) {
    head = driveMatch[1]
    rest = abs.slice(head.length)
  }
  const parts = rest.split(/[\\/]/).filter((part) => part !== '' && part !== '.')
  let resolved = head
  let i = 0
  // 找到最深的已存在前缀
  while (i < parts.length) {
    const candidate = resolved ? join(resolved, parts[i]) : parts[i]
    let ok = false
    try { statSync(candidate); ok = true } catch { ok = false }
    if (!ok) break
    resolved = candidate
    i += 1
  }
  if (i < parts.length) {
    try { resolved = realpathSync(resolved) } catch { /* 前缀也没了：原样返回 */ }
    resolved = join(resolved, ...parts.slice(i))
  }
  return resolved
}

function expandHome(root) {
  const raw = String(root || '')
  if (raw === '~') return process.env.USERPROFILE || process.env.HOME || raw
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    const home = process.env.USERPROFILE || process.env.HOME || ''
    return home ? join(home, raw.slice(2)) : raw
  }
  return raw
}

/** 校验并返回最终绝对路径（断言仍在 root 下）。 */
function safeTarget(root, domain, filename) {
  if (!store.validDomain(domain)) throw new ExportError(`非法域名: ${domain}`)
  if (!store.validFile(filename)) throw new ExportError(`非法文件名: ${filename}`)
  const base = pythonRealpath(expandHome(root))
  const directory = pythonRealpath(join(base, domain))
  const target = pythonRealpath(join(directory, filename))
  if (!target.startsWith(directory + '\\') && !target.startsWith(directory + '/')
    && target !== directory) {
    throw new ExportError(`拒绝写出目录之外: ${target}`)
  }
  return target
}

/** 原子写单个文件，返回最终路径。 */
export function writeFile(root, domain, filename, text) {
  const target = safeTarget(root, domain, filename)
  const directory = dirname(target)
  mkdirSync(directory, { recursive: true })
  const tmp = target + '.tmp'
  // Python: open(tmp, "w", encoding="utf-8", newline="\n") —— 不换行翻译。
  const fh = openSync(tmp, 'w')
  try {
    writeSync(fh, String(text || ''), null, 'utf8')
    fstatSync(fh)
  } finally {
    closeSync(fh)
  }
  renameSync(tmp, target)
  return target
}

/** 把该域的全部文件写到 `<root>/<domain>/`。files 来自 store.listFiles()。 */
export function exportDomain(root, domain, files, getFile) {
  const wrote = []
  for (const item of files || []) {
    const name = item.file
    const row = getFile(domain, name)
    if (row === null) continue
    const path = writeFile(root, domain, name, row.text || '')
    wrote.push({
      file: name, path,
      bytes: Buffer.byteLength(row.text || '', 'utf8'),
    })
  }
  return wrote
}

// ---------------------------------------------------------------- 入站

/** 扫描目录 → {domain: {title, files: [[name, text], ...]}}。
 *
 * 与 parser.discoverDomains 同一口径：含 table-cards.md 或 glossary.md 的子目录
 * 才算域；域内**所有** .md 都收（真实资产里有 hub-tollwaste.md 这种第 5 个文件）。
 */
export function scanDomainDir(root) {
  const base = resolve(expandHome(String(root || '')))
  const out = {}
  let entries
  try {
    entries = readdirSync(base)
  } catch (exc) {
    throw new ExportError(`读取目录失败: ${exc?.message || exc}`)
  }
  for (const name of entries.slice().sort()) {
    const path = join(base, name)
    try {
      if (!statSync(path).isDirectory()) continue
    } catch {
      continue
    }
    let files
    try {
      files = readdirSync(path).filter((fn) => fn.toLowerCase().endsWith('.md')).sort()
    } catch {
      continue
    }
    if (!files.includes('table-cards.md') && !files.includes('glossary.md')) continue
    const loaded = []
    let title = ''
    // 域标题优先取 table-cards.md 的 h1（那是"域的名字"）；没有才退回其它文件。
    // 不能简单按文件名排序取第一个：glossary.md 排在前面，它的 h1 是"xx 术语表"。
    const ordered = files.slice().sort((a, b) =>
      (a !== 'table-cards.md') - (b !== 'table-cards.md') || (a < b ? -1 : a > b ? 1 : 0))
    for (const filename of ordered) {
      if (!store.validFile(filename)) continue // 带奇怪字符的文件名直接跳过，不进 DB
      let body
      try {
        body = readFileSync(join(path, filename), 'utf8')
      } catch {
        continue
      }
      loaded.push([filename, body])
      if (!title) {
        for (const line of body.split('\n')) {
          if (line.startsWith('# ')) {
            title = line.slice(2).trim()
            break
          }
        }
      }
    }
    loaded.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) // 入库顺序仍按文件名，保持稳定
    if (loaded.length) {
      out[name] = { title: title || name, files: loaded }
    }
  }
  return out
}

/** 导入前的影响面：哪些域名已存在、哪些文件会被覆盖、其中哪些被人工改过。 */
export function clashReport(scanned, getDomain, listFiles) {
  const rows = []
  for (const [domain, payload] of Object.entries(scanned || {})) {
    const existing = getDomain(domain)
    if (existing === null) continue
    const current = new Map((listFiles(domain) || []).map((item) => [item.file, item]))
    for (const [filename] of payload.files || []) {
      const prior = current.get(filename)
      if (prior === undefined) continue
      rows.push({
        domain, file: filename,
        edited: prior.source === 'edited',
        revision: Number(prior.revision) || 1,
      })
    }
  }
  return rows
}

/** 把扫描结果写进 DB。已存在的域：overwrite=false 时只补缺文件，不覆盖。 */
export function applyImport(scanned, root, storeModule, overwrite = false) {
  const mod = storeModule || store
  let domains = 0
  let filesWritten = 0
  const skipped = []
  for (const [domain, payload] of Object.entries(scanned || {})) {
    const existing = mod.getDomain(domain)
    if (existing === null) {
      mod.createDomain(
        domain, payload.title, 'doc',
        payload.files.map(([name, body]) => [name, body, 'imported']),
        root)
      domains += 1
      filesWritten += payload.files.length
      continue
    }
    mod.updateDomain(domain, null, existing.exportDir || '')
    const current = new Map((mod.listFiles(domain) || []).map((item) => [item.file, item]))
    for (const [filename, body] of payload.files || []) {
      if (current.has(filename) && !overwrite) {
        skipped.push({ domain, file: filename })
        continue
      }
      try {
        mod.saveFile(domain, filename, body, null, true)
      } catch (exc) {
        if (exc instanceof store.SemanticStoreError
          || exc?.name === 'SemanticStoreError') continue
        throw exc
      }
      filesWritten += 1
    }
  }
  return { domains, files: filesWritten, skipped: skipped.length }
}
