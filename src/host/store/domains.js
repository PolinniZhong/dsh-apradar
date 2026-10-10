/**
 * AI 产品雷达的持久化域（domain）声明。
 *
 * ## 只声明、不发明
 *
 * 这里每个对象都严格是官方 `DomainSpec` 的**数据形状**，字段逐个对应
 * `@deepseek-ai/dsh-storage-domain/lib/types/spec.d.ts`：
 *
 *   - `name`               必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`dsh-storage/lib/index.js:80`）
 *   - `version`            当前格式版本，非负整数
 *   - `layout`             默认 `single`；`per-record` 用于「记录大、稀疏、可单独丢弃」的单元
 *   - `invalidRecords`     仅 `'backup-and-skip'` 合法，且要求后端支持 `backupRecord`
 *   - `global`             `{schema, initial}`；schema **不得接受 `null`**
 *   - `tables`             `{表名: {valueSchema}}`，表名同受 `UNIT_NAME_RE` 约束
 *
 * `domainTable(schema)` 在官方实现里就是 `return { valueSchema: schema }`
 * （`dsh-storage-domain/lib/index.js:46`），所以这里直接写字面量并不改变语义。
 * 首选路径仍然是官方 helper —— 见 `src/host/store/index.js` 的 `loadSpecBuilders()`。
 *
 * ## 记录键规则（已核验）
 *
 * JSON 后端 per-record 布局的记录键必须匹配 `SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/`
 * （`dsh-storage-json/lib/index.js:302`）：**不能含 `.`、`:`、`/`**。
 * 因此所有记录 id 都限定为 `[A-Za-z0-9_-]`，见本文件末尾的 `ID_PATTERN` / `isValidRecordId`。
 *
 * ## 时间一律是 epoch 毫秒整数
 *
 * 不用 ISO 字符串：字符串排序虽然也能用，但迟早会有人拿它做算术；而且
 * `count()` 校验器能顺手挡掉 `NaN` 与负数。展示层的格式化由 Client 负责。
 *
 * @module dsh-apradar/src/host/store/domains
 */

import { listAdapters } from '../adapters/index.js'
import { array, boolean, count, enumerate, looseObject, number, object, optional, string, withDefault } from './schema.js'

/**
 * 当前 schema 版本。**这是初始版本**，写进每个域的 `version`。
 *
 * 迁移入口：`dsh-storage-domain` 的 `compatibleVersions` 允许当前 schema 继续读
 * 旧版本文档；`per-record` 后端还会接受一个如此标记的旧整单元文件做一次性
 * bootstrap，而写入总是打上当前 `version`。升级时的做法是：把新版本号写进
 * `version`，把仍能读的旧版本号列进 `compatibleVersions`，并在 `src/host/store/migrate.js`
 * 里加一条显式迁移；**不要**改这个常量去"凑"旧数据。
 */
export const SCHEMA_VERSION = 1

/**
 * 关注源类型 —— **从适配器注册表推导，不手写**。
 *
 * 这里原先是一张手写的三元素清单。P1-04 新增两个适配器时忘了同步它，后果不是
 * "新类型存不下去"这么局部：持久化设施在 `open()` 时逐条校验记录，一条记录的
 * `type` 不在枚举里，**整个域打不开** —— `GET /sources`、`POST /sources`、刷新、
 * 导出全部返回 `STORAGE_OPEN_FAILED`，用户数据一字未丢却完全不可访问（实测，
 * 2026-10-09 真实宿主，报错 `invalid-record: domain 'ai_product_radar_sources':
 * stored record 'src_1db0065ded8a4342' in table 'sources' does not match its schema`）。
 *
 * 类型清单的唯一权威是适配器注册表 —— 注册一个适配器就应该自动获得"能被存下来"
 * 的资格。手写第二份清单等于给自己留了一个"加了类型忘了改这里"的开关，而它一
 * 按下去是全面宕机而不是局部失效。
 *
 * 注意 `listAdapters()` 的顺序就是 `ADAPTER_ORDER` 的顺序，所以这个数组是稳定的
 * （`enumerate()` 的取值集合不含顺序语义，但快照式比对会受影响）。
 */
export const SOURCE_TYPES = listAdapters().map((adapter) => adapter.type)

/** 最近一次检查的**存储态**结果。界面上的「从未检查 / 已停用」是推导出来的，不存。 */
export const LAST_STATUSES = /** @type {const} */ ([
  'ok',
  'failed',
])

/** 界面上可能出现的来源状态（含两个推导态）。 */
export const SOURCE_STATUSES = /** @type {const} */ ([
  'never',
  'ok',
  'failed',
  'disabled',
])

/** 变化的处理状态。 `pooled` 表示已经转成了一条产品机会。 */
export const CHANGE_STATUSES = /** @type {const} */ ([
  'unread',
  'seen',
  'ignored',
  'pooled',
])

/** 变化的类型。`summary` 是「只有移除」时合并出来的汇总记录。 */
export const CHANGE_KINDS = /** @type {const} */ ([
  'added',
  'removed',
  'modified',
  'summary',
])

/** 产品机会的状态。 */
export const OPPORTUNITY_STATUSES = /** @type {const} */ ([
  'to_research',
  'verifying',
  'planned',
  'dropped',
])

/**
 * 一条关注源记录。
 * 键是 id（`[A-Za-z0-9_-]`，由调用方生成，不含 `.`/`:`/`/`）。
 */
export const sourceRecord = object({
  id: string(),
  type: enumerate(SOURCE_TYPES),
  /** 展示名，用户可改。 */
  name: string(),
  /**
   * 适配器归一后的配置。形状由适配器决定，所以这里是**松散对象**
   * （`object()` 会丢掉未声明的键，那等于静默损坏用户配置）。
   */
  config: withDefault(looseObject(), {}),
  /** 由配置推导出的规范地址。它是**派生字段**，客户端不可写。 */
  canonicalUrl: string(),
  enabled: boolean(),
  createdAt: count(),
  updatedAt: count(),
  lastCheckedAt: optional(count()),
  /** 最近一次**成功**检查时间。失败时**不更新**它 —— 那是「上次成功」的事实。 */
  lastSuccessAt: optional(count()),
  lastStatus: optional(enumerate(LAST_STATUSES)),
  /** 最近的失败原因。只放 code 与短文案，绝不放响应体或路径。 */
  lastError: optional(
    object({
      code: string(),
      message: string(),
      at: count(),
    }),
  ),
  /**
   * 定时刷新的间隔（分钟），0 表示不参与定时刷新。合法区间见 `limits.js` 的
   * `[MIN_REFRESH_INTERVAL_MINUTES, MAX_REFRESH_INTERVAL_MINUTES]`。
   *
   * **必须在这里声明**：未声明的键会被结构校验器丢掉，于是定时刷新变成
   * "设置完看着生效、重开域又回到未设置" —— 一个只在重启之后才暴露的静默失效。
   */
  intervalMinutes: withDefault(count(), 0),
  /** 连续失败次数，成功一次清零；达到阈值后来源被自动停用。 */
  failureStreak: withDefault(count(), 0),
  /** HTML 结构指纹，仅 `html_static` 使用；用于区分「骨架变了」与「内容更新了」。 */
  structureFingerprint: optional(string()),
})

/**
 * `ai_product_radar_sources` 的 global 槽：整个插件共享的元状态。
 *
 * 这个域承载"本插件的持久化是否真的成立"这一件事：`openCount` 每次成功打开时
 * 自增并写回，因此**跨进程重启后它必须变大**——这是对 JSON 存储的实测判据，
 * 而不是推断。
 *
 * 注意 `schema` 必须拒绝 `null`：facility 会先 `safeParse(null)` 探测。
 */
export const sourcesGlobal = object({
  schemaVersion: count(),
  /** 已成功打开本域的累计次数（含本次）。 */
  openCount: count(),
  /** 首次打开时间，只在从未写入过时落定。 */
  firstOpenedAt: optional(string()),
  /** 最近一次打开时间。 */
  lastOpenedAt: optional(string()),
  /** 最近一次手动刷新的时间。 */
  lastRefreshAt: optional(string()),
})

/** `ai_product_radar_sources` 的 initial：只用于"从未写过"的补齐，不覆盖已存值。 */
export const SOURCES_GLOBAL_INITIAL = {
  schemaVersion: SCHEMA_VERSION,
  openCount: 0,
}

/**
 * 关注源域。`single` 布局：整单元一次读写，适合"小、权威、不可丢"的配置数据。
 * 它是**权威数据**，因此不声明 `invalidRecords` —— 一条坏记录即整次 `open` 失败，
 * 这是刻意的：来源配置被静默丢弃比启动失败更糟。
 */
export const sourcesDomain = {
  name: 'ai_product_radar_sources',
  version: SCHEMA_VERSION,
  global: { schema: sourcesGlobal, initial: SOURCES_GLOBAL_INITIAL },
  tables: { sources: { valueSchema: sourceRecord } },
}

/**
 * 一份抓取快照。
 *
 * 只保存**规范化后的文本**，不保存原始响应体：原始 HTML 体积大、几乎不可比较，
 * 而且会连带存下站点自己的样式与脚本。规范化文本才是「与上一版本比较」的输入。
 *
 * `itemIds` 是下一轮判断「新增 / 移除」的依据。首次抓取（`baseline: true`）
 * **不产生变化记录** —— 没有上一版本可比较，任何"变化"都是假信号。
 */
export const snapshotRecord = object({
  id: string(),
  sourceId: string(),
  /** 抓取时刻（epoch 毫秒）。 */
  fetchedAt: count(),
  /** 重定向后的最终地址。 */
  url: string(),
  statusCode: number(),
  /** 规范化正文的 sha256。 */
  contentFingerprint: string(),
  /** 规范化正文（受上限约束；旧快照会被裁成摘要并置 `textTruncated`）。 */
  normalizedText: string(),
  textChars: count(),
  /** 该快照的正文是否已被裁剪策略截短。 */
  textTruncated: withDefault(boolean(), false),
  /** 抓取时宿主是否报告内容被截断（`WebFetchResult.truncated`）。 */
  truncated: boolean(),
  /** 来源标题（Feed 标题或页面 `<title>`）。 */
  title: string(),
  itemCount: count(),
  itemIds: array(string()),
  /**
   * `itemId → itemFingerprint`。
   *
   * 为什么必须存下来：判断「某个条目被**修改**了」需要**上一轮的指纹**。
   * 只存 id 的话，当 added / removed 都为空、正文却变了时，我们既不能说
   * 「没变化」（那是撒谎），也无法指出是哪一条变了。用松散对象是因为
   * itemId 常常是 URL 或 `tag:github.com,...` 这类含 `:`/`,` 的字符串，
   * 它只能当值、不能当键约束。
   */
  itemHashes: withDefault(looseObject({ maxKeys: 500, maxBytes: 65536 }), {}),
  /** 首次抓取：没有可比较的上一份快照。 */
  baseline: boolean(),
})

/** @see snapshotRecord */
export const snapshotsDomain = {
  name: 'ai_product_radar_snapshots',
  version: SCHEMA_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  global: {
    schema: object({ schemaVersion: count(), snapshotCount: count() }),
    initial: { schemaVersion: SCHEMA_VERSION, snapshotCount: 0 },
  },
  tables: { snapshots: { valueSchema: snapshotRecord } },
}

/**
 * 一条变化记录：**相对上一份快照**的实质差异。
 *
 * 判定过程完全不含模型调用（SDD §4.4）。`dedupeKey` 是幂等的关键：同一份内容
 * 即使被反复抓到，也只会有一条变化记录，其余只更新 `lastSeenAt`。
 */
export const changeRecord = object({
  id: string(),
  sourceId: string(),
  snapshotId: string(),
  /** 作为比较基准的上一份快照 id；首次抓取时为 `undefined`。 */
  previousSnapshotId: optional(string()),
  /** `sha256(normalizedUrl + '|' + itemFingerprint)`，去重与幂等的依据。 */
  dedupeKey: string(),
  title: string(),
  publishedAt: optional(count()),
  discoveredAt: count(),
  kind: enumerate(CHANGE_KINDS),
  /** 一句话差异摘要（供列表展示）。 */
  diffSummary: string(),
  /** 明细。`added`/`removed`/`modified` 各自独立截断。 */
  diffDetail: withDefault(
    object({
      added: withDefault(array(string()), []),
      removed: withDefault(array(string()), []),
      modified: withDefault(array(string()), []),
    }),
    { added: [], removed: [], modified: [] },
  ),
  /** 该变化涉及的原文摘录（已规范化），受 `MAX_EXCERPT_CHARS` 约束。 */
  excerpt: string(),
  /** 本次抓取是否被截断 —— 被截断时结论必须降级。 */
  truncated: boolean(),
  status: enumerate(CHANGE_STATUSES),
  /** 最近一次在抓取中再次见到该条目的时间；用于幂等去重。 */
  lastSeenAt: count(),
  /** 用户备注。字段级写权限：`PATCH` 只允许改 `status` 与 `userNote`。 */
  userNote: optional(string()),
  /** 转成的机会 id（一条变化最多转一个）。 */
  opportunityId: optional(string()),
  /** 条目自身的 id 与地址，便于回溯原文。 */
  itemId: optional(string()),
  itemUrl: optional(string()),
})

/** @see changeRecord */
export const changesDomain = {
  name: 'ai_product_radar_changes',
  version: SCHEMA_VERSION,
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  global: {
    schema: object({ schemaVersion: count(), changeCount: count() }),
    initial: { schemaVersion: SCHEMA_VERSION, changeCount: 0 },
  },
  tables: { changes: { valueSchema: changeRecord } },
}

/**
 * 产品机会：用户把某条变化转成的待研究机会。
 *
 * 明确不做：不自动生成、不自动修改用户项目的版本路线图。`projectRef` 与
 * `judgment` 都是用户**自己**写的自由文本 —— 插件不读取任何项目内容。
 */
export const opportunityRecord = object({
  id: string(),
  title: string(),
  sourceId: optional(string()),
  changeId: optional(string()),
  /** 关联的个人项目名（自由文本）。 */
  projectRef: optional(string()),
  /** 用户自己的判断。 */
  judgment: optional(string()),
  /** 待验证的问题列表。 */
  questions: withDefault(array(string()), []),
  /** 下一步行动。 */
  nextAction: optional(string()),
  status: enumerate(OPPORTUNITY_STATUSES),
  createdAt: count(),
  updatedAt: count(),
})

/** @see opportunityRecord */
export const opportunitiesDomain = {
  name: 'ai_product_radar_opportunities',
  version: SCHEMA_VERSION,
  global: {
    schema: object({ schemaVersion: count(), opportunityCount: count() }),
    initial: { schemaVersion: SCHEMA_VERSION, opportunityCount: 0 },
  },
  tables: { opportunities: { valueSchema: opportunityRecord } },
}

/** 全部四个域，按打开顺序排列。顺序有意义：来源是权威数据，先开它。 */
export const DOMAINS = /** @type {const} */ ([
  sourcesDomain,
  snapshotsDomain,
  changesDomain,
  opportunitiesDomain,
])

/** 记录 id 允许的字符集：与 JSON 后端的 `SAFE_KEY_RE` 对齐。 */
export const ID_PATTERN = /^[A-Za-z0-9_-]{1,120}$/

/**
 * 校验一个记录 id 是否可安全用作 JSON 后端的 per-record 文档键。
 * @param {unknown} id 候选 id
 * @returns {boolean} 合法则为 true
 */
export function isValidRecordId(id) {
  return typeof id === 'string' && ID_PATTERN.test(id)
}
