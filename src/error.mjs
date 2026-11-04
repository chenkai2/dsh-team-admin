/** 本插件统一的业务错误：带机器可读 code 与 HTTP 状态。 */

/** 业务错误。code 供日志/前端分支使用，message 中文直出。 */
export class AdminError extends Error {
  /**
   * @param {string} message - 面向用户的中文文案。
   * @param {string} [code] - 机器可读错误码。
   * @param {number} [status] - HTTP 状态码。
   */
  constructor(message, code = 'system', status = 400) {
    super(message)
    this.name = 'AdminError'
    this.code = code
    this.status = status
  }
}
