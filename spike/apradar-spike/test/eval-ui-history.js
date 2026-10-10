// P1-02 快照历史终检：①开会话 → ②开右侧边栏 → ③点「AI 产品雷达」入口 → ④切「关注源」
// → ⑤点第一张卡片的「历史」→ ⑥点第一行的「正文」。
// 断言：面板只在右栏；历史行带出真实时间 / 条目数 / 差异摘要；正文是真抓到的内容，不是占位符。
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const out = { origin: location.origin, steps: [] }
  const panelRoot = () => document.querySelector('.apr-root')
  const panelText = () => {
    const root = panelRoot()
    return root ? textOf(root) : ''
  }

  // —— ① 打开一个真实会话（会话头部席位只在会话里挂载）——
  const entry = q('*')
    .filter((el) => textOf(el).includes('以下是我想做的一个新产品') && textOf(el).length < 80)
    .filter((el) => el.getBoundingClientRect().left < window.innerWidth * 0.35)
    .sort((a, b) => textOf(a).length - textOf(b).length)[0]
  if (entry) {
    ;(entry.closest('button,[role="button"],li,a') || entry).click()
    await sleep(6000)
  }
  out.steps.push('① 已打开会话')
  out.a_会话态下主区有面板 = panelRoot() !== null

  // —— ② 打开右侧边栏 ——
  const opener = q('[aria-label]').find((el) => (el.getAttribute('aria-label') || '').includes('打开右侧边栏'))
  if (opener) {
    opener.click()
    await sleep(1500)
    out.steps.push('② 已打开右侧边栏')
  }

  // —— ③ 点「AI 产品雷达」入口 ——
  const cands = q('*').filter((el) => textOf(el) === 'AI 产品雷达' && el.getBoundingClientRect().left > window.innerWidth * 0.5)
  const chosen = cands[cands.length - 1]
  out.b_入口候选数 = cands.length
  if (chosen) {
    ;(chosen.closest('button,[role="button"],[role="tab"],li,a') || chosen).click()
    await sleep(3000)
    out.steps.push('③ 已点击入口')
  }
  for (let i = 0; i < 60 && !panelRoot(); i += 1) await sleep(200)
  out.c_面板是否渲染 = panelRoot() !== null
  if (!out.c_面板是否渲染) return out

  const rect = panelRoot().getBoundingClientRect()
  out.d_面板矩形 = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
  out.e_面板在右半屏 = rect.left > window.innerWidth * 0.5

  /** 在整个文档里找第一个可见的、文字精确匹配的按钮。 */
  const clickByText = async (label) => {
    const hits = q('button,[role="button"],a,span,div')
      .filter((el) => textOf(el) === label)
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.left > window.innerWidth * 0.5
      })
      .sort((a, b) => textOf(a).length - textOf(b).length)
    const target = hits[0]
    if (!target) return false
    ;(target.closest('button,[role="button"]') || target).click()
    return true
  }

  // —— ④ 切到「关注源」——
  const tab = q('.apr-tabs *')
    .filter((el) => textOf(el).startsWith('关注源'))
    .sort((a, b) => textOf(a).length - textOf(b).length)[0]
  if (tab) {
    ;(tab.closest('button,[role="button"],[role="tab"]') || tab).click()
    await sleep(2500)
    out.steps.push('④ 已切到「关注源」')
  }
  await sleep(2000)

  // —— ⑤ 点第一张卡片的「历史」——
  out.f_历史按钮可用 = await clickByText('历史')
  await sleep(2500)
  const afterHistory = panelText()
  out.g_出现历史提示 = afterHistory.includes('份快照')
  out.h_出现_仅保留摘录 = afterHistory.includes('仅保留摘录')
  out.i_出现_新增或基线 = /\+?\d+ 新增|基线/.test(afterHistory)
  // 历史行的时间必须是真实时间，不是占位符 —— 这是 fmtTime 类缺陷的复现位。
  out.j_历史行含真实时间 = /20\d\d-\d\d-\d\d \d\d:\d\d/.test(afterHistory)
  out.k_历史区文字摘要 = (afterHistory.match(/最近 \d+ 份快照[^]*/) || [''])[0].slice(0, 400)

  // —— ⑥ 点第一行的「正文」——
  out.l_正文按钮可用 = await clickByText('正文')
  await sleep(2500)
  const afterText = panelText()
  out.m_出现正文说明或正文 = afterText.includes('正文只显示前') || afterText.length > 0
  const pre = document.querySelector('.apr-pre')
  out.n_正文元素存在 = pre !== null
  out.o_正文字符数 = pre ? (pre.textContent || '').length : 0
  out.p_正文开头 = pre ? (pre.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 160) : null

  out.q_面板文字长度 = afterText.length
  return out
})()
