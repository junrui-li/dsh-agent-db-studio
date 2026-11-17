    // ===== 导出工具结束 =====


    /** 复制到剪贴板；失败返回 false（页面是 127.0.0.1，属于安全上下文）。 */
    function writeClipboard(text) {
      return Promise.resolve().then(() => {
        const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null
        if (!clipboard || typeof clipboard.writeText !== 'function') return false
        return clipboard.writeText(String(text === undefined ? '' : text)).then(() => true, () => false)
      }).catch(() => false)
    }

    function redisDbValue(name) {
      const n = Number(name)
      return Number.isFinite(n) && String(n) === String(name) ? n : name
    }

    function redisValueName(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'object') {
        try {
          return JSON.stringify(value)
        } catch (error) {
          return String(value)
        }
      }
      return String(value)
    }

    // ---- SQL 只读守卫：面板不做写操作 UI，写语句留给 agent 的 db_execute（带审批） ----
    // 与后端 /api/query 的只读白名单保持一致（server/core/guard.py）
    const READ_ONLY_KEYWORDS = ['SELECT', 'SHOW', 'DESC', 'DESCRIBE', 'EXPLAIN', 'USE', 'SET']

    /** 按 ; 切分语句，跳过字符串与注释里的分号。 */
    function splitSqlStatements(sql) {
      const statements = []
      const text = String(sql)
      let current = ''
      let quote = null
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (quote) {
          current += char
          if (char === '\\' && quote !== '`') {
            index += 1
            if (index < text.length) current += text[index]
            continue
          }
          if (char === quote) {
            if (text[index + 1] === quote) {
              current += text[index + 1]
              index += 1
              continue
            }
            quote = null
          }
          continue
        }
        if (char === '\'' || char === '"' || char === '`') {
          quote = char
          current += char
          continue
        }
        if (char === '-' && text[index + 1] === '-') {
          const newline = text.indexOf('\n', index)
          if (newline < 0) {
            current += text.slice(index)
            break
          }
          current += text.slice(index, newline + 1)
          index = newline
          continue
        }
        if (char === '#') {
          const newline = text.indexOf('\n', index)
          if (newline < 0) {
            current += text.slice(index)
            break
          }
          current += text.slice(index, newline + 1)
          index = newline
          continue
        }
        if (char === '/' && text[index + 1] === '*') {
          const end = text.indexOf('*/', index + 2)
          if (end < 0) {
            current += text.slice(index)
            break
          }
          current += text.slice(index, end + 2)
          index = end + 1
          continue
        }
        if (char === ';') {
          statements.push(current)
          current = ''
          continue
        }
        current += char
      }
      statements.push(current)
      return statements.map(part => part.trim()).filter(Boolean)
    }

    function stripLeadingComments(text) {
      let value = String(text).trim()
      for (let guard = 0; guard < 8; guard += 1) {
        if (value.indexOf('--') === 0 || value.charAt(0) === '#') {
          const newline = value.indexOf('\n')
          value = newline < 0 ? '' : value.slice(newline + 1).trim()
          continue
        }
        if (value.indexOf('/*!') === 0) {
          // MySQL 条件注释：视为注释内部的语句（与后端 guard 一致）
          return value.replace(/^\/\*!\d*\s*/, '')
        }
        if (value.indexOf('/*') === 0) {
          const end = value.indexOf('*/')
          value = end < 0 ? '' : value.slice(end + 2).trim()
          continue
        }
        break
      }
      return value
    }

    function firstSqlKeyword(statement) {
      const match = /^[A-Za-z]+/.exec(stripLeadingComments(statement))
      return match ? match[0].toUpperCase() : ''
    }

    function checkReadOnlySql(sql) {
      const statements = splitSqlStatements(sql)
      if (!statements.length) return { ok: false, keyword: '', preview: '' }
      for (let index = 0; index < statements.length; index += 1) {
        const keyword = firstSqlKeyword(statements[index])
        if (READ_ONLY_KEYWORDS.indexOf(keyword) < 0) {
          return { ok: false, keyword, preview: statements[index].slice(0, 80) }
        }
      }
      return { ok: true }
    }

    // ---- SQL 补全数据（关键字 / 函数 / 别名解析） ----
    const SQL_KEYWORDS = [
      'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'AS',
      'JOIN', 'LEFT JOIN', 'RIGHT JOIN', 'INNER JOIN', 'OUTER JOIN', 'CROSS JOIN', 'ON', 'USING',
      'AND', 'OR', 'NOT', 'NULL', 'IS', 'IN', 'LIKE', 'BETWEEN', 'EXISTS', 'UNION', 'UNION ALL',
      'DISTINCT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'ASC', 'DESC', 'WITH', 'RECURSIVE',
      'INSERT INTO', 'VALUES', 'UPDATE', 'SET', 'DELETE FROM', 'CREATE TABLE', 'ALTER TABLE',
      'DROP TABLE', 'CREATE VIEW', 'IF EXISTS', 'IF NOT EXISTS', 'SHOW', 'SHOW TABLES', 'SHOW DATABASES',
      'SHOW CREATE TABLE', 'DESCRIBE', 'EXPLAIN', 'USE', 'DATABASE', 'TABLE', 'TABLES', 'VIEW',
      'PRIMARY KEY', 'AUTO_INCREMENT', 'DEFAULT', 'COLLATE', 'CHARSET', 'CURRENT_TIMESTAMP',
    ]
    const SQL_FUNCTIONS = [
      'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'IFNULL', 'NULLIF', 'COALESCE', 'CONCAT', 'CONCAT_WS',
      'SUBSTRING', 'SUBSTR', 'LENGTH', 'CHAR_LENGTH', 'TRIM', 'LTRIM', 'RTRIM', 'UPPER', 'LOWER',
      'REPLACE', 'LEFT', 'RIGHT', 'LPAD', 'RPAD', 'DATE_FORMAT', 'STR_TO_DATE', 'DATE_ADD',
      'DATE_SUB', 'DATEDIFF', 'TIMESTAMPDIFF', 'NOW', 'CURDATE', 'CURTIME', 'UNIX_TIMESTAMP',
      'FROM_UNIXTIME', 'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND', 'ROUND', 'CEIL',
      'FLOOR', 'ABS', 'MOD', 'POW', 'SQRT', 'RAND', 'GREATEST', 'LEAST', 'CAST', 'CONVERT',
      'JSON_EXTRACT', 'JSON_UNQUOTE', 'GROUP_CONCAT', 'ROW_NUMBER', 'RANK', 'DENSE_RANK',
      'OVER', 'PARTITION BY', 'LAG', 'LEAD',
    ]
    /** 关键字单色高亮 + 格式化（第 26 轮）：词级关键词集合（由 SQL_KEYWORDS 拆词派生）。 */
    const SQL_KEYWORD_WORD_SET = (() => {
      const words = new Set()
      for (const entry of SQL_KEYWORDS) {
        for (const word of String(entry).toUpperCase().split(' ')) {
          if (/^[A-Z_][A-Z0-9_]*$/.test(word)) words.add(word)
        }
      }
      words.add('BY')
      return words
    })()

    /** SQL 词法扫描（高亮 / 格式化共用）：kind = word（标识符/关键词）| raw（标点/数字/操作符）
     *  | string（字符串字面量，含引号）| comment（-- 与  完整注释）| space（代码内空白）。 */
    function sqlScanTokens(sql) {
      const tokens = []
      const text = String(sql || '')
      const n = text.length
      let index = 0
      while (index < n) {
        const ch = text[index]
        if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
          let end = index
          while (end < n && /\s/.test(text[end])) end += 1
          tokens.push({ kind: 'space', text: text.slice(index, end) })
          index = end
          continue
        }
        if (ch === "'" || ch === '"') {  // 字符串字面量（'' 与 \ 转义）
          let end = index + 1
          while (end < n) {
            if (text[end] === '\\') { end += 2; continue }
            if (text[end] === ch) {
              if (end + 1 < n && text[end + 1] === ch) { end += 2; continue }
              end += 1
              break
            }
            end += 1
          }
          tokens.push({ kind: 'string', text: text.slice(index, Math.min(end, n)) })
          index = Math.min(end, n)
          continue
        }
        if (ch === '-' && text[index + 1] === '-') {  // 行注释（含行尾换行）
          let end = text.indexOf('\n', index)
          end = end === -1 ? n : end + 1
          tokens.push({ kind: 'comment', text: text.slice(index, end) })
          index = end
          continue
        }
        if (ch === '/' && text[index + 1] === '*') {  // 块注释
          const end = text.indexOf('*/', index + 2)
          const stop = end === -1 ? n : end + 2
          tokens.push({ kind: 'comment', text: text.slice(index, stop) })
          index = stop
          continue
        }
        if (/[A-Za-z_]/.test(ch)) {  // 标识符 / 关键词
          let end = index
          while (end < n && /[A-Za-z0-9_$]/.test(text[end])) end += 1
          const word = text.slice(index, end)
          tokens.push({ kind: 'word', text: word, upper: word.toUpperCase(),
                        kw: SQL_KEYWORD_WORD_SET.has(word.toUpperCase()) })
          index = end
          continue
        }
        // 其余：数字（含小数）/ 多字符操作符 / 单标点
        if (/[0-9]/.test(ch)) {
          let end = index
          while (end < n && /[0-9.]/.test(text[end])) end += 1
          tokens.push({ kind: 'raw', text: text.slice(index, end) })
          index = end
          continue
        }
        const opMatch = text.slice(index).match(/^(<=>|>=|<=|<>|!=|:=|<<|>>|->>|->)/)
        if (opMatch) {
          tokens.push({ kind: 'raw', text: opMatch[0] })
          index += opMatch[0].length
          continue
        }
        tokens.push({ kind: 'raw', text: ch })
        index += 1
      }
      return tokens
    }

    /** 高亮 tokens：[{text, kw, comment}]（kw = 关键字；comment = 注释，渲染置灰但仍可读）；
     * 相邻普通文本（含字符串）合并；拼接恒等于原文——高亮层按 tokens 切分渲染，不能增删字符。 */
    function sqlHighlightTokens(sql) {
      const tokens = sqlScanTokens(sql)
      const output = []
      let plain = ''
      const flush = () => {
        if (plain) { output.push({ text: plain, kw: false, comment: false }); plain = '' }
      }
      for (const token of tokens) {
        if (token.kind === 'word' && token.kw) {
          flush()
          output.push({ text: token.text, kw: true, comment: false })
        } else if (token.kind === 'comment') {
          flush()
          output.push({ text: token.text, kw: false, comment: true })
        } else {
          plain += token.text
        }
      }
      flush()
      return output
    }

    const SQL_FORMAT_MAJOR = new Set(['SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING',
      'LIMIT', 'OFFSET', 'VALUES', 'SET', 'UNION', 'EXCEPT', 'INTERSECT'])
    const SQL_FORMAT_JOIN = new Set(['JOIN', 'INNER', 'LEFT', 'RIGHT', 'OUTER', 'CROSS', 'STRAIGHT_JOIN'])
    const SQL_FORMAT_SUB = new Set(['AND', 'OR'])
    const SQL_FORMAT_NOSPACE_BEFORE = new Set([',', ')', ';', '.'])  // '*' 仅在 ./(/ 后贴左（见 starGlued）
    const SQL_FUNCTION_WORD_SET = new Set(SQL_FUNCTIONS.map(name => name.toUpperCase()))
    const SQL_FORMAT_NOSPACE_AFTER = new Set(['(', '.'])

    /** 一键格式化（第 26 轮）：关键词大写；SELECT/FROM/WHERE 等主子句前断行；JOIN 短语缩进 2 格；
     *  AND/OR 换行缩进 4 格；字符串/注释原样保留；多条语句以「;」+ 空行分隔。启发式排版，不改语义。 */
    function formatSql(sql) {
      const tokens = sqlScanTokens(sql)
      let out = ''
      let prevUpper = ''   // 上一个关键词的大写（判断 JOIN 短语起点）
      let prevWord = ''    // 上一个词的大写（不限关键字；判断函数名贴 (）
      let prevRaw = ''     // 上一个发射的可见字符（判断空格）
      let prevKind = ''
      const endsOpen = () => out.endsWith('(') || out.endsWith('.')
      const needsSpace = () => out !== '' && !out.endsWith('\n') && !out.endsWith(' ') && !endsOpen()
      for (const token of tokens) {
        if (token.kind === 'space') continue
        if (token.kind === 'string' || token.kind === 'comment') {
          if (needsSpace() && token.kind === 'string') out += ' '
          out += token.text
          if (token.kind === 'comment' && token.text.endsWith('\n')) {
            out = out.replace(/[ \t]+\n/g, '\n')
            prevRaw = ''
          } else {
            prevRaw = token.text.slice(-1)
          }
          prevKind = token.kind
          continue
        }
        if (token.kind === 'word') {
          const upper = token.upper
          if (SQL_KEYWORD_WORD_SET.has(upper)) {
            let prefix = ''
            if (SQL_FORMAT_MAJOR.has(upper)) prefix = '\n'
            else if (SQL_FORMAT_JOIN.has(upper) && !SQL_FORMAT_JOIN.has(prevUpper)) prefix = '\n  '
            else if (SQL_FORMAT_SUB.has(upper)) prefix = '\n    '
            if (prefix && out) {
              if (out.endsWith('\n')) prefix = prefix.slice(1)  // 行注释已带换行：只保留缩进，避免叠出空行
              if (prefix) out = out.replace(/[ \t]+$/, '') + prefix
            } else if (needsSpace()) out += ' '
            out += upper
            prevUpper = upper
          } else {
            if (needsSpace()) out += ' '
            out += token.text
            prevUpper = ''
          }
          prevWord = upper  // 任意词的大写：函数名后的 ( 贴左（count(*)）
          prevRaw = token.text.slice(-1)
          prevKind = 'word'
          continue
        }
        // raw：标点 / 数字 / 操作符
        let piece = token.text
        if (piece === ';') {
          out = out.replace(/[ \t]+$/, '')
          out += ';\n\n'   // 语句之间空一行；下一条主子句的断行会因行首去重不再叠加
          prevUpper = ''
          prevRaw = ''
          prevKind = 'raw'
          continue
        }
        const starGlued = piece === '*' && (prevRaw === '.' || endsOpen())  // t.* / count(*)
        const parenGlued = piece === '(' && prevKind === 'word' && SQL_FUNCTION_WORD_SET.has(prevWord)
        if ((piece.length === 1 && SQL_FORMAT_NOSPACE_BEFORE.has(piece)) || starGlued || parenGlued) {
          out = out.replace(/[ \t]+$/, '') + piece       // 贴左：, ) . *（* 仅在 ./(/ 后贴左）
        } else if (prevRaw === '' || prevRaw === '(' || prevKind === '' ) {
          out += piece                                    // 语句开头 / 紧跟 ( .
        } else if (SQL_FORMAT_NOSPACE_AFTER.has(prevRaw)) {
          out += piece                                    // ( . 之后贴右
        } else if (prevKind === 'string' && /[-+*/=<>!,;]/.test(piece)) {
          out += piece
        } else {
          out += ' ' + piece                              // 操作符两边留空格
        }
        prevRaw = piece.slice(-1)
        prevUpper = ''
        prevKind = 'raw'
      }
      return out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    }

    const SQL_ALIAS_STOPWORDS = [
      'WHERE', 'ON', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'CROSS', 'GROUP', 'ORDER',
      'LIMIT', 'HAVING', 'UNION', 'SET', 'VALUES', 'USING', 'AND', 'OR', 'AS', 'STRAIGHT_JOIN',
    ]

    /** 解析 SQL 里的 FROM/JOIN/UPDATE/INTO <table> [AS] <alias>，返回 alias(小写)→table。 */
    function parseSqlAliases(sql) {
      const map = {}
      const text = String(sql || '')
      const pattern = /\b(?:from|join|update|into)\s+([A-Za-z0-9_$`]+)(?:\s+(?:as\s+)?([A-Za-z0-9_$`]+))?/gi
      let match = pattern.exec(text)
      while (match) {
        const rawTable = String(match[1] || '').replace(/`/g, '')
        const rawAlias = match[2] ? String(match[2]).replace(/`/g, '') : ''
        const table = rawTable.indexOf('.') >= 0 ? rawTable.slice(rawTable.lastIndexOf('.') + 1) : rawTable
        if (table) {
          map[table.toLowerCase()] = table
          const alias = rawAlias && SQL_ALIAS_STOPWORDS.indexOf(rawAlias.toUpperCase()) < 0 ? rawAlias : table
          if (alias) map[alias.toLowerCase()] = table
        }
        match = pattern.exec(text)
      }
      return map
    }

    /** 光标前最后一段标识符（用于补全替换）：返回 {prefix, qualifier, start}。 */
    function completionContextOf(value, caret) {
      const text = String(value || '')
      const position = typeof caret === 'number' ? Math.max(0, Math.min(caret, text.length)) : text.length
      const before = text.slice(0, position)
      const prefixMatch = /[A-Za-z0-9_$]*$/.exec(before)
      const prefix = prefixMatch ? prefixMatch[0] : ''
      const start = position - prefix.length
      const beforePrefix = before.slice(0, start)
      const qualifierMatch = /([A-Za-z0-9_$]+)\.$/.exec(beforePrefix)
      return {
        prefix,
        qualifier: qualifierMatch ? qualifierMatch[1] : '',
        start,
        position,
      }
    }

    /**
     * 光标所在子句：屏蔽字符串/注释后，取最后一条语句里最近出现的子句关键字。
     * 返回 'tables'（FROM/JOIN/UPDATE/INTO 之后）| 'columns'（SELECT/WHERE/ON/HAVING/ORDER/GROUP/SET/USING）| 'keyword'。
     */
    function completionClauseAt(value, position) {
      const text = String(value || '').slice(0, Math.max(0, typeof position === 'number' ? position : 0))
      let masked = ''
      let quote = null
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index]
        if (quote) {
          masked += char === '\n' ? '\n' : ' '
          if (char === '\\' && quote !== '`') {
            index += 1
            masked += ' '
            continue
          }
          if (char === quote) {
            if (text[index + 1] === quote) {
              index += 1
              masked += ' '
              continue
            }
            quote = null
          }
          continue
        }
        if (char === '\'' || char === '"' || char === '`') {
          quote = char
          masked += ' '
          continue
        }
        if (char === '-' && text[index + 1] === '-') {
          while (index < text.length && text[index] !== '\n') {
            masked += ' '
            index += 1
          }
          masked += '\n'
          continue
        }
        if (char === '#') {
          while (index < text.length && text[index] !== '\n') {
            masked += ' '
            index += 1
          }
          masked += '\n'
          continue
        }
        if (char === '/' && text[index + 1] === '*') {
          masked += ' '
          index += 1
          while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
            masked += text[index] === '\n' ? '\n' : ' '
            index += 1
          }
          if (index < text.length) {
            index += 1
            masked += ' '
          }
          continue
        }
        masked += char
      }
      const segment = masked.slice(masked.lastIndexOf(';') + 1).toUpperCase()
      const pattern = /\b(FROM|JOIN|UPDATE|INTO|WHERE|SELECT|ON|HAVING|ORDER|GROUP|BY|SET|USING)\b/g
      let clause = ''
      let found = pattern.exec(segment)
      while (found) {
        clause = found[1]
        found = pattern.exec(segment)
      }
      if (!clause) return 'keyword'
      if (clause === 'FROM' || clause === 'JOIN' || clause === 'UPDATE' || clause === 'INTO') return 'tables'
      return 'columns'
    }

    /** 词边界：needle 在 _ / 数字 / 驼峰 / 中文等边界之后出现的位置（找不到返回 -1）。 */
    function completionWordBoundaryIndex(label, needleLower) {
      const lower = label.toLowerCase()
      let index = lower.indexOf(needleLower, 1)
      while (index > 0) {
        const before = label.charCodeAt(index - 1)
        const current = label.charCodeAt(index)
        if (before === 95 || (before >= 48 && before <= 57)
          || before === 36 || before === 46 || before === 64
          || before > 0x2E80 || (current >= 65 && current <= 90)) {
          return index
        }
        index = lower.indexOf(needleLower, index + 1)
      }
      return -1
    }

    /** 子序列命中且返回首尾跨度（needle 字符按序出现，可跳字符）；不命中返回 -1。 */
    function completionSubsequenceSpan(needleLower, labelLower) {
      let cursor = 0
      let first = -1
      let last = -1
      for (let index = 0; index < labelLower.length && cursor < needleLower.length; index += 1) {
        if (labelLower.charCodeAt(index) === needleLower.charCodeAt(cursor)) {
          if (cursor === 0) first = index
          last = index
          cursor += 1
        }
      }
      return cursor < needleLower.length ? -1 : last - first + 1
    }

    /**
     * 近似子串编辑距离：以 label 为底、needle 逐行 DP，首行全 0、取最后一行最小值；
     * 相邻转置算 1 次。O(needle × label)，不建正则、不 split。
     */
    function completionApproxSubstringDistance(needleLower, labelLower, allowed) {
      const needleLength = needleLower.length
      const labelLength = labelLower.length
      if (!needleLength) return 0
      if (labelLength < needleLength - allowed) return allowed + 1
      let previousPrevious = null
      let previous = new Array(labelLength + 1)
      for (let column = 0; column <= labelLength; column += 1) previous[column] = 0
      for (let row = 1; row <= needleLength; row += 1) {
        const current = new Array(labelLength + 1)
        current[0] = row
        const needleCode = needleLower.charCodeAt(row - 1)
        for (let column = 1; column <= labelLength; column += 1) {
          const cost = needleCode === labelLower.charCodeAt(column - 1) ? 0 : 1
          let value = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + cost)
          if (previousPrevious && row > 1 && column > 1
            && needleLower.charCodeAt(row - 2) === labelLower.charCodeAt(column - 1)
            && needleCode === labelLower.charCodeAt(column - 2)) {
            value = Math.min(value, previousPrevious[column - 2] + 1)
          }
          current[column] = value
        }
        previousPrevious = previous
        previous = current
      }
      let best = previous[0]
      for (let column = 1; column <= labelLength; column += 1) {
        if (previous[column] < best) best = previous[column]
      }
      return best
    }

    /** needle 字符多重集在 label 中的覆盖率（用于最后的重叠兜底）。 */
    function completionCharOverlapRatio(needleLower, labelLower) {
      if (!needleLower.length) return 0
      const counts = {}
      for (let index = 0; index < labelLower.length; index += 1) {
        const code = labelLower.charCodeAt(index)
        counts[code] = (counts[code] || 0) + 1
      }
      let matched = 0
      for (let index = 0; index < needleLower.length; index += 1) {
        const code = needleLower.charCodeAt(index)
        if (counts[code]) {
          counts[code] -= 1
          matched += 1
        }
      }
      return matched / needleLower.length
    }

    /**
     * 分层模糊补全：完全相等 > 前缀 > 词边界 > 子串 > 子序列 > 拼写容错 > 字符重叠兜底。
     * 命中任意一层就保留（不再"打错一个字母就没提示"）；同层按位置/跨度/距离细分。
     * 排序：分数降序 → 来源 rank（关键字>函数>表>字段）→ label 长度升序 → 字典序。
     */
    function matchCompletionItems(items, prefix, limit) {
      const max = limit || 30
      const needle = String(prefix || '').toLowerCase()
      const needleLength = needle.length
      if (!needleLength) {
        return items.slice()
          .sort((left, right) => (
            (left.rank || 0) - (right.rank || 0)
            || String(left.label).length - String(right.label).length
            || String(left.label).localeCompare(String(right.label))
          ))
          .slice(0, max)
      }
      const allowed = needleLength > 6 ? 2 : 1
      const typoEnabled = needleLength >= 3
      const overlapEnabled = needleLength >= 4
      const scored = []
      items.forEach(item => {
        const label = String(item.label || '')
        if (!label) return
        const lower = label.toLowerCase()
        let score = -1
        if (lower === needle) {
          score = 100000
        } else if (lower.indexOf(needle) === 0) {
          // 前缀同层：分数一致，短候选靠后面的长度排序保证在前（来源 rank 优先）
          score = 90000
        } else {
          const boundary = completionWordBoundaryIndex(label, needle)
          if (boundary > 0) {
            score = 80000 - boundary * 3
          } else {
            const substringAt = lower.indexOf(needle)
            if (substringAt > 0) {
              score = 70000 - substringAt * 2
            } else {
              const span = completionSubsequenceSpan(needle, lower)
              // 子序列只在 ≥3 字符输入启用，且跨度太松（如 usre→user_name 跨 9 字符）噪声大不保留
              if (needleLength >= 3 && span > 0 && span - needleLength <= 4) {
                score = 60000 - (span - needleLength) * 5
              } else if (typoEnabled) {
                const distance = completionApproxSubstringDistance(needle, lower, allowed)
                if (distance <= allowed) {
                  score = 50000 - distance * 200 - Math.abs(label.length - needleLength) * 3
                }
              }
              if (score < 0 && overlapEnabled) {
                const ratio = completionCharOverlapRatio(needle, lower)
                if (ratio >= 0.7) {
                  score = 10000 - Math.round((1 - ratio) * 1000) - Math.abs(label.length - needleLength) * 2
                }
              }
            }
          }
        }
        if (score >= 0) scored.push({ item, score, length: label.length })
      })
      scored.sort((left, right) => (
        right.score - left.score
        || (left.item.rank || 0) - (right.item.rank || 0)
        || left.length - right.length
        || String(left.item.label).localeCompare(String(right.item.label))
      ))
      return scored.slice(0, max).map(entry => entry.item)
    }

    /** 结果集 tab 的语句标签（SELECT / SHOW / 执行）。 */
    function resultStatementLabel(result) {
      const keyword = firstSqlKeyword((result && result.sql) || '')
      if (keyword) return keyword
      return result && result.kind === 'exec' ? 'EXEC' : 'SELECT'
    }

    /** 补全候选的来源标签。 */
    function completionKindLabel(item) {
      const kind = item && item.kind
      if (kind === 'function') return t('sql.completeFunction')
      if (kind === 'table') return t('sql.completeTable')
      if (kind === 'view') return t('sql.completeView')
      if (kind === 'column') return t('sql.completeColumn')
      return t('sql.completeKeyword')
    }

    /** 表名/字段名插入时按需加反引号（保持 SQL 合法）。 */
    function quoteCompletionName(name) {
      const text = String(name === undefined || name === null ? '' : name)
      if (/^[A-Za-z0-9_$]+$/.test(text)) return text
      return '`' + text.replace(/`/g, '``') + '`'
    }

    // ---- 工单 / 执行历史：领域工具与字段兜底 ----

    const TICKET_STATUS_KEYS = {
      pending: 'tickets.status.pending',
      approved: 'tickets.status.approved',
      executing: 'tickets.status.executing',
      succeeded: 'tickets.status.succeeded',
      failed: 'tickets.status.failed',
      rejected: 'tickets.status.rejected',
      cancelled: 'tickets.status.cancelled',
      undone: 'tickets.status.undone',   // 第 43 轮：变更已撤销（终态，不可再执行）
    }

    function safeText(value, fallback) {
      if (value === undefined || value === null || value === '') return fallback || ''
      return String(value)
    }

    function numberOrNull(value) {
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }

    function ticketStatusLabel(status) {
      const key = TICKET_STATUS_KEYS[status]
      return key ? t(key) : t('tickets.status.unknown')
    }

    function ticketStatusTone(status) {
      if (status === 'failed') return 'danger'
      if (status === 'pending' || status === 'executing') return 'warn'
      if (status === 'succeeded' || status === 'approved') return 'link'
      if (status === 'undone') return 'warn'   // 已撤销：需要一眼可见，但非错误
      return 'plain'
    }

    function ticketRiskLabel(risk) {
      if (risk === 'high') return t('tickets.risk.high')
      if (risk === 'medium') return t('tickets.risk.medium')
      return t('tickets.risk.low')
    }

    function ticketRiskTone(risk) {
      if (risk === 'high') return 'danger'
      if (risk === 'medium') return 'warn'
      return 'link'
    }

    function ticketTitle(ticket) {
      const raw = ticket || {}
      if (raw.title) return String(raw.title)
      const sql = String(raw.sql || '').trim()
      const keyword = firstSqlKeyword(sql)
      return keyword ? keyword : safeText(raw.id, 'ticket')
    }

    /** 工单语句数（新旧字段兜底）。 */
    function ticketStatementCount(ticket) {
      const estimated = ticket && ticket.estimated
      if (!estimated) return 0
      if (estimated.statementCount !== null && estimated.statementCount !== undefined) {
        return Number(estimated.statementCount) || 0
      }
      return estimated.statements ? estimated.statements.length : 0
    }

    /** 多语句工单列表里的预估列文案：单条保持原样，多条显示「N 条 · 合计 X 行」。 */
    function ticketEstimatedListText(ticket) {
      const estimated = ticket && ticket.estimated
      if (!estimated) return t('tickets.detail.rowsUnknown')
      const count = ticketStatementCount(ticket) || 1
      const rows = estimated.affectedRows
      if (count > 1) {
        if (rows === null || rows === undefined) return t('tickets.list.multiNoRows', { n: count })
        return t('tickets.list.multi', { n: count, rows: formatNumber(rows) })
      }
      if (rows === null || rows === undefined) return t('tickets.detail.rowsUnknown')
      return t('tickets.detail.estimatedRows') + ' ' + formatNumber(rows)
    }

    /** EXPLAIN 计划明细的一行摘要：「ref(PRIMARY) + ALL」；无计划返回空串。 */
    function ticketPlanText(plan) {
      if (!Array.isArray(plan) || !plan.length) return ''
      return plan.map(entry => {
        if (!entry || typeof entry !== 'object') return null
        const type = entry.accessType !== null && entry.accessType !== undefined && String(entry.accessType) !== ''
          ? String(entry.accessType) : '?'
        const key = entry.key !== null && entry.key !== undefined && String(entry.key) !== ''
          ? `(${String(entry.key)})` : ''
        return type + key
      }).filter(Boolean).join(' + ')
    }

    /** 多语句 SQL 的展示版：按 ; 断行（只影响展示，复制仍用原文）。 */
    function formatTicketSqlForDisplay(sql) {
      const statements = splitSqlStatements(sql)
      if (statements.length <= 1) return String(sql || '')
      return statements.map(statement => statement + ';').join('\n\n')
    }

    function sqlSummary(sql, limit) {
      const text = String(sql || '').replace(/\s+/g, ' ').trim()
      const max = limit || 120
      return text.length > max ? text.slice(0, max) + '…' : text
    }

    /** Ticket 兜底：老数据/后端字段缺失时不让详情白屏。 */
    function normalizeTicket(raw) {
      const ticket = raw || {}
      const estimatedRaw = ticket.estimated && typeof ticket.estimated === 'object' ? ticket.estimated : null
      const estimated = estimatedRaw
        ? {
          affectedRows: numberOrNull(estimatedRaw.affectedRows),
          rowsExact: Boolean(estimatedRaw.rowsExact),
          statementCount: numberOrNull(estimatedRaw.statementCount),
          unknownStatements: numberOrNull(estimatedRaw.unknownStatements),
          risk: estimatedRaw.risk === 'high' || estimatedRaw.risk === 'medium' ? estimatedRaw.risk : 'low',
          statements: Array.isArray(estimatedRaw.statements)
            ? estimatedRaw.statements.map(statement => {
              const item = statement && typeof statement === 'object' ? statement : {}
              return {
                kind: safeText(item.kind),
                table: safeText(item.table),
                hasWhere: typeof item.hasWhere === 'boolean' ? item.hasWhere : null,
                estimatedRows: numberOrNull(item.estimatedRows),
                exact: item.exact === true,
                plan: Array.isArray(item.plan)
                  ? item.plan.map(entry => ({
                    accessType: entry && entry.accessType !== null && entry.accessType !== undefined
                      ? String(entry.accessType) : null,
                    key: entry && entry.key !== null && entry.key !== undefined
                      ? String(entry.key) : null,
                    rows: entry ? numberOrNull(entry.rows) : null,
                  }))
                  : null,
                sql: safeText(item.sql),
              }
            })
            : [],
          notes: Array.isArray(estimatedRaw.notes) ? estimatedRaw.notes.map(note => String(note)) : [],
        }
        : null
      const actualRaw = ticket.actual && typeof ticket.actual === 'object' ? ticket.actual : null
      const actual = actualRaw
        ? {
          affectedRows: numberOrNull(actualRaw.affectedRows),
          elapsedMs: numberOrNull(actualRaw.elapsedMs),
          results: Array.isArray(actualRaw.results) ? actualRaw.results : [],
          undo: actualRaw.undo && typeof actualRaw.undo === 'object'
            ? {
              available: actualRaw.undo.available === true,
              reason: safeText(actualRaw.undo.reason),
              undoId: safeText(actualRaw.undo.undoId),
            }
            : null,
        }
        : null
      return {
        id: safeText(ticket.id),
        status: TICKET_STATUS_KEYS[ticket.status] ? ticket.status : 'pending',
        kind: ticket.kind === 'export' ? 'export' : 'write',
        connectionId: safeText(ticket.connectionId),
        connectionName: safeText(ticket.connectionName),
        database: safeText(ticket.database),
        sql: String(ticket.sql || ''),
        title: safeText(ticket.title),
        background: safeText(ticket.background),
        submittedBy: ticket.submittedBy === 'user' ? 'user' : 'agent',
        createdAt: safeText(ticket.createdAt),
        approvedAt: safeText(ticket.approvedAt),
        approvedBy: safeText(ticket.approvedBy),
        approvalComment: safeText(ticket.approvalComment),
        executedAt: safeText(ticket.executedAt),
        undoneAt: safeText(ticket.undoneAt),   // 第 43/45 轮：撤销时间（详情接口按 undo_log 反查）
        estimated,
        actual,
        rowsPayload: ticket.rowsPayload && typeof ticket.rowsPayload === 'object' ? ticket.rowsPayload : null,
        error: safeText(ticket.error),
      }
    }

    function historySourceLabel(source) {
      if (source === 'panel') return t('history.source.panel')
      if (source === 'agent') return t('history.source.agent')
      if (source === 'ticket') return t('history.source.ticket')
      if (source === 'undo') return t('history.source.undo')
      return t('history.source.unknown')
    }

    function historyStatusLabel(status) {
      if (status === 'ok') return t('history.status.ok')
      if (status === 'error') return t('history.status.error')
      return t('history.status.unknown')
    }

    function historyStatusTone(status) {
      if (status === 'error') return 'danger'
      if (status === 'ok') return 'link'
      return 'plain'
    }

    /** HistoryItem 兜底：旧数据可能缺 source/database/kind/行数。 */
    function normalizeHistoryItem(raw) {
      const item = raw || {}
      return {
        id: safeText(item.id),
        connectionId: safeText(item.connectionId),
        connectionName: safeText(item.connectionName),
        database: safeText(item.database),
        sql: String(item.sql || ''),
        status: item.status === 'ok' || item.status === 'error' ? item.status : 'unknown',
        elapsedMs: numberOrNull(item.elapsedMs),
        time: safeText(item.time),
        source: item.source === 'panel' || item.source === 'agent' || item.source === 'ticket'
          || item.source === 'undo' ? item.source : 'unknown',
        kind: item.kind === 'execute' ? 'execute'
          : (item.kind === 'export' ? 'export'
            : (item.kind === 'query' ? 'query' : '')),
        statementCount: numberOrNull(item.statementCount),
        rowCount: numberOrNull(item.rowCount),
        affectedRows: numberOrNull(item.affectedRows),
        truncated: Boolean(item.truncated),
        error: safeText(item.error),
        // 第 19 轮：agent 查询目的摘要与 EXPLAIN 计划（可选字段，缺省为空）
        purpose: safeText(item.purpose),
        explain: Array.isArray(item.explain) ? item.explain : null,
        // 第 25 轮：撤销可用性摘要（available=false 时详情预判「不可撤销」并显示原因）
        undo: item.undo && typeof item.undo === 'object'
          ? {
            available: item.undo.available === true,
            reason: safeText(item.undo.reason),
          }
          : null,
        // 第 43 轮：undo_log 实时状态（active/undoing/undone）——undo_json 是执行时冻结的，
        // 已撤销的记录靠它禁用撤销按钮
        undoLive: safeText(item.undoLive),
        // 第 27 轮：工单执行的来源工单号与发起者（双向关联）
        ticketId: safeText(item.ticketId),
        ticketBy: item.ticketBy === 'agent' || item.ticketBy === 'user' ? item.ticketBy : '',
      }
    }

    function historyRowCountText(item) {
      if (!item) return t('common.dash')
      if (item.affectedRows !== null && item.affectedRows !== undefined) {
        return t('history.detail.affectedRows') + ' ' + formatNumber(item.affectedRows)
      }
      if (item.rowCount !== null && item.rowCount !== undefined) return formatNumber(item.rowCount)
      return t('common.dash')
    }
