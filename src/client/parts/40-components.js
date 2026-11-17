
    // ======================================================================
    // 4. 通用组件：图标 / 加载 / 错误条 / 复制按钮 / 标签
    // ======================================================================

    const ICONS = {
      database: [
        ['ellipse', { cx: 12, cy: 5.6, rx: 7, ry: 2.6 }],
        ['path', { d: 'M5 5.6v5.9c0 1.44 3.13 2.6 7 2.6s7-1.16 7-2.6V5.6' }],
        ['path', { d: 'M5 11.5v5.9c0 1.44 3.13 2.6 7 2.6s7-1.16 7-2.6v-5.9' }],
      ],
      layers: [
        ['path', { d: 'M12 3l9 5-9 5-9-5 9-5z' }],
        ['path', { d: 'M3 13l9 5 9-5' }],
      ],
      table: [
        ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
        ['path', { d: 'M3 9.5h18M9.5 9.5V20' }],
      ],
      view: [
        ['path', { d: 'M2.2 12S5.8 6 12 6s9.8 6 9.8 6-3.6 6-9.8 6-9.8-6-9.8-6z' }],
        ['circle', { cx: 12, cy: 12, r: 2.6 }],
      ],
      chevron: [['path', { d: 'M9 6l6 6-6 6' }]],
      refresh: [
        ['path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }],
        ['path', { d: 'M20.5 4.2v5h-5' }],
      ],
      play: [['path', { d: 'M8 5v14l11-7z', fill: 'currentColor', stroke: 'none' }]],
      copy: [
        ['rect', { x: 9, y: 9, width: 11, height: 11, rx: 2 }],
        ['path', { d: 'M5.5 15H4.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5v1' }],
      ],
      search: [
        ['circle', { cx: 11, cy: 11, r: 6.5 }],
        ['path', { d: 'M16 16l4.5 4.5' }],
      ],
      key: [
        ['circle', { cx: 8, cy: 15.5, r: 3.4 }],
        ['path', { d: 'M10.5 13L20 3.5M15.5 5L18 7.5M13.5 7.5L16 10' }],
      ],
      columns: [
        ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 2 }],
        ['path', { d: 'M9 4v16' }],
      ],
      list: [['path', { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }]],
      code: [['path', { d: 'M8.5 6.5L2.8 12l5.7 5.5M15.5 6.5l5.7 5.5-5.7 5.5' }]],
      warning: [
        ['path', { d: 'M12 3.4l9 16.2H3l9-16.2z' }],
        ['path', { d: 'M12 9.5v4.2M12 16.9h.01' }],
      ],
      plus: [['path', { d: 'M12 5v14M5 12h14' }]],
      sliders: [
        ['path', { d: 'M4 7h9M17 7h3M4 17h3M11 17h9' }],
        ['circle', { cx: 15, cy: 7, r: 2 }],
        ['circle', { cx: 9, cy: 17, r: 2 }],
      ],
      edit: [['path', { d: 'M4 20l4.6-1L19 8.6a2.1 2.1 0 0 0-3-3L5.6 16 4 20z' }]],
      trash: [
        ['path', { d: 'M4 7h16M9.5 7V4h5v3M6.5 7l.9 13h9.2l.9-13' }],
        ['path', { d: 'M10 11v6M14 11v6' }],
      ],
      spark: [
        ['path', { d: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z' }],
      ],
      close: [['path', { d: 'M6 6l12 12M18 6L6 18' }]],
      check: [['path', { d: 'M5 12.5l4.5 4.5L19 7' }]],
      file: [
        ['path', { d: 'M6 3h8l4 4v14H6z' }],
        ['path', { d: 'M14 3v4h4' }],
      ],
      save: [
        ['path', { d: 'M5 5h11l3 3v11H5z' }],
        ['path', { d: 'M8 5v5h7V5' }],
        ['path', { d: 'M8 19v-6h8v6' }],
      ],
      shield: [
        ['path', { d: 'M12 3l7.5 3v5.2c0 4.5-3 8.1-7.5 9.8-4.5-1.7-7.5-5.3-7.5-9.8V6L12 3z' }],
        ['path', { d: 'M8.8 12.1l2.1 2.1 4.3-4.4' }],
      ],
      lock: [
        ['rect', { x: 5, y: 10.5, width: 14, height: 9.5, rx: 2 }],
        ['path', { d: 'M8.2 10.5V7.4a3.8 3.8 0 0 1 7.6 0v3.1' }],
      ],
    }

    function Icon(props) {
      const settings = props || {}
      const name = settings.name || 'database'
      const size = settings.size || 16
      const nodes = ICONS[name] || ICONS.database
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', className: 'dbs-ic', style: { display: 'block', flex: 'none' },
      }, nodes.map((node, index) => h(node[0], Object.assign({ key: index }, node[1]))))
    }

    function Spinner(props) {
      return h('span', { className: 'dbs-spinner' + (props && props.large ? ' is-large' : ''), 'aria-hidden': 'true' })
    }

    function Tag(props) {
      const settings = props || {}
      const tone = settings.tone ? ' is-' + settings.tone : ''
      return h('span', { className: 'dbs-tag' + tone, title: settings.title }, settings.children)
    }

    /** × 形关闭按钮（提示统一可关，第 47 轮）：× 类仅无障碍标注——aria-label + title，无可见文字。 */
    function NoticeClose(props) {
      return h('button', {
        type: 'button',
        className: 'dbs-notice-close' + (props && props.tone ? ' is-' + props.tone : ''),
        'aria-label': t('common.close'),
        title: t('common.close'),
        onClick: props && props.onClose,
      }, '×')
    }

    function ErrorBar(props) {
      const settings = props || {}
      const message = errorText(settings.error)
      // 第 47 轮：错误条可手动关闭；同一条错误保持隐藏，新错误（引用变化）自动重新显示
      const [dismissed, setDismissed] = useState(false)
      const lastErrorRef = useRef(settings.error)
      useEffect(() => {
        if (lastErrorRef.current !== settings.error) {
          lastErrorRef.current = settings.error
          setDismissed(false)
        }
      }, [settings.error])
      if (!message || dismissed) return null
      const label = settings.label ? String(settings.label) : ''
      return h('div', { className: 'dbs-error' + (settings.compact ? ' is-compact' : ''), role: 'alert' },
        h(Icon, { name: 'warning', size: 15 }),
        h('span', { className: 'dbs-error-text' }, label ? label + message : message),
        settings.onRetry
          ? h('button', { type: 'button', className: 'dbs-btn is-ghost is-small', onClick: settings.onRetry }, t('common.retry'))
          : null,
        h(NoticeClose, { onClose: () => setDismissed(true) }))
    }

    function SkeletonList(props) {
      const rows = (props && props.rows) || 3
      const items = []
      for (let index = 0; index < rows; index += 1) {
        items.push(h('div', {
          key: index,
          className: 'dbs-skeleton',
          style: { width: (58 + (index * 13) % 34) + '%', marginTop: index === 0 ? 0 : 8 },
        }))
      }
      return h('div', { className: 'dbs-skeleton-list' }, items)
    }

    function CopyButton(props) {
      const settings = props || {}
      const [status, setStatus] = useState('idle')
      const timerRef = useRef(null)
      useEffect(() => () => {
        if (timerRef.current !== null) clearTimeout(timerRef.current)
      }, [])
      const onClick = useCallback(() => {
        let text = ''
        try {
          text = settings.getText ? settings.getText() : ''
        } catch (error) {
          text = ''
        }
        writeClipboard(text).then(ok => {
          setStatus(ok ? 'done' : 'fail')
          if (timerRef.current !== null) clearTimeout(timerRef.current)
          timerRef.current = setTimeout(() => setStatus('idle'), 1500)
        })
      }, [settings.getText])
      const label = status === 'done'
        ? t('results.copied')
        : (status === 'fail' ? t('results.copyFailed') : (settings.label || t('results.copy')))
      return h('button', { type: 'button', className: 'dbs-btn is-ghost is-small', onClick },
        h(Icon, { name: 'copy', size: 13 }), label)
    }

    function HealthBadge(props) {
      const health = (props && props.health) || { loading: true, data: null, error: null }
      const backend = health.data && health.data.backend ? health.data.backend : null
      const ready = !health.loading && !health.error && Boolean(backend && backend.ready)
      const down = !health.loading && (Boolean(health.error) || (backend !== null && !backend.ready))
      const className = 'dbs-health' + (ready ? ' is-ready' : (down ? ' is-down' : ''))
      const label = health.loading
        ? t('app.healthCheck')
        : (ready ? t('app.backendReady') : t('app.backendDown'))
      const title = backend && backend.error ? String(backend.error) : undefined
      return h('span', { className, title }, h('i', { className: 'dbs-dot' }), label)
    }

    function BackendBanner(props) {
      const health = props.health || {}
      // 第 47 轮：横幅可手动关闭；后端状态/错误变化时自动重新显示（头部 HealthBadge 仍常显状态）
      const loading = Boolean(health.loading)
      const error = health.error || null
      const banner = error
        ? { kind: 'error', title: t('app.healthErrorTitle'), body: t('app.healthErrorBody') + ' ' + t('app.healthErrorHint') }
        : null
      const backend = health.data && health.data.backend ? health.data.backend : null
      const down = !banner && !loading && backend && !backend.ready
        ? { kind: 'down', title: t('app.backendDownTitle'),
          body: (backend.error ? String(backend.error) + ' · ' : '') + t('app.backendDownHint') }
        : banner
      const bannerKey = down ? down.kind + ':' + String(health.error || (backend && backend.error) || '') : ''
      const [dismissed, setDismissed] = useState(false)
      const lastKeyRef = useRef(bannerKey)
      useEffect(() => {
        if (lastKeyRef.current !== bannerKey) {
          lastKeyRef.current = bannerKey
          setDismissed(false)
        }
      }, [bannerKey])
      if (loading || !down || dismissed) return null
      return h('div', { className: 'dbs-banner is-warn' },
        h(Icon, { name: 'warning', size: 15 }),
        h('div', { className: 'dbs-banner-body' },
          h('b', null, down.title),
          h('span', null, down.body)),
        h(NoticeClose, { onClose: () => setDismissed(true) }))
    }

    /** 面板内弹层：绝对定位在面板根部，不 portal、不碰全局 DOM；Esc / 点遮罩关闭。 */
    function Modal(props) {
      const settings = props || {}
      const panelRef = useRef(null)
      const open = Boolean(settings.open)
      const blocked = Boolean(settings.blocked)
      const requestClose = () => {
        if (blocked) return
        if (settings.onClose) settings.onClose()
      }
      useEffect(() => {
        if (!open) return
        const panel = panelRef.current
        if (!panel || typeof panel.querySelector !== 'function') return
        const target = panel.querySelector('input, textarea, select, button')
        if (target && typeof target.focus === 'function') target.focus()
      }, [open, settings.focusKey])
      if (!open) return null
      const onKeyDown = event => {
        if (event && event.key === 'Escape') {
          event.stopPropagation()
          requestClose()
        }
      }
      return h('div', {
        className: 'dbs-modal-mask' + (blocked ? ' is-blocked' : ''),
        onMouseDown: event => {
          if (event && event.target === event.currentTarget) requestClose()
        },
      },
      h('div', {
        ref: panelRef,
        className: 'dbs-modal' + (settings.wide ? ' is-wide' : '') + (blocked ? ' is-blocked' : ''),
        role: 'dialog',
        'aria-modal': 'true',
        'aria-busy': blocked ? 'true' : 'false',
        'aria-label': settings.title || '',
        tabIndex: -1,
        onKeyDown,
      },
      h('div', { className: 'dbs-modal-head' },
        h('span', { className: 'dbs-modal-title' }, settings.title),
        h('button', {
          type: 'button',
          className: 'dbs-iconbtn',
          'aria-label': t('connmgr.close'),
          title: t('connmgr.close'),
          disabled: blocked,
          onClick: requestClose,
        }, h(Icon, { name: 'close', size: 14 }))),
      h('div', { className: 'dbs-modal-body' }, settings.children,
        blocked
          ? h('div', { className: 'dbs-modal-block' },
            h(Spinner, { large: true }),
            h('div', { className: 'dbs-modal-block-text' }, settings.blockedMessage || t('masking.aiBlocking')))
          : null)))
    }

    /** 表单字段：label + 控件 + 可选提示。 */
    function Field(props) {
      const settings = props || {}
      return h('label', { className: 'dbs-field' + (settings.wide ? ' is-wide' : '') },
        h('span', { className: 'dbs-field-label' }, settings.label),
        settings.children,
        settings.hint ? h('span', { className: 'dbs-field-hint' }, settings.hint) : null)
    }
