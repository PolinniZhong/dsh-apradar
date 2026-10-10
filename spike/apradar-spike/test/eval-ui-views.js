// UI 三视图终检：①开会话 → ②开右侧边栏 → ③点「AI 产品雷达」入口 → ④切到目标视图
// 断言：面板只在右栏（几何 x > 视口一半），主区不出现面板；三视图都能渲染出真实数据。
// `__VIEW__` 由生成脚本替换为 inbox / sources / opps。
;(async () => {
  const VIEW = '__VIEW__'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const out = { origin: location.origin, view: VIEW, steps: [] }

  /** 面板最外层容器（我们自己的根节点，不是 DSH 的）。 */
  const panelRoot = () => document.querySelector('.apr-root')
  /** 面板可见文字的摘要，用来判断"里面是不是真的有东西"。 */
  const panelText = () => {
    const root = panelRoot()
    return root ? textOf(root) : ''
  }

  // 关掉可能挡路的模态
  for (const label of ['继续', '知道了', '关闭']) {
    const b = q('button').find((el) => textOf(el) === label)
    if (b) { b.click(); await sleep(400); break }
  }

  // ① 打开一个真实会话（会话头部席位只在会话里挂载，这是之前翻过车的地方）
  const entry = q('*')
    .filter((el) => textOf(el).includes('以下是我想做的一个新产品') && textOf(el).length < 80)
    .filter((el) => el.getBoundingClientRect().left < window.innerWidth * 0.35)
    .sort((a, b) => textOf(a).length - textOf(b).length)[0]
  if (entry) { (entry.closest('button,[role="button"],li,a') || entry).click(); await sleep(6000) }
  out.steps.push('① 已打开会话')
  out.a_会话态下主区有面板 = panelRoot() !== null

  // ② 打开右侧边栏
  const opener = q('[aria-label]').find((el) => (el.getAttribute('aria-label') || '').includes('打开右侧边栏'))
  if (opener) { opener.click(); await sleep(1500); out.steps.push('② 已打开右侧边栏') }

  // ③ 点右栏里的「AI 产品雷达」入口（取最内层的精确匹配，且必须在右半屏）
  const cands = q('*').filter((el) => textOf(el) === 'AI 产品雷达' && el.getBoundingClientRect().left > window.innerWidth * 0.5)
  const chosen = cands[cands.length - 1]
  out.b_入口候选数 = cands.length
  if (chosen) {
    (chosen.closest('button,[role="button"],[role="tab"],li,a') || chosen).click()
    await sleep(3000)
    out.steps.push('③ 已点击入口')
  }

  // 等面板真的出现（最多 12 秒）
  for (let i = 0; i < 60 && !panelRoot(); i += 1) await sleep(200)
  out.c_面板是否渲染 = panelRoot() !== null
  if (!out.c_面板是否渲染) return out

  // 几何证据：面板在右栏列里
  const rect = panelRoot().getBoundingClientRect()
  out.d_面板矩形 = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
  out.e_面板在右半屏 = rect.left > window.innerWidth * 0.5
  out.f_视口宽 = window.innerWidth

  // 祖先链（证明它挂在右栏的 tab host 里，而不是会话头部）
  const chain = []
  let node = panelRoot()
  for (let i = 0; i < 6 && node; i += 1) {
    const r = node.getBoundingClientRect()
    chain.push(`${node.tagName}.${typeof node.className === 'string' ? node.className.slice(0, 44) : ''} [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`)
    node = node.parentElement
  }
  out.g_祖先链 = chain
  out.h_在会话头部内 = chain.some((c) => /headerUtilities|titleRow/i.test(c))

  // ④ 切到目标视图
  const LABEL = { inbox: '变化', sources: '关注源', opps: '机会池' }[VIEW]
  const tab = q('.apr-tabs *')
    .filter((el) => textOf(el).startsWith(LABEL))
    .sort((a, b) => textOf(a).length - textOf(b).length)[0]
  if (tab) {
    ;(tab.closest('button,[role="button"],[role="tab"]') || tab).click()
    await sleep(2500)
    out.steps.push(`④ 已切到「${LABEL}」`)
  }
  out.i_页签数 = q('.apr-tabs *').filter((el) => /^(变化|关注源|机会池)/.test(textOf(el))).length

  // 等待数据落地（列表/空态都要稳定下来）
  await sleep(3000)

  const text = panelText()
  out.j_存储不可用 = text.includes('存储不可用')
  out.k_面板文字长度 = text.length
  out.l_面板文字摘要 = text.slice(0, 700)
  return out
})()
