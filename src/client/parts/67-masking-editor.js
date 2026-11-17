    /** 连接表单里的脱敏开关 / 关键字 / AI 分析（AI 结果回填到草稿 fields，不跳策略树）。 */
    function MaskingEditor(props) {
      const masking = props.masking || emptyMaskingDraft()
      const locked = Boolean(props.locked)
      const [keywordDraft, setKeywordDraft] = useState('')
      const [suggestBusy, setSuggestBusy] = useState(false)
      const [suggestError, setSuggestError] = useState(null)
      const [suggestInfo, setSuggestInfo] = useState(null)
      const keywords = Array.isArray(masking.keywords) ? masking.keywords : []

      const update = patch => {
        if (locked) return
        if (props.onChange) props.onChange(Object.assign({}, masking, patch))
      }

      const addKeywords = raw => {
        if (locked) return
        const parts = String(raw || '').split(/[,，;；\s]+/).map(part => part.trim()).filter(Boolean)
        if (!parts.length) return
        const next = keywords.slice()
        parts.forEach(part => {
          if (next.indexOf(part) < 0) next.push(part)
        })
        update({ keywords: next })
      }

      const removeKeyword = index => {
        if (locked) return
        update({ keywords: keywords.filter((keyword, position) => position !== index) })
      }

      const runSuggest = () => {
        if (suggestBusy || locked || !props.connectionId) return
        // 关键字为空、且当前连接已有策略已覆盖全部内置五类 → 没有新信息可发现，不必调用 AI（省时省费用）。
        const builtinCovered = MASKING_MANDATORY_TYPES.every(type => (masking.fields || [])
          .some(field => field && field.type === type))
        if (!keywords.length && builtinCovered) {
          setSuggestError(null)
          setSuggestInfo({ skipped: true, count: 0, stats: [], model: '', error: '', added: 0, kept: 0 })
          return
        }
        setSuggestBusy(true)
        setSuggestError(null)
        setSuggestInfo(null)
        if (props.onAnalyzingChange) props.onAnalyzingChange(true)
        const requestBody = { connectionId: props.connectionId, database: props.database || undefined }
        if (keywords.length) requestBody.keywords = keywords.slice()
        const fallbackBody = { connectionId: props.connectionId }
        if (keywords.length) fallbackBody.keywords = keywords.slice()

        const applyResult = (data, usedFallback, fallbackError) => {
          const candidates = normalizeSuggestCandidates(data && data.candidates)
          const errorText = data && typeof data.error === 'string' ? data.error : ''
          const modelLabel = describeAiModel(data && data.model)
          const merged = mergeAiCandidatesIntoFields(masking.fields, candidates)
          const stats = Object.keys(merged.stats).map(type => ({ type, count: merged.stats[type] }))
          // 回填到当前连接草稿（保存连接时随 masking.fields 一起提交）
          if (props.onChange) {
            props.onChange(Object.assign({}, masking, { fields: merged.fields }))
          }
          setSuggestBusy(false)
          setSuggestInfo({
            count: candidates.length,
            added: merged.added,
            kept: merged.kept,
            stats,
            model: modelLabel,
            error: errorText || (fallbackError ? String(fallbackError) : ''),
            fallback: Boolean(usedFallback) || !modelLabel,
          })
          if (props.onAnalyzingChange) props.onAnalyzingChange(false)
        }

        api.maskingSuggest(requestBody).then(
          data => applyResult(data, false, ''),
          suggestError => {
            const message = suggestError instanceof Error ? suggestError.message : String(suggestError || '')
            api.maskingAnalyze(fallbackBody).then(
              data => applyResult(data, true, message),
              () => {
                if (props.onAnalyzingChange) props.onAnalyzingChange(false)
                setSuggestBusy(false)
                setSuggestError(suggestError instanceof Error
                  ? suggestError
                  : new Error(String(suggestError)))
              },
            )
          },
        )
      }

      const statsText = suggestInfo && suggestInfo.stats
        ? suggestInfo.stats.map(item => maskingTypeLabel(item.type) + ' ×' + item.count).join(' · ')
        : ''

      return h('div', { className: 'dbs-masking' },
        h('div', { className: 'dbs-form-check' },
          h('label', { className: 'dbs-check' },
            h('input', {
              type: 'checkbox',
              name: 'maskingEnabled',
              checked: masking.enabled === true,
              disabled: locked,
              onChange: event => update({ enabled: Boolean(event && event.target && event.target.checked) }),
            }),
            h('span', null, t('masking.enabled')))),
        h('div', { className: 'dbs-field-hint' }, t('masking.enabledHint')),
        masking.enabled === true
          ? h('div', { className: 'dbs-masking-body' },
            h('div', { className: 'dbs-masking-keywords' },
              h('span', { className: 'dbs-field-label' }, t('masking.keywords')),
              h('div', { className: 'dbs-masking-chips' },
                keywords.length
                  ? keywords.map((keyword, index) => h('span', {
                    key: 'keyword:' + index,
                    className: 'dbs-chip is-on dbs-masking-chip',
                  }, keyword,
                  h('button', {
                    type: 'button',
                    className: 'dbs-masking-chip-x',
                    'aria-label': t('masking.keywordRemove', { keyword }),
                    disabled: locked,
                    onClick: () => removeKeyword(index),
                  }, '×')))
                  : h('span', { className: 'dbs-muted dbs-masking-keywords-empty' }, t('masking.keywordsEmpty')),
                h('input', {
                  className: 'dbs-input dbs-masking-keyword-input',
                  name: 'maskingKeyword',
                  value: keywordDraft,
                  placeholder: t('masking.keywordPlaceholder'),
                  'aria-label': t('masking.keywords'),
                  disabled: locked,
                  onChange: event => setKeywordDraft(event && event.target ? event.target.value : ''),
                  onKeyDown: event => {
                    if (!event || locked) return
                    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
                      if (event.preventDefault) event.preventDefault()
                      addKeywords(keywordDraft)
                      setKeywordDraft('')
                    }
                  },
                }))),
            h('div', { className: 'dbs-masking-actions' },
              h('button', {
                type: 'button',
                className: 'dbs-btn is-small',
                disabled: suggestBusy || locked || !props.connectionId,
                title: !props.connectionId ? t('masking.aiHint') : undefined,
                onClick: runSuggest,
              }, suggestBusy || locked ? h(Spinner, null) : h(Icon, { name: 'spark', size: 12 }),
              suggestBusy ? t('masking.aiBusy') : (locked ? t('masking.aiBlockingShort') : t('masking.aiButton'))),
              !props.connectionId
                ? h('span', { className: 'dbs-field-hint' }, t('masking.aiHint'))
                : null),
            suggestError
              ? h(ErrorBar, { error: suggestError, label: t('masking.aiError'), onRetry: runSuggest })
              : null,
            suggestInfo && suggestInfo.skipped
              ? h('div', { className: 'dbs-note dbs-ai-notice dbs-ai-skipped' },
                h('span', null, t('masking.aiSkipped')))
              : null,
            suggestInfo && !suggestInfo.skipped
              ? h('div', { className: 'dbs-note dbs-ai-notice' },
                h('span', null, suggestInfo.model
                  ? t('masking.aiFilled', { n: suggestInfo.count })
                  : t('masking.aiFilledFallback', { n: suggestInfo.count })),
                suggestInfo.model
                  ? h('span', null, ' · ' + t('masking.aiModel', { model: suggestInfo.model }))
                  : null,
                suggestInfo.error
                  ? h('span', {
                    className: 'dbs-ai-error',
                    title: maskingErrorNotice(suggestInfo.error).full,
                  }, ' · ' + t('masking.aiReason', {
                    reason: maskingErrorNotice(suggestInfo.error).preview,
                  }))
                  : null,
                statsText ? h('span', { className: 'dbs-ai-stats' }, ' · ' + statsText) : null,
                h('span', null, ' · ' + t('masking.aiAdjustHint')))
              : null,
            h('div', { className: 'dbs-field-hint' }, t('masking.policy.formHint')))
          : null)
    }
