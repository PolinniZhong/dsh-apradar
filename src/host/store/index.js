/**
 * 雷达的持久化存储：打开四个域、维护元状态、把失败原因如实交出去。
 *
 * ## 两条路径，一个结论
 *
 * `ctx.storageDomain` 是官方公开的领域存储设施（`dsh-storage-domain` 在 base bundle 里
 * 以 `backend: json` 启用，见 `dsh-base/cordis.patch.yml:173-176`）。本模块启动时：
 *
 *   1. **优先**尝试 `await import('@deepseek-ai/dsh-storage-domain')`，用官方
 *      `defineDomain` / `domainTable` 构造 spec ——这是首选路径，`mode: 'official'`。
 *   2. 该包不可解析时（本机实测：`link:` 安装的插件无法从自身路径解析
 *      `@deepseek-ai/*`，详见 `schema.js` 顶部的论证），退回 `domains.js` 里的
 *      **同形状字面量**，`mode: 'inline'`。
 *
 * 两条路径最终调用的是同一个 `ctx.storageDomain.open(spec)`，因此"持久化到底成不成立"
 * 只有一个判据：**`openCount` 是否真的跨进程累加**。
 *
 * ## 失败不许假装成功
 *
 * 打开失败时本模块**不抛**给路由层，而是返回一个 `ok: false` 的句柄，把后端给出的
 * 原始错误消息原样放进 `reason`。路由据此报 `persisted: false`，界面必须显示失败态，
 * 绝不能显示"已保存"。
 *
 * @module dsh-apradar/src/host/store
 */

import { DOMAINS, SCHEMA_VERSION, sourcesDomain } from './domains.js'
import { planMigration, runMigrations } from './migrate.js'

/** 官方 helper 包名。 */
const OFFICIAL_PACKAGE = '@deepseek-ai/dsh-storage-domain'

/** 表名 → 域名的反查表。服务层只按表名操作，不需要知道背后是哪个域。 */
const TABLE_TO_DOMAIN = new Map()
for (const domain of DOMAINS) {
  for (const tableName of Object.keys(domain.tables)) {
    TABLE_TO_DOMAIN.set(tableName, domain.name)
  }
}

/** 全部表名。 */
export const TABLE_NAMES = [...TABLE_TO_DOMAIN.keys()]

/**
 * 尝试取得官方 spec 构造器。
 *
 * 刻意用**动态** `import()` 而不是顶层静态 import：静态 import 会让整个插件在
 * 解析期就失败，连"插件能加载但存储不可用"这个如实降级态都表达不出来。
 * 这也是全仓库**唯一**被允许的动态 `import()`，`test/gate-scan.mjs` 会精确放行它。
 *
 * @returns {Promise<{mode: 'official', defineDomain: Function, domainTable: Function} | {mode: 'inline', reason: string}>}
 */
export async function loadSpecBuilders() {
  try {
    const mod = await import(OFFICIAL_PACKAGE)
    if (typeof mod.defineDomain !== 'function' || typeof mod.domainTable !== 'function') {
      return { mode: 'inline', reason: `${OFFICIAL_PACKAGE} 存在但不导出 defineDomain / domainTable` }
    }
    return { mode: 'official', defineDomain: mod.defineDomain, domainTable: mod.domainTable }
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code
    const detail = code ? `${code}: ${String(/** @type {Error} */ (error).message)}` : String(error)
    return { mode: 'inline', reason: `无法解析 ${OFFICIAL_PACKAGE}（${detail}），改用同形状字面量 spec` }
  }
}

/**
 * 用一个域的声明构造 spec。
 *
 * 官方路径下逐表调用 `domainTable()`；内联路径下直接用字面量。两条路径产出的
 * 结构必须一致，否则"两种模式行为相同"这个前提就不成立了 —— 所以表循环只写一次。
 *
 * @param {object} domain 域声明
 * @param {{mode: 'official'|'inline', defineDomain?: Function, domainTable?: Function}} builders
 * @returns {object} spec
 */
export function buildDomainSpec(domain, builders) {
  if (builders.mode !== 'official' || !builders.defineDomain || !builders.domainTable) {
    return domain
  }
  /** @type {Record<string, object>} */
  const tables = {}
  for (const [tableName, table] of Object.entries(domain.tables)) {
    tables[tableName] = builders.domainTable(table.valueSchema)
  }
  return builders.defineDomain({
    name: domain.name,
    version: domain.version,
    // `layout` / `invalidRecords` 缺省时不要显式传 `undefined`：官方 helper 对
    // 「传了 undefined」和「没传」的处理不一定一样，少传更安全。
    ...(domain.layout ? { layout: domain.layout } : {}),
    ...(domain.invalidRecords ? { invalidRecords: domain.invalidRecords } : {}),
    global: domain.global,
    tables,
  })
}

/**
 * 把存储打开结果压成给 Client 看的、**不含内部路径**的状态对象。
 * @param {object} store 已打开的存储句柄（`openRadarStore` 的返回值）
 * @returns {object}
 */
export function describeStore(store) {
  if (!store.ok) {
    return {
      persisted: false,
      domain: sourcesDomain.name,
      schemaVersion: SCHEMA_VERSION,
      specMode: store.specMode,
      reason: store.reason,
    }
  }
  const state = store.state()
  return {
    persisted: true,
    domain: sourcesDomain.name,
    domains: DOMAINS.map((d) => d.name),
    schemaVersion: state.schemaVersion,
    currentSchemaVersion: SCHEMA_VERSION,
    specMode: store.specMode,
    backend: 'json',
    openCount: state.openCount,
    firstOpenedAt: state.firstOpenedAt ?? null,
    lastOpenedAt: state.lastOpenedAt ?? null,
    lastRefreshAt: state.lastRefreshAt ?? null,
    counts: store.counts(),
    migration: store.migration,
  }
}

/**
 * 取存储设施，**不触发 Cordis 的 inject 守卫**。
 *
 * 实测教训（隔离 Profile 首次加载即复现）：直接读 `ctx.storageDomain` 在未 `inject`
 * 时**会抛** `Error: cannot get property "storageDomain" without inject`，而这个异常
 * 发生在 `apply()` 之后的异步续体里，会把整个宿主进程打成 `fatal load failure`。
 * Cordis 提供的免 inject 读法是 `ctx.get(name)`（`@deepseek-ai/cordis/lib/types/reflect.d.ts`：
 * "Read a service from the store without the inject requirement"），`strict` 默认为
 * `true`，即只在提供方 fiber 处于活动状态时才返回实现。
 *
 * @param {object} ctx Cordis 上下文
 * @returns {object | undefined} 设施，缺失时为 `undefined`
 */
function resolveFacility(ctx) {
  if (typeof ctx?.get === 'function') return ctx.get('storageDomain')
  // 单测里的假 ctx 直接挂着属性；真实 ctx 不会走到这一支。
  try {
    return ctx?.storageDomain
  } catch {
    return undefined
  }
}

/**
 * 打开雷达存储。
 *
 * **契约：永不抛出。** 无论后端、schema、迁移还是 Cordis 上下文出什么问题，
 * 都返回一个 `ok: false` 的句柄，让界面能显示失败原因 —— 绝不让宿主进程因为
 * 本插件的存储问题启动失败。
 *
 * @param {object} ctx Cordis 上下文（只用 `storageDomain` 与可选的 `effect`）
 * @param {{now?: () => string, log?: (message: string) => void}} [options]
 * @returns {Promise<object>} 句柄；失败时 `{ok: false, specMode, reason}`
 */
export async function openRadarStore(ctx, options = {}) {
  try {
    return await openRadarStoreInner(ctx, options)
  } catch (error) {
    const code = /** @type {{code?: string}} */ (error)?.code
    return {
      ok: false,
      specMode: 'unknown',
      reason: `存储初始化异常（${code ? `${code}: ` : ''}${String(/** @type {Error} */ (error)?.message ?? error)}）`,
    }
  }
}

/**
 * {@link openRadarStore} 的实际实现。异常由外层统一兜住。
 * @param {object} ctx Cordis 上下文
 * @param {{now?: () => string, log?: (message: string) => void}} options
 * @returns {Promise<object>}
 */
async function openRadarStoreInner(ctx, options) {
  const now = options.now ?? (() => new Date().toISOString())
  const log = options.log ?? (() => {})

  /** @type {Map<string, any>} 域名 → 已打开的 domain 句柄 */
  const opened = new Map()
  /** @type {boolean} 本次打开期间插件是否已被卸载（HMR 重载或停用） */
  let disposed = false

  // ⚠️ 释放钩子必须在**第一个 await 之前**注册。
  //
  // 这里踩过一个真实的坑（真实 Desktop 宿主实测）：原先把 `ctx.effect(...)` 放在所有
  // `await facility.open(...)` 之后。HMR 重载时，**上一个实例的 in-flight promise 会
  // 继续跑完**，而那时它的 fiber 早已被释放 —— 于是这个 effect 注册到一个死掉的
  // 作用域上，disposer 永远不会被调用，**域句柄就永久泄漏**。下一个实例打开同一个域
  // 时拿到 `already-open: domain '…' is already open`，整个存储不可用
  // （读写全停，界面只能显示失败原因）。
  //
  // 注册提前到同步段之后还不够：卸载可能发生在"句柄还没 open 出来"的那一瞬间。
  // 所以还要一个 `disposed` 标记，在每次 open 之后自查，把已经拿到手的句柄立刻关掉。
  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => {
        disposed = true
        return closeAll(opened)
      },
      'dsh-apradar: storage domain close',
    )
  }

  const builders = await loadSpecBuilders()
  if (builders.mode === 'inline') log(builders.reason)

  // 在第一次 await 之前就已卸载：连设施都不用去找了。
  if (disposed) {
    return { ok: false, specMode: builders.mode, reason: '存储初始化期间插件已被卸载，本次没有打开任何域' }
  }

  const facility = resolveFacility(ctx)
  if (!facility || typeof facility.open !== 'function') {
    return {
      ok: false,
      specMode: builders.mode,
      reason: 'ctx.storageDomain 不可用（当前 Profile 未挂载 storage-domain 设施）',
    }
  }

  /**
   * 打开一个域；遇到 `already-open` 时**先把上一个实例遗留的句柄关掉再重试一次**。
   *
   * 为什么敢关别人的句柄：这四个域名（`ai_product_radar_*`）由本插件独占，
   * 设施里挂着同名域的只可能是**本插件上一个实例**的残留 —— 而残留的来源是
   * 插件重载时 in-flight 的打开落在了已释放的 fiber 上（见本函数顶部的长注释，
   * 那是已经修掉的那一半）。这里是第二道防线：即使还有别的时序把它漏掉，
   * 下一次重载也能自己恢复，而不是要求用户重启 Harness。
   *
   * 安全性来自三点：①只对**本插件自己的域名**做；②只在错误码确实是
   * `already-open` 时做；③`facility.get(name)` 是官方公开的诊断接口
   * （`dsh-storage-domain` 的 `DomainFacility.get(name)`），返回的句柄
   * `close()` 是幂等的、并且会真正释放底层 unit。
   *
   * @param {{name: string}} domain 域声明
   * @param {object} spec 真实 spec
   * @returns {Promise<any>} 域句柄
   */
  const openDomainRecovering = async (domain, spec) => {
    try {
      return await facility.open(spec)
    } catch (error) {
      if (String(/** @type {{code?: string}} */ (error)?.code) !== 'already-open') throw error
      const stale = typeof facility.get === 'function' ? facility.get(domain.name) : undefined
      if (!stale || typeof stale.close !== 'function') throw error
      log(`域 ${domain.name} 已被上一个实例占用 —— 关掉遗留句柄后重试一次`)
      await stale.close()
      return await facility.open(spec)
    }
  }

  for (const domain of DOMAINS) {
    const spec = buildDomainSpec(domain, builders)
    /** @type {any} */
    let handle
    try {
      handle = await openDomainRecovering(domain, spec)
    } catch (error) {
      // 已经打开的先关掉：半个存储比没有存储更难排查。
      await closeAll(opened)
      const code = /** @type {{code?: string, detail?: unknown}} */ (error)?.code
      const detail = code ? `${code}: ${String(/** @type {Error} */ (error).message)}` : String(error)
      // `already-open` 这个码值得单独翻译：它不是"你的数据坏了"，而是**上一个插件实例
      // 没有把域还回来**（HMR 重载时 in-flight 的打开落在了已释放的 fiber 上，见本文件
      // 顶部那段长注释；已在 store/index.js 的释放钩子里修掉）。用户能做的只有重启宿主，
      // 所以必须把这句话直接说出来 —— 否则看到的是一个像数据损坏的成功误导。
      const hint = String(detail).includes('already-open')
        ? '这个域被上一个插件实例占着，且自动释放没有成功（插件重载时的已知时序问题）。重启 Harness 即可恢复；你的数据没有损坏。'
        : ''
      return {
        ok: false,
        specMode: builders.mode,
        reason: `打开域 ${domain.name} 失败（${detail}）${hint ? `。${hint}` : ''}`,
      }
    }
    opened.set(domain.name, handle)
    if (disposed) {
      // 卸载发生在 open 落地与注册之间：把刚拿到的句柄关掉，否则它同样会泄漏。
      await closeAll(opened)
      return { ok: false, specMode: builders.mode, reason: '存储初始化期间插件已被卸载，已关闭本次打开的域' }
    }
  }

  // 句柄生命周期归调用方所有；facility 不把 domain 绑到任何 consumer fiber。
  // 释放钩子在最上面注册（见那里的长注释），这里的 `closeAll` 会把它返回给 Cordis，
  // 不能写成 `() => void closeAll(...)`：那会让卸载时的关闭变成"发出去就不管"，
  // 宿主可以在域真正关掉之前就走完 teardown。

  const sourcesHandle = opened.get(sourcesDomain.name)

  const readState = () => {
    const stored = sourcesHandle.global.get()
    // 老数据的字段可能缺失：用 initial 补齐，而不是把 undefined 交给校验器。
    return { ...sourcesDomain.global.initial, ...stored }
  }

  const before = readState()

  // 版本高于本插件：**拒绝自动降级**。写下去只会把用户的数据改成旧格式。
  if (typeof before.schemaVersion === 'number' && before.schemaVersion > SCHEMA_VERSION) {
    await closeAll(opened)
    return {
      ok: false,
      specMode: builders.mode,
      reason: `本地数据版本（${before.schemaVersion}）高于当前插件支持的版本（${SCHEMA_VERSION}）`,
    }
  }

  const plan = planMigration(before.schemaVersion ?? SCHEMA_VERSION, SCHEMA_VERSION)

  /** @type {{from: number, to: number, applied: number, reason?: string} } */
  const migration = {
    from: before.schemaVersion ?? SCHEMA_VERSION,
    to: SCHEMA_VERSION,
    applied: 0,
  }

  if (!plan.ok) {
    await closeAll(opened)
    return { ok: false, specMode: builders.mode, reason: `schema 迁移不可用（${plan.reason}）`, migration }
  }

  if (plan.steps.length > 0) {
    try {
      await runMigrations(plan.steps, { domain: sourcesDomain, log })
      migration.applied = plan.steps.length
    } catch (error) {
      await closeAll(opened)
      return { ok: false, specMode: builders.mode, reason: `schema 迁移失败（${String(error)}）`, migration }
    }
  }

  const openedAt = now()
  const nextGlobal = {
    ...before,
    schemaVersion: SCHEMA_VERSION,
    openCount: (before.openCount ?? 0) + 1,
    firstOpenedAt: before.firstOpenedAt ?? openedAt,
    lastOpenedAt: openedAt,
  }

  try {
    // 先由后端落盘，成功后才更新内存；被拒的后端写不会让内存与介质分叉。
    await sourcesHandle.global.set(nextGlobal)
  } catch (error) {
    await closeAll(opened)
    return { ok: false, specMode: builders.mode, reason: `写入 global 失败（${String(error)}）`, migration }
  }

  /**
   * 按表名取底层 KvTable。
   * @param {string} tableName 表名
   * @returns {any}
   */
  function tableOf(tableName) {
    const domainName = TABLE_TO_DOMAIN.get(tableName)
    if (!domainName) throw new Error(`未知表名：${tableName}`)
    return opened.get(domainName).table(tableName)
  }

  return {
    ok: true,
    specMode: builders.mode,
    migration,
    domainName: sourcesDomain.name,
    domainNames: DOMAINS.map((d) => d.name),
    state: readState,

    /** 各表的记录数，供 `GET /apradar/state` 展示。 */
    counts() {
      /** @type {Record<string, number>} */
      const out = {}
      for (const tableName of TABLE_NAMES) out[tableName] = tableOf(tableName).size
      return out
    },

    /** 同步枚举一张表的全部记录（`entries()` 是快照，迭代期间写入落地不影响它）。 */
    all(tableName) {
      return [...tableOf(tableName).entries()].map(([key, value]) => ({ key, ...value }))
    },

    /** 同步读一条记录。 */
    get(tableName, id) {
      const value = tableOf(tableName).get(id)
      return value === undefined ? undefined : { key: id, ...value }
    },

    /** 写一条记录。**写失败会抛出**，调用方必须处理，不得假装成功。 */
    async put(tableName, record) {
      const id = record?.id
      if (!id) throw new Error(`记录缺少 id（表 ${tableName}）`)
      await tableOf(tableName).put(id, record)
      return record
    },

    /**
     * 删一条记录。返回是否真的删掉了。
     *
     * 存在性判断必须用 `table.get(id) === undefined`，**不能**用
     * `table.keys().includes(id)`：真实的 storage-domain 后端里 `keys()` 返回的
     * 不是数组（实测报错 `table.keys(...).includes is not a function`）。
     * 这个缺陷曾让 `DELETE /sources/:id` **从来没有成功过**，而且因为它在
     * `deleteSource()` 删完从属记录之后才抛出，每次点击还会无条件删掉那个来源的
     * 全部快照与变化记录 —— 即"删除失败 + 数据已损坏"。`get()` 是本文件别处
     * 已经在用的、经过验证的 API。
     */
    async del(tableName, id) {
      const table = tableOf(tableName)
      if (table.get(id) === undefined) return false
      await table.delete(id)
      return true
    },

    /** 批量写。任一条失败即抛出 —— 由调用方决定是整体回滚还是报告部分写入。 */
    async putMany(tableName, records) {
      for (const record of records) await this.put(tableName, record)
      return records.length
    },

    /**
     * 标记「刚刚完成一次手动刷新」。
     *
     * 写失败**不**抛出：刷新本身已经成功，把刷新时间写不进去不该让用户看到失败。
     * 但也不吞掉 —— 通过 `log` 留痕。
     */
    async markRefreshed() {
      try {
        const current = readState()
        await sourcesHandle.global.set({ ...current, lastRefreshAt: now() })
      } catch (error) {
        log(`写入 lastRefreshAt 失败：${String(error)}`)
      }
    },

    listSources: () => [...tableOf('sources').entries()].map(([key, value]) => ({ key, ...value })),
    sourceCount: () => tableOf('sources').size,
    close: () => closeAll(opened),
  }
}

/**
 * 关闭一批已打开的域，忽略单个失败。
 * @param {Map<string, any>} opened 域名 → 句柄
 * @returns {Promise<void>}
 */
async function closeAll(opened) {
  for (const handle of opened.values()) {
    try {
      await handle.close()
    } catch {
      // 关闭失败没有补救手段，也不该掩盖真正的错误原因。
    }
  }
  opened.clear()
}
