
    // ======================================================================
    // 11.8 执行历史视图（契约 §3.5）：时间筛选 + 分页 + 目的/EXPLAIN 计划
    // ======================================================================

    const HISTORY_PAGE_SIZE = 50   // 第 45 轮：工单/历史统一每页 50 条（时间倒序）

    /** EXPLAIN 计划表（item.explain）：每条语句一块，plans 列 / 出错显示原文。 */
    function HistoryExplainBlocks(props) {
      const blocks = Array.isArray(props.blocks) ? props.blocks : []
      if (!blocks.length) return null
      return h('div', { className: 'dbs-history-explain' },
        h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('history.detail.explainTitle')),
        blocks.map((block, blockIndex) => {
          const safeBlock = block && typeof block === 'object' ? block : {}
          const plans = Array.isArray(safeBlock.plans) ? safeBlock.plans : []
          return h('div', {
            key: 'explain:' + safeBlock.index + ':' + blockIndex,
            className: 'dbs-history-explain-block',
          },
          h('div', { className: 'dbs-history-explain-stmt' },
            t('history.detail.explainStatement', { n: safeBlock.index === undefined || safeBlock.index === null ? blockIndex + 1 : safeBlock.index })),
          plans.some(plan => plan && typeof plan === 'object' && !plan.error)
            ? h('div', { className: 'dbs-grid-wrap' },
              h('table', { className: 'dbs-grid' },
                h('thead', null, h('tr', null,
                  h('th', null, t('history.detail.explainTable')),
                  h('th', null, t('history.detail.explainType')),
                  h('th', null, t('history.detail.explainKey')),
                  h('th', null, t('history.detail.explainRows')),
                  h('th', null, t('history.detail.explainExtra')))),
                h('tbody', null, plans.map((plan, planIndex) => {
                  const safePlan = plan && typeof plan === 'object' ? plan : {}
                  if (safePlan.error) return null
                  return h('tr', { key: 'plan:' + planIndex },
                    h('td', null, safeText(safePlan.table, t('common.dash'))),
                    h('td', null, safeText(safePlan.type, t('common.dash'))),
                    h('td', null, safeText(safePlan.key, t('common.dash'))),
                    h('td', { className: 'is-num' }, safePlan.rows === null || safePlan.rows === undefined
                      ? t('common.dash')
                      : formatNumber(safePlan.rows)),
                    h('td', null, safeText(safePlan.extra, '')))
                }))))
            : null,
          plans.map((plan, planIndex) => {
            const safePlan = plan && typeof plan === 'object' ? plan : {}
            if (!safePlan.error) return null
            return h('pre', { key: 'plan-error:' + planIndex, className: 'dbs-history-explain-error' },
              String(safePlan.error))
          }))
        }))
    }

    function HistoryDetailPane(props) {
      const item = props.item
      if (!item) {
        return h('div', { className: 'dbs-empty is-small' },
          h(Icon, { name: 'list', size: 22 }),
          h('div', { className: 'dbs-empty-text' }, t('history.detail.empty')))
      }
      const connectionMissing = Boolean(props.missingConnection)
      return h('div', { className: 'dbs-history-detail' },
        h('div', { className: 'dbs-history-detail-head' },
          h('span', { className: 'dbs-history-detail-title' }, t('history.detail.title')),
          h(Tag, { tone: historyStatusTone(item.status) }, historyStatusLabel(item.status)),
          h(Tag, { tone: 'plain' }, historySourceLabel(item.source)),
          item.kind ? h(Tag, { tone: 'plain' }, item.kind === 'execute'
            ? t('history.kind.execute')
            : (item.kind === 'export' ? t('history.kind.export') : t('history.kind.query'))) : null,
          h('span', { className: 'dbs-grow' }),
          props.onUndo && item.kind === 'execute' && item.status === 'ok'
            ? h('button', {
              type: 'button', className: 'dbs-btn is-small',
              disabled: (item.undo !== null && item.undo.available === false)
                || item.undoLive === 'undone' || item.undoLive === 'undoing',
              title: item.undo !== null && item.undo.available === false
                ? (item.undo.reason || t('undo.none'))
                : (item.undoLive === 'undone' ? t('undo.liveUndone') : undefined),
              onClick: () => props.onUndo({ historyId: item.id }),
            }, h(Icon, { name: 'refresh', size: 12 }), t('undo.button'))
            : null,
          h('button', {
            type: 'button', className: 'dbs-btn is-primary is-small',
            onClick: () => { if (props.onLoadSql) props.onLoadSql(item) },
          }, h(Icon, { name: 'code', size: 12 }), t('history.detail.loadEditor'))),
        props.loaded ? h('div', { className: 'dbs-note' }, t('history.detail.loaded')) : null,
        connectionMissing
          ? h('div', { className: 'dbs-note' }, t('history.detail.missingConnection'))
          : null,
        h('div', { className: 'dbs-ticket-meta' },
          h(DetailMetaRow, { label: t('history.row.time') }, safeText(item.time, t('common.dash'))),
          h(DetailMetaRow, { label: t('history.row.connection') },
            safeText(item.connectionName, safeText(item.connectionId, t('common.dash')))),
          h(DetailMetaRow, { label: t('history.row.database') }, safeText(item.database, t('common.dash'))),
          h(DetailMetaRow, { label: t('history.row.elapsed') }, item.elapsedMs === null
            ? t('common.dash')
            : t('results.elapsed', { n: formatNumber(item.elapsedMs) })),
          h(DetailMetaRow, { label: t('history.detail.rowCount') }, item.rowCount === null
            ? t('common.dash')
            : formatNumber(item.rowCount)),
          h(DetailMetaRow, { label: t('history.detail.affectedRows') }, item.affectedRows === null
            ? t('common.dash')
            : formatNumber(item.affectedRows)),
          item.statementCount !== null
            ? h(DetailMetaRow, { label: t('history.detail.statementCount') }, formatNumber(item.statementCount))
            : null,
          item.purpose ? h(DetailMetaRow, { label: t('history.detail.purpose') }, item.purpose) : null,
          item.truncated ? h(DetailMetaRow, { label: t('history.detail.truncated') }, t('common.yes')) : null,
          item.ticketId
            ? h(DetailMetaRow, { label: t('history.detail.ticket') },
              h('button', {
                type: 'button', className: 'dbs-btn is-small',
                title: t('history.openTicket'),
                onClick: () => { if (props.onOpenTicket) props.onOpenTicket(item.ticketId) },
              }, h(Icon, { name: 'layers', size: 11 }), item.ticketId))
            : null,
          item.ticketBy
            ? h(DetailMetaRow, { label: t('history.detail.ticketBy') },
              item.ticketBy === 'user' ? t('history.ticketBy.user') : t('history.ticketBy.agent'))
            : null),
        item.error
          ? h('div', { className: 'dbs-ticket-error' },
            h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('history.detail.errorTitle')),
            h('pre', { className: 'dbs-error-pre' }, item.error))
          : null,
        item.undo && item.undo.available === false
          ? h('div', { className: 'dbs-note' }, t('undo.unavailable', {
            reason: item.undo.reason || t('undo.none'),
          }))
          : null,
        item.undoLive === 'undone'
          ? h('div', { className: 'dbs-note' }, t('undo.liveUndone'))
          : null,
        h(HistoryExplainBlocks, { blocks: item.explain }),
        h('div', { className: 'dbs-ticket-sql-head' },
          h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('history.row.sql')),
          h('span', { className: 'dbs-grow' }),
          h(CopyButton, { label: t('history.detail.copySql'), getText: () => item.sql })),
        h('pre', { className: 'dbs-pre dbs-ticket-sql' }, item.sql || ''))
    }

    function HistoryView(props) {
      const [filter, setFilter] = useState({ connectionId: '', status: '', keyword: '', from: '', to: '' })
      const [keywordDraft, setKeywordDraft] = useState('')
      const [offset, setOffset] = useState(0)
      const [selectedId, setSelectedId] = useState('')
      const [loaded, setLoaded] = useState(false)
      const [notice, setNotice] = useState(null)
      const [undoPreview, setUndoPreview] = useState(null)
      const [undoBusy, setUndoBusy] = useState(false)
      const [undoError, setUndoError] = useState(null)
      const connections = props.connections || []

      const state = useAsync(
        signal => api.history({
          limit: HISTORY_PAGE_SIZE,
          offset,
          connectionId: filter.connectionId || undefined,
          status: filter.status || undefined,
          keyword: filter.keyword || undefined,
          from: filter.from || undefined,
          to: filter.to || undefined,
        }, signal),
        [filter.connectionId, filter.status, filter.keyword, filter.from, filter.to, offset],
      )
      const items = ((state.data && state.data.history) || []).map(normalizeHistoryItem)
      const total = state.data && typeof state.data.total === 'number' ? state.data.total : null
      const selected = items.find(item => item.id === selectedId) || null

      useEffect(() => {
        if (selectedId) return
        if (items.length) setSelectedId(items[0].id)
      }, [state.data])
      // 过滤条件变化时清空选中并回到第一页，避免详情/分页还停在过滤外的记录上
      useEffect(() => {
        setSelectedId('')
      }, [filter.connectionId, filter.status, filter.keyword, filter.from, filter.to])
      useEffect(() => {
        setOffset(0)
      }, [filter])
      useEffect(() => {
        setLoaded(false)
      }, [selectedId])
      // 跨视图筛选种子（第 27 轮）：工单详情「查看执行历史」带工单号过来，自动应用关键字筛选
      useEffect(() => {
        const keyword = props.filterSeed && props.filterSeed.keyword
          ? String(props.filterSeed.keyword)
          : ''
        if (!keyword) return
        setKeywordDraft(keyword)
        setFilter(previous => (previous.keyword === keyword
          ? previous
          : Object.assign({}, previous, { keyword })))
      }, [props.filterSeed])

      const openUndo = useCallback((params) => {
        setNotice(null)
        setUndoError(null)
        api.undoPreview(params).then(body => {
          const undo = body && body.undo && body.undo.id ? body.undo : null
          setUndoPreview(undo)
          if (!undo) setNotice({ tone: 'bad', text: t('undo.none') })
        }, error => {
          setUndoPreview(null)
          setNotice({ tone: 'bad', text: t('undo.none') + '：' + errorText(error) })
        })
      }, [])

      const confirmUndo = useCallback(force => {
        if (undoBusy || !undoPreview) return
        setUndoBusy(true)
        setUndoError(null)
        api.undoExecute(undoPreview.id, force).then(data => {
          setUndoBusy(false)
          setUndoPreview(null)
          setNotice({ tone: 'ok', text: t('undo.done', { id: safeText(data && data.undo ? data.undo.id : '', '') }) })
          state.reload()
        }, error => {
          setUndoBusy(false)
          setUndoError(error)
        })
      }, [undoBusy, undoPreview, state.reload])

      const applyKeyword = () => {
        const keyword = String(keywordDraft || '').trim()
        setFilter(previous => (previous.keyword === keyword ? previous : Object.assign({}, previous, { keyword })))
      }

      let listBody
      if (state.error) {
        listBody = h('div', { className: 'dbs-pad' }, h(ErrorBar, {
          error: state.error, label: t('history.error'), onRetry: state.reload,
        }))
      } else if (state.loading && !items.length) {
        listBody = h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 8 }))
      } else if (!items.length) {
        const filtered = Boolean(filter.connectionId || filter.status || filter.keyword
          || filter.from || filter.to)
        listBody = h('div', { className: 'dbs-empty is-small' },
          h(Icon, { name: 'list', size: 22 }),
          h('div', { className: 'dbs-empty-title' }, filtered ? t('history.emptyFiltered') : t('history.emptyTitle')),
          filtered ? null : h('p', { className: 'dbs-empty-text' }, t('history.emptyBody')))
      } else {
        listBody = h('div', { className: 'dbs-history-list' },
          h('div', { className: 'dbs-history-row is-head' },
            h('span', null, t('history.row.time')),
            h('span', null, t('history.row.connection')),
            h('span', null, t('history.row.database')),
            h('span', null, t('history.row.sql')),
            h('span', null, t('history.row.status')),
            h('span', null, t('history.row.source')),
            h('span', null, t('history.row.ticket')),
            h('span', null, t('history.row.ticketBy')),
            h('span', null, t('history.row.elapsed')),
            h('span', null, t('history.row.rows'))),
          items.map(item => h('button', {
            key: 'history:' + (item.id || item.time + item.sql.slice(0, 20)),
            type: 'button',
            className: 'dbs-history-row' + (item.id === selectedId ? ' is-on' : ''),
            onClick: () => setSelectedId(item.id),
          },
          h('span', { className: 'dbs-mono' }, safeText(item.time, t('common.dash'))),
          h('span', null, safeText(item.connectionName, safeText(item.connectionId, t('common.dash')))),
          h('span', null, safeText(item.database, t('common.dash'))),
          h('span', { className: 'dbs-history-sql', title: item.sql }, sqlSummary(item.sql, 100)),
          h('span', null, h(Tag, { tone: historyStatusTone(item.status) }, historyStatusLabel(item.status))),
          h('span', null, historySourceLabel(item.source)),
          // 关联工单（第 27 轮双向关联）：列表内直接可见并可跳转；点击不改变选中行
          item.ticketId && props.onOpenTicket
            ? h('span', null, h('button', {
              type: 'button', className: 'dbs-btn is-small',
              title: t('history.openTicket'),
              onClick: event => {
                if (event && event.stopPropagation) event.stopPropagation()
                props.onOpenTicket(item.ticketId)
              },
            }, item.ticketId))
            : h('span', null, t('common.dash')),
          h('span', null, item.ticketBy
            ? (item.ticketBy === 'user' ? t('history.ticketByShort.user') : t('history.ticketByShort.agent'))
            : t('common.dash')),
          h('span', { className: 'dbs-mono' }, item.elapsedMs === null
            ? t('common.dash')
            : t('results.elapsed', { n: formatNumber(item.elapsedMs) })),
          h('span', { className: 'dbs-mono' }, historyRowCountText(item)))))
      }

      // 翻页条：total 已知且（超过一页或已翻页）才显示
      const showPager = total !== null && (total > HISTORY_PAGE_SIZE || offset > 0)
      const pager = showPager
        ? h('div', { className: 'dbs-history-page', 'data-dbs-testid': 'history-pager' },
          h('button', {
            type: 'button',
            className: 'dbs-btn is-small',
            'data-dbs-testid': 'history-prev-page',
            onClick: () => setOffset(current => Math.max(0, current - HISTORY_PAGE_SIZE)),
            disabled: offset <= 0,
          }, t('history.page.prev')),
          h('button', {
            type: 'button',
            className: 'dbs-btn is-small',
            'data-dbs-testid': 'history-next-page',
            onClick: () => setOffset(current => current + HISTORY_PAGE_SIZE),
            disabled: total !== null && offset + HISTORY_PAGE_SIZE >= total,
          }, t('history.page.next')),
          h('span', { className: 'dbs-history-page-info' },
            t('history.page.summary', {
              total: formatNumber(total),
              page: formatNumber(Math.floor(offset / HISTORY_PAGE_SIZE) + 1),
            })))
        : null

      return h('div', { className: 'dbs-view' },
        h('div', { className: 'dbs-view-head' },
          h('div', { className: 'dbs-view-heading' },
            h('div', { className: 'dbs-view-title' }, t('history.title')),
            h('div', { className: 'dbs-view-sub' }, t('history.subtitle'))),
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', onClick: state.reload, disabled: state.loading,
          }, h(Icon, { name: 'refresh', size: 13 }), t('history.refresh'))),
        h('div', { className: 'dbs-view-chips dbs-history-filters' },
          h('span', { className: 'dbs-muted' }, t('history.filter.connection')),
          h('select', {
            className: 'dbs-select',
            value: filter.connectionId,
            'aria-label': t('history.filter.connection'),
            onChange: event => setFilter(previous => Object.assign({}, previous, { connectionId: event.target.value })),
          },
          h('option', { value: '' }, t('history.filter.allConnections')),
          connections.map(connection => h('option', {
            key: connection.id, value: connection.id,
          }, safeText(connection.name, connection.id)))),
          h('span', { className: 'dbs-muted' }, t('history.filter.status')),
          h('select', {
            className: 'dbs-select',
            value: filter.status,
            'aria-label': t('history.filter.status'),
            onChange: event => setFilter(previous => Object.assign({}, previous, { status: event.target.value })),
          },
          h('option', { value: '' }, t('history.filter.allStatus')),
          h('option', { value: 'ok' }, t('history.filter.ok')),
          h('option', { value: 'error' }, t('history.filter.error'))),
          h('input', {
            className: 'dbs-input is-date',
            type: 'date',
            value: filter.from,
            'aria-label': t('history.filter.from'),
            'data-dbs-testid': 'history-from',
            onChange: event => setFilter(previous => Object.assign({}, previous,
              { from: event && event.target ? event.target.value : '' })),
          }),
          h('input', {
            className: 'dbs-input is-date',
            type: 'date',
            value: filter.to,
            'aria-label': t('history.filter.to'),
            'data-dbs-testid': 'history-to',
            onChange: event => setFilter(previous => Object.assign({}, previous,
              { to: event && event.target ? event.target.value : '' })),
          }),
          h('input', {
            className: 'dbs-input',
            value: keywordDraft,
            placeholder: t('history.filter.keyword'),
            'aria-label': t('history.filter.keyword'),
            onChange: event => setKeywordDraft(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                if (event.preventDefault) event.preventDefault()
                applyKeyword()
              }
            },
          }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', onClick: applyKeyword,
          }, h(Icon, { name: 'search', size: 12 }), t('history.filter.apply'))),
        notice
          ? h('div', { className: 'dbs-notice is-' + notice.tone }, notice.text,
            h(NoticeClose, { onClose: () => setNotice(null) }))
          : null,
        h('div', { className: 'dbs-view-split' },
          h('div', { className: 'dbs-history-list-pane' },
            listBody,
            pager),
          h('div', { className: 'dbs-history-detail-pane' },
            h(HistoryDetailPane, {
              item: selected,
              loaded,
              missingConnection: Boolean(selected && selected.connectionId
                && !connections.some(connection => connection.id === selected.connectionId)),
              onUndo: openUndo,
              onOpenTicket: props.onOpenTicket,
              onLoadSql: item => {
                if (props.onLoadSql) props.onLoadSql(item)
                setLoaded(true)
              },
            }))),
        undoPreview
          ? h(UndoConfirmModal, {
            undo: undoPreview,
            busy: undoBusy,
            error: undoError,
            onClose: () => { setUndoPreview(null); setUndoError(null) },
            onConfirm: confirmUndo,
          })
          : null)
    }
