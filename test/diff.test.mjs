/**
 * 差异模块的契约测试。
 *
 * 两件事分开验：
 *
 * - `diffItems`：判定只认 id 与指纹，顺序必须确定，截断必须报真实总数；
 * - `diffText`：剪公共前后缀后差异要小，计数要真，病态输入要走兜底而不是卡死。
 *
 * 运行：`node --test test/diff.test.mjs`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { MAX_DIFF_ITEMS, diffItems, diffText } from '../src/host/diff.js'

/** 造一条字段齐全的条目，省得每个用例都写一遍。 */
function entry(itemId, fingerprint, title = itemId) {
  return {
    itemId,
    fingerprint,
    title,
    text: `${itemId}-text`,
    url: `https://example.com/${itemId}`,
    publishedAt: '2025-01-01T00:00:00Z',
  }
}

/** 造 n 行文本，行内容由 `label(i)` 决定。 */
function lines(count, label) {
  const out = []
  for (let i = 0; i < count; i += 1) out.push(label(i))
  return out
}

test('diffItems：纯新增，顺序跟随 currentItems', () => {
  const a = entry('a', 'f1')
  const b = entry('b', 'f1')
  const c = entry('c', 'f1')
  const result = diffItems([a, b], [a, c, b])

  assert.deepEqual(result.added, [c])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.modified, [])
  assert.equal(result.addedCount, 1)
  assert.equal(result.removedCount, 0)
  assert.equal(result.modifiedCount, 0)
  assert.equal(result.truncated, false)
})

test('diffItems：纯删除，顺序跟随 previousItems', () => {
  const a = entry('a', 'f1')
  const b = entry('b', 'f1')
  const c = entry('c', 'f1')
  const result = diffItems([a, b, c], [a])

  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [b, c])
  assert.deepEqual(result.modified, [])
  assert.equal(result.removedCount, 2)
  assert.equal(result.truncated, false)
})

test('diffItems：纯修改，返回前后指纹与当前标题', () => {
  const before = entry('a', 'fp-旧', '旧标题')
  const after = entry('a', 'fp-新', '新标题')
  const result = diffItems([before], [after])

  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.modified, [
    { itemId: 'a', title: '新标题', previousFingerprint: 'fp-旧', fingerprint: 'fp-新' },
  ])
  assert.equal(result.modifiedCount, 1)
  assert.equal(result.truncated, false)
})

test('diffItems：混合场景，三个数组各自按输入顺序排列', () => {
  const previous = [entry('p1', 'f1'), entry('p2', 'f1'), entry('p3', 'f1')]
  const current = [
    entry('n1', 'f1'),
    entry('p1', 'f1'),
    entry('n2', 'f1'),
    entry('p3', 'f2'),
    entry('n3', 'f1'),
  ]
  const result = diffItems(previous, current)

  assert.deepEqual(result.added.map((item) => item.itemId), ['n1', 'n2', 'n3'])
  assert.deepEqual(result.removed.map((item) => item.itemId), ['p2'])
  assert.deepEqual(result.modified, [
    { itemId: 'p3', title: 'p3', previousFingerprint: 'f1', fingerprint: 'f2' },
  ])
  assert.equal(result.addedCount, 3)
  assert.equal(result.removedCount, 1)
  assert.equal(result.modifiedCount, 1)
  assert.equal(result.truncated, false)
})

test('diffItems：previousItems 为 undefined / null → 全部算新增（首轮基线由调用方判断）', () => {
  const current = [entry('a', 'f1'), entry('b', 'f1')]

  for (const previous of [undefined, null]) {
    const result = diffItems(previous, current)
    assert.deepEqual(result.added, current)
    assert.deepEqual(result.removed, [])
    assert.deepEqual(result.modified, [])
    assert.equal(result.addedCount, 2)
    assert.equal(result.truncated, false)
  }

  // 传入非数组垃圾同样按空处理，不抛。
  assert.equal(diffItems({}, 'nope').addedCount, 0)
})

test('diffItems：忽略 itemId 为空串的条目', () => {
  const previous = [entry('', 'f1'), entry('a', 'f1')]
  const current = [entry('', 'f1'), entry('a', 'f2')]
  const result = diffItems(previous, current)

  assert.deepEqual(result.added, [])
  assert.deepEqual(result.removed, [])
  assert.deepEqual(result.modified.map((item) => item.itemId), ['a'])
  assert.equal(result.addedCount, 0)
  assert.equal(result.removedCount, 0)
  assert.equal(result.truncated, false)
})

test('diffItems：指纹缺失按空串比较，不误报修改', () => {
  const previous = [{ itemId: 'a', title: 'a' }]
  const current = [{ itemId: 'a', title: 'a' }]
  assert.equal(diffItems(previous, current).modifiedCount, 0)

  const upgraded = diffItems(previous, [{ itemId: 'a', title: 'a', fingerprint: 'fp' }])
  assert.deepEqual(upgraded.modified, [
    { itemId: 'a', title: 'a', previousFingerprint: '', fingerprint: 'fp' },
  ])
})

test(`diffItems：超过 ${MAX_DIFF_ITEMS} 条时截断，*Count 报真实总数`, () => {
  const total = MAX_DIFF_ITEMS + 50
  const current = []
  for (let i = 0; i < total; i += 1) current.push(entry(`c-${i}`, 'f1'))

  const addedOnly = diffItems(undefined, current)
  assert.equal(addedOnly.addedCount, total)
  assert.equal(addedOnly.added.length, MAX_DIFF_ITEMS)
  assert.equal(addedOnly.added[0].itemId, 'c-0')
  assert.equal(addedOnly.added[MAX_DIFF_ITEMS - 1].itemId, `c-${MAX_DIFF_ITEMS - 1}`)
  assert.equal(addedOnly.truncated, true)

  // 三边同时溢出：新增、删除、修改都要报真数并各自截断。
  const previous = []
  for (let i = 0; i < total; i += 1) previous.push(entry(`p-${i}`, 'f1'))
  // 这些上一轮存在、这一轮消失的条目，专门用来把 removedCount 顶过上限。
  for (let i = 0; i < total; i += 1) previous.push(entry(`x-${i}`, 'f1'))
  for (let i = 0; i < total; i += 1) current.push(entry(`p-${i}`, 'f2'))
  const mixed = diffItems(previous, current)

  assert.equal(mixed.addedCount, total)
  assert.equal(mixed.removedCount, total)
  assert.equal(mixed.modifiedCount, total)
  assert.equal(mixed.added.length, MAX_DIFF_ITEMS)
  assert.equal(mixed.removed.length, MAX_DIFF_ITEMS)
  assert.equal(mixed.modified.length, MAX_DIFF_ITEMS)
  assert.equal(mixed.truncated, true)
})

test('diffItems：恰好等于上限时不标记截断', () => {
  const current = []
  for (let i = 0; i < MAX_DIFF_ITEMS; i += 1) current.push(entry(`c-${i}`, 'f1'))
  const result = diffItems([], current)

  assert.equal(result.addedCount, MAX_DIFF_ITEMS)
  assert.equal(result.added.length, MAX_DIFF_ITEMS)
  assert.equal(result.truncated, false)
})

test('diffText：完全相同 → 无差异', () => {
  const text = lines(50, (i) => `line-${i}`).join('\n')
  const result = diffText(text, text)

  assert.deepEqual(result.addedLines, [])
  assert.deepEqual(result.removedLines, [])
  assert.equal(result.addedCount, 0)
  assert.equal(result.removedCount, 0)
  assert.equal(result.truncated, false)

  assert.deepEqual(diffText('', ''), {
    addedLines: [],
    removedLines: [],
    addedCount: 0,
    removedCount: 0,
    truncated: false,
  })
})

test('diffText：纯追加 → 只有一行新增', () => {
  const result = diffText('a\nb', 'a\nb\nc')
  assert.deepEqual(result.addedLines, ['c'])
  assert.deepEqual(result.removedLines, [])
  assert.equal(result.addedCount, 1)
  assert.equal(result.removedCount, 0)
  assert.equal(result.truncated, false)
})

test('diffText：纯前置 → 只有一行新增', () => {
  const result = diffText('b\nc', 'a\nb\nc')
  assert.deepEqual(result.addedLines, ['a'])
  assert.deepEqual(result.removedLines, [])
  assert.equal(result.addedCount, 1)
  assert.equal(result.truncated, false)
})

test('diffText：1000 行文档中段改一处 → 差异极小', () => {
  const previous = lines(1000, (i) => `line-${i}`)
  const current = previous.slice()
  current[500] = 'line-500-已更新'

  const result = diffText(previous.join('\n'), current.join('\n'))
  assert.ok(result.addedLines.length <= 3, `新增行应极少，实际 ${result.addedLines.length}`)
  assert.ok(result.removedLines.length <= 3, `删除行应极少，实际 ${result.removedLines.length}`)
  assert.deepEqual(result.addedLines, ['line-500-已更新'])
  assert.deepEqual(result.removedLines, ['line-500'])
  assert.equal(result.truncated, false)
})

test('diffText：中段插入时用有界前瞻重同步，不把整段判成改写', () => {
  const result = diffText('A\nB\nC\nD', 'A\nB\nX\nC\nY\nD')
  assert.deepEqual(result.addedLines, ['X', 'Y'])
  assert.deepEqual(result.removedLines, [])
  assert.equal(result.addedCount, 2)
  assert.equal(result.removedCount, 0)
  assert.equal(result.truncated, false)
})

test('diffText：中段删除时同样重同步', () => {
  const result = diffText('A\nB\nX\nC\nY\nD', 'A\nB\nC\nD')
  assert.deepEqual(result.removedLines, ['X', 'Y'])
  assert.deepEqual(result.addedLines, [])
  assert.equal(result.removedCount, 2)
  assert.equal(result.addedCount, 0)
  assert.equal(result.truncated, false)
})

test(`diffText：500 行全改 → 真实计数 500/500，数组各截断到 ${MAX_DIFF_ITEMS}`, () => {
  const previous = lines(500, (i) => `p-${i}`).join('\n')
  const current = lines(500, (i) => `c-${i}`).join('\n')

  const result = diffText(previous, current)
  assert.equal(result.addedCount, 500)
  assert.equal(result.removedCount, 500)
  assert.equal(result.addedLines.length, MAX_DIFF_ITEMS)
  assert.equal(result.removedLines.length, MAX_DIFF_ITEMS)
  assert.equal(result.addedLines[0], 'c-0')
  assert.equal(result.removedLines[0], 'p-0')
  assert.equal(result.truncated, true)
})

test('diffText：上一版为空 → 全部算新增；这一版为空 → 全部算删除', () => {
  for (const previous of ['', undefined, null]) {
    const result = diffText(previous, 'a\nb\nc')
    assert.deepEqual(result.addedLines, ['a', 'b', 'c'])
    assert.equal(result.addedCount, 3)
    assert.equal(result.removedCount, 0)
    assert.equal(result.truncated, false)
  }

  const removed = diffText('a\nb', '')
  assert.deepEqual(removed.removedLines, ['a', 'b'])
  assert.equal(removed.removedCount, 2)
  assert.equal(removed.addedCount, 0)
})

test('diffText：中段超过 20000 行走兜底，整段当全删 + 全增', () => {
  const size = 20001
  const previous = lines(size, (i) => `p-${i}`).join('\n')
  const current = lines(size, (i) => `c-${i}`).join('\n')

  const result = diffText(previous, current)
  assert.equal(result.removedCount, size)
  assert.equal(result.addedCount, size)
  assert.equal(result.removedLines.length, MAX_DIFF_ITEMS)
  assert.equal(result.addedLines.length, MAX_DIFF_ITEMS)
  assert.equal(result.removedLines[0], 'p-0')
  assert.equal(result.addedLines[0], 'c-0')
  assert.equal(result.truncated, true)
})

test('diffText：两万行相同文档里改一行仍然很快且差异极小', () => {
  // 这一条压的是"剪公共前后缀"这一步：中段塌缩后不该走兜底分支。
  const size = 20000
  const previous = lines(size, (i) => `l-${i}`)
  const current = previous.slice()
  current[size - 1] = 'l-end-已更新'

  const result = diffText(previous.join('\n'), current.join('\n'))
  assert.deepEqual(result.addedLines, ['l-end-已更新'])
  assert.deepEqual(result.removedLines, [`l-${size - 1}`])
  assert.equal(result.truncated, false)
})
