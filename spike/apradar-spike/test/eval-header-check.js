// 复现「雷达面板被渲染进主区（会话头部）」的最初故障。
// 关键：必须先打开一个真实会话 —— 无会话时 conversation.session.header.utilities 根本不渲染，
// 所以之前的无会话测试完全看不到这个 bug。
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()

  const out = {
    origin: location.origin,
    steps: [],
    // 打开会话之前
    beforeSession: null,
    // 打开会话之后
    afterSession: null,
    sessionOpened: false,
  }

  // 「面板正文」的指纹：只有 RadarBody 里才有这句话
  const FINGERPRINT = '本页只显示 Host 真实返回的内容'

  const findPanel = () => {
    const hits = q('*').filter((el) => textOf(el).includes(FINGERPRINT))
    if (!hits.length) return null
    // 取最内层（文本最短）的那个
    const inner = hits.sort((a, b) => textOf(a).length - textOf(b).length)[0]
    const rect = inner.getBoundingClientRect()
    // 向上收集祖先链，看它到底挂在哪个容器里
    const chain = []
    let node = inner
    for (let i = 0; i < 6 && node; i += 1) {
      const r = node.getBoundingClientRect()
      chain.push({
        tag: node.tagName,
        cls: typeof node.className === 'string' ? node.className.slice(0, 60) : '',
        rect: `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`,
      })
      node = node.parentElement
    }
    return {
      rect: `${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`,
      // 面板落在窗口左半边（主区）还是右半边（右栏）？
      zone: rect.left + rect.width / 2 < window.innerWidth / 2 ? '主区(左半)' : '右栏(右半)',
      chain,
    }
  }

  const layout = () => ({
    viewport: `${window.innerWidth}x${window.innerHeight}`,
    panel: findPanel(),
    // 会话头部席位是否渲染了东西
    headerUtilities: (() => {
      const slot = document.querySelector('[data-slot="conversation.session.header.utilities"]')
      if (!slot) return 'slot 未以 data-slot 暴露'
      const r = slot.getBoundingClientRect()
      return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} :: ${textOf(slot).slice(0, 80)}`
    })(),
  })

  // 关掉首启模态，避免挡住点击
  for (const label of ['继续', '知道了', '关闭']) {
    const b = q('button').find((el) => textOf(el) === label)
    if (b) {
      b.click()
      await sleep(400)
      break
    }
  }

  out.beforeSession = layout()

  // 点左栏的会话，真正打开一个会话
  const sessionCandidates = q('*').filter((el) => {
    const t = textOf(el)
    if (!t.includes('以下是我想做的一个新产品') || t.length > 80) return false
    const r = el.getBoundingClientRect()
    return r.width > 0 && r.left < window.innerWidth * 0.35
  })
  const target = sessionCandidates.sort((a, b) => textOf(a).length - textOf(b).length)[0]
  out.sessionEntry = target ? textOf(target).slice(0, 40) : null
  if (target) {
    const clickable = target.closest('button,[role="button"],li,a') || target
    clickable.click()
    await sleep(6000)
    out.steps.push('已点击左栏会话')
    out.sessionOpened = document.body.innerText.includes('对话')
  }

  out.afterSession = layout()

  return out
})()
