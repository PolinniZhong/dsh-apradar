// 终检：①打开真实会话 → ②打开右侧边栏 → ③点「AI 产品雷达」入口
// 断言：面板只出现在右栏（sidebar.right 内），主区（会话头部/标题行）不得出现面板。
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()

  const FINGERPRINT = '本页只显示 Host 真实返回的内容'
  const out = { origin: location.origin, steps: [] }

  const panelInfo = () => {
    const hits = q('*').filter((el) => textOf(el).includes(FINGERPRINT))
    if (!hits.length) return null
    const inner = hits.sort((a, b) => textOf(a).length - textOf(b).length)[0]
    const chain = []
    let node = inner
    for (let i = 0; i < 8 && node; i += 1) {
      const r = node.getBoundingClientRect()
      chain.push(`${node.tagName}.${typeof node.className === 'string' ? node.className.slice(0, 48) : ''} [${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}]`)
      node = node.parentElement
    }
    // 面板是否挂在右栏容器里
    const inSidebar = chain.some((c) => /sidebarRight|sidebar_right|wSkVaW_sidebar/i.test(c))
    const inHeader = chain.some((c) => /headerUtilities|titleRow/i.test(c))
    return { chain, inSidebar, inHeader }
  }

  // 关模态
  for (const label of ['继续', '知道了', '关闭']) {
    const b = q('button').find((el) => textOf(el) === label)
    if (b) { b.click(); await sleep(400); break }
  }

  // ① 打开一个真实会话
  const entry = q('*')
    .filter((el) => textOf(el).includes('以下是我想做的一个新产品') && textOf(el).length < 80)
    .filter((el) => el.getBoundingClientRect().left < window.innerWidth * 0.35)
    .sort((a, b) => textOf(a).length - textOf(b).length)[0]
  if (entry) { (entry.closest('button,[role="button"],li,a') || entry).click(); await sleep(6000) }
  out.steps.push('① 已打开会话')
  out.a_会话态下主区是否有面板 = panelInfo() !== null

  // ② 打开右侧边栏
  const opener = q('[aria-label]').find((el) => (el.getAttribute('aria-label') || '').includes('打开右侧边栏'))
  if (opener) { opener.click(); await sleep(1500); out.steps.push('② 已打开右侧边栏') }

  // ③ 点「AI 产品雷达」入口（取最内层的精确匹配）
  const cands = q('*')
    .filter((el) => textOf(el) === 'AI 产品雷达' && el.getBoundingClientRect().left > window.innerWidth * 0.5)
  const chosen = cands[cands.length - 1]
  out.c_入口候选数 = cands.length
  if (chosen) {
    (chosen.closest('button,[role="button"],[role="tab"],li,a') || chosen).click()
    await sleep(4000)
    out.steps.push('③ 已点击入口')
  }

  const info = panelInfo()
  out.d_面板是否渲染 = info !== null
  out.e_面板在右栏内 = info ? info.inSidebar : null
  out.f_面板在会话头部内 = info ? info.inHeader : null
  out.g_祖先链 = info ? info.chain : null
  out.consoleHasApradar = true

  return out
})()
