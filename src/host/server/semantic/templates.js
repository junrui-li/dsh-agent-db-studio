/**
 * 语义层文件模板（第 51 轮）：server/semantic/templates.py + templates/ 目录的移植。
 *
 * 新建域时生成 4 个骨架文件。模板里的示例内容一律放在代码块里 —— 因为
 * parser 的 heading / 术语表格识别是按行正则，代码块外裸露的 `### \`表名\``
 * 或 `| 术语 | \`表\` |` 会被误收成真实的表卡 / 术语（幽灵资产）。
 * 幽灵资产测试（tests/v3/v3-semantic-parser.test.mjs）守着这条。
 *
 * 与 Python 版的差异：.tmpl 内容在构建时内联成 JS 字符串常量（M4 会删 server/，
 * 不能依赖磁盘模板目录）。变量只有 {{domain}} / {{title}} / {{date}}；
 * 用 replaceAll 逐个替换，不上 format/mako —— 模板里大量 markdown 花括号会被当成占位符炸掉。
 */

/** 顺序即面板文件列表顺序，也是导出顺序。 */
export const DEFAULT_FILES = ["table-cards.md", "glossary.md", "query-samples.md", "prompt-template.md"]

const _TEMPLATES = {
  "table-cards.md": `
# {{domain}} 域表语义卡

> 域标题：{{title}}
> 创建时间：{{date}}
> 事实来源：面板「语义层」页维护（dbs.db 为唯一事实来源，本文件由「导出」生成）
> 维护约定：一张表一个小节，小节标题必须是 \`\`### 2.N \`表名\` \`\` 形式，否则索引不会把该表挂到本域。

## 0. 公共约定

| 约定 | 说明 |
|:---|:---|
| 逻辑删除 | 待补充：哪些表有 \`is_deleted\`，查询是否必须带 \`is_deleted = 0\` |
| 金额单位与精度 | 待补充：元 / 分；各表金额列精度档位 |
| 审计字段 | 待补充：\`gmt_create\` / \`gmt_modified\` 的语义与更新时机 |
| 归属库 | 待补充 |
| 编号链 | 待补充：哪些编号同值域、哪些禁止互相当 join 键 |

## 2. 表语义卡

> 在面板「关联数据表」里加表，系统会在这里自动插入骨架小节；之后正文由你接管。

## 3. 域内 JOIN 路径

> 按 P1、P2… 编号写清每一条可用的连接路径与必带的过滤条件。

| 编号 | 路径 | 必带条件 |
|:---|:---|:---|
| P1 | 待补充 | 待补充 |

## 4. 悬案与待确认

> 代码/DDL/业务文档三者不一致、或尚未只读库复核的点，登记在这里，不要在 SQL 里假设。

## 5. 卡片写法示例

下面这段是**格式示例**（在代码块里，不会进索引），替换成自己的内容时保持结构一致：

\`\`\`
### 2.1 \`your_table_name\` — 中文名

| 项 | 内容 |
|:---|:---|
| 中文名 | 待补充；别名：待补充 |
| 粒度声明 | 一行 = 什么 |
| 归属库 | demo_db |
| 业务唯一键 | \`xxx_id\`（幂等口径见 glossary） |

核心字段字典：

| 字段 | 类型 | 含义 |
|:---|:---|:---|
| xxx_id | String | 主键 |
| is_deleted | tinyint | 0=未删除、1=已删除 |

访问路径：按 \`xxx_id\` 点查。
通用过滤口径：\`is_deleted = 0\`。
\`\`\`
`,
  "glossary.md": `
# {{domain}} 域术语表与消歧规则

> 域标题：{{title}}
> 创建时间：{{date}}
> 配套资产：table-cards.md（表卡 / 枚举 / JOIN 路径）、query-samples.md（金标样例）、prompt-template.md（系统提示词）
> 作用：把用户的口语词映射到明确的表 / 字段 / 状态值，并登记容易搞错的口径。

## 1. 术语 → 表/字段映射

> 一行一个口语说法。**目标列必须含反引号标识符**（如 \`\` \`order_info\` \`\`），否则索引不会收录该术语。

| 术语（含常见说法） | 目标表/字段 | 说明 |
|:---|:---|:---|
| 待补充 | 待补充 | 待补充 |

## 2. 字段级同义词

| 常见说法 | 标准字段 | 说明 |
|:---|:---|:---|
| 待补充 | 待补充 | 待补充 |

## 3. 消歧规则

> 每条规则编号写清「什么情况下会搞错 → 正确做法」。这是本域最值钱的部分。

1. 待补充。

## 4. 状态口语映射

> **口语词与状态枚举不一致时以本表为准**（例如 \`FINISHED\` 不代表成功）。

| 口语 | 精确口径 |
|:---|:---|
| 待补充 | 待补充 |

## 5. 写法示例

下面这段是**格式示例**（在代码块里，不会进索引）：

\`\`\`
| 订单、交易订单 | \`order_info\` | 一行 = 一笔订单 |
| 已完成 | \`state = 'FINISHED'\`（⚠️ 不代表成功，成败看 success_amount） | — |
\`\`\`
`,
  "query-samples.md": `
# {{domain}} 域金标查询样例

> 域标题：{{title}}
> 创建时间：{{date}}
> 使用前提：先读 glossary.md 消歧与 table-cards.md 的 JOIN 路径，再照本文件的样例写 SQL。
> 结构约定：一个小节一个样例，标题必须是 \`### Sxx 标题\` 形式，才会被索引成金标样例。

## 模式一：明细查询

> 按主键 / 业务键取明细的常见写法。

## 模式二：状态统计

> 状态分布、滞留检测、按天聚合的口径。

## 模式三：口径核对

> 金额恒等式、跨表一致性核对。

## 样例写法示例

下面是**格式示例**，整体放在外层四反引号代码块里（不会进索引）。照这个结构写你自己的样例：

\`\`\`\`
### S01 按时间窗取某类记录

**问题**：近 7 天某类记录有哪些？

\`\`\`sql
SELECT xxx_id, state
FROM your_table_name
WHERE is_deleted = 0
  AND biz_type = 'SOME_ENUM'
  AND gmt_create >= DATE_SUB(NOW(), INTERVAL 7 DAY);
\`\`\`

- 考点：\`is_deleted = 0\` 必带；时间用半开区间。
- 执行校验状态：未执行。
\`\`\`\`
`,
  "prompt-template.md": `
# {{domain}} 域 NL2SQL 系统提示词模板

> 域标题：{{title}}
> 创建时间：{{date}}
> 用法：这一段是给模型看的硬规则，写得越具体越少错。规则编号，便于在回答里引用。

## 系统提示词

你是 demo_db 库 {{domain}}（{{title}}）域的业务查询 SQL 专家。你的任务是把用户的自然语言问题转化为口径正确、可直接执行的 MySQL 查询 SQL。

## 硬规则（违反即错误）

1. **逻辑删除必带**：待补充（哪些表有 \`is_deleted\`，一律带 \`is_deleted = 0\`）。
2. **金额单位统一**：待补充（元 / 分）。
3. **状态枚举以 glossary §4 为准**：待补充（哪些枚举容易误读）。
4. **JOIN 必带条件**：待补充（哪些表 join 时必须带 \`originator\` / \`fee_level\` 之类）。
5. **禁止跨库 JOIN**：待补充（跨库时按 table-cards §3 的桥接方案）。
6. **统计先定粒度**：待补充（主表行 vs 明细行，避免 1:N 重复计数）。

## 资产注入指引

| 问题特征 | 注入资产 |
|:---|:---|
| 含本域业务口语（待补充） | glossary.md（消歧） |
| 需要确定表和 JOIN 路径 | table-cards.md §2 表卡 + §3 JOIN 速查 |
| 状态统计 / 金额核对 | query-samples.md 对应模式 |
| 跨域 | 按 table-cards §3 引用其它域资产 |

## 自检清单（输出前逐项核对）

- [ ] 所有表带 \`is_deleted = 0\`（例外表已在 §硬规则 注明）
- [ ] 金额单位与精度档位正确
- [ ] 状态值是枚举字面量，不是中文口语
- [ ] 统计粒度明确，无 1:N 重复计数
- [ ] SELECT / WHERE / JOIN 中每个列名都能在 table-cards §2 字段字典里指出出处

## 写法示例

下面是**格式示例**（在代码块里，不会进索引）：

\`\`\`
1. **逻辑删除必带**：本域 5 张表均有 \`is_deleted\`，一律带 \`is_deleted = 0\`。
4. **JOIN 必带条件**：join 多来源共用的订单表时必须带 \`originator = 'SOME_ENUM'\`。
\`\`\`
`,
}

function _read(name) {
  const text = _TEMPLATES[name]
  if (text === undefined) {
    throw new Error(`未知模板: ${name}`)
  }
  return text
}

/** 渲染单个模板。name 是目标文件名（table-cards.md 等）。 */
export function render(name, domain, title = '', date = '') {
  const text = _read(name)
  const stamp = date || _today()
  return text
    .replaceAll('{{domain}}', domain)
    .replaceAll('{{title}}', title || domain)
    .replaceAll('{{date}}', stamp)
}

/** 生成新域的全套文件 → [[name, body, 'template']]，source 固定 template。 */
export function renderAll(domain, title = '', date = '') {
  return DEFAULT_FILES.map((name) => [name, render(name, domain, title, date), 'template'])
}

function _today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

// ---------------------------------------------------------------- store 接线

// Python 里 api 层调 templates.render_all() 后把 files 传给 store.create_domain；
// store 本身不依赖模板。这里把 renderAll 挂到 store 的注入点，保持 M3-S 预留的接缝可用。
import { hooks as storeHooks } from './store.js'
storeHooks.templates = renderAll
