/* 诊断探针 2：打开右侧边栏 → 列出**所有**页签/入口（看清到底有几个雷达）→ 再收起侧边栏，把界面还原。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => [...document.querySelectorAll(sel)]
  const textOf = (el) => (el.innerText || el.textContent || '').trim()
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
  const byAria = (label) => q('button,[role="button"]').find((el) => (el.getAttribute('aria-label') || '').includes(label))

  const out = { steps: [] }
  await sleep(1500)

  const opener = byAria('打开右侧边栏')
  if (opener) { opener.click(); await sleep(2500); out.steps.push('已打开右侧边栏') }

  // 侧边栏区域（x 落在窗口右半边）里所有「页签/入口」文本
  out.sidebarEntries = q('*')
    .filter((el) => {
      const t = textOf(el)
      if (!t || t.length > 40) return false
      const r = el.getBoundingClientRect()
      return r.width > 0 && r.left > innerWidth * 0.5 && r.height < 80
    })
    .map((el) => ({ text: textOf(el), ...rect(el) }))
    .filter((n, i, arr) => arr.findIndex((m) => m.text === n.text && m.x === n.x) === i)
    .slice(0, 40)

  out.radarOnly = out.sidebarEntries.filter((n) => n.text.includes('雷达'))

  // 还原：收起右侧边栏
  const closer = byAria('收起右侧边栏')
  if (closer) { closer.click(); await sleep(1200); out.steps.push('已收起右侧边栏（还原界面）') }
  out.sidebarOpenAfter = !!q('*').find((el) => textOf(el).includes('Host 原始响应'))

  return out
})()
