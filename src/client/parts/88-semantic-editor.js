
    // ======================================================================
    // 11.9 语义层配套弹窗（第 51 轮，契约 §3.9）：建域 / 关联数据表 / AI 蒸馏
    //      外加 Markdown 小节导航的纯前端扫描（跳过 ``` 围栏代码块）
    // ======================================================================

    // 域 id 规则：前端同步校验，与后端 SEMANTIC_DOMAIN 校验保持同一份
    const SEMANTIC_DOMAIN_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/
    const SEMANTIC_ANCHOR_LINE_HEIGHT = 19
    // 标题跳到内容区最上方时留一点空隙，避免标题紧贴 textarea 上边缘
    const SEMANTIC_TOC_SCROLL_PAD = 4
    const SEMANTIC_DISTILL_LIMIT = 40
    const SEMANTIC_DISTILL_DEFAULT_HOURS = 24

    function semanticDomainValid(value) {
      return SEMANTIC_DOMAIN_PATTERN.test(String(value || '').trim())
    }

    /** Date → 'YYYY-MM-DD HH:mm:ss'（后端时间窗两种格式都接受）。 */
    function semanticStamp(date) {
      const pad = value => (Number(value) < 10 ? '0' + String(value) : String(value))
      return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
        + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds())
    }

    /**
     * 从 Markdown 原文按行扫 `#{1,4} 标题` → [{section,level,line,offset}]。
     * ``` / ~~~ 围栏代码块里的行一律不算标题（SQL 注释里的 # 不该进目录）。
     *
     * 单条缓存：正文是字符串，同一次编辑内其它 state 变化（提示条、保存态…）会重渲染，
     * 但 text 引用不变，直接复用上一次结果，避免每次按键都重扫几十 KB。
     */
    let SEMANTIC_ANCHOR_CACHE = { text: null, anchors: [] }
    function semanticParseAnchors(text) {
      const source = typeof text === 'string' ? text : ''
      if (SEMANTIC_ANCHOR_CACHE.text === source) return SEMANTIC_ANCHOR_CACHE.anchors
      const anchors = []
      let fence = ''
      let offset = 0
      const lines = source.split('\n')
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        const marker = line.replace(/^\s+/, '').slice(0, 3)
        if (marker === '```' || marker === '~~~') {
          if (!fence) fence = marker
          else if (fence === marker) fence = ''
          offset += line.length + 1
          continue
        }
        if (!fence) {
          const matched = /^(#{1,4})[ \t]+(.*)$/.exec(line)
          if (matched) {
            const title = matched[2].trim()
            anchors.push({
              section: title || t('semantic.sectionFallback', { line: index + 1 }),
              level: matched[1].length,
              line: index + 1,
              offset,
            })
          }
        }
        offset += line.length + 1
      }
      SEMANTIC_ANCHOR_CACHE = { text: source, anchors }
      return anchors
    }

    /** 关联数据表保存结果 → {tone,text}（ownerConflict 是软提示，不吞掉计数）。 */
    function semanticTablesResultText(data) {
      const payload = data || {}
      const added = Array.isArray(payload.added) ? payload.added : []
      const removed = Array.isArray(payload.removed) ? payload.removed : []
      const parts = []
      let tone = 'ok'
      if (added.length) parts.push(t('semantic.tables.added', { tables: added.join('、') }))
      if (removed.length) parts.push(t('semantic.tables.removed', { tables: removed.join('、') }))
      if (!parts.length) parts.push(t('semantic.tables.saved'))
      if (payload.ownerConflict && payload.ownerConflict.ownerDomain) {
        parts.push(t('semantic.tables.ownerConflict', {
          domain: String(payload.ownerConflict.ownerDomain),
        }))
        tone = 'bad'
      }
      if (payload.prefillError) {
        parts.push(String(payload.prefillError))
        tone = 'bad'
      }
      if (payload.indexOk === false) {
        parts.push(t('semantic.save.indexFail', { error: String(payload.indexError || '') }))
        tone = 'bad'
      }
      return { tone, text: parts.join(' ') }
    }

    // ---------------------------------------------------------------- 建域

    function SemanticDomainDialog(props) {
      const settings = props || {}
      const open = Boolean(settings.open)
      const [domain, setDomain] = useState('')
      const [title, setTitle] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const trimmed = String(domain || '').trim()
      const invalid = trimmed.length > 0 && !semanticDomainValid(trimmed)
      const canSubmit = semanticDomainValid(trimmed) && !busy

      useEffect(() => {
        if (open) return
        setDomain('')
        setTitle('')
        setBusy(false)
        setError(null)
      }, [open])

      const submit = () => {
        if (!canSubmit) return
        setBusy(true)
        setError(null)
        api.semanticDomainCreate({
          domain: trimmed,
          title: String(title || '').trim() || trimmed,
        }).then(data => {
          setBusy(false)
          if (settings.onCreated) settings.onCreated((data && data.domain) || null, data)
        }, failure => {
          setBusy(false)
          setError(failure)
        })
      }

      return h(Modal, {
        open,
        title: t('semantic.domain.newTitle'),
        onClose: settings.onClose,
        blocked: busy,
        blockedMessage: t('semantic.domain.creating'),
        focusKey: 'semantic-domain-new',
      },
      h('div', { className: 'dbs-form', 'data-dbs-testid': 'semantic-domain-dialog' },
        h('div', { className: 'dbs-form-grid' },
          h(Field, { label: t('semantic.domain.id'), hint: t('semantic.domain.idHint') },
            h('input', {
              className: 'dbs-input is-full',
              name: 'semanticDomain',
              value: domain,
              autoFocus: true,
              'aria-label': t('semantic.domain.id'),
              'data-dbs-testid': 'semantic-domain-id',
              onChange: event => setDomain(event && event.target ? event.target.value : ''),
            })),
          h(Field, { label: t('semantic.domain.titleField'), hint: t('semantic.domain.titleHint') },
            h('input', {
              className: 'dbs-input is-full',
              name: 'semanticDomainTitle',
              value: title,
              'aria-label': t('semantic.domain.titleField'),
              'data-dbs-testid': 'semantic-domain-title',
              onChange: event => setTitle(event && event.target ? event.target.value : ''),
            }))),
        invalid
          ? h('div', { className: 'dbs-form-test is-bad', role: 'alert' }, t('semantic.domain.invalid'))
          : null,
        h('p', { className: 'dbs-semantic-dialog-note' }, t('semantic.domain.willCreate')),
        error ? h(ErrorBar, { error, label: t('semantic.domain.createFail') }) : null,
        h('div', { className: 'dbs-form-actions' },
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', disabled: busy, onClick: settings.onClose,
          }, t('connmgr.cancel')),
          h('button', {
            type: 'button',
            className: 'dbs-btn is-primary is-small',
            'data-dbs-testid': 'semantic-domain-create',
            disabled: !canSubmit,
            onClick: submit,
          }, busy ? h(Spinner, null) : null,
          busy ? t('semantic.domain.creating') : t('semantic.domain.create')))))
    }

    // ---------------------------------------------------------------- 关联数据表

    function SemanticTablesDialog(props) {
      const settings = props || {}
      const open = Boolean(settings.open)
      const domain = String(settings.domain || '')
      const [connections, setConnections] = useState([])
      const [connectionId, setConnectionId] = useState('')
      const [databases, setDatabases] = useState([])
      const [database, setDatabase] = useState('')
      const [tables, setTables] = useState([])
      const [refs, setRefs] = useState({})
      // bound：后端按「该表是否与当前域登记」判定的结果（第 52 轮），不再自己比对维度
      const [bound, setBound] = useState({})
      const [boundMissing, setBoundMissing] = useState([])
      const [picked, setPicked] = useState({})
      const [loading, setLoading] = useState(false)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (!open) return undefined
        let alive = true
        api.connections().then(data => {
          if (!alive) return
          const list = (data && Array.isArray(data.connections) ? data.connections : [])
            .filter(item => item && item.kind !== 'redis')
          setConnections(list)
          setConnectionId(list.length ? String(list[0].id || '') : '')
        }, failure => {
          if (!alive || isAbort(failure)) return
          setError(failure)
        })
        return () => { alive = false }
      }, [open])

      useEffect(() => {
        if (!open || !connectionId) return undefined
        let alive = true
        api.databases(connectionId).then(data => {
          if (!alive) return
          const list = data && Array.isArray(data.databases) ? data.databases : []
          setDatabases(list)
          setDatabase(list.length ? String(list[0].name || '') : '')
        }, failure => {
          if (!alive || isAbort(failure)) return
          setError(failure)
        })
        return () => { alive = false }
      }, [open, connectionId])

      useEffect(() => {
        if (!open || !connectionId || !database) return undefined
        let alive = true
        setLoading(true)
        setError(null)
        const settle = promise => promise.then(
          data => ({ ok: true, data }),
          failure => ({ ok: false, error: failure }))
        Promise.all([
          settle(api.tables(connectionId, database)),
          settle(api.semanticTables({ connectionId, database, domain })),
        ]).then(pair => {
          if (!alive) return
          const listing = pair[0].ok && pair[0].data && Array.isArray(pair[0].data.tables)
            ? pair[0].data.tables
            : []
          const refRows = pair[1].ok && pair[1].data && Array.isArray(pair[1].data.tables)
            ? pair[1].data.tables
            : []
          const refMap = {}
          // boundMap：优先用后端 bound 字段；老后端没有该字段时退回 refs 里含当前域的判定
          const boundMap = {}
          refRows.forEach(row => {
            if (!row || !row.table) return
            const name = String(row.table)
            refMap[name] = Array.isArray(row.refs) ? row.refs : []
            boundMap[name] = typeof row.bound === 'boolean'
              ? row.bound
              : refMap[name].some(item => item && item.domain === domain)
          })
          const missing = pair[1].ok && pair[1].data && Array.isArray(pair[1].data.boundMissing)
            ? pair[1].data.boundMissing.map(name => String(name)).filter(Boolean)
            : []
          const nextPicked = {}
          listing.forEach(row => {
            const name = String((row && row.name) || '')
            if (!name) return
            if (boundMap[name]) nextPicked[name] = true
          })
          setTables(listing)
          setRefs(refMap)
          setBound(boundMap)
          setBoundMissing(missing)
          setPicked(nextPicked)
          setLoading(false)
          // 表清单或反查任一失败都如实上报，不静默吞掉
          const failure = pair[0].ok ? (pair[1].ok ? null : pair[1].error) : pair[0].error
          setError(failure && !isAbort(failure) ? failure : null)
        })
        return () => { alive = false }
      }, [open, connectionId, database, domain])

      const linkedHere = name => Boolean(bound[name])

      const toggle = (name, event) => {
        const on = Boolean(event && event.target && event.target.checked)
        setPicked(previous => {
          const next = Object.assign({}, previous)
          if (on) next[name] = true
          else delete next[name]
          return next
        })
      }

      const save = () => {
        if (busy || !domain || !connectionId || !database) return
        const add = []
        const remove = []
        tables.forEach(row => {
          const name = String((row && row.name) || '')
          if (!name) return
          const on = Boolean(picked[name])
          const linked = linkedHere(name)
          if (on && !linked) add.push({ connectionId, database, table: name })
          if (!on && linked) remove.push({ connectionId, database, table: name })
        })
        if (!add.length && !remove.length) {
          if (settings.onSaved) settings.onSaved({ added: [], removed: [] })
          return
        }
        setBusy(true)
        setError(null)
        api.semanticDomainTables({ domain, add, remove }).then(data => {
          setBusy(false)
          if (settings.onSaved) settings.onSaved(data || {})
        }, failure => {
          setBusy(false)
          setError(failure)
        })
      }

      const rows = tables.map(row => ({
        name: String((row && row.name) || ''),
        type: String((row && row.type) || ''),
      })).filter(row => row.name)
      rows.sort((left, right) => {
        const a = linkedHere(left.name) ? 0 : 1
        const b = linkedHere(right.name) ? 0 : 1
        if (a !== b) return a - b
        return left.name < right.name ? -1 : (left.name > right.name ? 1 : 0)
      })

      let listBody
      if (loading) {
        listBody = h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 4 }))
      } else if (!rows.length) {
        listBody = h('div', { className: 'dbs-semantic-note' },
          connections.length ? t('semantic.tables.empty') : t('masking.policy.noMysql'))
      } else {
        listBody = rows.map(row => {
          const refList = refs[row.name] || []
          return h('label', {
            key: 'semantic-table:' + row.name,
            className: 'dbs-semantic-table-row',
            'data-dbs-testid': 'semantic-table:' + row.name,
          },
          h('input', {
            type: 'checkbox',
            checked: Boolean(picked[row.name]),
            'aria-label': row.name,
            onChange: event => toggle(row.name, event),
          }),
          h('span', { className: 'dbs-semantic-table-name' }, row.name),
          row.type === 'view' ? h(Tag, null, t('semantic.tables.view')) : null,
          h('span', { className: 'dbs-semantic-table-refs' },
            refList.map((item, index) => h(Tag, {
              key: index,
              title: String((item && item.note) || ''),
            }, String((item && item.domain) || '')
              + '·' + (item && item.role === 'owner'
              ? t('semantic.tables.roleOwner')
              : t('semantic.tables.roleConsumer'))))))
        })
      }

      return h(Modal, {
        open,
        title: t('semantic.tables.title') + (domain ? '：' + domain : ''),
        onClose: settings.onClose,
        wide: true,
        blocked: busy,
        blockedMessage: t('semantic.tables.saving'),
        focusKey: 'semantic-tables:' + domain,
      },
      h('div', { className: 'dbs-form', 'data-dbs-testid': 'semantic-tables-dialog' },
        h('div', { className: 'dbs-semantic-tables-bar' },
          h(Field, { label: t('semantic.tables.connection') },
            h('select', {
              className: 'dbs-select',
              value: connectionId,
              'aria-label': t('semantic.tables.connection'),
              'data-dbs-testid': 'semantic-tables-connection',
              onChange: event => setConnectionId(event && event.target ? event.target.value : ''),
            }, connections.map(item => h('option', { key: item.id, value: item.id }, item.name)))),
          h(Field, { label: t('semantic.tables.database') },
            h('select', {
              className: 'dbs-select',
              value: database,
              'aria-label': t('semantic.tables.database'),
              'data-dbs-testid': 'semantic-tables-database',
              onChange: event => setDatabase(event && event.target ? event.target.value : ''),
            }, databases.map(item => h('option', { key: item.name, value: item.name }, item.name))))),
        h('p', { className: 'dbs-semantic-dialog-note' }, t('semantic.tables.hint')),
        h('div', { className: 'dbs-semantic-table-list' }, listBody),
        boundMissing.length
          ? h('p', { className: 'dbs-semantic-dialog-note', 'data-dbs-testid': 'semantic-tables-missing' },
            t('semantic.tables.boundMissing', {
              n: formatNumber(boundMissing.length),
              tables: boundMissing.slice(0, 8).join('、'),
            }))
          : null,
        error ? h(ErrorBar, { error, label: t('semantic.tables.fail') }) : null,
        h('div', { className: 'dbs-form-actions' },
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', disabled: busy, onClick: settings.onClose,
          }, t('connmgr.cancel')),
          h('button', {
            type: 'button',
            className: 'dbs-btn is-primary is-small',
            'data-dbs-testid': 'semantic-tables-save',
            disabled: busy || !rows.length,
            onClick: save,
          }, busy ? h(Spinner, null) : null,
          busy ? t('semantic.tables.saving') : t('semantic.tables.save')))))
    }

    // ---------------------------------------------------------------- AI 蒸馏

    function SemanticDistillDialog(props) {
      const settings = props || {}
      const open = Boolean(settings.open)
      const domains = Array.isArray(settings.domains) ? settings.domains : []
      const [domain, setDomain] = useState(String(settings.domain || ''))
      const [from, setFrom] = useState('')
      const [to, setTo] = useState('')
      const [running, setRunning] = useState(false)
      const [result, setResult] = useState(null)
      const [picks, setPicks] = useState({})
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [applying, setApplying] = useState(false)
      const [runs, setRuns] = useState({ loading: false, list: [], error: null })

      // 打开时把时间窗重置成「最近 24 小时」，并顺手读一次历史运行（失败只提示不白屏）
      useEffect(() => {
        if (!open) return undefined
        const now = new Date()
        setFrom(semanticStamp(new Date(now.getTime() - SEMANTIC_DISTILL_DEFAULT_HOURS * 3600 * 1000)))
        setTo(semanticStamp(now))
        let alive = true
        setRuns(previous => Object.assign({}, previous, { loading: true, error: null }))
        api.semanticDistillRuns({ limit: 5 }).then(data => {
          if (!alive) return
          setRuns({
            loading: false,
            list: data && Array.isArray(data.runs) ? data.runs : [],
            error: null,
          })
        }, failure => {
          if (!alive || isAbort(failure)) return
          setRuns({ loading: false, list: [], error: failure })
        })
        return () => { alive = false }
      }, [open])

      const run = () => {
        if (running) return
        setRunning(true)
        setError(null)
        setNotice(null)
        setResult(null)
        setPicks({})
        const payload = { limit: SEMANTIC_DISTILL_LIMIT }
        if (domain) payload.domain = domain
        if (from) payload.from = from
        if (to) payload.to = to
        api.semanticDistill(payload).then(data => {
          setRunning(false)
          const candidates = data && Array.isArray(data.candidates) ? data.candidates : []
          const nextPicks = {}
          candidates.forEach((item, index) => { nextPicks[index] = true })
          setResult({
            runId: String((data && data.runId) || ''),
            candidates,
            model: String((data && data.model) || ''),
          })
          setPicks(nextPicks)
          if (data && data.error) {
            setNotice({ tone: 'bad', text: t('semantic.distill.runError') + String(data.error) })
          }
        }, failure => {
          setRunning(false)
          setError(failure)
        })
      }

      const toggle = (index, event) => {
        const on = Boolean(event && event.target && event.target.checked)
        setPicks(previous => {
          const next = Object.assign({}, previous)
          if (on) next[index] = true
          else delete next[index]
          return next
        })
      }

      const apply = () => {
        if (applying || !result || !result.runId) return
        const picked = []
        result.candidates.forEach((item, index) => {
          if (!picks[index]) return
          picked.push({
            index,
            question: String((item && item.question) || ''),
            sql: String((item && item.sql) || ''),
            notes: String((item && item.notes) || ''),
          })
        })
        if (!picked.length) {
          setNotice({ tone: 'bad', text: t('semantic.distill.noPick') })
          return
        }
        setApplying(true)
        setNotice(null)
        api.semanticDistillApply({ runId: result.runId, picks: picked }).then(data => {
          setApplying(false)
          setNotice({
            tone: 'ok',
            text: t('semantic.distill.applied', {
              n: formatNumber((data && data.applied) || picked.length),
            }),
          })
          if (settings.onApplied) settings.onApplied(data || {}, result)
        }, failure => {
          setApplying(false)
          setError(failure)
        })
      }

      const candidates = result ? result.candidates : []
      const runSummary = runs.error
        ? t('semantic.distill.runsFail') + errorText(runs.error)
        : t('semantic.distill.runs', { n: formatNumber(runs.list.length) })

      let candidatesBody = null
      if (running) {
        candidatesBody = h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 3 }))
      } else if (result && !candidates.length) {
        candidatesBody = h('div', { className: 'dbs-semantic-note' }, t('semantic.distill.empty'))
      } else if (candidates.length) {
        candidatesBody = candidates.map((item, index) => h('div', {
          key: 'semantic-cand:' + index,
          className: 'dbs-semantic-cand',
          'data-dbs-testid': 'semantic-distill-candidate:' + index,
        },
        h('input', {
          type: 'checkbox',
          checked: Boolean(picks[index]),
          'aria-label': String((item && item.question) || ''),
          onChange: event => toggle(index, event),
        }),
        h('div', { className: 'dbs-semantic-cand-body' },
          h('div', { className: 'dbs-semantic-cand-q' },
            String((item && item.question) || t('semantic.distill.questionEmpty'))),
          item && item.sql
            ? h('pre', { className: 'dbs-semantic-cand-sql' }, String(item.sql))
            : null,
          h('div', { className: 'dbs-semantic-cand-meta' },
            h('span', null, t('semantic.distill.freq', {
              n: formatNumber((item && item.count) || 1),
            })),
            h('span', null, t('semantic.distill.tables', {
              tables: Array.isArray(item && item.tables) && item.tables.length
                ? item.tables.join('、')
                : t('common.dash'),
            })),
            item && item.notes
              ? h('span', null, String(item.notes))
              : null))))
      }

      return h(Modal, {
        open,
        title: t('semantic.distill.title'),
        onClose: settings.onClose,
        wide: true,
        blocked: applying,
        blockedMessage: t('semantic.distill.applying'),
        focusKey: 'semantic-distill',
      },
      h('div', { className: 'dbs-form', 'data-dbs-testid': 'semantic-distill-dialog' },
        h('div', { className: 'dbs-semantic-distill-head' },
          h(Field, { label: t('semantic.distill.domain') },
            h('select', {
              className: 'dbs-select',
              value: domain,
              'aria-label': t('semantic.distill.domain'),
              'data-dbs-testid': 'semantic-distill-domain',
              onChange: event => setDomain(event && event.target ? event.target.value : ''),
            },
            h('option', { value: '' }, t('semantic.distill.allDomains')),
            domains.map(item => h('option', {
              key: String(item.domain || ''),
              value: String(item.domain || ''),
            }, String(item.domain || ''))))),
          // 第 52 轮：hint 不再塞进 Field（会把这一列撑高、四个控件高度参次不齐），
          // 统一挪到整行下方作为一条说明文字
          h(Field, { label: t('semantic.distill.from') },
            h('input', {
              className: 'dbs-input',
              name: 'semanticDistillFrom',
              value: from,
              'aria-label': t('semantic.distill.from'),
              'data-dbs-testid': 'semantic-distill-from',
              onChange: event => setFrom(event && event.target ? event.target.value : ''),
            })),
          h(Field, { label: t('semantic.distill.to') },
            h('input', {
              className: 'dbs-input',
              name: 'semanticDistillTo',
              value: to,
              'aria-label': t('semantic.distill.to'),
              'data-dbs-testid': 'semantic-distill-to',
              onChange: event => setTo(event && event.target ? event.target.value : ''),
            })),
          h('button', {
            type: 'button',
            className: 'dbs-btn is-primary is-small',
            'data-dbs-testid': 'semantic-distill-run',
            disabled: running,
            onClick: run,
          }, running ? h(Spinner, null) : h(Icon, { name: 'play', size: 13 }),
          running ? t('semantic.distill.running') : t('semantic.distill.run'))),
        h('p', { className: 'dbs-semantic-dialog-note' }, t('semantic.distill.windowHint')),
        h('div', { className: 'dbs-semantic-dialog-note' }, runSummary),
        notice
          ? h('div', {
            className: 'dbs-notice ' + (notice.tone === 'ok' ? 'is-ok' : 'is-bad'),
            role: 'status',
          }, h('span', null, notice.text))
          : null,
        error ? h(ErrorBar, { error, label: t('semantic.distill.fail') }) : null,
        result && result.model
          ? h('div', { className: 'dbs-semantic-dialog-note' },
            t('semantic.distill.model', { model: result.model }))
          : null,
        result
          ? h('div', { className: 'dbs-semantic-distill-list' }, candidatesBody)
          : null,
        h('div', { className: 'dbs-form-actions' },
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', disabled: applying, onClick: settings.onClose,
          }, t('common.close')),
          h('button', {
            type: 'button',
            className: 'dbs-btn is-primary is-small',
            'data-dbs-testid': 'semantic-distill-apply',
            disabled: applying || !result || !result.runId,
            onClick: apply,
          }, applying ? h(Spinner, null) : null,
          applying ? t('semantic.distill.applying') : t('semantic.distill.apply')))))
    }
