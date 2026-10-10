/**
 * AI 产品雷达 —— Host 半边（Cordis 插件入口）。
 *
 * ## 职责边界（SDD §2）
 *
 * Host 负责：打开持久化域、维护权威数据、注册同源路由、把可核验的状态交给 Client。
 * Host **不**负责：任何界面。界面全在 `src/client/client.js`。
 *
 * ## 装配顺序与"为什么不是全都要 inject"
 *
 * 只 `ctx.inject(['webServer'], …)`：**不**把 `storageDomain`、`web` 写进 inject。
 * 原因是如果某个设施永远不出现，inject 回调就永不执行，插件会以"完全不存在"的
 * 方式失败 —— 用户看不到任何解释。这里改为：**路由一定注册**，能力缺失时如实
 * 回报（存储 `persisted:false`、出网 `WEB_PROVIDER_ERROR` 并附原因）。
 *
 * ## 服务只构造一次，存储句柄是晚绑定的
 *
 * `createService()` 拿到的 `store` 是一个**代理**：它把每次调用转发给当时真正的
 * 句柄。这样"存储打开是异步的"就不会要求服务层延迟构造 —— 在存储就绪之前调用
 * 任何方法都会得到明确的 `STORAGE_OPEN_FAILED`，而不是 `undefined is not a function`。
 *
 * @module dsh-apradar
 */

import { ROUTES, ROUTE_PREFIX, createHandler } from './http.js'
import { openRadarStore } from './store/index.js'
import { createService } from './service.js'
import { describeClientHalf, describeTypert } from './capabilities.js'
import { createScheduler } from './scheduler.js'
import { createWebGateway } from './fetch/gateway.js'
import { PLUGIN_VERSION } from './version.js'

/** Cordis 插件名。必须与 `package.json` 的 `name` 一致（由 `test/version.test.mjs` 断言）。 */
export const name = 'dsh-apradar'

/** 存储尚未就绪时的占位。字段与方法都齐全，因此下游永远不会撞到 `undefined`。 */
const NOT_READY = Object.freeze({
  ok: false,
  specMode: 'pending',
  reason: '存储尚未初始化完成',
})

/**
 * 把对存储句柄的调用转发给"当前"句柄。
 *
 * 只转发真实存在的接口；`all` 这类同步方法直接透传，异步方法也透传（返回 promise）。
 * 不在代理里做任何缓存 —— 缓存会让"存储打不开"变成难以复现的陈旧数据。
 *
 * @param {() => object} current 返回当前句柄
 * @returns {object} 形状与真实句柄一致的代理
 */
function createStoreProxy(current) {
  const forward = (method) => (...args) => current()[method](...args)
  return {
    get ok() {
      return current().ok === true
    },
    get specMode() {
      return current().specMode ?? 'unknown'
    },
    get reason() {
      return current().reason ?? null
    },
    all: forward('all'),
    get: forward('get'),
    put: forward('put'),
    del: forward('del'),
    counts: forward('counts'),
    state: forward('state'),
    markRefreshed: forward('markRefreshed'),
    listSources: forward('listSources'),
    sourceCount: forward('sourceCount'),
  }
}

/**
 * 插件装配。
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx 插件上下文
 * @returns {void}
 */
export function apply(ctx) {
  /** 当前存储句柄。先放占位，`openRadarStore` 完成后替换。 */
  let store = NOT_READY

  const log = (message) => console.log(`[${name}] ${message}`)
  const warn = (message) => console.warn(`[${name}] ${message}`)

  const storeProxy = createStoreProxy(() => store)
  const gateway = createWebGateway(ctx)

  const service = createService({
    store: storeProxy,
    gateway,
    now: () => Date.now(),
    log,
  })

  const runtime = () => ({
    plugin: name,
    pluginVersion: PLUGIN_VERSION,
    node: process.versions.node,
    pid: process.pid,
  })

  const handler = createHandler({
    getService: () => service,
    getRuntime: runtime,
    now: () => new Date().toISOString(),
  })

  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(
      () => {
        const unregister = webCtx.webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler,
        })
        log(`host route ready: ${ROUTES.length} endpoints under ${ROUTE_PREFIX}`)
        // 卸载/重载时必须真正注销：返回 disposer 交给 ctx.effect。
        return () => {
          unregister()
          log(`host route removed: ${ROUTE_PREFIX}`)
        }
      },
      `${name}: host route`,
    )

    if (!gateway.available) {
      // 明确说出来：出网能力缺失会让"刷新"永远失败，用户有权在启动日志里看到原因。
      warn(`web fetch unavailable: ${gateway.reason}`)
    }

    // —— 定时刷新（P1-01）——
    //
    // 定时器优先用 DSH 自带的 Cordis 定时器服务：它把句柄登记在当前 fiber 上，
    // 插件释放时自动清理。**不把 `timer` 写进 `ctx.inject`** —— 与本文档开头
    // 同一个理由：设施永远不出现时 inject 回调就永不执行，插件会以"完全不存在"
    // 的方式失败。这里改为主动探测，探测不到就走降级路径并把降级状态如实暴露。
    const timer = typeof webCtx.get === 'function' ? webCtx.get('timer') : null
    const scheduler = createScheduler({
      service,
      setIntervalImpl:
        timer && typeof timer.interval === 'function'
          ? (callback, delay) => timer.interval(callback, delay)
          : undefined,
      log,
      warn,
    })
    service.setScheduler(() => scheduler.status())

    webCtx.effect(
      () => {
        scheduler.start()
        // 定时器句柄随插件释放 —— HMR 反复重载不会累积定时器。
        return () => scheduler.stop()
      },
      `${name}: scheduler`,
    )
    log(
      `scheduler capability: timerService=${timer ? 'yes' : 'no'} ` +
        `available=${scheduler.status().available} degraded=${scheduler.status().degraded}`,
    )

    // —— 运行时能力探测（P1-06 / V4、P1-07 验收 ②）——
    //
    // 把"当前宿主的 typert 注册表是什么状况"与"本插件的客户端半边有没有被
    // 组合进启动图"变成可复核的运行事实，而不只是文档里的结论。
    // 两个 describe 都永不抛，探测不到就如实降级（`available:false` + reason）。
    const probe = (key) => webCtx.get(key)
    service.setRuntime(() => ({
      typert: describeTypert(probe),
      clientHalf: describeClientHalf(probe),
    }))
    {
      const typertReport = describeTypert(probe)
      log(
        `runtime: typert.available=${typertReport.available} packages=${typertReport.packages} ` +
          `descriptors=${typertReport.descriptors} ownPackageRegistered=${typertReport.ownPackageRegistered}` +
          (typertReport.reason ? ` reason=${typertReport.reason}` : ''),
      )
      // 客户端半边缺失必须**在启动时就喊出来**：平台在这条路上不会报错
      // （实测：缺 bundle 时宿主照常启动、页面照常渲染、`client.js` 根本没进启动图，
      // 而 stdout/stderr 与页面都没有任何提示 —— 见 TECH-SPIKE §6.12.4）。
      const clientReport = describeClientHalf(probe)
      if (clientReport.composed === false) {
        warn(`client half NOT composed: ${clientReport.reason}`)
      } else if (clientReport.composed === true) {
        log(`runtime: clientHalf.composed=true path=${clientReport.path}`)
      } else {
        log(`runtime: clientHalf.available=false reason=${clientReport.reason}`)
      }
    }

    void openRadarStore(webCtx, { log })
      .then((opened) => {
        store = opened
        if (opened.ok) {
          const state = opened.state()
          log(
            `storage ready: domain=${opened.domainName} specMode=${opened.specMode} ` +
              `openCount=${state.openCount} sources=${opened.sourceCount()}`,
          )
        } else {
          warn(`storage unavailable: ${opened.reason}`)
        }
      })
      .catch((error) => {
        // openRadarStore 的契约是永不抛出；这里仍然兜一层，因为**一个未处理的
        // 拒绝会把整个宿主进程打成 fatal load failure**（已在隔离 Profile 上实测到），
        // 而本插件的存储问题绝不该让用户的 Harness 起不来。
        store = { ok: false, specMode: 'unknown', reason: `存储初始化异常（${String(error)}）` }
        console.error(`[${name}] storage init crashed: ${String(error)}`)
      })
  })
}
