/**
 * 上限与裁剪策略的**单一事实来源**（SDD §5.4）。
 *
 * 为什么集中在一个文件：这些数字同时被三处消费 —— 服务层的写入路径、`GET
 * /apradar/meta` 的对外暴露、以及测试的边界断言。散落三处一定会漂移。
 *
 * 裁剪是**幂等**的：`planTrim()` 是一个纯函数，对同一批记录重复调用得到同一结果，
 * 因此存储刚 `open()` 之后重跑一次总是安全的。
 *
 * @module dsh-apradar/src/host/limits
 */

/** 关注源数量上限。超出时**拒绝创建**（而不是悄悄丢弃最旧的）。 */
export const MAX_SOURCES = 200

/** 每个来源保留的历史快照数（按 `fetchedAt` 降序，新的留下）。 */
export const MAX_SNAPSHOTS_PER_SOURCE = 20

/** 其中保留**全文**的快照数；更旧的保留但正文被裁成摘要。 */
export const MAX_FULL_TEXT_SNAPSHOTS = 2

/** 被裁成摘要的旧快照保留的正文长度。 */
export const MAX_OLD_SNAPSHOT_CHARS = 2000

/** 变化记录总量上限。 */
export const MAX_CHANGES = 2000

/** 单个来源的变化记录上限。 */
export const MAX_CHANGES_PER_SOURCE = 200

/** 机会记录总量上限。 */
export const MAX_OPPORTUNITIES = 500

/** 规范化正文长度上限（同时是 `normalizeText` 的截断点）。 */
export const MAX_NORMALIZED_TEXT_CHARS = 100000

/** 变化详情里单条摘录的长度上限。 */
export const MAX_EXCERPT_CHARS = 4000

/** 条目级差异（added / removed / modified）各自保留的条目数上限。 */
export const MAX_DIFF_ITEMS = 200

/** 快照里记录的条目 id 数量上限（用于下一轮做「新增/移除」判断）。 */
export const MAX_ITEM_IDS = 500

/**
 * 出网并发上限。
 *
 * DSH 全仓**没有**并发闸门（`TECH-SPIKE.md` 已核实），所以本插件必须自带：
 * 手动刷新时最多同时抓两个来源，避免一次刷新把宿主与目标站点都打满。
 */
export const FETCH_CONCURRENCY = 2

/** 列表默认分页大小。 */
export const PAGE_SIZE_DEFAULT = 50

/** 列表最大分页大小。 */
export const PAGE_SIZE_MAX = 100

/** 单个响应体上限（字节），超过直接拒绝，防止一次刷新撑爆界面。 */
export const MAX_RESPONSE_BYTES = 262144

// —— 快照历史查看（P1-02）——

/**
 * 一次「快照历史」请求最多返回多少份快照。
 *
 * 与 `MAX_SNAPSHOTS_PER_SOURCE`（保留上限 20）取同一个数：保留多少就能看多少，
 * 界面上不会出现「存储里有、列表里看不到」这种需要用户猜的差异。
 */
export const MAX_SNAPSHOT_HISTORY = MAX_SNAPSHOTS_PER_SOURCE

/**
 * 快照正文在**界面**里一次显示多少字符。
 *
 * 存储里全文上限是 `MAX_NORMALIZED_TEXT_CHARS`（100000），但那是给差异计算用的；
 * 一次响应把 10 万字符塞进右栏，用户既读不完也滚不动。所以查看接口按这个上限裁切，
 * 并**如实标注**裁切前后的长度差（`textTruncatedByView`），不假装那就是全文。
 */
export const MAX_SNAPSHOT_VIEW_CHARS = 20000

/**
 * 判断一份快照的正文是「全文」还是「只剩摘录」。
 *
 * 为什么要一个函数而不是直接读一个字段：`textTruncated` 这个标志有**两个来源** ——
 * ① 规范化阶段正文超长被截（这时 `textChars` 会顶到 `MAX_NORMALIZED_TEXT_CHARS`）；
 * ② 裁剪阶段旧快照被压成摘要（这时 `textChars` 不超过 `MAX_OLD_SNAPSHOT_CHARS`）。
 * 两者对用户的意义完全不同：前者是"上游内容太长了"，后者是"我们只替你留了摘录"。
 * 新增的 `retention` 字段直接把结论写下来；对没有该字段的旧记录用长度回退推断。
 *
 * @param {object|null|undefined} snapshot 快照记录
 * @returns {'full'|'excerpt'} 正文保留等级
 */
export function retentionOf(snapshot) {
  if (snapshot && snapshot.retention === 'excerpt') return 'excerpt'
  if (snapshot && snapshot.retention === 'full') return 'full'
  const chars = typeof snapshot?.textChars === 'number' ? snapshot.textChars : 0
  if (snapshot?.textTruncated === true && chars <= MAX_OLD_SNAPSHOT_CHARS) return 'excerpt'
  return 'full'
}

// —— 定时刷新（P1-01）——

/**
 * 单源刷新间隔的下限（分钟）。
 *
 * 为什么是 15：本插件的默认来源里有整站 RSS，15 分钟已经是「礼貌抓取」的下限；
 * 更密只会在用户毫无收益的情况下增加被目标站点限流的概率。填 0 表示关闭定时刷新。
 */
export const MIN_REFRESH_INTERVAL_MINUTES = 15

/** 单源刷新间隔的上限（分钟）＝ 24 小时。再长就等于「不刷新」，不如直接填 0。 */
export const MAX_REFRESH_INTERVAL_MINUTES = 1440

/**
 * 调度器的唤醒间隔（毫秒）。
 *
 * 与「单源间隔」解耦：调度器只负责**定期看看有没有到期的来源**，不负责精确计时。
 * 60 秒的粒度对 15 分钟级的间隔完全够用，而且一次唤醒没有到期来源时几乎不做事。
 */
export const SCHEDULER_TICK_MS = 60000

/**
 * 连续失败多少次后自动停用来源。
 *
 * 为什么要有这个：一个已经死掉的地址如果继续每 15 分钟抓一次，用户得到的只有
 * 噪音，站点得到的是无意义的请求。停用必须**可见**（来源上留下原因），
 * 否则就成了静默丢弃。用户手动重新启用即清零。
 */
export const AUTO_DISABLE_FAILURE_STREAK = 3

/** 供 `GET /apradar/meta` 对外暴露的只读快照。 */
export const LIMITS_SNAPSHOT = Object.freeze({
  maxSources: MAX_SOURCES,
  maxSnapshotsPerSource: MAX_SNAPSHOTS_PER_SOURCE,
  maxFullTextSnapshots: MAX_FULL_TEXT_SNAPSHOTS,
  maxOldSnapshotChars: MAX_OLD_SNAPSHOT_CHARS,
  maxChanges: MAX_CHANGES,
  maxChangesPerSource: MAX_CHANGES_PER_SOURCE,
  maxOpportunities: MAX_OPPORTUNITIES,
  maxNormalizedTextChars: MAX_NORMALIZED_TEXT_CHARS,
  maxExcerptChars: MAX_EXCERPT_CHARS,
  maxDiffItems: MAX_DIFF_ITEMS,
  maxItemIds: MAX_ITEM_IDS,
  fetchConcurrency: FETCH_CONCURRENCY,
  pageSizeDefault: PAGE_SIZE_DEFAULT,
  pageSizeMax: PAGE_SIZE_MAX,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxSnapshotHistory: MAX_SNAPSHOT_HISTORY,
  maxSnapshotViewChars: MAX_SNAPSHOT_VIEW_CHARS,
  minRefreshIntervalMinutes: MIN_REFRESH_INTERVAL_MINUTES,
  maxRefreshIntervalMinutes: MAX_REFRESH_INTERVAL_MINUTES,
  schedulerTickMs: SCHEDULER_TICK_MS,
  autoDisableFailureStreak: AUTO_DISABLE_FAILURE_STREAK,
})

/**
 * 把用户填的刷新间隔归一化成「0 或 [MIN, MAX] 内的整数分钟」。
 *
 * **不抛错**：间隔是一个可选偏好，填错不该让整个来源保存失败。无法理解的值
 * 一律退回 0（关闭），并在界面上由用户重新选择。
 *
 * @param {unknown} value 原始值
 * @returns {number} 归一化后的分钟数
 */
export function normalizeIntervalMinutes(value) {
  const raw = typeof value === 'string' ? Number(value) : value
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0
  const minutes = Math.trunc(raw)
  if (minutes <= 0) return 0
  return Math.min(Math.max(minutes, MIN_REFRESH_INTERVAL_MINUTES), MAX_REFRESH_INTERVAL_MINUTES)
}

/**
 * 按 `fetchedAt` 降序比较两条快照。相同时间戳时用 id 兜底，保证顺序稳定。
 * @param {{fetchedAt: number, id: string}} a 快照
 * @param {{fetchedAt: number, id: string}} b 快照
 * @returns {number}
 */
function byFetchedAtDesc(a, b) {
  return b.fetchedAt - a.fetchedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

/**
 * 按 `discoveredAt` 降序比较两条变化记录。
 * @param {{discoveredAt: number, id: string}} a 变化
 * @param {{discoveredAt: number, id: string}} b 变化
 * @returns {number}
 */
function byDiscoveredAtDesc(a, b) {
  return b.discoveredAt - a.discoveredAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

/**
 * 按 `updatedAt` 降序比较两条机会记录。
 * @param {{updatedAt: number, id: string}} a 机会
 * @param {{updatedAt: number, id: string}} b 机会
 * @returns {number}
 */
function byUpdatedAtDesc(a, b) {
  return b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
}

/**
 * 计算一次裁剪需要做什么。**纯函数**，不接触存储。
 *
 * @param {object} input 输入
 * @param {object[]} input.snapshots 全部快照记录
 * @param {object[]} input.changes 全部变化记录
 * @param {object[]} input.opportunities 全部机会记录
 * @returns {{ deleteSnapshots: string[], shrinkSnapshots: object[], deleteChanges: string[], deleteOpportunities: string[] }}
 *   `deleteSnapshots` / `deleteChanges` / `deleteOpportunities` 是记录 id 列表；
 *   `shrinkSnapshots` 是**已经改写好的**记录对象（正文裁成摘要），直接 `put` 即可。
 */
export function planTrim({ snapshots, changes, opportunities }) {
  // —— 快照：先按来源分组，组内按时间降序 ——
  /** @type {Map<string, object[]>} */
  const bySource = new Map()
  for (const snap of snapshots) {
    const list = bySource.get(snap.sourceId)
    if (list) list.push(snap)
    else bySource.set(snap.sourceId, [snap])
  }

  const deleteSnapshots = []
  const shrinkSnapshots = []

  for (const list of bySource.values()) {
    list.sort(byFetchedAtDesc)
    list.forEach((snap, index) => {
      if (index >= MAX_SNAPSHOTS_PER_SOURCE) {
        deleteSnapshots.push(snap.id)
        return
      }
      // 只有最新的若干份保留全文；更旧的裁成摘要，但仍保留指纹与条目 id，
      // 因为「与上一版本比较」只需要上一份快照，更早的只用来看趋势。
      const shouldShrink = index >= MAX_FULL_TEXT_SNAPSHOTS
      const text = typeof snap.normalizedText === 'string' ? snap.normalizedText : ''
      if (shouldShrink && (text.length > MAX_OLD_SNAPSHOT_CHARS || snap.textTruncated === true)) {
        // 已经裁过且长度达标就不要再写一次 —— 这是幂等的关键。
        if (snap.textTruncated === true && text.length <= MAX_OLD_SNAPSHOT_CHARS) return
        shrinkSnapshots.push({
          ...snap,
          normalizedText: text.slice(0, MAX_OLD_SNAPSHOT_CHARS),
          textChars: Math.min(snap.textChars ?? text.length, MAX_OLD_SNAPSHOT_CHARS),
          textTruncated: true,
          // 明确写下"只剩摘录"。不要靠 `textTruncated` 反推 —— 它同时也表示
          // "规范化时正文超长被截"，而这两件事在界面上必须能分开说。
          retention: 'excerpt',
        })
      }
    })
  }

  // —— 变化：先按来源限单源上限，再限总量 ——
  /** @type {Map<string, object[]>} */
  const changesBySource = new Map()
  for (const change of changes) {
    const list = changesBySource.get(change.sourceId)
    if (list) list.push(change)
    else changesBySource.set(change.sourceId, [change])
  }

  const survivors = []
  const deleteChanges = []
  for (const list of changesBySource.values()) {
    list.sort(byDiscoveredAtDesc)
    list.forEach((change, index) => {
      if (index >= MAX_CHANGES_PER_SOURCE) deleteChanges.push(change.id)
      else survivors.push(change)
    })
  }
  survivors.sort(byDiscoveredAtDesc)
  survivors.forEach((change, index) => {
    if (index >= MAX_CHANGES) deleteChanges.push(change.id)
  })

  // —— 机会：只看总量，按最近更新保留 ——
  const sortedOpportunities = [...opportunities].sort(byUpdatedAtDesc)
  const deleteOpportunities = sortedOpportunities.slice(MAX_OPPORTUNITIES).map((o) => o.id)

  return {
    deleteSnapshots,
    shrinkSnapshots,
    deleteChanges: [...new Set(deleteChanges)],
    deleteOpportunities,
  }
}

/**
 * 按上限把数组裁到 `max`，并报告是否发生了截断。
 * @template T
 * @param {T[]} list 待裁剪数组
 * @param {number} max 上限
 * @returns {{ items: T[], truncated: boolean, total: number }}
 */
export function capList(list, max) {
  const total = Array.isArray(list) ? list.length : 0
  const items = Array.isArray(list) ? list.slice(0, max) : []
  return { items, truncated: total > max, total }
}

/**
 * 把字符串裁到 `max` 个 UTF-16 码元，且**不切断代理对**。
 * @param {unknown} value 任意值
 * @param {number} max 上限
 * @returns {string}
 */
export function clampText(value, max) {
  const text = typeof value === 'string' ? value : ''
  if (text.length <= max) return text
  let end = max
  // 若截断点正好落在代理对中间，往前退一位，避免产出半个字符。
  const code = text.charCodeAt(end - 1)
  if (code >= 0xd800 && code <= 0xdbff) end -= 1
  return text.slice(0, end)
}

/**
 * 以受限并发跑一批任务，并保持结果顺序与输入一致。
 *
 * 不使用 `Promise.all`：一次刷新最多 200 个来源，全并发既打满宿主也打满目标站点。
 *
 * @template T, R
 * @param {T[]} items 输入
 * @param {number} limit 并发上限
 * @param {(item: T, index: number) => Promise<R>} worker 单个任务
 * @returns {Promise<R[]>} 与输入同序的结果
 */
export async function mapWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : []
  /** @type {R[]} */
  const results = new Array(list.length)
  let cursor = 0
  const width = Math.max(1, Math.min(limit, list.length))

  async function runner() {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= list.length) return
      results[index] = await worker(list[index], index)
    }
  }

  await Promise.all(Array.from({ length: width }, runner))
  return results
}
