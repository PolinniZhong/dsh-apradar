/*
 * 正式插件（dsh-apradar）在隔离 Web Profile 上的客户端探针。
 *
 * 只回答三件事：
 *   ① 正式插件的 client 脚本是否真的被注入并执行
 *   ② 右栏 kind 是否注册成功（日志与 DOM 双证据）
 *   ③ 页面有没有报错
 *
 * 不点面板：全新 Profile 无会话面，`sidebarRight.openTab()` 会抛
 * `no session surface is mounted`（TECH-SPIKE.md §6.4 已记录）。面板渲染在
 * Desktop 宿主（127.0.0.1:3080）上验证。
 */
(async () => {
  const out = { origin: location.origin, steps: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const q = (sel) => Array.from(document.querySelectorAll(sel))
  const textOf = (el) => (el.innerText || el.textContent || '').trim()
  const buttons = () => q('button,[role="button"],[role="tab"]')

  // 首启模态（预览版说明 / API Key 提示）会挡住后续交互
  for (let i = 0; i < 6; i++) {
    const b = buttons().find((x) => /^(继续|稍后配置|稍后再说|跳过|知道了|确定|好的|关闭|我知道了)$/.test(textOf(x)))
    if (!b) break
    b.click()
    await sleep(700)
  }
  out.steps.push('已尝试清理首启模态')

  // 证据 ①：脚本标签
  out.injectedScripts = q('script[src]').map((s) => s.getAttribute('src')).filter((s) => s && s.includes('apradar'))

  // 证据 ②：右栏 slot 注册留下的 DOM（标题条 / 入口）
  const mentions = q('*').filter((el) => {
    const t = textOf(el)
    return t.includes('AI 产品雷达') && t.length < 80
  })
  out.domMentionCount = mentions.length
  out.domMentions = mentions.slice(0, 5).map((el) => textOf(el))

  // 证据 ③：把 Host 状态读一遍（与插件内部同一条路径）
  try {
    const res = await fetch('/apradar/state', { headers: { accept: 'application/json' }, cache: 'no-store' })
    const body = await res.json()
    out.sameOriginState = { status: res.status, persisted: body?.storage?.persisted, openCount: body?.storage?.openCount }
  } catch (error) {
    out.sameOriginState = { error: String(error) }
  }

  // 证据 ④：样式确实注入了（说明 client 执行到模块尾部）
  out.styleInjected = !!document.getElementById('dsh-apradar-style')

  out.bodyHasMojibake = /â|ï¿½/.test(document.body.innerText || '')
  return out
})()
