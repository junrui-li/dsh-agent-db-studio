
    // ======================================================================
    // 11.8 语义层视图（契约 §3.9）：域 → 文件（内联标题树）→ 可编辑正文
    //      第 51 轮：dbs.db 为准；第 52 轮：顶栏目录改「DB 写出路径」，
    //      正文顶部的小节 chips 改成文件行下方内联展开的标题树（88 号 part 里解析）
    // ======================================================================

    function SemanticView() {
      const domainsState = useAsync(signal => api.semanticDomains(signal), [])
      const domainsData = domainsState.data || {}
      const indexInfo = domainsData.index || {}
      const domains = Array.isArray(domainsData.domains) ? domainsData.domains : []

      const [selectedDomain, setSelectedDomain] = useState('')
      const [selectedFile, setSelectedFile] = useState('')
      // 标题树里当前高亮的锚点（按行号，标题文字可能重名）
      const [activeAnchor, setActiveAnchor] = useState(0)
      const [refreshing, setRefreshing] = useState(false)
      const [notice, setNotice] = useState(null)
      const [exporting, setExporting] = useState(false)
      const [domainDialog, setDomainDialog] = useState(false)
      const [tablesDialog, setTablesDialog] = useState(false)
      const [distillDialog, setDistillDialog] = useState(false)
      const editorRef = useRef(null)

      // 编辑器正文：draft 是唯一真值来源（受控 textarea），dirty 表示与库里版本不一致
      const [draftText, setDraftText] = useState('')
      const [dirty, setDirty] = useState(false)
      const [saving, setSaving] = useState(false)
      const [saveState, setSaveState] = useState(null)
      const [conflict, setConflict] = useState(null)
      const [fileEpoch, setFileEpoch] = useState(0)
      const [fileState, setFileState] = useState({ loading: false, data: null, error: null })

      // DB 写出路径（POST /semantic/config）：初值取 exportDir，保存成功后同步生效目录
      const [dirDraft, setDirDraft] = useState('')
      const [savingDir, setSavingDir] = useState(false)
      const dirSyncedRef = useRef(false)
      useEffect(() => {
        if (dirSyncedRef.current) return
        if (typeof domainsData.exportDir !== 'string') return
        dirSyncedRef.current = true
        setDirDraft(domainsData.exportDir)
      }, [domainsData.exportDir])

      // 能否重建本地文件：没配写出路径时后端给 canRebuildFiles:false + rebuildHint 原话
      const canRebuildFiles = domainsData.canRebuildFiles === true
      const rebuildHint = typeof domainsData.rebuildHint === 'string' && domainsData.rebuildHint
        ? domainsData.rebuildHint
        : t('semantic.export.noTarget')
      const noTargetTitle = canRebuildFiles ? t('semantic.export.button') : rebuildHint

      // 域列表回来后合法化选中域（默认第一个）；切域时连带清掉文件选择
      useEffect(() => {
        if (!domains.length) return
        if (domains.some(item => item.domain === selectedDomain)) return
        setSelectedDomain(String(domains[0].domain || ''))
        setSelectedFile('')
        setActiveAnchor(0)
      }, [domains, selectedDomain])

      const activeDomain = domains.find(item => item.domain === selectedDomain) || null
      // fileList 现在是对象数组（file/kind/chars/revision/source）；兼容旧字符串形态
      const files = (activeDomain && Array.isArray(activeDomain.fileList) ? activeDomain.fileList : [])
        .map(item => (typeof item === 'string'
          ? { file: item, kind: '', chars: 0, revision: 0, source: '' }
          : {
            file: String((item && item.file) || ''),
            kind: String((item && item.kind) || ''),
            chars: Number((item && item.chars) || 0),
            revision: Number((item && item.revision) || 0),
            source: String((item && item.source) || ''),
          }))
        .filter(item => item.file)
      // files 每次渲染都是新数组，用拼出来的稳定 key 做 effect 依赖，避免空转
      const fileKey = files.map(item => item.file).join('|')
      useEffect(() => {
        if (!files.length) return
        if (files.some(item => item.file === selectedFile)) return
        setSelectedFile(files[0].file)
        setActiveAnchor(0)
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [fileKey, selectedFile])

      // 取全文（GET /semantic/file）：不再有 truncated / nextOffset 分页
      useEffect(() => {
        if (!selectedDomain || !selectedFile) {
          setFileState({ loading: false, data: null, error: null })
          setDraftText('')
          setDirty(false)
          setSaveState(null)
          setConflict(null)
          return undefined
        }
        const controller = new AbortController()
        let alive = true
        setFileState({ loading: true, data: null, error: null })
        setSaveState(null)
        setConflict(null)
        api.semanticFile({ domain: selectedDomain, file: selectedFile }, controller.signal).then(
          data => {
            if (!alive) return
            const payload = data || null
            setFileState({ loading: false, data: payload, error: null })
            setDraftText(payload && typeof payload.text === 'string' ? payload.text : '')
            setDirty(false)
            setActiveAnchor(0)
          },
          error => {
            if (!alive || isAbort(error)) return
            setFileState({ loading: false, data: null, error })
          })
        return () => {
          alive = false
          controller.abort()
        }
      }, [selectedDomain, selectedFile, fileEpoch])

      // 标题树数据：纯前端从当前正文按行扫（跳过 ``` 围栏代码块），不请求后端
      const anchors = semanticParseAnchors(draftText)

      // 标题树跳转：把光标挪到标题 offset，并让该标题出现在正文区最上方（留 4px 不贴边）
      const gotoAnchor = useCallback(anchor => {
        if (!anchor) return
        setActiveAnchor(Number(anchor.line) || 0)
        const node = editorRef.current
        if (!node) return
        const offset = Number(anchor.offset) || 0
        if (typeof node.focus === 'function') node.focus()
        if (typeof node.setSelectionRange === 'function') node.setSelectionRange(offset, offset)
        if (typeof anchor.line === 'number' && anchor.line > 0) {
          try {
            node.scrollTop = Math.max(
              0,
              (anchor.line - 1) * SEMANTIC_ANCHOR_LINE_HEIGHT - SEMANTIC_TOC_SCROLL_PAD,
            )
          } catch (error) {
            /* 只读节点忽略 */
          }
        }
      }, [])

      // 手动全量刷新：POST /semantic/refresh 强制重建索引，成功后重拉域列表
      const runRefresh = useCallback(() => {
        if (refreshing) return
        setRefreshing(true)
        setNotice(null)
        api.semanticRefresh().then(
          data => {
            setRefreshing(false)
            if (data && data.configured === false) {
              setNotice({ tone: 'bad', text: t('semantic.emptyNotConfigured') })
              return
            }
            setNotice({
              tone: 'ok',
              text: t('semantic.refreshDone', {
                domains: formatNumber(data && data.domains),
                ms: formatNumber(data && data.tookMs),
              }),
            })
            domainsState.reload()
          },
          error => {
            setRefreshing(false)
            if (error && error.code === 'SEMANTIC_INDEX_BUILDING') {
              setNotice({ tone: 'bad', text: t('semantic.refreshBuilding') })
            } else {
              setNotice({ tone: 'bad', text: t('semantic.refreshFail') + errorText(error) })
            }
          })
      }, [refreshing, domainsState.reload])

      // 保存并重建索引：POST /semantic/file/save（expectedRevision 做乐观并发）
      const saveFile = useCallback(force => {
        if (saving || !selectedDomain || !selectedFile) return
        const current = fileState.data || {}
        const payload = { domain: selectedDomain, file: selectedFile, text: draftText }
        if (force) payload.force = true
        else if (current.revision !== undefined && current.revision !== null) {
          payload.expectedRevision = current.revision
        }
        setSaving(true)
        setConflict(null)
        api.semanticFileSave(payload).then(
          data => {
            setSaving(false)
            const saved = data || {}
            setDirty(false)
            setFileState(previous => Object.assign({}, previous, {
              data: Object.assign({}, previous.data || {}, {
                revision: saved.revision !== undefined && saved.revision !== null
                  ? saved.revision
                  : previous.data && previous.data.revision,
              }),
            }))
            if (saved.writeError) {
              setSaveState({
                tone: 'bad',
                text: t('semantic.save.writeFail', { error: String(saved.writeError) }),
              })
            } else if (saved.indexOk === false) {
              setSaveState({
                tone: 'bad',
                text: t('semantic.save.indexFail', { error: String(saved.indexError || '') }),
              })
            } else if (saved.writeNoTarget) {
              // 没配「DB 写出路径」：DB 已存下，但重建不出本地文件（不是错误，用 warn 语气）
              setSaveState({ tone: 'warn', text: t('semantic.save.writeNoTarget') })
            } else {
              setSaveState({ tone: 'ok', text: t('semantic.save.ok') })
            }
            domainsState.reload()
          },
          error => {
            setSaving(false)
            if (error && error.code === 'SEMANTIC_FILE_CONFLICT') {
              setConflict(error)
            } else if (error && error.code === 'SEMANTIC_FILE_TOO_LARGE') {
              setSaveState({
                tone: 'bad',
                text: t('semantic.save.tooLarge') + errorText(error),
              })
            } else {
              setSaveState({ tone: 'bad', text: t('semantic.save.fail') + errorText(error) })
            }
          })
      }, [saving, selectedDomain, selectedFile, draftText, fileState.data, domainsState.reload])

      // 保存「DB 写出路径」并按需导入：POST /semantic/config {exportDir, import:true}
      const runSaveDir = useCallback(() => {
        if (savingDir) return
        setSavingDir(true)
        setNotice(null)
        api.semanticConfig({
          exportDir: String(dirDraft || '').trim(),
          import: true,
        }).then(
          data => {
            setSavingDir(false)
            const payload = data || {}
            if (typeof payload.exportDir === 'string') setDirDraft(payload.exportDir)
            if (payload.importError) {
              setNotice({ tone: 'bad', text: t('semantic.import.fail') + String(payload.importError) })
            } else {
              const parts = [t('semantic.saveDone', { domains: formatNumber(payload.domains) })]
              if (payload.imported) {
                const imported = payload.imported || {}
                parts.push(t('semantic.import.done', {
                  domains: formatNumber(imported.domains),
                  files: formatNumber(imported.files),
                }))
              }
              setNotice({ tone: 'ok', text: parts.join(' · ') })
            }
            domainsState.reload()
          },
          error => {
            setSavingDir(false)
            if (error && error.code === 'SEMANTIC_INDEX_BUILDING') {
              setNotice({ tone: 'bad', text: t('semantic.refreshBuilding') })
            } else if (error && error.status === 400) {
              setNotice({ tone: 'bad', text: errorText(error) })
            } else {
              setNotice({ tone: 'bad', text: t('semantic.saveFail') + errorText(error) })
            }
          })
      }, [savingDir, dirDraft, domainsState.reload])

      // 手动重建成本地文件：POST /semantic/export {domain}（没配写出路径 → 400 SEMANTIC_EXPORT_DIR_MISSING）
      const runExport = useCallback(() => {
        if (exporting || !selectedDomain) return
        setExporting(true)
        setNotice(null)
        api.semanticExport({ domain: selectedDomain }).then(
          data => {
            setExporting(false)
            const payload = data || {}
            const wrote = Array.isArray(payload.wrote) ? payload.wrote : []
            setNotice({
              tone: 'ok',
              text: t('semantic.export.done', {
                n: formatNumber(wrote.length),
                dir: String(payload.dir || t('common.dash')),
              }),
            })
          },
          error => {
            setExporting(false)
            if (error && error.code === 'SEMANTIC_EXPORT_DIR_MISSING') {
              setNotice({ tone: 'bad', text: t('semantic.export.missingDir') })
            } else {
              setNotice({ tone: 'bad', text: t('semantic.export.fail') + errorText(error) })
            }
          })
      }, [exporting, selectedDomain])

      const stale = indexInfo.stale === true
      const statusLine = indexInfo.ready
        ? t('semantic.status.ready', {
          time: String(indexInfo.builtAt || t('common.dash')),
          assets: formatNumber(indexInfo.assets),
          sections: formatNumber(indexInfo.sections),
        })
        : t('semantic.status.noIndex')

      const head = h('div', { className: 'dbs-view-head' },
        h('div', { className: 'dbs-view-heading' },
          h('div', { className: 'dbs-view-title' }, t('semantic.title')),
          h('div', { className: 'dbs-view-sub' }, statusLine)),
        h('span', { className: 'dbs-grow' }),
        stale ? h(Tag, { tone: 'warn', title: t('semantic.status.stale') }, t('semantic.status.stale')) : null,
        h('button', {
          type: 'button',
          className: 'dbs-btn is-small',
          'data-dbs-testid': 'semantic-distill-open',
          onClick: () => setDistillDialog(true),
        }, h(Icon, { name: 'spark', size: 13 }), t('semantic.distill.open')),
        h('button', {
          type: 'button',
          className: 'dbs-btn is-small',
          'data-dbs-testid': 'semantic-refresh',
          onClick: runRefresh,
          disabled: refreshing,
        }, h(Icon, { name: 'refresh', size: 13 }),
        refreshing ? t('semantic.refreshing') : t('semantic.refresh')))

      // 目录行：「DB 写出路径」（DB 内容 → 本地文件的重建目标）+「保存并导入」
      const dirRow = h('div', { className: 'dbs-semantic-dir-wrap' },
        h('div', { className: 'dbs-semantic-dir' },
          h('span', { className: 'dbs-muted dbs-semantic-dir-label' }, t('semantic.dirLabel')),
          h('input', {
            className: 'dbs-input dbs-semantic-dir-input',
            value: dirDraft,
            placeholder: t('semantic.dirPlaceholder'),
            'aria-label': t('semantic.dirLabel'),
            'data-dbs-testid': 'semantic-dir-input',
            onChange: event => setDirDraft(event && event.target ? event.target.value : ''),
          }),
          h('button', {
            type: 'button',
            className: 'dbs-btn is-primary is-small',
            'data-dbs-testid': 'semantic-dir-save',
            onClick: runSaveDir,
            disabled: savingDir,
          }, h(Icon, { name: 'check', size: 13 }),
          savingDir ? t('semantic.saving') : t('semantic.saveAndImport'))),
        // 没配写出路径：warn 样式的一条警示（不是 error 红字），文案用后端 rebuildHint 原话
        canRebuildFiles
          ? null
          : h('div', {
            className: 'dbs-semantic-dir-warn',
            role: 'status',
            'data-dbs-testid': 'semantic-dir-warn',
          }, h(Icon, { name: 'warning', size: 13 }), h('span', null, rebuildHint)))

      // 域区右上角只剩 + 新建（导入唯一入口是顶部「保存并导入」）
      const domainActions = h('div', { className: 'dbs-semantic-head-actions' },
        h('button', {
          type: 'button',
          className: 'dbs-iconbtn',
          'data-dbs-testid': 'semantic-domain-new',
          title: t('semantic.domain.newTitle'),
          'aria-label': t('semantic.domain.newTitle'),
          onClick: () => setDomainDialog(true),
        }, h(Icon, { name: 'plus', size: 14 })))

      let main
      if (domainsState.error) {
        main = h('div', { className: 'dbs-pad' },
          h(ErrorBar, { error: domainsState.error, label: t('semantic.domainsError'), onRetry: domainsState.reload }))
      } else if (domainsState.loading && !domainsState.data) {
        main = h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 6 }))
      } else if (domainsData.configured === false || !domains.length) {
        // 后端在「还没有业务域」时会带一句引导文案（error），有就原样展示，别再另写一套
        const emptyHint = typeof domainsData.error === 'string' && domainsData.error
          ? domainsData.error
          : (domainsData.configured === false
            ? t('semantic.emptyNotConfiguredHint')
            : t('semantic.emptyNoDomainsHint'))
        main = h('div', { className: 'dbs-empty' },
          h(Icon, { name: 'spark', size: 26 }),
          h('div', { className: 'dbs-empty-title' },
            domainsData.configured === false
              ? t('semantic.emptyNotConfigured')
              : t('semantic.emptyNoDomains')),
          h('p', { className: 'dbs-empty-text' }, emptyHint),
          h('div', { className: 'dbs-empty-actions' }, domainActions))
      } else {
        const domainRows = domains.map(item => {
          const name = String(item.domain || '')
          const active = name === selectedDomain
          const origin = String(item.origin || 'system')
          return h('button', {
            key: 'semantic-domain:' + name,
            type: 'button',
            className: 'dbs-semantic-row' + (active ? ' is-on' : ''),
            title: String(item.title || name),
            onClick: () => {
              if (active) return
              setSelectedDomain(name)
              setSelectedFile('')
              setActiveAnchor(0)
            },
          },
          h(Icon, { name: 'layers', size: 13 }),
          h('span', { className: 'dbs-semantic-row-name' }, name),
          h(Tag, {
            title: origin === 'doc' ? t('semantic.origin.docHint') : t('semantic.origin.systemHint'),
          }, origin === 'doc' ? t('semantic.origin.doc') : t('semantic.origin.system')),
          h('span', { className: 'dbs-semantic-row-sub' }, formatNumber(item.files)))
        })
        // 文件行 + 该文件的内联标题树（只有当前选中的文件展开，同一时刻最多一棵树）
        const fileRows = files.map(item => {
          const name = item.file
          const active = name === selectedFile
          const display = name.indexOf('/') >= 0 ? name.slice(name.lastIndexOf('/') + 1) : name
          const row = h('button', {
            key: 'semantic-file:' + name,
            type: 'button',
            className: 'dbs-semantic-row' + (active ? ' is-on' : ''),
            title: name,
            onClick: () => {
              if (active) return
              setSelectedFile(name)
              setActiveAnchor(0)
            },
          },
          h(Icon, { name: 'file', size: 13 }),
          h('span', { className: 'dbs-semantic-row-name' }, display),
          item.kind ? h('span', { className: 'dbs-semantic-row-sub' }, item.kind) : null)
          if (!active) {
            return h('div', { key: 'semantic-file-group:' + name, className: 'dbs-semantic-file-group' }, row)
          }
          const tocNodes = anchors.map(anchor => h('button', {
            key: 'semantic-toc:' + anchor.line,
            type: 'button',
            className: 'dbs-semantic-toc-item is-level-' + anchor.level
              + (Number(anchor.line) === activeAnchor ? ' is-on' : ''),
            title: t('semantic.tocItemTitle', { level: anchor.level, line: anchor.line }),
            'data-dbs-testid': 'semantic-toc:' + anchor.line,
            onClick: () => gotoAnchor(anchor),
          }, String(anchor.section || '')))
          return h('div', { key: 'semantic-file-group:' + name, className: 'dbs-semantic-file-group' },
            row,
            h('div', { className: 'dbs-semantic-toc', 'data-dbs-testid': 'semantic-toc' },
              tocNodes.length
                ? tocNodes
                : h('div', { className: 'dbs-semantic-note' }, t('semantic.tocEmpty'))))
        })

        let content
        if (fileState.error) {
          content = h('div', { className: 'dbs-pad' },
            h(ErrorBar, {
              error: fileState.error,
              label: t('semantic.assetError'),
              onRetry: () => setFileEpoch(value => value + 1),
            }))
        } else if (fileState.loading && !fileState.data) {
          content = h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 5 }))
        } else if (!selectedFile) {
          content = h('div', { className: 'dbs-empty is-small' },
            h(Icon, { name: 'view', size: 18 }),
            h('div', { className: 'dbs-empty-text' }, t('semantic.pickFile')))
        } else {
          const revision = fileState.data && fileState.data.revision !== undefined
            ? fileState.data.revision
            : null
          content = h('div', { className: 'dbs-semantic-editor-wrap' },
            conflict
              ? h('div', { className: 'dbs-semantic-conflict', role: 'alert' },
                h(Icon, { name: 'warning', size: 14 }),
                h('span', { className: 'dbs-grow' }, t('semantic.save.conflictHint')),
                h('button', {
                  type: 'button',
                  className: 'dbs-btn is-small',
                  'data-dbs-testid': 'semantic-file-reload',
                  onClick: () => {
                    setConflict(null)
                    setFileEpoch(value => value + 1)
                  },
                }, t('semantic.save.reload')),
                h('button', {
                  type: 'button',
                  className: 'dbs-btn is-danger is-small',
                  'data-dbs-testid': 'semantic-file-force',
                  disabled: saving,
                  onClick: () => saveFile(true),
                }, t('semantic.save.overwrite')))
              : null,
            h('textarea', {
              ref: editorRef,
              className: 'dbs-semantic-editor',
              value: draftText,
              spellCheck: false,
              placeholder: t('semantic.editorPlaceholder'),
              'aria-label': t('semantic.title'),
              'data-dbs-testid': 'semantic-file-editor',
              onChange: event => {
                setDraftText(event && event.target ? String(event.target.value) : '')
                setDirty(true)
              },
              onKeyDown: event => {
                if (!event) return
                const key = String(event.key || '')
                const modifier = event.ctrlKey || event.metaKey
                if (!modifier) return
                if (key === 's' || key === 'S' || key === 'Enter') {
                  if (event.preventDefault) event.preventDefault()
                  saveFile(false)
                }
              },
            }),
            h('div', { className: 'dbs-semantic-foot' },
              h('span', { className: 'dbs-semantic-foot-info', 'data-dbs-testid': 'semantic-file-chars' },
                t('semantic.save.chars', { n: formatNumber(draftText.length) })),
              revision === null
                ? null
                : h('span', { className: 'dbs-semantic-foot-info', 'data-dbs-testid': 'semantic-file-revision' },
                  t('semantic.save.revision', { n: formatNumber(revision) })),
              dirty
                ? h('span', { className: 'dbs-semantic-dirty', 'data-dbs-testid': 'semantic-file-dirty' },
                  t('semantic.save.dirty'))
                : null,
              saveState
                ? h('span', {
                  className: 'dbs-semantic-save-state is-'
                    + (saveState.tone === 'bad' ? 'bad' : (saveState.tone === 'warn' ? 'warn' : 'ok')),
                  role: 'status',
                  'data-dbs-testid': 'semantic-file-save-state',
                }, saveState.text)
                : null,
              h('span', { className: 'dbs-grow' }),
              h('span', { className: 'dbs-semantic-foot-info' }, t('semantic.save.shortcut')),
              h('button', {
                type: 'button',
                className: 'dbs-btn is-primary is-small',
                'data-dbs-testid': 'semantic-file-save',
                disabled: saving || !dirty,
                onClick: () => saveFile(false),
              }, h(Icon, { name: 'save', size: 13 }),
              saving ? t('semantic.save.saving') : t('semantic.save.button'))))
        }

        main = h('div', { className: 'dbs-semantic' },
          h('div', { className: 'dbs-semantic-pane dbs-semantic-domains' },
            h('div', { className: 'dbs-section-head' },
              h('span', { className: 'dbs-section-title' },
                t('semantic.domains') + '（' + formatNumber(domains.length) + '）'),
              h('span', { className: 'dbs-grow' }),
              domainActions),
            h('div', { className: 'dbs-semantic-list' }, domainRows)),
          h('div', { className: 'dbs-semantic-pane dbs-semantic-files' },
            h('div', { className: 'dbs-section-head' },
              h('span', { className: 'dbs-section-title' },
                t('semantic.files') + '（' + formatNumber(files.length) + '）'),
              h('span', { className: 'dbs-grow' }),
              h('button', {
                type: 'button',
                className: 'dbs-iconbtn',
                'data-dbs-testid': 'semantic-domain-export',
                title: noTargetTitle,
                'aria-label': t('semantic.export.button'),
                disabled: !selectedDomain || !canRebuildFiles || exporting,
                onClick: runExport,
              }, h(Icon, { name: 'save', size: 13 })),
              h('button', {
                type: 'button',
                className: 'dbs-btn is-small',
                'data-dbs-testid': 'semantic-tables-open',
                disabled: !selectedDomain,
                onClick: () => setTablesDialog(true),
              }, h(Icon, { name: 'table', size: 13 }), t('semantic.tables.open'))),
            files.length
              ? h('div', { className: 'dbs-semantic-list' }, fileRows)
              : h('div', { className: 'dbs-semantic-note' }, t('common.dash'))),
          // 正文区顶部不再有小节 chips：目录在文件名下方的标题树里
          h('div', { className: 'dbs-semantic-main' }, content))
      }

      return h('div', { className: 'dbs-view', 'data-dbs-testid': 'semantic-view' },
        head,
        dirRow,
        notice
          ? h('div', {
            className: 'dbs-notice ' + (notice.tone === 'ok' ? 'is-ok' : 'is-bad'),
            role: 'status',
          },
          h('span', null, notice.text),
          h(NoticeClose, { onClose: () => setNotice(null) }))
          : null,
        main,
        h(SemanticDomainDialog, {
          open: domainDialog,
          onClose: () => setDomainDialog(false),
          onCreated: created => {
            setDomainDialog(false)
            const name = String((created && created.domain) || '')
            setNotice({
              tone: 'ok',
              text: t('semantic.domain.created', { domain: name || t('common.dash') }),
            })
            domainsState.reload()
            if (name) {
              setSelectedDomain(name)
              setSelectedFile('')
              setActiveAnchor(0)
            }
          },
        }),
        h(SemanticTablesDialog, {
          open: tablesDialog,
          domain: selectedDomain,
          onClose: () => setTablesDialog(false),
          onSaved: data => {
            setTablesDialog(false)
            setNotice(semanticTablesResultText(data))
            domainsState.reload()
          },
        }),
        h(SemanticDistillDialog, {
          open: distillDialog,
          domains,
          domain: selectedDomain,
          onClose: () => setDistillDialog(false),
          onApplied: () => {
            domainsState.reload()
            setFileEpoch(value => value + 1)
          },
        }))
    }
