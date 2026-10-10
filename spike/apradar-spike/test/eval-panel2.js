/* 探针 4：精确点开右栏的「AI 产品雷达 · 技术验证」入口，读回 Spike 面板真实渲染的结果。 */
(async () => {
  const out = { origin: location.origin, steps: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  document.body.click() // 关掉可能开着的浮层
  await sleep(300)

  const opener = Array.from(document.querySelectorAll('button')).find((b) => /打开右侧边栏/.test(b.getAttribute('aria-label') || ''))
  if (opener) { opener.click(); await sleep(1200); out.steps.push('已打开右侧边栏') }

  // 精确匹配判据：元素自身文本含「技术验证」，且不含「产品 Radar / Radar_」
  const matches = Array.from(document.querySelectorAll('*')).filter((el) => {
    const t = (el.innerText || el.textContent || '').trim()
    return t.includes('技术验证') && t.length < 60
  })
  out.matchCount = matches.length
  out.matchDump = matches.slice(0, 5).map((el) => ({
    tag: el.tagName, cls: String(el.className || '').slice(0, 70), role: el.getAttribute('role'),
    aria: el.getAttribute('aria-label'), text: (el.innerText || el.textContent || '').trim().slice(0, 50),
  }))

  const target = matches[matches.length - 1]
  out.entryFound = !!target
  if (target) {
    const clickable = target.closest('button,[role="button"],[role="tab"],li,a') || target
    out.clickedTag = clickable.tagName
    clickable.click()
    await sleep(3000)
    out.steps.push('已点击入口： ' + (clickable.innerText || '').trim().slice(0, 40))
  }

  const text = document.body.innerText || ''
  const i = text.indexOf('页面来源')
  out.panelRendered = i >= 0
  out.panelExcerpt = i >= 0 ? text.slice(i, i + 1500).replace(/\s+/g, ' ') : null

  // 右栏 tab 条上应出现「产品雷达 Spike」
  out.tabTitleVisible = text.includes('产品雷达 Spike')
  const j = text.indexOf('产品雷达 Spike')
  out.tabAreaExcerpt = j >= 0 ? text.slice(j, j + 1400).replace(/\s+/g, ' ') : null

  return out
})()
