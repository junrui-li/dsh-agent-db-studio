

    function ConnectionsDialog(props) {
      const open = Boolean(props.open)
      const editing = props.editing || null
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(null)
      const [error, setError] = useState(null)
      const [testResult, setTestResult] = useState(null)
      const [aiAnalyzing, setAiAnalyzing] = useState(false)

      useEffect(() => {
        if (!open) {
          setDraft(null)
          setBusy(null)
          setError(null)
          setTestResult(null)
          setAiAnalyzing(false)
          return
        }
        setDraft(editing ? connectionDraftFrom(editing) : emptyConnectionDraft())
        setBusy(null)
        setError(null)
        setTestResult(null)
        setAiAnalyzing(false)
      }, [open, editing])

      // 策略树保存后：用后端返回的最新 connection.masking 回填表单草稿（保留 enabled/keywords/其他字段）
      useEffect(() => {
        const refresh = props.refreshConnection
        if (!refresh || !refresh.id) return
        setDraft(previous => {
          if (!previous || previous.id !== refresh.id) return previous
          return Object.assign({}, previous, { masking: maskingDraftFrom(refresh) })
        })
      }, [props.refreshConnection])

      if (!draft) return null
      const update = patch => {
        if (aiAnalyzing) return
        setDraft(previous => Object.assign({}, previous, patch))
      }
      const isEdit = Boolean(draft.id)

      const changeKind = kind => {
        if (aiAnalyzing) return
        const next = kind === 'redis' ? 'redis' : 'mysql'
        setDraft(previous => {
          const oldDefault = previous.kind === 'redis' ? 6379 : 3306
          const port = !previous.port || Number(previous.port) === oldDefault
            ? (next === 'redis' ? 6379 : 3306)
            : previous.port
          return Object.assign({}, previous, {
            kind: next,
            port,
            database: next === 'redis' && !previous.database ? '0' : previous.database,
          })
        })
      }

      const runTest = () => {
        if (busy || aiAnalyzing) return
        const message = validateConnectionDraft(draft)
        if (message) {
          setError(new Error(message))
          return
        }
        setBusy('test')
        setError(null)
        setTestResult(null)
        // 编辑旧连接且没填新密码：用 id 让后端用已保存的密码测试
        const payload = isEdit && !draft.password && !draft.clearPassword
          ? { id: draft.id }
          : { connection: buildConnectionPayload(draft) }
        api.testConnection(payload).then(data => {
          setBusy(null)
          setTestResult(data || { ok: false, error: '' })
        }, failure => {
          setBusy(null)
          setTestResult({ ok: false, error: errorText(failure) })
        })
      }

      const save = () => {
        if (busy || aiAnalyzing) return
        const message = validateConnectionDraft(draft)
        if (message) {
          setError(new Error(message))
          return
        }
        setBusy('save')
        setError(null)
        api.saveConnection(buildConnectionPayload(draft)).then(data => {
          setBusy(null)
          const saved = (data && data.connection) || {}
          if (props.onSaved) props.onSaved(saved, !isEdit)
        }, failure => {
          setBusy(null)
          setError(failure instanceof Error ? failure : new Error(String(failure)))
        })
      }

      const form = h('div', { className: 'dbs-form' },
        h('div', { className: 'dbs-form-grid' },
          h(Field, { label: t('connmgr.fieldKind') },
            h('select', {
              className: 'dbs-select is-full', name: 'kind', value: draft.kind, 'aria-label': t('connmgr.fieldKind'),
              disabled: aiAnalyzing,
              onChange: event => changeKind(event.target.value),
            },
            h('option', { value: 'mysql' }, t('connection.mysql')),
            h('option', { value: 'redis' }, t('connection.redis')))),
          h(Field, { label: t('connmgr.fieldName') },
            h('input', {
              className: 'dbs-input is-full', name: 'name', value: draft.name, 'aria-label': t('connmgr.fieldName'),
              disabled: aiAnalyzing,
              placeholder: 'demo_db 测试库', autoFocus: true,
              onChange: event => update({ name: event.target.value }),
            })),
          h(Field, { label: t('connmgr.fieldHost') },
            h('input', {
              className: 'dbs-input is-full', name: 'host', value: draft.host, 'aria-label': t('connmgr.fieldHost'),
              disabled: aiAnalyzing,
              placeholder: '127.0.0.1',
              onChange: event => update({ host: event.target.value }),
            })),
          h(Field, { label: t('connmgr.fieldPort') },
            h('input', {
              className: 'dbs-input is-full', name: 'port', value: String(draft.port), inputMode: 'numeric',
              disabled: aiAnalyzing,
              'aria-label': t('connmgr.fieldPort'),
              onChange: event => update({ port: event.target.value }),
            })),
          h(Field, { label: t('connmgr.fieldUser') },
            h('input', {
              className: 'dbs-input is-full', name: 'user', value: draft.user, 'aria-label': t('connmgr.fieldUser'),
              disabled: aiAnalyzing,
              onChange: event => update({ user: event.target.value }),
            })),
          h(Field, {
            label: t('connmgr.fieldPassword'),
            hint: isEdit ? (draft.hasPassword ? t('connmgr.passwordKeep') : t('connmgr.hasPassword')) : t('connmgr.passwordNew'),
          },
          h('input', {
            className: 'dbs-input is-full', name: 'password', type: 'password', value: draft.password,
            'aria-label': t('connmgr.fieldPassword'),
            placeholder: isEdit ? t('connmgr.passwordKeep') : t('connmgr.passwordNew'),
            disabled: draft.clearPassword || aiAnalyzing,
            onChange: event => update({ password: event.target.value }),
          })),
          h(Field, {
            label: draft.kind === 'redis' ? t('connmgr.fieldDatabase') : t('connmgr.fieldDatabase'),
            hint: t('connmgr.databaseHint'),
          },
          h('input', {
            className: 'dbs-input is-full', name: 'database', value: draft.database,
            disabled: aiAnalyzing,
            'aria-label': t('connmgr.fieldDatabase'),
            onChange: event => update({ database: event.target.value }),
          })),
          h(Field, { label: t('connmgr.fieldTimeout') },
            h('input', {
              className: 'dbs-input is-full', name: 'timeout', value: String(draft.timeout), inputMode: 'numeric',
              disabled: aiAnalyzing,
              'aria-label': t('connmgr.fieldTimeout'),
              onChange: event => update({ timeout: event.target.value }),
            })),
          h(Field, { label: t('connmgr.fieldMaxRows') },
            h('input', {
              className: 'dbs-input is-full', name: 'maxRows', value: String(draft.maxRows), inputMode: 'numeric',
              disabled: aiAnalyzing,
              'aria-label': t('connmgr.fieldMaxRows'),
              onChange: event => update({ maxRows: event.target.value }),
            })),
          draft.kind === 'mysql'
            ? h('div', { className: 'dbs-form-wide' },
              h(MaskingEditor, {
                connectionId: draft.id || '',
                database: draft.database || '',
                masking: draft.masking || emptyMaskingDraft(),
                locked: aiAnalyzing,
                onChange: nextMasking => update({ masking: nextMasking }),
                onAnalyzingChange: setAiAnalyzing,
              }))
            : null),
        h('div', { className: 'dbs-form-check' },
          h('label', { className: 'dbs-check' },
            h('input', {
              type: 'checkbox', name: 'readonly', checked: draft.readonly,
              disabled: aiAnalyzing,
              onChange: event => update({ readonly: event.target.checked }),
            }),
            h('span', null, t('connmgr.fieldReadonly'))),
          isEdit && draft.hasPassword
            ? h('label', { className: 'dbs-check' },
              h('input', {
                type: 'checkbox', name: 'clearPassword', checked: draft.clearPassword,
                disabled: aiAnalyzing,
                onChange: event => update({ clearPassword: event.target.checked }),
              }),
              h('span', null, t('connmgr.clearPassword')))
            : null),
        error ? h(ErrorBar, { error }) : null,
        testResult
          ? h('div', { className: 'dbs-form-test' + (testResult.ok ? ' is-ok' : ' is-bad') },
            testResult.ok
              ? t('connmgr.testOk', {
                ms: formatNumber(testResult.elapsedMs || 0),
                version: testResult.version ? ' · ' + testResult.version : '',
              })
              : t('connmgr.testFail', { message: String(testResult.error || '') }))
          : null,
        h('div', { className: 'dbs-form-actions' },
          h('button', {
            type: 'button', className: 'dbs-btn is-small', onClick: runTest, disabled: Boolean(busy) || aiAnalyzing,
          }, busy === 'test' ? h(Spinner, null) : null, busy === 'test' ? t('connmgr.testing') : t('connmgr.testButton')),
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', onClick: () => { if (!aiAnalyzing) props.onClose() }, disabled: Boolean(busy) || aiAnalyzing,
          }, t('connmgr.cancel')),
          h('button', {
            type: 'button', className: 'dbs-btn is-primary is-small', onClick: save, disabled: Boolean(busy) || aiAnalyzing,
          }, busy === 'save' ? h(Spinner, null) : null,
          busy === 'save' ? t('connmgr.saving') : t('connmgr.save'))))

      return h(Modal, {
        open,
        title: isEdit ? t('connmgr.editTitle') : t('connmgr.newTitle'),
        onClose: props.onClose,
        focusKey: isEdit ? draft.id : 'new',
        wide: true,
        blocked: aiAnalyzing,
        blockedMessage: t('masking.aiBlocking'),
      }, form)
    }
