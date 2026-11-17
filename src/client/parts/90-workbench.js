
    // ======================================================================
    // 10. SQL 工作区：编辑器 + 结果区（结果 / 表详情两个页签）
    // ======================================================================

    /** 人工工单弹窗（第 25 轮）：面板工作区只放行只读语句；写语句可在这里直接提交工单，
     *  由人工在「工单」页审批——不必绕道让 agent 代发（用户反馈：拦得住，但要给人工入口）。 */
    function WriteTicketModal(props) {
      if (!props.open) return null
      return h(Modal, {
        open: true,
        title: t('sql.ticketModalTitle'),
        onClose: () => { if (!props.busy) props.onClose() },
        focusKey: 'write-ticket',
      },
      h('div', { className: 'dbs-form' },
        h('p', { className: 'dbs-modal-text' }, t('sql.ticketModalHint')),
        h('textarea', {
          className: 'dbs-input is-full dbs-modal-textarea',
          value: props.sql,
          rows: 6,
          'aria-label': t('history.row.sql'),
          onChange: event => props.onSqlChange(event && event.target ? event.target.value : ''),
        }),
        h('textarea', {
          className: 'dbs-input is-full dbs-modal-textarea',
          value: props.background,
          rows: 3,
          placeholder: t('sql.ticketBackground'),
          'aria-label': t('sql.ticketBackground'),
          onChange: event => props.onBackgroundChange(event && event.target ? event.target.value : ''),
        }),
        props.error ? h(ErrorBar, { error: props.error }) : null,
        h('div', { className: 'dbs-form-actions' },
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', disabled: props.busy,
            onClick: () => { if (!props.busy) props.onClose() },
          }, t('connmgr.cancel')),
          h('button', {
            type: 'button', className: 'dbs-btn is-primary is-small', disabled: props.busy,
            onClick: () => { if (!props.busy) props.onConfirm() },
          }, props.busy ? h(Spinner, null) : null, t('tickets.action.confirm')))))
    }

    /**
     * 行编辑提交弹窗（第 48 轮）：把结果集里改的多行构建成完整 SQL 预览（每行一条
     * UPDATE/INSERT/DELETE），确认后生成一张结构化行写工单（rowsPayload → 人工批准执行）。
     */
    function RowEditModal(props) {
      if (!props.open) return null
      const stats = props.stats || {}
      return h(Modal, {
        open: true,
        title: t('results.edit.modalTitle'),
        onClose: () => { if (!props.busy) props.onClose() },
        wide: true,
        focusKey: 'row-edit',
      },
      h('div', { className: 'dbs-form' },
        h('p', { className: 'dbs-modal-text' }, t('results.edit.modalHint', { table: props.table || '' })),
        h('p', { className: 'dbs-modal-text' }, t('results.edit.stats', {
          u: formatNumber(stats.u || 0), i: formatNumber(stats.i || 0), d: formatNumber(stats.d || 0),
        })),
        h('div', { className: 'dbs-section-title dbs-ticket-label' }, t('results.edit.sqlPreview')),
        h('pre', { className: 'dbs-pre dbs-edit-preview' }, String(props.previewSql || '')),
        h('textarea', {
          className: 'dbs-input is-full dbs-modal-textarea',
          value: props.background,
          rows: 3,
          placeholder: t('sql.ticketBackground'),
          'aria-label': t('sql.ticketBackground'),
          onChange: event => props.onBackgroundChange(event && event.target ? event.target.value : ''),
        }),
        props.error ? h(ErrorBar, { error: props.error }) : null,
        h('div', { className: 'dbs-form-actions' },
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', disabled: props.busy,
            onClick: () => { if (!props.busy) props.onClose() },
          }, t('connmgr.cancel')),
          h('button', {
            type: 'button', className: 'dbs-btn is-primary is-small', disabled: props.busy,
            onClick: () => { if (!props.busy) props.onConfirm() },
          }, props.busy ? h(Spinner, null) : null, t('results.edit.submit')))))
    }

    /** 编辑器查找匹配计算（第 48 轮 Ctrl+F）：支持区分大小写 / 正则 / 全字匹配；非法正则视为无匹配。 */
    function computeEditorMatches(value, options) {
      const settings = options || {}
      const query = String(settings.query || '')
      if (!query) return []
      let pattern
      try {
        if (settings.regexMode) {
          pattern = new RegExp(query, settings.caseSensitive ? 'g' : 'gi')
        } else {
          const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const body = settings.wholeWord ? '\\b(?:' + escaped + ')\\b' : escaped
          pattern = new RegExp(body, settings.caseSensitive ? 'g' : 'gi')
        }
      } catch (error) {
        return []
      }
      const matches = []
      let found
      while ((found = pattern.exec(value)) !== null) {
        const length = found[0].length || query.length
        matches.push({ start: found.index, end: found.index + length })
        if (!found[0].length) pattern.lastIndex += 1
        if (matches.length >= 2000) break
      }
      return matches
    }

    /** 按命中区间切分高亮 tokens（搜索命中叠加层用）：tokens 顺序拼接恒等于全文，切分不增删字符，
     * 保证高亮层与 textarea 文字对齐；命中段标 match，当前命中再标 active，供高亮层画命中底色。
     * （textarea 文字透明、命中底色只能画在高亮层，不能靠 ::selection 表达「全部命中」） */
    function splitTokensByMatches(tokens, matches, activeIndex) {
      const segments = []
      let offset = 0
      let matchPos = 0
      for (const token of tokens) {
        const tokenStart = offset
        const tokenEnd = offset + token.text.length
        let cursor = tokenStart
        while (cursor < tokenEnd) {
          while (matchPos < matches.length && matches[matchPos].end <= cursor) matchPos += 1
          const match = matchPos < matches.length ? matches[matchPos] : null
          if (!match || match.start >= tokenEnd) {
            segments.push({ text: token.text.slice(cursor - tokenStart, tokenEnd - tokenStart),
              kw: token.kw, comment: !!token.comment, match: false, active: false })
            cursor = tokenEnd
            continue
          }
          if (match.start > cursor) {
            segments.push({ text: token.text.slice(cursor - tokenStart, match.start - tokenStart),
              kw: token.kw, comment: !!token.comment, match: false, active: false })
            cursor = match.start
          }
          const stop = Math.min(match.end, tokenEnd)
          segments.push({
            text: token.text.slice(cursor - tokenStart, stop - tokenStart),
            kw: token.kw, comment: !!token.comment, match: true, active: matchPos === activeIndex,
          })
          cursor = stop
        }
        offset = tokenEnd
      }
      return segments
    }

    /** 按分号切独立语句（字符串/注释里的分号不算切分点）：返回每条语句的内容区间
     * [start, end)，start = 上一分号后的首个非空白字符（前导注释也算本语句），
     * end = 分号后一位；末尾无分号的最后一段同样算一条。只有一条语句时返回空
     * （单语句没有「区分不同 SQL」的需求，全线框反而像选区残留）。 */
    function computeSqlStatementRanges(sql) {
      const value = String(sql || '')
      const ranges = []
      let stmtStart = -1
      let pos = 0
      for (const token of sqlScanTokens(value)) {
        const end = pos + token.text.length
        if (token.kind === 'raw' && token.text === ';') {
          if (stmtStart >= 0) ranges.push({ start: stmtStart, end })
          stmtStart = -1
        } else if (stmtStart < 0 && token.kind !== 'space') {
          stmtStart = pos
        }
        pos = end
      }
      if (stmtStart >= 0) ranges.push({ start: stmtStart, end: value.length })
      return ranges.length >= 2 ? ranges : []
    }

    /** 给语句区间标首末行号（线性扫描；换行计数跨区间/间隙连续，与渲染段的行号一致）。 */
    function attachStmtLineBounds(ranges, value) {
      let line = 0
      let pos = 0
      for (const range of ranges) {
        while (pos < range.start) {
          if (value.charCodeAt(pos) === 10) line += 1
          pos += 1
        }
        range.startLine = line
        while (pos < range.end) {
          if (value.charCodeAt(pos) === 10) line += 1
          pos += 1
        }
        range.endLine = line
      }
      return ranges
    }

    /** 在 match 切分段上按「语句区间 × 行」聚合出最终渲染段：区间内的相邻样式小段
     * 合并进同一个行带 span（dbs-sql-stmt，一语句一框的唯一绘制单元），样式小段
     * 作为其 children 嵌套渲染——若框样式直接画在并排的样式 span 上，会退化成
     * 「每个关键字一个框/每行一个框」。区间外的小段原样直出。整层拼接仍恒等于原文
     * （换行以裸文本回填），行带绝不跨行（inline 元素按 fragment 画线框的前提）。 */
    function buildStmtLineSegments(segments, ranges) {
      if (!ranges.length) return segments
      const out = []
      let offset = 0
      let line = 0
      let rangePos = 0
      let band = null
      const closeBand = () => {
        if (band) { out.push(band); band = null }
      }
      const flushChunk = (text, chunkStart, chunkLine, seg) => {
        if (!text) return
        const end = chunkStart + text.length
        let cursor = chunkStart
        while (cursor < end) {
          while (rangePos < ranges.length && ranges[rangePos].end <= cursor) rangePos += 1
          const range = rangePos < ranges.length ? ranges[rangePos] : null
          if (range && range.end > cursor && range.start <= cursor) {
            const stop = Math.min(range.end, end)
            const want = { first: chunkLine === range.startLine, last: chunkLine === range.endLine }
            if (!band || band.range !== range
              || band.stmt.first !== want.first || band.stmt.last !== want.last) {
              closeBand()
              band = { stmt: want, range, children: [] }
            }
            band.children.push(Object.assign({}, seg, {
              text: text.slice(cursor - chunkStart, stop - chunkStart) }))
            cursor = stop
          } else {
            closeBand()
            const stop = range && range.start > cursor ? Math.min(range.start, end) : end
            const piece = text.slice(cursor - chunkStart, stop - chunkStart)
            out.push(seg.kw || seg.comment || seg.match
              ? Object.assign({}, seg, { text: piece })
              : piece)
            cursor = stop
          }
        }
      }
      for (const seg of segments) {
        let rest = seg.text
        if (!rest) continue
        for (;;) {
          const nl = rest.indexOf('\n')
          if (nl < 0) {
            flushChunk(rest, offset, line, seg)
            offset += rest.length
            break
          }
          flushChunk(rest.slice(0, nl), offset, line, seg)
          closeBand()
          out.push('\n')
          offset += nl + 1
          rest = rest.slice(nl + 1)
          line += 1
        }
      }
      closeBand()
      return out
    }

    function SqlWorkbench(props) {
      const connection = props.connection
      const databaseNames = props.databaseNames || []
      const activeDb = props.activeDb || ''
      const maxRows = props.maxRows || DEFAULT_MAX_ROWS
      const [sql, setSql] = useState(() => String(props.initialSql || ''))
      const [tab, setTab] = useState('result')
      const [running, setRunning] = useState(false)
      const [response, setResponse] = useState(null)
      const [queryError, setQueryError] = useState(null)
      const [blockedWrite, setBlockedWrite] = useState(null)   // 被拦的写语句（提供人工建单入口）
      const [ticketModal, setTicketModal] = useState(null)     // {sql, background} 人工工单弹窗
      const [ticketModalBusy, setTicketModalBusy] = useState(false)
      const [ticketModalError, setTicketModalError] = useState(null)
      const [ticketNotice, setTicketNotice] = useState(null)   // 建单成功通知 {id}
      const [resultIndex, setResultIndex] = useState(0)
      const [closedResults, setClosedResults] = useState({})
      const [exportNotice, setExportNotice] = useState('')
      const [exportNoticeOk, setExportNoticeOk] = useState(false)   // 导出通知分 ok/error 两种色
      // 第 48 轮：编辑器查找替换（Ctrl+F / Ctrl+H）
      const [editorSearch, setEditorSearch] = useState(null)
      // {query, replacement, caseSensitive, regexMode, wholeWord, showReplace, matchIndex, message}
      // 每次打开查找（含重复 Ctrl+F / 工具条按钮）+1，驱动「焦点切进查找输入框」effect
      const [searchFocusTick, setSearchFocusTick] = useState(0)
      // 第 48 轮：结果集行编辑（结构化工单）+ 单行详情
      const [pkCache, setPkCache] = useState({})       // sqlText -> {ok, table, pkColumns} | {ok:false, reason}
      const [pkPending, setPkPending] = useState({})   // sqlText -> true（拉取中标记，ref 语义用 state 即可）
      const [editState, setEditState] = useState(null)
      // {resultIndex, editedCells: {'r,c': value}, deletedRows: {'r': true}, newRows: [{key, values}], newSeq}
      const [rowDetail, setRowDetail] = useState(null)  // {resultIndex, rowIndex}
      const [rowEditModal, setRowEditModal] = useState(null)
      // {table, updates, deletes, inserts, previewSql, stats}
      const [rowEditBusy, setRowEditBusy] = useState(false)
      const [rowEditError, setRowEditError] = useState(null)
      const [completion, setCompletion] = useState(null) // {mode,qualifier,prefix,start,position,index}
      const [caretAnchor, setCaretAnchor] = useState({ left: 8, top: 220 })
      const [caretTick, setCaretTick] = useState(0)
      const [, setCacheTick] = useState(0)
      const editorRef = useRef(null)
      const wrapRef = useRef(null)
      const mirrorRef = useRef(null)
      const highlightRef = useRef(null)
      const gutterRef = useRef(null)
      const searchInputRef = useRef(null)   // 查找输入框（打开时焦点切进去）
      const searchMirrorRef = useRef(null)  // 查找镜像里的命中盒子（量位置滚进可视区）
      const caretRef = useRef(null)
      const caretOffsetRef = useRef(0)
      const caretEndRef = useRef(0)
      const completionItemsRef = useRef([])
      const completionListRef = useRef(null)
      const completionItemRefs = useRef([])
      const tablesCacheRef = useRef({})
      const columnsCacheRef = useRef({})
      const aliasMapRef = useRef({})
      const seqRef = useRef(0)
      const abortRef = useRef(null)
      // 第 34 轮：编辑器/结果区默认 6:4 分隔（比例存 localStorage，双击复位 60%）
      const [editorRatio, setEditorRatio] = useState(() => readStoredEditorRatio())
      const [resizingLayout, setResizingLayout] = useState(false)
      const splitContainerRef = useRef(null)
      const ratioRef = useRef(editorRatio)
      const dragRef = useRef(null)
      ratioRef.current = editorRatio

      const bumpCache = useCallback(() => setCacheTick(value => value + 1), [])

      // SQL 变更上报（Panel 持久化用）：经 ref 转发避免回调身份变化牵动缓存依赖
      const onSqlChangeRef = useRef(null)
      onSqlChangeRef.current = props.onSqlChange || null
      const setSqlReport = useCallback(value => {
        setSql(value)
        if (onSqlChangeRef.current) onSqlChangeRef.current(String(value))
      }, [])

      // 一键格式化（第 26 轮）：启发式排版，不改语义；光标挪到末尾防越界
      const formatSqlNow = useCallback(() => {
        const formatted = formatSql(String(sql || ''))
        if (!formatted || formatted === sql) return
        setSqlReport(formatted)
        caretRef.current = formatted.length
        caretOffsetRef.current = formatted.length
      }, [sql, setSqlReport])

      // 表名：按 connectionId+database 缓存，面板里只拉一次（元数据树/补全共用同一接口）
      const ensureTables = useCallback(database => {
        if (!database) return
        const key = connection.id + '|' + database
        const cache = tablesCacheRef.current
        const entry = cache[key]
        if (entry && (entry.loading || entry.ready)) return
        cache[key] = { loading: true, ready: false, list: [] }
        api.tables(connection.id, database).then(data => {
          cache[key] = { loading: false, ready: true, list: Array.isArray(data.tables) ? data.tables : [] }
          bumpCache()
        }, () => {
          cache[key] = { loading: false, ready: true, list: [] }
          bumpCache()
        })
      }, [connection.id, bumpCache])

      // 字段：按 connectionId+database+table 缓存，避免重复请求
      const ensureColumns = useCallback(table => {
        if (!table || !activeDb) return
        const key = connection.id + '|' + activeDb + '|' + table
        const cache = columnsCacheRef.current
        const entry = cache[key]
        if (entry && (entry.loading || entry.ready)) return
        cache[key] = { loading: true, ready: false, list: [] }
        api.table(connection.id, activeDb, table, false).then(data => {
          const columns = Array.isArray(data.columns) ? data.columns : []
          cache[key] = {
            loading: false,
            ready: true,
            list: columns.map(column => String(column && column.name !== undefined ? column.name : column)),
          }
          bumpCache()
        }, () => {
          cache[key] = { loading: false, ready: true, list: [] }
          bumpCache()
        })
      }, [connection.id, activeDb, bumpCache])

      // 当前库的表名列表：进面板就预取，补全复用同一份缓存
      useEffect(() => {
        if (activeDb) ensureTables(activeDb)
      }, [connection.id, activeDb, ensureTables])

      // 触发表名/字段补全：FROM/JOIN 空前缀也给表，或按需拉列
      useEffect(() => {
        if (!completion) return
        if (activeDb) ensureTables(activeDb)
        if (completion.mode === 'qualified') {
          const table = aliasMapRef.current[completion.qualifier.toLowerCase()]
          if (table) ensureColumns(table)
          return
        }
        // 普通模式：预取 SQL 里 FROM/JOIN/UPDATE/INTO 涉及的表列（含裸表名），最多 6 张；
        // 缓存命中会直接复用，拉到后 bumpCache 触发重渲染自动出字段候选
        const prefetchTables = []
        Object.keys(aliasMapRef.current).forEach(alias => {
          const table = aliasMapRef.current[alias]
          if (table && prefetchTables.indexOf(table) < 0) prefetchTables.push(table)
        })
        if (props.tableTarget && props.tableTarget.table && prefetchTables.indexOf(props.tableTarget.table) < 0) {
          prefetchTables.push(props.tableTarget.table)
        }
        prefetchTables.slice(0, 6).forEach(table => ensureColumns(table))
      }, [completion, props.tableTarget, ensureColumns, ensureTables, activeDb])

      // 树里点表 → 自动切到「表详情」
      useEffect(() => {
        if (props.tableTarget) setTab('table')
      }, [props.tableTarget])

      // 执行历史「载入编辑器」：覆盖 SQL 内容并回到结果页签（按 queryTabId 定向，只灌目标查询页）
      useEffect(() => {
        const seed = props.editorSeed
        if (!seed || !seed.stamp) return
        if (seed.queryTabId && props.queryTabId && seed.queryTabId !== props.queryTabId) return
        const nextSql = String(seed.sql || '')
        setSqlReport(nextSql)
        setTab('result')
        setCompletion(null)
        setResultIndex(0)
        caretOffsetRef.current = nextSql.length
        caretRef.current = nextSql.length
      }, [props.editorSeed, props.queryTabId, setSqlReport])

      // 卸载时中止在途查询、让 seq 失效
      useEffect(() => () => {
        seqRef.current += 1
        if (abortRef.current) abortRef.current.abort()
      }, [])

      // Tab 插入两个空格 / 接受补全后恢复光标
      useEffect(() => {
        if (caretRef.current === null) return
        const editor = editorRef.current
        const position = caretRef.current
        caretRef.current = null
        if (editor && typeof editor.setSelectionRange === 'function') {
          editor.setSelectionRange(position, position)
          if (typeof editor.focus === 'function') editor.focus()
        }
      })

      // 补全弹层锚定光标：用等宽镜像元素量出 caret 坐标
      useEffect(() => {
        if (!completion) return
        const wrap = wrapRef.current
        const marker = mirrorRef.current
        const editor = editorRef.current
        if (!wrap || !marker
          || typeof marker.getBoundingClientRect !== 'function'
          || typeof wrap.getBoundingClientRect !== 'function') {
          setCaretAnchor({ left: 12, top: 214 })
          return
        }
        const wrapRect = wrap.getBoundingClientRect()
        const markerRect = marker.getBoundingClientRect()
        const scrollLeft = editor && editor.scrollLeft ? editor.scrollLeft : 0
        const scrollTop = editor && editor.scrollTop ? editor.scrollTop : 0
        let left = markerRect.left - wrapRect.left - scrollLeft
        let top = markerRect.bottom - wrapRect.top - scrollTop + 4
        left = Math.min(Math.max(4, left), Math.max(4, (wrapRect.width || 320) - 300))
        if (top > (wrapRect.height || 200) - 40) {
          top = Math.max(4, markerRect.top - wrapRect.top - scrollTop - 236)
        }
        setCaretAnchor({ left, top: Math.max(4, top) })
      }, [completion, sql, caretTick])

      // 根据当前缓存生成候选：qualified 只出字段，general 出关键字/函数/表/字段
      const buildCompletion = useCallback(state => {
        const items = []
        let loading = false
        if (!state) return { items, loading }
        if (state.mode === 'qualified') {
          const table = aliasMapRef.current[state.qualifier.toLowerCase()]
          const key = table && activeDb ? connection.id + '|' + activeDb + '|' + table : ''
          const entry = key ? columnsCacheRef.current[key] : null
          if (!entry || entry.loading) loading = true
          if (entry && entry.ready) {
            entry.list.forEach(name => items.push({
              label: name, kind: 'column', rank: 0, insert: quoteCompletionName(name), detail: table,
            }))
          }
          return { items: matchCompletionItems(items, '', 12), loading, table }
        }
        const clause = state.clause || 'keyword'
        const columnClause = clause === 'columns'
        const keywordRank = columnClause ? 1 : 0
        const functionRank = columnClause ? 0 : 1
        const tableRank = state.tableContext ? -1 : (columnClause ? 4 : 2)
        const columnRank = columnClause ? -2 : 3
        SQL_KEYWORDS.forEach(keyword => items.push({
          label: keyword, kind: 'keyword', rank: keywordRank, insert: keyword,
        }))
        SQL_FUNCTIONS.forEach(name => items.push({
          label: name, kind: 'function', rank: functionRank, insert: name,
        }))
        const tablesEntry = activeDb ? tablesCacheRef.current[connection.id + '|' + activeDb] : null
        if (tablesEntry && tablesEntry.loading) loading = true
        if (tablesEntry && tablesEntry.ready) {
          tablesEntry.list.forEach(row => items.push({
            label: String(row.name),
            kind: row.type === 'view' ? 'view' : 'table',
            rank: tableRank,
            insert: quoteCompletionName(row.name),
            detail: row.type === 'view' ? t('sql.completeView') : t('sql.completeTable'),
          }))
        }
        const columnTables = []
        // SQL 里 FROM/JOIN/UPDATE/INTO 引用到的表（含裸表名；aliasMap 的 value 就是表名）
        Object.keys(aliasMapRef.current).forEach(alias => {
          const table = aliasMapRef.current[alias]
          if (table && columnTables.indexOf(table) < 0) columnTables.push(table)
        })
        if (props.tableTarget && props.tableTarget.table && columnTables.indexOf(props.tableTarget.table) < 0) {
          columnTables.push(props.tableTarget.table)
        }
        columnTables.forEach(table => {
          const key = activeDb ? connection.id + '|' + activeDb + '|' + table : ''
          const entry = key ? columnsCacheRef.current[key] : null
          if (!entry || entry.loading) loading = true
          if (entry && entry.ready) {
            entry.list.forEach(name => {
              if (!items.some(item => item.kind === 'column' && item.label === name)) {
                items.push({
                  label: name,
                  kind: 'column',
                  rank: columnRank,
                  insert: quoteCompletionName(name),
                  detail: table,
                })
              }
            })
          }
        })
        return { items: matchCompletionItems(items, state.prefix, 12), loading }
      }, [activeDb, connection.id, props.tableTarget])

      const openCompletion = useCallback((value, offset, manual) => {
        aliasMapRef.current = parseSqlAliases(value)
        const context = completionContextOf(value, offset)
        const hasQualifier = Boolean(context.qualifier)
        if (!hasQualifier && !context.prefix && !manual) {
          setCompletion(null)
          return
        }
        // FROM/JOIN 之后的空前缀：优先弹表名
        const before = String(value || '').slice(0, context.start).replace(/\s+$/, '')
        const tableContext = /(?:from|join|update|into)$/i.test(before)
        const clause = completionClauseAt(value, context.start)
        setCompletion({
          mode: hasQualifier ? 'qualified' : 'general',
          qualifier: context.qualifier,
          prefix: context.prefix,
          start: context.start,
          position: context.position,
          index: 0,
          tableContext,
          clause,
        })
      }, [])

      const applyCompletion = useCallback(item => {
        if (!completion || !item) return
        const value = String(sql || '')
        const insert = item.insert !== undefined ? String(item.insert) : String(item.label)
        const next = value.slice(0, completion.start) + insert + value.slice(completion.position)
        const nextOffset = completion.start + insert.length
        setSqlReport(next)
        caretRef.current = nextOffset
        caretOffsetRef.current = nextOffset
        caretEndRef.current = nextOffset
        setCompletion(null)
      }, [completion, sql, setSqlReport])

      const runSql = useCallback(selection => {
        const text = String(sql || '').trim()
        if (!text) {
          setQueryError(new Error(t('sql.empty')))
          return
        }
        // 第 31 轮：执行**选中的 SQL**——start/end 优先取 keydown 事件里 textarea 的真实选区，
        // 否则回退 onSelect/onEditorChange 维护的选区；没有选中（或选中为空白）不允许执行
        const selStart = selection && Number.isFinite(selection.start)
          ? selection.start
          : caretOffsetRef.current
        const selEnd = selection && Number.isFinite(selection.end)
          ? selection.end
          : caretEndRef.current
        const selected = selEnd > selStart ? String(sql || '').slice(selStart, selEnd).trim() : ''
        if (!selected) {
          setQueryError(new Error(t('sql.selectionRequired')))
          return
        }
        // 面板不做写操作 UI：只放行只读语句，写语句交给 agent 的 db_execute（带审批）
        const readOnlyCheck = checkReadOnlySql(selected)
        if (!readOnlyCheck.ok) {
          setQueryError(new Error(
            (readOnlyCheck.preview
              ? t('sql.writeBlockedDetail', { preview: readOnlyCheck.preview }) + ' '
              : '')
            + t('sql.writeBlocked'),
          ))
          setBlockedWrite({ sql: selected })  // 拦得住，也要给人工入口：可一键提交工单（第 25 轮）
          return
        }
        setBlockedWrite(null)
        setTicketNotice(null)
        if (running) return
        setCompletion(null)
        const seq = seqRef.current + 1
        seqRef.current = seq
        if (abortRef.current) abortRef.current.abort()
        const controller = new AbortController()
        abortRef.current = controller
        setRunning(true)
        setQueryError(null)
        api.query({
          connectionId: connection.id,
          database: activeDb || undefined,
          sql: selected,   // 只执行选中的片段（第 31 轮）
          maxRows,
        }, controller.signal).then(data => {
          if (seqRef.current !== seq) return
          setRunning(false)
          setResultIndex(0)
          setClosedResults({})
          setExportNotice('')
          setExportNoticeOk(false)
          setEditState(null)     // 重跑后结果集替换，编辑态作废
          setRowDetail(null)
          setResponse(data || { results: [] })
        }, error => {
          if (seqRef.current !== seq) return
          setRunning(false)
          if (isAbort(error)) return
          setQueryError(error)
          setResponse(null)
        })
      }, [sql, running, connection.id, activeDb, maxRows])

      const openWriteTicket = useCallback(() => {
        if (!blockedWrite) return
        setTicketModalError(null)
        setTicketModal({ sql: blockedWrite.sql, background: '' })
      }, [blockedWrite])

      const submitWriteTicket = useCallback(() => {
        if (ticketModalBusy || !ticketModal) return
        const sql = String(ticketModal.sql || '').trim()
        if (!sql) {
          setTicketModalError(new Error(t('sql.empty')))
          return
        }
        const background = String(ticketModal.background || '').trim()
        if (background.length < 4) {
          setTicketModalError(new Error(t('sql.ticketBackgroundShort')))
          return
        }
        setTicketModalBusy(true)
        setTicketModalError(null)
        api.createTicket({
          connectionId: connection.id,
          database: activeDb || undefined,
          sql,
          background,
        }).then(data => {
          setTicketModalBusy(false)
          const ticket = data && data.ticket ? data.ticket : null
          setTicketModal(null)
          setBlockedWrite(null)
          setQueryError(null)
          setTicketNotice({ id: ticket ? ticket.id : '' })
        }, error => {
          setTicketModalBusy(false)
          setTicketModalError(error)
        })
      }, [ticketModalBusy, ticketModal, connection.id, activeDb])

      // ---- 第 48 轮：编辑器查找替换（Ctrl+F 打开 / Ctrl+H 带替换行；Esc 关闭） ----
      // 注意：必须先于 onEditorKeyDown 定义（其 useCallback deps 数组引用这些函数）
      const editorMatches = computeEditorMatches(String(sql || ''), editorSearch || {})

      const openEditorSearch = useCallback(showReplace => {
        const from = Math.min(caretOffsetRef.current, caretEndRef.current)
        const to = Math.max(caretOffsetRef.current, caretEndRef.current)
        const selected = String(sql || '').slice(from, to)
        setSearchFocusTick(value => value + 1)
        setEditorSearch(previous => Object.assign(
          {}, previous || {},
          { replacement: '', matchIndex: 0, message: '', showReplace: Boolean(showReplace) },
          selected && !previous ? { query: selected.slice(0, 200) } : {},
          !previous && !selected ? { query: '' } : {},
        ))
      }, [sql])

      const closeEditorSearch = useCallback(() => {
        setEditorSearch(null)
        const editor = editorRef.current
        if (editor && typeof editor.focus === 'function') editor.focus()
      }, [])

      // 步进只改索引；选区回写与滚动跟随由下方 effect 统一处理。
      // 不再把焦点抢到编辑器：连续 Enter/‹› 步进时焦点留在查找框（旧实现第一次步进后
      // 焦点落回编辑器，下一个 Enter 会直接插进 SQL）
      const stepEditorMatch = useCallback(step => {
        setEditorSearch(current => {
          if (!current) return current
          const total = editorMatches.length
          if (!total) return current
          const base = typeof current.matchIndex === 'number' ? current.matchIndex : 0
          const next = ((base + step) % total + total) % total
          return Object.assign({}, current, { matchIndex: next })
        })
      }, [editorMatches])

      const replaceEditorCurrent = useCallback(() => {
        const editor = editorRef.current
        if (!editorSearch || !editorMatches.length || !editor) return
        const index = Math.min(editorSearch.matchIndex || 0, editorMatches.length - 1)
        const match = editorMatches[index]
        const value = String(sql || '')
        const replacementText = editorSearch.replacement || ''
        const next = value.slice(0, match.start) + replacementText + value.slice(match.end)
        setSqlReport(next)
        setEditorSearch(current => Object.assign({}, current, {
          matchIndex: index > 0 ? index - 1 : 0,
          message: t('sql.search.replacedOne'),
        }))
        if (typeof editor.setSelectionRange === 'function') {
          editor.focus()
          editor.setSelectionRange(match.start, match.start + replacementText.length)
        }
      }, [editorSearch, editorMatches, sql, setSqlReport])

      const replaceEditorAll = useCallback(() => {
        if (!editorSearch || !editorMatches.length) return
        const value = String(sql || '')
        const settings = editorSearch
        let next = value
        let count = 0
        if (settings.regexMode) {
          try {
            const pattern = new RegExp(settings.query, 'g' + (settings.caseSensitive ? '' : 'i'))
            next = value.replace(pattern, () => { count += 1; return settings.replacement || '' })
          } catch (error) { return }
        } else {
          const escaped = settings.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const body = settings.wholeWord ? '\\b(?:' + escaped + ')\\b' : escaped
          next = value.replace(new RegExp(body, 'g' + (settings.caseSensitive ? '' : 'i')), () => {
            count += 1; return settings.replacement || ''
          })
        }
        if (!count) return
        setSqlReport(next)
        setEditorSearch(current => Object.assign({}, current, {
          matchIndex: 0, message: t('sql.search.replacedAll', { n: formatNumber(count) }),
        }))
      }, [editorSearch, editorMatches, setSqlReport])

      // 当前命中（渲染期统一钳制越界索引）：高亮层叠加标记、选区回写、滚动跟随共用
      const activeMatchIndex = editorSearch && editorMatches.length
        ? Math.min(editorSearch.matchIndex || 0, editorMatches.length - 1)
        : -1
      const activeMatch = activeMatchIndex >= 0 ? editorMatches[activeMatchIndex] : null
      // 选中/滚动的触发键只跟「查找设置 + 步进位置 + 打开动作」走：
      // 直接编辑 SQL 虽会改变命中坐标，但不重写选区（否则编辑时人工光标会被强行挪到命中处）
      const searchStepKey = editorSearch
        ? [editorSearch.query || '', editorSearch.caseSensitive ? 1 : 0, editorSearch.regexMode ? 1 : 0,
          editorSearch.wholeWord ? 1 : 0, editorSearch.matchIndex || 0].join('|')
        : ''

      // 步进/输入查询/打开查找后：把当前命中写回 textarea 选区，并把命中盒子滚进可视区。
      // textarea 没有「按偏移滚动」的 API，用镜像（与 textarea 文字原点对齐、不随滚动）量出
      // 命中盒子的内容坐标，再直接设置 scrollTop / scrollLeft
      useEffect(() => {
        if (!searchStepKey || !activeMatch) return
        const editor = editorRef.current
        if (editor && typeof editor.setSelectionRange === 'function') {
          editor.setSelectionRange(activeMatch.start, activeMatch.end)
        }
        const marker = searchMirrorRef.current
        const wrap = wrapRef.current
        if (!editor || !marker || !wrap
          || typeof marker.getBoundingClientRect !== 'function'
          || typeof wrap.getBoundingClientRect !== 'function') return
        const wrapRect = wrap.getBoundingClientRect()
        const rect = marker.getBoundingClientRect()
        const viewH = editor.clientHeight
        const viewW = editor.clientWidth
        if (!viewH || !viewW) return
        const contentTop = rect.top - wrapRect.top
        const contentBottom = rect.bottom - wrapRect.top
        const contentLeft = rect.left - wrapRect.left
        const contentRight = rect.right - wrapRect.left
        let scrollTop = editor.scrollTop
        // 19 = 一行行高（与 CSS line-height 一致），命中行上下各留一行缓冲；横向留 12px 缓冲
        if (contentTop - 19 < scrollTop) scrollTop = Math.max(0, contentTop - 19)
        else if (contentBottom + 19 > scrollTop + viewH) scrollTop = contentBottom + 19 - viewH
        if (scrollTop !== editor.scrollTop) editor.scrollTop = scrollTop
        let scrollLeft = editor.scrollLeft
        if (contentLeft - 12 < scrollLeft) scrollLeft = Math.max(0, contentLeft - 12)
        else if (contentRight + 12 > scrollLeft + viewW) scrollLeft = contentRight + 12 - viewW
        if (scrollLeft !== editor.scrollLeft) editor.scrollLeft = scrollLeft
      }, [searchStepKey, searchFocusTick])

      // 打开查找（含重复 Ctrl+F / 工具条按钮）时把焦点切进查找输入框并全选旧词——
      // 否则浮层开了焦点还在编辑器，用户接着打字全写进了 SQL
      useEffect(() => {
        if (!searchFocusTick) return
        const input = searchInputRef.current
        if (!input || typeof input.focus !== 'function') return
        input.focus()
        if (typeof input.select === 'function') input.select()
      }, [searchFocusTick])

      const onEditorChange = useCallback(event => {
        const target = event && event.target
        const value = target ? String(target.value) : ''
        const offset = target && typeof target.selectionStart === 'number' ? target.selectionStart : value.length
        const end = target && typeof target.selectionEnd === 'number' ? target.selectionEnd : offset
        caretOffsetRef.current = offset
        caretEndRef.current = end
        setSqlReport(value)
        openCompletion(value, offset, false)
      }, [openCompletion, setSqlReport])

      const onEditorKeyDown = useCallback(event => {
        if (!event) return
        const key = event.key
        const target = event.currentTarget || event.target
        const value = String(sql || '')
        const start = target && typeof target.selectionStart === 'number' ? target.selectionStart : caretOffsetRef.current
        const end = target && typeof target.selectionEnd === 'number' ? target.selectionEnd : caretEndRef.current
        caretOffsetRef.current = start
        caretEndRef.current = end
        // 第 48 轮：Ctrl+F 查找 / Ctrl+H 查找+替换（Ctrl+Shift+F 是格式化，不冲突）；Esc 关闭
        if ((key === 'f' || key === 'F') && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
          event.preventDefault()
          openEditorSearch(false)
          return
        }
        if ((key === 'h' || key === 'H') && (event.ctrlKey || event.metaKey) && !event.altKey) {
          event.preventDefault()
          openEditorSearch(true)
          return
        }
        if (key === 'Escape' && editorSearch) {
          event.preventDefault()
          closeEditorSearch()
          return
        }
        if (key === 'F5' || (key === 'Enter' && (event.ctrlKey || event.metaKey))) {
          event.preventDefault()
          runSql({ start, end })
          return
        }
        if (key === ' ' && event.ctrlKey) {
          event.preventDefault()
          openCompletion(value, start, true)
          return
        }
        if ((key === 'Space' || event.code === 'Space') && event.ctrlKey) {
          event.preventDefault()
          openCompletion(value, start, true)
          return
        }
        const items = completionItemsRef.current
        if (completion && items.length) {
          if (key === 'ArrowDown') {
            event.preventDefault()
            setCompletion(previous => previous ? Object.assign({}, previous, { index: (previous.index + 1) % items.length }) : previous)
            return
          }
          if (key === 'ArrowUp') {
            event.preventDefault()
            setCompletion(previous => previous
              ? Object.assign({}, previous, { index: (previous.index - 1 + items.length) % items.length })
              : previous)
            return
          }
          if (key === 'Enter' || key === 'Tab') {
            event.preventDefault()
            applyCompletion(items[Math.min(completion.index, items.length - 1)])
            return
          }
          if (key === 'Escape') {
            event.preventDefault()
            setCompletion(null)
            return
          }
        }
        if (key === 'Tab') {
          event.preventDefault()
          caretRef.current = start + 2
          setSqlReport(value.slice(0, start) + '  ' + value.slice(end))
        }
      }, [sql, completion, runSql, openCompletion, applyCompletion, setSqlReport,
        openEditorSearch, closeEditorSearch, editorSearch])

      // 渲染期生成补全候选（缓存更新 -> cacheTick 触发重渲染；不额外发请求）
      aliasMapRef.current = parseSqlAliases(sql)
      const completionBundle = completion ? buildCompletion(completion) : { items: [], loading: false }
      completionItemsRef.current = completionBundle.items
      const completionIndex = completion && completionBundle.items.length
        ? Math.min(completion.index, completionBundle.items.length - 1)
        : 0

      // ↑↓ / hover 切换高亮时把激活项滚进可视区（只在 index / 候选变化时触发，不每帧调；
      // block:'nearest' 只动补全列表，不带动整页滚动）
      useEffect(() => {
        if (!completion) return
        const active = completionItemRefs.current[completionIndex]
        if (active && typeof active.scrollIntoView === 'function') {
          active.scrollIntoView({ block: 'nearest' })
        }
      }, [
        completionIndex,
        completionBundle.items.length,
        completion ? completion.mode : '',
        completion ? completion.prefix : '',
      ])

      const runbar = h('div', { className: 'dbs-runbar' },
        h('button', {
          type: 'button', className: 'dbs-btn is-primary', onClick: runSql, disabled: running,
        }, running ? h(Spinner, null) : h(Icon, { name: 'play', size: 12 }), running ? t('sql.running') : t('sql.run')),
        h('span', { className: 'dbs-kbd' }, 'Ctrl+Enter'),
        h('button', {
          type: 'button', className: 'dbs-btn', title: t('sql.formatHint'), onClick: formatSqlNow,
        }, h(Icon, { name: 'spark', size: 12 }), t('sql.format')),
        h('span', { className: 'dbs-kbd' }, 'Ctrl+Shift+F'),
        h('button', {
          type: 'button', className: 'dbs-btn', title: t('sql.search.title'), onClick: () => openEditorSearch(false),
        }, h(Icon, { name: 'search', size: 12 }), t('sql.search.button')),
        h('span', { className: 'dbs-kbd' }, 'Ctrl+F'),
        h('span', { className: 'dbs-sep' }),
        h('span', { className: 'dbs-muted' }, t('sql.database')),
        h('select', {
          className: 'dbs-select',
          value: activeDb,
          onChange: event => { if (props.onDatabaseChange) props.onDatabaseChange(event.target.value) },
        },
        activeDb ? null : h('option', { value: '' }, t('sql.noDatabase')),
        databaseNames.map(name => h('option', { key: name, value: name }, name))),
        h('span', { className: 'dbs-muted' }, t('sql.maxRows', { n: formatNumber(maxRows) })),
        h('span', { className: 'dbs-grow' }),
        h('span', { className: 'dbs-mono dbs-muted' }, String(connection.name || connection.id)),
        h(Tag, { tone: connection.readonly ? 'link' : 'plain' },
          connection.readonly ? t('connection.readonly') : t('connection.writable')),
        connectionMaskingEnabled(connection)
          ? h('span', { className: 'dbs-mask-badge', title: t('masking.badgeTip') },
            h(Icon, { name: 'shield', size: 10 }), t('masking.badge'))
          : null)

      const completionPanel = completion
        ? h('div', {
          className: 'dbs-complete',
          style: { left: caretAnchor.left + 'px', top: caretAnchor.top + 'px' },
        },
        h('div', { className: 'dbs-complete-list', ref: completionListRef },
          completionBundle.loading && !completionBundle.items.length
            ? h('div', { className: 'dbs-complete-empty' }, h(Spinner, null), t('sql.completeLoading'))
            : completionBundle.items.length
              ? completionBundle.items.map((item, index) => h('button', {
                key: 'complete:' + index,
                type: 'button',
                ref: node => { completionItemRefs.current[index] = node || undefined },
                className: 'dbs-complete-item' + (index === completionIndex ? ' is-on' : ''),
                onMouseEnter: () => setCompletion(previous => (
                  previous && previous.index !== index
                    ? Object.assign({}, previous, { index })
                    : previous
                )),
                onMouseDown: event => {
                  if (event && event.preventDefault) event.preventDefault()
                  applyCompletion(item)
                },
              },
              h('span', { className: 'dbs-complete-label' }, item.label),
              h('span', { className: 'dbs-complete-kind' }, completionKindLabel(item)),
              item.detail ? h('span', { className: 'dbs-complete-detail' }, item.detail) : null))
              : h('div', { className: 'dbs-complete-empty' }, t('sql.completeNone'))),
        h('div', { className: 'dbs-complete-hint' }, t('sql.completeHint')))
        : null

      // 行号槽（第 35 轮）：宽度随行数位数自适应；textarea/highlight/补全镜像的左内边距同步右移，
      // 三者文字原点保持一致（gutterWidth + 21 = wrap 12 + 边框 1 + 内边距）
      const editorLineCount = String(sql || '').split('\n').length
      const gutterWidth = Math.max(30, 18 + String(editorLineCount).length * 8)
      const editorPadLeft = (gutterWidth + 8) + 'px'
      // 高亮层内容三步切分（每步都保持拼接恒等于原文，字符位置与 textarea 逐字符对齐）：
      // 关键字/注释 tokens → 按命中区间切分（查找）→ 按「行 × 语句区间」细分（独立语句线框）
      const highlightTokens = sqlHighlightTokens(sql)
      const stmtRanges = attachStmtLineBounds(computeSqlStatementRanges(sql), String(sql || ''))
      const highlightSegments = buildStmtLineSegments(
        editorSearch && editorMatches.length
          ? splitTokensByMatches(highlightTokens, editorMatches, activeMatchIndex)
          : highlightTokens,
        stmtRanges,
      )
      // 高亮小段统一样式渲染（关键字/注释/查找命中；语句行带的 children 也走这里，不带框）
      const renderHlSpan = (seg, key) => {
        const className = [
          seg.kw ? 'dbs-token-kw' : '',
          seg.comment ? 'dbs-token-comment' : '',
          seg.match ? (seg.active ? 'dbs-editor-match is-active' : 'dbs-editor-match') : '',
        ].filter(Boolean).join(' ')
        return className ? h('span', { key, className }, seg.text) : seg.text
      }

      const editorBox = h('div', { className: 'dbs-editor-wrap', ref: wrapRef },
        // 查找替换浮层（第 48 轮 Ctrl+F / Ctrl+H）：定位在编辑器容器右上角
        editorSearch
          ? h('div', { className: 'dbs-editor-search', role: 'search', 'aria-label': t('sql.search.title') },
            h('div', { className: 'dbs-editor-search-row' },
              h('input', {
                ref: searchInputRef,
                className: 'dbs-input is-small dbs-editor-search-input',
                placeholder: t('sql.search.placeholder'),
                'aria-label': t('sql.search.placeholder'),
                value: editorSearch.query,
                onChange: event => setEditorSearch(current => Object.assign({}, current, {
                  query: event && event.target ? event.target.value : '', matchIndex: 0, message: '',
                })),
                onKeyDown: event => {
                  if (!event) return
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    stepEditorMatch(event.shiftKey ? -1 : 1)
                  }
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    closeEditorSearch()
                  }
                },
              }),
              h('span', { className: 'dbs-editor-search-count' }, editorSearch.query
                ? (editorMatches.length
                  ? String((editorSearch.matchIndex || 0) + 1) + '/' + String(editorMatches.length)
                  : t('sql.search.noMatch'))
                : null),
              h('button', {
                type: 'button', className: 'dbs-btn is-small', title: t('sql.search.prev'),
                'aria-label': t('sql.search.prev'), disabled: !editorMatches.length,
                onClick: () => stepEditorMatch(-1),
              }, '‹'),
              h('button', {
                type: 'button', className: 'dbs-btn is-small', title: t('sql.search.next'),
                'aria-label': t('sql.search.next'), disabled: !editorMatches.length,
                onClick: () => stepEditorMatch(1),
              }, '›'),
              h('label', { className: 'dbs-check dbs-editor-search-opt' },
                h('input', {
                  type: 'checkbox', name: 'searchCaseSensitive', checked: Boolean(editorSearch.caseSensitive),
                  onChange: event => setEditorSearch(current => Object.assign({}, current, {
                    caseSensitive: Boolean(event.target && event.target.checked), matchIndex: 0,
                  })),
                }), t('sql.search.caseSensitive')),
              h('label', { className: 'dbs-check dbs-editor-search-opt' },
                h('input', {
                  type: 'checkbox', name: 'searchRegex', checked: Boolean(editorSearch.regexMode),
                  onChange: event => setEditorSearch(current => Object.assign({}, current, {
                    regexMode: Boolean(event.target && event.target.checked), matchIndex: 0,
                  })),
                }), t('sql.search.regex')),
              h('label', { className: 'dbs-check dbs-editor-search-opt' },
                h('input', {
                  type: 'checkbox', name: 'searchWholeWord', checked: Boolean(editorSearch.wholeWord),
                  onChange: event => setEditorSearch(current => Object.assign({}, current, {
                    wholeWord: Boolean(event.target && event.target.checked), matchIndex: 0,
                  })),
                }), t('sql.search.wholeWord')),
              h('button', {
                type: 'button', className: 'dbs-btn is-small', title: t('sql.search.showReplace'),
                'aria-label': t('sql.search.showReplace'),
                'aria-expanded': editorSearch.showReplace ? 'true' : 'false',
                onClick: () => setEditorSearch(current => Object.assign({}, current, {
                  showReplace: !current.showReplace })),
              }, t('sql.search.replaceShort')),
              editorSearch.message
                ? h('span', { className: 'dbs-editor-search-msg' }, editorSearch.message)
                : null,
              h('button', {
                type: 'button', className: 'dbs-iconbtn', title: t('common.close'),
                'aria-label': t('common.close'), onClick: closeEditorSearch,
              }, h(Icon, { name: 'close', size: 13 }))),
            editorSearch.showReplace
              ? h('div', { className: 'dbs-editor-search-row' },
                h('input', {
                  className: 'dbs-input is-small dbs-editor-search-input',
                  placeholder: t('sql.search.replacePlaceholder'),
                  'aria-label': t('sql.search.replacePlaceholder'),
                  value: editorSearch.replacement,
                  onChange: event => setEditorSearch(current => Object.assign({}, current, {
                    replacement: event && event.target ? event.target.value : '',
                  })),
                }),
                h('button', {
                  type: 'button', className: 'dbs-btn is-small', disabled: !editorMatches.length,
                  onClick: replaceEditorCurrent,
                }, t('sql.search.replace')),
                h('button', {
                  type: 'button', className: 'dbs-btn is-small', disabled: !editorMatches.length,
                  onClick: replaceEditorAll,
                }, t('sql.search.replaceAll')))
              : null)
          : null,
        // stack 与 textarea 同框：highlight inset:0 的高度恒等于 textarea 高度（含 resize 拖拽跟随），
        // 不会被内容撑爆（第 31 轮修复：此前 highlight 按内容自然高，长 SQL 直接铺满整屏）
        // 查找打开时按命中区间切分 tokens，命中段加 dbs-editor-match 标记（当前命中 is-active）
        h('div', { className: 'dbs-editor-stack' },
          h('div', { className: 'dbs-editor-highlight', 'aria-hidden': 'true', ref: highlightRef,
            style: { paddingLeft: editorPadLeft } },
            highlightSegments.map((seg, index) => {
              if (typeof seg === 'string') return seg
              if (seg.stmt) {
                return h('span', {
                  key: 'kw:' + index,
                  className: 'dbs-sql-stmt'
                    + (seg.stmt.first ? ' is-stmt-first' : '')
                    + (seg.stmt.last ? ' is-stmt-last' : ''),
                }, seg.children.map((child, childIndex) =>
                  renderHlSpan(child, 'kw:' + index + ':' + childIndex)))
              }
              return renderHlSpan(seg, 'kw:' + index)
            })),
          h('textarea', {
          ref: editorRef,
          className: 'dbs-editor dbs-editor-text',
          value: sql,
          placeholder: t('sql.placeholder'),
          spellCheck: false,
          wrap: 'off',
          style: { paddingLeft: editorPadLeft },
          onChange: onEditorChange,
          onKeyDown: onEditorKeyDown,
          onSelect: event => {
            const target = event && event.currentTarget
            if (!target || typeof target.selectionStart !== 'number') return
            caretOffsetRef.current = target.selectionStart
            caretEndRef.current = typeof target.selectionEnd === 'number' ? target.selectionEnd : target.selectionStart
            // 手动移动光标后，旧弹层位置会失效，直接收起
            if (completion && target.selectionStart !== completion.position) setCompletion(null)
          },
          onScroll: event => {
            const target = event && event.currentTarget
            if (target && highlightRef.current) {
              highlightRef.current.scrollTop = target.scrollTop
              highlightRef.current.scrollLeft = target.scrollLeft
            }
            // 行号槽纵向跟随编辑器滚动（第 35 轮）
            if (target && gutterRef.current) {
              gutterRef.current.scrollTop = target.scrollTop
            }
            if (completion) setCaretTick(value => value + 1)
          },
          onBlur: () => setCompletion(null),
          'aria-label': t('sql.hint'),
        }),
          // 行号：1..N 竖排（white-space:pre 文本块，行高与 textarea 一致），滚动由 gutterRef.scrollTop 同步
          h('div', { className: 'dbs-editor-gutter', 'aria-hidden': 'true', ref: gutterRef,
            style: { width: gutterWidth + 'px' } },
            h('div', { className: 'dbs-editor-gutter-inner' },
              Array.from({ length: editorLineCount }, (_, i) => i + 1).join('\n')))),
        completion
          ? h('div', { className: 'dbs-editor-mirror', 'aria-hidden': 'true',
            style: { paddingLeft: editorPadLeft } },
            h('span', null, sql.slice(0, completion.position)),
            h('span', { ref: mirrorRef, className: 'dbs-caret-marker' }, '\u200b'),
            h('span', null, sql.slice(completion.position)))
          : null,
        // 查找镜像（与补全镜像同一套对齐规则）：量出当前命中盒子的内容坐标，供滚动跟随。
        // 中间 span 恰好包住命中文本，rect 即命中盒子（起止两端都能参与滚动判断）
        editorSearch && activeMatch
          ? h('div', { className: 'dbs-editor-mirror', 'aria-hidden': 'true',
            style: { paddingLeft: editorPadLeft } },
            h('span', null, String(sql || '').slice(0, activeMatch.start)),
            h('span', { ref: searchMirrorRef }, String(sql || '').slice(activeMatch.start, activeMatch.end)),
            h('span', null, String(sql || '').slice(activeMatch.end)))
          : null,
        completionPanel,
        h('div', { className: 'dbs-editor-foot' },
          h('span', { className: 'dbs-muted' }, t('sql.hint')),
          h('span', { className: 'dbs-muted' }, t('sql.formatHint')),
          h('span', { className: 'dbs-muted' }, t('sql.completeManual')),
          h('span', { className: 'dbs-grow' }),
          connection.readonly
            ? h('span', { className: 'dbs-muted' }, t('sql.readonlyHint'))
            : h('span', { className: 'dbs-muted' }, t('sql.writeHint'))))

      const allResults = response && Array.isArray(response.results) ? response.results : []
      const visibleEntries = allResults
        .map((result, index) => ({ result, index }))
        .filter(entry => !closedResults[entry.index])

      const closeResultSet = originalIndex => {
        const position = visibleEntries.findIndex(entry => entry.index === originalIndex)
        const remaining = visibleEntries.filter(entry => entry.index !== originalIndex)
        setClosedResults(previous => Object.assign({}, previous, { [originalIndex]: true }))
        if (resultIndex === originalIndex) {
          const nextEntry = remaining[Math.min(position >= 0 ? position : 0, Math.max(0, remaining.length - 1))]
          setResultIndex(nextEntry ? nextEntry.index : 0)
        }
      }

      const clearResults = () => {
        const next = {}
        allResults.forEach((result, index) => { next[index] = true })
        setClosedResults(next)
        setResultIndex(0)
        setExportNotice('')
        setExportNoticeOk(false)
      }

      // 第 46 轮统一导出入口：导出不再前端直下，一律提交导出工单（export:true）——
      // 人工批准后由程序重跑该语句、分批取数（上限 1 万行，每批 500 行）落文件，
      // 用户在「工单」页详情点「下载」选 xlsx / JSON / INSERT；批准前工单不执行。
      const exportResult = originalIndex => {
        const result = allResults[originalIndex]
        if (!result) return Promise.resolve(false)
        const sqlText = result.sql !== undefined && result.sql !== null && String(result.sql).trim()
          ? String(result.sql)
          : String(sql || '')
        setExportNotice('')
        setExportNoticeOk(false)
        if (!sqlText.trim()) {
          setExportNotice(t('results.exportFailed'))
          return Promise.resolve(false)
        }
        return api.createTicket({
          connectionId: connection.id,
          database: activeDb || undefined,
          sql: sqlText,
          export: true,
          background: t('results.exportTicketBackground', { sql: sqlText.slice(0, 160) }),
        }).then(data => {
          const ticket = data && data.ticket ? data.ticket : null
          if (!ticket || !ticket.id) {
            setExportNotice(t('results.exportFailed'))
            return false
          }
          setExportNotice(t('results.exportTicketCreated', { id: ticket.id }))
          setExportNoticeOk(true)
          return true
        }, error => {
          setExportNotice(error && error.message ? String(error.message) : t('results.exportFailed'))
          return false
        })
      }

      // ---- 第 48 轮：结果集行编辑（结构化工单）+ 单行详情 ----
      // 可编辑判定：结果集 SQL 能解析出单一表名（parseExportTableName）且该表有主键
      // （/meta/table 的 columns[].key==='PRI'）；只读连接置灰（后端也会 403 兜底）。
      const ensurePkInfo = useCallback(sqlText => {
        const keyText = String(sqlText || '')
        const table = parseExportTableName(keyText)
        if (!table) return { ok: false, reason: t('results.edit.noTable'), table: '' }
        const cached = pkCache[keyText]
        if (cached) return cached
        if (pkPending[keyText]) return null   // 拉取中：按钮暂不可用
        setPkPending(previous => Object.assign({}, previous, { [keyText]: true }))
        api.table(connection.id, activeDb || undefined, table).then(data => {
          const pkColumns = ((data && Array.isArray(data.columns) ? data.columns : []) || [])
            .filter(col => col && col.key === 'PRI').map(col => String(col.name || ''))
            .filter(Boolean)
          setPkCache(previous => Object.assign({}, previous, {
            [keyText]: pkColumns.length
              ? { ok: true, table, pkColumns }
              : { ok: false, table, reason: t('results.edit.noPk') },
          }))
          setPkPending(previous => {
            const next = Object.assign({}, previous)
            delete next[keyText]
            return next
          })
        }, error => {
          // 第 49 轮：元数据查询失败（网络/权限/库不存在等）透出真实原因，
          // 不再笼统归为「无主键」误导排查
          setPkCache(previous => Object.assign({}, previous, {
            [keyText]: {
              ok: false, table,
              reason: t('results.edit.metaFail', { msg: errorText(error) || t('common.dash') }),
            },
          }))
          setPkPending(previous => {
            const next = Object.assign({}, previous)
            delete next[keyText]
            return next
          })
        })
        return null
      }, [pkCache, pkPending, connection.id, activeDb])

      // 查询成功后对可见结果集预取主键信息（每条 SQL 只取一次），驱动「编辑数据」按钮亮灭
      useEffect(() => {
        visibleEntries.forEach(entry => {
          const result = entry.result
          if (!result || result.error || result.kind === 'exec') return
          if (!Array.isArray(result.rows) || !result.rows.length) return
          const sqlText = String(result.sql || '')
          if (!sqlText || pkCache[sqlText] || pkPending[sqlText]) return
          ensurePkInfo(sqlText)
        })
      }, [visibleEntries, pkCache, pkPending, ensurePkInfo])

      const startRowEdit = useCallback(originalIndex => {
        const result = allResults[originalIndex]
        if (!result) return
        const sqlText = String(result.sql || '')
        const info = pkCache[sqlText]
        setExportNotice('')
        if (!info || !info.ok) {
          setExportNotice(info && info.reason ? info.reason : t('results.edit.checking'))
          setExportNoticeOk(false)
          return
        }
        if (connection.readonly) {
          setExportNotice(t('results.edit.readonly'))
          setExportNoticeOk(false)
          return
        }
        // 脱敏连接：结果集显示的是掩码值，把掩码写回真实数据会造成数据损坏——禁止行编辑
        if (connectionMaskingEnabled(connection)) {
          setExportNotice(t('results.edit.masked'))
          setExportNoticeOk(false)
          return
        }
        // 结果集必须包含全部主键列（SELECT 只查部分列时无法按主键定位行）
        const resultColumns = normalizeColumns(result.columns).map(col => String(col.name || ''))
        const missingPk = (info.pkColumns || []).filter(pk => resultColumns.indexOf(pk) < 0)
        if (missingPk.length) {
          setExportNotice(t('results.edit.noPkInResult', { cols: missingPk.join(', ') }))
          setExportNoticeOk(false)
          return
        }
        setEditState({ resultIndex: originalIndex, editedCells: {}, deletedRows: {}, newRows: [], newSeq: 0 })
      }, [allResults, pkCache, connection.readonly])

      const cancelRowEdit = useCallback(() => setEditState(null), [])

      const editCellInput = useCallback((rowIndex, colIndex, value) => {
        setEditState(current => {
          if (!current) return current
          const edited = Object.assign({}, current.editedCells)
          edited[rowIndex + ',' + colIndex] = value
          return Object.assign({}, current, { editedCells: edited })
        })
      }, [])

      const toggleDeleteRow = useCallback(rowIndex => {
        setEditState(current => {
          if (!current) return current
          const deleted = Object.assign({}, current.deletedRows)
          if (deleted[rowIndex]) delete deleted[rowIndex]
          else deleted[rowIndex] = true
          return Object.assign({}, current, { deletedRows: deleted })
        })
      }, [])

      const addRowEdit = useCallback(() => {
        setEditState(current => {
          if (!current) return current
          return Object.assign({}, current, {
            newRows: current.newRows.concat([{ key: 'new' + current.newSeq, values: {} }]),
            newSeq: current.newSeq + 1,
          })
        })
      }, [])

      const removeRowEdit = useCallback(key => {
        setEditState(current => {
          if (!current) return current
          return Object.assign({}, current, {
            newRows: current.newRows.filter(row => row.key !== key),
          })
        })
      }, [])

      const newRowInput = useCallback((key, colName, value) => {
        setEditState(current => {
          if (!current) return current
          return Object.assign({}, current, {
            newRows: current.newRows.map(row => (row.key === key
              ? { key, values: Object.assign({}, row.values, { [colName]: value }) }
              : row)),
          })
        })
      }, [])

      /** 提交前构建：多行变更 → rowsPayload + 完整 SQL 预览（每行一条 UPDATE/INSERT/DELETE）。 */
      const buildRowEditPayload = useCallback(() => {
        if (!editState) return null
        const result = allResults[editState.resultIndex]
        if (!result) return null
        const info = pkCache[String(result.sql || '')]
        if (!info || !info.ok) return null
        const columns = normalizeColumns(result.columns)
        const rows = Array.isArray(result.rows) ? result.rows : []
        const pkIndexes = info.pkColumns.map(pkName => columns.findIndex(col => col.name === pkName))
        const keysOfRow = rowIndex => {
          const origRow = rows[rowIndex] || []
          const keys = {}
          info.pkColumns.forEach((pkName, i) => {
            keys[pkName] = pkIndexes[i] >= 0 ? origRow[pkIndexes[i]] : null
          })
          return keys
        }
        const literalOf = value => (typeof value === 'string' && value.toUpperCase() === 'NULL' ? null : value)
        const whereOf = keys => info.pkColumns
          .map(pkName => '`' + pkName + '` = ' + sqlLiteral(keys[pkName])).join(' AND ')
        const updates = []
        const deletes = []
        const inserts = []
        const sqlLines = []
        Object.keys(editState.editedCells).sort((a, b) => Number(a.split(',')[0]) - Number(b.split(',')[0]))
          .forEach(cellKey => {
            const parts = cellKey.split(',')
            const rowIndex = Number(parts[0])
            const colIndex = Number(parts[1])
            if (editState.deletedRows[rowIndex]) return   // 已标删的行不再 UPDATE
            const colName = columns[colIndex] ? columns[colIndex].name : ''
            if (!colName) return
            const keys = keysOfRow(rowIndex)
            const setObj = {}
            setObj[colName] = literalOf(editState.editedCells[cellKey])
            updates.push({ keys, set: setObj })
            sqlLines.push('UPDATE `' + info.table + '` SET '
              + Object.keys(setObj).map(name => '`' + name + '` = ' + sqlLiteral(setObj[name])).join(', ')
              + ' WHERE ' + whereOf(keys) + ';')
          })
        Object.keys(editState.deletedRows).map(Number).sort((a, b) => a - b).forEach(rowIndex => {
          const keys = keysOfRow(rowIndex)
          deletes.push(keys)
          sqlLines.push('DELETE FROM `' + info.table + '` WHERE ' + whereOf(keys) + ';')
        })
        editState.newRows.forEach(newRow => {
          const obj = {}
          columns.forEach(col => {
            const value = newRow.values[col.name]
            if (value === undefined || value === '') return   // 未填列不进 INSERT
            obj[col.name] = literalOf(value)
          })
          if (!Object.keys(obj).length) return
          inserts.push(obj)
          sqlLines.push('INSERT INTO `' + info.table + '` ('
            + Object.keys(obj).map(name => '`' + name + '`').join(', ')
            + ') VALUES (' + Object.keys(obj).map(name => sqlLiteral(obj[name])).join(', ') + ');')
        })
        if (!updates.length && !deletes.length && !inserts.length) return null
        return {
          table: info.table, updates, deletes, inserts,
          previewSql: sqlLines.join('\n'),
          stats: { u: updates.length, i: inserts.length, d: deletes.length },
        }
      }, [editState, allResults, pkCache])

      const openRowEditModal = useCallback(() => {
        const payload = buildRowEditPayload()
        setRowEditError(null)
        if (!payload) {
          setExportNotice(t('results.edit.noChanges'))
          setExportNoticeOk(false)
          return
        }
        setRowEditModal(payload)
      }, [buildRowEditPayload])

      const submitRowEdit = useCallback(background => {
        if (!rowEditModal || rowEditBusy) return
        const text = String(background || '').trim()
        if (text.length < 4) {
          setRowEditError(new Error(t('sql.ticketBackgroundShort')))
          return
        }
        setRowEditBusy(true)
        setRowEditError(null)
        api.createTicket({
          connectionId: connection.id,
          database: activeDb || undefined,
          rowsPayload: {
            table: rowEditModal.table,
            updates: rowEditModal.updates,
            inserts: rowEditModal.inserts,
            deletes: rowEditModal.deletes,
          },
          background: text,
        }).then(data => {
          setRowEditBusy(false)
          const ticket = data && data.ticket ? data.ticket : null
          setRowEditModal(null)
          setEditState(null)
          setTicketNotice({ id: ticket ? ticket.id : '' })
        }, error => {
          setRowEditBusy(false)
          setRowEditError(error)
        })
      }, [rowEditModal, rowEditBusy, connection.id, activeDb])

      let resultBody
      if (tab === 'table') {
        resultBody = props.tableTarget
          ? h(TableDetail, {
            connection,
            database: props.tableTarget.database,
            table: props.tableTarget.table,
          })
          : h('div', { className: 'dbs-empty is-small' }, h(Icon, { name: 'columns', size: 24 }),
            h('div', { className: 'dbs-empty-text' }, t('table.empty')))
      } else if (queryError) {
        resultBody = h('div', { className: 'dbs-pad' },
          h(ErrorBar, { error: queryError }),
          queryError && queryError.code === 'READONLY'
            ? h('div', { className: 'dbs-note' }, t('sql.readonlyPathHint'))
            : null,
          blockedWrite
            ? h('div', { className: 'dbs-form-actions' },
              h('span', { className: 'dbs-note' }, t('sql.ticketEntryHint')),
              h('button', {
                type: 'button', className: 'dbs-btn is-small is-primary',
                onClick: openWriteTicket,
              }, h(Icon, { name: 'edit', size: 12 }), t('sql.ticketSubmit')))
            : null)
      } else if (ticketNotice) {
        resultBody = h('div', { className: 'dbs-pad' },
          h('div', { className: 'dbs-notice is-ok' },
            t('sql.ticketSubmitted', { id: ticketNotice.id || '—' }),
            h(NoticeClose, { onClose: () => setTicketNotice(null) })))
      } else if (running && !response) {
        resultBody = h('div', { className: 'dbs-empty is-small' }, h(Spinner, { large: true }),
          h('div', { className: 'dbs-empty-text' }, t('results.running')))
      } else if (!response) {
        resultBody = h('div', { className: 'dbs-empty is-small' },
          h(Icon, { name: 'code', size: 24 }),
          h('div', { className: 'dbs-empty-text' }, t('results.empty')),
          h('div', { className: 'dbs-empty-hint' }, t('results.emptyHint')))
      } else {
        resultBody = h(ResultsPane, {
          entries: visibleEntries,
          activeIndex: resultIndex,
          maxRows,
          fallbackElapsed: response.elapsedMs,
          exportNotice,
          exportNoticeOk,
          onExportNoticeClose: () => {
            setExportNotice('')
            setExportNoticeOk(false)
          },
          onSelect: setResultIndex,
          onClose: closeResultSet,
          onClear: clearResults,
          onExport: exportResult,
          // 第 48 轮：单行详情 + 行编辑（结构化工单）
          onRowDetail: originalIndex => setRowDetail(current => (current
            ? null
            : { resultIndex: originalIndex, rowIndex: 0 })),
          pkCache,
          pkPending,
          connectionReadonly: Boolean(connection.readonly),
          connectionMasked: connectionMaskingEnabled(connection),
          rowEdit: editState && editState.resultIndex === resultIndex
            ? { state: editState }
            : null,
          onEditStart: startRowEdit,
          onEditCancel: cancelRowEdit,
          onEditAddRow: addRowEdit,
          onEditCellInput: editCellInput,
          onEditToggleDelete: toggleDeleteRow,
          onEditNewRowInput: newRowInput,
          onEditRemoveNewRow: removeRowEdit,
          onEditCommit: openRowEditModal,
        })
      }

      const tabs = h('div', { className: 'dbs-tabbar', role: 'tablist' },
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': tab === 'result' ? 'true' : 'false',
          className: 'dbs-tab' + (tab === 'result' ? ' is-on' : ''),
          onClick: () => setTab('result'),
        }, t('results.title')),
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': tab === 'table' ? 'true' : 'false',
          className: 'dbs-tab' + (tab === 'table' ? ' is-on' : ''),
          onClick: () => setTab('table'),
        }, t('results.tableTab')),
        props.tableTarget ? h('span', { className: 'dbs-tab-note' },
          props.tableTarget.database + '.' + props.tableTarget.table) : null)

      const beginResize = event => {
        if (!event) return
        if (typeof event.button === 'number' && event.button !== 0) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const container = splitContainerRef.current
        const rect = container && typeof container.getBoundingClientRect === 'function'
          ? container.getBoundingClientRect()
          : null
        const height = rect && rect.height ? rect.height : 480
        dragRef.current = {
          startY: typeof event.clientY === 'number' ? event.clientY : 0,
          startRatio: ratioRef.current,
          height,
        }
        setResizingLayout(true)
        const target = event.currentTarget
        if (target && typeof target.setPointerCapture === 'function' && event.pointerId !== undefined) {
          try {
            target.setPointerCapture(event.pointerId)
          } catch (error) {
            /* 老浏览器忽略 pointer capture */
          }
        }
      }

      const moveResize = event => {
        const drag = dragRef.current
        if (!drag || !event) return
        if (typeof event.preventDefault === 'function') event.preventDefault()
        const clientY = typeof event.clientY === 'number' ? event.clientY : drag.startY
        const ratio = clampEditorRatio(drag.startRatio + (clientY - drag.startY) / drag.height, drag.height)
        ratioRef.current = ratio
        setEditorRatio(ratio)
      }

      const endResize = event => {
        if (!dragRef.current) return
        dragRef.current = null
        setResizingLayout(false)
        writeStoredEditorRatio(ratioRef.current)
        if (event && typeof event.preventDefault === 'function') event.preventDefault()
      }

      const resetResize = () => {
        // 双击：恢复默认 6:4 并持久化
        dragRef.current = null
        setResizingLayout(false)
        ratioRef.current = DEFAULT_EDITOR_RATIO
        setEditorRatio(DEFAULT_EDITOR_RATIO)
        writeStoredEditorRatio(DEFAULT_EDITOR_RATIO)
      }

      const editorRegion = h('div', {
        className: 'dbs-editor-region',
        style: { flexBasis: (Number(ratioRef.current || editorRatio) * 100).toFixed(2) + '%' },
      }, editorBox)
      const splitter = h('div', {
        className: 'dbs-splitter' + (resizingLayout ? ' is-resizing' : ''),
        role: 'separator',
        'aria-orientation': 'horizontal',
        title: t('layout.splitTip'),
        onPointerDown: beginResize,
        onPointerMove: moveResize,
        onPointerUp: endResize,
        onPointerCancel: endResize,
        onDoubleClick: resetResize,
      }, h('span', { className: 'dbs-splitter-grip' }))
      const workbenchMain = h('div', {
        className: 'dbs-workbench-main' + (resizingLayout ? ' is-resizing' : ''),
        ref: splitContainerRef,
      },
      editorRegion,
      splitter,
      h('div', { className: 'dbs-workbench-results' },
        h('div', { className: 'dbs-results' },
          tabs,
          h('div', { className: 'dbs-results-scroll' }, resultBody))))
      // Ctrl+S / Cmd+S：面板内任何焦点（编辑器/工具条/结果区）按下都会冒泡到根节点统一处理
      // Ctrl+F 同理兜底（编辑器自己的 keydown 已处理并 preventDefault，这里靠 defaultPrevented 跳过避免重复打开）
      return h('div', {
        className: 'dbs-workbench' + (props.hidden ? ' is-hidden' : ''),
        onKeyDown: event => {
          if (!event) return
          const key = String(event.key || '')
          if ((key === 's' || key === 'S') && (event.ctrlKey || event.metaKey) && !event.altKey) {
            if (event.preventDefault) event.preventDefault()
            if (props.onSaveFile) props.onSaveFile()
          }
          if ((key === 'f' || key === 'F') && (event.ctrlKey || event.metaKey)
            && !event.shiftKey && !event.altKey && !event.defaultPrevented) {
            if (event.preventDefault) event.preventDefault()
            openEditorSearch(false)
          }
          if ((key === 'f' || key === 'F') && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey) {
            if (event.preventDefault) event.preventDefault()
            formatSqlNow()
          }
        },
      },
      runbar,
      h('div', { className: 'dbs-workbench-body' }, workbenchMain),
      ticketModal
        ? h(WriteTicketModal, {
          open: true,
          sql: ticketModal.sql,
          background: ticketModal.background || '',
          busy: ticketModalBusy,
          error: ticketModalError,
          onSqlChange: value => setTicketModal(previous => ({ ...previous, sql: value })),
          onBackgroundChange: value => setTicketModal(previous => ({ ...previous, background: value })),
          onClose: () => { setTicketModal(null); setTicketModalError(null) },
          onConfirm: submitWriteTicket,
        })
        : null,
      // 第 48 轮：单行详情弹层 + 行编辑提交工单弹窗
      rowDetail && allResults[rowDetail.resultIndex]
        ? h(RowDetailModal, {
          columns: normalizeColumns(allResults[rowDetail.resultIndex].columns),
          rows: Array.isArray(allResults[rowDetail.resultIndex].rows)
            ? allResults[rowDetail.resultIndex].rows : [],
          index: rowDetail.rowIndex,
          onClose: () => setRowDetail(null),
        })
        : null,
      rowEditModal
        ? h(RowEditModal, {
          open: true,
          table: rowEditModal.table,
          stats: rowEditModal.stats,
          previewSql: rowEditModal.previewSql,
          background: rowEditModal.background || '',
          busy: rowEditBusy,
          error: rowEditError,
          onBackgroundChange: value => setRowEditModal(previous => (
            previous ? Object.assign({}, previous, { background: value }) : previous)),
          onClose: () => { setRowEditModal(null); setRowEditError(null) },
          onConfirm: () => submitRowEdit(rowEditModal.background),
        })
        : null)
    }
