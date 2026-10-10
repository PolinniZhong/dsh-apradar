/**
 * 出网 URL 的**第一道**校验（SDD §8）。
 *
 * 定位说明（很重要，不要误读）：真正的 SSRF 防线在 DSH 自己的抓取层 ——
 * `@deepseek-ai/dsh-web-fetch-http` 会解析 DNS，并要求**每一个**解析结果都是
 * 公有单播地址，重定向每一跳都重新校验，且响应体积、超时、跳数都有上限。
 * 本文件是它**前面**的一层快速失败：只做字面量检查，省掉一次无谓的请求，
 * 并让失败原因对用户更可读。
 *
 * 因此：**不得**在任何文档、界面或对外说明里声称本插件「具备完整 SSRF 防护」。
 * 我们依赖宿主的这一层，而宿主的保护是「自愿使用的接口」而非强制沙箱
 * （`TECH-SPIKE.md` §7 / `SDD.md` §8 已记录这一限制）。
 *
 * @module dsh-apradar/src/host/fetch/url
 */

import { radarError } from '../errors.js'

/** DSH 抓取层自己的 URL 长度上限是 2048，这里保持一致，避免发出注定被拒的请求。 */
export const MAX_URL_LENGTH = 2048

/** 明确拒绝的主机名（小写精确匹配）。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
])

/**
 * 判断一个主机名是否是我们**字面就能看出**不该访问的目标。
 *
 * 注意 `.local` 与内网域名只能按后缀挡；DNS 重绑定之类的攻击由宿主那一层处理。
 *
 * @param {string} hostname 已小写的主机名
 * @returns {boolean} 命中则为 true
 */
function isBlockedHostname(hostname) {
  if (!hostname) return true
  if (BLOCKED_HOSTNAMES.has(hostname)) return true
  if (hostname.endsWith('.localhost')) return true
  if (hostname.endsWith('.local')) return true
  if (hostname.endsWith('.internal')) return true
  if (hostname.endsWith('.home.arpa')) return true

  // IPv6 字面量在 `URL` 里带方括号，这里先去壳再判断。
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const lower = bare.toLowerCase()

  if (lower === '::' || lower === '::1' || lower === '0:0:0:0:0:0:0:1') return true
  // IPv4-mapped / NAT64：`::ffff:127.0.0.1` 之类必须挡住，否则回环会被绕过。
  if (lower.startsWith('::ffff:') || lower.startsWith('64:ff9b:')) return true
  // 唯一本地地址（fc00::/7）与链路本地（fe80::/10）
  if (/^f[cd][0-9a-f]{0,2}:/.test(lower)) return true
  if (/^fe[89ab][0-9a-f]?:/.test(lower)) return true

  const v4 = parseIPv4(lower)
  if (v4) return isBlockedIPv4(v4)

  return false
}

/**
 * 把点分十进制解析为 4 个字节。非 IPv4 字面量返回 null。
 * @param {string} host 主机名
 * @returns {number[] | null}
 */
function parseIPv4(host) {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const bytes = []
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const value = Number(part)
    if (value > 255) return null
    bytes.push(value)
  }
  return bytes
}

/**
 * 私有 / 保留 / 元数据网段。与宿主那一层的「只允许公有单播」相比，这里是更早、更粗的拦截。
 * @param {number[]} bytes 4 个字节
 * @returns {boolean} 命中则为 true
 */
function isBlockedIPv4(bytes) {
  const [a, b] = bytes
  if (a === 0) return true // 0.0.0.0/8「本网络」
  if (a === 10) return true // 私有
  if (a === 127) return true // 回环
  if (a === 169 && b === 254) return true // 链路本地，含云元数据 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true // 私有
  if (a === 192 && b === 168) return true // 私有
  if (a === 192 && b === 0) return true // 192.0.0.0/24 保留、含 192.0.0.0
  if (a === 198 && (b === 18 || b === 19)) return true // 基准测试网段
  if (a === 100 && b >= 64 && b <= 127) return true // 运营商级 NAT
  if (a >= 224) return true // 组播与保留
  return false
}

/**
 * 校验并返回一个可安全交给宿主抓取的 URL 字符串。
 *
 * @param {unknown} rawUrl 候选地址
 * @returns {string} 规范化后的绝对地址
 * @throws {import('../errors.js').RadarError} `WEB_INVALID_URL` 或 `WEB_BLOCKED_URL`
 */
export function assertFetchableUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw radarError('WEB_INVALID_URL')
  }
  const text = rawUrl.trim()
  if (text.length > MAX_URL_LENGTH) throw radarError('WEB_INVALID_URL')

  let url
  try {
    url = new URL(text)
  } catch {
    throw radarError('WEB_INVALID_URL')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    // 明确挡掉 file:、data:、ftp: 等 —— 它们既不是公开网页，也不该被插件读取。
    throw radarError('WEB_BLOCKED_URL')
  }
  if (url.username || url.password) {
    // 带凭据的 URL 会把秘密写进快照与日志，一律拒绝。
    throw radarError('WEB_BLOCKED_URL')
  }
  if (isBlockedHostname(url.hostname)) {
    throw radarError('WEB_BLOCKED_URL')
  }
  return url.toString()
}
