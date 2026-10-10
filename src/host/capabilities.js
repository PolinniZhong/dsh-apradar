/**
 * 宿主运行时能力探测（P1-06 / V4）。
 *
 * ## 为什么要有这个模块
 *
 * `COMPATIBILITY.md` 的 V4 问的是：「typert 严格模式代码生成在打包运行时是否可用」。
 * 这个问题**不能只靠读文档回答** —— 文档说的是设计意图，而"当前这台机器上的宿主
 * 到底挂没挂 typert 注册表、注册了哪些包、有没有本插件的生成产物"属于运行事实，
 * 必须现场测出来，且结论要能被以后的人复核。
 *
 * 所以这里不写死任何结论，只**如实报告观察到的东西**：注册表在不在、注册了多少包、
 * 其中有没有本插件。把"因此该不该迁移"留给文档去论证。
 *
 * ## 两条纪律
 *
 * 1. **永远不抛。** 探测的是可选设施，任何一步出问题都只能降级成 `available: false`
 *    加一句原因。一个能力探测把整个插件打崩，比探测不到更糟。
 * 2. **不猜。** 拿不到的字段就是 `null`，不用 `0` / `false` 冒充"探测过了且没有"。
 *    两者对读者的意义完全相反：`0` 是"确实没有"，`null` 是"我们没能问出来"。
 *
 * ## 设施怎么拿
 *
 * 用**主动探测** `ctx.get('typert')`，不写进 `ctx.inject` —— 与 `index.js` 里
 * `timer`、`webServer` 同一个理由：设施永远不出现时 `inject` 回调永不执行，
 * 插件会以"完全不存在"的方式失败，而不是以"降级"的方式失败。
 */

/**
 * 本插件自己的包名。用于判断注册表里有没有本插件的生成产物 —— 这是 V4 的关键
 * 观察点：没有它，迁移到 `@Remote` 就无从谈起。
 */
export const OWN_PACKAGE = 'dsh-apradar'

/**
 * 从任意形状里安全地数出条目数。
 * @param {unknown} value 可能是数组、可迭代对象或 undefined
 * @returns {number | null} 数不出来返回 `null`，**不返回 0**
 */
export function countEntries(value) {
  if (Array.isArray(value)) return value.length
  if (value && typeof value[Symbol.iterator] === 'function') {
    let n = 0
    try {
      for (const _ of value) {
        void _
        n += 1
      }
    } catch {
      return null
    }
    return n
  }
  return null
}

/**
 * @param {(name: string) => unknown} get 取服务的函数（通常是 `ctx.get`）
 * @returns {object} 运行时能力报告
 */
export function describeTypert(get) {
  /** @type {Record<string, unknown>} */
  const report = {
    /** 宿主是否挂了 typert 注册表（`ctx.typert`）。 */
    available: false,
    reason: null,
    /** 注册表里已注册的包反射条数；`null` = 没问出来。 */
    packages: null,
    /** 已注册的 schema 条数（`ctx.typert.list()`）；`null` = 没问出来。 */
    schemas: null,
    /**
     * **V4 的判据**：本环境可用的调用描述符条数（`ctx.typert.local.list()`）。
     * 为 0 就意味着没有任何生成产物可供 `@Remote` 调用挂靠。
     */
    descriptors: null,
    /** 消费方选定的 Remote 描述符条数（`ctx.typert.remotes.list()`），用来对照。 */
    remoteDescriptors: null,
    /** 注册表里有没有本插件的包 —— V4 的关键观察点。 */
    ownPackageRegistered: null,
    /** 探测到的包名样例（截断），便于人在现场核对。 */
    sample: [],
  }

  let typert = null
  try {
    typert = typeof get === 'function' ? get('typert') : null
  } catch (error) {
    return { ...report, reason: `读取 ctx.typert 时抛错：${error?.message ?? String(error)}` }
  }

  if (!typert || (typeof typert !== 'object' && typeof typert !== 'function')) {
    return {
      ...report,
      reason: '宿主未挂载 typert 注册表（ctx.typert 不存在）—— 当前组合里没有可用的生成描述符来源',
    }
  }

  report.available = true

  // 包列表：`listPackages()`。注册表 README 里它是读包反射的公开入口。
  //
  // **必须一趟遍历同时得出三件事**（总数、名字样例、有没有本插件）：注册表返回的
  // 可能是只能消费一次的迭代器，走两遍第二遍会得到空结果 —— 那会得出"包数为 0、
  // 本插件没注册"这种**看起来确定但完全错误**的结论。这正是本模块要防的那类错误。
  let packages = null
  try {
    if (typeof typert.listPackages === 'function') packages = typert.listPackages()
  } catch (error) {
    report.reason = `listPackages() 抛错：${error?.message ?? String(error)}`
  }

  const SAMPLE_LIMIT = 5
  if (Array.isArray(packages)) {
    report.packages = packages.length
    const { names, sawOwn } = scanPackageNames(packages, SAMPLE_LIMIT)
    report.sample = names
    // 数组必定能完整遍历 —— 走到这里就是确定的答案。
    report.ownPackageRegistered = sawOwn
  } else if (packages && typeof packages[Symbol.iterator] === 'function') {
    try {
      let n = 0
      const names = []
      let sawOwn = false
      for (const entry of packages) {
        n += 1
        const name = packageNameOf(entry)
        if (name === null) continue
        if (name === OWN_PACKAGE) sawOwn = true
        if (names.length < SAMPLE_LIMIT) names.push(name)
      }
      report.packages = n
      report.sample = names
      report.ownPackageRegistered = sawOwn
    } catch {
      // 遍历到一半失败：总数与"有没有本插件"都只能说"没问出来"。
      report.packages = null
      report.ownPackageRegistered = null
    }
  } else {
    report.packages = countEntries(packages)
  }

  // schema 条数：`list()`。
  try {
    if (typeof typert.list === 'function') report.schemas = countEntries(typert.list())
  } catch (error) {
    report.reason = report.reason ?? `list() 抛错：${error?.message ?? String(error)}`
  }

  // —— V4 的判据：`ctx.typert.local` 里有没有生成描述符 ——
  //
  // 这一项刻意读 `local.list()` 而不是 `list()`：前者是本环境可用的**调用描述符**，
  // 也正是 `@Remote` 迁移能否成立的前提。README 里 `local` 的定义是
  // "Current-environment invocation definitions"。
  report.descriptors = countInvocationDescriptors(readProperty(typert, 'local'))
  report.remoteDescriptors = countInvocationDescriptors(readProperty(typert, 'remotes'))

  return report
}

/**
 * 读属性，坏了就返回 `undefined`。
 * 注册表上的 `local` / `remotes` 是 **getter**，getter 自己也可能抛 —— 探测模块
 * 的纪律是"永不抛"，所以连取值这一步都要包住。
 * @param {unknown} target
 * @param {string} key
 * @returns {unknown}
 */
function readProperty(target, key) {
  try {
    return target?.[key]
  } catch {
    return undefined
  }
}

/**
 * 数一个描述符仓里的条目。仓的公开面是 `{ get, list, subscribe }`；
 * 任何一步坏掉都返回 `null`（"没问出来"），**不返回 0**。
 * @param {unknown} store
 * @returns {number | null}
 */
function countInvocationDescriptors(store) {
  if (!store || (typeof store !== 'object' && typeof store !== 'function')) return null
  try {
    if (typeof store.list !== 'function') return null
    return countEntries(store.list())
  } catch {
    return null
  }
}

/** @param {unknown} entry @returns {string | null} */
function packageNameOf(entry) {
  if (typeof entry === 'string') return entry === '' ? null : entry
  const name = entry?.name ?? entry?.package ?? null
  return typeof name === 'string' && name !== '' ? name : null
}

/**
 * 一趟扫出名字样例与"有没有本插件"。数组总能完整遍历，所以这个结论是确定的。
 * @param {unknown[]} list
 * @param {number} limit
 * @returns {{ names: string[], sawOwn: boolean }}
 */
function scanPackageNames(list, limit) {
  const names = []
  let sawOwn = false
  for (const entry of list) {
    const name = packageNameOf(entry)
    if (name === null) continue
    if (name === OWN_PACKAGE) sawOwn = true
    if (names.length < limit) names.push(name)
  }
  return { names, sawOwn }
}

/**
 * 报告**本插件的客户端半边有没有被宿主组合进启动图**（P1-07 验收 ②）。
 *
 * ## 为什么必须有这个函数
 *
 * `@deepseek-ai/dsh-client-modules` README 承诺「缺失 bundle 会明确导致激活失败，
 * 并给出一条构建说明及包／路径列表」。**实测不成立**：在干净 profile 里装一个
 * `exports["./client"]` 指向不存在文件的包，`dsh web` 照常启动、页面照常渲染，
 * 本插件的客户端条目在首页 HTML 里出现 **0 次**、stdout/stderr 与页面
 * **都没有任何提示**（见 `TECH-SPIKE.md` §6.12.4）。也就是说，这条路上
 * **平台不会告诉你少了东西** —— 你只会看到一个"什么都没发生"的界面。
 *
 * 所以这条自诊断由本插件自己给。宿主把 `clientModules` 服务放在上下文里
 * （`dsh-client-modules/lib/index.js:526` 的 `super(ctx, "clientModules")`），
 * 它的 `clientPath(id)`（同文件 `:569`）返回**宿主为该包解析出的客户端产物路径**；
 * 没有组合进来时是 `undefined`。这是一个权威信号，而且**不需要碰文件系统**
 * （Host 半边禁止 `node:` 导入，见 G-NET-2）。
 *
 * ## 三种回答必须分得清
 *
 *   - `available: false` —— 这个宿主上**没有** `clientModules` 服务（例如纯宿主组合）。
 *     我们**没有**观察能力，不能因此说"客户端没加载"。
 *   - `composed: false` —— 服务在、但它**没有**为本包解析出客户端产物：
 *     这是确定的坏消息，通常是 `exports["./client"]` 指向的文件不存在
 *     （没跑构建）或包没声明 `dsh.client`。
 *   - `composed: true` —— 有路径。附带 `path` 便于人工核对。
 *
 * @param {(key: string) => unknown} get 主动探测设施的函数（通常是 `(k) => ctx.get(k)`）
 * @param {string} [packageName]
 * @returns {{available: boolean, reason: string | null, composed: boolean | null, path: string | null}}
 */
export function describeClientHalf(get, packageName = OWN_PACKAGE) {
  const unavailable = (reason) => ({ available: false, reason, composed: null, path: null })

  if (typeof get !== 'function') return unavailable('无法探测宿主设施（get 不是函数）')

  let registry = null
  try {
    registry = get('clientModules')
  } catch (error) {
    return unavailable(`读取 ctx.clientModules 时抛错：${error?.message ?? String(error)}`)
  }
  if (!registry) {
    return unavailable('宿主未挂载 clientModules 服务（ctx.clientModules 不存在）—— 无法观察客户端半边是否已组合')
  }

  let path = null
  try {
    if (typeof registry.clientPath !== 'function') {
      return unavailable('宿主的 clientModules 服务没有 clientPath() 方法 —— 无法查询本包的客户端产物路径')
    }
    const value = registry.clientPath(packageName)
    path = typeof value === 'string' && value !== '' ? value : null
  } catch (error) {
    return unavailable(`查询客户端产物路径时抛错：${error?.message ?? String(error)}`)
  }

  if (path === null) {
    return {
      available: true,
      reason:
        `宿主没有为本包（${packageName}）组合出客户端入口。常见原因：` +
        `exports["./client"] 指向的文件不存在（没跑构建），或包没有声明 dsh.client。` +
        `修法：在包目录里跑 \`npm run build\`，然后重启宿主（宿主在启动时解析并缓存该路径）。`,
      composed: false,
      path: null,
    }
  }
  return { available: true, reason: null, composed: true, path }
}
