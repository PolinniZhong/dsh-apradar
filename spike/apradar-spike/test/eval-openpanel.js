/* 探针 3：真实打开右侧边栏 → 找到并点开 Spike 页签 → 读回页面自渲染的探针结果。
   这一支补齐「右侧栏页面真实加载」这一段证据；网络往返本身由 eval-roundtrip.js 覆盖。 */
(async () => {
  const out = { origin: location.origin, steps: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const buttons = () => Array.from(document.querySelectorAll('button,[role="tab"]'))
  const byAria = (re) => buttons().find((b) => re.test(b.getAttribute('aria-label') || '') || re.test((b.innerText || '').trim()))

  // ── ① 打开右侧边栏 ─────────────────────────────────────────────
  const opener = byAria(/打开右侧边栏/)
  out.sidebarOpenerFound = !!opener
  if (opener) {
    opener.click()
    await sleep(1200)
    out.steps.push('已点击「打开右侧边栏」')
  }

  // ── ② 找到 Spike 页签 ─────────────────────────────────────────
  let tab = buttons().find((b) => (b.innerText || '').includes('产品雷达'))
  out.tabFoundAfterOpen = !!tab
  if (!tab) {
    out.availableTabs = buttons().map((b) => (b.innerText || '').trim()).filter((t) => t && t.length < 24).slice(0, 40)
    // 退一步：直接调用官方 sidebarRight.openTab()
    try {
      const sr = (window.__DSH__ && window.__DSH__.ctx && window.__DSH__.ctx.get && window.__DSH__.ctx.get('sidebarRight')) || null
      out.sidebarRightReachableFromWindow = !!sr
    } catch (e) { out.sidebarRightReachableFromWindow = 'error: ' + e.message }
  }
  if (tab) {
    tab.click()
    await sleep(2500)
    out.steps.push('已点击页签「产品雷达 Spike」')
  }

  // ── ③ 读回页面自渲染的结果 ────────────────────────────────────
  const text = document.body.innerText || ''
  const i = text.indexOf('页面来源')
  out.panelRendered = i >= 0
  out.panelExcerpt = i >= 0 ? text.slice(i, i + 1200).replace(/\s+/g, ' ') : null
  out.anySpikeText = text.includes('apradar-spike') || text.includes('产品雷达 Spike')
  out.spikeTextExcerpt = out.anySpikeText
    ? text.slice(Math.max(0, text.indexOf('产品雷达 Spike')), Math.max(0, text.indexOf('产品雷达 Spike')) + 600).replace(/\s+/g, ' ')
    : null

  out.panelHtmlSnippet = (() => {
    const el = document.querySelector('[data-apradar-spike-panel]') || document.querySelector('.apradar-spike-root')
    return el ? el.outerHTML.slice(0, 500) : null
  })()

  return out
})()
