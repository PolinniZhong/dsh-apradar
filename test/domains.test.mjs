/**
 * 持久化域（domain）声明的契约测试。
 *
 * 这里断言的是 `@deepseek-ai/dsh-storage-domain` 在 `open()` 时**真的会检查**的那些条件
 * （`defineDomain` 的三条加载期抛错条件 + `UNIT_NAME_RE` + 后端键规则），
 * 因为一旦不满足，失败发生在插件启动阶段，用户只能看到"插件不存在"。
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { listAdapters } from '../src/host/adapters/index.js'
import {
  DOMAINS,
  ID_PATTERN,
  SCHEMA_VERSION,
  SOURCE_STATUSES,
  SOURCE_TYPES,
  isValidRecordId,
  opportunityRecord,
  snapshotRecord,
  sourceRecord,
  sourcesDomain,
  sourcesGlobal,
} from '../src/host/store/domains.js'

/** 与 `dsh-storage/lib/index.js:80` 逐字一致。 */
const UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/

/** 与 `dsh-storage-json/lib/index.js:302` 逐字一致。 */
const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

test('域与表名必须匹配官方 UNIT_NAME_RE', () => {
  for (const domain of DOMAINS) {
    assert.match(domain.name, UNIT_NAME_RE, `域名非法：${domain.name}`)
    for (const table of Object.keys(domain.tables)) {
      assert.match(table, UNIT_NAME_RE, `表名非法：${domain.name}.${table}`)
    }
  }
})

test('四个域的名字与 SDD §5.2 一致', () => {
  assert.deepEqual(
    DOMAINS.map((domain) => domain.name),
    [
      'ai_product_radar_sources',
      'ai_product_radar_snapshots',
      'ai_product_radar_changes',
      'ai_product_radar_opportunities',
    ],
  )
})

test('version / layout / invalidRecords 只能是官方接受的取值', () => {
  for (const domain of DOMAINS) {
    assert.ok(Number.isInteger(domain.version) && domain.version >= 0, `${domain.name} 的 version 必须是非负整数`)
    assert.equal(domain.version, SCHEMA_VERSION)
    if (domain.layout !== undefined) assert.ok(['single', 'per-record'].includes(domain.layout))
    if (domain.invalidRecords !== undefined) {
      assert.equal(domain.invalidRecords, 'backup-and-skip', 'invalidRecords 只接受 backup-and-skip')
    }
  }
})

test('体量大且互相独立的域用 per-record + backup-and-skip；权威配置用 single 且不丢记录', () => {
  const byName = Object.fromEntries(DOMAINS.map((domain) => [domain.name, domain]))

  for (const name of ['ai_product_radar_snapshots', 'ai_product_radar_changes']) {
    assert.equal(byName[name].layout, 'per-record', `${name} 应可单条丢弃`)
    assert.equal(byName[name].invalidRecords, 'backup-and-skip')
  }

  // 来源配置是权威数据：一条坏记录就应当让整次 open 失败，而不是被静默移走。
  assert.equal(sourcesDomain.layout, undefined, 'sources 用默认 single 布局')
  assert.equal(sourcesDomain.invalidRecords, undefined, 'sources 不得声明 backup-and-skip')
  assert.equal(byName['ai_product_radar_opportunities'].invalidRecords, undefined)
})

test('global schema 必须拒绝 null —— 这是 defineDomain 的加载期抛错条件', () => {
  for (const domain of DOMAINS) {
    const result = domain.global.schema.safeParse(null)
    assert.equal(result.success, false, `${domain.name} 的 global schema 接受了 null，会导致插件加载期抛错`)
  }
})

test('global 的 initial 必须能被自己的 schema 通过', () => {
  for (const domain of DOMAINS) {
    const result = domain.global.schema.safeParse(domain.global.initial)
    assert.equal(result.success, true, `${domain.name} 的 initial 不合 schema：${result.error?.message}`)
  }
})

test('openCount 是持久化判据：initial 从 0 开始且 schema 接受自增后的值', () => {
  assert.equal(sourcesDomain.global.initial.openCount, 0)
  assert.equal(sourcesDomain.global.initial.schemaVersion, SCHEMA_VERSION)
  const after = { schemaVersion: SCHEMA_VERSION, openCount: 1, firstOpenedAt: 'T', lastOpenedAt: 'T' }
  assert.equal(sourcesGlobal.safeParse(after).success, true)
})

test('sourceRecord：接受一条真实记录，并补齐默认值', () => {
  const parsed = sourceRecord.parse({
    id: 'openai_news',
    type: 'rss_atom',
    name: 'OpenAI 官方公告',
    canonicalUrl: 'https://example.invalid/feed.xml',
    enabled: true,
    createdAt: 1767225600000,
    updatedAt: 1767225600000,
  })
  // 缺省 config 是空对象：适配器读到空配置会给出明确的配置错误，而不是静默抓一个错地址。
  assert.deepEqual(parsed.config, {})
  // 状态是**推导**出来的（enabled + lastStatus），绝不落盘 —— 存冗余状态一定会漂移。
  assert.equal('status' in parsed, false)
  // 「从未检查」由 lastStatus 缺省表达，而不是靠一个假的 'never' 值。
  assert.equal(parsed.lastStatus, undefined)
  assert.equal(parsed.lastCheckedAt, undefined)
  assert.equal(parsed.lastSuccessAt, undefined)
  assert.equal(parsed.lastError, undefined)
  // 时间一律是 epoch 毫秒整数，不是 ISO 字符串。
  assert.equal(parsed.createdAt, 1767225600000)
})

test('sourceRecord：config 保留适配器自定义的键，不被 schema 静默丢弃', () => {
  const parsed = sourceRecord.parse({
    id: 'gh_1',
    type: 'github_releases',
    name: 'openai/openai-python',
    config: { owner: 'openai', repo: 'openai-python', includePrerelease: true },
    canonicalUrl: 'https://github.com/openai/openai-python/releases.atom',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  })
  // 用 `object()` 会丢掉未声明的键，那等于静默损坏用户配置 —— 所以必须是松散对象。
  assert.deepEqual(parsed.config, { owner: 'openai', repo: 'openai-python', includePrerelease: true })
})

test('sourceRecord：拒绝未知类型与缺失必填字段，且不把失败伪装成成功', () => {
  const base = {
    id: 'x',
    name: 'n',
    type: 'rss_atom',
    config: {},
    canonicalUrl: 'https://example.invalid/f.xml',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
  assert.equal(sourceRecord.safeParse({ ...base, type: 'scrape_anything' }).success, false)
  assert.equal(sourceRecord.safeParse({ ...base, enabled: 'yes' }).success, false)
  // 时间是 ISO 字符串时必须被拒 —— 否则两种时间表示会在存储里长期共存。
  assert.equal(sourceRecord.safeParse({ ...base, createdAt: '2026-01-01T00:00:00.000Z' }).success, false)
  const { id, ...withoutId } = base
  void id
  assert.equal(sourceRecord.safeParse(withoutId).success, false)
})

test('SOURCE_TYPES 必须由适配器注册表推导 —— 这是防"加了类型忘了改域"的那道闸', () => {
  /**
   * 这条测试守的是一个**真实宕机事故**，不是风格问题。
   *
   * P1-04 新增 `github_repo` / `npm_package` 两个适配器时，`SOURCE_TYPES` 还是
   * 一张手写的三元素清单。持久化设施在 `open()` 时逐条校验记录，一条 `type` 不在
   * 枚举里的记录会让**整个域打不开**：`GET /sources`、`POST /sources`、刷新、导出
   * 全部 `STORAGE_OPEN_FAILED`，磁盘上的数据一字未丢却完全不可访问。
   *
   * 所以这里不比一张字面量清单（那只是把手写的第二份拷贝搬进测试），而是断言
   * **注册表与域声明的取值集合逐字相同**：注册一个适配器就应该自动获得"能被存
   * 下来"的资格。
   */
  const registered = listAdapters().map((adapter) => adapter.type)
  assert.deepEqual([...SOURCE_TYPES], registered)
  assert.ok(registered.length >= 5, '至少要有 Releases / 仓库动态 / npm 包 / RSS / 静态页')
  assert.ok(SOURCE_STATUSES.includes('failed'), '必须有明确的失败状态')
  assert.ok(SOURCE_STATUSES.includes('never'), '必须有"从未检查"状态，不能与失败混淆')
})

test('每一个已注册的适配器类型都必须能真的存下来', () => {
  const base = {
    id: 'src_x',
    name: 'n',
    config: {},
    canonicalUrl: 'https://example.invalid/f.xml',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  }
  for (const adapter of listAdapters()) {
    const res = sourceRecord.safeParse({ ...base, type: adapter.type })
    assert.equal(res.success, true, `类型 ${adapter.type} 的记录过不了域 schema —— 它会拖垮整个域`)
  }
  // 枚举仍然要有意义：没注册的类型必须被拒。
  assert.equal(sourceRecord.safeParse({ ...base, type: 'scrape_anything' }).success, false)
})

test('sourceRecord：P1-01 的定时刷新字段必须被声明，不能靠 schema 丢键', () => {
  /**
   * 未声明的键会被结构校验器丢掉。`intervalMinutes` / `failureStreak` 若没写进
   * schema，定时刷新就变成"设置完看着生效、重开域又回到未设置"—— 一个只在重启
   * 之后才暴露的静默失效，比当场报错难查得多。
   */
  const parsed = sourceRecord.parse({
    id: 'src_x',
    name: 'n',
    type: 'github_repo',
    config: { owner: 'openai', repo: 'openai-node' },
    canonicalUrl: 'https://api.github.com/repos/openai/openai-node',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    intervalMinutes: 15,
    failureStreak: 2,
  })
  assert.equal(parsed.intervalMinutes, 15)
  assert.equal(parsed.failureStreak, 2)
  // 缺省时补 0，而不是 undefined —— 界面不该出现两种"没设置"的写法。
  const bare = sourceRecord.parse({
    id: 'src_y',
    name: 'n',
    type: 'rss_atom',
    config: {},
    canonicalUrl: 'https://example.invalid/f.xml',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
  })
  assert.equal(bare.intervalMinutes, 0)
  assert.equal(bare.failureStreak, 0)
})

test('per-record 域的记录键必须满足 JSON 后端的 SAFE_KEY_RE', () => {
  assert.ok(isValidRecordId('rel_2026-01-01_v1'))
  assert.ok(isValidRecordId('a'.repeat(120)))
  for (const bad of ['a.b', 'a:b', 'a/b', 'a b', '', 'a'.repeat(121), '../etc/passwd', null, 42]) {
    assert.equal(isValidRecordId(bad), false, `不该被接受：${String(bad)}`)
  }
  // 记录 id 的正则必须是 SAFE_KEY_RE 的子集（允许更严，不允许更松）
  for (const sample of ['a.b', 'a:b', 'a/b', 'a b']) {
    assert.ok(!ID_PATTERN.test(sample) && !SAFE_KEY_RE.test(sample))
  }
})

test('snapshotRecord 与 opportunityRecord 的必填字段齐全', () => {
  const snapshot = {
    id: 'snap_1',
    sourceId: 'src_1',
    fetchedAt: 1767225600000,
    url: 'https://example.invalid/a',
    statusCode: 200,
    contentFingerprint: '0'.repeat(64),
    normalizedText: 'body',
    textChars: 4,
    textTruncated: false,
    truncated: false,
    title: 't',
    itemCount: 0,
    itemIds: [],
    baseline: true,
  }
  const parsedSnapshot = snapshotRecord.parse(snapshot)
  assert.equal(parsedSnapshot.baseline, true)
  // `itemHashes` 缺省为空对象：没有它就无法判断「某条目被修改了」。
  assert.deepEqual(parsedSnapshot.itemHashes, {})

  // 少任何一个必填字段都必须失败 —— 快照是可比较性的唯一依据，不能半条。
  for (const field of ['contentFingerprint', 'normalizedText', 'textChars', 'itemCount', 'baseline']) {
    const broken = { ...snapshot }
    delete broken[field]
    assert.equal(snapshotRecord.safeParse(broken).success, false, `缺 ${field} 时不该通过`)
  }

  assert.equal(
    opportunityRecord.safeParse({
      id: 'opp_1',
      title: '值得验证的需求',
      status: 'to_research',
      createdAt: 1,
      updatedAt: 1,
    }).success,
    true,
  )
  // 机会状态只允许 SDD 定义的四种
  assert.equal(
    opportunityRecord.safeParse({ id: 'x', title: 't', status: 'doing', createdAt: 1, updatedAt: 1 }).success,
    false,
  )
})
