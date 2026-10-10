// P1-05 机会池 Markdown 导出：分区、链接安全、Markdown 注入、只读。
//
// 时间戳一律用 `new Date(局部年月日...)` 构造，这样 `formatTime` 在任何时区下都
// 得到同一个字符串，快照式比对才是稳定的。
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  exportFilename,
  formatTime,
  inline,
  quoted,
  renderOpportunitiesMarkdown,
  safeUrl,
  timeZoneLabel,
} from '../src/host/export.js'

/** 构造一个固定时刻：本地时间 2026-10-09 23:40。 */
const AT = () => new Date(2026, 9, 9, 23, 40, 0)

const SOURCE = {
  id: 'src_1',
  name: 'The Verge',
  type: 'rss_atom',
  canonicalUrl: 'https://www.theverge.com/rss/index.xml',
}

const SNAPSHOT = {
  id: 'src_1_mv1',
  fetchedAt: new Date(2026, 9, 9, 23, 10, 0).getTime(),
  url: 'https://www.theverge.com/rss/index.xml',
  itemCount: 10,
  baseline: false,
}

const CHANGE = {
  id: 'chg_1',
  sourceId: 'src_1',
  snapshotId: 'src_1_mv1',
  title: 'Meta is banning TikTok ads across its platforms',
  kind: 'added',
  diffSummary: '新增：Meta is banning TikTok ads across its platforms',
  excerpt: '元数据行\n\n真正的正文从这里开始。',
  itemUrl: 'https://www.theverge.com/tech/1008658/meta-tiktok-bytedance-ads-ban',
  discoveredAt: new Date(2026, 9, 9, 23, 10, 0).getTime(),
  truncated: false,
}

/** 渲染一条机会，输入可逐字段覆盖。 */
function render({ opportunity = {}, changes = [CHANGE], sources = [SOURCE], snapshots = [SNAPSHOT] } = {}) {
  return renderOpportunitiesMarkdown({
    opportunities: [
      {
        id: 'opp_1',
        title: '平台级封禁动作 → 投放前的素材合规预检',
        status: 'to_research',
        createdAt: new Date(2026, 9, 9, 23, 20, 0).getTime(),
        updatedAt: new Date(2026, 9, 9, 23, 22, 0).getTime(),
        changeId: 'chg_1',
        ...opportunity,
      },
    ],
    changes,
    sources,
    snapshots,
    now: AT(),
  })
}

test('导出：事实与推测分成两个区，且事实在前、推测在后', () => {
  const { markdown } = render({
    opportunity: {
      projectRef: 'https://github.com/me/my-project',
      judgment: '大厂开始拿广告位做平台级动作，可能影响投放类工具的机会。',
      questions: ['封禁标准是否公开？', '是否只针对 TikTok？'],
      nextAction: '找 3 个投放团队问一遍。',
    },
  })

  const factAt = markdown.indexOf('### 事实（来自插件抓取并落盘的记录）')
  const guessAt = markdown.indexOf('### 推测与判断（使用者自己写的，未经插件核实）')
  assert.ok(factAt > 0, '缺少事实区')
  assert.ok(guessAt > factAt, '推测区必须在事实区之后')

  // 事实只来自记录：条目链接、来源、快照、原文摘录。
  assert.match(markdown, /条目链接.*<https:\/\/www\.theverge\.com\/tech\/1008658\/meta-tiktok-bytedance-ads-ban>/)
  assert.match(markdown, /- 名称：The Verge/)
  assert.match(markdown, /- 解析器：`rss_atom`/)
  assert.match(markdown, /- 来源地址：<https:\/\/www\.theverge\.com\/rss\/index\.xml>/)
  assert.match(markdown, /- 快照 id：`src_1_mv1`/)
  assert.match(markdown, /- 抓取时间：2026-10-09 23:10/)
  assert.match(markdown, /- 关联项目：<https:\/\/github\.com\/me\/my-project>/)
  assert.match(markdown, /> 真正的正文从这里开始。/)

  // 用户的判断必须落在推测区里，而不是事实区。
  const factSection = markdown.slice(factAt, guessAt)
  assert.ok(!factSection.includes('大厂开始拿广告位'), '用户的判断混进了事实区')
  const guessSection = markdown.slice(guessAt)
  assert.match(guessSection, /大厂开始拿广告位/)
  assert.match(guessSection, /封禁标准是否公开？/)
  assert.match(guessSection, /- 下一步：找 3 个投放团队问一遍。/)
})

test('导出：没有关联抓取记录时明说，而不是留一个空的事实区', () => {
  const { markdown } = render({ opportunity: { changeId: undefined, judgment: '我自己想到的。' } })
  assert.match(markdown, /没有关联任何一次抓取记录/)
  assert.match(markdown, /全部出自使用者本人/)
  // 不能出现空标题下的空白，也不能把用户的判断当成事实。
  const factAt = markdown.indexOf('### 事实')
  const guessAt = markdown.indexOf('### 推测与判断')
  assert.ok(!markdown.slice(factAt, guessAt).includes('我自己想到的。'))
})

test('导出：还没写判断时说"还没有写"，不伪造内容', () => {
  const { markdown } = render()
  assert.match(markdown, /（还没有写。这条机会目前只有上面的事实部分。）/)
})

test('导出：抓取被截断时必须警示，不能让读者以为条目被删了', () => {
  const { markdown } = render({ changes: [{ ...CHANGE, truncated: true }] })
  assert.match(markdown, /本次抓取的响应被截断/)
  assert.match(markdown, /不能据此断言条目被删除/)
})

test('导出：非 http(s) 链接绝不进导出文件', () => {
  const { markdown } = render({
    opportunity: { projectRef: 'javascript:alert(1)' },
    changes: [{ ...CHANGE, itemUrl: 'javascript:alert(2)' }],
    sources: [{ ...SOURCE, canonicalUrl: 'data:text/html,<script>' }],
  })
  assert.ok(!markdown.includes('javascript:'), 'javascript: 链接出现在导出文件里')
  assert.ok(!markdown.includes('data:text/html'), 'data: 链接出现在导出文件里')
  // 不是"记得别那么写"，而是让它**不可能是一个合法 URI**：半角冒号被换成全角。
  assert.match(markdown, /关联项目：javascript：alert\(1\)（记了一条但不是网址，按原文照录，未做成链接）/)
  assert.ok(!/\]\(javascript/.test(markdown), '出现了 javascript: 链接目标')
})

test('导出：标题里的换行与 Markdown 标记不能越狱成新的块结构', () => {
  const { markdown } = render({
    opportunity: { title: '正常标题\n# 我是新标题\n- 我是列表项', judgment: '判断\n\n> 我是引用' },
  })
  const headings = markdown.split('\n').filter((line) => line.startsWith('## '))
  // 只有机会自己的那一个 `## 1.` 标题；注入的 `# 我是新标题` 被压成了同一行。
  assert.equal(headings.length, 1, `多出了标题行：${JSON.stringify(headings)}`)
  assert.match(headings[0], /正常标题 # 我是新标题 - 我是列表项/)
  // 行首的 `>` 注入同样被压平，不会伪造出一段引用。
  assert.ok(!markdown.includes('\n> 我是引用'))
})

test('导出：抓回来的内容不能伪造链接（摘录按不可信处理）', () => {
  const { markdown } = render({
    changes: [
      {
        ...CHANGE,
        excerpt: '看这个 [点我领奖](javascript:alert(1)) 还有 <javascript:alert(2)> 和 `反引号`',
      },
    ],
    opportunity: { judgment: '他写的 [这个](javascript:alert(3)) 也不能变成链接' },
  })

  // 链接目标与自动链接都不允许存活。
  assert.ok(!markdown.includes('](javascript:'), '摘录里的 javascript: 链接目标存活了')
  assert.ok(!markdown.includes('<javascript:'), '摘录里的自动链接存活了')
  // 方括号与尖括号被转义：Markdown 解析器不会把它读成链接或 HTML。
  // `String.raw` 里写的正是文件里真实存在的两个字符：反斜杠 + 方括号。
  assert.ok(
    markdown.includes(String.raw`\[点我领奖\](javascript：alert(1))`),
    `方括号没有被转义：${markdown.split('\n').filter((line) => line.includes('点我'))[0]}`,
  )
  assert.ok(markdown.includes(String.raw`\<javascript：alert(2)\>`), '尖括号没有被转义')
  // 反引号被转义，不会打开一个吃掉后续内容的代码段。
  assert.ok(!markdown.includes('`反引号`'), '反引号没被转义')
  assert.ok(markdown.includes(String.raw`\`反引号\``), '反引号没有被转义')
})

test('导出：抓回来的内容不能伪造新的块结构', () => {
  const { markdown } = render({
    changes: [{ ...CHANGE, excerpt: '# 假标题\n> 假引用\n- 假列表' }],
  })
  // 全部落在引用块内部，行首是 `> `，不可能是标题或列表。
  const injected = markdown.split('\n').filter((line) => line.includes('假标题') || line.includes('假引用') || line.includes('假列表'))
  assert.ok(injected.length >= 3, '注入的三行没找到')
  for (const line of injected) assert.ok(line.startsWith('> '), `行没被关进引用块：${line}`)
})

test('导出：文件名只用 id，不把标题拼进去', () => {
  const one = exportFilename([{ id: 'opp_abc-123' }], AT())
  assert.equal(one, 'ai-product-radar-opp_abc-123.md')
  const many = exportFilename([{ id: 'a' }, { id: 'b' }], AT())
  assert.equal(many, 'ai-product-radar-opportunities-20261009-2340.md')
})

test('导出：完整输出快照（含页眉、分区、页脚）', () => {
  const { markdown } = render({
    opportunity: {
      projectRef: 'https://github.com/me/my-project',
      judgment: '值得追。',
      questions: ['封禁标准是否公开？'],
      nextAction: '问投放团队。',
    },
  })

  const expected = [
    '# AI 产品雷达 · 产品机会导出',
    '',
    '- 导出时间：2026-10-09 23:40（UTC+08:00）',
    '- 机会数量：1',
    '- 生成方式：DeepSeek Harness「AI 产品雷达」插件，直接从本地存储导出。**没有人也没有模型改写过这里的任何一句话。**',
    '',
    '> 每一条机会都分成两个区：**事实**来自插件真实抓取并落盘的记录（可点开头部的条目链接自己核对），' +
      '**推测与判断**是使用者自己写的。两者不会混在一起 —— 一份分不清"看到的"和"猜的"的笔记，比没有笔记更危险。',
    '',
    '---',
    '',
    '## 1. 平台级封禁动作 → 投放前的素材合规预检',
    '',
    '- 机会 id：`opp_1`',
    '- 状态：待研究',
    '- 创建：2026-10-09 23:20',
    '- 更新：2026-10-09 23:22',
    '- 关联项目：<https://github.com/me/my-project>',
    '',
    '### 事实（来自插件抓取并落盘的记录）',
    '',
    '- **条目链接**：<https://www.theverge.com/tech/1008658/meta-tiktok-bytedance-ads-ban>',
    '- 标题：Meta is banning TikTok ads across its platforms',
    '- 变化类型：新增',
    '- 差异摘要：新增：Meta is banning TikTok ads across its platforms',
    '- 插件发现时间：2026-10-09 23:10',
    '',
    '**来源**',
    '',
    '- 名称：The Verge',
    '- 解析器：`rss_atom`',
    '- 来源地址：<https://www.theverge.com/rss/index.xml>',
    '',
    '**证据快照**',
    '',
    '- 快照 id：`src_1_mv1`',
    '- 抓取时间：2026-10-09 23:10',
    '- 该次抓到的条目数：10',
    '- 实际抓取地址：<https://www.theverge.com/rss/index.xml>（重定向后的最终地址）',
    '',
    '**原文摘录**',
    '',
    '> 元数据行',
    '>',
    '> 真正的正文从这里开始。',
    '',
    '### 推测与判断（使用者自己写的，未经插件核实）',
    '',
    '- 判断：值得追。',
    '- 待验证的问题：',
    '  1. 封禁标准是否公开？',
    '- 下一步：问投放团队。',
    '',
    '---',
    '',
    '本文件由「AI 产品雷达」生成于 2026-10-09 23:40（UTC+08:00）。' +
      '所有链接都是抓取时记录的原样地址，插件没有在导出时重新访问它们 —— 链接是否仍然有效，请自行核对。',
    '',
  ].join('\n')

  // 时区不同会导致页眉/页脚的偏移文字不同；此时只比对去掉时区标签的骨架。
  if (timeZoneLabel(AT()) === 'UTC+08:00') {
    assert.equal(markdown, expected)
  } else {
    assert.equal(markdown.split('\n').filter((line) => !line.includes('UTC')).length, expected.split('\n').filter((line) => !line.includes('UTC')).length)
    assert.match(markdown, /- 导出时间：2026-10-09 23:40（UTC[+-]\d\d:\d\d）/)
  }
})

test('导出：几个小工具函数的边界', () => {
  assert.equal(inline('a\n\nb\t c'), 'a b c')
  assert.equal(inline(null), '')
  assert.equal(inline('x\u0007y'), 'xy')
  assert.equal(inline('  '), '')

  assert.deepEqual(quoted(''), [])
  assert.deepEqual(quoted('一行'), ['> 一行'])
  assert.deepEqual(quoted('上\n\n\n下'), ['> 上', '>', '> 下'])
  assert.deepEqual(quoted('中间有空\n\n\n\n行'), ['> 中间有空', '>', '> 行'])
  assert.equal(quoted(Array.from({ length: 5 }, (_, i) => `第${i}行`).join('\n'), 3).length, 4)
  assert.match(quoted(Array.from({ length: 5 }, (_, i) => `第${i}行`).join('\n'), 3)[3], /还有 2 行/)

  assert.equal(safeUrl('https://a.example/x'), 'https://a.example/x')
  assert.equal(safeUrl('http://a.example'), 'http://a.example')
  assert.equal(safeUrl('javascript:alert(1)'), null)
  assert.equal(safeUrl('ftp://a.example'), null)
  assert.equal(safeUrl('不是网址'), null)
  assert.equal(safeUrl(''), null)
  assert.equal(safeUrl(null), null)

  assert.equal(formatTime(new Date(2026, 0, 2, 3, 4).getTime()), '2026-01-02 03:04')
  assert.equal(formatTime(0), null)
  assert.equal(formatTime(-1), null)
  assert.equal(formatTime('2026-01-02'), null)
  assert.equal(formatTime(Number.NaN), null)
  assert.equal(formatTime(undefined), null)
})

test('导出：机会池为空时也给一份能读的文件，不给出 0 字节', () => {
  const { markdown, count } = renderOpportunitiesMarkdown({
    opportunities: [],
    changes: [],
    sources: [],
    snapshots: [],
    now: AT(),
  })
  assert.equal(count, 0)
  assert.match(markdown, /机会数量：0/)
  assert.match(markdown, /（机会池是空的，没有可导出的内容。）/)
})
