/* 探针 2：真实渲染进程内的 Client → Host → Client 往返 + 异常态判别。
   全部请求都用**同源相对路径**发起，这正是 V1 要验证的东西。 */
(async () => {
  const out = { origin: location.origin, steps: [] }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const PREFIX = '/apradar-spike'

  // ── ① 打开右栏页签（若已注册，界面上应能点到它）────────────────
  const candidates = () => Array.from(document.querySelectorAll('button,[role="tab"],[role="button"],a'))
  const tabEl = candidates().find((el) => (el.innerText || '').includes('产品雷达 Spike'))
  out.tabElementFound = !!tabEl
  if (tabEl) {
    tabEl.click()
    await sleep(2500)
    out.steps.push('已点击右栏页签「产品雷达 Spike」')
  } else {
    out.steps.push('未在 DOM 中找到页签元素')
  }

  // 面板内容：SpikeBody 渲染出的探针结果文字
  const panelText = (document.body.innerText || '')
  const start = panelText.indexOf('页面来源')
  out.panelRendered = start >= 0
  out.panelExcerpt = start >= 0 ? panelText.slice(start, start + 900).replace(/\s+/g, ' ') : null

  // ── ② 直接发起同源请求（不依赖 UI），逐项记录 ────────────────────
  async function hit(path, timeoutMs) {
    const started = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs || 5000)
    try {
      const res = await fetch(PREFIX + path, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
        signal: controller.signal,
      })
      const text = await res.text()
      let parsed = null
      try { parsed = JSON.parse(text) } catch { parsed = null }
      return {
        path, outcome: 'response', status: res.status, ok: res.ok,
        ms: Date.now() - started,
        contentType: res.headers.get('content-type'),
        bodyLength: text.length,
        parsedCode: parsed && parsed.code ? parsed.code : null,
        isJson: parsed !== null,
        bodyPreview: text.slice(0, 200),
      }
    } catch (e) {
      return {
        path,
        outcome: (e && e.name === 'AbortError') ? 'timeout' : 'network-error',
        ms: Date.now() - started,
        error: (e && e.name === 'AbortError') ? 'AbortError@' + timeoutMs + 'ms' : String(e && e.message || e),
      }
    } finally {
      clearTimeout(timer)
    }
  }

  out.probes = []
  for (const [p, t] of [['/ping', 5000], ['/boom', 5000], ['/not-json', 5000], ['/empty', 5000], ['/nope', 5000], ['/hang', 1500]]) {
    out.probes.push(await hit(p, t))
  }

  // ── ③ 判定：四类异常是否互相可区分 ──────────────────────────────
  const by = Object.fromEntries(out.probes.map((p) => [p.path, p]))
  out.verdict = {
    pingIsJsonWithCode: by['/ping'].isJson && by['/ping'].parsedCode === 'spike/pong' && by['/ping'].status === 200,
    boomIs5xxWithCode: by['/boom'].status === 500 && by['/boom'].parsedCode === 'spike/boom',
    notJsonDetected: by['/not-json'].status === 200 && by['/not-json'].isJson === false,
    emptyBodyDetected: by['/empty'].status === 200 && by['/empty'].bodyLength === 0,
    notFoundDetected: by['/nope'].status === 404 && by['/nope'].parsedCode === 'spike/not-found-route',
    timeoutDetected: by['/hang'].outcome === 'timeout',
  }
  out.hostSawHost = null
  try {
    const r = await fetch(PREFIX + '/ping', { headers: { accept: 'application/json' }, cache: 'no-store' })
    const j = await r.json()
    out.hostSawHost = { host: j.host, origin: j.origin, referer: j.referer, userAgent: j.userAgent, pid: j.pid, node: j.node }
    out.verdict.hostHeaderMatchesPageOrigin = ('http://' + j.host) === location.origin
  } catch (e) {
    out.hostSawHost = { error: String(e) }
  }

  // 控制台不应有未捕获异常
  out.bodyTextLength = (document.body.innerText || '').length
  return out
})()
