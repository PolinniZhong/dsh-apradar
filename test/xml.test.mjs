/**
 * 严格子集 XML 解析器与 RSS 2.0 / Atom 1.0 提要提取器的契约测试。
 *
 * 这里断言的是**提要适配器真的会依赖的那些行为**：条目粒度、正文优先级、
 * 时间去哪儿了、以及「畸形输入必须失败而不是静默变成空提要」。
 *
 * 运行：`node --test test/xml.test.mjs`
 * （本文件是唯一允许出现 `node:` 的地方：测试需要读 fixture 文件。）
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'

import { parseFeed, parseXmlSubset, toEpochMs, xmlDepth } from '../src/host/parse/xml.js'

/** fixture 目录：`test/fixtures/feeds`。 */
const FEED_DIR = join(import.meta.dirname, 'fixtures', 'feeds')

/** 所有失败都必须是这个稳定错误码（SDD §7.1）。 */
const PARSE_FAILED = 'ADAPTER_PARSE_FAILED'

/**
 * 读一个 fixture。
 * @param {string} name 文件名
 * @returns {string} 文本
 */
function fixture(name) {
  return readFileSync(join(FEED_DIR, name), 'utf8')
}

/**
 * 读一个 fixture 并解析，断言成功。
 * @param {string} name 文件名
 * @returns {object} 解析结果
 */
function parseFixture(name) {
  const result = parseFeed(fixture(name))
  assert.equal(result.ok, true, `${name} 应当解析成功，实际失败：${result.message}`)
  return result
}

/* ================================================================== *
 * 1. fixture：GitHub releases.atom
 * ================================================================== */

test('github-releases.atom：识别为 Atom，条目与 id/链接/时间都对得上', () => {
  const feed = parseFixture('github-releases.atom')
  assert.equal(feed.kind, 'atom')
  assert.equal(feed.title, 'Release notes from dsh')
  assert.equal(feed.items.length, 2)

  const [latest, previous] = feed.items
  assert.equal(latest.itemId, 'tag:github.com,2008:Repository/123/v1.2.0')
  assert.equal(latest.title, 'v1.2.0')
  // <updated>2024-05-14T09:12:00Z</updated>
  assert.equal(latest.publishedAt, Date.UTC(2024, 4, 14, 9, 12, 0))
  // 必须选中 rel="alternate"，而不是同一条目里的 media:thumbnail 或 feed 级 link
  assert.equal(latest.url, 'https://github.com/dsh-labs/dsh/releases/tag/v1.2.0')
  assert.notEqual(latest.text, '')

  assert.equal(previous.itemId, 'tag:github.com,2008:Repository/123/v1.1.0')
  assert.equal(previous.publishedAt, Date.UTC(2024, 3, 2, 3, 40, 11))
  assert.equal(previous.url, 'https://github.com/dsh-labs/dsh/releases/tag/v1.1.0')
})

test('github-releases.atom：正文里的 HTML 实体被解码，得到可用的正文', () => {
  const feed = parseFixture('github-releases.atom')
  const text = feed.items[0].text
  assert.match(text, /What's Changed/)
  assert.match(text, /新增「关注源批量刷新」/)
  // 实体已解码：不该再有 &lt; / &apos; / &quot; 这类残渣
  assert.doesNotMatch(text, /&lt;|&gt;|&apos;|&quot;|&amp;/)
})

test('parseXmlSubset：命名空间前缀同时可按本地名与限定名匹配', () => {
  const doc = parseXmlSubset(
    '<feed xmlns:media="http://x"><entry><media:thumbnail url="https://a/b?x=1&amp;y=2"/></entry></feed>',
  )
  assert.equal(doc.ok, true)
  const entry = doc.root.children[0]
  const thumb = entry.children[0]
  // 本地名剥掉前缀，限定名留在 raw 里
  assert.equal(thumb.name, 'thumbnail')
  assert.equal(thumb.raw, 'media:thumbnail')
  // attrs 逐字保留，且实体在属性值里也被解码
  assert.equal(thumb.attrs.url, 'https://a/b?x=1&y=2')
})

test('parseXmlSubset：xml 前缀的属性既能按 xml:lang 也能按 lang 取到', () => {
  const doc = parseXmlSubset('<feed xml:lang="en-US" xmlns="http://www.w3.org/2005/Atom"/>')
  assert.equal(doc.ok, true)
  assert.equal(doc.root.attrs['xml:lang'], 'en-US')
  assert.equal(doc.root.attrs.lang, 'en-US')
})

/* ================================================================== *
 * 2. fixture：RSS 2.0
 * ================================================================== */

test('rss20-basic.xml：RFC 822 时间、guid、CDATA 正文', () => {
  const feed = parseFixture('rss20-basic.xml')
  assert.equal(feed.kind, 'rss')
  assert.equal(feed.title, '示例产品博客')
  assert.equal(feed.items.length, 2)

  const [first, second] = feed.items
  assert.equal(first.itemId, 'example-blog-post-1001')
  // <pubDate>Tue, 03 Jun 2008 11:05:30 GMT</pubDate>
  assert.equal(first.publishedAt, 1212491130000)
  assert.equal(first.url, 'https://example.com/blog/api-pricing')
  assert.notEqual(first.text, '')

  assert.equal(second.itemId, 'example-blog-post-1002')
  // <pubDate>Mon, 02 Jun 2008 08:15:00 +0200</pubDate> → 06:15Z
  assert.equal(second.publishedAt, 1212387300000)
})

test('CDATA 内容逐字保留（不做实体解码、不剥标签）', () => {
  const feed = parseFixture('rss20-basic.xml')
  const text = feed.items[0].text
  assert.match(text, /<p>从今天起，API 调用按量计费，<strong>无需预付费<\/strong>。<\/p>/)
  assert.match(text, /<p>价格与配额详见文档。<\/p>/)
  // CDATA 里的裸 & 与 < 不该被当成标记或实体
  assert.match(text, /<strong>/)
})

test('RSS：content:encoded 优先于 description', () => {
  const feed = parseFixture('rss20-basic.xml')
  const second = feed.items[1]
  assert.match(second.text, /新版控制台重构了导航/)
  assert.doesNotMatch(second.text, /简化版摘要/)
})

/* ================================================================== *
 * 3. fixture：Atom 1.0
 * ================================================================== */

test('atom10-basic.xml：id / updated 小数秒与偏移 / content 优先于 summary', () => {
  const feed = parseFixture('atom10-basic.xml')
  assert.equal(feed.kind, 'atom')
  assert.equal(feed.title, 'AI 产品观察 · Atom 1.0')
  assert.equal(feed.items.length, 1)

  const entry = feed.items[0]
  assert.equal(entry.itemId, 'urn:uuid:1225c695-cfb8-4ebb-aaaa-80da344efa6a')
  assert.equal(entry.title, '某模型把长上下文价格下调 40%')
  // <updated>2008-06-03T11:05:30.123+02:00</updated>
  assert.equal(entry.publishedAt, 1212483930123)
  assert.equal(entry.url, 'https://example.org/posts/long-context-price')
  assert.match(entry.text, /不再区分输入输出/)
  assert.doesNotMatch(entry.text, /简要说明/)
})

test('Atom：缺省 rel 视为 alternate，rel 非 alternate 时不选它', () => {
  const feed = parseFeed(
    '<feed><entry><id>1</id>' +
      '<link rel="enclosure" href="https://example.com/a.mp3"/>' +
      '<link href="https://example.com/page"/>' +
      '</entry></feed>',
  )
  assert.equal(feed.ok, true)
  assert.equal(feed.items[0].url, 'https://example.com/page')
})

/* ================================================================== *
 * 4. 空提要 / 畸形输入 / 非提要
 * ================================================================== */

test('空提要是合法结果：ok:true 且 items 为空数组', () => {
  const feed = parseFixture('empty-feed.xml')
  assert.equal(feed.kind, 'rss')
  assert.equal(feed.title, '暂时没有条目的提要')
  assert.deepEqual(feed.items, [])

  // 最小形态同样合法
  const minimal = parseFeed('<rss><channel></channel></rss>')
  assert.deepEqual(minimal, { ok: true, kind: 'rss', title: '', items: [] })
})

test('标签不闭合：失败并给出可读原因', () => {
  const result = parseFeed(fixture('malformed-unclosed.xml'))
  assert.equal(result.ok, false)
  assert.equal(result.code, PARSE_FAILED)
  assert.equal(typeof result.message, 'string')
  assert.match(result.message, /[不未]匹配|未闭合/)
})

test('格式良好但不是提要：失败且文案指明只支持 RSS/Atom', () => {
  const source = fixture('malformed-not-a-feed.xml')
  // XML 本身是好的
  assert.equal(parseXmlSubset(source).ok, true)
  const result = parseFeed(source)
  assert.equal(result.ok, false)
  assert.equal(result.code, PARSE_FAILED)
  assert.equal(result.message, '不是受支持的 RSS 2.0 或 Atom 1.0 文档')
})

test('RSS 根缺少 channel 时失败，而不是退化成空提要', () => {
  const result = parseFeed('<rss version="2.0"></rss>')
  assert.equal(result.ok, false)
  assert.equal(result.code, PARSE_FAILED)
  assert.match(result.message, /channel/)
})

test('未闭合的注释与 CDATA 都失败关闭', () => {
  const comment = parseXmlSubset('<a><!-- never closed</a>')
  assert.equal(comment.ok, false)
  assert.match(comment.message, /注释/)

  const cdata = parseXmlSubset('<a><![CDATA[ never closed </a>')
  assert.equal(cdata.ok, false)
  assert.match(cdata.message, /CDATA/)
})

test('多余的结束标签 / 第二个根元素 / 根元素外文本都失败', () => {
  for (const bad of ['<a></a></b>', '<a/><b/>', 'oops<a/>', '<a><b></a></b>']) {
    const result = parseXmlSubset(bad)
    assert.equal(result.ok, false, `应当失败：${bad}`)
    assert.equal(result.code, PARSE_FAILED)
  }
})

test('非字符串输入返回失败而不是抛异常', () => {
  for (const bad of [null, undefined, 42, {}, ['<a/>']]) {
    const result = parseXmlSubset(bad)
    assert.equal(result.ok, false)
    assert.equal(result.code, PARSE_FAILED)
  }
})

test('属性值必须带引号；`>` 写在属性值里不会提前结束标签', () => {
  // XML 不允许无引号属性值 —— 这类输入若被宽容处理，属性会静默错位
  for (const bad of ['<a href=x/>', '<a b=/>', '<a href="x>']) {
    const result = parseXmlSubset(bad)
    assert.equal(result.ok, false, `应当失败：${bad}`)
    assert.match(result.message, /引号/)
  }

  const withGt = parseXmlSubset('<a title="1 > 0">ok</a>')
  assert.equal(withGt.ok, true)
  assert.equal(withGt.root.attrs.title, '1 > 0')
  assert.equal(withGt.root.text, 'ok')
})

test('空文档与空白文档都失败，而不是被当成空提要', () => {
  for (const bad of ['', '   \n\t ', '<!-- 只有注释 -->']) {
    const result = parseXmlSubset(bad)
    assert.equal(result.ok, false)
    assert.equal(result.code, PARSE_FAILED)
    assert.match(result.message, /根元素/)
  }
})

test('RSS 1.0（rdf:RDF）和非 feed 根元素都返回「不受支持」', () => {
  for (const bad of ['<rdf:RDF xmlns:rdf="http://x"></rdf:RDF>', '<Rss><channel/></Rss>']) {
    const result = parseFeed(bad)
    assert.equal(result.ok, false)
    assert.equal(result.code, PARSE_FAILED)
    assert.equal(result.message, '不是受支持的 RSS 2.0 或 Atom 1.0 文档')
  }
})

test('非法码位的字符引用保留原样（不构造坏字符串）', () => {
  for (const bad of ['&#xZZ;', '&#0;', '&#xD800;', '&#x110000;']) {
    const result = parseXmlSubset(`<a>${bad}</a>`)
    assert.equal(result.ok, true)
    assert.equal(result.root.text, bad, `非法引用应原样保留：${bad}`)
  }
  // 裸 `&` 不是实体，原样保留
  assert.equal(parseXmlSubset('<a>a & b</a>').root.text, 'a & b')
})

/* ================================================================== *
 * 5. DTD / 实体安全
 * ================================================================== */

test('DTD 实体安全：内部实体不被展开，SYSTEM 实体不被触及', () => {
  const source = fixture('doctype-entity.xml')
  // 前提：fixture 里确实写了载荷，否则这个测试就是空转
  assert.match(source, /PWNED/)
  assert.match(source, /<!ENTITY xxe/)
  assert.match(source, /SYSTEM/)

  const doc = parseXmlSubset(source)
  const doomed = parseFeed(source)

  // `<!DOCTYPE>` 本身按不透明 token 跳过；一旦读到 `<!ENTITY` 就失败关闭。
  // 两条路都不会把 &xxe; 解释成 PWNED，所以这里只钉死「绝不展开」这一条安全性质。
  if (!doc.ok) {
    assert.equal(doc.code, PARSE_FAILED)
    assert.match(doc.message, /DOCTYPE|ENTITY/)
  } else {
    // 若实现改成整段跳过 DTD，则 &xxe; 只能作为未知实体保留为字面量
    assert.doesNotMatch(JSON.stringify(doc), /PWNED/)
  }

  // 无论走哪条分支，调用方都拿不到展开后的载荷
  assert.doesNotMatch(JSON.stringify({ doc, doomed }), /PWNED/)
})

test('未知实体原样保留，不会去找外部定义', () => {
  const result = parseFeed(
    '<rss><channel><title>t</title><item><guid>g</guid>' +
      '<description>&xxe; &foo; &amp; &lt;</description></item></channel></rss>',
  )
  assert.equal(result.ok, true)
  // `&xxe;` / `&foo;` 找不到定义 → 原样保留；`&amp;` / `&lt;` 是内置实体 → 正常解码
  assert.equal(result.items[0].text, '&xxe; &foo; & <')
})

/* ================================================================== *
 * 6. 实体与 BOM
 * ================================================================== */

test('命名实体与数字实体（含十六进制）都能解码', () => {
  const doc = parseXmlSubset(
    '<a>&amp;&lt;&gt;&quot;&apos;&nbsp;&mdash;&hellip;&copy;&times;&#39;&#x27;&#8212;</a>',
  )
  assert.equal(doc.ok, true)
  assert.equal(
    doc.root.text,
    // &#39; 与 &#x27; 都是 ASCII 撇号（U+0027），不是 &rsquo; 的 U+2019
    '&<>"\'\u00a0\u2014\u2026\u00a9\u00d7\u0027\u0027\u2014',
    '实体解码结果不符（\\u00a0 是不换行空格，\\u2019/\\u2014 是排版符号）',
  )
})

test('UTF-8 BOM 被剥掉，根元素名不带不可见字符', () => {
  const doc = parseXmlSubset('\ufeff<rss version="2.0"><channel/></rss>')
  assert.equal(doc.ok, true)
  assert.equal(doc.root.name, 'rss')
})

test('XML 声明、注释、处理指令不影响解析', () => {
  const doc = parseXmlSubset('<?xml version="1.0"?>\n<!-- 前导注释 -->\n<?dsh keep?>\n' + fixture('empty-feed.xml'))
  assert.equal(doc.ok, true)
  assert.equal(doc.root.name, 'rss')
})

test('自闭合标签不进 children，深度计数正确', () => {
  const doc = parseXmlSubset('<rss><channel><item/></channel></rss>')
  assert.equal(doc.ok, true)
  assert.equal(xmlDepth(doc.root), 3)
  assert.deepEqual(doc.root.children[0].children[0].children, [])
})

/* ================================================================== *
 * 7. 时间解析
 * ================================================================== */

test('toEpochMs：RFC 822 / RFC 3339 的固定取值表', () => {
  /** @type {Array<[string, number|null]>} */
  const cases = [
    // RFC 822 带工作日
    ['Wed, 02 Oct 1996 08:00:00 GMT', 844243200000],
    // RFC 822 无工作日
    ['03 Jun 2008 11:05:30 GMT', 1212491130000],
    // RFC 822 数字偏移
    ['Mon, 02 Jun 2008 08:15:00 +0200', 1212387300000],
    // RFC 822 两位年份（96 → 1996）
    ['Wed, 02 Oct 96 08:00:00 GMT', 844243200000],
    // RFC 822 两位年份（04 → 2004）
    ['Tue, 03 Jun 04 11:05:30 GMT', 1086260730000],
    // RFC 822 省略秒
    ['Tue, 03 Jun 2008 11:05 GMT', 1212491100000],
    // RFC 3339 的 Z
    ['2008-06-03T11:05:30Z', 1212491130000],
    // RFC 3339 小数秒 + 偏移
    ['2008-06-03T11:05:30.123+02:00', 1212483930123],
    // 日期-only
    ['2008-06-03', 1212451200000],
    // 无法解析：返回 null，绝不猜
    ['随便什么东西', null],
    ['', null],
    ['2008-02-30', null],
    ['2024-13-01', null],
  ]
  for (const [input, expected] of cases) {
    assert.equal(toEpochMs(input), expected, `时间解析不符：${JSON.stringify(input)}`)
  }
})

test('toEpochMs：非字符串输入返回 null', () => {
  for (const bad of [null, undefined, 0, {}, []]) {
    assert.equal(toEpochMs(bad), null)
  }
})

test('时间缺失或不可解析时 publishedAt 为 null，而不是猜一个时间', () => {
  const feed = parseFeed(
    '<rss><channel><item><guid>a</guid><title>A</title><pubDate>nonsense</pubDate></item>' +
      '<item><guid>b</guid><title>B</title></item></channel></rss>',
  )
  assert.equal(feed.ok, true)
  assert.equal(feed.items[0].publishedAt, null)
  assert.equal(feed.items[1].publishedAt, null)
})

/* ================================================================== *
 * 8. 深度防护与确定性
 * ================================================================== */

test('深度防护：200 层嵌套失败关闭，而不是爆栈', () => {
  const depth = 200
  const deep = '<a>'.repeat(depth) + 'x' + '</a>'.repeat(depth)
  const result = parseXmlSubset(deep)
  assert.equal(result.ok, false)
  assert.equal(result.code, PARSE_FAILED)
  assert.match(result.message, /深度/)

  // 上限之内仍然可用
  const okDepth = 60
  const fine = parseXmlSubset('<a>'.repeat(okDepth) + 'x' + '</a>'.repeat(okDepth))
  assert.equal(fine.ok, true)
  assert.equal(xmlDepth(fine.root), okDepth)
})

test('解析是确定性的：同一输入两次得到完全相同的结构', () => {
  for (const name of ['github-releases.atom', 'rss20-basic.xml', 'atom10-basic.xml']) {
    const source = fixture(name)
    assert.deepEqual(parseFeed(source), parseFeed(source), `${name} 两次解析结果不一致`)
  }
})

test('条目形状固定：五个字段都在，且 URL 为 null 而不是空串', () => {
  const feed = parseFeed('<rss><channel><item><title>只有标题</title></item></channel></rss>')
  assert.equal(feed.ok, true)
  assert.deepEqual(Object.keys(feed.items[0]).sort(), ['itemId', 'publishedAt', 'text', 'title', 'url'])
  assert.equal(feed.items[0].itemId, '')
  assert.equal(feed.items[0].url, null)
  // 正文兜底到标题
  assert.equal(feed.items[0].text, '只有标题')
})
