/**
 * 把「关联数据表」落成 table-cards.md 的骨架小节（第 51 轮需求 #3）。
 * server/semantic/skeleton.py 的逐函数移植（V3 去 sidecar）。
 *
 * 行为约定（本方案最重要的一条）：
 * **只在关联表时插入一次骨架，之后正文由编辑器独占**。关联表增删不再回写
 * markdown —— 否则 DB 与 markdown 会互相覆盖，用户改过的正文会被系统悄悄抹掉。
 *
 * 编号规则：
 * - 新卡编号 = 现有 `### 2.N` 的最大 N + 1；
 * - **删除关联不重排号**（重排会让 agent 历史回答里引用过的 anchor 失效），允许空洞。
 *
 * 两种卡：
 * - role=owner     → 完整卡：粒度声明 + 核心字段字典 + 归属库 + 通用过滤口径
 * - role=consumer  → 使用方视角卡：指向主属域的卡，不复制字段字典
 *   （真实资产里 bill-clearing §2.9 的写法）
 *
 * 回填口径（AGENTS.md 硬规则 8）：cards_of() 只扫 `## 2.`~`## 5.`（`## 1.` 是域级
 * 枚举，`### 1.1 扣款交易状态 \`trade_state\`` 会因白名单前缀被误收成表）。
 */

import { headingTables, iterHeadingsTuples } from './parser.js'

export const SECTION2_RE = /^##\s+2(?:\.|\s|$)/m
export const FENCE_LINE_RE = /^\s*(`{3,}|~{3,})/
export const HEADING_LINE_RE = /^###\s+(.*?)\s*$/
export const CARD_HEADING_RE = /^2\.(\d+)(?:\s|$)/

/** 下一个可用的 `2.N` 锚点（无 2.x 卡时从 2.1 开始）。
 *
 * 走 parser.iterHeadings 而不是直接正则：模板的代码块示例里写了 `### 2.1`，
 * 不跳过围栏会让新建域的第一张真实卡被编成 2.2。
 */
export function nextAnchor(text) {
  const numbers = []
  for (const [, level, heading] of iterHeadingsTuples(text || '')) {
    if (level !== 3) continue
    const m = CARD_HEADING_RE.exec(heading)
    if (m) numbers.push(Number.parseInt(m[1], 10))
  }
  return `2.${numbers.length ? Math.max(...numbers) + 1 : 1}`
}

function fieldDictionary(columns) {
  if (!columns || !columns.length) {
    return '| 字段 | 类型 | 含义 |\n|:---|:---|:---|\n| 待补充 | 待补充 | 待补充 |\n'
  }
  const lines = ['| 字段 | 类型 | 含义 |', '|:---|:---|:---|']
  for (const column of columns.slice(0, 80)) {
    const name = String(column?.name || '')
    if (!name) continue
    const ctype = String(column?.type || '').trim() || '-'
    const comment = String(column?.comment || '').trim()
    const extra = []
    if (column?.key === 'PRI') extra.push('主键')
    if (comment) extra.push(comment)
    const meaning = extra.length ? extra.join('；') : '待补充'
    lines.push(`| \`${name}\` | ${ctype} | ${meaning} |`)
  }
  if (columns.length > 80) {
    lines.push(`| … | | 另有 ${columns.length - 80} 列未列出 |`)
  }
  return lines.join('\n') + '\n'
}

/** 生成一个表卡小节正文（`### 2.<占位>` 由 insertCards 再换真锚点）。 */
export function renderCard(table, role, tableComment = '', database = '',
  columns = null, ownerDomain = '', ownerAnchor = '', note = '') {
  const title = `\`${table}\`` + (tableComment ? ` — ${tableComment}` : '')
  if (role === 'consumer') {
    const suffix = ownerDomain ? `（使用方视角 · 主属 ${ownerDomain}）` : '（使用方视角）'
    const ref = ownerDomain && ownerAnchor
      ? `${ownerDomain}/table-cards.md §${ownerAnchor}`
      : ownerDomain ? `${ownerDomain}/table-cards.md`
        : '待补充（主属域尚未建卡）'
    const lines = [
      `### 2.0 ${title}${suffix}`, '',
      `> 本域只描述「为什么关心这张表、怎么用」，字段字典与枚举以主属卡为准：${ref}`,
      '', `- 本域用途：${note || '待补充'}`,
      `- 归属库：${database || '待补充'}`,
      '- 使用注意：待补充（必带过滤条件 / 关联键）',
    ]
    return lines.join('\n') + '\n'
  }
  const lines = [`### 2.0 ${title}`, '']
  lines.push('| 项 | 内容 |')
  lines.push('|:---|:---|')
  lines.push('| 中文名 | 待补充；别名：待补充 |')
  lines.push('| 粒度声明 | 待补充：一行 = 什么 |')
  lines.push(`| 归属库 | ${database || '待补充'} |`)
  lines.push('| 业务唯一键 | 待补充 |')
  lines.push('')
  lines.push('核心字段字典：')
  lines.push('')
  lines.push(fieldDictionary(columns).replace(/\n+$/, ''))
  lines.push('')
  lines.push('访问路径：待补充。')
  lines.push('')
  lines.push('通用过滤口径：待补充（逻辑删除 / 状态枚举 / 金额单位）。')
  return lines.join('\n') + '\n'
}

/** 把 renderCard 里的占位编号 2.0 换成真实锚点。 */
function renumber(block, anchor) {
  return block.replace(/^###\s+2\.0\s/m, `### ${anchor} `)
}

/** 把若干卡插进 table-cards.md 的 `## 2.` 章节末尾。
 *
 * cards = [{table, role, tableComment, database, columns, ownerDomain,
 *           ownerAnchor, note}]
 * 返回 [newText, [{table, anchor, role}]]。
 */
export function insertCards(text, cards) {
  let current = text || ''
  const placed = []
  for (const card of cards || []) {
    const anchor = nextAnchor(current)
    const block = renumber(renderCard(
      card.table ?? '',
      card.role || 'consumer',
      card.tableComment || '',
      card.database || '',
      card.columns ?? null,
      card.ownerDomain || '',
      card.ownerAnchor || '',
      card.note || '',
    ), anchor)
    current = appendToSection2(current, block)
    placed.push({ table: card.table ?? '', anchor, role: card.role || 'consumer' })
  }
  return [current, placed]
}

/** 插到 `## 2.` 章节最后一个 `###` 之后；没有 `## 2.` 就追加到文件末尾。 */
function appendToSection2(text, block) {
  const match = SECTION2_RE.exec(text)
  if (match === null) {
    return text.replace(/\n+$/, '') + '\n\n' + block + '\n'
  }
  const start = match.index + match[0].length
  // 找下一个二级标题（`## ` 开头但不是 `## 2.`），作为本章节结束
  const tail = text.slice(start)
  const endMatch = /^##\s+(?!2(?:\.|\s|$))/m.exec(tail)
  const sectionEnd = start + (endMatch ? endMatch.index : tail.length)
  const head = text.slice(0, start)
  const body = text.slice(start, sectionEnd)
  const rest = text.slice(sectionEnd)
  return head + body.replace(/\n+$/, '') + '\n\n' + block + '\n' + rest
}

// ---------------------------------------------------------------- 回填（第 52 轮）

/** 表卡所在章节的编号白名单：`## 2. 表语义卡` 是标准段落；
 * demo-base-data 那类老资产把卡放在 §3/§4/§5（分组 A/B/C）。
 * §1 是「域级枚举」（`### 1.1 扣款交易状态 \`trade_state\`` 这种），**不是表卡** ——
 * 白名单前缀会把 `bill_*` 枚举误收成表，回填时必须按章节排除。 */
export const CARD_SECTIONS = ['2', '3', '4', '5']

/** 解析 table-cards.md → [{table, anchor, role, ownerDomain, level}]（按表名去重）。
 *
 * 用途是「把已有资产里的表重新关联回业务域」（用户需求 #6）：
 * 不重新插卡、不重编号，只读出现有的卡标题。
 *
 * **表名识别直接复用 parser.headingTables**，与索引层同一套规则
 * （主属卡 `### 2.N \`表名\`` + demo-base-data 那种分组式 `### 3.2 tbl_bill（…）`
 * 回退 + 白名单反引号）。自己再写一套必然走样。
 *
 * 额外的两道过滤（回填专用，索引层不需要）：
 * 1. **只看表卡章节**（§2~§5）—— §1 的域级枚举会把 `fee_level` / `order_type`
 *    这类枚举名误收成表；
 * 2. **同一张表在本域只保留一条**，主属卡优先于使用方视角卡。
 */
export function cardsOf(text) {
  const byTable = new Map()
  let section = ''
  let inFence = false
  for (const line of String(text || '').split('\n')) {
    if (FENCE_LINE_RE.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const level2 = /^##\s+(\d+)/.exec(line)
    if (level2) {
      section = level2[1]
      continue
    }
    if (!CARD_SECTIONS.includes(section)) continue
    const heading = HEADING_LINE_RE.exec(line)
    if (heading === null) continue
    const names = headingTables(heading[1])
    if (!names.length) continue
    const caption = heading[1]
    const anchorMatch = /^(\d+(?:\.\d+)*)/.exec(caption)
    const anchor = anchorMatch ? anchorMatch[1] : ''
    const consumer = caption.includes('使用方视角')
    const ownerMatch = /主属\s*([a-z0-9][a-z0-9._-]*)/.exec(caption)
    for (const name of names) {
      const key = name.toLowerCase()
      const card = {
        table: name,
        anchor,
        role: consumer || ownerMatch ? 'consumer' : 'owner',
        ownerDomain: ownerMatch ? ownerMatch[1] : '',
        level: 3,
      }
      const prior = byTable.get(key)
      if (prior === undefined || (prior.role === 'consumer' && card.role === 'owner')) {
        byTable.set(key, card)
      }
    }
  }
  return [...byTable.values()]
}

/** 同一张表在本域如果有卡：主属卡优先，否则使用方视角卡。 */
export function ownerOfTable(cards, table) {
  const lowered = String(table).toLowerCase()
  for (const card of cards || []) {
    if (card.table.toLowerCase() === lowered && card.role === 'owner') return 'owner'
  }
  for (const card of cards || []) {
    if (card.table.toLowerCase() === lowered) return card.role
  }
  return ''
}
