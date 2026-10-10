/**
 * AI 产品雷达 · P0-00 Spike —— 真实渲染进程探针（测试工具，不是插件代码）
 *
 * 为什么需要它：Milestone 0 要求「在真实运行的渲染进程里完成 Client → Host → Client 往返」。
 * 本机没有可用的 Playwright 浏览器（版本与缓存不匹配），但系统装有 Google Chrome，
 * 且 Node 22+ 自带全局 WebSocket —— 于是用「Chrome + CDP」实现零依赖的真实渲染验证。
 *
 * 它做四件事：
 *   1. 以 headless 模式启动本机 Chrome，读取 DevToolsActivePort
 *   2. 用 CDP 打开目标 URL，收集页面 console 与未捕获异常
 *   3. 在页面里执行给定的求值脚本（awaitPromise），把结果原样返回
 *   4. 截图落盘（可选）
 *
 * 用法：
 *   node cdp-run.mjs <url> <evalFile.js> [screenshot.png] [--wait-selector=<css>] [--wait-ms=3000]
 *
 * 依赖：仅 Node 内建能力（node:child_process / node:fs / 全局 fetch / 全局 WebSocket）。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { connect as wsConnect } from './ws-raw.mjs'

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'

const argv = process.argv.slice(2)
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith('--')).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=')
    return [k, v === undefined ? true : v]
  }),
)
const positional = argv.filter((a) => !a.startsWith('--'))
const [targetUrl, evalFile, shotPath] = positional

if (!targetUrl || !evalFile) {
  console.error('用法: node cdp-run.mjs <url> <evalFile.js> [screenshot.png] [--wait-selector=css] [--wait-ms=3000]')
  process.exit(2)
}

const waitMs = Number(flags['wait-ms'] || 3000)
const profileDir = mkdtempSync(join(tmpdir(), 'apr-cdp-'))
const result = { url: targetUrl, startedAt: new Date().toISOString(), console: [], pageErrors: [], failedRequests: [], evaluate: null, screenshot: null, error: null }

let chrome
let ws

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitForPortFile(timeoutMs = 15000) {
  const file = join(profileDir, 'DevToolsActivePort')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(file)) {
      const [port] = readFileSync(file, 'utf8').split('\n')
      if (port && Number(port) > 0) return Number(port)
    }
    await sleep(120)
  }
  throw new Error('Chrome 未在超时内写出 DevToolsActivePort')
}

/** 极简 CDP 客户端：只用 id/method/params 与 event 回调。 */
class Cdp {
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.listeners = []
  }
  async connect() {
    this.ws = await wsConnect(this.url)
    this.ws.on('message', (data) => {
      let msg
      try {
        msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8'))
      } catch {
        return
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        if (msg.error) reject(new Error(JSON.stringify(msg.error)))
        else resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg)
      }
    })
    this.ws.on('error', (e) => {
      for (const { reject } of this.pending.values()) reject(e)
      this.pending.clear()
    })
  }
  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id)
          reject(new Error('CDP 超时: ' + method))
        }
      }, 30000)
    })
  }
  on(fn) {
    this.listeners.push(fn)
  }
  close() {
    try { this.ws.close() } catch { /* 已关闭 */ }
  }
}

try {
  chrome = spawn(CHROME, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    // 本机实测：在 DSH 的文件沙箱下，Chrome 自带的 crashpad / sandbox 无法写入
    // 自己的目录，会导致 DevTools 会话在收到第一个帧后立刻关闭（close 1006）。
    // 这三个开关只为让无人值守的 headless 会话稳定跑完探针。
    '--no-sandbox',
    '--disable-crash-reporter',
    '--disable-crashpad',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--window-size=1440,900',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let chromeErr = ''
  chrome.stderr.on('data', (d) => { chromeErr += d.toString() })

  const port = await waitForPortFile()

  // 找到 page target
  let target = null
  for (let i = 0; i < 40 && !target; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json()).catch(() => [])
    target = list.find((t) => t.type === 'page')
    if (!target) await sleep(150)
  }
  if (!target) throw new Error('未找到 CDP page target')

  const cdp = new Cdp(target.webSocketDebuggerUrl)
  await cdp.connect()
  cdp.on((msg) => {
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args || [])
        .map((a) => (a.value !== undefined ? a.value : a.description !== undefined ? a.description : a.type))
        .join(' ')
      result.console.push({ type: msg.params.type, text })
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails || {}
      result.pageErrors.push(d.exception?.description || d.text || '(未知异常)')
    } else if (msg.method === 'Network.loadingFailed') {
      result.failedRequests.push({ id: msg.params.requestId, error: msg.params.errorText, blocked: msg.params.blockedReason })
    }
  })

  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')
  await cdp.send('Network.enable')

  await cdp.send('Page.navigate', { url: targetUrl })
  await sleep(waitMs)

  if (flags['wait-selector']) {
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `!!document.querySelector(${JSON.stringify(flags['wait-selector'])})`,
        returnByValue: true,
      })
      if (r.result?.value) break
      await sleep(200)
    }
  }

  const evalSource = readFileSync(evalFile, 'utf8')
  const evaled = await cdp.send('Runtime.evaluate', {
    expression: evalSource,
    awaitPromise: true,
    returnByValue: true,
    timeout: 60000,
  })
  if (evaled.exceptionDetails) {
    result.error = '求值抛错: ' + JSON.stringify(evaled.exceptionDetails).slice(0, 800)
  } else {
    result.evaluate = evaled.result?.value ?? null
  }

  if (shotPath) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    writeFileSync(shotPath, Buffer.from(shot.data, 'base64'))
    result.screenshot = shotPath
  }

  cdp.close()
} catch (error) {
  result.error = String(error?.stack || error)
} finally {
  try { chrome?.kill('SIGKILL') } catch { /* 已退出 */ }
  await sleep(200)
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* 清理失败不影响结论 */ }
  result.finishedAt = new Date().toISOString()
  console.log(JSON.stringify(result, null, 2))
}
