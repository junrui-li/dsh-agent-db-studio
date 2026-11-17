
    // ======================================================================
    // 3. 通用工具：错误文案、数字/字节/TTL、单元格、复制
    // ======================================================================

    function errorText(error) {
      if (error === null || error === undefined) return ''
      if (typeof error === 'string') return error
      if (isAbort(error)) return ''
      const message = error.message ? String(error.message) : String(error)
      const suffix = error.status
        ? '（HTTP ' + error.status + (error.code ? ' · ' + error.code : '') + '）'
        : ''
      return message + suffix
    }

    function formatNumber(value) {
      const n = Number(value)
      if (!Number.isFinite(n)) return String(value)
      try {
        return n.toLocaleString()
      } catch (error) {
        return String(n)
      }
    }

    function formatBytes(bytes) {
      const n = Number(bytes)
      if (!Number.isFinite(n) || n < 0) return ''
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB'
      return (n / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function formatTtlText(ttl) {
      if (ttl === null || ttl === undefined) return t('common.dash')
      const n = Number(ttl)
      if (!Number.isFinite(n)) return String(ttl)
      if (n === -1) return t('redis.ttlForever')
      if (n === -2) return t('redis.ttlExpired')
      if (n >= 86400) return t('redis.ttlDays', { n: Math.floor(n / 86400) })
      if (n >= 3600) return t('redis.ttlHours', { n: Math.floor(n / 3600) })
      return t('redis.ttlSeconds', { n })
    }

    function formatTtlShort(ttl) {
      if (ttl === null || ttl === undefined) return ''
      const n = Number(ttl)
      if (!Number.isFinite(n) || n === -2) return ''
      if (n === -1) return '∞'
      return n + 's'
    }

    /** 单元格值 → 展示文本；null/undefined 交给调用方渲染 NULL。 */
    function cellText(value) {
      if (value === null || value === undefined) return null
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value)
      try {
        return JSON.stringify(value)
      } catch (error) {
        return String(value)
      }
    }

    function prettyJson(value) {
      try {
        return JSON.stringify(value, null, 2)
      } catch (error) {
        return String(value)
      }
    }

    /** 列定义归一化：允许字符串列名或 {name,type}。 */
    function normalizeColumns(columns) {
      if (!Array.isArray(columns)) return []
      return columns.map((column, index) => {
        if (typeof column === 'string') return { name: column, type: '' }
        if (!column || typeof column !== 'object') return { name: 'column_' + (index + 1), type: '' }
        const name = column.name !== undefined && column.name !== null
          ? String(column.name)
          : (column.label !== undefined && column.label !== null ? String(column.label) : 'column_' + (index + 1))
        return { name, type: column.type ? String(column.type) : '' }
      })
    }

    /** 重名列去重，供复制 JSON/CSV 使用。 */
    function uniqueColumnNames(columns) {
      const seen = {}
      return columns.map(column => {
        const base = column.name || 'column'
        const count = seen[base] || 0
        seen[base] = count + 1
        return count === 0 ? base : base + '_' + (count + 1)
      })
    }

    function rowValue(row, index, name) {
      if (Array.isArray(row)) return row[index]
      if (row && typeof row === 'object') return row[name]
      return undefined
    }

    function rowsToObjects(columns, rows) {
      const names = uniqueColumnNames(columns)
      return (rows || []).map(row => {
        const object = {}
        names.forEach((name, index) => {
          const value = rowValue(row, index, columns[index] ? columns[index].name : name)
          object[name] = value === undefined ? null : value
        })
        return object
      })
    }
