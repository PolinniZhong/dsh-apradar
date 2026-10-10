// P1-05 导出终检：①开会话 → ②开右侧边栏 → ③点「AI 产品雷达」入口 → ④切「机会池」
// → ⑤点「导出 Markdown」→ ⑥看结果提示（成功给出文件名与字节数，失败给出原因）。
// 断言：面板只在右栏；导出走后端真实响应（文件名来自 content-disposition）；
// 失败时不留一句空提示。
;(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
  const out = { origin: location.origin, steps: [], downloads: [] }
  const panelRoot = () => document.querySelector('.apr-root')
  const panelText = () => {
    const root = panelRoot()
    return root ? textOf(root) : ''
  }

  // 记录浏览器是否真的发起了下载 —— 只有它能证明「点了按钮」不只是改了个提示。
  const origCreate = URL.createObjectURL
  URL.createObjectURL = function patched(blob) {
    try {
      out.downloads.push({ size: blob && blob.size, type: blob && blob.type })
    } catch {
      /* 记录失败不影响主流程 */
    }
    return origCreate.call(URL, blob)
  }
  const origClick = HTMLAnchorElement.prototype.click
  HTMLAnchorElement.prototype.click = function patchedClick() {
    if (this.download) out.download_basename = this.download
    return origClick.call(this)
  }

  // —— ① 打开一个真实会话（会话头部席位只在会话里挂载）——
  const entry = q('*')
    .filter((el) => textOf(el).includes('以下是我想做的一个新产品') && textOf(el).length < 80)
    .filter((el) => el.getBoundingClientRect().left < window.innerWidth * 0.35)
    .sort((a, b) => textOf(a).length - textOf(b).length)[0]
  if (entry) {
    ;(entry.closest('button,[role="button"],li,a') || entry).click()
    await sleep(6000)
  }
  out.steps.push('① 已打开会话')
  out.a_会话态下主区有面板 = panelRoot() !== null

  // —— ② 打开右侧边栏 ——
  const opener = q('[aria-label]').find((el) => (el.getAttribute('aria-label') || '').includes('打开右侧边栏'))
  if (opener) {
    opener.click()
    await sleep(1500)
    out.steps.push('② 已打开右侧边栏')
  }

  // —— ③ 点「AI 产品雷达」入口 ——
  const cands = q('*').filter((el) => textOf(el) === 'AI 产品雷达' && el.getBoundingClientRect().left > window.innerWidth * 0.5)
  const chosen = cands[cands.length - 1]
  out.b_入口候选数 = cands.length
  if (chosen) {
    ;(chosen.closest('button,[role="button"],[role="tab"],li,a') || chosen).click()
    await sleep(3000)
    out.steps.push('③ 已点击入口')
  }
  for (let i = 0; i < 60 && !panelRoot(); i += 1) await sleep(200)
  out.c_面板是否渲染 = panelRoot() !== null
  if (!out.c_面板是否渲染) return out

  const rect = panelRoot().getBoundingClientRect()
  out.d_面板矩形 = [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
  out.e_面板在右半屏 = rect.left > window.innerWidth * 0.5

  /** 在整个文档里找第一个可见的、文字精确匹配的按钮。 */
  const clickByText = async (label) => {
    const hits = q('button,[role="button"],a,span,div')
      .filter((el) => textOf(el) === label)
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.left > window.innerWidth * 0.5
      })
      .sort((a, b) => textOf(a).length - textOf(b).length)
    const target = hits[0]
    if (!target) return false
    ;(target.closest('button,[role="button"]') || target).click()
    return true
  }

  /** 找到文字精确匹配的按钮元素（不点），用于判断它是否被禁用。 */
  const findButton = (label) =>
    q('button,[role="button"]')
      .filter((el) => textOf(el) === label)
      .filter((el) => {
        const r = el.getBoundingClientRect()
        return r.width > 0 && r.height > 0 && r.left > window.innerWidth * 0.5
      })[0] || null

  // —— ④ 切到「机会池」——
  const tab = q('.apr-tabs *')
    .filter((el) => textOf(el).startsWith('机会池'))
    .sort((a, b) => textOf(a).length - textOf(b).length)[0]
  if (tab) {
    ;(tab.closest('button,[role="button"],[role="tab"]') || tab).click()
    await sleep(2500)
    out.steps.push('④ 已切到「机会池」')
  }
  await sleep(2000)

  const exportBtn = findButton('导出 Markdown')
  out.f_导出按钮存在 = exportBtn !== null
  out.g_导出按钮被禁用 = exportBtn ? exportBtn.disabled === true : null
  out.h_机会池卡片数 = q('.apr-card').length

  // —— ⑤ 点「导出 Markdown」——
  out.i_已点击导出 = await clickByText('导出 Markdown')
  await sleep(4000)
  const after = panelText()
  out.j_出现导出结果 = /已导出|导出失败|导出超时/.test(after)
  out.k_结果提示 = (after.match(/已导出 [^]*?。/s) || after.match(/导出失败[^]*?。/s) || [''])[0].slice(0, 300)
  out.l_结果提示含文件名 = /已导出 ai-product-radar-[^\s（]+\.md/.test(after)
  out.m_结果提示含字符数 = /（\d+ 字符）/.test(after)
  out.n_结果提示声明不写项目目录 = after.includes('不会写你的项目目录')
  out.o_浏览器确实创建了Blob = out.downloads.length > 0
  out.p_Blob类型 = out.downloads[0] ? out.downloads[0].type : null
  out.q_面板文字长度 = panelText().length
  return out
})()
