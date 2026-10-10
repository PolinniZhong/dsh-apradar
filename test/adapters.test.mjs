/**
 * 适配器测试（P1-04）—— GitHub 仓库动态 与 npm 包。
 *
 * ## 为什么这两个类型必须有 fixture
 *
 * 它们是**用户不填地址**的类型：地址由代码按 `owner`/`repo`/包名拼接。这意味着
 * 适配器与远端 API 的形状是硬耦合的 —— 上游改一个字段名，用户那边表现为
 * 「抓取失败」，而我们从日志里看不出是哪一层坏了。所以把**真实响应**存进仓库，
 * 让测试在任何网络环境下都能验证「这个形状我们读得懂」。
 *
 * fixture 是 2026-10-09 从真实端点抓下来的**完整响应**，没有裁剪字段：
 *
 * ```
 * curl -s https://api.github.com/repos/openai/openai-node          > test/fixtures/api/github-repo.json
 * curl -s https://registry.npmjs.org/ai/latest                     > test/fixtures/api/npm-ai-latest.json
 * ```
 *
 * 不裁剪是有意的：裁剪过的 fixture 只能证明"适配器读得懂我裁剩下的那些"。
 *
 * ## 这里测的是「失败状态必须能读懂」
 *
 * P1-04 的原文要求每个新类型有"明确失败状态"。对这两个类型来说这句话尤其要紧：
 * GitHub 用 HTTP 状态码 + `{message}` 表达一切，npm 甚至在 404 时回一个
 * **JSON 字符串** `"Not Found"`（它解析得开，所以如果不专门处理，会一路走到
 * 一句"缺少 name"）。下面每一条失败路径都有断言。
 *
 * 运行：`npm test`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { githubRepoAdapter, repoItems, groupDigits, STAR_MILESTONES } from '../src/host/adapters/github-repo.js'
import { npmPackageAdapter, normalizePackageName, normalizeTag, formatDependencies, manifestItems } from '../src/host/adapters/npm-package.js'
import { getAdapter, listAdapters, listTemplates } from '../src/host/adapters/index.js'
import { itemFingerprint } from '../src/host/fingerprint.js'

const FIXTURES = new URL('./fixtures/api/', import.meta.url)

/** 读一个 fixture 的原始文本。 */
function fixtureText(name) {
  return readFileSync(new URL(name, FIXTURES), 'utf8')
}

/** 读一个 fixture 并解析成对象（用于构造"改一个字段"的变体）。 */
function fixtureJson(name) {
  return JSON.parse(fixtureText(name))
}

/** 造一个成功的抓取结果。 */
function ok(content, extra = {}) {
  return { url: 'https://example.test/', statusCode: 200, content, truncated: false, ...extra }
}

/** 断言某次调用抛出 `AdapterParseError` 并且文案里含某个片段。 */
function assertParseFailure(fn, fragment) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `期望抛错，但调用成功了（期望文案含「${fragment}」）`)
  assert.equal(caught.code, 'ADAPTER_PARSE_FAILED', `期望 ADAPTER_PARSE_FAILED，收到 ${caught.code}`)
  assert.ok(
    String(caught.message).includes(fragment),
    `期望文案含「${fragment}」，实际是「${caught.message}」`,
  )
  return caught
}

/** 断言某次调用抛出 `SourceConfigError`。 */
function assertConfigFailure(fn, fragment) {
  let caught = null
  try {
    fn()
  } catch (error) {
    caught = error
  }
  assert.ok(caught, `期望抛错，但调用成功了（期望文案含「${fragment}」）`)
  assert.equal(caught.code, 'ADAPTER_CONFIG_INVALID', `期望 ADAPTER_CONFIG_INVALID，收到 ${caught.code}`)
  assert.ok(
    String(caught.message).includes(fragment),
    `期望文案含「${fragment}」，实际是「${caught.message}」`,
  )
  return caught
}

/** 把条目数组按 id 索引成 Map。 */
function byId(items) {
  return new Map(items.map((item) => [item.itemId, item]))
}

// ================================================================ GitHub 仓库动态

test('github_repo：真实响应解析出定位信息，且不产生「没有归档」这种空条目', () => {
  const config = githubRepoAdapter.normalizeConfig({ owner: 'openai', repo: 'openai-node' })
  const feed = githubRepoAdapter.parse(ok(fixtureText('github-repo.json')), config)

  assert.equal(feed.title, 'openai/openai-node 仓库动态')
  const items = byId(feed.items)

  // 真实值（2026-10-09）：描述、Topics 三条、Apache-2.0、TypeScript、main、public。
  assert.equal(items.get('description').text, 'Official JavaScript / TypeScript library for the OpenAI API')
  assert.equal(items.get('topics').text, 'nodejs, openai, typescript')
  assert.equal(items.get('license').text, 'Apache-2.0')
  assert.equal(items.get('language').text, 'TypeScript')
  assert.equal(items.get('default_branch').text, 'main')
  assert.equal(items.get('visibility').text, 'public')

  // 归档是单向且罕见的信号：没归档就不该有一条"没有归档"的记录占地方。
  assert.equal(items.has('archived'), false)

  // 11213 stars → 恰好跨过 1000 / 2000 / 5000 / 10000 四道门槛，20000 还没到。
  assert.deepEqual(
    feed.items.filter((item) => item.itemId.startsWith('stars:')).map((item) => item.itemId),
    ['stars:1000', 'stars:2000', 'stars:5000', 'stars:10000'],
  )
  assert.ok(items.get('stars:10000').title.includes('10,000'))
  assert.equal(items.has('stars:20000'), false)
})

test('github_repo：Stars 跨门槛是「新增一条」，没跨门槛时什么都不变', () => {
  const base = fixtureJson('github-repo.json')

  const below = repoItems({ ...base, stargazers_count: 9999 })
  const above = repoItems({ ...base, stargazers_count: 10000 })

  const before = byId(below)
  const after = byId(above)
  assert.equal(before.has('stars:10000'), false)
  assert.equal(after.has('stars:10000'), true)

  // 已跨过的门槛不能因为数字微调而改变指纹 —— 否则每次刷新都会报"内容有修改"。
  const again = byId(repoItems({ ...base, stargazers_count: 10001 }))
  assert.equal(
    itemFingerprint(again.get('stars:1000')),
    itemFingerprint(before.get('stars:1000')),
  )
})

test('github_repo：计数器与 pushed_at 的漂移不产生任何差异（防自噪声）', () => {
  const base = fixtureJson('github-repo.json')
  const before = repoItems(base)
  // 只动计数器和 pushed_at：这三个字段每次抓取都在变。它们一个都不该进差异。
  const after = repoItems({ ...base, forks_count: 99999, open_issues_count: 7, pushed_at: '2030-01-01T00:00:00Z' })

  assert.deepEqual(
    after.map((item) => item.itemId),
    before.map((item) => item.itemId),
  )
  // 不只是 id 相同 —— **指纹也必须相同**。这条是上面那条设计决定的真正判据：
  // 如果里程碑正文里带上"当前 Stars：11,213"，每刷新一次就会给每一道已跨过的
  // 门槛报一次「内容有修改」，真实的信号会被自己的噪声埋掉。
  const beforeMap = byId(before)
  for (const item of after) {
    assert.equal(
      itemFingerprint(item),
      itemFingerprint(beforeMap.get(item.itemId)),
      `${item.itemId} 的指纹不该因为计数器漂移而改变`,
    )
  }
})

test('github_repo：仓库被归档时出现独立条目', () => {
  const base = fixtureJson('github-repo.json')
  const items = byId(repoItems({ ...base, archived: true }))
  assert.ok(items.get('archived'))
  assert.ok(items.get('archived').title.includes('归档'))
  assert.ok(items.get('archived').text.includes('只读'))
})

test('github_repo：描述被改写会改变描述条目的指纹', () => {
  const base = fixtureJson('github-repo.json')
  const before = byId(repoItems(base)).get('description')
  const after = byId(repoItems({ ...base, description: '完全不同的一句话' })).get('description')
  assert.notEqual(itemFingerprint(after), itemFingerprint(before))
})

test('github_repo：没有描述 / 没有 Topics / 没有许可时如实说明，不留空条目', () => {
  const items = byId(repoItems({ full_name: 'a/b', description: null, topics: [], license: null, stargazers_count: 0 }))
  assert.equal(items.get('description').text, '（这个仓库没有填写描述）')
  assert.equal(items.get('topics').text, '（没有设置 Topics）')
  assert.equal(items.get('license').text, '（没有声明开源许可）')
  // GitHub 对「有许可但识别不出」返回 NOASSERTION，含义与"没有许可"不同，但都不能当作一个许可 id。
  assert.equal(byId(repoItems({ full_name: 'a/b', license: { spdx_id: 'NOASSERTION' } })).get('license').text, '（没有声明开源许可）')
  // 0 stars 不产生任何里程碑条目。
  assert.deepEqual(repoItems({ full_name: 'a/b', stargazers_count: 0 }).filter((item) => item.itemId.startsWith('stars:')), [])
})

test('github_repo：predefined milestones 单调递增且不含重复', () => {
  const sorted = [...STAR_MILESTONES].sort((a, b) => a - b)
  assert.deepEqual(STAR_MILESTONES, sorted)
  assert.equal(new Set(STAR_MILESTONES).size, STAR_MILESTONES.length)
  assert.equal(groupDigits(11213), '11,213')
  assert.equal(groupDigits(999), '999')
  assert.equal(groupDigits(1000000), '1,000,000')
})

test('github_repo：地址由代码拼接，不接受用户给的地址', () => {
  const config = githubRepoAdapter.normalizeConfig({ owner: 'openai', repo: 'openai-node' })
  assert.equal(githubRepoAdapter.buildRequest({}, config).url, 'https://api.github.com/repos/openai/openai-node')
  assert.equal(githubRepoAdapter.addressIsGenerated, true)
})

test('github_repo：配置校验把话说清楚', () => {
  assertConfigFailure(() => githubRepoAdapter.normalizeConfig({ repo: 'openai-node' }), '请填写owner')
  assertConfigFailure(() => githubRepoAdapter.normalizeConfig({ owner: 'openai', repo: '' }), '请填写repo')
  assertConfigFailure(() => githubRepoAdapter.normalizeConfig({ owner: 'open ai', repo: 'x' }), '只能包含字母')
  assertConfigFailure(() => githubRepoAdapter.normalizeConfig({ owner: '..', repo: 'x' }), '不合法')
  assertConfigFailure(() => githubRepoAdapter.normalizeConfig({ owner: 'a/../b', repo: 'x' }), '只能包含字母')
})

test('github_repo：失败状态逐条能读懂', () => {
  const config = { owner: 'openai', repo: 'openai-node' }

  // 404：GitHub 回的是 `{message: "Not Found"}`，状态码 404。
  assertParseFailure(
    () => githubRepoAdapter.parse(ok(JSON.stringify({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest', status: '404' }), { statusCode: 404 }), config),
    '仓库不存在',
  )
  // 限流：完全不同的处置（等一会儿 vs 改地址），文案必须能区分。
  assertParseFailure(
    () => githubRepoAdapter.parse(ok(JSON.stringify({ message: "API rate limit exceeded for 1.2.3.4." }), { statusCode: 403 }), config),
    '频率限制',
  )
  // 截断要在 JSON.parse 之前判，否则用户看到的是"不是合法 JSON"。
  const truncated = assertParseFailure(
    () => githubRepoAdapter.parse({ content: '{"full_name":"openai/openai-node"', truncated: true }, config),
    '截断',
  )
  assert.equal(truncated.detail.truncated, true)
  // 空体
  assertParseFailure(() => githubRepoAdapter.parse(ok('   '), config), '为空')
  // 不是 JSON
  assertParseFailure(() => githubRepoAdapter.parse(ok('<html>login</html>'), config), '不是合法 JSON')
  // 合法 JSON 但不是仓库对象（数组）
  assertParseFailure(() => githubRepoAdapter.parse(ok('[1,2,3]'), config), '不是仓库信息')
  // 对象形状但没有 full_name、也没有 message —— 不能猜，直接说读不懂。
  assertParseFailure(() => githubRepoAdapter.parse(ok('{"id":1,"name":"x"}'), config), '不是仓库信息')
})

// ================================================================ npm 包

test('npm_package：真实响应解析出版本、依赖与运行环境', () => {
  const config = npmPackageAdapter.normalizeConfig({ name: 'ai' })
  assert.deepEqual(config, { name: 'ai', tag: 'latest' })

  const feed = npmPackageAdapter.parse(ok(fixtureText('npm-ai-latest.json')), config)
  assert.equal(feed.title, 'ai@7.0.137')

  const items = byId(feed.items)
  // 版本进的是条目 id —— 这样一次发版在差异里表现为「新增：ai@7.0.138」。
  assert.ok(items.has('version:7.0.137'))
  assert.equal(items.get('version:7.0.137').text.includes('Apache-2.0'), true)
  // 真实值：3 个运行时依赖、1 个 peer 依赖、engines.node = ">=22"。
  assert.equal(items.get('dependencies').title, '运行时依赖（3 个）')
  assert.equal(items.get('peerDependencies').title, 'peer 依赖（1 个）')
  assert.equal(items.get('engines').text, 'node@>=22')
  // 这个版本没有被废弃 → 不产生警告条目。
  assert.equal(items.has('deprecated'), false)
  // 单版本清单里没有发布时间，如实留空而不是编一个。
  for (const item of feed.items) assert.equal(item.publishedAt, null)
})

test('npm_package：依赖集合的指纹只取决于内容，不取决于键序', () => {
  const a = formatDependencies({ zod: '^3.0.0', ws: '^8.0.0', undici: '^7.0.0' })
  const b = formatDependencies({ undici: '^7.0.0', zod: '^3.0.0', ws: '^8.0.0' })
  assert.equal(a.text, b.text)
  assert.equal(a.count, 3)
  // 依赖增减会改变指纹（稳定 id + 变化内容 = 「内容有修改」）。
  assert.notEqual(formatDependencies({ zod: '^3.0.0' }).text, a.text)
  assert.deepEqual(formatDependencies(null), { count: 0, text: '' })
  assert.deepEqual(formatDependencies(['nope']), { count: 0, text: '' })
})

test('npm_package：发版表现为新增条目，旧版本 id 消失', () => {
  const config = { name: 'ai', tag: 'latest' }
  const older = { ...fixtureJson('npm-ai-latest.json'), version: '7.0.136' }
  const newer = fixtureJson('npm-ai-latest.json')

  const before = npmPackageAdapter.parse(ok(JSON.stringify(older)), config)
  const after = npmPackageAdapter.parse(ok(JSON.stringify(newer)), config)

  assert.equal(byId(before.items).has('version:7.0.136'), true)
  assert.equal(byId(before.items).has('version:7.0.137'), false)
  assert.equal(byId(after.items).has('version:7.0.137'), true)
  assert.equal(after.title, 'ai@7.0.137')
  // 依赖条目的 id 是稳定的，所以依赖没动时它的指纹也不该动。
  assert.equal(
    itemFingerprint(byId(after.items).get('dependencies')),
    itemFingerprint(byId(before.items).get('dependencies')),
  )
})

test('npm_package：被废弃的版本必须自报家门', () => {
  const manifest = { ...fixtureJson('npm-ai-latest.json'), deprecated: '这个版本有安全问题，请升级到 7.0.138' }
  const items = byId(manifestItems(manifest))
  assert.ok(items.get('deprecated'))
  assert.ok(items.get('deprecated').title.includes('废弃'))
  assert.ok(items.get('deprecated').text.includes('安全问题'))
})

test('npm_package：老包的 license / repository 对象形状也要认', () => {
  const items = byId(manifestItems({
    name: 'legacy',
    version: '1.0.0',
    license: { type: 'MIT', url: 'https://example.test/mit' },
    repository: { type: 'git', url: 'git+https://example.test/legacy.git' },
  }))
  const text = items.get('version:1.0.0').text
  assert.ok(text.includes('许可：MIT'), text)
  assert.ok(text.includes('git+https://example.test/legacy.git'), text)
  // 什么都没声明时也不能显示成 MIT。
  assert.ok(byId(manifestItems({ name: 'x', version: '1.0.0' })).get('version:1.0.0').text.includes('（没有声明）'))
})

test('npm_package：作用域包地址按已验证的形式拼接', () => {
  const config = npmPackageAdapter.normalizeConfig({ name: '@anthropic-ai/sdk' })
  assert.deepEqual(config, { name: '@anthropic-ai/sdk', tag: 'latest' })
  assert.equal(
    npmPackageAdapter.buildRequest({}, config).url,
    'https://registry.npmjs.org/@anthropic-ai/sdk/latest',
  )
  assert.equal(
    npmPackageAdapter.buildRequest({}, npmPackageAdapter.normalizeConfig({ name: 'openai', tag: 'beta' })).url,
    'https://registry.npmjs.org/openai/beta',
  )
  assert.equal(npmPackageAdapter.addressIsGenerated, true)
})

test('npm_package：包名与标签的校验有明确边界', () => {
  assert.equal(normalizePackageName(' openai '), 'openai')
  assert.equal(normalizePackageName('@google/genai'), '@google/genai')
  assertConfigFailure(() => normalizePackageName(''), '请填写包名')
  assertConfigFailure(() => normalizePackageName('@scope/'), '只能包含字母')
  assertConfigFailure(() => normalizePackageName('..'), '不能以点或下划线开头')
  assertConfigFailure(() => normalizePackageName('_private'), '不能以点或下划线开头')
  assertConfigFailure(() => normalizePackageName('a/b/c'), '只能包含字母')
  assertConfigFailure(() => normalizePackageName('x'.repeat(215)), '包名过长')
  // tag 缺省是 latest，填了就必须合法 —— 它会直接进 URL 路径。
  assert.equal(normalizeTag(''), 'latest')
  assert.equal(normalizeTag(undefined), 'latest')
  assert.equal(normalizeTag('1.2.3-beta.1'), '1.2.3-beta.1')
  assertConfigFailure(() => normalizeTag('a b'), '标签只能包含字母')
  assertConfigFailure(() => normalizeTag('a/b'), '标签只能包含字母')
})

test('npm_package：失败状态逐条能读懂', () => {
  const config = { name: 'this-package-does-not-exist-xyz123', tag: 'latest' }

  // npm 在 404 时回的是一个**JSON 字符串** `"Not Found"`。
  // 它 JSON.parse 得开，所以如果不专门处理，会一路走到一句"缺少版本号"。
  assertParseFailure(
    () => npmPackageAdapter.parse(ok('"Not Found"', { statusCode: 404 }), config),
    'npm 上没有 this-package-does-not-exist-xyz123@latest',
  )
  // 另一种错误形状是 `{error: "..."}`。
  assertParseFailure(
    () => npmPackageAdapter.parse(ok(JSON.stringify({ error: 'version not found: 9.9.9' })), { name: 'ai', tag: '9.9.9' }),
    'npm 返回了错误：version not found: 9.9.9',
  )
  // 形状对但没有版本号 —— 不能猜。
  assertParseFailure(() => npmPackageAdapter.parse(ok('{"name":"ai"}'), { name: 'ai', tag: 'latest' }), '没有版本号')
  // 数组不是清单。
  assertParseFailure(() => npmPackageAdapter.parse(ok('[]'), { name: 'ai', tag: 'latest' }), '不是 npm 包清单')
  // 截断优先于"不是合法 JSON"。
  assertParseFailure(
    () => npmPackageAdapter.parse({ content: '{"name":"ai","vers', truncated: true }, { name: 'ai', tag: 'latest' }),
    '截断',
  )
  // 空体
  assertParseFailure(() => npmPackageAdapter.parse(ok(''), { name: 'ai', tag: 'latest' }), '为空')
})

// ================================================================ 注册表一致性

test('新增的两种类型都已注册，且按「代码拼地址的排前面」的顺序', () => {
  const order = listAdapters().map((adapter) => adapter.type)
  assert.deepEqual(order, ['github_releases', 'github_repo', 'npm_package', 'rss_atom', 'html_static'])
  assert.ok(getAdapter('github_repo'))
  assert.ok(getAdapter('npm_package'))
  // 有条件（依赖用户自己找地址 / 站点结构）的必须排在无条件的后面。
  const conditionals = listAdapters().map((adapter) => adapter.conditional)
  assert.deepEqual(conditionals, [false, false, false, true, true])
})

test('预置模板里每一条的地址都真的是代码拼的', () => {
  const templates = listTemplates()
  assert.ok(templates.length >= 3)
  for (const tpl of templates) {
    const adapter = getAdapter(tpl.type)
    assert.ok(adapter, `模板 ${tpl.id} 的类型 ${tpl.type} 必须已注册`)
    assert.equal(adapter.addressIsGenerated, true, `模板 ${tpl.id} 的类型 ${tpl.type} 没有声明地址由代码拼接`)
    // 用模板的 config 走一遍归一与地址拼接 —— 模板自己也得能过校验。
    const config = adapter.normalizeConfig(tpl.config)
    const request = adapter.buildRequest({}, config)
    assert.match(request.url, /^https:\/\//)
  }
  // 三种受控类型各要有模板，否则"预置模板"这件事只做了一半。
  for (const type of ['github_releases', 'github_repo', 'npm_package']) {
    assert.ok(templates.some((tpl) => tpl.type === type), `${type} 缺少预置模板`)
  }
})

test('两个新适配器都遵守「解析失败必须抛错，绝不返回空数组」', () => {
  // 返回空数组会让上层得出「这个来源没有更新」的结论 —— 那是我们无权做的断言。
  for (const [adapter, config, body] of [
    [githubRepoAdapter, { owner: 'a', repo: 'b' }, '{oops'],
    [npmPackageAdapter, { name: 'a', tag: 'latest' }, '{oops'],
  ]) {
    let caught = null
    try {
      adapter.parse(ok(body), config)
    } catch (error) {
      caught = error
    }
    assert.ok(caught, `${adapter.type} 在无法解析时必须抛错`)
  }
})
