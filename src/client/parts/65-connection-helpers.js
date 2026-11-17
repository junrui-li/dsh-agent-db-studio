
    // ======================================================================
    // 6.5 连接管理弹窗：新建 / 编辑 / 测试（密码留空=保留）
    // ======================================================================

    /** 内置五类：开启脱敏即强制，任何界面都不得删除/取消。 */
    const MASKING_MANDATORY_TYPES = ['name', 'phone', 'idcard', 'bankcard', 'email']
    const MASKING_TYPE_KEYS = {
      name: 'masking.type.name',
      phone: 'masking.type.phone',
      idcard: 'masking.type.idcard',
      bankcard: 'masking.type.bankcard',
      email: 'masking.type.email',
      generic: 'masking.type.generic',
    }

    /** 后端 type → 前端策略类型：已知类型原样保留，未知 type 也保留原文（展示兜底，不崩溃）。 */
    function maskingTypeOf(rawType) {
      const type = rawType === undefined || rawType === null ? '' : String(rawType)
      return type || 'generic'
    }

    function maskingTypeLabel(type) {
      const key = MASKING_TYPE_KEYS[type]
      return key ? t(key) : safeText(type, t('masking.type.generic'))
    }

    function isMandatoryMaskingCandidate(candidate) {
      if (!candidate) return false
      if (candidate.mandatory === true) return true
      return MASKING_MANDATORY_TYPES.indexOf(candidate.type) >= 0
    }

    /** 连接是否开启脱敏：兼容后端 masking 对象与列表里的 maskingEnabled 布尔。 */
    function connectionMaskingEnabled(connection) {
      if (!connection) return false
      if (connection.maskingEnabled === true) return true
      return Boolean(connection.masking && connection.masking.enabled === true)
    }

    function emptyMaskingDraft() {
      return { enabled: false, keywords: [], fields: [], candidates: [], summary: null, analyzedAt: '' }
    }

    /** masking 后端结构 → 表单草稿；fields 原样保留（关闭脱敏再保存时不能清空策略）。 */
    function maskingDraftFrom(connection) {
      const masking = connection && connection.masking && typeof connection.masking === 'object'
        ? connection.masking
        : null
      const enabled = masking ? masking.enabled === true : Boolean(connection && connection.maskingEnabled)
      const keywords = masking && Array.isArray(masking.keywords)
        ? masking.keywords.map(keyword => String(keyword)).filter(Boolean)
        : []
      const fields = masking && Array.isArray(masking.fields) ? masking.fields : []
      const normalizedFields = fields.map(field => ({
        table: safeText(field.table),
        column: safeText(field.column),
        type: maskingTypeOf(field.type),
        mandatory: Boolean(field.mandatory)
          || MASKING_MANDATORY_TYPES.indexOf(field.type) >= 0,
        reason: safeText(field.reason),
      })).filter(field => field.table && field.column)
      return {
        enabled,
        keywords,
        fields: normalizedFields,
        candidates: [],
        summary: masking && masking.summary ? masking.summary : null,
        analyzedAt: masking && masking.analyzedAt ? String(masking.analyzedAt) : '',
      }
    }

    function normalizeSuggestCandidates(list) {
      if (!Array.isArray(list)) return []
      return list.map(candidate => {
        const item = candidate && typeof candidate === 'object' ? candidate : {}
        const type = maskingTypeOf(item.type)
        return {
          table: safeText(item.table),
          column: safeText(item.column),
          type,
          mandatory: Boolean(item.mandatory) || MASKING_MANDATORY_TYPES.indexOf(type) >= 0,
          reason: safeText(item.reason),
          source: item.source === 'ai' ? 'ai' : 'rule',
          selected: true,
        }
      }).filter(candidate => candidate.table || candidate.column)
    }

    /** 合并候选：同一 table+column 保留既有选择；强制项永远勾选。 */
    function mergeMaskingCandidates(existing, incoming) {
      const merged = []
      const seen = {}
      const add = candidate => {
        const key = String(candidate.table || '') + '\u0000' + String(candidate.column || '')
        if (seen[key]) return
        seen[key] = true
        const mandatory = isMandatoryMaskingCandidate(candidate)
        merged.push(Object.assign({}, candidate, {
          mandatory,
          selected: mandatory ? true : candidate.selected !== false,
        }))
      }
      ;(existing || []).forEach(add)
      ;(incoming || []).forEach(add)
      return merged
    }

    function maskingFieldsFromCandidates(candidates) {
      return (candidates || [])
        .filter(candidate => isMandatoryMaskingCandidate(candidate) || candidate.selected !== false)
        .map(candidate => ({
          table: safeText(candidate.table),
          column: safeText(candidate.column),
          type: candidate.type || 'generic',
          mandatory: isMandatoryMaskingCandidate(candidate),
          reason: safeText(candidate.reason),
        }))
    }

    function maskingSummaryText(summary) {
      if (!summary || typeof summary !== 'object') return ''
      return t('masking.summary', {
        tables: numberOrNull(summary.tables) === null ? t('common.dash') : formatNumber(summary.tables),
        columns: numberOrNull(summary.columns) === null ? t('common.dash') : formatNumber(summary.columns),
        masked: numberOrNull(summary.masked) === null ? t('common.dash') : formatNumber(summary.masked),
      })
    }

    function emptyConnectionDraft() {
      return {
        id: '', kind: 'mysql', name: '', host: '127.0.0.1', port: 3306,
        user: '', database: '', readonly: true, timeout: 60, maxRows: 500,
        password: '', clearPassword: false, hasPassword: false,
        masking: emptyMaskingDraft(),
      }
    }

    function connectionDraftFrom(connection) {
      return {
        id: String(connection.id || ''),
        kind: connection.kind === 'redis' ? 'redis' : 'mysql',
        name: String(connection.name || ''),
        host: String(connection.host || ''),
        port: connection.port ? Number(connection.port) : (connection.kind === 'redis' ? 6379 : 3306),
        user: String(connection.user || ''),
        database: String(connection.database || ''),
        readonly: Boolean(connection.readonly),
        timeout: connection.timeout ? Number(connection.timeout) : 60,
        maxRows: connection.maxRows ? Number(connection.maxRows) : DEFAULT_MAX_ROWS,
        password: '',
        clearPassword: false,
        hasPassword: Boolean(connection.hasPassword),
        masking: maskingDraftFrom(connection),
      }
    }

    function validateConnectionDraft(draft) {
      if (!String(draft.name || '').trim()) return t('connmgr.required', { field: t('connmgr.fieldName') })
      if (!String(draft.host || '').trim()) return t('connmgr.required', { field: t('connmgr.fieldHost') })
      const port = Number(draft.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) return t('connmgr.badPort')
      const timeout = Number(draft.timeout)
      if (!Number.isInteger(timeout) || timeout < 1) return t('connmgr.badNumber', { field: t('connmgr.fieldTimeout') })
      const maxRows = Number(draft.maxRows)
      if (!Number.isInteger(maxRows) || maxRows < 1) return t('connmgr.badNumber', { field: t('connmgr.fieldMaxRows') })
      return ''
    }

    function buildConnectionPayload(draft) {
      const connection = {
        kind: draft.kind === 'redis' ? 'redis' : 'mysql',
        name: String(draft.name || '').trim(),
        host: String(draft.host || '').trim(),
        port: Number(draft.port),
        user: String(draft.user || ''),
        database: String(draft.database || '').trim(),
        readonly: Boolean(draft.readonly),
        timeout: Number(draft.timeout),
        maxRows: Number(draft.maxRows),
      }
      if (draft.id) connection.id = draft.id
      if (draft.clearPassword) connection.clearPassword = true
      else if (draft.password) connection.password = String(draft.password)
      // 密码为空时绝不发 password 字段：后端语义 = 保留原密码
      // 脱敏只有 MySQL 有意义；强制五项由后端保存时补回，这里只送 enabled/keywords/fields
      if (connection.kind === 'mysql') {
        const masking = draft.masking || emptyMaskingDraft()
        // 关键：fields 用草稿里保留的已存策略（关闭脱敏时也不能清空）；AI 候选只进树页面预选
        const fields = Array.isArray(masking.fields) && masking.fields.length
          ? masking.fields.map(field => ({
            table: safeText(field.table),
            column: safeText(field.column),
            type: maskingTypeOf(field.type),
            mandatory: Boolean(field.mandatory)
              || MASKING_MANDATORY_TYPES.indexOf(field.type) >= 0,
            reason: safeText(field.reason),
          })).filter(field => field.table && field.column)
          : []
        connection.masking = {
          enabled: Boolean(masking.enabled),
          keywords: Array.isArray(masking.keywords) ? masking.keywords.map(keyword => String(keyword)) : [],
          fields,
        }
      }
      return connection
    }

    /**
     * 连接表单里的脱敏编辑器（契约 §3.7）。
     * - 关键字 chips（逗号/回车分隔）
     * - AI 分析候选（Host /masking/suggest，失败回退后端规则由 Host 负责）
     * - 内置五类强制项：选择器锁定、锁图标 + tooltip；树顶部固定列出五项内置策略
     * 新建连接还没有 id 时不能 AI 分析（提示先保存）；保存时后端会再分析并补回强制项。
     */
    const MASKING_POLICY_NONE = 'none'

    function maskingPolicyLabel(type) {
      return type === MASKING_POLICY_NONE ? t('masking.policy.none') : maskingTypeLabel(type)
    }

    /** AI suggest 返回的 model 字段 → 「provider/model」展示串（兼容对象/字符串）。 */
    function describeAiModel(model) {
      if (!model) return ''
      if (typeof model === 'string') return model.trim()
      if (typeof model !== 'object') return ''
      const provider = model.provider ? String(model.provider) : ''
      const name = model.model ? String(model.model) : ''
      if (provider && name) return provider + '/' + name
      return provider || name
    }

    /** 后端 error 原文 → 展示用摘要（200 字符截断）+ 全文（title）。 */
    function maskingErrorNotice(text) {
      const full = String(text || '')
      return {
        full,
        preview: full.length > 200 ? full.slice(0, 200) + '…' : full,
      }
    }

    function maskingColumnList(columns) {
      if (!Array.isArray(columns)) return []
      return columns.map((column, index) => {
        const item = column && typeof column === 'object' ? column : { name: String(column) }
        return {
          name: safeText(item.name, 'column_' + (index + 1)),
          type: safeText(item.type),
          comment: safeText(item.comment),
        }
      })
    }

    function maskingEntryName(entry) {
      if (typeof entry === 'string') return entry
      if (!entry || typeof entry !== 'object') return ''
      return entry.name !== undefined && entry.name !== null ? String(entry.name) : ''
    }

    function maskingPolicyKey(table, column) {
      return String(table) + '\u0000' + String(column)
    }

    /** connection.masking.fields + AI 候选 → 树上的策略映射（key=table\u0000column）。 */
    function maskingPolicyMapFromConnection(connection, presets) {
      const map = {}
      const masking = connection && connection.masking && typeof connection.masking === 'object'
        ? connection.masking
        : null
      const fields = masking && Array.isArray(masking.fields) ? masking.fields : []
      fields.forEach(field => {
        if (!field || !field.table || !field.column) return
        const type = maskingTypeOf(field.type)
        map[maskingPolicyKey(field.table, field.column)] = {
          type,
          mandatory: Boolean(field.mandatory) || MASKING_MANDATORY_TYPES.indexOf(type) >= 0,
          reason: safeText(field.reason),
          ai: false,
        }
      })
      ;(presets || []).forEach(candidate => {
        if (!candidate || !candidate.table || !candidate.column) return
        const type = maskingTypeOf(candidate.type)
        const key = maskingPolicyKey(candidate.table, candidate.column)
        const previous = map[key] || {}
        map[key] = {
          type,
          mandatory: Boolean(candidate.mandatory)
            || MASKING_MANDATORY_TYPES.indexOf(type) >= 0
            || Boolean(previous.mandatory),
          reason: safeText(candidate.reason) || previous.reason || '',
          ai: true,
        }
      })
      return map
    }
