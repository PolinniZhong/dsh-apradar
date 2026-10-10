/**
 * 指纹模块的契约测试。
 *
 * 这里的分量压在**交叉验证**上：自己写的 SHA-256 必须逐字节等于
 * `node:crypto`（测试里允许 `node:` 导入，`src/` 里不允许）。
 * 已知答案向量只覆盖几个点，真正的防线是 0..200 每个字节长度——
 * 填充与长度块的所有边界（55/56/64/128/192）都在里面。
 *
 * 运行：`node --test test/fingerprint.test.mjs`
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import {
  contentFingerprint,
  dedupeKey,
  hashId,
  itemFingerprint,
  sha256Hex,
} from '../src/host/fingerprint.js'

const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
const HEX64 = /^[0-9a-f]{64}$/

/** 参照实现。字符串按 UTF-8 编码后哈希，与模块内 `TextEncoder` 的语义对齐。 */
function nodeSha256(input) {
  const bytes = typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 确定性伪随机字符串（ASCII 可打印，每个字符 1 字节）。
 * 不用 `Math.random()`：测试必须每次给出同一份输入。
 */
function pseudoRandomString(length) {
  let state = 0x2545f491
  let out = ''
  for (let i = 0; i < length; i += 1) {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0
    out += String.fromCharCode(32 + (state % 95))
  }
  return out
}

test('已知答案向量（FIPS 180-4 附录 B）', () => {
  assert.equal(sha256Hex(''), EMPTY_SHA256)
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(
    sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),
    '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
  )
  assert.equal(
    sha256Hex('a'.repeat(1000000)),
    'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0',
  )
})

test('0..200 字节与 511/512/513/1000 字节逐一对齐 node:crypto', () => {
  const lengths = []
  for (let i = 0; i <= 200; i += 1) lengths.push(i)
  lengths.push(511, 512, 513, 1000)

  for (const length of lengths) {
    const input = pseudoRandomString(length)
    assert.equal(Buffer.byteLength(input, 'utf8'), length, `输入字节长度应为 ${length}`)
    assert.equal(sha256Hex(input), nodeSha256(input), `长度 ${length} 的哈希不一致`)
  }
})

test('UTF-8 编码与 node:crypto 一致（中文、emoji、混合）', () => {
  const samples = [
    '人工智能产品雷达',
    '🚀',
    'AI 产品雷达 🚀 v0.1.0 —— 关注变化',
    'ｅｍｏｊｉ 与全角 ＡＢＣ',
    '第一行\n第二行 😀',
  ]
  for (const sample of samples) {
    assert.equal(sha256Hex(sample), nodeSha256(sample), `样本 ${JSON.stringify(sample)} 不一致`)
  }
})

test('Uint8Array 输入可用，且与同字节的字符串一致', () => {
  const bytes = new TextEncoder().encode('abc')
  assert.equal(sha256Hex(bytes), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  assert.equal(sha256Hex(bytes), nodeSha256(bytes))

  // 非零 byteOffset 的视图也必须只看它自己那一段。
  const backing = new Uint8Array([0xff, 0xfe, 0x61, 0x62, 0x63, 0xfd])
  const view = new Uint8Array(backing.buffer, 2, 3)
  assert.equal(sha256Hex(view), nodeSha256('abc'))

  // 256 字节全值域，确保 DataView 读取没有符号/端序问题。
  const allBytes = new Uint8Array(256)
  for (let i = 0; i < 256; i += 1) allBytes[i] = i
  assert.equal(sha256Hex(allBytes), nodeSha256(allBytes))
})

test('返回定长小写十六进制', () => {
  for (const input of ['', 'x', pseudoRandomString(300)]) {
    const hex = sha256Hex(input)
    assert.match(hex, HEX64)
    assert.equal(hex, hex.toLowerCase())
  }
})

test('非字符串、非字节数组入参一律当空输入，不抛错', () => {
  for (const bad of [null, undefined, 0, 42, true, {}, [], Symbol('s')]) {
    assert.equal(sha256Hex(bad), EMPTY_SHA256, `入参 ${String(bad)} 应退回空输入`)
  }
})

test('itemFingerprint：标题与正文任一变化都改变指纹，同输入稳定', () => {
  const base = { title: 'GPT-5 发布', text: 'OpenAI 发布了新模型。' }
  const fingerprint = itemFingerprint(base)

  assert.match(fingerprint, HEX64)
  assert.equal(itemFingerprint({ ...base }), fingerprint)
  assert.notEqual(itemFingerprint({ ...base, title: 'GPT-5 正式发布' }), fingerprint)
  assert.notEqual(itemFingerprint({ ...base, text: 'OpenAI 发布了新模型，附基准。' }), fingerprint)

  // 分隔符必须切得开：('ab','c') 不能撞上 ('a','bc')。
  assert.notEqual(itemFingerprint({ title: 'ab', text: 'c' }), itemFingerprint({ title: 'a', text: 'bc' }))
})

test('itemFingerprint：经 canonicalize 后对多余水平空白与 ASCII 大小写不敏感', () => {
  const noisy = { title: '  Hello   World ', text: 'A\tB\t\tC' }
  const clean = { title: 'hello world', text: 'a b c' }
  assert.equal(itemFingerprint(noisy), itemFingerprint(clean))

  // 换行不是水平空白，canonicalize 保留它——不该被折叠掉。
  assert.notEqual(itemFingerprint({ title: 'a b', text: '' }), itemFingerprint({ title: 'a', text: 'b' }))
})

test('itemFingerprint：缺字段/非字符串字段按空处理', () => {
  const empty = itemFingerprint({ title: '', text: '' })
  assert.equal(itemFingerprint(undefined), empty)
  assert.equal(itemFingerprint(null), empty)
  assert.equal(itemFingerprint({}), empty)
  assert.equal(itemFingerprint({ title: 42, text: null }), empty)
})

test('contentFingerprint 直接哈希已归一化文本，不做额外规范化', () => {
  assert.equal(contentFingerprint('abc'), sha256Hex('abc'))
  assert.equal(contentFingerprint('abc'), nodeSha256('abc'))

  // 大小写与空白属于真实内容，必须体现在指纹里。
  assert.notEqual(contentFingerprint('AB'), contentFingerprint('ab'))
  assert.notEqual(contentFingerprint('a  b'), contentFingerprint('a b'))

  assert.equal(contentFingerprint(null), EMPTY_SHA256)
  assert.equal(contentFingerprint(undefined), EMPTY_SHA256)
})

test('dedupeKey：等于 URL 与指纹的拼接哈希，URL 变化即变化', () => {
  const fingerprint = itemFingerprint({ title: 't', text: 'x' })
  const a = dedupeKey({ normalizedUrl: 'https://example.com/a', itemFingerprint: fingerprint })
  const b = dedupeKey({ normalizedUrl: 'https://example.com/b', itemFingerprint: fingerprint })

  assert.match(a, HEX64)
  assert.equal(a, sha256Hex(`https://example.com/a|${fingerprint}`))
  assert.notEqual(a, b)
  // 指纹变化同样要变。
  assert.notEqual(a, dedupeKey({ normalizedUrl: 'https://example.com/a', itemFingerprint: 'other' }))

  assert.equal(dedupeKey(undefined), sha256Hex('|'))
  assert.equal(dedupeKey({ normalizedUrl: 7, itemFingerprint: null }), sha256Hex('|'))
})

test('hashId：形状为 prefix_ + 16 位十六进制，且稳定可复算', () => {
  const id = hashId('chg', 'https://example.com/a|abc')
  assert.match(id, /^chg_[0-9a-f]{16}$/)
  assert.equal(id, hashId('chg', 'https://example.com/a|abc'))
  assert.equal(id, `chg_${sha256Hex('https://example.com/a|abc').slice(0, 16)}`)
  assert.notEqual(id, hashId('chg', 'https://example.com/b|abc'))
  assert.notEqual(id, hashId('item', 'https://example.com/a|abc'))

  assert.equal(hashId(undefined, undefined), `_${EMPTY_SHA256.slice(0, 16)}`)
  assert.match(hashId('', null), /^_[0-9a-f]{16}$/)
})
