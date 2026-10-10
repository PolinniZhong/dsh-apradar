/**
 * RSS 2.0 / Atom 1.0 适配器。
 *
 * 这是 P0 里**唯一**对任意用户填写地址开放的 Feed 类型（`feedUrl` 由用户提供），
 * 因此它被归为「有条件支持」：我们只承诺解析 RSS 2.0 与 Atom 1.0 的常用子集，
 * 解析不了就报 `ADAPTER_PARSE_FAILED`，绝不返回空结果假装成功。
 *
 * @module dsh-apradar/src/host/adapters/rss-atom
 */

import { parseFeed } from '../parse/xml.js'
import { stripHtmlToText } from '../parse/html-text.js'
import { normalizeUrl } from '../normalize.js'
import { hashId } from '../fingerprint.js'
import { assertFetchableUrl } from '../fetch/url.js'
import {
  defineAdapter,
  SourceConfigError,
  AdapterParseError,
  asText,
  asConfigObject,
  assertBodyNotTruncated,
} from './types.js'

/** 单条记录的标题长度上限，与存储 schema 对齐。 */
const MAX_TITLE_CHARS = 300

/**
 * 把 `parseFeed()` 的结果映射为插件内部的标准条目。
 *
 * 两个要点：
 * 1. `text` 必须**已经剥掉 HTML 标签**（很多 Feed 的 description 内嵌 HTML），
 *    否则指纹会随无关的样式改动而变，产生假的「有变化」。
 * 2. `itemId` 缺失时用「标题 + 正文」的哈希兜底。这不是完美的主键（标题改了
 *    就会被当成新条目），但比用序号稳定得多 —— 序号会随排序变化整体漂移。
 *
 * @param {{ items: object[] }} feed 解析结果
 * @returns {object[]} 标准条目
 */
export function mapFeedItems(feed) {
  const items = Array.isArray(feed?.items) ? feed.items : []
  return items.map((item) => {
    const rawTitle = asText(item?.title).slice(0, MAX_TITLE_CHARS)
    const text = stripHtmlToText(asText(item?.text))
    const rawId = asText(item?.itemId)
    const url = item?.url ? normalizeUrl(item.url) : null
    return {
      itemId: rawId ? rawId.slice(0, 300) : hashId('item', `${rawTitle}\n${text}`),
      title: rawTitle,
      publishedAt: typeof item?.publishedAt === 'number' ? item.publishedAt : null,
      text,
      url,
    }
  })
}

/**
 * 从抓取结果里取出 XML 文本。
 *
 * 宿主的 `classifyContentType()` 把 `application/atom+xml`、`application/rss+xml`、
 * `application/xml`、`text/xml` 都归为 `kind: 'text'`（只有 `text/html` 会是 `html`），
 * 所以这里对两种 kind 都接受 —— 用 kind 做判断反而会误伤。
 *
 * @param {{content?: string, url?: string}} result 抓取结果
 * @returns {string}
 */
export function readXmlBody(result) {
  return typeof result?.content === 'string' ? result.content : ''
}

export const rssAtomAdapter = defineAdapter({
  type: 'rss_atom',
  label: 'RSS / Atom',
  summary: '标准订阅源。只支持 RSS 2.0 与 Atom 1.0 的常用子集。',
  testable: true,
  // `acceptHint` 只是记录我们的期望：宿主的抓取层会自己设置 Accept 头，适配器改不了它。
  fields: [
    {
      key: 'feedUrl',
      label: '订阅地址',
      kind: 'url',
      required: true,
      placeholder: 'https://example.com/feed.xml',
      hint: '必须是可以直接返回 XML 的 http/https 地址。',
    },
  ],

  /**
   * @param {unknown} input 用户输入
   * @returns {{feedUrl: string}} 归一后的配置
   */
  normalizeConfig(input) {
    const config = asConfigObject(input)
    const raw = asText(config.feedUrl)
    if (!raw) throw new SourceConfigError('请填写订阅地址')
    try {
      return { feedUrl: assertFetchableUrl(raw) }
    } catch (err) {
      throw new SourceConfigError(err?.message ?? '订阅地址不合法')
    }
  },

  /**
   * @param {object} source 来源记录
   * @param {{feedUrl: string}} config 归一配置
   * @returns {{url: string, acceptHint: string}}
   */
  buildRequest(source, config) {
    return { url: config.feedUrl, acceptHint: 'application/atom+xml, application/rss+xml, application/xml;q=0.9, text/xml;q=0.8' }
  },

  /**
   * @param {object} result 抓取结果
   * @param {{feedUrl: string}} config 归一配置
   * @returns {{title: string, items: object[]}}
   */
  parse(result, config) {
    // 先判截断，再解析：被截断的 XML 一定会报出**误导性**的结构错误
    // （实测："CDATA 段未闭合" / "标签未闭合：<item>"），见 `assertBodyNotTruncated`。
    assertBodyNotTruncated(result, '这个订阅源太大，请改用站点提供的分页或精简入口')
    const xml = readXmlBody(result)
    if (!xml.trim()) throw new AdapterParseError('响应内容为空，无法解析')
    const parsed = parseFeed(xml)
    if (!parsed.ok) throw new AdapterParseError(parsed.message ?? '无法解析为 RSS 或 Atom')
    return { title: asText(parsed.title).slice(0, MAX_TITLE_CHARS), items: mapFeedItems(parsed) }
  },
})
