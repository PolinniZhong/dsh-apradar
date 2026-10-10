/* 探针 6：全新 profile 的完整走位 —— 关模态 → 新建会话 → 打开右侧边栏 → 点开 Spike 面板。 */
(async () => {
  const out = { origin: location.origin, steps: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const buttons = () => q('button,[role="button"],[role="tab"]')
  const textOf = (el) => (el.innerText || el.textContent || '').trim()

  for (let i = 0; i < 6; i++) {
    const b = buttons().find((x) => /^(继续|稍后配置|稍后再说|跳过|知道了|确定|好的|关闭|我知道了)$/.test(textOf(x)))
    if (!b) break
    b.click()
    await sleep(800)
  }
  out.steps.push('已清理首启模态')

  const findOpener = () => buttons().find((b) => /打开右侧边栏|右侧边栏|打开右栏/.test(b.getAttribute('aria-label') || ''))
  let opener = findOpener()

  if (!opener) {
    const nw = buttons().find((b) => /新会话/.test(textOf(b)))
    if (nw) { nw.click(); await sleep(2500); out.steps.push('已点击「新会话」') }
    opener = findOpener()
  }
  out.sidebarOpenerFound = !!opener
  if (opener) { opener.click(); await sleep(1500); out.steps.push('已打开右侧边栏') }

  if (!opener) {
    out.ariaDump = q('[aria-label]').map((e) => e.getAttribute('aria-label')).filter(Boolean).slice(0, 40)
  }

  const matches = Array.from(document.querySelectorAll('*')).filter((el) => {
    const t = textOf(el)
    return t.includes('技术验证') && t.length < 60
  })
  out.matchCount = matches.length
  const target = matches[matches.length - 1]
  out.entryFound = !!target
  if (target) {
    const clickable = target.closest('button,[role="button"],[role="tab"],li,a') || target
    clickable.click()
    await sleep(3200)
    out.steps.push('已点击入口')
  }

  const text = document.body.innerText || ''
  const i = text.indexOf('页面来源')
  out.panelRendered = i >= 0
  out.panelExcerpt = i >= 0 ? text.slice(i, i + 1500).replace(/\s+/g, ' ') : null
  out.tabTitleVisible = text.includes('产品雷达 Spike')
  return out
})()
