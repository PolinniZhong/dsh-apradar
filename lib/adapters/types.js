/**
 * 关注源适配器的契约（SDD §3.1）。
 *
 * 核心设计约束：**适配器是纯函数式的，不接收 `ctx`**。
 * 这不是风格偏好，而是安全属性 —— 适配器在物理上拿不到 `ctx.web`，
 * 所以它**不可能**自己发起请求。抓取只能由服务层通过网关完成，然后把
 * 结果（`WebFetchResult`）作为参数交给 `parse()`。
 *
 * 另一个约束：`parse()` 在无法解析时**必须抛错**，绝不能返回空数组。
 * 返回空数组会让上层得出「这个来源没有更新」的结论，而那是一句我们无权
 * 做出的断言（SDD §7.2）。
 *
 * @module dsh-apradar/src/host/adapters/types
 */

/**
 * 来源配置不合法。用户能在界面上改配置，所以文案要能直接展示。
 */
export class SourceConfigError extends Error {
  /**
   * @param {string} message 面向用户的中文说明
   * @param {unknown} [detail] 机器可读的补充信息（字段名等）
   */
  constructor(message, detail) {
    super(message)
    this.name = 'SourceConfigError'
    this.code = 'ADAPTER_CONFIG_INVALID'
    if (detail !== undefined) this.detail = detail
  }
}

/**
 * 内容无法解析成受支持的格式（畸形 XML、不是 Feed、缺少必需元素……）。
 */
export class AdapterParseError extends Error {
  /**
   * @param {string} message 面向用户的中文说明
   * @param {unknown} [detail] 机器可读的补充信息
   */
  constructor(message, detail) {
    super(message)
    this.name = 'AdapterParseError'
    this.code = 'ADAPTER_PARSE_FAILED'
    if (detail !== undefined) this.detail = detail
  }
}

/**
 * 页面结构无法稳定解析。
 *
 * 与 `AdapterParseError` 分开，是因为它对应**另一种处置**：前者可能只是这一次
 * 抓到的内容坏了（来源仍然可用），后者说明这个来源在我们的能力范围之外，
 * 必须拒绝把它标记为可用，而不是反复重试。
 */
export class StructureUnsupportedError extends Error {
  /**
   * @param {string} message 面向用户的中文说明
   * @param {unknown} [detail] 机器可读的补充信息
   */
  constructor(message, detail) {
    super(message)
    this.name = 'StructureUnsupportedError'
    this.code = 'ADAPTER_STRUCTURE_UNSUPPORTED'
    if (detail !== undefined) this.detail = detail
  }
}

/**
 * 声明一个适配器，并做最低限度的形状校验。
 *
 * 之所以要校验：`registry.js` 在加载期就会把全部适配器过一遍，
 * 契约缺项应当在**模块加载时**炸掉，而不是等到用户点了刷新才发现。
 *
 * @param {object} spec 适配器实现
 * @param {string} spec.type 类型标识（同时是记录里的 `source.type`）
 * @param {string} spec.label 界面上的中文名
 * @param {string} spec.summary 一句话说明（给「添加来源」的选择列表用）
 * @param {boolean} [spec.testable] 是否支持「测试可访问性」
 * @param {object[]} spec.fields 配置字段描述，驱动界面表单
 * @param {(input: object) => object} spec.normalizeConfig 校验并归一配置
 * @param {(source: object, config: object) => {url: string, acceptHint?: string}} spec.buildRequest 由配置推导请求
 * @param {(source: object, config: object) => {url: string, acceptHint?: string}[]} [spec.buildRequests] 多端点候选（按优先级），服务层依次尝试
 * @param {(config: object) => string} [spec.defaultName] 由配置推导来源的默认名字（用户没起名时用）
 * @param {(result: object, config: object) => {title: string, items: object[]}} spec.parse 解析抓取结果
 * @param {(result: object, config: object) => (string|null)} [spec.structureFingerprint] 结构指纹
 * @returns {object} 原样返回，便于链式注册
 */
export function defineAdapter(spec) {
  if (!spec || typeof spec !== 'object') throw new TypeError('适配器必须是一个对象')
  const required = ['type', 'label', 'normalizeConfig', 'buildRequest', 'parse']
  for (const key of required) {
    if (!spec[key]) throw new TypeError(`适配器缺少必需成员：${key}`)
  }
  if (spec.buildRequests !== undefined && typeof spec.buildRequests !== 'function') {
    throw new TypeError(`适配器 ${spec.type} 的 buildRequests 必须是函数（或干脆不写）`)
  }
  if (!/^[a-z][a-z0-9_]*$/.test(spec.type)) {
    throw new TypeError(`适配器 type 必须匹配 ^[a-z][a-z0-9_]*$，收到 ${spec.type}`)
  }
  if (spec.parse.length < 2) {
    // 形参个数不足以区分「抓取结果」与「配置」时多半是写错了签名。
    throw new TypeError(`适配器 ${spec.type} 的 parse() 必须接收 (result, config)`)
  }
  return spec
}

/**
 * 把任意值转成去首尾空白的字符串。
 * @param {unknown} value 任意值
 * @returns {string}
 */
export function asText(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 从一个可能为空的输入对象里读配置。
 * @param {unknown} input 用户输入
 * @returns {Record<string, unknown>}
 */
export function asConfigObject(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new SourceConfigError('来源配置必须是一个对象')
  }
  return /** @type {Record<string, unknown>} */ (input)
}

/**
 * 宿主对响应体的字符上限（`dsh-web-fetch-http` 的 `maxBodyChars` 默认值）。
 *
 * 写在这里是为了在报错时能说出**具体数字** —— 用户看到"超过上限"却不知道
 * 上限是多少，就无法判断"这个源是不是永远用不了"。
 */
export const HOST_MAX_BODY_CHARS = 100000

/**
 * 响应体被宿主截断时**立刻**报错，不要拿去解析。
 *
 * 这是实测踩出来的坑：`https://github.blog/feed/`（1.2 MB）与
 * `https://openai.com/blog/rss.xml`（768 KB）都远超 10 万字符上限，被截断后
 * 送进 XML 解析器，得到的是"CDATA 段未闭合（缺少 `]]>`）"和"标签未闭合：<item>"
 * —— 这两句话把**一个可解释的容量限制**伪装成了**来源自身的格式错误**，
 * 排查方向会彻底跑偏。
 *
 * 截断的部分能不能凑合解析？不能。哪怕前缀能解析出半页条目，缺失的尾部也会让
 * 差异比较得出"这些条目被删除了"的结论 —— 那是我们无权做出的断言（SDD §7.2）。
 *
 * @param {{truncated?: boolean}|null|undefined} result 抓取结果
 * @param {string} [hint] 针对该类型的补充建议
 * @returns {void}
 */
export function assertBodyNotTruncated(result, hint) {
  if (result?.truncated !== true) return
  throw new AdapterParseError(
    `响应体超过宿主上限（${HOST_MAX_BODY_CHARS} 字符）已被截断，无法可靠解析${hint ? `。${hint}` : ''}`,
    { truncated: true, maxBodyChars: HOST_MAX_BODY_CHARS },
  )
}

/**
 * 由一个来源推导出**按优先级排列**的候选请求。
 *
 * 为什么要多端点：同一个来源在不同网络里能走通的地址并不相同。实测本机
 * `github.com:443` 连接超时、`api.github.com` 正常（见 `github-releases.js`
 * 文件头），所以适配器可以声明多个候选，由服务层依次尝试第一个成功的。
 *
 * 单端点适配器不需要写 `buildRequests` —— 这里会把 `buildRequest` 包成
 * 只有一个元素的数组，两条路径对服务层是同一个形状。
 *
 * @param {object} adapter 适配器
 * @param {object} source 来源记录（可为临时对象）
 * @param {object} config 归一配置
 * @returns {{url: string, acceptHint?: string}[]} 至少一项
 */
export function resolveRequests(adapter, source, config) {
  const many = typeof adapter?.buildRequests === 'function' ? adapter.buildRequests(source, config) : null
  const list = Array.isArray(many) ? many : [adapter.buildRequest(source, config)]
  const requests = list.filter((item) => item && typeof item.url === 'string' && item.url.trim() !== '')
  if (requests.length === 0) {
    throw new SourceConfigError('无法从配置推导出可用的请求地址')
  }
  return requests
}
