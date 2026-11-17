/**
 * 后端能力错误与错误码 → 中文指引表（V3 唯一位置；tools.js 之外的错误翻译全走这里）。
 */

/** 后端能力错误：message 已经是给模型看的中文原因（V3 进程内引擎与路由层共用）。 */
export class BackendError extends Error {
  constructor(message, { status, code } = {}) {
    super(message)
    this.name = 'BackendError'
    this.status = status
    this.code = code
  }
}

/** 后端常见机器码 → 该怎么办（给模型的中文可执行建议）。 */
export const ERROR_HINTS = {
  READONLY: '只读连接只允许 SELECT/SHOW/DESC/DESCRIBE/EXPLAIN/USE/SET',
  NO_WHERE: 'UPDATE/DELETE 必须带顶层 WHERE 条件',
  SLOW_SQL_RISK: '慢 SQL 门禁：大表全表扫描（type=ALL 且表数据量达分档阈值）或估算行数超限——收窄过滤条件/时间窗、改走有索引的列，或分页限量后重试',
  CONNECTION_NOT_FOUND: '连接不存在，先用 db_list_connections 确认 connectionId',
  UNAUTHORIZED: '后端令牌不匹配（后端可能不是本插件拉起的）',
  // 撤销（契约 §3.6a）：UNDO_EXECUTE_FAILED 时原变更仍在（反向执行已回滚），可以修好条件后重试。
  UNDO_NOT_FOUND: '没有可撤销的变更：写执行被标记不可撤销（多语句/多表/DDL/超限）或快照已过期',
  UNDO_STATE: '快照状态已变化：只有 active 可以撤销；undoing/undone 都是并发或已撤销',
  UNDO_SNAPSHOT_GONE: '快照文件已清理或损坏（超过保留条数），该变更无法再撤销',
  UNDO_EXECUTE_FAILED: '撤销执行失败且已回滚，原变更仍在——先查清反向语句失败原因再重试',
  WRITES_CLOSED: '写窗口未开启（会话级写总闸，到时自动关）：请让用户在面板「数据管理 → 工单」点「临时开闸」（15/30/60 分钟）后重试',
  WRITES_WINDOW_MINUTES: '开闸时长只允许 15/30/60 分钟',
  KEYS_DISABLED: 'Redis KEYS 命令被禁用，请改用 db_redis_scan 分页扫描',
  SELECT_DISABLED: 'Redis SELECT 命令被禁用，请用 database 参数选择 db',
  // 业务语义层（契约 §3.9）：错误要给模型一条能直接照做的下一步。
  SEMANTIC_NOT_CONFIGURED: '语义层未配置：让用户在插件配置 semanticLayerPath 填语义层目录，配置后重载插件',
  SEMANTIC_INDEX_BUILDING: '语义层索引正在构建：等待几秒后重试本次调用',
  SEMANTIC_DOMAIN_UNKNOWN: '业务域不存在：先用 db_list_semantic_domains 确认域名再重试',
  SEMANTIC_FILE_UNKNOWN: '语义文件不存在：先用 db_list_semantic_domains 查看该域下的文件列表',
  SEMANTIC_SECTION_UNKNOWN: '语义小节不存在：先不带 section 调 db_get_semantic_asset 查看目录（anchors）再取正文',
}
