/* 诊断 2：开会话的点击到底该怎么发。逐种策略试，每一步报告页面变没变。 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  const out = { tries: [] }
  const home = () => document.body.innerText.includes('探索未至之境')
  const href = () => location.href

  /** 完整的指针事件序列（有些实现监听 mousedown/pointerdown 而不是 click）。 */
  const fire = (el, type, x, y) => {
    const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent
    el.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, buttons: type.endsWith('down') ? 1 : 0, pointerId: 1, isPrimary: true }))
  }
  const fullClick = (el, x, y) => {
    for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) fire(el, t, x, y)
  }

  const state = () => ({ home: home(), href: href(), bodyLen: (document.body.innerText || '').length, headerSlot: !!document.querySelector('[data-slot="conversation.session.header.utilities"]') })

  out.before = state()

  const rows = q('[class*="sessionRow"]')
  out.rows = rows.map((el) => ({ text: textOf(el).slice(0, 30), rect: rectOf(el), cls: String(el.className).slice(0, 60), html: el.outerHTML.slice(0, 300) }))
  const pick = rows.find((el) => !/selected/.test(String(el.className))) || rows[0]
  if (!pick) { out.reason = '没有会话行'; return out }
  out.picked = textOf(pick).slice(0, 30)

  // 策略 1：直接 click() 行本身
  pick.click(); await sleep(3500)
  out.tries.push({ strategy: '1. 行元素 .click()', after: state() })
  if (!home()) return out

  // 策略 2：行内的按钮 / 链接 / role=button
  const inner = pick.querySelector('button, a, [role="button"]')
  out.innerFound = inner ? (inner.tagName + '.' + String(inner.className).slice(0, 40)) : null
  if (inner) { inner.click(); await sleep(3500); out.tries.push({ strategy: '2. 行内 ' + out.innerFound + ' .click()', after: state() }) }
  if (!home()) return out

  // 策略 3：完整指针事件序列打在行中心
  const r = pick.getBoundingClientRect()
  fullClick(pick, r.left + r.width / 2, r.top + r.height / 2); await sleep(3500)
  out.tries.push({ strategy: '3. 行中心完整指针事件序列', after: state() })
  if (!home()) return out

  // 策略 4：打在最深的那层文字元素上
  const deep = pick.querySelector('span,div:last-child') || pick.firstElementChild || pick
  const dr = deep.getBoundingClientRect()
  fullClick(deep, dr.left + dr.width / 2, dr.top + dr.height / 2); await sleep(3500)
  out.tries.push({ strategy: '4. 最深层 ' + deep.tagName + '.' + String(deep.className).slice(0, 40) + ' 完整指针序列', after: state() })
  if (!home()) return out

  // 策略 5：双击
  const r2 = pick.getBoundingClientRect()
  for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click', 'dblclick']) fire(pick, t, r2.left + 30, r2.top + r2.height / 2)
  await sleep(3500)
  out.tries.push({ strategy: '5. 行上双击', after: state() })

  return out
})()
