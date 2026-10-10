/**
 * 错误码与中文文案的**单一事实来源**。
 *
 * 设计取舍（SDD §7.1）：
 * 1. Client 半边**不自行拼装**错误文案 —— 它只认识 `code`，文案由 Host 给出。
 *    这样同一失败在界面上永远只有一种说法，也便于以后做多语言。
 * 2. DSH 抓取层（`ctx.web.fetch()`）抛出的 `WebError.code` 是**开放字符串**，
 *    我们只对已知的 8 个码做翻译，其余一律降级为 `WEB_PROVIDER_ERROR` 并保留原文。
 * 3. 任何失败都**不**产生「没有更新」这类结论（SDD §7.2）—— 文案里刻意避免
 *    「无变化」「未更新」措辞，只说「本次检查失败」。
 *
 * @module dsh-apradar/src/host/errors
 */

/** DSH 抓取层已知的错误码。其余一律归一为 `WEB_PROVIDER_ERROR`。 */
export const WEB_ERROR_CODES = [
  'WEB_INVALID_URL',
  'WEB_BLOCKED_URL',
  'WEB_FETCH_TOO_LARGE',
  'WEB_FETCH_TIMEOUT',
  'WEB_REDIRECT_BLOCKED',
  'WEB_UNSUPPORTED_CONTENT_TYPE',
  'WEB_ABORTED',
  'WEB_PROVIDER_ERROR',
]

/** 本插件自有的错误码。 */
export const OWN_ERROR_CODES = [
  'SOURCE_NOT_FOUND',
  'SOURCE_DISABLED',
  'SOURCE_AUTO_DISABLED',
  'SOURCE_LIMIT_REACHED',
  'REFRESH_IN_FLIGHT',
  'ADAPTER_CONFIG_INVALID',
  'ADAPTER_PARSE_FAILED',
  'ADAPTER_STRUCTURE_UNSUPPORTED',
  'STORAGE_OPEN_FAILED',
  'STORAGE_VERSION_MISMATCH',
  'STORAGE_RECORD_INVALID',
  'STORAGE_WRITE_FAILED',
  'FIELD_NOT_WRITABLE',
  'PAYLOAD_TOO_LARGE',
  'INTERNAL',
]

/** 传输层（路由）专用的错误码，不属于业务语义。 */
export const TRANSPORT_ERROR_CODES = [
  'BAD_REQUEST',
  'METHOD_NOT_ALLOWED',
  'NOT_FOUND',
  'LOOPBACK_ONLY',
  'VALIDATION_FAILED',
  'CONFLICT',
  'NOT_IMPLEMENTED',
]

/** `code → 中文文案`。文案面向用户，尽量说清「发生了什么」与「可以怎么办」。 */
export const ERROR_MESSAGES = {
  // —— DSH 抓取层 ——
  WEB_INVALID_URL: '地址格式不合法，无法发起请求',
  WEB_BLOCKED_URL: '目标地址被宿主的安全策略拒绝（只允许公开可访问的 http/https 地址）',
  WEB_FETCH_TOO_LARGE: '响应体积超过宿主上限，已中止',
  WEB_FETCH_TIMEOUT: '请求超时，未能在限定时间内完成',
  WEB_REDIRECT_BLOCKED: '重定向被拒绝（次数超限或跳转到了不被允许的地址）',
  WEB_UNSUPPORTED_CONTENT_TYPE: '返回的内容类型不受支持',
  WEB_ABORTED: '请求已被取消',
  WEB_PROVIDER_ERROR: '出网请求失败',

  // —— 来源与配置 ——
  SOURCE_NOT_FOUND: '找不到这个关注源',
  SOURCE_DISABLED: '这个关注源已被停用，不会刷新',
  SOURCE_AUTO_DISABLED: '连续多次刷新失败，这个关注源已被自动停用；修好地址后重新启用即可',
  SOURCE_LIMIT_REACHED: '关注源数量已达上限，请先删除不再需要的来源',
  ADAPTER_CONFIG_INVALID: '来源配置不合法',
  ADAPTER_PARSE_FAILED: '内容无法解析为受支持的格式（本次检查失败，不代表来源没有更新）',
  ADAPTER_STRUCTURE_UNSUPPORTED: '页面结构无法稳定解析，本版本不支持把该来源标记为可用',

  // —— 存储 ——
  STORAGE_OPEN_FAILED: '本地存储打开失败，本次不做任何保存',
  STORAGE_VERSION_MISMATCH: '本地数据的版本高于当前插件，已进入只读保护，不做自动降级',
  STORAGE_RECORD_INVALID: '本地存在无法校验的记录，已按策略跳过',
  STORAGE_WRITE_FAILED: '写入本地存储失败，内存与磁盘状态未保持一致',

  // —— 写入与请求 ——
  FIELD_NOT_WRITABLE: '该字段不允许由客户端写入',
  REFRESH_IN_FLIGHT: '这个关注源正在刷新中，已跳过重复的刷新请求',
  PAYLOAD_TOO_LARGE: '请求内容过大',
  INTERNAL: '插件内部错误',

  // —— 传输层 ——
  BAD_REQUEST: '请求不合法',
  METHOD_NOT_ALLOWED: '该路径不支持这个请求方法',
  NOT_FOUND: '找不到该接口',
  LOOPBACK_ONLY: '本插件的接口只服务本机界面',
  VALIDATION_FAILED: '参数校验未通过',
  CONFLICT: '与现有数据冲突',
  NOT_IMPLEMENTED: '该接口尚未实现',
}

/**
 * 插件内部统一抛出的错误类型。
 *
 * 之所以自定义而不是直接用 `Error`：调用方需要**按 code 分支**（例如决定是否
 * 更新来源的失败状态），而 `message` 面向用户、可能被改写。
 */
export class RadarError extends Error {
  /**
   * @param {string} code 机器可读错误码
   * @param {string} [message] 覆盖默认中文文案
   * @param {unknown} [detail] 附加信息（**不得**包含本机绝对路径或凭据）
   */
  constructor(code, message, detail) {
    super(message ?? ERROR_MESSAGES[code] ?? `未知错误（${code}）`)
    this.name = 'RadarError'
    this.code = code
    if (detail !== undefined) this.detail = detail
  }
}

/**
 * 构造一个 `RadarError`。
 * @param {string} code 错误码
 * @param {unknown} [detail] 附加信息
 * @returns {RadarError}
 */
export function radarError(code, detail) {
  return new RadarError(code, undefined, detail)
}

/**
 * 构造一个"这条记录不存在"的错误。
 *
 * 为什么要单独一个：`radarError('NOT_FOUND')` 落到的是通用文案「找不到该接口」，
 * 而在详情页里**接口明明找到了** —— 找不到的是那条记录。这两句话对使用者的含义
 * 完全不同：「找不到该接口」听起来像插件装坏了，而真实情况通常是这条记录被容量
 * 上限清理掉了（`maxSnapshotsPerSource` / `maxChanges` 等），界面据此提示
 * "它可能已经被清理掉"才是对的。
 *
 * 真正的"路径对不上"由 `http.js` 的 `matchRoute` 负责，它有自己的文案
 * （`没有这个接口：<METHOD> <path>`），与这里互不干扰。
 *
 * @param {string} what 记录的中文名（「变化」「快照」「机会」）
 * @param {unknown} [detail] 附加信息（**不得**包含本机绝对路径或凭据）
 * @returns {RadarError}
 */
export function notFoundError(what, detail) {
  return new RadarError('NOT_FOUND', `找不到这条${what}`, detail)
}

/**
 * 取某个错误码的中文文案。
 * @param {string} code 错误码
 * @returns {string}
 */
export function messageFor(code) {
  return ERROR_MESSAGES[code] ?? ERROR_MESSAGES.INTERNAL
}

/**
 * 沿 `cause` 链收集诊断信息。
 *
 * 为什么必须做：宿主的抓取层把 undici 的失败包成 `WebError("web fetch failed:
 * TypeError: fetch failed", "WEB_PROVIDER_ERROR", { cause })` —— 外层那句话里
 * **没有**任何可行动的信息。真正的原因（`ENOTFOUND` 主机名、`ECONNREFUSED`
 * 端口、`CERT_HAS_EXPIRED`、DNS 解析到内网地址被拦……）全在 `cause` 链上。
 * 不往下走一层，用户看到的就是"出网请求失败"，而我们自己也查不出该改什么。
 *
 * 只取 `code` / `message` / `address` / `port` 这几个字段：它们是定位问题所需
 * 的全部，且不含本机绝对路径。返回值会在 `http.js` 里再过一遍 `redactPaths`。
 *
 * @param {unknown} err 任意抛出物（通常是带 `cause` 的 Error）
 * @returns {string} 形如 `TypeError: fetch failed / ENOTFOUND (api.example.com)`；无信息时为空串
 */
export function describeCause(err) {
  const parts = []
  let node = err
  for (let depth = 0; depth < 4 && node && typeof node === 'object'; depth += 1) {
    const message = typeof node.message === 'string' ? node.message.trim() : ''
    const code = typeof node.code === 'string' ? node.code.trim() : ''
    const where = [node.address, node.hostname, node.port].filter((value) => value !== undefined && value !== null && value !== '').join(':')
    const piece = [message, code ? `(${code}${where ? ` ${where}` : ''})` : where ? `(${where})` : '']
      .filter(Boolean)
      .join(' ')
    if (piece && !parts.includes(piece)) parts.push(piece)
    node = node.cause
  }
  return parts.join(' / ')
}

/**
 * 把任意抛出物归一为 `{ code, message, detail? }`。
 *
 * DSH 的 `WebError` 是开放字符串码：已知的 8 个原样透传，未知的一律折成
 * `WEB_PROVIDER_ERROR`。
 *
 * **宿主自己的文案与 `cause` 链必须原样带上**（放在 `detail.providerMessage`）。
 * 曾经这里只回我们自己的中文文案，于是"出网请求失败"这句话背后真正的失败原因
 * —— 比如"未配置代理"或某个字段缺失 —— 在界面和日志里都彻底消失了，谁也没法
 * 判断该去改什么。这不是"避免泄漏内部细节"，而是把唯一的诊断线索删掉。
 * 我们仍然只归一 `code`，不改写 `message`。
 *
 * @param {unknown} err 捕获到的任何东西
 * @returns {{ code: string, message: string, detail?: unknown }}
 */
export function toWireError(err) {
  if (err instanceof RadarError) {
    const out = { code: err.code, message: err.message }
    if (err.detail !== undefined) out.detail = err.detail
    return out
  }

  if (err && typeof err === 'object') {
    const rawCode = typeof err.code === 'string' ? err.code : ''
    const own = typeof err.message === 'string' && err.message.trim() ? err.message.trim() : ''
    const cause = describeCause(err.cause)
    const providerMessage = [own, cause].filter(Boolean).join(' ← ')
    /**
     * 把宿主文案挂上去，**但保留抛错方自己写的 `detail`**。
     *
     * 曾经这里是直接 `wire.detail = { providerMessage }` —— 那会把适配器/服务层
     * 精心附上的诊断信息（比如"试过哪几个端点、各自怎么失败的"）悄悄吃掉，
     * 于是排查时看到的是一个没有线索的错误。附加信息只应累加，不应覆盖。
     */
    const attachProvider = (wire) => {
      const base = err.detail && typeof err.detail === 'object' && !Array.isArray(err.detail) ? err.detail : {}
      /** @type {Record<string, unknown>} */
      const detail = { ...base }
      /** 宿主文案与我们自己的同一句时就不再重复一遍。 */
      if (providerMessage && providerMessage !== wire.message) detail.providerMessage = providerMessage
      if (Object.keys(detail).length > 0) wire.detail = detail
      return wire
    }

    if (WEB_ERROR_CODES.includes(rawCode)) return attachProvider({ code: rawCode, message: messageFor(rawCode) })
    if (OWN_ERROR_CODES.includes(rawCode) || TRANSPORT_ERROR_CODES.includes(rawCode)) {
      const generic = messageFor(rawCode)
      /**
       * 抛错方自己写的中文文案通常比通用文案**具体得多**（"请填写 owner"、
       * "CDATA 段未闭合"、"响应体超过宿主上限…已被截断"），所以让它占据 message
       * 主位。通用文案不是废纸 —— 它常带有重要的限定（"本次检查失败，不代表
       * 来源没有更新"），因此降级成 `detail.note` 保留，而不是丢掉。
       */
      const wire = { code: rawCode, message: own || generic }
      if (own && generic && own !== generic) return attachProvider({ ...wire, detail: { note: generic } })
      return attachProvider(wire)
    }
    // 认不出的 code：保留可读 message，但把码归一，避免泄漏宿主内部枚举。
    return {
      code: rawCode ? 'WEB_PROVIDER_ERROR' : 'INTERNAL',
      message: own || messageFor('INTERNAL'),
      ...(providerMessage && providerMessage !== own ? { detail: { providerMessage } } : {}),
    }
  }

  if (typeof err === 'string' && err.trim()) return { code: 'INTERNAL', message: err.trim() }
  return { code: 'INTERNAL', message: messageFor('INTERNAL') }
}
