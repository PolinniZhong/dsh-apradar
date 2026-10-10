/* 诊断：点一个会话行之后，页面到底变成什么了。只观察，不断言。 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  const out = { viewport: [window.innerWidth, window.innerHeight] }

  const snapshot = (tag) => ({
    tag,
    homeHero: document.body.innerText.includes('探索未至之境'),
    bodyTextLen: (document.body.innerText || '').length,
    inputs: q('textarea, input, [contenteditable="true"], .ProseMirror').map((el) => ({
      tag: el.tagName.toLowerCase() + '.' + String(el.className || '').split(/\s+/).filter(Boolean).slice(0, 2).join('.'),
      rect: rectOf(el),
      placeholder: el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || '',
      ce: el.getAttribute('contenteditable') || '',
    })),
    headerUtilitiesSlot: !!document.querySelector('[data-slot="conversation.session.header.utilities"]'),
    aprRoot: !!document.querySelector('.apr-root'),
    // 头部那一排按钮（DSH 自己的）
    topButtons: q('button').map((b) => ({ aria: b.getAttribute('aria-label') || '', rect: rectOf(b), text: textOf(b).slice(0, 24) }))
      .filter((b) => b.rect[1] < 60 && b.rect[0] > window.innerWidth * 0.5),
    bodyHead: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 200),
  })

  out.before = snapshot('before')

  const rows = q('[class*="sessionRow"]')
  out.rowCount = rows.length
  out.rowTexts = rows.map((el) => textOf(el).slice(0, 30))
  // 取一个**不是** selected 的行，逼一次真实导航
  const pick = rows.find((el) => !/selected/.test(String(el.className))) || rows[0]
  out.picked = pick ? { cls: String(pick.className), text: textOf(pick).slice(0, 30) } : null
  if (pick) {
    ;(pick.querySelector('button,a,[role="button"]') || pick).click()
    await sleep(7000)
  }
  out.after = snapshot('after')

  // 面板指纹遍布全页搜一遍
  const FP = '本页只显示 Host 真实返回的内容'
  out.fingerprint = q('*').filter((el) => textOf(el).includes(FP)).map((el) => rectOf(el)).slice(0, 5)
  return out
})()
