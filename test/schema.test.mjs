/**
 * 结构校验器的契约测试。
 *
 * 这些契约不是"我们觉得应该这样"，而是 `@deepseek-ai/dsh-storage-domain` 的
 * 调用点要求的（见 `src/host/store/schema.js` 顶部逐行引用的三个调用点）：
 * `parse` 失败要抛、`safeParse` 永不抛、对象要丢未声明键、global schema 要拒绝 `null`。
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SchemaError,
  array,
  boolean,
  count,
  enumerate,
  literal,
  number,
  object,
  optional,
  string,
  withDefault,
} from '../src/host/store/schema.js'

test('string / number / count / boolean：类型判定与报错信息', () => {
  assert.equal(string().parse('x'), 'x')
  assert.throws(() => string().parse(1), SchemaError)

  assert.equal(number().parse(1.5), 1.5)
  assert.throws(() => number().parse(Number.NaN), SchemaError, 'NaN 无法 JSON 往返，必须拒绝')
  assert.throws(() => number().parse(Number.POSITIVE_INFINITY), SchemaError)
  assert.throws(() => number().parse('1'), SchemaError)

  assert.equal(count().parse(0), 0)
  assert.throws(() => count().parse(-1), SchemaError)
  assert.throws(() => count().parse(1.5), SchemaError, 'count 是非负整数')

  assert.equal(boolean().parse(false), false)
  assert.throws(() => boolean().parse('true'), SchemaError, '不得做字符串到布尔的隐式转换')
})

test('literal / enumerate：只接受列出的取值', () => {
  assert.equal(literal('a').parse('a'), 'a')
  assert.throws(() => literal('a').parse('b'), SchemaError)

  const type = enumerate(['rss_atom', 'github_releases'])
  assert.equal(type.parse('rss_atom'), 'rss_atom')
  assert.throws(() => type.parse('html'), SchemaError)
  assert.throws(() => type.parse(undefined), SchemaError)
})

test('safeParse：永不抛错，失败时给出 SchemaError', () => {
  const ok = string().safeParse('x')
  assert.deepEqual(ok, { success: true, data: 'x' })

  const bad = string().safeParse(3)
  assert.equal(bad.success, false)
  assert.ok(bad.error instanceof SchemaError)
  assert.equal(bad.error.issues.length, 1)

  // 连明显的越界输入也不能抛
  assert.equal(object({ a: string() }).safeParse(null).success, false)
  assert.equal(array(string()).safeParse('nope').success, false)
})

test('object：丢弃未声明的键（与 zod 默认一致），保证往返稳定', () => {
  const schema = object({ a: string(), b: count() })
  const parsed = schema.parse({ a: 'x', b: 1, extra: 'drop-me' })
  assert.deepEqual(parsed, { a: 'x', b: 1 })
  assert.deepEqual(Object.keys(parsed), ['a', 'b'])
})

test('object：字段级失败要指出字段名', () => {
  const schema = object({ a: string(), b: count() })
  const result = schema.safeParse({ a: 'x', b: 'not-a-number' })
  assert.equal(result.success, false)
  assert.match(result.error.message, /field 'b' invalid/)
  assert.throws(() => schema.parse({ a: 1, b: 0 }), /field 'a' invalid/)
})

test('optional 与 withDefault：缺失可接受、null 不接受', () => {
  const opt = optional(string())
  assert.equal(opt.parse(undefined), undefined)
  assert.equal(opt.parse('x'), 'x')
  assert.throws(() => opt.parse(null), SchemaError, 'null 与"从未写过"语义冲突，必须拒绝')

  const def = withDefault(count(), 0)
  assert.equal(def.parse(undefined), 0)
  assert.equal(def.parse(7), 7)
  assert.throws(() => def.parse(null), SchemaError)
})

test('withDefault：默认值不可被调用方原地污染', () => {
  const schema = withDefault(array(string()), [])
  const first = schema.parse(undefined)
  first.push('污染')
  assert.deepEqual(schema.parse(undefined), [], '每次都要给出独立的默认值')
})

test('嵌套结构：数组元素失败要带下标', () => {
  const schema = array(count())
  assert.deepEqual(schema.parse([1, 2, 3]), [1, 2, 3])
  const result = schema.safeParse([1, 'x'])
  assert.equal(result.success, false)
  assert.match(result.error.message, /item 1 invalid/)
})

// ---------------------------------------------------------------- P1-02 快照保留等级

test('retentionOf：优先读显式字段，旧记录按长度回退推断', async () => {
  const { retentionOf, MAX_OLD_SNAPSHOT_CHARS, MAX_NORMALIZED_TEXT_CHARS } = await import('../src/host/limits.js')

  // 显式字段优先：即便长度看起来像全文，写了 excerpt 就是 excerpt。
  assert.equal(retentionOf({ retention: 'excerpt', textChars: MAX_NORMALIZED_TEXT_CHARS, textTruncated: true }), 'excerpt')
  assert.equal(retentionOf({ retention: 'full', textChars: 10, textTruncated: false }), 'full')

  // 旧记录（没有 retention 字段）的回退：短且标记截断 → 是被裁剪成摘录。
  assert.equal(retentionOf({ textChars: MAX_OLD_SNAPSHOT_CHARS, textTruncated: true }), 'excerpt')
  assert.equal(retentionOf({ textChars: 120, textTruncated: true }), 'excerpt')
  // 长且标记截断 → 是规范化阶段正文超长，不是我们少留了东西。
  assert.equal(retentionOf({ textChars: MAX_NORMALIZED_TEXT_CHARS, textTruncated: true }), 'full')
  // 没截断就是全文。
  assert.equal(retentionOf({ textChars: 999, textTruncated: false }), 'full')
  assert.equal(retentionOf({}), 'full')
  assert.equal(retentionOf(null), 'full')
})
