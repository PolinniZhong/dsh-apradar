/**
 * 文本解析与规范化模块的契约测试。
 *
 * 覆盖三件事，都是"错了会静默出错"的地方：
 *
 *   1. 实体解码 —— 未知引用 / 非法码点必须**原样保留**，单趟不递归
 *   2. HTML → 文本 —— 对抗性输入不能挂、不能被属性里的 `>` 骗到、不能丢正文
 *   3. 规范化 —— 确定性（幂等）、无 locale 依赖、URL 去重键的正确形状
 *
 * 运行：`node --test test/normalize.test.mjs`
 * （`node:` 前缀只在测试里允许；`src/` 内部禁止。）
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeEntities } from '../src/host/parse/entities.js'
import { htmlStructureFingerprint, stripHtmlToText } from '../src/host/parse/html-text.js'
import {
  MAX_NORMALIZED_TEXT_CHARS,
  canonicalize,
  normalizeText,
  normalizeUrl,
} from '../src/host/normalize.js'

// ---------------------------------------------------------------------------
// 1. 实体解码
// ---------------------------------------------------------------------------

test('decodeEntities：XML 五个内建实体全部解出', () => {
  assert.equal(decodeEntities('&amp;'), '&')
  assert.equal(decodeEntities('&lt;'), '<')
  assert.equal(decodeEntities('&gt;'), '>')
  assert.equal(decodeEntities('&quot;'), '"')
  assert.equal(decodeEntities('&apos;'), "'")
  assert.equal(decodeEntities('&amp;&lt;&gt;&quot;&apos;'), '&<>"\'')
})

test('decodeEntities：常见具名实体', () => {
  assert.equal(decodeEntities('&nbsp;'), '\u00A0')
  assert.equal(decodeEntities('&mdash;'), '\u2014')
  assert.equal(decodeEntities('&ndash;'), '\u2013')
  assert.equal(decodeEntities('&hellip;'), '\u2026')
  assert.equal(decodeEntities('&copy;'), '\u00A9')
  assert.equal(decodeEntities('&reg;'), '\u00AE')
  assert.equal(decodeEntities('&trade;'), '\u2122')
  assert.equal(decodeEntities('&laquo;'), '\u00AB')
  assert.equal(decodeEntities('&raquo;'), '\u00BB')
  assert.equal(decodeEntities('&middot;'), '\u00B7')
  assert.equal(decodeEntities('&bull;'), '\u2022')
  assert.equal(decodeEntities('&times;'), '\u00D7')
  assert.equal(decodeEntities('&divide;'), '\u00F7')
  assert.equal(decodeEntities('&deg;'), '\u00B0')
  assert.equal(decodeEntities('&larr;'), '\u2190')
  assert.equal(decodeEntities('&rarr;'), '\u2192')
  assert.equal(decodeEntities('&ne;'), '\u2260')
  assert.equal(decodeEntities('&le;'), '\u2264')
  assert.equal(decodeEntities('&ge;'), '\u2265')
  assert.equal(decodeEntities('&asymp;'), '\u2248')
})

test('decodeEntities：十进制与十六进制数值引用（含大写 X）', () => {
  assert.equal(decodeEntities('&#39;'), "'")
  assert.equal(decodeEntities('&#x27;'), "'")
  assert.equal(decodeEntities('&#X27;'), "'")
  assert.equal(decodeEntities('&#8212;'), '\u2014')
  assert.equal(decodeEntities('&#x2014;'), '\u2014')
  assert.equal(decodeEntities('&#X1F600;'), '\u{1F600}')
  assert.equal(decodeEntities('&#65;&#66;&#67;'), 'ABC')
})

test('decodeEntities：未知引用原样保留，绝不静默丢弃', () => {
  assert.equal(decodeEntities('&notanentity;'), '&notanentity;')
  assert.equal(decodeEntities('a &unknown; b'), 'a &unknown; b')
  assert.equal(decodeEntities('&foobar'), '&foobar')
  assert.equal(decodeEntities('&;'), '&;')
  assert.equal(decodeEntities('100% & more'), '100% & more')
  // 原型链上的名字不能被当成实体（`&constructor;` 必须保持字面量）
  assert.equal(decodeEntities('&constructor;'), '&constructor;')
  assert.equal(decodeEntities('&toString;'), '&toString;')
  assert.equal(decodeEntities('&hasOwnProperty;'), '&hasOwnProperty;')
})

test('decodeEntities：非法码点原样保留，不产出孤立代理或越界字符', () => {
  // 代理区
  assert.equal(decodeEntities('&#xD800;'), '&#xD800;')
  assert.equal(decodeEntities('&#55296;'), '&#55296;')
  assert.equal(decodeEntities('&#xDFFF;'), '&#xDFFF;')
  // 超出 Unicode 上限
  assert.equal(decodeEntities('&#x110000;'), '&#x110000;')
  assert.equal(decodeEntities('&#1114112;'), '&#1114112;')
  // 合法边界仍然要解出来
  assert.equal(decodeEntities('&#x10FFFF;'), '\u{10FFFF}')
  assert.equal(decodeEntities('&#xE9;'), '\u00E9')
})

test('decodeEntities：单趟解码，不递归', () => {
  // `&amp;lt;` 必须解成 `&lt;`，不能继续解成 `<`
  assert.equal(decodeEntities('&amp;lt;'), '&lt;')
  assert.equal(decodeEntities('&amp;amp;'), '&amp;')
  // 二次解码结果不同，正是"单趟"的证据
  assert.notEqual(decodeEntities(decodeEntities('&amp;lt;')), '&lt;')
})

test('decodeEntities：非字符串与空输入', () => {
  assert.equal(decodeEntities(''), '')
  assert.equal(decodeEntities(null), '')
  assert.equal(decodeEntities(undefined), '')
  assert.equal(decodeEntities(123), '')
  // 无 `&` 时返回按值相等的结果
  assert.equal(decodeEntities('普通文本'), '普通文本')
})

// ---------------------------------------------------------------------------
// 2. stripHtmlToText
// ---------------------------------------------------------------------------

test('stripHtmlToText：script/style/noscript 连同内容一起丢弃（大小写与属性）', () => {
  assert.equal(stripHtmlToText('<script>var a = 1</script>可见'), '可见')
  assert.equal(stripHtmlToText('<SCRIPT>var a = 1</SCRIPT>可见'), '可见')
  assert.equal(stripHtmlToText('<script src="x.js" type="module">if (a<b) {}</script>可见'), '可见')
  assert.equal(stripHtmlToText('<style>.a { color: red }</style>文本'), '文本')
  assert.equal(stripHtmlToText('<noscript><p>请开启 JS</p></noscript>文本'), '文本')
})

test('stripHtmlToText：未闭合的 script 丢弃到输入末尾', () => {
  assert.equal(stripHtmlToText('前<script>未闭合 var x = 1'), '前')
  assert.equal(stripHtmlToText('后部没了<style>body{}'), '后部没了')
})

test('stripHtmlToText：注释被删除；未闭合注释丢弃到末尾', () => {
  assert.equal(stripHtmlToText('A<!-- 这是一段注释 -->B'), 'AB')
  assert.equal(stripHtmlToText('A<!-- 注释 <p>x</p> -->B'), 'AB')
  assert.equal(stripHtmlToText('A<!-- 未闭合 B <p>x</p>'), 'A')
  assert.equal(stripHtmlToText('<!--[if IE]><p>x</p><![endif]-->正文'), '正文')
})

test('stripHtmlToText：块级标签变成换行', () => {
  assert.equal(stripHtmlToText('<p>a</p><p>b</p>'), '\na\n\nb\n')
  assert.equal(stripHtmlToText('<div>a</div><span>b</span>'), '\na\nb')
  assert.equal(stripHtmlToText('a<br>b'), 'a\nb')
  assert.equal(stripHtmlToText('a<br/>b'), 'a\nb')
  assert.equal(stripHtmlToText('a<hr>b'), 'a\nb')
  assert.equal(stripHtmlToText('<h1>标题</h1><h2>子标题</h2>'), '\n标题\n\n子标题\n')
  assert.equal(stripHtmlToText('<ul><li>一</li><li>二</li></ul>'), '\n\n一\n\n二\n\n')
  // 规则：**每个**块级标签（开或闭）各在它所在位置产生一个 `\n`，不合并。
  // table/tr/td 三个开标签 → 3 个 `\n`；三个闭标签 → 3 个 `\n`。
  assert.equal(stripHtmlToText('<table><tr><td>c</td></tr></table>'), '\n\n\nc\n\n\n')
  // 行内标签不制造换行
  assert.equal(stripHtmlToText('<p>a<b>粗</b>c</p>'), '\na粗c\n')
})

test('stripHtmlToText：属性值里的 `>` 不会提前结束标签', () => {
  assert.equal(stripHtmlToText('<a href="a>b">x</a>'), 'x')
  assert.equal(stripHtmlToText("<a href='a>b'>x</a>"), 'x')
  assert.equal(stripHtmlToText('<a title="1 > 0" href="/x">点这里</a>正文'), '点这里正文')
  // 属性值里出现的 `<p>` 是**属性文本**，不是元素；只有 div 的一开一闭各给一个 `\n`。
  assert.equal(stripHtmlToText('<div data-x="<p>">真文本</div>'), '\n真文本\n')
})

test('stripHtmlToText：不成标签的 `<` 当字面文本', () => {
  assert.equal(stripHtmlToText('a < b and 3<4'), 'a < b and 3<4')
  assert.equal(stripHtmlToText('未闭合 <div 正文'), '未闭合 <div 正文')
  assert.equal(stripHtmlToText('价格 <100 元'), '价格 <100 元')
})

test('stripHtmlToText：文本级解码实体，且不清洗空白（那是 normalize 的活）', () => {
  assert.equal(stripHtmlToText('<p>a&amp;b</p>'), '\na&b\n')
  assert.equal(stripHtmlToText('<p>&lt;tag&gt;</p>'), '\n<tag>\n')
  assert.equal(stripHtmlToText('&nbsp;&mdash;'), '\u00A0\u2014')
  // 未知实体原样保留
  assert.equal(stripHtmlToText('x&notanentity;y'), 'x&notanentity;y')
  // 不清洗空白：连续空行照原样保留
  // 原文里那 3 个裸换行**不清洗**，与段落标签产生的换行叠加：
  // `</p>` 的 `\n` + 裸 `\n\n\n` + `<p>` 的 `\n` = a 与 b 之间 5 个 `\n`。
  assert.equal(stripHtmlToText('<p>a</p>\n\n\n<p>b</p>'), '\na\n\n\n\n\nb\n')
})

test('stripHtmlToText：清除 NUL 与 C0 控制字符，保留 \\n 与 \\t', () => {
  assert.equal(stripHtmlToText('a\u0000b\u0001c\u0007d'), 'abcd')
  assert.equal(stripHtmlToText('a\n\tb\u000Bc'), 'a\n\tbc')
  assert.equal(stripHtmlToText('删除\u007F符'), '删除符')
})

test('stripHtmlToText：非字符串与空输入', () => {
  assert.equal(stripHtmlToText(''), '')
  assert.equal(stripHtmlToText(null), '')
  assert.equal(stripHtmlToText(undefined), '')
  assert.equal(stripHtmlToText(42), '')
})

test('stripHtmlToText：对抗性输入不挂死（大量未闭合标签）', () => {
  // 这些构造正是懒惰正则最容易退化的形状；手写扫描必须是线性的。
  // `<script` 没有 `>`，**不成标签**，按字面文本原样保留 —— 与
  // `'未闭合 <div 正文'` 同一条规则。这里要验的是"不挂死"，不是"被丢掉"。
  const hostile = '<script'.repeat(5000)
  const startedAt = Date.now()
  const out = stripHtmlToText(hostile)
  assert.equal(out, hostile)
  assert.ok(Date.now() - startedAt < 5000, '未闭合 script 堆叠耗时过长')

  const hostile2 = '<!--'.repeat(5000)
  assert.equal(stripHtmlToText(hostile2), '')

  const hostile3 = '<div '.repeat(5000)
  assert.equal(stripHtmlToText(hostile3), hostile3)
})

// ---------------------------------------------------------------------------
// 3. normalizeText
// ---------------------------------------------------------------------------

test('normalizeText：非字符串一律当空串', () => {
  assert.deepEqual(normalizeText(null), { text: '', truncated: false, chars: 0 })
  assert.deepEqual(normalizeText(undefined), { text: '', truncated: false, chars: 0 })
  assert.deepEqual(normalizeText(42), { text: '', truncated: false, chars: 0 })
  assert.deepEqual(normalizeText({}), { text: '', truncated: false, chars: 0 })
})

test('normalizeText：行结尾统一为 \\n', () => {
  assert.equal(normalizeText('a\r\nb\rc\nd').text, 'a\nb\nc\nd')
  assert.equal(normalizeText('\r\n').text, '')
})

test('normalizeText：3 个以上换行压成 2 个；首尾换行去掉', () => {
  assert.equal(normalizeText('a\n\n\n\n\nb').text, 'a\n\nb')
  assert.equal(normalizeText('\n\n\na\n\n').text, 'a')
  assert.equal(normalizeText('a\n\nb').text, 'a\n\nb')
})

test('normalizeText：逐行折叠水平空白并去掉行尾空白', () => {
  assert.equal(normalizeText('a   \nb\t \nc').text, 'a\nb\nc')
  assert.equal(normalizeText('  a    b  ').text, 'a b')
  assert.equal(normalizeText('a\t\t\tb').text, 'a b')
})

test('normalizeText：抹掉零宽字符与 C0 控制字符', () => {
  assert.equal(normalizeText('a\u200Bb\u200Cc\u200Dd\uFEFFe\u2060f').text, 'abcdef')
  assert.equal(normalizeText('a\u0000b\u0001c\u007Fd').text, 'abcd')
  // 制表符必须**作为水平空白存活**，而不是被当控制字符删掉：
  // 删掉会得到 'ab'，折叠会得到 'a b'。这里要的是后者。
  assert.equal(normalizeText('a\tb').text, 'a b')
})

test('normalizeText：解码实体，但只在文本仍含 `&` 时解码', () => {
  assert.equal(normalizeText('a &amp; b').text, 'a & b')
  assert.equal(normalizeText('&lt;p&gt;').text, '<p>')
  assert.equal(normalizeText('x &notanentity; y').text, 'x &notanentity; y')
  // 已解码文本（不含 `&`）原样通过
  assert.equal(normalizeText('a & b').text, 'a & b')
  // 单趟语义在 normalizeText 里同样成立
  assert.equal(normalizeText('&amp;lt;').text, '&lt;')
})

test('normalizeText：idempotence —— 归一两次等于归一一次', () => {
  const samples = [
    '  Hello   WORLD \n\n\n 第二行\t \r\n\r\n',
    '<p>a &amp; b</p>',
    'a\u200B b\r\n\r\n\r\n c ',
    '',
    '\n\n\n',
  ]
  for (const sample of samples) {
    const once = normalizeText(sample).text
    const twice = normalizeText(once).text
    assert.equal(twice, once, `非幂等输入：${JSON.stringify(sample)}`)
  }
})

test('normalizeText：超长输入在 MAX_NORMALIZED_TEXT_CHARS 处截断并置 truncated', () => {
  const original = 'a'.repeat(MAX_NORMALIZED_TEXT_CHARS + 50000)
  const result = normalizeText(original)
  assert.equal(result.truncated, true)
  assert.equal(result.chars, MAX_NORMALIZED_TEXT_CHARS)
  assert.equal(result.text.length, MAX_NORMALIZED_TEXT_CHARS)
  assert.equal(result.text, 'a'.repeat(MAX_NORMALIZED_TEXT_CHARS))
})

test('normalizeText：恰好等于上限时不算截断', () => {
  const exact = 'a'.repeat(MAX_NORMALIZED_TEXT_CHARS)
  const result = normalizeText(exact)
  assert.equal(result.truncated, false)
  assert.equal(result.chars, MAX_NORMALIZED_TEXT_CHARS)
  assert.equal(result.text, exact)
})

test('normalizeText：截断不劈开代理对', () => {
  // 全是代理对（每个 2 个 UTF-16 码元）：切点必然落在某一对中间。
  const emoji = '\u{1F600}'.repeat(MAX_NORMALIZED_TEXT_CHARS)
  const result = normalizeText(emoji)
  assert.equal(result.truncated, true)
  assert.ok(result.chars <= MAX_NORMALIZED_TEXT_CHARS)

  const lastCode = result.text.charCodeAt(result.text.length - 1)
  const isLoneHigh = lastCode >= 0xD800 && lastCode <= 0xDBFF
  assert.equal(isLoneHigh, false, '输出末尾不能是孤立的高位代理')

  // 一个完整的代理对都没有被破坏：重新解码后长度等于码元数
  assert.equal([...result.text].length, result.text.length / 2)
})

test('normalizeText：30 万字符不挂死且结果确定', () => {
  const big = 'a'.repeat(300000)
  const startedAt = Date.now()
  const first = normalizeText(big)
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 5000, `30 万字符耗时过长：${elapsed}ms`)
  assert.equal(first.chars, MAX_NORMALIZED_TEXT_CHARS)
  assert.equal(first.truncated, true)
  // 同一输入必须得到逐字节相同的结果
  assert.equal(normalizeText(big).text, first.text)
})

test('normalizeText：相同输入总是字节级一致（含奇怪字符）', () => {
  const sample = 'a\u00A0b\u200Bc &amp; d\r\n\r\n\r\n\u7528\u6237'
  assert.equal(normalizeText(sample).text, normalizeText(sample).text)
})

// ---------------------------------------------------------------------------
// 4. canonicalize
// ---------------------------------------------------------------------------

test('canonicalize：折叠空白 + ASCII 折叠大小写', () => {
  assert.equal(canonicalize('  Hello   WORLD \n'), 'hello world')
  // 只折叠水平空白；换行是结构信息，保留（3+ 换行压成 2）
  assert.equal(canonicalize('A\tB'), 'a b')
  assert.equal(canonicalize('A\n\n\n\nC'), 'a\n\nc')
  assert.equal(canonicalize(''), '')
  assert.equal(canonicalize(null), '')
  assert.equal(canonicalize(123), '')
})

test('canonicalize：ASCII 折叠，不用 toLowerCase', () => {
  // 土耳其语无点 I / 有点 i：locale 相关实现会给出不同的结果，
  // 这里必须保持码点级别的确定性。
  assert.equal(canonicalize('I'), 'i')
  assert.equal(canonicalize('\u0130'), '\u0130')
  assert.equal(canonicalize('\u0131'), '\u0131')
  assert.equal(canonicalize('ABCXYZ'), 'abcxyz')
  // 非 ASCII 字母不折叠
  assert.equal(canonicalize('ÄÖÜ'), 'ÄÖÜ')
  assert.equal(canonicalize('中文ABC'), '中文abc')
})

test('canonicalize：与手写期望一致，且幂等', () => {
  // 注意不能拿 `.replace(/\s+/g, ' ')` 当参照——那会把换行也吞掉，
  // 而 canonicalize 只折叠水平空白。
  assert.equal(canonicalize('Mixed CASE 123\n\n\n\n第二行'), 'mixed case 123\n\n第二行')
  // 行首与行尾空白都去掉，与 normalizeText 的语义**必须**一致：
  // 指纹用的规范形式若和展示用的规范形式对空白处理不同，"内容没变但指纹变了"
  // 就会按 HTML 缩进随机出现——那正是缩进最容易引起的一种假变化。
  assert.equal(canonicalize('  A   B \n C '), 'a b\nc')
  const sample = 'Mixed CASE 123\n\n\n\n第二行'
  assert.equal(canonicalize(canonicalize(sample)), canonicalize(sample))
})

// ---------------------------------------------------------------------------
// 5. normalizeUrl
// ---------------------------------------------------------------------------

test('normalizeUrl：主机名小写、默认端口丢弃、非默认端口保留', () => {
  assert.equal(normalizeUrl('HTTPS://Example.COM/Path/'), 'https://example.com/Path')
  assert.equal(normalizeUrl('https://example.com:443/a'), 'https://example.com/a')
  assert.equal(normalizeUrl('http://example.com:80/a'), 'http://example.com/a')
  assert.equal(normalizeUrl('http://example.com:8080/a/'), 'http://example.com:8080/a')
  assert.equal(normalizeUrl('https://EXAMPLE.com:8443/A/b/'), 'https://example.com:8443/A/b')
})

test('normalizeUrl：fragment 整段丢弃', () => {
  assert.equal(normalizeUrl('https://example.com/a#frag'), 'https://example.com/a')
  assert.equal(normalizeUrl('https://example.com/a?q=1#frag'), 'https://example.com/a?q=1')
  assert.equal(normalizeUrl('https://example.com/a#'), 'https://example.com/a')
})

test('normalizeUrl：剔除跟踪参数（名称大小写不敏感）', () => {
  assert.equal(
    normalizeUrl('https://example.com/a?utm_source=x&utm_medium=y&ref=z&source=s'),
    'https://example.com/a',
  )
  assert.equal(normalizeUrl('https://example.com/a?UTM_Source=x&q=1'), 'https://example.com/a?q=1')
  assert.equal(
    normalizeUrl('https://example.com/a?gclid=1&fbclid=2&msclkid=3&mc_cid=4&mc_eid=5'),
    'https://example.com/a',
  )
  assert.equal(
    normalizeUrl('https://example.com/a?spm=1&yclid=2&igshid=3&utm_id=4&utm_term=5&utm_content=6'),
    'https://example.com/a',
  )
  // 前缀相似但不相等的参数必须保留（精确匹配，不做前缀匹配）
  assert.equal(normalizeUrl('https://example.com/a?reftype=1&sources=2'), 'https://example.com/a?reftype=1&sources=2')
})

test('normalizeUrl：剩余参数按 key 再按 value 排序', () => {
  assert.equal(normalizeUrl('https://example.com/a?b=2&a=1'), 'https://example.com/a?a=1&b=2')
  assert.equal(normalizeUrl('https://example.com/a?b=1&b=2&a=9'), 'https://example.com/a?a=9&b=1&b=2')
  assert.equal(normalizeUrl('https://example.com/a?q=1&spm=xx&gclid=g'), 'https://example.com/a?q=1')
})

test('normalizeUrl：路径末尾单个 `/` 去掉，根路径 `/` 保留', () => {
  assert.equal(normalizeUrl('https://example.com/'), 'https://example.com/')
  assert.equal(normalizeUrl('https://example.com'), 'https://example.com/')
  assert.equal(normalizeUrl('https://example.com/a/'), 'https://example.com/a')
  assert.equal(normalizeUrl('https://example.com/a/b/'), 'https://example.com/a/b')
  // 重复斜杠折叠
  assert.equal(normalizeUrl('https://example.com/a//b///c'), 'https://example.com/a/b/c')
  // 空 query 不输出 `?`
  assert.equal(normalizeUrl('https://example.com/a?'), 'https://example.com/a')
})

test('normalizeUrl：内嵌凭据、非 http(s)、相对路径、非法输入 → null', () => {
  assert.equal(normalizeUrl('https://user:pass@example.com/a'), null)
  assert.equal(normalizeUrl('https://user@example.com/a'), null)
  assert.equal(normalizeUrl('ftp://example.com/a'), null)
  assert.equal(normalizeUrl('/relative/path'), null)
  assert.equal(normalizeUrl('relative/path'), null)
  assert.equal(normalizeUrl('javascript:alert(1)'), null)
  assert.equal(normalizeUrl('not a url'), null)
  assert.equal(normalizeUrl(''), null)
  assert.equal(normalizeUrl('   '), null)
  assert.equal(normalizeUrl(null), null)
  assert.equal(normalizeUrl(undefined), null)
  assert.equal(normalizeUrl(42), null)
  assert.equal(normalizeUrl('//example.com/a'), null)
})

test('normalizeUrl：idempotence —— 归一两次等于归一一次', () => {
  const samples = [
    'HTTPS://Example.COM:8443/A/b/?utm_source=x&b=2&a=1#frag',
    'http://example.com:8080/a/',
    'https://example.com/',
    'https://example.com/a?b=2&a=1&utm_source=x',
    'https://example.com/a?UTM_Source=x&q=1&ref=z',
    'https://example.com/a?q=%20&r=1',
    'https://example.com/a?x=a%2Fb',
  ]
  for (const sample of samples) {
    const once = normalizeUrl(sample)
    assert.ok(once !== null, `样本应当可归一：${sample}`)
    assert.equal(normalizeUrl(once), once, `非幂等样本：${sample}`)
  }
})

// ---------------------------------------------------------------------------
// 6. htmlStructureFingerprint
// ---------------------------------------------------------------------------

test('htmlStructureFingerprint：结构相同、文案不同 → 指纹相同', () => {
  const a = '<html><body><div id="main"><p>正文 A</p><p>正文 B</p></div></body></html>'
  const b = '<html><body><div id="main"><p>完全不同的文字 111</p><p>又一段 222</p></div></body></html>'
  assert.equal(htmlStructureFingerprint(a), htmlStructureFingerprint(b))
  assert.equal(htmlStructureFingerprint(a), 'html|body|div|#main|p|/p|p|/p|/div|/body|/html')
})

test('htmlStructureFingerprint：多一层 wrapper → 指纹不同', () => {
  const a = '<html><body><div id="main"><p>x</p><p>y</p></div></body></html>'
  const nested = '<html><body><div id="main"><div><p>x</p><p>y</p></div></div></body></html>'
  assert.notEqual(htmlStructureFingerprint(a), htmlStructureFingerprint(nested))
})

test('htmlStructureFingerprint：id/class 参与指纹，文本内容不参与', () => {
  const withClass = '<div id="main"><p class="lead">x</p></div>'
  const withoutClass = '<div id="main"><p>y</p></div>'
  assert.notEqual(htmlStructureFingerprint(withClass), htmlStructureFingerprint(withoutClass))
  assert.equal(
    htmlStructureFingerprint(withClass),
    'div|#main|p|.lead|/p|/div',
  )
  // 同一 class 列表、不同文案 → 相同
  assert.equal(
    htmlStructureFingerprint('<p class="a b">一</p>'),
    htmlStructureFingerprint('<p class="a b">二</p>'),
  )
})

test('htmlStructureFingerprint：忽略 script/style/注释内容', () => {
  const a = '<div><script>var x = 1</script><p>a</p></div>'
  const b = '<div><script>var y = 2; 完全不同的脚本</script><p>b</p></div>'
  assert.equal(htmlStructureFingerprint(a), htmlStructureFingerprint(b))

  const c = '<div><!-- 注释一 --><p>a</p></div>'
  const d = '<div><!-- 注释二 --><p>b</p></div>'
  assert.equal(htmlStructureFingerprint(c), htmlStructureFingerprint(d))
})

test('htmlStructureFingerprint：连续 3 个以上相同 token 压成一个', () => {
  // `<br>` 三次 → token 流 `br|br|br`，压成单个 `br`
  assert.equal(htmlStructureFingerprint('<br><br><br>'), 'br')
  assert.equal(htmlStructureFingerprint('<br><br><br><br><br>'), 'br')
  // 只有 2 个（不足 3）时不压
  assert.equal(htmlStructureFingerprint('<br><br>'), 'br|br')
  assert.equal(htmlStructureFingerprint('<br>'), 'br')
})

test('htmlStructureFingerprint：输出长度不超过 2000 字符', () => {
  const long = '<div class="x">' + '<p>t</p>'.repeat(2000) + '</div>'
  const fingerprint = htmlStructureFingerprint(long)
  assert.ok(fingerprint.length <= 2000, `指纹过长：${fingerprint.length}`)
  assert.equal(fingerprint.length, 2000)

  // 正常页面远小于上限
  const normal = '<html><body><div id="a"><p>x</p></div></body></html>'
  assert.ok(htmlStructureFingerprint(normal).length < 2000)
})

test('htmlStructureFingerprint：确定性 + 空输入', () => {
  const doc = '<DIV ID="Main"><SPAN Class="Lead More">x</SPAN></DIV>'
  assert.equal(htmlStructureFingerprint(doc), htmlStructureFingerprint(doc))
  // 标签名大小写不敏感（统一小写）
  assert.equal(htmlStructureFingerprint(doc), 'div|#Main|span|.Lead|.More|/span|/div')
  assert.equal(htmlStructureFingerprint(''), '')
  assert.equal(htmlStructureFingerprint(null), '')
  assert.equal(htmlStructureFingerprint(undefined), '')
  assert.equal(htmlStructureFingerprint(123), '')
})
