# dsh-db-studio 接口契约 v1

> 这份文件是接口与行为的唯一权威：改动必须先改这里，再改实现。

## 1. 仓库布局

```
<repo>/
├─ package.json            # bundle 清单
├─ cordis.patch.yml        # 插件行与默认 config
├─ icon.svg
├─ docs/CONTRACT.md        # 本文件
├─ src/
│  ├─ host.js              # Host 半片入口：进程内引擎组装 + 工具 + 代理（拆在 src/host/*.js）
│  └─ client/parts/*.js    # Client 半片源码（分区文件按文件名排序拼接）
├─ scripts/build-client.mjs  # Client 构建（生成 dist/client/index.js，不入库）
└─ tests/                  # client / ai / v3 三组断言 + 引擎 e2e
```

**dist/client/index.js 是生成物**：不要读、不要改、不要提交；改 parts 后跑 `node scripts/build-client.mjs`。

## 2. 进程模型（V3 收编：进程内实现，无 sidecar）

后端是 Host 插件进程内的一个模块（`src/host/server/`），**没有子进程、没有监听端口、没有令牌**。
浏览器通道（§4.1）与 agent 工具（§4.2）消费的 `getJson/postJson/proxy/fetchHealth` 四个入口
接口形状不变；传输从 HTTP 换成进程内 `router.dispatch`。

- **配置等价物**：V2 的 `DBS_*` 环境变量仍存在——插件配置在引擎组装时注入 `process.env`
  （`DBS_DATA_DIR`/`DBS_MAX_ROWS`/`DBS_TIMEOUT`/`DBS_SEMANTIC_DIR`/`DBS_SEMANTIC_EXPORT_DIR`/
  `DBS_SEMANTIC_MAX_CHARS`/`DBS_SEMANTIC_REFRESH_HOURS`/`DBS_UNDO_MAX_ROWS`/`DBS_UNDO_KEEP`），
  测试与文档沿用同一套变量名。`DBS_PORT`/`DBS_TOKEN` 随 sidecar 消失。
- **数据目录布局不变**：`dbs.db`（连接/历史/工单/**语义层内容**）与 `semantic-index.db`
  （**派生检索索引**，可随时删）落 `<dataDir>/`，旧 JSON 迁移后为 `*.json.migrated`；
  `undo/` 与 `exports/` 两个敏感目录同样在 `<dataDir>/` 下。**存量 dbs.db 原地兼容**
  （schema 零改动，node:sqlite 直接打开）。
- **鉴权**：令牌机制随 sidecar 消失——「凭证只存在于 Host 进程内」由**同进程**更强地满足；
  浏览器通道的 Host/Origin + 登录凭证校验（`connection.requestRejection`，fail closed）不变，
  浏览器仍然拿不到连接密码。
- **健康检查**：`engine.health()` → `{"ok":true,"version":"3-node","connections":<int>,
  "semantic":{"configured":bool,"indexReady":bool,"domains":int,"assets":int}}`；
  `/db-studio/api/health` 探针形状不变。`semantic` 的加法兼容语义与旧契约一致。
- **错误翻译**：§3 的全部错误码、HTTP 状态码语义与 `{error, code}` 错误体逐字保留
  （`ApiError` → `BackendError` 的映射在 `local-stack.js`，中文指引表在 `error-hints.js`）。
- **启动语义**：引擎组装即就绪（约 50ms）；迁移失败（如 `dbs.db` 损坏）抛错并使插件激活
  失败，原因可见——对应旧契约「进程以非 0 退出并把原因写 stderr」。

## 2a. 旧进程模型（V1~V2，已删除；历史存档）

V1~V2 由 Host 用 `node:child_process` 拉起 Python sidecar（`server/app.py`，已在 V3 删除）：
`DBS_PORT` 只绑 127.0.0.1、`DBS_TOKEN` 随机共享令牌（除 `/health` 外全部
请求必须携带，否则 401）、stdout/stderr 落 `backend.log`、意外退出有限重启。V3 的
进程内模型在保持 §3 契约逐字不变的前提下替代了它；当时的取舍记录见 `docs/ROADMAP.md` ADR
D1~D5（D2/D3/D6 的边界语义由本节等价继承）。

## 3. HTTP API v1

统一约定：
- 请求/响应都是 UTF-8 JSON；`POST` 请求体必须是 JSON 对象。
- 成功：HTTP 200 + 业务对象。失败：HTTP 4xx/5xx + `{"error":"人话原因","code":"<可选机器码>"}`。
- 时间单位：毫秒用 `elapsedMs`，秒用 `timeout`。

### 3.1 连接

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/connections` | — | `{connections:[Connection]}` |
| `POST /api/connections/save` | `{connection:Connection}`（无 `id` 即新建） | `{connection:Connection}` |
| `POST /api/connections/delete` | `{id}` | `{ok:true}` |
| `POST /api/connections/test` | `{id}` 或 `{connection:Connection}` | `{ok:boolean,elapsedMs:number,version?:string,error?:string}` |

- `save` 的密码语义：缺省或空串 = **保留原密码**；要清空必须显式 `clearPassword:true`（读接口不回密码，所以"不改密码"不能靠前端回传旧值）。
- `test` 连不上时仍返回 **HTTP 200** + `{ok:false,error}`（"连不上"是业务结果，不是接口错误）。

```jsonc
// Connection —— 注意：永远不要把 password 回给浏览器或模型
{ "id":"62bfdc5ae60a", "name":"测试库(只读)", "kind":"mysql",   // mysql | redis
  "host":"...", "port":3306, "user":"demo_user", "database":"demo_db",
  "readonly":true, "timeout":60, "maxRows":500,
  "hasPassword":true, "createdAt":"2026-11-09 23:24:10" }
```

写接口（`save`）允许带 `password`；读接口一律只回 `hasPassword`。

### 3.2 元数据（MySQL）

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/meta/databases?connectionId=` | — | `{databases:[{name,charset?,collation?}]}` |
| `GET /api/meta/tables?connectionId=&database=` | — | `{tables:[{name,type:"table"\|"view",estimatedRows?,sizeBytes?,comment?}]}` |
| `GET /api/meta/table?connectionId=&database=&table=&exactCount=false` | — | `{columns:[Column],indexes:[Index],ddl?:string,estimatedRows?:number,exactRows?:number}` |

```jsonc
// Column
{ "name":"id", "type":"bigint(20)", "nullable":false, "key":"PRI",
  "default":null, "extra":"auto_increment", "comment":"" }
// Index
{ "name":"PRIMARY", "columns":["id"], "unique":true, "type":"BTREE" }
```

Redis 连接的元数据：`GET /api/meta/databases?connectionId=` 返回 `{databases:[{name:"0",keys?:number}]}`（db 列表，来自 `INFO keyspace`）。

### 3.3 查询与执行

`POST /api/query`（只读路径，工具 `db_query` 走这里）

```jsonc
// 请求
{ "connectionId":"...", "database":"demo_db", "sql":"select * from t limit 10", "maxRows":500 }
// 响应
{ "elapsedMs": 12,
  "results": [{
    "sql":"select ...", "kind":"rows"|"exec",
    "columns":[{"name":"id","type":"bigint"}],
    "rows":[[1,"a"],[2,"b"]],      // 值统一 JSON 化：datetime→ISO 字符串，bytes→base64 前缀 "base64:"
    "rowCount":2, "truncated":false,
    "affectedRows":null, "elapsedMs":8, "error":null }] }
```

- 多语句按顺序执行，**出错即停**，已成功的结果照常返回（最后一个 result 带 `error`）。
- `truncated=true` 表示命中 `maxRows` 上限。
- **`/api/query` 对所有连接都强制只读白名单**（不只就读连接）：`db_query` 不经过审批，后端是唯一防线，否则模型能对可写连接借查询接口绕过审批写库。写操作只能走 `/api/execute`。
- **守卫先全量预校验再执行**：`READONLY` / `NO_WHERE` 是整请求 403、零部分执行（不会出现"前三条跑了、第四条被拦"）。只有执行期的 SQL 错误才走"出错即停 + 已成功结果照常返回"。
- **截断语义**：`/api/query` 命中上限时 `truncated=true`、`error=null`、停止后续语句；`/api/execute` 里出现截断按事务失败处理（整体回滚，该 result 带 `error`）。
- 值 JSON 化补充：`Decimal` → **字符串**（保留 scale，如 `"1.50"`），`NaN`/`Inf` → 字符串。
- **慢 SQL 硬门禁（第 18 轮引入；第 19 轮双条件；第 45 轮 type=ALL 按表数据量分档，仅 agent）**：`X-DBS-Actor: agent`
  的查询，每条 `SELECT` 执行前先 `EXPLAIN`——**两个独立条件命中任一即拦**：
  ① 执行计划出现 `type=ALL`（全表扫描）**且表近似行数达分档阈值**——表数据量取
  `information_schema.TABLES.TABLE_ROWS`（近似值），≥ `DBS_SLOW_SQL_FULL_SCAN_TABLE_ROWS`（默认 500000）才拦，
  小表全扫放行；TABLE_ROWS 取不到（视图/无权限）按保守拦；阈值 ≤0 关闭分档，回到 type=ALL 一律拦的旧规则；
  ② 估算行数 > `DBS_SLOW_SQL_MAX_SCAN_ROWS`（默认 100000，≤0 关闭门禁，不论扫描类型）。
  `403 {"error":"慢 SQL 门禁：…（附计划要点与改写建议）","code":"SLOW_SQL_RISK"}`；EXPLAIN 自身失败按 `400` 拒绝
  （fail closed，无法证明安全性就不执行）。**面板查询（actor=user）不受门禁约束**，但同样会跑一遍 EXPLAIN
  体检并把计划写入执行历史（§3.5，仅供详情展示、不拦截）。`db_query` 工具描述与 NL2SQL
  系统提示已同步声明该门禁；Redis 路径不涉及。

`POST /api/execute`（写入路径，工具 `db_execute` 走这里）——请求体同 `/api/query`，另加 `"reason"`。守卫顺序不可变：

1. 连接不存在 → 404 `CONNECTION_NOT_FOUND`
2. 连接 `readonly=true` 且语句非只读白名单 → 403 `READONLY`
3. `UPDATE`/`DELETE` 缺顶层 `WHERE` → 403 `NO_WHERE`
4. 以上都过 → 在单事务里执行（失败整体回滚），响应同 `/api/query`。

只读白名单（与旧版一致）：`SELECT SHOW DESC DESCRIBE EXPLAIN USE SET`。

**结构化行写（V2.3，契约 §3.3b）**：agent 说「把 id=3 的 status 改成 archived」，不拼 SQL 字符串——后端用
`core/sqlgen`（主键定位 WHERE、值一律 `%s` 参数化、仅标识符反引号）生成 DML。两条路径同一生成逻辑：

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/write-rows` | `{connectionId,database?,table,updates:[{keys,set}],inserts:[row],deletes:[keys],reason?}` | `{elapsedMs,results,rendered,summary,undo}`（direct 直执行） |
| `POST /api/tickets`（带 `rowsPayload`） | `{connectionId,database?,background,rowsPayload:{table,updates,inserts,deletes},title?}` | `{ticket}`（`sql`=render 人读文本；`rowsPayload`=参数化语句存档） |

- 约束：表必须有主键/唯一键（`400 NO_PRIMARY_KEY`）；一次最多 `DBS_WRITE_ROWS_MAX`（默认 200）行
  （`400 WRITE_ROWS_MAX`）；列名必须存在（400 带 unknown 列名）；语句顺序固定 updates→inserts→deletes；
- 守卫与快照：复用三道闸（只读连接拒绝；主键定位天然带 WHERE）与变更前快照——第 38 轮起**多行写
  可撤销**（§3.6a：多语句 DML 逐行 segment 快照、撤销倒序回放；累计行数 ≤ `DBS_UNDO_MAX_ROWS`）；
  超限等不可撤销时，写错就再提交一次反向 diff；
- 结构化工单：`estimated.rowsExact=true`（主键定位逐行精确，每条 `estimatedRows=1`/`exact=true`）；
  批准执行走存档参数化语句（`rowsPayload.statements[].sql + params`，**不执行** render 文本、不经
  `split_sql`）；`tickets.rows_json` 列存档，读接口字段名 `rowsPayload`；旧工单无该字段照常。

**会话写窗口（V2.4，契约 §3.3c）**：`allowWrites`（插件配置，工具 `when` 隐藏）之外的第二道**时间闸**——
状态存 dbs.db meta（`writes_window_open_until`），读时惰性判过期，到期自动关。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/writes/window` | — | `{window:{open,openUntil,minutesLeft}}` |
| `POST /api/writes/window` | `{minutes:15│30│60}`（已有窗口则顺延叠加，上限 720）或 `{close:true}` | `{window}`（403 不适用；`minutes` 越界 400 `WRITES_WINDOW_MINUTES`） |

- **四个 MySQL 写入口统一检查**（守卫三道闸之前）：`/api/execute`、工单批准执行、`/api/write-rows`、
  `/api/undo`——窗口关闭 → 403 `WRITES_CLOSED`（error 文案带「让用户在面板临时开闸」的可执行建议）。
  建单（`POST /api/tickets`）**不拦**——提交≠执行，批准那一刻才查；Redis 路径不受窗口约束；
- 分层语义（ADR D4 + D6）：全局 `allowWrites=false` → 写工具不注册（模型看不见）；`allowWrites=true`
  → 工具注册着，执行时若窗口关 → 403 + 引导开闸。`db_status` 返回 `writesWindow:{open,minutesLeft,openUntil,unknown}`
  （老后端降级 `unknown:true`）并随状态行汇报。

### 3.4 Redis

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/redis/scan` | `{connectionId,database,cursor?,match?,count?}` | `{cursor:"0",keys:[{key,type,ttl}]}` |
| `POST /api/redis/key` | `{connectionId,database,key}` | `{key,type,ttl,memoryBytes?,value,truncated?}` |
| `POST /api/redis/command` | `{connectionId,database,command:"GET foo"}` | `{reply,kind:"string"\|"array"\|"number"\|"nil"}` |

- **`KEYS` 一律禁用**（任何连接）：HTTP 400 `KEYS_DISABLED`，用 `scan` 代替；`SELECT` 同样 400 `SELECT_DISABLED`（切库走参数）。
- 只读连接：非白名单命令 403 `READONLY`。
- **可写连接上的销毁级命令（`DEL/UNLINK/FLUSHDB/FLUSHALL`）后端不拦——必须由 Host 层先过审批**。这是明确的责任分工：后端管"连接是否只读"，Host 管"人是否同意"。
- `value` 按类型给结构化数据：string 直接给字符串（像 JSON 就额外给 `json` 字段）；hash → `[{field,value}]`；list/set/zset → 数组；stream 给前 100 条。

### 3.5 执行历史

`GET /api/history?limit=500&offset=0&from=&to=&connectionId=&status=&keyword=`
→ `{history:[HistoryItem], total, limit, offset}`（最新在前；`limit` 默认 **500**，上限 500；
`offset` 翻页；`from`/`to` 支持 `YYYY-MM-DD`（自动补当天 00:00:00 / 23:59:59）或完整时间串，闭区间；
`total` = 当前过滤条件下的总条数）

```jsonc
// HistoryItem —— 面板「执行历史」直接用这个结构
{ "id":"3f2a1b0c9d8e", "connectionId":"62bfdc5ae60a", "connectionName":"demo_db测试(只读)",
  "database":"demo_db", "sql":"select * from t limit 10",
  "status":"ok"|"error", "elapsedMs":23, "time":"2026-11-10 11:20:00",
  "source":"panel"|"agent"|"ticket"|"undo",   // 谁发起的：面板 / agent 工具 / 工单审批执行 / 撤销（V2.2）
  "undo": {"available":true,"reason":""},     // 撤销可用性摘要（第 25 轮；可撤销快照关联时存在；执行时冻结）
  "undoLive":"active"|"undoing"|"undone"|"",  // undo_log 实时状态（第 43 轮；按 historyId/ticketId 关联最新条目，无关联为空）——已撤销记录据此禁用撤销按钮
  "kind":"query"|"execute",                 // 只读查询还是写执行
  "statementCount":1,
  "rowCount":5, "affectedRows":null,        // 查询给 rowCount，写给 affectedRows
  "truncated":false,
  "error":"...",                            // 仅 status=error
  "explain":[{"index":1,"plans":[{"table":"t","type":"ref","key":"PRIMARY","rows":12,"extra":""}]}],
                                            // 仅 /api/query：每条 SELECT 的 EXPLAIN 计划（第 19 轮）
  "purpose":"近 7 天失败工单"                // 仅 agent 且调用时带 purpose（第 19 轮，分组展示）
}
```

写入时机：`/api/query`、`/api/execute`、工单审批执行三处都要记；`source` 来自 `X-DBS-Actor`（`agent`）或工单执行（`ticket`），其余 `panel`。
`connectionId` / `status` / `keyword`（对 sql 做不区分大小写子串匹配）/ `from` / `to` 都是可选过滤参数。
`/api/query` 可带 `purpose`（≤200 字，agent 一句话说明本次查询回答哪个业务问题），随历史落库；
面板详情展示 EXPLAIN 计划与 purpose。DSH 工具层拿不到原始用户提示词，分组标识由模型按
`db_query.purpose` 参数自述（NL2SQL 提示已约束每次填写）。

### 3.6 工单（非查询语句的审批执行）

对应阿里云 DMS 的「工单」：AI 想执行非查询语句时**不是直接执行**，而是提交工单，由人在面板里审批后才执行。
数据落在 `<dataDir>/tickets.json`（原子写，最多 500 条）。

```jsonc
// Ticket
{
  "id": "tk_7f3a91c2",
  "status": "pending" | "approved" | "executing" | "succeeded" | "failed" | "rejected" | "cancelled" | "undone",
  "kind": "write" | "export",                 // 工单类型（第 45 轮）：写变更 / 数据导出（SELECT 单语句，批准后程序分批取数、面板下载 xlsx/JSON/INSERT；第 46 轮起是唯一导出入口，工作区/agent 一律走它）
  "connectionId": "...", "connectionName": "...", "database": "demo_db",
  "sql": "update ...; delete ...;",           // 允许多条语句，用 ";" 分隔（见下「多语句工单」）
  "title": "UPDATE t_check_config",        // 缺省由后端按首关键字 + 表名生成；多语句时带条数
  "background": "清理 3 条过期配置",           // 背景说明，必填（≥4 字符）
  "submittedBy": "agent" | "user",
  "createdAt": "2026-11-10 11:20:00",
  "estimated": {                              // 提交时算好的影响面预估
    "affectedRows": 3,                        // 多语句 = 各条估算之和；null = 一条都估不出来
    "rowsExact": false,                       // 全部语句都精确（COUNT(*) 命中）才为 true
    "statementCount": 2,                      // 语句总数
    "unknownStatements": 0,                   // 其中估不出行数的条数（不影响已知项的求和）
    "risk": "low" | "medium" | "high",
    "statements": [{"kind":"UPDATE","table":"t_check_config","hasWhere":true,"estimatedRows":3,
                    "exact":true,"plan":[{"accessType":"ref","key":"PRIMARY","rows":3}],
                    "sql":"UPDATE t_check_config SET ..."}],   // sql = 该条语句的预览（≤200 字符）
    "notes": ["DDL 结构变更，无法预估行数"]     // 人话提示，可空
  },
  "approvedAt": null, "approvedBy": null, "approvalComment": "",
  "executedAt": null,
  "actual": {"affectedRows": 3, "elapsedMs": 23, "results": [...],
            "undo": {"available":true,"reason":"","op":"UPDATE","table":"...","rows":3,"undoId":"undo_..."}},  // undo = 撤销可用性摘要（V2.2/§3.6a；第 25 轮起随 actual 落库），面板据此预判撤销按钮 | null,
  "error": null
}
```

**多语句工单（一张工单里多条 SQL）**：

- `sql` 用 `;` 分隔多条语句，后端用 `core/sqlsplit.py` 拆分（引号/注释感知），顺序不可变。
- **估算**：逐条估算（每条 `statements[i].estimatedRows`），`estimated.affectedRows` = **各条之和**（封顶 1e9）。
  某条估不出来（DDL / SELECT / EXPLAIN 失败）时它不参与求和，`unknownStatements` 计数，`notes` 里说明；
  一条都估不出来时 `affectedRows = null`。
- **执行**：整张工单的所有语句在**同一个事务**里按顺序执行，全部成功才 `commit`；任一条失败（含结果集被
  `maxRows` 截断）→ **整体 `rollback`**，工单状态 `failed`，`error` 记原文。不允许"前面成功、后面失败"的部分生效。
- **守卫**：只读白名单 / NO_WHERE 对**每一条**语句都生效；任一条不过 → 整张工单在建单时就被拒（不落库），
  审批时会再校验一次（连接配置可能已被改）。
- `actual.affectedRows` = 各语句 `affectedRows` 之和（纯 SELECT 语句贡献 null，全部为 SELECT 时 `null`）。
- 面板必须把「合计」与逐条明细都展示出来：`estimated.affectedRows` 是合计值，`statements[]` 是明细。

**状态机**（只有这些迁移合法，其它一律 409 `TICKET_STATE`）：

```
pending ──approve──► executing ──► succeeded | failed
   │                    │
   ├──reject──► rejected │
   └──cancel──► cancelled│
                        ▼（第 43 轮：撤销成功自动 CAS，不经工单接口）
                    succeeded ──undo──► undone（终态）
                        ▲                   │
                        └── 撤销恢复快照(重做) ─┘（经撤销历史，工单状态如实回写）
```

> `approved` 仅作为枚举保留值：审批与执行是同一个同步动作，`executing` 只在执行期间可见，落盘状态只会是 `pending` / `succeeded` / `failed` / `rejected` / `cancelled` / `undone`。面板不要做「已通过」过滤档（永远为空），要展示成功请用 `succeeded`。
>
> **`undone`（第 43 轮）**：工单变更被撤销后的**终态**——不可再审批/执行（执行只从 `pending` 进入，天然封死）；面板详情显示回滚提示并隐藏撤销按钮，筛选档「已撤销」。唯一回写路径：在撤销历史中对恢复快照（redo）执行撤销 → CAS `undone→succeeded`（数据效果恢复时状态必须如实回写）。撤销→重做→再撤销的震荡不会改写工单状态以外的任何数据。

`POST /api/tickets/estimate` 只校验「连接存在且为 MySQL」，**不跑只读/WHERE 守卫**——它是预览接口，允许在只读连接上预估写语句；真正的 `POST /api/tickets` 才做三道校验。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `POST /api/tickets/estimate` | `{connectionId,database?,sql}` | `{estimated: Estimated}`（只算不存，面板/工具做预览） |
| `POST /api/tickets` | `{connectionId,database?,sql,background,title?}` | `{ticket: Ticket}`（status=`pending`） |
| `GET /api/tickets?status=&limit=&keyword=&offset=` | — | `{tickets:[Ticket], counts:{pending,succeeded,failed,rejected,cancelled,undone}, total, limit, offset}`（第 45 轮：keyword 匹配 id/title/sql/background/connectionName/database 六字段（含**工单号**），offset 分页默认 0，total = 过滤后总数；排序 seq DESC 时间倒序，面板默认每页 50 条） |
| `GET /api/tickets/detail?id=` | — | `{ticket: Ticket}` |
| `POST /api/tickets/approve` | `{id, approve:boolean, comment?}` | `{ticket: Ticket}`（批准时**同步执行完**才返回） |
| `POST /api/tickets/cancel` | `{id}` | `{ticket: Ticket}` |

**人工建单（第 25 轮）**：面板工作区只放行只读语句；写语句被拦时提供「提交工单」入口——人工填
background 后走同一个 `POST /api/tickets`（`submittedBy:"user"`），预估/守卫/审批流程与 agent 建单完全一致。

**数据导出工单（第 45 轮，第 46 轮统一入口，`kind="export"`）**：`POST /api/tickets` body 加 `"export": true`——
**所有导出（不限制类型）都走工单**：agent 用 `db_export_query`，面板工作区结果卡的「导出」按钮提交同一工单
（`submittedBy:"user"`，背景自动填「工作区结果集导出：<SQL>」；「导出选中行」前端直下已随统一入口移除）。
sql 必须是**恰好一条 SELECT**（多语句 → 400 `TICKET_EXPORT_SINGLE`；非 SELECT → 400 `TICKET_EXPORT_SELECT_ONLY`；含
`INTO OUTFILE/DUMPFILE` → 400 `TICKET_EXPORT_NO_OUTFILE`；不接受 rowsPayload → 400 `TICKET_EXPORT_SQL_ONLY`）。
导出是**只读**动作：只读连接可用、不走写窗口；`rowsPayload` 与导出互斥。审批通过后由程序执行：
EXPLAIN 体检只记录不拦截（人工审批即边界）；SSCursor **分批取数**——每批 `DBS_EXPORT_BATCH_SIZE`（默认 **500**）
行，逐批掩码（§3.7，导出文件也是掩码值）后流式追加落盘，控内存；行数上限 `DBS_EXPORT_MAX_ROWS`（默认 **10000**）。
**建单时先按导出条件计数**（原 SELECT 包裹成 `SELECT COUNT(*) FROM (<原SQL>) _cnt`，GROUP BY/UNION/DISTINCT
都包得住；失败降级放行）——超上限 → **400 `TICKET_EXPORT_OVER_LIMIT`，工单不落库**（不产出「批准后必然失败」的
工单）；计数成功把精确行数写进预估（rowsExact）；批准执行后再核一次（建单到批准间数据变化的兜底）——
取满上限后仍能再取到一行 → 工单置 failed 并给人话错误，不落文件（SSCursor 有未读数据，连接一并丢弃）。
恰好等于上限放行；≤0 视为不限。结果数据（columns+rows）以 JSON 落
`<dataDir>/exports/export_<ticketId>.json`，保留 `DBS_EXPORT_KEEP`（默认 20）份；`actual` 附
`exportRows`（导出行数）与 `exportBatches`（取数批次数）（`exportFile` 本地路径**出站剥离**，同 undoFile）。
导出工单没有撤销语义（面板不出撤销按钮）。

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/tickets/export/download?id=` | — | `{columns, rows, filenameBase}`（JSON 数据；404 `EXPORT_GONE` = 文件已被清理，400 `TICKET_EXPORT_BAD_ID` = 非法工单号）。**前端下载菜单按所选格式转换保存**：xlsx（`buildXlsxBytes`，文件名 `<连接名>-<表名>-<时间戳>.xlsx`）/ JSON（`buildJsonText`）/ INSERT（`buildInsertText`），服务端不做打包 |

工具入口：`db_export_query`（只读工具，不受 allowWrites 约束；提交后等人在面板批准并下载，agent 不能批准）。
Ticket 详情在 `status="undone"` 时附 `undoneAt`（撤销时间，按 undo_log 反查，第 45 轮）。

**创建工单时必须做的三道校验**（顺序不可变，都失败则不落库；导出工单走上面的导出校验）：
1. 连接存在且为 MySQL → 404 `CONNECTION_NOT_FOUND` / 400 `NOT_MYSQL`
2. 只读连接 + 非只读白名单语句 → 403 `READONLY`
3. `UPDATE`/`DELETE` 缺顶层 `WHERE` → 403 `NO_WHERE`

**预估实现**（`estimate()`，best-effort，任何一步失败降级成 `affectedRows:null` + `notes` 说明，不能让整个请求失败）：
- `UPDATE`/`DELETE`：对语句跑 `EXPLAIN <sql>`，取 `rows` 列；多表取各表 `rows` 的乘积（封顶 1e9）。
- **同条件精确计数**（第 21 轮）：`UPDATE`/`DELETE` 在 EXPLAIN 之后，若估算 ≤ `DBS_IMPACT_COUNT_MAX_ROWS`（默认 100000，≤0 关闭）
  且带顶层 WHERE 且非多表（JOIN/逗号），改写成 `SELECT COUNT(*) FROM <表> <WHERE 起的原文>` 真扫一次数据取精确值；
  命中的语句 `statements[].exact=true`，值替换估算值；COUNT 失败只记 `notes` 退回估算。
  `rowsExact=true` 仅当**全部**语句都精确（含 INSERT 的元组计数不算精确——ON DUPLICATE 下元组数 ≠ 影响行数）。
- `statements[].plan`：EXPLAIN 每行的 `[{accessType(=type 列), key(命中索引), rows}]`；旧工单/非 EXPLAIN 语句没有该字段。
- `INSERT`：数 `VALUES` 后的 `(...)` 元组个数；解析不出来再用 `EXPLAIN`。
- DDL（`CREATE/ALTER/DROP/TRUNCATE/RENAME`）：`affectedRows=null`，`notes` 写「结构变更，无法预估行数」。
- `risk`：含 `DROP`/`TRUNCATE` 或预估 > 1000 → `high`；预估 > 100 或语句数 > 3 → `medium`；其余 `low`；`null` 预估按 `medium`。

**批准执行**：复用 `/api/execute` 的守卫与单事务逻辑（失败整体回滚），执行后把 `actual.affectedRows`（各语句 `affectedRows` 求和）、`elapsedMs`、`results` 写回工单，并向 `/api/history` 记一条 `source:"ticket"`、`kind:"execute"` 的历史。
**并发保护**：`approve` 前先把状态从 `pending` 原子切到 `executing`；不是 `pending` 就 409。执行完再落 `succeeded`/`failed`。

### 3.6a 变更前快照与撤销（V2.2，仅 MySQL）

每次写执行（`/api/execute`、工单批准、`/api/write-rows`、撤销本身）在**同一事务**里自动抓受影响行，
落 JSON 到 `<dataDir>/undo/` + 索引 SQLite `undo_log` 表。范围（不满足即标记「不可撤销」继续执行）：

- `UPDATE`/`DELETE`/`INSERT` **多语句可用**（第 38 轮）：每条语句一个 segment，执行时逐条
  「抓行 → 执行 → INSERT 回查」交错进行（第 N 条的快照看到前 N-1 条的效果）；撤销按 segment
  **倒序**逐段回放反向语句；任一条不可快照 → 整体标记不可撤销（all-or-nothing，reason 带第几条）；
- 单条语句内**多表**（JOIN、逗号）/ **DDL** / **多行 VALUES 的 INSERT / INSERT..SELECT** / 缺顶层 WHERE 不可撤销；
- `UPDATE`/`DELETE`：执行前按同条件 `SELECT *`（WHERE 起原文含 ORDER BY/LIMIT）抓旧行；表无主键不可撤销；
  语句为参数化形态（撤销反向语句 / `db_write_rows` 生成 DML，含 `%s` 占位）时，同条件 SELECT **带 WHERE 参数**执行
  ——UPDATE 取 params 末 n 个（n = 占位数，WHERE 值在尾部）、DELETE 取全部；漏传 params 会 1064（第 42 轮）；
- `INSERT`：执行后回查新行（redo 抓行）双路径（第 44 轮）——**反向 INSERT**（DELETE 类撤销生成的，语句自带
  `_pkColumns`/`_pkValues` 元数据）**按原主键回查**，与 lastrowid 无关，复合主键也能定位，redo 链成立；
  普通用户 INSERT 仅「单 VALUES 元组 + 单列**自增**主键」走 lastrowid（显式主键的 lastrowid 不可信，不适用）；
- **原主键占用预检（第 44 轮）**：撤销 DELETE 类变更前，逐行 `SELECT 1 WHERE 原主键 = 旧值`（参数化）检查
  id 是否已被新数据占用。`GET /api/undo/preview` 响应 `undo.pkConflicts = [{table, count}]`（按表聚合，
  **不带主键值**，null = 预检跳过/失败）；`POST /api/undo` 冲突且未确认 → **409 `UNDO_PK_CONFLICT`**（不再
  撞 1062），body 带 `force: true` 人工确认后，冲突行反向 INSERT **省略主键列**改用自增 id（仅单列自增
  主键表；复合/业务主键冲突无法自动处理，同样 409 并说明需人工清理）。预检与执行间有 TOCTOU 间隙，
  最终兜底 = 事务内主键冲突整体回滚（fail-closed）；
- **全部段累计**行数 > `DBS_UNDO_MAX_ROWS`（默认 1000，`<=0` 整体关闭快照，此时写响应**不带** `undo` 段）
  → 不可撤销不阻断；全部段零匹配 → 标记「没有匹配行，无需撤销」；
- **fail-closed**：抓行 / 回查 / 落盘 / 记账失败 → 整体回滚（宁可不做也不能没退路）；
- 快照文件含**明文行数据**，只落本地 `<dataDir>/undo/`（不入库不出站）；保留 `DBS_UNDO_KEEP`（默认 50）份，超限连文件一起淘汰；
- `/api/execute` 与工单批准的响应多一个 `undo` 字段：`{available, reason, op, table, rows, undoId}`（`available=false` 时 `reason` 说明）。

撤销入口（撤销也是写：过同样的三道守卫 + 单事务 + 快照，因此撤销的撤销 = redo 天然成立）：

| 方法 路径 | 请求 | 响应 |
|---|---|---|
| `GET /api/undo/preview?id=│ticketId=│historyId=` | — | `{undo}`（缺省 = 最近 active；`reverse` = **%s 占位符**反向语句，值绝不出站） |
| `POST /api/undo` | `{id?}` | `{undo, results, elapsedMs, affectedRows}` |
| `GET /api/undo/list?limit=` | — | `{undoList}`（含 undone/redo 链） |

**undo_log 状态机**：`prepared ──commit──► active ──undo──► undone`；`undoing` 是撤销执行期间的瞬态（CAS `active→undoing` 原子占位，第二个撤销 409 `UNDO_STATE`；失败/回滚归还 `active`）；`discarded` 保留枚举。撤销执行失败 → 400 `UNDO_EXECUTE_FAILED`（原变更仍在）；快照文件被清理/损坏 → 410 `UNDO_SNAPSHOT_GONE`。

**撤销 ↔ 工单状态联动（第 43 轮）**：撤销原工单变更成功 → 工单 CAS `succeeded→undone`（终态，见 §3.6 状态机）；撤销的是恢复快照（重做）→ 沿 `undo_of` 链回溯根条目，工单 CAS `undone→succeeded`（数据效果恢复时状态如实回写）。`GET /api/undo/preview?ticketId=│historyId=` 不限状态反查——已撤销条目返回 **409 `UNDO_STATE`**（文案「该变更已撤销…」），不再是 404「没有可撤销的变更」。

**边界**：Redis 不参与快照/撤销；反向语句恢复「全列旧值」（UPDATE 恢复含主键，被改主键也能恢复）；执行响应 `/api/execute` 的 `results[]` exec 条目新增可选 `lastrowid`（INSERT 快照回查用）。历史 `source` 新增 `"undo"`（§3.5）。快照文件第 38 轮起为 v2 多段形状 `{"version":2,"segments":[...]}`，v1 扁平单段形状兼容读取；多语句快照 `undo.op="MULTI"`、`table` 为涉及表清单。Host 工具 `db_undo_last`：direct 模式走 `ctx.approval` 后执行；ticket 模式只查询并引导人工在面板点「撤销」——agent 不能撤销（与 §4.2「agent 不能批准」同一边界）。

### 3.7 数据脱敏（连接级，程序内强制）

**硬规则：脱敏在后端（V3 起为 Host 进程内的 server 模块）出站前完成，任何调用方（agent 工具 / 浏览器面板 / 工单执行结果）拿到的都已经是脱敏值。禁止"先取原始数据、再在 Host 或浏览器里脱敏"。**

**连接模型新增 `masking` 字段**（MySQL 连接有效；Redis 连接忽略）：

```jsonc
// Connection.masking
{
  "enabled": true,
  "keywords": ["姓名", "phone", "card"],        // 用户输入的关键字，用来圈定要脱敏的字段
  "fields": [                                   // 分析结果，落库；执行时按它脱敏
    {"table":"t_user","column":"real_name","type":"name","mandatory":true,"reason":"内置：字段名命中姓名"},
    {"table":"t_user","column":"mobile","type":"phone","mandatory":true,"reason":"内置：字段名命中手机号"},
    {"table":"t_order","column":"card_no","type":"bankcard","mandatory":true,"reason":"内置：字段名命中银行卡"},
    {"table":"t_user","column":"cert_no","type":"idcard","mandatory":true,"reason":"内置：字段名命中身份证"},
    {"table":"t_user","column":"nickname","type":"generic","mandatory":false,"reason":"关键字命中：nickname"}
  ],
  "analyzedAt": "2026-11-10 12:00:00",
  "summary": {"tables": 12, "columns": 340, "masked": 5}
}
```

**内置五种类型（开启脱敏即强制，任何界面都不得删除/关闭）**：`name` / `phone` / `idcard` / `bankcard` / `email`。
`mandatory:true` 的字段只能由后端自动写入，`save` 请求里**不能删除或改类型**（后端会把缺失的强制项补回来）。
额外来源：用户关键字命中的字段，类型推不出来时用 `generic`（非强制，可增删）。

**脱敏算法（参考国家/行业通行做法）**：

| 类型 | 规则 | 示例 |
|---|---|---|
| `name` 姓名 | 保留姓（首字），其余每个字替换为 `*`；单字姓名 → `*` | 张三 → 张*；欧阳娜娜 → 欧*** |
| `phone` 手机号 | 11 位手机号保留 **前 3 + 后 4**，中间 4 位 `*`；其它长度保留前 3 后 2 | 13812345678 → 138****5678 |
| `idcard` 身份证 | 18 位保留 **前 6 + 后 4**，中间 8 位 `*`；15 位保留前 6 后 4 | 110101199003071234 → 110101********1234 |
| `bankcard` 银行卡 | 保留 **前 6（BIN）+ 后 4**，中间全 `*`；长度 ≤10 → 全掩 | 6222021234567890123 → 622202*********0123 |
| `email` 邮箱 | 保留本地部分**首字符** + `***` + `@域名`（域名保留，便于识别来源） | zhangsan@example.com → z***@example.com |
| `generic` 通用 | 保留首尾各 1 个字符，中间 `*`（长度 ≤2 → 全 `*`） | 张三丰 → 张*丰 |

补充规则：
- `NULL` / 空字符串原样返回（空值没有可泄露内容）。
- 命中脱敏**列**后，无论值是什么格式都按该列类型掩码（格式不符合也用同规则兜底，不允许"格式不匹配就原样返回"）。
- **值级兜底（防止 ALIAS/未知列/表达式绕过）——判定必须"高精度"，宁可漏判不可误伤业务 ID**：
  - 手机号：`^1[3-9]\d{9}$`。
  - 身份证：18 位且 GB 11643 mod 11-2 校验位正确，**且**第 7~14 位是合法出生日期（1900-01-01 ~ 今天）；或 15 位且第 7~12 位是合法出生日期。
  - 银行卡：16/19 位（Visa 13 位也接受）纯数字，**通过 Luhn**，**且前缀是真实卡组织 IIN**：
    `4`（Visa）、`5[1-5]`（MasterCard）、`62`（银联，16~19 位）、`34|37`（Amex，15 位）、`35`（JCB，16 位）、
    `6011|65`（Discover，16/19 位）、`62[0-9]` 等。
    **只靠"长度 + Luhn"不够**：雪花 ID（如 19 位订单号 `1979095408206553088`）末位分布有偏，约 15% 会碰巧过 Luhn，会造成大面积误伤。
  - 姓名：无法靠值判断，只按列名规则处理（见「已知限制」）。
- 已知限制：敏感值若**嵌在 JSON/TEXT 字段内部**（不是独立列），列名/值级规则都不解析内容；Redis 连接不做脱敏。

**生效路径（全部必须在后端出站前脱敏）**：`/api/query`、`/api/execute`、工单批准执行的 `actual.results`、以及任何返回数据行的接口。元数据接口（列名/DDL/行数）不涉及数据行，不脱敏。

**分析接口**：`POST /api/masking/analyze` `{connectionId, keywords:[string]}` → `{candidates:[{table,column,type,mandatory,reason}], summary}`。
按**表名 / 列名 / 列注释**匹配关键字；同时用内置字段名启发式识别姓名/手机号/身份证/银行卡/**邮箱**（中英文常见命名，如 `real_name`/`user_name`/`mobile`/`phone`/`id_card`/`cert_no`/`card_no`/`bank_card`/`email`/`mail_addr`/`姓名`/`手机号`/`身份证`/`银行卡`/`邮箱`/`电子邮箱` 等）。
`POST /api/connections/save` 时若 `masking.enabled`，后端**重新分析一次**并把强制四种合并进 `fields`（前端传的不完整/被删都会补回）。

**Host 侧**：`POST /db-studio/api/masking/suggest` 用 DSH 模型做同一件事（输入 schema + 关键字，输出候选字段）。

```jsonc
// 请求体（连接表单「AI 分析字段」；第 18 轮起 Host 侧唯一保留的模型调用通道）
{ "connectionId": "...", "keywords": ["姓名", "phone"], "database": "demo_db",
  "model": {"provider": "...", "model": "..."} }        // model 可省略
// 响应：{candidates:[{table,column,type,mandatory,reason}], summary, model:{provider,model}}
```

- `keywords` **可省略**（Host 视为空关键字，不报 400；后端 analyze 收到缺省时沿用连接已保存的关键字）。
- `model` 可省略：缺省用 DSH 默认模型 + 自动回退（见 §4.4）；显式指定了不存在的模型/没凭据 → 返回 `503` + 人话原因（不静默回退，避免「以为切了其实没切」）。
- 模型完全不可用时回退到后端 `/api/masking/analyze`（规则分析）。**它只产候选，不参与实际脱敏**。
- 第 18 轮起面板 AI 对话已下线：`/db-studio/api/chat`、`/db-studio/api/chat/status`、`/db-studio/api/chat/models` 已删除（404）。

### 3.8 脱敏策略维护（树 + 保存语义）

策略是**连接级持久配置**，与"是否开启脱敏"解耦：

- `GET /api/connections` 的 `connection.masking.fields` 就是策略集合（`{table,column,type,mandatory,reason}`），面板据此在树上标记每个字段的策略。
- **策略树的数据来源**（不需要新接口，复用元数据接口 + 懒加载）：
  连接 → 数据库（`GET /api/meta/databases`）→ 数据表（`GET /api/meta/tables`）→ 字段（`GET /api/meta/table` 的 `columns`，含 `comment`）。
  字段节点的策略默认即"不脱敏"（不在 `fields` 里就是 none）。

**保存策略**：`POST /api/masking/policies`

```jsonc
// 请求：整份替换（传 none 等价于移除该字段策略）
{
  "connectionId": "62bfdc5ae60a",
  "fields": [
    {"table": "t_account", "column": "mobile", "type": "phone"},
    {"table": "t_account", "column": "nickname", "type": "generic"}
  ],
  "keywords": ["手机号", "姓名"]        // 可选，一并保存
}
// 响应：{connection: Connection}（含合并后的 masking）
```

- **保存策略绝不触发 AI 重新分析**（避免覆盖人工维护结果）；AI 分析只在用户显式点「AI 分析字段」时调 `analyze`/`suggest`。
- **内置五类（`mandatory:true`）不可移除、不可改类型**：请求里缺了或改了，后端按已存储的强制项补回/纠正；`mandatory` 字段只允许后端写。
- 非强制策略可自由增删改；`type` 只能是 `name|phone|idcard|bankcard|generic`（`none` 表示不脱敏 → 从列表移除）。
- 字段不存在于该连接 schema 时忽略该条（不报错，但响应里不会出现）。

**开启/关闭脱敏与策略的关系（用户明确要求）**：

- 关闭脱敏（`enabled:false`）**不清空 `fields`**——数据查询时原样返回，策略保留。
- 再次开启时**沿用已有策略**，不重置；只新增/修改本次维护的策略。
- `POST /api/connections/save` 的语义调整为：`enabled=true` 且 `fields` 为空时，后端自动分析一次补齐（首次开启的便利路径）；**其余情况不再重新分析**，只把已存强制项合并进提交的 `fields`，避免覆盖人工维护的策略。

### 3.8.1 策略树的筛选查询（连接级批量列查询）

策略树是懒加载的，**筛选不能只作用于"已展开的节点"**（否则搜不到未展开的表、切换筛选后只剩当前展开的那一张表）。因此提供一个**连接级批量列查询**，筛选时面板改用它渲染扁平结果：

`GET /api/masking/columns?connectionId=&keyword=&onlyMasked=&database=&table=&limit=`

| 参数 | 说明 |
|---|---|
| `connectionId` | 必填，MySQL 连接 |
| `keyword` | 不区分大小写**子串**匹配 `列名 / 表名 / 列注释`；空=不过滤 |
| `onlyMasked` | `true` 时只返回**已有策略**的列（策略即 `connection.masking.fields`） |
| `database` / `table` | 可选收窄范围 |
| `limit` | 默认 300，最大 1000 |

响应：

```jsonc
{
  "columns": [
    {"database":"demo_db","table":"t_account","column":"mobile","dataType":"varchar(32)",
     "comment":"手机号",
     "policy": {"type":"phone","mandatory":true,"reason":"内置：字段名命中手机号"} }  // 无策略 = null
  ],
  "total": 12,          // 命中总数（应用 limit 前）
  "truncated": false
}
```

- 实现：一条 `information_schema.columns` 查询（`table_schema NOT IN (系统库)`），再按 `masking.fields` 左连接出 `policy`；`onlyMasked=true` 时过滤出有策略的列。
- **策略里存在但 schema 里已不存在的字段**（表被删/改名）也要出现在 `onlyMasked` 结果里，标记 `"inSchema": false`、`database: ""`，便于显示「策略残留」。
- 未开启脱敏的连接同样可查询（只用于维护策略）。
- 该接口**不返回任何数据行**，只返回列元数据与策略，不涉及脱敏。
- 失败：连接不可用 → `400` + 人话；连接不存在 → `404 CONNECTION_NOT_FOUND`；Redis → `400 NOT_MYSQL`。

**面板筛选行为约定**：
- 无筛选 = 懒加载树（连接→库→表→字段，按需展开）。
- **有筛选（搜索非空 或 「只看已脱敏」开启）= 调上面的接口渲染扁平分组结果**（库→表→命中字段），结果与树的展开状态**完全无关**；策略下拉仍可编辑、mandatory 仍锁定。
- **清空筛选 / 取消只看已脱敏 → 回到懒加载树，并保留之前的展开状态**（不能变成空白）。
- 搜索防抖 200~300ms；无结果时给明确空态（而不是一片空白）。


### 3.9 业务语义层（NL2SQL；第 18 轮新增，第 51 轮重写为 DB 为准）

**事实来源是 `dbs.db`**（第 51 轮裁决 Q2=C）：`semantic_domain` / `semantic_doc` /
`semantic_domain_table` / `semantic_meta` 四张表存内容，面板直接编辑它们。
`<数据目录>/semantic-index.db` 只是从这些表**派生**出来的检索索引（`semantic_tables` /
`semantic_sections` 等），按 `semantic_meta.content_version` 签名幂等重建，**删了不丢内容**。
Markdown 文件退出事实来源地位：只在「导出」或该域绑定了 `export_dir` 时写出，盘上改动
**不会自动回流**（要显式「从目录重新导入」）。

`DBS_SEMANTIC_DIR` 是「**文档导入源目录**」（env 或面板覆盖，存
`dbs.db meta.semantic_dir`），只在导入与首次补种时被读。
`DBS_SEMANTIC_EXPORT_DIR` 是「**DB 写出路径**」（第 52 轮，面板存
`meta.semantic_export_dir`）：语义内容从 DB 重建后写出到这里的 `<dir>/<域>/<文件>.md`。
**没配写出路径不影响编辑与检索，只影响「重建成本地文件」**——面板用
`canRebuildFiles:false` + `rebuildHint` 明说，保存时回 `writeNoTarget:true`。

**`configured` 的语义变了**：从「配了目录」改为「**至少有一个业务域**」。
四个只读接口在 0 个域时返回原有形状 + `configured:false`（老客户端不会崩）。

#### 只读检索

| 路径 | 参数 | 响应 |
|---|---|---|
| `GET /api/semantic/domains` | — | `{configured,exportDir,canRebuildFiles,rebuildHint,index:{ready,builtAt,assets,sections,stale},domains:[{domain,title,origin,exportDir,originDir,files,fileList:[{file,kind,chars,revision,source}],tables,samples,domainTables}],usageOrder,error?}`。**`fileList` 是对象数组**（第 51 轮）。第 52 轮：`importSource` → **`exportDir`**（顶部目录 = DB 写出路径）+ `canRebuildFiles`/`rebuildHint`（没配写出路径时的提示） |
| `GET /api/semantic/search` | `q`*、`domain?`、`file?`、`kind?`、`limit?`、`snippetChars?` | `{configured,query,total,hits:[{domain,file,section,anchor,ref,title,snippet,score,line,kind}],truncated,indexReady}` |
| `GET /api/semantic/asset` | `domain`*、`file`*、`section?`、`offset?`、`maxChars?`(500-20000，默认 8000) | `{configured,domain,file,section?,anchors:[{section,level,line}],text,chars,truncated,nextOffset,anchor,ref}`。`file` 接受 `table-cards.md` 与 `pay/table-cards.md` 两种写法 |
| `GET /api/semantic/table` | `table`*、`domain?`、`maxChars?`(默认 6000) | `{configured,table,total,matches:[{domain,file,section,title,text,chars,truncated,anchor,ref,**role**,**ownerDomain**}],note?}`。`role` 是 `owner`（主属卡）/`consumer`（使用方视角卡） |

`asset` 的小节正文**首行带该节原标题**（第 19 轮）：anchor 常是纯编号（如 2.1），
不带标题会让 agent 丢失「这一节讲哪张表」的上下文（标题往往就是表名）。

#### 编辑与域管理（第 51 轮新增）

| 路径 | 参数 | 响应 |
|---|---|---|
| `GET /api/semantic/file` | `domain`*、`file`* | 编辑器取**全文**：`{domain,file,text,revision,source,kind,updatedAt,chars}` |
| `POST /api/semantic/file/save` | `{domain,file,text,expectedRevision?\|force?}` | 先落库 → 再重建索引 → 再（有条件）写盘。`{domain,file,revision,savedAt,indexOk,indexError?,wrote,writePath?,writeError?,writeNoTarget?}`。写盘目标优先级：该域 `exportDir` > 顶部「DB 写出路径」；都没有 → `wrote:false` + `writeNoTarget:true` |
| `POST /api/semantic/domain/create` | `{domain,title?}` | 建域 + 生成 4 个模板文件 → `{domain:{…},createdAt,indexOk,indexError?}` |
| `POST /api/semantic/domain/update` | `{domain,title?,exportDir?}` | 改标题 / 绑定导出目录（目录必须已存在，否则 400） |
| `POST /api/semantic/domain/delete` | `{domain,confirm:true}` | 只删 DB 记录，**不动导出目录里的文件**（响应里注明） |
| `POST /api/semantic/domain/tables` | `{domain,add:[{connectionId,database,table,role?,note?}],remove:[…],prefill?,force?}` | 同步关联表 + **一次性**插 `table-cards.md` 骨架。`{domain,added,removed,inserted:[{table,anchor,role}],revision,indexOk,ownerConflict?,prefillError?,indexError?}` |
| `GET /api/semantic/tables` | `connectionId`*、`database`*、`domain?` | 多域反查：`{connectionId,database,tables:[{table,refs:[{domain,role,note,unbound}],bound?}]}`。**第 52 轮**：反查同时返回「未绑定维度的全局关系」（`connectionId`/`database` 都是空串的 `backfill` 行），否则回填出来的表在任何真实库都查不到；传 `domain` 时每表多 `bound:boolean`（已与该域登记）并回 `boundTotal`/`boundMissing` |
| `POST /api/semantic/export` | `{domain,dir?}` | 写 `<dir>/<domain>/<file>.md`；目标优先级 `dir` > 该域 `exportDir` > 顶部「DB 写出路径」；都没有 → 400 `SEMANTIC_EXPORT_DIR_MISSING`。成功后把 `dir` 记为 `exportDir`。`{domain,dir,wrote:[{file,path,bytes}]}` |
| `POST /api/semantic/import` | `{dir,overwrite?,force?}` | 把目录的域读进 DB（`origin='doc'`）。`{imported:{domains,files,skipped},dir,indexOk,indexError?}` |
| `POST /api/semantic/refresh` | — | 强制从 DB 重建索引：`{configured,index:{…},domains,tookMs}`；0 个域 → `configured:false` + `error` 人话 |
| `POST /api/semantic/backfill` | `{dryRun?（默认 true）, domain?}` | **第 52 轮**：从各域现有 `table-cards.md` 解析表卡，回填「域↔表」关联。`{dryRun,domains:[{domain,cards,added,tables}],added,indexOk?,indexError?}` |
| `POST /api/semantic/config` | body `{exportDir,mustExist?,import?}`（老 `semanticDir` 兼容） | **第 52 轮语义**：保存「DB 写出路径」到 `meta.semantic_export_dir`；保存本身不要求目录已存在（导出时创建），`mustExist:true` 才校验；**默认不导入**，`import:true` 才把该目录当语义资产读进来。`{configured,exportDir,dirSource,domains,imported?,indexOk?,importError?}` |

#### 写操作的分阶段口径

写接口一律「**先落库、再重建索引、最后（有条件）写盘**」，且三步**分别上报**：

- 索引失败 **不回滚 DB**（索引是派生数据），响应 `200 + indexOk:false + indexError`；
- 写盘失败同理，`200 + writeError`，DB 内容不受影响；
- `expectedRevision` 与库里不一致 → **409 `SEMANTIC_FILE_CONFLICT`**（响应不带 `current`，
  客户端重新 `GET /file` 取最新再决定覆盖）；
- 单文件 > 512KB → 413 `SEMANTIC_FILE_TOO_LARGE`。

#### 多域归属（第 51 轮，对应「一张表可能属于多个领域」）

`semantic_domain_table` 是**多对多 + role**：`owner`（主属）/`consumer`（使用方视角）。
索引层与工具层本来就返回一表多卡，这里补的是**语义**：

- **owner 唯一是 API 层软约束**，DB 不建 UNIQUE（真实资产里存在归属争议，硬约束会挡住导入）。
  加表时若该表已被别的域 `owner` → 默认降级为 `consumer` 并在响应里给
  `ownerConflict:{table,ownerDomain}`；显式要 owner 需 `force:true`。
- 插入的骨架分两型：`owner` → 完整卡（粒度声明 + 核心字段字典 + 归属库 + 过滤口径）；
  `consumer` → 使用方视角卡（标题点明「主属 X」，正文交叉引用 `X/table-cards.md §2.N`，
  **不复制字段字典**）。这正是真实资产里 bill-clearing §2.9 的写法。
- `GET /api/semantic/table` 的每条 match 带 `role`/`ownerDomain`，`db_get_table_card`
  的 render 据此标注「主属卡」/「使用方视角卡（主属：X）」。

#### 存量资产回填（第 52 轮）

第 51 轮之前的资产是纯 markdown，`semantic_domain_table` 一直是 0 行，于是「关联数据表」
弹窗里没有任何表被打勾。`POST /api/semantic/backfill` 从每个域的 `table-cards.md` 解析出
表卡（`### 2.N \`表名\`` + demo-base-data 的分组式 `### 3.2 tbl_bill（…）`），补登记域↔表关系。

两条**回填专用**的过滤（索引层不需要，因此放在 `semantic/skeleton.py::cards_of`）：

1. **只看表卡章节**（`## 2.`~`## 5.`）：`## 1.` 是域级枚举，
   `### 1.1 扣款交易状态 \`trade_state\`` 这类会因白名单前缀 `bill*` 被误收成表；
2. **同域同名表只留一条**，主属卡优先于使用方视角卡。

回填**只登记关系、不碰正文**：不插骨架、不重编号。`connectionId`/`database` 记占位空串
（资产里没有可靠的库名信息，强行猜会让关联弹窗对不上）——因此 `GET /api/semantic/tables`
的反查**必须同时返回占位维度行**（见上表 `unbound`），否则回填数据在真实库上永远查不到。
实测真实 7 域解析出 **64 张表**（52 张卡 + 分组标题里点名的表），owner 冲突按先到先得降级，
最终 5 张使用方视角卡。

**重要行为约定**：关联表只在**首次关联**时插一次骨架，之后正文归编辑器独占 ——
关联表的增删不再回写 markdown（否则 DB 与 markdown 会互相覆盖）。
骨架锚点编号 = 现有 `### 2.N` 最大值 +1，**删除关联不重排号**（重排会让 agent 历史回答里
引用过的 anchor 失效）。编号与示例识别都**跳过 ``` 围栏代码块**。

#### 模板与「幽灵资产」

新建域的 4 个模板（`server/semantic/templates/*.md.tmpl`）里，所有示例内容必须缩进放在
代码块里 —— `parser` 的 heading / 术语表格识别是逐行正则（第 51 轮起虽已跳过围栏，但样例
格式仍需一致）。验收硬线：**新建空域解析结果必须是 0 表卡 / 0 术语 / 0 样例**
（`test_semantic_store.py::test_templates_produce_no_phantom_assets` 守着）。

#### 错误码

`SEMANTIC_INDEX_BUILDING`(503) / `SEMANTIC_DOMAIN_UNKNOWN`(404) / `SEMANTIC_FILE_UNKNOWN`(404) /
`SEMANTIC_SECTION_UNKNOWN`(404，列出前 20 个 section) / `SEMANTIC_DOMAIN_INVALID`(400) /
`SEMANTIC_DOMAIN_EXISTS`(409) / `SEMANTIC_FILE_CONFLICT`(409) / `SEMANTIC_FILE_TOO_LARGE`(413) /
`SEMANTIC_IMPORT_WOULD_CLOBBER`(409，覆盖到已存在或人工改过的文件时) /
`SEMANTIC_DISTILL_RUN_UNKNOWN`(404) / `SEMANTIC_DISTILL_RUN_CLOSED`(409)。
（`SEMANTIC_NOT_CONFIGURED` 自第 51 轮起不再出现：没有域不是错误，是空态。）

#### 首次升级补种

启动时若 **DB 里 0 个域**且导入源目录能发现域 → 自动导入一次（`semantic_meta.seeded`
保证只做一次，之后即使又删光域也不会反复回灌）。这是老用户升级后「7 个域不见了」的唯一防线。

检索用 LIKE + 结构化打分（表名/术语精确 > 标题 > 样例问题 > 正文），不依赖分词/FTS；
同一张表的多张语义卡（主属域 + 使用方域视角）全部返回。
`DBS_SEMANTIC_REFRESH_HOURS`（>0）仍保留（从 DB 重建的每日定时刷新）。

### 3.10 AI 蒸馏（第 51 轮新增，默认关闭）

把执行历史里的**只读查询**蒸馏成 `query-samples.md` 的金标样例候选。
模型调用在 **Host 半片**（只有 Host 能拿到 DSH 的 `llm` 服务），后端只做确定性部分。

数据流：

```
面板「AI 蒸馏」→ POST /db-studio/api/semantic/distill          （Host 前置路由）
  → POST /api/semantic/distill/candidates   确定性候选（SQL 已脱敏）
  → Host resolveUsableModel() → 模型只做「挑 + 整理」
  → 服务端硬校验（归一后必须逐字等于输入且仍是 SELECT）
  → POST /api/semantic/distill/run          存 run
  → 面板勾选 → POST /db-studio/api/semantic/distill/apply
  → POST /api/semantic/distill/apply        追加进 query-samples.md → 重建索引
```

| 路径 | 参数 | 响应 |
|---|---|---|
| `POST /api/semantic/distill/candidates` | `{domain?,connectionId?,from?,to?,limit?}` | `{scanned,deduped,window:{from,to},candidates:[{sqlScrubbed,count,lastSeen,connectionIds,databases,tables,purpose,historyIds}]}` |
| `POST /api/semantic/distill/run` | `{domain?,connectionId?,from?,to?,trigger?,model?,scanned?,deduped?,candidates?,status?}` | `{run:{id,status,…}}` |
| `POST /api/semantic/distill/apply` | `{runId,picks:[{question,sql,notes?,count?}]}` | `{run,domain,revision,applied,indexOk,indexError?}` |
| `GET /api/semantic/distill/runs` | `domain?`、`limit?`(1-100，默认 20) | `{runs:[…]}` |

**三条硬规则（都有测试守着）**：

1. **只收只读查询**：`kind='query'`、`status='ok'`、`source∈{panel,agent}`（排除 ticket/undo）、
   `sqlsplit.split_sql()` 恰好 1 条、`guard.first_keyword(sql)=='SELECT'`、
   不含 `INTO OUTFILE|DUMPFILE`。SHOW/DESC/EXPLAIN/SET/USE/任何写语句一律不进候选。
2. **字面量出站前脱敏**：字符串字面量与裸数字一律替换成 `?`（反引号标识符与其内数字保留）。
   发往模型与入 run 记录的**永远**是脱敏后的 SQL；原始 SQL 只留在 history。
3. **归一 + 计频**：空白折叠、去 `LIMIT ?` 后作为聚类键，按出现次数降序。
4. **严格域过滤（第 53 轮收紧，用户裁决）**：选了域时，SQL 涉及的**每一张表**都必须属于该域
   （owner 或 consumer 关联都算），`FROM 本域表 JOIN 其它域表` 的跨域 SQL **整条丢弃**，
   不许污染本域样例（旧逻辑是「碰到 ≥1 张本域表就放行」）。`domainFiltered` 字段回被丢弃的条数。

**时间窗**：默认最近 24 小时；显式 `from`/`to` 优先（`YYYY-MM-DD` 会补全天边界）。
**注意**：`history` 只保留最近 500 条（`config.HISTORY_MAX`），所以窗口内的可用历史受此限制。

**run 生命周期**：`running → ready → applied | discarded`（失败为 `failed`）。
`apply` 只追加**不覆盖**人工样例，样例编号接着现有最大 `Sxx` +1，
每条带「执行校验状态：AI 蒸馏（待人工核实）」与来源（次数 / 时间窗）。
**定时蒸馏**（`semanticDistillHours > 0`，默认 0 关闭）由 **Host 定时器**驱动，
只产生 `status='ready'` 的 run，**绝不自动写文件**。

## 4. Host 插件对外

### 4.1 浏览器通道（给 Client 半片）

`ctx.webServer.register({kind:'prefix', path:'/db-studio'})`，handler 内先 `connection.requestRejection` 鉴权，再把
`/db-studio/api/**` 原样转发进进程内引擎的 `/api/**`（`X-DBS-Actor: user`；V3 无进程间令牌）。

另加插件自己的探针：`GET /db-studio/api/health` →
`{ok,plugin,backend:{ready,error},connectionsCount,settings:{allowWrites,maxRows,timeout}}`。
**浏览器永远拿不到连接密码。**

### 4.2 agent 工具（16 个；语义层 4 个工具恒定注册，合计 20 个）

> 第 51 轮起**语义层工具不再有门禁**：`db_list_semantic_domains` / `db_search_semantics` /
> `db_get_semantic_asset` / `db_get_table_card` 与 NL2SQL 提示段**总是注册**，
> 没有业务域时工具照常可用、返回空域 + 引导文案（后端 `configured:false`）。
> 因此工具表恒为 16 个（`allowWrites=true`）/ 12 个（`allowWrites=false`）+ 4 个语义工具。

| 工具 | 参数 | 作用 | 守卫 |
|---|---|---|---|
| `db_status` | — | 后端是否就绪、连接数、写权限、写窗口状态（§3.3c）、待审批工单数、脱敏/语义层概况 | — |
| `db_list_connections` | — | 列连接（无密码） | — |
| `db_list_databases` | `connectionId` | 库/db 列表 | — |
| `db_list_tables` | `connectionId`,`database` | 表/视图列表 | — |
| `db_describe_table` | `connectionId`,`database`,`table`,`exactCount?` | 列/索引/DDL/行数 | — |
| `db_query` | `connectionId`,`database?`,`sql`,`maxRows?`,`purpose?` | 只读查询 | 后端 READONLY 守卫 + 慢 SQL EXPLAIN 门禁（仅 agent，§3.3）；purpose 随历史落库（§3.5） |
| `db_execute` | `connectionId`,`database?`,`sql`,`background`,`title?` | **提交写操作工单**，不直接执行 | 工单模式：人审批才执行；`direct` 模式退回「审批直执行」 |
| `db_write_rows` | `connectionId`,`database?`,`table`,`updates?`,`inserts?`,`deletes?`,`background?`,`reason?`,`title?` | **结构化行写（V2.3，§3.3b）**：主键定位 diff → 参数化 DML；ticket 建结构化工单 / direct 审批后执行 | 同 db_execute 策略；表必须有主键；≤200 行/次 |
| `db_list_tickets` | `status?`,`limit?`,`offset?` | 列工单（含待审批数量；**分页**：offset+limit 单页 ≤200，响应透出 `total/limit/offset`，文本提示用 offset 翻更早工单；第 47 轮补齐，面板/后端第 45 轮已分页） | — |
| `db_get_ticket` | `id` | 工单详情：状态 / 预估影响 / 实际影响 / 错误 | — |
| `db_export_query`（第 45 轮） | `connectionId`,`sql`（恰好一条 SELECT）,`background`,`database?`,`title?` | 提交数据导出工单（`export:true`；**唯一导出入口**，工作区导出同走此工单）：批准后程序分批取数（500 行/批，上限 1 万行），人在面板工单详情点「下载」选 xlsx/JSON/INSERT（前端转格式文件）；只读动作，不受 allowWrites 约束 | — |
| `db_list_history` | `limit?`,`connectionId?`,`keyword?` | SQL 执行历史 | — |
| `db_undo_last` | — | **撤销最近一次可撤销写（V2.2，§3.6a）**：direct 审批后执行反向语句；ticket 只查询并引导人工在面板撤销（agent 不能撤销） | direct：ctx.approval；快照仅覆盖单语句 UPDATE/DELETE/INSERT |
| `db_redis_scan` | `connectionId`,`database?`,`match?`,`cursor?`,`count?` | 键扫描分页 | 禁 KEYS |
| `db_redis_key` | `connectionId`,`database?`,`key` | 键详情 | — |
| `db_redis_command` | `connectionId`,`database?`,`command` | 任意 Redis 命令 | 写命令需审批 |
| `db_list_semantic_domains` | —（仅配置语义层时注册） | 语义层域清单：域 / 文件 / 表卡 / 样例 / 索引状态；业务问题的第一步 | — |
| `db_search_semantics` | `query`,`domain?`,`file?`,`limit?`,`snippetChars?` | 全文检索语义资产，返回域/文件/section/锚点/片段/打分 | — |
| `db_get_semantic_asset` | `domain`,`file`,`section?`,`offset?`,`maxChars?` | 读语义资产正文（带截断与 nextOffset）；不传 `section` 返回该文件目录（anchors） | — |
| `db_get_table_card` | `table`,`domain?`,`maxChars?` | 按表名取全部语义卡（含跨域使用方视角）+ join 路径；未建卡 = 200 + 空 matches | — |

**写操作的两条策略（config `writeMode`）**：

- `writeMode: 'ticket'`（默认，对应阿里云 DMS 工单）：`db_execute` **只创建工单**（带背景说明 + 预估影响行数），返回工单 id 和「等待人工审批」。它**不调用** `ctx.approval`——审批发生在面板的工单详情里，由人点「批准并执行」后才真正跑。
- `writeMode: 'direct'`：退回 v1 行为，`db_execute` 先过 `ctx.approval` 再立即执行（仍写执行历史）。

**没有任何工具能批准工单**：agent 只能提交和查询，审批入口只在浏览器面板（人）。这是刻意的防越权设计，不要为了"方便"加 `db_approve_ticket`。

`db_redis_command` 的写命令不走工单（Redis 命令不是 SQL 语句），仍用 `ctx.approval`。

**`direct` 模式与 Redis 写命令的审批**：

```js
const outcome = await ctx.approval.request({
  agent: exec.agent,                 // ToolExecutionInput.agent 可能 undefined → 直接拒绝
  toolName: 'db_execute',
  callId: exec.callId,
  reason: `将在 ${connectionName} 执行：${sql.slice(0, 200)}`,
  displayReason: { en: '...', zh: '将在 ... 执行 ...' },
  signal: exec.signal,
})
if (outcome !== 'allowed-once') → 返回错误，不执行
```

**工具可见性**：`allowWrites=false` 时用 `ctx.tools.register(def, { when: () => settings.allowWrites })` 让所有写工具（含工单提交）**根本不出现**在模型工具表里；只读工具不受影响。**语义层 4 个工具自第 51 轮起恒定注册**（不再看 `semanticLayerPath`；配置项只决定「文档导入源目录」）。

**NL2SQL 系统提示段**：**恒定注册**（第 51 轮起不再看是否配置语义层），Host 向系统提示注册一段工作流说明（`tool:db-studio:nl2sql`，order 160，≤1500 字：何时必查语义层、domains → search → asset(glossary 消歧) → table-card → query-samples → 生成 → 自检 → 只读 `db_query` 的工作流、硬规则、输出要求与自检清单）。成本是每次会话约 300 token。

### 4.3 结果呈现

每个工具都要给 `output.render`，返回 `[{type:'text', text}]`，文本是给人看的一句话摘要 + 关键数据；完整 JSON 由框架按 `output.schema` 落盘。查询类工具的描述里写明「最多返回 maxRows 行」。

### 4.4 脱敏 AI 分析：模型解析与自动回退（第 18 轮起唯一 AI 通道）

第 18 轮起**面板 AI 对话已下线**：`/db-studio/api/chat`、`/db-studio/api/chat/status`、`/db-studio/api/chat/models` 三条路由删除（请求得 404）。
Host 半片保留的唯一模型调用通道是连接表单的「AI 分析字段」（`/db-studio/api/masking/suggest`，请求体与响应见 §3.7），
调用方式为 `ctx.get('llm').prepareCall(...)` + `ctx.get('agentDefaultModel').currentSelection()`。模型不可用时优雅降级（回退后端规则分析），表单显示原因而不是白屏。

**模型解析与自动回退**：DSH 的 `agent-default-model` 可能指向**已删除的 provider**（用户删了自定义模型但没改默认选择）。此时
插件不能盲报"可用"：先用 `llm.listProviders()` 校验 provider 是否仍注册——
- 默认 provider 仍注册 → 用它；`prepareCall` 失败再回退；
- 默认 provider 未注册 → 自动回退到其它已注册 provider 的模型（每 provider ≤2 个、总共 ≤3 个，逐个 `prepareCall`，第一个成功的就用），响应里的 `model` 必须是**实际使用**的那一对，并带可执行说明；
- 一个 provider 都没有 → 明确报「没有可用的模型（已注册 provider: []）；请在 DSH 设置里配置并选择默认模型」，仍 200 + 后端规则分析回退（不 5xx）。

`db_status` 保留 `aiAvailable / aiProvider / aiModel / aiError` 字段名（消费者兼容），用户可见文案改为「脱敏 AI」；
AI 行要显示真实解析结果（可用 / 自动回退及原因 / 不可用及原因），不得盲报可用。

## 5. Client 半片

- `sidebar.panellist`：`{id:'db-studio', order:6, label:()=>'数据管理'}` + 图标组件。
- `main`（keyed `db-studio`）：整块面板，负责连接选择、元数据树、SQL 编辑执行、结果网格、（只读）Redis 浏览。
- 只请求 `db-studio/api/**`，同一个 origin，不需要 token。
- 主题一律用 DSH 输出的真实 token（**`var(--dsw-alias-*, fallback)`**，例如 `--dsw-alias-bg-base`、`--dsw-alias-label-primary`、`--dsw-alias-border-l2`、`--dsw-alias-link`、`--dsw-alias-danger`）；fallback 用 CSS 系统色（`Canvas`/`CanvasText`/`GrayText`），**不出现任何 hex/rgb 写死色**。文案中文为主，通过组件内 i18n 表集中管理。

### 5.1 右侧边栏 tab（第 10 轮新增）

数据管理面板除左侧栏入口外，还可以在 DSH **右侧边栏**以 tab 打开（与终端 / 文件 / 文档预览 / 计划等并列）。

**依赖**：`package.json` → `dsh.client.inject` 增加 `@deepseek-ai/dsh-client-ui-sidebar-right`；
Client 半片 `plugin.inject = ['slots', 'layout', 'sidebarRight', 'sidebarRightTabs']`。

**注册**（`C0-register.js`，全部放 `ctx.effect` 内，卸载时统一回收）：
- tab 类型：`ctx.sidebarRightTabs.register({ id: 'dsh-db-studio', kind: 'db-studio', title: () => '数据管理', guide: [{ id: 'open', order: 30, title, description, icon }] })`。
  **不设 `multiple`**（同一会话同一 pane 只有一个数据管理 tab）、**不设 `priority`**（默认 `extension` band，第三方插件的正确 band）；
  `id` 全局唯一，且就是下面两个槽的 key。
- body / title：`sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 两个 **keyed** 槽，key=`dsh-db-studio`；
  body 渲染同一个 `Panel`（`mode='sidebar'`），title 渲染图标 + 「数据管理」。
- guide 卡片由内置 guide 页渲染（`icon` 以 `{size,className}` 渲染）；点击卡片即内部执行 `tab.actions.openTab('db-studio', { replaceTab: true })`。

**打开 / 关闭入口**：

| 入口 | 实现 |
|---|---|
| 右栏 guide 卡片 | 内置 guide 页渲染，点击即打开 |
| 主面板工具栏「在侧栏打开」 | 先 `ctx.layout.selectPanel(null)` 切回会话，再以 50ms×≤40 次轮询 `ctx.sidebarRight.openTab('db-studio')`。**全局面板（main 槽）选中时 Conversation 不渲染、右栏 seat 未挂载，`openTab` 首次会同步抛 `sidebarRight: no session surface is mounted`——重试是必须的，不是兜底。** |
| 侧栏 tab 内「在主面板打开」 | `ctx.layout.selectPanel('db-studio')` |

**Session 作用域**：右栏 tab 布局按 Session 由 DSH 持久化（`localStorage['dsh.sidebar-right.v1.<sessionId>']`），切换会话各自独立；`openTab` 只作用于“当前屏幕上的会话”。插件卸载时遍历 `ctx.sidebarRight.openTabs.getSnapshot()`，把 `kind === 'db-studio'` 的 tab 用 `closeIn(sessionId, tabId)` 关掉（无 seat 时是 no-op；不关别的 kind）。

### 5.2 面板布局契约（第 10 轮新增）

- `Panel(props)`：`props.mode ∈ 'main' | 'sidebar'`（缺省 `main`）；`props.shell` 由注册层注入 `{ openInSidebar?, openInMain? }`，
  Panel 内部只调回调，**不直接碰 ctx**（主面板 / 右栏 body 由 C0 的两个 wrapper 分别注入）。
- 窄布局：`narrow = mode === 'sidebar' || 面板实测宽度 < 720px`（`ResizeObserver` 测 root，测不到时回退窗口宽度 / 1200）；
  root class 带 `is-narrow`、侧栏模式再加 `is-sidebar`。
- 左栏（连接 + 元数据）显隐：工具栏**一个**开关（`data-dbs-testid="toggle-side"`，文案「连接与元数据」）——
  第 50 轮把原来的 `toggle-connections` / `toggle-meta` 两个按钮合并成一个，二者不再分别开合。
  **默认（用户没手动设置过）跟随宽度**：narrow → 收起，宽 → 展开；用户点过开关后写
  `localStorage['dsh-db-studio:layout'] = {"showSide":boolean}` 记住显式选择，之后拉宽不会自动恢复（显式优先）。
  旧版 `{"showConnections","showMeta"}` 只做**读取兼容**（任一为 true 即视为展开），下次写入即迁移成 `{showSide}`。
- 左栏内部分区固定 **3:7**：连接区 `.dbs-conn-section` 占 30%、元数据区 `.dbs-tree-section` 占 70%
  （`flex: 3 1 0` / `flex: 7 1 0`）。连接行数超出时在 `.dbs-conn-list` 内独立纵向滚动（`overflow-y:auto`），
  不会把元数据区挤走；旧的 `max-height: 46%` 已移除。
- 头部按钮（`.dbs-head .dbs-btn`）的全部状态**统一白字**：激活态（`is-on`）用加深的白底 + 更强白描边表达，
  不再切回品牌蓝字 `var(--dbs-accent)`。
- narrow 下左栏是**覆盖式抽屉**（绝对定位 + `.dbs-drawer-mask` 遮罩 + 关闭 ×），不挤压主区。
- 侧栏模式：左栏默认收起；主区纵向排布、结果 tab 横向滚动；左栏收起时显示一行提示（`panel.sidebarHint`）。
- 文案：`panel.showSide` / `panel.hideSide`（aria-label 与 title）、`panel.sideToggle`（按钮文字）等 `panel.*` 中英文案在 `10-strings.js`。

### 5.3 语义层页（第 51 轮重写）

导航「语义层」（`app.nav.semantic`，在「脱敏策略」之后）→ `SemanticView`（`87-semantic-view.js`），
配套件在 `88-semantic-editor.js`。三栏：**域 / 文件 / 正文**。

- **域区**右上角只有 `+`（`data-dbs-testid="semantic-domain-new"`，建域弹窗）；**无域空态同样给这个入口**。
  域行显示 `origin` 徽标（`doc`=文档 / `system`=系统）。
  **第 52 轮删除了独立的「导入」按钮**：导入的唯一入口是顶部目录行的「保存并导入」。
- **正文区是全篇 `<textarea class="dbs-semantic-editor">`**（第 51 轮从 `<pre>` 改的可编辑形态），
  数据来自 `GET /api/semantic/file`（全文），**不再用 asset 的分页小节**。
- **标题树在文件列里内联展开（第 52 轮改动）**：点文件时该文件行下方展开一棵按 level 缩进的标题树，
  点标题把正文滚到该标题**最上方**并高亮当前项。树数据由客户端从原文按行扫 `/^(#{1,4})[ \t]+/` 得到，
  **必须跳过 ``` / ~~~ 围栏代码块**（与服务端 `parser.iter_headings` 同一规则）。
  **第 52 轮删除了正文区顶部那排小节 chips**（用户反馈「那其实是标题，做成目录形式」）。
- **底栏**：字数、`revision`、未保存标记、`保存并重建索引`（`data-dbs-testid="semantic-file-save"`）、Ctrl+S / Ctrl+Enter。
- **保存四态**（对应后端分阶段口径）：`已保存` / `已保存但索引重建失败：…` /
  `已保存，写回文件失败：…（DB 内容不受影响）` / **`已保存，但没有配置写出路径，无法重建成本地文件`**（`writeNoTarget`）；
  409 `SEMANTIC_FILE_CONFLICT` → 两个按钮「重新加载」/「覆盖保存（`force:true`）」；413 给独立文案。
- **文件区标题栏「关联数据表」** → 弹窗（连接→库→表多选）；**已与当前域关联的表默认打勾并置顶**
  （第 52 轮；存量资产已由 `POST /api/semantic/backfill` 回填出 64 条关联）。
  保存后提示「已在 table-cards.md §2 插入 N 个骨架」；有 `ownerConflict` 时提示按使用方视角添加。
- **顶部目录行（第 52 轮语义变化）**：标签是 `DB 写出路径`，`POST /api/semantic/config`
  body `{exportDir, import:true}`。`canRebuildFiles:false` 时在行下方给**警告条**（用 `rebuildHint` 原话），
  并禁用导出类按钮 —— 用户原话是「如果没填提示无法重建成本地文件」。
- **AI 蒸馏弹窗**：选域 + 时间区间（默认最近 24 小时）+ 运行 → 候选可勾选 → 应用到 `query-samples.md`；
  筛选行是**固定对齐网格**（输入框底边同一水平线，hint 挪到整行下方，第 52 轮修「参差不齐」）；
  接口失败只显示错误文案，**不白屏**。

**静态约束（`check-client-full` 硬断言，改动前先看）**：唯一 `require('react')`；全文件 `window.` 只出现 1 次；
禁 `addEventListener` / `setInterval`；`document` ≤4 处且只用于受控下载；禁写死 hex/rgb/hsl 颜色。
⚠️ 英文文案里**不要出现字面词 `document`**（正则 `\bdocument\b` 扫全文件，会打红 `document ≤ 4`）。

## 6. 验收口径

1. **V3 测试套件全绿**（`node tests/v3/run-all.mjs`，18 套件 ~596 例，替代旧 `pytest server/tests`）+
   四套引擎 e2e（`tests/v3/e2e-local-engine.mjs` / `e2e-tools-local.mjs` / `e2e-export.mjs` /
   `e2e-undo-tool.mjs` / `e2e-semantic-tools.mjs` / `e2e-distill.mjs`）+ Host 89 / AI 39 /
   client 815（`node scripts/build-client.mjs --check`）。
2. `db_status` / `db_list_connections` / `db_list_databases` / `db_list_tables` / `db_describe_table` / `db_query` 在真实 MySQL 连接上跑通。
3. 只读连接上 `db_execute` 被拒；`allowWrites=false` 时看不到写工具。
4. 面板能选中连接、展开库表、跑一条 SELECT 并显示网格。
5. 引擎随插件卸载释放全部句柄（外部连接池 → Redis 池 → SQLite 顺序关闭），进程自然退出。
6. **语义层（第 51 轮）**：
   - 面板语义层页 `+` 建域 → 生成 4 个文件 → 可编辑 → 保存后索引重建、agent 立刻 `db_search_semantics` 命中新内容；
   - 关联数据表 → `table-cards.md` 插入 `### 2.N` 骨架 → `db_get_table_card` 命中该表；
   - 删除 `semantic-index.db` 后仍能正常重建（内容在 `dbs.db`）；删掉导入源目录后域照常可用；
   - 导入真实 7 域后 agent 行为与第 50 轮一致；导出到临时目录再解析，表卡/样例计数不掉；
   - 新建空域解析结果必须是 **0 表卡 / 0 术语 / 0 样例**（模板不产出幽灵资产）。
7. **AI 蒸馏（第 51 轮）**：候选里非 SELECT 一条都没有；发往模型的 SQL 字面量已替换成 `?`；
   模型返回的 SQL 与服务端候选不一致时被丢弃；`apply` 只追加、不覆盖人工样例。
