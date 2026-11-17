/**
 * 语义层 Markdown 解析（只读）：server/semantic/parser.py 的逐函数移植（V3 去 sidecar）。
 *
 * 按 `^#{1,4} ` 切 section（anchor = 标题前导编号如 2.1，否则 slug）。
 * 容错点（计划 §12 风险 11）：
 * - 域发现 = 含 table-cards.md 或 glossary.md 的子目录；README.md 不算域。
 * - metrics.md 实际已不存在 / 缺任意文件 → 全部容忍，缺啥少啥。
 * - 表卡两级识别：`### 数字 \`表名\`` 优先；demo-base-data 分组式回退
 *   （无反引号标识符 + 白名单前缀 + 跟全角/半角括号），再加标题内白名单反引号标识符。
 * - 术语 = glossary 表格行（目标格含反引号标识符即收，含口语映射表）。
 * - 样例 = `### Sxx 标题`，问题取 `**问题**：` 行，SQL 取代码块，其余为 notes。
 *
 * 硬规则（AGENTS.md #7）：heading / 术语表格识别按行正则，围栏内的行跳过 ——
 * 否则 ```sql 里的 `# 注释` 与 `| 表格 |` 行会被切成幽灵 section / 术语。
 * 正则逐字对齐 parser.py：_HEADING / _FENCE / _NUM_ANCHOR / _SAMPLE / _CARD_BT /
 * _IDENT_PAREN / _BT_ANY / _BT_LOOSE / _QUESTION / _CODE_FENCE / _SLUG_OK。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const HEADING_RE = /^(#{1,4})\s+(.*?)\s*$/
// 围栏代码块（``` 或 ~~~）。语义层资产大量用 ```sql 写样例，块里出现的
// `# 注释` 行与 `| 表格 |` 行会被逐行正则误切成 section / 术语（幽灵资产）。
// 第 51 轮起：围栏内的行不参与 heading 与术语表格识别，但仍原样留在 section 正文里。
export const FENCE_RE = /^\s*(`{3,}|~{3,})/
export const NUM_ANCHOR_RE = /^(\d+(?:\.\d+)*)\.?(?:\s|$)/
export const SAMPLE_RE = /^#{1,4}\s+(S\d+)\s+(.*)$/
export const CARD_BT_RE = /^`([A-Za-z_][A-Za-z0-9_]*)`/
export const IDENT_PAREN_RE = /([A-Za-z_][A-Za-z0-9_]*)\s*[（(]/g
export const BT_ANY_RE = /`([A-Za-z_][A-Za-z0-9_]*)`/g
// 术语目标格：允许 `表.列='值'` 复合口径
export const BT_LOOSE_RE = /`([^`\n]+)`/g
export const QUESTION_RE = /^\*\*问题\*\*[：:]\s*(.*)$/
export const CODE_FENCE_RE = /```[a-zA-Z]*\n([\s\S]*?)```/
export const SLUG_OK_RE = /[A-Za-z0-9\u4e00-\u9fff]+/g
// 白名单前缀（计划 B2）；计划的裸 `j` 收紧为 `j_`（避免误收 join 等普通词）
export const TABLE_PREFIX = ['bill', 'trade', 'work_order', 'hub', 'fin', 'etc',
  'ssp', 'ql', 'tbl', 'j_', 'oe_']
export const FILE_KINDS = [['table-cards.md', 'card'], ['glossary.md', 'glossary'],
  ['query-samples.md', 'samples'], ['prompt-template.md', 'prompt'],
  ['metrics.md', 'metric']]

/** 文件名 → kind（与 templates.DEFAULT_FILES 同口径；不认识的落 doc）。 */
export function fileKind(name) {
  const low = String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase()
  for (const [suffix, kind] of FILE_KINDS) {
    if (low === suffix) return kind
  }
  return 'doc'
}

export function slugify(text) {
  const parts = String(text || '').toLowerCase().match(SLUG_OK_RE) || []
  return (parts.join('-').slice(0, 80)) || 'section'
}

/** 围栏感知的标题扫描 → [{lineno, level, heading}]（1-based 行号）。
 *
 * 与 splitSections 同一套规则，供需要「真实标题」的调用方复用
 * （骨架编号、客户端目录导航都按它算，避免把 ```sql 里的 `# 注释` 当标题）。
 * Python 返回 [(lineno, level, heading)] 三元组；JS 侧用对象数组，
 * 顺序语义一致。
 */
export function iterHeadings(text) {
  const out = []
  let inFence = false
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = HEADING_RE.exec(line)
    if (m) out.push({ lineno: i + 1, level: m[1].length, heading: m[2] })
  }
  return out
}

/** Python iter_headings 的元组形态（[lineno, level, heading]），给对齐用例用。 */
export function iterHeadingsTuples(text) {
  return iterHeadings(text).map((h) => [h.lineno, h.level, h.heading])
}

function makeAnchor(heading) {
  const m = NUM_ANCHOR_RE.exec(heading)
  if (m) return m[1]
  const stripped = heading.replace(NUM_ANCHOR_RE, '').trim()
  return slugify(stripped || heading)
}

function isTableIdent(ident) {
  const low = ident.toLowerCase()
  return TABLE_PREFIX.some((prefix) => low.startsWith(prefix))
}

/** 标题里的表名：主属卡（反引号打头）+ 分组式（标识符+括号）+ 白名单反引号。 */
export function headingTables(heading) {
  const names = []
  const body = heading.replace(NUM_ANCHOR_RE, '').trim()
  const m = CARD_BT_RE.exec(body)
  if (m) names.push(m[1])
  // 全局正则（带 g）用 matchAll 拿分组 1；IDENT_PAREN_RE / BT_ANY_RE 每次
  // matchAll 自带独立 lastIndex，无需手动重置。
  for (const match of body.matchAll(IDENT_PAREN_RE)) {
    const ident = match[1]
    if (isTableIdent(ident) && !names.includes(ident)) names.push(ident)
  }
  for (const match of body.matchAll(BT_ANY_RE)) {
    const ident = match[1]
    if (isTableIdent(ident) && !names.includes(ident)) names.push(ident)
  }
  return names
}

/** glossary 表格行 → [{term, target}]。目标格含反引号标识符即收（含口语映射表）。 */
export function tableRows(body) {
  const rows = []
  let inFence = false
  for (const line of String(body || '').split('\n')) {
    if (FENCE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const text = line.trim()
    if (!text.startsWith('|') || [...text].every((ch) => '|-: '.includes(ch))) {
      continue
    }
    const cells = text.replace(/^\|/, '').replace(/\|$/, '').split('|')
      .map((c) => c.trim())
    if (cells.length < 2 || !cells[0]) continue
    const targets = []
    for (const cell of cells.slice(1)) {
      for (const match of [...cell.matchAll(BT_LOOSE_RE)]) targets.push(match[1])
    }
    if (!targets.length) continue
    // Python: cells[0].strip("*` ").strip() —— 只剥两端，不剥中间
    const term = cells[0].replace(/^[*`\s]+/, '').replace(/[*`\s]+$/, '').trim()
    if (term && term.length < 120) rows.push({ term, target: targets[0] })
  }
  return rows
}

/** (level, heading, line, body) 列表；文件级前言 body 不成 section。
 *
 * 围栏代码块内的 `#` 行不算 heading（否则 ```sql 里的注释会切成幽灵小节）。
 * 注意围栏行的判定在 heading 判定之前（Python：`if _FENCE.match(line): in_fence
 * = not in_fence` 之后 `m = None if in_fence else ...`——同一行的围栏标记
 * 先翻转状态，本行不再按 heading 处理）。
 */
export function splitSections(text) {
  const sections = []
  let cur = null
  let buf = []
  let inFence = false
  const lines = String(text || '').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (FENCE_RE.test(line)) inFence = !inFence
    const m = inFence ? null : HEADING_RE.exec(line)
    if (m) {
      if (cur !== null) {
        sections.push({ level: cur.level, heading: cur.heading, line: cur.line, body: buf.join('\n').trim() })
      }
      cur = { level: m[1].length, heading: m[2], line: i + 1 }
      buf = []
    } else if (cur !== null) {
      buf.push(line)
    }
  }
  if (cur !== null) {
    sections.push({ level: cur.level, heading: cur.heading, line: cur.line, body: buf.join('\n').trim() })
  }
  return sections
}

/** 单文件解析 → {file, kind, title, sections, tables, terms, samples}。 */
export function parseDocument(domain, relfile, text) {
  const kind = fileKind(relfile)
  let title = ''
  const sections = []
  const tables = []
  const terms = []
  const samples = []
  const usedAnchors = new Set()

  const secs = splitSections(text)
  for (let i = 0; i < secs.length; i++) {
    const ord = i + 1
    const { level, heading, line, body } = secs[i]
    if (!title && level === 1) title = heading.trim()
    const sm = SAMPLE_RE.exec(`${'#'.repeat(level)} ${heading}`)
    let anchor
    if (sm) {
      anchor = sm[1] // Sxx 样例锚 = 编号本身
    } else {
      anchor = makeAnchor(heading)
    }
    const base = anchor
    let n = 2
    while (usedAnchors.has(anchor)) { // 同文件 anchor 去重
      anchor = `${base}-${n}`
      n += 1
    }
    usedAnchors.add(anchor)

    let sample = null
    let secKind = ''
    if (sm) {
      let question = ''
      const rest = []
      for (const row of body.split('\n')) {
        const qm = QUESTION_RE.exec(row.trim())
        if (qm && !question) {
          question = qm[1].trim()
        } else if (!row.trim().startsWith('```')) {
          rest.push(row)
        }
      }
      const fence = CODE_FENCE_RE.exec(body)
      const sql = fence ? fence[1].trim() : ''
      const notes = rest.join('\n').trim()
      sample = { sid: sm[1], title: sm[2].trim(), question, sql, notes: notes.slice(0, 2000) }
      secKind = 'sample'
    }

    const heads = headingTables(heading)
    if (heads && level <= 4 && ['card', 'doc', 'glossary'].includes(kind)) {
      for (const name of heads) tables.push({ table: name, ord, anchor })
    }
    const rows = kind === 'glossary' ? tableRows(body) : []
    if (rows) {
      for (const { term, target } of rows) {
        terms.push({ term, target, ord, anchor })
      }
    }

    if (!secKind) {
      // Python 空列表是 falsy；JS 空数组是 truthy，必须判 length
      secKind = heads.length ? 'table'
        : rows.length ? 'term'
          : ['prompt', 'metric'].includes(kind) ? kind : 'doc'
    }
    sections.push({
      ord, anchor, heading: heading.trim(), level, line, body,
      kind: secKind,
      searchText: `${heading}\n${body}`.slice(0, 100000),
      tables: heads, terms: rows,
      sample,
    })
  }
  return {
    file: String(relfile || '').replace(/\\/g, '/'), kind, title,
    sections, tables, terms, samples,
  }
}

/** 含 table-cards.md 或 glossary.md 的子目录 = 域（README.md 不算域）。
 * 目录排序对齐 Python sorted(os.listdir(root))。 */
export function discoverDomains(root) {
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const domains = []
  for (const name of entries.slice().sort()) {
    const dpath = join(root, name)
    try {
      if (!statSync(dpath).isDirectory()) continue
    } catch {
      continue
    }
    if (isFile(dpath, 'table-cards.md') || isFile(dpath, 'glossary.md')) {
      domains.push(name)
    }
  }
  return domains
}

function isFile(dir, name) {
  try {
    return statSync(join(dir, name)).isFile()
  } catch {
    return false
  }
}

/** 解析单个域：返回域级聚合（docs/sections/tables/terms/samples）。 */
export function parseDomain(root, domain) {
  const dpath = join(root, domain)
  let files = []
  try {
    files = readdirSync(dpath).filter((fn) => fn.toLowerCase().endsWith('.md')).sort()
  } catch {
    files = []
  }
  const agg = { domain, title: '', docs: [], sections: [], tables: [], terms: [], samples: [] }
  for (const fn of files) {
    const rel = `${domain}/${fn}`
    let text = ''
    try {
      text = readFileSync(join(dpath, fn), 'utf8')
    } catch {
      continue
    }
    const doc = parseDocument(domain, rel, text)
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

/** 全量解析 → 域列表（按域名排序）。 */
export function parseRoot(root) {
  return discoverDomains(root).map((d) => parseDomain(root, d))
}
