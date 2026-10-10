/* 只做一件事：打开右侧边栏并停在那里，供截图留证（不点击任何雷达入口）。 */
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const byAria = (label) => [...document.querySelectorAll('button,[role="button"]')]
    .find((el) => (el.getAttribute('aria-label') || '').includes(label))
  await sleep(2000)
  const opener = byAria('打开右侧边栏')
  if (opener) { opener.click(); await sleep(2500) }
  const textOf = (el) => (el.innerText || el.textContent || '').trim()
  return {
    已打开: !!opener,
    右栏雷达入口: [...document.querySelectorAll('*')]
      .filter((el) => {
        const t = textOf(el)
        const r = el.getBoundingClientRect()
        return t.includes('雷达') && t.length <= 30 && r.width > 0 && r.left > innerWidth * 0.5
      })
      .map((el) => textOf(el))
      .filter((v, i, a) => a.indexOf(v) === i),
  }
})()
