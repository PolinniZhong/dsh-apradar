/**
 * G-NET-2 / G-NET-3 / G-NET-1 静态闸门（SDD §8.1.1）。
 *
 * 这个脚本回答两个问题，且**只回答这两个**：
 *   1. `src/host/**` 里出现的**每一个 import / require 说明符**，是否都在白名单里？
 *      （正向白名单 —— 黑名单永远漏项。）
 *   2. 有没有出现任何"绕过宿主出网闸门"的加载形态？
 *      （`node:` 前缀、`require(`、`createRequire`、`process.getBuiltinModule`、
 *       `process.binding`、以及白名单之外的动态 `import()`。）
 *
 * ## 为什么必须先剥注释
 *
 * 本仓库的代码里**大量**在注释与 JSDoc 里提到 `node:http`、`node:crypto`、`node:os`，
 * 因为那些正是我们要解释"为什么不用它"的地方。一个不剥注释的扫描器会把每一处
 * 说明文字都判成违规，然后被维护者关掉 —— 那就是闸门失效的开始。
 *
 * ## 这个脚本**不**声称能证明"无法绕过"
 *
 * 它是静态的、基于文本的。运行期仍可构造出它看不到的形态。它的价值是：
 * **我们自己的代码一旦出现越界写法，立刻失败**。诚实声明见 README「安全边界」。
 *
 * 用法：
 *   node test/gate-scan.mjs          # CI / 命令行，违规时 exit 1
 *
 * 单测在 `test/gate.test.mjs`（含"故意违规样例必须被抓到"的自检）。
 *
 * @module dsh-apradar/test/gate-scan
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根目录（本文件在 `test/` 下）。 */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 被扫描的目录（相对仓库根）。 */
export const SCAN_ROOT = 'src/host'

/**
 * 静态 import 说明符白名单（**正向**）。
 * 只允许本仓相对路径与 Cordis 本身 —— 没有 zod，没有第三方 HTTP 客户端。
 */
export const ALLOWED_SPECIFIER_PATTERNS = [/^\.{1,2}\//, /^@deepseek-ai\/cordis$/]

/**
 * 唯一被放行的动态 `import()`：官方 storage-domain 探测。
 * 值是该 `import()` 所在的文件（相对仓库根）；`null` 表示**不允许任何**动态 import。
 */
export const DYNAMIC_IMPORT_ALLOWLIST = new Map([['src/host/store/index.js', 1]])

/** 唯一允许引用 `ctx.web` 的文件（G-NET-1：出网只有一个点）。 */
export const WEB_ACCESS_ALLOWLIST = new Set(['src/host/fetch/gateway.js'])

/** G-NET-3：出现即违规的加载形态。 */
const FORBIDDEN_LOADING = [
  { name: 'node: 前缀说明符', pattern: /['"]node:[^'"]*['"]/ },
  { name: 'require(', pattern: /\brequire\s*\(/ },
  { name: 'createRequire', pattern: /\bcreateRequire\b/ },
  { name: 'process.getBuiltinModule', pattern: /\bprocess\s*\.\s*getBuiltinModule\b/ },
  { name: 'process.binding', pattern: /\bprocess\s*\.\s*binding\b/ },
  { name: 'module.createRequire', pattern: /\bmodule\s*\.\s*createRequire\b/ },
]

/** G-NET-2 的补充：原生出网入口（即使能加载也不许用）。 */
const FORBIDDEN_EGRESS = [
  { name: 'globalThis.fetch', pattern: /\bglobalThis\s*\.\s*fetch\b/ },
  { name: 'window.fetch', pattern: /\bwindow\s*\.\s*fetch\b/ },
  { name: 'self.fetch', pattern: /\bself\s*\.\s*fetch\b/ },
  { name: 'XMLHttpRequest', pattern: /\bXMLHttpRequest\b/ },
  { name: 'navigator.sendBeacon', pattern: /\bsendBeacon\b/ },
  { name: 'new WebSocket', pattern: /\bnew\s+WebSocket\b/ },
  { name: 'new EventSource', pattern: /\bnew\s+EventSource\b/ },
]

/** G-NET-1：引用宿主出网能力的写法。 */
const WEB_ACCESS = { name: "ctx.web / ctx.get('web')", pattern: /ctx\s*(?:\.\s*web\b|\[\s*['"]web['"]\s*\]|\.\s*get\s*\(\s*['"]web['"]\s*\))/ }

/**
 * 剥掉注释，保留字符串字面量的内容。
 *
 * 逐字符推进而不是用正则：正则版在"字符串里出现 `//`"或"注释里出现引号"时
 * 会错位，而错位会让闸门给出**错误**的结论 —— 比没有闸门更糟。
 * 注释字符被替换成空格且保留换行，因此行号在报告里仍然准确。
 *
 * 已知局限（可接受）：模板字符串里的 `${}` 表达式不会被当作代码扫描。
 * 本仓库的模板字符串只做字符串拼接，没有在 `${}` 里动态 `import()`。
 *
 * @param {string} code 源码
 * @returns {string} 等长的、注释被抹成空白的源码
 */
export function stripComments(code) {
  let out = ''
  let index = 0
  const length = code.length
  /** @type {'code'|'line'|'block'|'single'|'double'|'template'} */
  let state = 'code'
  while (index < length) {
    const ch = code[index]
    const next = code[index + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        out += '  '
        index += 2
        continue
      }
      if (ch === '/' && next === '*') {
        state = 'block'
        out += '  '
        index += 2
        continue
      }
      if (ch === "'") state = 'single'
      else if (ch === '"') state = 'double'
      else if (ch === '`') state = 'template'
      out += ch
      index += 1
      continue
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code'
        out += '\n'
      } else out += ' '
      index += 1
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        out += '  '
        index += 2
        continue
      }
      out += ch === '\n' ? '\n' : ' '
      index += 1
      continue
    }
    // 字符串内部
    if (ch === '\\') {
      out += ch + (next ?? '')
      index += 2
      continue
    }
    if ((state === 'single' && ch === "'") || (state === 'double' && ch === '"') || (state === 'template' && ch === '`')) {
      state = 'code'
    }
    out += ch
    index += 1
  }
  return out
}

/** 递归列出某个目录下所有 `.js` / `.mjs` 文件（相对仓库根，正斜杠分隔）。 */
export function listSourceFiles(root = REPO_ROOT, subdir = SCAN_ROOT) {
  const start = join(root, subdir)
  const found = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) walk(full)
      else if (/\.(?:js|mjs)$/.test(entry)) found.push(relative(root, full).split(sep).join('/'))
    }
  }
  walk(start)
  return found.sort()
}

/**
 * 从一个源码文本里抽出全部 import / require 说明符。
 * @param {string} stripped 已剥注释的源码
 * @returns {{specifier: string, kind: 'static'|'dynamic'|'require', index: number}[]}
 */
export function collectSpecifiers(stripped) {
  const results = []
  const patterns = [
    { kind: 'static', regex: /\b(?:import|export)\s+(?:[^'"]*?\s+from\s*)?['"]([^'"]+)['"]/g },
    { kind: 'dynamic', regex: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
    { kind: 'require', regex: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g },
  ]
  for (const { kind, regex } of patterns) {
    regex.lastIndex = 0
    let match
    while ((match = regex.exec(stripped)) !== null) {
      results.push({ specifier: match[1], kind, index: match.index })
    }
  }
  return results.sort((a, b) => a.index - b.index)
}

/** 把字符下标换算成 1 起的行号。 */
function lineOf(text, index) {
  let line = 1
  for (let i = 0; i < index && i < text.length; i += 1) if (text[i] === '\n') line += 1
  return line
}

/**
 * 扫描一个源码文本。
 *
 * @param {string} code 源码（未剥注释）
 * @param {string} file 相对仓库根的路径，用于白名单判断
 * @returns {{violations: {file: string, line: number, rule: string, detail: string}[]}}
 */
export function scanSource(code, file) {
  const stripped = stripComments(code)
  const violations = []
  const add = (index, rule, detail) => violations.push({ file, line: lineOf(stripped, index), rule, detail })

  // G-NET-2：静态说明符白名单
  for (const { specifier, kind, index } of collectSpecifiers(stripped)) {
    if (kind === 'static') {
      if (!ALLOWED_SPECIFIER_PATTERNS.some((pattern) => pattern.test(specifier))) {
        add(index, 'G-NET-2', `静态 import 说明符不在白名单里：${specifier}`)
      }
      continue
    }
    if (kind === 'require') {
      add(index, 'G-NET-3', `不得使用 require()：${specifier}`)
      continue
    }
    // dynamic
    if (!DYNAMIC_IMPORT_ALLOWLIST.has(file)) {
      add(index, 'G-NET-3', `白名单之外的动态 import()：${specifier}`)
    } else if (specifier !== '@deepseek-ai/dsh-storage-domain') {
      add(index, 'G-NET-3', `动态 import() 的目标超出了唯一放行的包：${specifier}`)
    }
  }

  // G-NET-3：动态加载形态（不依赖说明符写法）
  for (const { name, pattern } of FORBIDDEN_LOADING) {
    const match = pattern.exec(stripped)
    if (match) {
      // `require(` 在已有静态 import 的文件里一定是误用；这里不设例外。
      add(match.index, 'G-NET-3', `出现了被禁止的加载形态：${name}`)
    }
  }

  // 原生出网入口
  for (const { name, pattern } of FORBIDDEN_EGRESS) {
    const match = pattern.exec(stripped)
    if (match) add(match.index, 'G-NET-2', `出现了被禁止的出网入口：${name}`)
  }

  // G-NET-1：出网只有一个点
  const webMatch = WEB_ACCESS.pattern.exec(stripped)
  if (webMatch && !WEB_ACCESS_ALLOWLIST.has(file)) {
    add(webMatch.index, 'G-NET-1', `只有 src/host/fetch/gateway.js 可以引用 ctx.web（违规文件：${file}）`)
  }

  return { violations }
}

/**
 * 扫描整个 `src/host`。
 * @param {string} [root] 仓库根
 * @returns {{files: string[], violations: object[], specifiers: string[]}}
 */
export function scanRepo(root = REPO_ROOT) {
  const files = listSourceFiles(root)
  const violations = []
  const specifiers = new Set()
  for (const file of files) {
    const code = readFileSync(join(root, file), 'utf8')
    for (const entry of collectSpecifiers(stripComments(code))) specifiers.add(entry.specifier)
    violations.push(...scanSource(code, file).violations)
  }
  return { files, violations, specifiers: [...specifiers].sort() }
}

/** 命令行入口。 */
function main() {
  const { files, violations, specifiers } = scanRepo()
  console.log(`[gate-scan] 扫描 ${files.length} 个文件，发现 ${specifiers.length} 个不同说明符`)
  console.log(`[gate-scan] 说明符：${specifiers.join(', ')}`)
  if (violations.length) {
    console.error(`[gate-scan] 失败：${violations.length} 处违规`)
    for (const v of violations) console.error(`  ${v.file}:${v.line} [${v.rule}] ${v.detail}`)
    process.exitCode = 1
    return
  }
  console.log('[gate-scan] 通过：import 白名单、动态加载、原生出网入口、出网单点全部合规')
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) main()
