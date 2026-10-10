/* 探针 1：页面是否真的启动、插件 Client 半边是否被装载、右栏页签是否注册。
   这只读页面状态，不发任何业务请求。 */
(() => {
  const out = {
    origin: location.origin,
    href: String(location.href).replace(/([?&]token=)[^&]*/g, '$1<hidden>'),
    title: document.title,
    bootReady: !!window.__DSH_BOOT_READY__,
    hasModuleLoader: typeof window.__ModuleLoader__ !== 'undefined',
    hasBootConfig: !!window.__DSH_BOOT__,
    bodyText: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 600),
    visibleButtonLabels: Array.from(document.querySelectorAll('button'))
      .map((b) => (b.innerText || b.getAttribute('aria-label') || '').trim())
      .filter(Boolean)
      .slice(0, 60),
    anyApradarText: (document.body.innerText || '').includes('产品雷达'),
  }
  // 侧栏页签：DSH 右栏把 tab 渲染成按钮，标题文字来自 tabs.register 的 title()
  out.tabCandidates = Array.from(document.querySelectorAll('button,[role=tab]'))
    .map((el) => (el.innerText || '').trim())
    .filter((t) => t && (t.includes('雷达') || t.includes('Spike')))
  return out
})()
