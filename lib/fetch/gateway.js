/**
 * 出网网关：**全插件唯一**允许发起网络请求的地方（SDD §6.2 / §8）。
 *
 * 两条不可协商的规则：
 *  1. 只用宿主公开的 `ctx.web.fetch({ url })`。**禁止**使用 `globalThis.fetch`、
 *     `XMLHttpRequest`、`node:http`/`node:https` —— 那条路会绕过宿主的地址白名单、
 *     体积上限与重定向校验。`test/no-native-fetch.test.mjs` 会把这当作闸门来验证。
 *  2. 服务必须用 `ctx.get('web')` 读取。直接读 `ctx.web` 在未声明 `inject` 时
 *     会被 Cordis 抛错，而且那个异常足以把整个宿主进程打成 fatal load failure
 *     （`TECH-SPIKE.md` §6.4 有完整现场记录）。
 *
 * @module dsh-apradar/src/host/fetch/gateway
 */

import { radarError } from '../errors.js'

/**
 * 从 Cordis 上下文里安全地取一个服务。
 *
 * `ctx.get(name)` 是官方文档明确说明的「无需 inject 即可读取服务」的入口；
 * 老版本或测试替身可能没有 `get`，所以退回到属性访问并用 try/catch 兜住
 * 「未 inject 就抛错」的行为。
 *
 * @param {object} ctx 插件上下文或测试替身
 * @param {string} name 服务名
 * @returns {any} 服务实例；不可用时为 undefined
 */
export function resolveService(ctx, name) {
  if (!ctx || typeof ctx !== 'object') return undefined
  if (typeof ctx.get === 'function') {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  try {
    return ctx[name]
  } catch {
    return undefined
  }
}

/**
 * 把宿主返回的抓取结果归一成插件内部的形状。
 *
 * 宿主的 `WebFetchResult` 已经是稳定形状（`{url, statusCode, body:{kind,content}, truncated}`），
 * 这里只做防御性修补：字段缺失时给安全默认值，避免下游到处写 `?.`。
 *
 * @param {unknown} result `ctx.web.fetch` 的返回值
 * @returns {{ url: string, statusCode: number, kind: 'html'|'text', content: string, truncated: boolean }}
 */
export function normalizeFetchResult(result) {
  const raw = result && typeof result === 'object' ? result : {}
  const body = raw.body && typeof raw.body === 'object' ? raw.body : {}
  const kind = body.kind === 'html' ? 'html' : 'text'
  return {
    url: typeof raw.url === 'string' ? raw.url : '',
    statusCode: typeof raw.statusCode === 'number' ? raw.statusCode : 0,
    kind,
    content: typeof body.content === 'string' ? body.content : '',
    truncated: raw.truncated === true,
  }
}

/**
 * 基于宿主 `ctx.web` 的网关。
 *
 * @param {object} ctx 插件上下文
 * @returns {{ available: boolean, reason?: string, fetch: (url: string, options?: {signal?: AbortSignal}) => Promise<object> }}
 */
export function createWebGateway(ctx) {
  const web = resolveService(ctx, 'web')
  if (!web || typeof web.fetch !== 'function') {
    return {
      available: false,
      reason: '宿主未提供网页请求能力（ctx.web.fetch 不可用）',
      async fetch() {
        throw radarError('WEB_PROVIDER_ERROR', { reason: 'ctx.web.fetch 不可用' })
      },
    }
  }

  return {
    available: true,
    /**
     * @param {string} url 已通过 `assertFetchableUrl` 的绝对地址
     * @param {{signal?: AbortSignal}} [options] 取消信号
     * @returns {Promise<object>} 归一后的抓取结果
     */
    async fetch(url, options = {}) {
      // 注意：请求体**必须**是对象。宿主的签名是 fetch(request: {url}, signal?)。
      const raw = await web.fetch({ url }, options.signal)
      return normalizeFetchResult(raw)
    },
  }
}

/**
 * 测试用的假网关。
 *
 * 存在的意义：适配器与服务层的单测**绝不能出网**。CI 里由它替代真实网关，
 * 让「解析失败」「HTTP 500」「响应被截断」这些分支都能被确定性地覆盖。
 *
 * @param {(url: string) => object | Promise<object>} handler 收到 url 返回（不完整的）抓取结果
 * @returns {{ available: boolean, calls: string[], fetch: (url: string) => Promise<object> }}
 */
export function createFakeGateway(handler) {
  /** @type {string[]} */
  const calls = []
  return {
    available: true,
    calls,
    async fetch(url) {
      calls.push(url)
      const result = await handler(url)
      return normalizeFetchResult(result)
    },
  }
}
