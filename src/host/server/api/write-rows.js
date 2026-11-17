/**
 * 结构化行写（V2.3）：agent 说「把 id=3 的 status 改成 archived」，不拼 SQL 字符串。
 * server/api/write_rows.py 的移植。
 *
 * 后端用 core/sqlgen（V1 就保留的种子）生成参数化 DML：主键定位 WHERE、值一律 `?`
 * 参数化、仅标识符反引号包裹。两条路径共用同一生成逻辑：
 * - `POST /api/write-rows`：direct 模式直执行（守卫 → 快照 → 单事务）；
 * - `POST /api/tickets` 带 rowsPayload：ticket 模式建结构化工单——sql 存 render 人读文本
 *   给审批人看，rows_json 存参数化语句，批准执行走参数化管线（api/tickets.js 分支）。
 *
 * 撤销语义（诚实声明）：多行写 = 多语句，多语句 DML 可撤销（每行一个 segment，倒序
 * 回放）；undo 不可用时写错就再调一次 db_write_rows 提交反向 diff（主键精确定位）。
 */

import * as common from './common.js'
import { executeInTransaction, guardStatements } from './execute.js'
import { databaseOf, maxRowsOf } from './query.js'
import { ensureOpen } from './writes-window.js'
import * as config from '../core/config.js'
import { pool } from '../core/pool.js'
import { ApiError, ValueError } from '../core/errors.js'
import { buildDelete, buildInsert, buildUpdate, resolveKeyColumns, tableColumns }
  from '../core/sqlgen.js'
import { historyRecord } from './history.js'

const _LIST_KEYS = ['updates', 'inserts', 'deletes']

/** `db.table` / `table` → [db, table] 纯名；库名缺省回退连接 database。 */
function _splitTable(table, database) {
  const parts = String(table || '').replace(/`/g, '').split('.')
  if (parts.length === 2 && parts[0] && parts[1]) return [parts[0], parts[1]]
  if (parts.length === 1 && parts[0]) {
    const dbName = String(database || '').trim()
    if (!dbName) {
      throw new ApiError(400, '表名必须带库名（db.table），或请求里带 database', 'TABLE_DATABASE')
    }
    return [dbName, parts[0]]
  }
  throw new ApiError(400, `非法表名: ${JSON.stringify(table)}`, 'TABLE_NAME')
}

function _dictOf(value, label) {
  if (!value || typeof value !== 'object' || value instanceof Array || !Object.keys(value).length) {
    throw new ApiError(400, `${label} 必须是非空对象（列名 → 值）`)
  }
  for (const key of Object.keys(value)) {
    if (typeof key !== 'string' || !key.trim()) {
      throw new ApiError(400, `${label} 的列名必须是字符串`)
    }
  }
  const out = {}
  for (const [key, itemValue] of Object.entries(value)) out[key.trim()] = itemValue
  return out
}

function _checkColumns(valid, columns, label) {
  const unknown = columns.filter((name) => !valid.has(name))
  if (unknown.length) {
    throw new ApiError(400, `${label} 含表中不存在的列: ${unknown.sort().join(', ')}`)
  }
}

/** body → [statements, rendered, summary]；纯生成 + 连库取主键，不执行。
 * statements = [{op, sql(`?` 占位), params(list)}]；rendered = 人读文本（工单展示/审批）。 */
export async function buildRowChanges(info, database, body) {
  const table = common.textField(body, 'table', '', 'table').trim()
  if (!table) throw new ApiError(400, '缺少 table')
  const lists = {}
  for (const key of _LIST_KEYS) {
    const value = body[key]
    lists[key] = value instanceof Array ? value : []
  }
  const total = _LIST_KEYS.reduce((sum, key) => sum + lists[key].length, 0)
  if (total === 0) {
    throw new ApiError(400, 'updates / inserts / deletes 至少要有一项')
  }
  const limit = Math.max(Math.trunc(config.writeRowsMax()), 1)
  if (total > limit) {
    throw new ApiError(400,
      `一次最多 ${limit} 行（当前 ${total} 行），请分批提交`, 'WRITE_ROWS_MAX')
  }

  const [dbName, tableName] = _splitTable(table, database)
  const updates = lists.updates
  const inserts = lists.inserts
  const deletes = lists.deletes

  const { statements, rendered } = await pool.runWithRetry(
    info.id || '__draft__', info, database, async (conn) => {
      const pkColumns = await resolveKeyColumns(conn, dbName, tableName)
      if (!pkColumns.length) {
        throw new ApiError(400,
          `表 ${dbName}.${tableName} 无主键/唯一键，不支持结构化行写`, 'NO_PRIMARY_KEY')
      }
      const columnsMeta = await tableColumns(conn, dbName, tableName)
      const valid = new Set(columnsMeta.map((column) => column.name))
      const statementsOut = []
      const renderedOut = []

      const add = (built) => {
        statementsOut.push({ op: built.op, sql: built.sql, params: [...built.params] })
        renderedOut.push(built.render)
      }

      for (const [index, item] of updates.entries()) {
        if (!item || typeof item !== 'object' || item instanceof Array) {
          throw new ApiError(400, `updates[${index}] 必须是对象`)
        }
        const keys = _dictOf(item.keys, `updates[${index}].keys`)
        const sets = _dictOf(item.set, `updates[${index}].set`)
        _checkColumns(valid, Object.keys(sets), `updates[${index}].set`)
        try {
          add(buildUpdate(dbName, tableName, pkColumns, keys, sets))
        } catch (error) {
          if (error instanceof ValueError) throw new ApiError(400, `updates[${index}]: ${error.message}`)
          throw error
        }
      }

      for (const [index, row] of inserts.entries()) {
        const rowDict = _dictOf(row, `inserts[${index}]`)
        _checkColumns(valid, Object.keys(rowDict), `inserts[${index}]`)
        try {
          add(buildInsert(dbName, tableName, columnsMeta, rowDict))
        } catch (error) {
          if (error instanceof ValueError) throw new ApiError(400, `inserts[${index}]: ${error.message}`)
          throw error
        }
      }

      for (const [index, item] of deletes.entries()) {
        const keys = _dictOf(item, `deletes[${index}]`)
        try {
          add(buildDelete(dbName, tableName, pkColumns, keys))
        } catch (error) {
          if (error instanceof ValueError) throw new ApiError(400, `deletes[${index}]: ${error.message}`)
          throw error
        }
      }
      return { statements: statementsOut, rendered: renderedOut }
    })

  const summary = {
    table: `${dbName}.${tableName}`,
    updates: updates.length,
    inserts: inserts.length,
    deletes: deletes.length,
    total,
  }
  return [statements, rendered, summary]
}

/** 结构化工单存档形状（rows_json）：参数化语句 + 人读渲染，批准执行时原样还原执行。 */
export function rowsPayloadOf(statements, rendered, summary) {
  return {
    table: summary.table,
    summary: {
      updates: summary.updates, inserts: summary.inserts,
      deletes: summary.deletes, total: summary.total,
    },
    statements,
    rendered,
  }
}

/** direct 直执行：守卫 → 快照（逐行 segment，多行可撤销）→ 单事务。 */
export async function handleWriteRows(_query, body = null, headers = null) {
  const payload = common.bodyOf(body)
  const info = common.getConnection(payload)
  common.requireMysql(info)
  const database = databaseOf(payload, info)
  ensureOpen() // 闸 1.5：会话写窗口（V2.4）
  const [statements, rendered, summary] = await buildRowChanges(info, database, payload)
  guardStatements(info, statements) // 三道闸：只读连接拒绝；主键定位天然带 WHERE
  const reason = common.textField(payload, 'reason', '', 'reason')
  const result = await executeInTransaction(info, database, statements, maxRowsOf(payload, info))
  const error = result.error
  const historyId = await historyRecord(
    info, rendered.join('\n'), error === null, result.elapsedMs, error, {
      database,
      source: common.actorOf(headers) === 'agent' ? 'agent' : 'panel',
      kind: 'execute',
      statementCount: statements.length,
      rowCount: result.rowCount,
      affectedRows: result.affectedRows,
      truncated: result.truncated,
      undo: result.undo,
    })
  const undo = result.undo
  if (undo && undo.undoId) {
    const storeDb = await import('../store/db.js')
    storeDb.casUpdateUndo(undo.undoId, 'active', { historyId })
  }
  common.audit(common.actorOf(headers), 'write_rows.execute', {
    connection: info.name || '',
    connectionId: info.id || '',
    table: summary.table,
    status: error === null ? 'ok' : 'error',
    rows: summary.total,
    elapsedMs: result.elapsedMs,
    reason,
  })
  return {
    elapsedMs: result.elapsedMs,
    results: result.results,
    rendered,
    summary,
    undo,
  }
}
