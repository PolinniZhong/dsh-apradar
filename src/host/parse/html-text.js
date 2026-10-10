/**
 * HTML → 纯文本，以及文档的结构指纹。
 *
 * ## 为什么用手写扫描而不是正则
 *
 * 输入是**不可信的外部页面**。形如 `<script[\s\S]*?<\/script>` 的懒惰正则在
 * "一堆 `<script` 但没有闭合"的构造上会退化成平方级回溯，直接把插件拖死。
 * 这里每一步都用 `indexOf` + 显式指针推进，扫描指针**只前进**，
 * 所以最坏情况是线性的，长度上限也由调用方控制。
 *
 * ## 与相邻模块的边界
 *
 * 本模块只负责"把标签拿掉、留下原始文本"，**不做空白归一化**——
 * 那是 `../normalize.js` 的职责。分离的原因：结构指纹与文本指纹必须
 * 基于同一份归一化结果，归一化只能有一个实现。
 *
 * @module dsh-apradar/src/host/parse/html-text
 */

import { decodeEntities } from './entities.js'

/** 内容整体丢弃的标签。这些标签里的"文本"不是给读者看的内容。 */
const RAW_TEXT_SKIP = Object.freeze(['script', 'style', 'noscript'])

/**
 * 块级边界标签。开标签或闭标签出现时都换成一个 `\n`。
 * 之所以要 `br`/`hr`：它们没有闭标签，只出现开标签。
 */
const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ol', 'ul',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'tr', 'td', 'th', 'table',
  'section', 'article', 'header', 'footer',
  'blockquote', 'pre', 'figure', 'figcaption',
  'hr', 'dd', 'dt',
])

/** `htmlStructureFingerprint` 结果的硬上限；超长指纹没有区分度还占存储。 */
const FINGERPRINT_MAX_CHARS = 2000

/**
 * 单个标签允许的最大长度。
 *
 * 正常标签远小于此值（最长的 CDN 内联 `data:` 属性也就几 KB）。
 * 设这个上限是为了让 `parseTagAt` 的工作量有界：超过它就认定"这个 `<`
 * 不是标签"，按字面文本处理，从而保证整条流水线是 O(n) 而不是 O(n²)。
 */
const MAX_TAG_CHARS = 8192

/** 判断字符是否为 ASCII 字母。用码点比较，不依赖 locale。 */
function isAsciiLetter(code) {
  return (code >= 0x41 && code <= 0x5A) || (code >= 0x61 && code <= 0x7A)
}

/** 判断是否为 HTML 空白（空格/制表/换行/回车）。 */
function isHtmlSpace(code) {
  return code === 0x20 || code === 0x09 || code === 0x0A || code === 0x0D
}

/** 判断是否为 tag name 允许的后续字符（字母/数字/`-`/`_`/`:`/`.`）。 */
function isTagNameChar(code) {
  return (
    isAsciiLetter(code) ||
    (code >= 0x30 && code <= 0x39) ||
    code === 0x2D || // -
    code === 0x5F || // _
    code === 0x3A || // :
    code === 0x2E // .
  )
}

/**
 * 返回 `i` 处或其后**最近的** `>` / `"` / `'` 的下标；没有则返回 `-1`。
 *
 * 这是"预建位置索引"的取数侧（建索引见 `buildSpecialIndex`）。语义与
 * `indexOf` 一致：从 `i` 本身开始找，`i` 恰好命中就返回 `i`。
 *
 * **必须二分查找。** `index` 是一个"按出现顺序装满、与字符串等长但只用前
 * `count` 项"的数组，所以 `index` 的下标和它存的位置值**没有任何关系**。
 * 早期版本写成 `for (let k = i; k < count; k += 1)`，把"要找的位置"当成
 * "数组下标"起步——只要 `i` 比 `count` 大就直接返回 `-1`，于是所有标签都
 * 被当成字面文本、整条流水线静默失效。索引内位置严格递增，因此二分即可。
 *
 * @param {number} i 起始位置
 * @param {Float64Array} index 位置数组（前 `count` 项有效、严格递增）
 * @param {number} count `index` 中已填充的元素个数
 * @returns {number}
 */
function nextSpecial(i, index, count) {
  let lo = 0
  let hi = count
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (index[mid] < i) lo = mid + 1
    else hi = mid
  }
  return lo < count ? index[lo] : -1
}

/**
 * 一次性建立 `>` / `"` / `'` 的位置索引（按出现顺序，与 `html` 等长）。
 *
 * ## 为什么需要它
 *
 * 逐标签调用 `indexOf('"')` 在没有引号时会把**整个剩余输入**扫一遍才能
 * 判定"不存在"，于是"每个标签都做几次全量搜索"就变成 O(n²)。索引只在
 * 整个文档上扫一遍，之后每次查询是 O(1) 摊还，整条流水线因此是线性的。
 *
 * 长度上限：`>` 与引号在一份 HTML 里至多各占一半字符，所以一个等长数组
 * 一定装得下；`Float64Array` 可精确表示到 2^53 的整数下标。
 *
 * @param {string} html
 * @returns {{index: Float64Array, count: number}}
 */
function buildSpecialIndex(html) {
  const len = html.length
  const index = new Float64Array(len)
  let count = 0

  for (let i = 0; i < len; i += 1) {
    const code = html.charCodeAt(i)
    if (code === 0x3E /* > */ || code === 0x22 /* " */ || code === 0x27 /* ' */) {
      index[count] = i
      count += 1
    }
  }

  return { index, count }
}

/**
 * 读取 `start` 起的标签名（字母/数字/`-`/`_`/`:`/`.`），返回原名与结束下标。
 *
 * @param {string} html
 * @param {number} start
 * @returns {{name: string, end: number}}
 */
function readTagName(html, start) {
  const len = html.length
  let cursor = start
  while (cursor < len && isTagNameChar(html.charCodeAt(cursor))) cursor += 1
  return { name: html.slice(start, cursor), end: cursor }
}

/**
 * 解析 `start` 处（`html[start] === '<'`）的一个标签。
 *
 * 需要位置索引而不调用 `indexOf`：理由见 `buildSpecialIndex`。
 *
 * 引号感知：`<a href="a>b">` 里属性值内的 `>` 不会提前结束标签。
 * 无法解析成标签（`<` 后面不是名字、找不到 `>`、超过长度上限、
 * 引号一直不闭合）时返回 `null`，由调用方按字面文本处理。
 *
 * @param {string} html
 * @param {number} start
 * @param {{index: Float64Array, count: number}} specials
 * @returns {{name: string, attrs: string, isClose: boolean, selfClosing: boolean, end: number}|null}
 *   `end` 是 `>` 之后的下标
 */
function parseTagAt(html, start, specials) {
  const { index, count } = specials
  const len = html.length
  let cursor = start + 1

  if (cursor >= len) return null

  // 声明/注释/处理指令不是普通标签：`<!DOCTYPE html>`、`<?xml ...?>`
  const marker = html.charCodeAt(cursor)
  if (marker === 0x21 /* ! */ || marker === 0x3F /* ? */) {
    const gt = nextSpecial(cursor, index, count)
    // 索引里的位置天然满足"是 `>`、`"` 或 `'`"三者之一，必须再确认类型。
    if (gt === -1 || html.charCodeAt(gt) !== 0x3E) return null
    return { name: '', attrs: '', isClose: false, selfClosing: false, end: gt + 1 }
  }

  let isClose = false
  if (marker === 0x2F /* / */) {
    isClose = true
    cursor += 1
  }

  // tag name 必须以字母开头；否则 `<` 是字面文本（例如 `a < b`）。
  if (cursor >= len || !isAsciiLetter(html.charCodeAt(cursor))) return null

  const nameInfo = readTagName(html, cursor)
  const attrsStart = nameInfo.end
  cursor = attrsStart

  // 单个标签的长度上限：超过就认为这个 `<` 不是标签。
  // 没有它，"`<a x=\"` 重复十万次"这类输入会让一次扫描走很远，
  // 而外层每次只前进一点，重新退化成 O(n²)。
  const windowEnd = Math.min(len, cursor + MAX_TAG_CHARS)

  // 快路径：属性段里若没有引号，`>` 就是标签结尾，可以直接跳过去，
  // 不必逐字符扫描。普通标签绝大多数走这条路。
  const first = nextSpecial(cursor, index, count)
  if (first !== -1 && html.charCodeAt(first) === 0x3E) {
    if (first >= windowEnd) return null
    return finishTag(html, nameInfo.name, attrsStart, first, isClose)
  }
  if (first === -1) return null

  // 慢路径：属性段里有引号，需要引号状态扫描。
  let quote = 0
  let ok = false
  while (cursor < windowEnd) {
    const code = html.charCodeAt(cursor)
    if (quote !== 0) {
      if (code === quote) quote = 0
      cursor += 1
      continue
    }
    if (code === 0x22 /* " */ || code === 0x27 /* ' */) {
      quote = code
      cursor += 1
      continue
    }
    if (code === 0x3E /* > */) {
      ok = true
      break
    }
    cursor += 1
  }

  // 引号一直不闭合 / 超长：当作字面文本，避免无界扫描。
  if (!ok) return null

  return finishTag(html, nameInfo.name, attrsStart, cursor, isClose)
}

/**
 * 由 `gt`（`>` 的下标）收尾，顺带判断自闭合。
 *
 * @param {string} html
 * @param {string} rawName
 * @param {number} attrsStart
 * @param {number} gt
 * @param {boolean} isClose
 * @returns {{name: string, attrs: string, isClose: boolean, selfClosing: boolean, end: number}}
 */
function finishTag(html, rawName, attrsStart, gt, isClose) {
  let tail = gt - 1
  while (tail >= attrsStart && isHtmlSpace(html.charCodeAt(tail))) tail -= 1
  const selfClosing = tail >= attrsStart && html.charCodeAt(tail) === 0x2F /* / */

  return {
    name: rawName.toLowerCase(),
    attrs: html.slice(attrsStart, gt),
    isClose,
    selfClosing,
    end: gt + 1,
  }
}

/**
 * 从 `from` 起，在 raw-text 元素内部查找自身闭标签的结束位置。
 *
 * **不能**直接 `indexOf('</' + name)`：HTML 标签名大小写不敏感，
 * `<SCRIPT>…</SCRIPT>` 里查找小写的 `</script` 会失败，于是被误判成
 * "未闭合"而丢掉其后整篇正文——这类页面非常常见。
 *
 * 扫描指针**只前进不回头**：每次 `indexOf` 失败后都从 `lt + 2` 继续，
 * 因此整段只被线性扫过一遍。若这里改成"每遇到一个 `<` 就重新搜索"，
 * 在"几千个 `<script` 但没有一个闭标签"的敌意输入上就是 O(n²)。
 *
 * 返回 `>` 之后的下标；找不到返回 `-1`。
 *
 * @param {string} html
 * @param {number} from
 * @param {string} name 已经小写化的标签名
 * @returns {number}
 */
function findClosingTagEnd(html, from, name) {
  const len = html.length
  let cursor = from

  while (cursor < len) {
    const lt = html.indexOf('</', cursor)
    if (lt === -1) return -1

    let index = lt + 2
    let matched = true
    for (let i = 0; i < name.length; i += 1) {
      const at = index + i
      if (at >= len) {
        matched = false
        break
      }
      // 逐字符 ASCII 折叠后比较，标签名只可能是 ASCII。
      const code = html.charCodeAt(at)
      const folded = code >= 0x41 && code <= 0x5A ? code + 0x20 : code
      if (folded !== name.charCodeAt(i)) {
        matched = false
        break
      }
    }

    // 名字必须在这里结束（`</scriptx>` 不算 `</script>`）。
    const after = index + name.length
    if (!matched || (after < len && isTagNameChar(html.charCodeAt(after)))) {
      cursor = lt + 2
      continue
    }

    // 允许 `</script >` 与 `</script foo="bar">` 这类写法。
    const gt = html.indexOf('>', after)
    if (gt === -1) return -1
    return gt + 1
  }

  return -1
}

/**
 * 从 `start` 起只读出标签名本身（不做引号感知、不找 `>`）。
 *
 * 与上面的 `readTagName` **不是**同一个函数，不要合并：那个返回
 * `{name, end}` 且服务于完整的 `parseTagAt`；这个只服务
 * `removeRawTextElements` 里"先看看这是不是 script/style/noscript"
 * 的一次试探，拿到名字就够了，多做的扫描都是浪费。
 *
 * @param {string} html
 * @param {number} start 名字首字符下标
 * @returns {string} 原名（未小写化）
 */
function peekTagName(html, start) {
  const len = html.length
  let cursor = start
  while (cursor < len && isTagNameChar(html.charCodeAt(cursor))) cursor += 1
  return html.slice(start, cursor)
}

/**
 * 去掉 `<script>` / `<style>` / `<noscript>` 及其内容。
 *
 * ## 为什么是"单趟状态机"而不是"逐次搜索闭标签"
 *
 * 输入是**敌意可控**的。若对每个疑似开标签都独立搜索一次闭标签，
 * `'<script'.repeat(40000)` 这类"全是开标签、没有一个闭标签"的输入
 * 会让每次搜索都白扫一遍剩余文本，退化成 O(n²)（实测 4 万次约 26 秒）。
 * 这里改成一次线性扫描：`indexOf` 的游标只前进，无论输入怎么构造，
 * 总工作量都是 O(n)。
 *
 * 未闭合时丢弃到输入末尾——半截脚本的"错误信息"对读者毫无价值，
 * 留下反而会污染文本指纹。
 *
 * 只用数组收集再 `join`，不用 `out += …`：字符串是定长值，反复拼接会让
 * V8 每轮复制已累积内容，同样有退化风险。
 *
 * @param {string} html
 * @returns {string}
 */
function removeRawTextElements(html) {
  const len = html.length
  if (len === 0) return ''

  const specials = buildSpecialIndex(html)
  const pieces = []
  let cursor = 0

  while (cursor < len) {
    const lt = html.indexOf('<', cursor)

    // 没有更多 `<`：剩下的都是普通文本。
    if (lt === -1) {
      pieces.push(html.slice(cursor))
      break
    }

    pieces.push(html.slice(cursor, lt))

    // 大小写不敏感地判断这是不是一个 raw-text 开标签（`<` `/` `!` 三个快筛，
    // 避免为每个普通标签都做一次解析）。
    const first = html.charCodeAt(lt + 1)
    const isNameStart = (first >= 0x41 && first <= 0x5A) || (first >= 0x61 && first <= 0x7A)

    if (isNameStart) {
      const folded = peekTagName(html, lt + 1).toLowerCase()
      if (RAW_TEXT_SKIP.includes(folded)) {
        const tag = parseTagAt(html, lt, specials)
        if (tag !== null) {
          const closeEnd = findClosingTagEnd(html, tag.end, tag.name)
          // 未闭合：丢弃到末尾（这正是"容错"的落点）。
          cursor = closeEnd === -1 ? len : closeEnd
          continue
        }
      }
    }

    // 普通标签或字面 `<`：只推进一个字符，让后续步骤照常处理它。
    pieces.push('<')
    cursor = lt + 1
  }

  return pieces.join('')
}

/**
 * 去掉 HTML 注释 `<!-- ... -->`；未闭合则丢弃到输入末尾。
 *
 * @param {string} html
 * @returns {string}
 */
function removeComments(html) {
  if (html.indexOf('<!--') === -1) return html

  const len = html.length
  const pieces = []
  let cursor = 0

  while (cursor < len) {
    const start = html.indexOf('<!--', cursor)
    if (start === -1) {
      pieces.push(html.slice(cursor))
      break
    }
    pieces.push(html.slice(cursor, start))

    const end = html.indexOf('-->', start + 4)
    if (end === -1) {
      // 未闭合注释：后面全被注释吃掉。
      cursor = len
      break
    }
    cursor = end + 3
  }

  return pieces.join('')
}

/**
 * 把块级标签换成 `\n`。
 *
 * 只对**块级标签**替换；其余标签（`<a>`、`<span>`、`<strong>`…）原样留给
 * `stripTags`，这样行内标签不会制造假换行。
 *
 * @param {string} html
 * @returns {string}
 */
function blockTagsToNewlines(html) {
  if (html.indexOf('<') === -1) return html

  const specials = buildSpecialIndex(html)
  const len = html.length
  const pieces = []
  let cursor = 0

  while (cursor < len) {
    const lt = html.indexOf('<', cursor)
    if (lt === -1) {
      pieces.push(html.slice(cursor))
      break
    }
    pieces.push(html.slice(cursor, lt))

    const tag = parseTagAt(html, lt, specials)
    if (tag === null || tag.name === '') {
      pieces.push('<')
      cursor = lt + 1
      continue
    }

    if (BLOCK_TAGS.has(tag.name)) {
      pieces.push('\n')
    } else {
      pieces.push(html.slice(lt, tag.end))
    }
    cursor = tag.end
  }

  return pieces.join('')
}

/**
 * 移除所有剩余标签。
 *
 * `parseTagAt` 已经带引号状态扫描，因此 `href="a>b"` 不会提前截断。
 * 无法解析成标签的 `<` 按字面文本保留。
 *
 * @param {string} html
 * @returns {string}
 */
function stripTags(html) {
  if (html.indexOf('<') === -1) return html

  const specials = buildSpecialIndex(html)
  const len = html.length
  const pieces = []
  let cursor = 0

  while (cursor < len) {
    const lt = html.indexOf('<', cursor)
    if (lt === -1) {
      pieces.push(html.slice(cursor))
      break
    }
    pieces.push(html.slice(cursor, lt))

    const tag = parseTagAt(html, lt, specials)
    if (tag === null) {
      pieces.push('<')
      cursor = lt + 1
      continue
    }
    cursor = tag.end
  }

  return pieces.join('')
}

/**
 * 清除 NUL 与其余 C0 控制字符，但保留 `\n` 与 `\t`。
 *
 * 这里**不做空白折叠**：折叠属于 `normalize.js`。保留"只清控制字符"这一
 * 最小动作，是为了让 `stripHtmlToText` 的输出仍然能被单独使用。
 *
 * @param {string} text
 * @returns {string}
 */
function stripControlChars(text) {
  let needs = false
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code < 0x20 && code !== 0x0A && code !== 0x09) {
      needs = true
      break
    }
    if (code === 0x7F) {
      needs = true
      break
    }
  }
  if (!needs) return text

  const pieces = []
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    if (code === 0x0A || code === 0x09) {
      pieces.push(text[i])
      continue
    }
    if (code < 0x20 || code === 0x7F) continue
    pieces.push(text[i])
  }
  return pieces.join('')
}

/**
 * 把 HTML 抽成原始文本。
 *
 * 顺序就是"流水线步骤"，每一步都只做一件事：
 *
 *   1. 丢弃 `<script>/<style>/<noscript>` 及其内容（容忍属性、未闭合丢到末尾）
 *   2. 丢弃注释（未闭合丢到末尾）
 *   3. 块级标签 → `\n`
 *   4. 其余标签全删（引号感知，`<` 不闭合当字面量）
 *   5. 文本级解码实体（复用 `entities.js`，不复制实体表）
 *   6. 去掉 NUL 等 C0 控制字符
 *
 * **不做空白归一化**——调用方拿到的可能是连续空行，这是 `normalize.js` 的输入契约。
 *
 * @param {unknown} html
 * @returns {string}
 */
export function stripHtmlToText(html) {
  if (typeof html !== 'string' || html.length === 0) return ''

  let text = removeRawTextElements(html)
  text = removeComments(text)
  text = blockTagsToNewlines(text)
  text = stripTags(text)
  text = decodeEntities(text)
  text = stripControlChars(text)

  return text
}

/**
 * 从属性片段里抽取 `id` / `class` 的取值。
 *
 * 用非回溯的字面量正则：`[\s\S]*?` 之外没有任何嵌套量词，且属性段长度
 * 受单个标签长度限制，不存在对抗性回溯的构造。
 *
 * @param {string} attrs 不含 tag name、以 `>` 结尾的片段
 * @returns {string[]} 形如 `#id` / `.class` 的 token 片段列表
 */
function extractStructureTokens(attrs) {
  const tokens = []
  if (!attrs) return tokens

  const ATTR_RE = /\b(id|class)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]*))/gi
  let match
  while ((match = ATTR_RE.exec(attrs)) !== null) {
    const keyword = match[1].toLowerCase()
    const value = match[3] !== undefined ? match[3] : match[4] !== undefined ? match[4] : match[5] || ''
    if (value === '') continue

    if (keyword === 'id') {
      tokens.push('#' + value)
    } else {
      // class 属性按空白切分；多个类名各自成 token。
      const parts = value.split(/[\s]+/)
      for (const part of parts) {
        if (part !== '') tokens.push('.' + part)
      }
    }
  }
  return tokens
}

/**
 * 计算文档的结构指纹。
 *
 * 语义：按出现顺序为每个标签产出一个 token（`tagname`），闭标签为 `/tagname`，
 * 并为开标签的 `id`/`class` 追加 `#id` / `.class`；`|` 连接 → 把连续 **3 个
 * 及以上完全相同**的 token 压成一个 → 截断到 2000 字符。**不含任何文本内容**，
 * 因此"改了文案"不会让指纹变化，"加了一层 wrapper div"会让指纹变化。
 *
 * 跳过 script/style/noscript 的内容与注释内容：它们不是布局结构。
 *
 * @param {unknown} html
 * @returns {string} 结构指纹，最长 2000 字符
 */
export function htmlStructureFingerprint(html) {
  if (typeof html !== 'string' || html.length === 0) return ''

  const cleaned = removeComments(removeRawTextElements(html))
  const specials = buildSpecialIndex(cleaned)
  const len = cleaned.length
  const tokens = []
  let cursor = 0

  while (cursor < len) {
    const lt = cleaned.indexOf('<', cursor)
    if (lt === -1) break

    const tag = parseTagAt(cleaned, lt, specials)
    if (tag === null) {
      cursor = lt + 1
      continue
    }

    if (tag.name !== '') {
      if (tag.isClose) {
        tokens.push('/' + tag.name)
      } else {
        tokens.push(tag.name)
        const extra = extractStructureTokens(tag.attrs)
        for (const token of extra) tokens.push(token)
      }
    }

    cursor = tag.end
  }

  // 连续 **3 个及以上**相同 token 压成一个；恰好 2 个**不压**（保真）。
  // 压缩的目的是抹掉"几千个相邻 `<br>`"这类噪声，而不是改变局部结构。
  const collapsed = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]
    let run = 1
    while (index + run < tokens.length && tokens[index + run] === token) run += 1

    if (run >= 3) {
      collapsed.push(token)
    } else {
      // run 为 1 或 2：原样保留
      for (let i = 0; i < run; i += 1) collapsed.push(token)
    }
    index += run
  }

  const fingerprint = collapsed.join('|')
  return fingerprint.length > FINGERPRINT_MAX_CHARS
    ? fingerprint.slice(0, FINGERPRINT_MAX_CHARS)
    : fingerprint
}
