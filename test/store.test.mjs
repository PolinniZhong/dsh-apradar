/**
 * 存储打开路径的测试。
 *
 * 这里是「持久化到底成不成立」的判据所在：
 * `openRadarStore` 必须**永不抛出**，成功时 `openCount` 自增，失败时如实给出原因。
 * 用假的 `storageDomain` 设施来测，因此不依赖真实 Host、不写任何真实文件。
 *
 * 存储现在**开了四个域**（sources / snapshots / changes / opportunities），
 * 所以假设施也必须按域名分别记账 —— 否则「只开成功一个域」这种半开状态测不出来。
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { DOMAINS, SCHEMA_VERSION, sourcesDomain } from '../src/host/store/domains.js'
import { buildDomainSpec, describeStore, loadSpecBuilders, openRadarStore } from '../src/host/store/index.js'
import { MIGRATIONS, planMigration, runMigrations } from '../src/host/store/migrate.js'

/** 四个域各自的「表名 → Map」。
 * @param {object} backing 假设施的后端账本
 * @param {string} domainName 域名
 * @param {string} tableName 表名
 * @returns {Map<string, object>}
 */
function tableStore(backing, domainName, tableName) {
  const key = `${domainName}/${tableName}`
  if (!backing.tables.has(key)) backing.tables.set(key, new Map())
  return backing.tables.get(key)
}

/** 把一张 Map 包装成官方 `KvTable` 被用到的那部分形状。 */
function makeTable(map) {
  return {
    get size() {
      return map.size
    },
    entries: () => map.entries(),
    keys: () => [...map.keys()],
    get: (id) => map.get(id),
    put: async (id, value) => void map.set(id, value),
    delete: async (id) => map.delete(id),
  }
}

/**
 * 一个最小的假 `ctx.storageDomain`：把每个域的 global 与每张表分别存在内存 Map 里，
 * 形状与官方 `DomainFacility` / `Domain` / `KvTable` 的**被用到的那部分**一致。
 *
 * @param {object} [overrides] 覆盖后端账本字段（`openError` / `setError` / `openErrorOn`）
 * @returns {object} 假设施
 */
function fakeFacility(overrides = {}) {
  const backing = {
    /** 域名 → global 值 */
    globals: new Map(),
    /** `${域名}/${表名}` → Map */
    tables: new Map(),
    openError: null,
    /** 只在某一个域上失败，用来验证「已经打开的先关掉」 */
    openErrorOn: null,
    setError: null,
    ...overrides,
  }
  const opened = []
  const closed = []
  return {
    backing,
    opened,
    closed,
    tableOf: (domainName, tableName) => makeTable(tableStore(backing, domainName, tableName)),
    async open(spec) {
      opened.push(spec)
      if (backing.openErrorOn === spec.name) {
        throw Object.assign(new Error(`后端拒绝打开 ${spec.name}`), { code: 'malformed-medium' })
      }
      if (backing.openError) throw backing.openError
      return {
        name: spec.name,
        global: {
          get: () => backing.globals.get(spec.name),
          set: async (value) => {
            if (backing.setError) throw backing.setError
            backing.globals.set(spec.name, value)
          },
        },
        table: (tableName) => makeTable(tableStore(backing, spec.name, tableName)),
        close: async () => {
          closed.push(spec.name)
        },
      }
    },
  }
}

/** 假 ctx：记录 effect 的 disposer，便于验证生命周期。 */
function fakeCtx(facility) {
  const disposers = []
  return {
    disposers,
    storageDomain: facility,
    effect(callback, label) {
      disposers.push({ label, dispose: callback() })
    },
  }
}

test('loadSpecBuilders：永远返回可用结果或明确的降级原因，不抛错', async () => {
  const builders = await loadSpecBuilders()
  assert.ok(['official', 'inline'].includes(builders.mode))
  if (builders.mode === 'inline') assert.equal(typeof builders.reason, 'string')
  else assert.equal(typeof builders.defineDomain, 'function')
})

test('buildDomainSpec：inline 退回时给出与官方 DomainSpec 同形状的字面量', () => {
  const built = buildDomainSpec(sourcesDomain, { mode: 'inline' })
  // 降级路径必须**原样**返回声明，不能顺手加字段 —— 加了就不是官方形状了。
  assert.deepEqual(built, sourcesDomain)
  assert.equal(typeof built.global.schema.parse, 'function')
  assert.equal(typeof built.global.schema.safeParse, 'function')
  assert.equal(typeof built.tables.sources.valueSchema.parse, 'function')
})

test('buildDomainSpec：有官方 helper 时走 official 路径，且每张表都过 domainTable', () => {
  const seen = []
  const built = buildDomainSpec(sourcesDomain, {
    mode: 'official',
    defineDomain: (spec) => {
      seen.push(spec)
      return { ...spec, viaOfficial: true }
    },
    domainTable: (schema) => ({ valueSchema: schema }),
  })
  assert.equal(built.viaOfficial, true)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].name, sourcesDomain.name)
  assert.equal(seen[0].tables.sources.valueSchema, sourcesDomain.tables.sources.valueSchema)
})

test('四个域全部打开，句柄上能按表名访问', async () => {
  const facility = fakeFacility()
  const store = await openRadarStore(fakeCtx(facility), { now: () => 'T' })
  assert.equal(store.ok, true, store.reason)
  assert.deepEqual(
    facility.opened.map((spec) => spec.name),
    DOMAINS.map((domain) => domain.name),
  )
  assert.deepEqual(store.domainNames, DOMAINS.map((domain) => domain.name))
  assert.deepEqual(Object.keys(store.counts()).sort(), ['changes', 'opportunities', 'snapshots', 'sources'])
})

test('四个域的 global schema 都必须拒绝 null —— 这是 defineDomain 的加载期抛错条件', async () => {
  const facility = fakeFacility()
  await openRadarStore(fakeCtx(facility), {})
  for (const spec of facility.opened) {
    assert.equal(spec.global.schema.safeParse(null).success, false, `${spec.name} 的 global 接受了 null`)
    assert.equal(spec.global.schema.safeParse(spec.global.initial).success, true, `${spec.name} 的 initial 没通过自己的 schema`)
  }
})

test('ctx.storageDomain 不可用时：明确失败，不抛错，不说"已保存"', async () => {
  const store = await openRadarStore({}, {})
  assert.equal(store.ok, false)
  assert.match(store.reason, /storageDomain/)
  assert.equal(store.state, undefined)
})

test('回归：不得直接读 ctx.storageDomain —— Cordis 未 inject 时会抛，且会打死宿主', async () => {
  // 真实失败现场（隔离 Web Profile 首次加载）：
  //   Error: cannot get property "storageDomain" without inject
  //   → dsh: fatal load failure
  // 因此实现必须走 ctx.get('storageDomain')（reflect 的免 inject 读法）。
  const facility = fakeFacility()
  const ctx = {
    disposed: [],
    get(name) {
      assert.equal(name, 'storageDomain')
      return facility
    },
    effect(callback) {
      this.disposed.push(callback())
    },
  }
  // 只要实现去读了 ctx.storageDomain，这个 getter 就会抛 —— 必须读不到它。
  Object.defineProperty(ctx, 'storageDomain', {
    get() {
      throw new Error('cannot get property "storageDomain" without inject')
    },
  })

  const store = await openRadarStore(ctx, { now: () => 'T' })
  assert.equal(store.ok, true, store.reason)
  assert.equal(store.state().openCount, 1)
})

test('回归：openRadarStore 对任何异常都返回失败句柄，绝不抛给调用方', async () => {
  const ctx = {
    get() {
      throw new Error('上下文本身坏了')
    },
  }
  const store = await openRadarStore(ctx, {})
  assert.equal(store.ok, false)
  assert.match(store.reason, /存储初始化异常/)
})

test('回归：facility.open 返回非对象（后端实现异常）也要落到失败句柄', async () => {
  const ctx = { storageDomain: { open: async () => null } }
  const store = await openRadarStore(ctx, {})
  assert.equal(store.ok, false)
  assert.match(store.reason, /存储初始化异常|不可用/)
})

test('某个域打开失败：报告是哪个域，并把已经打开的域全部关掉 —— 不留半个存储', async () => {
  const facility = fakeFacility({ openErrorOn: 'ai_product_radar_changes' })
  const store = await openRadarStore(fakeCtx(facility), {})
  assert.equal(store.ok, false)
  assert.match(store.reason, /打开域 ai_product_radar_changes 失败/)
  assert.match(store.reason, /malformed-medium/)
  // sources 与 snapshots 已经打开过，失败后必须被关掉。
  assert.deepEqual(facility.closed, ['ai_product_radar_sources', 'ai_product_radar_snapshots'])
})

test('第一次打开：openCount 从 0 变 1，并落定 firstOpenedAt', async () => {
  const facility = fakeFacility()
  const ctx = fakeCtx(facility)
  const store = await openRadarStore(ctx, { now: () => 'T1' })

  assert.equal(store.ok, true, store.reason)
  assert.equal(store.domainName, 'ai_product_radar_sources')
  const state = store.state()
  assert.equal(state.openCount, 1)
  assert.equal(state.firstOpenedAt, 'T1')
  assert.equal(state.lastOpenedAt, 'T1')
  assert.equal(state.schemaVersion, SCHEMA_VERSION)
  // 写回的是后端里的值，不是内存里的镜像
  assert.equal(facility.backing.globals.get('ai_product_radar_sources').openCount, 1)
})

test('再次打开（模拟重启后再进一次）：openCount 累加，firstOpenedAt 不变 —— 这就是持久化判据', async () => {
  const facility = fakeFacility()
  const first = await openRadarStore(fakeCtx(facility), { now: () => 'T1' })
  assert.equal(first.state().openCount, 1)

  const second = await openRadarStore(fakeCtx(facility), { now: () => 'T2' })
  const state = second.state()
  assert.equal(state.openCount, 2, '跨"进程"重开后必须变大')
  assert.equal(state.firstOpenedAt, 'T1', '首次打开时间必须保留')
  assert.equal(state.lastOpenedAt, 'T2')
})

test('domain 的生命周期交给 ctx.effect；disposer 真的会 close 全部四个域', async () => {
  const facility = fakeFacility()
  const ctx = fakeCtx(facility)
  const store = await openRadarStore(ctx, {})
  assert.equal(ctx.disposers.length, 1, '四个域共用一个 disposer')
  assert.match(ctx.disposers[0].label, /storage domain close/)
  assert.deepEqual(facility.closed, [])
  await ctx.disposers[0].dispose()
  assert.deepEqual(facility.closed, DOMAINS.map((domain) => domain.name))
  await store.close()
  assert.equal(facility.closed.length, 4, 'close 幂等且可重复调用')
})

test('all / get / put / del / counts 读写的是对应的表，不是别的表', async () => {
  const facility = fakeFacility()
  const store = await openRadarStore(fakeCtx(facility), {})

  await store.put('sources', { id: 'src_a', name: 'A' })
  await store.put('snapshots', { id: 'snap_a', sourceId: 'src_a' })

  assert.deepEqual(store.all('sources'), [{ key: 'src_a', id: 'src_a', name: 'A' }])
  assert.deepEqual(store.get('snapshots', 'snap_a'), { key: 'snap_a', id: 'snap_a', sourceId: 'src_a' })
  assert.equal(store.get('snapshots', 'nope'), undefined)
  assert.equal(store.counts().sources, 1)
  assert.equal(store.counts().snapshots, 1)
  assert.equal(store.counts().changes, 0)

  // 表名不认识时必须立刻抛出 —— 静默写进别的表是最难查的一类 bug。
  await assert.rejects(() => store.put('nope', { id: 'x' }), /未知表名/)

  assert.equal(await store.del('snapshots', 'snap_a'), true)
  assert.equal(await store.del('snapshots', 'snap_a'), false, '删不存在的记录要如实返回 false')
  assert.equal(store.counts().snapshots, 0)
})

test('put 缺少 id：抛出，不写一条没有键的记录', async () => {
  const facility = fakeFacility()
  const store = await openRadarStore(fakeCtx(facility), {})
  await assert.rejects(() => store.put('sources', { name: '没 id' }), /缺少 id/)
  assert.equal(store.counts().sources, 0)
})

test('listSources / sourceCount 读的是 sources 表，不是别的来源', async () => {
  const facility = fakeFacility()
  facility.tableOf('ai_product_radar_sources', 'sources').put('src_a', { id: 'src_a', name: 'A' })
  const store = await openRadarStore(fakeCtx(facility), {})
  assert.equal(store.sourceCount(), 1)
  assert.deepEqual(store.listSources(), [{ key: 'src_a', id: 'src_a', name: 'A' }])
  // 往别的表里塞东西不该影响来源数。
  facility.tableOf('ai_product_radar_changes', 'changes').put('chg_a', { id: 'chg_a' })
  assert.equal(store.sourceCount(), 1)
})

test('storageDomain.open 抛错：原样带出错误码，不假装成功', async () => {
  const facility = fakeFacility({ openError: Object.assign(new Error('bad medium'), { code: 'malformed-medium' }) })
  const store = await openRadarStore(fakeCtx(facility), {})
  assert.equal(store.ok, false)
  assert.match(store.reason, /malformed-medium/)
})

test('写 global 失败：报告失败，不留下"内存已更新"的假象', async () => {
  const facility = fakeFacility({ setError: new Error('read-only medium') })
  const store = await openRadarStore(fakeCtx(facility), {})
  assert.equal(store.ok, false)
  assert.match(store.reason, /写入 global 失败/)
  assert.equal(facility.backing.globals.get('ai_product_radar_sources'), undefined, '后端没写成功，后端里就不该有这个值')
})

test('存储里的 schemaVersion 高于代码：拒绝降级写入', async () => {
  const facility = fakeFacility()
  facility.backing.globals.set('ai_product_radar_sources', { schemaVersion: 99, openCount: 5 })
  const store = await openRadarStore(fakeCtx(facility), {})
  assert.equal(store.ok, false)
  assert.match(store.reason, /高于当前插件支持的版本/)
  assert.equal(facility.backing.globals.get('ai_product_radar_sources').openCount, 5, '降级模式下不得改动已有数据')
})

test('markRefreshed：写失败不抛出（刷新本身已成功），但要通过 log 留痕', async () => {
  const facility = fakeFacility()
  const logs = []
  const store = await openRadarStore(fakeCtx(facility), { now: () => 'T1', log: (m) => logs.push(m) })
  facility.backing.setError = new Error('read-only medium')
  await store.markRefreshed()
  // `log` 里还会有启动期的降级说明，所以按内容找，不按条数断言。
  assert.ok(
    logs.some((message) => /lastRefreshAt/.test(message)),
    `写失败必须留痕，实际日志：${JSON.stringify(logs)}`,
  )

  facility.backing.setError = null
  await store.markRefreshed()
  assert.equal(facility.backing.globals.get('ai_product_radar_sources').lastRefreshAt, 'T1')
})

test('planMigration：同版本无步骤、降级被拒、缺路径被拒、非法输入被拒', () => {
  assert.deepEqual(planMigration(1, 1), { ok: true, steps: [] })

  const down = planMigration(2, 1)
  assert.equal(down.ok, false)
  assert.equal(down.code, 'downgrade')

  const gap = planMigration(0, 1)
  assert.equal(gap.ok, false)
  assert.equal(gap.code, 'no-path')

  const bad = planMigration(-1, 1)
  assert.equal(bad.ok, false)
  assert.equal(bad.code, 'no-path')
})

test('迁移表当前为空：v1 是初始版本，不需要迁移', () => {
  assert.deepEqual(MIGRATIONS, [])
})

test('runMigrations：按顺序执行且把说明写进日志', async () => {
  const log = []
  const order = []
  await runMigrations(
    [
      { from: 1, to: 2, description: '加字段', run: async () => void order.push('a') },
      { from: 2, to: 3, description: '改语义', run: async () => void order.push('b') },
    ],
    { domain: { name: 'ai_product_radar_sources' }, log: (message) => log.push(message) },
  )
  assert.deepEqual(order, ['a', 'b'])
  assert.equal(log.length, 2)
  assert.match(log[0], /1 → 2/)
})

test('describeStore：成功与失败两种结论都不含本机绝对路径', () => {
  const ok = describeStore({
    ok: true,
    specMode: 'inline',
    domainName: 'ai_product_radar_sources',
    migration: { from: 1, to: 1, applied: 0 },
    state: () => ({ schemaVersion: 1, openCount: 2 }),
    counts: () => ({ sources: 0, snapshots: 0, changes: 0, opportunities: 0 }),
  })
  assert.equal(ok.persisted, true)
  assert.equal(ok.currentSchemaVersion, SCHEMA_VERSION)
  assert.deepEqual(ok.domains, DOMAINS.map((domain) => domain.name))
  assert.deepEqual(ok.counts, { sources: 0, snapshots: 0, changes: 0, opportunities: 0 })

  const failed = describeStore({ ok: false, specMode: 'inline', reason: '打不开' })
  assert.equal(failed.persisted, false)
  assert.equal(failed.reason, '打不开')

  assert.ok(!JSON.stringify(ok).includes('/Users/'))
  assert.ok(!JSON.stringify(failed).includes('/Users/'))
})

test('回归：open 已发出但还没落地时被卸载 —— 那只句柄必须被关掉（HMR 重载的 already-open 泄漏）', async () => {
  // 真实事故（真实 Desktop 宿主实测）：HMR 重载时，**上一个实例的 in-flight promise
  // 会继续跑完**，而那时它的 fiber 早已释放。原实现把 `ctx.effect(...)` 放在所有
  // `await facility.open(...)` 之后 —— 于是释放钩子注册到死掉的作用域上，
  // disposer 永不执行，**域句柄永久泄漏**。下一个实例再打开同一个域就拿到
  //   already-open: domain 'ai_product_radar_sources' is already open
  // 整个存储不可用（读写全停）。这个用例把那个时序钉死。
  const closed = []
  let releaseOpen = null
  const gate = new Promise((resolve) => {
    releaseOpen = resolve
  })
  let resolveCalled = null
  const called = new Promise((resolve) => {
    resolveCalled = resolve
  })
  const facility = {
    async open(spec) {
      resolveCalled(spec.name)
      await gate
      return {
        name: spec.name,
        global: { get: () => undefined, set: async () => {} },
        table: () => makeTable(new Map()),
        close: async () => {
          closed.push(spec.name)
        },
      }
    },
  }

  const ctx = fakeCtx(facility)
  const pending = openRadarStore(ctx, {})

  // 第一个 await 之前钩子就该注册好了：这时 disposer 必须已经存在。
  assert.equal(ctx.disposers.length, 1, '释放钩子必须在第一个 await 之前注册')
  assert.match(ctx.disposers[0].label, /storage domain close/)

  // 等 open 真的发出去（在飞），然后卸载。
  const firstDomain = await called
  await ctx.disposers[0].dispose()

  // 现在让 open 落地 —— 它拿到的句柄必须被立刻关掉，不能留在已释放的 fiber 上。
  releaseOpen()
  const store = await pending

  assert.equal(store.ok, false, '卸载后不该报告存储可用')
  assert.match(store.reason, /已被卸载/)
  assert.deepEqual(closed, [firstDomain], `在飞的那只句柄必须被关掉，实际关掉 ${JSON.stringify(closed)}`)
})

test('回归：第一次 await 之前就被卸载时，一个域都不该打开', async () => {
  const closed = []
  const facility = {
    async open(spec) {
      return {
        name: spec.name,
        global: { get: () => undefined, set: async () => {} },
        table: () => makeTable(new Map()),
        close: async () => {
          closed.push(spec.name)
        },
      }
    },
  }

  const ctx = fakeCtx(facility)
  const pending = openRadarStore(ctx, {})
  // 同步段刚跑完就卸载（此时还在 await loadSpecBuilders()）。
  await ctx.disposers[0].dispose()

  const store = await pending
  assert.equal(store.ok, false)
  assert.match(store.reason, /已被卸载/)
  assert.deepEqual(closed, [], '什么都没打开，也就不该有关闭动作')
})

test('回归：关闭钩子必须把关闭的 promise 交回 Cordis（否则宿主能在域关掉前走完 teardown）', async () => {
  const facility = fakeFacility()
  const ctx = fakeCtx(facility)
  const store = await openRadarStore(ctx, {})
  assert.equal(store.ok, true)

  const disposer = ctx.disposers.find((entry) => /storage domain close/.test(entry.label))
  assert.ok(disposer, '必须注册释放钩子')
  const returned = disposer.dispose()
  assert.ok(returned instanceof Promise, 'disposer 必须返回 promise，让 Cordis 等它')
  await returned
  assert.equal(facility.closed.length, DOMAINS.length)
})

test('回归：already-open 时关掉上一个实例的遗留句柄并重试一次（自愈，不要求用户重启）', async () => {
  // 真实事故：插件重载后新实例拿到
  //   already-open: domain 'ai_product_radar_sources' is already open
  // 整个存储不可用。修掉泄漏的时序之后仍然留了这道防线 —— 因为只要还有别的时序
  // 能把句柄漏掉，用户看到的就是"重启才能恢复"。域名是本插件独占的，所以
  // 同名域只可能是上一个实例的残留，关掉它是安全的。
  const staleClosed = []
  const liveOpened = []
  /** 已经抛出过 already-open 的域名 —— 每个域名只拦第一次，第二次放行。 */
  const blocked = new Set()
  const facility = {
    async open(spec) {
      if (!blocked.has(spec.name)) {
        blocked.add(spec.name)
        throw Object.assign(new Error(`domain '${spec.name}' is already open`), { code: 'already-open' })
      }
      liveOpened.push(spec.name)
      return {
        name: spec.name,
        global: { get: () => undefined, set: async () => {} },
        table: () => makeTable(new Map()),
        close: async () => {},
      }
    },
    get(name) {
      return {
        name,
        close: async () => {
          staleClosed.push(name)
        },
      }
    },
  }

  const store = await openRadarStore(fakeCtx(facility), {})
  assert.equal(store.ok, true, '遗留句柄被释放后必须能重新打开')
  assert.deepEqual(staleClosed, DOMAINS.map((domain) => domain.name), '每个域名的遗留句柄都要被关掉')
  assert.deepEqual(liveOpened, DOMAINS.map((domain) => domain.name), '每个域都要被重新打开')
})

test('回归：already-open 且拿不到遗留句柄时，如实失败并给出可行动的提示', async () => {
  const facility = {
    async open(spec) {
      throw Object.assign(new Error(`domain '${spec.name}' is already open`), { code: 'already-open' })
    },
    // 没有 get()：模拟设施不提供诊断接口的情况。
  }

  const store = await openRadarStore(fakeCtx(facility), {})
  assert.equal(store.ok, false)
  // 必须区分"HMR 泄漏"和"数据损坏" —— 前者重启就能好，后者不是。
  assert.match(store.reason, /already-open/)
  assert.match(store.reason, /重启 Harness/)
  assert.match(store.reason, /数据没有损坏/)
})

test('回归：非 already-open 的打开失败不做自愈尝试（不许掩盖真实错误）', async () => {
  let attempts = 0
  let getCalls = 0
  const facility = {
    async open(spec) {
      attempts += 1
      throw Object.assign(new Error('后端拒绝'), { code: 'malformed-medium' })
    },
    get(name) {
      getCalls += 1
      return { name, close: async () => {} }
    },
  }

  const store = await openRadarStore(fakeCtx(facility), {})
  assert.equal(store.ok, false)
  assert.match(store.reason, /malformed-medium/)
  assert.equal(attempts, 1, '其它错误不该被重试掩盖')
  assert.equal(getCalls, 0, '其它错误不该去碰设施的诊断接口')
})
