/* 验证「把右栏那个页签关掉，右栏就回到入口列表（Knit + AI 产品雷达）」这条恢复步骤是否成立。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => [...document.querySelectorAll(sel)]
  const textOf = (el) => (el.innerText || el.textContent || '').trim()
  const byAria = (label) => q('button,[role="button"]').find((el) => (el.getAttribute('aria-label') || '').includes(label))
  const rightSideText = () => q('*')
    .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.left > innerWidth * 0.5 })
    .map(textOf).join(' ')

  const out = { steps: [] }
  await sleep(2000)

  byAria('打开右侧边栏')?.click(); await sleep(2500); out.steps.push('① 打开右侧边栏')
  out.a_入口列表 = q('*')
    .filter((el) => { const t = textOf(el); const r = el.getBoundingClientRect(); return t && t.length <= 20 && r.width > 0 && r.left > innerWidth * 0.5 && r.height < 50 })
    .map(textOf).filter((v, i, a) => a.indexOf(v) === i && ['Knit 最近文档', 'AI 产品雷达', 'AI 产品雷达 · 技术验证'].includes(v))

  // 点入口，打开面板
  const entry = q('*').filter((el) => textOf(el) === 'AI 产品雷达' && el.getBoundingClientRect().left > innerWidth * 0.5).pop()
  entry?.click(); await sleep(2500); out.steps.push('② 点「AI 产品雷达」入口')
  out.b_面板是否打开 = rightSideText().includes('Host 原始响应')

  // 关掉这个页签：找页签条上的关闭按钮
  const closers = q('button,[role="button"]')
    .filter((el) => {
      const r = el.getBoundingClientRect()
      const label = (el.getAttribute('aria-label') || '') + textOf(el)
      return r.width > 0 && r.width < 32 && r.height < 32 && r.top < 80 && /关闭|close|✕|×/i.test(label)
    })
  out.关闭按钮候选数 = closers.length
  if (closers.length) { closers[0].click(); await sleep(2500); out.steps.push('③ 点页签上的关闭按钮') }

  out.c_关闭后右栏 = q('*')
    .filter((el) => { const t = textOf(el); const r = el.getBoundingClientRect(); return t && t.length <= 20 && r.width > 0 && r.left > innerWidth * 0.5 && r.height < 50 })
    .map(textOf).filter((v, i, a) => a.indexOf(v) === i && ['Knit 最近文档', 'AI 产品雷达', 'AI 产品雷达 · 技术验证', '开始'].includes(v))
  out.d_面板已关 = !rightSideText().includes('Host 原始响应')

  return out
})()
