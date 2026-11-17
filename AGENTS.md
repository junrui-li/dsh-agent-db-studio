# AGENTS.md — 仓库导航（给人 / 给 AI）

DSH 插件 `dsh-agent-db-studio`：把数据库管理接进 DeepSeek Harness（agent 用工具接管数据管理，人在 Web UI 面板里看得见、管得住）。
**V3**：数据库引擎在 Host 进程内运行（`src/host/server/`），无子进程、无端口；契约（`docs/CONTRACT.md`）是唯一权威。

## 目录地图（先看这里，别乱翻）

| 路径 | 说明 |
|---|---|
| `src/host.js` + `src/host/` | **Host 半片**：进程内引擎（`src/host/server/`：router 48 条路由 / core 守卫池快照 / api / store node:sqlite / semantic）+ 20 个 agent 工具 + 浏览器鉴权代理 + 面板 AI + AI 蒸馏通道 |
| `src/host/node_modules/` | **入库的 vendor 依赖**（mysql2 + ioredis，19 包）：升级流程见其 README.md |
| `src/client/parts/*.js` | **Client 半片源码**（28 个按功能分区的小文件，文件名前缀 = 拼接顺序）。改前端就改这里 |
| `dist/client/index.js` | **生成物**：parts 拼成的运行时单文件。**不要读、不要改、不要提交**（dist/ 已在 .gitignore） |
| `scripts/` | `build-client.mjs`（拼 Client） |
| `tests/v3/` | **V3 主测试套件**（`run-all.mjs` 聚合 20 套件 + 6 套引擎 e2e；主验收） |
| `tests/client/` | Client 装配/交互断言（`check-client.mjs` 基础 + `check-client-full.mjs` 822 项） |
| `tests/ai/` | Host AI 通道断言（`ai-tests.mjs` 39 项） |
| `docs/CONTRACT.md` | 接口与行为契约（唯一权威）；`docs/ROADMAP.md` 演进路线 |
| `server/data/` | **用户数据目录**（gitignored，磁盘保留）：`dbs.db` / `semantic-index.db` / `undo/` / `exports/`。由 `src/host/server/store/db.js`（node:sqlite）直接打开 |
| `.tmpcheck/` | 本地 scratch（gitignored，不入库）：临时脚本/日志/调试产物 |

## 硬规则

1. **Client 半片不要直接改生成文件**：改 `src/client/parts/*.js` → `node scripts/build-client.mjs`。
   插件激活时也会按需自动重建（parts 比 dist 新就重建），所以忘了 build 不会静默跑旧代码。
   提交前跑 `node scripts/build-client.mjs --check`。
2. 运行时约束：Client 半片必须是**单个模块**（`window.__ModuleLoader__.load` + `factory(require)`），
   factory 里只能 `require('react')`，**不能 import 相对文件**——所以才有 parts + 拼接。
3. `<dataDir>/`（默认 `server/data/`）有明文连接密码，已 gitignore，**绝不入库**；`.tmpcheck` 产物也不要提交。
4. Agent **不能**审批工单（无 approve 工具）；脱敏必须由引擎出站处理，agent 拿不到原始敏感值。
   **AI 蒸馏同理**：发往模型的 SQL 字面量必须先在后端替换成 `?`（`src/host/server/semantic/distill.js::scrubSql`）。
5. 插件重装用 `plugin_manager set_bundle` 开关；**不要** `remove_bundle`+`install_bundle`
   （会触发 pnpm 重装，可能删掉别的插件；真要做先备份 profile 的 package.json）。
6. **语义层的事实来源是 `dbs.db`，不是 markdown 文件**。`semantic-index.db` 是派生索引，
   删了会从 DB 重建。写盘目标优先级：该域 `export_dir` > 顶部「DB 写出路径」
   （`DBS_SEMANTIC_EXPORT_DIR` / `meta.semantic_export_dir`）；都没有则只写 DB 并回 `writeNoTarget`。
   盘上文件被外部改动**不会自动回流**（要显式导入）。
7. **parser 的 heading / 术语表格识别按行正则**（`src/host/server/semantic/parser.js`），围栏内的行跳过，
   但新建模板仍必须把示例内容放进代码块，否则会造出幽灵表卡/术语（模板幽灵资产测试守着）。
8. **语义层回填数据是「占位维度」**：`backfill` 写进 `semantic_domain_table` 的
   `connection_id` / `database_name` 都是空串（资产里没有可靠库名），所以 `store.table_refs()` 的反查
   **必须同时接受空维度行**，否则面板「关联数据表」永远查不到任何表、也不会打勾。
   以后新增任何按维度筛选域↔表的逻辑，都别只做精确匹配。
   另：`skeleton.cards_of()` 只扫 `## 2.`~`## 5.`，因为 `## 1.` 是域级枚举。
9. **V3 行为规格 = `tests/v3/`**：改 `src/host/server/` 下任何模块前，先看对应套件；
   中文错误文案、状态枚举、守卫顺序逐字对齐。

## 常用命令

需要 **Node ≥ 24**（`node:sqlite` STRICT 表 + `import.meta.dirname`）；任何满足版本的 node 均可，跨平台。

```bash
# Client 构建 / 一致性检查
node scripts/build-client.mjs
node scripts/build-client.mjs --check

# 前端全量断言（需要先 build，读 dist/client/index.js）
node tests/client/check-client.mjs
node tests/client/check-client-full.mjs

# Host AI 通道
node tests/ai/ai-tests.mjs

# V3 主测试套件
node tests/v3/run-all.mjs
node tests/v3/e2e-local-engine.mjs
node tests/v3/e2e-undo-tool.mjs
# 真数据 e2e（依赖本机 server/data/dbs.db；缺失或 DBS_E2E_REAL=0 优雅跳过）
node tests/v3/e2e-tools-local.mjs
node tests/v3/e2e-export.mjs
node tests/v3/e2e-semantic-tools.mjs
node tests/v3/e2e-distill.mjs
```

改完代码的验收口径：`build --check` + 测试全绿。

- **基线**：client **822**（两套 client 断言）+ ai **39** +
  V3 主套件 **20 文件 519 例** + 引擎 e2e **50 例**（六套：engine 10 / tools 17 / export 7 /
  semantic 6 / undo 5 / distill 5；后四套真数据门禁，公开环境以自包含套件为准）。
  e2e-tools/export 中真连 MySQL 的用例依赖本机网络可达；unreachable 时这些用例失败不算回归。