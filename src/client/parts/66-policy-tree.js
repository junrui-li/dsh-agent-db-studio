
    /**
     * 可复用脱敏策略树（契约 §3.8）：连接 → 库 → 表 → 字段，懒加载。
     * 入口 A（连接表单 AI 分析后）与入口 B（顶部导航「脱敏策略」）共用本组件与保存逻辑。
     */
    function MaskingPolicyTree(props) {
      const mysqlConnections = (props.connections || []).filter(connection => connection.kind !== 'redis')
      const initialId = props.initialConnectionId || (mysqlConnections[0] && mysqlConnections[0].id) || ''
      const [connectionId, setConnectionId] = useState(initialId)
      const [policyState, setPolicyState] = useState(() => {
        const next = {}
        mysqlConnections.forEach(connection => {
          next[connection.id] = maskingPolicyMapFromConnection(
            connection,
            connection.id === initialId ? props.presets : null,
          )
        })
        return next
      })
      const [dbState, setDbState] = useState({})
      const [tableState, setTableState] = useState({})
      const [columnState, setColumnState] = useState({})
      const [expanded, setExpanded] = useState(() => (initialId ? { ['conn:' + initialId]: true } : {}))
      const [search, setSearch] = useState('')
      const [appliedSearch, setAppliedSearch] = useState('')
      const [onlyMasked, setOnlyMasked] = useState(false)
      const [filterState, setFilterState] = useState({ loading: false, error: null, data: null })
      const [filterEpoch, setFilterEpoch] = useState(0)
      const filterSeqRef = useRef(0)
      const [saving, setSaving] = useState(false)
      const [saveError, setSaveError] = useState(null)
      const loadedRef = useRef({})
      // 第 47 轮：AI 分析提示条可手动关闭；新一轮分析结果（引用变化）自动重新显示
      const [aiNoticeDismissed, setAiNoticeDismissed] = useState(false)
      const lastAiNoticeRef = useRef(props.aiNotice || null)
      useEffect(() => {
        if (lastAiNoticeRef.current !== (props.aiNotice || null)) {
          lastAiNoticeRef.current = props.aiNotice || null
          setAiNoticeDismissed(false)
        }
      }, [props.aiNotice])

      const ensureDatabases = useCallback(connId => {
        if (!connId) return
        const guard = 'db:' + connId
        if (loadedRef.current[guard]) return
        loadedRef.current[guard] = 'loading'
        setDbState(previous => Object.assign({}, previous, {
          [connId]: { loading: true, ready: false, list: [], error: null },
        }))
        api.databases(connId).then(data => {
          loadedRef.current[guard] = 'ready'
          setDbState(previous => Object.assign({}, previous, {
            [connId]: {
              loading: false,
              ready: true,
              list: data && Array.isArray(data.databases) ? data.databases : [],
              error: null,
            },
          }))
        }, error => {
          loadedRef.current[guard] = 'ready'
          setDbState(previous => Object.assign({}, previous, {
            [connId]: { loading: false, ready: true, list: [], error },
          }))
        })
      }, [])

      const ensureTables = useCallback((connId, database) => {
        if (!connId || !database) return
        const guard = 'tables:' + connId + '|' + database
        if (loadedRef.current[guard]) return
        loadedRef.current[guard] = 'loading'
        setTableState(previous => Object.assign({}, previous, {
          [connId + '|' + database]: { loading: true, ready: false, list: [], error: null },
        }))
        api.tables(connId, database).then(data => {
          loadedRef.current[guard] = 'ready'
          setTableState(previous => Object.assign({}, previous, {
            [connId + '|' + database]: {
              loading: false,
              ready: true,
              list: data && Array.isArray(data.tables) ? data.tables : [],
              error: null,
            },
          }))
        }, error => {
          loadedRef.current[guard] = 'ready'
          setTableState(previous => Object.assign({}, previous, {
            [connId + '|' + database]: { loading: false, ready: true, list: [], error },
          }))
        })
      }, [])

      const ensureColumns = useCallback((connId, database, table) => {
        if (!connId || !database || !table) return
        const guard = 'columns:' + connId + '|' + database + '|' + table
        if (loadedRef.current[guard]) return
        loadedRef.current[guard] = 'loading'
        setColumnState(previous => Object.assign({}, previous, {
          [connId + '|' + database + '|' + table]: { loading: true, ready: false, list: [], error: null },
        }))
        api.table(connId, database, table, false).then(data => {
          loadedRef.current[guard] = 'ready'
          setColumnState(previous => Object.assign({}, previous, {
            [connId + '|' + database + '|' + table]: {
              loading: false,
              ready: true,
              list: maskingColumnList(data && data.columns),
              error: null,
            },
          }))
        }, error => {
          loadedRef.current[guard] = 'ready'
          setColumnState(previous => Object.assign({}, previous, {
            [connId + '|' + database + '|' + table]: { loading: false, ready: true, list: [], error },
          }))
        })
      }, [])

      useEffect(() => {
        if (!connectionId) return
        const key = 'conn:' + connectionId
        setExpanded(previous => (previous[key] !== undefined
          ? previous
          : Object.assign({}, previous, { [key]: true })))
        ensureDatabases(connectionId)
      }, [connectionId, ensureDatabases])

      // 搜索防抖 250ms；只在有筛选时走连接级 columns 查询
      useEffect(() => {
        const keyword = search.trim()
        if (!keyword) {
          setAppliedSearch('')
          return undefined
        }
        const timer = setTimeout(() => setAppliedSearch(keyword), 250)
        return () => clearTimeout(timer)
      }, [search])

      const filterMode = Boolean(search.trim()) || onlyMasked

      // 有筛选 = 连接级查询 → 扁平结果；与懒加载树的展开状态完全无关。
      // 清空筛选时不发请求，直接恢复懒加载树（expanded 状态全程未被筛选修改）。
      useEffect(() => {
        if (!filterMode || !connectionId) {
          setFilterState({ loading: false, error: null, data: null })
          return undefined
        }
        const keyword = appliedSearch.trim()
        if (search.trim() && keyword !== search.trim()) {
          setFilterState(previous => ({
            loading: true,
            error: null,
            data: previous.data || null,
          }))
          return undefined
        }
        const seq = filterSeqRef.current + 1
        filterSeqRef.current = seq
        setFilterState(previous => ({ loading: true, error: null, data: previous.data || null }))
        let active = true
        api.maskingColumns({
          connectionId,
          keyword: keyword || undefined,
          onlyMasked: onlyMasked ? 'true' : undefined,
          limit: 300,
        }).then(data => {
          if (!active || filterSeqRef.current !== seq) return
          setFilterState({
            loading: false,
            error: null,
            data: data || { columns: [], total: 0, truncated: false },
          })
        }, error => {
          if (!active || filterSeqRef.current !== seq) return
          setFilterState({ loading: false, error, data: null })
        })
        return () => { active = false }
      }, [connectionId, search, appliedSearch, onlyMasked, filterMode, filterEpoch])

      const retryDatabases = connId => {
        delete loadedRef.current['db:' + connId]
        ensureDatabases(connId)
      }
      const retryTables = (connId, database) => {
        delete loadedRef.current['tables:' + connId + '|' + database]
        ensureTables(connId, database)
      }
      const retryColumns = (connId, database, table) => {
        delete loadedRef.current['columns:' + connId + '|' + database + '|' + table]
        ensureColumns(connId, database, table)
      }

      const connection = mysqlConnections.find(item => item.id === connectionId) || null
      const connectionKey = 'conn:' + connectionId
      const policyMap = policyState[connectionId] || {}
      const policyOf = (table, column) => (
        policyMap[maskingPolicyKey(table, column)]
        || { type: MASKING_POLICY_NONE, mandatory: false, ai: false, reason: '' }
      )
      const setPolicy = (table, column, type) => {
        if (!connectionId) return
        const key = maskingPolicyKey(table, column)
        setPolicyState(previous => {
          const map = Object.assign({}, previous[connectionId] || {})
          const current = map[key] || { type: MASKING_POLICY_NONE, mandatory: false, ai: false }
          if (current.mandatory) return previous
          map[key] = Object.assign({}, current, { type })
          return Object.assign({}, previous, { [connectionId]: map })
        })
      }
      const toggleKey = key => setExpanded(previous => (
        Object.assign({}, previous, { [key]: !previous[key] })
      ))
      const isExpanded = (key, auto) => Boolean(expanded[key] || (auto && auto[key]))

      const needle = search.trim().toLowerCase()
      const filterActive = Boolean(needle) || onlyMasked
      const matchesField = (database, table, column) => {
        const entry = policyOf(table, column.name)
        if (onlyMasked && entry.type === MASKING_POLICY_NONE) return false
        if (!needle) return true
        return (database + '\u0000' + table + '\u0000' + column.name + '\u0000' + column.comment)
          .toLowerCase().indexOf(needle) >= 0
      }
      const autoExpand = {}
      let loadedFieldCount = 0
      if (filterActive) {
        Object.keys(columnState).forEach(stateKey => {
          const parts = stateKey.split('|')
          if (parts[0] !== connectionId) return
          const state = columnState[stateKey]
          if (!state || !state.ready) return
          loadedFieldCount += state.list.length
          if (state.list.some(column => matchesField(parts[1], parts[2], column))) {
            autoExpand['conn:' + connectionId] = true
            autoExpand['db:' + connectionId + '|' + parts[1]] = true
            autoExpand['table:' + stateKey] = true
          }
        })
      } else {
        Object.keys(columnState).forEach(stateKey => {
          if (stateKey.indexOf(connectionId + '|') !== 0) return
          const state = columnState[stateKey]
          if (state && state.ready) loadedFieldCount += state.list.length
        })
      }
      const maskedCount = Object.keys(policyMap).filter(key => (
        policyMap[key] && policyMap[key].type !== MASKING_POLICY_NONE
      )).length
      const keywords = (() => {
        if (props.keywords && props.keywords.length && connectionId === initialId) {
          return props.keywords.slice()
        }
        if (connection && connection.masking && Array.isArray(connection.masking.keywords)) {
          return connection.masking.keywords.slice()
        }
        return []
      })()

      const save = () => {
        if (!connectionId || saving) return
        const fields = []
        Object.keys(policyMap).forEach(key => {
          const entry = policyMap[key]
          if (!entry || entry.type === MASKING_POLICY_NONE) return
          // 未知 type 只做展示兜底，不回传（后端 type 白名单会 400）
          if (!MASKING_TYPE_KEYS[entry.type]) return
          const parts = key.split('\u0000')
          fields.push({ table: parts[0], column: parts[1], type: entry.type })
        })
        setSaving(true)
        setSaveError(null)
        const body = { connectionId, fields }
        // keywords 省略时后端沿用已存关键字（§3.8），空数组不传避免误清空
        if (keywords.length) body.keywords = keywords
        api.maskingPolicies(body).then(data => {
          setSaving(false)
          if (props.onSaved) props.onSaved(data && data.connection ? data.connection : null, connectionId)
          if (props.onClose) props.onClose()
        }, error => {
          setSaving(false)
          setSaveError(error)
        })
      }

      const renderPolicySelect = (table, column, entry, label) => {
        const mandatory = Boolean(entry.mandatory)
        return h('span', { className: 'dbs-policy-select' },
          h('select', {
            className: 'dbs-select',
            value: entry.type,
            disabled: mandatory,
            title: mandatory ? t('masking.lockTip') : undefined,
            'aria-label': t('masking.policy.aria', { name: label }),
            onChange: event => {
              if (mandatory) return
              setPolicy(table, column, event && event.target ? event.target.value : MASKING_POLICY_NONE)
            },
          }, (() => {
            const options = [MASKING_POLICY_NONE].concat(MASKING_MANDATORY_TYPES, ['generic'])
            // 未知 type（后端先上新类型）也要能显示原文，不能崩
            if (entry.type && options.indexOf(entry.type) < 0) options.push(entry.type)
            return options
          })().map(type => h('option', {
            key: 'policy:' + type,
            value: type,
          }, maskingPolicyLabel(type)))),
          mandatory
            ? h('span', { className: 'dbs-policy-lock', title: t('masking.lockTip') },
              h(Icon, { name: 'lock', size: 11 }))
            : null,
          entry.ai
            ? h('span', { className: 'dbs-policy-ai', title: t('masking.policy.aiTip') },
              t('masking.policy.ai'))
            : null)
      }

      const renderFields = (database, table) => {
        const stateKey = connectionId + '|' + database + '|' + table
        const state = columnState[stateKey]
        if (!state) return null
        if (state.loading) {
          return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.loading'))
        }
        if (state.error) {
          return h('div', { className: 'dbs-policy-pad' }, h(ErrorBar, {
            error: state.error,
            label: t('masking.policy.errorColumns'),
            onRetry: () => retryColumns(connectionId, database, table),
          }))
        }
        if (!state.list.length) {
          return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.emptyColumns'))
        }
        const rows = state.list.filter(column => !filterActive || matchesField(database, table, column))
        if (!rows.length) return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.noMatch'))
        return h('div', { className: 'dbs-policy-fields' }, rows.map(column => {
          const entry = policyOf(table, column.name)
          const mandatory = Boolean(entry.mandatory)
          return h('div', {
            key: 'field:' + stateKey + ':' + column.name,
            className: 'dbs-policy-row is-field' + (entry.type !== MASKING_POLICY_NONE ? ' is-masked' : '')
              + (mandatory ? ' is-mandatory' : ''),
          },
          h('span', { className: 'dbs-policy-field-name dbs-mono', title: column.name }, column.name),
          h('span', { className: 'dbs-policy-field-comment', title: column.comment || '' },
            column.comment || t('common.dash')),
          h('span', { className: 'dbs-policy-field-type dbs-muted' }, column.type || ''),
          renderPolicySelect(table, column.name, entry, column.name))
        }))
      }

      const renderTables = database => {
        const stateKey = connectionId + '|' + database
        const state = tableState[stateKey]
        if (!state) return null
        if (state.loading) return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.loading'))
        if (state.error) {
          return h('div', { className: 'dbs-policy-pad' }, h(ErrorBar, {
            error: state.error,
            label: t('masking.policy.errorTables'),
            onRetry: () => retryTables(connectionId, database),
          }))
        }
        if (!state.list.length) return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.emptyTables'))
        const rows = state.list.filter(entry => {
          if (!filterActive) return true
          const tableName = maskingEntryName(entry)
          if (!tableName) return false
          if (needle && (database + ' ' + tableName).toLowerCase().indexOf(needle) >= 0) return true
          const columnStateEntry = columnState[connectionId + '|' + database + '|' + tableName]
          if (columnStateEntry && columnStateEntry.ready) {
            return columnStateEntry.list.some(column => matchesField(database, tableName, column))
          }
          return false
        })
        if (!rows.length) return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.noMatch'))
        return h('div', null, rows.map(entry => {
          const tableName = maskingEntryName(entry)
          const tableKey = 'table:' + connectionId + '|' + database + '|' + tableName
          const open = isExpanded(tableKey, autoExpand)
          return h('div', { key: 'table-wrap:' + tableName, className: 'dbs-policy-group' },
            h('div', {
              className: 'dbs-policy-row is-table',
              style: { paddingLeft: '34px' },
            },
            h('button', {
              type: 'button',
              className: 'dbs-policy-toggle' + (open ? ' is-open' : ''),
              'aria-label': t('masking.policy.expandTable', { name: tableName }),
              onClick: () => {
                toggleKey(tableKey)
                if (!open) ensureColumns(connectionId, database, tableName)
              },
            }, h(Icon, { name: 'chevron', size: 12 })),
            h(Icon, { name: 'table', size: 13 }),
            h('span', { className: 'dbs-policy-name' }, tableName)),
            open ? h('div', { className: 'dbs-policy-children' }, renderFields(database, tableName)) : null)
        }))
      }

      const renderDatabases = () => {
        const state = dbState[connectionId]
        if (!state) return null
        if (state.loading) return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.loading'))
        if (state.error) {
          return h('div', { className: 'dbs-policy-pad' }, h(ErrorBar, {
            error: state.error,
            label: t('masking.policy.errorDatabases'),
            onRetry: () => retryDatabases(connectionId),
          }))
        }
        if (!state.list.length) return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.emptyDatabases'))
        const rows = state.list.filter(entry => {
          if (!filterActive) return true
          const database = maskingEntryName(entry)
          if (needle && database.toLowerCase().indexOf(needle) >= 0) return true
          const tableStateKey = connectionId + '|' + database
          const tableEntry = tableState[tableStateKey]
          if (tableEntry && tableEntry.ready) {
            return tableEntry.list.some(table => {
              const tableName = maskingEntryName(table)
              if (needle && (database + ' ' + tableName).toLowerCase().indexOf(needle) >= 0) return true
              const columns = columnState[connectionId + '|' + database + '|' + tableName]
              return Boolean(columns && columns.ready
                && columns.list.some(column => matchesField(database, tableName, column)))
            })
          }
          return false
        })
        if (!rows.length) return h('div', { className: 'dbs-policy-muted' }, t('masking.policy.noMatch'))
        return h('div', null, rows.map(entry => {
          const database = maskingEntryName(entry)
          const dbKey = 'db:' + connectionId + '|' + database
          const open = isExpanded(dbKey, autoExpand)
          return h('div', { key: 'db-wrap:' + database, className: 'dbs-policy-group' },
            h('div', {
              className: 'dbs-policy-row is-db',
              style: { paddingLeft: '18px' },
            },
            h('button', {
              type: 'button',
              className: 'dbs-policy-toggle' + (open ? ' is-open' : ''),
              'aria-label': t('masking.policy.expandDatabase', { name: database }),
              onClick: () => {
                toggleKey(dbKey)
                if (!open) ensureTables(connectionId, database)
              },
            }, h(Icon, { name: 'chevron', size: 12 })),
            h(Icon, { name: 'layers', size: 13 }),
            h('span', { className: 'dbs-policy-name' }, 'db' + database)),
            open ? h('div', { className: 'dbs-policy-children' }, renderTables(database)) : null)
        }))
      }

      const renderFilterResults = () => {
        if (filterState.loading) {
          return h('div', { className: 'dbs-policy-filter' },
            h('div', { className: 'dbs-policy-muted' }, t('masking.policy.filterLoading')))
        }
        if (filterState.error) {
          return h('div', { className: 'dbs-policy-filter dbs-policy-pad' }, h(ErrorBar, {
            error: filterState.error,
            label: t('masking.policy.filterError'),
            onRetry: () => setFilterEpoch(value => value + 1),
          }))
        }
        const data = filterState.data
        const columns = data && Array.isArray(data.columns) ? data.columns : []
        if (!columns.length) {
          return h('div', { className: 'dbs-policy-filter' },
            h('div', { className: 'dbs-policy-empty' }, t('masking.policy.filterEmpty')))
        }
        const groups = []
        const groupMap = {}
        columns.forEach(column => {
          const databaseName = column.database ? String(column.database) : t('masking.policy.residual')
          const tableName = column.table ? String(column.table) : ''
          if (!groupMap[databaseName]) {
            groupMap[databaseName] = { database: databaseName, tables: [], tableMap: {} }
            groups.push(groupMap[databaseName])
          }
          const group = groupMap[databaseName]
          if (!group.tableMap[tableName]) {
            group.tableMap[tableName] = { table: tableName, columns: [] }
            group.tables.push(group.tableMap[tableName])
          }
          group.tableMap[tableName].columns.push(column)
        })
        const renderFilterField = column => {
          const table = column.table ? String(column.table) : ''
          const columnName = column.column ? String(column.column) : ''
          const apiPolicy = column.policy && typeof column.policy === 'object' ? column.policy : null
          const storedRaw = policyMap[maskingPolicyKey(table, columnName)]
          // 草稿里显式的 none 优先于接口返回的旧策略（方便在筛选视图里移除策略）
          const entry = storedRaw || (apiPolicy
            ? {
              type: maskingTypeOf(apiPolicy.type),
              mandatory: Boolean(apiPolicy.mandatory)
                || MASKING_MANDATORY_TYPES.indexOf(apiPolicy.type) >= 0,
              reason: safeText(apiPolicy.reason),
              ai: false,
            }
            : policyOf(table, columnName))
          const residual = column.inSchema === false
          return h('div', {
            key: 'filter-field:' + column.database + ':' + table + ':' + columnName,
            className: 'dbs-policy-row is-field' + (entry.type !== MASKING_POLICY_NONE ? ' is-masked' : '')
              + (Boolean(entry.mandatory) ? ' is-mandatory' : '')
              + (residual ? ' is-residual' : ''),
          },
          h('span', { className: 'dbs-policy-field-name dbs-mono', title: columnName }, columnName),
          h('span', { className: 'dbs-policy-field-comment', title: column.comment || '' },
            column.comment || t('common.dash')),
          h('span', { className: 'dbs-policy-field-type dbs-muted' },
            column.dataType ? String(column.dataType) : ''),
          residual
            ? h('span', { className: 'dbs-policy-residual', title: t('masking.policy.residualTip') },
              t('masking.policy.residual'))
            : null,
          renderPolicySelect(table, columnName, entry, columnName))
        }
        return h('div', { className: 'dbs-policy-filter' },
          h('div', { className: 'dbs-policy-filter-total dbs-muted' }, t('masking.policy.filterTotal', {
            n: formatNumber(data.total !== undefined && data.total !== null ? data.total : columns.length),
            truncated: data.truncated
              ? ' ' + t('masking.policy.truncated', { n: formatNumber(columns.length) })
              : '',
          })),
          groups.map(group => h('div', {
            key: 'filter-db:' + group.database,
            className: 'dbs-policy-filter-group',
          },
          h('div', { className: 'dbs-policy-row is-db' },
            h(Icon, { name: 'layers', size: 13 }),
            h('span', { className: 'dbs-policy-name' }, group.database),
            h('span', { className: 'dbs-muted' },
              String(group.tables.reduce((sum, tableGroup) => sum + tableGroup.columns.length, 0)))),
          group.tables.map(tableGroup => h('div', {
            key: 'filter-table:' + group.database + ':' + tableGroup.table,
            className: 'dbs-policy-filter-table',
          },
          h('div', { className: 'dbs-policy-row is-table', style: { paddingLeft: '18px' } },
            h(Icon, { name: 'table', size: 13 }),
            h('span', { className: 'dbs-policy-name' }, tableGroup.table || '—')),
          tableGroup.columns.map(renderFilterField))))))
      }

      if (!mysqlConnections.length) {
        const emptyPanel = h('div', { className: 'dbs-policy' },
          props.inline ? null : h('div', { className: 'dbs-policy-head' },
            h(Icon, { name: 'shield', size: 16 }),
            h('div', { className: 'dbs-policy-title' }, t('masking.policy.title')),
            h('span', { className: 'dbs-grow' }),
            h('button', {
              type: 'button', className: 'dbs-iconbtn', title: t('masking.policy.close'),
              'aria-label': t('masking.policy.closeTree'), onClick: props.onClose,
            }, h(Icon, { name: 'x', size: 14 }))),
          h('div', { className: 'dbs-empty is-small' },
            h(Icon, { name: 'shield', size: 26 }),
            h('div', { className: 'dbs-empty-title' }, t('masking.policy.noMysql')),
            h('p', { className: 'dbs-empty-text' }, t('masking.policy.noMysqlHint'))))
        // inline：策略页原位展开，跳过弹窗遮罩外壳
        return props.inline
          ? h('div', { className: 'dbs-policy-inline' }, emptyPanel)
          : h('div', { className: 'dbs-policy-mask' }, emptyPanel)
      }

      // inline：策略页直出，页面已有「脱敏策略」标题，头部不重复渲染（弹窗入口保留）
      const panelHead = props.inline ? null : h('div', { className: 'dbs-policy-head' },
            h(Icon, { name: 'shield', size: 16 }),
            h('div', { className: 'dbs-policy-title' }, t('masking.policy.title')),
            connection
              ? h('span', { className: 'dbs-policy-conn-title' }, String(connection.name || connection.id))
              : null,
            connectionMaskingEnabled(connection)
              ? h('span', { className: 'dbs-mask-badge' }, t('masking.badge'))
              : null,
            h('span', { className: 'dbs-grow' }),
            h('button', {
              type: 'button', className: 'dbs-iconbtn', title: t('masking.policy.close'),
              'aria-label': t('masking.policy.closeTree'), onClick: props.onClose,
            }, h(Icon, { name: 'x', size: 14 })))
      const panel = h('div', { className: 'dbs-policy' },
          panelHead,
          props.aiNotice && !aiNoticeDismissed
            ? h('div', { className: 'dbs-policy-ai-notice' },
              props.aiNotice.model
                ? h('span', null, t('masking.aiModel', { model: props.aiNotice.model }))
                : props.aiNotice.error
                  ? h('span', {
                    className: 'dbs-ai-error',
                    title: maskingErrorNotice(props.aiNotice.error).full,
                  }, t('masking.aiFallbackReason', {
                    reason: maskingErrorNotice(props.aiNotice.error).preview,
                  }))
                  : h('span', null, t('masking.fallbackRule')),
              h(NoticeClose, { onClose: () => setAiNoticeDismissed(true) }))
            : null,
          h('div', { className: 'dbs-policy-layout' },
            h('aside', { className: 'dbs-policy-conns' },
              h('div', { className: 'dbs-section-title' }, t('masking.policy.connections')),
              mysqlConnections.map(item => h('button', {
                key: 'conn:' + item.id,
                type: 'button',
                className: 'dbs-policy-conn' + (item.id === connectionId ? ' is-on' : ''),
                onClick: () => {
                  setConnectionId(item.id)
                  // 策略页直出时记住选中的连接，切走再切回来不重置
                  if (props.onConnectionChange) props.onConnectionChange(item.id)
                },
              },
              h(Icon, { name: 'database', size: 13 }),
              h('span', { className: 'dbs-policy-conn-name' }, String(item.name || item.id)),
              connectionMaskingEnabled(item)
                ? h('span', { className: 'dbs-mask-badge' }, t('masking.badge'))
                : null))),
            h('div', { className: 'dbs-policy-main' },
              h('div', { className: 'dbs-policy-toolbar' },
                h('input', {
                  className: 'dbs-input dbs-policy-search',
                  name: 'policySearch',
                  value: search,
                  placeholder: t('masking.policy.search'),
                  'aria-label': t('masking.policy.search'),
                  onChange: event => setSearch(event && event.target ? event.target.value : ''),
                }),
                h('label', { className: 'dbs-check dbs-policy-only' },
                  h('input', {
                    type: 'checkbox', name: 'policyOnlyMasked', checked: onlyMasked,
                    onChange: event => setOnlyMasked(Boolean(event && event.target && event.target.checked)),
                  }),
                  h('span', null, t('masking.policy.onlyMasked'))),
                h('span', { className: 'dbs-grow' }),
                h('span', { className: 'dbs-muted' }, t('masking.policy.count', {
                  masked: formatNumber(maskedCount),
                  loaded: formatNumber(loadedFieldCount),
                })),
                keywords.length
                  ? h('span', { className: 'dbs-muted' }, t('masking.policy.keywords', {
                    keywords: keywords.join('、'),
                  }))
                  : null),
              h('div', { className: 'dbs-policy-builtin' },
                h('span', { className: 'dbs-policy-builtin-title' },
                  t('masking.policy.builtin', { n: MASKING_MANDATORY_TYPES.length })),
                MASKING_MANDATORY_TYPES.map(type => h('span', {
                  key: 'builtin:' + type,
                  className: 'dbs-policy-builtin-chip',
                  title: t('masking.lockTip'),
                }, h(Icon, { name: 'lock', size: 9 }), maskingTypeLabel(type)))),
              saveError
                ? h('div', { className: 'dbs-policy-pad' }, h(ErrorBar, {
                  error: saveError,
                  label: t('masking.policy.saveFail'),
                  onRetry: save,
                }))
                : null,
              filterMode ? renderFilterResults() : h('div', { className: 'dbs-policy-tree' },
                h('div', { className: 'dbs-policy-row is-conn' },
                  h('button', {
                    type: 'button',
                    className: 'dbs-policy-toggle' + (isExpanded(connectionKey, autoExpand) ? ' is-open' : ''),
                    'aria-label': t('masking.policy.expandConnection'),
                    onClick: () => toggleKey(connectionKey),
                  }, h(Icon, { name: 'chevron', size: 12 })),
                  h(Icon, { name: 'database', size: 13 }),
                  h('span', { className: 'dbs-policy-name' },
                    connection ? String(connection.name || connection.id) : ''),
                  h('span', { className: 'dbs-muted dbs-policy-conn-state' },
                    connectionMaskingEnabled(connection)
                      ? t('masking.policy.enabled')
                      : t('masking.policy.disabled'))),
                isExpanded(connectionKey, autoExpand) ? h('div', { className: 'dbs-policy-children' }, renderDatabases()) : null),
              h('div', { className: 'dbs-policy-foot' },
                props.inline ? null : h('button', {
                  type: 'button', className: 'dbs-btn is-small',
                  onClick: props.onClose,
                }, t('masking.policy.close')),
                h('span', { className: 'dbs-grow' }),
                h('button', {
                  type: 'button', className: 'dbs-btn is-primary is-small', disabled: saving,
                  onClick: save,
                }, saving ? t('masking.policy.saving') : t('masking.policy.save'))))))

      // inline：策略页原位展开（无遮罩外壳，宽度撑满容器）；弹窗入口保持原遮罩外壳
      return props.inline
        ? h('div', { className: 'dbs-policy-inline' }, panel)
        : h('div', { className: 'dbs-policy-mask' }, panel)
    }

    /** 连接表单里的脱敏开关 / 关键字 / AI 分析入口；策略本身在 MaskingPolicyTree 里维护。 */
    /** 把 AI/规则候选合并回草稿 fields：不覆盖已存在的人工策略；mandatory 以候选为准补齐。 */
    function mergeAiCandidatesIntoFields(baseFields, candidates) {
      const normalizedExisting = Array.isArray(baseFields) ? baseFields.map(field => ({
        table: safeText(field.table),
        column: safeText(field.column),
        type: maskingTypeOf(field.type),
        mandatory: Boolean(field.mandatory),
        reason: safeText(field.reason),
      })).filter(field => field.table && field.column) : []
      const existingMap = {}
      normalizedExisting.forEach(field => {
        existingMap[field.table + '\u0000' + field.column] = field
      })
      const stats = {}
      let added = 0
      let kept = 0
      ;(candidates || []).forEach(candidate => {
        if (!candidate || !candidate.table || !candidate.column) return
        const key = candidate.table + '\u0000' + candidate.column
        const type = maskingTypeOf(candidate.type)
        const existing = existingMap[key]
        stats[type] = (stats[type] || 0) + 1
        if (existing) {
          kept += 1
          const mandatory = Boolean(existing.mandatory) || Boolean(candidate.mandatory)
            || MASKING_MANDATORY_TYPES.indexOf(existing.type) >= 0
          existingMap[key] = Object.assign({}, existing, { mandatory })
          return
        }
        added += 1
        existingMap[key] = {
          table: safeText(candidate.table),
          column: safeText(candidate.column),
          type,
          mandatory: Boolean(candidate.mandatory) || MASKING_MANDATORY_TYPES.indexOf(type) >= 0,
          reason: safeText(candidate.reason),
        }
      })
      const fields = Object.keys(existingMap).map(key => existingMap[key])
      return { fields, stats, added, kept }
    }
