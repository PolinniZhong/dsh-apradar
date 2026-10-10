/* 枚举右侧栏的页签，以及「+」里可添加的页签类型。 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  const out = {}

  // 打开右栏
  const opener = q('button').find((b) => /打开右侧边栏/.test(b.getAttribute('aria-label') || ''))
  if (opener) { opener.click(); await sleep(1500) }

  const strip = () => q('[role="tab"], [class*="tabStrip"] button, [class*="tabBar"] button, [class*="tabHost"] button')
    .filter((el) => rectOf(el)[0] > window.innerWidth * 0.52)
  out.tabStripBefore = strip().map((b) => ({ text: textOf(b).slice(0, 20), aria: (b.getAttribute('aria-label') || '').slice(0, 30), cls: String(b.className).slice(0, 50), rect: rectOf(b) }))
  out.aprTabs = q('[role="tab"]').filter((el) => /apradar/i.test(String(el.className) + (el.getAttribute('data-kind') || '') + (el.getAttribute('aria-label') || ''))).map((el) => ({ text: textOf(el).slice(0, 20), rect: rectOf(el), attrs: Array.from(el.attributes).map((a) => a.name + '=' + a.value.slice(0, 40)).join(' ') }))

  // 点「+」看能加哪些页签
  const plus = strip().find((b) => textOf(b) === '+' || /添加|新建页签|更多页签/.test(b.getAttribute('aria-label') || ''))
  out.plusFound = !!plus
  if (plus) {
    plus.click(); await sleep(1500)
    out.afterPlus = q('[role="menuitem"], [role="option"], button, [class*="menu"] div')
      .map((el) => textOf(el)).filter((t) => t && t.length < 30)
      .filter((t, i, a) => a.indexOf(t) === i).slice(0, 40)
    // 也把右栏里出现的所有文字抓一份
    const right = q('div').filter((el) => { const r = el.getBoundingClientRect(); return r.left > window.innerWidth * 0.52 && r.width > 200 && r.height > 100 })
    out.rightTexts = right.map((el) => textOf(el).slice(0, 400)).slice(-3)
  }

  out.bodyText = (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 1500)
  return out
})()
