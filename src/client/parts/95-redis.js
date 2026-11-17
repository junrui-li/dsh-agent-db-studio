
    // ======================================================================
    // 11. Redis 浏览：SCAN 分页 + 键详情（只读）
    // ======================================================================

    function RedisValueView(props) {
      const detail = props.detail || {}
      const type = String(detail.type || '').toLowerCase()
      const value = detail.value

      if (type === 'string' || typeof value === 'string') {
        const isJson = detail.json !== undefined && detail.json !== null
        return h('div', { className: 'dbs-redis-value' },
          isJson ? h('div', { className: 'dbs-redis-value-bar' }, t('redis.jsonValue')) : null,
          h('pre', { className: 'dbs-pre' }, isJson ? prettyJson(detail.json) : String(value === undefined || value === null ? '' : value)))
      }
      if (Array.isArray(value)) {
        if (!value.length) {
          return h('div', { className: 'dbs-pad dbs-muted' }, t('redis.emptyCollection'))
        }
        const first = value[0]
        const isObjectRow = first !== null && typeof first === 'object' && !Array.isArray(first)
        if (isObjectRow) {
          let columns
          if (type === 'hash' || ('field' in first && 'value' in first)) {
            columns = [t('redis.columnField'), t('redis.columnValue')]
            return h('div', { className: 'dbs-redis-value' },
              h(ResultGrid, {
                columns,
                rows: value.map(item => [
                  redisValueName(item && item.field),
                  item && item.value !== undefined ? redisValueName(item.value) : null,
                ]),
              }),
              detail.truncated ? h('div', { className: 'dbs-note' }, t('redis.truncated', { n: value.length })) : null)
          }
          if (type === 'zset' || ('member' in first && 'score' in first)) {
            columns = [t('redis.columnMember'), t('redis.columnScore')]
            return h('div', { className: 'dbs-redis-value' },
              h(ResultGrid, {
                columns,
                rows: value.map(item => [
                  redisValueName(item && item.member),
                  item && item.score !== undefined ? item.score : null,
                ]),
              }),
              detail.truncated ? h('div', { className: 'dbs-note' }, t('redis.truncated', { n: value.length })) : null)
          }
          const keys = Object.keys(first).slice(0, 6)
          return h('div', { className: 'dbs-redis-value' },
            h(ResultGrid, {
              columns: keys.map(name => ({ name })),
              rows: value.map(item => keys.map(name => (item && item[name] !== undefined ? item[name] : null))),
            }))
        }
        return h('div', { className: 'dbs-redis-value' },
          h(ResultGrid, {
            columns: [{ name: t('redis.columnIndex') }, { name: t('redis.columnValue') }],
            rows: value.map((item, index) => [index, redisValueName(item)]),
          }),
          detail.truncated ? h('div', { className: 'dbs-note' }, t('redis.truncated', { n: value.length })) : null)
      }
      if (value !== null && typeof value === 'object') {
        return h('div', { className: 'dbs-redis-value' },
          h(ResultGrid, {
            columns: [{ name: t('redis.columnKey') }, { name: t('redis.columnValue') }],
            rows: Object.keys(value).map(key => [key, redisValueName(value[key])]),
          }))
      }
      if (value === null || value === undefined) {
        return h('div', { className: 'dbs-pad dbs-muted' }, t('common.dash'))
      }
      return h('pre', { className: 'dbs-pre' }, String(value))
    }

    function RedisBrowser(props) {
      const connection = props.connection
      const databaseEntries = props.databaseEntries || []
      // 库列表还没回来时先按 db 0 处理，避免先发一条空库名的扫描
      const activeDb = props.activeDb ? String(props.activeDb) : '0'
      const [pattern, setPattern] = useState('*')
      const [applied, setApplied] = useState('*')
      const [nonce, setNonce] = useState(0)
      const [keys, setKeys] = useState([])
      const [cursor, setCursor] = useState('0')
      const [scanning, setScanning] = useState(false)
      const [scanError, setScanError] = useState(null)
      const [loadingMore, setLoadingMore] = useState(false)
      const [scanned, setScanned] = useState(false)
      const [selectedKey, setSelectedKey] = useState(null)
      const [detail, setDetail] = useState(null)
      const [detailLoading, setDetailLoading] = useState(false)
      const [detailError, setDetailError] = useState(null)
      const scanSeqRef = useRef(0)
      const detailSeqRef = useRef(0)

      // 库 / pattern 变化 → 重置并扫描第一页
      useEffect(() => {
        const seq = scanSeqRef.current + 1
        scanSeqRef.current = seq
        const controller = new AbortController()
        let alive = true
        setKeys([])
        setCursor('0')
        setScanned(false)
        setScanning(true)
        setScanError(null)
        setSelectedKey(null)
        setDetail(null)
        setDetailError(null)
        api.redisScan({
          connectionId: connection.id,
          database: redisDbValue(activeDb),
          cursor: '0',
          match: applied || '*',
          count: 200,
        }, controller.signal).then(data => {
          if (!alive || scanSeqRef.current !== seq) return
          setScanning(false)
          setScanned(true)
          setCursor(String(data.cursor === undefined || data.cursor === null ? '0' : data.cursor))
          setKeys(Array.isArray(data.keys) ? data.keys : [])
        }, error => {
          if (!alive || scanSeqRef.current !== seq) return
          setScanning(false)
          if (isAbort(error)) return
          setScanError(error)
          setKeys([])
        })
        return () => {
          alive = false
          controller.abort()
        }
      }, [connection.id, activeDb, applied, nonce])

      const loadMore = useCallback(() => {
        if (loadingMore || scanning || cursor === '0' || cursor === '' || cursor === null) return
        const seq = scanSeqRef.current + 1
        scanSeqRef.current = seq
        setLoadingMore(true)
        api.redisScan({
          connectionId: connection.id,
          database: redisDbValue(activeDb),
          cursor: String(cursor),
          match: applied || '*',
          count: 200,
        }).then(data => {
          if (scanSeqRef.current !== seq) return
          setLoadingMore(false)
          setCursor(String(data.cursor === undefined || data.cursor === null ? '0' : data.cursor))
          const incoming = Array.isArray(data.keys) ? data.keys : []
          setKeys(previous => {
            const seen = {}
            previous.forEach(item => { seen[item.key] = true })
            return previous.concat(incoming.filter(item => item && !seen[item.key]))
          })
        }, error => {
          if (scanSeqRef.current !== seq) return
          setLoadingMore(false)
          if (!isAbort(error)) setScanError(error)
        })
      }, [connection.id, activeDb, applied, cursor, loadingMore, scanning])

      const openKey = useCallback(key => {
        setSelectedKey(key)
        setDetail(null)
        setDetailLoading(true)
        setDetailError(null)
        const seq = detailSeqRef.current + 1
        detailSeqRef.current = seq
        api.redisKey({ connectionId: connection.id, database: redisDbValue(activeDb), key })
          .then(data => {
            if (detailSeqRef.current !== seq) return
            setDetailLoading(false)
            setDetail(data || null)
          }, error => {
            if (detailSeqRef.current !== seq) return
            setDetailLoading(false)
            if (isAbort(error)) return
            setDetailError(error)
          })
      }, [connection.id, activeDb])

      // 卸载时让在途详情请求失效
      useEffect(() => () => { detailSeqRef.current += 1 }, [])

      const dbSelect = h('select', {
        className: 'dbs-select',
        value: activeDb,
        onChange: event => { if (props.onDbChange) props.onDbChange(event.target.value) },
      }, databaseEntries.map(entry => {
        const name = typeof entry === 'string' ? entry : String(entry.name)
        const keysCount = typeof entry === 'object' && entry && entry.keys !== undefined && entry.keys !== null
          ? ' (' + formatNumber(entry.keys) + ')'
          : ''
        return h('option', { key: 'db:' + name, value: name }, 'db' + name + keysCount)
      }))

      const scanbar = h('div', { className: 'dbs-runbar' },
        h('span', { className: 'dbs-muted' }, t('redis.database')),
        dbSelect,
        h('input', {
          className: 'dbs-input',
          value: pattern,
          placeholder: t('redis.matchPlaceholder'),
          onChange: event => setPattern(event.target.value),
          onKeyDown: event => {
            if (event.key === 'Enter') {
              event.preventDefault()
              setApplied(String(pattern || '').trim() || '*')
              setNonce(value => value + 1)
            }
          },
          'aria-label': t('redis.matchPlaceholder'),
        }),
        h('button', {
          type: 'button', className: 'dbs-btn is-small',
          onClick: () => {
            setApplied(String(pattern || '').trim() || '*')
            setNonce(value => value + 1)
          },
          disabled: scanning,
        }, h(Icon, { name: 'search', size: 13 }), t('redis.search')),
        h('button', {
          type: 'button', className: 'dbs-btn is-small',
          onClick: loadMore,
          disabled: scanning || loadingMore || cursor === '0' || cursor === '' || cursor === null,
        }, loadingMore ? h(Spinner, null) : null, loadingMore ? t('redis.loadingMore') : t('redis.loadMore')),
        h('span', { className: 'dbs-grow' }),
        scanned && !scanError
          ? h('span', { className: 'dbs-muted' }, t('redis.scanned', { n: formatNumber(keys.length) })
            + (cursor === '0' ? ' · ' + t('redis.done') : ''))
          : null)

      let keysBody
      if (scanError) {
        keysBody = h('div', { className: 'dbs-pad' }, h(ErrorBar, {
          error: scanError,
          label: t('redis.scanError'),
          onRetry: () => setNonce(value => value + 1),
        }))
      } else if (scanning && !keys.length) {
        keysBody = h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 6 }))
      } else if (!keys.length) {
        keysBody = h('div', { className: 'dbs-empty is-small' }, h(Icon, { name: 'key', size: 22 }),
          h('div', { className: 'dbs-empty-text' }, t('redis.keysEmpty')))
      } else {
        keysBody = h('div', { className: 'dbs-keys', role: 'list' }, keys.map(item => {
          const key = String(item.key)
          const active = key === selectedKey
          return h('button', {
            key: 'key:' + key,
            type: 'button',
            role: 'listitem',
            className: 'dbs-key-row' + (active ? ' is-on' : ''),
            title: key,
            onClick: () => openKey(key),
          },
          h('span', { className: 'dbs-key-name' }, key),
          item.type ? h(Tag, { tone: 'plain' }, String(item.type)) : null,
          formatTtlShort(item.ttl) ? h('span', { className: 'dbs-key-ttl' }, formatTtlShort(item.ttl)) : null)
        }))
      }

      let detailBody
      if (detailError) {
        detailBody = h('div', { className: 'dbs-pad' }, h(ErrorBar, {
          error: detailError,
          label: t('redis.keyError'),
          onRetry: () => { if (selectedKey) openKey(selectedKey) },
        }))
      } else if (detailLoading) {
        detailBody = h('div', { className: 'dbs-empty is-small' }, h(Spinner, { large: true }),
          h('div', { className: 'dbs-empty-text' }, t('redis.keyLoading')))
      } else if (!detail) {
        detailBody = h('div', { className: 'dbs-empty is-small' }, h(Icon, { name: 'key', size: 24 }),
          h('div', { className: 'dbs-empty-text' }, t('redis.keyEmpty')))
      } else {
        detailBody = h('div', { className: 'dbs-redis-detail' },
          h('div', { className: 'dbs-redis-detail-head' },
            h('span', { className: 'dbs-mono dbs-key-title', title: String(detail.key) }, String(detail.key)),
            detail.type ? h(Tag, { tone: 'link' }, String(detail.type)) : null,
            h(Tag, { tone: 'plain' }, t('redis.ttl') + ' · ' + formatTtlText(detail.ttl)),
            detail.memoryBytes !== undefined && detail.memoryBytes !== null
              ? h(Tag, { tone: 'plain' }, t('redis.memory') + ' · ' + formatBytes(detail.memoryBytes))
              : null),
          detail.note ? h('div', { className: 'dbs-note' }, String(detail.note)) : null,
          h('div', { className: 'dbs-redis-detail-body' }, h(RedisValueView, { detail })))
      }

      return h('div', { className: 'dbs-redis' },
        scanbar,
        h('div', { className: 'dbs-redis-split' },
          h('div', { className: 'dbs-keys-pane' }, keysBody),
          h('div', { className: 'dbs-detail-pane' }, detailBody)))
    }
