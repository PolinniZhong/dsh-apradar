/**
 * 服务层：把存储、适配器、出网网关接成产品语义（SDD §6）。
 *
 * 这一层是**唯一**有权改数据的地方 —— 路由只做参数校验与信封包装，适配器是纯函数，
 * 网关只负责出网。三条不变量在这里落地：
 *
 *  1. **失败不产生结论**。抓取失败 / 解析失败时，快照不动、变化记录不建，
 *     只更新来源的失败状态。绝不允许出现「没有更新」这种由失败推出来的说法。
 *  2. **首次抓取不产生变化记录**（`baseline: true`）。没有上一版本就没有「变化」。
 *  3. **幂等**。同一条内容重复抓到只会有一条变化记录，其余只更新 `lastSeenAt`。
 *
 * 全过程**不含任何模型调用**（SDD §4.4）——变化判定只有 sha256、集合差与文本行比对。
 *
 * @module dsh-apradar/src/host/service
 */

import {
  AUTO_DISABLE_FAILURE_STREAK,
  FETCH_CONCURRENCY,
  LIMITS_SNAPSHOT,
  MAX_CHANGES,
  MAX_EXCERPT_CHARS,
  MAX_ITEM_IDS,
  MAX_OPPORTUNITIES,
  MAX_SNAPSHOT_HISTORY,
  MAX_SNAPSHOT_VIEW_CHARS,
  MAX_SOURCES,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  capList,
  clampText,
  mapWithConcurrency,
  normalizeIntervalMinutes,
  planTrim,
  retentionOf,
} from './limits.js'
import { CHANGE_STATUSES, OPPORTUNITY_STATUSES, isValidRecordId } from './store/domains.js'
import { renderOpportunitiesMarkdown } from './export.js'
import { RadarError, notFoundError, radarError, toWireError } from './errors.js'
import { getAdapter, listAdapters, listTemplates, requireAdapter, resolveRequests } from './adapters/index.js'
import { assertFetchableUrl } from './fetch/url.js'
import { normalizeText } from './normalize.js'
import { contentFingerprint, dedupeKey as makeDedupeKey, hashId, itemFingerprint } from './fingerprint.js'
import { diffItems, diffText } from './diff.js'

/** 变化记录里允许客户端写入的字段。**白名单**，其余一律 `FIELD_NOT_WRITABLE`。 */
export const CHANGE_WRITABLE_FIELDS = ['status', 'userNote']

/** 机会记录里允许客户端写入的字段。 */
export const OPPORTUNITY_WRITABLE_FIELDS = ['title', 'projectRef', 'judgment', 'questions', 'nextAction', 'status']

/** 来源记录里允许客户端写入的字段（`type` 只在创建时可写）。 */
export const SOURCE_WRITABLE_FIELDS = ['name', 'config', 'enabled', 'intervalMinutes']

/**
 * `POST /sources` 允许的字段。
 *
 * 创建路径也必须走白名单：**只认识白名单、其余静默忽略**的接口会把客户端的一个拼写
 * 错误变成"保存成功但内容丢了" —— 对一个用来记录判断的工具，这是最坏的一种失败
 * （用户以为写进去了，几天后回来发现是空的）。宁可当场报 `FIELD_NOT_WRITABLE`。
 */
export const SOURCE_CREATE_FIELDS = ['type', ...SOURCE_WRITABLE_FIELDS]

/** `POST /opportunities` 允许的字段（比 PATCH 多两个关联键）。 */
export const OPPORTUNITY_CREATE_FIELDS = [...OPPORTUNITY_WRITABLE_FIELDS, 'changeId', 'sourceId']

/** 机会标题长度上限。 */
const MAX_OPPORTUNITY_TITLE_CHARS = 200
/** 机会自由文本长度上限。 */
const MAX_JUDGMENT_CHARS = 4000
/** 单个待验证问题的长度上限。 */
const MAX_QUESTION_CHARS = 300
/** 待验证问题的条数上限。 */
const MAX_QUESTIONS = 20
/** 备注长度上限。 */
const MAX_USER_NOTE_CHARS = 2000
/** 来源名长度上限。 */
const MAX_SOURCE_NAME_CHARS = 80
/** 失败原因文案长度上限 —— 只留能读懂的短句，避免把后端细节写进存储。 */
const MAX_ERROR_MESSAGE_CHARS = 300

/**
 * 给一条新记录挑一个**没被占用**的 id。
 *
 * 为什么不能直接用派生 id：本插件的 id 是创建时由内容派生的，而**改内容时刻意
 * 不重算 id**（快照与变化记录都引用它，重算会产生孤儿）。于是库里可能躺着一条
 * id 与它当前内容已经脱钩的旧记录，而那个 id 恰好会等于"按旧内容新建"的 id。
 *
 * 真实事故（2026-10-09，真实宿主）：一条来源被 PATCH 改到 simonwillison，
 * id 仍是当初按 techcrunch 派生的 `src_1c338a28c22616e8`；用户随后重新添加
 * techcrunch 时，判重只看当前地址（techcrunch 确实无人占用，放行），新记录的
 * 派生 id 又等于那条旧记录的 id → `store.put` **按键覆盖**，simonwillison 来源
 * 连同它的全部历史一起消失。
 *
 * 所以"判重"与"分配 id"是两件必须分开做的事：前者管逻辑上重不重复，后者管
 * 物理上覆不覆盖。规则：优先用派生 id，被占用就追加 `-2`、`-3`… 取第一个空闲的。
 * **绝不覆盖已有记录，也绝不改动已有记录的 id。**
 *
 * @param {string} preferred 派生出来的首选 id
 * @param {Array<{id?: string}>} existing 现有记录
 * @returns {string} 可安全写入的 id
 */
export function allocateId(preferred, existing) {
  const taken = new Set(
    (Array.isArray(existing) ? existing : [])
      .map((item) => item?.id)
      .filter((value) => typeof value === 'string' && value !== ''),
  )
  if (typeof preferred !== 'string' || preferred === '') {
    throw radarError('INTERNAL', { message: '无法为记录派生 id' })
  }
  if (!taken.has(preferred)) return preferred
  for (let suffix = 2; suffix <= 999; suffix += 1) {
    const candidate = `${preferred}-${suffix}`
    if (!taken.has(candidate)) return candidate
  }
  throw radarError('INTERNAL', { message: '无法为记录分配一个空闲 id' })
}

/**
 * 创建一个服务实例。
 *
 * @param {object} deps 依赖
 * @param {object} deps.store `openRadarStore()` 返回的句柄
 * @param {{available: boolean, reason?: string, fetch: Function}} deps.gateway 出网网关
 * @param {() => number} [deps.now] 当前时间（epoch 毫秒）
 * @param {(message: string) => void} [deps.log] 日志
 * @returns {object} 服务
 */
export function createService({ store, gateway, now = () => Date.now(), log = () => {} }) {
  /**
   * 正在刷新的来源 id。**同一个来源永不并发**（手动与定时共用这一份集合）。
   * @type {Set<string>}
   */
  const inFlight = new Set()

  /**
   * 调度器状态的提供者。由装配层（`index.js`）在调度器建好后注入。
   * 默认为 null → `state()` 会如实回报"调度器未挂载"。
   * @type {null | (() => object)}
   */
  let schedulerProvider = null
  /**
   * 运行时能力报告（P1-06 的 V4 验证需要它落地，不只是写在文档里）。
   *
   * 由 `index.js` 注入：`ctx.typert` 这类设施**不能**写进 `ctx.inject`（设施不出现
   * 时 inject 回调永不执行，插件会以"完全不存在"的方式失败），只能主动探测后把
   * 探测结果如实报出来。
   */
  let runtimeProvider = null

  /**
   * 注入调度器状态提供者（P1-01）。
   * @param {null | (() => object)} provider 返回调度器状态的函数
   * @returns {void}
   */
  function setScheduler(provider) {
    schedulerProvider = typeof provider === 'function' ? provider : null
  }

  /**
   * @param {() => object} provider 返回运行时能力报告的函数
   */
  function setRuntime(provider) {
    runtimeProvider = typeof provider === 'function' ? provider : null
  }

  /**
   * 断言存储可用。不可用时抛的是 `STORAGE_OPEN_FAILED` —— 路由会把它变成
   * `ok:false` 的信封，界面据此显示失败态，而不是显示空列表冒充"没有数据"。
   * @returns {object}
   */
  function requireStore() {
    if (!store || !store.ok) {
      throw radarError('STORAGE_OPEN_FAILED', { reason: store?.reason ?? '存储尚未初始化' })
    }
    return store
  }

  /**
   * 取一张表的全部记录。
   * @param {string} table 表名
   * @returns {object[]}
   */
  function all(table) {
    return requireStore().all(table)
  }

  /**
   * 按 id 规范化分页参数。
   * @param {{offset?: unknown, limit?: unknown}} query 查询串
   * @returns {{offset: number, limit: number}}
   */
  function pagination(query = {}) {
    const rawOffset = Number(query.offset)
    const rawLimit = Number(query.limit)
    const offset = Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0
    const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), PAGE_SIZE_MAX) : PAGE_SIZE_DEFAULT
    return { offset, limit }
  }

  /**
   * 把「最多返回几条」规范化到 `[1, max]`。
   *
   * 快照历史的条数上限与列表分页**不是一回事**：分页上限是 `PAGE_SIZE_MAX`（100），
   * 而快照历史最多只有保留上限那么多份，用两套常量表达两件事，避免以后调其中一个
   * 时悄悄改变另一个的行为。
   *
   * @param {unknown} value 原始值
   * @param {number} max 上限
   * @returns {number} 归一化后的条数
   */
  function clampLimit(value, max) {
    const raw = Number(value)
    if (!Number.isFinite(raw) || raw <= 0) return max
    return Math.min(Math.floor(raw), max)
  }

  /**
   * 从一条来源记录推导界面要显示的状态。
   *
   * 「从未检查」与「已停用」都是**推导**出来的，不写进存储 —— 存冗余状态一定会漂移。
   * @param {object} source 来源记录
   * @returns {'never'|'ok'|'failed'|'disabled'}
   */
  function deriveSourceStatus(source) {
    if (source.enabled === false) return 'disabled'
    if (!source.lastStatus) return 'never'
    return source.lastStatus === 'ok' ? 'ok' : 'failed'
  }

  /**
   * 按 `fetchedAt` 降序取某个来源的快照。
   * @param {string} sourceId 来源 id
   * @returns {object[]}
   */
  function snapshotsOf(sourceId) {
    return all('snapshots')
      .filter((snap) => snap.sourceId === sourceId)
      .sort((a, b) => b.fetchedAt - a.fetchedAt || (a.id < b.id ? 1 : -1))
  }

  /**
   * 全部变化记录的 `dedupeKey` 集合，用于幂等去重。
   * @returns {Map<string, object>}
   */
  function dedupeIndex() {
    /** @type {Map<string, object>} */
    const index = new Map()
    for (const change of all('changes')) {
      if (typeof change.dedupeKey === 'string' && change.dedupeKey) index.set(change.dedupeKey, change)
    }
    return index
  }

  /**
   * 把一次刷新失败如实写进来源记录。
   *
   * **不碰快照、不建变化记录**，也不改 `lastSuccessAt` —— 那是「上次成功」的事实。
   * @param {object} source 来源记录
   * @param {unknown} error 捕获到的错误
   * @returns {Promise<object>} 更新后的来源记录
   */
  async function recordFailure(source, error) {
    const wire = toWireError(error)
    const at = now()
    const streak = (typeof source.failureStreak === 'number' ? source.failureStreak : 0) + 1
    const next = {
      ...source,
      lastCheckedAt: at,
      lastStatus: 'failed',
      failureStreak: streak,
      lastError: {
        code: wire.code,
        message: clampText(wire.message, MAX_ERROR_MESSAGE_CHARS),
        at,
      },
      updatedAt: at,
    }
    // 连续失败到阈值 → 自动停用。**必须留下原因**：静默停用和静默丢弃数据是同一种
    // 失职，用户会以为"来源还在跑，只是没有更新"。
    if (next.enabled !== false && streak >= AUTO_DISABLE_FAILURE_STREAK) {
      next.enabled = false
      next.autoDisabledAt = at
      next.autoDisabledReason = `连续 ${streak} 次刷新失败，已自动停用（最近一次：${next.lastError.code}）`
    }
    try {
      await store.put('sources', next)
    } catch (writeError) {
      // 连失败状态都写不进去：如实抛出，让路由报 STORAGE_WRITE_FAILED。
      throw radarError('STORAGE_WRITE_FAILED', { cause: String(writeError) })
    }
    return next
  }

  /**
   * 把抓取结果转成参与指纹与差异的条目。
   * @param {object} feed 适配器解析结果
   * @returns {object[]}
   */
  function toDiffItems(feed) {
    const items = Array.isArray(feed?.items) ? feed.items : []
    return items.slice(0, MAX_ITEM_IDS).map((item) => {
      const title = typeof item?.title === 'string' ? item.title : ''
      const text = typeof item?.text === 'string' ? item.text : ''
      return {
        itemId: typeof item?.itemId === 'string' ? item.itemId : '',
        title,
        text,
        url: item?.url ?? null,
        publishedAt: typeof item?.publishedAt === 'number' ? item.publishedAt : null,
        fingerprint: itemFingerprint({ title, text }),
      }
    })
  }

  /**
   * 计算整份内容的规范化文本。
   *
   * 取「来源标题 + 每条条目的标题与正文」作为一个整体：这样即使站点重排了
   * 条目的顺序，只要内容集合不变，指纹就不变 —— 顺序变化不该被当成内容变化。
   * @param {object} feed 适配器解析结果
   * @param {object[]} items 已归一化的条目
   * @returns {{text: string, truncated: boolean, chars: number}}
   */
  function buildNormalizedText(feed, items) {
    const title = typeof feed?.title === 'string' ? feed.title : ''
    const parts = [title]
    for (const item of items) parts.push(`${item.title}\n${item.text}`)
    return normalizeText(parts.join('\n\n'))
  }

  /**
   * 抓一个来源并解析，**不做任何写入**。
   *
   * 抽出来是为了让「添加来源前的测试」与「刷新」走同一条代码路径 ——
   * 否则测试通过而刷新失败这种事迟早会发生。
   *
   * 适配器可以声明多个候选端点（`buildRequests`），这里**按优先级依次尝试**，
   * 第一个抓取并解析成功的就返回。之所以两者都算「成功条件」：本机实测
   * `github.com` 不可达而 `api.github.com` 可达（见 `github-releases.js` 文件头），
   * 反过来也有 API 被限流、Atom 仍可用的情形 —— 任一端点能给出可解析的内容，
   * 这次抓取就是成功的。
   *
   * 全部候选都失败时，抛出**首选端点**的错误（它才是用户应当关注的那个），
   * 并把每个候选的失败原因挂在 `detail.attempts` 里 —— 否则用户只能看到
   * 「第一条路不通」，不知道我们其实已经试过别的。
   *
   * @param {object} source 来源记录（至少要有 `type` 与 `config`）
   * @returns {Promise<{url: string, result: object, feed: object, items: object[], adapter: object, attempts: object[]}>}
   */
  async function fetchAndParse(source) {
    if (!gateway || gateway.available === false) {
      throw radarError('WEB_PROVIDER_ERROR', { reason: gateway?.reason ?? '出网能力不可用' })
    }
    const adapter = requireAdapter(source.type)
    const requests = resolveRequests(adapter, source, source.config)

    /** @type {{url: string, code: string, message: string}[]} */
    const attempts = []
    /** @type {unknown} */
    let primaryError = null

    for (const request of requests) {
      // 地址校验失败属于我们自己的接线错误（或用户配置错误），换端点没有意义，
      // 直接抛出 —— 静默回退会把「插件拼错了 URL」伪装成「网络不通」。
      const url = assertFetchableUrl(request?.url)
      try {
        const result = await gateway.fetch(url)
        const feed = adapter.parse(result, source.config)
        return { url, result, feed, items: toDiffItems(feed), adapter, attempts }
      } catch (error) {
        attempts.push({ url, code: error?.code ?? 'UNKNOWN', message: error?.message ?? String(error) })
        if (primaryError === null) primaryError = error
      }
    }

    // 抛出**首选端点**的错误，而不是最后一条 —— 首选端点才是用户真正想用的那条路，
    // 它的失败原因最接近"我该怎么修"。其余候选的失败只作为诊断信息附上。
    const failure = primaryError ?? radarError('WEB_PROVIDER_ERROR', {})
    if (attempts.length > 1 && failure && typeof failure === 'object') {
      try {
        const detail = failure.detail && typeof failure.detail === 'object' ? failure.detail : {}
        failure.detail = { ...detail, attempts }
      } catch {
        // 错误对象被冻结（或 detail 不可写）时忽略：诊断信息是附加项，
        // 绝不能因为它挂不上去就换掉用户看到的那个错误。
      }
    }
    throw failure
  }

  /**
   * 取 `GET /apradar/meta` 的载荷。
   * @returns {object}
   */
  function meta() {
    return {
      limits: LIMITS_SNAPSHOT,
      adapters: listAdapters(),
      changeStatuses: CHANGE_STATUSES,
      opportunityStatuses: OPPORTUNITY_STATUSES,
      storage: {
        ok: store?.ok === true,
        specMode: store?.specMode ?? 'unknown',
        reason: store?.ok ? null : (store?.reason ?? '存储尚未初始化'),
      },
      /** 变化判定不含模型调用 —— 这一点会显示在界面上，不是内部实现细节。 */
      modelCallsInRefresh: 0,
      /**
       * 定时刷新的能力开关。`available: false` 时界面必须**禁用**间隔选择并
       * 显示 `reason`，而不是让用户设一个永远不会生效的间隔。
       */
      scheduler: schedulerProvider ? schedulerProvider() : { available: false, reason: '调度器未挂载', running: false },
      /**
       * 宿主运行时能力。`typert` 是 P1-06（V4）的判据：代码生成产物是否可用、
       * 本插件是否有生成描述符 —— 结论必须能被现场复核，而不是只写进文档。
       */
      runtime: runtimeProvider ? runtimeProvider() : { typert: { available: false, reason: '运行时能力报告未挂载' } },
    }
  }

  /**
   * `GET /apradar/state`
   * @returns {object}
   */
  function state() {
    const stored = store?.ok ? store.state() : null
    return {
      storage: {
        ok: store?.ok === true,
        specMode: store?.specMode ?? 'unknown',
        reason: store?.ok ? null : (store?.reason ?? '存储尚未初始化'),
        schemaVersion: stored?.schemaVersion ?? null,
        openCount: stored?.openCount ?? 0,
        firstOpenedAt: stored?.firstOpenedAt ?? null,
        lastOpenedAt: stored?.lastOpenedAt ?? null,
        lastRefreshAt: stored?.lastRefreshAt ?? null,
      },
      counts: store?.ok ? store.counts() : { sources: 0, snapshots: 0, changes: 0, opportunities: 0 },
      unreadChanges: store?.ok
        ? all('changes').filter((change) => change.status === 'unread').length
        : 0,
      /**
       * 定时刷新的真实状态。**永远如实回报**，包括"能力不可用"：
       * 一个不能定时刷新的环境必须让用户看到原因，而不是让开关看起来在工作。
       */
      scheduler: schedulerProvider ? schedulerProvider() : { available: false, reason: '调度器未挂载', running: false },
      /** 正在刷新的来源 id —— 界面的"刷新中"直接读它，不去猜。 */
      refreshingSourceIds: [...inFlight],
    }
  }

  /**
   * 把一条来源记录补齐成**完整形状**再对外。
   *
   * 为什么需要：`intervalMinutes` / `failureStreak` 是后加的字段，在那之前落盘的
   * 记录里根本没有这两个键。读路径若把存储里的原样丢出去，客户端就得自己判断
   * "这个键不在"——而客户端的自然写法是 `source.intervalMinutes`，于是同一个概念
   * 在不同代码里会有两种缺失写法（`undefined` 与 `0`），一定有人漏判。
   *
   * 约定：**存储可以稀疏，接口必须完整。** 缺失一律按"关闭定时 / 没失败过"补齐。
   * 刻意**不回写存储**：读操作顺手改用户的磁盘是最容易出事的一类副作用。
   *
   * @param {object} source 存储里的原始记录
   * @returns {object} 补齐后的记录
   */
  function normalizeSourceRecord(source) {
    return {
      ...source,
      intervalMinutes: normalizeIntervalMinutes(source.intervalMinutes),
      failureStreak:
        typeof source.failureStreak === 'number' && source.failureStreak >= 0 ? source.failureStreak : 0,
    }
  }

  /** @returns {object[]} 全部来源，按创建时间倒序 */
  function listSources() {
    return all('sources')
      .map((source) => normalizeSourceRecord(source))
      .map((source) => ({ ...source, status: deriveSourceStatus(source) }))
      .sort((a, b) => b.createdAt - a.createdAt || (a.id < b.id ? -1 : 1))
  }

  /**
   * `POST /apradar/sources`
   * @param {object} input 请求体
   * @returns {Promise<object>} 新来源
   */
  async function createSource(input = {}) {
    assertWritable(input, SOURCE_CREATE_FIELDS)
    const type = typeof input.type === 'string' ? input.type : ''
    const adapter = requireAdapter(type)
    const config = adapter.normalizeConfig(input.config ?? {})

    const name = clampText(typeof input.name === 'string' && input.name.trim() ? input.name.trim() : defaultNameFor(type, config), MAX_SOURCE_NAME_CHARS)
    const canonicalUrl = assertFetchableUrl(adapter.buildRequest({ type, config }, config).url)

    const existing = all('sources')
    /**
     * 给新来源挑一个**没被占用**的 id，而不是直接用它派生出来的那个。
     *
     * 真实事故（2026-10-09，真实宿主）：库里一条记录被 PATCH 改到
     * simonwillison，但它的 id 仍是当初按 techcrunch 派生的
     * `src_1c338a28c22616e8`（改地址时刻意不重算 id）。用户随后**重新添加
     * techcrunch** 时，判重只看 `canonicalUrl`（techcrunch 确实没人占，放行），
     * 而新记录的派生 id 又恰好等于那条旧记录的 id → `store.put` **按键覆盖**，
     * 那条 simonwillison 来源连同它的全部历史一起消失。
     *
     * 所以：判重管"逻辑上重不重复"，分配 id 管"物理上覆不覆盖"，两件事都要做。
     * 规则是优先用派生 id，被占用就追加 `-2`、`-3`… 取第一个空闲的 ——
     * **绝不覆盖已有记录，也绝不改动已有记录的 id**。
     */
    const id = allocateId(hashId('src', `${type}|${canonicalUrl}`), existing)
    /**
     * 判重必须比 **`type` + `canonicalUrl`**，不能比 `id`。
     *
     * 实测踩到的坑（真实宿主，2026-10-09）：`id` 是创建时由 `type|canonicalUrl`
     * 派生的，而 PATCH 改配置时**只更新 `canonicalUrl`、刻意不改 `id`**
     * （id 被快照与变化记录引用，改了就会产生孤儿）。于是 id 会随着每次改地址而
     * 变得过时，用 id 判重会同时犯两个相反的错：
     *   ① 误报：把来源改到新地址后，**原地址反而加不回来了**（明明已经没人用它）；
     *   ② 漏报（更严重）：把来源改到新地址后，**用同一个新地址能再加一个来源** ——
     *      两个来源轮询完全相同的 URL，同一条内容被记成两条变化。
     *
     * 比 URL 则是"当下事实"：谁现在占着这个地址就拦住谁。`type` 也参与比较，
     * 因为同一个 URL 用不同解析器（`rss_atom` vs `html_static`）是合法的两个来源。
     */
    const duplicate = existing.find(
      (source) => source.type === type && source.canonicalUrl === canonicalUrl,
    )
    if (duplicate) {
      throw radarError('CONFLICT', {
        message: '这个来源已经添加过了',
        existingId: duplicate.id,
        existingName: duplicate.name,
      })
    }
    if (existing.length >= MAX_SOURCES) {
      throw radarError('SOURCE_LIMIT_REACHED', { max: MAX_SOURCES })
    }

    const at = now()
    const record = {
      id,
      type,
      name,
      config,
      canonicalUrl,
      enabled: input.enabled === false ? false : true,
      // 定时刷新间隔：0 表示关闭。**始终落在记录上**（哪怕为 0），
      // 这样界面读到的永远是显式值，不需要区分「从没设过」与「设成了关闭」。
      intervalMinutes: normalizeIntervalMinutes(input.intervalMinutes),
      failureStreak: 0,
      createdAt: at,
      updatedAt: at,
    }
    await store.put('sources', record)
    return { ...normalizeSourceRecord(record), status: deriveSourceStatus(record) }
  }

  /**
   * 给一个来源起默认名字。
   * @param {string} type 类型
   * @param {object} config 归一配置
   * @returns {string}
   */
  function defaultNameFor(type, config) {
    /**
     * 优先问适配器自己。
     *
     * 这里原先是一个硬编码的 `if (type === 'github_releases')`，其余类型一律去
     * 配置里找 URL 取主机名。P1-04 加了两个**配置里没有 URL** 的类型之后，那个
     * 写法的后果是：一个 GitHub 仓库动态来源的默认名字变成了字面量
     * `github_repo`（实测，真实宿主），用户在一个叫「github_repo」的卡片下面
     * 根本认不出这是哪个仓库。
     *
     * 名字的规则和配置的形状绑在一起，所以它应该跟适配器放在一起 —— 新增一个
     * 类型的人顺手就会写对，而不是要去 service 里找那张 if 表。
     */
    const adapter = getAdapter(type)
    if (typeof adapter?.defaultName === 'function') {
      const derived = adapter.defaultName(config)
      if (typeof derived === 'string' && derived.trim() !== '') return derived.trim()
    }
    try {
      const url = new URL(config.feedUrl ?? config.pageUrl ?? '')
      return url.hostname
    } catch {
      return type
    }
  }

  /**
   * `PATCH /apradar/sources/:id`
   * @param {string} id 来源 id
   * @param {object} patch 请求体
   * @returns {Promise<object>} 更新后的来源
   */
  async function updateSource(id, patch = {}) {
    const source = all('sources').find((entry) => entry.id === id)
    if (!source) throw radarError('SOURCE_NOT_FOUND', { id })
    assertWritable(patch, SOURCE_WRITABLE_FIELDS)

    const next = { ...source, updatedAt: now() }
    if ('name' in patch) {
      const name = typeof patch.name === 'string' ? patch.name.trim() : ''
      if (!name) throw radarError('VALIDATION_FAILED', { field: 'name', message: '名称不能为空' })
      next.name = clampText(name, MAX_SOURCE_NAME_CHARS)
    }
    if ('enabled' in patch) {
      if (typeof patch.enabled !== 'boolean') throw radarError('VALIDATION_FAILED', { field: 'enabled' })
      next.enabled = patch.enabled
      // 用户手动开关一次，就等于重置了"连续失败"的计数与自动停用标记。
      // 不重置的话，重新启用后第一次失败会立刻又撞到阈值、再次被自动停用 ——
      // 用户会觉得开关坏掉了。
      next.failureStreak = 0
      delete next.autoDisabledAt
      delete next.autoDisabledReason
    }
    if ('intervalMinutes' in patch) {
      next.intervalMinutes = normalizeIntervalMinutes(patch.intervalMinutes)
    }
    if ('config' in patch) {
      const adapter = requireAdapter(source.type)
      const previousConfig = source.config
      next.config = adapter.normalizeConfig(patch.config ?? {})
      next.canonicalUrl = assertFetchableUrl(adapter.buildRequest(source, next.config).url)
      // 地址变了就不再是同一个来源：旧结构指纹必须清掉，否则第一次抓取会被误判为「结构变了」。
      delete next.structureFingerprint
      // 名字还是"上一条地址自动起的"时候，跟着新地址重起一个。
      // 不这么做的话，界面上会出现「名字写着 blog.google、内容全是 techcrunch.com」
      // 这种自相矛盾的来源 —— 用户改过一次地址就会被这个坑绊住。
      if (!('name' in patch) && source.name === defaultNameFor(source.type, previousConfig)) {
        next.name = clampText(defaultNameFor(source.type, next.config), MAX_SOURCE_NAME_CHARS)
      }
    }

    await store.put('sources', next)
    return { ...normalizeSourceRecord(next), status: deriveSourceStatus(next) }
  }

  /**
   * `DELETE /apradar/sources/:id`
   *
   * 同时删掉它的快照与变化记录：留下孤儿记录既占配额也会在列表里显示成挂了的数据。
   * @param {string} id 来源 id
   * @returns {Promise<{deleted: boolean, removedSnapshots: number, removedChanges: number}>}
   */
  async function deleteSource(id) {
    const source = all('sources').find((entry) => entry.id === id)
    if (!source) throw radarError('SOURCE_NOT_FOUND', { id })

    const snapshots = all('snapshots').filter((entry) => entry.sourceId === id)
    const changes = all('changes').filter((entry) => entry.sourceId === id)

    /**
     * **先删来源记录，再删从属记录。**
     *
     * 顺序是有意的：删从属记录是"无条件覆盖"式的批量删除，一旦中途抛错就会留下
     * "历史没了、来源还在"的半损坏状态（真实事故：`store.del` 的存在性判断在真实
     * 后端上抛错，于是每次点击删除都会先把全部快照与变化删干净、再报失败）。
     * 先删来源，最坏情况只是"来源没了、历史还在"——残留数据不可达、可见、可清理，
     * 而且来源不见了界面上就看得出来，不会骗人。
     */
    const removed = await store.del('sources', id)
    if (!removed) throw radarError('SOURCE_NOT_FOUND', { id })
    for (const snapshot of snapshots) await store.del('snapshots', snapshot.id)
    for (const change of changes) await store.del('changes', change.id)

    return { deleted: true, removedSnapshots: snapshots.length, removedChanges: changes.length }
  }

  /**
   * `POST /apradar/sources/test`
   *
   * 只抓一次并解析，**不写任何东西**。这样「测试通过」与「来源可用」之间不会
   * 出现「测试之后什么都没发生」的错觉。
   * @param {{sourceId?: string, type?: string, config?: object}} input 请求体
   * @returns {Promise<object>}
   */
  async function testSource(input = {}) {
    /** @type {object} */
    let source
    if (input.sourceId) {
      const found = all('sources').find((entry) => entry.id === input.sourceId)
      if (!found) throw radarError('SOURCE_NOT_FOUND', { id: input.sourceId })
      source = found
    } else {
      const adapter = requireAdapter(typeof input.type === 'string' ? input.type : '')
      source = { type: adapter.type, config: adapter.normalizeConfig(input.config ?? {}) }
    }

    const started = Date.now()
    try {
      const { url, result, feed, items } = await fetchAndParse(source)
      return {
        ok: true,
        url,
        statusCode: result.statusCode,
        title: feed.title ?? '',
        itemCount: items.length,
        truncated: result.truncated === true,
        elapsedMs: Date.now() - started,
        /** 只回前 3 条的标题作为「我们确实解析到了东西」的证据。 */
        sampleTitles: items.slice(0, 3).map((item) => item.title),
      }
    } catch (error) {
      return { ok: false, url: null, error: toWireError(error) }
    }
  }

  /**
   * `POST /apradar/refresh`
   *
   * @param {{sourceIds?: string[]}} [input] 只刷新指定来源
   * @returns {Promise<object>} 每个来源的结果 + 汇总
   */
  async function refresh(input = {}) {
    const sources = all('sources')
    const requested = Array.isArray(input.sourceIds) && input.sourceIds.length
      ? sources.filter((source) => input.sourceIds.includes(source.id))
      : sources

    /**
     * 「同一个来源不并发」的落地方式：**服务层持有唯一的一份 in-flight 集合**。
     *
     * 放在服务层而不是调度器里：手动刷新与定时刷新走的是同一个 `refresh()`，
     * 因此两边必然共享这份集合；如果各自维护，就会出现"两边都以为自己在刷"。
     * 被跳过的来源不是失败，也不是成功 —— 它是一条明确的 `REFRESH_IN_FLIGHT`。
     */
    const running = requested.filter((source) => source.enabled !== false && inFlight.has(source.id))
    const targets = requested.filter((source) => source.enabled !== false && !inFlight.has(source.id))
    const skipped = requested
      .filter((source) => source.enabled === false)
      .map((source) => ({
        sourceId: source.id,
        name: source.name,
        skipped: true,
        code: source.autoDisabledAt ? 'SOURCE_AUTO_DISABLED' : 'SOURCE_DISABLED',
        autoDisabledReason: source.autoDisabledReason ?? null,
      }))
      .concat(
        running.map((source) => ({
          sourceId: source.id,
          name: source.name,
          skipped: true,
          code: 'REFRESH_IN_FLIGHT',
        })),
      )

    for (const source of targets) inFlight.add(source.id)
    let results
    try {
      results = await mapWithConcurrency(targets, FETCH_CONCURRENCY, async (source) => {
        try {
          return await refreshOne(source)
        } catch (error) {
          const wire = toWireError(error)
          try {
            await recordFailure(source, error)
          } catch (writeError) {
            return { sourceId: source.id, name: source.name, ok: false, error: toWireError(writeError) }
          }
          return { sourceId: source.id, name: source.name, ok: false, error: wire }
        }
      })
    } finally {
      for (const source of targets) inFlight.delete(source.id)
    }

    await applyTrim()
    await store.markRefreshed()

    const flat = [...skipped, ...results]
    return {
      results: flat,
      summary: {
        total: flat.length,
        succeeded: flat.filter((entry) => entry.ok === true).length,
        failed: flat.filter((entry) => entry.ok === false && entry.skipped !== true).length,
        skipped: skipped.length,
        newChanges: flat.reduce((sum, entry) => sum + (entry.newChanges ?? 0), 0),
        /** 被宿主截断的来源数量 —— 被截断时结论必须降级，界面要提示。 */
        truncated: flat.filter((entry) => entry.truncated === true).length,
      },
    }
  }

  /**
   * 定时刷新的入口：只刷新**已到期**的来源（P1-01）。
   *
   * 与手动刷新的区别只有一个 —— 挑哪些来源。落库、写变化、失败处理全部复用
   * `refresh()`，因此不存在"定时路径和手动路径行为不一致"这种最难查的缺陷。
   *
   * @returns {Promise<{results: object[], summary: object, due: string[]}>}
   */
  async function refreshDue() {
    const due = selectDueSources(all('sources'), now())
    if (!due.length) {
      return {
        due: [],
        results: [],
        summary: { total: 0, succeeded: 0, failed: 0, skipped: 0, newChanges: 0, truncated: 0 },
      }
    }
    const report = await refresh({ sourceIds: due.map((source) => source.id) })
    return { ...report, due: due.map((source) => source.id) }
  }

  /**
   * 当前正在刷新的来源 id 列表（供状态接口如实回报）。
   * @returns {string[]}
   */
  function inFlightIds() {
    return [...inFlight]
  }

  /**
   * 刷新单个来源。写入顺序刻意是「先快照、再变化、最后来源状态」：
   * 中途失败时留下的是「有快照但没有对应变化记录」，比「有变化记录却没有快照」
   * 好处理得多（后者会让详情页指向一个不存在的快照）。
   * @param {object} source 来源记录
   * @returns {Promise<object>}
   */
  async function refreshOne(source) {
    const { url, result, feed, items, adapter } = await fetchAndParse(source)
    const normalized = buildNormalizedText(feed, items)
    const at = now()

    const previous = snapshotsOf(source.id)[0] ?? null
    const isBaseline = !previous

    const snapshot = {
      id: `${source.id}_${at.toString(36)}`,
      sourceId: source.id,
      fetchedAt: at,
      url: result.url || url,
      statusCode: result.statusCode,
      contentFingerprint: contentFingerprint(normalized.text),
      normalizedText: normalized.text,
      textChars: normalized.chars,
      textTruncated: normalized.truncated,
      truncated: result.truncated === true,
      title: clampText(feed.title ?? '', 300),
      itemCount: items.length,
      // 刚抓下来的快照必定是全文；被裁剪阶段压成摘要时会改写成 'excerpt'。
      retention: 'full',
      itemIds: items.map((item) => item.itemId).slice(0, MAX_ITEM_IDS),
      itemHashes: items.reduce((acc, item) => {
        acc[item.itemId] = item.fingerprint
        return acc
      }, /** @type {Record<string,string>} */ ({})),
      baseline: isBaseline,
    }

    /** @type {object[]} */
    const pending = []
    if (!isBaseline) {
      const previousItems = previous.itemIds.map((itemId) => ({
        itemId,
        fingerprint: previous.itemHashes?.[itemId] ?? '',
        title: '',
      }))
      const diff = diffItems(previousItems, items)
      pending.push(...buildChanges({ source, snapshot, previous, items, diff, at }))
    }

    // —— 写入 ——
    try {
      await store.put('snapshots', snapshot)

      const index = dedupeIndex()
      const created = []
      for (const candidate of pending) {
        const known = index.get(candidate.dedupeKey)
        if (known) {
          // 幂等：同一条内容再次出现，只更新 `lastSeenAt`，不制造重复记录。
          if (known.status === 'ignored') {
            await store.put('changes', { ...known, lastSeenAt: at })
            continue
          }
          await store.put('changes', { ...known, lastSeenAt: at })
          continue
        }
        await store.put('changes', candidate)
        index.set(candidate.dedupeKey, candidate)
        created.push(candidate)
      }

      const nextSource = {
        ...source,
        lastCheckedAt: at,
        lastSuccessAt: at,
        lastStatus: 'ok',
        // 成功即清零：连续的"失败次数"只有在一串失败中间才有意义。
        failureStreak: 0,
        updatedAt: at,
      }
      delete nextSource.lastError
      delete nextSource.autoDisabledAt
      delete nextSource.autoDisabledReason
      if (typeof adapter.structureFingerprint === 'function') {
        const fingerprint = adapter.structureFingerprint(result, source.config)
        if (fingerprint) nextSource.structureFingerprint = clampText(fingerprint, 2000)
      }
      await store.put('sources', nextSource)

      return {
        sourceId: source.id,
        name: source.name,
        ok: true,
        baseline: isBaseline,
        itemCount: items.length,
        newChanges: created.length,
        truncated: result.truncated === true,
        structureChanged:
          typeof nextSource.structureFingerprint === 'string' &&
          typeof source.structureFingerprint === 'string' &&
          source.structureFingerprint !== nextSource.structureFingerprint,
      }
    } catch (error) {
      // 存储写失败：不能假装成功，也不能把内存与介质说成一致。
      const wrapped = error instanceof RadarError ? error : radarError('STORAGE_WRITE_FAILED', { cause: String(error) })
      await recordFailure(source, wrapped).catch(() => {})
      throw wrapped
    }
  }

  /**
   * 由一次条目级差异生成待写入的变化记录。
   *
   * 规则（SDD §4.4）：
   *  - `added` 非空 → 每条一个 change；
   *  - `modified` 非空 → 每条一个 change；
   *  - **只有 `removed`** → 合并成一条 `summary`；
   *  - 全空 → 不建 change。
   * @param {object} input 输入
   * @returns {object[]} 待写入的变化记录
   */
  function buildChanges({ source, snapshot, previous, items, diff, at }) {
    const byId = new Map(items.map((item) => [item.itemId, item]))
    /** @type {object[]} */
    const out = []

    for (const item of diff.added ?? []) {
      const full = byId.get(item.itemId)
      out.push(
        makeChange({
          source,
          snapshot,
          previous,
          at,
          item: full,
          kind: 'added',
          diffSummary: `新增：${item.title || item.itemId}`,
          diffDetail: { added: [item.title || item.itemId], removed: [], modified: [] },
        }),
      )
    }

    for (const entry of diff.modified ?? []) {
      const full = byId.get(entry.itemId)
      const textDiff = diffText(previous?.normalizedText ?? '', snapshot.normalizedText)
      out.push(
        makeChange({
          source,
          snapshot,
          previous,
          at,
          item: full,
          kind: 'modified',
          diffSummary: `内容有修改：${entry.title || entry.itemId}`,
          diffDetail: {
            added: textDiff.addedLines,
            removed: textDiff.removedLines,
            modified: [entry.itemId],
          },
        }),
      )
    }

    const removed = diff.removed ?? []
    if (removed.length && !(diff.added ?? []).length && !(diff.modified ?? []).length) {
      const titles = removed.map((item) => item.title || item.itemId)
      out.push(
        makeChange({
          source,
          snapshot,
          previous,
          at,
          item: null,
          kind: 'summary',
          diffSummary: `有 ${removed.length} 条从来源中消失（可能是分页或归档，不等于被删除）`,
          diffDetail: { added: [], removed: titles, modified: [] },
        }),
      )
    }

    return out
  }

  /**
   * 组装一条变化记录。
   * @param {object} input 输入
   * @returns {object}
   */
  function makeChange({ source, snapshot, previous, at, item, kind, diffSummary, diffDetail }) {
    const dedupe = makeDedupeKey({
      normalizedUrl: `${source.canonicalUrl}#${item?.itemId ?? 'summary'}`,
      itemFingerprint: item?.fingerprint ?? contentFingerprint(diffSummary),
    })
    return {
      // 用 dedupeKey 派生 id：同一条内容永远得到同一个 id，写入因此天然幂等。
      id: hashId('chg', dedupe),
      sourceId: source.id,
      snapshotId: snapshot.id,
      previousSnapshotId: previous?.id,
      dedupeKey: dedupe,
      title: clampText(item?.title || source.name, 300),
      publishedAt: typeof item?.publishedAt === 'number' ? item.publishedAt : undefined,
      discoveredAt: at,
      kind,
      diffSummary: clampText(diffSummary, 500),
      diffDetail: {
        added: capList(diffDetail.added, 200).items,
        removed: capList(diffDetail.removed, 200).items,
        modified: capList(diffDetail.modified, 200).items,
      },
      // 摘要是给人看的预览，先把首尾空白去掉再截断：
      // 真实 Feed 的 description 常以换行/制表符开头（模板缩进留下的），不 trim 的话
      // 详情页会先空一大段再出现正文，而且前几千字符的截断预算全花在了空行上。
      excerpt: clampText((item?.text ?? snapshot.normalizedText ?? '').trim(), MAX_EXCERPT_CHARS),
      truncated: snapshot.truncated === true,
      status: 'unread',
      lastSeenAt: at,
      itemId: item?.itemId,
      itemUrl: item?.url ?? undefined,
    }
  }

  /**
   * 比较相邻两份快照的条目集合，得出「这一份相对上一份变了什么」。
   *
   * 只做集合差与指纹比对，**不含任何模型调用**（SDD §4.4）。刻意不用
   * `snapshot.itemCount` 相减来推断，因为那会把"删了 3 条又加了 3 条"说成"没变"。
   *
   * @param {object|null} previous 上一份（更旧的）快照
   * @param {object} snapshot 当前（更新的）快照
   * @returns {{baseline: boolean, added: number, removed: number, modified: number, itemCount: number, capped: boolean}} 差异摘要
   */
  function chainLink(previous, snapshot) {
    const after = new Map((snapshot?.itemIds ?? []).map((itemId) => [itemId, snapshot?.itemHashes?.[itemId] ?? '']))
    if (!previous) {
      return { baseline: true, added: 0, removed: 0, modified: 0, itemCount: after.size, capped: false }
    }
    const before = new Map((previous.itemIds ?? []).map((itemId) => [itemId, previous.itemHashes?.[itemId] ?? '']))
    let added = 0
    let modified = 0
    for (const [itemId, fingerprint] of after) {
      if (!before.has(itemId)) added += 1
      else if (before.get(itemId) !== fingerprint) modified += 1
    }
    let removed = 0
    for (const itemId of before.keys()) if (!after.has(itemId)) removed += 1
    // 条目 id 是**有上限**的（MAX_ITEM_IDS），超过的条目根本没被记下来。
    // 这时上面的计数是"至少这么多"，必须如实标注，不能让用户以为是精确值。
    const capped = (snapshot?.itemCount ?? after.size) > after.size
    return { baseline: false, added, removed, modified, itemCount: after.size, capped }
  }

  /**
   * 把一份快照压成列表要用的摘要形状（**不带全文**）。
   *
   * 列表里绝不返回 `normalizedText`：20 份快照各带 10 万字符正文，一次请求就是
   * 数兆字节，而用户在这一屏里只想看"什么时候、抓到多少条、比上次变了什么"。
   *
   * @param {object} snapshot 快照记录
   * @param {object|null} previous 更旧的一份
   * @param {object[]} changes 由这一份快照产生的变化记录
   * @returns {object} 摘要
   */
  function snapshotSummary(snapshot, previous, changes) {
    const kinds = { added: 0, removed: 0, modified: 0, summary: 0 }
    for (const change of changes) {
      if (typeof change.kind === 'string' && change.kind in kinds) kinds[change.kind] += 1
    }
    return {
      id: snapshot.id,
      sourceId: snapshot.sourceId,
      fetchedAt: snapshot.fetchedAt,
      url: snapshot.url,
      statusCode: snapshot.statusCode,
      title: snapshot.title ?? '',
      itemCount: snapshot.itemCount ?? 0,
      baseline: snapshot.baseline === true,
      retention: retentionOf(snapshot),
      textChars: snapshot.textChars ?? 0,
      textTruncated: snapshot.textTruncated === true,
      truncated: snapshot.truncated === true,
      fingerprint: String(snapshot.contentFingerprint ?? '').slice(0, 12),
      // 摘要统一走截断，保证列表每行的体量可预期。
      excerpt: clampText((snapshot.normalizedText ?? '').trim(), MAX_EXCERPT_CHARS),
      chain: chainLink(previous, snapshot),
      changeKinds: kinds,
      changeIds: changes.map((change) => change.id),
    }
  }

  /**
   * `GET /apradar/sources/:id/snapshots` —— 某个来源最近的快照历史（P1-02）。
   *
   * 返回的每一行都带**相对上一份**的差异摘要，所以用户在列表里就能看出
   * "哪一次抓到了新东西"，不必逐个点开。最后一行的 `previous` 取自被截断掉的
   * 那一份（如果存在），因此**链在列表尽头依然是真的**，不会因为分页而变成基线。
   *
   * @param {string} sourceId 来源 id
   * @param {{limit?: unknown}} [query] 查询串
   * @returns {object} `{ source, total, items }`
   */
  function listSnapshots(sourceId, query = {}) {
    const source = all('sources').find((entry) => entry.id === sourceId)
    if (!source) throw radarError('SOURCE_NOT_FOUND', { id: sourceId })
    const limit = clampLimit(query.limit, MAX_SNAPSHOT_HISTORY)
    const full = snapshotsOf(sourceId)
    const rows = full.slice(0, limit)
    const changesOf = new Map()
    for (const change of all('changes')) {
      if (change.sourceId !== sourceId) continue
      const list = changesOf.get(change.snapshotId)
      if (list) list.push(change)
      else changesOf.set(change.snapshotId, [change])
    }
    return {
      source: { id: source.id, name: source.name, type: source.type, canonicalUrl: source.canonicalUrl },
      total: full.length,
      items: rows.map((snapshot, index) => snapshotSummary(snapshot, full[index + 1] ?? null, changesOf.get(snapshot.id) ?? [])),
    }
  }

  /**
   * `GET /apradar/snapshots/:id` —— 单份快照的正文与差异链（P1-02）。
   *
   * @param {string} id 快照 id
   * @returns {object} 快照详情
   */
  function getSnapshot(id) {
    const snapshot = all('snapshots').find((entry) => entry.id === id)
    if (!snapshot) throw notFoundError('快照', { id })
    const siblings = snapshotsOf(snapshot.sourceId)
    const index = siblings.findIndex((entry) => entry.id === id)
    const previous = index >= 0 ? siblings[index + 1] ?? null : null
    const source = all('sources').find((entry) => entry.id === snapshot.sourceId) ?? null
    const text = typeof snapshot.normalizedText === 'string' ? snapshot.normalizedText : ''
    return {
      snapshot: {
        ...snapshotSummary(snapshot, previous, all('changes').filter((change) => change.snapshotId === id)),
        // 查看接口给的是**正文**，按界面上限裁切，并如实说明裁了多少。
        text: text.slice(0, MAX_SNAPSHOT_VIEW_CHARS),
        textTruncatedByView: text.length > MAX_SNAPSHOT_VIEW_CHARS,
        maxViewChars: MAX_SNAPSHOT_VIEW_CHARS,
      },
      source: source ? { id: source.id, name: source.name, type: source.type, canonicalUrl: source.canonicalUrl } : null,
      previousSnapshot: previous
        ? { id: previous.id, fetchedAt: previous.fetchedAt, url: previous.url, itemCount: previous.itemCount, retention: retentionOf(previous) }
        : null,
      changes: all('changes')
        .filter((change) => change.snapshotId === id)
        .sort((a, b) => (b.discoveredAt ?? 0) - (a.discoveredAt ?? 0))
        .map(decorateChange),
    }
  }

  /**
   * `GET /apradar/changes`
   * @param {object} [query] 查询
   * @returns {object}
   */
  function listChanges(query = {}) {
    const { offset, limit } = pagination(query)
    let rows = all('changes')

    if (typeof query.status === 'string' && query.status) {
      rows = rows.filter((row) => row.status === query.status)
    }
    if (typeof query.sourceId === 'string' && query.sourceId) {
      rows = rows.filter((row) => row.sourceId === query.sourceId)
    }
    if (typeof query.q === 'string' && query.q.trim()) {
      const needle = query.q.trim().toLowerCase()
      rows = rows.filter((row) =>
        `${row.title} ${row.diffSummary} ${row.excerpt} ${row.userNote ?? ''}`.toLowerCase().includes(needle),
      )
    }

    const dir = query.dir === 'asc' ? 1 : -1
    const key = query.sort === 'publishedAt' ? 'publishedAt' : query.sort === 'title' ? 'title' : 'discoveredAt'
    rows = [...rows].sort((a, b) => {
      const left = a[key] ?? 0
      const right = b[key] ?? 0
      if (left === right) return (a.id < b.id ? -1 : 1) * dir
      return (left < right ? -1 : 1) * dir
    })

    return {
      total: rows.length,
      offset,
      limit,
      items: rows.slice(offset, offset + limit).map(decorateChange),
    }
  }

  /**
   * 给变化记录补上展示需要的派生字段（来源名、机会 id）。
   * @param {object} change 变化记录
   * @returns {object}
   */
  function decorateChange(change) {
    const source = all('sources').find((entry) => entry.id === change.sourceId)
    return {
      ...change,
      sourceName: source?.name ?? '（来源已删除）',
      sourceType: source?.type ?? null,
      // 原文地址优先用条目自己的地址；没有就退回来源的规范地址。
      sourceUrl: change.itemUrl ?? source?.canonicalUrl ?? null,
    }
  }

  /**
   * `GET /apradar/changes/:id`
   * @param {string} id 变化 id
   * @returns {object}
   */
  function getChange(id) {
    const change = all('changes').find((entry) => entry.id === id)
    if (!change) throw notFoundError('变化', { id })
    const snapshot = all('snapshots').find((entry) => entry.id === change.snapshotId)
    const previous = change.previousSnapshotId
      ? all('snapshots').find((entry) => entry.id === change.previousSnapshotId)
      : null
    return {
      change: decorateChange(change),
      snapshot: snapshot
        ? { id: snapshot.id, fetchedAt: snapshot.fetchedAt, url: snapshot.url, itemCount: snapshot.itemCount, baseline: snapshot.baseline }
        : null,
      previousSnapshot: previous
        ? { id: previous.id, fetchedAt: previous.fetchedAt, url: previous.url, itemCount: previous.itemCount }
        : null,
    }
  }

  /**
   * `PATCH /apradar/changes/:id`。只允许 `status` 与 `userNote`。
   * @param {string} id 变化 id
   * @param {object} patch 请求体
   * @returns {Promise<object>}
   */
  async function updateChange(id, patch = {}) {
    const change = all('changes').find((entry) => entry.id === id)
    if (!change) throw notFoundError('变化', { id })
    assertWritable(patch, CHANGE_WRITABLE_FIELDS)

    const next = { ...change }
    if ('status' in patch) {
      if (!CHANGE_STATUSES.includes(patch.status)) {
        throw radarError('VALIDATION_FAILED', { field: 'status', allowed: CHANGE_STATUSES })
      }
      next.status = patch.status
    }
    if ('userNote' in patch) {
      if (patch.userNote !== null && typeof patch.userNote !== 'string') {
        throw radarError('VALIDATION_FAILED', { field: 'userNote' })
      }
      next.userNote = clampText(patch.userNote ?? '', MAX_USER_NOTE_CHARS)
    }
    next.lastSeenAt = change.lastSeenAt
    await store.put('changes', next)
    return decorateChange(next)
  }

  /**
   * `GET /apradar/opportunities/:id`
   *
   * 机会详情必须能**独立读取**。两个真实场景决定了不能只靠列表数据：
   *  1. 从一条变化跳到它的机会时，那条机会可能不在已加载的列表里
   *     （列表有分页，还有状态筛选，默认页不一定包含它）；
   *  2. 刷新页面后，详情必须能按 id 恢复。
   * 所以补一个按 id 读取的最小接口，而不是让客户端去猜"它应该在列表第几页"。
   *
   * 顺带把**关联的那条变化**一并返回（用 `decorateChange` 装饰），这样详情页
   * 能展示"对应的来源变化"并直接跳过去。关联一律靠 `changeId` 这个真实 id，
   * 绝不按标题相同来判断。
   *
   * 关联对象已经不存在时（变化被删、来源被删），如实返回 `changeMissing` /
   * `sourceMissing`，让界面能明说"关联对象已不存在"，而不是渲染一个空链接。
   *
   * @param {string} id 机会 id
   * @returns {object}
   */
  function getOpportunity(id) {
    const record = all('opportunities').find((entry) => entry.id === id)
    if (!record) throw notFoundError('机会', { id })

    const change = record.changeId ? all('changes').find((entry) => entry.id === record.changeId) : null
    const source = change?.sourceId ? all('sources').find((entry) => entry.id === change.sourceId) : null

    return {
      opportunity: record,
      change: change ? decorateChange(change) : null,
      changeMissing: Boolean(record.changeId) && !change,
      source: source
        ? { id: source.id, name: source.name, type: source.type, canonicalUrl: source.canonicalUrl }
        : null,
      sourceMissing: Boolean(change?.sourceId) && !source,
    }
  }

  /**
   * `GET /apradar/opportunities`
   * @param {object} [query] 查询
   * @returns {object}
   */
  function listOpportunities(query = {}) {
    const { offset, limit } = pagination(query)
    let rows = all('opportunities')
    if (typeof query.status === 'string' && query.status) {
      rows = rows.filter((row) => row.status === query.status)
    }
    if (typeof query.q === 'string' && query.q.trim()) {
      const needle = query.q.trim().toLowerCase()
      rows = rows.filter((row) =>
        `${row.title} ${row.projectRef ?? ''} ${row.judgment ?? ''} ${(row.questions ?? []).join(' ')}`.toLowerCase().includes(needle),
      )
    }
    rows = [...rows].sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
    return { total: rows.length, offset, limit, items: rows.slice(offset, offset + limit) }
  }

  /**
   * `POST /apradar/opportunities`
   * @param {object} input 请求体
   * @returns {Promise<object>}
   */
  async function createOpportunity(input = {}) {
    assertWritable(input, OPPORTUNITY_CREATE_FIELDS)
    const title = typeof input.title === 'string' ? input.title.trim() : ''
    if (!title) throw radarError('VALIDATION_FAILED', { field: 'title', message: '标题不能为空' })
    if (all('opportunities').length >= MAX_OPPORTUNITIES) {
      throw radarError('SOURCE_LIMIT_REACHED', { max: MAX_OPPORTUNITIES, what: '机会' })
    }

    let changeId = null
    if (typeof input.changeId === 'string' && input.changeId) {
      const change = all('changes').find((entry) => entry.id === input.changeId)
      if (!change) throw notFoundError('变化', { id: input.changeId })
      changeId = change.id
    }

    const at = now()
    const record = {
      id: hashId('opp', `${title}|${at}|${changeId ?? ''}`),
      title: clampText(title, MAX_OPPORTUNITY_TITLE_CHARS),
      sourceId: typeof input.sourceId === 'string' && input.sourceId ? input.sourceId : undefined,
      changeId: changeId ?? undefined,
      projectRef: optionalText(input.projectRef, 200),
      judgment: optionalText(input.judgment, MAX_JUDGMENT_CHARS),
      questions: normalizeQuestions(input.questions),
      nextAction: optionalText(input.nextAction, MAX_QUESTION_CHARS),
      status: OPPORTUNITY_STATUSES.includes(input.status) ? input.status : 'to_research',
      createdAt: at,
      updatedAt: at,
    }
    await store.put('opportunities', record)

    // 反向链接：把变化标记为已进入机会池，收件箱里就不会再催这条。
    if (changeId) {
      const change = all('changes').find((entry) => entry.id === changeId)
      if (change && change.status !== 'pooled') {
        await store.put('changes', { ...change, status: 'pooled', opportunityId: record.id })
      }
    }

    return record
  }

  /**
   * `PATCH /apradar/opportunities/:id`
   * @param {string} id 机会 id
   * @param {object} patch 请求体
   * @returns {Promise<object>}
   */
  async function updateOpportunity(id, patch = {}) {
    const record = all('opportunities').find((entry) => entry.id === id)
    if (!record) throw notFoundError('机会', { id })
    assertWritable(patch, OPPORTUNITY_WRITABLE_FIELDS)

    const next = { ...record, updatedAt: now() }
    if ('title' in patch) {
      const title = typeof patch.title === 'string' ? patch.title.trim() : ''
      if (!title) throw radarError('VALIDATION_FAILED', { field: 'title', message: '标题不能为空' })
      next.title = clampText(title, MAX_OPPORTUNITY_TITLE_CHARS)
    }
    if ('projectRef' in patch) next.projectRef = optionalText(patch.projectRef, 200)
    if ('judgment' in patch) next.judgment = optionalText(patch.judgment, MAX_JUDGMENT_CHARS)
    if ('nextAction' in patch) next.nextAction = optionalText(patch.nextAction, MAX_QUESTION_CHARS)
    if ('questions' in patch) next.questions = normalizeQuestions(patch.questions)
    if ('status' in patch) {
      if (!OPPORTUNITY_STATUSES.includes(patch.status)) {
        throw radarError('VALIDATION_FAILED', { field: 'status', allowed: OPPORTUNITY_STATUSES })
      }
      next.status = patch.status
    }

    await store.put('opportunities', next)
    return next
  }

  /**
   * `GET /apradar/export/opportunities`
   *
   * 导出单条或全部机会为 Markdown。**只读**：不写任何用户项目、不改任何记录。
   *
   * `query.ids` 是以逗号分隔的机会 id。指定了就**按给定顺序**导出，其中任何一个
   * 找不到就整体失败（`NOT_FOUND`）—— 导出一半、静默漏掉几条，比导出失败更糟：
   * 用户会以为文件是完整的。
   *
   * @param {{ids?: string}} [query] 查询参数
   * @returns {{markdown: string, filename: string, count: number}} 渲染结果
   */
  function exportOpportunities(query = {}) {
    const requested =
      typeof query.ids === 'string' && query.ids.trim() !== ''
        ? query.ids
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        : null

    let rows
    if (requested) {
      rows = requested.map((id) => {
        const found = all('opportunities').find((entry) => entry.id === id)
        if (!found) throw notFoundError('机会', { id })
        return found
      })
    } else {
      rows = [...all('opportunities')].sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
    }

    return renderOpportunitiesMarkdown({
      opportunities: rows,
      changes: all('changes'),
      sources: all('sources'),
      snapshots: all('snapshots'),
      now: new Date(now()),
    })
  }

  /**
   * `DELETE /apradar/opportunities/:id`
   * @param {string} id 机会 id
   * @returns {Promise<{deleted: boolean}>}
   */
  async function deleteOpportunity(id) {
    const record = all('opportunities').find((entry) => entry.id === id)
    if (!record) throw notFoundError('机会', { id })
    await store.del('opportunities', id)
    if (record.changeId) {
      const change = all('changes').find((entry) => entry.id === record.changeId)
      // 机会被删掉后，那条变化回到「未读」，否则它会永远停在 pooled 而看不到。
      if (change) {
        const restored = { ...change, status: 'unread' }
        delete restored.opportunityId
        await store.put('changes', restored)
      }
    }
    return { deleted: true }
  }

  /**
   * `POST /apradar/maintenance/purge`
   *
   * 只清快照与变化（以及机会，若 `includeOpportunities`），**保留来源**。
   * 必须显式传 `confirm: true`。
   * @param {{confirm?: boolean, includeOpportunities?: boolean}} input 请求体
   * @returns {Promise<object>}
   */
  async function purge(input = {}) {
    if (input.confirm !== true) {
      throw radarError('VALIDATION_FAILED', { field: 'confirm', message: '需要显式确认' })
    }
    const removed = { snapshots: 0, changes: 0, opportunities: 0 }
    for (const snapshot of all('snapshots')) {
      await store.del('snapshots', snapshot.id)
      removed.snapshots += 1
    }
    for (const change of all('changes')) {
      await store.del('changes', change.id)
      removed.changes += 1
    }
    if (input.includeOpportunities === true) {
      for (const opportunity of all('opportunities')) {
        await store.del('opportunities', opportunity.id)
        removed.opportunities += 1
      }
    }
    return { purged: true, removed, counts: store.counts() }
  }

  /**
   * 按上限裁剪存储。**幂等**，每次成功刷新批次结束后调用一次。
   * @returns {Promise<object>} 本次裁剪的统计
   */
  async function applyTrim() {
    if (!store?.ok) return { skipped: true }
    const plan = planTrim({
      snapshots: all('snapshots'),
      changes: all('changes'),
      opportunities: all('opportunities'),
    })
    for (const id of plan.deleteSnapshots) await store.del('snapshots', id)
    for (const record of plan.shrinkSnapshots) await store.put('snapshots', record)
    for (const id of plan.deleteChanges) await store.del('changes', id)
    for (const id of plan.deleteOpportunities) await store.del('opportunities', id)
    return {
      deletedSnapshots: plan.deleteSnapshots.length,
      shrunkSnapshots: plan.shrinkSnapshots.length,
      deletedChanges: plan.deleteChanges.length,
      deletedOpportunities: plan.deleteOpportunities.length,
    }
  }

  return {
    meta,
    state,
    listSources,
    createSource,
    updateSource,
    deleteSource,
    testSource,
    refresh,
    refreshDue,
    inFlightIds,
    setScheduler,
    setRuntime,
    listSnapshots,
    getSnapshot,
    listChanges,
    getChange,
    updateChange,
    listOpportunities,
    getOpportunity,
    createOpportunity,
    updateOpportunity,
    deleteOpportunity,
    exportOpportunities,
    purge,
    templates: () => listTemplates(),
    applyTrim,
  }
}

/**
 * 选出「现在该自动刷新」的来源（P1-01）。
 *
 * **纯函数**：不接触存储、不读时钟（时间由 `at` 传入），因此可以用固定时间戳单测。
 * 不在这里做任何抓取或写入 —— 它只回答"哪些该刷"，刷不刷得成由 `refresh()` 说了算。
 *
 * 判定规则：
 *  - 停用的来源永不到期（`enabled === false` 一律排除，含被自动停用的）；
 *  - `intervalMinutes <= 0`（含缺失）表示用户没开定时刷新；
 *  - **从未检查过的来源立刻到期** —— 用户刚打开开关就该看到一次结果，
 *    而不是先干等一个完整间隔；
 *  - 其余按 `lastCheckedAt + interval` 与 `at` 比较。
 *
 * 刻意**不**用 `lastSuccessAt`：一个一直失败的来源如果按"上次成功"算，
 * 就会永远不再重试，反而让自动停用机制永远触发不了。
 *
 * @param {object[]} sources 全部来源记录
 * @param {number} at 当前时间戳（毫秒）
 * @returns {object[]} 到期的来源，顺序与输入一致
 */
export function selectDueSources(sources, at) {
  const list = Array.isArray(sources) ? sources : []
  return list.filter((source) => {
    if (source?.enabled === false) return false
    const interval = typeof source?.intervalMinutes === 'number' ? source.intervalMinutes : 0
    if (interval <= 0) return false
    const last = typeof source.lastCheckedAt === 'number' ? source.lastCheckedAt : null
    if (last === null) return true
    return at - last >= interval * 60000
  })
}

/**
 * 断言请求体里没有不可写字段。
 *
 * 白名单而不是黑名单：新加字段时忘记同步黑名单会静默允许越权写，
 * 而忘记同步白名单只会让合法写被拒 —— 后者会立刻被测试发现。
 *
 * @param {object} patch 请求体
 * @param {string[]} allowed 允许写入的字段
 * @returns {void}
 */
export function assertWritable(patch, allowed) {
  const keys = Object.keys(patch ?? {}).filter((key) => !allowed.includes(key))
  if (keys.length) {
    throw radarError('FIELD_NOT_WRITABLE', { fields: keys, allowed })
  }
}

/**
 * 可选文本字段：空串与 `null` 都归一为「不设置」。
 * @param {unknown} value 输入
 * @param {number} max 长度上限
 * @returns {string|undefined}
 */
function optionalText(value, max) {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') throw radarError('VALIDATION_FAILED', { field: 'text' })
  const text = value.trim()
  return text ? clampText(text, max) : undefined
}

/**
 * 归一待验证问题列表。
 * @param {unknown} value 输入
 * @returns {string[]}
 */
function normalizeQuestions(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) throw radarError('VALIDATION_FAILED', { field: 'questions' })
  if (value.length > MAX_QUESTIONS) throw radarError('VALIDATION_FAILED', { field: 'questions', max: MAX_QUESTIONS })
  return value.map((entry) => {
    if (typeof entry !== 'string') throw radarError('VALIDATION_FAILED', { field: 'questions' })
    return clampText(entry.trim(), MAX_QUESTION_CHARS)
  }).filter(Boolean)
}

/** 记录 id 校验器再导出，方便路由层复用。 */
export { isValidRecordId }
