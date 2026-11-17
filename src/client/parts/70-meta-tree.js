
    // ======================================================================
    // 7. 左栏：元数据树（MySQL 库→表/视图，Redis db 列表；懒加载）
    // ======================================================================

    // 表名模糊匹配：大小写不敏感的「字符子序列」——查询串的字符按顺序全部出现在
    // 表名里即命中（忽略空格/下划线差异）。比前缀/包含都宽：`tusr` 命中 t_user、
    // `tpo` 命中 t_trade_order，宁多勿漏（第 55 轮）。
    function fuzzyTableNameMatch(name, query) {
      const haystack = String(name || '').toLowerCase()
      const needle = String(query || '').toLowerCase().replace(/[\s_]+/g, '')
      if (!needle) return false
      let from = 0
      for (let i = 0; i < needle.length; i++) {
        from = haystack.indexOf(needle[i], from)
        if (from < 0) return false
        from += 1
      }
      return true
    }

    function MetaTree(props) {
      const connection = props.connection
      const isRedis = connection.kind === 'redis'
      const databaseState = props.databaseState || { loading: false, data: null, error: null }
      const entries = (databaseState.data && Array.isArray(databaseState.data.databases))
        ? databaseState.data.databases
        : []
      const [expanded, setExpanded] = useState({})
      const [cache, setCache] = useState({})
      const [tableQuery, setTableQuery] = useState('')
      const seqRef = useRef({})

      // 外部刷新（全局刷新 / 本组件刷新按钮）时清空懒加载缓存
      useEffect(() => {
        seqRef.current = {}
        setExpanded({})
        setCache({})
        setTableQuery('')
      }, [props.reloadToken, connection.id])

      const databaseName = entry => (typeof entry === 'string' ? entry : String(entry.name))

      const loadTables = useCallback(name => {
        const sequences = seqRef.current
        const seq = (sequences[name] || 0) + 1
        sequences[name] = seq
        setCache(previous => Object.assign({}, previous, {
          [name]: { loading: true, error: null, tables: null },
        }))
        api.tables(connection.id, name).then(
          data => {
            if (seqRef.current[name] !== seq) return
            setCache(previous => Object.assign({}, previous, {
              [name]: { loading: false, error: null, tables: Array.isArray(data.tables) ? data.tables : [] },
            }))
          },
          error => {
            if (seqRef.current[name] !== seq || isAbort(error)) return
            setCache(previous => Object.assign({}, previous, {
              [name]: { loading: false, error, tables: null },
            }))
          },
        )
      }, [connection.id])

      const toggleDatabase = useCallback(name => {
        if (isRedis) {
          if (props.onSelectDb) props.onSelectDb(name)
          return
        }
        const willOpen = !expanded[name]
        setExpanded(previous => Object.assign({}, previous, { [name]: willOpen }))
        if (willOpen) {
          if (props.onSelectDb) props.onSelectDb(name)
          if (!cache[name]) loadTables(name)
        }
      }, [expanded, cache, isRedis, loadTables, props.onSelectDb])

      // 搜索态：表是按库懒加载的，跨库搜索先把没拉过的库全部补齐（缓存命中即跳过）
      const queryText = String(tableQuery || '').trim()
      useEffect(() => {
        if (isRedis || !queryText || !entries.length) return
        entries.forEach(entry => {
          const name = databaseName(entry)
          if (!cache[name]) loadTables(name)
        })
      }, [isRedis, queryText, entries, cache, loadTables])

      const header = h('div', { className: 'dbs-section-head' },
        h('span', { className: 'dbs-section-title' }, t('meta.title')),
        h('span', { className: 'dbs-grow' }),
        h('button', {
          type: 'button', className: 'dbs-iconbtn', title: t('meta.refresh'),
          onClick: props.onRefresh, disabled: databaseState.loading,
        }, h(Icon, { name: 'refresh', size: 14 })))

      const searchRow = !isRedis && entries.length ? h('div', { className: 'dbs-meta-search' },
        h('input', {
          type: 'text',
          className: 'dbs-input is-full',
          name: 'metaTableSearch',
          value: tableQuery,
          placeholder: t('meta.searchPlaceholder'),
          'aria-label': t('meta.searchPlaceholder'),
          'data-dbs-testid': 'meta-table-search',
          onChange: event => setTableQuery(event && event.target ? event.target.value : ''),
        })) : null

      let body
      if (databaseState.error) {
        body = h('div', { className: 'dbs-pad' }, h(ErrorBar, {
          error: databaseState.error, label: t('meta.error'), onRetry: props.onRefresh,
        }))
      } else if (!entries.length) {
        body = databaseState.loading
          ? h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 4 }))
          : h('div', { className: 'dbs-empty is-small' },
            h(Icon, { name: 'table', size: 22 }),
            h('div', { className: 'dbs-empty-title' }, t('meta.empty')))
      } else if (isRedis) {
        body = h('div', { className: 'dbs-tree', role: 'tree' }, entries.map(entry => {
          const name = databaseName(entry)
          const active = name === String(props.activeDb)
          const keys = typeof entry === 'object' && entry ? entry.keys : undefined
          return h('button', {
            key: 'db:' + name,
            type: 'button',
            role: 'treeitem',
            className: 'dbs-tree-row dbs-tree-db' + (active ? ' is-on' : ''),
            'aria-selected': active ? 'true' : 'false',
            onClick: () => { if (props.onSelectDb) props.onSelectDb(name) },
          },
          h(Icon, { name: 'layers', size: 13 }),
          h('span', { className: 'dbs-tree-label' }, 'db' + name),
          keys !== undefined && keys !== null
            ? h('span', { className: 'dbs-tree-sub' }, t('meta.dbKeys', { n: formatNumber(keys) }))
            : null)
        }))
      } else if (queryText) {
        // 搜索结果：跨库平铺，按库分组；还没拉完的库边搜边出（部分结果先可见）
        const groups = []
        let searching = false
        entries.forEach(entry => {
          const name = databaseName(entry)
          const node = cache[name]
          if (!node || node.loading) {
            searching = true
            return
          }
          if (node.error) return
          const items = (node.tables || []).filter(item => item && fuzzyTableNameMatch(item.name, queryText))
          if (items.length) groups.push({ name, items })
        })
        const groupNodes = groups.map(group => h('div', { key: 'search:' + group.name, className: 'dbs-tree-node' }, [
          h('div', { className: 'dbs-tree-group' }, t('meta.searchGroup', { db: group.name, n: group.items.length })),
          ...group.items.map(item => treeTableRow(group.name, item, item && item.type === 'view')),
        ]))
        if (searching) {
          body = h('div', { className: 'dbs-tree' },
            groupNodes,
            h('div', { className: 'dbs-tree-note' }, h(Spinner, null), t('meta.tablesLoading')))
        } else if (!groups.length) {
          body = h('div', { className: 'dbs-empty is-small' },
            h(Icon, { name: 'table', size: 22 }),
            h('div', { className: 'dbs-empty-title' }, t('meta.searchNone')))
        } else {
          body = h('div', { className: 'dbs-tree', role: 'tree' }, groupNodes)
        }
      } else {
        body = h('div', { className: 'dbs-tree', role: 'tree' }, entries.map(entry => {
          const name = databaseName(entry)
          const open = Boolean(expanded[name])
          const node = cache[name]
          const rows = [h('button', {
            key: 'db:' + name,
            type: 'button',
            role: 'treeitem',
            className: 'dbs-tree-row dbs-tree-db' + (open ? ' is-open' : ''),
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => toggleDatabase(name),
          },
          h('span', { className: 'dbs-chevron' + (open ? ' is-open' : '') }, h(Icon, { name: 'chevron', size: 12 })),
          h(Icon, { name: 'database', size: 13 }),
          h('span', { className: 'dbs-tree-label' }, name))]

          if (open) {
            if (!node || node.loading) {
              rows.push(h('div', { key: 'loading:' + name, className: 'dbs-tree-note' },
                h(Spinner, null), t('meta.tablesLoading')))
            } else if (node.error) {
              rows.push(h('div', { key: 'error:' + name, className: 'dbs-tree-error' },
                h(ErrorBar, { error: node.error, compact: true, label: t('meta.tablesError') })))
            } else {
              const tables = (node.tables || []).filter(item => item && item.type !== 'view')
              const views = (node.tables || []).filter(item => item && item.type === 'view')
              if (!tables.length && !views.length) {
                rows.push(h('div', { key: 'empty:' + name, className: 'dbs-tree-note' }, t('meta.emptyDatabase')))
              }
              if (tables.length) {
                rows.push(h('div', { key: 'group:t:' + name, className: 'dbs-tree-group' },
                  t('meta.tableGroup', { n: tables.length })))
                tables.forEach(table => rows.push(treeTableRow(name, table, false)))
              }
              if (views.length) {
                rows.push(h('div', { key: 'group:v:' + name, className: 'dbs-tree-group' },
                  t('meta.viewGroup', { n: views.length })))
                views.forEach(table => rows.push(treeTableRow(name, table, true)))
              }
            }
          }
          return h('div', { key: 'node:' + name, className: 'dbs-tree-node' }, rows)
        }))
      }

      function treeTableRow(database, table, isView) {
        const selected = props.activeTable
          && props.activeTable.database === database
          && props.activeTable.table === table.name
        const estimated = table.estimatedRows !== undefined && table.estimatedRows !== null
          ? t('meta.rows', { n: formatNumber(table.estimatedRows) })
          : ''
        return h('button', {
          key: 'table:' + database + '.' + table.name,
          type: 'button',
          role: 'treeitem',
          className: 'dbs-tree-row dbs-tree-table' + (selected ? ' is-on' : ''),
          'aria-selected': selected ? 'true' : 'false',
          title: table.comment ? String(table.comment) : undefined,
          onClick: () => { if (props.onOpenTable) props.onOpenTable(database, String(table.name)) },
        },
        h(Icon, { name: isView ? 'view' : 'table', size: 12 }),
        h('span', { className: 'dbs-tree-label' }, String(table.name)),
        estimated ? h('span', { className: 'dbs-tree-sub' }, estimated) : null)
      }

      return h('div', { className: 'dbs-section dbs-tree-section' }, header, searchRow, body)
    }
