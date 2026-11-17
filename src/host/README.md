# src/host —— Host 半片模块说明

Host 半片做五件事：**进程内数据库引擎**（V3：原 Python sidecar 收编进 Host 进程，无子进程、无端口）、
**把数据库能力注册成 agent 工具（20 个）**、**给浏览器半片一条带鉴权的代理通道**、
**给连接表单的「AI 分析字段」提供模型调用（脱敏 AI）**、
**注册 4 个只读 NL2SQL 工具与工作流系统提示**（恒定注册）。
契约见 `docs/CONTRACT.md` 第 2、4 节。

```
src/host.js            入口：export name / inject / apply(ctx, config)（另有 createRuntime 给测试注入）；语义层定时蒸馏器
src/host/config.js     配置归一（dataDir/allowWrites/writeMode/maxRows/timeout/undo/语义层）；旧 engine/pythonPath/port 残留静默忽略
src/host/error-hints.js 错误码 → 中文指引表（local-stack 复用）
src/host/server/       V3 进程内引擎：runtime.js（组装+迁移）、router.js（48 条路由）、local-stack.js
                       （supervisor/backend 同接口适配层，dispatch 直进 router）、core/（守卫/池/快照/门禁/脱敏）、
                       api/（路由 handler）、store/（node:sqlite 仓储）、semantic/（语义层解析/索引/导出/蒸馏）
src/host/browser.js    /db-studio 路由：鉴权（fail closed）、插件探针、脱敏 AI、语义层蒸馏、/api/** 代理
src/host/tools.js      16 个 db_* 工具的定义、执行、工单提交与写审批
src/host/ai.js         脱敏 AI 分析：模型解析与自动回退、masking 候选字段生成
src/host/distill.js    语义层 AI 蒸馏：候选 → 模型挑+整理 → 服务端校验 → 落 run（不写文件）
src/host/http-util.js  AI 通道共用的响应/错误小工具（永远 200 + 人话 error 的降级口径收在一处）
src/host/semantic.js   4 个只读语义工具（domains/search/asset/table-card），恒定注册
src/host/nl2sql-prompt.js  NL2SQL 工作流系统提示段文本（tool:db-studio:nl2sql，order 160）
src/host/render.js     output.render 用的有界人话格式化（截断、表格预览、TTL、计数）
src/host/clientBuild.js   Client 半片运行时文件（dist/client/index.js）的按需重建（parts 更新/缺失时）
src/host/clientBundleCore.js  parts → 单文件的唯一拼接实现（CLI 与 clientBuild 共用）
```

## 数据流

```
agent ── tool call ──> tools.js ──local-stack(dispatch)──> server/router.js（进程内，无 HTTP）
browser ── fetch /db-studio/api/** ──> browser.js（先鉴权）─┬─> local-stack.proxy ──> router /api/**
                                                          ├─> ai.js（/api/masking/suggest，直调 DSH 模型）
                                                          └─> distill.js（/api/semantic/distill[/apply]）
```

- 引擎与 Host 同进程：没有监听端口、没有进程间令牌；浏览器通道的鉴权靠 DSH
  `connection.requestRejection`（Host/Origin + 登录凭证，fail closed）。
- `X-DBS-Actor`：浏览器通道固定 `user`，工具调用固定 `agent`（工单 submittedBy 与历史 source 靠它区分）。
- 引擎日志（模型/解析失败等诊断）落 `<dataDir>/host.log`；响应里只带人话 error。

## 配置

| 键 | 缺省 | 说明 |
|---|---|---|
| `dataDir` | `''` | 空 = `<仓库>/server/data`（`dbs.db` / `semantic-index.db` / `undo/` / `exports/`；旧 JSON 首次启动迁移为 `*.json.migrated`） |
| `allowWrites` | false | false 时所有写工具（含「提交工单」「撤销」「结构化行写」）**不注册**进模型工具表，只剩只读能力。另有一道会话「写窗口」：allowWrites=true 时写执行还要求窗口开着（面板「临时开闸」，到时自动关），否则 403 WRITES_CLOSED |
| `writeMode` | `ticket` | `ticket`：`db_execute` 只建工单，人工在面板批准后执行；`direct`：过 `ctx.approval` 后立即执行 |
| `maxRows` | 500 | 单次查询默认返回行数上限 |
| `timeout` | 60 | 查询超时秒数（DbsConn 层执行超时参照它） |
| `undoMaxRows` | 1000 | 变更前快照单语句最大行数；<=0 关闭快照/撤销；超限的写标记「不可撤销」照常执行 |
| `undoKeep` | 50 | undo_log / 快照文件保留条数（超过淘汰最旧） |
| `semanticLayerPath` | `''` | 业务语义层的**文档导入源目录**（面板「导入文档目录」的来源）。**不是工具门禁**：4 个语义工具与提示段恒定注册，域由人在面板新建/导入。相对路径按仓库根解析 |
| `semanticMaxChars` | 8000 | 语义资产单次返回正文的最大字符数 |
| `semanticRefreshHours` | 0 | 语义层索引定时全量刷新间隔（小时，0-720）；0 = 关闭（刷新走面板手动按钮） |
| `semanticDistillHours` | 0 | 语义层「AI 蒸馏」定时巡检间隔（小时，0-720）；0 = 关闭。>0 时只产 `status='ready'` 的 run 记录供人在面板勾选，**绝不自动写文件**；失败只打日志 |

不声明 `export const Config`：缺省值与类型归一都在 `config.js` 里做，非法值报中文错。
`llm` / `agentDefaultModel` 也是**可选**依赖（不进 `export const inject`）：模型不可用时插件照常激活，
只是脱敏 AI 报 `available:false`。

## 工具一览（20 个；4 个语义工具恒定注册）

| 工具 | 参数 | 守卫 / 审批 |
|---|---|---|
| `db_status` | — | —（汇报引擎就绪、连接数、`writeMode`、待审批工单数、脱敏 AI 可用性、语义层状态） |
| `db_list_connections` | — | — |
| `db_list_databases` | connectionId | — |
| `db_list_tables` | connectionId, database | — |
| `db_describe_table` | connectionId, database, table, exactCount? | — |
| `db_query` | connectionId, database?, sql, maxRows?, purpose? | 引擎对所有连接强制只读白名单；SELECT 先过慢 SQL 门禁；purpose 随历史落库 |
| `db_execute` | connectionId, database?, sql, **background**(ticket) / reason(direct), title? | ticket：只建工单、不走 approval；direct：`ctx.approval` + `/api/execute` |
| `db_write_rows` | connectionId, database, table, rows 操作 | 结构化行写；与 db_execute 同一套写窗口 + 工单/审批守卫 |
| `db_undo_last` | — | 撤销最近一次可撤销变更；ticket 模式报告、direct 模式过审批后执行 |
| `db_export_query` | connectionId, database?, sql, title? | 建导出工单，人工批准后流式取数落盘，面板下载 |
| `db_list_tickets` | status?, limit? | — |
| `db_get_ticket` | id | — |
| `db_list_history` | limit?, connectionId?, keyword? | — |
| `db_redis_scan` | connectionId, database?, match?, cursor?, count? | 禁 `KEYS` |
| `db_redis_key` | connectionId, database?, key | — |
| `db_redis_command` | connectionId, database?, command | 只读白名单外的命令一律先审批；`KEYS`/`SELECT` 本地拦截 |
| `db_list_semantic_domains` | — | 恒定注册；业务问题第一步。没有域时提示去面板 + 新建 / 导入文档目录 |
| `db_search_semantics` | query, domain?, file?, limit?(1-20), snippetChars? | 同上；LIKE + 结构化打分 |
| `db_get_semantic_asset` | domain, file, section?, offset?, maxChars?(500-20000) | 同上；不传 section = 文件目录 |
| `db_get_table_card` | table, domain?, maxChars? | 同上；未建卡 = 空 matches + 建议检索；多卡区分「主属卡」/「使用方视角卡（主属：X）」|

**没有任何「批准工单」的工具**，这是刻意的：agent 只能提交和查询工单，审批入口只在浏览器面板。
工具描述里也写明了这一点，别为了"顺手"补一个 `db_approve_ticket`。

**多语句工单**：`db_execute` 的 `sql` 允许 `;` 分隔的多条语句。拆分与逐条守卫都在引擎（`core/sqlsplit.js` + 守卫），
工具层只透传、不自己拆；批准后整张工单在**同一个事务**里按顺序执行，任一条失败整体回滚。
`db_execute`/`db_get_ticket`/`db_list_tickets` 的 render 会同时给「合计预估行数」和「逐条明细（含语句预览）」。

错误统一 `throw new Error('中文原因')`；`output.render` 只返回
`[{type:'text', text:'给人看的一句摘要 + 关键数据'}]`，完整 JSON 走 `output.schema`。

### 结果呈现的三种「不是全成功」

按契约 §3.3，HTTP 200 不等于全成功，`renderResults` 对三种情况都显式说明：

- **HTTP 200 + `results[last].error`**：多语句出错即停，已成功的结果照常返回；
  render 打 `⚠ 语句出错：…（出错即停，后续语句未执行）`。
- **`truncated=true`**：`error=null` 但结果不是全量，render 打
  `⚠ 已截断：命中 maxRows/… 行上限`。
- **空结果**：render 打 `结果为空（0 行）`，避免模型把空表当失败。
- HTTP 4xx/5xx（READONLY / NO_WHERE / KEYS_DISABLED / SELECT_DISABLED / TICKET_STATE …）在
  `local-stack.js` 里翻译成中文并附引擎说明，工具直接抛给模型。

## 脱敏 AI 分析（ai.js）与 NL2SQL 语义工具（semantic.js）

**ai.js**（服务连接表单「AI 分析字段」）：
- 模型解析：`ctx.get('llm')` + `ctx.get('agentDefaultModel').currentSelection()`（`prepareCall`）。
- 默认选择指向已删除 provider 时**自动回退**其它已注册 provider 的模型（每 provider ≤2 个、总共 ≤3 个）；
  显式指定的模型失败不回退（避免「以为切了其实没切」）。
- `/db-studio/api/masking/suggest` 只**产候选字段**（读 schema 元数据，不读数据行），模型不可用时回退引擎规则分析。

**semantic.js + nl2sql-prompt.js**（恒定注册）：
- 4 个只读工具走引擎 `/api/semantic/*`，超时 15s、并发安全。
- `src/host.js` 检测到 `ctx.get('systemPrompt')` 可用时注册 `tool:db-studio:nl2sql` 提示段（order 160，≤1500 字）。
- 「还没有业务域」是引擎 `configured:false` 的正常状态（域由人在面板新建/导入），不是工具没启用；
  `db_status` 显示「语义层：还没有业务域」并指向面板。

**distill.js（AI 蒸馏）**：
- 路由：`POST /db-studio/api/semantic/distill`（跑一次）、`POST .../distill/apply`（人工勾选后应用）。都在泛代理之前、走同一层鉴权。
- 流程：引擎 `/api/semantic/distill/candidates` 出确定性候选（SQL 已脱敏归一，频次/表名/用途也算好）
  → 模型**只做「挑 + 整理」** → **服务端硬校验** → 引擎 `/api/semantic/distill/run` 存 run（`status='ready'`）。
- **防幻觉硬校验**：模型给的 SQL 归一后（折叠空白、去尾分号、小写）必须**逐字等于**输入里的某条候选，
  且归一后仍必须是只读 SELECT（`WITH ... SELECT` 收，多语句/写/DDL 丢）；命中后一律回填**输入的原始 SQL**，模型文本不采信。
- 降级（与 suggestMasking 同一口径）：模型不可用/超时（90s）/解析失败/引擎失败一律 **200 + `candidates:[]` + 人话 `error`**，绝不 5xx、绝不白屏。
- 定时蒸馏（`semanticDistillHours>0`）：unref 定时器，`trigger='scheduled'`，**只产 run 记录、绝不调 apply（不写文件）**；失败只打日志。

## 数据脱敏（工具层只读、不脱敏）

连接级脱敏（契约 §3.7）由**引擎在结果出站前**完成，Host 与工具层拿到的已经是掩码值：

- `tools.js` 只做两件事：`db_status` 汇总「几个连接开了脱敏 / 共多少字段」，`db_list_connections` 标出 `· 脱敏`。
- **工具层没有任何脱敏、还原、二次处理逻辑**，也没有 `unmask`/`reveal` 类参数（单测里有安全边界断言）。
- `ai.js` 的 `/db-studio/api/masking/suggest` 只**产候选字段**（读 schema 元数据，不读数据行），模型不可用时回退引擎规则分析。

## 本地验证

需要 Node ≥24（`node:sqlite` STRICT 表 + `import.meta.dirname`）。

```bash
node scripts/build-client.mjs --check        # Client 生成物一致性
node tests/client/check-client.mjs           # Client 装配基础断言
node tests/client/check-client-full.mjs      # Client 全量结构/交互冒烟（822 项）
node tests/ai/ai-tests.mjs                   # 脱敏分析、模型解析回退、代理、AI 蒸馏（39 项）
node tests/v3/run-all.mjs                    # V3 主套件（20 文件 519 例）
node tests/v3/e2e-local-engine.mjs           # 引擎组装/路由/生命周期 e2e（自包含）
node tests/v3/e2e-undo-tool.mjs              # 撤销链路 e2e（自包含，pool 打桩不触真库）
```

真数据 e2e（`e2e-tools-local` / `e2e-export` / `e2e-distill` / `e2e-semantic-tools`）依赖本机
`server/data/dbs.db`（不入库）：缺失或 `DBS_E2E_REAL=0` 时整套优雅跳过，公开环境验收以上面自包含套件为准。

## 已知边界

- 引擎只服务本机，Host 不做多用户隔离。工单审批是「单用户本地工具」模型：谁能开面板谁就能批。
- 浏览器代理只透传 `/api/**` 与 `/db-studio/api/{health,masking/suggest,semantic/distill[/apply]}`，不代理任意路径。
- `db_redis_command` 只读判定用命令白名单（不含 `CLIENT`/`MEMORY`/`DEBUG` 这类能踢连接或改
  行为的命令），白名单外一律当写命令先审批（fail safe）——契约 §3.4 明确：可写连接上的
  `DEL/UNLINK/FLUSHDB/FLUSHALL` 引擎不拦，Host 审批是唯一防线。
- Redis 命令不走工单（不是 SQL 语句），仍用 `ctx.approval`。
- 进程内引擎无残留子进程：卸载/热重载走 `dispose()` 顺序关闭 MySQL/Redis 池与 SQLite 句柄。