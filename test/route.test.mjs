/**
 * 路由层测试 —— 覆盖全部插件接口（当前 21 条）、每一个用户能看到的失败形态，以及防护不变量。
 *
 * ## 为什么这里用"真服务 + 假存储/假网关"
 *
 * 只测 `http.js` 的路由表会漏掉最有价值的一类缺陷：路由接对了、但服务层拒绝或
 * 抛错。因此这里的处理器是 `createHandler({ getService: () => createService(...) })`，
 * 存储与出网是**内存替身**（`test/` 绝不出网）。整条链路（路由 → 服务 → 存储）
 * 都在测试范围内，唯一被替换的是"磁盘"与"网络"这两个不可控的边界。
 *
 * 运行：`npm test`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROUTES,
  ROUTE_CODES,
  ROUTE_PREFIX,
  createHandler,
  isLoopback,
  matchRoute,
  readJsonBody,
  redactPaths,
  sendJson,
} from '../src/host/http.js'
import { getAdapter, listAdapters } from '../src/host/adapters/index.js'
import { RUNTIME, atomFeed, call, fakeGateway, fakeReq, fakeRes, makeApp, memStore, streamOf } from './helpers.mjs'

// ---------------------------------------------------------------- 路由表

test('路由表恰好 22 条，方法与路径唯一', () => {
  assert.equal(ROUTES.length, 22, '接口数量变了就要同步更新文档与客户端')
  const seen = new Set()
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`
    assert.ok(!seen.has(key), `重复路由：${key}`)
    seen.add(key)
    assert.ok(route.summary && route.summary.length > 4, `${key} 缺少 summary`)
  }
})

test('每条路由都能被 matchRoute 解析出参数', () => {
  for (const route of ROUTES) {
    const concrete = route.path.replace(':id', 'abc123')
    const matched = matchRoute(route.method, concrete)
    assert.ok(matched && matched.route, `${route.method} ${concrete} 无法匹配`)
    if (route.path.includes(':id')) assert.equal(matched.params.id, 'abc123')
  }
})

test('静态段优先：/sources/test 不会被 /sources/:id 抢走', () => {
  const matched = matchRoute('POST', '/sources/test')
  assert.equal(matched.route.path, '/sources/test')
  assert.equal(matchRoute('PATCH', '/sources/test').route.path, '/sources/:id')
})

test('matchRoute 区分"路径不存在"与"方法不对"', () => {
  assert.equal(matchRoute('GET', '/nope'), null)
  assert.deepEqual(matchRoute('DELETE', '/ping'), { methodMismatch: true })
})

test('isLoopback 覆盖 ::1 与 IPv4-mapped 形式', () => {
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1', '127.0.0.53']) {
    assert.equal(isLoopback(address), true, `${address} 应被认为是回环`)
  }
  for (const address of ['10.0.0.1', '::', '192.168.1.1', undefined, '']) {
    assert.equal(isLoopback(address), false, `${address} 不该被认为是回环`)
  }
})

// ---------------------------------------------------------------- 失败形态

test('非回环地址一律拒绝：插件路由只服务本机界面', async () => {
  const res = await call(makeApp(), `${ROUTE_PREFIX}/ping`, { address: '10.0.0.7' })
  assert.equal(res.status, 403)
  assert.equal(res.body.error.code, 'LOOPBACK_ONLY')
  assert.equal(res.body.error.detail.code, ROUTE_CODES.loopbackOnly)
})

test('未知路由 404，且回显路径（便于定位接线错误）', async () => {
  const res = await call(makeApp(), `${ROUTE_PREFIX}/nope`)
  assert.equal(res.status, 404)
  assert.equal(res.body.error.code, 'NOT_FOUND')
  assert.equal(res.body.error.detail.route, '/nope')
})

test('方法不对返回 405，而不是 404', async () => {
  const res = await call(makeApp(), `${ROUTE_PREFIX}/ping`, { method: 'POST' })
  assert.equal(res.status, 405)
  assert.equal(res.body.error.code, 'METHOD_NOT_ALLOWED')
})

test('存储不可用时，读接口如实报失败态而不是谎报成功', async () => {
  const app = makeApp({ store: memStore({ ok: false, reason: '打开域失败（ENOENT: /Users/someone/.dsh/s.json）' }) })
  const res = await call(app, `${ROUTE_PREFIX}/state`)
  assert.equal(res.status, 200, '接口本身可用，但存储结论必须是失败')
  assert.equal(res.data.storage.ok, false)
  assert.equal(typeof res.data.storage.reason, 'string')
  assert.equal(res.data.storage.openCount, 0)
  assert.equal(res.data.counts.sources, 0)
})

test('存储不可用时，写接口返回 503 而不是静默丢弃', async () => {
  const app = makeApp({ store: memStore({ ok: false }) })
  const res = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  assert.equal(res.status, 503)
  assert.equal(res.body.error.code, 'STORAGE_OPEN_FAILED')
})

test('存储失败原因里的 home 路径会被抹掉，但仍保留可定位的目录与文件名', async () => {
  const app = makeApp({ store: memStore({ ok: false, reason: 'ENOENT: /Users/someone/.dsh/storages/radar.json' }) })
  const res = await call(app, `${ROUTE_PREFIX}/state`)
  assert.ok(!res.raw.includes('/Users/'), '失败原因里不得带 home 绝对路径')
  assert.match(res.data.storage.reason, /~\/\.dsh\/storages\/radar\.json/, '仍要保留可定位的部分')
})

test('所有响应都不得泄漏本机绝对路径', async () => {
  const app = makeApp()
  for (const path of ['/ping', '/meta', '/state', '/sources', '/changes', '/opportunities', '/templates', '/nope']) {
    const res = await call(app, `${ROUTE_PREFIX}${path}`)
    assert.ok(!res.raw.includes('/Users/'), `${path} 泄漏了本机路径`)
    assert.ok(!/\/Volumes\//.test(res.raw), `${path} 泄漏了挂载卷路径`)
  }
})

test('redactPaths 是纯函数，不依赖 node:os', () => {
  assert.equal(redactPaths('/Users/someone/x.json'), '~/x.json')
  assert.equal(redactPaths('/Volumes/Data/y.json'), '/Volumes/<volume>/y.json')
  assert.equal(redactPaths('no path here'), 'no path here')
})

// ---------------------------------------------------------------- 健康与元数据

test('/ping 的响应确实来自本插件', async () => {
  const res = await call(makeApp(), `${ROUTE_PREFIX}/ping?cachebust=1`)
  assert.equal(res.status, 200)
  assert.equal(res.body.ok, true)
  assert.match(res.data.testMarker, /^apradar-/)
  assert.equal(res.data.plugin, 'dsh-apradar')
  assert.equal(res.data.routePrefix, ROUTE_PREFIX)
})

test('/meta 给出上限、适配器与状态枚举（界面据此渲染，不硬编码）', async () => {
  const res = await call(makeApp(), `${ROUTE_PREFIX}/meta`)
  assert.equal(res.status, 200)
  assert.equal(res.data.adapters.length, 5)
  assert.deepEqual(
    res.data.adapters.map((adapter) => adapter.type),
    ['github_releases', 'github_repo', 'npm_package', 'rss_atom', 'html_static'],
  )
  // 地址由代码拼接的类型必须排在需要用户自己找地址的类型前面，且不能反过来说。
  assert.deepEqual(
    res.data.adapters.map((adapter) => adapter.conditional),
    [false, false, false, true, true],
  )
  assert.equal(typeof res.data.limits, 'object')
  assert.ok(Object.keys(res.data.limits).length >= 10, '上限要以数据形式给出，不能只写在文档里')
  assert.ok(Number.isFinite(res.data.limits.maxSources))
  assert.ok(Number.isFinite(res.data.limits.maxResponseBytes))
  assert.deepEqual(res.data.changeStatuses, ['unread', 'seen', 'ignored', 'pooled'])
  assert.deepEqual(res.data.opportunityStatuses, ['to_research', 'verifying', 'planned', 'dropped'])
  assert.equal(res.data.modelCallsInRefresh, 0, '刷新过程中不做任何模型调用')
})

test('/templates 只给地址由代码拼接的模板', async () => {
  const res = await call(makeApp(), `${ROUTE_PREFIX}/templates`)
  assert.equal(res.status, 200)
  assert.ok(res.data.items.length >= 1)
  // 判据刻意**不是**"类型写在一张白名单里"，而是「这个适配器自己声明了地址由
  // 代码拼接」。白名单会在将来新增类型时悄悄放过一条用户自填地址的模板，
  // 而这条断言会立刻失败。
  for (const item of res.data.items) {
    const adapter = getAdapter(item.type)
    assert.ok(adapter, `模板 ${item.id} 的类型 ${item.type} 必须已注册`)
    assert.equal(adapter.addressIsGenerated, true, `模板 ${item.id} 的地址必须是代码拼接的`)
  }
  // 反向也要成立：凡是地址由代码拼接的类型，都应当至少有一条模板可用。
  for (const adapter of listAdapters()) {
    if (adapter.conditional === false) {
      assert.ok(
        res.data.items.some((item) => item.type === adapter.type),
        `${adapter.type} 声明了地址由代码拼接，却没有预置模板`,
      )
    }
  }
})

// ---------------------------------------------------------------- 关注源

test('未起名时，默认名字由适配器给出 —— 不能是类型名', async () => {
  const app = makeApp()
  /** @type {[object, string][]} */
  const cases = [
    [{ type: 'github_releases', config: { owner: 'openai', repo: 'openai-node' } }, 'openai/openai-node'],
    [{ type: 'github_repo', config: { owner: 'openai', repo: 'openai-node' } }, 'openai/openai-node'],
    [{ type: 'npm_package', config: { name: 'ai' } }, 'ai'],
    // 非 latest 的 tag 必须出现在名字里：ai 与 ai@beta 是两个不同的来源。
    [{ type: 'npm_package', config: { name: '@anthropic-ai/sdk', tag: 'beta' } }, '@anthropic-ai/sdk@beta'],
    [{ type: 'rss_atom', config: { feedUrl: 'https://example.com/feed.xml' } }, 'example.com'],
  ]
  for (const [body, expected] of cases) {
    const res = await call(app, `${ROUTE_PREFIX}/sources`, { method: 'POST', body })
    assert.equal(res.status, 200, `${body.type} 建源失败：${JSON.stringify(res.body)}`)
    assert.equal(res.data.name, expected, `${body.type} 的默认名字`);
    // 名字绝不能等于类型标识 —— 一个叫「github_repo」的卡片认不出是哪个仓库。
    assert.notEqual(res.data.name, body.type)
  }

  // 用户自己起的名字永远优先。
  const named = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_repo', config: { owner: 'anthropics', repo: 'anthropic-sdk-typescript' }, name: 'Anthropic TS SDK 动态' },
  })
  assert.equal(named.data.name, 'Anthropic TS SDK 动态')
})

test('POST /sources 建源，重复建同一个源得到 409', async () => {
  const app = makeApp()
  const body = { type: 'github_releases', config: { owner: 'deepseek-ai', repo: 'deepseek-harness' } }
  const first = await call(app, `${ROUTE_PREFIX}/sources`, { method: 'POST', body })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.data.type, 'github_releases')
  assert.equal(first.data.status, 'never')
  assert.equal(first.data.enabled, true)

  const again = await call(app, `${ROUTE_PREFIX}/sources`, { method: 'POST', body })
  assert.equal(again.status, 409)
  assert.equal(again.body.error.code, 'CONFLICT')
})

test('POST /sources 配置不合法时 400，而不是建出一个坏来源', async () => {
  const app = makeApp()
  const res = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: '', repo: 'r' } },
  })
  assert.equal(res.status, 400)
  assert.ok(['ADAPTER_CONFIG_INVALID', 'VALIDATION_FAILED'].includes(res.body.error.code))
  assert.equal(app.store.counts().sources, 0, '失败的创建不得留下记录')
})

test('不支持的来源类型 400 且说清类型', async () => {
  const app = makeApp()
  const res = await call(app, `${ROUTE_PREFIX}/sources`, { method: 'POST', body: { type: 'carrier_pigeon' } })
  assert.equal(res.status, 400)
  assert.equal(res.body.error.code, 'ADAPTER_CONFIG_INVALID')
})

test('PATCH /sources/:id 只允许改名称/配置/启停；越权字段返回 400', async () => {
  const app = makeApp()
  const created = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  const id = created.data.id

  const renamed = await call(app, `${ROUTE_PREFIX}/sources/${id}`, { method: 'PATCH', body: { name: '新名字' } })
  assert.equal(renamed.status, 200)
  assert.equal(renamed.data.name, '新名字')

  const disabled = await call(app, `${ROUTE_PREFIX}/sources/${id}`, { method: 'PATCH', body: { enabled: false } })
  assert.equal(disabled.data.enabled, false)
  assert.equal(disabled.data.status, 'disabled', 'status 是推导出来的，不是存的')

  const forbidden = await call(app, `${ROUTE_PREFIX}/sources/${id}`, {
    method: 'PATCH',
    body: { canonicalUrl: 'https://evil.test/' },
  })
  assert.equal(forbidden.status, 400)
  assert.equal(forbidden.body.error.code, 'FIELD_NOT_WRITABLE')

  const missing = await call(app, `${ROUTE_PREFIX}/sources/nope`, { method: 'PATCH', body: { name: 'x' } })
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'SOURCE_NOT_FOUND')
})

test('PATCH 改配置时：自动生成的名称跟着新地址走，用户自己起的名不动', async () => {
  const app = makeApp()
  // ① 用户没起名 → 名字是按旧地址自动生成的，改地址后必须跟着变。
  const auto = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://blog.google/technology/ai/rss/' } },
  })
  assert.equal(auto.data.name, 'blog.google', '默认名取主机名')
  const moved = await call(app, `${ROUTE_PREFIX}/sources/${auto.data.id}`, {
    method: 'PATCH',
    body: { config: { feedUrl: 'https://techcrunch.com/feed/' } },
  })
  assert.equal(moved.data.name, 'techcrunch.com', '名字必须跟着新地址，否则界面自相矛盾')
  assert.equal(moved.data.canonicalUrl, 'https://techcrunch.com/feed/')

  // ② 用户自己起过名 → 那是他的表达，改地址不许悄悄覆盖。
  const named = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', name: '我盯的 AI 博客', config: { feedUrl: 'https://www.theverge.com/rss/index.xml' } },
  })
  const kept = await call(app, `${ROUTE_PREFIX}/sources/${named.data.id}`, {
    method: 'PATCH',
    body: { config: { feedUrl: 'https://simonwillison.net/atom/everything/' } },
  })
  assert.equal(kept.data.name, '我盯的 AI 博客', '手动命名必须保留')
  assert.equal(kept.data.canonicalUrl, 'https://simonwillison.net/atom/everything/')
})

test('判重比的是来源**当前占用的地址**，不是过时的 id', async () => {
  const app = makeApp()
  // A 建在 blog.google 上（id 由 blog.google 派生），随后被改到 techcrunch。
  const a = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://blog.google/technology/ai/rss/' } },
  })
  await call(app, `${ROUTE_PREFIX}/sources/${a.data.id}`, {
    method: 'PATCH',
    body: { config: { feedUrl: 'https://techcrunch.com/feed/' } },
  })

  // ① techcrunch 现在被 A 占着 → 不许再加一个。否则两个来源轮询同一个 URL，
  //    同一条内容会被记成两条变化（真实宿主实测踩到过）。
  const dup = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://techcrunch.com/feed/' } },
  })
  assert.equal(dup.body.ok, false, '同一个地址不许有两个来源')
  assert.equal(dup.body.error.code, 'CONFLICT')
  assert.equal(dup.body.error.detail.existingId, a.data.id, '要点名是谁占着这个地址')
  assert.equal(app.store.all('sources').length, 1)

  // ② blog.google 已经没人占了（A 已经搬走）→ 必须能加回来。
  //    用 id 判重的旧写法在这里会误报，把"原地址反而加不回来"当成正常。
  const back = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://blog.google/technology/ai/rss/' } },
  })
  assert.equal(back.body.ok, true, '原地址空出来了就该能加回来')
  assert.notEqual(back.data.id, a.data.id)
  assert.equal(app.store.all('sources').length, 2)
})

test('派生 id 撞上一条过时记录时，新来源拿后缀 id —— 绝不覆盖已有来源', async () => {
  const app = makeApp()
  const a = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://blog.google/technology/ai/rss/' } },
  })
  await call(app, `${ROUTE_PREFIX}/sources/${a.data.id}`, {
    method: 'PATCH',
    body: { config: { feedUrl: 'https://techcrunch.com/feed/' } },
  })

  // a 的 id 仍派生自 blog.google（改地址不重算 id）。此时再建一个 blog.google：
  // 地址确实空着（判重放行），但它派生出的 id 与 a 相同 —— 分配器必须让路。
  // 真实事故就是这样丢掉了一条 simonwillison 来源：`store.put` 按键直接覆盖。
  const b = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://blog.google/technology/ai/rss/' } },
  })
  assert.equal(b.body.ok, true)
  assert.notEqual(b.data.id, a.data.id, 'id 撞车时必须换一个，不能覆盖')
  assert.equal(app.store.all('sources').length, 2, 'a 必须还在')

  const survived = app.store.get('sources', a.data.id)
  assert.ok(survived, 'a 被覆盖了 —— 这是数据丢失')
  assert.equal(survived.canonicalUrl, 'https://techcrunch.com/feed/', 'a 的内容必须原样保留')
  assert.equal(app.store.get('sources', b.data.id).canonicalUrl, 'https://blog.google/technology/ai/rss/')
})

test('DELETE /sources/:id 连带删除它的快照与变化', async () => {
  const app = makeApp({ gateway: fakeGateway([atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])]) })
  const created = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  const id = created.data.id
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  assert.equal(app.store.counts().snapshots, 1)

  const removed = await call(app, `${ROUTE_PREFIX}/sources/${id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  assert.equal(removed.data.deleted, true)
  assert.equal(removed.data.removedSnapshots, 1)
  assert.equal(app.store.counts().sources, 0)
  assert.equal(app.store.counts().snapshots, 0)
})

test('POST /sources/test 走静态路由：真的抓一次但不写任何东西', async () => {
  const app = makeApp({ gateway: fakeGateway([atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])]) })
  const res = await call(app, `${ROUTE_PREFIX}/sources/test`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.ok, true)
  assert.equal(res.data.itemCount, 1)
  assert.deepEqual(res.data.sampleTitles, ['v1'])
  assert.equal(app.store.counts().sources, 0, '试抓不写存储')
  assert.equal(app.store.counts().snapshots, 0)
  // 首选端点是 GitHub 官方 API，不是 `releases.atom`（切换原因见适配器文件头）。
  assert.match(app.gateway.calls[0], /^https:\/\/api\.github\.com\/repos\/o\/r\/releases\?per_page=\d+$/)
  assert.equal(app.gateway.calls.length, 1, '首选端点成功时不该再打第二个端点')
})

test('首选端点失败时自动退到备用端点', async () => {
  // 第一个候选（api.github.com）返回 HTML，第二个候选（releases.atom）返回正常 Atom。
  const app = makeApp({
    gateway: fakeGateway(['<html>blocked by gateway</html>', atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])]),
  })
  const res = await call(app, `${ROUTE_PREFIX}/sources/test`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.ok, true, '备用端点能解析时这次抓取就是成功的')
  assert.equal(res.data.itemCount, 1)
  assert.equal(app.gateway.calls.length, 2, '两个候选都必须被试过')
  assert.match(app.gateway.calls[0], /^https:\/\/api\.github\.com\//)
  assert.match(app.gateway.calls[1], /^https:\/\/github\.com\/o\/r\/releases\.atom$/)
})

test('两个端点都失败时报首选端点的原因，并把每个候选的失败附在 detail 里', async () => {
  const app = makeApp({ gateway: fakeGateway(['<html>nope</html>', '<html>nope</html>']) })
  const res = await call(app, `${ROUTE_PREFIX}/sources/test`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  assert.equal(res.status, 200)
  assert.equal(res.data.ok, false)
  // 报的是**首选**端点的原因，不是最后一条：首选端点才是用户想用的那条路。
  assert.equal(res.data.error.code, 'ADAPTER_PARSE_FAILED')
  assert.ok(Array.isArray(res.data.error.detail?.attempts), '必须列出试过的每个地址')
  assert.equal(res.data.error.detail.attempts.length, 2)
  assert.match(res.data.error.detail.attempts[0].url, /^https:\/\/api\.github\.com\//)
  assert.match(res.data.error.detail.attempts[1].url, /releases\.atom$/)
  assert.equal(res.data.error.detail.attempts[0].code, 'ADAPTER_PARSE_FAILED')
})

test('POST /sources/test 抓取失败时返回 ok:false + 可读错误，而不是 500', async () => {
  const app = makeApp({ gateway: fakeGateway(['<html>not a feed</html>']) })
  const res = await call(app, `${ROUTE_PREFIX}/sources/test`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  assert.equal(res.status, 200, '试抓的失败是"这个来源现在不能用"，不是接口错误')
  assert.equal(res.data.ok, false)
  assert.equal(res.data.error.code, 'ADAPTER_PARSE_FAILED')
})

// ---------------------------------------------------------------- 刷新与变化

test('首次刷新是基线：建立快照，但不产生变化记录', async () => {
  const app = makeApp({ gateway: fakeGateway([atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])]) })
  await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  const res = await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  assert.equal(res.status, 200)
  assert.equal(res.data.summary.total, 1)
  assert.equal(res.data.summary.succeeded, 1)
  assert.equal(app.store.counts().snapshots, 1)
  assert.equal(app.store.counts().changes, 0, '首次抓取只建基线')

  const state = await call(app, `${ROUTE_PREFIX}/state`)
  assert.equal(state.data.storage.lastRefreshAt, '2026-01-01T00:00:01.000Z')
})

test('第二轮内容变化产生变化记录，且能按状态筛选与翻页', async () => {
  const first = atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])
  const second = atomFeed([
    { id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' },
    { id: 'b', title: 'v2', updated: '2026-01-03T00:00:00Z' },
  ])
  const app = makeApp({ gateway: fakeGateway([first, second]) })
  await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })

  const list = await call(app, `${ROUTE_PREFIX}/changes`)
  assert.equal(list.status, 200)
  assert.equal(list.data.total, 1)
  assert.equal(list.data.items[0].kind, 'added')
  assert.equal(list.data.items[0].status, 'unread')
  assert.equal(list.data.items[0].sourceName, 'o/r')
  assert.ok(list.data.items[0].sourceUrl, '变化要带可点开的原文地址')

  const unread = await call(app, `${ROUTE_PREFIX}/changes?status=unread`)
  assert.equal(unread.data.total, 1)
  const seen = await call(app, `${ROUTE_PREFIX}/changes?status=seen`)
  assert.equal(seen.data.total, 0)

  const paged = await call(app, `${ROUTE_PREFIX}/changes?limit=1&offset=0`)
  assert.equal(paged.data.limit, 1)
})

test('GET /changes/:id 返回前后快照；未知 id 是 404', async () => {
  const first = atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z', body: 'old' }])
  const second = atomFeed([
    { id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z', body: 'old' },
    { id: 'b', title: 'v2', updated: '2026-01-03T00:00:00Z' },
  ])
  const app = makeApp({ gateway: fakeGateway([first, second]) })
  await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })

  const list = await call(app, `${ROUTE_PREFIX}/changes`)
  const id = list.data.items[0].id
  const detail = await call(app, `${ROUTE_PREFIX}/changes/${id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.data.change.id, id)
  assert.ok(detail.data.snapshot, '要能给出本轮快照作为原始证据')

  const missing = await call(app, `${ROUTE_PREFIX}/changes/nope`)
  assert.equal(missing.status, 404)
})

test('PATCH /changes/:id 只允许 status 与 userNote', async () => {
  const first = atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])
  const second = atomFeed([
    { id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' },
    { id: 'b', title: 'v2', updated: '2026-01-03T00:00:00Z' },
  ])
  const app = makeApp({ gateway: fakeGateway([first, second]) })
  await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  const id = (await call(app, `${ROUTE_PREFIX}/changes`)).data.items[0].id

  const ok = await call(app, `${ROUTE_PREFIX}/changes/${id}`, { method: 'PATCH', body: { status: 'ignored' } })
  assert.equal(ok.status, 200)
  assert.equal(ok.data.status, 'ignored')

  const bad = await call(app, `${ROUTE_PREFIX}/changes/${id}`, { method: 'PATCH', body: { kind: 'added' } })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'FIELD_NOT_WRITABLE')

  const invalid = await call(app, `${ROUTE_PREFIX}/changes/${id}`, { method: 'PATCH', body: { status: 'unheard-of' } })
  assert.equal(invalid.status, 400)
})

// ---------------------------------------------------------------- 机会池

test('机会池：创建 / 更新 / 删除，删除后对应变化回到未读', async () => {
  const first = atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])
  const second = atomFeed([
    { id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' },
    { id: 'b', title: 'v2', updated: '2026-01-03T00:00:00Z' },
  ])
  const app = makeApp({ gateway: fakeGateway([first, second]) })
  await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  const changeId = (await call(app, `${ROUTE_PREFIX}/changes`)).data.items[0].id

  const noTitle = await call(app, `${ROUTE_PREFIX}/opportunities`, { method: 'POST', body: {} })
  assert.equal(noTitle.status, 400)
  assert.equal(noTitle.body.error.code, 'VALIDATION_FAILED')

  const created = await call(app, `${ROUTE_PREFIX}/opportunities`, {
    method: 'POST',
    body: { title: '把发布说明接进竞品跟踪', changeId, judgment: '值得做' },
  })
  assert.equal(created.status, 200)
  assert.equal(created.data.status, 'to_research')
  assert.equal(created.data.changeId, changeId)

  const pooled = await call(app, `${ROUTE_PREFIX}/changes/${changeId}`)
  assert.equal(pooled.data.change.status, 'pooled', '已进池的变化不再在收件箱里催')

  const updated = await call(app, `${ROUTE_PREFIX}/opportunities/${created.data.id}`, {
    method: 'PATCH',
    body: { status: 'verifying', questions: ['真实用量有多少？'] },
  })
  assert.equal(updated.status, 200)
  assert.equal(updated.data.status, 'verifying')
  assert.deepEqual(updated.data.questions, ['真实用量有多少？'])

  const badStatus = await call(app, `${ROUTE_PREFIX}/opportunities/${created.data.id}`, {
    method: 'PATCH',
    body: { status: 'doing' },
  })
  assert.equal(badStatus.status, 400)

  const removed = await call(app, `${ROUTE_PREFIX}/opportunities/${created.data.id}`, { method: 'DELETE' })
  assert.equal(removed.status, 200)
  const restored = await call(app, `${ROUTE_PREFIX}/changes/${changeId}`)
  assert.equal(restored.data.change.status, 'unread', '机会删掉后变化要回到未读，而不是永远卡在 pooled')
})

test('GET /opportunities/:id：关联用真实 id，关联对象被清掉后如实标注而不是渲染空链接', async () => {
  const first = atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }])
  const second = atomFeed([
    { id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' },
    { id: 'b', title: 'v2', updated: '2026-01-03T00:00:00Z' },
  ])
  const app = makeApp({ gateway: fakeGateway([first, second]) })
  await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  const changeId = (await call(app, `${ROUTE_PREFIX}/changes`)).data.items[0].id

  const linked = await call(app, `${ROUTE_PREFIX}/opportunities`, {
    method: 'POST',
    body: { title: '从变化沉淀', changeId },
  })
  // 手工创建的机会：从来没有关联过任何抓取记录。
  const manual = await call(app, `${ROUTE_PREFIX}/opportunities`, {
    method: 'POST',
    body: { title: '手工记的一条', judgment: '自己想的' },
  })

  const detail = await call(app, `${ROUTE_PREFIX}/opportunities/${linked.data.id}`)
  assert.equal(detail.status, 200)
  assert.equal(detail.data.opportunity.id, linked.data.id)
  assert.equal(detail.data.change.id, changeId, '关联必须用真实 id，不能靠标题相同来认定')
  assert.equal(detail.data.source.name, 'o/r')
  assert.equal(detail.data.sourceMissing, false)

  const manualDetail = await call(app, `${ROUTE_PREFIX}/opportunities/${manual.data.id}`)
  assert.equal(manualDetail.status, 200)
  assert.equal(manualDetail.data.change, null)
  // 从来没有关联过 ≠ 关联对象不见了，这两句话对用户完全不是一回事。
  assert.equal(manualDetail.data.changeMissing, false)

  const missing = await call(app, `${ROUTE_PREFIX}/opportunities/opp_nope`)
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'NOT_FOUND')
  /*
   * 「找不到这条机会」而不是通用文案「找不到该接口」：接口是找到了，
   * 找不到的是那条记录。详情页据此才能告诉使用者"它可能已经被清理掉"，
   * 而不是让人以为插件装坏了。
   */
  assert.equal(missing.body.error.message, '找不到这条机会')
  assert.equal(missing.body.error.detail.id, 'opp_nope')

  // 清掉变化（保留机会）之后，机会上的 changeId 还在，但那条变化已经不存在了。
  await call(app, `${ROUTE_PREFIX}/maintenance/purge`, { method: 'POST', body: { confirm: true } })
  const orphan = await call(app, `${ROUTE_PREFIX}/opportunities/${linked.data.id}`)
  assert.equal(orphan.status, 200)
  assert.equal(orphan.data.change, null)
  assert.equal(orphan.data.changeMissing, true, '关联对象被删掉这件事必须能被界面知道')
})

test('记录不存在时说的是"找不到这条记录"，而不是"找不到该接口"', async () => {
  /*
   * 这两句话对使用者的含义完全不同：
   *   - 「找不到该接口」听起来像插件装坏了（接口都不在）；
   *   - 「找不到这条变化」说明接口是好的，只是这条记录没了 ——
   *     详情页据此才能给出"它可能已经被容量上限清理掉了"这个正确解释。
   * 真正的路径失配由 `matchRoute` 负责，文案是「没有这个接口：<METHOD> <path>」。
   */
  const app = makeApp()
  const cases = [
    ['GET', `${ROUTE_PREFIX}/changes/chg_nope`, '找不到这条变化'],
    ['PATCH', `${ROUTE_PREFIX}/changes/chg_nope`, '找不到这条变化'],
    ['GET', `${ROUTE_PREFIX}/snapshots/src_nope_mv_nope`, '找不到这条快照'],
    ['GET', `${ROUTE_PREFIX}/opportunities/opp_nope`, '找不到这条机会'],
    ['PATCH', `${ROUTE_PREFIX}/opportunities/opp_nope`, '找不到这条机会'],
    ['DELETE', `${ROUTE_PREFIX}/opportunities/opp_nope`, '找不到这条机会'],
    ['POST', `${ROUTE_PREFIX}/opportunities`, '找不到这条变化'],
  ]
  for (const [method, path, message] of cases) {
    const body =
      method === 'POST' ? { title: '从一条不存在的变化沉淀', changeId: 'chg_nope' } : method === 'GET' ? undefined : {}
    const res = await call(app, path, { method, body })
    assert.equal(res.status, 404, `${method} ${path} 应当是 404`)
    assert.equal(res.body.error.code, 'NOT_FOUND', `${method} ${path} 的码应当是 NOT_FOUND`)
    assert.equal(res.body.error.message, message, `${method} ${path} 的文案必须说清找不到的是什么`)
  }

  // 路径本身对不上时，仍然走另一套文案 —— 两者不能被混为一谈。
  const noRoute = await call(app, `${ROUTE_PREFIX}/nope`)
  assert.equal(noRoute.status, 404)
  assert.match(noRoute.body.error.message, /没有这个接口/)
})

test('GET /opportunities 支持按状态筛选', async () => {
  const app = makeApp()
  await call(app, `${ROUTE_PREFIX}/opportunities`, { method: 'POST', body: { title: 'A' } })
  await call(app, `${ROUTE_PREFIX}/opportunities`, { method: 'POST', body: { title: 'B', status: 'planned' } })
  const all = await call(app, `${ROUTE_PREFIX}/opportunities`)
  assert.equal(all.data.total, 2)
  const planned = await call(app, `${ROUTE_PREFIX}/opportunities?status=planned`)
  assert.equal(planned.data.total, 1)
  assert.equal(planned.data.items[0].title, 'B')
})

// ---------------------------------------------------------------- 清理

test('POST /maintenance/purge 需要显式 confirm', async () => {
  const app = makeApp()
  const refused = await call(app, `${ROUTE_PREFIX}/maintenance/purge`, { method: 'POST', body: {} })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'VALIDATION_FAILED')

  await call(app, `${ROUTE_PREFIX}/opportunities`, { method: 'POST', body: { title: 'A' } })
  const purged = await call(app, `${ROUTE_PREFIX}/maintenance/purge`, { method: 'POST', body: { confirm: true } })
  assert.equal(purged.status, 200)
  assert.equal(purged.data.purged, true)
  assert.equal(purged.data.counts.opportunities, 1, '默认不动机会池')
})

// ---------------------------------------------------------------- 请求体

test('readJsonBody：空体按 {} 处理', async () => {
  assert.deepEqual(await readJsonBody(streamOf([])), {})
  assert.deepEqual(await readJsonBody(streamOf(['   '])), {})
})

test('readJsonBody：合法对象、非法 JSON、非对象各自给出正确错误码', async () => {
  assert.deepEqual(await readJsonBody(streamOf(['{"a":1}'])), { a: 1 })

  await assert.rejects(() => readJsonBody(streamOf(['{oops'])), (error) => {
    assert.equal(error.code, 'BAD_REQUEST')
    assert.match(error.detail.reason, /合法 JSON/)
    return true
  })
  await assert.rejects(() => readJsonBody(streamOf(['[1,2]'])), (error) => {
    assert.equal(error.code, 'BAD_REQUEST')
    assert.match(error.detail.reason, /JSON 对象/)
    return true
  })
})

test('readJsonBody：超过上限时报 PAYLOAD_TOO_LARGE 且不读完', async () => {
  const huge = 'x'.repeat(70_000)
  await assert.rejects(() => readJsonBody(streamOf([huge])), (error) => error.code === 'PAYLOAD_TOO_LARGE')
})

test('请求体不是对象时返回 400 bad-json 信封', async () => {
  const app = makeApp()
  const res = fakeRes()
  await createHandler({
    getService: () => app.service,
    getRuntime: () => RUNTIME,
    now: () => 'T',
    readBody: async () => {
      throw Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_REQUEST' })
    },
  })(fakeReq(`${ROUTE_PREFIX}/sources`, { method: 'POST' }), res)
  assert.equal(res.status, 400)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'BAD_REQUEST')
})

// ---------------------------------------------------------------- 信封与响应头

test('响应头固定：JSON + no-store + nosniff + 正确的 content-length', async () => {
  const res = await call(makeApp(), `${ROUTE_PREFIX}/ping`)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  assert.equal(Number(res.headers['content-length']), Buffer.byteLength(res.raw))
})

test('成功信封恒为 {ok:true, data}，失败恒为 {ok:false, error:{code,message}}', async () => {
  const app = makeApp()
  const good = await call(app, `${ROUTE_PREFIX}/ping`)
  assert.deepEqual(Object.keys(good.body).sort(), ['data', 'ok'])
  const bad = await call(app, `${ROUTE_PREFIX}/nope`)
  assert.deepEqual(Object.keys(bad.body).sort(), ['error', 'ok'])
  assert.equal(typeof bad.body.error.message, 'string')
  assert.ok(bad.body.error.message.length > 0, '失败必须给出人能看懂的原因')
})

test('未分类的异常被兜成 500 INTERNAL，绝不逃成空响应体', async () => {
  const res = fakeRes()
  const handler = createHandler({
    getService: () => ({
      meta() {
        throw new TypeError('boom')
      },
    }),
    getRuntime: () => RUNTIME,
    now: () => 'T',
  })
  await handler(fakeReq(`${ROUTE_PREFIX}/meta`), res)
  assert.equal(res.status, 500)
  const parsed = JSON.parse(res.body)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.error.code, 'INTERNAL')
})

test('sendJson 对 undefined 字段不产生该键（线上格式干净）', () => {
  const res = fakeRes()
  sendJson(res, 200, { ok: true, missing: undefined })
  assert.deepEqual(JSON.parse(res.body), { ok: true })
})

test('所有 GET 路由都真实可答（不存在"文档里有、实现里没有"）', async () => {
  const app = makeApp()
  for (const route of ROUTES.filter((entry) => entry.method === 'GET')) {
    const path = route.path.replace(':id', 'nope')
    const res = await call(app, `${ROUTE_PREFIX}${path}`)
    assert.ok(res.status !== 404 || route.path.includes(':id'), `${path} 返回了 404`)
    assert.notEqual(res.status, 405, `${path} 方法不对`)
    // 原始响应（Markdown 导出）没有 JSON 信封，但**必须有**正确的 content-type。
    if (res.body === null) {
      assert.ok(
        String(res.contentType).startsWith('text/markdown'),
        `${path} 返回了非 JSON 响应，content-type 却是 ${res.contentType}`,
      )
    }
  }
})

test('创建路径也走字段白名单：拼错的字段必须当场报错，而不是静默丢掉', async () => {
  const app = makeApp()

  // 用户真实踩到过的形态：把「待验证问题」写成 openQuestions、「下一步」写成 nextStep。
  // 静默忽略会让接口返回 200 + 一条缺字段的记录 —— 那就是"假保存成功"。
  const typo = await call(app, `${ROUTE_PREFIX}/opportunities`, {
    method: 'POST',
    body: {
      title: '投放前的素材合规预检',
      openQuestions: ['封禁标准是否公开？'],
      nextStep: '找 3 个投放团队问',
    },
  })
  assert.equal(typo.status, 400)
  assert.equal(typo.body.error.code, 'FIELD_NOT_WRITABLE')
  assert.deepEqual(typo.body.error.detail.fields.sort(), ['nextStep', 'openQuestions'])
  assert.deepEqual(typo.body.error.detail.allowed.includes('questions'), true)

  // 正确字段名必须照旧写入
  const good = await call(app, `${ROUTE_PREFIX}/opportunities`, {
    method: 'POST',
    body: { title: '投放前的素材合规预检', questions: ['封禁标准是否公开？'], nextAction: '找 3 个投放团队问' },
  })
  assert.equal(good.status, 200)
  assert.deepEqual(good.body.data.questions, ['封禁标准是否公开？'])
  assert.equal(good.body.data.nextAction, '找 3 个投放团队问')

  // 来源创建同样要有白名单（`type` 是创建期字段）
  const badSource = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', feedUrl: 'https://techcrunch.com/feed/' },
  })
  assert.equal(badSource.status, 400)
  assert.equal(badSource.body.error.code, 'FIELD_NOT_WRITABLE')
  assert.deepEqual(badSource.body.error.detail.fields, ['feedUrl'])
})

test('摘要首尾不留空白：详情页不该先空一大段再出现正文', async () => {
  // 第一轮建立基线，第二轮多出一条带前后空白的条目 —— 只有非基线轮才会产生变化记录。
  const gateway = fakeGateway([
    atomFeed([{ id: 'a', title: '旧条目', updated: '2026-01-02T00:00:00Z' }]),
    atomFeed([
      { id: 'a', title: '旧条目', updated: '2026-01-02T00:00:00Z' },
      { id: 'b', title: '新条目', updated: '2026-01-03T00:00:00Z', body: '<p>&#9;&#9;</p>\n\n  真正的正文从这里开始  ' },
    ]),
  ])
  const app = makeApp({ gateway })
  await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://example.test/feed.xml' } },
  })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })
  await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: {} })

  const change = app.store.all('changes').find((entry) => entry.title === '新条目')
  assert.ok(change, '第二轮新增的条目应产生变化记录')
  assert.equal(change.excerpt, change.excerpt.trim(), `摘要首尾不能有空白，实际是 ${JSON.stringify(change.excerpt)}`)
  assert.ok(change.excerpt.startsWith('真正的正文'), `摘要应直接从正文开始，实际是 ${JSON.stringify(change.excerpt)}`)
})

// ---------------------------------------------------------------- P1-02 快照历史

test('快照历史：列表只给摘要不给全文，且链在列表尽头依然是真的', async () => {
  let t = 1_700_000_000_000
  const app = makeApp({
    // 时间必须真的往前走：快照 id 由 fetchedAt 派生，固定时间会让三份快照撞成同一个 id。
    now: () => (t += 60_000),
    gateway: fakeGateway([
      atomFeed([{ id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' }]),
      atomFeed([
        { id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' },
        { id: 'b', title: 'v2', updated: '2026-01-03T00:00:00Z' },
      ]),
      atomFeed([
        { id: 'a', title: 'v1', updated: '2026-01-02T00:00:00Z' },
        { id: 'b', title: 'v2', updated: '2026-01-03T00:00:00Z' },
        { id: 'c', title: 'v3', updated: '2026-01-04T00:00:00Z' },
      ]),
    ]),
  })
  const created = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  const id = created.data.id
  for (let i = 0; i < 3; i += 1) {
    await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: { sourceIds: [id] } })
  }
  assert.equal(app.store.counts().snapshots, 3, '三轮刷新应当留下三份快照')

  const res = await call(app, `${ROUTE_PREFIX}/sources/${id}/snapshots`)
  assert.equal(res.status, 200)
  assert.equal(res.data.total, 3)
  assert.equal(res.data.items.length, 3)
  assert.equal(res.data.source.id, id)

  // 列表绝不带全文：20 份快照各带 10 万字符正文会把一次请求变成数兆字节。
  for (const item of res.data.items) {
    assert.ok(!('normalizedText' in item), '列表不能带 normalizedText')
    assert.equal(item.retention, 'full')
    assert.ok(typeof item.excerpt === 'string')
  }

  // 差异是**算出来的**（集合差 + 指纹），不是 itemCount 相减 ——
  // 相减会把"删了 3 条又加了 3 条"说成"没变"。
  assert.equal(res.data.items[0].chain.added, 1)
  assert.equal(res.data.items[0].chain.removed, 0)
  assert.equal(res.data.items[0].itemCount, 3)
  assert.equal(res.data.items[1].chain.added, 1)
  assert.equal(res.data.items[1].chain.baseline, false)
  // 最旧的一份是基线，而且**即便它是列表最后一行也仍然知道自己是基线** ——
  // previous 取自被截断掉的那一份，链不会因为分页而凭空变成基线。
  assert.equal(res.data.items[2].chain.baseline, true)
  // 每份都真的挂着由它产生的变化记录。
  assert.equal(res.data.items[1].changeKinds.added, 1)
  assert.equal(res.data.items[1].changeIds.length, 1)
  assert.equal(res.data.items[2].changeIds.length, 0, '基线不产生变化记录')
})

test('快照历史：来源不存在时报 SOURCE_NOT_FOUND', async () => {
  const res = await call(makeApp(), `${ROUTE_PREFIX}/sources/src_nope/snapshots`)
  assert.equal(res.status, 404)
  assert.equal(res.body.error.code, 'SOURCE_NOT_FOUND')
})

test('快照详情：正文按查看上限裁切，并如实说明裁了多少', async () => {
  const app = makeApp()
  const long = 'x'.repeat(25_000)
  await app.store.put('snapshots', {
    id: 'snap_long',
    sourceId: 'src_x',
    fetchedAt: 1,
    normalizedText: long,
    textChars: long.length,
    itemCount: 0,
    itemIds: [],
    itemHashes: {},
    baseline: true,
    retention: 'full',
  })
  const res = await call(app, `${ROUTE_PREFIX}/snapshots/snap_long`)
  assert.equal(res.status, 200)
  assert.equal(res.data.snapshot.text.length, 20_000)
  assert.equal(res.data.snapshot.textTruncatedByView, true)
  assert.equal(res.data.snapshot.maxViewChars, 20_000)
  // 原始长度必须仍然可见，否则"裁过"这件事就无法核对。
  assert.equal(res.data.snapshot.textChars, 25_000)
  assert.deepEqual(res.data.changes, [])

  const missing = await call(app, `${ROUTE_PREFIX}/snapshots/snap_nope`)
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'NOT_FOUND')
})

test('旧快照被裁成摘录后明示 retention=excerpt，不靠 textTruncated 反推', async () => {
  // 全文保留上限是 2 份（MAX_FULL_TEXT_SNAPSHOTS），所以第 3 份（最旧的）会被压成摘录。
  // 正文必须真的超过 2000 字符，否则裁剪阶段按幂等规则不会动它。
  let t = 1_700_000_000_000
  const body = 'y'.repeat(3_000)
  const page = (n) =>
    atomFeed(Array.from({ length: n }, (_, i) => ({ id: `i${i}`, title: `t${i}`, updated: '2026-01-02T00:00:00Z', body })))
  const app = makeApp({ now: () => (t += 60_000), gateway: fakeGateway([page(1), page(2), page(3)]) })
  const created = await call(app, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'github_releases', config: { owner: 'o', repo: 'r' } },
  })
  const id = created.data.id
  for (let i = 0; i < 3; i += 1) {
    await call(app, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: { sourceIds: [id] } })
  }
  await app.service.applyTrim()

  const res = await call(app, `${ROUTE_PREFIX}/sources/${id}/snapshots`)
  assert.equal(res.data.items[0].retention, 'full')
  assert.equal(res.data.items[1].retention, 'full')
  assert.equal(res.data.items[2].retention, 'excerpt', '超过全文保留上限的旧快照必须明示只剩摘录')
  assert.equal(res.data.items[2].textTruncated, true)
  // 摘录状态下条目 id 与指纹仍然保留 —— 差异链在裁剪之后依然算得出来。
  assert.equal(res.data.items[2].chain.baseline, true)
  assert.ok(res.data.items[1].chain.added >= 1)
})

// ---------------------------------------------------------------- P1-05 机会池导出

test('导出 Markdown：走原始响应（不是 JSON 信封），并带下载文件名', async () => {
  const app = makeApp()

  // 池子空的也要能导出 —— 给一份能读的文件，而不是 0 字节或一个错误。
  const empty = await call(app, `${ROUTE_PREFIX}/export/opportunities`)
  assert.equal(empty.status, 200)
  assert.equal(empty.contentType, 'text/markdown; charset=utf-8')
  assert.match(empty.headers['content-disposition'], /^attachment; filename="ai-product-radar-opportunities-\d{8}-\d{4}\.md"$/)
  assert.equal(empty.body, null, '导出不能是 JSON 信封')
  assert.match(empty.raw, /^# AI 产品雷达 · 产品机会导出/)
  assert.match(empty.raw, /机会数量：0/)

  // 建两个真实来源、刷出真实变化（替身网关喂 Atom），再把其中一条变化沉淀成机会。
  const gateway = fakeGateway([atomFeed([{ id: 'a1', title: '第一条', body: '正文 A' }]), atomFeed([{ id: 'a1', title: '第一条', body: '正文 A' }, { id: 'a2', title: '第二条', body: '正文 B' }])])
  const app2 = makeApp({ gateway })
  const created = await call(app2, `${ROUTE_PREFIX}/sources`, {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://example.com/feed.xml' }, name: '示例源' },
  })
  assert.equal(created.status, 200)
  await call(app2, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: { sourceIds: [created.body.data.id] } })
  await call(app2, `${ROUTE_PREFIX}/refresh`, { method: 'POST', body: { sourceIds: [created.body.data.id] } })

  const changeId = app2.store.all('changes')[0].id
  const opp = await call(app2, `${ROUTE_PREFIX}/opportunities`, {
    method: 'POST',
    body: {
      title: '把「第二条」做成一个工具',
      changeId,
      judgment: '我认为值得做。',
      questions: ['谁会用？'],
      nextAction: '先问 3 个人。',
    },
  })
  assert.equal(opp.status, 200)

  const one = await call(app2, `${ROUTE_PREFIX}/export/opportunities?ids=${opp.body.data.id}`)
  assert.equal(one.status, 200)
  assert.equal(one.contentType, 'text/markdown; charset=utf-8')
  assert.match(one.headers['content-disposition'], new RegExp(`filename="ai-product-radar-${opp.body.data.id}\\.md"`))
  assert.match(one.raw, /### 事实（来自插件抓取并落盘的记录）/)
  assert.match(one.raw, /### 推测与判断（使用者自己写的，未经插件核实）/)
  assert.match(one.raw, /- 判断：我认为值得做。/)
  assert.match(one.raw, /- 来源地址：<https:\/\/example\.com\/feed\.xml>/)

  // 「全部导出」要把池子里的机会都带上。
  await call(app2, `${ROUTE_PREFIX}/opportunities`, { method: 'POST', body: { title: '第二条机会' } })
  const all = await call(app2, `${ROUTE_PREFIX}/export/opportunities`)
  assert.match(all.raw, /机会数量：2/)
  assert.match(all.raw, /没有关联任何一次抓取记录/)
})

test('导出：`?ids=` 里有一个找不到就整体失败，绝不给一份看起来完整的残缺文件', async () => {
  const app = makeApp()
  await call(app, `${ROUTE_PREFIX}/opportunities`, { method: 'POST', body: { title: '存在的一条' } })
  const id = app.store.all('opportunities')[0].id

  const partial = await call(app, `${ROUTE_PREFIX}/export/opportunities?ids=${id},opp_不存在`)
  assert.equal(partial.status, 404)
  assert.equal(partial.body.error.code, 'NOT_FOUND')
  assert.equal(partial.body.error.detail.id, 'opp_不存在')
})

test('导出是只读的：不改任何一张表，也不碰用户项目', async () => {
  const app = makeApp()
  await call(app, `${ROUTE_PREFIX}/opportunities`, { method: 'POST', body: { title: '一条机会', judgment: '判断', questions: ['问题'] } })

  const before = JSON.stringify({
    sources: app.store.all('sources'),
    snapshots: app.store.all('snapshots'),
    changes: app.store.all('changes'),
    opportunities: app.store.all('opportunities'),
  })
  const res = await call(app, `${ROUTE_PREFIX}/export/opportunities`)
  assert.equal(res.status, 200)
  const after = JSON.stringify({
    sources: app.store.all('sources'),
    snapshots: app.store.all('snapshots'),
    changes: app.store.all('changes'),
    opportunities: app.store.all('opportunities'),
  })
  assert.equal(after, before, '导出改动了存储')
})
