# dsh-db-studio

**DeepSeek Harness（DSH）插件：让 agent 接管数据管理**——查库、看表结构、跑 SQL、按审批改数据，都由 DSH 里的 agent 直接干；人在 Web UI 的「数据管理」面板里看得见、管得住。

## 它不是又一个数据库 GUI

传统 DMS 是"人点鼠标操作数据库"。这里的定位是：

- **agent 有手**：20 个 `db_*` 工具直接暴露给模型（含 4 个语义层工具，恒定注册），查元数据/跑查询是普通工具调用，不需要人去点点点。
- **写操作走工单**：AI 想执行非查询语句时**不能直接执行**，只能提交一张工单（SQL + 背景说明 + 预估影响行数），由人在面板点「批准并执行」后才跑——对标 DMS 工单。只读连接与服务端守卫仍然是硬拦。
- **面板是观测面**：Web UI 里的「数据管理」面板给人看现状（连了哪些库、表结构、刚跑的 SQL、待审批工单、执行历史），不是必须操作的入口。

## 架构

V3 起数据库引擎**收编进 Host 进程**（Node 实现，`node:sqlite` 做持久化，vendor 入库的 mysql2 / ioredis 连外部库）：无子进程、无监听端口、无进程间令牌。

```
┌──────────────────────── DSH Host 进程 ────────────────────────┐
│  src/host.js（Host 半片）                                      │
│   ├─ src/host/server/ 进程内引擎 ── router 48 条路由            │
│   │    core（守卫/池/快照/门禁/脱敏）· store（SQLite）· semantic │
│   ├─ ctx.tools.register × 20 ──► agent 直接调用                │
│   ├─ ctx.approval.request     ──► direct 模式 / Redis 写命令    │
│   ├─ src/host/ai.js（ctx.llm）──► 脱敏字段 AI 分析（解析/回退）  │
│   ├─ src/host/semantic.js ──► NL2SQL 语义工具 + 工作流提示     │
│   └─ ctx.webServer /db-studio ──► 带鉴权的浏览器通道            │
└───────────────────────────────────────────────────────────────┘
        ▲ 同 origin，DSH 登录鉴权（fail closed）
┌───────┴──────── DSH Web UI（浏览器）──────────────────────────┐
│  src/client/parts/*.js（Client 半片，构建为 dist/client/index）│
│   ├─ sidebar.panellist：「数据管理」入口 → 中央面板             │
│   └─ 右侧边栏 tab（右栏 guide 卡片 / 主面板「在侧栏打开」）     │
└───────────────────────────────────────────────────────────────┘
```

浏览器半片只跟 Host 的 `/db-studio/api/**` 说话，**永远拿不到连接密码**；脱敏在引擎出站前完成，浏览器与 agent 拿到的都是掩码值。

## 面板

**入口**
- 左侧栏「数据管理」图标 → 整块中央面板；
- 也可以从 **DSH 右侧边栏**打开：右栏 guide 页里的「数据管理」卡片，或主面板顶栏的「在侧栏打开」；右栏 tab 内点「在主面板打开」可切回中央面板。右栏 tab 与终端/文件/文档预览等并列，内容与主面板同源（同一套 `Panel` 组件，`mode='sidebar'` 紧凑布局）。

**窄面板自动收起**：面板宽度 < 720px 或处于右侧边栏时，**连接管理与元数据树默认收起**；顶栏两个开关可随时展开（窄时为**覆盖式抽屉**，遮罩/× 关闭，不挤压主区）。用户点过开关后记住显式选择（`localStorage['dsh-db-studio:layout']`）；没手动设置过时跟随宽度自动默认。

中央面板顶部五个视图：**工作区 / 工单 / 历史 / 脱敏策略 / 语义层**。

**工作区**
- **连接独立 tab**：从左侧点不同的连接会各自开一个 tab，互不覆盖——每个 tab 保留自己的 SQL、结果集、选中的库/表与 Redis 浏览位置；关闭 tab 自动激活邻居，全关回到引导页。新建连接保存后自动开 tab。
- **可拖拽的结果区**：SQL 编辑器与结果区之间有一条分隔条，上下拖动可实时调整比例（双击复位、比例记在本地），结果区占满剩余高度、内部滚动。
- **连接管理**：新建 / 编辑 / 删除 / 测试连接（MySQL、Redis）。密码只存在引擎数据目录，界面只显示"已设置"；编辑时留空即保留原密码。
- **元数据树**：库 → 表/视图，看列 / 索引 / DDL，可点「精确行数」（`COUNT(*)`）；表搜索支持模糊匹配（子序列）。
- **SQL 编辑器**：关键字 + 表名 + 字段名补全（打 `t.` 自动出该表列名，别名从 `FROM/JOIN` 解析），**模糊匹配**——前缀优先，但打错一个字母（`customr`→`customer`）、只记得部分字母（`usrnm`→`user_name`）、或词中段命中（`name`→`user_name`）都能出候选；`Ctrl+Enter` / `F5` 执行，多语句的结果按 **tab** 切换。
- **结果网格**：NULL 灰显、行数 / 耗时 / 截断提示；结果集可关闭；最左有复选框可**勾选行**（表头全选、显示已选行数）。
- **导出**：支持「导出选中行」或「导出整个结果集」，三种格式——**INSERT 语句 / JSON / Excel(.xlsx)**（xlsx 由前端零依赖生成，导出内容就是当前已脱敏的展示值，不做还原）。大结果集导出走**导出工单**（批准后引擎分批取数落盘，面板下载）。
- **Redis 浏览**：SCAN 分页列键，点键看类型 / TTL / 值（string 里的 JSON 会格式化）。

**工单**
- 列表：状态过滤（待审批 / 已成功 / 失败 / 已驳回 / 已取消）+ 待审批红点徽标。
- 详情：完整 SQL、背景说明、**预估影响行数**（`EXPLAIN` 估算 + 风险等级 + 每条语句的表/是否有 WHERE）、**实际影响行数**、耗时、错误、时间线。
- 操作：`批准并执行`（同步执行单事务，失败整体回滚）、`驳回`（可填审批意见）、`取消`。只有「待审批」的工单能操作。
- **一张工单可以放多条 SQL**（`;` 分隔）：批准后在**同一个事务**里按顺序执行，任一条失败整体回滚，不会部分生效。
- **agent 没有批准能力**——它只能提交和查询，审批入口只在这里。

**历史**
- SQL 执行历史：时间 / 连接 / 库 / SQL / 状态 / 来源（面板 · agent · 工单）/ 耗时 / 行数或影响行数，可按连接、状态、关键字、**时间范围**过滤；默认一页 **500 条**，支持**翻页**。
- 详情面板带 **EXPLAIN 计划**与 agent 的 **purpose 摘要**（同一业务问题的多次查询可据此归组）。
- 点「载入编辑器」把某条历史 SQL 灌回工作区**新查询 tab**（自动切连接与库）。

## 数据脱敏（连接级）

在连接里开启「脱敏模式」后，**该连接所有查询结果在引擎出站前就被掩码**——agent 工具、面板、工单执行结果拿到的都是掩码值，
**不存在"先取原始数据、再在 Host/浏览器里脱敏"的路径**，也没有任何"查看原文/关闭脱敏"的接口或参数。

- **内置五种（开启即强制，不可删除）**：姓名、手机号、身份证号、银行卡号、邮箱。界面上勾选锁定、保存时强制补回，配置过期也不会失效。
- **判定三层叠加**（任一命中即掩码，取更严格的类型）：
  1. 配置层：AI/规则分析后保存的 `masking.fields`；
  2. **列名启发式层（每次查询实时判）**：结果列的**原始列名**（驱动报告的 `org_name`，ALIAS 后仍是源列名）命中内置命名 → 对应类型；
  3. **值级兜底层**：手机号正则、身份证 GB 11643 校验位、银行卡 Luhn 校验，命中即掩码（防未知列/表达式绕过）。
- **算法**（参考国家/行业通行做法）：

| 类型 | 规则 | 示例 |
|---|---|---|
| 姓名 | 保留姓，其余 `*` | 张三 → 张*；欧阳娜娜 → 欧*** |
| 手机号 | 前 3 + `****` + 后 4 | 13812345678 → 138****5678 |
| 身份证 | 18 位前 6 + `*`×8 + 后 4 | 110101199003071234 → 110101********1234 |
| 银行卡 | 前 6（BIN）+ `*` + 后 4 | 6222021234567890123 → 622202*********0123 |
| 邮箱 | 保留本地部分首字符 + `***` + `@域名` | zhangsan@example.com → z***@example.com |

- **策略维护（树状页面）**：`数据连接 → 数据库 → 数据表 → 字段`，每个字段显示字段名 / comment / 脱敏策略，可逐个改；内置五类强制字段锁定不可改。连接里点「AI 分析字段」识别完成后候选直接回填策略；顶部「脱敏策略」视图可随时维护。
- **筛选走连接级查询**：搜索框（字段名 / 表名 / 注释）和「只看已脱敏」按连接全库查询并以「库 → 表 → 字段」扁平展示；清空筛选立刻回到懒加载树并保留展开状态。
- **关闭脱敏不会删策略**；再次开启直接沿用。
- **AI 分析**：模型不可用会自动回退其它已注册模型，仍不行才回退引擎规则分析（显示具体原因）。内置五类永远强制。
- `NULL`/空串原样；已含 `*` 的值不会二次掩码（幂等）。

## NL2SQL / 业务语义层

**事实来源是 `dbs.db`**（不是磁盘上的 markdown）：语义层是「可运营的业务资产」，在面板里建域、关联表、直接改正文，agent 立刻能检索到。

- **4 个语义工具恒定注册**：`db_list_semantic_domains`（业务问题第一步）、`db_search_semantics`（LIKE + 结构化打分检索）、`db_get_semantic_asset`（按文件读目录/正文，带截断与 nextOffset）、`db_get_table_card`（按表名取全部语义卡 + join 路径，并标明主属卡 / 使用方视角卡）。
- **NL2SQL 工作流提示**：系统提示恒定注册一段 ≤1500 字的工作流——回答业务问题先查语义层资产；只用卡中出现过的表/列，状态/枚举/金额单位/跨库 JOIN 口径以资产为准，口径模糊先向用户澄清；只读查询走 `db_query`（agent 的 SELECT 执行前有 **EXPLAIN 慢 SQL 门禁**），写操作仍走工单审批。
- **面板「语义层」选项卡**（新建域 / 导入 / 关联数据表 / 编辑正文）：新建域自动生成 4 个文件（`table-cards.md` / `glossary.md` / `query-samples.md` / `prompt-template.md`）；保存后重建索引（`semantic-index.db` 是**派生**索引，删了会从 DB 重建）；同一张表可属于多个域（owner 主属卡 / consumer 使用方视角卡）。
- **导入 / 导出**：`semanticLayerPath` 只是「文档导入源目录」；导入把 markdown 读进 DB，导出把 DB 写成 `<dir>/<域>/<文件>.md`。盘上改动**不会自动回流**，要显式重新导入。
- **AI 蒸馏（默认关闭，`semanticDistillHours > 0` 开启）**：从执行历史里筛只读查询，**SQL 字面量先在后端替换成 `?`** 再交给模型「挑 + 整理」，模型给的 SQL 必须逐字命中后端候选才采信，产出 `query-samples.md` 候选，人工勾选后才写入。定时任务只产候选、**绝不自动写文件**。
- 没有业务域时 4 个工具照常可用，只返回空域 + 引导文案。

## 安全模型

1. **只读连接**：引擎词法扫描首关键字，非 `SELECT/SHOW/DESC/EXPLAIN/USE/SET` 一律 403。建工单时同样拦。
2. **无 WHERE 拦截**：`UPDATE`/`DELETE` 缺顶层 `WHERE` 直接拒绝（引号与注释感知）。
3. **写窗口**：`allowWrites=true` 之外还有一道会话级「写窗口」（面板临时开闸、到时自动关），关闸时写执行 403。
4. **工单审批**：`db_execute` 默认只提交工单，人在面板批准后才在**单事务**里执行；失败整体回滚。
5. **agent 无审批权**：没有任何工具能批准工单——模型不能给自己放行。
6. **密码不出进程**：读接口只回 `hasPassword`；引擎与 Host 同进程，浏览器拿不到密码。
7. **脱敏在引擎出站前**：没有还原接口，工具层也没有任何脱敏/还原参数。详见[数据脱敏](#数据脱敏连接级)。
8. **变更前快照 + 撤销**：可撤销的写执行前落快照，`db_undo_last` 反向恢复（同样过写窗口/审批）。

## 安装与配置

要求：**Node ≥ 24**（`node:sqlite` STRICT 表）。插件以 bundle 形式装进 DSH profile（仓库即安装源），无需 Python、无需额外服务进程。

**安装插件**：用 DSH 自带的 `dsh` CLI（在 profile 目录内转发 pnpm；桌面应用的 profile 名为 `desktop`）：

```sh
# 本地安装：在仓库的上级目录执行，或改为绝对路径
dsh plugin --profile desktop add ./dsh-db-studio

# 或从 git 仓库安装（也可用 npm 包名）
dsh plugin --profile desktop add git+https://github.com/<用户>/dsh-db-studio.git
```

首次使用会自动初始化 profile；本包声明了 `dsh.bundle`，会被自动追加进 `dsh.profile.bundles` 并启用。也可以在 DSH 会话里让 agent 调 `plugin_manager(action="install_bundle", target="<仓库绝对路径或安装规格>")` 安装（同一套 pnpm 实现，需放行 full-access 审批）。

**从 git 仓库安装需要一次性构建授权**：pnpm ≥ 10 默认拒绝运行 git 依赖的 `prepare` 脚本，首次 `add` git 仓库会失败；按 `dsh` 的提示把包键写进该 profile 的 `pnpm-workspace.yaml`，再重新执行 `add`：

```yaml
allowBuilds:
  dsh-db-studio: true
```

`prepare` 只是把 `src/client/parts/*.js` 拼成 `dist/client/index.js`；本地路径安装（`./dsh-db-studio`）不依赖它，插件激活时会自动按需重建，忘了 build 也不会静默跑旧代码。

- 数据目录默认 `<仓库>/server/data`（`dbs.db` / `semantic-index.db` / `undo/` / `exports/`）。**库里含明文连接密码，`.gitignore` 已排除 `server/data/` 与所有 `*.db`，绝不入库。**
- 配置以 `cordis.patch.yml` 为准（插件没有设置页）：`allowWrites` / `writeMode` / `maxRows` / `timeout` / `undoMaxRows` / `undoKeep` / `semanticLayerPath` / `semanticMaxChars` / `semanticRefreshHours` / `semanticDistillHours`。改完用 `plugin_manager set_bundle` 关→开重载（**不要** `remove_bundle`+`install_bundle`，会触发依赖重装、可能殃及别的插件）。
- `allowWrites: true` 后写工具才注册。默认 `writeMode: ticket`：`db_execute` 只提交工单；`direct` 才过一次 DSH 审批弹窗后立即执行。`db_redis_command` 的写命令始终走审批。
- 面板/工具行为细节见 [src/host/README.md](src/host/README.md) 与 [docs/CONTRACT.md](docs/CONTRACT.md)。

## agent 工具（20 个）

| 工具 | 作用 | 守卫 |
|---|---|---|
| `db_status` | 引擎是否就绪、连接数、写模式、待审批工单数、脱敏 AI 可用性、语义层状态 | — |
| `db_list_connections` | 列连接（不回密码） | — |
| `db_list_databases` | 库 / Redis db 列表 | — |
| `db_list_tables` | 表与视图列表 | — |
| `db_describe_table` | 列、索引、DDL、行数 | — |
| `db_query` | 只读查询（多语句、出错即停） | 只读白名单硬拦 + 慢 SQL EXPLAIN 门禁（仅 agent） |
| `db_execute` | **提交写操作工单**（SQL + 背景说明 + 预估影响行数） | ticket：人工审批才执行；direct：逐次审批 |
| `db_write_rows` | 结构化行写（插入/更新/删除行） | 同写窗口 + 工单/审批 |
| `db_undo_last` | 撤销最近一次可撤销变更 | ticket 报告 / direct 审批 |
| `db_export_query` | 提交数据导出工单（批准后分批取数、面板下载） | 只读动作，人工批准 |
| `db_list_tickets` | 列工单与各状态数量 | — |
| `db_get_ticket` | 工单详情：预估/实际影响行数、审批信息、错误 | — |
| `db_list_history` | SQL 执行历史（可按连接/关键字过滤） | — |
| `db_redis_scan` | 键扫描分页 | 禁 `KEYS` |
| `db_redis_key` | 键详情（类型/TTL/值） | — |
| `db_redis_command` | 任意 Redis 命令 | 写命令需审批 |
| `db_list_semantic_domains` | 语义层域清单 | 恒定注册 |
| `db_search_semantics` | 全文检索语义资产（锚点 + 片段 + 打分） | 恒定注册 |
| `db_get_semantic_asset` | 读语义资产正文（可先取目录，带截断续读） | 恒定注册 |
| `db_get_table_card` | 按表名取全部语义卡 + join 路径 | 恒定注册 |

`allowWrites=false` 时写工具不注册，可见 16 个。**没有任何「批准工单」的工具**。完整参数与返回形状见 [docs/CONTRACT.md](docs/CONTRACT.md)。

## 开发

```bash
# Client 半片源码是拆开的（src/client/parts/*.js），运行时单文件 dist/client/index.js 由脚本生成
# （dist/ 不入库；插件激活时会自动按需重建，忘了 build 也不会跑旧代码）
node scripts/build-client.mjs            # 手动构建
node scripts/build-client.mjs --check    # 一致性校验（提交前跑）

# 验收（Node ≥24，跨平台）
node tests/client/check-client.mjs       # Client 装配基础断言
node tests/client/check-client-full.mjs  # Client 全量结构/交互冒烟（822 项）
node tests/ai/ai-tests.mjs               # 脱敏 AI / 模型回退 / 代理 / 蒸馏（39 项）
node tests/v3/run-all.mjs                # V3 主套件（20 文件 519 例）
node tests/v3/e2e-local-engine.mjs       # 引擎组装 e2e（自包含）
node tests/v3/e2e-undo-tool.mjs          # 撤销链路 e2e（自包含）
```

真数据 e2e（`e2e-tools-local` / `e2e-export` / `e2e-distill` / `e2e-semantic-tools`）依赖本机 `server/data/dbs.db`（不入库）：缺失或 `DBS_E2E_REAL=0` 时整套优雅跳过。

**排障**：脱敏 AI / 蒸馏每次调用往 `<数据目录>/host.log` 写阶段日志（模型 finish 原因、输出长度、耗时、失败原因）；连接表单上也会直接显示失败原因。

## 相关

- 接口契约：[docs/CONTRACT.md](docs/CONTRACT.md)
- Host 半片模块说明：[src/host/README.md](src/host/README.md)
- 演进路线：[docs/ROADMAP.md](docs/ROADMAP.md)
- 许可证：[MIT](LICENSE)