/**
 * 机会池的 Markdown 导出（P1-05）。
 *
 * ## 这个文件只做一件事：把已经有的事实**照原样**排成 Markdown
 *
 * 它不抓取、不调用模型、不改写任何文字。用户判断（`judgment` / `questions` /
 * `nextAction`）与抓取到的事实（变化、快照、来源）在输出里被**分成两个区**，
 * 永远不混在一起 —— 一份带出去的笔记如果分不清"我看到的"和"我猜的"，
 * 它就是在制造虚假的确定性。
 *
 * ## 分区规则（不是文案技巧，是数据来源）
 *
 * - **事实** 只能来自 `changes` / `snapshots` / `sources` 三张表的记录。
 *   这些记录全部由真实抓取写入，没有任何一条来自模型。
 * - **推测与判断** 只能来自用户自己写的字段。
 * - 一边为空时**明说为空**，不留一个空标题让人误以为"没有异常"：
 *   没关联变化就说没关联，没写判断就说还没写。
 *
 * ## 这份文件会被贴到别处，所以内容按"不可信"处理
 *
 * 导出的 Markdown 会被粘进别人的笔记或仓库，而里面既有使用者写的自由文本，也有
 * **从公网抓回来的原文摘录**。两者都可能包含 Markdown 控制字符。因此：
 * ① 非 `http(s)` 的 URI 方案会被拆掉（`javascript:` → `javascript：`）；
 * ② 能构成**链接、自动链接、代码段或原始 HTML** 的字符（`[ ] < > \``）被转义。
 * 强调标记（`*` `_`）刻意**不**转义：它们最多改变外观，而到处加反斜杠会让
 * 源文件不可读 —— 安全处理不应该以牺牲可读性来表达"我很小心"。
 *
 * @module dsh-apradar/src/host/export
 */

/** 变化类型 → 中文。导出里也用人话，理由和界面一样：这是给人读的文件。 */
const KIND_LABEL = {
  added: '新增',
  removed: '移除',
  modified: '修改',
  summary: '汇总',
}

/** 机会状态 → 中文。 */
const STATUS_LABEL = {
  to_research: '待研究',
  researching: '研究中',
  validated: '已验证',
  dropped: '已放弃',
}

/** Markdown 正文里不允许出现的控制字符（除换行与制表符外）。 */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g

/**
 * 把任意文本压成**一行**，用于标题与列表项。
 *
 * 用户写的东西可能带换行也可能带 `#`/`-` 这类会改变 Markdown 块结构的字符。
 * 标题与列表项里只允许单行，所以这里先把换行统一成空格，再让出标题与
 * 列表项的前缀去承担结构 —— 内容永远在冒号或项目符号之后，不可能"越狱"
 * 变成新的标题。
 *
 * @param {unknown} value 任意值
 * @returns {string} 单行纯文本
 */
export function inline(value) {
  return String(value ?? '')
    .replace(CONTROL_CHARS, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 需要反斜杠转义的字符：能构成链接、自动链接、代码段或原始 HTML。 */
const MARKDOWN_ESCAPE = /[\[\]<>\`]/g

/**
 * 把非 `http(s)` 的 URI 方案拆掉。
 *
 * `javascript:alert(1)` 在 Markdown 里作为纯文本并不会被点开，但只要它出现在
 * `[文字](这里)` 或 `<这里>` 的位置就会变成可点击的陷阱。安全做法不是"记得别
 * 那么写"，而是**让它不可能是一个合法 URI**：把半角冒号换成全角冒号。
 * 只处理"方案 + 冒号 + 非空白"的形状，`Releases: v1` 这类正常英文冒号
 * （冒号后紧跟空格）不受影响。
 *
 * @param {string} text 已压成单行的文本
 * @returns {string} 方案被拆掉的文本
 */
export function neutralizeSchemes(text) {
  return String(text ?? '').replace(/([A-Za-z][A-Za-z0-9+.-]*):(?=\S)/g, (match, scheme) => {
    const lower = scheme.toLowerCase()
    return lower === 'http' || lower === 'https' || lower === 'mailto' ? match : `${scheme}：`
  })
}

/**
 * 把任意文本处理成**可以安全内联进正文**的单行文本。
 *
 * 依次做三件事：压成一行 → 拆掉非 http(s) 方案 → 转义 Markdown 控制字符。
 * 标题、判断、摘要、来源名等一切"贴进正文的文字"都必须过这一步，因为其中一部分
 * 是公网抓回来的，我们不能假设它没有恶意。
 *
 * @param {unknown} value 任意值
 * @returns {string} 可安全内联的文本
 */
export function safeInline(value) {
  return neutralizeSchemes(inline(value)).replace(MARKDOWN_ESCAPE, '\\$&')
}

/**
 * 把长文本排成 Markdown 引用块。
 *
 * 引用块是这里唯一合适的选择：原文摘录可能包含 `#`、`-`、`|`，直接贴进正文会
 * 变成标题、列表或表格，把导出的结构搞坏；每行前面加 `> ` 之后，Markdown 只会
 * 把它当引用文字。
 *
 * @param {unknown} value 长文本
 * @param {number} [maxLines] 最多保留多少行（超出时注明省略）
 * @returns {string[]} 每行一条（含 `> ` 前缀），空文本返回空数组
 */
export function quoted(value, maxLines = 40) {
  const text = String(value ?? '').replace(CONTROL_CHARS, '').replace(/\r\n?/g, '\n')
  const lines = text
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
    .filter((line, index, arr) => !(line === '' && (index === 0 || index === arr.length - 1 || arr[index - 1] === '')))
  const kept = lines.slice(0, maxLines)
  // 摘录来自公网，按不可信内容处理：同样要拆方案、转义链接语法。
  const out = kept.map((line) => (line === '' ? '>' : `> ${safeInline(line)}`))
  if (lines.length > maxLines) out.push(`> …（原文还有 ${lines.length - maxLines} 行，此处省略；完整内容见上面的条目链接）`)
  return out
}

/**
 * 校验一个字符串是不是可以直接写进 Markdown 链接目标的 URL。
 *
 * 只接受 `http:` / `https:`。其它协议（尤其是 `javascript:`）不能进导出的文件 ——
 * 这份文件会被贴进别人的笔记或仓库，一个可点击的 `javascript:` 就是个陷阱。
 *
 * @param {unknown} value 候选地址
 * @returns {string|null} 可用则返回原字符串，否则 null
 */
export function safeUrl(value) {
  const text = inline(value)
  if (text === '') return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return text
  } catch {
    return null
  }
}

/**
 * 按本地时区把毫秒时间戳排成人话。
 *
 * 导出文件是给人读的，所以用本地时间并**标出时区偏移** —— 只写 `23:10` 而不写
 * 是哪个时区的 `23:10`，跨时区看这份文件的人会得出错误的时序。
 *
 * @param {unknown} value epoch 毫秒
 * @returns {string} `YYYY-MM-DD HH:mm`，或 `null`
 */
export function formatTime(value) {
  const ms = typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  if (ms === null) return null
  const date = new Date(ms)
  if (Number.isNaN(date.getTime())) return null
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/**
 * 时区偏移文字，例如 `UTC+08:00`。
 *
 * @param {Date} date 取偏移的基准时刻
 * @returns {string} 形如 `UTC+08:00`
 */
export function timeZoneLabel(date) {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes < 0 ? '-' : '+'
  const abs = Math.abs(minutes)
  return `UTC${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/**
 * 导出文件名。
 *
 * 用 id 而不是标题：标题可能含 `/`、空格、emoji 甚至换行，拼进文件名在不同
 * 系统上会得到不同结果（或直接失败）。id 的字符集是 `[A-Za-z0-9_-]`。
 *
 * @param {Array<{id: string}>} opportunities 本次导出的机会
 * @param {Date} at 导出时刻
 * @returns {string} 文件名（不含目录）
 */
export function exportFilename(opportunities, at) {
  if (opportunities.length === 1) return `ai-product-radar-${opportunities[0].id}.md`
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-${pad(at.getHours())}${pad(at.getMinutes())}`
  return `ai-product-radar-opportunities-${stamp}.md`
}

/**
 * 把一批机会渲染成 Markdown。
 *
 * @param {object} input 输入
 * @param {Array<object>} input.opportunities 机会记录
 * @param {Array<object>} input.changes 全部变化记录（用于回溯证据链）
 * @param {Array<object>} input.sources 全部来源记录
 * @param {Array<object>} input.snapshots 全部快照记录
 * @param {Date} input.now 导出时刻
 * @returns {{markdown: string, filename: string, count: number}} 渲染结果
 */
export function renderOpportunitiesMarkdown({ opportunities, changes, sources, snapshots, now }) {
  const at = now instanceof Date && !Number.isNaN(now.getTime()) ? now : new Date()
  const byId = (rows, id) => (id ? (rows ?? []).find((row) => row?.id === id) : undefined)
  const tz = timeZoneLabel(at)

  const lines = []
  lines.push('# AI 产品雷达 · 产品机会导出')
  lines.push('')
  lines.push(`- 导出时间：${formatTime(at.getTime())}（${tz}）`)
  lines.push(`- 机会数量：${opportunities.length}`)
  lines.push('- 生成方式：DeepSeek Harness「AI 产品雷达」插件，直接从本地存储导出。**没有人也没有模型改写过这里的任何一句话。**')
  lines.push('')
  lines.push(
    '> 每一条机会都分成两个区：**事实**来自插件真实抓取并落盘的记录（可点开头部的条目链接自己核对），' +
      '**推测与判断**是使用者自己写的。两者不会混在一起 —— 一份分不清"看到的"和"猜的"的笔记，比没有笔记更危险。',
  )
  lines.push('')

  if (opportunities.length === 0) {
    lines.push('（机会池是空的，没有可导出的内容。）')
    lines.push('')
    // 空池也用带时间戳的「全部导出」文件名：`[]` 走的是复数分支，
    // 不要为了凑一个名字塞一条假记录进去。
    return { markdown: lines.join('\n'), filename: exportFilename([], at), count: 0 }
  }

  opportunities.forEach((opportunity, index) => {
    lines.push('---')
    lines.push('')
    lines.push(`## ${index + 1}. ${safeInline(opportunity.title) || '（无标题）'}`)
    lines.push('')
    lines.push(`- 机会 id：\`${opportunity.id}\``)
    lines.push(`- 状态：${STATUS_LABEL[opportunity.status] ?? safeInline(opportunity.status)}`)
    if (formatTime(opportunity.createdAt)) lines.push(`- 创建：${formatTime(opportunity.createdAt)}`)
    if (formatTime(opportunity.updatedAt)) lines.push(`- 更新：${formatTime(opportunity.updatedAt)}`)
    const projectRef = safeUrl(opportunity.projectRef)
    if (projectRef) lines.push(`- 关联项目：<${projectRef}>`)
    else if (inline(opportunity.projectRef)) lines.push(`- 关联项目：${safeInline(opportunity.projectRef)}（记了一条但不是网址，按原文照录，未做成链接）`)
    lines.push('')

    // ---- 事实区 ----
    lines.push('### 事实（来自插件抓取并落盘的记录）')
    lines.push('')

    const change = byId(changes, opportunity.changeId)
    const source = byId(sources, opportunity.sourceId) ?? (change ? byId(sources, change.sourceId) : undefined)
    const snapshot = change ? byId(snapshots, change.snapshotId) : undefined

    if (!change) {
      // 一条机会可以完全由使用者凭记忆创建。此时**不能**把推断塞进事实区，
      // 也不能留一个空标题 —— 必须说清"这条机会没有抓取证据"。
      lines.push(
        '这条机会**没有关联任何一次抓取记录** —— 它是在没有来源证据的情况下创建的。' +
          '下面「推测与判断」里的内容全部出自使用者本人。',
      )
      lines.push('')
    } else {
      const itemUrl = safeUrl(change.itemUrl)
      if (itemUrl) lines.push(`- **条目链接**：<${itemUrl}>`)
      lines.push(`- 标题：${safeInline(change.title)}`)
      lines.push(`- 变化类型：${KIND_LABEL[change.kind] ?? safeInline(change.kind)}`)
      lines.push(`- 差异摘要：${safeInline(change.diffSummary)}`)
      if (formatTime(change.publishedAt)) lines.push(`- 条目发布时间：${formatTime(change.publishedAt)}`)
      if (formatTime(change.discoveredAt)) lines.push(`- 插件发现时间：${formatTime(change.discoveredAt)}`)
      if (change.truncated === true) {
        lines.push('- ⚠️ **本次抓取的响应被截断**：上面的差异只是已取回部分的结果，不能据此断言条目被删除。')
      }
      lines.push('')
      lines.push('**来源**')
      lines.push('')
      if (source) {
        lines.push(`- 名称：${safeInline(source.name)}`)
        lines.push(`- 解析器：\`${safeInline(source.type)}\``)
        const sourceUrl = safeUrl(source.canonicalUrl)
        if (sourceUrl) lines.push(`- 来源地址：<${sourceUrl}>`)
      } else {
        lines.push('- （这个来源已被删除，只剩变化记录里的名称与地址。）')
        const fallback = safeUrl(change.itemUrl)
        if (fallback) lines.push(`- 条目地址：<${fallback}>`)
      }
      lines.push('')
      if (snapshot) {
        lines.push('**证据快照**')
        lines.push('')
        lines.push(`- 快照 id：\`${snapshot.id}\``)
        if (formatTime(snapshot.fetchedAt)) lines.push(`- 抓取时间：${formatTime(snapshot.fetchedAt)}`)
        if (typeof snapshot.itemCount === 'number') lines.push(`- 该次抓到的条目数：${snapshot.itemCount}`)
        const fetchedUrl = safeUrl(snapshot.url)
        if (fetchedUrl) lines.push(`- 实际抓取地址：<${fetchedUrl}>（重定向后的最终地址）`)
        lines.push('')
      }
      const quote = quoted(change.excerpt)
      if (quote.length > 0) {
        lines.push('**原文摘录**')
        lines.push('')
        lines.push(...quote)
        lines.push('')
      }
    }

    // ---- 推测区 ----
    lines.push('### 推测与判断（使用者自己写的，未经插件核实）')
    lines.push('')

    const judgment = safeInline(opportunity.judgment)
    const questions = Array.isArray(opportunity.questions) ? opportunity.questions.map(safeInline).filter(Boolean) : []
    const nextAction = safeInline(opportunity.nextAction)

    if (!judgment && questions.length === 0 && !nextAction) {
      lines.push('（还没有写。这条机会目前只有上面的事实部分。）')
      lines.push('')
    } else {
      if (judgment) {
        lines.push(`- 判断：${judgment}`)
      }
      if (questions.length > 0) {
        lines.push('- 待验证的问题：')
        for (const question of questions) lines.push(`  1. ${question}`)
      }
      if (nextAction) {
        lines.push(`- 下一步：${nextAction}`)
      }
      lines.push('')
    }
  })

  lines.push('---')
  lines.push('')
  lines.push(
    `本文件由「AI 产品雷达」生成于 ${formatTime(at.getTime())}（${tz}）。` +
      '所有链接都是抓取时记录的原样地址，插件没有在导出时重新访问它们 —— 链接是否仍然有效，请自行核对。',
  )
  lines.push('')

  return { markdown: lines.join('\n'), filename: exportFilename(opportunities, at), count: opportunities.length }
}
