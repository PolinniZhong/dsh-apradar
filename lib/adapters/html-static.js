/**
 * 静态 HTML 更新页适配器（P0-18，**排在 P0 最后**，属于「有条件支持」）。
 *
 * 为什么把它排最后、并且允许它失败：任意 HTML 页面没有契约。我们只认三种
 * 足够常见、且不依赖站点定制的结构：
 *   1. `<article>` 块；
 *   2. 含链接的 `<li>` 列表（至少 3 条）；
 *   3. 连续的小标题（`<h2>` / `<h3>`）加正文（至少 2 条）。
 * 三者都不命中时抛 `ADAPTER_STRUCTURE_UNSUPPORTED`，**明确拒绝**把这个来源
 * 标记为可用 —— 宁可让用户看到「本版本不支持」，也不要给出一个时好时坏的抓取器。
 *
 * 另外记录一个**结构指纹**：页面骨架变了（比如换了主题），下一次抓取就能发现
 * 「结构变了」而不是制造一堆假的「新增内容」。
 *
 * @module dsh-apradar/src/host/adapters/html-static
 */

import { stripHtmlToText, htmlStructureFingerprint } from '../parse/html-text.js'
import { normalizeUrl } from '../normalize.js'
import { hashId } from '../fingerprint.js'
import { assertFetchableUrl } from '../fetch/url.js'
import { defineAdapter, SourceConfigError, StructureUnsupportedError, asText, asConfigObject,
  assertBodyNotTruncated,
} from './types.js'

/** 单条记录标题长度上限。 */
const MAX_TITLE_CHARS = 300

/** 一条候选至少要有这么多字符的正文，否则视为导航项而不是更新条目。 */
const MIN_ITEM_TEXT_CHARS = 20

/** `<article>` 结构至少要找出这么多条，才认为这个页面是「更新列表」。 */
const MIN_ARTICLE_ITEMS = 1

/** 列表 / 小标题结构要求的最少条数 —— 太少的「列表」多半是导航。 */
const MIN_LIST_ITEMS = 3
const MIN_HEADING_ITEMS = 2

/**
 * 在 HTML 里按标签名找出全部块的**内部** HTML。
 *
 * 手写扫描而不是正则：正则在嵌套与畸形输入上要么漏要么灾难性回溯，
 * 而这里处理的正是不可信的外部内容。
 *
 * @param {string} html 原始 HTML
 * @param {string} tag 标签名（小写，不含尖括号）
 * @param {number} [max] 最多收集多少个，避免在超长页面上做无谓工作
 * @returns {string[]} 每个块的内部 HTML
 */
export function findBlocks(html, tag, max = 200) {
  const blocks = []
  const source = String(html ?? '')
  const lower = source.toLowerCase()
  const open = `<${tag}`
  const close = `</${tag}>`
  let cursor = 0

  while (blocks.length < max) {
    const start = lower.indexOf(open, cursor)
    if (start === -1) break
    const afterName = lower.charAt(start + open.length)
    // 必须是真正的标签边界，避免把 `<articlemeta>` 当成 `<article>`。
    if (afterName && !/[\s/>]/.test(afterName)) {
      cursor = start + open.length
      continue
    }
    const tagEnd = source.indexOf('>', start)
    if (tagEnd === -1) break
    if (source.charAt(tagEnd - 1) === '/') {
      // 自闭合：内容为空
      blocks.push('')
      cursor = tagEnd + 1
      continue
    }

    // 深度计数，正确处理嵌套的同名标签。
    let depth = 1
    let scan = tagEnd + 1
    let bodyEnd = -1
    for (;;) {
      const nextOpen = lower.indexOf(open, scan)
      const nextClose = lower.indexOf(close, scan)
      if (nextClose === -1) break
      if (nextOpen !== -1 && nextOpen < nextClose) {
        const boundary = lower.charAt(nextOpen + open.length)
        if (!boundary || /[\s/>]/.test(boundary)) {
          depth += 1
          scan = nextOpen + open.length
          continue
        }
      }
      depth -= 1
      if (depth === 0) {
        bodyEnd = nextClose
        break
      }
      scan = nextClose + close.length
    }
    if (bodyEnd === -1) break
    blocks.push(source.slice(tagEnd + 1, bodyEnd))
    cursor = bodyEnd + close.length
  }

  return blocks
}

/**
 * 从一段标签文本里取属性值。
 * @param {string} tagText 形如 `<a href="x">` 或 `<h2>` 的片段
 * @param {string} name 属性名（小写）
 * @returns {string} 属性值；不存在时为空串
 */
export function extractAttr(tagText, name) {
  const text = String(tagText ?? '')
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i')
  const match = pattern.exec(text)
  if (!match) return ''
  return match[2] ?? match[3] ?? match[4] ?? ''
}

/**
 * 取一段块的开头标签文本（用于读属性）。
 * @param {string} block 块的**外部** HTML
 * @returns {string}
 */
function openingTagOf(block) {
  const end = String(block ?? '').indexOf('>')
  return end === -1 ? '' : String(block).slice(0, end + 1)
}

/**
 * 用标题 + 正文哈希兜底生成条目 id。
 * @param {string} title 标题
 * @param {string} text 正文
 * @returns {string}
 */
function fallbackItemId(title, text) {
  return hashId('item', `${title}\n${text}`)
}

/**
 * 把「标题 + 正文」装成一个标准条目。
 * @param {{title: string, text: string, href?: string, publishedAt?: number|null}} input 原始字段
 * @returns {object|null} 文本太短时返回 null
 */
function buildItem({ title, text, href, publishedAt }) {
  const cleanTitle = stripHtmlToText(title).trim().slice(0, MAX_TITLE_CHARS)
  const cleanText = stripHtmlToText(text).trim()
  if (cleanText.length < MIN_ITEM_TEXT_CHARS && cleanTitle.length < 8) return null
  const url = href ? normalizeUrl(href) : null
  return {
    itemId: url || fallbackItemId(cleanTitle, cleanText),
    title: cleanTitle,
    publishedAt: typeof publishedAt === 'number' ? publishedAt : null,
    text: cleanText || cleanTitle,
    url,
  }
}

export const htmlStaticAdapter = defineAdapter({
  type: 'html_static',
  label: '静态网页 / 更新日志',
  summary: '不含订阅源的静态更新页。只在页面结构属于受支持的少数几种时才可用。',
  testable: true,
  fields: [
    {
      key: 'pageUrl',
      label: '页面地址',
      kind: 'url',
      required: true,
      placeholder: 'https://example.com/changelog',
      hint: '必须是公开、无需登录、服务端渲染的页面。动态渲染与反爬页面不支持。',
    },
  ],

  /**
   * @param {unknown} input 用户输入
   * @returns {{pageUrl: string}} 归一后的配置
   */
  normalizeConfig(input) {
    const config = asConfigObject(input)
    const raw = asText(config.pageUrl)
    if (!raw) throw new SourceConfigError('请填写页面地址')
    try {
      return { pageUrl: assertFetchableUrl(raw) }
    } catch (err) {
      throw new SourceConfigError(err?.message ?? '页面地址不合法')
    }
  },

  /**
   * @param {object} source 来源记录
   * @param {{pageUrl: string}} config 归一配置
   * @returns {{url: string, acceptHint: string}}
   */
  buildRequest(source, config) {
    return { url: config.pageUrl, acceptHint: 'text/html' }
  },

  /**
   * @param {object} result 抓取结果
   * @param {{pageUrl: string}} config 归一配置
   * @returns {{title: string, items: object[]}}
   */
  parse(result, config) {
    // 截断的 HTML 会让下半页的条目凭空"消失"，差异比较就会报出一堆假的"已删除"。
    // 这种情况必须直接失败，而不是给出一个残缺的条目表。
    assertBodyNotTruncated(result, '这个页面太大，请改用站点提供的分页或列表页')
    const html = typeof result?.content === 'string' ? result.content : ''
    if (!html.trim()) throw new StructureUnsupportedError('页面内容为空，无法判断结构')

    // ① `<article>` 块：最可靠的一种，博客与更新日志常用。
    const articles = findBlocks(html, 'article')
    if (articles.length >= MIN_ARTICLE_ITEMS) {
      const items = []
      for (const block of articles) {
        const outer = `<article>${block}</article>`
        const headingMatch = /<h[1-4][^>]*>([\s\S]*?)<\/h[1-4]>/i.exec(block)
        const anchorMatch = /<a\b[^>]*>/i.exec(block)
        const item = buildItem({
          title: headingMatch ? headingMatch[1] : '',
          text: block,
          href: anchorMatch ? extractAttr(anchorMatch[0], 'href') : '',
        })
        if (item) items.push(item)
      }
      if (items.length) {
        return { title: readPageTitle(html), items }
      }
    }

    // ② 含链接的 `<li>` 列表：changelog 与「更新历史」页的常见形态。
    const listItems = findBlocks(html, 'li')
      .map((block) => {
        const anchorMatch = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(block)
        if (!anchorMatch) return null
        const href = extractAttr(openingTagOf(anchorMatch[0]), 'href')
        if (!href) return null
        return buildItem({ title: anchorMatch[1], text: block, href })
      })
      .filter(Boolean)
    if (listItems.length >= MIN_LIST_ITEMS) {
      return { title: readPageTitle(html), items: listItems.slice(0, 200) }
    }

    // ③ 连续小标题 + 正文：公告页的常见形态。
    const headings = findBlocks(html, 'h2').concat(findBlocks(html, 'h3'))
    const headingItems = []
    for (const heading of headings) {
      const title = stripHtmlToText(heading).trim()
      if (!title) continue
      // 取该标题在原文里之后的 400 字符作为「正文」的近似。
      const index = html.indexOf(heading)
      const tail = index === -1 ? '' : html.slice(index + heading.length, index + heading.length + 400)
      const item = buildItem({ title, text: tail })
      if (item) headingItems.push(item)
    }
    if (headingItems.length >= MIN_HEADING_ITEMS) {
      return { title: readPageTitle(html), items: headingItems.slice(0, 200) }
    }

    throw new StructureUnsupportedError(
      '页面结构不属于受支持的几种形态（article 块 / 含链接的列表 / 连续小标题）',
    )
  },

  /**
   * 结构指纹：用于区分「页面骨架变了」与「内容真的更新了」。
   * @param {object} result 抓取结果
   * @returns {string|null}
   */
  structureFingerprint(result) {
    const html = typeof result?.content === 'string' ? result.content : ''
    return html ? htmlStructureFingerprint(html) : null
  },
})

/**
 * 读 `<title>` 作为来源标题。
 * @param {string} html 原始 HTML
 * @returns {string}
 */
function readPageTitle(html) {
  const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(String(html ?? ''))
  return match ? stripHtmlToText(match[1]).trim().slice(0, MAX_TITLE_CHARS) : ''
}
