/**
 * dsh-agent-db-studio —— Client 半片：Web UI「数据管理」主面板
 *
 * ⚠️ 本文件（以及 src/client/index.js）是由 src/client/parts/*.js 拼接生成的运行时单文件，
 *    **不要直接改 index.js**——改对应的 part，然后运行：node scripts/build-client.mjs
 *    （提交前可用 node scripts/build-client.mjs --check 校验有没有忘记重新生成。）
 *
 * 为什么要拆：DSH 的 Client 半片必须是单个模块（factory 里只能拿宿主注入的 react，
 * 不能 import 相对文件），所以源码拆成多个 part、运行时再拼起来。
 *
 * part 顺序（文件名前缀决定拼接顺序）：
 *   00-header            入口外壳与常量
 *   10-strings           中英文文案表
 *   20-http              /db-studio/api 请求封装
 *   30/35/36-*           格式化工具、导出工具（INSERT/JSON/XLSX）、结果/表格工具
 *   40-components        通用小组件
 *   50-hooks             useAsync 等
 *   60/65/66/67/68-*     连接列表、脱敏与连接辅助函数、脱敏策略树、脱敏编辑器、连接弹窗
 *   70-meta-tree         元数据树
 *   80/81/82/85-*        结果网格、结果卡片、单行详情弹层、表详情
 *   87-semantic-view     语义层视图（域 → 文件 → 小节 → 正文 + 全量刷新）
 *   90-workbench         SQL 工作区（编辑器 + 结果区）
 *   95/97/98-*          Redis 浏览、工单、执行历史
 *   A0/B0/C0-*           根面板、样式、slot 注册
 */

    const PANEL_KEY = 'db-studio'
    const API_ROOT = 'db-studio/api'
    const DEFAULT_MAX_ROWS = 500
