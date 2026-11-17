/**
 * NL2SQL 工作流系统提示段（Phase C3）。
 *
 * 这里只导出文本常量：由 src/host.js 在「配置了语义层」时通过
 * `ctx.get('systemPrompt')` 可选注册（name: 'tool:db-studio:nl2sql', order: 160），
 * 不写硬 inject。文本 ≤1500 字（约 300 token），内容覆盖计划 §6 C3 的 ①-⑥：
 * 何时必查语义层 / 工作流 / 硬规则 / 输出要求 / 退化策略 / 自检清单。
 */

export const NL2SQL_PROMPT_SECTION = {
  name: 'tool:db-studio:nl2sql',
  order: 160,
}

export const NL2SQL_PROMPT_TEXT = `# db-studio 业务语义层（NL2SQL）

回答业务问题（指标、状态分布、金额、跨表口径）时，第一步先查语义层：用 db_list_semantic_domains 看清业务域，再按流程取数，不要直接凭表名猜 SQL。

## 工作流
1. db_list_semantic_domains：看清业务域与资产概况；
2. db_search_semantics：按关键词定位表卡/术语/样例；
3. db_get_semantic_asset(file=glossary.md)：先读术语表消歧，确认口语词对应的表与字段；
4. db_get_table_card：定表、定列、定 JOIN 路径（跨库禁止直接 JOIN 时按卡的桥接方案）；
5. db_get_semantic_asset(file=query-samples.md)：参考金标样例的问题/SQL/注意点；
6. 生成 SQL → 自检 → db_query 只读执行（每次调用带 purpose=一句话说明本次回答的业务问题，便于历史分组；agent 的 SELECT 会先过 EXPLAIN 慢 SQL 门禁：大表全表扫描（type=ALL 且表数据量达分档阈值，默认 50 万行）或估算行数超限，任一命中即被 SLOW_SQL_RISK 拒绝并附执行计划，按提示收窄过滤/改走索引列/加 LIMIT 后重试（小表全表扫描可放行））；需要写数据时改走 db_execute 提交工单，由人工审批。

## 硬规则
- 只允许使用表语义卡中出现过的表和列；卡里没有的列不要编造。
- 过滤口径必须带全：逻辑删除标记（如 is_deleted）、状态枚举值、金额单位（元/分）以资产为准，不要想当然。
- 状态枚举与口语词不一致时（如 FINISHED 不代表成功），以语义层资产的定义为准。
- 跨库表禁止直接 JOIN；按资产给出的中间表/桥接路径处理。
- 口径模糊（如「退款成功率」的分母）先向用户澄清，不要硬编一个口径。

## 输出要求
- 回答必须引用用到的资产锚点（domain/file/section/anchor）。
- 明确列出你做的假设（时间窗、过滤口径、金额单位）；没把握的写「口径待确认」。

## 退化策略
- 表未建卡或语义层检索不到：退化为 db_list_tables/db_describe_table 的 schema 探查，
  并在回答中声明「无业务语义资产，口径未确认」，不要假装口径可靠。

## 自检清单（执行 SQL 前逐项过）
1. 所有表/列都在卡或 glossary 里出现过？
2. is_deleted/状态枚举/金额单位过滤带上了？
3. 多表 JOIN 在同一库且路径有资产依据？
4. SQL 只读（SELECT/SHOW/DESC/EXPLAIN）？写操作走工单了吗？
5. 回答里引用了锚点并列出假设？
6. 有全表扫描（type=ALL）或大表估算行数超高？任一条都会被门禁拦下，先自己收窄条件、改走索引列。`
