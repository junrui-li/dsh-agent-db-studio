
    // ======================================================================
    // 8.2 单行详情弹层（第 48 轮）：一行全部字段 序号/字段名/值 + 行间导航
    // ======================================================================

    function RowDetailModal(props) {
      const columns = Array.isArray(props.columns) ? props.columns : []
      const rows = Array.isArray(props.rows) ? props.rows : []
      const [current, setCurrent] = useState(
        typeof props.index === 'number' && props.index >= 0 && props.index < rows.length ? props.index : 0)
      const total = rows.length
      if (!total || !columns.length) {
        return h(Modal, { open: true, title: t('results.rowDetail.title', { n: 1 }), onClose: props.onClose },
          h('div', { className: 'dbs-pad dbs-muted' }, t('results.emptySet')))
      }
      const rowIndex = Math.min(Math.max(current, 0), total - 1)
      const row = rows[rowIndex] || []
      const step = delta => setCurrent(value => Math.min(Math.max(value + delta, 0), total - 1))
      return h(Modal, {
        open: true,
        title: t('results.rowDetail.title', { n: formatNumber(rowIndex + 1) }),
        onClose: props.onClose,
        wide: true,
        focusKey: 'row-detail:' + rowIndex,
      },
      h('div', { className: 'dbs-row-detail-wrap' },
        h('table', { className: 'dbs-row-detail' },
          h('thead', null,
            h('tr', null,
              h('th', { className: 'dbs-rownum' }, t('results.rowDetail.seq')),
              h('th', null, t('results.rowDetail.fieldName')),
              h('th', null, t('results.rowDetail.value')))),
          h('tbody', null, columns.map((column, colIndex) => {
            const value = rowValue(row, colIndex, column.name)
            const text = cellText(value)
            return h('tr', { key: 'field:' + colIndex },
              h('td', { className: 'dbs-rownum' }, String(colIndex + 1)),
              h('td', { className: 'dbs-row-detail-name' },
                h('span', { className: 'dbs-th-name' }, column.name),
                column.type ? h('span', { className: 'dbs-th-type' }, column.type) : null),
              h('td', { className: 'dbs-row-detail-value' },
                text === null ? h('span', { className: 'dbs-null' }, 'NULL') : text))
          })))),
      h('div', { className: 'dbs-form-actions' },
        h('button', {
          type: 'button', className: 'dbs-btn is-small', disabled: rowIndex <= 0,
          'aria-label': t('results.rowDetail.first'), title: t('results.rowDetail.first'),
          onClick: () => step(-rowIndex),
        }, '«'),
        h('button', {
          type: 'button', className: 'dbs-btn is-small', disabled: rowIndex <= 0,
          'aria-label': t('results.rowDetail.prev'), title: t('results.rowDetail.prev'),
          onClick: () => step(-1),
        }, '‹'),
        h('span', { className: 'dbs-muted' }, t('results.rowDetail.nav', {
          n: formatNumber(rowIndex + 1), m: formatNumber(total),
        })),
        h('button', {
          type: 'button', className: 'dbs-btn is-small', disabled: rowIndex >= total - 1,
          'aria-label': t('results.rowDetail.next'), title: t('results.rowDetail.next'),
          onClick: () => step(1),
        }, '›'),
        h('button', {
          type: 'button', className: 'dbs-btn is-small', disabled: rowIndex >= total - 1,
          'aria-label': t('results.rowDetail.last'), title: t('results.rowDetail.last'),
          onClick: () => step(total - 1 - rowIndex),
        }, '»')))
    }
