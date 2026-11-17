
    // ===== 导出工具开始 =====
    const EXPORT_INSERT_BATCH = 200

    function exportPad2(value) {
      return value < 10 ? '0' + value : String(value)
    }

    function exportTimestamp(date) {
      const value = date || new Date()
      return String(value.getFullYear())
        + exportPad2(value.getMonth() + 1)
        + exportPad2(value.getDate())
        + '-' + exportPad2(value.getHours())
        + exportPad2(value.getMinutes())
        + exportPad2(value.getSeconds())
    }

    function exportSanitizeName(name) {
      return String(name || 'query')
        .replace(/[\\/:*?"<>|\r\n\t\s]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'query'
    }

    /** 从结果集 SQL 解析第一个 FROM / JOIN 的表名；解析不到返回 result_set。 */
    function parseExportTableName(sql) {
      const match = /\b(?:from|join)\s+([A-Za-z0-9_$`."]+)/i.exec(String(sql || ''))
      if (!match) return 'result_set'
      let table = String(match[1]).replace(/`/g, '').replace(/"/g, '')
      if (table.indexOf('.') >= 0) table = table.slice(table.lastIndexOf('.') + 1)
      return table || 'result_set'
    }

    function sqlLiteral(value) {
      if (value === null || value === undefined) return 'NULL'
      if (typeof value === 'boolean') return value ? '1' : '0'
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL'
      if (typeof value === 'bigint') return String(value)
      let text = typeof value === 'string' ? value : String(value)
      text = text.replace(/\\/g, '\\\\')
        .replace(/'/g, "''")
        .replace(/\r/g, '\\r')
        .replace(/\n/g, '\\n')
        .replace(/\t/g, '\\t')
      return "'" + text + "'"
    }

    /** INSERT 语句导出（每批 200 行），文件头带来源/时间/SQL 摘要/脱敏提示。 */
    function buildInsertText(options) {
      const opt = options || {}
      const columns = normalizeColumns(opt.columns)
      const rows = Array.isArray(opt.rows) ? opt.rows : []
      const names = uniqueColumnNames(columns)
      const table = parseExportTableName(opt.sql)
      const sqlSummary = String(opt.sql || '').replace(/\s+/g, ' ').trim()
      const lines = [
        '-- 导出时间: ' + String(opt.exportedAt || new Date().toISOString()),
        '-- 来源连接: ' + String(opt.connectionName || ''),
        '-- SQL: ' + (sqlSummary.length > 200 ? sqlSummary.slice(0, 200) + '…' : sqlSummary),
        '-- 注意: 数据可能已脱敏（后端出站脱敏），按当前展示值导出',
        '',
      ]
      const tableName = '`' + table.replace(/`/g, '``') + '`'
      const columnList = ' (' + names.map(name => '`' + String(name).replace(/`/g, '``') + '`').join(', ') + ')'
      for (let start = 0; start < rows.length; start += EXPORT_INSERT_BATCH) {
        const chunk = rows.slice(start, start + EXPORT_INSERT_BATCH)
        const values = chunk.map(row => '(' + columns.map((column, columnIndex) => (
          sqlLiteral(rowValue(row, columnIndex, column.name))
        )).join(', ') + ')')
        lines.push('INSERT INTO ' + tableName + columnList + ' VALUES\n' + values.join(',\n') + ';')
        lines.push('')
      }
      return lines.join('\n')
    }

    /** JSON 导出：数组 of row objects，UTF-8 原样中文。 */
    function buildJsonText(options) {
      const opt = options || {}
      const columns = normalizeColumns(opt.columns)
      const rows = Array.isArray(opt.rows) ? opt.rows : []
      return JSON.stringify(rowsToObjects(columns, rows), null, 2)
    }

    function exportUtf8(text) {
      if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(String(text))
      const encoded = unescape(encodeURIComponent(String(text)))
      const bytes = new Uint8Array(encoded.length)
      for (let index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index)
      return bytes
    }

    function exportXmlEscape(value) {
      return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
    }

    function exportColumnLetter(index) {
      let number = index + 1
      let text = ''
      while (number > 0) {
        const remainder = (number - 1) % 26
        text = String.fromCharCode(65 + remainder) + text
        number = Math.floor((number - 1) / 26)
      }
      return text
    }

    function exportCrc32(bytes) {
      let crc = 0xFFFFFFFF
      for (let index = 0; index < bytes.length; index += 1) {
        crc ^= bytes[index]
        for (let bit = 0; bit < 8; bit += 1) {
          crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0)
        }
      }
      return (crc ^ 0xFFFFFFFF) >>> 0
    }

    function exportWriteU16(target, offset, value) {
      target[offset] = value & 0xFF
      target[offset + 1] = (value >>> 8) & 0xFF
    }

    function exportWriteU32(target, offset, value) {
      target[offset] = value & 0xFF
      target[offset + 1] = (value >>> 8) & 0xFF
      target[offset + 2] = (value >>> 16) & 0xFF
      target[offset + 3] = (value >>> 24) & 0xFF
    }

    /** zip 容器（store 不压缩，UTF-8 文件名）。files: [{name, bytes}] → Uint8Array */
    function exportZipStore(files) {
      const entries = (files || []).map(file => {
        const nameBytes = exportUtf8(file.name)
        const raw = file.bytes !== undefined ? file.bytes : (file.text !== undefined ? file.text : '')
        const data = raw instanceof Uint8Array ? raw : exportUtf8(raw)
        return {
          nameBytes,
          data,
          crc: exportCrc32(data),
          size: data.length,
        }
      })
      let localSize = 0
      let centralSize = 0
      entries.forEach(entry => {
        localSize += 30 + entry.nameBytes.length + entry.size
        centralSize += 46 + entry.nameBytes.length
      })
      const total = localSize + centralSize + 22
      const output = new Uint8Array(total)
      let offset = 0
      const localOffsets = []
      entries.forEach(entry => {
        localOffsets.push(offset)
        exportWriteU32(output, offset, 0x04034B50)
        exportWriteU16(output, offset + 4, 20)
        exportWriteU16(output, offset + 6, 0x0800)
        exportWriteU16(output, offset + 8, 0)
        exportWriteU16(output, offset + 10, 0)
        exportWriteU16(output, offset + 12, 0)
        exportWriteU32(output, offset + 14, entry.crc)
        exportWriteU32(output, offset + 18, entry.size)
        exportWriteU32(output, offset + 22, entry.size)
        exportWriteU16(output, offset + 26, entry.nameBytes.length)
        exportWriteU16(output, offset + 28, 0)
        offset += 30
        output.set(entry.nameBytes, offset)
        offset += entry.nameBytes.length
        output.set(entry.data, offset)
        offset += entry.size
      })
      const centralStart = offset
      entries.forEach((entry, index) => {
        exportWriteU32(output, offset, 0x02014B50)
        exportWriteU16(output, offset + 4, 20)
        exportWriteU16(output, offset + 6, 20)
        exportWriteU16(output, offset + 8, 0x0800)
        exportWriteU16(output, offset + 10, 0)
        exportWriteU16(output, offset + 12, 0)
        exportWriteU16(output, offset + 14, 0)
        exportWriteU32(output, offset + 16, entry.crc)
        exportWriteU32(output, offset + 20, entry.size)
        exportWriteU32(output, offset + 24, entry.size)
        exportWriteU16(output, offset + 28, entry.nameBytes.length)
        exportWriteU16(output, offset + 30, 0)
        exportWriteU16(output, offset + 32, 0)
        exportWriteU16(output, offset + 34, 0)
        exportWriteU16(output, offset + 36, 0)
        exportWriteU32(output, offset + 38, 0)
        exportWriteU32(output, offset + 42, localOffsets[index])
        offset += 46
        output.set(entry.nameBytes, offset)
        offset += entry.nameBytes.length
      })
      const centralEnd = offset
      exportWriteU32(output, offset, 0x06054B50)
      exportWriteU16(output, offset + 4, 0)
      exportWriteU16(output, offset + 6, 0)
      exportWriteU16(output, offset + 8, entries.length)
      exportWriteU16(output, offset + 10, entries.length)
      exportWriteU32(output, offset + 12, centralEnd - centralStart)
      exportWriteU32(output, offset + 16, centralStart)
      exportWriteU16(output, offset + 20, 0)
      return output
    }

    function exportXlsxCellXml(columnIndex, rowNumber, value) {
      const ref = exportColumnLetter(columnIndex) + rowNumber
      if (value === null || value === undefined) return ''
      if (typeof value === 'boolean') {
        return '<c r="' + ref + '" t="b"><v>' + (value ? '1' : '0') + '</v></c>'
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return '<c r="' + ref + '" t="n"><v>' + String(value) + '</v></c>'
      }
      let text
      if (typeof value === 'string') text = value
      else {
        try {
          text = JSON.stringify(value)
        } catch (error) {
          text = String(value)
        }
      }
      return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">'
        + exportXmlEscape(text) + '</t></is></c>'
    }

    /** 最小 xlsx 生成（5 个 XML 部件 + store zip；字符串 inlineStr，数字 t="n"）。 */
    function buildXlsxBytes(options) {
      const opt = options || {}
      const columns = normalizeColumns(opt.columns)
      const rows = Array.isArray(opt.rows) ? opt.rows : []
      const sheetRows = []
      sheetRows.push('<row r="1">' + columns.map((column, columnIndex) => (
        exportXlsxCellXml(columnIndex, 1, String(column.name))
      )).join('') + '</row>')
      rows.forEach((row, rowIndex) => {
        const rowNumber = rowIndex + 2
        const cells = columns.map((column, columnIndex) => {
          const value = rowValue(row, columnIndex, column.name)
          if (value === null || value === undefined) return ''
          return exportXlsxCellXml(columnIndex, rowNumber, value)
        }).join('')
        sheetRows.push('<row r="' + rowNumber + '">' + cells + '</row>')
      })
      const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '</Types>'
      const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>'
      const workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>'
      const workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>'
      const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + '<sheetData>' + sheetRows.join('') + '</sheetData></worksheet>'
      return exportZipStore([
        { name: '[Content_Types].xml', text: contentTypes },
        { name: '_rels/.rels', text: rels },
        { name: 'xl/workbook.xml', text: workbook },
        { name: 'xl/_rels/workbook.xml.rels', text: workbookRels },
        { name: 'xl/worksheets/sheet1.xml', text: sheet },
      ])
    }

    function buildExportFilename(options) {
      const opt = options || {}
      const extension = opt.format === 'xlsx' ? 'xlsx' : (opt.format === 'json' ? 'json' : 'sql')
      const table = parseExportTableName(opt.sql)
      const base = (opt.connectionName ? String(opt.connectionName) + '-' : '')
        + (table === 'result_set' ? 'query' : table)
        + '-' + exportTimestamp(opt.now)
      return exportSanitizeName(base) + '.' + extension
    }

    /** 浏览器下载：Blob + 临时 a[download]，不挂载到页面 body、无全局监听。 */
    function downloadExportBlob(blob, filename) {
      if (typeof Blob === 'undefined' || typeof URL === 'undefined'
        || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') {
        return false
      }
      let url = ''
      try {
        url = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = String(filename)
        anchor.rel = 'noopener'
        if (anchor.style) anchor.style.display = 'none'
        if (typeof anchor.click === 'function') anchor.click()
        return true
      } catch (error) {
        return false
      } finally {
        if (url && typeof URL.revokeObjectURL === 'function') {
          if (typeof setTimeout === 'function') {
            setTimeout(() => {
              try {
                URL.revokeObjectURL(url)
              } catch (error) {
                /* 忽略 */
              }
            }, 0)
          } else {
            try {
              URL.revokeObjectURL(url)
            } catch (error) {
              /* 忽略 */
            }
          }
        }
      }
    }
