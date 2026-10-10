/**
 * Client bundle 契约（构建期与测试期共用一份）。
 *
 * ## 为什么要单独一个文件
 *
 * "这个 bundle 合不合法"这件事，构建脚本要问、测试也要问。写在两处就会漂移 ——
 * 构建放行的东西测试未必认，或者反过来。这里是唯一的一份。
 *
 * ## 契约来自哪里（不是我们发明的）
 *
 * - `@deepseek-ai/dsh-client-modules` README：插件包以 `platform: 'web'` 声明
 *   `dsh.client`，导出 `./client` bundle，并在 `dsh.client.external` 下列出任何
 *   **基座之外**的模块请求。
 * - `.../lib/types/client/manifest.d.ts`：执行插件 bundle **只注册 factory**
 *   （`window.__ModuleLoader__.load({id, factory})`），一切模块体副作用（包括
 *   CSS 注入）都在 factory 闭包内、在物化时才运行。
 * - `.../lib/index.js` 的 `clientExportOf()`：`exports["./client"]` 必须是字符串，
 *   或一个 `default` 是字符串的对象；否则**直接抛错**。
 * - 基座模块表：`@deepseek-ai/dsh-web-frontend` 构建产物里
 *   `staticModules` 的工厂函数返回的那张表（见下方 `BASELINE_MODULES`）。
 *   基座之外的东西必须列进 `dsh.client.external`，而且要真的有人提供。
 */

/**
 * 基座（platform singleton）模块表 —— 执行环境已经冻结提供，bundle 可以直接
 * `require`，**不需要**也不应该写进 `dsh.client.external`。
 *
 * 来源：`@deepseek-ai/dsh-web-frontend/dist/assets/index-*.js` 里
 * `staticModules: rM()` 的 `rM` 函数体，逐字为：
 *
 *   `react` / `react/jsx-runtime` / `react-dom` / `react-dom/client` /
 *   `@deepseek-ai/cordis` / `@deepseek-ai/dsh-client-store` /
 *   `@deepseek-ai/dsh-client-ui-slots` /
 *   `@deepseek-ai/dsh-client-ui-primitives` / `@deepseek-ai/dsh-client-ui-dockkit`
 *
 * 这张表是**抄来的**，不是猜的。它也解释了为什么"基座之外必须显式声明"是一条
 * 硬规矩：`require` 一个既不在这张表里、也没有外部提供方的名字，会在物化时
 * 抛错（manifest.d.ts 原文：anything else → throw，loud）。
 */
export const BASELINE_MODULES = Object.freeze([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** bundle 里唯一允许的装载调用。 */
const LOAD_CALL = '__ModuleLoader__.load('

/**
 * 去掉注释，保留字符串字面量（含模板串的 `${}` 内嵌表达式）。
 *
 * 为什么必须做这一步：源文件的**文档注释里**就写着 `window.__ModuleLoader__.load({…})`
 * 这句话（用来解释本文件的装载形态）。不剥注释的话，构建期会把一句注释当成
 * "第二次装载调用"而拒绝构建 —— 一个完全由自己的文档触发的假失败。
 *
 * 为什么不能用正则：`//` 出现在 `https://` 里、`/*` 出现在模板串里都会误判。
 * 所以走一个状态机，字符串一律原样保留（模板串里的注释是内容，不是注释）。
 */
export function stripComments(text) {
  let out = ''
  let i = 0

  /** 从 `start` 位置起扫描一段"代码"，遇到 `stopAt`（`}` 或 undefined）就返回。 */
  function scanCode(stopAt) {
    while (i < text.length) {
      const ch = text[i]
      if (stopAt !== undefined && ch === stopAt) return
      if (ch === '/' && text[i + 1] === '/') {
        while (i < text.length && text[i] !== '\n') i += 1
        continue
      }
      if (ch === '/' && text[i + 1] === '*') {
        i += 2
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1
        i += 2
        continue
      }
      if (ch === "'" || ch === '"') {
        const quote = ch
        out += ch
        i += 1
        while (i < text.length) {
          if (text[i] === '\\') {
            out += text[i] + (text[i + 1] ?? '')
            i += 2
            continue
          }
          out += text[i]
          const done = text[i] === quote
          i += 1
          if (done) break
        }
        continue
      }
      if (ch === '`') {
        out += ch
        i += 1
        while (i < text.length) {
          if (text[i] === '\\') {
            out += text[i] + (text[i + 1] ?? '')
            i += 2
            continue
          }
          if (text[i] === '`') {
            out += '`'
            i += 1
            break
          }
          if (text[i] === '$' && text[i + 1] === '{') {
            out += '${'
            i += 2
            scanCode('}') // 内嵌表达式里可以有注释，但仍属代码
            out += '}'
            i += 1
            continue
          }
          out += text[i]
          i += 1
        }
        continue
      }
      out += ch
      i += 1
    }
  }

  scanCode(undefined)
  return out
}

/**
 * 收集源码里所有 `require('...')` 的模块说明符。
 *
 * 刻意用**正则**而不是把文件当模块执行：构建期跑一遍别人的代码，等于把构建
 * 变成一次不可控的执行；而且我们要找的正是"这段代码到底会请求什么"，静态扫描
 * 给出的答案更直接。代价是它认不出动态拼出来的说明符 —— 那正是下一条要拒的。
 */
export function collectRequires(text) {
  const found = []
  const re = /\brequire\(\s*(['"])([^'"]+)\1\s*\)/g
  let match
  while ((match = re.exec(text)) !== null) found.push(match[2])
  return found
}

/**
 * 校验一段 client bundle 文本。返回 `{ok, problems, ids, requires, externals}`，
 * **不抛错** —— 调用方要能把所有问题一次列全，而不是修一个跑一次。
 *
 * @param {string} text bundle 源码
 * @param {{packageName: string, external?: string[]}} options
 */
export function analyzeBundle(text, options) {
  const packageName = options?.packageName
  const declaredExternal = Array.isArray(options?.external) ? options.external : []
  const problems = []

  // 所有检查都在**去掉注释之后**的文本上做：源文件的文档注释里就写着
  // `window.__ModuleLoader__.load({…})` 与 `require('react')` 这类示例，
  // 不剥注释会得到完全由自己的文档触发的假失败。
  const code = stripComments(text)

  // 1) 必须**恰好一次**装载调用。多次装载说明有人把两个插件拼进了一个文件；
  //    零次说明这个文件根本不是 bundle（比如误把宿主半边拷过来了）。
  const loadCount = code.split(LOAD_CALL).length - 1
  if (loadCount !== 1) {
    problems.push(`必须恰好有 1 次 ${LOAD_CALL}…) ，实际 ${loadCount} 次`)
  }

  // 2) 装载用的 id 必须等于包名 —— `WebBootEntry.id` 的注释原文就是
  //    "Entry name == package name"，对不上时宿主认不出这个 factory 属于谁。
  const idMatch = code.match(/__ModuleLoader__\.load\(\s*\{\s*id:\s*(['"])([^'"]+)\1/)
  const ids = idMatch ? [idMatch[2]] : []
  if (!idMatch) {
    problems.push(`没有找到 __ModuleLoader__.load({ id: '…' })，无法确认装载 id`)
  } else if (packageName && idMatch[2] !== packageName) {
    problems.push(`装载 id 是 ${idMatch[2]}，必须等于包名 ${packageName}`)
  }

  // 3) 只准请求基座里的模块，或者显式声明过的外部模块。
  const requires = collectRequires(code)
  const allowed = new Set([...BASELINE_MODULES, ...declaredExternal])
  const unknown = [...new Set(requires)].filter((name) => !allowed.has(name))
  if (unknown.length > 0) {
    problems.push(
      `请求了既不在基座、也没在 dsh.client.external 里声明的模块：${unknown.join('、')}。` +
        `要么改用基座模块，要么在 package.json 的 dsh.client.external 里声明它（并确认真的有提供方）。`,
    )
  }

  // 4) 动态请求必须被拒：它绕过了上面那条静态检查，会在运行时才炸。
  if (/\brequire\(\s*[^'")]/.test(code) || /\bimport\s*\(/.test(code)) {
    problems.push(`出现了动态 require/import；基座的请求必须能在构建期静态列出`)
  }

  // 5) 不能是 ESM。bundle 由经典 <script> 装载（`loadBundle` 默认即 classic script），
  //    顶层 `import`/`export` 会直接语法报错。
  if (/^\s*(import|export)\s/m.test(code)) {
    problems.push(`出现了顶层 import/export 语句；bundle 必须是经典脚本`)
  }

  // 6) 正文里不允许出现 JSX 之类的构建期语法（本插件手写 createElement）。
  if (/<[A-Z][A-Za-z0-9]*[\s/>]/.test(code)) {
    problems.push(`疑似包含 JSX；本插件约定手写 React.createElement，不做转译`)
  }

  return { ok: problems.length === 0, problems, ids, requires, externals: declaredExternal }
}
