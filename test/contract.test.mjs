/**
 * T16 —— 路由契约（逐端点测入参校验与错误码）。
 *
 * 对应 `COMPATIBILITY.md` T16：
 * 「逐端点测入参校验与错误码 / 一律 `ok:false` 且不抛异常 / 字段级写权限生效」。
 *
 * ## 为什么单独写一个文件，而不是散在 route.test.mjs 里
 *
 * `route.test.mjs` 测的是**功能**（刷新、去重、差异、导出…）。这里测的是**契约**：
 * 每一条路由在**输入不合法**时都必须给出一致的形状。两者的失败方式不同 ——
 * 功能坏了是"结果不对"，契约坏了是"调用方拿到一个它看不懂的东西"。后者往往
 * 只在别人接入时才暴露，所以需要一张把**所有**端点点名过一遍的表。
 *
 * ## 三条硬规矩
 *
 * 1. **一律 `ok:false`，绝不抛异常。** 处理器是对外的边界；一个未捕获的异常会
 *    变成宿主上的未处理拒绝，调用方只会看到连接断掉，拿不到任何原因。
 * 2. **错误必须带 `code`。** 只有中文 `message` 的话，调用方无法分支处理。
 * 3. **写权限必须是字段级的。** 只认白名单、其余静默忽略的接口会把客户端的
 *    拼写错误变成"保存成功但内容丢了"—— 对一个用来记录判断的工具，这是最坏的
 *    失败形态（见 `SDD.md` §7.2 第 ⑦ 条）。
 *
 * ## 防漂移
 *
 * 最后一条用例断言"这张表覆盖了 `ROUTES` 里的每一条路由"。新增端点却忘了补
 * 契约测试，会直接让这套测试失败 —— 否则这张表会慢慢变成过期的装饰。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { ROUTES, matchRoute } from '../src/host/http.js'
import { atomFeed, call, fakeGateway, makeApp } from './helpers.mjs'

/**
 * 每条路由一个"最不合法但形状合法"的请求，以及期望的错误码。
 *
 * 期望值写死是**故意的**：如果哪天某个端点悄悄从 `SOURCE_NOT_FOUND` 变成
 * `INTERNAL`，那多半是上层把异常当成了未知错误吞掉，这正是要拦住的事。
 */
const BAD_INPUT = [
  { method: 'POST', path: '/sources', body: {}, status: 400, code: 'ADAPTER_CONFIG_INVALID' },
  { method: 'PATCH', path: '/sources/src_nope', body: { name: 'x' }, status: 404, code: 'SOURCE_NOT_FOUND' },
  { method: 'DELETE', path: '/sources/src_nope', status: 404, code: 'SOURCE_NOT_FOUND' },
  { method: 'POST', path: '/sources/test', body: {}, status: 400, code: 'ADAPTER_CONFIG_INVALID' },
  { method: 'GET', path: '/sources/src_nope/snapshots', status: 404, code: 'SOURCE_NOT_FOUND' },
  { method: 'GET', path: '/snapshots/snap_nope', status: 404, code: 'NOT_FOUND' },
  { method: 'GET', path: '/changes/chg_nope', status: 404, code: 'NOT_FOUND' },
  { method: 'PATCH', path: '/changes/chg_nope', body: { status: 'read' }, status: 404, code: 'NOT_FOUND' },
  { method: 'POST', path: '/opportunities', body: {}, status: 400, code: 'VALIDATION_FAILED' },
  { method: 'GET', path: '/opportunities/opp_nope', status: 404, code: 'NOT_FOUND' },
  { method: 'PATCH', path: '/opportunities/opp_nope', body: { title: 'x' }, status: 404, code: 'NOT_FOUND' },
  { method: 'DELETE', path: '/opportunities/opp_nope', status: 404, code: 'NOT_FOUND' },
  { method: 'POST', path: '/maintenance/purge', body: {}, status: 400, code: 'VALIDATION_FAILED' },
]

/** 不需要不合法输入就应当成功的路由。 */
const HAPPY = [
  { method: 'GET', path: '/ping' },
  { method: 'GET', path: '/meta' },
  { method: 'GET', path: '/state' },
  { method: 'GET', path: '/sources' },
  { method: 'POST', path: '/refresh', body: {} },
  { method: 'GET', path: '/changes' },
  { method: 'GET', path: '/opportunities' },
  { method: 'GET', path: '/templates' },
  { method: 'POST', path: '/maintenance/purge', body: { confirm: true } },
]

/** 走原始响应（不是 JSON 信封）的路由 —— 它们由单独一条用例覆盖。 */
const RAW_CARRIER = [{ method: 'GET', path: '/export/opportunities' }]

/** 造一个带一条真实变化的 app（复用真实的刷新链路，不注入假记录）。 */
async function appWithData() {
  const a = ['第一条', '第二条']
  const app = makeApp({ gateway: fakeGateway([atomFeed([{ id: 'a', title: a[0] }]), atomFeed([{ id: 'a', title: a[0] }, { id: 'b', title: a[1] }])]) })
  const created = await call(app, '/apradar/sources', {
    method: 'POST',
    body: { type: 'rss_atom', config: { feedUrl: 'https://example.com/feed.xml' } },
  })
  assert.equal(created.body.ok, true, '前置条件：来源必须能建出来')
  await call(app, '/apradar/refresh', { method: 'POST', body: { sourceIds: [created.body.data.id] } })
  await call(app, '/apradar/refresh', { method: 'POST', body: { sourceIds: [created.body.data.id] } })
  const changes = await call(app, '/apradar/changes')
  const change = changes.body.data.items[0]
  assert.ok(change, '前置条件：两轮不同内容必须产出至少一条变化')
  const opp = await call(app, '/apradar/opportunities', { method: 'POST', body: { title: '一个真实机会' } })
  assert.equal(opp.body.ok, true, '前置条件：机会必须能建出来')
  return { app, sourceId: created.body.data.id, changeId: change.id, opportunityId: opp.body.data.id }
}

test('T16：每一条路由在输入不合法时都返回 ok:false、带 code，且处理器从不抛异常', async () => {
  const app = makeApp()
  for (const probe of BAD_INPUT) {
    const res = await call(app, `/apradar${probe.path}`, { method: probe.method, body: probe.body })
    const label = `${probe.method} ${probe.path}`
    assert.equal(res.status, probe.status, `${label} 的 HTTP 状态码`)
    assert.equal(res.body?.ok, false, `${label} 必须是 ok:false`)
    // 只有中文 message 的话调用方无法分支 —— code 是契约的一部分。
    assert.equal(res.body?.error?.code, probe.code, `${label} 的错误码`)
    assert.equal(typeof res.body?.error?.message, 'string', `${label} 必须带可读的 message`)
    assert.notEqual(res.body.error.message, '', `${label} 的 message 不能是空串`)
  }
})

test('T16：不需要输入的端点一律成功，且返回的是 JSON 信封', async () => {
  const app = makeApp()
  for (const probe of HAPPY) {
    const res = await call(app, `/apradar${probe.path}`, { method: probe.method, body: probe.body })
    const label = `${probe.method} ${probe.path}`
    assert.equal(res.status, 200, `${label} 的状态码`)
    assert.equal(res.body?.ok, true, `${label} 必须是 ok:true`)
    assert.match(res.contentType, /^application\/json/, `${label} 必须是 JSON 载体`)
  }
})

test('T16：未知路径 404 / 方法不符 405，两者都是信封而不是空响应', async () => {
  const app = makeApp()
  const missing = await call(app, '/apradar/没有这个接口')
  assert.equal(missing.status, 404)
  assert.equal(missing.body.error.code, 'NOT_FOUND')
  // detail 里带上路由，便于用户把地址抄给我们排查。
  // 注意回显的是 URL 里的**原始（百分号编码）**路径：这是浏览器实际请求的那串
  // 字符，原样回显才不会在"编码与否"上产生新的歧义。
  assert.equal(missing.body.error.detail.route, encodeURI('/没有这个接口'))

  // `/ping` 实现的是 GET；用 DELETE 打它必须得到 405 而不是 404 ——
  // 两者的排查方向完全不同（"地址写错了" vs "方法用错了"）。
  const wrongMethod = await call(app, '/apradar/ping', { method: 'DELETE' })
  assert.equal(wrongMethod.status, 405)
  assert.equal(wrongMethod.body.error.code, 'METHOD_NOT_ALLOWED')
})

test('T16：非回环地址一律 403，且在解析请求体之前就拒绝', async () => {
  const app = makeApp()
  const res = await call(app, '/apradar/sources', { method: 'POST', body: { type: 'rss_atom' }, address: '10.1.2.3' })
  assert.equal(res.status, 403)
  assert.equal(res.body.error.code, 'LOOPBACK_ONLY')
})

test('T16：三条 PATCH 路由的写权限必须是字段级的（多余字段当场报错，不静默丢弃）', async () => {
  const { app, sourceId, changeId, opportunityId } = await appWithData()

  const cases = [
    { path: `/sources/${sourceId}`, field: 'feedUrl', allowed: 'config' },
    { path: `/changes/${changeId}`, field: 'title', allowed: 'status' },
    { path: `/opportunities/${opportunityId}`, field: 'summary', allowed: 'title' },
  ]

  for (const probe of cases) {
    const res = await call(app, `/apradar${probe.path}`, { method: 'PATCH', body: { [probe.field]: '随便什么' } })
    const label = `PATCH ${probe.path} 带 ${probe.field}`
    assert.equal(res.status, 400, label)
    assert.equal(res.body.error.code, 'FIELD_NOT_WRITABLE', label)
    // 光说"这个字段不能写"不够 —— 必须同时告诉他哪些能写，否则调用方只能去读源码。
    assert.deepEqual(res.body.error.detail.fields, [probe.field], `${label} 要指出是哪个字段`)
    assert.ok(
      res.body.error.detail.allowed.includes(probe.allowed),
      `${label} 的 allowed 必须包含一个真实可写字段（实际：${JSON.stringify(res.body.error.detail.allowed)}）`,
    )
  }

  // 反例：合法字段必须真的写进去 —— 否则上面的 400 可能只是"所有 PATCH 都坏了"。
  const okPatch = await call(app, `/apradar/opportunities/${opportunityId}`, { method: 'PATCH', body: { judgment: '我认为值得做' } })
  assert.equal(okPatch.body.ok, true)
  assert.equal(okPatch.body.data.judgment, '我认为值得做')
})

test('T16：Markdown 导出走原始响应载体，不是 JSON 信封', async () => {
  const app = makeApp()
  const res = await call(app, '/apradar/export/opportunities')
  assert.equal(res.status, 200)
  // 空池也必须是可读的文件，而不是空体。
  assert.match(res.contentType, /^text\/markdown/)
  assert.match(res.raw, /^# AI 产品雷达/)
  // 走原始载体的响应**不能**同时长得像信封，否则调用方无法区分两种载体。
  assert.equal(res.body, null)
})

test('T16：这张契约表必须覆盖 ROUTES 里的每一条路由（防漂移）', () => {
  // 不靠字符串拼 `:id` —— 那等于把路由表的形状又抄了一遍。直接问路由器：
  // "这条请求会被哪条路由接走"。这样表里写具体 id 也能对上模式。
  const covered = new Set()
  for (const probe of [...BAD_INPUT, ...HAPPY, ...RAW_CARRIER]) {
    const matched = matchRoute(probe.method, probe.path)
    assert.ok(matched?.route, `契约表里的 ${probe.method} ${probe.path} 没有匹配到任何路由`)
    covered.add(`${matched.route.method} ${matched.route.path}`)
  }

  const declared = ROUTES.map((route) => `${route.method} ${route.path}`)
  const missing = declared.filter((key) => !covered.has(key))
  assert.deepEqual(
    missing,
    [],
    `有 ${missing.length} 条路由没有契约测试：${missing.join('、')}。新增端点时请同时补上它的输入校验用例。`,
  )
  const extra = [...covered].filter((key) => !declared.includes(key))
  assert.deepEqual(extra, [], `契约表里有已不存在的路由：${extra.join('、')}`)
})
