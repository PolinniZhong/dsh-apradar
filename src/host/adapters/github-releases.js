/**
 * GitHub Releases 适配器。
 *
 * 这是 P0 里**最受控**的来源类型，也是唯一「用户不填地址」的类型：
 * 用户只提供 `owner` / `repo` 两段标识，请求地址完全由代码拼接。
 *
 * ## 为什么有两个端点
 *
 * 曾经只有 `https://github.com/<owner>/<repo>/releases.atom` 一个端点。实测发现
 * 它在真实网络里并不可靠：本机（2026-10-09）`github.com:443` **连接超时**
 * （`UND_ERR_CONNECT_TIMEOUT`，10s），而 `api.github.com` 正常返回 200。博客、
 * 代理、企业网关会各挡一边，所以两个端点都得留着，而不是赌哪一个总能通。
 *
 * 顺序是**官方 API 优先**：
 *
 *  1. `https://api.github.com/repos/<owner>/<repo>/releases` —— 结构化 JSON，
 *     直接给 `tag_name` / `body` / `prerelease`，不需要从 Atom 的 HTML 里再剥一层；
 *     代价是未认证限流 60 次/小时。
 *  2. `https://github.com/<owner>/<repo>/releases.atom` —— 无配额限制的 Atom 订阅源，
 *     在没有 API 配额或 API 被挡时兜底。
 *
 * 用哪一个是**透明**的：`snapshot.url` 记录的就是实际抓取到的地址，界面上看得到。
 *
 * @module dsh-apradar/src/host/adapters/github-releases
 */

import { parseFeed } from '../parse/xml.js'
import { normalizeUrl } from '../normalize.js'
import { defineAdapter, AdapterParseError, asText, asConfigObject, assertBodyNotTruncated } from './types.js'
import { MAX_TITLE_CHARS, normalizeIdentifier, toEpochMs } from './github-common.js'
import { mapFeedItems, readXmlBody } from './rss-atom.js'

/**
 * 单次请求的发布条数。
 *
 * 定成 10 而不是 API 上限 100，是因为宿主的抓取层把响应体裁剪到
 * `maxBodyChars`（默认 **100000 字符**）。100 条带完整 release notes 的记录
 * 会远超这个数，被截断的 JSON 无法解析 —— 那时报的是"解析失败"，而不是
 * "内容被截断"，排查会绕远路。10 条大约只占十分之一，留足余量。
 *
 * 代价是窗口较浅：仓库连发 10 个版本之后，更早的记录会离开快照，从而被记为
 * 「移除」。这是**真实**的观测变化（我们确实看不到了），不是伪造的。
 */
const RELEASES_PER_PAGE = 10

/**
 * 解析 GitHub Releases API 的 JSON 响应。
 *
 * @param {string} text 响应体
 * @param {{owner: string, repo: string}} config 归一配置
 * @param {boolean} truncated 宿主是否标记了截断
 * @returns {{title: string, items: object[]}}
 */
function parseApiJson(text, config, truncated) {
  if (truncated) {
    // 截断的 JSON 一定解析不了，但要报"截断"而不是"格式错误"。
    throw new AdapterParseError('响应被宿主截断，JSON 不完整；请调小单页条数（见适配器注释里的原因）')
  }
  let data
  try {
    data = JSON.parse(text)
  } catch (error) {
    throw new AdapterParseError('返回的内容不是合法 JSON', { reason: String(error?.message ?? error) })
  }
  if (!Array.isArray(data)) {
    // 对象形状 = 错误响应（比如限流或 404 的 `{message: ...}`）。
    const message = typeof data?.message === 'string' ? data.message : ''
    throw new AdapterParseError(message ? `GitHub 返回了错误：${message}` : '返回的内容不是发布列表')
  }

  const items = data
    .filter((release) => release && typeof release === 'object')
    // 草稿不是公开信息，抓进来只会制造"我们看到了别人看不到的东西"的错觉。
    .filter((release) => release.draft !== true)
    .map((release) => {
      const tag = asText(release.tag_name)
      const name = asText(release.name)
      const title = (name || tag || '').slice(0, MAX_TITLE_CHARS)
      /** `id` 是仓库内稳定的数字主键；没有它才退回 tag。 */
      const rawId = release.id !== undefined && release.id !== null ? String(release.id) : tag
      return {
        itemId: rawId ? rawId.slice(0, 300) : '',
        title: title || `${config.owner}/${config.repo} 的发布`,
        publishedAt: toEpochMs(release.published_at) ?? toEpochMs(release.created_at),
        /** release notes 是 Markdown；这里保留原文，规范化交给 `normalizeText`。 */
        text: typeof release.body === 'string' ? release.body : '',
        url: release.html_url ? normalizeUrl(release.html_url) : null,
      }
    })
    // `itemId` 为空的条目无法稳定去重，宁可丢掉也不要用会漂移的主键。
    .filter((item) => item.itemId !== '')

  return {
    title: `${config.owner}/${config.repo} Releases`,
    items,
  }
}

export const githubReleasesAdapter = defineAdapter({
  type: 'github_releases',
  label: 'GitHub Releases',
  summary: '公开仓库的 Releases。只需填 owner 与 repo，地址由插件拼接。',
  testable: true,
  /** 地址由代码拼接，不是用户填的自由地址（见 `index.js` 里 `conditional` 的判据）。 */
  addressIsGenerated: true,
  fields: [
    { key: 'owner', label: 'owner', kind: 'text', required: true, placeholder: 'deepseek-ai', hint: '组织或用户名。' },
    { key: 'repo', label: 'repo', kind: 'text', required: true, placeholder: 'deepseek-harness', hint: '仓库名。' },
  ],

  /**
   * @param {unknown} input 用户输入
   * @returns {{owner: string, repo: string}} 归一后的配置
   */
  normalizeConfig(input) {
    const config = asConfigObject(input)
    return {
      owner: normalizeIdentifier(config.owner, 'owner'),
      repo: normalizeIdentifier(config.repo, 'repo'),
    }
  },

  /**
   * 用户没起名时的默认名字。见 `service.js` 的 `defaultNameFor`。
   * @param {{owner: string, repo: string}} config 归一配置
   * @returns {string}
   */
  defaultName(config) {
    return `${config.owner}/${config.repo}`
  },

  /**
   * 候选端点，**按优先级排列**。服务层会依次尝试，第一个成功就用它。
   *
   * @param {object} _source 来源记录
   * @param {{owner: string, repo: string}} config 归一配置
   * @returns {{url: string, acceptHint: string}[]}
   */
  buildRequests(_source, config) {
    return [
      {
        url: `https://api.github.com/repos/${config.owner}/${config.repo}/releases?per_page=${RELEASES_PER_PAGE}`,
        acceptHint: 'application/vnd.github+json',
      },
      {
        url: `https://github.com/${config.owner}/${config.repo}/releases.atom`,
        acceptHint: 'application/atom+xml',
      },
    ]
  },

  /**
   * 兼容单端点调用方的入口：见 `defineAdapter` 的 `buildRequest` 契约。
   * @param {object} source 来源记录
   * @param {{owner: string, repo: string}} config 归一配置
   * @returns {{url: string, acceptHint: string}}
   */
  buildRequest(source, config) {
    return this.buildRequests(source, config)[0]
  },

  /**
   * 解析抓取结果。**按内容嗅探格式**，因为同一个来源可能落到两个不同的端点上。
   *
   * @param {object} result 抓取结果
   * @param {{owner: string, repo: string}} config 归一配置
   * @returns {{title: string, items: object[]}}
   */
  parse(result, config) {
    const body = typeof result?.content === 'string' ? result.content : ''
    if (body.trim() === '') throw new AdapterParseError('响应内容为空，无法解析')

    // JSON 端点：第一个非空白字符就是 `[` 或 `{`。
    const head = body.trimStart()[0]
    if (head === '[' || head === '{') {
      return parseApiJson(body, config, result?.truncated === true)
    }

    // Atom 端点：沿用 Feed 解析路径。
    assertBodyNotTruncated(result, '这个仓库的 Releases 太多，请改用 API 端点（本适配器的首选端点）')
    const xml = readXmlBody(result)
    const parsed = parseFeed(xml)
    if (!parsed.ok) throw new AdapterParseError(parsed.message ?? '无法解析为 Atom')
    if (parsed.kind !== 'atom') {
      // 地址被重定向到了 HTML 登录页之类 —— 明确报错，不要试图从 HTML 里猜 Release。
      throw new AdapterParseError('返回的内容不是 Atom 订阅源，请确认仓库是公开的且存在 Releases')
    }
    const items = mapFeedItems(parsed).map((item) => {
      // GitHub 的 entry title 就是 tag 名（如 `v1.2.0`），标题为空时用地址兜底。
      const title = asText(item.title).slice(0, MAX_TITLE_CHARS)
      return { ...item, title: title || `${config.owner}/${config.repo} 的发布` }
    })
    return {
      title: asText(parsed.title).slice(0, MAX_TITLE_CHARS) || `${config.owner}/${config.repo} Releases`,
      items,
    }
  },
})

/**
 * 预置模板：把常用仓库固化在代码里，避免用户手抄错的地址。
 *
 * 这些 URL 是**代码内常量**（不是用户输入），因此不受「自定义地址」那层限制。
 * 注意：模板只固化**地址形状**，不会预先把来源写进用户的存储 —— 用户可以自己决定加不加。
 */
export const GITHUB_TEMPLATES = [
  { owner: 'deepseek-ai', repo: 'deepseek-harness', name: 'DeepSeek Harness Releases' },
  { owner: 'openai', repo: 'openai-node', name: 'OpenAI Node SDK Releases' },
  { owner: 'anthropics', repo: 'anthropic-sdk-typescript', name: 'Anthropic TS SDK Releases' },
]
