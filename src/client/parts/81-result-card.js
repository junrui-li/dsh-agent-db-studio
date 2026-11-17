
    function ResultCard(props) {
      const result = props.result || {}
      const columns = normalizeColumns(result.columns)
      const rows = Array.isArray(result.rows) ? result.rows : []
      const failed = Boolean(result.error)
      const isRows = !failed && result.kind !== 'exec' && columns.length > 0
      const elapsed = result.elapsedMs !== undefined && result.elapsedMs !== null
        ? result.elapsedMs
        : props.fallbackElapsed
      const maxRows = props.maxRows || DEFAULT_MAX_ROWS
      // 第 48 轮：行编辑（结构化工单）——可编辑性由主键预取结果决定（单表+主键+非只读）
      const originalIndex = props.originalIndex !== undefined ? props.originalIndex : (props.index || 0)
      const editMeta = props.editMetaFor ? props.editMetaFor(result) : { editable: false }
      const editing = Boolean(props.rowEdit && props.rowEdit.state
        && props.rowEdit.state.resultIndex === originalIndex)
      const actions = []
      if (isRows && rows.length) {
        if (editing) {
          actions.push(h('button', {
            key: 'edit-commit',
            type: 'button', className: 'dbs-btn is-primary is-small',
            title: t('results.edit.commitTip'),
            onClick: () => { if (props.onEditCommit) props.onEditCommit() },
          }, h(Icon, { name: 'save', size: 12 }), t('results.edit.commit')))
          actions.push(h('button', {
            key: 'edit-add',
            type: 'button', className: 'dbs-btn is-small', title: t('results.edit.newRowTip'),
            onClick: () => { if (props.onEditAddRow) props.onEditAddRow() },
          }, h(Icon, { name: 'plus', size: 12 }), t('results.edit.newRow')))
          actions.push(h('button', {
            key: 'edit-cancel',
            type: 'button', className: 'dbs-btn is-small', title: t('results.edit.cancelTip'),
            onClick: () => { if (props.onEditCancel) props.onEditCancel() },
          }, t('results.edit.cancel')))
        } else {
          const editReason = editMeta.editable ? '' : (editMeta.reason || t('results.edit.checking'))
          actions.push(h('button', {
            key: 'edit-start',
            type: 'button', className: 'dbs-btn is-small',
            title: editMeta.editable ? t('results.edit.buttonTip') : editReason,
            disabled: !editMeta.editable,
            onClick: () => { if (props.onEditStart) props.onEditStart(originalIndex) },
          }, h(Icon, { name: 'edit', size: 12 }), t('results.edit.button')))
          // 第 49 轮：置灰原因显性化——不再只靠悬停 title，直接显示在按钮旁
          if (editReason) {
            actions.push(h('span', { key: 'edit-reason', className: 'dbs-edit-reason' }, editReason))
          }
        }
        actions.push(h('button', {
          key: 'row-detail',
          type: 'button', className: 'dbs-btn is-small', title: t('results.rowDetail.buttonTip'),
          onClick: () => { if (props.onRowDetail) props.onRowDetail(originalIndex) },
        }, h(Icon, { name: 'list', size: 12 }), t('results.rowDetail.button')))
        // 第 46 轮统一导出入口：导出按钮（走工单），选中行导出已随统一入口移除
        actions.push(h(ResultExportMenu, {
          key: 'export',
          total: rows.length,
          onExport: props.onExport,
        }))
      }
      actions.push(h('button', {
        key: 'clear-results',
        type: 'button',
        className: 'dbs-btn is-small',
        title: t('results.clearTip'),
        onClick: () => { if (props.onClear) props.onClear() },
      }, t('results.clear')))
      if (props.onClose) {
        actions.push(h('button', {
          key: 'close-result',
          type: 'button',
          className: 'dbs-result-close',
          title: t('results.close', { n: formatNumber((props.index || 0) + 1) }),
          'aria-label': t('results.close', { n: formatNumber((props.index || 0) + 1) }),
          onClick: () => props.onClose(),
        }, '×'))
      }
      return h('section', { className: 'dbs-result' + (failed ? ' is-error' : '') },
        h('header', { className: 'dbs-result-head' },
          h('span', { className: 'dbs-result-index' }, '#' + (props.index + 1)),
          failed
            ? h(Tag, { tone: 'danger' }, t('results.failed'))
            : h(Tag, { tone: 'plain' }, result.kind === 'exec' ? t('results.kindExec') : t('results.kindRows')),
          failed ? null : h('span', { className: 'dbs-muted' }, isRows
            ? t('results.rows', { n: formatNumber(result.rowCount !== undefined && result.rowCount !== null ? result.rowCount : rows.length) })
            : t('results.affected', { n: formatNumber(result.affectedRows || 0) })),
          elapsed !== undefined && elapsed !== null
            ? h('span', { className: 'dbs-muted' }, t('results.elapsed', { n: formatNumber(elapsed) }))
            : null,
          !failed && result.truncated ? h(Tag, { tone: 'warn' }, t('results.truncated', { n: formatNumber(maxRows) })) : null,
          // 第 49 轮：工具栏按钮统一左对齐（grow 移到按钮组之后）
          actions,
          h('span', { className: 'dbs-grow' }),
          props.exportNotice
            ? h('span', {
              className: props.exportNoticeOk ? 'dbs-export-notice is-ok' : 'dbs-export-error',
            }, props.exportNotice,
            props.onExportNoticeClose ? h(NoticeClose, { onClose: props.onExportNoticeClose }) : null)
            : null,
          result.sql ? h('span', { className: 'dbs-result-sql', title: String(result.sql) }, String(result.sql)) : null),
        failed
          ? h('div', { className: 'dbs-pad' }, h('pre', { className: 'dbs-error-pre' }, String(result.error)))
          : isRows
            ? (rows.length
              ? h(ResultGrid, Object.assign(
                { columns, rows },
                editing && props.rowEdit && props.rowEdit.state ? {
                  editing: true,
                  editedCells: props.rowEdit.state.editedCells,
                  deletedRows: props.rowEdit.state.deletedRows,
                  extraRows: props.rowEdit.state.newRows,
                  onEditCellInput: props.onEditCellInput,
                  onEditToggleDelete: props.onEditToggleDelete,
                  onEditNewRowInput: props.onEditNewRowInput,
                  onEditRemoveNewRow: props.onEditRemoveNewRow,
                } : {}))
              : h('div', { className: 'dbs-pad dbs-muted' }, t('results.emptySet')))
            : h('div', { className: 'dbs-pad dbs-muted' },
              t('results.execSummary', { n: formatNumber(result.affectedRows || 0) })))
    }

    /**
     * 结果区：单结果集直接渲染卡片；多结果集渲染可关闭的结果 tab。
     * entries: [{result, index}]（已过滤掉被关闭的结果集，index 为原始索引）。
     * 第 46 轮：行选择随「导出选中行」移除，导出统一走工单（全量结果集）。
     */
    function ResultsPane(props) {
      const entries = Array.isArray(props.entries) ? props.entries : []
      if (!entries.length) {
        return h('div', { className: 'dbs-empty is-small' },
          h(Icon, { name: 'code', size: 24 }),
          h('div', { className: 'dbs-empty-title' }, t('results.closedEmpty')),
          h('div', { className: 'dbs-empty-hint' }, t('results.closedEmptyHint')))
      }
      const found = entries.findIndex(entry => entry.index === props.activeIndex)
      const activePosition = found >= 0 ? found : 0
      const activeEntry = entries[activePosition]
      const active = activeEntry ? activeEntry.result : {}
      const originalIndex = activeEntry ? activeEntry.index : 0
      const failed = Boolean(active.error)
      const isRows = !failed && active.kind !== 'exec' && normalizeColumns(active.columns).length > 0
      const maxRows = props.maxRows || DEFAULT_MAX_ROWS
      const elapsed = active.elapsedMs !== undefined && active.elapsedMs !== null
        ? active.elapsedMs
        : props.fallbackElapsed
      const lastVisible = entries[entries.length - 1] ? entries[entries.length - 1].result : null
      const truncatedNote = lastVisible && lastVisible.truncated
        ? h('div', { key: 'truncated-stop', className: 'dbs-note' }, t('results.truncatedStop'))
        : null
      // 第 48 轮：可编辑性元信息（主键预取缓存）+ 编辑态判定
      const editMetaFor = result => {
        const sqlText = String((result && result.sql) || '')
        const cached = props.pkCache ? props.pkCache[sqlText] : null
        if (!cached) return { ready: false, editable: false, reason: t('results.edit.checking') }
        if (!cached.ok) return { ready: true, editable: false, reason: cached.reason || t('results.edit.noPk') }
        const readonly = Boolean(props.connectionReadonly)
        const masked = Boolean(props.connectionMasked)
        // 结果集必须包含全部主键列，否则无法按主键定位行（SELECT 只查了部分列时挡下）
        const pkColumns = Array.isArray(cached.pkColumns) ? cached.pkColumns : []
        const columnNames = normalizeColumns(result.columns).map(col => String(col.name || ''))
        const missingPk = pkColumns.filter(pk => columnNames.indexOf(pk) < 0)
        if (missingPk.length) {
          return {
            ready: true, editable: false,
            reason: t('results.edit.noPkInResult', { cols: missingPk.join(', ') }),
          }
        }
        return {
          ready: true,
          editable: !readonly && !masked,
          reason: readonly ? t('results.edit.readonly')
            : masked ? t('results.edit.masked') : '',
          table: cached.table,
        }
      }
      const isEditingResult = originalIndexValue => Boolean(props.rowEdit && props.rowEdit.state
        && props.rowEdit.state.resultIndex === originalIndexValue)
      const paneProps = {
        onExport: () => (props.onExport ? props.onExport(originalIndex) : null),
        onClear: () => { if (props.onClear) props.onClear() },
        onRowDetail: originalIndexValue => {
          if (props.onRowDetail) props.onRowDetail(originalIndexValue)
        },
        onEditStart: originalIndexValue => {
          if (props.onEditStart) props.onEditStart(originalIndexValue)
        },
        onEditCancel: () => { if (props.onEditCancel) props.onEditCancel() },
        onEditAddRow: () => { if (props.onEditAddRow) props.onEditAddRow() },
        onEditCommit: () => { if (props.onEditCommit) props.onEditCommit() },
        editMetaFor,
        rowEdit: props.rowEdit || null,
        onEditCellInput: props.onEditCellInput,
        onEditToggleDelete: props.onEditToggleDelete,
        onEditNewRowInput: props.onEditNewRowInput,
        onEditRemoveNewRow: props.onEditRemoveNewRow,
      }

      if (entries.length <= 1) {
        return h('div', { className: 'dbs-result-list' },
          h(ResultCard, Object.assign({}, paneProps, {
            result: active,
            index: activePosition,
            originalIndex,
            maxRows: props.maxRows,
            fallbackElapsed: props.fallbackElapsed,
            exportNotice: props.exportNotice,
            exportNoticeOk: props.exportNoticeOk,
            onClose: () => { if (props.onClose) props.onClose(originalIndex) },
          })),
          truncatedNote)
      }

      const actions = []
      if (isRows && Array.isArray(active.rows) && active.rows.length) {
        if (isEditingResult(originalIndex)) {
          actions.push(h('button', {
            key: 'edit-commit', type: 'button', className: 'dbs-btn is-primary is-small',
            title: t('results.edit.commitTip'),
            onClick: () => { if (props.onEditCommit) props.onEditCommit() },
          }, h(Icon, { name: 'save', size: 12 }), t('results.edit.commit')))
          actions.push(h('button', {
            key: 'edit-add', type: 'button', className: 'dbs-btn is-small', title: t('results.edit.newRowTip'),
            onClick: () => { if (props.onEditAddRow) props.onEditAddRow() },
          }, h(Icon, { name: 'plus', size: 12 }), t('results.edit.newRow')))
          actions.push(h('button', {
            key: 'edit-cancel', type: 'button', className: 'dbs-btn is-small', title: t('results.edit.cancelTip'),
            onClick: () => { if (props.onEditCancel) props.onEditCancel() },
          }, t('results.edit.cancel')))
        } else {
          const editMeta = editMetaFor(active)
          const editReason = editMeta.editable ? '' : (editMeta.reason || t('results.edit.checking'))
          actions.push(h('button', {
            key: 'edit-start', type: 'button', className: 'dbs-btn is-small',
            title: editMeta.editable ? t('results.edit.buttonTip') : editReason,
            disabled: !editMeta.editable,
            onClick: () => { if (props.onEditStart) props.onEditStart(originalIndex) },
          }, h(Icon, { name: 'edit', size: 12 }), t('results.edit.button')))
          if (editReason) {
            actions.push(h('span', { key: 'edit-reason', className: 'dbs-edit-reason' }, editReason))
          }
        }
        actions.push(h('button', {
          key: 'row-detail', type: 'button', className: 'dbs-btn is-small', title: t('results.rowDetail.buttonTip'),
          onClick: () => { if (props.onRowDetail) props.onRowDetail(originalIndex) },
        }, h(Icon, { name: 'list', size: 12 }), t('results.rowDetail.button')))
        actions.push(h(ResultExportMenu, {
          key: 'export',
          total: active.rows.length,
          onExport: paneProps.onExport,
        }))
      }
      if (active.truncated) {
        actions.push(h(Tag, { key: 'truncated', tone: 'warn' }, t('results.truncated', { n: formatNumber(maxRows) })))
      }
      actions.push(h('button', {
        key: 'clear-results',
        type: 'button',
        className: 'dbs-btn is-small',
        title: t('results.clearTip'),
        onClick: () => { if (props.onClear) props.onClear() },
      }, t('results.clear')))
      if (props.exportNotice) {
        actions.push(h('span', {
          key: 'export-notice',
          className: props.exportNoticeOk ? 'dbs-export-notice is-ok' : 'dbs-export-error',
        }, props.exportNotice,
        props.onExportNoticeClose ? h(NoticeClose, { onClose: props.onExportNoticeClose }) : null))
      }

      const body = failed
        ? h('div', { className: 'dbs-pad' }, h('pre', { className: 'dbs-error-pre' }, String(active.error)))
        : isRows
          ? (Array.isArray(active.rows) && active.rows.length
            ? h(ResultGrid, Object.assign(
              { columns: normalizeColumns(active.columns), rows: active.rows },
              isEditingResult(originalIndex) && props.rowEdit && props.rowEdit.state ? {
                editing: true,
                editedCells: props.rowEdit.state.editedCells,
                deletedRows: props.rowEdit.state.deletedRows,
                extraRows: props.rowEdit.state.newRows,
                onEditCellInput: props.onEditCellInput,
                onEditToggleDelete: props.onEditToggleDelete,
                onEditNewRowInput: props.onEditNewRowInput,
                onEditRemoveNewRow: props.onEditRemoveNewRow,
              } : {}))
            : h('div', { className: 'dbs-pad dbs-muted' }, t('results.emptySet')))
          : h('div', { className: 'dbs-pad dbs-muted' }, t('results.execSummary', { n: formatNumber(active.affectedRows || 0) }))

      return h('div', { className: 'dbs-result-panel' },
        h('div', { className: 'dbs-result-tabs' },
          // 第 49 轮：工具栏按钮统一左对齐（actions 移到 tab 栏左侧）
          h('div', { className: 'dbs-result-tab-actions' }, actions),
          h('div', { className: 'dbs-result-tabs-scroll', role: 'tablist' }, entries.map((entry, index) => {
            const result = entry.result
            const resultFailed = Boolean(result.error)
            const resultRows = Array.isArray(result.rows) ? result.rows.length : 0
            const resultElapsed = result.elapsedMs !== undefined && result.elapsedMs !== null
              ? result.elapsedMs
              : props.fallbackElapsed
            const badges = []
            if (resultFailed) {
              badges.push(h('span', { key: 'b:error', className: 'dbs-result-tab-badge is-danger' }, t('results.failed')))
            } else {
              badges.push(h('span', { key: 'b:rows', className: 'dbs-result-tab-badge' },
                result.kind === 'exec'
                  ? t('results.affected', { n: formatNumber(result.affectedRows || 0) })
                  : t('results.rows', {
                    n: formatNumber(result.rowCount !== undefined && result.rowCount !== null ? result.rowCount : resultRows),
                  })))
              if (resultElapsed !== undefined && resultElapsed !== null) {
                badges.push(h('span', { key: 'b:ms', className: 'dbs-result-tab-badge dbs-muted' },
                  t('results.elapsed', { n: formatNumber(resultElapsed) })))
              }
            }
            return h('span', {
              key: 'tab-wrap:' + entry.index,
              className: 'dbs-result-tab-wrap',
            },
            h('button', {
              type: 'button',
              role: 'tab',
              'aria-selected': entry.index === originalIndex ? 'true' : 'false',
              className: 'dbs-result-tab' + (entry.index === originalIndex ? ' is-on' : '') + (resultFailed ? ' is-error' : ''),
              title: result.sql ? String(result.sql) : undefined,
              onClick: () => { if (props.onSelect) props.onSelect(entry.index) },
            },
            h('span', { className: 'dbs-result-tab-label' },
              t('results.tabLabel', { n: index + 1 }) + ' · ' + resultStatementLabel(result)),
            badges),
            h('button', {
              type: 'button',
              className: 'dbs-result-tab-close',
              title: t('results.close', { n: formatNumber(index + 1) }),
              'aria-label': t('results.close', { n: formatNumber(index + 1) }),
              onClick: () => { if (props.onClose) props.onClose(entry.index) },
            }, '×'))
          }))),
        h('div', { className: 'dbs-result-tab-body' }, body),
        truncatedNote)
    }
