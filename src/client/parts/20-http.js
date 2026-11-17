
    // ======================================================================
    // 2. HTTP —— 只打 /db-studio/api/**，统一解析 {error} 错误体
    // ======================================================================

    function isAbort(error) {
      return Boolean(error && error.name === 'AbortError')
    }

    /**
     * @param {string} path 以 / 开头的子路径
     * @param {{method?:string, body?:object, signal?:AbortSignal}} options
     */
    async function request(path, options) {
      const settings = options || {}
      const init = {
        method: settings.method || 'GET',
        headers: { accept: 'application/json' },
        signal: settings.signal,
      }
      if (settings.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(settings.body)
      }
      let response
      try {
        response = await fetch(API_ROOT + path, init)
      } catch (error) {
        if (isAbort(error)) throw error
        const reason = error && error.message ? error.message : String(error)
        throw new Error(t('error.network', { message: reason }))
      }
      let raw = ''
      try {
        raw = await response.text()
      } catch (error) {
        raw = ''
      }
      let payload = null
      if (raw) {
        try {
          payload = JSON.parse(raw)
        } catch (error) {
          payload = { error: t('error.badResponse', { message: raw.slice(0, 200) }) }
        }
      }
      if (!response.ok) {
        const message = payload && typeof payload === 'object' && payload.error
          ? String(payload.error)
          : 'HTTP ' + response.status
        const failure = new Error(message)
        failure.status = response.status
        if (payload && typeof payload === 'object' && payload.code) failure.code = String(payload.code)
        throw failure
      }
      return payload === null ? {} : payload
    }

    /** 拼查询串：跳过空值，避免 `?status=&keyword=` 这类噪音。 */
    function queryString(params) {
      const pairs = []
      const source = params || {}
      Object.keys(source).forEach(key => {
        const value = source[key]
        if (value === undefined || value === null || value === '') return
        pairs.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(value)))
      })
      return pairs.length ? '?' + pairs.join('&') : ''
    }

    const api = {
      health: signal => request('/health', { signal }),
      connections: signal => request('/connections', { signal }),
      databases: (connectionId, signal) => request(
        '/meta/databases?connectionId=' + encodeURIComponent(connectionId), { signal },
      ),
      tables: (connectionId, database, signal) => request(
        '/meta/tables?connectionId=' + encodeURIComponent(connectionId)
          + '&database=' + encodeURIComponent(database), { signal },
      ),
      table: (connectionId, database, table, exactCount, signal) => request(
        // 第 49 轮：改走 queryString（跳过空值）——此前 encodeURIComponent(undefined) 会把
        // 未选库时的 database 编码成字面 "undefined"，主键预取查空列导致编辑按钮恒置灰
        '/meta/table' + queryString({
          connectionId,
          database,
          table,
          exactCount: exactCount ? 1 : '',
        }), { signal },
      ),
      query: (body, signal) => request('/query', { method: 'POST', body, signal }),
      redisScan: (body, signal) => request('/redis/scan', { method: 'POST', body, signal }),
      redisKey: (body, signal) => request('/redis/key', { method: 'POST', body, signal }),
      saveConnection: connection => request('/connections/save', { method: 'POST', body: { connection } }),
      deleteConnection: id => request('/connections/delete', { method: 'POST', body: { id } }),
      testConnection: payload => request('/connections/test', { method: 'POST', body: payload }),
      maskingSuggest: (body, signal) => request('/masking/suggest', { method: 'POST', body, signal }),
      maskingAnalyze: (body, signal) => request('/masking/analyze', { method: 'POST', body, signal }),
      maskingPolicies: (body, signal) => request('/masking/policies', { method: 'POST', body, signal }),
      maskingColumns: (params, signal) => request('/masking/columns' + queryString(params), { signal }),
      history: (params, signal) => request('/history' + queryString(params), { signal }),
      tickets: (params, signal) => request('/tickets' + queryString(params), { signal }),
      ticketDetail: (id, signal) => request('/tickets/detail' + queryString({ id }), { signal }),
      // 人工建单（第 25 轮）：面板工作区写语句可直接提交工单（submittedBy=user）
      createTicket: (body, signal) => request('/tickets', { method: 'POST', body, signal }),
      approveTicket: (body, signal) => request('/tickets/approve', { method: 'POST', body, signal }),
      cancelTicket: (id, signal) => request('/tickets/cancel', { method: 'POST', body: { id }, signal }),
      // 撤销（契约 §3.6a）：preview {id?|ticketId?|historyId?} → {undo}；execute body {id}
      undoPreview: (params, signal) => request('/undo/preview' + queryString(params || {}), { signal }),
      undoExecute: (id, force, signal) => request('/undo', {
        method: 'POST',
        body: force ? { id, force: true } : { id },   // force：原主键被占用的冲突行改用自增 id（第 44 轮）
        signal,
      }),
      // 会话写窗口（契约 §3.3c）：GET 状态 / POST {minutes} 或 {close:true}
      writesWindow: signal => request('/writes/window', { signal }),
      setWritesWindow: (body, signal) => request('/writes/window', { method: 'POST', body, signal }),
      // 导出工单下载（第 45 轮）：取回 JSON 数据（columns+rows），前端转 xlsx 后保存
      exportDownload: (id, signal) => request('/tickets/export/download?id='
        + encodeURIComponent(String(id || '')), { signal }),
      // ---- 语义层（第 51 轮：dbs.db 为准，面板可编辑；契约 §3.9）----
      semanticDomains: signal => request('/semantic/domains', { signal }),
      // 编辑器取全文：{domain,file} → {domain,file,text,revision,source,kind,updatedAt,chars}
      semanticFile: (params, signal) => request('/semantic/file' + queryString(params), { signal }),
      // 保存并重建索引：body {domain,file,text,expectedRevision?|force?}
      semanticFileSave: (payload, signal) => request('/semantic/file/save', {
        method: 'POST', body: payload, signal,
      }),
      semanticRefresh: signal => request('/semantic/refresh', { method: 'POST', body: {}, signal }),
      // DB 写出路径：body {exportDir, mustExist?, import?}（import:true 才顺带导入；老 semanticDir 兼容）
      semanticConfig: (payload, signal) => request('/semantic/config', { method: 'POST', body: payload, signal }),
      semanticDomainCreate: (payload, signal) => request('/semantic/domain/create', {
        method: 'POST', body: payload, signal,
      }),
      semanticDomainUpdate: (payload, signal) => request('/semantic/domain/update', {
        method: 'POST', body: payload, signal,
      }),
      semanticDomainDelete: (payload, signal) => request('/semantic/domain/delete', {
        method: 'POST', body: payload, signal,
      }),
      // 关联数据表：body {domain,add:[{connectionId,database,table,role,note}],remove:[...]}
      semanticDomainTables: (payload, signal) => request('/semantic/domain/tables', {
        method: 'POST', body: payload, signal,
      }),
      // 该库每张表被哪些域引用 → {tables:[{table,refs:[{domain,role,note,unbound?}],bound?}],boundTotal?,boundMissing?}
      // 第 52 轮：传 domain 时每行带 bound（该表是否与本域登记），面板据此打勾
      semanticTables: (params, signal) => request('/semantic/tables' + queryString(params), { signal }),
      semanticExport: (payload, signal) => request('/semantic/export', {
        method: 'POST', body: payload, signal,
      }),
      semanticImport: (payload, signal) => request('/semantic/import', {
        method: 'POST', body: payload, signal,
      }),
      // ---- AI 蒸馏（契约 §3.10）：候选由后端确定性提取，模型在 Host 半片 ----
      semanticDistill: (payload, signal) => request('/semantic/distill', {
        method: 'POST', body: payload, signal,
      }),
      semanticDistillApply: (payload, signal) => request('/semantic/distill/apply', {
        method: 'POST', body: payload, signal,
      }),
      semanticDistillRuns: (params, signal) => request(
        '/semantic/distill/runs' + queryString(params || {}), { signal },
      ),
    }

    // ---- 工作区编辑器/结果区分隔比例（第 34 轮：默认 6:4，localStorage 持久化） ----
    const EDITOR_RATIO_STORAGE_KEY = 'dsh-agent-db-studio:editor-ratio'
    const DEFAULT_EDITOR_RATIO = 0.6
    const MIN_EDITOR_PX = 280   // 编辑器区下限（含 wrap 内边距/foot，textarea 保底约 240px）
    const MIN_RESULTS_PX = 140

    function clampEditorRatio(ratio, containerHeight) {
      const height = Number.isFinite(containerHeight) && containerHeight > 0 ? containerHeight : 480
      const min = Math.min(0.7, MIN_EDITOR_PX / height)
      const max = Math.max(min, 1 - MIN_RESULTS_PX / height)
      const value = Number.isFinite(ratio) ? ratio : DEFAULT_EDITOR_RATIO
      return Math.min(Math.max(value, min), max)
    }

    function readStoredEditorRatio() {
      try {
        if (typeof localStorage === 'undefined') return DEFAULT_EDITOR_RATIO
        const raw = localStorage.getItem(EDITOR_RATIO_STORAGE_KEY)
        if (raw === null || raw === '') return DEFAULT_EDITOR_RATIO
        const value = Number(raw)
        if (!Number.isFinite(value)) return DEFAULT_EDITOR_RATIO
        return Math.min(Math.max(value, 0.12), 0.8)
      } catch (error) {
        return DEFAULT_EDITOR_RATIO
      }
    }

    function writeStoredEditorRatio(ratio) {
      try {
        if (typeof localStorage === 'undefined') return
        localStorage.setItem(EDITOR_RATIO_STORAGE_KEY, String(Number(Number(ratio).toFixed(4))))
      } catch (error) {
        /* 忽略存储失败 */
      }
    }

    // ---- 工作区查询页缓存（localStorage 持久化：连接 tab / 查询 tab / SQL 草稿） ----
    // SQL 正文不放 queryTabs state（避免每个键击触发整树重渲染），运行时真值在 Panel 的
    // querySqlRef；持久化时从这里取。单条 SQL 超过 QUERY_SQL_STORAGE_LIMIT 时只存元数据，
    // 不截断落库（宁可下次打开丢草稿，也不恢复出被截断的 SQL）。
    const QUERY_TABS_STORAGE_KEY = 'dsh-agent-db-studio:query-tabs:v1'
    const QUERY_SQL_STORAGE_LIMIT = 200000

    function emptyQueryTabsCache() {
      return { connTabs: [], activeConnTabId: null, dbByConn: {}, queryTabs: {} }
    }

    function readStoredQueryTabs() {
      try {
        if (typeof localStorage === 'undefined') return emptyQueryTabsCache()
        const raw = localStorage.getItem(QUERY_TABS_STORAGE_KEY)
        if (!raw) return emptyQueryTabsCache()
        const parsed = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object') return emptyQueryTabsCache()
        const cache = emptyQueryTabsCache()
        if (Array.isArray(parsed.connTabs)) {
          cache.connTabs = parsed.connTabs.map(id => String(id)).filter(Boolean).slice(0, 24)
        }
        cache.activeConnTabId = parsed.activeConnTabId ? String(parsed.activeConnTabId) : null
        if (parsed.dbByConn && typeof parsed.dbByConn === 'object') {
          Object.keys(parsed.dbByConn).forEach(id => {
            if (cache.connTabs.indexOf(id) < 0) return
            cache.dbByConn[id] = String(parsed.dbByConn[id] || '')
          })
        }
        if (parsed.queryTabs && typeof parsed.queryTabs === 'object') {
          Object.keys(parsed.queryTabs).forEach(connId => {
            if (cache.connTabs.indexOf(connId) < 0) return
            const entry = parsed.queryTabs[connId]
            if (!entry || typeof entry !== 'object' || !Array.isArray(entry.list)) return
            const list = entry.list.slice(0, 20).map(item => {
              if (!item || typeof item !== 'object' || !item.id) return null
              const sql = typeof item.sql === 'string' ? item.sql : ''
              return {
                id: String(item.id),
                name: String(item.name || ''),
                origin: item.origin === 'file' ? 'file' : 'temp',
                fileName: item.fileName ? String(item.fileName) : '',
                sql: sql.length <= QUERY_SQL_STORAGE_LIMIT ? sql : '',
              }
            }).filter(Boolean)
            if (!list.length) return
            const activeId = entry.activeId && list.some(item => item.id === entry.activeId)
              ? String(entry.activeId)
              : list[0].id
            cache.queryTabs[connId] = { activeId, list }
          })
        }
        if (cache.activeConnTabId && cache.connTabs.indexOf(cache.activeConnTabId) < 0) {
          cache.activeConnTabId = null
        }
        return cache
      } catch (error) {
        return emptyQueryTabsCache()
      }
    }

    function writeStoredQueryTabs(cache) {
      try {
        if (typeof localStorage === 'undefined' || !cache || typeof cache !== 'object') return
        localStorage.setItem(QUERY_TABS_STORAGE_KEY, JSON.stringify(cache))
      } catch (error) {
        /* 配额满 / 序列化失败：忽略，草稿只留在内存 */
      }
    }

    function sanitizeSqlFilename(name) {
      const clean = String(name || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
        .replace(/\s+/g, ' ')
        .trim()
      return (clean || 'query') + '.sql'
    }
