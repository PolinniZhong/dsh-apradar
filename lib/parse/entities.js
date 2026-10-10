/**
 * HTML/XML 字符引用解码。
 *
 * ## 为什么要自己写
 *
 * 插件零运行时依赖，运行时也没有可用的 DOM/解码器；而且抓到的页面文本必须
 * **可复现**：同一份输入在任何机器、任何 locale 下都要得到逐字节相同的输出。
 * 因此这里只做一张静态表 + 手写扫描，不碰 Intl、不碰随机、不碰时间。
 *
 * ## 三条硬规则
 *
 * 1. **未知引用原样保留**。`&notanentity;` 必须逐字留着——静默吞掉会让
 *    下游的 diff 凭空少一段文本，比解错更糟（无法察觉）。
 * 2. **非法码点原样保留**。代理区 `0xD800`–`0xDFFF` 与超出 `0x10FFFF` 的数值
 *    会产生"破碎字符串"（lone surrogate），后续编码/长度计算都会出错，
 *    所以宁可留着字面量。
 * 3. **单趟解码，不递归**。`&amp;lt;` 必须解成 `&lt;` 而不是 `<`；
 *    扫描指针只前进，绝不回头重扫已产出的文本。
 *
 * @module dsh-apradar/src/host/parse/entities
 */

/**
 * 命名实体表（不含前导 `&` 与结尾 `;`）。
 *
 * 覆盖 XML 五个内建实体 + 常见 HTML 具名实体。值都是**单个码点**，
 * 需要多码点的（如 `hellip` 是 U+2026 单码点，没问题）在这里也按单码点写。
 * 表本身冻结，防止调用方误改造成跨调用污染。
 *
 * 用 `Object.freeze` 的对象而不是 `Map`：查表用 `Object.prototype.hasOwnProperty`
 * 语义的显式判断即可，且对象字面量在模块加载时一次性建好。
 */
export const NAMED_ENTITIES = Object.freeze({
  // XML 五个内建实体
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",

  // 空白与标点
  nbsp: '\u00A0',
  mdash: '\u2014',
  ndash: '\u2013',
  hellip: '\u2026',
  middot: '\u00B7',
  bull: '\u2022',
  lsquo: '\u2018',
  rsquo: '\u2019',
  ldquo: '\u201C',
  rdquo: '\u201D',
  laquo: '\u00AB',
  raquo: '\u00BB',
  sect: '\u00A7',
  para: '\u00B6',
  dagger: '\u2020',
  permil: '\u2030',
  prime: '\u2032',
  Prime: '\u2033',

  // 符号与货币
  copy: '\u00A9',
  reg: '\u00AE',
  trade: '\u2122',
  times: '\u00D7',
  divide: '\u00F7',
  deg: '\u00B0',
  plusmn: '\u00B1',
  frac12: '\u00BD',
  sup2: '\u00B2',
  sup3: '\u00B3',
  euro: '\u20AC',
  pound: '\u00A3',
  yen: '\u00A5',
  cent: '\u00A2',

  // 箭头与关系
  larr: '\u2190',
  rarr: '\u2192',
  harr: '\u2194',
  infin: '\u221E',
  ne: '\u2260',
  le: '\u2264',
  ge: '\u2265',
  asymp: '\u2248',
})

/** 数值引用允许出现在 `&#` 之后的十进制数字。 */
function isDigit(code) {
  return code >= 0x30 && code <= 0x39
}

/** 十六进制数字判定，覆盖大小写。 */
function isHexDigit(code) {
  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  )
}

/**
 * 判断一个码点能否安全地写进 JS 字符串。
 *
 * 代理区码点在 JS 里是合法的"半个字符"，但它不是 Unicode 标量值：
 * 一旦落进输出，`JSON.stringify`、`TextEncoder`、长度统计都会得到意外结果。
 * 超出 `0x10FFFF` 的数值根本不是 Unicode 码点。两者都拒绝。
 */
function isScalarValue(cp) {
  if (!Number.isInteger(cp) || cp < 0) return false
  if (cp >= 0xD800 && cp <= 0xDFFF) return false
  if (cp > 0x10FFFF) return false
  return true
}

/**
 * 解码文本中的 HTML/XML 字符引用。
 *
 * 单趟从前向后扫描：只有真正识别出完整引用时才替换并前移指针，
 * 否则把当前位置的字符原样搬到输出并前移一位。因此不可能递归。
 *
 * @param {unknown} text 待解码文本；非字符串按空串处理
 * @returns {string} 解码结果
 */
export function decodeEntities(text) {
  if (typeof text !== 'string' || text.length === 0) return ''

  // 没有 & 就没有引用，直接返回同一引用，省一次全量拷贝。
  if (text.indexOf('&') === -1) return text

  const parts = []
  let cursor = 0
  let plain = '' // 累积连续的非引用字符，减少数组元素数量

  while (cursor < text.length) {
    const ampIndex = text.indexOf('&', cursor)
    if (ampIndex === -1) {
      plain += text.slice(cursor)
      break
    }

    plain += text.slice(cursor, ampIndex)

    // 找引用的结束分号。分号不能离 & 太远——HTML 具名实体最长 ~32 字符，
    // 这里放宽到 32；找不到就说明这个 & 只是普通文本。
    const semiIndex = text.indexOf(';', ampIndex + 1)

    if (semiIndex === -1 || semiIndex - ampIndex > 40) {
      // 无分号：& 是字面文本，保留并继续。
      plain += '&'
      cursor = ampIndex + 1
      continue
    }

    const body = text.slice(ampIndex + 1, semiIndex)

    // 空 body（`&;`）不是引用。
    if (body.length === 0) {
      plain += '&'
      cursor = ampIndex + 1
      continue
    }

    // ---- 数值引用：`#123` 或 `#x1F600` / `#X1F600` ----
    if (body.charCodeAt(0) === 0x23 /* # */) {
      const digits = body.slice(1)
      const hex = digits.length > 1 && (digits.charCodeAt(0) === 0x78 || digits.charCodeAt(0) === 0x58)
      const numberText = hex ? digits.slice(1) : digits

      let ok = numberText.length > 0
      if (ok) {
        for (let i = 0; i < numberText.length; i += 1) {
          const code = numberText.charCodeAt(i)
          if (hex ? !isHexDigit(code) : !isDigit(code)) {
            ok = false
            break
          }
        }
      }

      if (ok) {
        // parseInt 的基数显式给出，避免任何隐式推断。
        const cp = parseInt(numberText, hex ? 16 : 10)
        if (isScalarValue(cp)) {
          plain += String.fromCodePoint(cp)
          cursor = semiIndex + 1
          continue
        }
      }

      // 非法数值引用：整段原样保留。
      plain += text.slice(ampIndex, semiIndex + 1)
      cursor = semiIndex + 1
      continue
    }

    // ---- 具名引用 ----
    // 用 hasOwnProperty 而不是 `NAMED_ENTITIES[body]`：后者会让 `&constructor;`
    // 之类命中 Object.prototype，产出函数而不是字符。
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) {
      plain += NAMED_ENTITIES[body]
      cursor = semiIndex + 1
      continue
    }

    // 未知具名引用：原样保留。
    plain += text.slice(ampIndex, semiIndex + 1)
    cursor = semiIndex + 1
  }

  parts.push(plain)
  return parts.join('')
}
