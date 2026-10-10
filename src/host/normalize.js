/**
 * 文本与 URL 的规范化（normalize）。
 *
 * ## 为什么"只能有一份"
 *
 * 下游至少有三处要拿文本做判断：显示指纹、变化 diff、摘录。
 * 只要它们各自 normalize，同一段页面就会被切成不同字符串——diff 里冒出
 * 满屏"其实没变"的行，摘录和指纹对不上。所以这里定义**唯一**的规范形式
 * `normalizeText`，其余能力都建立在它之上。
 *
 * ## 确定性契约
 *
 * 没有 `Date.now()`、没有 `Math.random()`、没有 `toLocaleLowerCase()`、
 * 没有 `Intl`。大小写折叠用 `charCodeAt` 手写 ASCII 算术（见 `canonicalize`），
 * 因为页面文本里混着土耳其语 `I`/`i` 之类时，locale 相关的大小写会让
 * **同一份输入在不同机器上产生不同指纹**——去重与"页面变了没"的判定会随
 * 运行环境漂移，这是不可接受的。
 *
 * @module dsh-apradar/src/host/normalize
 */

import { decodeEntities } from './parse/entities.js'

/**
 * 规范化文本的字符上限。
 *
 * 选 10 万的理由：足以覆盖绝大多数正文页面的可读文本（远超一屏），
 * 同时把单条快照的内存与 diff 代价锁在常数级。截断是**硬**的，
 * 且不劈开代理对（见 `truncateSafely`）。
 */
export const MAX_NORMALIZED_TEXT_CHARS = 100000

/**
 * 零宽 / 不可见字符必须抹掉：它们肉眼不可见却参与比较，
 * 是"看起来一样但 diff 说有差异"的头号来源。
 *
 *   - `\u200B` ZERO WIDTH SPACE
 *   - `\u200C` ZERO WIDTH NON-JOINER
 *   - `\u200D` ZERO WIDTH JOINER
 *   - `\u2060` WORD JOINER
 *   - `\uFEFF` ZERO WIDTH NO-BREAK SPACE / BOM
 *
 * 它们和 C0 控制字符一起在 `stripInvisibleAndControls` 里手写扫描剔除，
 * 不走正则——理由见那个函数。
 */

/**
 * 逐行折叠：把行内的空格/制表符串压成一个空格，并去掉行尾空白。
 *
 * `[^\S\n]+` 表示"是空白但不是换行"——保留换行，只折水平空白。
 * 这是无嵌套量词的字面量正则，不存在对抗性回溯。
 */
const HORIZONTAL_RUN_RE = /[^\S\n]+/g
/** 行尾水平空白（折叠后最多只剩一个，这里兜底）。 */
const TRAILING_SPACE_RE = /[ \t]+$/gm
/**
 * 行首水平空白同样要去掉。
 *
 * 这条规则不是"顺手 trim 一下"，它直接决定变化检测的信噪比：HTML 里
 * 缩进是**结构性**的，只要上游改了模板嵌套层级，同一段文字就会整体
 * 多出几个空格——不去掉的话，每一次改版都会刷出一整页"内容变了"，
 * 而读者看到的字一个都没变。
 *
 * 注意这会连制表符一起去掉：`'a\n\tb'` → `'a\nb'`。制表符在行内的
 * 存活另有证明（`'a\tb'` → `'a b'`：被折叠成空格，而不是当控制字符删掉）。
 */
const LEADING_SPACE_RE = /^[ \t]+/gm
/** 3 个及以上换行压成 2 个：保留"一个空行"的段落分隔信息。 */
const BLANK_RUN_RE = /\n{3,}/g

/** 去掉首尾换行（不 trim 其他字符，空格已在上一步处理）。 */
const EDGE_NEWLINE_RE = /^\n+|\n+$/g

/**
 * 重写行结尾：`\r\n` 与裸 `\r` 都变成 `\n`。
 *
 * 顺序不能反：先处理 `\r\n`（两字符），否则裸 `\r` 规则会把 `\r\n` 变成 `\n\n`。
 */
function normalizeNewlines(text) {
  if (text.indexOf('\r') === -1) return text
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/**
 * 按上限截断，且**不劈开代理对**。
 *
 * 若恰好切在代理对中间（高位代理 `0xD800`–`0xDBFF` 后面紧跟低位代理），
 * 就少取一个字符。否则输出末尾会留下一个孤立代理，长度、编码、
 * JSON 序列化都会出错。
 *
 * @param {string} text
 * @param {number} limit
 * @returns {{text: string, truncated: boolean}}
 */
function truncateSafely(text, limit) {
  if (text.length <= limit) return { text, truncated: false }

  let end = limit
  const lastCode = text.charCodeAt(end - 1)
  const nextCode = text.charCodeAt(end)
  const lastIsHigh = lastCode >= 0xD800 && lastCode <= 0xDBFF
  const nextIsLow = nextCode >= 0xDC00 && nextCode <= 0xDFFF
  if (lastIsHigh && nextIsLow) end -= 1

  return { text: text.slice(0, end), truncated: true }
}

/**
 * 生成规范文本。**这是下游唯一允许使用的文本形式。**
 *
 * 步骤：
 *   1. 非字符串一律当 `''`
 *   2. `\r\n` / `\r` → `\n`
 *   3. 仍含 `&` 时做一次实体解码（调用方可能已解码；只有仍含 `&` 才解，
 *      避免对已解码文本二次解码）
 *   4. 抹掉零宽字符与除 `\n`/`\t` 外的 C0 控制字符
 *   5. 逐行折叠水平空白、去行首与行尾空白
 *   6. 3+ 换行压成 2，去首尾换行
 *   7. 截断到 `MAX_NORMALIZED_TEXT_CHARS`（不劈代理对）
 *
 * @param {unknown} raw
 * @returns {{text: string, truncated: boolean, chars: number}}
 */
export function normalizeText(raw) {
  let text = typeof raw === 'string' ? raw : ''
  text = normalizeNewlines(text)

  // 只在还有 `&` 时解码：这是"防二次解码"的守门条件。
  if (text.indexOf('&') !== -1) {
    text = decodeEntities(text)
  }

  // 控制字符：保留 \n 与 \t，其余 C0、DEL，以及零宽字符全删。
  // 手写扫描而非正则，避免在超长输入上产生临时大字符串。
  text = stripInvisibleAndControls(text)

  text = text.replace(HORIZONTAL_RUN_RE, ' ')
  text = text.replace(TRAILING_SPACE_RE, '')
  text = text.replace(LEADING_SPACE_RE, '')
  text = text.replace(BLANK_RUN_RE, '\n\n')
  text = text.replace(EDGE_NEWLINE_RE, '')

  const outcome = truncateSafely(text, MAX_NORMALIZED_TEXT_CHARS)
  return { text: outcome.text, truncated: outcome.truncated, chars: outcome.text.length }
}

/**
 * 删除零宽字符与除 `\n`/`\t` 外的 C0 控制字符、DEL。
 *
 * 先做一次"是否需要处理"的探测：绝大多数文本不需要，可原地返回同一个引用。
 *
 * @param {string} text
 * @returns {string}
 */
function stripInvisibleAndControls(text) {
  let needed = false
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 0x0A || code === 0x09) continue
    if (code < 0x20 || code === 0x7F) {
      needed = true
      break
    }
    if (code === 0x200B || code === 0x200C || code === 0x200D || code === 0x2060 || code === 0xFEFF) {
      needed = true
      break
    }
  }
  if (!needed) return text

  const pieces = []
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 0x0A || code === 0x09) {
      pieces.push(text[i])
      continue
    }
    if (code < 0x20 || code === 0x7F) continue
    if (code === 0x200B || code === 0x200C || code === 0x200D || code === 0x2060 || code === 0xFEFF) continue
    pieces.push(text[i])
  }
  return pieces.join('')
}

/**
 * 用于指纹计算的强规范形式。
 *
 * 在 `normalizeText` 的空白语义之上再做一次 ASCII 大小写折叠。
 * **明确不用 `toLowerCase()`**：它受 locale 影响（土耳其语无点 i 等），
 * 会让同一份输入在不同环境产出不同指纹。这里只按码点把 `A-Z` 映射到 `a-z`。
 *
 * 注意：只折叠 ASCII。非 ASCII 字母（含全角、希腊字母等）保持原样——
 * 中文页面里几乎不出现"仅大小写不同"的噪声，而 Unicode 折叠会引入
 * 依赖大小写表的版本漂移。
 *
 * @param {unknown} text
 * @returns {string}
 */
export function canonicalize(text) {
  const base = typeof text === 'string' ? text : ''
  const cleaned = base
    .replace(HORIZONTAL_RUN_RE, ' ')
    .replace(TRAILING_SPACE_RE, '')
    .replace(LEADING_SPACE_RE, '')
    .replace(BLANK_RUN_RE, '\n\n')
    .replace(EDGE_NEWLINE_RE, '')
    .trim()

  const pieces = []
  for (let i = 0; i < cleaned.length; i += 1) {
    const code = cleaned.charCodeAt(i)
    // A-Z → a-z：加 0x20 是 ASCII 里唯一正确的大小写映射差。
    pieces.push(code >= 0x41 && code <= 0x5A ? String.fromCharCode(code + 0x20) : cleaned[i])
  }
  return pieces.join('')
}

/**
 * 需要剔除的跟踪参数。**按名字精确匹配（不区分大小写）**，不做前缀匹配：
 * `source` 常被内容站当作真实参数，但它在列表里（按既定规范），
 * 因此一并剔除；而 `reftype` 这类"长得像 reftype"的参数不受影响。
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid',
  'mc_cid', 'mc_eid',
  'ref', 'source', 'spm', 'yclid', 'igshid',
])

/** 各 scheme 的默认端口，只有等于默认值时才丢弃。 */
const DEFAULT_PORTS = Object.freeze({ 'http:': '80', 'https:': '443' })

/**
 * 判定 query 参数名是否要剔除（大小写不敏感）。
 *
 * @param {string} paramName
 * @returns {boolean}
 */
function isTrackingParam(paramName) {
  return TRACKING_PARAMS.has(paramName.toLowerCase())
}

/**
 * 去掉路径里重复的 `/`（`//a///b` → `/a/b`）。
 *
 * 手写扫描而不是 `replace(/\/+/g, '/')`：后者同样安全，但这里需要
 * 保留"完全不重复"时的原引用，省一次拷贝。语义上与折叠一致。
 *
 * @param {string} pathname
 * @returns {string}
 */
function collapseSlashes(pathname) {
  if (pathname.indexOf('//') === -1) return pathname

  const pieces = []
  let previousSlash = false
  for (let i = 0; i < pathname.length; i += 1) {
    const char = pathname[i]
    if (char === '/') {
      if (previousSlash) continue
      previousSlash = true
    } else {
      previousSlash = false
    }
    pieces.push(char)
  }
  return pieces.join('')
}

/**
 * 把 URL 归一成**去重键**形式。
 *
 * 规则与理由：
 *   - 只接受能 `new URL()` 解析、且协议是 `http:`/`https:` 的绝对地址。
 *     解析失败（相对路径、`javascript:`、`ftp:`）返回 `null`——
 *     不能"猜一个 base"补全，那会把不同页面的相对链接混成同一个键。
 *   - 带用户名/密码的 URL 返回 `null`：同一资源因凭据不同会被当成不同页面，
 *     而且凭据不该进入持久化存储。
 *   - scheme 与 hostname 统一小写（主机名大小写不敏感）；默认端口丢弃，
 *     非默认端口保留（`:8443` 可能是完全不同的服务）。
 *   - fragment 整段丢弃：`#section` 与服务端返回的内容无关。
 *   - 跟踪参数按名单剔除，其余参数**按 key 再按 value 排序**后重新序列化：
 *     顺序不定的 query 是"同一页被判成两个"的主要来源。
 *   - 路径去掉一个末尾 `/`（`/a/` → `/a`），但根路径 `/` 必须保留；
 *     空 query 不输出 `?`。
 *   - 幂等：`normalizeUrl(normalizeUrl(x)) === normalizeUrl(x)`。
 *
 * @param {unknown} rawUrl
 * @returns {string|null}
 */
export function normalizeUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return null
  const trimmed = rawUrl.trim()
  if (trimmed === '') return null

  let parsed
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }

  const scheme = parsed.protocol.toLowerCase()
  if (scheme !== 'http:' && scheme !== 'https:') return null

  // 显式拒绝内嵌凭据。
  if (parsed.username !== '' || parsed.password !== '') return null

  const hostname = parsed.hostname.toLowerCase()
  // URL 对 IPv6 会带上方括号，hostname 已含 `[...]`，这里不再补。
  const defaultPort = DEFAULT_PORTS[scheme]
  const port = parsed.port !== '' && parsed.port !== defaultPort ? ':' + parsed.port : ''

  let pathname = collapseSlashes(parsed.pathname)
  if (pathname.length > 1 && pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1)
  }
  if (pathname === '') pathname = '/'

  // 过滤 + 排序。`sort()` 默认按 UTF-16 码元序，与 locale 无关，满足确定性要求。
  const kept = []
  for (const [key, value] of parsed.searchParams) {
    if (isTrackingParam(key)) continue
    kept.push([key, value])
  }
  kept.sort((a, b) => {
    if (a[0] < b[0]) return -1
    if (a[0] > b[0]) return 1
    if (a[1] < b[1]) return -1
    if (a[1] > b[1]) return 1
    return 0
  })

  const search = new URLSearchParams()
  for (const [key, value] of kept) search.append(key, value)
  const query = search.toString()

  return `${scheme}//${hostname}${port}${pathname}${query === '' ? '' : '?' + query}`
}
