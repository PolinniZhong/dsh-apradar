/**
 * Host 侧的 HTTP 表面：同源前缀路由、回环限制、统一的 JSON 信封。
 *
 * 形态照抄本机已验证的在用实现（`08_Knit/knit/src/host/index.js` 的
 * `webServer.register({kind:'prefix', ...})` + `sendJson`），因为它在 Desktop 与
 * Web 两个 Profile 下都已被实测服务（见 `TECH-SPIKE.md` §6）。**没有**任何
 * 未公开的全局对象或 DOM 依赖。
 *
 * ## 信封是刻意的
 *
 * 成功 `{ok:true, data}`，失败 `{ok:false, error:{code, message, detail?}}`。
 * Client 依据 `code` 决定怎么显示，**不去猜中文文案**；`message` 是给人看的。
 * 任何 handler 抛出的异常都在这里被翻译成信封 —— 绝不让一个异常逃成
 * "响应体是空的 500"，那会让界面只能显示"未知错误"。
 *
 * ## 这个文件不做业务
 *
 * 它只做：路由匹配、方法校验、请求体读取与体积限制、把参数交给服务层、
 * 把服务层的结果或异常翻译成信封。所有业务判断都在 `src/host/service.js`。
 *
 * @module dsh-apradar/src/host/http
 */

import { MAX_RESPONSE_BYTES } from './limits.js'
import { RadarError, messageFor, radarError, toWireError } from './errors.js'

/** 与 Client 半边约定的路由前缀。**与 Spike 的 `/apradar-spike` 不同**，两者可共存。 */
export const ROUTE_PREFIX = '/apradar'

/** 请求体上限。POST/PATCH 的载荷都很小，超过这个体积一定是出了别的问题。 */
export const MAX_REQUEST_BYTES = 65536

/** 机器可读的响应码。Client 依据它区分失败形态，而不是去猜文案。 */
export const ROUTE_CODES = {
  pong: 'apradar/pong',
  meta: 'apradar/meta',
  state: 'apradar/state',
  boom: 'apradar/boom',
  notFound: 'apradar/not-found-route',
  methodNotAllowed: 'apradar/method-not-allowed',
  loopbackOnly: 'apradar/loopback-only',
  badJson: 'apradar/bad-json',
  requestTooLarge: 'apradar/request-too-large',
  responseTooLarge: 'apradar/response-too-large',
}

/**
 * 错误码 → HTTP 状态码。
 *
 * 用 `code` 而不是文案来决定状态：文案会改，状态码是给机器看的契约。
 * 表里没有的 code 一律按 500 处理 —— 未分类的错误不该被伪装成客户端错误。
 */
const STATUS_BY_CODE = {
  BAD_REQUEST: 400,
  VALIDATION_FAILED: 400,
  FIELD_NOT_WRITABLE: 400,
  PAYLOAD_TOO_LARGE: 413,
  METHOD_NOT_ALLOWED: 405,
  NOT_FOUND: 404,
  SOURCE_NOT_FOUND: 404,
  CONFLICT: 409,
  SOURCE_LIMIT_REACHED: 409,
  SOURCE_DISABLED: 409,
  ADAPTER_CONFIG_INVALID: 400,
  ADAPTER_PARSE_FAILED: 422,
  ADAPTER_STRUCTURE_UNSUPPORTED: 422,
  WEB_INVALID_URL: 400,
  WEB_BLOCKED_URL: 400,
  STORAGE_OPEN_FAILED: 503,
  STORAGE_VERSION_MISMATCH: 503,
  STORAGE_WRITE_FAILED: 503,
  WEB_FETCH_TIMEOUT: 504,
  WEB_FETCH_TOO_LARGE: 502,
  WEB_REDIRECT_BLOCKED: 502,
  WEB_UNSUPPORTED_CONTENT_TYPE: 502,
  WEB_ABORTED: 499,
  WEB_PROVIDER_ERROR: 502,
}

/**
 * 判断请求是否来自本机回环地址。
 *
 * 与 Knit 同样的取舍：插件路由只服务本机界面，**不**对外网暴露。
 * 这在 Desktop 与 Web 下都成立，因为两者都由同一个宿主进程服务
 * （`TECH-SPIKE.md` §6.0）。
 *
 * @param {string | undefined} address `req.socket.remoteAddress`
 * @returns {boolean}
 */
export function isLoopback(address) {
  if (typeof address !== 'string') return false
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || address.startsWith('127.')
}

/**
 * 写一个 JSON 响应。
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {unknown} body 会被 `JSON.stringify` 的正文
 * @returns {void}
 */
export function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

/**
 * 「这个 handler 要自己写响应」的标记。
 *
 * 默认所有 handler 的返回值都会被包成 JSON 信封 —— 那是 Client 与宿主之间的契约，
 * 不能随便破。但 Markdown 导出必须回 `text/markdown`（否则浏览器里点开是一坨 JSON），
 * 所以给它留一个**显式**的出口：handler 返回 `{ [RAW_RESULT]: {...} }`。
 * 默认路径完全不变，只有写着这个标记的返回值才绕过信封。
 */
export const RAW_RESULT = Symbol('apradar.rawResult')

/**
 * 构造一个原始响应结果（绕过 JSON 信封）。
 *
 * @param {object} spec 响应
 * @param {string} spec.text 正文
 * @param {string} spec.contentType MIME 类型
 * @param {string} [spec.filename] 下载文件名（会写进 `content-disposition`）
 * @param {number} [spec.maxBytes] 体积上限，默认 `MAX_RESPONSE_BYTES`
 * @param {string} [spec.tooLargeMessage] 超限时的错误文案
 * @returns {object} 带 `RAW_RESULT` 标记的对象
 */
export function rawResult({ text, contentType, filename, maxBytes = MAX_RESPONSE_BYTES, tooLargeMessage }) {
  return { [RAW_RESULT]: { text: String(text ?? ''), contentType, filename, maxBytes, tooLargeMessage } }
}

/**
 * 写一个原始（非 JSON）响应。
 *
 * @param {import('node:http').ServerResponse} res 响应对象
 * @param {number} status HTTP 状态码
 * @param {string} body 正文
 * @param {string} contentType MIME 类型
 * @param {string} [filename] 下载文件名
 * @returns {void}
 */
export function sendRaw(res, status, body, contentType, filename) {
  const headers = {
    'content-type': contentType,
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  }
  if (filename) headers['content-disposition'] = `attachment; filename="${filename.replace(/[^A-Za-z0-9._-]/g, '_')}"`
  res.writeHead(status, headers)
  res.end(body)
}

/** 成功信封。 */
export function okEnvelope(data) {
  return { ok: true, data }
}

/**
 * 失败信封。`detail` 只放**可公开**的结构化信息（字段名、上限值），
 * 不放响应体、不放本机路径。
 * @param {string} code 机器可读的错误码
 * @param {string} [message] 给人看的中文说明；缺省时用错误码表里的文案
 * @param {object} [detail] 结构化细节
 * @returns {object}
 */
export function failEnvelope(code, message, detail) {
  return {
    ok: false,
    error: {
      code,
      message: redactPaths(message || messageFor(code)),
      ...(detail && Object.keys(detail).length ? { detail: sanitizeDetail(detail) } : {}),
    },
  }
}

/**
 * 把异常翻译成线上信封与 HTTP 状态码。
 * @param {unknown} error 任意异常
 * @returns {{status: number, body: object}}
 */
export function toWireFailure(error) {
  const wire = toWireError(error)
  const code = wire.code
  const status = STATUS_BY_CODE[code] ?? 500
  return { status, body: failEnvelope(code, wire.message, wire.detail) }
}

/**
 * 把 `RadarError` 之外的杂音也纳入统一映射，并在服务层缺失时给出明确结论。
 * @returns {never}
 */
function unavailableService() {
  throw radarError('STORAGE_OPEN_FAILED', { reason: '服务尚未初始化完成' })
}

/**
 * 路由表。**这是接口清单的唯一事实来源** —— 文档、Client 与测试都从它读，
 * 这样"文档里写了但没实现"或"实现了但没文档"都不可能悄悄发生。
 *
 * `path` 里的 `:name` 是路径参数。静态段优先于参数段（见 `matchRoute`）。
 *
 * @type {{method: string, path: string, summary: string, handler: (ctx: object) => Promise<object>|object}[]}
 */
export const ROUTES = [
  {
    method: 'GET',
    path: '/ping',
    summary: '存活探测：确认这条响应确实来自本插件',
    handler: ({ runtime, now }) => ({
      testMarker: `apradar-${runtime.pluginVersion}`,
      code: ROUTE_CODES.pong,
      ts: now(),
      plugin: runtime.plugin,
      pluginVersion: runtime.pluginVersion,
      node: runtime.node,
      pid: runtime.pid,
      routePrefix: ROUTE_PREFIX,
    }),
  },
  {
    method: 'GET',
    path: '/meta',
    summary: '上限、适配器清单、状态枚举 —— 界面据此渲染，而不是硬编码',
    handler: ({ service }) => service.meta(),
  },
  {
    method: 'GET',
    path: '/state',
    summary: '存储与计数的当前状态',
    handler: ({ service }) => service.state(),
  },
  {
    method: 'GET',
    path: '/sources',
    summary: '关注源列表',
    handler: ({ service }) => ({ items: service.listSources() }),
  },
  {
    method: 'POST',
    path: '/sources',
    summary: '新建关注源',
    handler: ({ service, body }) => service.createSource(body),
  },
  {
    method: 'PATCH',
    path: '/sources/:id',
    summary: '改来源的名称 / 配置 / 启停',
    handler: ({ service, params, body }) => service.updateSource(params.id, body),
  },
  {
    method: 'DELETE',
    path: '/sources/:id',
    summary: '删除来源（连同它的快照与变化）',
    handler: ({ service, params }) => service.deleteSource(params.id),
  },
  {
    method: 'POST',
    path: '/sources/test',
    summary: '试抓一次：不写任何东西，只回答"这个来源现在能不能解析"',
    handler: ({ service, body }) => service.testSource(body),
  },
  {
    method: 'POST',
    path: '/refresh',
    summary: '刷新（全部、指定来源，或只刷新已到期的定时来源：body {due:true}）',
    handler: ({ service, body }) => (body?.due === true ? service.refreshDue() : service.refresh(body)),
  },
  {
    method: 'GET',
    path: '/sources/:id/snapshots',
    summary: '某个来源的快照历史（每份带相对上一份的差异摘要）',
    handler: ({ service, params, query }) => service.listSnapshots(params.id, query),
  },
  {
    method: 'GET',
    path: '/snapshots/:id',
    summary: '一份快照的正文与差异链',
    handler: ({ service, params }) => service.getSnapshot(params.id),
  },
  {
    method: 'GET',
    path: '/export/opportunities',
    summary: '把机会池导出为 Markdown（事实与推测分区；只读，不改任何用户项目）',
    handler: ({ service, query }) => {
      const result = service.exportOpportunities(query)
      return rawResult({
        text: result.markdown,
        contentType: 'text/markdown; charset=utf-8',
        filename: result.filename,
        tooLargeMessage: '导出的机会太多，超过了单次响应的体积上限；请分批导出（用 `?ids=` 指定几条）。',
      })
    },
  },
  {
    method: 'GET',
    path: '/changes',
    summary: '变化收件箱（分页、筛选、排序）',
    handler: ({ service, query }) => service.listChanges(query),
  },
  {
    method: 'GET',
    path: '/changes/:id',
    summary: '一条变化的详情（含前后快照）',
    handler: ({ service, params }) => service.getChange(params.id),
  },
  {
    method: 'PATCH',
    path: '/changes/:id',
    summary: '改变化的状态或备注（只有这两个字段可写）',
    handler: ({ service, params, body }) => service.updateChange(params.id, body),
  },
  {
    method: 'GET',
    path: '/opportunities',
    summary: '产品机会池',
    handler: ({ service, query }) => service.listOpportunities(query),
  },
  {
    method: 'POST',
    path: '/opportunities',
    summary: '从一条变化沉淀出机会',
    handler: ({ service, body }) => service.createOpportunity(body),
  },
  {
    method: 'GET',
    path: '/opportunities/:id',
    summary: '一条机会的详情（含关联的那条变化；关联对象不存在时如实标注）',
    handler: ({ service, params }) => service.getOpportunity(params.id),
  },
  {
    method: 'PATCH',
    path: '/opportunities/:id',
    summary: '改机会的判断、待验证问题、下一步或状态',
    handler: ({ service, params, body }) => service.updateOpportunity(params.id, body),
  },
  {
    method: 'DELETE',
    path: '/opportunities/:id',
    summary: '删除机会（对应变化回到未读）',
    handler: ({ service, params }) => service.deleteOpportunity(params.id),
  },
  {
    method: 'GET',
    path: '/templates',
    summary: '内置来源模板（地址由代码拼接，不由用户输入）',
    handler: ({ service }) => ({ items: service.templates() }),
  },
  {
    method: 'POST',
    path: '/maintenance/purge',
    summary: '清空快照与变化（需显式 confirm）',
    handler: ({ service, body }) => service.purge(body),
  },
]

/** 路由表里出现过的全部路径（用于 405 与 404 的区分）。 */
const ALL_PATHS = new Set(ROUTES.map((route) => route.path))

/**
 * 匹配一条路由。
 *
 * 静态段优先：否则 `/sources/test` 会被 `/sources/:id` 抢走，
 * 于是"测试一个来源"变成"改一个 id 叫 test 的来源"。
 *
 * @param {string} method HTTP 方法
 * @param {string} path 去前缀后的路径
 * @returns {{route: object, params: Record<string, string>} | {methodMismatch: true} | null}
 */
export function matchRoute(method, path) {
  const wished = splitPath(path)
  const candidates = ROUTES.filter((route) => splitPath(route.path).length === wished.length)
  const matches = candidates.filter((route) => {
    const parts = splitPath(route.path)
    return parts.every((part, index) => part.startsWith(':') || part === wished[index])
  })
  if (!matches.length) return null

  // 段内静态字符更多的排在前面 —— 这就是"静态优先"。
  matches.sort((a, b) => staticWeight(b.path) - staticWeight(a.path))
  const exact = matches.find((route) => route.method === method)
  if (!exact) {
    // 同路径存在别的实现，但方法不对。
    if (matches.some((route) => ALL_PATHS.has(route.path))) return { methodMismatch: true }
    return null
  }
  const params = {}
  splitPath(exact.path).forEach((part, index) => {
    if (part.startsWith(':')) params[part.slice(1)] = decodeURIComponent(wished[index])
  })
  return { route: exact, params }
}

/** 按 `/` 切分并丢掉首尾空段。 */
function splitPath(path) {
  return String(path).split('/').filter(Boolean)
}

/** 路径里静态段的总长度，用于给候选排序。 */
function staticWeight(path) {
  return splitPath(path).reduce((sum, part) => sum + (part.startsWith(':') ? 0 : part.length), 0)
}

/**
 * 构造前缀路由处理器。
 *
 * 依赖以闭包注入，因此可以在**没有真实 Host** 的情况下用假的 `req` / `res` 单测，
 * 这也是 `test/route.test.mjs` 覆盖异常分支的方式。
 *
 * @param {object} deps 依赖
 * @param {() => object} deps.getService 返回当前服务（可能尚未就绪）
 * @param {() => object} deps.getRuntime 返回运行时事实（pid / node / 版本）
 * @param {() => string} [deps.now] 当前时间（ISO 8601）
 * @param {(req: object) => Promise<object>} [deps.readBody] 读并解析请求体（可注入以便单测）
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createHandler({ getService, getRuntime, now = () => new Date().toISOString(), readBody = readJsonBody }) {
  return async function handle(req, res) {
    try {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, failEnvelope('LOOPBACK_ONLY', undefined, { code: ROUTE_CODES.loopbackOnly }))
        return
      }

      const method = String(req.method ?? 'GET').toUpperCase()
      const url = new URL(req.url || '/', 'http://localhost')
      const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) || '/' : url.pathname

      const matched = matchRoute(method, path)
      if (!matched) {
        sendJson(res, 404, failEnvelope('NOT_FOUND', `没有这个接口：${method} ${path}`, { code: ROUTE_CODES.notFound, route: path }))
        return
      }
      if (matched.methodMismatch) {
        sendJson(res, 405, failEnvelope('METHOD_NOT_ALLOWED', `${path} 不支持 ${method}`, { code: ROUTE_CODES.methodNotAllowed }))
        return
      }

      const hasBody = method === 'POST' || method === 'PATCH' || method === 'DELETE'
      let body = {}
      if (hasBody) {
        try {
          body = await readBody(req)
        } catch (error) {
          const wire = toWireError(error)
          const status = wire.code === 'PAYLOAD_TOO_LARGE' ? 413 : 400
          sendJson(res, status, failEnvelope(wire.code, wire.message, wire.detail))
          return
        }
      }

      const service = getService() ?? unavailableService()
      const query = Object.fromEntries(url.searchParams.entries())
      const data = await matched.route.handler({ service, runtime: getRuntime(), now, query, params: matched.params, body })

      // 成功响应也过一遍路径脱敏：`storage.reason`、来源的 `lastError.message`
      // 这类字段会带着本机绝对路径直接进界面，而它们**不在**失败信封里。
      // 只重写 `$HOME` 前缀与 `/Users/<name>`、`/Volumes/<name>` 这三种形状，
      // 因此正常内容（公开网址、发布说明）不会被改动。
      // 显式标记的原始响应（目前只有 Markdown 导出）。默认路径完全不变。
      const raw = data !== null && typeof data === 'object' ? data[RAW_RESULT] : null
      if (raw) {
        const body = redactPaths(raw.text)
        if (Buffer.byteLength(body) > raw.maxBytes) {
          sendJson(res, 500, failEnvelope('INTERNAL', raw.tooLargeMessage ?? `响应超过 ${raw.maxBytes} 字节上限，请缩小范围`, {
            code: ROUTE_CODES.responseTooLarge,
            limit: raw.maxBytes,
          }))
          return
        }
        sendRaw(res, 200, body, raw.contentType, raw.filename)
        return
      }

      const envelope = okEnvelope(data)
      const text = redactPaths(JSON.stringify(envelope))
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
        // 宁可报错也不静默截断：被截断的列表会让人以为"就这么多"。
        sendJson(res, 500, failEnvelope('INTERNAL', `响应超过 ${MAX_RESPONSE_BYTES} 字节上限，请缩小分页或范围`, {
          code: ROUTE_CODES.responseTooLarge,
          limit: MAX_RESPONSE_BYTES,
        }))
        return
      }
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      })
      res.end(text)
    } catch (error) {
      const { status, body: envelope } = toWireFailure(error)
      // 这里再兜一层：连错误信封都写失败的话，至少不要把异常抛进宿主的请求处理栈。
      try {
        sendJson(res, status, envelope)
      } catch {
        /* 响应已经不可写，没有补救手段 */
      }
    }
  }
}

/**
 * 读并解析 JSON 请求体。
 *
 * 空体按 `{}` 处理 —— `POST /refresh` 不带参数是完全合法的调用。
 * 体超限时**先停止累积**再抛错，不把整个请求读进内存。
 *
 * @param {import('node:http').IncomingMessage} req 请求
 * @returns {Promise<object>}
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_REQUEST_BYTES) {
      throw radarError('PAYLOAD_TOO_LARGE', { limit: MAX_REQUEST_BYTES, code: ROUTE_CODES.requestTooLarge })
    }
    chunks.push(chunk)
  }
  if (!size) return {}
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw radarError('BAD_REQUEST', { code: ROUTE_CODES.badJson, reason: '请求体必须是 JSON 对象' })
    }
    return parsed
  } catch (error) {
    if (error instanceof RadarError) throw error
    throw radarError('BAD_REQUEST', { code: ROUTE_CODES.badJson, reason: '请求体不是合法 JSON' })
  }
}

/**
 * 抹掉文本里的本机绝对路径。
 *
 * 后端给出的失败原因常常带完整路径（例如 `.../storages/ai_product_radar_sources.json`），
 * 而失败原因是要显示在界面上的。这里把它换成 `~`，**保留可定位的部分**
 * （目录层级与文件名），只隐藏 home 与用户名。
 *
 * 刻意不依赖 `node:os`：只需要 `$HOME` 就够了，而 `node:` 前缀是本项目
 * G-NET-2 闸门禁止的（见 `test/gate-scan.mjs`）。
 *
 * @param {string} text 待处理文本
 * @returns {string}
 */
export function redactPaths(text) {
  let out = String(text)
  const home = globalThis.process?.env?.HOME
  if (home) out = out.split(home).join('~')
  // 兜底：任何 /Users/<name> 或 /Volumes/<name> 形式的前缀
  out = out.replace(/\/Users\/[^/\s"']+/g, '~')
  out = out.replace(/\/Volumes\/[^/\s"']+/g, '/Volumes/<volume>')
  return out
}

/**
 * 抹掉结构化细节里的路径样式的字符串值。
 * @param {object} detail 细节
 * @returns {object}
 */
function sanitizeDetail(detail) {
  const out = {}
  for (const [key, value] of Object.entries(detail)) {
    out[key] = typeof value === 'string' ? redactPaths(value) : value
  }
  return out
}

/** 记录 id 的形状约束，供路由层做**最早**的一道校验（服务层还会再查存在性）。 */
export const ID_IN_PATH = /^[A-Za-z0-9_-]{1,120}$/
