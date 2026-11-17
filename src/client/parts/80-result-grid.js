
    // ======================================================================
    // 8. 结果网格 + 单个结果集卡片
    // ======================================================================

    function ResultGrid(props) {
      const columns = normalizeColumns(props.columns)
      const rows = Array.isArray(props.rows) ? props.rows : []
      // 第 48 轮：行编辑态（结构化工单）——单元格就地 input、行首勾选标删、末尾追加新行
      const editing = Boolean(props.editing)
      const editedCells = editing && props.editedCells ? props.editedCells : {}
      const deletedRows = editing && props.deletedRows ? props.deletedRows : {}
      const extraRows = editing && Array.isArray(props.extraRows) ? props.extraRows : []
      return h('div', { className: 'dbs-grid-wrap' },
        h('table', { className: 'dbs-grid' + (editing ? ' is-editing' : '') },
          h('thead', null,
            h('tr', null,
              editing ? h('th', { className: 'dbs-grid-edit', title: t('results.edit.deleteCol') },
                t('results.edit.deleteShort')) : null,
              h('th', { className: 'dbs-rownum' }, '#'),
              columns.map((column, index) => h('th', {
                key: 'head:' + index,
                title: column.type ? column.name + ' · ' + column.type : column.name,
              },
              h('span', { className: 'dbs-th-name' }, column.name),
              column.type ? h('span', { className: 'dbs-th-type' }, column.type) : null)))),
          h('tbody', null,
            rows.map((row, rowIndex) => h('tr', {
              key: 'row:' + rowIndex,
              className: deletedRows[rowIndex] ? ' is-deleted' : '',
            },
            editing ? h('td', { className: 'dbs-grid-edit' },
              h('input', {
                type: 'checkbox',
                name: 'deleteRow-' + rowIndex,
                'aria-label': t('results.edit.deleteMark', { n: rowIndex + 1 }),
                checked: Boolean(deletedRows[rowIndex]),
                onChange: () => { if (props.onEditToggleDelete) props.onEditToggleDelete(rowIndex) },
              })) : null,
            h('td', { className: 'dbs-rownum' }, String(rowIndex + 1)),
            columns.map((column, columnIndex) => {
              const value = rowValue(row, columnIndex, column.name)
              const text = cellText(value)
              const numeric = !editing && typeof value === 'number'
              const title = text !== null && text.length > 800 ? text.slice(0, 800) + '…' : text
              if (editing) {
                return h('td', { key: 'cell:' + columnIndex, className: 'dbs-cell' },
                  h('input', {
                    className: 'dbs-cell-input' + (editedCells[rowIndex + ',' + columnIndex] !== undefined
                      ? ' is-dirty' : ''),
                    name: 'cell-' + rowIndex + '-' + columnIndex,
                    'aria-label': column.name,
                    defaultValue: text === null ? '' : text,
                    placeholder: text === null ? 'NULL' : undefined,
                    onChange: event => {
                      if (props.onEditCellInput) {
                        props.onEditCellInput(rowIndex, columnIndex,
                          event && event.target ? event.target.value : '')
                      }
                    },
                  }))
              }
              return h('td', {
                key: 'cell:' + columnIndex,
                className: 'dbs-cell' + (numeric ? ' is-num' : ''),
                title: title === null ? undefined : title,
              }, text === null ? h('span', { className: 'dbs-null' }, 'NULL') : text)
            }))),
            extraRows.map((extraRow, extraIndex) => h('tr', { key: 'new:' + extraRow.key, className: ' is-new-row' },
              h('td', { className: 'dbs-grid-edit' },
                h('button', {
                  type: 'button', className: 'dbs-notice-close', title: t('results.edit.removeNewRow'),
                  'aria-label': t('results.edit.removeNewRow'),
                  onClick: () => { if (props.onEditRemoveNewRow) props.onEditRemoveNewRow(extraRow.key) },
                }, '×')),
              h('td', { className: 'dbs-rownum' }, '+' + String(extraIndex + 1)),
              columns.map((column, columnIndex) => h('td', {
                key: 'new-cell:' + columnIndex, className: 'dbs-cell',
              },
              h('input', {
                className: 'dbs-cell-input' + (extraRow.values[column.name] !== undefined
                  && extraRow.values[column.name] !== '' ? ' is-dirty' : ''),
                name: 'new-cell-' + extraRow.key + '-' + columnIndex,
                'aria-label': column.name,
                value: extraRow.values[column.name] !== undefined ? String(extraRow.values[column.name]) : '',
                onChange: event => {
                  if (props.onEditNewRowInput) {
                    props.onEditNewRowInput(extraRow.key, column.name,
                      event && event.target ? event.target.value : '')
                  }
                },
              })))))))
      )
    }

    function exportFormatLabel(format) {
      if (format === 'insert') return t('results.formatInsert')
      if (format === 'json') return t('results.formatJson')
      return t('results.formatExcel')
    }

    /**
     * 结果卡片工具栏的导出按钮（第 46 轮统一导出入口）：不再前端直下，
     * 一律提交导出工单（人工批准 → 程序重跑该语句分批取数 → 工单页下载 xlsx/JSON/INSERT）。
     */
    function ResultExportMenu(props) {
      const [busy, setBusy] = useState(false)
      const total = props.total || 0
      const run = () => {
        if (!props.onExport || busy || total === 0) return
        setBusy(true)
        Promise.resolve(props.onExport()).then(
          () => setBusy(false),
          () => setBusy(false),
        )
      }
      return h('span', { className: 'dbs-export' },
        h('button', {
          type: 'button',
          className: 'dbs-btn is-small',
          title: t('results.exportTip'),
          disabled: busy || total === 0,
          onClick: run,
        }, busy ? t('results.exporting') : t('results.export')))
    }
