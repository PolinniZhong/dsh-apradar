/**
 * P0「详情页与跨视图操作闭环」的回归测试。
 *
 * 这一轮补的不是新端点，而是**把已经实现的后端能力真正交到用户手上**：
 * 三个视图各自从「只有列表」变成「列表 ↔ 页面内详情」，并且详情之间能互相跳。
 * 所以这里测的是交互契约，不是数据形状 —— 数据形状由 `route.test.mjs` 守着。
 *
 * 十项对应任务书第六节的十类要求：
 *
 *   ① 变化列表打开详情与返回（含滚动位置恢复）
 *   ② 详情数据不存在、服务报错、关联快照不存在
 *   ③ 有基线 / 无基线 / 已截断 / 仅有摘录的差异展示
 *   ④ 修改状态与备注后的持久化（成功才显示成功，失败保留输入）
 *   ⑤ 来源详情、快照历史加载与读取失败
 *   ⑥ 机会详情编辑与保存失败
 *   ⑦ 变化与机会双向跳转（必须用真实 id）
 *   ⑧ 已删除来源或变化的引用处理
 *   ⑨ 列表筛选、分页与滚动位置恢复
 *   ⑩ 键盘可达性（真的 `<button>` / `<label>`）与窄侧栏不横向溢出
 *
 * ## 这套替身能证明什么、不能证明什么
 *
 * 能：真实的 `src/client/client.js`、真实的 Hook 调用序列、真实的请求路径与
 * 请求体、真实的 `nav` 状态机（含滚动位置的存取）。
 *
 * 不能：**布局**。替身没有 CSS 引擎，`scrollTop` 是一个可写数字而不是真实滚动；
 * 窄侧栏会不会横向溢出、焦点环长什么样、深浅色下的对比度，这些必须在真实浏览器
 * 里用 CDP 量。`TECH-SPIKE.md` §6.14 记录了那一次实测的数字与阻塞项，
 * 这份测试**不**替代它。
 *
 * @module dsh-apradar/test/detail
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ROUTE_PREFIX } from '../src/host/http.js'
import { loadClient } from './client-harness.mjs'

// ------------------------------------------------------------------ 固定数据

const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
const HOUR = 3600 * 1000

const LIMITS = {
  maxDiffItems: 200,
  maxSnapshotsPerSource: 20,
  maxFullTextSnapshots: 2,
  maxOldSnapshotChars: 2000,
  pageSizeDefault: 50,
}

const META = {
  adapters: [{ type: 'rss_atom', label: 'RSS/Atom', fields: [{ key: 'feedUrl', label: '订阅地址', required: true, default: '' }] }],
  changeStatuses: ['unread', 'seen', 'ignored', 'pooled'],
  opportunityStatuses: ['to_research', 'verifying', 'planned', 'dropped'],
  storage: { ok: true, specMode: 'inline', reason: null },
  modelCallsInRefresh: 0,
  limits: LIMITS,
}

const STATE = {
  storage: { ok: true, specMode: 'inline', schemaVersion: 1, openCount: 3, firstOpenedAt: T0, lastOpenedAt: T0, lastRefreshAt: null },
}

function changeRow(over = {}) {
  return {
    id: 'chg_1',
    sourceId: 'src_1',
    sourceName: '某来源',
    sourceType: 'rss_atom',
    sourceUrl: 'https://example.invalid/feed',
    itemUrl: 'https://example.invalid/item/1',
    kind: 'added',
    diffSummary: '新增：示例标题',
    title: '示例标题',
    discoveredAt: T0,
    publishedAt: null,
    status: 'unread',
    userNote: '',
    opportunityId: null,
    excerpt: '这是来源里的原文摘录。',
    truncated: false,
    diffDetail: { added: [], removed: [], modified: [] },
    ...over,
  }
}

function sourceRow(over = {}) {
  return {
    id: 'src_1',
    name: '某来源',
    type: 'rss_atom',
    canonicalUrl: 'https://example.invalid/feed',
    enabled: true,
    intervalMinutes: 60,
    status: 'ok',
    lastCheckedAt: T0,
    lastSuccessAt: T0,
    failureStreak: 0,
    lastError: null,
    autoDisabledAt: null,
    autoDisabledReason: null,
    config: { feedUrl: 'https://example.invalid/feed' },
    createdAt: T0,
    ...over,
  }
}

function oppRow(over = {}) {
  return {
    id: 'opp_1',
    title: '示例机会',
    changeId: 'chg_1',
    sourceId: 'src_1',
    projectRef: 'https://example.invalid/item/1',
    judgment: '这条变化可能意味着一个机会。',
    questions: ['谁已经在做这件事？'],
    nextAction: '下周做一次用户访谈',
    status: 'to_research',
    createdAt: T0,
    updatedAt: T0,
    ...over,
  }
}

function snapshotRow(over = {}) {
  return {
    id: 'src_1_mv2',
    fetchedAt: T0,
    itemCount: 10,
    retention: 'full',
    truncated: false,
    chain: { baseline: false, added: 1, removed: 0, modified: 0, itemCount: 10, capped: false },
    changeIds: [],
    ...over,
  }
}

/**
 * 装一个把所有端点都答上的替身，测试只覆盖自己关心的那一两个。
 *
 * 表的键是 `METHOD /path`（不含查询串），与真实路由表的写法一致 ——
 * 这样"客户端请求了一个不存在的端点"会以 `NOT_FOUND` 暴露出来，而不是被
 * 一个宽容的默认分支吞掉。
 */
function makeClient(overrides = {}) {
  const table = {
    [`GET ${ROUTE_PREFIX}/meta`]: () => ({ ok: true, data: META }),
    [`GET ${ROUTE_PREFIX}/state`]: () => ({ ok: true, data: STATE }),
    [`GET ${ROUTE_PREFIX}/changes`]: ({ query }) => ({
      ok: true,
      data: {
        total: Number(query.total ?? 1),
        offset: Number(query.offset ?? 0),
        limit: Number(query.limit ?? 20),
        items: [changeRow()],
      },
    }),
    [`GET ${ROUTE_PREFIX}/changes/chg_1`]: () => ({
      ok: true,
      data: {
        change: changeRow(),
        source: sourceRow(),
        snapshot: snapshotRow(),
        previousSnapshot: snapshotRow({ id: 'src_1_mv1', fetchedAt: T0 - HOUR }),
      },
    }),
    [`PATCH ${ROUTE_PREFIX}/changes/chg_1`]: ({ body }) => ({ ok: true, data: changeRow(body) }),
    [`GET ${ROUTE_PREFIX}/sources`]: () => ({ ok: true, data: { items: [sourceRow()] } }),
    [`GET ${ROUTE_PREFIX}/sources/src_1/snapshots`]: () => ({ ok: true, data: { total: 1, items: [snapshotRow()] } }),
    [`PATCH ${ROUTE_PREFIX}/sources/src_1`]: ({ body }) => ({ ok: true, data: sourceRow(body) }),
    [`DELETE ${ROUTE_PREFIX}/sources/src_1`]: () => ({ ok: true, data: { deleted: true, removedSnapshots: 3, removedChanges: 2 } }),
    [`POST ${ROUTE_PREFIX}/refresh`]: () => ({ ok: true, data: { results: [{ sourceId: 'src_1', name: '某来源', ok: true, newChanges: 2 }] } }),
    [`GET ${ROUTE_PREFIX}/templates`]: () => ({ ok: true, data: { items: [] } }),
    [`GET ${ROUTE_PREFIX}/opportunities`]: ({ query }) => ({
      ok: true,
      data: {
        total: Number(query.total ?? 1),
        offset: Number(query.offset ?? 0),
        limit: Number(query.limit ?? 20),
        items: [oppRow()],
      },
    }),
    [`GET ${ROUTE_PREFIX}/opportunities/opp_1`]: () => ({
      ok: true,
      data: {
        opportunity: oppRow(),
        change: changeRow({ opportunityId: 'opp_1', status: 'pooled' }),
        changeMissing: false,
        source: { id: 'src_1', name: '某来源', type: 'rss_atom', canonicalUrl: 'https://example.invalid/feed' },
        sourceMissing: false,
      },
    }),
    [`PATCH ${ROUTE_PREFIX}/opportunities/opp_1`]: ({ body }) => ({ ok: true, data: oppRow(body) }),
    [`DELETE ${ROUTE_PREFIX}/opportunities/opp_1`]: () => ({ ok: true, data: { deleted: true } }),
    [`POST ${ROUTE_PREFIX}/opportunities`]: ({ body }) => ({ ok: true, data: oppRow({ ...body, id: 'opp_new' }) }),
    ...overrides,
  }

  return loadClient({
    respond: ({ method, path, body }) => {
      const [clean, search = ''] = String(path).split('?')
      const query = Object.fromEntries(new URLSearchParams(search))
      const handler = table[`${method} ${clean}`]
      if (!handler) return { ok: false, error: { code: 'NOT_FOUND', message: `测试替身没有为 ${method} ${clean} 准备响应` } }
      return handler({ method, path: clean, query, body })
    },
  })
}

/** 面板正文那个滚动容器（`RadarPane` 里唯一的滚动宿主）。 */
function findBody(renderer, tree) {
  return renderer.find(tree, (node) => node.props?.className === 'apr-body')
}

/** 按 `aria-label` 找控件。 */
function byLabel(renderer, tree, label) {
  return renderer.find(tree, (node) => node.props?.['aria-label'] === label)
}

/** 点击一个按文案找到的可点击元素。 */
function click(renderer, tree, predicate) {
  const node = renderer.findClickable(tree, predicate)
  assert.ok(node, `找不到可点击元素：${predicate.toString()}`)
  node.props.onClick()
  return node
}

async function render(client, Component, props = {}) {
  return client.renderer.render(Component, props)
}

// ------------------------------------------------- ① 列表 → 详情 → 返回

test('① 变化列表 → 详情 → 返回：详情在页面内部打开，返回后滚动位置与列表状态都还在', async () => {
  const client = makeClient()
  try {
    const { PANE_BODIES } = client.exported.__test
    const R = client.renderer
    let tree = await render(client, PANE_BODIES.inbox)
    let text = R.textOf(tree)

    assert.ok(text.includes('本次显示第'), `列表要有分页与计数，实际渲染出：${text.slice(0, 240)}`)

    // 模拟用户把列表滚到 320。
    const body = findBody(R, tree)
    assert.ok(body && body.element, '面板正文必须是可滚动宿主元素 —— 否则滚动位置无从恢复')
    body.element.scrollTop = 320

    const row = R.findClickable(tree, (_node, t) => t.includes('示例标题'))
    assert.ok(row, '变化列表行必须是可点击的')
    assert.equal(row.tag, 'button', '行必须是真正的 <button>，否则键盘用户按不到它')
    assert.match(row.props['aria-label'] ?? '', /打开变化详情/, '行必须有可读的无障碍名字')
    row.props.onClick()
    tree = await render(client, PANE_BODIES.inbox)
    text = R.textOf(tree)

    assert.ok(
      client.requests.some((r) => r.path === `${ROUTE_PREFIX}/changes/chg_1`),
      '打开详情必须真的去读这条变化，而不是用列表里已有的那几行凑',
    )
    assert.ok(text.includes('‹ 返回变化列表'), '详情必须有明确的返回入口')
    assert.ok(!text.includes('本次显示第'), '详情打开时列表不该还在下面接着排 —— 那不是详情页，是列表末尾')
    assert.equal(findBody(R, tree).element.scrollTop, 0, '详情应该从顶部开始，而不是继承列表的滚动位置')

    click(R, tree, (_node, t) => t === '‹ 返回变化列表')
    tree = await render(client, PANE_BODIES.inbox)
    text = R.textOf(tree)

    assert.ok(text.includes('本次显示第'), '返回后必须回到列表')
    assert.equal(findBody(R, tree).element.scrollTop, 320, '返回后必须恢复离开列表时的滚动位置')
  } finally {
    client.restore()
  }
})

// ------------------------------------------------- ② 读不出来 / 不存在

test('② 详情服务报错、记录不存在、没有关联快照：三种都不是死胡同', async () => {
  // `loadClient()` 的返回值上没有 `__test`（它挂在导出的模块上），这里只是留个记号：
  // 真正的断言都在下面各自的客户端实例上。
  const placeholder = makeClient().__test ?? {}
  assert.equal(placeholder.PANE_BODIES, undefined, '占位：真正的断言在下面各自的客户端实例上')

  // (a) 服务端报错 —— 必须原样转述原因，并且仍然给得出返回与重试。
  const failing = makeClient({
    [`GET ${ROUTE_PREFIX}/changes/chg_1`]: () => ({ ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: '存储域不可写' } }),
  })
  try {
    const R = failing.renderer
    let tree = await render(failing, failing.exported.__test.PANE_BODIES.inbox)
    click(R, tree, (_node, t) => t.includes('示例标题'))
    tree = await render(failing, failing.exported.__test.PANE_BODIES.inbox)
    const text = R.textOf(tree)

    assert.match(text, /这条变化读不出来/, '必须明确说读不出来')
    assert.match(text, /存储域不可写/, '必须原样给出服务端的原因，不能只说"出错了"')
    assert.match(text, /STORAGE_UNAVAILABLE/, '错误码要留着 —— 用户报障时它才是可查的')
    assert.ok(text.includes('‹ 返回变化列表'), '读失败时返回入口同样要在，否则详情是死胡同')
    assert.ok(R.findClickable(tree, (_node, t) => t === '重试'), '要有重试')
  } finally {
    failing.restore()
  }

  // (b) 记录不存在（404）—— 说明"可能已被清理"，而不是渲染一堆 undefined。
  const missing = makeClient({
    [`GET ${ROUTE_PREFIX}/changes/chg_1`]: () => ({ ok: false, error: { code: 'NOT_FOUND', message: '没有这条变化：chg_1' } }),
  })
  try {
    const R = missing.renderer
    let tree = await render(missing, missing.exported.__test.PANE_BODIES.inbox)
    click(R, tree, (_node, t) => t.includes('示例标题'))
    tree = await render(missing, missing.exported.__test.PANE_BODIES.inbox)
    const text = R.textOf(tree)

    assert.match(text, /没有这条变化/, '记录不存在时要说清是哪条不存在')
    assert.match(text, /已经被清理/, '要给出"为什么它不见了"的最可能解释')
    assert.ok(text.includes('‹ 返回变化列表'))
  } finally {
    missing.restore()
  }

  // (c) 关联快照不存在 —— 快照与上一份都应显示为「—」，而不是 0 条或伪造时间。
  const noSnapshot = makeClient({
    [`GET ${ROUTE_PREFIX}/changes/chg_1`]: () => ({ ok: true, data: { change: changeRow(), source: sourceRow(), snapshot: null, previousSnapshot: null } }),
  })
  try {
    const R = noSnapshot.renderer
    const text = R.textOf(await render(noSnapshot, noSnapshot.exported.__test.ChangeDetail, { id: 'chg_1', meta: META }))
    assert.match(text, /首次抓取，没有可比较的上一版/, '没有上一份快照时必须明说，不能显示成"没有变化"')
    assert.ok(text.includes('—'), '快照缺失要显示占位符，不要显示 "0 条"（那会被读成"抓到了但没内容"）')
  } finally {
    noSnapshot.restore()
  }
})

// ------------------------------------------------- ③ 差异的四种情况

test('③ 差异展示：有基线 / 无基线 / 已截断 / 仅有摘录，四种不能混为一谈', async () => {
  const cases = [
    {
      name: '有基线且有真实差异',
      snap: { snapshot: snapshotRow(), previousSnapshot: snapshotRow({ id: 'src_1_mv1', fetchedAt: T0 - HOUR }) },
      change: { diffDetail: { added: ['新条目 A'], removed: ['旧条目 B'], modified: ['改动条目 C'] } },
      expect: [/\+ 新条目 A/, /- 旧条目 B/, /~ 改动条目 C/, /共 1 条新增 · 1 条移除 · 1 条修改/],
      reject: [/没有可比较的上一版/, /条目没有变化/],
    },
    {
      name: '没有上一份快照',
      snap: { snapshot: snapshotRow({ chain: { baseline: true, added: 0, removed: 0, modified: 0, itemCount: 10, capped: false } }), previousSnapshot: null },
      change: {},
      expect: [/没有可比较的上一版/],
      reject: [/条目没有变化/, /共 0 条新增/],
    },
    {
      name: '有基线但确实没有变化',
      snap: { snapshot: snapshotRow(), previousSnapshot: snapshotRow({ id: 'src_1_mv1', fetchedAt: T0 - HOUR }) },
      change: {},
      expect: [/条目没有变化/],
      reject: [/没有可比较的上一版/],
    },
    {
      name: '响应被宿主截断',
      snap: { snapshot: snapshotRow({ truncated: true }), previousSnapshot: snapshotRow({ id: 'src_1_mv1', fetchedAt: T0 - HOUR }) },
      change: { truncated: true, diffDetail: { added: ['新条目 A'], removed: [], modified: [] } },
      expect: [/被宿主截断/, /不能据此断言条目被删除/],
      reject: [],
    },
    {
      name: '上一份只保留了摘录',
      snap: { snapshot: snapshotRow(), previousSnapshot: snapshotRow({ id: 'src_1_mv1', fetchedAt: T0 - HOUR, retention: 'excerpt' }) },
      change: { diffDetail: { added: ['新条目 A'], removed: [], modified: [] } },
      expect: [/只保留了摘录而不是全文/],
      reject: [],
    },
  ]

  for (const item of cases) {
    const client = makeClient({
      [`GET ${ROUTE_PREFIX}/changes/chg_1`]: () => ({ ok: true, data: { change: changeRow(item.change), source: sourceRow(), ...item.snap } }),
    })
    try {
      const R = client.renderer
      const text = R.textOf(await render(client, client.exported.__test.ChangeDetail, { id: 'chg_1', meta: META }))
      for (const pattern of item.expect) assert.match(text, pattern, `「${item.name}」缺少：${pattern}`)
      for (const pattern of item.reject) assert.doesNotMatch(text, pattern, `「${item.name}」不该出现：${pattern}`)
    } finally {
      client.restore()
    }
  }

  // 差异条数顶到上限时必须标成下限，不能读成"就这么多"。
  const capped = makeClient({
    [`GET ${ROUTE_PREFIX}/changes/chg_1`]: () => ({
      ok: true,
      data: {
        change: changeRow({ diffDetail: { added: Array.from({ length: LIMITS.maxDiffItems }, (_v, i) => `条目 ${i}`), removed: [], modified: [] } }),
        source: sourceRow(),
        snapshot: snapshotRow(),
        previousSnapshot: snapshotRow({ id: 'src_1_mv1', fetchedAt: T0 - HOUR }),
      },
    }),
  })
  try {
    const text = capped.renderer.textOf(
      await render(capped, capped.exported.__test.ChangeDetail, { id: 'chg_1', meta: META }),
    )
    assert.match(text, /上限/, '差异列表到顶时必须说明这只是下限')
    assert.match(text, /只是下限/)
  } finally {
    capped.restore()
  }
})

// ------------------------------------------------- ④ 状态与备注的持久化

test('④ 改状态与备注：只有服务端确认成功才显示已保存，失败时保留用户输入', async () => {
  // (a) 成功路径：请求体要对，成功之后才出现「已保存」。
  const ok = makeClient()
  try {
    const R = ok.renderer
    let tree = await render(ok, ok.exported.__test.PANE_BODIES.inbox)
    click(R, tree, (_node, t) => t.includes('示例标题'))
    tree = await render(ok, ok.exported.__test.PANE_BODIES.inbox)

    const noteBox = R.find(tree, (node) => node.tag === 'textarea')
    assert.ok(noteBox, '详情必须有备注输入框')
    noteBox.props.onChange({ target: { value: '这条和我们的 SDK 路线有关' } })
    tree = await render(ok, ok.exported.__test.PANE_BODIES.inbox)

    click(R, tree, (_node, t) => t === '保存备注')
    tree = await render(ok, ok.exported.__test.PANE_BODIES.inbox)

    const patched = ok.requests.filter((r) => r.method === 'PATCH' && r.path === `${ROUTE_PREFIX}/changes/chg_1`)
    assert.equal(patched.length, 1, '必须真的发一次 PATCH')
    assert.equal(patched[0].body.userNote, '这条和我们的 SDK 路线有关')
    assert.match(R.textOf(tree), /已保存/, '服务端确认之后才显示已保存')

    // 状态修改走同一个端点。
    click(R, tree, (_node, t) => t === '忽略')
    tree = await render(ok, ok.exported.__test.PANE_BODIES.inbox)
    const statusPatch = ok.requests.filter((r) => r.method === 'PATCH' && r.body?.status === 'ignored')
    assert.equal(statusPatch.length, 1, '点「忽略」必须发 status=ignored')
  } finally {
    ok.restore()
  }

  // (b) 失败路径：显示原因、**保留输入**、绝不出现「已保存」。
  const bad = makeClient({
    [`PATCH ${ROUTE_PREFIX}/changes/chg_1`]: () => ({ ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: '存储域不可写' } }),
  })
  try {
    const R = bad.renderer
    let tree = await render(bad, bad.exported.__test.PANE_BODIES.inbox)
    click(R, tree, (_node, t) => t.includes('示例标题'))
    tree = await render(bad, bad.exported.__test.PANE_BODIES.inbox)

    R.find(tree, (node) => node.tag === 'textarea').props.onChange({ target: { value: '用户辛苦写的一段判断' } })
    tree = await render(bad, bad.exported.__test.PANE_BODIES.inbox)
    click(R, tree, (_node, t) => t === '保存备注')
    tree = await render(bad, bad.exported.__test.PANE_BODIES.inbox)

    const text = R.textOf(tree)
    assert.match(text, /保存失败/, '失败必须说出来')
    assert.match(text, /存储域不可写/, '要带服务端给的原因')
    assert.ok(!/已保存/.test(text), '写入失败时绝不能显示「已保存」')
    assert.equal(
      R.find(tree, (node) => node.tag === 'textarea').props.value,
      '用户辛苦写的一段判断',
      '保存失败必须保留用户输入 —— 清空表单等于让他重写一遍',
    )
  } finally {
    bad.restore()
  }
})

// ------------------------------------------------- ⑤ 来源详情与快照历史

test('⑤ 来源详情：状态、失败原因与快照历史都在，读取失败不伪装成"没有快照"', async () => {
  const degraded = sourceRow({
    status: 'failed',
    lastError: { code: 'FETCH_TIMEOUT', message: '超过 30000 ms 未返回', at: T0 },
    failureStreak: 3,
    autoDisabledAt: T0,
    autoDisabledReason: '连续 3 次刷新失败，已自动停用',
  })

  const partial = makeClient({
    [`GET ${ROUTE_PREFIX}/sources`]: () => ({ ok: true, data: { items: [degraded] } }),
    [`GET ${ROUTE_PREFIX}/sources/src_1/snapshots`]: () => ({ ok: true, data: { total: 2, items: [snapshotRow(), snapshotRow({ id: 'src_1_mv1', fetchedAt: T0 - HOUR, retention: 'excerpt' })] } }),
  })
  try {
    const R = partial.renderer
    // 「关注源」现在是自己一个右栏页签，不再是页内分段控件：直接挂载那个页签的正文。
    let tree = await render(partial, partial.exported.__test.PANE_BODIES.sources)

    click(R, tree, (_node, t) => t.includes('某来源'))
    tree = await render(partial, partial.exported.__test.PANE_BODIES.sources)
    const text = R.textOf(tree)

    assert.ok(
      partial.requests.some((r) => r.path === `${ROUTE_PREFIX}/sources/src_1/snapshots`),
      '来源详情必须真的去读它自己的快照历史',
    )
    assert.match(text, /‹ 返回关注源列表/)
    assert.match(text, /规范化地址/)
    assert.match(text, /连续失败次数/)
    assert.match(text, /FETCH_TIMEOUT/, '失败原因要带错误码 —— 只说"抓取失败"会让用户去改一个没错的地址')
    assert.match(text, /超过 30000 ms 未返回/)
    assert.match(text, /已自动停用/)
    assert.match(text, /仅保留摘录/, '摘录快照必须与全文快照区分开')
    assert.match(text, /最多保留 20 份快照/, '要把保留上限如实告诉用户')
  } finally {
    partial.restore()
  }

  // 读取失败 ≠ 没有快照。这两件事的含义正相反，必须分开说。
  const broken = makeClient({
    [`GET ${ROUTE_PREFIX}/sources/src_1/snapshots`]: () => ({ ok: false, error: { code: 'STORAGE_UNAVAILABLE', message: '存储域不可写' } }),
  })
  try {
    const R = broken.renderer
    let tree = await render(broken, broken.exported.__test.PANE_BODIES.sources)
    click(R, tree, (_node, t) => t.includes('某来源'))
    tree = await render(broken, broken.exported.__test.PANE_BODIES.sources)
    const text = R.textOf(tree)

    assert.match(text, /快照历史读取失败/, '读取失败要说"读取失败"')
    assert.match(text, /存储域不可写/)
    assert.ok(!text.includes('这个来源还没有快照'), '读取失败绝不能显示成"还没有快照" —— 那是在替服务端撒谎')
    assert.ok(R.findClickable(tree, (_node, t) => t === '重试'), '读取失败要有重试')
  } finally {
    broken.restore()
  }
})

// ------------------------------------------------- ⑥ 机会详情编辑与保存失败

test('⑥ 机会详情：编辑保存失败时保留输入并显示原因，删除失败不离开页面', async () => {
  const failingSave = makeClient({
    [`PATCH ${ROUTE_PREFIX}/opportunities/opp_1`]: () => ({ ok: false, error: { code: 'FIELD_NOT_WRITABLE', message: '字段 status 不可写' } }),
    [`DELETE ${ROUTE_PREFIX}/opportunities/opp_1`]: () => ({ ok: false, error: { code: 'NOT_FOUND', message: '这条机会已经不存在了' } }),
  })
  try {
    const R = failingSave.renderer
    let tree = await render(failingSave, failingSave.exported.__test.PANE_BODIES.opps)

    click(R, tree, (_node, t) => t.includes('示例机会'))
    tree = await render(failingSave, failingSave.exported.__test.PANE_BODIES.opps)
    assert.ok(
      failingSave.requests.some((r) => r.path === `${ROUTE_PREFIX}/opportunities/opp_1`),
      '机会详情必须独立读取，不能靠列表里那一行凑',
    )
    assert.match(R.textOf(tree), /‹ 返回机会池/)

    click(R, tree, (_node, t) => t === '编辑判断与问题')
    tree = await render(failingSave, failingSave.exported.__test.PANE_BODIES.opps)

    const judgment = R.find(tree, (node) => node.tag === 'textarea')
    assert.ok(judgment, '编辑表单要有判断输入框')
    judgment.props.onChange({ target: { value: '我自己写的判断，绝不能被清空' } })
    tree = await render(failingSave, failingSave.exported.__test.PANE_BODIES.opps)

    click(R, tree, (_node, t) => t === '保存')
    tree = await render(failingSave, failingSave.exported.__test.PANE_BODIES.opps)
    let text = R.textOf(tree)

    assert.match(text, /保存失败/, '保存失败必须显示出来')
    assert.match(text, /字段 status 不可写/, '要带服务端给的字段级原因')
    assert.equal(
      R.find(tree, (node) => node.tag === 'textarea').props.value,
      '我自己写的判断，绝不能被清空',
      '保存失败必须保留输入',
    )
    assert.ok(!/已保存/.test(text), '失败时不能出现「已保存」')

    // 删除失败：必须留在详情页，且如实转述后端结果。
    click(R, tree, (_node, t) => t === '删除')
    tree = await render(failingSave, failingSave.exported.__test.PANE_BODIES.opps)
    click(R, tree, (_node, t) => t === '确认删除')
    tree = await render(failingSave, failingSave.exported.__test.PANE_BODIES.opps)
    text = R.textOf(tree)

    assert.match(text, /删除失败/, '删除失败必须说出来')
    assert.match(text, /这条机会已经不存在了/)
    assert.match(text, /‹ 返回机会池/, '删除失败时不能把用户弹回列表 —— 那会让人以为删掉了')
  } finally {
    failingSave.restore()
  }
})

// ------------------------------------------------- ⑦ 双向跳转

test('⑦ 变化 ↔ 机会双向跳转：跨视图开的是另一个右栏页签，并用真实 id 定位到那一条', async () => {
  const client = makeClient({
    [`GET ${ROUTE_PREFIX}/changes/chg_1`]: () => ({
      ok: true,
      data: {
        change: changeRow({ opportunityId: 'opp_1', status: 'pooled' }),
        source: sourceRow(),
        snapshot: snapshotRow(),
        previousSnapshot: snapshotRow({ id: 'src_1_mv1', fetchedAt: T0 - HOUR }),
      },
    }),
  })
  try {
    const R = client.renderer
    const opened = []
    /*
     * 右栏席位注入的 hook 是按名字变成 props 的，所以这里直接把 `useTabInfo` 当 prop
     * 传进去。fake 出来的 `tab` 只要满足 `navigation` + `actions` 两件事。
     */
    const inboxTab = () => ({
      tab: { navigation: { params: {}, revision: 1 }, actions: { openTab: (kind, options) => opened.push({ kind, options }) } },
    })
    let tree = await render(client, client.exported.__test.PANE_BODIES.inbox, { useTabInfo: inboxTab })

    // 变化详情 → 打开「机会池」页签，并把那一条机会的 id 带过去。
    click(R, tree, (_node, t) => t.includes('示例标题'))
    tree = await render(client, client.exported.__test.PANE_BODIES.inbox, { useTabInfo: inboxTab })
    assert.ok(R.textOf(tree).includes('已关联机会 opp_1'), '有关联时要把关联对象显示出来')

    click(R, tree, (_node, t) => t === '打开机会详情 ›')
    tree = await render(client, client.exported.__test.PANE_BODIES.inbox, { useTabInfo: inboxTab })
    assert.deepEqual(
      opened,
      [{ kind: 'apradar:opps', options: { params: { detailId: 'opp_1' }, revealIfOpened: true } }],
      '跨视图必须去打开机会池页签并带上真实 id —— 只切自己这块视图的话，用户就没法两边对着看',
    )
    assert.match(R.textOf(tree), /已关联机会 opp_1/, '打开另一个页签不该把本页签的内容替换掉')

    // 被指过来的机会池页签：按 params 直接落在那条机会的详情上。
    R.reset()
    const oppsTab = () => ({
      tab: { navigation: { params: { detailId: 'opp_1' }, revision: 4 }, actions: { openTab: () => {} } },
    })
    tree = await render(client, client.exported.__test.PANE_BODIES.opps, { useTabInfo: oppsTab })
    assert.ok(
      client.requests.some((r) => r.path === `${ROUTE_PREFIX}/opportunities/opp_1`),
      '被指过来的页签必须按 params 去读那条机会，而不是停在机会池列表',
    )
    assert.match(R.textOf(tree), /关联的来源变化/, '要真的落在机会详情上')

    // 「返回」回到的是本页签自己的列表 —— 跨页签没有来路栈，这是 0.1.1 与 0.1.0 的差别。
    click(R, tree, (_node, t) => t === '‹ 返回机会池')
    tree = await render(client, client.exported.__test.PANE_BODIES.opps, { useTabInfo: oppsTab })
    assert.match(R.textOf(tree), /示例机会/, '返回要回到机会池列表')

    // 反方向：机会详情 →「打开变化详情 ›」→ 打开「变化」页签。
    R.reset()
    const backToChange = []
    const oppsDir = () => ({
      tab: { navigation: { params: {}, revision: 1 }, actions: { openTab: (kind, options) => backToChange.push({ kind, options }) } },
    })
    tree = await render(client, client.exported.__test.PANE_BODIES.opps, { useTabInfo: oppsDir })
    click(R, tree, (_node, t) => t.includes('示例机会'))
    tree = await render(client, client.exported.__test.PANE_BODIES.opps, { useTabInfo: oppsDir })
    click(R, tree, (_node, t) => t === '打开变化详情 ›')
    assert.deepEqual(
      backToChange,
      [{ kind: 'apradar:inbox', options: { params: { detailId: 'chg_1' }, revealIfOpened: true } }],
      '反方向必须打开「变化」页签，并用真实的变化 id',
    )
  } finally {
    client.restore()
  }
})

// ------------------------------------------------- ⑧ 关联对象已被删除

test('⑧ 关联的变化已被清理：如实说明，不渲染空链接、也不抛未处理错误', async () => {
  // (a) 机会原本关联的变化没了 → changeMissing=true
  const orphan = makeClient({
    [`GET ${ROUTE_PREFIX}/opportunities/opp_1`]: () => ({
      ok: true,
      data: { opportunity: oppRow(), change: null, changeMissing: true, source: null, sourceMissing: false },
    }),
  })
  try {
    const R = orphan.renderer
    let tree = await render(orphan, orphan.exported.__test.PANE_BODIES.opps)
    click(R, tree, (_node, t) => t.includes('示例机会'))
    tree = await render(orphan, orphan.exported.__test.PANE_BODIES.opps)
    const text = R.textOf(tree)

    assert.match(text, /已经不在了/, '关联对象消失时必须明说')
    assert.ok(!text.includes('打开变化详情'), '关联对象没了就不该再给一个会 404 的入口')
  } finally {
    orphan.restore()
  }

  // (b) 手工创建、从来没有关联过 → changeMissing=false，两句话必须不同
  const manual = makeClient({
    [`GET ${ROUTE_PREFIX}/opportunities`]: () => ({ ok: true, data: { total: 1, offset: 0, limit: 20, items: [oppRow({ changeId: null, id: 'opp_1', title: '手工建的机会' })] } }),
    [`GET ${ROUTE_PREFIX}/opportunities/opp_1`]: () => ({
      ok: true,
      data: { opportunity: oppRow({ changeId: null, title: '手工建的机会' }), change: null, changeMissing: false, source: null, sourceMissing: false },
    }),
  })
  try {
    const R = manual.renderer
    let tree = await render(manual, manual.exported.__test.PANE_BODIES.opps)
    assert.match(R.textOf(tree), /没有关联任何一次抓取记录/, '列表上就要能看出来这条机会没有抓取证据')
    click(R, tree, (_node, t) => t.includes('手工建的机会'))
    tree = await render(manual, manual.exported.__test.PANE_BODIES.opps)
    const text = R.textOf(tree)

    assert.match(text, /没有关联任何一次抓取记录/, '详情里必须明说这条机会没有抓取证据')
    assert.doesNotMatch(text, /已经不在了/, '"从来没有关联过"与"关联对象不见了"是两件事，不能说成一句')
  } finally {
    manual.restore()
  }

  // (c) 变化指向的机会已被删除 → 打开时如实报错，不崩。
  const gone = makeClient({
    [`GET ${ROUTE_PREFIX}/changes/chg_1`]: () => ({
      ok: true,
      data: {
        change: changeRow({ opportunityId: 'opp_gone', status: 'pooled' }),
        source: sourceRow(),
        snapshot: snapshotRow(),
        previousSnapshot: null,
      },
    }),
    [`GET ${ROUTE_PREFIX}/opportunities/opp_gone`]: () => ({ ok: false, error: { code: 'NOT_FOUND', message: '没有这条机会：opp_gone' } }),
  })
  try {
    const R = gone.renderer
    let tree = await render(gone, gone.exported.__test.PANE_BODIES.inbox)
    click(R, tree, (_node, t) => t.includes('示例标题'))
    tree = await render(gone, gone.exported.__test.PANE_BODIES.inbox)
    click(R, tree, (_node, t) => t === '打开机会详情 ›')
    tree = await render(gone, gone.exported.__test.PANE_BODIES.inbox)
    const text = R.textOf(tree)

    assert.match(text, /读不出来/, '打开一个已经删掉的机会要说清读不出来')
    assert.match(text, /没有这条机会/)
    assert.match(text, /‹ 返回机会池/, '读失败时也要有出口')

    // 没有右栏 API 时就地打开：返回必须回到本页签自己的列表，不能卡在别人的详情里。
    click(R, tree, (_node, t) => t === '‹ 返回机会池')
    tree = await render(gone, gone.exported.__test.PANE_BODIES.inbox)
    assert.match(R.textOf(tree), /本次显示第/, '就地打开的另一个视图返回后，要回到本页签自己的列表')
  } finally {
    gone.restore()
  }
})

// ------------------------------------------------- ⑨ 筛选 / 分页 / 滚动

test('⑨ 列表筛选、分页与滚动位置：换条件回到第一页，返回时工作位置原样恢复', async () => {
  const client = makeClient({
    [`GET ${ROUTE_PREFIX}/changes`]: ({ query }) => ({
      ok: true,
      data: {
        total: 45,
        offset: Number(query.offset ?? 0),
        limit: Number(query.limit ?? 20),
        items: [changeRow({ title: `第 ${Number(query.offset ?? 0) + 1} 条` })],
      },
    }),
  })
  try {
    const R = client.renderer
    let tree = await render(client, client.exported.__test.PANE_BODIES.inbox)
    assert.match(R.textOf(tree), /共 45 条/)

    // 翻到第二页
    click(R, tree, (_node, t) => t === '下一页')
    tree = await render(client, client.exported.__test.PANE_BODIES.inbox)
    const paged = client.requests.filter((r) => r.path.startsWith(`${ROUTE_PREFIX}/changes?`) && r.path.includes('offset=20'))
    assert.equal(paged.length, 1, '「下一页」必须真的按 offset=20 去取')
    assert.match(R.textOf(tree), /本次显示第 21/, '分页位置必须显示出来')

    // 改筛选条件 → 必须回到第一页
    const filter = byLabel(R, tree, '按处理状态筛选')
    assert.ok(filter, '筛选下拉必须有可读的无障碍名字')
    filter.props.onChange({ target: { value: 'ignored' } })
    tree = await render(client, client.exported.__test.PANE_BODIES.inbox)
    const afterFilter = client.requests.filter((r) => r.path.includes('status=ignored')).at(-1)
    assert.ok(afterFilter, '改筛选必须带上新的 status')
    assert.ok(!afterFilter.path.includes('offset=20'), '换筛选条件必须回到第一页，否则用户会看到"没有结果"的假象')

    // 搜索词
    byLabel(R, tree, '搜索变化').props.onChange({ target: { value: '某个关键词' } })
    tree = await render(client, client.exported.__test.PANE_BODIES.inbox)
    assert.ok(
      client.requests.some((r) => r.path.includes('q=') && decodeURIComponent(r.path).includes('某个关键词')),
      '搜索必须真的发给服务端',
    )

    // 进详情再返回：搜索词、筛选、分页都要还在。
    const body = findBody(R, tree)
    body.element.scrollTop = 111
    click(R, tree, (_node, t) => t.includes('第 1 条'))
    tree = await render(client, client.exported.__test.PANE_BODIES.inbox)
    click(R, tree, (_node, t) => t === '‹ 返回变化列表')
    tree = await render(client, client.exported.__test.PANE_BODIES.inbox)

    assert.equal(byLabel(R, tree, '搜索变化').props.value, '某个关键词', '返回后搜索词必须还在')
    assert.equal(byLabel(R, tree, '按处理状态筛选').props.value, 'ignored', '返回后筛选条件必须还在')
    assert.equal(findBody(R, tree).element.scrollTop, 111, '返回后滚动位置必须恢复')

    // 机会池的筛选同样住在 nav 里。
    // 换页签等于换一个挂载点（真实右栏里本来就是两个根），重置渲染器实例。
    R.reset()
    tree = await render(client, client.exported.__test.PANE_BODIES.opps)
    byLabel(R, tree, '搜索机会').props.onChange({ target: { value: '机会关键词' } })
    tree = await render(client, client.exported.__test.PANE_BODIES.opps)
    assert.ok(
      client.requests.some((r) => r.path.startsWith(`${ROUTE_PREFIX}/opportunities?`) && decodeURIComponent(r.path).includes('机会关键词')),
      '机会池的搜索也必须真的发给服务端',
    )
  } finally {
    client.restore()
  }
})

// ------------------------------------------------- ⑩ 键盘可达性与窄侧栏

test('⑩ 键盘可达性：入口是真的 button，表单控件有标签，窄侧栏样式不横向溢出', async () => {
  const client = makeClient()
  try {
    const R = client.renderer
    let tree = await render(client, client.exported.__test.PANE_BODIES.inbox)

    // 列表行：真 button + 无障碍名字。
    const row = R.findClickable(tree, (_node, t) => t.includes('示例标题'))
    assert.equal(row.tag, 'button', '列表行必须是 <button>')
    assert.match(row.props['aria-label'] ?? '', /打开变化详情/)

    // 每个可点击元素都必须是能聚焦的宿主元素，不能是挂了 onClick 的 div。
    const focusable = new Set(['button', 'a', 'input', 'select', 'textarea'])
    const wrong = R.find(tree, (node) => typeof node.props?.onClick === 'function' && !focusable.has(node.tag))
    assert.equal(wrong, null, `有 onClick 挂在了不可聚焦的 <${wrong?.tag}> 上 —— 键盘用户永远按不到它`)

    // 表单控件要能被打字/选择，而且有可读名字（<label> 包裹或 aria-label）。
    click(R, tree, (_node, t) => t.includes('示例标题'))
    tree = await render(client, client.exported.__test.PANE_BODIES.inbox)

    const textarea = R.find(tree, (node) => node.tag === 'textarea')
    assert.ok(textarea, '备注输入框必须在')
    const labelled = R.find(tree, (node) => node.tag === 'label' && (node.children ?? []).includes(textarea))
    assert.ok(labelled, '备注框必须被 <label> 包着，否则屏幕阅读器读不出它是干什么的')

    const links = R.find(tree, (node) => node.tag === 'a')
    assert.equal(links.props.target, '_blank', '外部链接必须新开')
    assert.match(links.props.rel ?? '', /noopener/, '外部链接必须带 rel=noopener')
  } finally {
    client.restore()
  }

  // 静态部分：新加的交互条必须允许换行，否则在 648px 的窄侧栏里会横向溢出。
  // 这一条只保证"我们没有写死宽度"；真实像素要在浏览器里量（见 TECH-SPIKE §6.14）。
  const source = (await import('./client-harness.mjs')).SOURCE
  for (const rule of ['.apr-crumb', '.apr-pager', '.apr-bar', '.apr-actions']) {
    const block = source.slice(source.indexOf(`${rule} {`), source.indexOf('}', source.indexOf(`${rule} {`)))
    assert.ok(block.length > 0, `${rule} 规则必须存在`)
    assert.match(block, /flex-wrap:\s*wrap/, `${rule} 必须在窄侧栏里换行`)
    assert.doesNotMatch(block, /(^|[^-])width:\s*\d{3,}px/, `${rule} 不该写死宽度`)
  }
  assert.match(source, /\.apr-row:focus-visible[\s\S]{0,200}outline/, '必须有可见的键盘焦点样式')
  assert.match(source, /\.apr-rowlink:focus-visible[\s\S]{0,200}outline/, '详情入口也必须有可见焦点')
})
