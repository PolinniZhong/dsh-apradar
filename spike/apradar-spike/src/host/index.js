/**
 * AI 产品雷达 · P0-00 技术验证 Spike —— Host 半边
 *
 * 这不是产品代码，也不是 Demo。它唯一的职责是让 V1 / V6 可被实测：
 *   ① 右栏页签能否注册（Client 半边）
 *   ② Client 能否同源访问插件注册的 HTTP 路由
 *   ③ Host 正常响应能否被解析
 *   ④ 异常态（错误码 / 非 JSON / 超时）能否被区分且界面不崩溃
 *
 * 接口用法只参照本机已核验的两处公开形态：
 *   - 路由注册：`webServer.register({ kind: 'prefix', path, handler })`
 *     （Knit 在 08_Knit/knit/src/host/index.js:2058 的同款调用；
 *      路径前缀式注册，回调返回 unregister）
 *   - 生命周期：`ctx.inject(['webServer'], cb)` + 回调内 `webCtx.effect(fn, label)`
 *
 * 刻意不做的事：不读写任何存储、不出网、不碰工作区文件。
 */

export const name = 'dsh-apradar-spike'

/** 与 Client 半边约定的路由前缀。Client 用同源相对路径访问它。 */
const ROUTE_PREFIX = '/apradar-spike'

/** `/hang` 的等待时长：足够让 Client 侧主动超时，又不会挂死进程。 */
const HANG_MS = 10_000

/**
 * 只服务回环地址。
 *
 * 照抄的是 Knit 的同款判断口径（`req.socket.remoteAddress`），
 * 但这里的目的更窄：Spike 只是本机验证工具，不应对局域网暴露。
 */
function isLoopback(address) {
  if (!address) return false
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1'
  )
}

/** 统一的 JSON 应答形状，与产品侧路由契约保持同构（`ok` + `code`）。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(text)
}

export function apply(ctx) {
  // `webServer` 缺席时这个回调**根本不跑**（cordis 的 inject 语义：服务不齐就静默不加载）。
  // 这正是要的降级路径 —— 没有 webServer 的环境不应该因为本插件而报错。
  ctx.inject(['webServer'], (webCtx) => {
    const handler = async (req, res) => {
      if (!isLoopback(req.socket?.remoteAddress)) {
        sendJson(res, 403, { ok: false, code: 'spike/loopback-only' })
        return
      }

      const url = new URL(req.url || '/', 'http://localhost')
      const path = url.pathname

      if (req.method !== 'GET') {
        sendJson(res, 405, { ok: false, code: 'spike/method-not-allowed' })
        return
      }

      try {
        // ── ③ 正常响应：Host 把「谁在访问、页面来源是谁」如实回给 Client ──
        if (path === `${ROUTE_PREFIX}/ping`) {
          sendJson(res, 200, {
            ok: true,
            code: 'spike/pong',
            ts: new Date().toISOString(),
            // Client 侧会把它与 `window.location.origin` 对照 —— 这是 V1 的核心判据。
            host: req.headers.host || '',
            origin: req.headers.origin || '(无 Origin 头)',
            referer: req.headers.referer || '(无 Referer 头)',
            method: req.method,
            url: req.url,
            userAgent: req.headers['user-agent'] || '',
            pid: process.pid,
            node: process.version,
          })
          return
        }

        // ── ④a 异常态：明确的错误码 + 非 2xx ──
        if (path === `${ROUTE_PREFIX}/boom`) {
          sendJson(res, 500, { ok: false, code: 'spike/boom', detail: '这是故意制造的服务端错误' })
          return
        }

        // ── ④b 异常态：200 但**不是** JSON（Client 必须能识别而不是崩在 JSON.parse）──
        if (path === `${ROUTE_PREFIX}/not-json`) {
          const text = '<!doctype html><title>not json</title><p>这不是 JSON</p>'
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(text),
            'cache-control': 'no-store',
          })
          res.end(text)
          return
        }

        // ── ④c 异常态：慢响应（Client 侧主动 abort，用于验证超时可区分）──
        if (path === `${ROUTE_PREFIX}/hang`) {
          await new Promise((resolve) => setTimeout(resolve, HANG_MS))
          sendJson(res, 200, { ok: true, code: 'spike/too-late' })
          return
        }

        // ── ④d 异常态：空响应体（200 + 零长度，用于验证 Client 的空体处理）──
        if (path === `${ROUTE_PREFIX}/empty`) {
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': '0',
            'cache-control': 'no-store',
          })
          res.end()
          return
        }

        sendJson(res, 404, { ok: false, code: 'spike/not-found-route' })
      } catch (error) {
        sendJson(res, 500, {
          ok: false,
          code: 'spike/internal',
          detail: String((error && error.message) || error),
        })
      }
    }

    webCtx.effect(() => {
      const unregister = webCtx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler,
      })
      console.log(
        `[${name}] spike route ready: ${ROUTE_PREFIX}/ping, /boom, /not-json, /hang, /empty`,
      )
      return () => unregister()
    }, 'dsh-apradar-spike: host route')
  })
}
