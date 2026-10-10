/*
 * 正式插件（dsh-apradar）在**真实 Desktop 宿主**（127.0.0.1:3080）上的面板探针。
 *
 * 走位：清模态 → 打开右侧边栏 → 点「AI 产品雷达」入口 → 读面板正文 →
 *       点面板内「测试错误响应」→ 再读一次。
 *
 * 判定标准：面板正文里必须出现 Host 的真实返回（openCount 与 code），
 * 以及失败态文案；不允许出现任何模拟数据。
 */
(async () => {
  const out = { origin: location.origin, steps: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.innerText || el.textContent || '').trim()
  const buttons = () => q('button,[role="button"],[role="tab"],[role="menuitem"],li,a')

  for (let i = 0; i < 6; i++) {
    const b = buttons().find((x) => /^(继续|稍后配置|稍后再说|跳过|知道了|确定|好的|关闭|我知道了)$/.test(textOf(x)))
    if (!b) break
    b.click()
    await sleep(700)
  }
  out.steps.push('已尝试清理首启模态')

  // 打开右侧边栏
  const opener = q('[aria-label]').find((el) => /打开右侧边栏|右侧边栏/.test(el.getAttribute('aria-label') || ''))
  out.sidebarOpenerFound = !!opener
  if (opener) {
    opener.click()
    await sleep(1500)
    out.steps.push('已打开右侧边栏')
  }

  // 找入口：文本包含「AI 产品雷达」的最短元素，且必须落在**右侧边栏区域内**
  // （左侧工作区名 "13_AI Product Radar_AI 产品雷达" 也含同样的子串，必须排除）。
  const candidates = q('*')
    .filter((el) => {
      const t = textOf(el)
      if (!t.includes('AI 产品雷达') || t.length > 60) return false
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.left > window.innerWidth * 0.5
    })
    .map((el) => ({ el, text: textOf(el), rect: el.getBoundingClientRect() }))
  out.candidates = candidates.map((c) => `${c.text} @${Math.round(c.rect.left)},${Math.round(c.rect.top)}`).slice(0, 10)

  // 精确等于「AI 产品雷达」的优先（Spike 的是「AI 产品雷达 · 技术验证」）；
  // 取**最后一个**命中 —— 那是最内层的元素，监听器通常挂在它或它的祖先上。
  const exacts = candidates.filter((c) => c.text === 'AI 产品雷达')
  const chosen = exacts[exacts.length - 1] || candidates[candidates.length - 1]
  out.chosenEntryText = chosen ? chosen.text : null

  if (chosen) {
    const clickable = chosen.el.closest('button,[role="button"],[role="tab"],li,a') || chosen.el
    const rect = clickable.getBoundingClientRect()
    out.clickedAt = `${Math.round(rect.left)},${Math.round(rect.top)}`
    clickable.click()
    await sleep(3500)
    out.steps.push('已点击「AI 产品雷达」入口')
  }

  const readPanel = () => {
    const text = document.body.innerText || ''
    const marker = text.indexOf('页面来源')
    return marker >= 0 ? text.slice(marker, marker + 2200).replace(/\s+/g, ' ') : null
  }
  out.panelRendered = !!readPanel()
  out.panelExcerpt = readPanel()
  out.tabTitleVisible = (document.body.innerText || '').includes('AI 产品雷达')

  // 点面板内的「测试错误响应」，验证失败态可区分
  const errBtn = buttons().find((b) => textOf(b) === '测试错误响应')
  out.errorButtonFound = !!errBtn
  if (errBtn) {
    errBtn.click()
    await sleep(2500)
    out.afterErrorExcerpt = readPanel()
  }

  return out
})()
