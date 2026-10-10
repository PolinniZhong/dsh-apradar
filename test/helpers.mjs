/**
 * 测试替身（**不是**测试文件，不会被 `node --test 'test/*.test.mjs'` 收集）。
 *
 * 存储与出网是本插件唯二不可控的边界，所有测试都从这里取替身：
 *   - `memStore()`   —— 内存存储，形状与 `openRadarStore()` 的返回值一致
 *   - `fakeGateway()` —— 记录调用次数的假网关，**测试绝不出网**
 *
 * 放在一处而不是每个测试文件各写一份：两份替身一定会漂移，而漂移后的
 * 替身会让"测试通过"变得没有意义。
 *
 * @module dsh-apradar/test/helpers
 */

import { createHandler } from '../src/host/http.js'
import { createService } from '../src/host/service.js'

/** 四个存储域里的表名。 */
export const TABLES = ['sources', 'snapshots', 'changes', 'opportunities']

/** 最小可用的假响应对象。 */
export function fakeRes() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers
    },
    end(text) {
      this.body = text
    },
  }
}

/** 最小可用的假请求对象。 */
export function fakeReq(url, { method = 'GET', address = '127.0.0.1' } = {}) {
  return { method, url, socket: { remoteAddress: address } }
}

/** 把字符串数组包成一个 async iterable，模拟 `req` 的请求体流。 */
export function streamOf(chunks) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield Buffer.from(chunk)
    },
  }
}

/**
 * 内存存储替身，形状与 `openRadarStore()` 的成功返回值一致。
 *
 * `ok: false` 时**不提供**真实的表操作语义（但方法仍在），用来测"存储不可用"
 * 这条路径 —— 界面上必须显示失败原因，而不是显示"已保存"。
 *
 * @param {{ok?: boolean, reason?: string}} [options] 让它失败
 * @returns {object} 句柄
 */
export function memStore({ ok = true, reason } = {}) {
  const backing = new Map(TABLES.map((name) => [name, new Map()]))
  const globals = {
    schemaVersion: 1,
    openCount: 2,
    firstOpenedAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: '2026-01-01T00:00:00.000Z',
  }
  const table = (name) => {
    if (!backing.has(name)) throw new Error(`未知表名：${name}`)
    return backing.get(name)
  }
  return {
    ok,
    specMode: ok ? 'inline' : 'unavailable',
    reason: ok ? null : (reason ?? 'ctx.storageDomain 不可用'),
    domainName: 'ai_product_radar_sources',
    domainNames: [
      'ai_product_radar_sources',
      'ai_product_radar_snapshots',
      'ai_product_radar_changes',
      'ai_product_radar_opportunities',
    ],
    state: () => ({ ...globals }),
    counts: () => Object.fromEntries(TABLES.map((name) => [name, table(name).size])),
    all: (name) => [...table(name).entries()].map(([id, value]) => ({ id, ...value })),
    get: (name, id) => {
      const value = table(name).get(id)
      return value === undefined ? undefined : { id, ...value }
    },
    put: async (name, record) => {
      if (!record || typeof record.id !== 'string' || !record.id) throw new Error(`记录缺少 id（表 ${name}）`)
      table(name).set(record.id, { ...record })
    },
    del: async (name, id) => table(name).delete(id),
    markRefreshed: async () => {
      globals.lastRefreshAt = '2026-01-01T00:00:01.000Z'
    },
    listSources: () => [...backing.get('sources').entries()].map(([id, value]) => ({ id, ...value })),
    sourceCount: () => backing.get('sources').size,
  }
}

/**
 * 一个确定性的 Atom 订阅源，用来喂给 GitHub Releases 适配器。
 * @param {{id: string, title: string, updated: string, body?: string}[]} entries 条目
 * @returns {string} Atom XML
 */
export function atomFeed(entries) {
  const items = entries
    .map(
      (entry) => `  <entry>
    <id>${entry.id}</id>
    <title>${entry.title}</title>
    <updated>${entry.updated}</updated>
    <link href="https://example.test/${entry.id}"/>
    <content type="html">${entry.body ?? entry.title}</content>
  </entry>`,
    )
    .join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Releases</title>
${items}
</feed>`
}

/**
 * 记录每次出网的假网关（插件测试**绝不真的出网**）。
 *
 * 多次抓取按 `pages` 顺序依次返回，用完后重复最后一页 —— 这样"第一轮基线、
 * 第二轮有变化"这种序列可以写得直接。
 *
 * @param {string[]} [pages] 依次返回的响应体
 * @returns {{available: boolean, calls: string[], fetch: (url: string) => Promise<object>}}
 */
export function fakeGateway(pages = []) {
  const calls = []
  let index = 0
  return {
    available: true,
    calls,
    async fetch(url) {
      calls.push(url)
      const page = pages[Math.min(index, pages.length - 1)] ?? ''
      index += 1
      return { url, statusCode: 200, kind: 'text', content: page, truncated: false }
    },
  }
}

/** 假的运行时事实。 */
export const RUNTIME = { plugin: 'dsh-apradar', pluginVersion: '0.1.0', node: 'v0.0.0', pid: 1 }

/**
 * 组装一个可调用的处理器（真服务 + 假存储 + 假网关）。
 *
 * 只测 `http.js` 的路由表会漏掉最有价值的一类缺陷：路由接对了、但服务层拒绝
 * 或抛错。因此这里让整条链路（路由 → 服务 → 存储）都在测试范围内，
 * 唯一被替换的是"磁盘"与"网络"这两个不可控的边界。
 *
 * @param {object} [options] `{store, gateway, now}`
 * @returns {{service: object, store: object, gateway: object}}
 */
export function makeApp({ store = memStore(), gateway = fakeGateway(), now = () => 1_700_000_000_000 } = {}) {
  const service = createService({ store, gateway, now, log: () => {} })
  return { service, store, gateway }
}

/**
 * 发一个请求并解析响应。
 * @param {object} app `makeApp()` 的返回值
 * @param {string} url 路径（含前缀）
 * @param {object} [options] `{method, body, address}`
 * @returns {Promise<{status: number, headers: object, data: any, body: any, raw: string}>}
 */
export async function call(app, url, { method = 'GET', body, address = '127.0.0.1' } = {}) {
  const res = fakeRes()
  const handle = createHandler({
    getService: () => app.service,
    getRuntime: () => RUNTIME,
    now: () => '2026-01-01T00:00:00.000Z',
    readBody: async () => body ?? {},
  })
  await handle(fakeReq(url, { method, address }), res)
  // 不是所有响应都是 JSON：Markdown 导出走的是原始响应（`rawResult`）。
  // 这里如实区分两种载体，而不是硬 `JSON.parse` —— 硬解析会在测试里抛
  // SyntaxError，把"接口正常工作"报成"测试基础设施坏了"。
  let parsed = null
  try {
    parsed = JSON.parse(res.body || '{}')
  } catch {
    parsed = null
  }
  return {
    status: res.status,
    headers: res.headers,
    data: parsed ? parsed.data : undefined,
    body: parsed,
    raw: res.body,
    contentType: res.headers['content-type'],
  }
}
