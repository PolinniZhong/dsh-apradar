/**
 * AI 产品雷达 · P0-00 技术验证 Spike —— Client 半边
 *
 * 这不是产品代码，也不是 Demo。它要回答的是：
 *   ① 右栏页签能否注册
 *   ② Client 能否**同源**访问 Host 注册的 `/apradar-spike/*` 路由
 *   ③ 正常响应能否解析
 *   ④ 异常态（500 错误码 / 200 非 JSON / 超时 / 空体 / 404）能否区分且界面不崩溃
 *
 * 写法约束（沿用本机已验证的手写客户端范式，Knit 的 08_Knit/knit/src/client/client.js）：
 *   - **无构建步骤**：由 `window.__ModuleLoader__.load({...})` 直接装载
 *   - **禁止 JSX**：一律 `React.createElement`（这里别名为 `h`）
 *   - 只 `require` 基线模块；此处只需要 `react`
 *
 * 刻意不做的事：不访问任意外部网站、不碰宿主文件系统、不触碰持久化后端。
 */

window.__ModuleLoader__.load({
  id: 'dsh-apradar-spike',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /** 与 Host 半边约定的路由前缀。 */
    const ROUTE_PREFIX = '/apradar-spike'

    /** 右栏类型 / 页签标识。 */
    const TAB_ID = 'dsh-apradar-spike:main'
    const KIND = 'apradar-spike'

    /** 客户端主动超时（毫秒）。故意小于 Host 侧 `/hang` 的 10s，以便稳定触发 AbortError。 */
    const CLIENT_TIMEOUT_MS = 4000

    /** 安全解析：非 JSON 必须返回 null，而不是抛错。 */
    function safeJson(text) {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }

    /**
     * 一次探针请求。
     *
     * **用同源相对路径**（`/apradar-spike/...`）是刻意的：
     * 这正是要验证的东西 —— 页面来源与插件路由是否同源。
     */
    async function probe(path, options) {
      const opts = options || {}
      const timeoutMs = opts.timeoutMs || CLIENT_TIMEOUT_MS
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)

      try {
        const res = await fetch(ROUTE_PREFIX + path, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
          signal: controller.signal,
        })
        const text = await res.text()
        return {
          path,
          outcome: 'response',
          status: res.status,
          ok: res.ok,
          ms: Date.now() - started,
          contentType: res.headers.get('content-type') || '(无)',
          bodyPreview: text.slice(0, 300),
          parsed: safeJson(text),
          bodyLength: text.length,
        }
      } catch (error) {
        const aborted = error && error.name === 'AbortError'
        return {
          path,
          outcome: aborted ? 'timeout' : 'network-error',
          status: null,
          ok: false,
          ms: Date.now() - started,
          error: aborted
            ? 'AbortError（客户端 ' + timeoutMs + 'ms 主动超时）'
            : String((error && error.message) || error),
        }
      } finally {
        clearTimeout(timer)
      }
    }

    /** 把一次探针结果压成一句人话 —— 这就是「异常态可区分」的证据。 */
    function summarize(r) {
      if (!r) return '尚未执行'
      if (r.outcome === 'timeout') return '超时：' + r.error
      if (r.outcome === 'network-error') return '网络失败：' + r.error
      if (r.parsed === null) return 'HTTP ' + r.status + '，但响应不是 JSON（' + r.ms + 'ms）'
      if (!r.ok) return 'HTTP ' + r.status + ' · ' + (r.parsed.code || '(无 code)') + '（' + r.ms + 'ms）'
      return 'HTTP ' + r.status + ' · ' + (r.parsed.code || 'ok') + '（' + r.ms + 'ms）'
    }

    /** 探针清单：正常 / 5xx / 非 JSON / 超时 / 空体 / 404，一次覆盖全部四类判别。 */
    const PROBES = [
      { label: '正常 ping', path: '/ping' },
      { label: '错误码 500', path: '/boom' },
      { label: '200 但非 JSON', path: '/not-json' },
      { label: '超时', path: '/hang' },
      { label: '空响应体', path: '/empty' },
      { label: '404 路由', path: '/nope' },
    ]

    function OriginLine() {
      // V1 的核心对照：**页面来源**必须与插件路由的 host 一致，同源请求才成立。
      // token 是 DSH 自己的鉴权参数，不是本插件的，显示时裁掉。
      const href = String(window.location.href).replace(/([?&]token=)[^&]*/g, '$1<已隐藏>')
      return h(
        'div',
        {
          style: {
            padding: '8px 10px',
            borderRadius: 6,
            background: 'rgba(127,127,127,0.10)',
            fontSize: 11,
            lineHeight: 1.6,
            wordBreak: 'break-all',
          },
        },
        h('div', null, h('b', null, '页面来源：'), window.location.origin),
        h('div', null, h('b', null, '完整地址：'), href),
        h('div', null, h('b', null, '路由前缀：'), ROUTE_PREFIX),
      )
    }

    function SpikeBody() {
      const [rows, setRows] = React.useState([])
      const [busy, setBusy] = React.useState(false)

      const runAll = React.useCallback(async () => {
        setBusy(true)
        setRows([])
        const collected = []
        for (const spec of PROBES) {
          // 串行执行：并发会让「超时」这一项的耗时读数失真。
          const result = await probe(spec.path)
          collected.push({ label: spec.label, result })
          setRows(collected.slice())
        }
        setBusy(false)
      }, [])

      React.useEffect(() => {
        console.log('[apradar-spike] client mounted; page origin =', window.location.origin)
        runAll()
      }, [runAll])

      const style = {
        root: { padding: 10, fontSize: 12, display: 'flex', flexDirection: 'column', gap: 8 },
        btn: {
          padding: '6px 10px',
          borderRadius: 6,
          border: '1px solid rgba(127,127,127,0.35)',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 12,
        },
        row: {
          padding: '6px 8px',
          border: '1px solid rgba(127,127,127,0.25)',
          borderRadius: 6,
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        },
        label: { fontWeight: 600 },
        mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 10.5, wordBreak: 'break-all', opacity: 0.85 },
      }

      return h(
        'div',
        { style: style.root },
        h(OriginLine, null),
        h(
          'button',
          { type: 'button', style: style.btn, disabled: busy, onClick: runAll },
          busy ? '探测中…' : '重新运行全部探针',
        ),
        h(
          'div',
          { style: { opacity: 0.7, fontSize: 11 } },
          '结果同时打印到浏览器控制台（前缀 [apradar-spike]）。',
        ),
        rows.length === 0 && !busy
          ? h('div', { style: { opacity: 0.6 } }, '尚无结果。')
          : null,
        ...rows.map((row) =>
          h(
            'div',
            { key: row.label, style: style.row },
            h('div', { style: style.label }, row.label + ' — ' + summarize(row.result)),
            h('div', { style: style.mono }, 'GET ' + ROUTE_PREFIX + row.result.path),
            row.result.bodyPreview
              ? h('div', { style: style.mono }, 'body: ' + row.result.bodyPreview)
              : null,
          ),
        ),
      )
    }

    /** 右栏标题。必须是个返回字符串的函数（宿主按需调用）。 */
    function SpikeTitle() {
      return h('span', null, '产品雷达 Spike')
    }

    /** guide 里的图标：纯内联 SVG，不引外部资源。 */
    function SpikeGlyph() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 },
        h('circle', { cx: 8, cy: 8, r: 2 }),
        h('path', { d: 'M8 1v3M8 12v3M1 8h3M12 8h3' }),
      )
    }

    /** 侧栏入口按钮：比 guide 入口更直接，点一下就把面板打开。 */
    function makeEntryButton(getCtx) {
      return function EntryButton() {
        return h(
          'button',
          {
            type: 'button',
            title: '打开 AI 产品雷达技术验证面板',
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              padding: '2px 8px',
              borderRadius: 6,
              border: '1px solid rgba(127,127,127,0.35)',
              background: 'transparent',
              color: 'inherit',
              cursor: 'pointer',
              fontSize: 11,
            },
            onClick: () => {
              const ctx = getCtx()
              const sidebarRight = ctx && typeof ctx.get === 'function' ? ctx.get('sidebarRight') : null
              if (sidebarRight && typeof sidebarRight.openTab === 'function') {
                try {
                  sidebarRight.openTab(KIND)
                  console.log('[apradar-spike] openTab ok')
                } catch (error) {
                  console.warn('[apradar-spike] openTab failed', error)
                }
              } else {
                console.warn('[apradar-spike] sidebarRight.openTab 不可用')
              }
            },
          },
          '产品雷达 Spike',
        )
      }
    }

    module.exports.inject = ['slots']
    module.exports.apply = (ctx) => {
      console.log('[apradar-spike] client apply(); origin =', window.location.origin)

      // ① 独立入口：会话头部按钮。它不依赖 sidebarRightTabs 是否存在，
      //    因此即使右栏注册失败，也能在界面上看到本插件已经加载。
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: 'apradar-spike:entry',
            order: 90,
          },
          makeEntryButton(() => ctx),
        ),
      )

      // ② DSH 自带右侧栏（主路径）。`sidebarRightTabs` 缺席时子 fiber 只等待、不报错。
      ctx.inject(['sidebarRightTabs'], (srCtx) => {
        const tabs = srCtx.sidebarRightTabs
        if (!tabs || typeof tabs.register !== 'function') {
          console.warn('[apradar-spike] 官方右侧栏不可用 —— 页签未注册（这本身是一条 Spike 结论）')
          return
        }

        srCtx.effect(
          () =>
            tabs.register({
              id: TAB_ID,
              kind: KIND,
              priority: 'extension',
              title: () => '产品雷达 Spike',
              guide: [
                {
                  order: 90,
                  title: () => 'AI 产品雷达 · 技术验证',
                  description: () => '验证右栏注册与 Client→Host 同源请求',
                  icon: SpikeGlyph,
                },
              ],
            }),
          'dsh-apradar-spike: sidebar-right type',
        )

        srCtx.effect(
          () =>
            srCtx.slots.inject('sidebar.right.pane.tab', () =>
              srCtx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, SpikeBody),
            ),
          'dsh-apradar-spike: sidebar-right body',
        )

        srCtx.effect(
          () =>
            srCtx.slots.inject('sidebar.right.pane.tab.title', () =>
              srCtx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, SpikeTitle),
            ),
          'dsh-apradar-spike: sidebar-right title',
        )

        console.log('[apradar-spike] 官方右侧栏页签已注册：kind =', KIND)

        // 测试钩子（只存在于 Spike，绝不会进入正式插件）：让自动化探针在不依赖
        // 某一版 UI 具体按钮形态的前提下，走官方 sidebarRight.openTab() 打开面板。
        try {
          window.__apradarSpike = {
            kind: KIND,
            tabId: TAB_ID,
            openTab() {
              const sidebarRight = ctx.get('sidebarRight')
              if (!sidebarRight || typeof sidebarRight.openTab !== 'function') {
                return { ok: false, reason: 'sidebarRight.openTab 不可用' }
              }
              sidebarRight.openTab(KIND)
              return { ok: true }
            },
          }
          console.log('[apradar-spike] 测试钩子 window.__apradarSpike 已就绪')
        } catch (error) {
          console.warn('[apradar-spike] 测试钩子安装失败', error)
        }
      })
    }

    return module.exports
  },
})
