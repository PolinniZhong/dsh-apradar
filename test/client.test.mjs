/**
 * Client 半边回归测试。
 *
 * 这里**不**依赖真实 React：本插件运行在宿主的模块装载器里，`react` 由装载器
 * 提供，工程目录下并没有这个依赖。所以在测试里注入一个最小渲染器 —— 它实现
 * `createElement` 与四个常用 Hook，并且**按组件实例**保存 Hook 状态、支持
 * `setState` 触发重渲染、渲染后执行 `useEffect`。够用的判据是：被测代码是
 * 真实的那份 `src/client/client.js`，走的是真实的 Hook 调用序列。
 *
 * 覆盖四件事，都是"改坏了会静默出错"的类型：
 *
 *   1. **注册形态**：四处注册点必须与 Knit 同形；会话头部入口按钮只能作为
 *      位置参数传入，options 里不能有 `component` —— 这一条来自真实事故
 *      （见 `TECH-SPIKE.md` §6.5），写错会把整个面板渲染进会话头部。
 *   2. **接口漂移**：把渲染过程中真实发出的每个 `/apradar/*` 请求喂给真实
 *      路由表 `matchRoute()`，确保没有拼错路径或方法 —— 客户端与服务端是
 *      两份独立手写的代码，漂移不会有编译错误。
 *   3. **视图骨架**：三个视图都要能渲染出来，且切换页签会真的去取数据。
 *   4. **诚实性**：存储不可用时必须显示失败原因，而不是显示一个空列表让人
 *      以为"没有变化"。
 *
 * @module dsh-apradar/test/client
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchRoute, ROUTES, ROUTE_PREFIX } from '../src/host/http.js'

import { createRenderer, loadClient, SOURCE, CLIENT_PATH } from './client-harness.mjs'

// ------------------------------------------------------------------ 1. 注册形态

test('注册形态：四处注册点，且会话头部入口按钮不能把面板正文带进去', async () => {
  // 会话头部那一段：从 inject 起到下一次 register 调用结束。
  const start = SOURCE.indexOf("ctx.slots.inject('conversation.session.header.utilities'")
  assert.ok(start > 0, '必须注册会话头部入口按钮')
  const block = SOURCE.slice(start, SOURCE.indexOf('\n    }\n', start))
  // 去注释后再断言：注释里提 RadarBody 是允许的（事故说明就写在注释里）。
  const code = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.ok(!code.includes('RadarBody'), '会话头部席位不能传 RadarBody —— 会把整个面板渲染进主区')
  assert.ok(!code.includes('component:'), 'options 里不能写 component，组件只能走位置参数')
  assert.match(
    code,
    // 非贪婪：options 对象里有 `${KIND}` 这种模板字面量，所以不能用 `[^{}]*`
    // 限定花括号；退而求其次要求「`{…},` 之后紧跟 RadarEntryButton, )」。
    /ctx\.slots\.register\(\s*\{[\s\S]*?\},\s*RadarEntryButton,\s*\)/,
    '组件必须以第 2 个位置参数传入，且 options 对象里不能再塞别的东西',
  )

  // 右栏三处，key 必须都指向同一个 TAB_ID。
  assert.match(SOURCE, /tabs\.register\(\{[\s\S]*?id: TAB_ID,[\s\S]*?kind: KIND,/, '页签类型注册必须同时给 id 与 kind')
  assert.match(SOURCE, /slots\.register\(\{ name: 'sidebar\.right\.pane\.tab', key: TAB_ID \}, RadarBody\)/, '正文注册的 key 必须是 TAB_ID')
  assert.match(SOURCE, /slots\.register\(\{ name: 'sidebar\.right\.pane\.tab\.title', key: TAB_ID \}, RadarTitle\)/, '标题注册的 key 必须是 TAB_ID')

  // 标识符必须与 Spike 不同，否则两个插件会争同一个页签。
  const kind = SOURCE.match(/const KIND = '([^']+)'/)?.[1]
  const tabId = SOURCE.match(/const TAB_ID = '([^']+)'/)?.[1]
  assert.equal(kind, 'apradar')
  assert.equal(tabId, 'dsh-apradar:main')
  assert.notEqual(kind, 'apradar-spike')
})

test('客户端不引入任何第三方依赖，也不直接访问外部网络', async () => {
  assert.match(SOURCE, /const React = require\('react'\)/)
  const requires = [...SOURCE.matchAll(/require\(([^)]*)\)/g)].map((match) => match[1])
  assert.deepEqual(requires, ["'react'"], '客户端只能 require react')

  // 底座约束：所有出网都由宿主 `/apradar/*` 承担，客户端不得出现绝对网址。
  assert.ok(!/https?:\/\//.test(SOURCE.replace(/\/\*[\s\S]*?\*\//g, '')), '客户端源码里不应出现 http(s) 绝对地址')
})

// ------------------------------------------------------------------ 2. 视图骨架与接口漂移

test('三个视图都能渲染，且每个真实请求都命中真实路由（防客户端/服务端漂移）', async () => {
  const renderer = createRenderer()
  const requests = []
  const responder = ({ method, path }) => {
    requests.push({ method, path })
    const clean = path.split('?')[0]
    if (clean.endsWith('/meta')) {
      return {
        ok: true,
        data: {
          adapters: [
            { type: 'github_releases', label: 'GitHub Releases', summary: '按 owner/repo 读取发布记录', testable: true, fields: [{ key: 'owner', label: 'owner' }, { key: 'repo', label: 'repo' }], conditional: false },
            { type: 'rss_atom', label: 'RSS / Atom', summary: '抓取提要', testable: true, fields: [{ key: 'url', label: '地址' }], conditional: true },
          ],
          changeStatuses: ['unread', 'seen', 'ignored', 'pooled'],
          opportunityStatuses: ['to_research', 'verifying', 'planned', 'dropped'],
          storage: { ok: true, specMode: 'inline', reason: null },
          modelCallsInRefresh: 0,
        },
      }
    }
    if (clean.endsWith('/state')) {
      return { ok: true, data: { storage: { ok: true, specMode: 'inline', schemaVersion: 1, openCount: 3, firstOpenedAt: 1, lastOpenedAt: 2, lastRefreshAt: null } } }
    }
    if (clean.endsWith('/changes')) return { ok: true, data: { total: 1, offset: 0, limit: 20, items: [{ id: 'chg_1', sourceId: 'src_1', sourceName: '某来源', sourceType: 'rss_atom', sourceUrl: null, kind: 'added', diffSummary: '新增 1 条', title: '示例标题', discoveredAt: Date.now(), status: 'unread' }] } }
    if (clean.endsWith('/sources')) return { ok: true, data: { items: [{ id: 'src_1', name: '某来源', type: 'rss_atom', canonicalUrl: 'https://example.invalid/feed', enabled: true, status: 'ok', lastCheckedAt: 1, lastSuccessAt: 1, lastError: null, createdAt: 1 }] } }
    if (clean.endsWith('/templates')) return { ok: true, data: { items: [{ id: 'github_releases:o/r', type: 'github_releases', name: 'o/r', config: { owner: 'o', repo: 'r' }, note: '地址由插件拼接', verified: true }] } }
    if (clean.endsWith('/opportunities')) return { ok: true, data: { total: 0, offset: 0, limit: 100, items: [] } }
    return { ok: false, error: { code: 'NOT_FOUND', message: `测试替身没有为 ${method} ${clean} 准备响应` } }
  }

  const client = loadClient({ respond: responder })
  try {
    const mod = client.exports ?? client.exported
    // 拿不到 exports 就退化为直接对源码做静态契约检查，并在下面断言失败。
    assert.ok(mod, '客户端模块必须通过 __ModuleLoader__.load 导出 exports')

    // 真渲染：把 RadarBody 挂上去。
    const body = mod.__test?.RadarBody ?? null
    assert.ok(body, '客户端必须导出 __test.RadarBody 供回归测试渲染（仅在测试里使用）')

    let tree = await client.renderer.render(body, {})
    let text = client.renderer.textOf(tree)
    // 面板正文里**不该**再重复一遍产品名：右栏的页签 chip（`RadarTitle`）已经写着它，
    // 正文再写一遍既重复又白占一行高度。名字的存在性改由 RadarTitle 自己来证明。
    assert.ok(!text.includes('AI 产品雷达'), '面板正文不该重复产品名 —— 名字在右栏页签上')
    assert.ok(text.includes('变化') && text.includes('关注源') && text.includes('机会池'), '三个视图页签都必须在')

    const title = await client.renderer.render(mod.__test.RadarTitle, {})
    assert.ok(client.renderer.textOf(title).includes('AI 产品雷达'), '产品名必须在右栏页签上（否则界面上就没有名字了）')

    // 渲染过程中的请求：/meta 与 /state 至少各一次，且全部命中真实路由。
    assert.ok(client.requests.some((r) => r.path === '/apradar/meta'), '首屏必须读能力清单')
    assert.ok(client.requests.some((r) => r.path === '/apradar/state'), '首屏必须读存储状态')

    // 切到「关注源」
    const sourcesTab = client.renderer.findClickable(tree, (node, t) => t === '关注源')
    assert.ok(sourcesTab, '要有「关注源」页签按钮')
    sourcesTab.props.onClick()
    tree = await client.renderer.render(body, {})
    text = client.renderer.textOf(tree)
    assert.ok(client.requests.some((r) => r.path === '/apradar/sources'), '切到关注源必须去取来源列表')
    assert.ok(client.requests.some((r) => r.path === '/apradar/templates'), '切到关注源必须去取预置模板')

    // 切到「机会池」
    const oppsTab = client.renderer.findClickable(tree, (node, t) => t === '机会池')
    assert.ok(oppsTab, '要有「机会池」页签按钮')
    oppsTab.props.onClick()
    tree = await client.renderer.render(body, {})
    assert.ok(client.requests.some((r) => r.path.startsWith('/apradar/opportunities')), '切到机会池必须去取机会列表')

    // ***** 防漂移：每个真实发出的请求都要能被真实路由表接住 *****
    const known = new Set(ROUTES.map((route) => `${route.method} ${route.path}`))
    const unmatched = []
    for (const request of client.requests) {
      assert.ok(request.path.startsWith(ROUTE_PREFIX), `客户端只能请求 ${ROUTE_PREFIX} 前缀：${request.path}`)
      const path = request.path.slice(ROUTE_PREFIX.length).split('?')[0] || '/'
      const matched = matchRoute(request.method, path)
      if (!matched || matched.methodMismatch) unmatched.push(`${request.method} ${path}`)
    }
    assert.deepEqual(unmatched, [], `以下请求在真实路由表里没有对应项：\n  ${unmatched.join('\n  ')}\n已知路由：\n  ${[...known].join('\n  ')}`)
  } finally {
    client.restore()
  }
})

// ------------------------------------------------------------------ 3. 诚实性

test('存储不可用时不显示空列表，而是显示失败原因', async () => {
  const responder = ({ path }) => {
    const clean = path.split('?')[0]
    if (clean.endsWith('/meta')) return { ok: true, data: { adapters: [], changeStatuses: [], opportunityStatuses: [], storage: { ok: false, specMode: 'none', reason: '存储域不可写' }, modelCallsInRefresh: 0 } }
    if (clean.endsWith('/state')) return { ok: true, data: { storage: { ok: false, specMode: 'none', reason: '存储域不可写', schemaVersion: 0, openCount: 0, firstOpenedAt: null, lastOpenedAt: null, lastRefreshAt: null } } }
    if (clean.endsWith('/changes')) return { ok: true, data: { total: 0, offset: 0, limit: 20, items: [] } }
    return { ok: true, data: { items: [] } }
  }

  const client = loadClient({ respond: responder })
  try {
    const mod = client.exports ?? client.exported
    const body = mod.__test?.RadarBody
    assert.ok(body, '客户端必须导出 __test.RadarBody')
    const tree = await client.renderer.render(body, {})
    const text = client.renderer.textOf(tree)
    assert.ok(text.includes('存储不可用'), `存储失败时必须显式说明，实际渲染出：${text.slice(0, 200)}`)
    assert.ok(text.includes('存储域不可写'), '必须把宿主给的原因原样显示出来，不能只说"出错了"')
  } finally {
    client.restore()
  }
})

test('时间显示：宿主给的时间既有 epoch 毫秒也有 ISO 字符串，两种都必须显示出来', async () => {
  const client = loadClient({ respond: () => ({ ok: true, data: { items: [] } }) })
  try {
    const mod = client.exports ?? client.exported
    const { fmtTime, fmtAgo, orDash } = mod.__test ?? {}
    assert.ok(fmtTime && fmtAgo, '客户端必须导出 __test.fmtTime / fmtAgo 供回归测试')

    // 存储块用 ISO 字符串（宿主 /state 的真实形态）
    const iso = '2026-10-09T14:50:19.611Z'
    assert.ok(/^2026-10-09 \d{2}:\d{2}$/.test(fmtTime(iso)), `ISO 字符串必须能显示，实际 ${fmtTime(iso)}`)
    // 变化/来源记录用 epoch 毫秒
    const ms = Date.parse(iso)
    assert.equal(fmtTime(ms), fmtTime(iso), '两种形态必须归一到同一个显示结果')
    // 垃圾输入不能伪装成时间
    assert.equal(fmtTime('不是时间'), null)
    assert.equal(fmtTime(''), null)
    assert.equal(fmtTime(null), null)
    assert.equal(fmtTime(0), null)
    assert.equal(orDash(fmtTime('不是时间')), '—', '读不懂就显示破折号，而不是编一个时间')
    assert.equal(fmtAgo(Date.now() - 30 * 60 * 1000), '30 分钟前')
  } finally {
    client.restore()
  }
})

test('定时刷新：下一次到期时间只在真能确定时才给出', () => {
  const client = loadClient({ respond: () => ({ ok: true, data: { items: [] } }) })
  try {
    const { nextRunAt, INTERVAL_OPTIONS } = client.exported.__test ?? {}
    assert.ok(nextRunAt, '客户端必须导出 __test.nextRunAt')
    assert.ok(Array.isArray(INTERVAL_OPTIONS) && INTERVAL_OPTIONS.length > 0, '必须导出 __test.INTERVAL_OPTIONS')

    const last = Date.parse('2026-01-01T00:00:00.000Z')

    // ① 没开启定时 → 没有"下次"可言。
    assert.equal(nextRunAt({ intervalMinutes: 0, lastCheckedAt: last }), null)
    assert.equal(nextRunAt({ lastCheckedAt: last }), null, '缺失间隔按关闭处理，不能猜 15 分钟')
    assert.equal(nextRunAt({ intervalMinutes: -5, lastCheckedAt: last }), null)

    // ② 开启了但从未检查过 → 也不能报一个时刻：调度器下一秒就会抓它，
    //    报"下次在 X 点"是编造。界面这一分支显示「等待首次检查」。
    assert.equal(nextRunAt({ intervalMinutes: 15 }), null)
    assert.equal(nextRunAt({ intervalMinutes: 15, lastCheckedAt: null }), null)
    assert.equal(nextRunAt({ intervalMinutes: 15, lastCheckedAt: '不是时间' }), null)

    // ③ 正常：上次检查时刻 + 间隔；毫秒与 ISO 两种形态必须一致。
    assert.equal(nextRunAt({ intervalMinutes: 15, lastCheckedAt: last }), last + 15 * 60000)
    assert.equal(
      nextRunAt({ intervalMinutes: 15, lastCheckedAt: '2026-01-01T00:00:00.000Z' }),
      last + 15 * 60000,
      'ISO 与毫秒必须算出同一个到期时刻',
    )
    assert.equal(nextRunAt({ intervalMinutes: 1440, lastCheckedAt: last }), last + 1440 * 60000)

    // ④ 界面只能提供服务端会原样接受的档位 —— 否则用户选了 5 分钟却存成 15，
    //    下拉框显示的值与实际存储不一致，比刷新慢更糟。
    for (const opt of INTERVAL_OPTIONS) {
      assert.ok(
        opt.value === 0 || (opt.value >= 15 && opt.value <= 1440),
        `选项 ${opt.value} 会被服务端夹取，界面不该提供它`,
      )
    }
  } finally {
    client.restore()
  }
})

test('沉淀为产品机会必须带上 changeId：否则机会与变化两个方向都断链', async () => {
  // 真事故：这一处最初只发 title/projectRef/judgment，服务端据此建了一条
  // 「无来源」的机会，变化那边也没被标记入池 —— 两个方向都断了，而且界面上
  // 看不出断了（机会看起来只是"没填项目"）。服务端本来就支持 `changeId`，
  // 会同时回写 changeId 与 opportunityId，所以客户端必须发。
  const responder = ({ method, path, body }) => {
    const clean = path.split('?')[0]
    if (clean.endsWith('/meta')) {
      return { ok: true, data: { adapters: [], changeStatuses: ['unread', 'pooled'], opportunityStatuses: ['to_research'], storage: { ok: true, specMode: 'inline', reason: null }, modelCallsInRefresh: 0 } }
    }
    if (clean.endsWith('/state')) {
      return { ok: true, data: { storage: { ok: true, specMode: 'inline', schemaVersion: 1, openCount: 1, firstOpenedAt: null, lastOpenedAt: null, lastRefreshAt: null } } }
    }
    if (method === 'POST' && clean === `${ROUTE_PREFIX}/opportunities`) {
      return { ok: true, data: { id: 'opp_1', title: body.title } }
    }
    if (clean === `${ROUTE_PREFIX}/changes/chg_1`) {
      return {
        ok: true,
        data: {
          change: { id: 'chg_1', sourceId: 'src_1', sourceName: '某来源', sourceType: 'rss_atom', kind: 'added', diffSummary: '新增 1 条', title: '示例标题', discoveredAt: Date.now(), status: 'unread' },
          snapshot: null,
          previousSnapshot: null,
        },
      }
    }
    if (clean.endsWith('/changes')) {
      return { ok: true, data: { total: 1, offset: 0, limit: 20, items: [{ id: 'chg_1', sourceId: 'src_1', sourceName: '某来源', sourceType: 'rss_atom', sourceUrl: null, kind: 'added', diffSummary: '新增 1 条', title: '示例标题', discoveredAt: Date.now(), status: 'unread' }] } }
    }
    return { ok: true, data: { items: [] } }
  }

  const client = loadClient({ respond: responder })
  try {
    const mod = client.exports ?? client.exported
    const body = mod.__test?.RadarBody
    assert.ok(body, '客户端必须导出 __test.RadarBody')

    // ① 渲染收件箱
    let tree = await client.renderer.render(body, {})

    // ② 打开那条变化的详情
    const row = client.renderer.findClickable(tree, (_node, text) => text.includes('示例标题') && text.includes('新增 1 条'))
    assert.ok(row, '收件箱里必须能点开一条变化')
    row.props.onClick()
    tree = await client.renderer.render(body, {})

    // ③ 点「沉淀为产品机会」
    const pool = client.renderer.findClickable(tree, (_node, text) => text === '沉淀为产品机会')
    assert.ok(pool, `详情里必须有「沉淀为产品机会」，实际渲染出：${client.renderer.textOf(tree).slice(0, 300)}`)
    pool.props.onClick()
    await client.renderer.render(body, {})

    // ④ 断言请求体里带了 changeId
    const created = client.requests.find((r) => r.method === 'POST' && r.path === `${ROUTE_PREFIX}/opportunities`)
    assert.ok(created, '点击后必须真的发一次创建机会的请求')
    assert.equal(created.body.changeId, 'chg_1', '不带 changeId 就会建出一条和变化无关联的机会')
  } finally {
    client.restore()
  }
})

// ---------------------------------------------------------------- P1-02 快照历史

test('快照历史行：基线、增量与"仅保留摘录"都必须说出来', async () => {
  const client = loadClient({ respond: () => ({ ok: true, data: {} }) })
  try {
    const { SnapshotRow } = client.exported.__test
    const { createElement } = client.renderer.React
    const textOf = client.renderer.textOf

    const base = {
      id: 'src_1_mv1',
      fetchedAt: Date.UTC(2026, 0, 2, 3, 4, 5),
      itemCount: 7,
      retention: 'excerpt',
      truncated: false,
      chain: { baseline: false, added: 2, removed: 1, modified: 3, itemCount: 7, capped: false },
      changeIds: ['chg_1', 'chg_2'],
    }

    const text = textOf(await client.renderer.render(SnapshotRow, { snap: base }))
    assert.match(text, /仅保留摘录/, '被裁成摘录的快照必须明示，不能让用户以为是全文')
    assert.match(text, /\+2 新增/)
    assert.match(text, /−1 移除/)
    assert.match(text, /~3 修改/)
    assert.match(text, /关联 2 条变化记录/)

    // 基线不能显示成"0 新增 0 移除" —— 那会让人以为"抓到了、但内容没变化"。
    const baselineText = textOf(
      await client.renderer.render(SnapshotRow, {
        snap: { ...base, retention: 'full', chain: { baseline: true, added: 0, removed: 0, modified: 0, itemCount: 7, capped: false } },
      }),
    )
    assert.match(baselineText, /基线/)
    assert.ok(!baselineText.includes('0 新增'), '基线不能说成"0 新增"')

    // 条目数超过记录上限时必须标注为下限，不能把"至少 500 条"说成精确值。
    const cappedText = textOf(
      await client.renderer.render(SnapshotRow, {
        snap: { ...base, chain: { baseline: false, added: 0, removed: 0, modified: 0, itemCount: 900, capped: true } },
      }),
    )
    assert.match(cappedText, /下限/)
    assert.match(cappedText, /条目没有变化/)
  } finally {
    client.restore()
  }
})
