/**
 * 统一的业务错误类型（HTTP/路由层负责映射成 {error, code} JSON）。
 * server/core/errors.py 的移植。
 *
 * api/ 里的处理器只抛 ApiError，不直接拼 HTTP 响应；
 * router 捕获后转成契约要求的错误体。PermissionError 等由调用方翻译。
 */

/** 带状态码与可选机器码的业务错误（等价 Python ApiError）。 */
export class ApiError extends Error {
  constructor(status, message, code = '') {
    super(message)
    this.name = 'ApiError'
    this.status = Number(status)
    this.message = String(message)
    this.code = code || ''
  }

  body() {
    const out = { error: this.message }
    if (this.code) out.code = this.code
    return out
  }
}

/** Python PermissionError 的等价物（guard 拦截语义）。 */
export class PermissionError extends Error {
  constructor(message) {
    super(message)
    this.name = 'PermissionError'
  }
}

/** Python ValueError 的等价物（参数形状错误）。 */
export class ValueError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValueError'
  }
}
