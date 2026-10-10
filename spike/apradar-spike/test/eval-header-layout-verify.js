/*
 * 会话区布局回归探针（自证版）——回答「AI 产品雷达面板有没有被渲染进会话头部 / 主区」。
 *
 * 为什么重写：老的 eval-header-check.js 与 eval-ui-header.js 都靠一个**硬编码的会话标题**
 * （「以下是我想做的一个新产品」）来打开会话。那个标题一旦不存在，探针就会在"没打开会话"
 * 的情况下继续跑，`a_会话态下主区有面板 = False` 这种断言会**空转变为通过** ——
 * 看起来是绿的，其实什么都没测。这个探针的每一步都要求先拿到正证据再继续。
 *
 * 正证据链：
 *   ① 左栏确实找到了会话条目（列出候选文字，不是布尔值）
 *   ② 点开之后**必须**找到输入框（composer）才算会话真开了；找不到就立刻返回并标记 inconclusive
 *   ③ 会话开后 `conversation.session.header.utilities` 席位必须存在（这是 bug 的载体）
 *   ④ 面板指纹只能出现在右半屏；出现在左半屏（主区）就是 bug 复现
 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  const desc = (el) => `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}.${String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.')}`

  const out = { origin: location.origin, conclusive: false, steps: [], candidates: [] }
  const VW = window.innerWidth
  /** 面板根节点（我们插件的最外层）。 */
  const panelRoot = () => document.querySelector('.apr-root')
  /** 面板正文指纹：只有 RadarPane 里才有这句。 */
  const FINGERPRINT = '本页只显示 Host 真实返回的内容'
  const fingerprintHits = () => q('*').filter((el) => textOf(el).includes(FINGERPRINT))

  const slotSel = '[data-slot="conversation.session.header.utilities"]'
  const slotInfo = () => {
    const s = document.querySelector(slotSel)
    if (!s) return null
    return { rect: rectOf(s), text: textOf(s).slice(0, 120), childCount: s.children.length }
  }
  /**
   * 会话真的打开了没有？
   *
   * ⚠️ 只找"有没有输入框"会**假阳性**：首页那个"描述你想要构建的内容"提示框也是输入区
   * （实测在 y≈380，屏幕中部）。真会话有两个可区分特征，两条都要满足：
   *   ① 输入区**贴着屏幕底部**（会话的 composer 在底部，首页的在中间）；
   *   ② 首页主视觉那句「探索未至之境」**消失了**。
   */
  const composer = () => {
    const homeHeroGone = !document.body.innerText.includes('探索未至之境')
    const box = q('textarea, [contenteditable="true"], .ProseMirror').find((el) => {
      const r = el.getBoundingClientRect()
      return r.width > 120 && r.height > 10 && r.top > window.innerHeight * 0.55
    })
    if (!box || !homeHeroGone) return null
    return box
  }

  /** 左栏里的**会话行**（实测类名带 sessionRow；项目分组标题是 groupSection，点了只会折叠）。 */
  const sessionRows = () =>
    q('[class*="sessionRow"], [class*="session_row"], [class*="SessionRow"]')

  // 关掉可能挡路的模态
  for (const label of ['继续', '知道了', '关闭', '稍后']) {
    const b = q('button').find((el) => textOf(el) === label)
    if (b) { b.click(); await sleep(400); break }
  }
  await sleep(800)

  out.before = { panel: !!panelRoot(), fingerprintHits: fingerprintHits().length, slot: slotInfo() }

  // ── ① 在左栏里找**会话行**（不依赖任何具体标题）─────────────────
  // ⚠️ 上一版把所有左栏元素按 y 排序取第一个，结果取到了 `div.bhn1Oq_groupSection`
  //    （**项目分组标题**，点了只会折叠展开，不会开会话），于是后面全是空转。
  //    实测真实会话行的类名带 `sessionRow`（`div.YDXeBa_sessionRow`），
  //    项目分组标题是 `groupSection`、项目行是 `projectRow` —— 认类名，不认位置。
  const seen = new Set()
  const rows = []
  for (const el of sessionRows()) {
    const r = el.getBoundingClientRect()
    if (r.width < 80 || r.height < 18 || r.height > 60 || r.top < 0) continue
    const t = textOf(el)
    if (!t || t.length > 60) continue
    const key = t + '|' + Math.round(r.top)
    if (seen.has(key)) continue
    seen.add(key)
    rows.push({ el, tag: desc(el), text: t.slice(0, 48), rect: rectOf(el) })
  }
  // ⚠️ 必须挑**未选中**的会话行：点一个已经 `*_selected` 的行不会发生导航
  //    （实测点「新会话」这个已选中行，7 秒后 `homeHero` 仍是 True、什么都没变）。
  //    另外实测只有「直接把 .click() 打在行元素本身」有效；行内没有 button/a/[role=button]，
  //    完整指针事件序列也能用但没必要。
  rows.sort((a, b) => {
    const sa = /selected/.test(String(a.el.className)) ? 1 : 0
    const sb = /selected/.test(String(b.el.className)) ? 1 : 0
    return sa - sb || a.rect[1] - b.rect[1]
  })
  out.candidates = rows.slice(0, 12).map((r) => ({ tag: r.tag, text: r.text, rect: r.rect, selected: /selected/.test(String(r.el.className)) }))
  out.sessionRowCount = rows.length

  const target = rows[0]
  if (!target) { out.reason = '左栏没有找到任何会话条目 —— 无法进行，判定 inconclusive'; return out }
  out.clickedCandidate = { tag: target.tag, text: target.text, rect: target.rect }

  // 直接把 click 打在行元素本身（实测这是有效的那个；行内没有 button/a/[role=button]）
  target.el.click()
  await sleep(6500)

  // ── ② 正证据：输入框必须出现 ─────────────────────────────────
  const box = composer()
  out.composerFound = !!box
  out.composerRect = box ? rectOf(box) : null
  if (!box) {
    out.reason = '点击后没有出现输入框 —— 会话没有真的打开，本次结果无意义（inconclusive）'
    out.afterClick = { panel: !!panelRoot(), fingerprintHits: fingerprintHits().length, slot: slotInfo() }
    return out
  }
  out.steps.push('② 输入框出现 => 会话确实打开了')
  out.conclusive = true

  // ── ③ 会话头部席位 ──────────────────────────────────────────
  out.afterSession = { panel: !!panelRoot(), fingerprintHits: fingerprintHits().length, slot: slotInfo() }
  out.headerSlotExists = out.afterSession.slot !== null

  // 头部里的按钮有哪些（入口按钮应当在这里，而且是个小按钮）
  const headerButtons = q(`${slotSel} button`).map((b) => ({ text: textOf(b).slice(0, 30), rect: rectOf(b), cls: desc(b) }))
  out.headerButtons = headerButtons
  out.entryInHeader = headerButtons.find((b) => b.text.includes('AI 产品雷达')) || null

  // ── ④ 面板指纹的位置（题眼）──────────────────────────────────
  const hits = fingerprintHits()
  out.fingerprintCount = hits.length
  if (hits.length) {
    const inner = hits.sort((a, b) => textOf(a).length - textOf(b).length)[0]
    const r = inner.getBoundingClientRect()
    const chain = []
    let n = inner
    for (let i = 0; i < 7 && n; i += 1) { chain.push(`${desc(n)} ${rectOf(n).join(',')}`); n = n.parentElement }
    out.fingerprint = {
      rect: rectOf(inner),
      zone: (r.left + r.width / 2) < VW / 2 ? '主区(左半) ← BUG' : '右栏(右半)',
      chain,
      inHeader: chain.some((c) => /headerUtilities|titleRow/i.test(c)),
    }
  }

  // ── ⑤ 点头部入口 -> 面板应当只出现在右半屏 ───────────────────
  const entry = out.entryInHeader
  if (entry) {
    const btn = q(`${slotSel} button`).find((b) => textOf(b).includes('AI 产品雷达'))
    btn.click()
    for (let i = 0; i < 75 && !panelRoot(); i += 1) await sleep(200)
    await sleep(2500)
    out.afterEntryClick = { panelPresent: !!panelRoot() }
    if (panelRoot()) {
      const pr = panelRoot().getBoundingClientRect()
      out.afterEntryClick.panelRect = rectOf(panelRoot())
      out.afterEntryClick.panelZone = (pr.left + pr.width / 2) < VW / 2 ? '主区(左半) ← BUG' : '右栏(右半)'
      const chain = []
      let n = panelRoot()
      for (let i = 0; i < 7 && n; i += 1) { chain.push(`${desc(n)} ${rectOf(n).join(',')}`); n = n.parentElement }
      out.afterEntryClick.panelChain = chain
      out.afterEntryClick.panelInHeader = chain.some((c) => /headerUtilities|titleRow/i.test(c))
      out.afterEntryClick.panelTextLen = textOf(panelRoot()).length
      // 主区（左半屏）里还有没有面板指纹
      out.afterEntryClick.fingerprintInMainArea = fingerprintHits().some((el) => {
        const r = el.getBoundingClientRect()
        return (r.left + r.width / 2) < VW / 2
      })
    }
  } else {
    out.afterEntryClick = { skipped: '会话头部里没找到「AI 产品雷达」入口按钮' }
  }

  return out
})()
