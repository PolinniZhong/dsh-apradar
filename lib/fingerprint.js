/**
 * 稳定指纹：条目级、正文级、去重键，以及记录 id 的短哈希。
 *
 * ## 为什么自己写 SHA-256
 *
 * 三条硬约束把标准库的路都堵死了：
 *
 * 1. `crypto.subtle.digest` 是**异步**的，而指纹要在同步流程里当场算出来
 *    （去重、入库、比对都发生在一次遍历中），await 会把整条链路染成异步。
 * 2. `node:crypto` 的 `createHash` 虽然同步，但它是 `node:` 前缀的内建模块，
 *    本插件 `src/` 内只允许相对导入（安全闸门）。
 * 3. 零运行时依赖，不能引第三方哈希库。
 *
 * 所以这里是 FIPS 180-4 的一份最小实现：纯函数、无状态、可重入。
 * 全部用 `Uint32Array` / `DataView`，不产生大临时字符串。
 *
 * @module dsh-apradar/src/host/fingerprint
 */

// 与 `src/host/normalize.js` 同级（同目录的 adapters/ 也是这么引的）。
import { canonicalize } from './normalize.js'

/** SHA-256 轮常数（FIPS 180-4 §4.2.2）：前 64 个素数立方根小数部分的前 32 位。 */
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

/** 初始哈希值（FIPS 180-4 §5.3.3）：前 8 个素数平方根小数部分的前 32 位。 */
const H0 = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
])

/**
 * UTF-8 编码器只建一次：`TextEncoder` 是无状态的，复用省掉每次哈希的构造开销，
 * 也不引入任何可变状态（同一输入永远同一字节序列）。
 */
const encoder = new TextEncoder()

/** 32 位循环右移。`n` 限定在 1..31，避免 `>>> 32` 的 JS 陷阱（位移量按 32 取模）。 */
function rotr(value, n) {
  return ((value >>> n) | (value << (32 - n))) >>> 0
}

/**
 * 把入参归一成字节视图。非字符串、非字节数组一律当空输入——
 * 调用方传 `null`/`undefined` 是常见情形（字段缺失），不该炸。
 *
 * @param {unknown} input
 * @returns {Uint8Array}
 */
function toBytes(input) {
  if (typeof input === 'string') return encoder.encode(input)
  if (input instanceof Uint8Array) return input
  // 其它 TypedArray / DataView：按底层字节看，不做数值转换。
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
  return new Uint8Array(0)
}

/**
 * 同步 SHA-256（FIPS 180-4），输入按 UTF-8 编码。
 *
 * 填充规则是这里最容易错的地方，逐条对上 §5.1.1：
 * 先补一个 `0x80`，再补 `0x00` 到长度 ≡ 56 (mod 64)，最后写 8 字节大端**比特**长度。
 * 因此当 `len % 64` 落在 56..63 时要多占一个整块——`((len + 8) >> 6) + 1`
 * 正好覆盖这一点，包括 `len === 0` 与 `len` 是 64 的整数倍。
 *
 * @param {string | Uint8Array} input
 * @returns {string} 64 位小写十六进制
 */
export function sha256Hex(input) {
  const message = toBytes(input)
  const length = message.length

  // 需要的总块数：最小的满足 blocks*64 >= length + 9 的 blocks。
  const blocks = ((length + 8) >> 6) + 1
  const padded = new Uint8Array(blocks * 64)
  padded.set(message)
  padded[length] = 0x80

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength)
  const bitLength = length * 8
  // 高 32 位用除法取，不能用 >>>（会先把操作数折成 32 位）；低 32 位用 >>> 0 取模。
  view.setUint32(blocks * 64 - 8, Math.floor(bitLength / 0x100000000), false)
  view.setUint32(blocks * 64 - 4, bitLength >>> 0, false)

  const h = new Uint32Array(H0)
  const w = new Uint32Array(64)

  for (let block = 0; block < blocks; block += 1) {
    const offset = block * 64
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false)
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15]
      const y = w[i - 2]
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0
    }

    let a = h[0]
    let b = h[1]
    let c = h[2]
    let d = h[3]
    let e = h[4]
    let f = h[5]
    let g = h[6]
    let hh = h[7]

    for (let i = 0; i < 64; i += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = ((e & f) ^ (~e & g)) >>> 0
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = ((a & b) ^ (a & c) ^ (b & c)) >>> 0
      const t2 = (S0 + maj) >>> 0

      hh = g
      g = f
      f = e
      e = (d + t1) >>> 0
      d = c
      c = b
      b = a
      a = (t1 + t2) >>> 0
    }

    h[0] = (h[0] + a) >>> 0
    h[1] = (h[1] + b) >>> 0
    h[2] = (h[2] + c) >>> 0
    h[3] = (h[3] + d) >>> 0
    h[4] = (h[4] + e) >>> 0
    h[5] = (h[5] + f) >>> 0
    h[6] = (h[6] + g) >>> 0
    h[7] = (h[7] + hh) >>> 0
  }

  let hex = ''
  for (let i = 0; i < 8; i += 1) hex += h[i].toString(16).padStart(8, '0')
  return hex
}

/** 非字符串一律当 `''`。`canonicalize` 自己也防御，但先收口可保住"每个导出都防御"这条约定。 */
function asText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 条目指纹：标题与正文的强规范形式的拼接哈希。
 *
 * 用 `\n` 做分隔符是刻意的：`canonicalize` 保留换行、只折叠水平空白，
 * 所以 `('ab','c')` 与 `('a','bc')` 不会撞在同一串上。
 *
 * @param {{ title?: unknown, text?: unknown }} [input]
 * @returns {string} 64 位小写十六进制
 */
export function itemFingerprint(input) {
  const source = input && typeof input === 'object' ? input : {}
  const title = canonicalize(asText(source.title))
  const text = canonicalize(asText(source.text))
  return sha256Hex(`${title}\n${text}`)
}

/**
 * 正文指纹：直接哈希**已归一化**的正文，不再叠加 `canonicalize`。
 *
 * 调用方（抓取管线）已经用 `normalizeText` 归一过一遍；再折叠一次大小写
 * 会让"仅大小写变化"的真改动被误判为无变化，那是产品层面的错误。
 *
 * @param {unknown} normalizedText
 * @returns {string} 64 位小写十六进制
 */
export function contentFingerprint(normalizedText) {
  return sha256Hex(asText(normalizedText))
}

/**
 * 去重键：归一化 URL 与条目指纹的联合哈希。
 *
 * 只存哈希不存原文，键长度固定，且 URL 与指纹的边界用 `|` 明确切开
 * （`|` 在归一化 URL 里不会出现，指纹又是定长 hex）。
 *
 * @param {{ normalizedUrl?: unknown, itemFingerprint?: unknown }} [input]
 * @returns {string} 64 位小写十六进制
 */
export function dedupeKey(input) {
  const source = input && typeof input === 'object' ? input : {}
  return sha256Hex(`${asText(source.normalizedUrl)}|${asText(source.itemFingerprint)}`)
}

/**
 * 稳定短 id：`${prefix}_${seed 哈希前 16 位}`。
 *
 * 取 16 位十六进制（64 bit）而不是截更短，是为了让同一 feed 里成千上万条
 * 记录的碰撞概率可以忽略；前缀让人一眼看出 id 属于哪类记录。
 *
 * @param {unknown} prefix
 * @param {unknown} seed
 * @returns {string}
 */
export function hashId(prefix, seed) {
  return `${asText(prefix)}_${sha256Hex(asText(seed)).slice(0, 16)}`
}
