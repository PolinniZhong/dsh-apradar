/**
 * 定时刷新调度器（P1-01）。
 *
 * ## 为什么是一个循环，而不是「每个来源一个定时器」
 *
 * 200 个来源就是 200 个定时器；每个定时器都要自己处理"上一次还没跑完"、自己处理
 * 释放、自己处理 HMR 重载 —— 这是三处容易各错一次的地方。改成一个循环之后，
 * **并发控制只剩服务层那一份 in-flight 集合**（`refresh()` 里的 `inFlight`），
 * 定时器只需要回答一个问题：现在有哪些来源到期了。
 *
 * 循环还顺带解决了两件事：① 宿主休眠/挂起之后错过的时点会在下一次唤醒时自然补上
 * （因为判定是 `lastCheckedAt + interval <= now`，不是"排到点就该跑"）；
 * ② 一个来源刷新很慢时不会阻塞其它来源的到期判断。
 *
 * ## 定时器能力是**可选**的，缺失必须可见
 *
 * 首选 DSH 自带的 Cordis 定时器服务（`ctx.get('timer')`，来自
 * `@deepseek-ai/cordis-plugin-timer`）：它把定时器句柄登记在当前 fiber 上，
 * 插件被释放时自动清理 —— 这正是 HMR 反复重载时最需要的性质。
 *
 * 该服务不存在时**不静默降级成"永远不刷新"**，而是分两步：
 *  1. 若宿主提供了全局 `setInterval`，仍然启动，但把定时器登记进调用方给的
 *     `dispose` 回调里（由 `ctx.effect` 负责调用），并在状态里标注
 *     `degraded: true` —— 能力是降级来的，用户有权知道。
 *  2. 连全局定时器都没有时，`available: false` 且给出 `reason`；界面据此禁用开关。
 *
 * @module dsh-apradar/src/host/scheduler
 */

import { SCHEDULER_TICK_MS } from './limits.js'

/**
 * 创建调度器。
 *
 * @param {object} options 选项
 * @param {{ refreshDue: () => Promise<object> }} options.service 服务层（只需要 `refreshDue`）
 * @param {(callback: () => void, delayMs: number) => (() => void)} [options.setIntervalImpl]
 *   创建一个重复定时器并返回停止函数。缺省用宿主全局 `setInterval`。
 * @param {number} [options.tickMs] 唤醒间隔
 * @param {(message: string) => void} [options.log] 日志
 * @param {(message: string) => void} [options.warn] 警告日志
 * @returns {object} 调度器
 */
export function createScheduler({
  service,
  setIntervalImpl,
  tickMs = SCHEDULER_TICK_MS,
  log = () => {},
  warn = () => {},
}) {
  /** 是否存在可用的重复定时器能力。 */
  const hasTimer =
    typeof setIntervalImpl === 'function' ||
    typeof globalThis.setInterval === 'function'

  /** 停止函数。`null` 表示未启动。 */
  let stopTimer = null
  /** 是否用了降级路径（全局 setInterval 而非 Cordis 定时器服务）。 */
  let degraded = false
  /** 连续叠起来的 tick 数 —— 一次 tick 还没跑完时又到点，不再排队。 */
  let ticking = false

  const state = {
    /** 单调递增的 tick 计数，用来在界面上证明"调度器真的在跑"。 */
    tickCount: 0,
    /** 最近一次 tick 的时间戳。 */
    lastTickAt: null,
    /** 最近一次 tick 的结果摘要（没有到期来源时 `due: 0`）。 */
    lastResult: null,
    /** 最近一次 tick 抛错的信息。绝不吞掉：调度器静默死掉是最坏的情况。 */
    lastError: null,
  }

  /**
   * 跑一轮：挑出到期来源并刷新。
   *
   * **永不抛出** —— 调度器是后台循环，一次异常不能让整个循环消失。
   * 错误如实记进 `state.lastError` 并打日志，下一轮照常。
   *
   * @returns {Promise<object>} 本轮摘要
   */
  async function tick() {
    if (ticking) return { skipped: true, reason: '上一轮尚未结束' }
    ticking = true
    try {
      const report = await service.refreshDue()
      state.tickCount += 1
      state.lastTickAt = Date.now()
      state.lastError = null
      state.lastResult = {
        due: report.due.length,
        ...report.summary,
      }
      if (report.due.length) {
        log(
          `scheduled refresh: due=${report.due.length} ok=${report.summary.succeeded} ` +
            `failed=${report.summary.failed} newChanges=${report.summary.newChanges}`,
        )
      }
      return state.lastResult
    } catch (error) {
      state.tickCount += 1
      state.lastTickAt = Date.now()
      state.lastError = {
        message: error?.message ?? String(error),
        code: error?.code ?? 'INTERNAL',
        at: state.lastTickAt,
      }
      warn(`scheduled refresh failed: ${state.lastError.code} ${state.lastError.message}`)
      return { failed: true, error: state.lastError }
    } finally {
      ticking = false
    }
  }

  /**
   * 启动循环。重复调用是安全的（第二次是空操作）。
   * @returns {boolean} 是否真的启动了
   */
  function start() {
    if (stopTimer) return false
    if (!hasTimer) {
      warn('scheduler unavailable: 宿主既没有 Cordis 定时器服务，也没有全局 setInterval')
      return false
    }

    if (typeof setIntervalImpl === 'function') {
      degraded = false
      stopTimer = setIntervalImpl(() => {
        void tick()
      }, tickMs)
    } else {
      degraded = true
      const handle = globalThis.setInterval(() => {
        void tick()
      }, tickMs)
      // 降级路径必须自己保证可释放：Node 的定时器默认不会让进程退出时留下
      // 悬挂句柄，但 HMR 反复重载会累积，所以这里显式 `unref`（可能不存在）。
      try {
        handle.unref?.()
      } catch {
        /* 某些运行时的句柄不可 unref —— 不影响正确性，忽略 */
      }
      stopTimer = () => globalThis.clearInterval(handle)
    }

    log(`scheduler started: tick=${tickMs}ms degraded=${degraded}`)
    return true
  }

  /** 停止循环。重复调用是安全的。 @returns {void} */
  function stop() {
    if (!stopTimer) return
    const stop = stopTimer
    stopTimer = null
    try {
      stop()
    } catch (error) {
      warn(`scheduler stop failed: ${String(error)}`)
    }
    log('scheduler stopped')
  }

  /**
   * 对外状态。**这是界面唯一的真相来源** —— 不让界面去猜"定时刷新到底开没开"。
   * @returns {object}
   */
  function status() {
    return {
      available: hasTimer,
      running: stopTimer !== null,
      degraded,
      tickMs,
      tickCount: state.tickCount,
      lastTickAt: state.lastTickAt,
      lastResult: state.lastResult,
      lastError: state.lastError,
      reason: hasTimer ? null : '宿主未提供定时器能力，定时刷新不可用',
    }
  }

  return { start, stop, tick, status }
}
