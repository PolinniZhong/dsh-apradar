/**
 * 零依赖的「严格子集」XML 解析器 + RSS 2.0 / Atom 1.0 提要提取器。
 *
 * ## 为什么自己写解析器
 *
 * 本插件对运行时依赖是零容忍的（`package.json` 里没有 `dependencies`），而
 * 运行时环境不保证存在任何 XML 实现（`DOMParser` 是 Web 平台的东西，Host
 * 侧没有）。所以这里只实现提要真正用到的那个子集，其余一律**失败关闭**。
 *
 * ## 安全属性：不解析 DTD、不展开自定义实体
 *
 * 这是本模块最重要的设计决定，不是遗漏：
 *
 *   1. `<!DOCTYPE ...>` 连同它的内部子集被当作**不透明 token 整段跳过**，
 *      不做任何解释；`<!ENTITY ...>` 一律解析失败。
 *   2. 因此 `<!ENTITY xxe "PWNED">` 不可能被展开成 `PWNED`：未知实体引用
 *      原样保留为文本（`&xxe;`），而不是去查表。
 *   3. 外部实体（`SYSTEM "file:///..."`）永远不会被读取 —— 本模块是纯函数，
 *      没有任何 IO 能力，这一点由代码边界保证，而不是由黑名单保证。
 *
 * 换句话说：即便提要里带了「十亿笑声」或 XXE 载荷，这里最多只是把它当普通
 * 文本搬来搬去，不会去读文件、不会去发请求、不会做实体递归展开。
 *
 * ## 纯函数
 *
 * 本模块只吃字符串、只吐对象：没有 IO、不看时钟、不用随机数、不依赖 locale。
 * 所有错误以返回值表达（`{ ok: false, code, message }`），不抛异常给调用方。
 *
 * @module dsh-apradar/src/host/parse/xml
 */

/** 解析失败的稳定错误码；与 SDD §7.1 的自有错误码一致。 */
const PARSE_FAILED = 'ADAPTER_PARSE_FAILED'

/**
 * 元素嵌套深度上限。
 * 合法的提要不会超过这个深度，超过的一律判定为恶意或损坏输入，失败关闭，
 * 避免递归把 Host 主线程栈打爆。
 */
const MAX_DEPTH = 64

/** XML 的空白字符：空格、制表、换行、回车。 */
const isSpace = (c) => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d

/** 名字的终止字符：空白或 `> / =`。 */
const isNameEnd = (c) => isSpace(c) || c === 0x3e || c === 0x2f || c === 0x3d

/** 名字的起始字符：拒绝 `<!` `<?` 这类构造以及数字开头。 */
const isNameStart = (c) =>
  (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f || c === 0x3a ||
  (c >= 0xc0 && c <= 0xd6) || (c >= 0xd8 && c <= 0xf6) || (c >= 0xf8 && c <= 0xff) || c > 0xff

/** 名字的后续字符，另接受数字、`-`、`.` 与组合用字符 `·`。 */
const isNameChar = (c) =>
  isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x2d || c === 0x2e || c === 0xb7

/**
 * 命名实体表：XML 内置五个 + 提要里常见的排版符号。
 * 不在这里的名字（包括 DTD 里自定义的）一律不展开，见文件头「安全属性」。
 */
const NAMED_ENTITIES = {
  amp: '&',
  apos: "'",
  bull: '\u2022',
  copy: '\u00a9',
  gt: '>',
  hellip: '\u2026',
  laquo: '\u00ab',
  ldquo: '\u201c',
  lsquo: '\u2018',
  lt: '<',
  mdash: '\u2014',
  middot: '\u00b7',
  nbsp: '\u00a0',
  ndash: '\u2013',
  quot: '"',
  raquo: '\u00bb',
  rdquo: '\u201d',
  reg: '\u00ae',
  rsquo: '\u2019',
  times: '\u00d7',
  trade: '\u2122',
}

/** 月份名 → 1-12。RFC 822 里大小写不敏感，所以查表前统一小写。 */
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

/** 提要及时区缩写 → 分钟偏移。未知缩写按 UTC 处理（见 parseRfc822）。 */
const ZONE_ABBR = {
  gmt: 0, ut: 0, utc: 0, z: 0,
  est: -300, edt: -240,
  cst: -360, cdt: -300,
  mst: -420, mdt: -360,
  pst: -480, pdt: -420,
}

/* ------------------------------------------------------------------ *
 * 字符级扫描
 * ------------------------------------------------------------------ */

/**
 * 从 `i` 起读一个 XML 名字。
 * @param {string} s 源串
 * @param {number} i 起始位置
 * @returns {{ name: string, i: number }} 名字（可能为空串）与结束位置
 */
function readName(s, i) {
  const start = i
  const n = s.length
  if (i < n && isNameStart(s.charCodeAt(i))) {
    i += 1
    while (i < n && isNameChar(s.charCodeAt(i))) i += 1
  }
  return { name: s.slice(start, i), i }
}

/**
 * 判断标签在位置 `gt` 处是否合法结束。
 * 防的是 `>` 出现在属性值里的情形：靠引号计数判断，而不是直接 indexOf('>')。
 * @returns {number} 合法的 `>` 位置；找不到返回 -1
 */
function findTagEnd(s, from) {
  let j = from
  const n = s.length
  let quote = 0
  while (j < n) {
    const c = s.charCodeAt(j)
    if (quote === 0) {
      if (c === 0x22 || c === 0x27) quote = c
      else if (c === 0x3e) return j
    } else if (c === quote) {
      quote = 0
    }
    j += 1
  }
  return -1
}

/* ------------------------------------------------------------------ *
 * 实体解码
 * ------------------------------------------------------------------ */

/**
 * 解码一个实体引用体（`&` 与 `;` 之间的内容）。
 * @returns {string|null} 解码结果；不认识则返回 null（调用方保留原样）
 */
function decodeEntity(body) {
  if (body.length === 0) return null
  if (body.charCodeAt(0) === 0x23) {
    let digits = ''
    let radix = 10
    if (body.charCodeAt(1) === 0x78 || body.charCodeAt(1) === 0x58) {
      digits = body.slice(2)
      radix = 16
      // 十六进制里 e/E 是数字，不能用 parseInt 的宽松解析，先自查字符集
      for (let k = 0; k < digits.length; k += 1) {
        const c = digits.charCodeAt(k)
        const hex = (c >= 0x30 && c <= 0x39) || (c >= 0x61 && c <= 0x66) || (c >= 0x41 && c <= 0x46)
        if (!hex) return null
      }
    } else {
      digits = body.slice(1)
      for (let k = 0; k < digits.length; k += 1) {
        const c = digits.charCodeAt(k)
        if (c < 0x30 || c > 0x39) return null
      }
    }
    if (digits.length === 0) return null
    const code = parseInt(digits, radix)
    // 非法码位与代理区码位不构造字符串，保留原引用更可诊断
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return null
    return String.fromCodePoint(code)
  }
  return Object.hasOwn(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : null
}

/**
 * 解码字符数据里的实体引用。
 * 未知实体（含 DTD 自定义实体、以及单独出现的 `&`）原样保留。
 * @param {string} raw 原始字符数据
 * @returns {string} 解码后的文本
 */
function decodeEntities(raw) {
  if (raw.indexOf('&') < 0) return raw
  let out = ''
  let i = 0
  const n = raw.length
  while (i < n) {
    const amp = raw.indexOf('&', i)
    if (amp < 0) {
      out += raw.slice(i)
      break
    }
    out += raw.slice(i, amp)
    const semi = raw.indexOf(';', amp + 1)
    // 实体引用不会有几百个字符；超出范围说明这是个裸 `&`
    if (semi < 0 || semi - amp > 64) {
      out += '&'
      i = amp + 1
      continue
    }
    const decoded = decodeEntity(raw.slice(amp + 1, semi))
    if (decoded === null) {
      out += raw.slice(amp, semi + 1)
    } else {
      out += decoded
    }
    i = semi + 1
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 节点辅助
 * ------------------------------------------------------------------ */

/**
 * 创建一个元素节点。
 *
 * `name` 是剥掉命名空间前缀后的**本地名**，`raw` 保留限定名。
 * 之所以两个都留：匹配时要同时接受 `<content:encoded>` 与 `<encoded>`，
 * 而 `attrs` 按调用方要求逐字保留。
 */
function makeNode(rawName) {
  const colon = rawName.indexOf(':')
  return {
    name: colon < 0 ? rawName : rawName.slice(colon + 1),
    raw: rawName,
    attrs: {},
    children: [],
    text: '',
  }
}

/**
 * 取节点的全部文本（含后代元素的文本）。
 *
 * `node.text` 只装**直接**字符数据，而 RSS 里 `<description>` 内嵌 HTML、
 * 提要里 `<title>` 可能带子元素都很常见；逐层拼接比一路只读 `.text` 稳。
 * @param {object|null|undefined} node 节点
 * @returns {string} 文本
 */
function nodeText(node) {
  if (!node) return ''
  let out = node.text
  for (const child of node.children) out += nodeText(child)
  return out
}

/**
 * 按名字取第一个直接子元素。同时接受本地名与限定名，因此
 * `childNamed(n, 'encoded')` 与 `childNamed(n, 'content:encoded')` 都成立。
 * @param {object} node 父节点
 * @param {string} name 本地名或限定名
 * @returns {object|null} 子元素或 null
 */
function childNamed(node, name) {
  return node.children.find((child) => child.name === name || child.raw === name) || null
}

/**
 * 按名字取全部直接子元素（RSS 的 `<item>` / Atom 的 `<entry>`）。
 * @param {object} node 父节点
 * @param {string} name 本地名
 * @returns {object[]} 子元素数组
 */
function childrenNamed(node, name) {
  return node.children.filter((child) => child.name === name)
}

/**
 * 按名字取第一个直接子元素的文本，并去掉首尾空白。
 * @returns {string} 文本；不存在则空串
 */
function childText(node, name) {
  return nodeText(childNamed(node, name)).trim()
}

/**
 * 依次取第一个存在的字段文本。
 * @param {object} node 父节点
 * @param {string[]} names 候选名字，按优先级排列
 * @returns {string} 文本；全都不存在则空串
 */
function firstChildText(node, names) {
  for (const name of names) {
    const child = childNamed(node, name)
    if (child) return nodeText(child).trim()
  }
  return ''
}

/**
 * 计算树的最大深度。
 * 递归深度在 `parseNode` 里已经设限，所以这里不会爆栈。
 */
function depthOf(node) {
  let max = 1
  for (const child of node.children) {
    const d = 1 + depthOf(child)
    if (d > max) max = d
  }
  return max
}

/* ------------------------------------------------------------------ *
 * 解析器
 * ------------------------------------------------------------------ */

/** 以 `{ ok: false, code, message }` 表达失败；调用方不需要 try/catch。 */
function fail(message) {
  return { ok: false, code: PARSE_FAILED, message }
}

class Parser {
  /** @param {string} src 原始 XML 文本 */
  constructor(src) {
    // 行首 BOM 对解析是噪音，且会让根元素名带上不可见字符
    this.s = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src
    this.i = 0
    this.n = this.s.length
  }

  /**
   * 跳过 `<? ... ?>`。找不到 `?>` 就报错 —— 这类截断会吞掉后面的标签，
   * 静默跳过可能把畸形文档解析成「恰好少几个元素」的样子。
   */
  readPI() {
    const close = this.s.indexOf('?>', this.i + 2)
    if (close < 0) throw new Error('处理指令 `<?` 未闭合（缺少 `?>`）')
    this.i = close + 2
  }

  /**
   * 跳过 `<!DOCTYPE ...>`（含 `[ ... ]` 内部子集）。
   *
   * 刻意不解析：整段只做括号与引号平衡扫描，然后丢弃。内部子集里的
   * `<!ENTITY ...>` 因此永远不会被登记，也就永远不会被展开。
   */
  readDoctype() {
    let j = this.i + 9
    let inner = 0
    let quote = 0
    while (j < this.n) {
      const c = this.s.charCodeAt(j)
      if (quote !== 0) {
        if (c === quote) quote = 0
        j += 1
        continue
      }
      if (c === 0x5b) inner += 1
      else if (c === 0x5d) inner -= 1
      else if (c === 0x22 || c === 0x27) quote = c
      else if (c === 0x3e && inner <= 0) {
        this.i = j + 1
        return
      }
      j += 1
    }
    throw new Error('`<!DOCTYPE` 未闭合')
  }

  /** 跳过 `<!-- ... -->`。 */
  readComment() {
    const close = this.s.indexOf('-->', this.i + 4)
    if (close < 0) throw new Error('注释 `<!--` 未闭合（缺少 `-->`）')
    this.i = close + 3
  }

  /**
   * 读一个元素的开始标签。
   * @returns {{ node: object, selfClosing: boolean }}
   */
  readOpenTag() {
    let i = this.i + 1
    const open = readName(this.s, i)
    if (open.name.length === 0) throw new Error(`第 ${i} 个字符处：标签名缺失或非法`)
    const node = makeNode(open.name)
    i = open.i
    for (;;) {
      while (i < this.n && isSpace(this.s.charCodeAt(i))) i += 1
      if (i >= this.n) throw new Error(`标签 <${node.raw}> 未闭合`)
      const c = this.s.charCodeAt(i)
      if (c === 0x3e) {
        i += 1
        break
      }
      if (c === 0x2f) {
        // 要求 `/>` 紧邻；`<a / >` 这种畸形写法失败关闭
        if (this.s.charCodeAt(i + 1) !== 0x3e) throw new Error(`标签 <${node.raw}> 的自我闭合写法非法（应为 \`/>\`）`)
        this.i = i + 2
        return { node, selfClosing: true }
      }
      const attr = this.readAttr(i)
      i = attr.i
      const full = attr.name
      if (!Object.hasOwn(node.attrs, full)) node.attrs[full] = attr.value
      // 同时登记去掉前缀的本地名，让调用方既能按 `href` 也能按 `atom:href` 取
      const colon = full.indexOf(':')
      if (colon > 0) {
        const local = full.slice(colon + 1)
        if (!Object.hasOwn(node.attrs, local)) node.attrs[local] = attr.value
      }
    }
    this.i = i
    return { node, selfClosing: false }
  }

  /**
   * 读一个属性（名字 + `=` + 引号值）。
   * XML 要求属性值必须带引号，所以无引号的值直接判错。
   * @returns {{ name: string, value: string, i: number }}
   */
  readAttr(from) {
    let i = from
    const name = readName(this.s, i)
    if (name.name.length === 0) throw new Error(`第 ${i} 个字符处：属性名非法`)
    i = name.i
    while (i < this.n && isSpace(this.s.charCodeAt(i))) i += 1
    if (this.s.charCodeAt(i) !== 0x3d) throw new Error(`属性 ${name.name} 缺少 \`=\``)
    i += 1
    while (i < this.n && isSpace(this.s.charCodeAt(i))) i += 1
    const quote = this.s.charCodeAt(i)
    if (quote !== 0x22 && quote !== 0x27) throw new Error(`属性 ${name.name} 的值必须用引号括起`)
    const end = this.s.indexOf(String.fromCharCode(quote), i + 1)
    if (end < 0) throw new Error(`属性 ${name.name} 的引号未闭合`)
    return { name: name.name, value: decodeEntities(this.s.slice(i + 1, end)), i: end + 1 }
  }

  /**
   * 迭代（非递归）建树。
   *
   * 用显式栈而不是递归，是为了让深度上限成为**可测的**、与引擎栈大小无关的
   * 一条硬线：超过 `MAX_DEPTH` 直接失败，而不是等到爆栈才崩。
   * @returns {{ root: object, maxDepth: number }}
   */
  parse() {
    /** @type {object[]} */
    const stack = []
    let root = null
    let maxDepth = 0

    while (this.i < this.n) {
      const c = this.s.charCodeAt(this.i)

      if (c === 0x3c) {
        const next = this.s.charCodeAt(this.i + 1)

        if (Number.isNaN(next)) throw new Error('文档以孤立的 `<` 结尾')

        if (next === 0x2f) {
          // 结束标签：与栈顶必须是同一个本地名，且不能多也不能少
          const close = readName(this.s, this.i + 2)
          if (close.name.length === 0) throw new Error('结束标签缺少标签名')
          let j = close.i
          while (j < this.n && isSpace(this.s.charCodeAt(j))) j += 1
          if (this.s.charCodeAt(j) !== 0x3e) throw new Error(`结束标签 </${close.name}> 未正确闭合`)
          const top = stack.pop()
          if (!top) throw new Error(`多余的结束标签 </${close.name}>`)
          const local = close.name.indexOf(':') < 0 ? close.name : close.name.slice(close.name.indexOf(':') + 1)
          if (top.name !== local) throw new Error(`标签不匹配：<${top.raw}> 被 </${close.name}> 关闭`)
          this.i = j + 1
          continue
        }

        if (next === 0x3f) {
          this.readPI()
          continue
        }

        if (next === 0x21) {
          if (this.s.startsWith('<!--', this.i)) {
            this.readComment()
            continue
          }
          if (this.s.startsWith('<![CDATA[', this.i)) {
            if (!stack.length) throw new Error('CDATA 出现在根元素之外')
            const close = this.s.indexOf(']]>', this.i + 9)
            if (close < 0) throw new Error('CDATA 段未闭合（缺少 `]]>`）')
            // CDATA 内容逐字保留，不做实体解码
            stack[stack.length - 1].text += this.s.slice(this.i + 9, close)
            this.i = close + 3
            continue
          }
          if (this.s.startsWith('<!DOCTYPE', this.i)) {
            this.readDoctype()
            continue
          }
          throw new Error('解析失败：不支持 DTD 与实体声明（本解析器刻意不处理 `<!DOCTYPE` 内部子集与 `<!ENTITY`）')
        }

        if (stack.length >= MAX_DEPTH) {
          throw new Error(`XML 嵌套深度超过上限 ${MAX_DEPTH}`)
        }
        const tag = this.readOpenTag()
        if (!stack.length) {
          if (root) throw new Error('文档存在第二个根元素')
          root = tag.node
        } else {
          stack[stack.length - 1].children.push(tag.node)
        }
        if (!tag.selfClosing) {
          stack.push(tag.node)
          if (stack.length > maxDepth) maxDepth = stack.length
        }
        continue
      }

      // 字符数据：直接归属当前栈顶元素，根元素之外的非空白才判错
      const nextTag = this.s.indexOf('<', this.i)
      const end = nextTag < 0 ? this.n : nextTag
      const raw = this.s.slice(this.i, end)
      if (stack.length) {
        stack[stack.length - 1].text += decodeEntities(raw)
      } else if (raw.trim() !== '') {
        throw new Error('根元素之外存在文本内容')
      }
      this.i = end
    }

    if (stack.length) throw new Error(`标签未闭合：<${stack[stack.length - 1].raw}>`)
    if (!root) throw new Error('文档中没有根元素')
    return { root, maxDepth }
  }
}

/**
 * 解析严格子集内的 XML 文档。
 *
 * @param {string} source XML 文本
 * @returns {{ ok: true, root: object } | { ok: false, code: string, message: string }}
 *   `root` 为 `{ name, raw, attrs, children, text }`：`name` 是剥前缀的本地名，
 *   `raw` 是限定名，`attrs` 按出现顺序逐字保留，`text` 只含直接字符数据。
 *
 * @example
 * parseXmlSubset('<a><b>1</b></a>').root.children[0].text // '1'
 */
export function parseXmlSubset(source) {
  if (typeof source !== 'string') return fail('解析失败：输入不是字符串')
  try {
    const parsed = new Parser(source).parse()
    return { ok: true, root: parsed.root }
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error))
  }
}

/* ------------------------------------------------------------------ *
 * 时间解析
 * ------------------------------------------------------------------ */

/**
 * 由「明确的 UTC 各字段」构造 epoch 毫秒。
 *
 * 刻意不用 `new Date(string)`：各引擎对非标准日期串的宽容度不一样，
 * 同一份提要在不同运行时可能得到不同结果，而本插件要做变化比对。
 *
 * @returns {number|null} 合法则返回 epoch 毫秒，字段非法则 null
 */
function makeUtc(year, month, day, hour, minute, second) {
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  if (!Number.isInteger(day) || day < 1 || day > 31) return null
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59 || second < 0 || second > 60) return null
  const ms = Date.UTC(year, month - 1, day, hour, minute, second)
  // Date.UTC 会把 2 月 30 日滚到 3 月，用回读校验拒绝这种「假日期」
  const back = new Date(ms)
  if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) return null
  return ms
}

/**
 * 解析 RFC 822 / RFC 1123 时间串。
 * 形如 `Tue, 03 Jun 2008 11:05:30 GMT`、`03 Jun 2008 11:05:30 +0200`、`3 Jun 08 11:05 GMT`。
 * @param {string} s 已去空白的输入
 * @returns {number|null} epoch 毫秒或 null
 */
function parseRfc822(s) {
  let body = s
  // 工作日是冗余信息，直接剥掉
  const comma = body.indexOf(',')
  if (comma >= 0) body = body.slice(comma + 1).trim()

  const matched = /^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s+([A-Za-z]{1,5}|[+-]\d{4}))?$/.exec(body)
  if (!matched) return null

  const day = Number(matched[1])
  const month = MONTHS[matched[2].toLowerCase()]
  if (month === undefined) return null
  let year = Number(matched[3])
  // RFC 822 的两位年份：00-49 归 2000 年代，50-99 归 1900 年代
  if (matched[3].length === 2) year += year < 50 ? 2000 : 1900

  const hour = Number(matched[4])
  const minute = Number(matched[5])
  const second = matched[6] === undefined ? 0 : Number(matched[6])

  let offset = 0
  const zone = matched[7]
  if (zone !== undefined) {
    if (zone.charCodeAt(0) === 0x2b || zone.charCodeAt(0) === 0x2d) {
      const sign = zone.charCodeAt(0) === 0x2d ? -1 : 1
      offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)))
    } else {
      // RFC 822 允许字母时区；表内未收录的按 UTC 处理（保守，不猜偏移）
      offset = ZONE_ABBR[zone.toLowerCase()] ?? 0
    }
  }

  const ms = makeUtc(year, month, day, hour, minute, second)
  return ms === null ? null : ms - offset * 60_000
}

/**
 * 解析 RFC 3339 / ISO 8601 时间串。
 * 支持 `2008-06-03T11:05:30Z`、`2008-06-03T11:05:30.123+02:00`、`2008-06-03`。
 * @param {string} s 已去空白的输入
 * @returns {number|null} epoch 毫秒或 null
 */
function parseRfc3339(s) {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (dateOnly) {
    const ms = makeUtc(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]), 0, 0, 0)
    return ms === null ? null : ms
  }

  const matched = /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|z|[+-]\d{2}:\d{2})?$/.exec(s)
  if (!matched) return null

  const second = matched[6] === undefined ? 0 : Number(matched[6])
  const ms = makeUtc(Number(matched[1]), Number(matched[2]), Number(matched[3]), Number(matched[4]), Number(matched[5]), second)
  if (ms === null) return null

  // 小数秒只影响毫秒位，用前三位补零
  let base = ms
  if (matched[7] !== undefined) {
    const padded = (matched[7] + '000').slice(0, 3)
    base += Number(padded)
  }

  const zone = matched[8]
  let offset = 0
  if (zone !== undefined && zone !== 'Z' && zone !== 'z') {
    const sign = zone.charCodeAt(0) === 0x2d ? -1 : 1
    offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(4, 6)))
  }
  return base - offset * 60_000
}

/**
 * 解析提要里的时间串，返回 epoch 毫秒。
 *
 * 两种格式都覆盖：RFC 822 / RFC 1123（`pubDate`）与 RFC 3339 / ISO 8601
 * （`updated` / `published` / `dc:date`）。**解析不了就返回 null，绝不猜测** ——
 * 猜错时间会让「这条是不是新的」直接判断错。
 *
 * @param {string} input 时间串
 * @returns {number|null} epoch 毫秒；无法解析时为 null
 *
 * @example
 * toEpochMs('Tue, 03 Jun 2008 11:05:30 GMT') // 1212491130000
 */
export function toEpochMs(input) {
  if (typeof input !== 'string') return null
  const s = input.trim()
  if (s === '') return null
  return parseRfc3339(s) ?? parseRfc822(s)
}

/* ------------------------------------------------------------------ *
 * 提要提取
 * ------------------------------------------------------------------ */

/**
 * Atom 条目的链接选择：优先 `rel="alternate"`，否则取第一个带 `href` 的 `<link>`。
 * 缺 `rel` 时按 Atom 规范默认视为 `alternate`。
 * @param {object} entry Atom `<entry>` 节点
 * @returns {string|null} URL 或 null
 */
function pickAtomLink(entry) {
  const links = childrenNamed(entry, 'link')
  let fallback = null
  for (const link of links) {
    const href = link.attrs.href
    if (typeof href !== 'string' || href === '') continue
    const rel = typeof link.attrs.rel === 'string' ? link.attrs.rel : 'alternate'
    if (rel === 'alternate') return href
    if (fallback === null) fallback = href
  }
  return fallback
}

/**
 * 把 RSS `<item>` 归一化成统一条目形状。
 * @param {object} item RSS item 节点
 */
function readRssItem(item) {
  const raw = firstChildText(item, ['encoded', 'content:encoded', 'description', 'summary'])
  const date = firstChildText(item, ['pubDate', 'published', 'updated', 'date', 'dc:date'])
  const link = childText(item, 'link')
  return {
    // `guid` 的 isPermaLink 与身份无关：这里只取文本，缺失交给调用方做内容指纹
    itemId: childText(item, 'guid'),
    title: childText(item, 'title'),
    publishedAt: toEpochMs(date),
    // 正文**不在这一步剥 HTML**，保留原始串供页面展示与后续指纹计算
    text: raw !== '' ? raw : childText(item, 'title'),
    url: link !== '' ? link : null,
  }
}

/**
 * 把 Atom `<entry>` 归一化成统一条目形状。
 * @param {object} entry Atom entry 节点
 */
function readAtomItem(entry) {
  const raw = firstChildText(entry, ['content', 'summary', 'encoded'])
  const date = firstChildText(entry, ['updated', 'published', 'issued', 'date', 'dc:date'])
  return {
    itemId: childText(entry, 'id'),
    title: childText(entry, 'title'),
    publishedAt: toEpochMs(date),
    text: raw !== '' ? raw : childText(entry, 'title'),
    url: pickAtomLink(entry),
  }
}

/**
 * 解析 RSS 2.0 / Atom 1.0 提要。
 *
 * 空的提要（`<rss><channel></channel></rss>`）是**合法结果**而不是错误：
 * 「这个源暂时没有条目」与「这份文档不是提要」必须区分开，否则调用方会把
 * 前者记成解析失败。文档是 XML 但既不是 RSS 也不是 Atom 才返回失败。
 *
 * @param {string} source 提要文本
 * @returns {{ ok: true, kind: 'rss'|'atom', title: string, items: object[] }
 *   | { ok: false, code: string, message: string }}
 *
 * @example
 * parseFeed('<rss><channel></channel></rss>').items // []
 */
export function parseFeed(source) {
  const parsed = parseXmlSubset(source)
  if (!parsed.ok) return parsed

  const root = parsed.root
  if (root.name === 'rss') {
    const channel = childNamed(root, 'channel')
    if (!channel) return fail('RSS 文档缺少 `<channel>` 元素')
    return {
      ok: true,
      kind: 'rss',
      title: childText(channel, 'title'),
      items: childrenNamed(channel, 'item').map(readRssItem),
    }
  }

  if (root.name === 'feed') {
    return {
      ok: true,
      kind: 'atom',
      title: childText(root, 'title'),
      items: childrenNamed(root, 'entry').map(readAtomItem),
    }
  }

  return fail('不是受支持的 RSS 2.0 或 Atom 1.0 文档')
}

/**
 * 解析结果里出现的最大元素深度（根元素记为 1）。
 *
 * 多数提要深度在 5 层以内（`rss > channel > item > description`）；
 * 明显更深的值得被调用方记录下来当作来源质量的信号。
 *
 * @param {object} root `parseXmlSubset` 返回的根节点
 * @returns {number} 最大深度
 */
export function xmlDepth(root) {
  return depthOf(root)
}
