/**
 * GitHub 系适配器共用的工具（P1-04 抽出）。
 *
 * 为什么要有这个文件：`github_releases` 与 `github_repo` 面对的是**同一个 API 的
 * 同一套规则** —— 同一种 owner/repo 字符集、同一种 ISO 时间、同一种
 * `{message: ...}` 错误体。把这几条各写一遍，等于给自己留了「改了一处忘了另一处」
 * 的机会：哪天发现某个字符集要收紧，只会收紧其中一个适配器，另一个继续放行。
 *
 * 所以这里只放**已经被两个适配器共同使用**的东西，不预先把可能用到的都搬进来。
 *
 * @module dsh-apradar/src/host/adapters/github-common
 */

import { AdapterParseError, SourceConfigError, asText, assertBodyNotTruncated } from './types.js'

/**
 * GitHub 的 owner / repo 允许的字符集。
 *
 * 刻意收紧：GitHub 自身的规则略有出入，但这里只要**足够覆盖真实仓库**即可，
 * 过宽的字符集只会给 URL 拼接引入不必要的风险。点号与下划线是合法仓库名的一部分，
 * 但 `.` 与 `..` 单独出现会被显式拒绝（路径穿越）。
 */
export const IDENTIFIER_RE = /^[A-Za-z0-9._-]+$/

/** owner / repo 各自的最大长度（GitHub 的实际限制是 39 / 100，这里取更宽松的上界）。 */
export const MAX_IDENTIFIER_CHARS = 100

/** 单条记录标题长度上限。 */
export const MAX_TITLE_CHARS = 300

/**
 * 校验并归一一个 GitHub 标识段。
 * @param {unknown} value 用户输入
 * @param {string} field 字段中文名（用于错误文案）
 * @returns {string}
 */
export function normalizeIdentifier(value, field) {
  const text = asText(value)
  if (!text) throw new SourceConfigError(`请填写${field}`)
  if (text.length > MAX_IDENTIFIER_CHARS) throw new SourceConfigError(`${field}过长`)
  if (!IDENTIFIER_RE.test(text)) {
    throw new SourceConfigError(`${field}只能包含字母、数字、点、下划线和连字符`)
  }
  if (text === '.' || text === '..') throw new SourceConfigError(`${field}不合法`)
  return text
}

/**
 * 把 ISO 8601 时间转成 epoch 毫秒。
 *
 * 解析不出来就返回 `null` —— 「没有发布时间」和「发布时间是 1970 年」是两件
 * 事，编一个时间出来会让界面显示一个看起来很确定的错误日期。
 *
 * @param {unknown} value 任意值
 * @returns {number|null}
 */
export function toEpochMs(value) {
  const text = asText(value)
  if (!text) return null
  const ms = Date.parse(text)
  return Number.isFinite(ms) ? ms : null
}

/**
 * 读一个 JSON 响应体，并在每一步失败时给出**能读懂**的原因。
 *
 * 顺序刻意是「先判截断、再判空、最后才 JSON.parse」：被截断的 JSON 一定解析
 * 不了，如果先解析，用户看到的是「返回的内容不是合法 JSON」，而真实原因是
 * 响应被宿主的体积上限切了 —— 那是两句完全不同的话，指向完全不同的排查方向。
 *
 * @param {object} result 抓取结果（`{content, truncated, ...}`）
 * @param {string} hint 超限时针对本类型的补充建议
 * @returns {unknown} 解析出的 JSON 值
 */
export function readJsonBody(result, hint) {
  assertBodyNotTruncated(result, hint)
  const body = typeof result?.content === 'string' ? result.content : ''
  if (body.trim() === '') throw new AdapterParseError('响应内容为空，无法解析')
  try {
    return JSON.parse(body)
  } catch (error) {
    throw new AdapterParseError('返回的内容不是合法 JSON', { reason: String(error?.message ?? error) })
  }
}

/**
 * 从一个「错误形状」的 GitHub 响应里取出它自己给的说明。
 *
 * GitHub 的错误体是 `{message, documentation_url, status}`。`message` 是英文的，
 * 但它比我们能编的任何中文都准确（比如 `Not Found` 与 `API rate limit exceeded`
 * 的处置完全不同），所以照录，再在前面补一句中文解释。
 *
 * @param {unknown} data 已解析的响应
 * @returns {string} 没有 message 时返回空串
 */
export function githubApiMessage(data) {
  if (!data || typeof data !== 'object') return ''
  return typeof data.message === 'string' ? data.message.trim() : ''
}

/**
 * 把 `{message}` 形式的 GitHub 错误翻成一句带处置建议的中文。
 * @param {string} message GitHub 原文
 * @param {number|undefined} statusCode HTTP 状态码
 * @returns {string}
 */
export function describeGithubError(message, statusCode) {
  const lower = message.toLowerCase()
  if (lower.includes('rate limit') || statusCode === 429) {
    return `GitHub 接口频率限制已用尽（未认证请求每小时 60 次）。（${message}）`
  }
  if (lower.includes('not found') || statusCode === 404) {
    return `GitHub 返回 Not Found：仓库不存在，或者它是一个私有仓库。（${message}）`
  }
  return `GitHub 返回了错误：${message}`
}
