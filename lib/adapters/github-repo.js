/**
 * GitHub 仓库动态适配器（P1-04）。
 *
 * 与 `github_releases` 的区别是**它看的不是发布记录，而是仓库自身的定位信息**：
 * 描述、主页、Topics、开源许可、语言、默认分支、可见性、是否归档，以及 Stars
 * 跨过的整数关卡。
 *
 * 为什么这是一个独立的适配器而不是给 Releases 加个开关：两者回答的是不同的问题。
 * Releases 回答「他们发了什么」，仓库动态回答「他们现在说自己是做什么的」。
 * 后者变化很少，但变化时几乎总是一件值得知道的事 —— 一个项目改掉自己的描述、
 * 换掉许可、或者被标记为归档，都不是版本号能表达的。
 *
 * ## 为什么只抓一个仓库对象，不抓 stars 的精确数值
 *
 * 这个端点只用一次请求（实测 6,938 字节），返回的 `stargazers_count` 几乎**每次
 * 抓取都会变**。如果把它当作一个会被 diff 的条目，每次刷新都会产出一条
 * 「内容有修改：Stars」，真实的信号会被自己的噪声埋掉。
 *
 * 所以这里把 Stars 处理成**里程碑**：`1,000 / 2,000 / 5,000 / 10,000 / …` 每跨过
 * 一道门槛才新增一个条目。它是一次性的、不会重复触发，而且「Stars 突破 10,000」
 * 本身就是一句人话。精确数字仍然写在条目的正文里，只是不参与差异比较。
 *
 * `pushed_at` 同理不进条目 —— 它每次提交都会变；「最近推送时间」也不是产品信息。
 *
 * @module dsh-apradar/src/host/adapters/github-repo
 */

import { defineAdapter, AdapterParseError, asText, asConfigObject } from './types.js'
import {
  MAX_TITLE_CHARS,
  describeGithubError,
  githubApiMessage,
  normalizeIdentifier,
  readJsonBody,
} from './github-common.js'

/**
 * Stars 里程碑门槛。
 *
 * 只到 500,000 就停：再往上是全世界前几名仓库的量级，多写几档不会有人用到，
 * 却会让每个仓库的快照多出几行空白判断。
 */
export const STAR_MILESTONES = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000]

/**
 * 给整数加千位分隔符。
 *
 * 不用 `toLocaleString()`：它的输出取决于运行环境的 ICU 数据与默认区域，
 * 测试里的快照式比对会因此变得不稳定，而这只是显示用的分组。
 *
 * @param {number} value 非负整数
 * @returns {string}
 */
export function groupDigits(value) {
  const text = String(Math.trunc(value))
  return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * 把仓库对象摊平成一组**会被差异比较**的条目。
 *
 * @param {Record<string, unknown>} repo GitHub 仓库对象
 * @returns {object[]}
 */
export function repoItems(repo) {
  const items = []
  const push = (itemId, title, text) => {
    items.push({ itemId, title: title.slice(0, MAX_TITLE_CHARS), text, url: null, publishedAt: null })
  }

  const description = asText(repo.description)
  push(
    'description',
    '仓库描述',
    description || '（这个仓库没有填写描述）',
  )

  const homepage = asText(repo.homepage)
  push('homepage', '项目主页', homepage || '（这个仓库没有填写主页）')

  const topics = Array.isArray(repo.topics)
    ? repo.topics.map((topic) => asText(topic)).filter((topic) => topic !== '').sort()
    : []
  push('topics', 'Topics', topics.length > 0 ? topics.join(', ') : '（没有设置 Topics）')

  const language = asText(repo.language)
  push('language', '主要语言', language || '（GitHub 还没有识别出主要语言）')

  const branch = asText(repo.default_branch)
  push('default_branch', '默认分支', branch || '（未知）')

  const licenseId = asText(repo?.license?.spdx_id)
  // GitHub 对「没有许可」返回 `license: null`；对「识别不出的许可」返回 `spdx_id: "NOASSERTION"`。
  // 两者含义不同，但都属于「拿不到一个明确的许可标识」，这里如实照录。
  push('license', '开源许可', licenseId && licenseId !== 'NOASSERTION' ? licenseId : '（没有声明开源许可）')

  const visibility = asText(repo.visibility)
  push('visibility', '可见性', visibility || '（未知）')

  // 归档是单向的、且会改变一个项目"还能不能用"的判断，所以只在真的归档时出现。
  // 不归档时不产生条目 —— 一个「没有归档」的条目每次都在，只会占地方。
  if (repo.archived === true) {
    push(
      'archived',
      '⚠️ 仓库已归档',
      '维护者把这个仓库标记为只读。它不会再收到更新（除非有人接手）。',
    )
  }

  const stars = Number.isFinite(repo.stargazers_count) ? Number(repo.stargazers_count) : 0
  for (const milestone of STAR_MILESTONES) {
    if (stars >= milestone) {
      // 正文**不带当前计数**，这是刻意的：差异比较看的正是正文的指纹，只要正文里
      // 有一个每次都在变的数字，"没跨门槛时什么都不该变"这条性质就不成立 ——
      // 每刷新一次都会给每一道已跨过的门槛报一次「内容有修改」。
      // 里程碑自带的数字已经说明了它自己，多写的那个只值一次噪声。
      push(
        `stars:${milestone}`,
        `Stars 突破 ${groupDigits(milestone)}`,
        `这个仓库的 Stars 跨过了 ${groupDigits(milestone)}。每个门槛只会出现一次 —— 数字回落也不会让它消失，那样才说明它确实发生过。`,
      )
    }
  }

  return items
}

export const githubRepoAdapter = defineAdapter({
  type: 'github_repo',
  label: 'GitHub 仓库动态',
  summary: '仓库的描述、主页、Topics、许可与归档状态。只填 owner 与 repo，地址由插件拼接。',
  testable: true,
  /**
   * 地址由代码拼接，不是用户填的自由地址。
   * `index.js` 用它决定界面上要不要显示「依赖站点结构」的警告 —— 这里不显示。
   */
  addressIsGenerated: true,
  fields: [
    { key: 'owner', label: 'owner', kind: 'text', required: true, placeholder: 'openai', hint: '组织或用户名。' },
    { key: 'repo', label: 'repo', kind: 'text', required: true, placeholder: 'openai-node', hint: '仓库名。' },
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
   * @param {object} _source 来源记录
   * @param {{owner: string, repo: string}} config 归一配置
   * @returns {{url: string, acceptHint: string}}
   */
  buildRequest(_source, config) {
    return {
      url: `https://api.github.com/repos/${config.owner}/${config.repo}`,
      acceptHint: 'application/vnd.github+json',
    }
  },

  /**
   * @param {object} result 抓取结果
   * @param {{owner: string, repo: string}} config 归一配置
   * @returns {{title: string, items: object[]}}
   */
  parse(result, config) {
    const data = readJsonBody(
      result,
      '这个接口只返回一个仓库对象，正常不会超限；请确认地址没有被重定向到别处',
    )
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new AdapterParseError('返回的内容不是仓库信息', { received: Array.isArray(data) ? 'array' : typeof data })
    }

    const fullName = asText(data.full_name)
    if (!fullName) {
      // 没有 `full_name` 而只有 `message`，就是 GitHub 的错误体（404 / 限流）。
      const message = githubApiMessage(data)
      throw new AdapterParseError(
        message
          ? describeGithubError(message, result?.statusCode)
          : '返回的内容不是仓库信息',
        message ? { statusCode: result?.statusCode ?? null } : undefined,
      )
    }

    return {
      title: `${fullName} 仓库动态`,
      items: repoItems(data),
    }
  },
})
