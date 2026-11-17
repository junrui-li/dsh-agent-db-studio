
    // ======================================================================
    // 6. 左栏：连接列表
    // ======================================================================

    function connectionKindLabel(kind) {
      if (kind === 'redis') return t('connection.redis')
      if (kind === 'mysql') return t('connection.mysql')
      return String(kind || '')
    }

    function connectionHost(connection) {
      const host = connection.host ? String(connection.host) : 'localhost'
      return connection.port ? host + ':' + connection.port : host
    }

    function ConnectionList(props) {
      const connections = props.connections || []
      const state = props.state || { loading: false, error: null }
      const [menuId, setMenuId] = useState(null)
      const [confirmId, setConfirmId] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [notice, setNotice] = useState(null) // {id, tone:'ok'|'bad', text}

      const testConnection = connection => {
        setMenuId(null)
        setNotice(null)
        setBusyId(connection.id)
        api.testConnection({ id: connection.id }).then(data => {
          setBusyId(null)
          const ok = Boolean(data && data.ok)
          setNotice({
            id: connection.id,
            tone: ok ? 'ok' : 'bad',
            text: ok
              ? t('connmgr.testOk', {
                ms: formatNumber(data.elapsedMs || 0),
                version: data.version ? ' · ' + data.version : '',
              })
              : t('connmgr.testFail', { message: String((data && data.error) || '') }),
          })
        }, error => {
          setBusyId(null)
          setNotice({ id: connection.id, tone: 'bad', text: t('connmgr.testFail', { message: errorText(error) }) })
        })
      }

      const removeConnection = connection => {
        setConfirmId(null)
        setBusyId(connection.id)
        api.deleteConnection(connection.id).then(() => {
          setBusyId(null)
          setMenuId(null)
          setNotice(null)
          if (props.onDeleted) props.onDeleted(connection)
        }, error => {
          setBusyId(null)
          setNotice({ id: connection.id, tone: 'bad', text: t('connmgr.deleteFail', { message: errorText(error) }) })
        })
      }

      const header = h('div', { className: 'dbs-section-head' },
        h('span', { className: 'dbs-section-title' }, t('connection.title')),
        connections.length ? h('span', { className: 'dbs-count' }, String(connections.length)) : null,
        h('span', { className: 'dbs-grow' }),
        h('button', {
          type: 'button', className: 'dbs-btn is-small', title: t('connmgr.newTitle'),
          onClick: () => { if (props.onCreate) props.onCreate() },
        }, h(Icon, { name: 'sliders', size: 14 }), t('connmgr.newTitle')),
        h('button', {
          type: 'button', className: 'dbs-btn is-small', title: t('app.refresh'),
          onClick: props.onRefresh, disabled: state.loading,
        }, h(Icon, { name: 'refresh', size: 14 }), t('app.refresh')))

      let body
      if (state.error) {
        body = h('div', { className: 'dbs-pad' }, h(ErrorBar, {
          error: state.error, label: t('connection.error'), onRetry: props.onRefresh,
        }))
      } else if (!connections.length) {
        body = state.loading
          ? h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 3 }))
          : h('div', { className: 'dbs-empty is-small' },
            h(Icon, { name: 'database', size: 24 }),
            h('div', { className: 'dbs-empty-title' }, t('connection.emptyTitle')),
            h('p', { className: 'dbs-empty-text' }, t('connection.emptyBody')),
            h('p', { className: 'dbs-empty-hint' }, t('connection.emptyHint')))
      } else {
        body = h('div', { className: 'dbs-conn-list', role: 'list' }, connections.map(connection => {
          const active = connection.id === props.selectedId
          const open = menuId === connection.id
          const busy = busyId === connection.id
          const rowNotice = notice && notice.id === connection.id ? notice : null
          return h('div', {
            key: String(connection.id),
            role: 'listitem',
            className: 'dbs-conn-item' + (active ? ' is-on' : '') + (open ? ' is-menu' : ''),
          },
          h('div', { className: 'dbs-conn-line' },
            h('button', {
              type: 'button',
              className: 'dbs-conn',
              'aria-pressed': active ? 'true' : 'false',
              title: connection.name + ' · ' + connectionHost(connection),
              onClick: () => props.onSelect(connection.id),
            },
            h(Icon, { name: connection.kind === 'redis' ? 'layers' : 'database', size: 15 }),
            h('span', { className: 'dbs-conn-main' },
              h('span', { className: 'dbs-conn-name' }, String(connection.name || connection.id)),
              h('span', { className: 'dbs-conn-sub' },
                connectionKindLabel(connection.kind) + ' · ' + connectionHost(connection) +
                (connection.hasPassword ? ' · ' + t('connmgr.hasPassword') : ''))),
            h(Tag, { tone: connection.readonly ? 'link' : '' },
              connection.readonly ? t('connection.readonly') : t('connection.writable')),
            connectionMaskingEnabled(connection)
              ? h('span', { className: 'dbs-mask-badge', title: t('masking.badgeTip') },
                h(Icon, { name: 'shield', size: 10 }), t('masking.badge'))
              : null),
            h('button', {
              type: 'button', className: 'dbs-conn-more', 'aria-label': t('connmgr.actions'),
              title: t('connmgr.actions'),
              'aria-expanded': open ? 'true' : 'false',
              onClick: () => {
                setMenuId(open ? null : connection.id)
                setConfirmId(null)
              },
            }, h(Icon, { name: 'sliders', size: 12 }), t('connmgr.actions')))
          ,
          open
            ? h('div', { className: 'dbs-conn-menu' },
              h('button', {
                type: 'button', className: 'dbs-conn-menu-item',
                onClick: () => { setMenuId(null); if (props.onEdit) props.onEdit(connection) },
              }, h(Icon, { name: 'edit', size: 12 }), t('connmgr.edit')),
              h('button', {
                type: 'button', className: 'dbs-conn-menu-item', disabled: busy,
                onClick: () => testConnection(connection),
              }, h(Icon, { name: 'check', size: 12 }), busy ? t('connmgr.testing') : t('connmgr.test')),
              confirmId === connection.id
                ? h('button', {
                  type: 'button', className: 'dbs-conn-menu-item is-danger', disabled: busy,
                  onClick: () => removeConnection(connection),
                }, h(Icon, { name: 'trash', size: 12 }), busy ? t('connmgr.deleting') : t('connmgr.confirmDelete'))
                : h('button', {
                  type: 'button', className: 'dbs-conn-menu-item is-danger',
                  onClick: () => setConfirmId(connection.id),
                }, h(Icon, { name: 'trash', size: 12 }), t('connmgr.delete')),
              confirmId === connection.id
                ? h('button', {
                  type: 'button', className: 'dbs-conn-menu-item',
                  onClick: () => setConfirmId(null),
                }, t('connmgr.cancel'))
                : null,
              h('div', { className: 'dbs-conn-menu-confirm' }, confirmId === connection.id
                ? t('connmgr.deleteConfirm', { name: String(connection.name || connection.id) })
                : null))
            : null,
          rowNotice
            ? h('div', { className: 'dbs-conn-test is-' + rowNotice.tone },
              h('span', { className: 'dbs-conn-test-text' }, rowNotice.text),
              h(NoticeClose, { onClose: () => setNotice(null) }))
            : null)
        }))
      }

      const footer = h('div', { className: 'dbs-conn-footer' },
        h('button', {
          type: 'button', className: 'dbs-conn-new',
          onClick: () => { if (props.onCreate) props.onCreate() },
        }, h(Icon, { name: 'plus', size: 13 }), t('connmgr.newShort')))

      return h('div', { className: 'dbs-section dbs-conn-section' }, header, body, footer)
    }
