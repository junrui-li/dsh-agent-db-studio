
    // ======================================================================
    // 9. 表详情：列 / 索引 / DDL
    // ======================================================================

    function TableDetail(props) {
      const connection = props.connection
      const database = props.database
      const table = props.table
      const state = useAsync(
        signal => api.table(connection.id, database, table, false, signal),
        [connection.id, database, table],
      )
      const [tab, setTab] = useState('columns')
      const [exactRows, setExactRows] = useState(null)
      const [counting, setCounting] = useState(false)
      const [countError, setCountError] = useState(null)

      useEffect(() => {
        setTab('columns')
        setExactRows(null)
        setCountError(null)
      }, [connection.id, database, table])

      const countExact = useCallback(() => {
        if (counting) return
        setCounting(true)
        setCountError(null)
        api.table(connection.id, database, table, true)
          .then(data => {
            if (data.exactRows !== undefined && data.exactRows !== null) setExactRows(data.exactRows)
            else if (data.estimatedRows !== undefined && data.estimatedRows !== null) setExactRows(data.estimatedRows)
          }, error => {
            if (!isAbort(error)) setCountError(error)
          })
          .then(() => setCounting(false), () => setCounting(false))
      }, [connection.id, database, table, counting])

      const data = state.data || {}
      const columns = Array.isArray(data.columns) ? data.columns : []
      const indexes = Array.isArray(data.indexes) ? data.indexes : []
      const estimatedRows = data.estimatedRows !== undefined && data.estimatedRows !== null
        ? data.estimatedRows
        : null

      const head = h('div', { className: 'dbs-td-head' },
        h(Icon, { name: 'table', size: 15 }),
        h('span', { className: 'dbs-td-name', title: database + '.' + table }, database + '.' + table),
        estimatedRows !== null ? h(Tag, { tone: 'plain' }, t('table.estimatedRows', { n: formatNumber(estimatedRows) })) : null,
        exactRows !== null ? h(Tag, { tone: 'link' }, t('table.exactRows', { n: formatNumber(exactRows) })) : null,
        h('span', { className: 'dbs-grow' }),
        h('button', {
          type: 'button', className: 'dbs-btn is-small', onClick: countExact, disabled: counting,
        }, counting ? t('table.counting') : t('table.exactCount')))

      let content
      if (state.error) {
        content = h('div', { className: 'dbs-pad' },
          h(ErrorBar, { error: state.error, label: t('table.error'), onRetry: state.reload }))
      } else if (state.loading && !state.data) {
        content = h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 6 }))
      } else {
        const columnRows = columns.map(column => [
          column.name !== undefined ? String(column.name) : '',
          String(column.type || '') + (column.extra ? ' · ' + String(column.extra) : ''),
          column.nullable ? t('table.yes') : t('table.no'),
          column.key === 'PRI' ? 'PK' : '',
          column.default === null || column.default === undefined ? null : String(column.default),
          column.comment ? String(column.comment) : null,
        ])
        const indexRows = indexes.map(index => [
          index.name !== undefined ? String(index.name) : '',
          index.unique ? t('table.yes') : t('table.no'),
          Array.isArray(index.columns) ? index.columns.join(', ') : '',
          index.type ? String(index.type) : '',
        ])
        const tabBar = h('div', { className: 'dbs-tabbar', role: 'tablist' },
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': tab === 'columns' ? 'true' : 'false',
            className: 'dbs-tab' + (tab === 'columns' ? ' is-on' : ''),
            onClick: () => setTab('columns'),
          }, t('table.columns'), columns.length ? h('span', { className: 'dbs-count' }, String(columns.length)) : null),
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': tab === 'indexes' ? 'true' : 'false',
            className: 'dbs-tab' + (tab === 'indexes' ? ' is-on' : ''),
            onClick: () => setTab('indexes'),
          }, t('table.indexes'), indexes.length ? h('span', { className: 'dbs-count' }, String(indexes.length)) : null),
          h('button', {
            type: 'button', role: 'tab', 'aria-selected': tab === 'ddl' ? 'true' : 'false',
            className: 'dbs-tab' + (tab === 'ddl' ? ' is-on' : ''),
            onClick: () => setTab('ddl'),
          }, t('table.ddl')))
        let pane
        if (tab === 'columns') {
          pane = columnRows.length
            ? h(ResultGrid, {
              columns: [
                { name: t('table.columnName') }, { name: t('table.columnType') },
                { name: t('table.columnNullable') }, { name: t('table.columnPk') },
                { name: t('table.columnDefault') }, { name: t('table.columnComment') },
              ],
              rows: columnRows,
            })
            : h('div', { className: 'dbs-pad dbs-muted' }, t('meta.emptyDatabase'))
        } else if (tab === 'indexes') {
          pane = indexRows.length
            ? h(ResultGrid, {
              columns: [
                { name: t('table.indexName') }, { name: t('table.indexUnique') },
                { name: t('table.indexColumns') }, { name: t('table.indexType') },
              ],
              rows: indexRows,
            })
            : h('div', { className: 'dbs-pad dbs-muted' }, t('common.dash'))
        } else {
          pane = h('div', { className: 'dbs-ddl-box' },
            h('div', { className: 'dbs-ddl-bar' },
              h('span', { className: 'dbs-muted' }, database + '.' + table),
              h('span', { className: 'dbs-grow' }),
              h(CopyButton, { label: t('table.copyDdl'), getText: () => String(data.ddl || '') })),
            h('pre', { className: 'dbs-pre' }, String(data.ddl || ('-- ' + t('common.dash')))))
        }
        content = h('div', { className: 'dbs-td-body' }, tabBar, pane)
      }

      return h('div', { className: 'dbs-tabledetail' },
        head,
        countError ? h('div', { className: 'dbs-pad' }, h(ErrorBar, {
          error: countError, compact: true, label: t('table.error'),
        })) : null,
        content)
    }
