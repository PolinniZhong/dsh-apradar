/* 诊断探针：不点任何东西，只枚举当前 DOM 里「会话区布局」与「雷达相关入口」的真实结构。
 * 目的：回答用户「会话区是不是被拆成三块 / 雷达是不是多注册了东西」。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => [...document.querySelectorAll(sel)]
  const textOf = (el) => (el.innerText || el.textContent || '').trim()
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) } }
  const desc = (el) => {
    if (!el) return null
    const cls = (el.className || '').toString().split(/\s+/).filter(Boolean).slice(0, 3).join('.')
    return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''}`
  }

  const out = { viewport: { w: innerWidth, h: innerHeight }, steps: [] }

  await sleep(2500)

  // ① 顶层骨架：从 body 往下找「宽度接近满屏」的横向分栏容器
  const rows = []
  const walk = (el, depth) => {
    if (depth > 4) return
    for (const child of el.children) {
      const r = child.getBoundingClientRect()
      if (r.width > innerWidth * 0.12 && r.height > innerHeight * 0.5) {
        rows.push({ depth, tag: desc(child), ...rect(child), text: textOf(child).slice(0, 40) })
      }
      walk(child, depth + 1)
    }
  }
  walk(document.body, 0)
  out.columns = rows

  // ② 所有含「雷达」的元素（入口、页签、面板）
  out.radarNodes = q('*')
    .filter((el) => textOf(el).includes('雷达') && textOf(el).length <= 80)
    .map((el) => ({ tag: desc(el), ...rect(el), text: textOf(el) }))
    .filter((n) => n.w > 0 && n.h > 0)

  // ③ 右栏面板容器是否存在、多宽
  const pane = q('*').find((el) => textOf(el).includes('Host 原始响应'))
  out.spikePanelPresent = !!q('*').find((el) => textOf(el).includes('产品雷达 Spike'))

  // ④ 会话区底部的 tab 条（用户看到的「三个布局」候选）
  out.bottomTabs = q('[role="tab"], [role="tablist"] button, [class*="tab"]')
    .filter((el) => { const r = el.getBoundingClientRect(); return r.top > innerHeight * 0.6 && r.width > 0 })
    .map((el) => ({ tag: desc(el), ...rect(el), text: textOf(el).slice(0, 30) }))
    .slice(0, 20)

  // ⑤ 顶部/头部工具区里与雷达有关的按钮
  out.utilitiesButtons = q('button, [role="button"]')
    .filter((el) => { const r = el.getBoundingClientRect(); return r.top < 120 && r.width > 0 })
    .map((el) => ({ tag: desc(el), ...rect(el), text: textOf(el).slice(0, 24), aria: el.getAttribute('aria-label') }))
    .slice(0, 25)

  return out
})()
