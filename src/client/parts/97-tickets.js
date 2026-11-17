
    // ======================================================================
    // 11.7 工单视图（契约 §3.6）：列表 + 过滤 + 详情 + 审批操作
    // ======================================================================

    const TICKET_FILTERS = [
      ['all', 'tickets.filter.all'],
      ['pending', 'tickets.filter.pending'],
      ['succeeded', 'tickets.filter.succeeded'],
      ['failed', 'tickets.filter.failed'],
      ['rejected', 'tickets.filter.rejected'],
      ['cancelled', 'tickets.filter.cancelled'],
      ['undone', 'tickets.filter.undone'],   // 第 43 轮：变更已撤销（终态）
    ]

    function TicketStatusTag(props) {
      const ticket = props.ticket || {}
      const status = ticket.status
      return h(Tag, { tone: ticketStatusTone(status), title: ticketStatusLabel(status) },
        ticketStatusLabel(status))
    }

    function DetailMetaRow(props) {
      return h('div', { className: 'dbs-meta-row' },
        h('span', { className: 'dbs-meta-key' }, props.label),
        h('span', { className: 'dbs-meta-value' }, props.children))
    }

    function TicketTimeline(props) {
      const ticket = props.ticket || {}
      const items = []
      items.push({
        key: 'submit',
        time: ticket.createdAt,
        label: t('tickets.detail.timeline.submit'),
        detail: ticket.submittedBy === 'user' ? t('tickets.submittedBy.user') : t('tickets.submittedBy.agent'),
      })
      if (ticket.status === 'rejected') {
        items.push({
          key: 'reject',
          time: ticket.approvedAt,
          label: t('tickets.detail.timeline.reject'),
          detail: [ticket.approvedBy, ticket.approvalComment].filter(Boolean).join(' · '),
          tone: 'danger',
        })
      } else if (ticket.approvedAt) {
        items.push({
          key: 'approve',
          time: ticket.approvedAt,
          label: t('tickets.detail.timeline.approve'),
          detail: [ticket.approvedBy, ticket.approvalComment].filter(Boolean).join(' · '),
          tone: 'link',
        })
      }
      if (ticket.executedAt) {
        const failed = ticket.status === 'failed'
        items.push({
          key: 'execute',
          time: ticket.executedAt,
          label: failed ? t('tickets.detail.timeline.executeFail') : t('tickets.detail.timeline.execute'),
          detail: ticket.actual && ticket.actual.elapsedMs !== null
            ? t('tickets.detail.elapsed') + ' ' + t('results.elapsed', { n: formatNumber(ticket.actual.elapsedMs) })
            : '',
          tone: failed ? 'danger' : 'link',
        })
      }
      if (ticket.status === 'cancelled') {
        items.push({
          key: 'cancel',
          time: '',
          label: t('tickets.status.cancelled'),
          detail: '',
          tone: 'plain',
        })
      }
      if (ticket.status === 'undone') {
        // 撤销事件（第 43/45 轮）：undoneAt 由详情接口按 undo_log 反查
        items.push({
          key: 'undone',
          time: ticket.undoneAt || '',
          label: t('tickets.timeline.undone'),
          detail: '',
          tone: 'warn',
        })
      }
      return h('div', { className: 'dbs-timeline' },
        items.map(item => h('div', { key: item.key, className: 'dbs-timeline-item' },
          h('span', { className: 'dbs-timeline-dot is-' + (item.tone || 'plain') }),
          h('div', { className: 'dbs-timeline-body' },
            h('div', { className: 'dbs-timeline-line' },
              h('span', { className: 'dbs-timeline-label' }, item.label),
              item.time ? h('span', { className: 'dbs-timeline-time' }, item.time) : null),
            item.detail ? h('div', { className: 'dbs-timeline-detail' }, item.detail) : null))))
    }

    /** 结构化工单的 diff 展示（V2.3）：updates/inserts/deletes 分组表格（行数据即 agent 提交的
     *  结构化值，不泄露库里原始行；语句文本以 render 人读版为准）。 */
    function TicketRowsDiff(props) {
      const payload = props.payload
      if (!payload || typeof payload !== 'object') return null
      const statements = Array.isArray(payload.statements) ? payload.statements : []
      if (!statements.length) return null
      const summary = payload.summary || {}
      const rendered = Array.isArray(payload.rendered) ? payload.rendered : []
      const groups = [
        ['undo.rowsDiff.updates', statements.filter(statement => statement.op === 'UPDATE')],
        ['undo.rowsDiff.inserts', statements.filter(statement => statement.op === 'INSERT')],
        ['undo.rowsDiff.deletes', statements.filter(statement => statement.op === 'DELETE')],
      ].filter(([, rows]) => rows.length)
      return h('div', { className: 'dbs-ticket-rowsdiff' },
        h('div', { className: 'dbs-ticket-stat-row' },
          h('div', { className: 'dbs-stat' },
            h('span', { className: 'dbs-stat-label' }, t('undo.rowsDiff.table')),
            h('span', { className: 'dbs-stat-value' }, safeText(payload.table, t('common.dash')))),
          ['updates', 'inserts', 'deletes'].map(key => h('div', { key, className: 'dbs-stat' },
            h('span', { className: 'dbs-stat-label' }, t('undo.rowsDiff.' + key)),
            h('span', { className: 'dbs-stat-value' }, String(summary[key] ?? 0))))),
        groups.map(([label, rows]) => h('div', { key: label, className: 'dbs-ticket-rowsdiff-group' },
          h('span', { className: 'dbs-section-title dbs-ticket-label' },
            t(label, { n: rows.length })),
          h(ResultGrid, {
            columns: [
              { name: t('tickets.detail.statementIndex') },
              { name: t('undo.rowsDiff.operation') },
              { name: t('undo.rowsDiff.generated') },
            ],
            rows: rows.map((statement, index) => [
              t('tickets.detail.statementNo', { n: index + 1 }),
              safeText(statement.op),
              safeText(rendered[statements.indexOf(statement)] || '', statement.sql),
            ]),
          }))))
    }

    function TicketStatementsTable(props) {
      const statements = (props.ticket && props.ticket.estimated && props.ticket.estimated.statements) || []
      if (!statements.length) return null
      // 新工单带 statements[].sql 预览；旧数据没有该字段时只显示 kind/table 等基础列
      const hasPreview = statements.some(statement => statement.sql)
      // 第 21 轮起 EXPLAIN 计划明细（访问类型/命中索引）随预估落库；有计划才加「计划」列
      const hasPlan = statements.some(statement => Array.isArray(statement.plan) && statement.plan.length)
      const columns = [
        { name: t('tickets.detail.statementIndex') },
        { name: t('tickets.detail.statementKind') },
        { name: t('tickets.detail.statementTable') },
        { name: t('tickets.detail.statementWhere') },
        { name: t('tickets.detail.statementRows') },
      ]
      if (hasPlan) columns.push({ name: t('tickets.detail.statementPlan') })
      if (hasPreview) columns.push({ name: t('tickets.detail.statementSql') })
      const rows = statements.map((statement, index) => {
        const row = [
          t('tickets.detail.statementNo', { n: index + 1 }),
          safeText(statement.kind),
          safeText(statement.table, t('common.dash')),
          statement.hasWhere === true
            ? t('tickets.detail.hasWhere')
            : (statement.hasWhere === false ? t('tickets.detail.noWhere') : t('common.dash')),
          statement.estimatedRows === null || statement.estimatedRows === undefined
            ? null
            : formatNumber(statement.estimatedRows),
        ]
        if (hasPlan) row.push(ticketPlanText(statement.plan) || null)
        if (hasPreview) row.push(statement.sql || null)
        return row
      })
      return h('div', { className: 'dbs-ticket-statements' },
        h(ResultGrid, { columns, rows }))
    }

    function TicketDetailPane(props) {
      const ticket = props.ticket
      const busy = Boolean(props.busy)
      if (props.loading && !ticket) {
        return h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 8 }))
      }
      if (props.error) {
        return h('div', { className: 'dbs-pad' },
          h(ErrorBar, { error: props.error, label: t('tickets.detail.error'), onRetry: props.onRetry }))
      }
      if (!ticket) {
        return h('div', { className: 'dbs-empty is-small' },
          h(Icon, { name: 'sliders', size: 22 }),
          h('div', { className: 'dbs-empty-text' }, t('tickets.detail.empty')))
      }
      const estimated = ticket.estimated
      const actual = ticket.actual
      const undoInfo = actual && actual.undo && typeof actual.undo === 'object' ? actual.undo : null
      const undoBlocked = undoInfo !== null && undoInfo.available === false
      const pending = ticket.status === 'pending'
      const estimatedCount = ticketStatementCount(ticket)
      const statementCount = estimatedCount > 0 ? estimatedCount : null
      const unknownStatements = estimated && estimated.unknownStatements !== null
        ? estimated.unknownStatements
        : 0
      const actualCount = actual
        ? (actual.results.length || estimatedCount || 0)
        : 0
      // 导出工单（第 45 轮）：执行成功后可下载数据（fetch JSON → 前端按所选格式保存）。
      // 第 46 轮统一导出入口：下载出格式菜单（xlsx / JSON / INSERT），同一份数据按需转换。
      const isExport = ticket.kind === 'export'
      const [exportBusy, setExportBusy] = useState(false)
      const [exportError, setExportError] = useState(null)
      const [dlOpen, setDlOpen] = useState(false)
      const downloadExport = useCallback(format => {
        if (exportBusy) return
        setExportBusy(true)
        setExportError(null)
        setDlOpen(false)
        // 数据 JSON → 前端按格式生成文件（复用结果区导出的既有生成器）
        api.exportDownload(ticket.id).then(data => {
          setExportBusy(false)
          const columns = Array.isArray(data.columns) ? data.columns : []
          const rows = Array.isArray(data.rows) ? data.rows : []
          let blob = null
          if (format === 'json') {
            blob = new Blob([buildJsonText({ columns, rows })],
              { type: 'application/json;charset=utf-8' })
          } else if (format === 'insert') {
            blob = new Blob([buildInsertText({
              columns, rows, sql: ticket.sql, connectionName: ticket.connectionName,
            })], { type: 'application/sql;charset=utf-8' })
          } else {
            blob = new Blob([buildXlsxBytes({ columns, rows })],
              { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
          }
          const filename = buildExportFilename({
            format, sql: ticket.sql, connectionName: ticket.connectionName,
          })
          downloadExportBlob(blob, filename)
        }, error => {
          setExportBusy(false)
          setExportError(error)
        })
      }, [exportBusy, ticket.id, ticket.sql, ticket.connectionName])

      const actions = h('div', { className: 'dbs-ticket-actions' },
        pending
          ? h('button', {
            type: 'button', className: 'dbs-btn is-primary is-small', disabled: busy,
            onClick: () => props.onAction('approve', ticket),
          }, h(Icon, { name: 'check', size: 12 }), t('tickets.action.approve'))
          : null,
        pending
          ? h('button', {
            type: 'button', className: 'dbs-btn is-small', disabled: busy,
            onClick: () => props.onAction('reject', ticket),
          }, h(Icon, { name: 'close', size: 12 }), t('tickets.action.reject'))
          : null,
        pending
          ? h('button', {
            type: 'button', className: 'dbs-btn is-small is-danger', disabled: busy,
            onClick: () => props.onAction('cancel', ticket),
          }, h(Icon, { name: 'trash', size: 12 }), t('tickets.action.cancel'))
          : null,
        ticket.status === 'succeeded' && ticket.kind !== 'export' && props.onUndo
          ? h('button', {
            type: 'button', className: 'dbs-btn is-small',
            // 撤销可用性预判（第 25 轮）：执行时已把摘要写进 actual.undo，不可撤销直接禁用；
            // 导出工单（第 45 轮）是只读操作，没有撤销语义
            disabled: busy || undoBlocked,
            title: undoBlocked ? (undoInfo.reason || t('undo.none')) : undefined,
            onClick: () => props.onUndo({ ticketId: ticket.id }),
          }, h(Icon, { name: 'refresh', size: 12 }), t('undo.button'))
          : null,
        isExport && ticket.status === 'succeeded'
          ? h('span', { className: 'dbs-export' },
            h('button', {
              type: 'button', className: 'dbs-btn is-primary is-small', disabled: exportBusy,
              'aria-haspopup': 'menu', 'aria-expanded': dlOpen ? 'true' : 'false',
              onClick: () => setDlOpen(value => !value),
            }, exportBusy ? h(Spinner, null) : h(Icon, { name: 'save', size: 12 }),
            t('tickets.export.download')),
            dlOpen
              ? h('div', { className: 'dbs-export-menu', role: 'menu' },
                ['xlsx', 'json', 'insert'].map(format => h('button', {
                  key: format,
                  type: 'button',
                  role: 'menuitem',
                  className: 'dbs-export-option',
                  disabled: exportBusy,
                  onClick: () => downloadExport(format),
                }, exportFormatLabel(format))))
              : null)
          : null)

      return h('div', { className: 'dbs-ticket-detail-inner' },
        h('div', { className: 'dbs-ticket-detail-head' },
          h('div', { className: 'dbs-ticket-detail-title' }, ticketTitle(ticket)),
          h(TicketStatusTag, { ticket }),
          isExport ? h(Tag, { tone: 'plain' }, t('tickets.export.tag')) : null,
          estimated ? h(Tag, { tone: ticketRiskTone(estimated.risk) }, ticketRiskLabel(estimated.risk)) : null,
          h('span', { className: 'dbs-grow' }),
          actions),
        pending ? h('div', { className: 'dbs-note' }, t('tickets.detail.pendingTip')) : null,
        ticket.status === 'undone'
          ? h('div', { className: 'dbs-note' }, t('tickets.detail.undoneTip')) : null,
        exportError
          ? h(ErrorBar, { error: exportError, label: t('tickets.export.downloadFail') })
          : null,
        h('div', { className: 'dbs-ticket-meta' },
          h(DetailMetaRow, { label: t('tickets.detail.ticketId') },
            h('span', { className: 'dbs-ticket-row-meta' }, safeText(ticket.id, t('common.dash')))),
          h(DetailMetaRow, { label: t('tickets.detail.connection') },
            safeText(ticket.connectionName, safeText(ticket.connectionId, t('common.dash')))),
          h(DetailMetaRow, { label: t('tickets.detail.database') }, safeText(ticket.database, t('common.dash'))),
          h(DetailMetaRow, { label: t('tickets.detail.submittedBy') }, safeText(ticket.submittedBy, t('common.dash'))),
          h(DetailMetaRow, { label: t('tickets.detail.createdAt') }, safeText(ticket.createdAt, t('common.dash'))),
          ticket.approvedBy ? h(DetailMetaRow, { label: t('tickets.detail.approvedBy') }, ticket.approvedBy) : null,
          ticket.executedAt ? h(DetailMetaRow, { label: t('tickets.detail.executedAt') }, ticket.executedAt) : null,
          ticket.status === 'undone' && ticket.undoneAt
            ? h(DetailMetaRow, { label: t('tickets.detail.undoneAt') }, ticket.undoneAt) : null),
        h('div', { className: 'dbs-section-title dbs-ticket-label' }, t('tickets.detail.background')),
        h('div', { className: 'dbs-ticket-background' }, safeText(ticket.background, t('tickets.detail.noText'))),
        ticket.rowsPayload
          ? h('div', { className: 'dbs-ticket-rowsdiff-wrap' },
            h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('undo.rowsDiff.title')),
            h(TicketRowsDiff, { payload: ticket.rowsPayload }))
          : null,
        h('div', { className: 'dbs-ticket-sql-head' },
          h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('tickets.detail.sql')),
          h('span', { className: 'dbs-grow' }),
          h(CopyButton, { label: t('history.detail.copySql'), getText: () => ticket.sql })),
        h('pre', { className: 'dbs-pre dbs-ticket-sql' }, formatTicketSqlForDisplay(ticket.sql)),
        estimated
          ? h('div', { className: 'dbs-ticket-estimated' },
            h('div', { className: 'dbs-ticket-section-head' },
              h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('tickets.detail.estimated')),
              h('span', { className: 'dbs-grow' }),
              estimated.rowsExact
                ? h(Tag, { tone: 'link' }, t('tickets.detail.rowsExact'))
                : h(Tag, { tone: 'plain' }, t('tickets.detail.rowsInexact'))),
            h('div', { className: 'dbs-ticket-stat-row' },
              h('div', { className: 'dbs-stat' },
                h('span', { className: 'dbs-stat-label' }, estimatedCount > 1
                  ? t('tickets.detail.estimatedRowsWithCount', { n: estimatedCount })
                  : t('tickets.detail.estimatedRows')),
                h('span', { className: 'dbs-stat-value' }, estimated.affectedRows === null
                  ? t('tickets.detail.rowsUnknown')
                  : formatNumber(estimated.affectedRows))),
              h('div', { className: 'dbs-stat' },
                h('span', { className: 'dbs-stat-label' }, t('tickets.detail.statementCount')),
                h('span', { className: 'dbs-stat-value' }, statementCount === null ? t('common.dash') : String(statementCount))),
              h('div', { className: 'dbs-stat' },
                h('span', { className: 'dbs-stat-label' }, t('tickets.detail.risk')),
                h('span', { className: 'dbs-stat-value' },
                  h(Tag, { tone: ticketRiskTone(estimated.risk) }, ticketRiskLabel(estimated.risk))))),
            unknownStatements > 0
              ? h('div', { className: 'dbs-ticket-unknown' },
                h('span', null, t('tickets.detail.unknownStatements', { n: unknownStatements })),
                estimated.affectedRows !== null
                  ? h('span', { className: 'dbs-muted' }, ' · ' + t('tickets.detail.sumKnownOnly'))
                  : null)
              : null,
            estimated.statements.length
              ? h('div', { className: 'dbs-ticket-statements' },
                h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('tickets.detail.statements')),
                h(TicketStatementsTable, { ticket }))
              : null,
            estimated.notes.length
              ? h('ul', { className: 'dbs-ticket-notes' },
                estimated.notes.map((note, index) => h('li', { key: 'note:' + index }, note)))
              : null)
          : null,
        undoBlocked
          ? h('div', { className: 'dbs-note' }, t('undo.unavailable', {
            reason: undoInfo.reason || t('undo.none'),
          }))
          : null,
        actual
          ? h('div', { className: 'dbs-ticket-actual' },
            h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('tickets.detail.actual')),
            h('div', { className: 'dbs-ticket-stat-row' },
              h('div', { className: 'dbs-stat' },
                h('span', { className: 'dbs-stat-label' }, actualCount > 1
                  ? t('tickets.detail.actualRowsWithCount', { n: actualCount })
                  : t('tickets.detail.actualRows')),
                h('span', { className: 'dbs-stat-value' }, actual.affectedRows === null
                  ? t('common.dash')
                  : formatNumber(actual.affectedRows))),
              h('div', { className: 'dbs-stat' },
                h('span', { className: 'dbs-stat-label' }, t('tickets.detail.elapsed')),
                h('span', { className: 'dbs-stat-value' }, actual.elapsedMs === null
                  ? t('common.dash')
                  : t('results.elapsed', { n: formatNumber(actual.elapsedMs) }))),
              isExport
                ? h('div', { className: 'dbs-stat' },
                  h('span', { className: 'dbs-stat-label' }, t('tickets.detail.exportRows')),
                  h('span', { className: 'dbs-stat-value' }, formatNumber(actual.exportRows || 0)))
                : h('div', { className: 'dbs-stat' },
                  h('span', { className: 'dbs-stat-label' }, t('tickets.detail.statementCount')),
                  h('span', { className: 'dbs-stat-value' }, String(actual.results.length))),
              isExport
                ? h('div', { className: 'dbs-stat' },
                  h('span', { className: 'dbs-stat-label' }, t('tickets.detail.exportBatches')),
                  h('span', { className: 'dbs-stat-value' }, formatNumber(actual.exportBatches || 0)))
                : null),
            actual.results.length > 1
              ? h('div', { className: 'dbs-ticket-results' },
                h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('tickets.detail.perStatementResults')),
                h(ResultGrid, {
                  columns: [
                    { name: t('tickets.detail.statementIndex') },
                    { name: t('tickets.detail.statementKind') },
                    { name: t('tickets.detail.resultAffected') },
                    { name: t('tickets.detail.resultElapsed') },
                    { name: t('tickets.detail.resultError') },
                  ],
                  rows: actual.results.map((result, index) => {
                    const item = result && typeof result === 'object' ? result : {}
                    return [
                      t('tickets.detail.statementNo', { n: index + 1 }),
                      safeText(item.kind),
                      item.affectedRows === null || item.affectedRows === undefined
                        ? null
                        : formatNumber(item.affectedRows),
                      item.elapsedMs === null || item.elapsedMs === undefined
                        ? null
                        : t('results.elapsed', { n: formatNumber(item.elapsedMs) }),
                      item.error ? String(item.error) : null,
                    ]
                  }),
                }))
              : null)
          : null,
        ticket.error
          ? h('div', { className: 'dbs-ticket-error' },
            h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('tickets.detail.errorTitle')),
            h('pre', { className: 'dbs-error-pre' }, ticket.error))
          : null,
        h('div', { className: 'dbs-ticket-timeline' },
          h('span', { className: 'dbs-section-title dbs-ticket-label' }, t('tickets.detail.timeline')),
          h(TicketTimeline, { ticket })))
    }

    /** 审批弹窗里的影响面摘要（第 21 轮）：合计行数 + 精确/估算 + 风险 + 可展开逐条明细。
     *  让人在「点允许」的那一刻不用滚回详情页就能判断影响面。 */
    function TicketImpactSummary(props) {
      const estimated = props.estimated
      if (!estimated) return null
      const [showStatements, setShowStatements] = useState(false)
      const highRisk = estimated.risk === 'high'
      const rowsUnknown = estimated.affectedRows === null || estimated.affectedRows === undefined
      const hasStatements = Array.isArray(estimated.statements) && estimated.statements.length > 0
      return h('div', { className: 'dbs-modal-impact' },
        h('div', { className: 'dbs-modal-impact-row' },
          h('span', { className: 'dbs-modal-impact-title' }, t('tickets.modal.impactTitle')),
          h('span', { className: 'dbs-modal-impact-rows' }, rowsUnknown
            ? t('tickets.detail.rowsUnknown')
            : t('tickets.modal.rowsValue', { n: formatNumber(estimated.affectedRows) })),
          rowsUnknown
            ? null
            : (estimated.rowsExact
              ? h(Tag, { tone: 'link' }, t('tickets.detail.rowsExact'))
              : h(Tag, { tone: 'plain' }, t('tickets.detail.rowsInexact'))),
          h(Tag, { tone: ticketRiskTone(estimated.risk) }, ticketRiskLabel(estimated.risk))),
        highRisk
          ? h('div', { className: 'dbs-modal-impact-warn' }, t('tickets.modal.highRiskTip'))
          : null,
        rowsUnknown
          ? h('div', { className: 'dbs-modal-impact-warn' }, t('tickets.modal.unknownTip'))
          : null,
        hasStatements
          ? h('button', {
            type: 'button', className: 'dbs-btn is-small dbs-modal-impact-toggle',
            onClick: () => setShowStatements(!showStatements),
          }, showStatements ? t('tickets.modal.hideStatements') : t('tickets.modal.showStatements'))
          : null,
        showStatements && hasStatements
          ? h(TicketStatementsTable, { ticket: { estimated } })
          : null,
        Array.isArray(estimated.notes) && estimated.notes.length
          ? h('ul', { className: 'dbs-ticket-notes' },
            estimated.notes.map((note, index) => h('li', { key: 'note:' + index }, note)))
          : null)
    }

    /** 撤销状态标签文案。 */
    function undoStatusLabel(status) {
      if (status === 'undone') return t('undo.status.undone')
      if (status === 'undoing') return t('undo.status.undoing')
      if (status === 'active') return t('undo.status.active')
      return t('common.dash')
    }

    /** 撤销确认弹窗（V2.2）：展示反向语句占位符（值不出站），确认后 POST /api/undo。
        第 44 轮：原主键被占用时显示冲突警示，确认按钮换成「仍要撤销（冲突行改用自增 id）」。 */
    function UndoConfirmModal(props) {
      const undo = props.undo || null
      if (!undo) return null
      const reverse = Array.isArray(undo.reverse) ? undo.reverse : []
      const rows = undo.capturedRows === null || undo.capturedRows === undefined
        ? undo.affectedRows
        : undo.capturedRows
      const pkConflicts = Array.isArray(undo.pkConflicts) ? undo.pkConflicts : null
      const hasConflicts = Boolean(pkConflicts && pkConflicts.length)
      const conflictRows = pkConflicts
        ? pkConflicts.reduce((sum, item) => sum + (Number(item.count) || 0), 0) : 0
      const conflictTables = pkConflicts
        ? pkConflicts.map(item => safeText(item.table)).filter(Boolean).join('、') : ''
      return h(Modal, {
        open: true,
        title: t('undo.confirmTitle'),
        onClose: () => { if (!props.busy) props.onClose() },
        focusKey: 'undo',
      },
      h('div', { className: 'dbs-form' },
        h('p', { className: 'dbs-modal-text' }, t('undo.confirmBody', {
          table: safeText(undo.table, t('common.dash')),
          rows: rows === null || rows === undefined ? t('common.dash') : formatNumber(rows),
        })),
        h('div', { className: 'dbs-modal-impact' },
          h('div', { className: 'dbs-modal-impact-row' },
            h('span', { className: 'dbs-modal-impact-title' }, t('undo.reverseTitle')),
            h('span', { className: 'dbs-modal-impact-rows' },
              t('undo.reverseCount', { n: undo.reverseCount || reverse.length })),
            h(Tag, { tone: undo.status === 'active' ? 'link' : 'warn' }, undoStatusLabel(undo.status)))),
        reverse.length
          ? h('pre', { className: 'dbs-pre dbs-modal-sql' },
            reverse.map(statement => statement.sql).join('\n\n'))
          : null,
        hasConflicts
          ? h('div', { className: 'dbs-note' }, t('undo.pkConflict', {
            count: formatNumber(conflictRows), tables: conflictTables || t('common.dash'),
          }))
          : null,
        props.error ? h(ErrorBar, { error: props.error }) : null,
        h('div', { className: 'dbs-form-actions' },
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', disabled: props.busy,
            onClick: () => { if (!props.busy) props.onClose() },
          }, t('connmgr.cancel')),
          hasConflicts
            ? h('button', {
              type: 'button', className: 'dbs-btn is-danger is-small', disabled: props.busy,
              onClick: () => { if (!props.busy) props.onConfirm(true) },
            }, props.busy ? h(Spinner, null) : null, t('undo.pkConflictAction'))
            : h('button', {
              type: 'button', className: 'dbs-btn is-primary is-small', disabled: props.busy,
              onClick: () => { if (!props.busy) props.onConfirm(false) },
            }, props.busy ? h(Spinner, null) : null, t('undo.confirmAction')))))
    }

    function TicketActionModal(props) {
      const preview = props.preview || null
      if (!preview) return null
      const ticket = preview.ticket || {}
      const kind = preview.type
      const title = kind === 'approve'
        ? t('tickets.confirm.approveTitle')
        : (kind === 'reject' ? t('tickets.confirm.rejectTitle') : t('tickets.confirm.cancelTitle'))
      const bodyText = kind === 'approve'
        ? t('tickets.confirm.approveBody', {
          connection: safeText(ticket.connectionName, safeText(ticket.connectionId, '—')),
        })
        : (kind === 'reject' ? t('tickets.confirm.rejectBody') : t('tickets.confirm.cancelBody'))
      return h(Modal, {
        open: true,
        title,
        onClose: () => { if (!props.busy) props.onClose() },
        focusKey: kind,
      },
      h('div', { className: 'dbs-form' },
        h('p', { className: 'dbs-modal-text' }, bodyText),
        kind === 'approve'
          ? h(TicketImpactSummary, { estimated: ticket.estimated })
          : null,
        kind === 'approve' && ticket.rowsPayload
          ? h(TicketRowsDiff, { payload: ticket.rowsPayload })
          : null,
        kind === 'approve'
          ? h('pre', { className: 'dbs-pre dbs-modal-sql' }, formatTicketSqlForDisplay(ticket.sql))
          : null,
        kind === 'reject'
          ? h('textarea', {
            className: 'dbs-input is-full dbs-modal-textarea',
            value: props.comment,
            rows: 3,
            placeholder: t('tickets.confirm.commentPlaceholder'),
            'aria-label': t('tickets.confirm.commentPlaceholder'),
            onChange: event => props.onCommentChange(event && event.target ? event.target.value : ''),
          })
          : null,
        props.error ? h(ErrorBar, { error: props.error }) : null,
        h('div', { className: 'dbs-form-actions' },
          h('span', { className: 'dbs-grow' }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small', disabled: props.busy,
            onClick: () => { if (!props.busy) props.onClose() },
          }, t('connmgr.cancel')),
          h('button', {
            type: 'button',
            className: 'dbs-btn is-primary is-small' + (kind === 'approve' ? '' : ' is-danger'),
            disabled: props.busy,
            onClick: () => { if (!props.busy) props.onConfirm() },
          }, props.busy ? h(Spinner, null) : null, t('tickets.action.confirm')))))
    }

    /** 会话写窗口条（V2.4）：关→三档开闸按钮；开→剩余分钟 + 立即关闭。 */
    function WritesWindowBar(props) {
      const state = props.state
      if (!state) return null  // 加载中/未知：不占位
      return h('div', { className: 'dbs-window-bar' + (state.open ? ' is-open' : '') },
        h('span', { className: 'dbs-window-bar-label' }, t('writeswin.title')),
        state.open
          ? h('span', { className: 'dbs-window-bar-state' }, t('writeswin.open', {
            n: formatNumber(state.minutesLeft),
            until: safeText(state.openUntil, t('common.dash')),
          }))
          : h('span', { className: 'dbs-window-bar-state' }, t('writeswin.closed')),
        h('span', { className: 'dbs-grow' }),
        state.open
          ? h('button', {
            type: 'button', className: 'dbs-btn is-small',
            disabled: props.busy,
            onClick: () => props.onSet({ close: true }),
          }, t('writeswin.close'))
          : [15, 30, 60].map(minutes => h('button', {
            key: 'win:' + minutes,
            type: 'button', className: 'dbs-btn is-small',
            disabled: props.busy,
            onClick: () => props.onSet({ minutes }),
          }, t('writeswin.openN', { n: minutes }))),
      )
    }

    function TicketsView(props) {
      const [filter, setFilter] = useState('all')
      const [selectedId, setSelectedId] = useState('')
      // 跨视图聚焦（第 27 轮）：历史详情「查看工单」跳转过来时直接选中该工单
      useEffect(() => {
        if (props.focusTicketId) setSelectedId(props.focusTicketId)
      }, [props.focusTicketId])
      // 工单号/标题/SQL 关键字筛选 + 分页（第 45 轮：默认每页 50 条，时间倒序）
      const TICKET_PAGE_SIZE = 50
      const [keywordInput, setKeywordInput] = useState('')
      const [keyword, setKeyword] = useState('')
      const [offset, setOffset] = useState(0)
      const [action, setAction] = useState(null)
      const [busy, setBusy] = useState(false)
      const [comment, setComment] = useState('')
      const [actionError, setActionError] = useState(null)
      const [notice, setNotice] = useState(null)
      // 撤销（V2.2）：预览弹窗 + 执行忙碌 + 错误
      const [undoPreview, setUndoPreview] = useState(null)
      const [undoBusy, setUndoBusy] = useState(false)
      const [undoError, setUndoError] = useState(null)
      // 会话写窗口（V2.4）：null = 未知（加载中/老后端）
      const [windowState, setWindowState] = useState(null)
      const [windowBusy, setWindowBusy] = useState(false)

      const listState = useAsync(
        signal => api.tickets({
          status: filter === 'all' ? undefined : filter,
          keyword: keyword || undefined,
          limit: TICKET_PAGE_SIZE,
          offset: offset || undefined,
        }, signal),
        [filter, keyword, offset],
      )
      const listTotal = listState.data && typeof listState.data.total === 'number'
        ? listState.data.total : null
      // deps 含 focusTicketId（第 27 轮）：跨视图跳转落在新挂载的首帧，确保详情必拉
      const detailState = useAsync(
        signal => (selectedId
          ? api.ticketDetail(selectedId, signal)
          : Promise.resolve({ ticket: null })),
        [selectedId, props.focusTicketId],
      )
      const tickets = ((listState.data && listState.data.tickets) || []).map(normalizeTicket)
      const counts = listState.data && listState.data.counts ? listState.data.counts : null
      const selectedTicket = detailState.data && detailState.data.ticket
        ? normalizeTicket(detailState.data.ticket)
        : null

      useEffect(() => {
        if (selectedId) return
        if (tickets.length) setSelectedId(tickets[0].id)
      }, [listState.data])

      const reloadAll = useCallback(() => {
        listState.reload()
        if (selectedId) detailState.reload()
        if (props.onChanged) props.onChanged()
      }, [listState.reload, detailState.reload, selectedId, props.onChanged])

      const openAction = useCallback((type, ticket) => {
        setAction({ type, ticket })
        setComment('')
        setActionError(null)
        setNotice(null)
      }, [])

      // 写窗口：初始拉一次，操作后刷新
      useEffect(() => {
        api.writesWindow().then(body => {
          setWindowState(body && body.window && typeof body.window === 'object' ? body.window : null)
        }, () => setWindowState(null))
      }, [])

      const setWindow = useCallback((body) => {
        if (windowBusy) return
        setWindowBusy(true)
        api.setWritesWindow(body).then(data => {
          setWindowBusy(false)
          setWindowState(data && data.window && typeof data.window === 'object' ? data.window : null)
        }, () => {
          setWindowBusy(false)
          setNotice({ tone: 'bad', text: t('writeswin.fail') })
        })
      }, [windowBusy])

      /** 撤销入口：按 ticketId 反查最近 active 快照，拉预览后弹确认。 */
      const openUndo = useCallback((params) => {
        setNotice(null)
        setUndoError(null)
        api.undoPreview(params).then(body => {
          const undo = body && body.undo && body.undo.id ? body.undo : null
          setUndoPreview(undo)
          if (!undo) setNotice({ tone: 'bad', text: t('undo.none') })
        }, error => {
          setUndoPreview(null)
          setNotice({ tone: 'bad', text: t('undo.none') + '：' + errorText(error) })
        })
      }, [])

      const confirmUndo = useCallback(force => {
        if (undoBusy || !undoPreview) return
        setUndoBusy(true)
        setUndoError(null)
        api.undoExecute(undoPreview.id, force).then(data => {
          setUndoBusy(false)
          setUndoPreview(null)
          setNotice({ tone: 'ok', text: t('undo.done', { id: safeText(data && data.undo ? data.undo.id : '', '') }) })
          reloadAll()
        }, error => {
          setUndoBusy(false)
          setUndoError(error)
        })
      }, [undoBusy, undoPreview, reloadAll])

      const confirmAction = useCallback(() => {
        if (busy || !action) return
        setBusy(true)
        setActionError(null)
        const ticket = action.ticket
        const type = action.type
        let promise
        if (type === 'approve') promise = api.approveTicket({ id: ticket.id, approve: true })
        else if (type === 'reject') {
          promise = api.approveTicket({
            id: ticket.id,
            approve: false,
            comment: String(comment || '').trim() || undefined,
          })
        } else promise = api.cancelTicket(ticket.id)
        promise.then(data => {
          setBusy(false)
          setAction(null)
          setComment('')
          const result = data && data.ticket ? normalizeTicket(data.ticket) : null
          if (type === 'approve' && result && result.status === 'failed') {
            setNotice({ tone: 'bad', text: t('tickets.status.failed') + '：' + safeText(result.error, '') })
          } else {
            setNotice({
              tone: 'ok',
              text: t(type === 'approve'
                ? 'tickets.notice.approve'
                : (type === 'reject' ? 'tickets.notice.reject' : 'tickets.notice.cancel')),
            })
          }
          reloadAll()
        }, error => {
          setBusy(false)
          setActionError(error)
          if (props.onChanged) props.onChanged()
        })
      }, [busy, action, comment, reloadAll, props.onChanged])

      let listBody
      if (listState.error) {
        listBody = h('div', { className: 'dbs-pad' }, h(ErrorBar, {
          error: listState.error, label: t('tickets.error'), onRetry: listState.reload,
        }))
      } else if (listState.loading && !tickets.length) {
        listBody = h('div', { className: 'dbs-pad' }, h(SkeletonList, { rows: 6 }))
      } else if (!tickets.length) {
        listBody = h('div', { className: 'dbs-empty is-small' },
          h(Icon, { name: 'sliders', size: 22 }),
          h('div', { className: 'dbs-empty-title' }, filter === 'all'
            ? t('tickets.emptyTitle')
            : t('tickets.emptyFiltered')),
          filter === 'all' ? h('p', { className: 'dbs-empty-text' }, t('tickets.emptyBody')) : null)
      } else {
        listBody = h('div', { className: 'dbs-ticket-list' }, tickets.map(ticket => h('button', {
          key: 'ticket:' + ticket.id,
          type: 'button',
          className: 'dbs-ticket-row' + (ticket.id === selectedId ? ' is-on' : ''),
          onClick: () => setSelectedId(ticket.id),
        },
        h('span', { className: 'dbs-ticket-row-status' }, h(TicketStatusTag, { ticket })),
        h('span', { className: 'dbs-ticket-row-main' },
          h('span', { className: 'dbs-ticket-row-title' }, ticketTitle(ticket)),
          h('span', { className: 'dbs-ticket-row-sql' }, sqlSummary(ticket.sql, 140)),
          h('span', { className: 'dbs-ticket-row-meta' },
            [safeText(ticket.id, '—'),
              safeText(ticket.connectionName, safeText(ticket.connectionId, '—')),
              safeText(ticket.database, '—'),
              safeText(ticket.createdAt, '—'),
              safeText(ticket.submittedBy, '—')].join(' · '))),
        h('span', { className: 'dbs-ticket-row-est' }, ticketEstimatedListText(ticket)))))
      }

      return h('div', { className: 'dbs-view' },
        h('div', { className: 'dbs-view-head' },
          h('div', { className: 'dbs-view-heading' },
            h('div', { className: 'dbs-view-title' }, t('tickets.title')),
            h('div', { className: 'dbs-view-sub' }, t('tickets.subtitle'))),
          h('span', { className: 'dbs-grow' }),
          props.onOpenHistory
            ? h('button', {
              type: 'button', className: 'dbs-btn is-small',
              disabled: !selectedId,
              onClick: () => props.onOpenHistory(selectedId),
            }, h(Icon, { name: 'list', size: 12 }), t('tickets.openHistory'))
            : null,
          h('button', {
            type: 'button', className: 'dbs-btn is-small', onClick: reloadAll, disabled: listState.loading,
          }, h(Icon, { name: 'refresh', size: 13 }), t('tickets.refresh'))),
        h(WritesWindowBar, {
          state: windowState,
          busy: windowBusy,
          onSet: setWindow,
        }),
        h('div', { className: 'dbs-view-chips' }, TICKET_FILTERS.map(entry => h('button', {
          key: entry[0],
          type: 'button',
          className: 'dbs-chip' + (filter === entry[0] ? ' is-on' : ''),
          onClick: () => { setFilter(entry[0]); setSelectedId(''); setOffset(0) },
        }, t(entry[1]),
        entry[0] !== 'all' && counts && typeof counts[entry[0]] === 'number'
          ? h('span', { className: 'dbs-chip-count' }, String(counts[entry[0]]))
          : null))),
        h('div', { className: 'dbs-view-chips' },
          h('input', {
            type: 'text', className: 'dbs-input is-small',
            'aria-label': t('tickets.search.placeholder'),
            placeholder: t('tickets.search.placeholder'),
            value: keywordInput,
            onChange: event => setKeywordInput(event.target.value),
            onKeyDown: event => {
              if (event.key === 'Enter') {
                setKeyword(String(keywordInput || '').trim())
                setOffset(0)
                setSelectedId('')
              }
            },
          }),
          h('button', {
            type: 'button', className: 'dbs-btn is-small',
            onClick: () => { setKeyword(String(keywordInput || '').trim()); setOffset(0); setSelectedId('') },
          }, t('tickets.search.apply'))),
        notice
          ? h('div', { className: 'dbs-notice is-' + notice.tone }, notice.text,
            h(NoticeClose, { onClose: () => setNotice(null) }))
          : null,
        h('div', { className: 'dbs-view-split' },
          h('div', { className: 'dbs-ticket-list-pane' },
            listBody,
            // 翻页条常显（第 47 轮，用户反馈「工单页面缺少分页查询」）：第 45 轮的实现是总数
            // >50 或已翻页才显示——单页内整个分页控件不可见，容易被认为没有分页。
            // 现在列表加载成功即显示（总数/页码可见），单页时上下页按钮禁用。
            listTotal !== null
              ? h('div', { className: 'dbs-history-page', 'data-dbs-testid': 'tickets-pager' },
                h('button', {
                  type: 'button', className: 'dbs-btn is-small',
                  'data-dbs-testid': 'tickets-prev-page',
                  onClick: () => setOffset(current => Math.max(0, current - TICKET_PAGE_SIZE)),
                  disabled: offset <= 0,
                }, t('history.page.prev')),
                h('button', {
                  type: 'button', className: 'dbs-btn is-small',
                  'data-dbs-testid': 'tickets-next-page',
                  onClick: () => setOffset(current => current + TICKET_PAGE_SIZE),
                  disabled: listTotal !== null && offset + TICKET_PAGE_SIZE >= listTotal,
                }, t('history.page.next')),
                h('span', { className: 'dbs-history-page-info' },
                  t('history.page.summary', {
                    total: formatNumber(listTotal),
                    page: formatNumber(Math.floor(offset / TICKET_PAGE_SIZE) + 1),
                  })))
              : null),
          h('div', { className: 'dbs-ticket-detail-pane' },
            h(TicketDetailPane, {
              ticket: selectedTicket,
              loading: detailState.loading,
              error: detailState.error,
              busy,
              onRetry: detailState.reload,
              onAction: openAction,
              onUndo: openUndo,
            }))),
        action
          ? h(TicketActionModal, {
            preview: action,
            busy,
            comment,
            error: actionError,
            onCommentChange: setComment,
            onClose: () => { setAction(null); setActionError(null) },
            onConfirm: confirmAction,
          })
          : null,
        undoPreview
          ? h(UndoConfirmModal, {
            undo: undoPreview,
            busy: undoBusy,
            error: undoError,
            onClose: () => { setUndoPreview(null); setUndoError(null) },
            onConfirm: confirmUndo,
          })
          : null)
    }
