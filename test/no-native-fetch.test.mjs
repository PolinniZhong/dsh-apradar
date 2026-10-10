/**
 * G-NET-4：运行期替身断言（SDD §8.1.1）。
 *
 * **目的**：把 `globalThis.fetch` 与 `XMLHttpRequest` 换成"一调用就抛错"的桩，
 * 然后跑**完整的刷新流程**。判据有两条，缺一不可：
 *   1. 宿主 `ctx.web` 替身**被调用**（说明出网确实走了那一条路）；
 *   2. 抛错桩**零调用**（说明我们没走原生通路）。
 *
 * ## 这个测试**不能**证明什么（必须原样保留）
 *
 * 它**只**证明"我们自己的代码没走原生 fetch"。它**不**证明网络请求无法绕过：
 * `node:http`、`node:https`、`node:net`、`node:dns`、`undici`，以及动态
 * `import('node:http')` / `createRequire(...)('node:http')` /
 * `process.getBuiltinModule('http')`，都能在运行期绕开任何"删掉几个全局对象"的做法。
 * 因此这是**必要条件，不是充分条件**；充分性由静态闸门（`test/gate-scan.mjs`）
 * 与代码评审共同承担，而 DSH 当前**不提供**网络沙箱。
 *
 * 运行：`npm test`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { createWebGateway } from '../src/host/fetch/gateway.js'
import { atomFeed, memStore } from './helpers.mjs'
import { createService } from '../src/host/service.js'

/** 装上一组"一调用就抛错"的原生出网桩，并返回调用计数与还原函数。 */
function installEgressTraps() {
  const calls = { fetch: 0, xhr: 0, webSocket: 0, sendBeacon: 0 }
  const saved = {
    fetch: globalThis.fetch,
    XMLHttpRequest: globalThis.XMLHttpRequest,
    WebSocket: globalThis.WebSocket,
  }
  globalThis.fetch = () => {
    calls.fetch += 1
    throw new Error('原生 fetch 被调用了 —— 出网必须只走 ctx.web.fetch')
  }
  globalThis.XMLHttpRequest = class {
    constructor() {
      calls.xhr += 1
      throw new Error('XMLHttpRequest 被构造了 —— 出网必须只走 ctx.web.fetch')
    }
  }
  globalThis.WebSocket = class {
    constructor() {
      calls.webSocket += 1
      throw new Error('WebSocket 被构造了 —— 出网必须只走 ctx.web.fetch')
    }
  }
  return {
    calls,
    restore() {
      globalThis.fetch = saved.fetch
      globalThis.XMLHttpRequest = saved.XMLHttpRequest
      globalThis.WebSocket = saved.WebSocket
    },
  }
}

/** 一个假的 Cordis 上下文：只提供 `ctx.get('web')`。 */
function fakeCtxWithWeb(webDouble) {
  return {
    get(name) {
      return name === 'web' ? webDouble : undefined
    },
  }
}

test('完整刷新流程只走 ctx.web.fetch：替身被调用，原生桩零调用', async () => {
  const traps = installEgressTraps()
  try {
    /** 记录宿主抓取替身收到的请求体。 */
    const webCalls = []
    const feed = atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])
    const webDouble = {
      async fetch(request, signal) {
        webCalls.push({ request, signal })
        return { url: request.url, statusCode: 200, body: { kind: 'text', content: feed }, truncated: false }
      },
    }

    const gateway = createWebGateway(fakeCtxWithWeb(webDouble))
    assert.equal(gateway.available, true, 'ctx.web 可用时网关必须可用')

    const service = createService({ store: memStore(), gateway, now: () => 1_700_000_000_000, log: () => {} })
    const created = await service.createSource({
      type: 'github_releases',
      config: { owner: 'deepseek-ai', repo: 'deepseek-harness' },
    })
    assert.ok(created.id, '建源不该出网')

    const result = await service.refresh({})
    assert.equal(result.summary.succeeded, 1, '刷新必须成功')
    assert.equal(result.summary.failed, 0)

    assert.equal(webCalls.length, 1, 'ctx.web.fetch 必须恰好被调用一次')
    assert.deepEqual(
      Object.keys(webCalls[0].request),
      ['url'],
      '请求体必须是 { url } 对象 —— 传字符串会被宿主拒绝（Spike 已实测过这个坑）',
    )
    // GitHub 来源的首选端点是官方 API（`github.com` 在实测网络里不可达，
    // 见 `src/host/adapters/github-releases.js` 文件头）。这里断言的是
    // **首选端点被真的用了**，而不是"某次抓取发生过"。
    assert.match(webCalls[0].request.url, /^https:\/\/api\.github\.com\/repos\/deepseek-ai\/deepseek-harness\/releases\?per_page=\d+$/)

    assert.deepEqual(traps.calls, { fetch: 0, xhr: 0, webSocket: 0, sendBeacon: 0 }, '原生出网入口必须零调用')
  } finally {
    traps.restore()
  }
})

test('ctx.web 不可用时如实失败，且**绝不**回落到原生 fetch', async () => {
  const traps = installEgressTraps()
  try {
    const gateway = createWebGateway(fakeCtxWithWeb(undefined))
    assert.equal(gateway.available, false)
    assert.match(gateway.reason, /ctx\.web/)

    const service = createService({ store: memStore(), gateway, now: () => 1_700_000_000_000, log: () => {} })
    await service.createSource({ type: 'github_releases', config: { owner: 'o', repo: 'r' } })
    const result = await service.refresh({})

    assert.equal(result.summary.succeeded, 0)
    assert.equal(result.summary.failed, 1)
    assert.equal(result.results[0].error.code, 'WEB_PROVIDER_ERROR')
    assert.equal(traps.calls.fetch, 0, '不能因为宿主没给能力就偷偷用原生 fetch')
  } finally {
    traps.restore()
  }
})

test('网关透传取消信号，并归一化宿主返回值', async () => {
  const seen = []
  const gateway = createWebGateway(
    fakeCtxWithWeb({
      async fetch(request, signal) {
        seen.push({ request, signal })
        return { url: request.url, statusCode: 204, body: undefined, truncated: true }
      },
    }),
  )
  const controller = new AbortController()
  const result = await gateway.fetch('https://example.test/x', { signal: controller.signal })
  assert.equal(seen[0].signal, controller.signal, '取消信号必须透传，否则超时无法中断')
  assert.deepEqual(result, { url: 'https://example.test/x', statusCode: 204, kind: 'text', content: '', truncated: true })
})

test('createWebGateway 走 ctx.get 而不是属性访问（未 inject 时属性访问会抛错）', () => {
  let getCalls = 0
  const ctx = {
    get(name) {
      getCalls += 1
      return name === 'web' ? { fetch: async () => ({ url: '', statusCode: 200, body: { kind: 'text', content: '' } }) } : undefined
    },
  }
  // 属性访问会抛错 —— 如果实现用了 ctx.web，这一行就会把测试打红。
  Object.defineProperty(ctx, 'web', {
    get() {
      throw new Error('cannot get property "web" without inject')
    },
  })
  const gateway = createWebGateway(ctx)
  assert.equal(gateway.available, true)
  assert.ok(getCalls >= 1)
})

test('宿主返回体缺失字段时给出安全默认值（下游不必到处写可选链）', async () => {
  const gateway = createWebGateway(fakeCtxWithWeb({ async fetch() { return {} } }))
  assert.deepEqual(await gateway.fetch('https://example.test/y'), {
    url: '',
    statusCode: 0,
    kind: 'text',
    content: '',
    truncated: false,
  })
})
