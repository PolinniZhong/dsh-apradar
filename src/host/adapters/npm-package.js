/**
 * npm 包适配器（P1-04）。
 *
 * 抓的是 `https://registry.npmjs.org/<包名>/<tag>`，也就是**一个版本的清单**
 * （实测 `openai@7.31.0` 为 7,826 字节）。
 *
 * ## 为什么不用完整的 packument
 *
 * `https://registry.npmjs.org/<包名>` 会返回**全部历史版本**，信息最全，但它
 * 也是唯一一个实测直接撞上宿主上限的形状：`openai` 的 packument 是
 * **4,496,833 字节**，而宿主的 `maxBodyChars` 是 100,000 字符 —— 被截断之后
 * 报出来的是「响应体超过宿主上限已被截断」，用户拿不到任何东西。
 *
 * 所以这里固定走单版本清单：它足够小、形状稳定，而且**恰好回答这个问题** ——
 * 「这个包现在的最新版是什么，它带了哪些依赖」。
 *
 * ## 版本号的条目设计
 *
 * 版本号进的是**条目 id**（`version:7.31.0`）而不是正文，所以一次发版在差异里
 * 表现为「新增：openai@7.31.0」——这是最直接的一句话。依赖集合用的是**稳定 id**
 * （`dependencies`），所以依赖的增减表现为「内容有修改：运行时依赖（12 个）」。
 *
 * ## `publishedAt` 为什么是空的
 *
 * 单版本清单里没有发布时间（只有完整 packument 的 `time` 字段有，而它超限）。
 * 不编时间：条目的 `publishedAt` 一律为 `null`，插件记录的是**自己发现它的时间**，
 * 界面上写的是「插件发现时间」。把「我没拿到」显示成「发布时间是某年某月」是撒谎。
 *
 * @module dsh-apradar/src/host/adapters/npm-package
 */

import { defineAdapter, AdapterParseError, SourceConfigError, asText, asConfigObject } from './types.js'
import { MAX_TITLE_CHARS, readJsonBody } from './github-common.js'

/**
 * npm 包名允许的字符集。
 *
 * 比 npm 官方的规则略紧：官方还允许老包里的非法字符（历史遗留），但那些包
 * 正是我们不想拼进 URL 的东西。作用域包（`@scope/name`）是明确允许的，
 * 因为 AI 生态里最常见的那几个 SDK 恰好都在作用域下（`@anthropic-ai/sdk`、
 * `@google/genai`）。
 */
const PACKAGE_RE = /^(@[A-Za-z0-9-._~]+\/)?[A-Za-z0-9-._~]+$/

/** npm 官方对包名的长度限制（214 个字符），这里照用。 */
const MAX_PACKAGE_CHARS = 214

/** tag 与版本号共用一套字符集（`latest` / `next` / `1.2.3-beta.1`）。 */
const TAG_RE = /^[A-Za-z0-9-._~]+$/

/**
 * 校验并归一包名。
 * @param {unknown} value 用户输入
 * @returns {string}
 */
export function normalizePackageName(value) {
  const text = asText(value)
  if (!text) throw new SourceConfigError('请填写包名')
  if (text.length > MAX_PACKAGE_CHARS) throw new SourceConfigError('包名过长')
  if (!PACKAGE_RE.test(text)) {
    throw new SourceConfigError('包名只能包含字母、数字、点、下划线、波浪线和连字符；作用域包写成 @scope/name')
  }
  // 以点或下划线开头的包名在 npm 里是非法的，也容易和路径片段混淆。
  const bare = text.startsWith('@') ? text.slice(text.indexOf('/') + 1) : text
  if (bare.startsWith('.') || bare.startsWith('_')) throw new SourceConfigError('包名不能以点或下划线开头')
  return text
}

/**
 * 校验并归一 tag（缺省 `latest`）。
 * @param {unknown} value 用户输入
 * @returns {string}
 */
export function normalizeTag(value) {
  const text = asText(value)
  if (!text) return 'latest'
  if (!TAG_RE.test(text)) {
    throw new SourceConfigError('标签只能包含字母、数字、点、下划线、波浪线和连字符')
  }
  return text
}

/**
 * 把依赖对象摊成稳定的多行文本。
 *
 * **必须排序**：JSON 对象的键序不保证稳定，而在差异比较里「顺序变了」和
 * 「内容变了」是两件事。不排序会让一次无关紧要的键序调整产出一条假的变化。
 *
 * @param {unknown} deps 依赖对象
 * @returns {{count: number, text: string}}
 */
export function formatDependencies(deps) {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) return { count: 0, text: '' }
  const lines = Object.entries(deps)
    .filter(([name]) => asText(name) !== '')
    .map(([name, range]) => `${name}@${asText(range) || '（未指定范围）'}`)
    .sort()
  return { count: lines.length, text: lines.join('\n') }
}

/**
 * 从 `repository` 字段里取出一个字符串。
 * npm 既可能给字符串，也可能给 `{type, url}`。
 * @param {unknown} value 任意值
 * @returns {string}
 */
function repositoryUrl(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object' && typeof value.url === 'string') return value.url.trim()
  return ''
}

/**
 * 取出许可标识。
 *
 * 老包（npm 早期规范）把 `license` 写成对象 `{type, url}`，新包写成字符串。
 * 两种都要认，否则一个 MIT 的包会被显示成「没有声明许可」。
 *
 * @param {unknown} value 任意值
 * @returns {string} 取不到时返回空串
 */
function licenseId(value) {
  if (typeof value === 'string') return value.trim()
  if (value && typeof value === 'object') {
    for (const key of ['type', 'name']) {
      if (typeof value[key] === 'string') return value[key].trim()
    }
  }
  return ''
}

/**
 * 把版本清单摊平成一组会被差异比较的条目。
 *
 * @param {Record<string, unknown>} manifest npm 版本清单
 * @returns {object[]}
 */
export function manifestItems(manifest) {
  const name = asText(manifest.name)
  const version = asText(manifest.version)
  const items = []
  const push = (itemId, title, text) => {
    items.push({ itemId, title: title.slice(0, MAX_TITLE_CHARS), text, url: null, publishedAt: null })
  }

  const lines = [asText(manifest.description) || '（没有填写描述）']
  lines.push(`许可：${licenseId(manifest.license) || '（没有声明）'}`)
  const homepage = asText(manifest.homepage)
  if (homepage) lines.push(`主页：${homepage}`)
  const repository = repositoryUrl(manifest.repository)
  if (repository) lines.push(`代码库：${repository}`)
  const type = asText(manifest.type)
  if (type) lines.push(`模块类型：${type}`)
  if (manifest.bin) lines.push('这个包提供命令行工具。')
  // 刻意**不**在这里重复 Node 要求：它是独立条目 `engines`，重复写会让一次
  // 运行环境的变化同时修改两个条目，差异里出现两条指向同一件事的记录。

  push(`version:${version}`, `${name}@${version}`, lines.join('\n'))

  const deps = formatDependencies(manifest.dependencies)
  if (deps.count > 0) {
    push('dependencies', `运行时依赖（${deps.count} 个）`, deps.text)
  }

  const peers = formatDependencies(manifest.peerDependencies)
  if (peers.count > 0) {
    push('peerDependencies', `peer 依赖（${peers.count} 个）`, peers.text)
  }

  const engines = formatDependencies(manifest.engines)
  if (engines.count > 0) {
    push('engines', '运行环境要求', engines.text)
  }

  // `deprecated` 是发布者自己写下的一句警告，通常意味着这个版本有安全或兼容问题。
  // 它只在真的存在时出现 —— 一条「没有被废弃」的条目每次都占地方。
  const deprecated = asText(manifest.deprecated)
  if (deprecated) {
    push('deprecated', '⚠️ 这个版本已被标记为废弃', deprecated)
  }

  return items
}

export const npmPackageAdapter = defineAdapter({
  type: 'npm_package',
  label: 'npm 包',
  summary: 'npm 上某个包（或某个 tag）的当前版本、描述与依赖。地址由插件拼接。',
  testable: true,
  /** 地址由代码拼接，不是用户填的自由地址 —— 界面上不显示「依赖站点结构」的警告。 */
  addressIsGenerated: true,
  fields: [
    {
      key: 'name',
      label: '包名',
      kind: 'text',
      required: true,
      placeholder: 'openai',
      hint: '作用域包写成 @scope/name，例如 @anthropic-ai/sdk。',
    },
    {
      key: 'tag',
      label: '标签',
      kind: 'text',
      required: false,
      placeholder: 'latest',
      hint: '留空就是 latest。也可以填 next、beta，或一个具体的版本号。',
    },
  ],

  /**
   * @param {unknown} input 用户输入
   * @returns {{name: string, tag: string}} 归一后的配置
   */
  normalizeConfig(input) {
    const config = asConfigObject(input)
    return {
      name: normalizePackageName(config.name),
      tag: normalizeTag(config.tag),
    }
  },

  /**
   * 用户没起名时的默认名字。见 `service.js` 的 `defaultNameFor`。
   *
   * 填了非 `latest` 的 tag 时带上 tag：`ai` 与 `ai@beta` 是两个不同的来源，
   * 卡片上必须分得清。
   *
   * @param {{name: string, tag: string}} config 归一配置
   * @returns {string}
   */
  defaultName(config) {
    return config.tag && config.tag !== 'latest' ? `${config.name}@${config.tag}` : config.name
  },

  /**
   * 地址里的包名与标签**不做 URL 编码**。
   *
   * 理由是上面的字符集已经把它们限制在一个不需要编码的集合里（字母、数字、
   * 点、下划线、波浪线、连字符，作用域包额外允许 `@` 与一个 `/`），而
   * `encodeURIComponent('@anthropic-ai/sdk')` 会得到 `%40anthropic-ai%2Fsdk`。
   * 实测两种写法 npm 都接受，但**未编码的那种是一个已经被验证过的 200**，
   * 而"编码后也应该能用"只是一句推测。字符集校验才是真正的防线。
   *
   * @param {object} _source 来源记录
   * @param {{name: string, tag: string}} config 归一配置
   * @returns {{url: string, acceptHint: string}}
   */
  buildRequest(_source, config) {
    return {
      url: `https://registry.npmjs.org/${config.name}/${config.tag}`,
      acceptHint: 'application/json',
    }
  },

  /**
   * @param {object} result 抓取结果
   * @param {{name: string, tag: string}} config 归一配置
   * @returns {{title: string, items: object[]}}
   */
  parse(result, config) {
    const data = readJsonBody(
      result,
      '这个包的清单太大，请改用具体版本（例如 /1.2.3）或换一个包',
    )

    // 404 时 npm 回的是 JSON 字符串 `"Not Found"`，不是对象。
    // 它解析得开，所以必须在形状判断里显式处理，否则会一路走到"缺少 name"。
    if (typeof data === 'string') {
      throw new AdapterParseError(`npm 上没有 ${config.name}@${config.tag}：${data}`)
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new AdapterParseError('返回的内容不是 npm 包清单', {
        received: Array.isArray(data) ? 'array' : typeof data,
      })
    }
    // 其余错误形状是 `{error: "..."}`。
    if (typeof data.error === 'string' && data.error.trim() !== '') {
      throw new AdapterParseError(`npm 返回了错误：${data.error.trim()}`)
    }

    const name = asText(data.name) || config.name
    const version = asText(data.version)
    if (!version) {
      throw new AdapterParseError(`npm 返回的清单里没有版本号：${config.name}@${config.tag}`)
    }

    return {
      title: `${name}@${version}`,
      items: manifestItems({ ...data, name }),
    }
  },
})

/**
 * 预置模板：常用 AI SDK。
 *
 * 与 GitHub 模板同一约定 —— 地址由代码拼接，只固化形状，**不会**在安装时
 * 偷偷写进用户的存储。
 */
export const NPM_TEMPLATES = [
  { name: 'openai', label: 'OpenAI Node SDK', packageName: 'openai' },
  { name: '@anthropic-ai/sdk', label: 'Anthropic TS SDK', packageName: '@anthropic-ai/sdk' },
  { name: 'ai', label: 'Vercel AI SDK', packageName: 'ai' },
]
