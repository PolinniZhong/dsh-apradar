/**
 * Client 半边测试的最小渲染器与模块装载器。
 *
 * 这里**不**依赖真实 React：本插件运行在宿主的模块装载器里，`react` 由装载器
 * 提供，工程目录下并没有这个依赖。所以注入一个最小渲染器 —— 它实现
 * `createElement` 与常用 Hook，并且**按组件实例**保存 Hook 状态、支持
 * `setState` 触发重渲染、渲染后执行 `useEffect` / `useLayoutEffect`。
 * 够用的判据是：被测代码是**真实的**那份 `src/client/client.js`，走的是真实的
 * Hook 调用序列。
 *
 * 抽成独立文件是因为现在有两个测试文件要用它（`client.test.mjs` 与
 * `detail.test.mjs`）—— 两份复制品会漂移，而这份替身一旦与被测代码的 Hook
 * 序列不一致，测出来的结论就没有意义。
 *
 * @module dsh-apradar/test/client-harness
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
export const CLIENT_PATH = resolve(HERE, '../src/client/client.js')
/** 被测客户端的源码文本。有些测试直接对源码做静态契约检查。 */
export const SOURCE = readFileSync(CLIENT_PATH, 'utf8')

// ------------------------------------------------------------------ 最小渲染器

/** 渲染器的内部状态。每次 `loadClient()` 都会重置，避免测试之间串味。 */
export function createRenderer() {
  /** 每个组件实例一份 Hook 槽位，键是组件在树中的位置路径。 */
  let instances = new Map()
  /**
   * 本轮渲染真正走到的组件路径。
   *
   * 渲染结束后，不在这个集合里的实例会被删掉 —— 这就是 React 的"卸载"：
   * 父组件不再渲染某个子组件时，它的 Hook 状态必须消失。少了这一步，
   * 切走再切回视图时组件会"带着上次的 state 复活"，比真实行为少发请求、
   * 少走一遍加载态，测试会测出一个真实浏览器里不存在的世界。
   */
  let touched = null
  /** 本轮渲染正在使用的组件实例。 */
  let currentInstance = null
  /** 本轮渲染收集到的 Hook 序号计数（每实例独立）。 */
  let hookIndex = 0
  /** 待执行的副作用。 */
  let pendingEffects = []
  /**
   * useLayoutEffect 的待执行队列。
   *
   * 这个替身没有真实 DOM 的布局阶段，所以 layout effect 只是"在普通 effect 之前
   * 跑"——它唯一的用处是让被测代码的恢复逻辑（读一个 ref 上的 scrollTop）有机会
   * 执行到。`bodyRef.current` 在替身里恒为 null，被测代码因此会直接返回。
   */
  let pendingLayoutEffects = []
  /** 有 setState 落下来就把这个标志置起，驱动循环据此决定是否再渲染一轮。 */
  let dirty = false

  function shallowEqual(a, b) {
    if (a === b) return true
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((value, index) => Object.is(value, b[index]))
  }

  const React = {
    createElement(type, props, ...children) {
      const flat = []
      for (const child of children) {
        if (Array.isArray(child)) flat.push(...child)
        else flat.push(child)
      }
      return { type, props: props ?? {}, children: flat }
    },
    useState(initial) {
      const instance = currentInstance
      const index = hookIndex++
      if (instance.hooks.length <= index) {
        instance.hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      }
      const slot = instance.hooks[index]
      const setter = (next) => {
        const value = typeof next === 'function' ? next(slot.value) : next
        if (Object.is(value, slot.value)) return
        slot.value = value
        dirty = true
      }
      return [slot.value, setter]
    },
    useEffect(fn, deps) {
      const instance = currentInstance
      const index = hookIndex++
      pendingEffects.push({ instance, index, fn, deps })
    },
    useLayoutEffect(fn, deps) {
      const instance = currentInstance
      const index = hookIndex++
      pendingLayoutEffects.push({ instance, index, fn, deps })
    },
    useCallback(fn, deps) {
      const instance = currentInstance
      const index = hookIndex++
      const slot = instance.hooks[index]
      if (!slot || !shallowEqual(slot.deps, deps)) {
        instance.hooks[index] = { value: fn, deps }
        return fn
      }
      return slot.value
    },
    useMemo(fn, deps) {
      const instance = currentInstance
      const index = hookIndex++
      const slot = instance.hooks[index]
      if (!slot || !shallowEqual(slot.deps, deps)) {
        const value = fn()
        instance.hooks[index] = { value, deps }
        return value
      }
      return slot.value
    },
    useRef(initial) {
      const instance = currentInstance
      const index = hookIndex++
      const slot = instance.hooks[index]
      if (!slot) instance.hooks[index] = { current: initial }
      return instance.hooks[index].current === undefined && !('current' in instance.hooks[index])
        ? (instance.hooks[index] = { current: initial })
        : instance.hooks[index]
    },
  }

  /** 把一个元素渲染成宿主树。函数组件会被调用。 */
  function renderNode(node, path) {
    if (node === null || node === undefined || node === false || node === true) return null
    if (typeof node === 'string' || typeof node === 'number') return { text: String(node) }
    if (Array.isArray(node)) return node.map((child, index) => renderNode(child, `${path}.${index}`)).filter(Boolean)

    const { type, props, children } = node

    if (typeof type === 'function') {
      let instance = instances.get(path)
      if (!instance) {
        instance = { hooks: [] }
        instances.set(path, instance)
      }
      // 记下这一轮真正渲染到的组件，好把不再渲染的那些当作"卸载"清掉。
      if (touched) touched.add(path)
      const previousInstance = currentInstance
      const previousIndex = hookIndex
      currentInstance = instance
      hookIndex = 0
      let output
      try {
        output = type({ ...props, children: children.length ? children : undefined })
      } finally {
        currentInstance = previousInstance
        hookIndex = previousIndex
      }
      return renderNode(output, `${path}>`)
    }

    const rendered = children.map((child, index) => renderNode(child, `${path}.${index}`)).filter(Boolean)
    const host = { tag: type, props, children: rendered }
    /*
     * 极简的 ref 支持：只给宿主元素挂一个假 DOM 元素，让被测代码里
     * "记住滚动位置 / 写回滚动位置" 这条链真的被执行到。
     * 元素对象跨重渲染复用（真实 DOM 也是同一个节点），所以 scrollTop 会保留 ——
     * 这正是"返回列表后滚动位置是否恢复"能被测出来的前提。
     */
    if (props && props.ref && typeof props.ref === 'object') {
      if (!props.ref.current || typeof props.ref.current !== 'object' || !('scrollTop' in props.ref.current)) {
        props.ref.current = { tag: type, scrollTop: 0, scrollHeight: 0 }
      }
      host.element = props.ref.current
    }
    return host
  }

  /** 在宿主树里按谓词找第一个节点（不要求可点击）。 */
  function find(node, predicate) {
    if (!node) return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = find(child, predicate)
        if (found) return found
      }
      return null
    }
    if (predicate(node, textOf(node))) return node
    for (const child of node.children ?? []) {
      const found = find(child, predicate)
      if (found) return found
    }
    return null
  }

  /** 在宿主树里按文本找第一个可点击元素。 */
  function findClickable(node, predicate) {
    if (!node) return null
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = findClickable(child, predicate)
        if (found) return found
      }
      return null
    }
    if (node.props && typeof node.props.onClick === 'function' && predicate(node, textOf(node))) return node
    for (const child of node.children ?? []) {
      const found = findClickable(child, predicate)
      if (found) return found
    }
    return null
  }

  /** 取一棵子树里的全部文本。 */
  function textOf(node) {
    if (!node) return ''
    if (node.text !== undefined) return node.text
    return (node.children ?? []).map(textOf).join('')
  }

  /**
   * 执行一批候到的副作用。
   *
   * 依赖数组相同的会被跳过（与 React 一致）；有依赖时把依赖记到 hook 槽上，
   * 无依赖的 effect 每次渲染都会跑。
   */
  function flushEffects(queue) {
    // 先复制再清空。直接 `queue.length = 0` 会把要遍历的那个数组本身清掉。
    const effects = [...queue]
    queue.length = 0
    for (const effect of effects) {
      const slot = effect.instance.hooks[effect.index]
      if (slot && slot.deps && effect.deps && shallowEqual(slot.deps, effect.deps)) continue
      if (effect.deps) effect.instance.hooks[effect.index] = { deps: effect.deps, ran: true }
      const cleanup = effect.fn()
      if (typeof cleanup === 'function') effect.instance.hooks[effect.index].cleanup = cleanup
    }
  }

  /**
   * 渲染根组件直到收敛。
   *
   * 每轮：调用组件 → 执行候到的副作用 → 让微任务队列跑空 → 如果期间有
   * setState 就再来一轮。步数上限是防止"effect 里 setState、setState 又
   * 触发新 effect"写成了死循环时测试挂住。
   */
  async function render(Component, props = {}, { steps = 40 } = {}) {
    let tree = null
    for (let step = 0; step < steps; step += 1) {
      dirty = false
      pendingEffects = []
      pendingLayoutEffects = []
      touched = new Set()
      tree = renderNode(React.createElement(Component, props), 'root')
      /*
       * 卸载语义：这一轮没被渲染到的组件实例，其 Hook 状态必须消失。
       * 少了这一步，切走再切回视图时组件会"带着上次的 state 复活"，
       * 比真实 React 少发请求、少走一遍加载态。
       */
      for (const key of [...instances.keys()]) {
        if (!touched.has(key)) instances.delete(key)
      }
      touched = null

      // layout effect 先跑：真实 React 里它在绘制前同步执行。
      flushEffects(pendingLayoutEffects)
      flushEffects(pendingEffects)

      // 让 effect 里发起的 fetch 有机会落地（含 fetch → then → setState 的多跳）。
      for (let tick = 0; tick < 12; tick += 1) await Promise.resolve()
      if (!dirty) return tree
    }
    throw new Error(`渲染 ${steps} 轮仍未收敛，可能是 effect 里形成了 setState 循环`)
  }

  return { React, render, find, findClickable, textOf, reset: () => { instances = new Map() } }
}

/** 装一个响应对象，形状对齐 `fetch()` 返回值的被测子集。 */
export function jsonResponse(envelope, status = 200) {
  const text = JSON.stringify(envelope)
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : null) },
    text: async () => text,
  }
}

/**
 * 装载真实的客户端模块。
 *
 * @param {object} options
 * @param {(req: {method: string, path: string, body: unknown}) => object} options.respond 决定每个请求的响应信封
 * @returns {{ exported: object, requests: object[], renderer: object }}
 */
export function loadClient({ respond }) {
  const renderer = createRenderer()
  const requests = []

  let loaded = null
  const loader = {
    load({ factory }) {
      const require = (name) => {
        if (name === 'react') return renderer.React
        throw new Error(`客户端只允许 require('react')，实际请求了 ${name}`)
      }
      loaded = factory(require)
      return loaded
    },
  }

  const styleNodes = []
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousFetch = globalThis.fetch

  globalThis.window = { __ModuleLoader__: loader }
  globalThis.document = {
    head: { appendChild: (node) => styleNodes.push(node) },
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '' }),
  }
  globalThis.fetch = async (url, init = {}) => {
    const method = String(init.method ?? 'GET').toUpperCase()
    const path = String(url)
    const body = init.body ? JSON.parse(init.body) : undefined
    requests.push({ method, path, body })
    const result = respond({ method, path, body })
    if (result instanceof Error) throw result
    return jsonResponse(result.envelope ?? result, result.status ?? 200)
  }

  let exported = null
  // 模块是 IIFE 风格：加载即执行 `window.__ModuleLoader__.load(...)`。
  // 用 `new Function` 而不是 `import()`，因为源码引用全局 `window`，
  // 而 ESM 下没有可靠的"只注入 window 再执行"的方式。
  new Function('window', SOURCE)(globalThis.window)
  exported = loaded

  return {
    exported,
    requests,
    renderer,
    restore() {
      globalThis.window = previousWindow
      globalThis.document = previousDocument
      globalThis.fetch = previousFetch
    },
  }
}
