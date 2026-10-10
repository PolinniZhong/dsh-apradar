/* 0.1.2 形态验收：右栏只有一个「AI 产品雷达」入口，三个视图在页内用分段控件切换。
 * 每一步都要正证据：拿不到就记进 problems，不算通过。 */
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] }
  const until = async (fn, ms = 8000, step = 200) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { if (fn()) return true } catch (e) {} await sleep(step) } return false }
  const out = { problems: [], phases: {}, segments: [] }
  const panelRoot = () => document.querySelector('.apr-root')
  const panelText = () => { const r = panelRoot(); return r ? textOf(r) : '' }
  const clickBtn = (re) => { const b = q('button').find((el) => re.test(textOf(el))); if (b) { b.click(); return true } return false }

  await sleep(2500)
  for (const label of ['继续', '知道了', '关闭']) {
    const b = q('button').find((el) => textOf(el) === label)
    if (b) { b.click(); await sleep(400); break }
  }

  // ① 开会话（头部席位只在会话里挂载）
  const rows = q('[class*="sessionRow"]').map((el) => ({ el, sel: /selected/i.test(String(el.className)), text: textOf(el).slice(0, 20), r: rectOf(el) }))
    .filter((x) => x.r[0] < window.innerWidth * 0.3)
  out.phases.准备 = { 会话行候选: rows.map((x) => (x.sel ? '*' : '') + x.text) }
  const target = rows.find((x) => !x.sel) || rows[0]
  if (!target) { out.problems.push('左栏没有找到任何会话行'); return out }
  target.el.click()
  const composerOk = await until(() => q('textarea, [contenteditable="true"], input[type="text"]').some((el) => rectOf(el)[1] > window.innerHeight * 0.55), 9000)
  out.phases.准备.会话已打开 = composerOk
  if (!composerOk) { out.problems.push('点了会话行但底部输入框没出现，后续判据不成立'); return out }

  // ② 头部席位与我们的入口按钮
  const headerBtns = q('button').filter((el) => rectOf(el)[1] < 60 && rectOf(el)[0] > window.innerWidth * 0.5)
  const aprEntry = headerBtns.find((el) => /AI 产品雷达/.test(textOf(el)))
  out.phases.头部 = {
    我们的入口: aprEntry ? rectOf(aprEntry) : null,
    Knit的入口: (() => { const b = q('button.knit-entry, button[class*="knit"]')[0]; return b ? rectOf(b) : null })(),
    点击前面板存在: !!panelRoot(),
  }
  if (!aprEntry) out.problems.push('会话头部没有找到「AI 产品雷达」入口按钮')

  // ③ 点入口 → 面板出现
  if (aprEntry) aprEntry.click()
  const opened = await until(() => !!panelRoot() && panelText().length > 200, 9000)
  out.phases.面板 = { 已打开: opened }
  if (!opened) { out.problems.push('点头部入口后面板没有出现'); return out }

  const root = panelRoot()
  const chain = (() => { const a = []; let e = root; while (e && a.length < 8) { a.push(e.tagName.toLowerCase() + '.' + String(e.className).split(' ')[0]); e = e.parentElement } return a })()
  const pr = root.getBoundingClientRect()
  out.phases.面板.几何 = rectOf(root)
  out.phases.面板.祖先链 = chain
  out.phases.面板.落在右半屏 = pr.left >= window.innerWidth * 0.5
  out.phases.面板.文字长度 = panelText().length
  if (!out.phases.面板.落在右半屏) out.problems.push('面板不在右半屏（' + rectOf(root) + '）')

  // ④ 页内分段控件：必须正好 3 个 button
  const segs = q('.apr-tab')
  out.segments = segs.map((el) => ({ text: textOf(el), rect: rectOf(el), active: /is-active/.test(String(el.className)), tag: el.tagName }))
  out.phases.分段控件 = { 数量: segs.length, 文案: segs.map((el) => textOf(el)) }
  if (segs.length !== 3) out.problems.push('页内分段控件数量是 ' + segs.length + '，应为 3')
  if (segs.some((el) => el.tagName !== 'BUTTON')) out.problems.push('分段控件里有非 button 元素（键盘不可达）')
  const segOf = (re) => segs.find((el) => re.test(textOf(el)))

  // ⑤ 右栏页签条里我们的入口只应有 1 个
  const ourTabs = q('[role="tab"]').filter((el) => /产品雷达|变化|关注源|机会池/.test(textOf(el)))
  out.phases.右栏页签 = { 我们的页签: ourTabs.map((el) => textOf(el).slice(0, 20)), 数量: ourTabs.length }
  if (ourTabs.length > 1) out.problems.push('右栏出现了 ' + ourTabs.length + ' 个我们的页签，应只有 1 个')

  // ⑥ 逐个点分段控件，每个视图都要有内容
  for (const seg of segs) {
    const label = textOf(seg)
    seg.click()
    await sleep(1500)
    const t = panelText()
    out.phases['视图:' + label] = { 文字长度: t.length, 是激活态: /is-active/.test(String(seg.className)), 片段: t.slice(0, 100) }
    if (t.length < 100) out.problems.push('切到「' + label + '」后正文几乎为空')
  }

  // ⑦ 横向溢出（真实 647px 与强制 320px）
  const overflow = () => {
    const r = panelRoot(); if (!r) return null
    const prr = r.getBoundingClientRect()
    const bad = q('*').filter((c) => { const x = c.getBoundingClientRect(); return x.width > 0 && (x.right > prr.right + 1 || x.left < prr.left - 1) && r.contains(c) })
    return { 文档横向溢出: document.documentElement.scrollWidth - document.documentElement.clientWidth, 内部溢出元素数: bad.length, 面板宽: Math.round(prr.width) }
  }
  out.phases.横向溢出_真实 = overflow()
  const r0 = panelRoot(); if (r0) { r0.style.width = '320px'; await sleep(800); out.phases.横向溢出_强制320 = overflow(); r0.style.width = ''; await sleep(400) }

  // ⑧ 跨视图跳转 + 返回：机会详情 →「打开变化详情」→ 返回应回到**机会详情**（来路栈）
  const oppSeg = segOf(/机会池/)
  if (oppSeg) { oppSeg.click(); await sleep(1600) }
  out.phases.跨视图 = { 已切到机会池: /新建机会/.test(panelText()) }
  let jumped = false
  for (let i = 0; i < 8 && !jumped; i++) {
    const rowsOpp = q('.apr-rowlink')
    if (!rowsOpp[i]) break
    rowsOpp[i].click()
    const at = await until(() => /返回机会池/.test(panelText()), 6000)
    if (!at) { out.problems.push('点第 ' + (i + 1) + ' 条机会后没进详情'); break }
    out.phases.跨视图.试到第几条机会 = i + 1
    const go = clickBtn(/打开变化详情/)
    if (go) {
      const arrived = await until(() => /返回变化列表/.test(panelText()), 7000)
      out.phases.跨视图.已跳到变化详情 = arrived
      if (!arrived) { out.problems.push('点了「打开变化详情」但没到变化详情'); break }
      out.phases.跨视图.有返回按钮 = clickBtn(/返回变化列表/)
      await sleep(1400)
      out.phases.跨视图.返回后是机会详情 = /返回机会池/.test(panelText())
      if (!out.phases.跨视图.返回后是机会详情) out.problems.push('从变化详情返回后没有回到机会详情（来路栈失效）')
      jumped = true
    } else {
      clickBtn(/返回机会池/)
      await sleep(900)
    }
  }
  if (!jumped) out.problems.push('没有找到任何带「打开变化详情」入口的机会（跨视图跳转没测到）')

  return out
})()
