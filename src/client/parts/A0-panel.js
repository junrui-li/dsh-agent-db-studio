
    // ======================================================================
    // 12. 空态 / 根面板
    // ======================================================================

    // ---- SQL 文件句柄持久层（第 49 轮）----
    // FileSystemFileHandle 只能存在内存 ref：退出插件后丢失，重新进来无法写回原文件
    // （退化为另存/下载）。Chromium 支持把句柄结构化克隆进 IndexedDB——跨会话恢复句柄，
    // 保存时 queryPermission/requestPermission（按钮点击手势内）直接写回原文件；
    // 不支持的环境（老内核/隐私模式/Node 测试）全部静默回退到原「另存/下载」链路。
    const FILE_HANDLE_DB = 'dsh-db-studio-files'
    const FILE_HANDLE_STORE = 'sql-file-handles'
    function openFileHandleDb() {
      return new Promise(resolve => {
        if (typeof indexedDB === 'undefined' || !indexedDB || typeof indexedDB.open !== 'function') {
          resolve(null)
          return
        }
        let request
        try {
          request = indexedDB.open(FILE_HANDLE_DB, 1)
        } catch (error) {
          resolve(null)
          return
        }
        request.onupgradeneeded = () => {
          const db = request.result
          if (!db.objectStoreNames.contains(FILE_HANDLE_STORE)) db.createObjectStore(FILE_HANDLE_STORE)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => resolve(null)
        request.onblocked = () => resolve(null)
      })
    }
    const storeFileHandle = (tabId, handle) => openFileHandleDb().then(db => new Promise(resolve => {
      if (!db) {
        resolve()
        return
      }
      let tx
      try {
        tx = db.transaction(FILE_HANDLE_STORE, 'readwrite')
        tx.objectStore(FILE_HANDLE_STORE).put(handle, tabId)
        tx.oncomplete = () => { try { db.close() } catch (error) { /* ignore */ } resolve() }
        tx.onerror = () => { try { db.close() } catch (error) { /* ignore */ } resolve() }
        tx.onabort = () => { try { db.close() } catch (error) { /* ignore */ } resolve() }
      } catch (error) {
        try { db.close() } catch (ignore) { /* ignore */ }
        resolve()
      }
    }))
    const deleteStoredFileHandle = tabId => openFileHandleDb().then(db => new Promise(resolve => {
      if (!db) {
        resolve()
        return
      }
      let tx
      try {
        tx = db.transaction(FILE_HANDLE_STORE, 'readwrite')
        tx.objectStore(FILE_HANDLE_STORE).delete(tabId)
        tx.oncomplete = () => { try { db.close() } catch (error) { /* ignore */ } resolve() }
        tx.onerror = () => { try { db.close() } catch (error) { /* ignore */ } resolve() }
        tx.onabort = () => { try { db.close() } catch (error) { /* ignore */ } resolve() }
      } catch (error) {
        try { db.close() } catch (ignore) { /* ignore */ }
        resolve()
      }
    }))
    const loadAllFileHandles = () => openFileHandleDb().then(db => new Promise(resolve => {
      const map = {}
      if (!db) {
        resolve(map)
        return
      }
      let tx
      try {
        tx = db.transaction(FILE_HANDLE_STORE, 'readonly')
        const cursorRequest = tx.objectStore(FILE_HANDLE_STORE).openCursor()
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result
          if (cursor) {
            map[String(cursor.key)] = cursor.value
            cursor.continue()
          } else {
            try { db.close() } catch (error) { /* ignore */ }
            resolve(map)
          }
        }
        cursorRequest.onerror = () => { try { db.close() } catch (error) { /* ignore */ } resolve(map) }
      } catch (error) {
        try { db.close() } catch (ignore) { /* ignore */ }
        resolve(map)
      }
    }))

    function WelcomeEmpty(props) {
      const health = props.health || {}
      const settings = (health.data && health.data.settings) || {}
      const backend = (health.data && health.data.backend) || null
      const pluginStatus = health.loading
        ? t('common.loading')
        : (health.error
          ? t('app.healthErrorTitle')
          : (backend && backend.ready ? t('app.backendReady') : t('app.backendDown')))
      const statusRows = [
        [t('app.plugin'), pluginStatus],
        [t('app.backend'), backend ? (backend.ready ? t('app.backendReady') : t('app.backendDown')) : t('common.dash')],
        [t('connection.title'), formatNumber(props.connectionCount || 0)],
        [t('app.writesOn') + ' / ' + t('app.writesOff'), settings.allowWrites ? t('app.writesOn') : t('app.writesOff')],
        [t('app.maxRowsLabel'), settings.maxRows
          ? formatNumber(settings.maxRows) + (settings.timeout ? ' · ' + settings.timeout + 's' : '')
          : t('common.dash')],
      ]
      return h('div', { className: 'dbs-empty' },
        h(Icon, { name: 'database', size: 30 }),
        h('div', { className: 'dbs-empty-title' }, t('connection.emptyTitle')),
        h('p', { className: 'dbs-empty-text' }, t('connection.emptyBody')),
        h('p', { className: 'dbs-empty-hint' }, t('connection.emptyHint')),
        h('div', { className: 'dbs-empty-actions' },
          h('button', { type: 'button', className: 'dbs-btn is-primary', onClick: props.onRefresh },
            h(Icon, { name: 'refresh', size: 13 }), t('common.refresh')),
          props.onManage
            ? h('button', { type: 'button', className: 'dbs-btn', onClick: props.onManage },
              h(Icon, { name: 'plus', size: 13 }), t('connmgr.newShort'))
            : null),
        h('div', { className: 'dbs-statuscard' }, statusRows.map((row, index) => h('div', {
          key: 'status:' + index,
          className: 'dbs-statusrow',
        },
        h('span', { className: 'dbs-muted' }, row[0]),
        h('span', null, row[1])))),
        health.error || (backend && !backend.ready)
          ? h('div', { className: 'dbs-guide-wide' },
            health.error
              ? h(ErrorBar, { error: health.error })
              : h(ErrorBar, { error: new Error(backend.error || t('app.backendDownTitle')) }))
          : null)
    }

    function Panel(props) {
      const settings = props || {}
      const mode = settings.mode === 'sidebar' ? 'sidebar' : 'main'
      const shell = settings.shell || null
      // 窄布局 / 连接与元数据显隐；rootRef 必须挂到最外层 .dbs-root 上
      const layout = usePanelLayout(mode)
      const openInSidebar = shell && typeof shell.openInSidebar === 'function' ? shell.openInSidebar : null
      const openInMain = shell && typeof shell.openInMain === 'function' ? shell.openInMain : null
      const health = useAsync(signal => api.health(signal), [])
      const connectionsState = useAsync(signal => api.connections(signal), [])
      // 工作区缓存（localStorage）：连接 tab / 激活 tab / 每连接选中的库 / 查询页（含 SQL 草稿）
      const [storedWorkspace] = useState(readStoredQueryTabs)
      const [openTabs, setOpenTabs] = useState(storedWorkspace.connTabs)
      const [activeTabId, setActiveTabId] = useState(storedWorkspace.activeConnTabId)
      const [tabState, setTabState] = useState(() => {
        const next = {}
        Object.keys(storedWorkspace.dbByConn).forEach(id => {
          next[id] = { database: storedWorkspace.dbByConn[id] || '', tableTarget: null, seed: null }
        })
        return next
      })
      const [queryTabs, setQueryTabs] = useState(storedWorkspace.queryTabs)
      const [tabDatabases, setTabDatabases] = useState({})
      const [databasesEpoch, setDatabasesEpoch] = useState(0)
      const [treeEpoch, setTreeEpoch] = useState(0)
      const [connectionDialog, setConnectionDialog] = useState({ open: false, editing: null })
      const [view, setView] = useState('workspace')
      // 跨视图导航（第 27 轮）：历史 ↔ 工单双向跳转（工单详情 ↔ 它的执行历史）
      const [ticketFocus, setTicketFocus] = useState(null)       // {id}
      const [historyFilterSeed, setHistoryFilterSeed] = useState(null)  // {keyword}
      const [policyDialog, setPolicyDialog] = useState({
        open: false, connectionId: '', presets: null, keywords: null, aiNotice: null,
      })
      // 脱敏策略页：策略树直出，连接切换在树内「数据连接」侧栏；记录上次选中的连接（弹窗入口仅剩工作区 AI 分析等其它路径）
      const [policyConnectionId, setPolicyConnectionId] = useState('')
      const [policyRefresh, setPolicyRefresh] = useState(null)
      const autoOpenedRef = useRef(false)
      const pendingSelectRef = useRef(null)
      // ---- 查询页（工作区多 tab）----
      // SQL 草稿运行时真值：'connId|queryTabId' -> text。不放 React state，
      // 键击只写 ref + 防抖落盘，不触发整树重渲染。
      const querySqlRef = useRef(null)
      if (!querySqlRef.current) {
        const seeded = {}
        Object.keys(storedWorkspace.queryTabs).forEach(connId => {
          storedWorkspace.queryTabs[connId].list.forEach(item => {
            seeded[connId + '|' + item.id] = item.sql || ''
          })
        })
        querySqlRef.current = seeded
      }
      // FileSystemFileHandle（仅会话内）：Ctrl+S 静默覆盖原文件；重挂载后句柄丢失会走另存为
      const fileHandlesRef = useRef({})
      const queryTabsRef = useRef(queryTabs)
      queryTabsRef.current = queryTabs
      const openTabsRef = useRef(openTabs)
      openTabsRef.current = openTabs
      const activeTabIdRef = useRef(activeTabId)
      activeTabIdRef.current = activeTabId
      const tabStateRef = useRef(tabState)
      tabStateRef.current = tabState
      const saveTimerRef = useRef(null)
      const fileInputRef = useRef(null)
      const pendingFileConnRef = useRef('')
      const [queryNotice, setQueryNotice] = useState({})
      // 顶部导航里的待审批徽标（操作后再刷新，不做定时轮询）
      const ticketsSummary = useAsync(signal => api.tickets({ limit: 1 }, signal), [])
      const pendingTicketCount = (() => {
        const counts = ticketsSummary.data && ticketsSummary.data.counts
        const value = counts ? counts.pending : undefined
        return typeof value === 'number' ? value : null
      })()

      const connectionList = (connectionsState.data && Array.isArray(connectionsState.data.connections))
        ? connectionsState.data.connections
        : []
      const connectionById = useCallback(id => (
        connectionList.find(connection => connection.id === id) || null
      ), [connectionList])

      const openConnectionTab = useCallback(id => {
        if (!id) return
        setOpenTabs(previous => (previous.indexOf(id) >= 0 ? previous : previous.concat([id])))
        setActiveTabId(id)
      }, [])

      const updateTabState = useCallback((id, patch) => {
        if (!id) return
        setTabState(previous => {
          const current = previous[id] || { database: '', tableTarget: null, seed: null }
          return Object.assign({}, previous, {
            [id]: Object.assign({}, current, typeof patch === 'function' ? patch(current) : patch),
          })
        })
      }, [])

      const closeConnectionTab = useCallback(id => {
        const index = openTabs.indexOf(id)
        const nextTabs = openTabs.filter(tabId => tabId !== id)
        setOpenTabs(nextTabs)
        setTabState(previous => {
          const next = Object.assign({}, previous)
          delete next[id]
          return next
        })
        // 查询页草稿一并清掉（ref 键前缀 = connId + '|'）
        setQueryTabs(previous => {
          if (!(id in previous)) return previous
          const next = Object.assign({}, previous)
          delete next[id]
          return next
        })
        Object.keys(querySqlRef.current).forEach(key => {
          if (key.indexOf(id + '|') === 0) delete querySqlRef.current[key]
        })
        if (activeTabId === id) setActiveTabId(nextTabs[Math.min(index, nextTabs.length - 1)] || null)
      }, [openTabs, activeTabId])

      // ---- 查询页持久化 ----
      const persistQueryTabs = useCallback(() => {
        const connTabs = openTabsRef.current
        const tabs = {}
        const dbByConn = {}
        const states = queryTabsRef.current
        connTabs.forEach(connId => {
          const entry = states[connId]
          if (!entry || !Array.isArray(entry.list) || !entry.list.length) return
          tabs[connId] = {
            activeId: entry.activeId,
            list: entry.list.map(item => ({
              id: item.id,
              name: item.name,
              origin: item.origin,
              fileName: item.fileName || '',
              sql: String(querySqlRef.current[connId + '|' + item.id] || ''),
            })),
          }
          const db = tabStateRef.current[connId]
          dbByConn[connId] = db && db.database ? db.database : ''
        })
        writeStoredQueryTabs({
          connTabs,
          activeConnTabId: activeTabIdRef.current,
          dbByConn,
          queryTabs: tabs,
        })
      }, [])
      const schedulePersistQueryTabs = useCallback(() => {
        if (saveTimerRef.current && typeof clearTimeout === 'function') clearTimeout(saveTimerRef.current)
        if (typeof setTimeout !== 'function') {
          persistQueryTabs()
          return
        }
        saveTimerRef.current = setTimeout(persistQueryTabs, 250)
      }, [persistQueryTabs])
      // 元数据类变化（开合 tab / 切换 / 选库）立即落盘；SQL 键击走防抖
      useEffect(() => { persistQueryTabs() }, [openTabs, activeTabId, tabState, queryTabs, persistQueryTabs])

      // 第 49 轮：面板打开时从 IndexedDB 恢复跨会话的 SQL 文件句柄（tabId 持久化不变），
      // 「存文件」按钮即可写回原文件而非退化为另存/下载
      useEffect(() => {
        loadAllFileHandles().then(map => {
          Object.keys(map || {}).forEach(tabId => {
            fileHandlesRef.current[tabId] = map[tabId]
          })
        })
      }, [])

      const handleQuerySqlChange = useCallback((connId, tabId, value) => {
        querySqlRef.current[connId + '|' + tabId] = String(value || '')
        schedulePersistQueryTabs()
      }, [schedulePersistQueryTabs])

      const genQueryTabId = () => 'qt-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)

      // 每个打开的 SQL 连接 tab 保证至少有一个查询页
      useEffect(() => {
        openTabs.forEach(connId => {
          const connection = connectionById(connId)
          if (!connection || connection.kind === 'redis') return
          const entry = queryTabs[connId]
          if (entry && entry.list.length) return
          const id = genQueryTabId()
          querySqlRef.current[connId + '|' + id] = ''
          setQueryTabs(previous => {
            const current = previous[connId]
            if (current && current.list.length) return previous
            return Object.assign({}, previous, {
              [connId]: {
                activeId: id,
                list: [{ id, name: t('sql.queryTab.newName', { n: 1 }), origin: 'temp', fileName: '' }],
              },
            })
          })
        })
      }, [openTabs, queryTabs, connectionById])

      const newQueryTab = useCallback(connId => {
        setQueryTabs(previous => {
          const entry = previous[connId] || { activeId: '', list: [] }
          const names = {}
          entry.list.forEach(item => { names[item.name] = true })
          let n = 1
          while (names[t('sql.queryTab.newName', { n })]) n += 1
          const id = genQueryTabId()
          querySqlRef.current[connId + '|' + id] = ''
          return Object.assign({}, previous, {
            [connId]: {
              activeId: id,
              list: entry.list.concat([{
                id, name: t('sql.queryTab.newName', { n }), origin: 'temp', fileName: '',
              }]),
            },
          })
        })
      }, [])

      const selectQueryTab = useCallback((connId, tabId) => {
        setQueryTabs(previous => {
          const entry = previous[connId]
          if (!entry || entry.activeId === tabId) return previous
          return Object.assign({}, previous, {
            [connId]: Object.assign({}, entry, { activeId: tabId }),
          })
        })
      }, [])

      const closeQueryTab = useCallback((connId, tabId) => {
        setQueryTabs(previous => {
          const entry = previous[connId]
          if (!entry) return previous
          const index = entry.list.findIndex(item => item.id === tabId)
          if (index < 0) return previous
          delete querySqlRef.current[connId + '|' + tabId]
          delete fileHandlesRef.current[tabId]
          deleteStoredFileHandle(tabId)   // 关页签同步清理持久化句柄（第 49 轮）
          const remaining = entry.list.filter(item => item.id !== tabId)
          if (!remaining.length) {
            // 关掉最后一个查询页：自动补一个全新的，编辑器永远可用
            const id = genQueryTabId()
            querySqlRef.current[connId + '|' + id] = ''
            return Object.assign({}, previous, {
              [connId]: {
                activeId: id,
                list: [{ id, name: t('sql.queryTab.newName', { n: 1 }), origin: 'temp', fileName: '' }],
              },
            })
          }
          const activeId = entry.activeId === tabId
            ? remaining[Math.min(index, remaining.length - 1)].id
            : entry.activeId
          return Object.assign({}, previous, { [connId]: { activeId, list: remaining } })
        })
      }, [])

      // ---- 打开本地 SQL 文件 / Ctrl+S 保存 ----
      // 读文件文本：File.text()（新内核 / 测试假文件）优先，FileReader 兜底（老内核全环境可用）
      const readLocalText = file => new Promise((resolve, reject) => {
        if (typeof file.text === 'function') {
          Promise.resolve(file.text()).then(resolve, reject)
          return
        }
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(new Error('FileReader failed'))
        reader.readAsText(file)
      })

      // 选定文件入工作区：每个文件一个查询页，激活最后一个；
      // 带句柄的登记进 fileHandlesRef——Ctrl+S 时按原路径直存不弹另存框（第 36 轮）
      const adoptSqlFiles = useCallback((connId, results) => {
        setQueryTabs(previous => {
          const entry = previous[connId] || { activeId: '', list: [] }
          const created = results.map(result => {
            const id = genQueryTabId()
            querySqlRef.current[connId + '|' + id] = result.text
            if (result.handle) {
              fileHandlesRef.current[id] = result.handle
              storeFileHandle(id, result.handle)   // 跨会话恢复写回原文件（第 49 轮）
            }
            return { id, name: result.name, origin: 'file', fileName: result.name }
          })
          return Object.assign({}, previous, {
            [connId]: {
              activeId: created[created.length - 1].id,
              list: entry.list.concat(created),
            },
          })
        })
      }, [])

      const openSqlFilePicker = useCallback(connId => {
        // 优先 File System Access API：拿到可写句柄，Ctrl+S 原路径直存（第 36 轮）；
        // 不可用（老内核 / Node 测试环境）或 API 抛错时回退 input[type=file]（只读，保存退回另存为）
        if (typeof showOpenFilePicker === 'function') {
          Promise.resolve(showOpenFilePicker({
            multiple: true,
            types: [{ description: 'SQL', accept: { 'text/sql': ['.sql'], 'text/plain': ['.txt'] } }],
          })).then(handles => {
            if (!handles || !handles.length) return
            Promise.all(handles.map(handle =>
              Promise.resolve(handle.getFile()).then(file =>
                readLocalText(file).then(text => ({
                  name: String(file.name || handle.name || ''),
                  text: String(text || ''),
                  handle,
                }))
              )
            )).then(results => adoptSqlFiles(connId, results), () => {
              setQueryNotice(previous => Object.assign({}, previous, {
                [connId]: t('sql.queryTab.openFailed'),
              }))
            })
          }, error => {
            // 用户取消：静默；API 抛错（webview 权限等）：回退 input 选文件
            if (error && error.name === 'AbortError') return
            pendingFileConnRef.current = connId
            const input = fileInputRef.current
            if (input && typeof input.click === 'function') input.click()
          })
          return
        }
        pendingFileConnRef.current = connId
        const input = fileInputRef.current
        if (input && typeof input.click === 'function') input.click()
      }, [adoptSqlFiles])

      const handleSqlFileChosen = useCallback(event => {
        const connId = pendingFileConnRef.current
        pendingFileConnRef.current = ''
        const target = event && event.target
        // 先快照文件列表再清空 input.value（第 30 轮）：真实浏览器里重置 value 会连带清空
        // 已选文件列表（先清后读会拿到空数组静默返回）；测试环境的假 files 不受影响。
        const files = [].slice.call((target && target.files) || [])  // slice.call 全环境可用（FileList → 数组）
        const input = fileInputRef.current
        if (input) input.value = ''
        // 第 29 轮起支持 multiple：一次选多个文件 → 每个文件一个查询页，激活最后一个
        if (!files.length || !connId) return
        Promise.all(files.map(file =>
          readLocalText(file).then(text => ({
            name: String(file.name || ''),
            text: String(text || ''),
          }))
        )).then(results => adoptSqlFiles(connId, results), () => {
          setQueryNotice(previous => Object.assign({}, previous, {
            [connId]: t('sql.queryTab.openFailed'),
          }))
        })
      }, [adoptSqlFiles])

      const saveQueryTabFile = useCallback((connId, tabId) => {
        const entry = queryTabsRef.current[connId]
        const item = entry && entry.list.find(x => x.id === tabId)
        if (!item) return
        const sqlText = String(querySqlRef.current[connId + '|' + tabId] || '')
        const suggested = item.origin === 'file' && item.fileName
          ? item.fileName
          : sanitizeSqlFilename(item.name)
        const noticeSaved = name => setQueryNotice(previous => Object.assign({}, previous, {
          [connId]: t('sql.queryTab.saved', { name }),
        }))
        const noticeFailed = () => setQueryNotice(previous => Object.assign({}, previous, {
          [connId]: t('sql.queryTab.saveFailed'),
        }))
        const markAsFile = name => {
          setQueryTabs(previous => {
            const current = previous[connId]
            if (!current) return previous
            return Object.assign({}, previous, {
              [connId]: Object.assign({}, current, {
                list: current.list.map(x => (x.id === tabId
                  ? Object.assign({}, x, { origin: 'file', fileName: name })
                  : x)),
              }),
            })
          })
        }
        const writeHandle = handle => Promise.resolve(handle.createWritable())
          .then(writable => Promise.resolve(writable.write(sqlText)).then(() => writable.close()))
        const saveAs = () => {
          // 无 File System Access API（老 webview / Node 测试环境）：Blob 下载兜底
          if (typeof showSaveFilePicker !== 'function') {
            if (typeof Blob === 'undefined') {
              noticeFailed()
              return
            }
            const blob = new Blob([sqlText], { type: 'text/sql;charset=utf-8' })
            const ok = downloadExportBlob(blob, suggested)
            if (!ok) {
              noticeFailed()
              return
            }
            markAsFile(suggested)
            noticeSaved(suggested)
            return
          }
          showSaveFilePicker({
            suggestedName: suggested,
            types: [{ description: 'SQL', accept: { 'text/sql': ['.sql'] } }],
          }).then(handle => writeHandle(handle).then(() => {
            fileHandlesRef.current[tabId] = handle
            storeFileHandle(tabId, handle)   // 跨会话恢复（第 49 轮）
            const name = handle.name || suggested
            markAsFile(name)
            noticeSaved(name)
          }), error => {
            // 用户在另存为对话框取消：静默，不算失败
            if (error && error.name === 'AbortError') return
            noticeFailed()
          })
        }
        const existing = fileHandlesRef.current[tabId]
        if (existing) {
          // 已有句柄（本次会话内另存过 / 跨会话从 IndexedDB 恢复，第 49 轮）：能写就
          // 直接覆盖原文件，不再弹框
          Promise.resolve(existing.queryPermission
            ? existing.queryPermission({ mode: 'readwrite' })
            : 'granted')
            .then(permission => {
              if (permission === 'granted') {
                return writeHandle(existing).then(() => {
                  storeFileHandle(tabId, existing)
                  return noticeSaved(item.fileName || suggested)
                })
              }
              return Promise.resolve(existing.requestPermission({ mode: 'readwrite' })).then(next => {
                if (next === 'granted') {
                  return writeHandle(existing).then(() => {
                    storeFileHandle(tabId, existing)
                    return noticeSaved(item.fileName || suggested)
                  })
                }
                saveAs()
              })
            })
            .catch(saveAs)
          return
        }
        saveAs()
      }, [])

      // 连接列表变化：清掉已删除连接的 tab/缓存；首次自动打开第一个连接；新建保存后自动打开
      useEffect(() => {
        if (!connectionsState.data) return
        const validIds = connectionList.map(connection => connection.id)
        setOpenTabs(previous => {
          const next = previous.filter(id => validIds.indexOf(id) >= 0)
          return next.length === previous.length ? previous : next
        })
        setTabState(previous => {
          const next = {}
          let changed = false
          Object.keys(previous).forEach(id => {
            if (validIds.indexOf(id) >= 0) next[id] = previous[id]
            else changed = true
          })
          return changed ? next : previous
        })
        setTabDatabases(previous => {
          const next = {}
          let changed = false
          Object.keys(previous).forEach(id => {
            if (validIds.indexOf(id) >= 0) next[id] = previous[id]
            else changed = true
          })
          return changed ? next : previous
        })
        setQueryTabs(previous => {
          const next = {}
          let changed = false
          Object.keys(previous).forEach(id => {
            if (validIds.indexOf(id) >= 0) next[id] = previous[id]
            else changed = true
          })
          return changed ? next : previous
        })
        if (!autoOpenedRef.current && validIds.length) {
          autoOpenedRef.current = true
          // 缓存恢复的 tab 仍然有效时不再抢焦点（保持上次打开的连接）
          const restored = openTabs.filter(id => validIds.indexOf(id) >= 0)
          if (!restored.length) {
            openConnectionTab(validIds[0])
          } else if (!activeTabId || validIds.indexOf(activeTabId) < 0) {
            openConnectionTab(restored[0])
          }
          return
        }
        const pending = pendingSelectRef.current
        if (pending && validIds.indexOf(pending) >= 0) {
          pendingSelectRef.current = null
          openConnectionTab(pending)
        }
      }, [connectionsState.data, connectionList, openConnectionTab])

      // 激活 tab 指向的连接不存在时，切到其它还开着的 tab
      useEffect(() => {
        if (!activeTabId) return
        if (connectionList.some(connection => connection.id === activeTabId)) return
        const next = openTabs.filter(id => connectionList.some(connection => connection.id === id))[0] || null
        setActiveTabId(next)
      }, [connectionsState.data, openTabs, activeTabId, connectionList])

      // 每个打开 tab 懒加载自己的库/db 列表（按连接缓存；刷新时 epoch+1 重拉）
      useEffect(() => {
        openTabs.forEach(id => {
          const entry = tabDatabases[id]
          if (entry && entry.loading) return
          if (entry && entry.epoch === databasesEpoch) return
          setTabDatabases(previous => Object.assign({}, previous, {
            [id]: {
              loading: true,
              list: previous[id] && Array.isArray(previous[id].list) ? previous[id].list : [],
              error: null,
              epoch: databasesEpoch,
            },
          }))
          api.databases(id).then(
            data => setTabDatabases(previous => Object.assign({}, previous, {
              [id]: {
                loading: false,
                list: data && Array.isArray(data.databases) ? data.databases : [],
                error: null,
                epoch: databasesEpoch,
              },
            })),
            error => setTabDatabases(previous => Object.assign({}, previous, {
              [id]: { loading: false, list: [], error, epoch: databasesEpoch },
            })),
          )
        })
      }, [openTabs, databasesEpoch])

      // 每个 tab 选中的库合法化（数据库列表回来后补默认库）
      useEffect(() => {
        if (!openTabs.length) return
        setTabState(previous => {
          let changed = false
          const next = Object.assign({}, previous)
          openTabs.forEach(id => {
            const connection = connectionList.find(item => item.id === id)
            if (!connection) return
            const entry = tabDatabases[id]
            const list = entry && Array.isArray(entry.list) ? entry.list : []
            const names = list.map(item => (typeof item === 'string' ? item : String(item.name)))
            const current = previous[id] || { database: '', tableTarget: null, seed: null }
            let database = current.database || ''
            if (names.length) {
              if (names.indexOf(database) < 0) {
                const preferred = connection.database !== undefined && connection.database !== null
                  ? String(connection.database)
                  : ''
                database = names.indexOf(preferred) >= 0 ? preferred : names[0]
              }
            } else if (!database && connection.kind === 'redis') {
              database = '0'
            }
            if (!previous[id] || database !== current.database) {
              next[id] = Object.assign({}, current, { database })
              changed = true
            }
          })
          return changed ? next : previous
        })
      }, [openTabs, tabDatabases, connectionsState.data, connectionList])

      const activeConnection = activeTabId ? connectionById(activeTabId) : null
      const activeState = activeTabId
        ? (tabState[activeTabId] || { database: '', tableTarget: null, seed: null })
        : { database: '', tableTarget: null, seed: null }
      const activeDatabaseEntry = activeTabId ? tabDatabases[activeTabId] : null
      const activeDatabaseList = activeDatabaseEntry && Array.isArray(activeDatabaseEntry.list)
        ? activeDatabaseEntry.list
        : []
      const reloadDatabases = useCallback(() => {
        setTabDatabases({})
        setDatabasesEpoch(value => value + 1)
      }, [])
      const activeDatabaseState = {
        loading: Boolean(activeDatabaseEntry && activeDatabaseEntry.loading),
        data: { databases: activeDatabaseList },
        error: activeDatabaseEntry ? activeDatabaseEntry.error : null,
        reload: reloadDatabases,
      }

      const allowWrites = Boolean(health.data && health.data.settings && health.data.settings.allowWrites)
      const defaultMaxRows = (health.data && health.data.settings && health.data.settings.maxRows)
        ? Number(health.data.settings.maxRows)
        : DEFAULT_MAX_ROWS

      const refreshAll = useCallback(() => {
        health.reload()
        connectionsState.reload()
        ticketsSummary.reload()
        setTabDatabases({})
        setDatabasesEpoch(value => value + 1)
        setTreeEpoch(value => value + 1)
      }, [health.reload, connectionsState.reload, ticketsSummary.reload, reloadDatabases])

      const selectConnection = useCallback(id => openConnectionTab(id), [openConnectionTab])
      const selectDb = useCallback(name => {
        updateTabState(activeTabId, { database: String(name), tableTarget: null })
      }, [activeTabId, updateTabState])
      const openTable = useCallback((database, table) => {
        updateTabState(activeTabId, {
          database: String(database),
          tableTarget: { database: String(database), table: String(table) },
        })
      }, [activeTabId, updateTabState])

      // 在连接 tab 上新建一个查询页承载 SQL（历史「载入编辑器」等入口共用），返回查询页 id。
      // 用渲染期同步的 ref 计算命名/落位，不能在 setState updater 里算（updater 是延迟批处理的）。
      const createSqlTabWith = useCallback((connId, sql) => {
        const current = queryTabsRef.current[connId] || { activeId: '', list: [] }
        const names = {}
        current.list.forEach(x => { names[x.name] = true })
        let n = 1
        while (names[t('sql.queryTab.newName', { n })]) n += 1
        const id = genQueryTabId()
        querySqlRef.current[connId + '|' + id] = String(sql || '')
        setQueryTabs(previous => Object.assign({}, previous, {
          [connId]: {
            activeId: id,
            list: current.list.concat([{
              id, name: t('sql.queryTab.newName', { n }), origin: 'temp', fileName: '',
            }]),
          },
        }))
        return id
      }, [])

      // 历史「载入编辑器」（第 55 轮裁决）：总是开一个**新查询页**承载 SQL——绝不覆盖
      // 已打开的编辑器内容；同时打开/激活对应连接的 tab，editorSeed 按 queryTabId 定向，
      // 只灌进新建的那个页。
      const loadSqlFromHistory = useCallback(item => {
        if (!item || !item.sql) return
        setView('workspace')
        const target = connectionList.find(connection => connection.id === item.connectionId) || null
        const seed = {
          sql: String(item.sql),
          stamp: Date.now(),
          connectionId: target ? target.id : '',
          database: item.database || '',
        }
        if (target) {
          openConnectionTab(target.id)
          seed.queryTabId = createSqlTabWith(target.id, item.sql)
          updateTabState(target.id, current2 => ({
            database: item.database || current2.database || '',
            tableTarget: null,
            seed,
          }))
        } else if (activeTabId) {
          // 无对应连接（已删除等）：落在当前连接 tab。只有 mysql 工作区才有查询页管理
          // （第 316 行 effect 保证至少一页），Redis tab 没有 editorSeed 消费方，直接落 seed 即可。
          if (queryTabsRef.current[activeTabId]) {
            seed.queryTabId = createSqlTabWith(activeTabId, item.sql)
          }
          updateTabState(activeTabId, { seed })
        }
      }, [connectionList, activeTabId, openConnectionTab, updateTabState, createSqlTabWith])

      // ---- 连接管理弹窗 ----
      const openCreateConnection = useCallback(() => {
        setConnectionDialog({ open: true, editing: null })
      }, [])
      const openEditConnection = useCallback(connection => {
        setConnectionDialog({ open: true, editing: connection })
      }, [])
      const closeConnectionDialog = useCallback(() => {
        setConnectionDialog({ open: false, editing: null })
      }, [])
      const handleConnectionSaved = useCallback((saved, isNew) => {
        setConnectionDialog({ open: false, editing: null })
        connectionsState.reload()
        health.reload()
        setTabDatabases({})
        setDatabasesEpoch(value => value + 1)
        setTreeEpoch(value => value + 1)
        // 只有新建才自动打开 tab；编辑保持当前 tab
        pendingSelectRef.current = isNew && saved && saved.id ? saved.id : null
      }, [connectionsState.reload, health.reload])
      const handleConnectionDeleted = useCallback(connection => {
        connectionsState.reload()
        health.reload()
        setTreeEpoch(value => value + 1)
        if (connection && connection.id) closeConnectionTab(connection.id)
      }, [connectionsState.reload, health.reload, closeConnectionTab])

      // ---- 脱敏策略树（两处入口共用同一组件） ----
      const openPolicyTree = useCallback(options => {
        const optionsValue = options || {}
        setPolicyDialog({
          open: true,
          connectionId: optionsValue.connectionId || '',
          presets: optionsValue.presets || null,
          keywords: optionsValue.keywords || null,
          aiNotice: optionsValue.aiNotice || null,
        })
      }, [])
      const closePolicyTree = useCallback(() => {
        setPolicyDialog({ open: false, connectionId: '', presets: null, keywords: null, aiNotice: null })
      }, [])
      const handlePolicySaved = useCallback(connection => {
        connectionsState.reload()
        if (connection && connection.id) setPolicyRefresh(connection)
      }, [connectionsState.reload])
      const mysqlConnections = connectionList.filter(connection => connection.kind !== 'redis')

      // 右上角只留一个左栏开关（连接 + 元数据是一个整体，合并后不再分两个按钮）
      const sideToggleLabel = layout.showSide
        ? t('panel.hideSide')
        : t('panel.showSide')
      const header = h('div', { className: 'dbs-head' },
        h(Icon, { name: 'database', size: 18 }),
        h('div', { className: 'dbs-title' }, t('app.title')),
        h(HealthBadge, { health }),
        h(Tag, { tone: allowWrites ? 'link' : 'plain', title: allowWrites ? '' : t('app.writesOffHint') },
          allowWrites ? t('app.writesOn') : t('app.writesOff')),
        h('span', { className: 'dbs-grow' }),
        h('button', {
          type: 'button',
          className: 'dbs-btn is-small' + (layout.showSide ? ' is-on' : ''),
          'data-dbs-testid': 'toggle-side',
          'aria-pressed': layout.showSide ? 'true' : 'false',
          'aria-label': sideToggleLabel,
          title: sideToggleLabel,
          onClick: layout.toggleSide,
        }, h(Icon, { name: 'layers', size: 14 }), t('panel.sideToggle')),
        mode !== 'sidebar' && openInSidebar
          ? h('button', {
            type: 'button',
            className: 'dbs-btn is-small dbs-open-sidebar',
            'data-dbs-testid': 'open-in-sidebar',
            'aria-label': t('panel.openInSidebar'),
            title: t('panel.openInSidebar'),
            onClick: () => openInSidebar(),
          }, h(Icon, { name: 'columns', size: 13 }), t('panel.openInSidebar'))
          : null,
        mode === 'sidebar' && openInMain
          ? h('button', {
            type: 'button',
            className: 'dbs-btn is-small dbs-open-main',
            'data-dbs-testid': 'open-in-main',
            'aria-label': t('panel.openInMain'),
            title: t('panel.openInMain'),
            onClick: () => openInMain(),
          }, h(Icon, { name: 'chevron', size: 13 }), t('panel.openInMain'))
          : null,
        h('button', {
          type: 'button', className: 'dbs-btn is-small', onClick: refreshAll,
          disabled: health.loading && connectionsState.loading,
        }, h(Icon, { name: 'refresh', size: 13 }), t('app.refresh')))

      const tabBar = openTabs.length
        ? h('div', { className: 'dbs-conn-tabs' },
          h('div', { className: 'dbs-conn-tabs-scroll', role: 'tablist' }, openTabs.map(id => {
            const connection = connectionById(id)
            if (!connection) return null
            const active = id === activeTabId
            const name = String(connection.name || connection.id)
            return h('div', {
              key: 'tab:' + id,
              className: 'dbs-conn-tab' + (active ? ' is-on' : ''),
            },
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': active ? 'true' : 'false',
              className: 'dbs-conn-tab-label',
              title: name,
              onClick: () => setActiveTabId(id),
            },
            h(Icon, { name: connection.kind === 'redis' ? 'layers' : 'database', size: 12 }),
            h('span', { className: 'dbs-conn-tab-name' }, name),
            connection.readonly
              ? h('span', { className: 'dbs-conn-tab-badge' }, t('connection.readonly'))
              : null,
            connectionMaskingEnabled(connection)
              ? h('span', { className: 'dbs-conn-tab-badge' }, t('masking.badge'))
              : null),
            h('button', {
              type: 'button',
              className: 'dbs-conn-tab-close',
              title: t('app.tab.close', { name }),
              'aria-label': t('app.tab.close', { name }),
              onClick: () => closeConnectionTab(id),
            }, '×'))
          })))
        : null

      const panes = openTabs.map(id => {
        const connection = connectionById(id)
        if (!connection) return null
        const state = tabState[id] || { database: '', tableTarget: null, seed: null }
        const entry = tabDatabases[id]
        const list = entry && Array.isArray(entry.list) ? entry.list : []
        const names = list.map(item => (typeof item === 'string' ? item : String(item.name)))
        const active = id === activeTabId
        const paneMaxRows = connection.maxRows ? Number(connection.maxRows) : defaultMaxRows
        let content
        if (connection.kind === 'redis') {
          content = h(RedisBrowser, {
            key: 'redis:' + id,
            connection,
            databaseEntries: list,
            activeDb: state.database || '',
            onDbChange: name => updateTabState(id, { database: String(name), tableTarget: null }),
          })
        } else {
          // 查询页（多 tab）：每个查询页一个独立工作台实例（SQL/结果互不影响），
          // 未激活的实例保持挂载、CSS 隐藏，切回来内容原样
          const queryEntry = queryTabs[id] || { activeId: '', list: [] }
          const queryList = queryEntry.list
          const notice = queryNotice[id] || ''
          const queryTabBar = h('div', { className: 'dbs-query-tabs' },
            h('div', { className: 'dbs-query-tabs-scroll', role: 'tablist' },
              queryList.map(item => {
                const isFile = item.origin === 'file'
                const tabActive = item.id === queryEntry.activeId
                const label = item.name || item.fileName || t('sql.queryTab.newName', { n: '?' })
                return h('div', {
                  key: 'qtab:' + item.id,
                  className: 'dbs-query-tab' + (tabActive ? ' is-on' : '') + (isFile ? ' is-file' : ''),
                },
                h('button', {
                  type: 'button',
                  role: 'tab',
                  'aria-selected': tabActive ? 'true' : 'false',
                  'data-dbs-testid': 'query-tab:' + id + ':' + item.id,
                  className: 'dbs-query-tab-label',
                  title: isFile ? String(item.fileName || label) : t('sql.queryTab.tempTip'),
                  onClick: () => selectQueryTab(id, item.id),
                },
                h(Icon, { name: isFile ? 'file' : 'code', size: 11 }),
                h('span', { className: 'dbs-query-tab-name' }, label)),
                h('button', {
                  type: 'button',
                  className: 'dbs-query-tab-close',
                  title: t('sql.queryTab.close', { name: label }),
                  'aria-label': t('sql.queryTab.close', { name: label }),
                  onClick: () => closeQueryTab(id, item.id),
                }, '×'))
              })),
            h('div', { className: 'dbs-query-tab-actions' },
              h('button', {
                type: 'button', className: 'dbs-btn is-small',
                title: t('sql.queryTab.new'),
                'aria-label': t('sql.queryTab.new'),
                'data-dbs-testid': 'query-tab-new:' + id,
                onClick: () => newQueryTab(id),
              }, h(Icon, { name: 'plus', size: 12 }), t('sql.queryTab.newShort')),
              h('button', {
                type: 'button', className: 'dbs-btn is-small',
                title: t('sql.queryTab.openFile'),
                'aria-label': t('sql.queryTab.openFile'),
                'data-dbs-testid': 'query-tab-open:' + id,
                onClick: () => openSqlFilePicker(id),
              }, h(Icon, { name: 'file', size: 12 }), t('sql.queryTab.openShort')),
              h('button', {
                type: 'button', className: 'dbs-btn is-small',
                title: t('sql.queryTab.save'),
                'aria-label': t('sql.queryTab.save'),
                'data-dbs-testid': 'query-tab-save:' + id,
                onClick: () => saveQueryTabFile(id, queryEntry.activeId),
              }, h(Icon, { name: 'save', size: 12 }), t('sql.queryTab.saveShort')),
              notice
                ? h('span', { className: 'dbs-query-note', 'data-dbs-testid': 'query-note:' + id },
                  notice,
                  h(NoticeClose, {
                    onClose: () => setQueryNotice(previous => {
                      const next = Object.assign({}, previous)
                      delete next[id]
                      return next
                    }),
                  }))
                : null))
          content = h('div', { className: 'dbs-query-workspace' },
            queryTabBar,
            h('div', { className: 'dbs-query-panes' }, queryList.map(item => h(SqlWorkbench, {
              key: 'sql:' + id + ':' + item.id,
              connection,
              queryTabId: item.id,
              hidden: item.id !== queryEntry.activeId,
              initialSql: String(querySqlRef.current[id + '|' + item.id] || ''),
              databaseNames: names,
              activeDb: state.database || '',
              onDatabaseChange: name => updateTabState(id, { database: String(name), tableTarget: null }),
              tableTarget: state.tableTarget || null,
              maxRows: paneMaxRows,
              editorSeed: state.seed || null,
              onSqlChange: value => handleQuerySqlChange(id, item.id, value),
              onSaveFile: () => saveQueryTabFile(id, item.id),
            }))))
        }
        return h('div', {
          key: 'pane:' + id,
          className: 'dbs-tab-pane' + (active ? ' is-active' : ''),
          role: 'tabpanel',
        }, content)
      })

      // 窄/侧栏模式下左栏是覆盖式抽屉：关闭时收起整个左栏（记住选择）
      const closeDrawer = () => {
        if (layout.showSide) layout.toggleSide()
      }
      const side = layout.showSide
        ? h('aside', {
          className: 'dbs-side' + (layout.narrow ? ' is-drawer' : ''),
          'data-dbs-testid': 'side',
        },
        layout.narrow
          ? h('div', { className: 'dbs-drawer-head' },
            h('span', { className: 'dbs-drawer-title' }, t('app.title')),
            h('span', { className: 'dbs-grow' }),
            h('button', {
              type: 'button',
              className: 'dbs-iconbtn dbs-drawer-close',
              'data-dbs-testid': 'drawer-close',
              title: t('connmgr.close'),
              'aria-label': t('connmgr.close'),
              onClick: closeDrawer,
            }, h(Icon, { name: 'close', size: 14 })))
          : null,
        h(ConnectionList, {
          connections: connectionList,
          state: { loading: connectionsState.loading, error: connectionsState.error },
          selectedId: activeTabId,
          onSelect: selectConnection,
          onRefresh: refreshAll,
          onCreate: openCreateConnection,
          onEdit: openEditConnection,
          onDeleted: handleConnectionDeleted,
        }),
        activeConnection
          ? h(MetaTree, {
            key: activeConnection.id,
            connection: activeConnection,
            databaseState: activeDatabaseState,
            activeDb: activeState.database || '',
            activeTable: activeState.tableTarget || null,
            reloadToken: treeEpoch,
            onSelectDb: selectDb,
            onOpenTable: openTable,
            onRefresh: refreshAll,
          })
          : h('div', { className: 'dbs-section dbs-tree-section' },
            h('div', { className: 'dbs-section-head' },
              h('span', { className: 'dbs-section-title' }, t('meta.title'))),
            h('div', { className: 'dbs-empty is-small' },
              h(Icon, { name: 'table', size: 20 }),
              h('div', { className: 'dbs-empty-text' }, t('meta.selectDb')))))
        : null
      const drawerMask = layout.narrow && layout.showSide
        ? h('div', {
          className: 'dbs-drawer-mask',
          'data-dbs-testid': 'drawer-mask',
          onClick: closeDrawer,
          'aria-hidden': 'true',
        })
        : null

      let main
      // 没有任何可见的连接 tab（未打开 / 连接列表加载失败 / 恢复的缓存连接全失效）→ 空态
      const hasVisiblePane = openTabs.some(id => Boolean(connectionById(id)))
      if (!hasVisiblePane) {
        main = h('div', { className: 'dbs-main' }, connectionList.length
          ? h('div', { className: 'dbs-empty is-small' },
            h(Icon, { name: 'database', size: 26 }),
            h('div', { className: 'dbs-empty-title' }, t('app.tab.emptyTitle')),
            h('p', { className: 'dbs-empty-text' }, t('app.tab.emptyBody')))
          : h(WelcomeEmpty, {
            health,
            connectionCount: connectionList.length,
            onRefresh: refreshAll,
            onManage: openCreateConnection,
          }))
      } else {
        main = h('div', { className: 'dbs-main' },
          tabBar,
          h('div', { className: 'dbs-tab-panes' }, panes))
      }

      const nav = h('div', { className: 'dbs-nav', role: 'tablist' },
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'workspace' ? 'true' : 'false',
          className: 'dbs-nav-item' + (view === 'workspace' ? ' is-on' : ''),
          onClick: () => setView('workspace'),
        }, h(Icon, { name: 'code', size: 13 }), t('app.nav.workspace')),
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'tickets' ? 'true' : 'false',
          className: 'dbs-nav-item' + (view === 'tickets' ? ' is-on' : ''),
          onClick: () => { setView('tickets'); setTicketFocus(null); ticketsSummary.reload() },
        }, h(Icon, { name: 'sliders', size: 13 }), t('app.nav.tickets'),
        pendingTicketCount !== null && pendingTicketCount > 0
          ? h('span', {
            className: 'dbs-nav-badge',
            title: t('tickets.pendingBadge', { n: pendingTicketCount }),
          }, pendingTicketCount > 99 ? '99+' : String(pendingTicketCount))
          : null),
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'history' ? 'true' : 'false',
          className: 'dbs-nav-item' + (view === 'history' ? ' is-on' : ''),
          onClick: () => setView('history'),
        }, h(Icon, { name: 'list', size: 13 }), t('app.nav.history')),
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'policies' ? 'true' : 'false',
          className: 'dbs-nav-item' + (view === 'policies' ? ' is-on' : ''),
          onClick: () => setView('policies'),
        }, h(Icon, { name: 'shield', size: 13 }), t('app.nav.policies')),
        h('button', {
          type: 'button', role: 'tab', 'aria-selected': view === 'semantic' ? 'true' : 'false',
          className: 'dbs-nav-item' + (view === 'semantic' ? ' is-on' : ''),
          onClick: () => setView('semantic'),
        }, h(Icon, { name: 'spark', size: 13 }), t('app.nav.semantic')))

      const policyPage = view === 'policies'
        ? h('div', { className: 'dbs-policy-page' },
          h('div', { className: 'dbs-view-head' },
            h('div', { className: 'dbs-view-heading' },
              h(Icon, { name: 'shield', size: 16 }),
              h('span', null, t('masking.policy.title'))),
            h('span', { className: 'dbs-grow' }),
            h('span', { className: 'dbs-muted' }, t('masking.policy.pageHint'))),
          mysqlConnections.length
            ? h(MaskingPolicyTree, {
              key: 'policy-inline',
              inline: true,
              connections: connectionList,
              initialConnectionId: policyConnectionId,
              onConnectionChange: setPolicyConnectionId,
              onSaved: handlePolicySaved,
            })
            : h('div', { className: 'dbs-empty is-small' },
              h(Icon, { name: 'shield', size: 26 }),
              h('div', { className: 'dbs-empty-title' }, t('masking.policy.noMysql')),
              h('p', { className: 'dbs-empty-text' }, t('masking.policy.noMysqlHint'))))
        : null

      const semanticPage = view === 'semantic'
        ? h(SemanticView, null)
        : null

      const content = h('div', { className: 'dbs-content' },
        h('div', {
          className: 'dbs-body'
            + (layout.narrow ? ' is-narrow' : '')
            + (view === 'workspace' ? '' : ' is-hidden'),
        },
          drawerMask, side, main),
        view === 'tickets'
          ? h(TicketsView, {
            connections: connectionList,
            onChanged: ticketsSummary.reload,
            focusTicketId: ticketFocus ? ticketFocus.id : '',
            onOpenHistory: keyword => { setHistoryFilterSeed({ keyword }); setView('history') },
          })
          : null,
        view === 'history'
          ? h(HistoryView, {
            connections: connectionList,
            onLoadSql: loadSqlFromHistory,
            filterSeed: historyFilterSeed,
            onOpenTicket: ticketId => { setTicketFocus({ id: ticketId }); setView('tickets'); ticketsSummary.reload() },
          })
          : null,
        policyPage,
        semanticPage)

      // 侧栏模式内部提示：只在默认收起时出现，展开后不再占高度
      const sidebarHint = mode === 'sidebar' && !layout.showSide
        ? h('div', { className: 'dbs-sidebar-hint' },
          h(Icon, { name: 'columns', size: 12 }),
          t('panel.sidebarHint'))
        : null

      return h('div', {
        ref: layout.rootRef,
        className: 'dbs-root'
          + (layout.narrow ? ' is-narrow' : '')
          + (mode === 'sidebar' ? ' is-sidebar' : ''),
        'data-dbs-testid': 'panel-root',
        'data-dbs-mode': mode,
      },
        h('style', null, CSS),
        h('input', {
          ref: fileInputRef,
          type: 'file',
          accept: '.sql,.txt,text/plain,text/sql',
          multiple: true,
          className: 'dbs-file-input',
          onChange: handleSqlFileChosen,
          'aria-hidden': 'true',
          tabIndex: -1,
        }),
        header,
        sidebarHint,
        nav,
        h(BackendBanner, { health }),
        content,
        h(ConnectionsDialog, {
          open: connectionDialog.open,
          editing: connectionDialog.editing,
          onClose: closeConnectionDialog,
          onSaved: handleConnectionSaved,
          refreshConnection: policyRefresh,
        }),
        policyDialog.open
          ? h(MaskingPolicyTree, {
            key: 'masking-policy:' + (policyDialog.connectionId || 'auto'),
            connections: connectionList,
            initialConnectionId: policyDialog.connectionId,
            presets: policyDialog.presets,
            keywords: policyDialog.keywords,
            aiNotice: policyDialog.aiNotice,
            onClose: closePolicyTree,
            onSaved: handlePolicySaved,
          })
          : null)
    }

    /** 侧栏入口图标（只画图标，尺寸由宿主传入）。 */
    function SidebarIcon(props) {
      return h(Icon, { name: 'database', size: (props && props.size) || 16 })
    }
