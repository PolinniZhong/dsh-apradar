/* 探针 5：通用版 —— 先关掉首次运行弹窗，再打开右侧边栏，精确点开 Spike 面板并读回渲染结果。
   与 eval-panel2.js 的区别：能处理全新 profile 的「预览版说明」等首启模态。 */
(async () => {
  const out = { origin: location.origin, steps: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const buttons = () => Array.from(document.querySelectorAll('button,[role="button"],[role="tab"]'))
  const textOf = (el) => (el.innerText || el.textContent || '').trim()

  // ── ① 关掉首启模态（「预览版说明」等）───────────────────────────
  const dismissed = []
  for (let round = 0; round < 6; round++) {
    const btn = buttons().find((b) => /^(继续|稍后配置|稍后再说|跳过|知道了|确定|好的|关闭|我知道了)$/.test(textOf(b)))
    if (!btn) break
    dismissed.push(textOf(btn))
    btn.click()
    await sleep(800)
  }
  out.dismissed = dismissed
  await sleep(600)

  // ── ② 打开右侧边栏 ────────────────────────────────────────────
  const opener = buttons().find((b) => /打开右侧边栏|右侧边栏|打开右栏/.test(b.getAttribute('aria-label') || ''))
  out.sidebarOpenerFound = !!opener
  if (opener) { opener.click(); await sleep(1200); out.steps.push('已打开右侧边栏') }

  // ── ③ 精确点开「AI 产品雷达 · 技术验证」入口 ────────────────────
  const matches = Array.from(document.querySelectorAll('*')).filter((el) => {
    const t = (el.innerText || el.textContent || '').trim()
    return t.includes('技术验证') && t.length < 60
  })
  out.matchCount = matches.length
  const target = matches[matches.length - 1]
  out.entryFound = !!target
  if (target) {
    const clickable = target.closest('button,[role="button"],[role="tab"],li,a') || target
    out.clickedTag = clickable.tagName
    clickable.click()
    await sleep(3200)
    out.steps.push('已点击入口： ' + textOf(clickable).slice(0, 40))
  } else {
    out.visibleEntries = buttons().map(textOf).filter((t) => t && t.length < 30).slice(0, 30)
  }

  // ── ④ 读回面板渲染结果 ────────────────────────────────────────
  const text = document.body.innerText || ''
  const i = text.indexOf('页面来源')
  out.panelRendered = i >= 0
  out.panelExcerpt = i >= 0 ? text.slice(i, i + 1500).replace(/\s+/g, ' ') : null
  out.tabTitleVisible = text.includes('产品雷达 Spike')
  return out
})()
