/**
 * MySQL 连接池：按连接 id 池化，配置指纹失效。server/core/pool.py 的移植（mysql2）。
 *
 * 与 Python 版相同的设计要点：
 * - 每个 connection_id 一个空闲队列，借/还独占，池空新建、池满关闭。
 * - 借出前比对配置指纹（host|port|user|password|database 的 sha256），
 *   不匹配说明连接配置被改过，旧池整体作废重建。
 * - 池中闲置连接被服务器 wait_timeout 掐断时，首次执行报连接失效则丢弃重试一次。
 * - 库切换不用 USE：借出连接后统一 selectDb(db)（changeUser），避免池连接状态污染；
 *   与 Python 的 select_db（COM_INIT_DB）等价物用 mysql2 的 changeUser（COM_CHANGE_USER），
 *   副作用是会重置会话变量——发生在借出时机、任何语句之前，比 Python 更干净。
 * - 查询流式取数：Python 用 SSCursor fetchmany(max_rows+1) 取到上限即停、剩余随连接
 *   丢弃；JS 用 mysql2 的 stream() 只读到 limit+1 行，语义一致。
 *
 * 与 Python 版的差异（JS 侧的接口约定，tests/v3/helpers/fakes.mjs 同款实现）：
 * - borrow 是 async（建连异步）；api 层 handler 全 async。
 * - 查询超时：Python 用 pymysql read/write_timeout；JS 在 DbsConn 包装层对每次
 *   query/fetchMany 做竞速，超时 destroy 连接并抛 dbsConnDead 错误。
 * - BIGINT 超 JS 安全整数范围的值以字符串返回（bigNumberStrings），宁要精确值不丢数字；
 *   安全范围内的整数仍是 number，与 Python 契约一致。
 * - 连接错误识别：err.fatal（mysql2 连接级错误）或 err.dbsConnDead（超时）→ 连接不可信。
 */

import { createHash } from 'node:crypto'
import mysql from 'mysql2/promise'
import * as config from './config.js'

const _pools = new Map() // cid -> { fingerprint, idle: [DbsConn], info }

/** 配置指纹（与 Python pool.fingerprint 相同的字段序）。 */
export function fingerprint(info) {
  const raw = ['host', 'port', 'user', 'password', 'database']
    .map((k) => String(info?.[k] ?? '')).join('|')
  return createHash('sha256').update(raw).digest('hex')
}

function _drain(idle) {
  for (const conn of idle.splice(0)) {
    try { conn.destroy() } catch { /* 已经死掉就算了 */ }
  }
}

/** 建一条新连接并包成 DbsConn。 */
async function _connect(info, db) {
  const timeout = Math.trunc(Number(info.timeout || 0)) || config.defaultTimeout()
  const conn = await mysql.createConnection({
    host: info.host,
    port: Number(info.port || 0) || 3306,
    user: info.user,
    password: info.password || '',
    charset: 'utf8mb4',
    rowsAsArray: true, // 契约 rows 是数组的数组；列名/类型从 fields 取
    supportBigNumbers: true,
    bigNumberStrings: true, // 超 JS 安全整数的 BIGINT 回字符串（不丢精度）
    decimalNumbers: false, // DECIMAL → 字符串（契约）
    multipleStatements: false, // 多语句由 sqlsplit 拆分后逐条执行
    connectTimeout: config.CONNECT_TIMEOUT * 1000,
  })
  return new DbsConn(conn, timeout)
}

/**
 * DbsConn：mysql2 连接的统一包装（超时竞速 + fetchMany 流式取数）。
 * api 层与测试假连接都实现这一套接口：
 *   query(sql, params) / execute(sql, params) → [rows, fields]
 *   fetchMany(sql, params, limit) → { rows, fields }（rows 可达 limit+1 条）
 *   selectDb(db) / beginTransaction() / commit() / rollback() / end() / destroy()
 * query 返回值形态：有结果集 → [rows(数组), fields]；exec → [OkPacket, undefined]。
 */
export class DbsConn {
  constructor(conn, timeoutSeconds) {
    this._conn = conn // mysql2/promise 连接
    this._timeoutMs = Math.max(1, timeoutSeconds) * 1000
    this._dead = false
    this.lastInsertId = 0
    this.lastAffectedRows = 0
  }

  _timeoutRace(promise, label) {
    let timer = null
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        this._dead = true
        try { this._conn.destroy() } catch { /* 忽略 */ }
        const err = new Error(`${label}超时（${Math.round(this._timeoutMs / 1000)} 秒）`)
        err.dbsConnDead = true
        err.code = 'DBS_QUERY_TIMEOUT'
        reject(err)
      }, this._timeoutMs)
    })
    return Promise.race([promise, timeout]).finally(() => {
      if (timer) clearTimeout(timer)
    })
  }

  async query(sql, params) {
    const promise = params === undefined || params === null
      ? this._conn.query(sql)
      : this._conn.query(sql, params)
    const [rows, fields] = await this._timeoutRace(promise, '查询')
    if (fields === undefined || fields === null) {
      // exec 语句：mysql2 返回 OkPacket（多语句时为数组，取首条）
      const packet = Array.isArray(rows) ? rows[0] : rows
      this.lastAffectedRows = Number(packet?.affectedRows ?? 0)
      this.lastInsertId = Number(packet?.insertId ?? 0)
    }
    return [rows, fields]
  }

  async execute(sql, params) {
    if (params === undefined || params === null) return this.query(sql)
    const [rows, fields] = await this._timeoutRace(this._conn.query(sql, params), '查询')
    if (fields === undefined || fields === null) {
      const packet = Array.isArray(rows) ? rows[0] : rows
      this.lastAffectedRows = Number(packet?.affectedRows ?? 0)
      this.lastInsertId = Number(packet?.insertId ?? 0)
    }
    return [rows, fields]
  }

  /** 流式取数：只读到 limit+1 行即停（对应 SSCursor fetchmany(max_rows+1)）。
   * 连接上有未读数据时由调用方标记 discard（不还池），这里不做清理。 */
  async fetchMany(sql, params, limit) {
    const started = Date.now()
    const rawConn = this._conn.connection ?? this._conn
    let fields = null
    return await new Promise((resolve, reject) => {
      let settled = false
      const rows = []
      const finish = (error, result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) {
          if (this._timeoutMs && Date.now() - started >= this._timeoutMs) {
            this._dead = true
            error.dbsConnDead = true
          }
          reject(error)
        } else {
          resolve(result)
        }
      }
      const timer = setTimeout(() => {
        this._dead = true
        try { rawConn.destroy() } catch { /* 忽略 */ }
        const err = new Error(`查询超时（${Math.round(this._timeoutMs / 1000)} 秒）`)
        err.dbsConnDead = true
        err.code = 'DBS_QUERY_TIMEOUT'
        finish(err)
      }, this._timeoutMs)

      let queryObj
      try {
        queryObj = params === undefined || params === null
          ? rawConn.query(sql)
          : rawConn.query({ sql, values: params })
      } catch (error) {
        finish(error)
        return
      }
      queryObj.on('fields', (f) => { fields = f })
      let stream
      try {
        stream = queryObj.stream({ highWaterMark: 64 })
      } catch (error) {
        // 流式不可用（驱动变化）：退化为缓冲查询（放弃内存防线，保可用）
        this.query(sql, params).then(
          ([rows2, fields2]) => finish(null, { rows: (rows2 || []).slice(0, limit + 1), fields: fields2 }),
          (error2) => finish(error2))
        return
      }
      stream.on('data', (row) => {
        rows.push(row)
        if (rows.length > limit) {
          // 已到 limit+1：停止读取，剩余数据留在连接上（调用方必须 discard）
          try { stream.destroy() } catch { /* 忽略 */ }
          try { queryObj.removeListener('result', () => {}) } catch { /* 忽略 */ }
          finish(null, { rows, fields })
        }
      })
      stream.on('fields', (f) => { if (f && !fields) fields = f })
      stream.on('error', (error) => finish(error))
      stream.on('end', () => {
        // 正常读完（未触发上限）：fields 可能还没到（空结果集），补一次等待
        if (!fields) {
          queryObj.on('fields', (f) => { if (!settled) { fields = f; finish(null, { rows, fields: f }) } })
          setTimeout(() => finish(null, { rows, fields }), 50)
        } else {
          finish(null, { rows, fields })
        }
      })
    })
  }

  /** 逐行流式回调（导出工单用）：onRow(row) 逐行调用，内部按批聚合由调用方负责。
   * onFields(fields)：fields 事件即触发（首行前）——导出 writer 需要在写首行前拿到列名。
   * 返回 { fields }；超时/错误语义与 fetchMany 一致（超时 destroy 并标记 dbsConnDead）。 */
  async fetchEach(sql, params, onRow, onFields = null) {
    const rawConn = this._conn.connection ?? this._conn
    return await new Promise((resolve, reject) => {
      let settled = false
      let fields = null
      const finish = (error, result) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (error) reject(error)
        else resolve(result)
      }
      const timer = setTimeout(() => {
        this._dead = true
        try { rawConn.destroy() } catch { /* 忽略 */ }
        const err = new Error(`查询超时（${Math.round(this._timeoutMs / 1000)} 秒）`)
        err.dbsConnDead = true
        err.code = 'DBS_QUERY_TIMEOUT'
        finish(err)
      }, this._timeoutMs)

      let queryObj
      try {
        queryObj = params === undefined || params === null
          ? rawConn.query(sql)
          : rawConn.query({ sql, values: params })
      } catch (error) {
        finish(error)
        return
      }
      let stream
      try {
        stream = queryObj.stream({ highWaterMark: 256 })
      } catch (error) {
        finish(error)
        return
      }
      stream.on('fields', (f) => {
        fields = f
        if (onFields) {
          try { onFields(f) } catch (error) {
            try { stream.destroy() } catch { /* 忽略 */ }
            finish(error)
          }
        }
      })
      stream.on('data', (row) => {
        try {
          onRow(row)
        } catch (error) {
          try { stream.destroy() } catch { /* 忽略 */ }
          finish(error)
        }
      })
      stream.on('error', (error) => finish(error))
      stream.on('end', () => finish(null, { fields }))
    })
  }

  async selectDb(db) {
    await this._timeoutRace(this._conn.changeUser({ database: db }), '切库')
  }

  async beginTransaction() {
    await this._conn.beginTransaction()
  }

  async commit() {
    await this._conn.query('COMMIT')
  }

  async rollback() {
    await this._conn.query('ROLLBACK')
  }

  async end() {
    try { await this._conn.end() } catch { /* 忽略 */ }
  }

  destroy() {
    this._dead = true
    try { this._conn.destroy() } catch { /* 忽略 */ }
  }

  get dead() {
    return this._dead
  }
}

/** 借连接。指纹不匹配时旧池作废。借出必设库：池连接可能带着
 * 上次使用时的库状态（或根本没选库），每次借出都显式 selectDb。 */
async function _borrow(cid, info, db) {
  const fp = fingerprint(info)
  let entry = _pools.get(cid)
  if (!entry || entry.fingerprint !== fp) {
    if (entry) _drain(entry.idle)
    entry = { fingerprint: fp, idle: [], info: { ...info } }
    _pools.set(cid, entry)
  }
  if (entry.idle.length) {
    const conn = entry.idle.pop()
    if (db) await conn.selectDb(db)
    return conn
  }
  const conn = await _connect(info, db)
  if (db) await conn.selectDb(db)
  return conn
}

/** 连接已被判定为坏，绕过池直接新建（重试路径）。 */
async function _retake(cid, info, db) {
  const conn = await _connect(info, db)
  if (db) await conn.selectDb(db)
  return conn
}

/** 还连接；broken 时销毁。池满（>= POOL_MAX）也销毁。 */
function _giveBack(cid, conn, broken = false) {
  if (!conn) return
  if (broken || conn.dead) {
    conn.destroy()
    return
  }
  const entry = _pools.get(cid)
  if (!entry) {
    conn.destroy()
    return
  }
  if (entry.idle.length >= config.POOL_MAX) {
    conn.destroy()
    return
  }
  entry.idle.push(conn)
}

/** 连接配置删除/变更时整体作废。 */
function _dropPool(cid) {
  const entry = _pools.get(cid)
  if (entry) {
    _pools.delete(cid)
    _drain(entry.idle)
  }
}

/** 是否连接失效类错误（丢弃重试一次的判据）。 */
function _isConnDead(error) {
  if (!error) return false
  if (error.dbsConnDead || error.fatal) return true
  const code = String(error.code || '')
  return /^ECONN|^ETIMEDOUT$|^EPIPE$|^PROTOCOL_CONNECTION_LOST$/.test(code)
}

/** 借连接执行 fn(conn)。连接失效类错误丢弃重试一次；借出必设库。 */
async function _runWithRetry(cid, info, db, fn) {
  let lastError = null
  for (const attempt of [0, 1]) {
    const conn = await _borrow(cid, info, db)
    try {
      const result = await fn(conn)
      _giveBack(cid, conn)
      return result
    } catch (error) {
      _giveBack(cid, conn, true)
      lastError = error
      if (attempt || !_isConnDead(error)) throw error
      continue
    }
  }
  throw lastError // pragma: no cover
}

/** 关闭全部池（engine.dispose / 插件卸载用）：销毁所有空闲连接，进程可自然退出。
 * 借出中的连接由调用方归还时按「entry 已删」走销毁路径（_giveBack 对缺失 entry destroy）。 */
function _closeAll() {
  for (const [cid, entry] of [..._pools.entries()]) {
    _pools.delete(cid)
    _drain(entry.idle)
  }
}

/**
 * pool 注入接缝：api 层一律 `import { pool } from '../core/pool.js'` 并调
 * `pool.borrow(...)` 等方法；测试直接覆写对象方法（等价 Python 的 monkeypatch）。
 */
export const pool = {
  borrow: _borrow,
  retake: _retake,
  giveBack: _giveBack,
  dropPool: _dropPool,
  runWithRetry: _runWithRetry,
  closeAll: _closeAll,
}
