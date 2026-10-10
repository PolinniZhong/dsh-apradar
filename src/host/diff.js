/**
 * Host 侧的差异计算：条目级（同一来源前后两轮抓取）与文本级（同一篇正文前后两版）。
 *
 * ## 为什么不调模型
 *
 * "什么变了"必须是可复算、可对账的：同一对输入永远给出同一份结果，
 * 不依赖模型、不依赖时间。模型只负责在**已经确认变化**之后做摘要，
 * 变化判定本身留在纯函数里。
 *
 * ## 为什么 diffText 不是最小差异
 *
 * 经典的 LCS / Myers 在"整篇被替换"的输入上是 O(n·m)，两万行就能把主线程卡死，
 * 而这里要的只是"给人看的变化概览"，不是可应用的补丁。所以：
 *
 * 1. 先剪掉相同的**公共前缀与公共后缀**——小改动落在长文档里时，中段自然塌缩成几行；
 * 2. 中段再用**有界回看**（最多 8 行）重同步；
 * 3. 中段仍然过大就整体放弃重同步，直接判"全删 + 全增"。
 *
 * 代价是重排类改动（同一批行换了顺序）会被报成大改写。这是明知的取舍：
 * 宁可在极少数场景下高估变化，也不让界面在病态输入上卡住。
 *
 * @module dsh-apradar/src/host/diff
 */

/** 三个差异数组各自最多返回多少条；真实总数另由 `*Count` 给出，避免调用方误判规模。 */
export const MAX_DIFF_ITEMS = 200

/** 文本重同步时最多向前看多少行。有界是硬约束：无界会退化成二次复杂度。 */
const TEXT_LOOKAHEAD = 8

/** 剪掉公共前后缀后，中段超过这个行数就放弃重同步。 */
const MAX_MIDDLE_LINES = 20000

/** `addedLines` / `removedLines` 对应的真实计数键。 */
const LINE_COUNT_KEYS = { addedLines: 'addedCount', removedLines: 'removedCount' }

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function asText(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 取出条目 id。空串 id 视为"没有 id"：调用方负责在调用前补好兜底 id，
 * 这里忽略它们，否则所有缺 id 的条目会被误判成同一条。
 */
function idOf(entry) {
  if (!entry || typeof entry !== 'object') return ''
  return typeof entry.itemId === 'string' ? entry.itemId : ''
}

/**
 * 条目级差异。不调模型，不碰网络，纯粹按 id 与指纹判定。
 *
 * 三个数组都按"当前/上一轮输入的原始顺序"排列，保证同一输入永远同一输出，
 * 便于测试与在界面上稳定展示。数组各自截断到 `MAX_DIFF_ITEMS`，
 * 真实总数由 `addedCount` / `removedCount` / `modifiedCount` 给出。
 *
 * `previousItems` 为 `null` / `undefined` 时按空数组处理（首次抓取），
 * 但"这是不是首轮"由调用方判断——本函数不臆造基线信号。
 *
 * @param {Array<object> | null | undefined} previousItems
 * @param {Array<object> | null | undefined} currentItems
 * @returns {{
 *   added: Array<object>,
 *   removed: Array<object>,
 *   modified: Array<{ itemId: string, title: string, previousFingerprint: string, fingerprint: string }>,
 *   addedCount: number,
 *   removedCount: number,
 *   modifiedCount: number,
 *   truncated: boolean,
 * }}
 */
export function diffItems(previousItems, currentItems) {
  const previous = asArray(previousItems)
  const current = asArray(currentItems)

  const previousIds = new Set()
  const previousFingerprintById = new Map()
  for (const entry of previous) {
    const id = idOf(entry)
    if (id === '') continue
    previousIds.add(id)
    // 同 id 重复出现时取**第一条**，与 currentItems 的遍历顺序语义一致。
    if (!previousFingerprintById.has(id)) previousFingerprintById.set(id, asText(entry && entry.fingerprint))
  }

  const currentIds = new Set()
  for (const entry of current) {
    const id = idOf(entry)
    if (id !== '') currentIds.add(id)
  }

  const added = []
  const modified = []
  let addedCount = 0
  let modifiedCount = 0
  for (const entry of current) {
    const id = idOf(entry)
    if (id === '') continue

    if (!previousIds.has(id)) {
      addedCount += 1
      if (added.length < MAX_DIFF_ITEMS) added.push(entry)
      continue
    }

    const fingerprint = asText(entry && entry.fingerprint)
    const previousFingerprint = previousFingerprintById.get(id)
    if (previousFingerprint !== fingerprint) {
      modifiedCount += 1
      if (modified.length < MAX_DIFF_ITEMS) {
        modified.push({
          itemId: id,
          title: asText(entry && entry.title),
          previousFingerprint,
          fingerprint,
        })
      }
    }
  }

  const removed = []
  let removedCount = 0
  for (const entry of previous) {
    const id = idOf(entry)
    if (id === '' || currentIds.has(id)) continue
    removedCount += 1
    if (removed.length < MAX_DIFF_ITEMS) removed.push(entry)
  }

  return {
    added,
    removed,
    modified,
    addedCount,
    removedCount,
    modifiedCount,
    truncated:
      addedCount > MAX_DIFF_ITEMS || removedCount > MAX_DIFF_ITEMS || modifiedCount > MAX_DIFF_ITEMS,
  }
}

/**
 * 按 `\n` 切行。空串当作**零行**而不是 `['']`，否则"上一版为空"会和
 * "上一版只有一个空行"混淆，凭空多出一条删除。
 */
function splitLines(text) {
  const value = asText(text)
  if (value === '') return []
  return value.split('\n')
}

/**
 * 追加若干行，同时维护真实计数；数组本身到 `MAX_DIFF_ITEMS` 就不再增长。
 */
function pushLines(result, key, lines) {
  const countKey = LINE_COUNT_KEYS[key]
  const target = result[key]
  for (const line of lines) {
    result[countKey] += 1
    if (target.length < MAX_DIFF_ITEMS) target.push(line)
  }
}

/**
 * 在最多 `TEXT_LOOKAHEAD` 行内找最小的重同步位移。
 *
 * 返回 `{ removed: k, added: 0 }` 表示上一侧多出的 k 行被删除后可以重新对齐；
 * `{ removed: 0, added: k }` 表示当前侧插入了 k 行。同一 k 下先试"删除"，
 * 保证结果确定。8 行内接不上则返回 `null`，交回调用方按逐行改写处理。
 */
function resync(previous, current, p, c) {
  for (let k = 1; k <= TEXT_LOOKAHEAD; k += 1) {
    if (p + k < previous.length && previous[p + k] === current[c]) return { removed: k, added: 0 }
    if (c + k < current.length && previous[p] === current[c + k]) return { removed: 0, added: k }
  }
  return null
}

/**
 * 双指针走中段：相同就前进；不同就先找重同步点，找不到就按"这一行被改写"记一删一增。
 */
function walkMiddle(previous, current, result) {
  let p = 0
  let c = 0
  while (p < previous.length && c < current.length) {
    if (previous[p] === current[c]) {
      p += 1
      c += 1
      continue
    }

    const shift = resync(previous, current, p, c)
    if (shift === null) {
      pushLines(result, 'removedLines', [previous[p]])
      pushLines(result, 'addedLines', [current[c]])
      p += 1
      c += 1
      continue
    }

    if (shift.removed > 0) pushLines(result, 'removedLines', previous.slice(p, p + shift.removed))
    if (shift.added > 0) pushLines(result, 'addedLines', current.slice(c, c + shift.added))
    p += shift.removed
    c += shift.added
  }

  if (p < previous.length) pushLines(result, 'removedLines', previous.slice(p))
  if (c < current.length) pushLines(result, 'addedLines', current.slice(c))
}

/**
 * 文本级差异：行粒度，返回的是"给人看的变化概览"，不是可应用的补丁。
 *
 * 先剪公共前缀/后缀，再对有界的中段做重同步；中段超过 `MAX_MIDDLE_LINES`
 * 就整体退化成全删 + 全增。`addedCount` / `removedCount` 始终是**截断前**的真实值。
 *
 * @param {unknown} previousText
 * @param {unknown} currentText
 * @returns {{
 *   addedLines: string[],
 *   removedLines: string[],
 *   addedCount: number,
 *   removedCount: number,
 *   truncated: boolean,
 * }}
 */
export function diffText(previousText, currentText) {
  const previous = splitLines(previousText)
  const current = splitLines(currentText)

  // 公共前缀：逐行相同就一起吞掉。
  let head = 0
  const headLimit = Math.min(previous.length, current.length)
  while (head < headLimit && previous[head] === current[head]) head += 1

  // 公共后缀：前缀之后的部分再逐行从尾部吞掉，两侧同时收，避免重叠。
  let previousEnd = previous.length
  let currentEnd = current.length
  while (
    previousEnd > head &&
    currentEnd > head &&
    previous[previousEnd - 1] === current[currentEnd - 1]
  ) {
    previousEnd -= 1
    currentEnd -= 1
  }

  const previousMiddle = previous.slice(head, previousEnd)
  const currentMiddle = current.slice(head, currentEnd)

  const result = {
    addedLines: [],
    removedLines: [],
    addedCount: 0,
    removedCount: 0,
    truncated: false,
  }

  // 病态输入（例如整篇被替换且无一行相同）：放弃重同步，整段当全删 + 全增。
  if (previousMiddle.length > MAX_MIDDLE_LINES || currentMiddle.length > MAX_MIDDLE_LINES) {
    pushLines(result, 'removedLines', previousMiddle)
    pushLines(result, 'addedLines', currentMiddle)
  } else {
    walkMiddle(previousMiddle, currentMiddle, result)
  }

  result.truncated = result.addedCount > MAX_DIFF_ITEMS || result.removedCount > MAX_DIFF_ITEMS
  return result
}
