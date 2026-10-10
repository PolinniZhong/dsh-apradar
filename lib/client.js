/*
 * dsh-apradar@0.1.0 —— 客户端 bundle（生成产物，请勿手改）
 *
 * 由 scripts/build.mjs 从 src/client/client.js 生成。
 * 改客户端请改源文件，然后跑 `npm run build`。
 * 源内容指纹：35804a9e5169
 */
/**
 * AI 产品雷达 —— Client 半边。
 *
 * ## 写法约束（沿用本机已验证的手写客户端范式，见 `KNIT/AGENTS.md` §6.1）
 *
 *   - **无转译**：本文件已经是 loader bundle 本体，由
 *     `window.__ModuleLoader__.load({ id, factory })` 注册 factory
 *   - **禁止 JSX**：一律 `React.createElement`（这里别名为 `h`）
 *   - 只 `require` 装载器提供的基线模块；本文件只需要 `react`
 *   - 整个样式内联在一个模板串里，不引外部资源
 *
 * ## ⚠️ 改完必须构建（P1-07 起）
 *
 * npm 安装路径消费的是**包内**的客户端 bundle，约定位置是 `lib/client.js`
 * （`@deepseek-ai/dsh-client-modules` README：「宿主提供的是已构建的客户端 bundle……
 * 缺失 bundle 会明确导致激活失败」）。所以 `package.json` 的
 * `exports["./client"]` 指向 `./lib/client.js`，而 `lib/client.js` 由
 * `npm run build` 从本文件生成（`scripts/build-client.mjs`）。
 *
 * 这个「构建」**不转译、不打包、不引依赖**，就是一次带契约校验的复制 + 生成头 ——
 * 之所以仍然需要这一步，是因为「发布产物在哪个文件」需要一个确定的答案。
 * 忘了跑构建不会静默生效：`test/publish.test.mjs` 会比对源与产物，一旦不一致
 * 就直接失败（`npm run build:check` 也能单独查）。
 *
 * ## 职责边界（SDD §2）
 *
 * Client 只做呈现与用户操作：展示、搜索、筛选、导航、刷新、标记。
 * **不**直接访问任意外部网站、**不**操作宿主文件系统、**不**直接访问持久化
 * 后端 —— 它读到的每一个字节都来自同源的 `/apradar/*` 路由。
 *
 * ## 诚实性约束（PRD §非目标 / 用户硬约束）
 *
 *   - 页面上出现的每个数字、每段文字都来自 Host 的真实响应，**没有任何模拟数据**
 *   - 只有服务端返回成功才显示"已保存"；失败一律显示服务端给的原因
 *   - "刷新"是真的抓取；失败时明确显示失败来源与错误码，不用旧数据假装成功
 *   - 存储不可用时不显示空列表伪装成"没有变化"，而是显示失败原因
 *
 * ## 三个视图
 *
 *   1. **变化**（变化收件箱）—— 关注源上发现了什么变化，逐条判断、入池或忽略
 *   2. **关注源** —— 添加/启用/停用/测试/刷新来源，看清每个来源的状态与错误
 *   3. **机会池** —— 由变化沉淀出的产品机会，记录判断、待验证问题与下一步
 *
 * @module dsh-apradar/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-apradar',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /** 与 Host 半边约定的路由前缀（`src/host/http.js` 的 `ROUTE_PREFIX`）。 */
    const ROUTE_PREFIX = '/apradar'

    /** 右栏类型与页签标识。**与 Spike 的 `apradar-spike` 不同**，两者可共存。 */
    const KIND = 'apradar'
    const TAB_ID = 'dsh-apradar:main'

    /** 客户端主动超时：必须小于用户耐心，且让"超时"成为一个**可区分**的态。 */
    const CLIENT_TIMEOUT_MS = 5000
    /** 刷新是网络抓取，允许更久；但必须有上限，否则用户无法判断"卡住了"。 */
    const REFRESH_TIMEOUT_MS = 120000
    /** 导出只在本地拼字符串，但机会多时也要留够时间；10 秒足够，也不会让界面一直停在「导出中…」。 */
    const EXPORT_TIMEOUT_MS = 10000
    /**
     * 列表每页条数。
     *
     * 右栏只有 648px 宽，20 条已经要滚一段；再大只会让「下一页」形同虚设。
     * 这个值同时被 `load()` 与分页控件的位移量使用 —— 两处不一致会让「下一页」
     * 跳过或重复条目，所以只能有一个来源。
     */
    const PAGE_SIZE = 20

    /** 变化状态的展示文案。未知状态原样显示，绝不猜测。 */
    const CHANGE_STATUS_LABEL = {
      unread: '未读',
      seen: '已读',
      ignored: '已忽略',
      pooled: '已入池',
    }
    /** 变化类型的展示文案。 */
    const CHANGE_KIND_LABEL = {
      added: '新增',
      removed: '移除',
      modified: '修改',
      summary: '汇总',
    }
    /** 机会状态的展示文案。 */
    const OPPORTUNITY_STATUS_LABEL = {
      to_research: '待研究',
      verifying: '验证中',
      planned: '已立项',
      dropped: '已放弃',
    }
    /** 来源状态的展示文案。 */
    const SOURCE_STATUS_LABEL = {
      never: '尚未抓取',
      ok: '正常',
      failed: '抓取失败',
      disabled: '已停用',
    }

    const CSS = `
.apr-root {
  --apr-fg: var(--dsw-alias-label-primary, #1b1f26);
  --apr-fg-2: var(--dsw-alias-label-secondary, #4a5261);
  --apr-caption: var(--dsw-alias-label-caption, #8a93a3);
  --apr-line: var(--dsw-alias-border-l3, rgba(0, 0, 0, 0.12));
  --apr-line-2: var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.07));
  --apr-hover: rgba(38, 49, 72, 0.024);
  --apr-active: rgba(38, 49, 72, 0.061);
  --apr-accent: var(--dsw-alias-brand-primary-new-colorprimary-new-color, #4176e6);
  --apr-danger: var(--dsw-alias-state-error-primary, #ba2723);
  --apr-warn: var(--dsw-alias-state-warning-primary, #a06400);
  --apr-ok: var(--dsw-alias-state-success-primary, #1a7f45);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  color: var(--apr-fg);
  font-size: 13px;
}
body[data-ds-dark-theme] .apr-root {
  --apr-hover: rgba(255, 255, 255, 0.028);
  --apr-active: rgba(255, 255, 255, 0.076);
  --apr-caption: var(--dsw-alias-label-caption, #98a2b3);
}
.apr-grow { flex: 1 1 auto; min-width: 0; }
.apr-bar { display: flex; align-items: center; gap: 8px; padding: 0 12px 8px; flex: none; flex-wrap: wrap; }
.apr-tabs { display: flex; gap: 2px; padding: 6px 12px 0; flex: none; border-bottom: 0.5px solid var(--apr-line); }
.apr-tab {
  appearance: none; border: 0; background: transparent; color: var(--apr-caption);
  font-family: inherit; font-size: 12.5px; padding: 7px 9px; cursor: pointer;
  border-bottom: 1.5px solid transparent; margin-bottom: -0.5px;
  display: inline-flex; align-items: center; gap: 5px;
}
.apr-tab:hover { color: var(--apr-fg-2); }
.apr-tab.is-active { color: var(--apr-fg); border-bottom-color: var(--apr-accent); font-weight: 500; }
.apr-count { font-size: 10.5px; color: var(--apr-caption); background: var(--apr-active); border-radius: 8px; padding: 0 5px; line-height: 15px; }
.apr-btn {
  height: 28px; padding: 0 10px; border-radius: 8px; font-size: 12px;
  border: 0.5px solid var(--apr-line); background: transparent; color: var(--apr-fg-2);
  cursor: pointer; font-family: inherit; white-space: nowrap;
}
.apr-btn:hover { background: var(--apr-hover); }
.apr-btn:active { background: var(--apr-active); }
.apr-btn:focus-visible { outline: 1px solid var(--apr-accent); outline-offset: 1px; }
.apr-btn[disabled] { opacity: 0.5; cursor: default; }
.apr-btn.is-primary { border-color: transparent; background: var(--apr-accent); color: #fff; }
.apr-btn.is-primary:hover { filter: brightness(1.06); }
.apr-btn.is-danger { color: var(--apr-danger); }
.apr-btn.is-sm { height: 24px; padding: 0 8px; font-size: 11.5px; border-radius: 6px; }
.apr-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; padding: 10px 12px 14px; }
.apr-kv { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 10px; margin: 0 0 12px; }
.apr-kv dt { color: var(--apr-caption); font-size: 11px; }
.apr-kv dd { margin: 0; font-size: 12px; word-break: break-all; }
.apr-note { font-size: 12px; line-height: 1.55; color: var(--apr-fg-2); border-left: 2px solid var(--apr-line); padding-left: 9px; margin: 0 0 12px; }
.apr-note.is-error { border-left-color: var(--apr-danger); color: var(--apr-danger); }
.apr-note.is-warn { border-left-color: var(--apr-warn); color: var(--apr-warn); }
.apr-pre {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-word; margin: 0;
  border: 0.5px solid var(--apr-line); border-radius: 10px; padding: 9px 10px;
}
.apr-pre.is-scroll { max-height: 320px; overflow: auto; }
.apr-section-title { font-size: 12.5px; font-weight: 500; margin: 16px 0 8px; }
.apr-empty { color: var(--apr-caption); font-size: 12px; line-height: 1.6; }
.apr-list { display: flex; flex-direction: column; gap: 6px; }
.apr-row {
  border: 0.5px solid var(--apr-line); border-radius: 10px; padding: 9px 10px;
  cursor: pointer; background: transparent; text-align: left; font-family: inherit; color: inherit;
  display: block; width: 100%;
}
.apr-row:hover { background: var(--apr-hover); }
.apr-row.is-active { border-color: var(--apr-accent); background: var(--apr-hover); }
.apr-row-top { display: flex; align-items: center; gap: 6px; margin-bottom: 4px; flex-wrap: wrap; }
.apr-row-title { font-size: 12.5px; font-weight: 500; line-height: 1.45; }
.apr-row-sub { font-size: 11px; color: var(--apr-caption); margin-top: 3px; }
.apr-badge {
  font-size: 10.5px; line-height: 15px; padding: 0 5px; border-radius: 6px;
  border: 0.5px solid var(--apr-line); color: var(--apr-caption); white-space: nowrap;
}
.apr-badge.is-add { color: var(--apr-ok); border-color: currentColor; }
.apr-badge.is-del { color: var(--apr-danger); border-color: currentColor; }
.apr-badge.is-mod { color: var(--apr-warn); border-color: currentColor; }
.apr-badge.is-warn { color: var(--apr-warn); border-color: currentColor; }
.apr-badge.is-unread { color: var(--apr-accent); border-color: currentColor; }
.apr-fields { display: flex; flex-direction: column; gap: 8px; margin: 0 0 10px; }
.apr-field { display: flex; flex-direction: column; gap: 3px; }
.apr-label { font-size: 11px; color: var(--apr-caption); }
.apr-input, .apr-select, .apr-area {
  width: 100%; box-sizing: border-box; font-family: inherit; font-size: 12px;
  color: var(--apr-fg); background: transparent; border: 0.5px solid var(--apr-line);
  border-radius: 8px; padding: 6px 8px;
}
.apr-area { min-height: 62px; resize: vertical; line-height: 1.5; }
.apr-input:focus-visible, .apr-select:focus-visible, .apr-area:focus-visible { outline: 1px solid var(--apr-accent); outline-offset: 0; }
.apr-hint { font-size: 11px; color: var(--apr-caption); line-height: 1.5; }
.apr-actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.apr-card { border: 0.5px solid var(--apr-line); border-radius: 10px; padding: 10px; margin-bottom: 10px; }
.apr-diff { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; }
.apr-diff-line { white-space: pre-wrap; word-break: break-word; padding: 1px 4px; border-radius: 3px; }
.apr-diff-line.is-add { background: rgba(26, 127, 69, 0.12); }
.apr-diff-line.is-del { background: rgba(186, 39, 35, 0.12); }
.apr-quote { margin: 0; padding: 8px 10px; border-left: 2px solid var(--apr-line); font-size: 12px; line-height: 1.6; white-space: pre-wrap; word-break: break-word; color: var(--apr-fg-2); max-height: 260px; overflow-y: auto; }
.apr-link { color: var(--apr-accent); text-decoration: none; }
.apr-link:hover { text-decoration: underline; }
.apr-status { font-size: 11.5px; color: var(--apr-caption); line-height: 1.5; }
.apr-status.is-error { color: var(--apr-danger); }
.apr-status.is-ok { color: var(--apr-ok); }
.apr-inline { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.apr-sep { height: 0.5px; background: var(--apr-line); margin: 12px 0; }

/*
 * 详情页的返回栏。列表与详情都在同一个面板里切换，不新开 DSH 侧栏页签 ——
 * 三个视图各自只有一个详情槽位，返回就是回到本视图的列表。
 */
.apr-crumb { display: flex; align-items: center; gap: 8px; margin: 0 0 8px; flex-wrap: wrap; }
.apr-crumb-label { font-size: 12.5px; font-weight: 500; }

/*
 * 行内"进入详情"的按钮：看着像标题，行为像链接，但它真的是 <button>，
 * 所以 Tab 能走到、回车能打开、有可见焦点。行上的刷新/删除等操作是它的**兄弟**
 * 而不是子节点，因此不会因为事件冒泡被误触发。
 */
.apr-rowlink {
  appearance: none; border: 0; background: transparent; padding: 0; margin: 0;
  font-family: inherit; font-size: 12.5px; font-weight: 500; line-height: 1.45;
  color: inherit; text-align: left; cursor: pointer; border-radius: 4px;
}
.apr-rowlink:hover { color: var(--apr-accent); }
.apr-rowlink[disabled] { cursor: default; opacity: 0.6; }
.apr-row:focus-visible, .apr-rowlink:focus-visible { outline: 1px solid var(--apr-accent); outline-offset: 2px; }
.apr-pager { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.apr-only-print { display: none; }
`

    // ---------------------------------------------------------------- 基础工具

    /** 安全解析：非 JSON 必须返回 `null`，而不是抛错 —— "200 但不是 JSON" 是必须能被区分的失败态。 */
    function safeJson(text) {
      try {
        return JSON.parse(text)
      } catch {
        return null
      }
    }

    /**
     * 一次同源请求。
     *
     * **相对路径**（`/apradar/...`）是刻意的：页面来源与插件路由必须同源，
     * 这一点已在 `TECH-SPIKE.md` §6 于 Desktop 与隔离 Web Profile 两处实测过。
     *
     * **永不抛出**：所有失败都归一成 `{ ok: false, ... }`，因为调用方必须能
     * 区分"网络失败 / 超时 / 服务端拒绝 / 不是 JSON"四种情况并把原因显示出来。
     *
     * @param {string} path 前缀之后的路由
     * @param {{method?: string, body?: unknown, timeoutMs?: number}} [options]
     * @returns {Promise<object>} `{ok:true,data,ms}` 或 `{ok:false,outcome,status,code,message,detail}`
     */
    async function api(path, options = {}) {
      const method = options.method ?? 'GET'
      const timeoutMs = options.timeoutMs ?? CLIENT_TIMEOUT_MS
      const started = Date.now()
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const init = { method, headers: { accept: 'application/json' }, cache: 'no-store', signal: controller.signal }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const url = ROUTE_PREFIX + path
      try {
        const res = await fetch(url, init)
        const text = await res.text()
        const ms = Date.now() - started
        const json = safeJson(text)
        if (json === null) {
          return { ok: false, outcome: res.ok ? 'not-json' : 'http-error', status: res.status, ms, url, message: `响应不是 JSON（${res.headers.get('content-type') || '无 content-type'}）`, text }
        }
        if (json.ok === true) return { ok: true, status: res.status, ms, url, data: json.data }
        const error = json.error ?? {}
        return { ok: false, outcome: 'http-error', status: res.status, ms, url, code: error.code ?? 'UNKNOWN', message: error.message ?? '服务端返回了失败，但没有给出原因', detail: error.detail }
      } catch (error) {
        const ms = Date.now() - started
        const aborted = error?.name === 'AbortError'
        return {
          ok: false,
          outcome: aborted ? 'timeout' : 'network-error',
          ms,
          url,
          message: aborted ? `超过 ${timeoutMs} ms 未返回，已中止` : `请求未能完成：${String(error?.message ?? error)}`,
        }
      } finally {
        clearTimeout(timer)
      }
    }

    /** 把失败结果压成一句话。 */
    /**
     * 把一条返回 Markdown 的插件路由存成文件（P1-05）。
     *
     * 走 `fetch` 而不是 `api()`：导出**不是** JSON 信封，`api()` 会把一个完全
     * 正常的 `text/markdown` 响应判成「响应不是 JSON」的失败。失败时服务端回的
     * 仍然是 JSON 信封，所以两种载体都要处理。
     *
     * 落盘用 Blob + 一个临时 `<a download>`，**不经过任何后端写文件** ——
     * 插件永远不碰用户的项目目录，保存位置由用户自己决定。
     */
    async function downloadMarkdown(path) {
      const url = ROUTE_PREFIX + path
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), EXPORT_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          headers: { accept: 'text/markdown, application/json' },
          cache: 'no-store',
          signal: controller.signal,
        })
        const text = await res.text()
        if (!res.ok) {
          const json = safeJson(text)
          const failure = json?.error ?? {}
          return {
            ok: false,
            code: failure.code ?? `HTTP_${res.status}`,
            message: failure.message ?? `导出失败（HTTP ${res.status}）`,
          }
        }
        const disposition = res.headers.get('content-disposition') ?? ''
        const matched = /filename="([^"]+)"/.exec(disposition)
        const filename = matched ? matched[1] : 'ai-product-radar-export.md'
        const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
        const href = URL.createObjectURL(blob)
        const anchor = document.createElement('a')
        anchor.href = href
        anchor.download = filename
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
        setTimeout(() => URL.revokeObjectURL(href), 10000)
        return { ok: true, filename, bytes: text.length }
      } catch (error) {
        const aborted = error?.name === 'AbortError'
        return { ok: false, message: aborted ? '导出超时' : `导出失败：${error?.message ?? String(error)}` }
      } finally {
        clearTimeout(timer)
      }
    }

    function failText(result) {
      if (!result) return ''
      const parts = [result.message]
      if (result.code) parts.push(`（${result.code}）`)
      if (result.detail !== undefined) {
        const detail = typeof result.detail === 'string' ? result.detail : JSON.stringify(result.detail)
        if (detail && detail !== '{}') parts.push(` ${detail}`)
      }
      return parts.join('')
    }

    /**
     * 时间值的统一归一。
     *
     * 必须同时接受两种形态，因为宿主返回的不是同一种：
     *   - 列表/变化记录里的时间戳是 epoch 毫秒（来自存储层的 `now()`）
     *   - `storage` 块里的 `firstOpenedAt` / `lastOpenedAt` / `lastRefreshAt` 是 ISO 字符串
     * 之前这里只认 number，于是"已打开 N 次，最近一次 —，上次刷新 —"永远显示破折号：
     * 数字判断把真时间当成了缺值，界面在撒谎说"没有时间"，而不是"我读不懂这个格式"。
     */
    function toEpochMs(value) {
      if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
      if (typeof value === 'string' && value) {
        const ms = Date.parse(value)
        return Number.isFinite(ms) && ms > 0 ? ms : null
      }
      return null
    }

    /** 时间戳（epoch 毫秒或 ISO 字符串）→ 本地可读时间；读不懂就返回 null，不编造时间。 */
    function fmtTime(value) {
      const ms = toEpochMs(value)
      if (ms === null) return null
      const d = new Date(ms)
      if (Number.isNaN(d.getTime())) return null
      const pad = (n) => String(n).padStart(2, '0')
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
    }

    /** 相对时间：只在能确定时给出，避免"刚刚"掩盖真实时间戳。 */
    function fmtAgo(value) {
      const ms = toEpochMs(value)
      if (ms === null) return ''
      const diff = Date.now() - ms
      if (diff < 0) return fmtTime(value) ?? ''
      const min = Math.floor(diff / 60000)
      if (min < 1) return '刚刚'
      if (min < 60) return `${min} 分钟前`
      const hour = Math.floor(min / 60)
      if (hour < 24) return `${hour} 小时前`
      const day = Math.floor(hour / 24)
      if (day < 30) return `${day} 天前`
      return fmtTime(value) ?? ''
    }

    /** 空值统一的显示形式。 */
    function orDash(value) {
      return value === null || value === undefined || value === '' ? '—' : String(value)
    }

    /**
     * 定时刷新间隔的可选项（分钟）。`0` 表示关闭。
     *
     * 15 / 1440 是本插件 `limits.js` 里写死的夹取边界 —— 界面只提供合法值，
     * 服务端仍然会再夹一次（集成方可能不经过界面）。这里的值刻意不写"每 5 分钟"
     * 之类的激进档位：对一个要去抓别人网站的工具，礼貌比及时更重要。
     */
    const INTERVAL_OPTIONS = [
      { value: 0, label: '关闭定时刷新' },
      { value: 15, label: '每 15 分钟' },
      { value: 30, label: '每 30 分钟' },
      { value: 60, label: '每 1 小时' },
      { value: 180, label: '每 3 小时' },
      { value: 360, label: '每 6 小时' },
      { value: 720, label: '每 12 小时' },
      { value: 1440, label: '每 24 小时' },
    ]

    /**
     * 下一次定时刷新"大约"在什么时候（epoch 毫秒）；无法确定时返回 `null`。
     *
     * 返回 `null` 有两种情况，界面必须区别对待：
     *   · 没开启定时（`intervalMinutes <= 0`）→ 说「未开启」；
     *   · 开启了但**从未检查过**（`lastCheckedAt` 缺失）→ 不能说"下次在某个时刻"，
     *     因为调度器下一秒就会抓它。这种情况由调用方显示「等待首次检查」。
     *
     * 刻意不叫 `nextRunAt`：调度器是一个 60 秒粒度的循环，真实执行时刻会晚一点，
     * 名字里带"大约"才诚实。
     */
    function nextRunAt(source) {
      const minutes = Number(source?.intervalMinutes)
      if (!Number.isFinite(minutes) || minutes <= 0) return null
      const last = toEpochMs(source?.lastCheckedAt)
      if (last === null) return null
      return last + minutes * 60000
    }

    // ---------------------------------------------------------------- 小部件

    /** 通用按钮。 */
    function Btn({ label, onClick, disabled, variant, size, title }) {
      const cls = ['apr-btn']
      if (variant === 'primary') cls.push('is-primary')
      if (variant === 'danger') cls.push('is-danger')
      if (size === 'sm') cls.push('is-sm')
      return h('button', { className: cls.join(' '), type: 'button', disabled: disabled === true, onClick, title }, label)
    }

    /** 带标签的表单控件。 */
    function Field({ label, hint, children }) {
      return h('label', { className: 'apr-field' }, h('span', { className: 'apr-label' }, label), children, hint ? h('span', { className: 'apr-hint' }, hint) : null)
    }

    /** 一个状态徽标。 */
    function Badge({ text, tone }) {
      const cls = ['apr-badge']
      if (tone) cls.push(`is-${tone}`)
      return h('span', { className: cls.join(' ') }, text)
    }

    /** 失败提示条。 */
    function ErrorNote({ text }) {
      return h('p', { className: 'apr-note is-error' }, text)
    }

    // ---------------------------------------------------------------- 变化视图

    /** 变化收件箱。 */
    function InboxView({ counts, onCounts, storageOk, meta, slice, patchSlice, openDetail, back }) {
      /**
       * 搜索词、筛选、分页位置**不存在这里**，而是存在面板层的导航状态里。
       *
       * 原因：从一条变化跳到它的机会时，本组件会卸载；回到变化列表时如果这些
       * 存在组件内，就会被重置成默认值 —— 用户会发现自己"返回后回到了另一个地方"。
       * 放进导航状态之后，连跨视图跳转也能原样恢复。
       */
      const status = slice.status
      const query = slice.query
      const offset = slice.offset ?? 0
      const [page, setPage] = React.useState({ total: 0, items: [], offset: 0, limit: 20 })
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [refreshReport, setRefreshReport] = React.useState(null)

      const load = React.useCallback(async () => {
        setBusy(true)
        setError('')
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
        if (status !== 'all') params.set('status', status)
        if (query.trim()) params.set('q', query.trim())
        const result = await api(`/changes?${params.toString()}`)
        if (result.ok) {
          setPage(result.data)
          // 告诉外壳"这一页的内容到位了"，它才好把离开前的滚动位置写回来。
          patchSlice('inbox', { loadedAt: Date.now() })
        } else {
          setError(failText(result))
        }
        setBusy(false)
      }, [status, query, offset, patchSlice])

      React.useEffect(() => {
        void load()
      }, [load])

      const syncCounts = React.useCallback(async () => {
        const result = await api('/changes?status=unread&limit=1')
        if (result.ok) onCounts({ unreadChanges: result.data.total })
      }, [onCounts])

      React.useEffect(() => {
        void syncCounts()
      }, [syncCounts])

      const refreshAll = React.useCallback(async () => {
        setBusy(true)
        setError('')
        setRefreshReport(null)
        const result = await api('/refresh', { method: 'POST', body: {}, timeoutMs: REFRESH_TIMEOUT_MS })
        if (result.ok) {
          setRefreshReport(result.data)
          await load()
          await syncCounts()
        } else {
          setError(failText(result))
        }
        setBusy(false)
      }, [load, syncCounts])

      const rows = page.items ?? []

      // 详情打开时**只渲染详情**：列表不在下面接着排，否则"详情"只是列表末尾的
      // 一块内容，用户得自己滚下去找，返回也无从谈起。
      if (slice.detailId) {
        return h(ChangeDetail, {
          id: slice.detailId,
          meta,
          onBack: back,
          onChanged: async () => {
            await load()
            await syncCounts()
          },
          onOpenOpportunity: (id) => openDetail('opps', id),
        })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'apr-bar', style: { padding: '0 0 8px' } },
          h(
            'select',
            {
              className: 'apr-select',
              style: { width: 'auto' },
              value: status,
              'aria-label': '按处理状态筛选',
              onChange: (event) => patchSlice('inbox', { status: event.target.value, offset: 0 }),
              disabled: busy,
            },
            h('option', { value: 'unread' }, '未读'),
            h('option', { value: 'seen' }, '已读'),
            h('option', { value: 'ignored' }, '已忽略'),
            h('option', { value: 'pooled' }, '已入池'),
            h('option', { value: 'all' }, '全部'),
          ),
          h('input', {
            className: 'apr-input',
            style: { flex: '1 1 120px', width: 'auto' },
            placeholder: '搜索标题、摘要、备注',
            'aria-label': '搜索变化',
            value: query,
            onChange: (event) => patchSlice('inbox', { query: event.target.value, offset: 0 }),
            onKeyDown: (event) => {
              if (event.key === 'Enter') void load()
            },
          }),
          h(Btn, { label: busy ? '读取中…' : '查询', onClick: () => void load(), disabled: busy, size: 'sm' }),
          h(Btn, { label: busy ? '刷新中…' : '刷新全部来源', onClick: () => void refreshAll(), disabled: busy, variant: 'primary', size: 'sm' }),
        ),

        refreshReport ? RefreshReport({ report: refreshReport }) : null,
        error ? ErrorNote({ text: error }) : null,
        !storageOk ? h('p', { className: 'apr-note is-warn' }, '存储当前不可用，下面的列表可能不是完整的历史记录。') : null,

        busy && rows.length === 0 ? h('p', { className: 'apr-empty' }, '读取中…') : null,
        !busy && rows.length === 0 && !error
          ? h(
              'p',
              { className: 'apr-empty' },
              status === 'unread' ? '没有未读变化。上方可以点「刷新全部来源」去抓一次。' : '这个筛选条件下没有记录。',
            )
          : null,

        h(
          'div',
          { className: 'apr-list' },
          rows.map((row) =>
            h(
              'button',
              {
                key: row.id,
                className: 'apr-row',
                type: 'button',
                'aria-label': `打开变化详情：${row.title ?? ''}`,
                onClick: () => openDetail('inbox', row.id),
              },
              h(
                'div',
                { className: 'apr-row-top' },
                h(Badge, { text: CHANGE_KIND_LABEL[row.kind] ?? row.kind, tone: row.kind === 'added' ? 'add' : row.kind === 'removed' ? 'del' : row.kind === 'modified' ? 'mod' : undefined }),
                row.status === 'unread' ? h(Badge, { text: '未读', tone: 'unread' }) : h(Badge, { text: CHANGE_STATUS_LABEL[row.status] ?? row.status }),
                h('span', { className: 'apr-grow' }),
                h('span', { className: 'apr-row-sub' }, fmtAgo(row.discoveredAt)),
              ),
              h('div', { className: 'apr-row-title' }, orDash(row.title)),
              h('div', { className: 'apr-row-sub' }, `${row.sourceName} · ${row.diffSummary}`),
              h('div', { className: 'apr-row-sub' }, '打开详情 ›'),
            ),
          ),
        ),

        page.total > 0
          ? h(
              'div',
              { className: 'apr-pager' },
              h(
                'span',
                { className: 'apr-status' },
                `共 ${page.total} 条${rows.length ? `，本次显示第 ${offset + 1}–${offset + rows.length} 条` : ''}`,
              ),
              h(Btn, {
                label: '上一页',
                size: 'sm',
                disabled: busy || offset === 0,
                onClick: () => patchSlice('inbox', { offset: Math.max(0, offset - PAGE_SIZE) }),
              }),
              h(Btn, {
                label: '下一页',
                size: 'sm',
                disabled: busy || offset + rows.length >= page.total,
                onClick: () => patchSlice('inbox', { offset: offset + PAGE_SIZE }),
              }),
            )
          : null,
      )
    }

    /** 刷新报告的呈现：每个来源的结果都要能看见，不能只有一个"成功"。 */
    function RefreshReport({ report }) {
      const summary = report.summary ?? {}
      return h(
        'div',
        { className: 'apr-card' },
        h(
          'div',
          { className: 'apr-inline' },
          h('strong', null, '刷新结果'),
          h('span', { className: 'apr-status' }, `${summary.succeeded ?? 0} 个成功 · ${summary.failed ?? 0} 个失败 · ${summary.skipped ?? 0} 个跳过 · 新增 ${summary.newChanges ?? 0} 条变化`),
        ),
        summary.truncated > 0
          ? h('p', { className: 'apr-note is-warn' }, `有 ${summary.truncated} 个来源的响应被宿主截断，这些来源的结论不完整。`)
          : null,
        ...(report.results ?? []).map((entry) =>
          h(
            'div',
            { key: entry.sourceId, className: 'apr-row-sub' },
            `${entry.ok ? '✓' : entry.skipped ? '–' : '✗'} ${entry.name}${entry.skipped ? `（${entry.reason ?? '跳过'}）` : entry.ok ? `（新增 ${entry.newChanges ?? 0} 条）` : `：${entry.error?.message ?? '失败'}`}`,
          ),
        ),
      )
    }

    /** 一条变化的详情。 */
    function ChangeDetail({ id, meta, onBack, onChanged, onOpenOpportunity }) {
      const [detail, setDetail] = React.useState(null)
      const [error, setError] = React.useState('')
      const [note, setNote] = React.useState('')
      const [status, setStatus] = React.useState('')
      const [saveState, setSaveState] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [poolState, setPoolState] = React.useState('')

      const load = React.useCallback(async () => {
        setBusy(true)
        setError('')
        const result = await api(`/changes/${encodeURIComponent(id)}`)
        if (result.ok) {
          setDetail(result.data)
          setNote(result.data.change.userNote ?? '')
          setStatus(result.data.change.status)
        } else {
          setError(failText(result))
        }
        setBusy(false)
      }, [id])

      React.useEffect(() => {
        void load()
      }, [load])

      const patch = React.useCallback(
        async (body, after) => {
          setSaveState('保存中…')
          const result = await api(`/changes/${encodeURIComponent(id)}`, { method: 'PATCH', body })
          if (result.ok) {
            setDetail((prev) => (prev ? { ...prev, change: result.data } : prev))
            setStatus(result.data.status)
            setSaveState('已保存')
            if (after) await after()
          } else {
            // 只有服务端返回成功才说"已保存"。
            setSaveState(`保存失败：${failText(result)}`)
          }
        },
        [id],
      )

      const createOpportunity = React.useCallback(async () => {
        setPoolState('创建中…')
        const change = detail?.change
        const result = await api('/opportunities', {
          method: 'POST',
          body: {
            // 必须带上 changeId：服务端据此把这条变化标记为已入池并回写 opportunityId。
            // 只发标题不建立链接的话，机会池里那条记录看不出它是从哪条变化来的，
            // 变化这边也指不回机会 —— 两个方向都断了，而且看不出是断了（看起来只是没填）。
            changeId: change?.id,
            title: (change?.title ?? '').slice(0, 200) || '未命名机会',
            projectRef: change?.sourceUrl ?? '',
            judgment: `${change?.sourceName ?? ''} 的这条变化是否意味着一个产品机会？`,
            questions: [],
          },
        })
        if (result.ok) {
          setPoolState(`已创建机会：${result.data.title}`)
          await load()
          if (onChanged) await onChanged()
        } else {
          setPoolState(`创建失败：${failText(result)}`)
        }
      }, [detail, load, onChanged])

      /**
       * 返回栏在**每种状态**下都要在：读取中、读取失败、没有这条记录时，
       * 用户同样需要一个明确的出口，否则详情就是一个死胡同（尤其是点了一条
       * 已经被清理掉的变化之后）。
       */
      const crumb = h(
        'div',
        { className: 'apr-crumb' },
        h(Btn, { label: '‹ 返回变化列表', size: 'sm', onClick: onBack }),
      )

      if (busy && !detail) return h('div', null, crumb, h('p', { className: 'apr-empty' }, '读取详情…'))
      if (error) {
        return h(
          'div',
          null,
          crumb,
          ErrorNote({ text: `这条变化读不出来：${error}` }),
          h('p', { className: 'apr-hint' }, '它可能已经被清理掉了（快照与变化有容量上限，超过后旧记录会被删除）。返回列表可以看到仍然存在的记录。'),
          h(Btn, { label: '重试', onClick: () => void load(), size: 'sm' }),
        )
      }
      if (!detail) return h('div', null, crumb)

      const change = detail.change
      const diff = change.diffDetail ?? { added: [], removed: [], modified: [] }
      const diffCount = (diff.added?.length ?? 0) + (diff.removed?.length ?? 0) + (diff.modified?.length ?? 0)
      const maxDiffItems = meta?.limits?.maxDiffItems
      const diffMaybeCapped = typeof maxDiffItems === 'number' && maxDiffItems > 0 && diffCount >= maxDiffItems

      return h(
        'div',
        null,
        crumb,
        h('div', { className: 'apr-card' },
        h('h2', { className: 'apr-section-title', style: { marginTop: 0 } }, orDash(change.title)),
        h(
          'dl',
          { className: 'apr-kv' },
          h('dt', null, '来源'),
          h(
            'dd',
            null,
            change.sourceUrl
              ? h('a', { className: 'apr-link', href: change.sourceUrl, target: '_blank', rel: 'noopener noreferrer' }, change.sourceName)
              : change.sourceName,
            change.sourceType ? h('span', { className: 'apr-row-sub' }, `　${change.sourceType}`) : null,
          ),
          h('dt', null, '类型'),
          h('dd', null, `${CHANGE_KIND_LABEL[change.kind] ?? change.kind} · ${change.diffSummary}`),
          h('dt', null, '官方发布时间'),
          /*
           * 发布时间**不是**发现时间。很多 Feed 不给 published，那时必须写
           * 「未能获取」—— 拿发现时间冒充发布时间会让"这条东西是什么时候发的"
           * 这个判断变成一个我们编出来的数字。
           */
          h(
            'dd',
            null,
            toEpochMs(change.publishedAt) === null
              ? '未能获取（来源没有提供发布时间）'
              : `${orDash(fmtTime(change.publishedAt))}（${fmtAgo(change.publishedAt)}）`,
          ),
          h('dt', null, '本次发现'),
          h('dd', null, `${orDash(fmtTime(change.discoveredAt))}（${fmtAgo(change.discoveredAt)}）`),
          h('dt', null, '处理状态'),
          h('dd', null, CHANGE_STATUS_LABEL[change.status] ?? change.status),
          h('dt', null, '条目链接'),
          h(
            'dd',
            null,
            change.itemUrl
              ? h('a', { className: 'apr-link', href: change.itemUrl, target: '_blank', rel: 'noopener noreferrer' }, change.itemUrl)
              : '这条记录没有单独的条目地址，请用上面的来源地址核实。',
          ),
          h('dt', null, '快照'),
          h('dd', null, detail.snapshot ? `${orDash(fmtTime(detail.snapshot.fetchedAt))} · ${detail.snapshot.itemCount ?? 0} 条${detail.snapshot.baseline ? ' · 首次基线' : ''}` : '—'),
          h('dt', null, '上一份快照'),
          h('dd', null, detail.previousSnapshot ? `${orDash(fmtTime(detail.previousSnapshot.fetchedAt))} · ${detail.previousSnapshot.itemCount ?? 0} 条` : '（首次抓取，没有可比较的上一版）'),
        ),

        h('div', { className: 'apr-section-title' }, '原文摘录'),
        h('blockquote', { className: 'apr-quote' }, change.excerpt || '来源没有提供可展示的正文。请打开来源页面核实，不要用模型生成的内容代替原文。'),
        change.truncated
          ? h(
              'p',
              { className: 'apr-note is-warn' },
              '本次抓取的响应被宿主截断，上面不是全文，差异也**只是已取回部分**的结果 —— 不能据此断言条目被删除。',
            )
          : null,

        /*
         * 差异区要把三种"没有内容可展示"分开说，因为它们的含义完全不同：
         *   · 没有上一份快照 → 没有可比较的基准，不是"没有变化"；
         *   · 有基准但差异为空 → 真的没有变化；
         *   · 差异列表顶到上限 → 这里只是**下限**，不能读成"就这么多"。
         * 混成一句"无差异"会把前两种说成第三种，那是我们无权做的断言。
         */
        h('div', { className: 'apr-section-title' }, '与上一份快照的差异'),
        !detail.previousSnapshot && diffCount === 0
          ? h('p', { className: 'apr-note' }, '没有可比较的上一版：这是该来源的首次抓取，或上一份快照已经被清理。')
          : !diffCount
            ? h('p', { className: 'apr-note' }, '条目没有变化（与上一份快照的条目集合与指纹都一致）。')
            : h(
                'div',
                { className: 'apr-diff' },
                diff.added.map((line, i) => h('div', { key: `a${i}`, className: 'apr-diff-line is-add' }, `+ ${line}`)),
                diff.removed.map((line, i) => h('div', { key: `d${i}`, className: 'apr-diff-line is-del' }, `- ${line}`)),
                diff.modified.map((line, i) => h('div', { key: `m${i}`, className: 'apr-diff-line' }, `~ ${line}`)),
              ),
        diffCount
          ? h(
              'p',
              { className: 'apr-hint' },
              `共 ${diff.added.length} 条新增 · ${diff.removed.length} 条移除 · ${diff.modified.length} 条修改${diffMaybeCapped ? `（差异列表已达到 ${maxDiffItems} 条的上限，实际变化可能更多，这里只是下限）` : ''}`,
            )
          : null,
        /*
         * 内容保留等级必须说出来。`retention: 'excerpt'` 的快照只留了条目摘录，
         * 不是全文 —— 这种快照上的差异是按保留下来的条目集合与指纹算的，拿它当
         * "全文对比"的结论就是在伪造差异。
         */
        detail.snapshot?.retention === 'excerpt' || detail.previousSnapshot?.retention === 'excerpt'
          ? h(
              'p',
              { className: 'apr-note' },
              '这里至少有一份快照只保留了摘录而不是全文，差异是按保留下来的条目集合与指纹算出来的，正文级别的对比可能不完整。',
            )
          : null,

        /*
         * 关联机会。关联**只看 `change.opportunityId`**，绝不按标题相同来推断 ——
         * 两条不同来源的标题一模一样是常事。没有关联时明说，而不是留一个空入口。
         */
        h('div', { className: 'apr-section-title' }, '关联的产品机会'),
        change.opportunityId
          ? h(
              'div',
              { className: 'apr-inline' },
              h('span', { className: 'apr-status' }, `已关联机会 ${change.opportunityId}`),
              h(Btn, { label: '打开机会详情 ›', size: 'sm', onClick: () => onOpenOpportunity(change.opportunityId) }),
            )
          : h('p', { className: 'apr-note' }, '还没有从这条变化创建机会。点下面的「沉淀为产品机会」会新建一条并建立双向关联。'),

        h('div', { className: 'apr-section-title' }, '我的处理'),
        h(
          'div',
          { className: 'apr-actions' },
          h(Btn, { label: '标记已读', size: 'sm', disabled: saveState === '保存中…', onClick: () => void patch({ status: 'seen' }, onChanged) }),
          h(Btn, { label: '忽略', size: 'sm', disabled: saveState === '保存中…', onClick: () => void patch({ status: 'ignored' }, onChanged) }),
          h(Btn, { label: '标记未读', size: 'sm', disabled: saveState === '保存中…', onClick: () => void patch({ status: 'unread' }, onChanged) }),
          h(Btn, { label: '沉淀为产品机会', size: 'sm', variant: 'primary', disabled: saveState === '保存中…' || status === 'pooled', onClick: () => void createOpportunity() }),
        ),
        h('p', { className: saveState.startsWith('保存失败') ? 'apr-status is-error' : 'apr-status' }, saveState),
        poolState ? h('p', { className: poolState.startsWith('创建失败') ? 'apr-status is-error' : 'apr-status is-ok' }, poolState) : null,

        h(Field, { label: '研究备注（会落盘，可随时修改）' }, h('textarea', { className: 'apr-area', value: note, onChange: (event) => setNote(event.target.value), placeholder: '记录与自己的项目有什么关系、还需要核实什么…' })),
        h(
          'div',
          { className: 'apr-actions' },
          h(Btn, {
            label: '保存备注',
            size: 'sm',
            disabled: saveState === '保存中…',
            onClick: () => void patch({ userNote: note }, onChanged),
          }),
        ),
        ),
      )
    }

    // ---------------------------------------------------------------- 来源视图

    /** 关注源管理。 */
    /**
     * 快照历史里的一行（P1-02）。
     *
     * 正文**按需加载**：列表里 20 行各带全文会让"打开历史"变成一次数兆字节的请求，
     * 而用户通常先想看的只是"哪几次抓到了东西、哪几次只是空转"。
     *
     * @param {{snap: object}} props 一份快照的摘要
     */
    function SnapshotRow({ snap }) {
      const [open, setOpen] = React.useState(false)
      const [detail, setDetail] = React.useState(null)
      const [error, setError] = React.useState('')

      const toggle = React.useCallback(async () => {
        if (open) {
          setOpen(false)
          return
        }
        setOpen(true)
        if (detail) return
        const result = await api(`/snapshots/${encodeURIComponent(snap.id)}`)
        if (result.ok) setDetail(result.data.snapshot)
        else setError(failText(result))
      }, [open, detail, snap.id])

      const chain = snap.chain ?? {}
      const parts = []
      if (chain.baseline) {
        parts.push('基线：首次抓取，没有可对比的上一版')
      } else {
        if (chain.added) parts.push(`+${chain.added} 新增`)
        if (chain.removed) parts.push(`−${chain.removed} 移除`)
        if (chain.modified) parts.push(`~${chain.modified} 修改`)
        if (!parts.length) parts.push('条目没有变化')
      }
      if (chain.capped) parts.push('（条目数超过记录上限，这里只是下限）')

      return h(
        'div',
        { className: 'apr-card', style: { marginBottom: 4, padding: '6px 8px' } },
        h(
          'div',
          { className: 'apr-row-top' },
          h('span', { className: 'apr-row-sub' }, orDash(fmtTime(snap.fetchedAt))),
          h(Badge, { text: `${snap.itemCount} 条` }),
          snap.retention === 'excerpt' ? h(Badge, { text: '仅保留摘录', tone: 'warn' }) : null,
          snap.truncated ? h(Badge, { text: '响应被截断', tone: 'del' }) : null,
          h('span', { className: 'apr-grow' }),
          h(Btn, { label: open ? '收起正文' : '正文', size: 'sm', onClick: () => void toggle() }),
        ),
        h('div', { className: 'apr-row-sub' }, parts.join(' · ')),
        h('div', { className: 'apr-row-sub' }, `这份快照关联 ${snap.changeIds?.length ?? 0} 条变化记录`),
        // 幂等规则（SDD §4.4）会让"重复看到的同一条内容"不再产生记录，于是
        // "新增 20 条"旁边写着"1 条记录"看起来像自相矛盾。这里如实说明原因，
        // 而不是把数字悄悄对齐。
        !chain.baseline && (chain.added ?? 0) + (chain.modified ?? 0) > (snap.changeIds?.length ?? 0)
          ? h(
              'div',
              { className: 'apr-row-sub' },
              '其余新增/修改的条目在更早的抓取里已经记过，按幂等规则不重复记录。',
            )
          : null,
        open
          ? error
            ? h('p', { className: 'apr-note is-error' }, error)
            : detail
              ? h(
                  'div',
                  {},
                  detail.textTruncatedByView
                    ? h('p', { className: 'apr-note' }, `正文只显示前 ${detail.maxViewChars} 个字符（这份快照共 ${detail.textChars} 个字符）。`)
                    : null,
                  h('pre', { className: 'apr-pre is-scroll' }, detail.text || '（这份快照没有留下正文）'),
                )
              : h('p', { className: 'apr-status' }, '读取中…')
          : null,
      )
    }

    function SourcesView({ meta, onCounts, slice, patchSlice, openDetail, back }) {
      const [items, setItems] = React.useState([])
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [testResult, setTestResult] = React.useState(null)
      const [form, setForm] = React.useState(null)
      const [notice, setNotice] = React.useState('')

      const adapters = meta?.adapters ?? []
      /** 预置模板来自 `/templates`（Host 侧 `listTemplates()`），不从 `meta` 猜。 */
      const [templates, setTemplates] = React.useState([])

      const load = React.useCallback(async () => {
        setBusy(true)
        const result = await api('/sources')
        if (result.ok) {
          setItems(result.data.items ?? [])
          // 告诉外壳"内容到位了"，它才好把离开前的滚动位置写回来。
          patchSlice('sources', { loadedAt: Date.now() })
        } else {
          setError(failText(result))
        }
        setBusy(false)
      }, [patchSlice])

      const loadTemplates = React.useCallback(async () => {
        const result = await api('/templates')
        if (result.ok) setTemplatesState(result.data.items ?? [])
      }, [])

      const [templatesState, setTemplatesState] = React.useState([])

      React.useEffect(() => {
        void load()
        void loadTemplates()
      }, [load, loadTemplates])

      React.useEffect(() => {
        onCounts({ sources: items.length })
      }, [items.length, onCounts])

      const openForm = React.useCallback(
        (preset) => {
          const type = preset?.type ?? adapters[0]?.type ?? 'github_releases'
          const adapter = adapters.find((entry) => entry.type === type)
          const config = { ...(preset?.config ?? {}) }
          for (const field of adapter?.fields ?? []) if (config[field.key] === undefined) config[field.key] = field.default ?? ''
          setForm({ type, config, name: preset?.name ?? '' })
          setTestResult(null)
          setNotice('')
        },
        [adapters],
      )

      const submit = React.useCallback(async () => {
        setNotice('添加中…')
        const body = { type: form.type, config: form.config }
        if (form.name.trim()) body.name = form.name.trim()
        const result = await api('/sources', { method: 'POST', body })
        if (result.ok) {
          setNotice(`已添加：${result.data.name}`)
          setForm(null)
          await load()
        } else {
          setNotice(`添加失败：${failText(result)}`)
        }
      }, [form, load])

      const testDraft = React.useCallback(async () => {
        setTestResult({ pending: true })
        const result = await api('/sources/test', { method: 'POST', body: { type: form.type, config: form.config }, timeoutMs: 30000 })
        // 注意：路由成功不代表抓取成功 —— 服务端刻意用 200 + ok:false 表达"抓取失败"。
        setTestResult(result.ok ? result.data : { ok: false, error: { message: failText(result) } })
      }, [form])

      const testExisting = React.useCallback(async (id) => {
        setTestResult({ pending: true })
        const result = await api('/sources/test', { method: 'POST', body: { sourceId: id }, timeoutMs: 30000 })
        setTestResult(result.ok ? result.data : { ok: false, error: { message: failText(result) } })
      }, [])

      const refreshOne = React.useCallback(
        async (id) => {
          setNotice('刷新中…')
          const result = await api('/refresh', { method: 'POST', body: { sourceIds: [id] }, timeoutMs: REFRESH_TIMEOUT_MS })
          if (result.ok) {
            const entry = (result.data.results ?? [])[0]
            setNotice(entry?.ok ? `刷新成功，新增 ${entry.newChanges ?? 0} 条变化` : `刷新失败：${entry?.error?.message ?? '未知原因'}`)
            await load()
          } else {
            setNotice(`刷新失败：${failText(result)}`)
          }
        },
        [load],
      )

      const toggle = React.useCallback(
        async (item) => {
          const result = await api(`/sources/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { enabled: item.enabled !== true } })
          if (result.ok) setItems((prev) => prev.map((row) => (row.id === result.data.id ? result.data : row)))
          else setError(failText(result))
        },
        [],
      )

      /**
       * 改定时刷新间隔。
       *
       * 服务端会夹取（15..1440，0 表示关闭），所以这里**用服务端返回的记录回填**，
       * 而不是乐观地信任 `event.target.value`：用户选了"每 5 分钟"却看到下拉框停在
       * 5 而实际存的是 15，是比慢一点刷新更糟的欺骗。
       */
      const changeInterval = React.useCallback(async (item, value) => {
        const result = await api(`/sources/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: { intervalMinutes: value } })
        if (result.ok) {
          setItems((prev) => prev.map((row) => (row.id === result.data.id ? result.data : row)))
          setNotice(
            Number(result.data.intervalMinutes) > 0
              ? `「${result.data.name}」将每 ${result.data.intervalMinutes} 分钟检查一次`
              : `「${result.data.name}」已关闭定时刷新`,
          )
        } else {
          setError(failText(result))
        }
      }, [])

      const remove = React.useCallback(
        async (item) => {
          setNotice('删除中…')
          const result = await api(`/sources/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
          if (result.ok) {
            setNotice(`已删除「${item.name}」，同时移除 ${result.data.removedSnapshots} 份快照与 ${result.data.removedChanges} 条变化`)
            await load()
          } else {
            setNotice(`删除失败：${failText(result)}`)
          }
        },
        [load],
      )

      const activeAdapter = form ? adapters.find((entry) => entry.type === form.type) : null

      /**
       * 改来源的名称与配置（详情页里的「编辑」）。
       *
       * 成功时**用服务端返回的记录回填**列表，失败时把原因交回给调用方显示 ——
       * 不在这里乐观地改本地状态，因为"改名的输入框清空了"与"服务端真的改了名"
       * 是两件必须能分开的事。
       */
      const saveEdit = React.useCallback(async (item, patch) => {
        const result = await api(`/sources/${encodeURIComponent(item.id)}`, { method: 'PATCH', body: patch })
        if (result.ok) {
          setItems((prev) => prev.map((row) => (row.id === result.data.id ? result.data : row)))
          return { ok: true, data: result.data }
        }
        return { ok: false, message: failText(result) }
      }, [])

      // 详情打开时只渲染详情。来源记录已经在列表里，直接传进去 —— 详情不该为
      // 了显示"名称/类型/地址"再发一次请求。
      if (slice.detailId) {
        return h(SourceDetail, {
          id: slice.detailId,
          item: items.find((row) => row.id === slice.detailId) ?? null,
          meta,
          busy,
          notice,
          onBack: back,
          onRefresh: refreshOne,
          onTest: testExisting,
          onChangeInterval: changeInterval,
          onToggle: toggle,
          onDelete: remove,
          onSaveEdit: saveEdit,
        })
      }

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'apr-actions', style: { marginBottom: 8 } },
          h(Btn, { label: '添加来源', size: 'sm', variant: 'primary', onClick: () => openForm(null), disabled: busy }),
          h(Btn, { label: busy ? '读取中…' : '重新读取', size: 'sm', onClick: () => void load(), disabled: busy }),
        ),
        notice ? h('p', { className: 'apr-status' }, notice) : null,
        error ? ErrorNote({ text: error }) : null,

        form
          ? h(
              'div',
              { className: 'apr-card' },
              h('div', { className: 'apr-section-title', style: { marginTop: 0 } }, '添加来源'),
              h(
                Field,
                { label: '类型' },
                h(
                  'select',
                  {
                    className: 'apr-select',
                    value: form.type,
                    onChange: (event) => openForm({ type: event.target.value }),
                  },
                  adapters.map((entry) => h('option', { key: entry.type, value: entry.type }, entry.label)),
                ),
              ),
              activeAdapter?.summary ? h('p', { className: 'apr-hint' }, activeAdapter.summary) : null,
              activeAdapter?.conditional ? h('p', { className: 'apr-hint' }, '这一类型依赖站点页面结构，站点改版后可能失效；插件会记录下来，不会假装成功。') : null,
              h(
                'div',
                { className: 'apr-fields' },
                (activeAdapter?.fields ?? []).map((field) =>
                  h(
                    Field,
                    { key: field.key, label: field.label ?? field.key, hint: field.hint },
                    h('input', {
                      className: 'apr-input',
                      value: form.config[field.key] ?? '',
                      placeholder: field.placeholder ?? '',
                      onChange: (event) => setForm((prev) => ({ ...prev, config: { ...prev.config, [field.key]: event.target.value } })),
                    }),
                  ),
                ),
              ),
              h(
                Field,
                { label: '名称（可留空，默认按配置生成）' },
                h('input', { className: 'apr-input', value: form.name, onChange: (event) => setForm((prev) => ({ ...prev, name: event.target.value })) }),
              ),
              h(
                'div',
                { className: 'apr-actions' },
                h(Btn, { label: '测试抓取（不写入存储）', size: 'sm', onClick: () => void testDraft() }),
                h(Btn, { label: '添加', size: 'sm', variant: 'primary', onClick: () => void submit() }),
                h(Btn, { label: '取消', size: 'sm', onClick: () => { setForm(null); setTestResult(null) } }),
              ),
            )
          : null,

        testResult ? TestResultCard({ result: testResult }) : null,

        templatesState.length
          ? h(
              'div',
              { className: 'apr-card' },
              h('div', { className: 'apr-section-title', style: { marginTop: 0 } }, '预置来源（地址由插件拼接，可信）'),
              ...templatesState.map((tpl) =>
                h(
                  'div',
                  { key: tpl.id, className: 'apr-inline', style: { marginBottom: 6 } },
                  h('span', { className: 'apr-row-title' }, tpl.name),
                  h('span', { className: 'apr-grow' }),
                  h(Btn, { label: '测试', size: 'sm', onClick: () => { openForm(tpl); setTestResult(null) } }),
                ),
              ),
              h('p', { className: 'apr-hint' }, '模板只填充表单，不会自动写入存储 —— 需要你确认后点「添加」。'),
            )
          : null,

        h('div', { className: 'apr-section-title' }, `已关注来源（${items.length}）`),
        /**
         * 定时刷新能力的如实交代。
         *
         * 三态必须都看得见，因为它们的后果不同：
         *   · `available: false` → 定时间隔设了也不会生效，必须**禁用并说明原因**，
         *     否则用户会以为"我已经设了定时"，而实际上什么都没发生（静默失效）。
         *   · `degraded: true` → 定时可用，但宿主没提供释放感知的定时器，插件在
         *     用全局 `setInterval` 兜底（HMR 反复重载时可能留下残留句柄）。
         *   · 正常 → 不说话。
         */
        meta?.scheduler && meta.scheduler.available === false
          ? h(
              'p',
              { className: 'apr-note is-warn' },
              `定时刷新不可用：${meta.scheduler.reason ?? '宿主未提供定时器能力'}。「立即刷新」仍然可用。`,
            )
          : null,
        meta?.scheduler?.degraded === true
          ? h('p', { className: 'apr-hint' }, '定时刷新正在使用降级定时器（宿主未提供释放感知的定时器能力）。')
          : null,
        meta?.scheduler?.running === false && meta.scheduler.available !== false
          ? h('p', { className: 'apr-note is-warn' }, '定时刷新尚未启动，正在等待宿主完成挂载。')
          : null,
        items.length === 0 && !busy ? h('p', { className: 'apr-empty' }, '还没有关注源。点「添加来源」，或从上面的预置来源里选一个先测试。') : null,
        h(
          'div',
          { className: 'apr-list' },
          items.map((item) =>
            h(
              'div',
              { key: item.id, className: 'apr-card', style: { marginBottom: 6 } },
              h(
                'div',
                { className: 'apr-row-top' },
                /*
                 * 名称是进入详情的入口。它必须是一个真的 <button> ——
                 * 只在 div 上挂 onClick 的话键盘用户按不到它。
                 * 行上的刷新/启停/删除是它的**兄弟节点**，不在它内部，
                 * 所以点「删除」绝不会顺带打开详情。
                 */
                h(
                  'button',
                  {
                    className: 'apr-rowlink',
                    type: 'button',
                    'aria-label': `打开来源详情：${item.name}`,
                    onClick: () => openDetail('sources', item.id),
                  },
                  item.name,
                ),
                h(Badge, { text: SOURCE_STATUS_LABEL[item.status] ?? item.status, tone: item.status === 'failed' ? 'del' : item.status === 'ok' ? 'add' : undefined }),
                h('span', { className: 'apr-grow' }),
                h('span', { className: 'apr-row-sub' }, item.enabled === false ? '已停用' : '已启用'),
              ),
              h('div', { className: 'apr-row-sub' }, `${item.type} · ${item.canonicalUrl}`),
              h(
                'div',
                { className: 'apr-row-sub' },
                `上次检查 ${orDash(fmtTime(item.lastCheckedAt))} · 上次成功 ${orDash(fmtTime(item.lastSuccessAt))}`,
              ),
              item.lastError
                ? h('div', { className: 'apr-row-sub', style: { color: 'var(--apr-danger)' } }, `上次错误：${item.lastError.message}（${item.lastError.code}）`)
                : null,
              item.autoDisabledAt
                ? h(
                    'p',
                    { className: 'apr-note is-warn' },
                    `已自动停用：${item.autoDisabledReason ?? '连续多次刷新失败'}（${orDash(fmtTime(item.autoDisabledAt))}）。修好地址后点「启用」即可恢复，计数会清零。`,
                  )
                : null,
              h(
                'div',
                { className: 'apr-row-sub', style: { marginTop: 4 } },
                '定时刷新：',
                h(
                  'select',
                  {
                    className: 'apr-select',
                    style: { width: 'auto' },
                    value: String(Number(item.intervalMinutes) || 0),
                    disabled: busy,
                    'aria-label': `${item.name} 的定时刷新间隔`,
                    onChange: (event) => void changeInterval(item, Number(event.target.value)),
                  },
                  INTERVAL_OPTIONS.map((opt) => h('option', { key: opt.value, value: String(opt.value) }, opt.label)),
                ),
                h(
                  'span',
                  { style: { marginLeft: 6 } },
                  Number(item.intervalMinutes) > 0
                    ? toEpochMs(item.lastCheckedAt) === null
                      ? '等待首次检查'
                      : `下次大约 ${orDash(fmtTime(nextRunAt(item)))}（${fmtAgo(nextRunAt(item))}）`
                    : '未开启',
                ),
              ),
              h(
                'div',
                { className: 'apr-actions', style: { marginTop: 6 } },
                h(Btn, { label: '查看详情', size: 'sm', onClick: () => openDetail('sources', item.id) }),
                h(Btn, { label: '立即刷新', size: 'sm', onClick: () => void refreshOne(item.id) }),
                h(Btn, { label: '测试抓取', size: 'sm', onClick: () => void testExisting(item.id) }),
                h(Btn, { label: item.enabled === false ? '启用' : '停用', size: 'sm', onClick: () => void toggle(item) }),
              ),
            ),
          ),
        ),
      )
    }

    /**
     * 一个关注源的详情。
     *
     * 与变化/机会详情不同的是：来源记录**已经在列表里**（`GET /sources` 一次给全
     * 部字段），所以这里不再为"名称/类型/地址"发请求；只有快照历史需要单独读
     * （`GET /sources/:id/snapshots`，最多 20 份）。
     */
    function SourceDetail({ id, item, meta, busy, notice, onBack, onRefresh, onTest, onChangeInterval, onToggle, onDelete, onSaveEdit }) {
      const [history, setHistory] = React.useState(null)
      const [editing, setEditing] = React.useState(false)
      const [draft, setDraft] = React.useState(null)
      const [saveState, setSaveState] = React.useState('')
      const [confirming, setConfirming] = React.useState(false)
      const [actionNote, setActionNote] = React.useState('')

      const loadHistory = React.useCallback(async () => {
        setHistory({ loading: true, items: [], total: 0 })
        const result = await api(`/sources/${encodeURIComponent(id)}/snapshots`)
        /*
         * 读取失败必须与"这个来源还没有快照"分开。把失败显示成空列表，等于告诉
         * 用户"这里什么都没有"——而那正是他最不该从一次网络错误里得到的结论。
         */
        if (result.ok) {
          setHistory({ loading: false, items: result.data.items ?? [], total: result.data.total ?? 0, error: '' })
        } else {
          setHistory({ loading: false, items: [], total: 0, error: `快照历史读取失败：${failText(result)}` })
        }
      }, [id])

      React.useEffect(() => {
        void loadHistory()
      }, [loadHistory])

      const adapter = (meta?.adapters ?? []).find((entry) => entry.type === item?.type)
      const limits = meta?.limits ?? {}

      const openEdit = () => {
        const config = { ...(item?.config ?? {}) }
        for (const field of adapter?.fields ?? []) if (config[field.key] === undefined) config[field.key] = field.default ?? ''
        setDraft({ name: item?.name ?? '', config })
        setEditing(true)
        setSaveState('')
      }

      const submitEdit = async () => {
        if (!draft) return
        setSaveState('保存中…')
        // 只发用户能编辑的两样：名称与配置。
        const result = await onSaveEdit(item, { name: draft.name, config: draft.config })
        if (result.ok) {
          setSaveState('已保存')
          setEditing(false)
        } else {
          // 失败时**保留输入**，只把原因显示出来 —— 清空表单会让用户重打一遍。
          setSaveState(`保存失败：${result.message}`)
        }
      }

      const crumb = h(
        'div',
        { className: 'apr-crumb' },
        h(Btn, { label: '‹ 返回关注源列表', size: 'sm', onClick: onBack }),
        h('span', { className: 'apr-crumb-label' }, item?.name ?? id),
      )

      if (!item) {
        return h(
          'div',
          null,
          crumb,
          h('p', { className: 'apr-empty' }, '这个来源已经不在列表里了（可能刚刚被删除）。'),
          h(Btn, { label: '重新读取列表', size: 'sm', onClick: onBack }),
        )
      }

      const retentionNote =
        typeof limits.maxSnapshotsPerSource === 'number'
          ? `每个来源最多保留 ${limits.maxSnapshotsPerSource} 份快照；其中最近 ${limits.maxFullTextSnapshots ?? '?'} 份保留全文，更旧的只保留 ${limits.maxOldSnapshotChars ?? '?'} 字符的摘录。`
          : ''

      return h(
        'div',
        null,
        crumb,
        h(
          'div',
          { className: 'apr-card' },
          h('div', { className: 'apr-section-title', style: { marginTop: 0 } }, '来源状态'),
          h(
            'dl',
            { className: 'apr-kv' },
            h('dt', null, '名称'),
            h('dd', null, item.name),
            h('dt', null, '类型'),
            h('dd', null, `${adapter?.label ?? item.type}（${item.type}）`),
            h('dt', null, '规范化地址'),
            h(
              'dd',
              null,
              h('a', { className: 'apr-link', href: item.canonicalUrl, target: '_blank', rel: 'noopener noreferrer' }, item.canonicalUrl),
            ),
            h('dt', null, '启用状态'),
            h('dd', null, item.enabled === false ? '已停用' : '已启用'),
            h('dt', null, '定时刷新'),
            h(
              'dd',
              null,
              Number(item.intervalMinutes) > 0
                ? `每 ${item.intervalMinutes} 分钟${toEpochMs(item.lastCheckedAt) === null ? '（等待首次检查）' : `，下次大约 ${orDash(fmtTime(nextRunAt(item)))}`}`
                : '未开启',
            ),
            h('dt', null, '上次检查'),
            h('dd', null, `${orDash(fmtTime(item.lastCheckedAt))}（${fmtAgo(item.lastCheckedAt)}）`),
            h('dt', null, '上次成功'),
            h('dd', null, `${orDash(fmtTime(item.lastSuccessAt))}（${fmtAgo(item.lastSuccessAt)}）`),
            h('dt', null, '连续失败次数'),
            h('dd', null, String(Number(item.failureStreak) || 0)),
            h('dt', null, '上次抓取状态'),
            h('dd', null, SOURCE_STATUS_LABEL[item.status] ?? item.status),
          ),
          /*
           * 失败原因必须**原样**给出来。只说"抓取失败"会让用户去改一个本来没错的
           * 地址 —— 真实原因（超时、404、被截断、解析不了）决定了下一步该做什么。
           */
          item.lastError
            ? h(
                'p',
                { className: 'apr-note is-error' },
                `上次错误（${item.lastError.code}）：${item.lastError.message}${item.lastError.at ? ` · ${orDash(fmtTime(item.lastError.at))}` : ''}`,
              )
            : null,
          item.autoDisabledAt
            ? h(
                'p',
                { className: 'apr-note is-warn' },
                `已自动停用：${item.autoDisabledReason ?? '连续多次刷新失败'}（${orDash(fmtTime(item.autoDisabledAt))}）。修好后点「启用」即可恢复，失败计数会清零。`,
              )
            : null,
        ),

        h('div', { className: 'apr-section-title' }, '操作'),
        h(
          'div',
          { className: 'apr-actions' },
          h(Btn, { label: '立即刷新', size: 'sm', variant: 'primary', disabled: busy, onClick: () => void onRefresh(id) }),
          h(Btn, { label: '试抓一次', size: 'sm', disabled: busy, onClick: () => void onTest(id) }),
          h(Btn, { label: editing ? '取消编辑' : '编辑名称与配置', size: 'sm', onClick: () => (editing ? setEditing(false) : openEdit()) }),
          h(Btn, {
            label: item.enabled === false ? '启用' : '停用',
            size: 'sm',
            disabled: busy,
            onClick: () => void onToggle(item),
          }),
          confirming
            ? h(
                'span',
                { className: 'apr-inline' },
                h('span', { className: 'apr-status is-error' }, `确定删除「${item.name}」？它名下的快照与变化会一起消失，无法撤销。`),
                h(Btn, {
                  label: '确认删除',
                  size: 'sm',
                  variant: 'danger',
                  disabled: busy,
                  onClick: async () => {
                    // 先等服务端确认，再收起确认条 —— 删除失败时界面必须留在原地，
                    // 否则用户会以为删掉了，而记录其实还在。
                    await onDelete(item)
                    setConfirming(false)
                  },
                }),
                h(Btn, { label: '取消', size: 'sm', onClick: () => setConfirming(false) }),
              )
            : h(Btn, { label: '删除', size: 'sm', variant: 'danger', onClick: () => setConfirming(true) }),
        ),
        notice ? h('p', { className: 'apr-status' }, notice) : null,

        editing && draft
          ? h(
              'div',
              { className: 'apr-card' },
              h('div', { className: 'apr-section-title', style: { marginTop: 0 } }, '编辑来源'),
              h(Field, { label: '名称' }, h('input', { className: 'apr-input', value: draft.name, onChange: (e) => setDraft((p) => ({ ...p, name: e.target.value })) })),
              h(
                'div',
                { className: 'apr-fields' },
                (adapter?.fields ?? []).map((field) =>
                  h(
                    Field,
                    { key: field.key, label: field.required ? `${field.label}（必填）` : field.label, hint: field.hint },
                    h('input', {
                      className: 'apr-input',
                      value: draft.config[field.key] ?? '',
                      placeholder: field.placeholder ?? '',
                      onChange: (e) => setDraft((p) => ({ ...p, config: { ...p.config, [field.key]: e.target.value } })),
                    }),
                  ),
                ),
              ),
              h(
                'div',
                { className: 'apr-actions' },
                h(Btn, { label: '保存', size: 'sm', variant: 'primary', disabled: saveState === '保存中…', onClick: () => void submitEdit() }),
                h(Btn, { label: '取消', size: 'sm', onClick: () => setEditing(false) }),
              ),
              saveState ? h('p', { className: saveState.startsWith('保存失败') ? 'apr-status is-error' : 'apr-status' }, saveState) : null,
            )
          : null,

        h('div', { className: 'apr-section-title' }, `快照历史${history && !history.loading && !history.error ? `（共 ${history.total} 份）` : ''}`),
        retentionNote ? h('p', { className: 'apr-hint' }, retentionNote) : null,
        history?.loading
          ? h('p', { className: 'apr-status' }, '读取快照历史…')
          : history?.error
            ? h('div', null, ErrorNote({ text: history.error }), h(Btn, { label: '重试', size: 'sm', onClick: () => void loadHistory() }))
            : (history?.items ?? []).length === 0
              ? h('p', { className: 'apr-empty' }, '这个来源还没有快照 —— 点上面的「立即刷新」抓一次。')
              : h(
                  'div',
                  null,
                  h('p', { className: 'apr-note' }, '每行标出它相对上一份变了什么；正文默认收起。首次抓取的那份是基线，没有可比较的上一版。'),
                  history.items.map((snap) => h(SnapshotRow, { key: snap.id, snap })),
                ),
      )
    }

    /** 抓取测试结果：成功要说清"抓到了什么"，失败要说清"为什么"。 */
    function TestResultCard({ result }) {
      if (result.pending) return h('div', { className: 'apr-card' }, h('p', { className: 'apr-status' }, '测试中…'))
      if (result.ok) {
        return h(
          'div',
          { className: 'apr-card' },
          h('p', { className: 'apr-status is-ok' }, `抓取成功 · HTTP ${result.statusCode} · ${result.elapsedMs} ms · 解析到 ${result.itemCount} 条`),
          h('div', { className: 'apr-row-sub' }, result.url),
          result.truncated ? h('p', { className: 'apr-note is-warn' }, '响应被宿主截断，解析结果不完整。') : null,
          ...(result.sampleTitles ?? []).map((title, i) => h('div', { key: i, className: 'apr-row-sub' }, `· ${title}`)),
          h('p', { className: 'apr-hint' }, '测试不会写入存储，也不会产生变化记录。'),
        )
      }
      return h(
        'div',
        { className: 'apr-card' },
        h('p', { className: 'apr-status is-error' }, `抓取失败：${result.error?.message ?? '未知原因'}${result.error?.code ? `（${result.error.code}）` : ''}`),
        result.error?.detail ? h('pre', { className: 'apr-pre' }, typeof result.error.detail === 'string' ? result.error.detail : JSON.stringify(result.error.detail, null, 2)) : null,
      )
    }

    // ---------------------------------------------------------------- 机会视图

    /** 产品机会池。 */
    function OpportunitiesView({ meta, onCounts, slice, patchSlice, openDetail, back }) {
      const [items, setItems] = React.useState([])
      const [total, setTotal] = React.useState(0)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState('')
      const [draft, setDraft] = React.useState(null)
      /** 导出结果：成功给出文件名与字符数，失败给出原因。 */
      const [exported, setExported] = React.useState(null)
      const [exporting, setExporting] = React.useState(false)

      // 筛选、搜索、分页都住在 nav.slice 里 —— 进详情再返回时它们必须原样还在。
      const status = slice.status ?? 'all'
      const query = slice.query ?? ''
      const offset = slice.offset ?? 0

      const load = React.useCallback(async () => {
        setBusy(true)
        const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(offset) })
        if (status !== 'all') params.set('status', status)
        if (query.trim()) params.set('q', query.trim())
        const result = await api(`/opportunities?${params.toString()}`)
        if (result.ok) {
          setItems(result.data.items ?? [])
          setTotal(result.data.total ?? 0)
          setError('')
          patchSlice('opps', { loadedAt: Date.now() })
        } else {
          setError(failText(result))
        }
        setBusy(false)
      }, [status, query, offset, patchSlice])

      React.useEffect(() => {
        void load()
      }, [load])

      React.useEffect(() => {
        onCounts({ opportunities: total })
      }, [total, onCounts])

      const create = React.useCallback(async () => {
        setNotice('创建中…')
        const result = await api('/opportunities', {
          method: 'POST',
          body: {
            title: draft.title,
            projectRef: draft.projectRef,
            judgment: draft.judgment,
            questions: draft.questions
              .split('\n')
              .map((line) => line.trim())
              .filter(Boolean),
          },
        })
        if (result.ok) {
          setNotice(`已创建：${result.data.title}`)
          setDraft(null)
          await load()
        } else {
          setNotice(`创建失败：${failText(result)}`)
        }
      }, [draft, load])

      /**
       * 保存一条机会。
       *
       * 把服务端的结果**交回给调用方**（列表用一个、详情用另一个），而不是在这里
       * 统一改成一句提示 —— 详情页的编辑框必须能在保存失败时留在原地并保留输入。
       */
      const saveOpportunity = React.useCallback(async (id, body) => {
        const result = await api(`/opportunities/${encodeURIComponent(id)}`, { method: 'PATCH', body })
        if (result.ok) {
          setItems((prev) => prev.map((row) => (row.id === id ? result.data : row)))
          return { ok: true, data: result.data }
        }
        return { ok: false, message: failText(result) }
      }, [])

      const removeOpportunity = React.useCallback(
        async (id) => {
          const result = await api(`/opportunities/${encodeURIComponent(id)}`, { method: 'DELETE' })
          if (result.ok) {
            // 服务端确认删掉之后才动列表 —— 删除失败时不能先把界面上的行抹掉。
            setNotice('已删除；由它沉淀的那条变化已回到未读')
            await load()
            return { ok: true }
          }
          return { ok: false, message: failText(result) }
        },
        [load],
      )

      /**
       * 导出机会为 Markdown。
       *
       * `ids` 为空表示「全部」。单条导出走同一个回调，只是多带一个 id ——
       * 两条路径共用一套失败处理，不会出现「单个能导出、全部导出静默失败」。
       */
      const exportMarkdown = React.useCallback(async (ids) => {
        setExporting(true)
        setExported(null)
        const query = ids && ids.length ? `?ids=${ids.map(encodeURIComponent).join(',')}` : ''
        const result = await downloadMarkdown(`/export/opportunities${query}`)
        setExporting(false)
        setExported(result)
      }, [])

      // 详情打开时只渲染详情，列表不在下面接着排。
      if (slice.detailId) {
        return h(OpportunityDetail, {
          id: slice.detailId,
          meta,
          onBack: back,
          onSave: saveOpportunity,
          onDelete: removeOpportunity,
          onExport: exportMarkdown,
          onOpenChange: (changeId) => openDetail('inbox', changeId),
          onChanged: load,
        })
      }

      const rows = items

      return h(
        'div',
        null,
        h(
          'div',
          { className: 'apr-actions', style: { marginBottom: 8 } },
          h(Btn, {
            label: '新建机会',
            size: 'sm',
            variant: 'primary',
            onClick: () => setDraft({ title: '', projectRef: '', judgment: '', questions: '' }),
          }),
          h(Btn, { label: busy ? '读取中…' : '重新读取', size: 'sm', onClick: () => void load(), disabled: busy }),
          h(Btn, {
            label: exporting ? '导出中…' : '导出 Markdown',
            size: 'sm',
            disabled: exporting || items.length === 0,
            onClick: () => void exportMarkdown(null),
          }),
        ),
        notice ? h('p', { className: 'apr-status' }, notice) : null,
        exported
          ? exported.ok
            ? h(
                'p',
                { className: 'apr-status is-ok' },
                `已导出 ${exported.filename}（${exported.bytes} 字符）。保存位置由浏览器决定 —— 插件没有、也不会写你的项目目录。`,
              )
            : ErrorNote({ text: `导出失败：${exported.message}` })
          : null,
        error ? ErrorNote({ text: error }) : null,

        draft
          ? h(
              'div',
              { className: 'apr-card' },
              h('div', { className: 'apr-section-title', style: { marginTop: 0 } }, '新建产品机会'),
              h(Field, { label: '标题（必填）' }, h('input', { className: 'apr-input', value: draft.title, onChange: (e) => setDraft((p) => ({ ...p, title: e.target.value })) })),
              h(Field, { label: '关联项目 / 链接' }, h('input', { className: 'apr-input', value: draft.projectRef, onChange: (e) => setDraft((p) => ({ ...p, projectRef: e.target.value })) })),
              h(Field, { label: '产品判断' }, h('textarea', { className: 'apr-area', value: draft.judgment, onChange: (e) => setDraft((p) => ({ ...p, judgment: e.target.value })) })),
              h(Field, { label: '待验证问题（每行一条）' }, h('textarea', { className: 'apr-area', value: draft.questions, onChange: (e) => setDraft((p) => ({ ...p, questions: e.target.value })) })),
              h(
                'div',
                { className: 'apr-actions' },
                h(Btn, { label: '创建', size: 'sm', variant: 'primary', onClick: () => void create(), disabled: !draft.title.trim() }),
                h(Btn, { label: '取消', size: 'sm', onClick: () => setDraft(null) }),
              ),
            )
          : null,

        /*
         * 筛选与搜索。改条件必须回到第一页 —— 留在第 3 页上看到"没有结果"是最容易
         * 让人以为数据没了的假象。
         */
        h(
          'div',
          { className: 'apr-bar' },
          h(
            'select',
            {
              className: 'apr-select',
              value: status,
              'aria-label': '按状态筛选机会',
              onChange: (e) => patchSlice('opps', { status: e.target.value, offset: 0 }),
            },
            h('option', { value: 'all' }, '全部'),
            Object.keys(OPPORTUNITY_STATUS_LABEL).map((key) => h('option', { key, value: key }, OPPORTUNITY_STATUS_LABEL[key])),
          ),
          h('input', {
            className: 'apr-input',
            style: { flex: '1 1 140px', minWidth: 0 },
            value: query,
            placeholder: '搜索标题、项目、判断、问题',
            'aria-label': '搜索机会',
            onChange: (e) => patchSlice('opps', { query: e.target.value, offset: 0 }),
          }),
          h(Btn, { label: '查询', size: 'sm', onClick: () => patchSlice('opps', { offset: 0 }) }),
        ),

        error ? ErrorNote({ text: error }) : null,
        rows.length === 0 && !busy
          ? h(
              'p',
              { className: 'apr-empty' },
              status === 'all' && !query.trim()
                ? '机会池是空的。在「变化」里打开一条变化，点「沉淀为产品机会」就会出现在这里。'
                : '没有符合筛选条件的机会。',
            )
          : null,
        h(
          'div',
          { className: 'apr-list' },
          rows.map((item) =>
            h(
              'div',
              { key: item.id, className: 'apr-card', style: { marginBottom: 6 } },
              h(
                'div',
                { className: 'apr-row-top' },
                /*
                 * 标题是进入详情的入口，必须是真的 <button>（键盘能到、回车能开）。
                 * 行内动作是它的兄弟节点，点「导出」不会顺带打开详情。
                 */
                h(
                  'button',
                  {
                    className: 'apr-rowlink',
                    type: 'button',
                    'aria-label': `打开机会详情：${item.title}`,
                    onClick: () => openDetail('opps', item.id),
                  },
                  item.title,
                ),
                h(Badge, { text: OPPORTUNITY_STATUS_LABEL[item.status] ?? item.status }),
                h('span', { className: 'apr-grow' }),
                h('span', { className: 'apr-row-sub' }, fmtAgo(item.updatedAt)),
              ),
              /*
               * 手工创建的机会没有任何抓取记录支撑。这件事在列表上就得看得出来 ——
               * 混在一堆"来自某条变化"的机会里，用户会以为它也有证据。
               */
              item.changeId ? null : h('div', { className: 'apr-row-sub' }, '没有关联任何一次抓取记录'),
              item.projectRef ? h('div', { className: 'apr-row-sub' }, item.projectRef) : null,
              item.judgment ? h('p', { className: 'apr-row-sub' }, item.judgment) : null,
              (item.questions ?? []).length
                ? h(
                    'div',
                    { className: 'apr-row-sub' },
                    ...(item.questions ?? []).map((question, i) => h('div', { key: i }, `· ${question}`)),
                  )
                : null,
              item.nextAction ? h('div', { className: 'apr-row-sub' }, `下一步：${item.nextAction}`) : null,
              h(
                'div',
                { className: 'apr-actions', style: { marginTop: 6 } },
                h(Btn, { label: '打开详情', size: 'sm', onClick: () => openDetail('opps', item.id) }),
                h(Btn, { label: '导出', size: 'sm', disabled: exporting, onClick: () => void exportMarkdown([item.id]) }),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'apr-pager' },
          h(
            'span',
            { className: 'apr-row-sub' },
            total === 0 ? '共 0 条' : `共 ${total} 条，本次显示第 ${offset + 1}–${offset + rows.length} 条`,
          ),
          h(Btn, {
            label: '上一页',
            size: 'sm',
            disabled: busy || offset === 0,
            onClick: () => patchSlice('opps', { offset: Math.max(0, offset - PAGE_SIZE) }),
          }),
          h(Btn, {
            label: '下一页',
            size: 'sm',
            disabled: busy || offset + rows.length >= total,
            onClick: () => patchSlice('opps', { offset: offset + PAGE_SIZE }),
          }),
        ),
      )
    }

    /** 机会编辑表单。 */
    /**
     * 一条产品机会的详情。
     *
     * 独立读取 `GET /opportunities/:id`，而不是从列表里找那条 —— 从一条变化跳过来
     * 时这条机会可能不在当前页，刷新页面后也要能按 id 恢复。响应里的关联变化是
     * 服务端按 `changeId` 找的；`changeMissing` 用来把「从来没有关联过」与
     * 「关联的那条已经不在了」分成两句不同的话。
     */
    function OpportunityDetail({ id, meta, onBack, onSave, onDelete, onExport, onOpenChange, onChanged }) {
      const [detail, setDetail] = React.useState(null)
      const [error, setError] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [editing, setEditing] = React.useState(false)
      const [saveState, setSaveState] = React.useState('')
      const [confirming, setConfirming] = React.useState(false)
      const [exported, setExported] = React.useState(null)
      const [exporting, setExporting] = React.useState(false)

      const load = React.useCallback(async () => {
        setBusy(true)
        const result = await api(`/opportunities/${encodeURIComponent(id)}`)
        if (result.ok) {
          setDetail(result.data)
          setError('')
        } else {
          setDetail(null)
          setError(failText(result))
        }
        setBusy(false)
      }, [id])

      React.useEffect(() => {
        void load()
      }, [load])

      const crumb = h(
        'div',
        { className: 'apr-crumb' },
        h(Btn, { label: '‹ 返回机会池', size: 'sm', onClick: onBack }),
        h('span', { className: 'apr-crumb-label' }, detail?.opportunity?.title ?? id),
      )

      // 返回栏在每种状态下都在 —— 详情不能是死胡同。
      if (busy && !detail) return h('div', null, crumb, h('p', { className: 'apr-status' }, '读取机会详情…'))
      if (error) {
        return h(
          'div',
          null,
          crumb,
          ErrorNote({ text: `读不出来：${error}` }),
          h('p', { className: 'apr-note' }, '这条机会可能已经被删除了。'),
          h(Btn, { label: '重试', size: 'sm', onClick: () => void load() }),
        )
      }

      const item = detail?.opportunity
      if (!item) return h('div', null, crumb, h('p', { className: 'apr-empty' }, '没有这条机会。'))

      const change = detail.change

      const submitEdit = async (body) => {
        setSaveState('保存中…')
        const result = await onSave(item.id, body)
        if (result.ok) {
          // 只有服务端确认写入之后才显示成功。
          setDetail((prev) => ({ ...prev, opportunity: result.data }))
          setSaveState('已保存')
          setEditing(false)
          if (onChanged) await onChanged()
        } else {
          setSaveState(`保存失败：${result.message}`)
        }
        return result
      }

      const confirmDelete = async () => {
        setSaveState('删除中…')
        const result = await onDelete(item.id)
        if (result.ok) {
          if (onChanged) await onChanged()
          onBack()
          return
        }
        // 删除失败时不离开这一页，也不动任何本地状态。
        setSaveState(`删除失败：${result.message}`)
        setConfirming(false)
      }

      const exportOne = async () => {
        setExporting(true)
        setExported(null)
        const result = await onExport([item.id])
        setExporting(false)
        setExported(result)
      }

      return h(
        'div',
        null,
        crumb,

        h(
          'div',
          { className: 'apr-card' },
          h('h2', { className: 'apr-section-title', style: { marginTop: 0 } }, item.title),
          h(
            'dl',
            { className: 'apr-kv' },
            h('dt', null, '当前状态'),
            h('dd', null, OPPORTUNITY_STATUS_LABEL[item.status] ?? item.status),
            h('dt', null, '关联项目'),
            h(
              'dd',
              null,
              item.projectRef
                ? h('a', { className: 'apr-link', href: item.projectRef, target: '_blank', rel: 'noopener noreferrer' }, item.projectRef)
                : '（没有填写）',
            ),
            h('dt', null, '创建时间'),
            h('dd', null, `${orDash(fmtTime(item.createdAt))}（${fmtAgo(item.createdAt)}）`),
            h('dt', null, '更新时间'),
            h('dd', null, `${orDash(fmtTime(item.updatedAt))}（${fmtAgo(item.updatedAt)}）`),
            h('dt', null, '产品判断'),
            h('dd', null, item.judgment && item.judgment.trim() ? item.judgment : '（还没有写判断）'),
            h('dt', null, '待验证问题'),
            h(
              'dd',
              null,
              (item.questions ?? []).length
                ? h('div', null, ...(item.questions ?? []).map((question, i) => h('div', { key: i }, `${i + 1}. ${question}`)))
                : '（还没有列出问题）',
            ),
            h('dt', null, '下一步'),
            h('dd', null, item.nextAction && item.nextAction.trim() ? item.nextAction : '（还没有定下一步）'),
          ),
        ),

        /*
         * 关联的来源变化。三种情况必须说三句不同的话：
         *   - 找得到：把真实的那条变化摊开，并给一个用真实 id 的入口。
         *   - changeMissing：本来有关联，但那条已经不在了。
         *   - 其余：从来没有关联过 —— 这条机会没有抓取证据，判断全部出自使用者。
         * 绝不按标题相同去猜关联。
         */
        h('div', { className: 'apr-section-title' }, '关联的来源变化'),
        change
          ? h(
              'div',
              { className: 'apr-card' },
              h('div', { className: 'apr-row-top' }, h('span', { className: 'apr-row-title' }, orDash(change.title))),
              h('div', { className: 'apr-row-sub' }, `${change.sourceName ?? '（来源已删除）'} · ${CHANGE_KIND_LABEL[change.kind] ?? change.kind}`),
              h('div', { className: 'apr-row-sub' }, `发现于 ${orDash(fmtTime(change.discoveredAt))}`),
              change.diffSummary ? h('p', { className: 'apr-row-sub' }, change.diffSummary) : null,
              change.itemUrl
                ? h(
                    'div',
                    { className: 'apr-row-sub' },
                    h('a', { className: 'apr-link', href: change.itemUrl, target: '_blank', rel: 'noopener noreferrer' }, change.itemUrl),
                  )
                : null,
              h(
                'div',
                { className: 'apr-actions', style: { marginTop: 6 } },
                h(Btn, { label: '打开变化详情 ›', size: 'sm', onClick: () => onOpenChange(change.id) }),
              ),
            )
          : detail?.changeMissing
            ? h(
                'p',
                { className: 'apr-note is-warn' },
                '这条机会原本关联的那条变化已经不在了（可能已被清理，或它的来源被删除）。下面「产品判断」里的内容仍然是你写的，但它的抓取证据已经不在了。',
              )
            : h(
                'p',
                { className: 'apr-note' },
                '没有关联任何一次抓取记录 —— 这条机会是手工创建的。上面的判断、问题与下一步全部出自你自己，插件没有为它抓到任何证据。',
              ),

        h('div', { className: 'apr-section-title' }, '操作'),
        h(
          'div',
          { className: 'apr-actions' },
          h(Btn, {
            label: editing ? '取消编辑' : '编辑判断与问题',
            size: 'sm',
            variant: editing ? undefined : 'primary',
            onClick: () => {
              setEditing(!editing)
              setSaveState('')
            },
          }),
          h(Btn, { label: exporting ? '导出中…' : '导出这条 Markdown', size: 'sm', disabled: exporting, onClick: () => void exportOne() }),
          confirming
            ? h(
                'span',
                { className: 'apr-inline' },
                h('span', { className: 'apr-status is-error' }, `确定删除「${item.title}」？由它沉淀的那条变化会回到未读，无法撤销。`),
                h(Btn, { label: '确认删除', size: 'sm', variant: 'danger', onClick: () => void confirmDelete() }),
                h(Btn, { label: '取消', size: 'sm', onClick: () => setConfirming(false) }),
              )
            : h(Btn, { label: '删除', size: 'sm', variant: 'danger', onClick: () => setConfirming(true) }),
        ),
        saveState ? h('p', { className: saveState.includes('失败') ? 'apr-status is-error' : 'apr-status' }, saveState) : null,
        exported
          ? exported.ok
            ? h('p', { className: 'apr-status is-ok' }, `已导出 ${exported.filename}（${exported.bytes} 字符）。`)
            : ErrorNote({ text: `导出失败：${exported.message}` })
          : null,

        editing ? h(EditOpportunity, { item, onSave: submitEdit, onCancel: () => setEditing(false) }) : null,
      )
    }

    /**
     * 机会编辑表单。
     *
     * `onSave` 返回 `{ ok: true }` 或 `{ ok: false, message }`。失败时**保留输入**，
     * 只把原因显示出来 —— 清空表单会让用户把自己刚写的一段判断重打一遍。
     */
    function EditOpportunity({ item, onSave, onCancel }) {
      const [draft, setDraft] = React.useState({
        title: item.title ?? '',
        projectRef: item.projectRef ?? '',
        judgment: item.judgment ?? '',
        questions: (item.questions ?? []).join('\n'),
        nextAction: item.nextAction ?? '',
        status: item.status ?? 'to_research',
      })
      const [saving, setSaving] = React.useState(false)
      const [error, setError] = React.useState('')

      const submit = async () => {
        setSaving(true)
        setError('')
        const result = await onSave({
          title: draft.title,
          projectRef: draft.projectRef,
          judgment: draft.judgment,
          questions: draft.questions.split('\n').map((line) => line.trim()).filter(Boolean),
          nextAction: draft.nextAction,
          status: draft.status,
        })
        setSaving(false)
        if (result && result.ok === false) setError(result.message)
      }

      return h(
        'div',
        { className: 'apr-card' },
        h('div', { className: 'apr-section-title', style: { marginTop: 0 } }, '编辑机会'),
        h(Field, { label: '标题' }, h('input', { className: 'apr-input', value: draft.title, onChange: (e) => setDraft((p) => ({ ...p, title: e.target.value })) })),
        h(Field, { label: '关联项目 / 链接' }, h('input', { className: 'apr-input', value: draft.projectRef, onChange: (e) => setDraft((p) => ({ ...p, projectRef: e.target.value })) })),
        h(Field, { label: '产品判断' }, h('textarea', { className: 'apr-area', value: draft.judgment, onChange: (e) => setDraft((p) => ({ ...p, judgment: e.target.value })) })),
        h(Field, { label: '待验证问题（每行一条）' }, h('textarea', { className: 'apr-area', value: draft.questions, onChange: (e) => setDraft((p) => ({ ...p, questions: e.target.value })) })),
        h(Field, { label: '下一步' }, h('input', { className: 'apr-input', value: draft.nextAction, onChange: (e) => setDraft((p) => ({ ...p, nextAction: e.target.value })) })),
        h(
          Field,
          { label: '状态' },
          h(
            'select',
            { className: 'apr-select', value: draft.status, onChange: (e) => setDraft((p) => ({ ...p, status: e.target.value })) },
            Object.keys(OPPORTUNITY_STATUS_LABEL).map((key) => h('option', { key, value: key }, OPPORTUNITY_STATUS_LABEL[key])),
          ),
        ),
        // 保存失败时输入原样留着，只把原因显示在下面。
        error ? ErrorNote({ text: `保存失败：${error}` }) : null,
        h(
          'div',
          { className: 'apr-actions' },
          h(Btn, { label: saving ? '保存中…' : '保存', size: 'sm', variant: 'primary', disabled: saving, onClick: () => void submit() }),
          h(Btn, { label: '取消', size: 'sm', onClick: onCancel }),
        ),
      )
    }

    // ---------------------------------------------------------------- 外壳

    /** 页签引导项里的图标（内联 SVG，不引外部资源）。 */
    function RadarGlyph() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', 'aria-hidden': 'true' },
        h('circle', { cx: 8, cy: 8, r: 6.25, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, opacity: 0.55 }),
        h('circle', { cx: 8, cy: 8, r: 3.1, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.2, opacity: 0.8 }),
        h('circle', { cx: 8, cy: 8, r: 1.15, fill: 'currentColor' }),
        h('path', { d: 'M8 8 L12.4 5.1', stroke: 'currentColor', 'stroke-width': 1.2, 'stroke-linecap': 'round' }),
      )
    }

    /** 右栏页签上的标题。 */
    function RadarTitle() {
      return 'AI 产品雷达'
    }

    /** 面板正文：三个视图 + 存储状态。 */
    function RadarBody() {
      const [meta, setMeta] = React.useState(null)
      const [state, setState] = React.useState(null)
      const [banner, setBanner] = React.useState('')
      const [counts, setCounts] = React.useState({ unreadChanges: null, sources: null, opportunities: null })

      /*
       * 三个视图的工作位置（筛选、搜索、分页、打开的详情、滚动位置）全部住在这里，
       * 而不是各自组件内部。理由：从一条变化跳到它的机会时 `InboxView` 会卸载 ——
       * 如果这些状态留在组件里，回来时会被重置成默认值，用户会发现自己"返回后
       * 回到了另一个地方"。
       *
       * `stack` 记录来路：跨视图跳转后按返回，应该回到跳出来的那一页（可能正是
       * 某条变化的详情），而不是本视图的列表开头。
       */
      const [nav, setNav] = React.useState({
        view: 'inbox',
        stack: [],
        inbox: { status: 'unread', query: '', offset: 0, detailId: null, scrollTop: 0, loadedAt: 0 },
        sources: { detailId: null, scrollTop: 0, loadedAt: 0 },
        opps: { status: 'all', query: '', offset: 0, detailId: null, scrollTop: 0, loadedAt: 0 },
      })
      const bodyRef = React.useRef(null)

      const onCounts = React.useCallback((patch) => setCounts((prev) => ({ ...prev, ...patch })), [])

      const patchSlice = React.useCallback((key, patch) => {
        setNav((prev) => ({ ...prev, [key]: { ...prev[key], ...patch } }))
      }, [])

      /** 进入某个视图的某条详情。离开前先把当前列表的滚动位置存下来。 */
      const openDetail = React.useCallback((key, detailId) => {
        const scrollTop = bodyRef.current ? bodyRef.current.scrollTop : 0
        setNav((prev) => {
          const from = prev.view
          const next = { ...prev, view: key, stack: [...prev.stack, from] }
          // 先记下"离开的那个视图"的滚动位置。
          next[from] = { ...prev[from], scrollTop }
          /*
           * 再设置目标视图的详情。**必须基于 `next[key]` 而不是 `prev[key]`** ——
           * 在本视图内打开详情时 `key === from`，两个计算属性其实是同一个键，
           * 后写的会覆盖先写的；基于 `prev` 展开就会把刚存下的 scrollTop 丢掉，
           * 于是"返回后恢复滚动位置"永远是 0。
           */
          next[key] = { ...next[key], detailId }
          return next
        })
      }, [])

      /**
       * 返回。
       *
       * 栈顶是**另一个**视图时，回到那个视图并保留它当时的详情（用户是从那条
       * 变化跳到机会的，返回就该回到那条变化）；栈空或栈顶就是本视图时，只关掉
       * 本视图的详情，回到自己的列表。
       */
      const back = React.useCallback(() => {
        setNav((prev) => {
          const stack = [...prev.stack]
          const target = stack.pop()
          if (target === undefined || target === prev.view) {
            return { ...prev, stack, [prev.view]: { ...prev[prev.view], detailId: null } }
          }
          return { ...prev, view: target, stack }
        })
      }, [])

      /** 点页签直接切视图：清空来路栈，因为这不是一次"跳出去"。 */
      const switchView = React.useCallback((key) => {
        const scrollTop = bodyRef.current ? bodyRef.current.scrollTop : 0
        setNav((prev) => (prev.view === key ? prev : { ...prev, view: key, stack: [], [prev.view]: { ...prev[prev.view], scrollTop } }))
      }, [])

      /*
       * 恢复滚动位置。
       *
       * 刻意不给依赖数组：切视图后列表要先把数据读回来才有高度，太早写 scrollTop
       * 会被随后的内容撑开重置掉。用 `loadedAt` 当"内容到位了"的信号，每次渲染
       * 都检查一次，恢复一次就停（否则会一直和用户的滚动打架）。
       */
      const restoredRef = React.useRef({ key: null, done: false })
      React.useLayoutEffect(() => {
        const el = bodyRef.current
        if (!el) return
        const key = `${nav.view}|${nav[nav.view]?.detailId ?? ''}`
        if (restoredRef.current.key !== key) restoredRef.current = { key, done: false }
        if (restoredRef.current.done) return
        const slice = nav[nav.view] ?? {}
        if (slice.detailId) {
          el.scrollTop = 0
          restoredRef.current.done = true
          return
        }
        if (slice.loadedAt) {
          el.scrollTop = slice.scrollTop ?? 0
          restoredRef.current.done = true
        }
      })

      const bootstrap = React.useCallback(async () => {
        const [metaResult, stateResult] = await Promise.all([api('/meta'), api('/state')])
        if (metaResult.ok) setMeta(metaResult.data)
        else setBanner(`读取能力清单失败：${failText(metaResult)}`)
        if (stateResult.ok) setState(stateResult.data)
        else setBanner(`读取存储状态失败：${failText(stateResult)}`)
      }, [])

      React.useEffect(() => {
        void bootstrap()
      }, [bootstrap])

      const storage = state?.storage
      const storageOk = storage?.ok === true
      const view = nav.view

      const tab = (key, label, count) =>
        h(
          'button',
          { className: view === key ? 'apr-tab is-active' : 'apr-tab', type: 'button', onClick: () => switchView(key) },
          label,
          count === null || count === undefined ? null : h('span', { className: 'apr-count' }, String(count)),
        )

      return h(
        'div',
        { className: 'apr-root' },
        !storageOk
          ? h(
              'div',
              { style: { padding: '0 12px 6px' } },
              h(
                'p',
                { className: 'apr-note is-error' },
                `存储不可用：${orDash(storage?.reason)} —— 现在读到的一切都可能不是完整历史。`,
              ),
            )
          : null,
        banner ? h('div', { style: { padding: '0 12px 6px' } }, ErrorNote({ text: banner })) : null,

        h(
          'div',
          { className: 'apr-tabs' },
          tab('inbox', '变化', counts.unreadChanges),
          tab('sources', '关注源', counts.sources),
          tab('opps', '机会池', counts.opportunities),
        ),

        h(
          'div',
          { className: 'apr-body', ref: bodyRef },
          view === 'inbox'
            ? h(InboxView, { counts, onCounts, storageOk, meta, slice: nav.inbox, patchSlice, openDetail, back })
            : null,
          view === 'sources' ? h(SourcesView, { meta, onCounts, slice: nav.sources, patchSlice, openDetail, back }) : null,
          view === 'opps' ? h(OpportunitiesView, { meta, onCounts, slice: nav.opps, patchSlice, openDetail, back }) : null,

          h('div', { className: 'apr-sep' }),
          h(
            'p',
            { className: 'apr-hint' },
            storageOk
              ? `数据保存在宿主侧存储域，已打开 ${orDash(storage?.openCount)} 次，最近一次 ${orDash(fmtTime(storage?.lastOpenedAt))}${storage?.lastRefreshAt ? `，上次刷新 ${orDash(fmtTime(storage.lastRefreshAt))}` : ''}。刷新与判定不调用任何模型。`
              : '存储未就绪，界面不会显示任何"已保存"。',
          ),
          meta
            ? h('p', { className: 'apr-hint' }, `来源类型：${(meta.adapters ?? []).map((a) => a.label).join(' / ')} · 刷新时模型调用次数：${meta.modelCallsInRefresh ?? 0}`)
            : null,
        ),
      )
    }

    module.exports.inject = ['slots']

    module.exports.apply = (ctx) => {
      ctx.inject(['sidebarRightTabs'], (srCtx) => {
        const tabs = srCtx.sidebarRightTabs
        if (!tabs || typeof tabs.register !== 'function') {
          console.warn(`[${KIND}] 官方右侧栏不可用 —— 页签未注册`)
          return
        }

        srCtx.effect(
          () =>
            tabs.register({
              id: TAB_ID,
              kind: KIND,
              priority: 'extension',
              title: RadarTitle,
              guide: [
                {
                  order: 60,
                  title: () => 'AI 产品雷达',
                  description: () => '关注公开来源，识别前后变化，沉淀产品机会',
                  icon: RadarGlyph,
                },
              ],
            }),
          `${KIND}: sidebar-right type`,
        )

        srCtx.effect(
          () =>
            srCtx.slots.inject('sidebar.right.pane.tab', () =>
              srCtx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, RadarBody),
            ),
          `${KIND}: sidebar-right body`,
        )

        srCtx.effect(
          () =>
            srCtx.slots.inject('sidebar.right.pane.tab.title', () =>
              srCtx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, RadarTitle),
            ),
          `${KIND}: sidebar-right title`,
        )

        console.log(`[${KIND}] 官方右侧栏页签已注册：kind = ${KIND}`)
      })

      // 会话头部的入口按钮：没有它就只能在右栏已打开时看到本插件。
      //
      // 必须与 Knit 完全同形（`08_Knit/knit/src/client/client.js:5581-5588`）：
      //   • 组件**只**作为 register 的第 2 个位置参数传入；
      //   • options 里**不能**再写 `component`，更不能误把面板正文传进来。
      // 曾写成 `register({ …, component: () => … }, RadarBody)`，而 DSH 取的是位置参数，
      // 于是整个雷达面板被渲染进了会话头部（实测 DOM 祖先链：
      // apr-root → wSkVaW_headerUtilities → wSkVaW_titleRow），把主区顶成一大块面板。
      const RadarEntryButton = () =>
        h(
          'button',
          {
            className: 'apr-btn',
            type: 'button',
            title: '打开 AI 产品雷达',
            style: { display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 8px' },
            onClick: () => {
              const sidebarRight = ctx.get('sidebarRight')
              if (sidebarRight && typeof sidebarRight.openTab === 'function') sidebarRight.openTab(KIND)
            },
          },
          h(RadarGlyph),
          h('span', null, 'AI 产品雷达'),
        )

      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          {
            name: 'conversation.session.header.utilities',
            id: `${KIND}:entry`,
            order: 45,
          },
          RadarEntryButton,
        ),
      )
    }

    // 测试钩子：本插件没有构建步骤，组件无法从外部 import，所以只能由模块
    // 自己把组件挂出来。**只被 `test/client.test.mjs` 使用**，宿主不读这个字段，
    // 也不构成对外接口 —— 不要在产品代码里依赖它。
    module.exports.__test = {
      RadarBody,
      RadarTitle,
      RadarGlyph,
      InboxView,
      ChangeDetail,
      SourcesView,
      SourceDetail,
      OpportunitiesView,
      OpportunityDetail,
      EditOpportunity,
      SnapshotRow,
      fmtTime,
      fmtAgo,
      orDash,
      nextRunAt,
      INTERVAL_OPTIONS,
      PAGE_SIZE,
    }

    // 样式只注入一次。
    const styleId = 'dsh-apradar-style'
    if (typeof document !== 'undefined' && !document.getElementById(styleId)) {
      const style = document.createElement('style')
      style.id = styleId
      style.textContent = CSS
      document.head.appendChild(style)
    }

    return module.exports
  },
})
