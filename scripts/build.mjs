#!/usr/bin/env node
/**
 * 最小构建步骤：把 `src/` 组装成 `lib/` —— 也就是**发布出去的运行树**。
 *
 * ## 这个"构建"到底做了什么（如实说明）
 *
 * **它不转译、不打包、不引依赖、不压缩。**
 *
 *   - `src/host/**` → `lib/**`：**逐字节复制**。宿主半边本来就是可执行的 ESM
 *     （没有 TypeScript、没有 JSX），复制是为了让发布产物只有一个入口目录，
 *     而不是把源码目录也发出去。
 *   - `src/client/client.js` → `lib/client.js`：**带校验的复制 + 生成头**。
 *
 * 之所以仍然需要这一步，有两个具体理由，都不是"仪式感"：
 *
 * 1. **npm 安装路径消费包内的产物。** `@deepseek-ai/dsh-client-modules` README
 *    原文：「宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须
 *    已产出每个 `lib/client.js`；缺失 bundle 会明确导致激活失败」。`lib/client.js`
 *    是约定位置（本机其它已发布插件同样是 `exports["./client"] → ./lib/client.js`）。
 * 2. **`files` 白名单只能收窄到"跑起来需要什么"。** 发 `src/` 就等于把 `demo/`
 *    之外的一切开发材料也留在了包里；发 `lib/` 则边界清晰：只要 `lib/` 在，
 *    没有 `src/` 也能跑（P1-07 验收 ① 就是这件事，并在干净 profile 里实测过）。
 *
 * ## 校验（决定"能不能发"的唯一关口）
 *
 * 写文件之前先过客户端 bundle 契约（装载调用恰好一次、id 等于包名、只请求基座
 * 或显式声明的外部模块、没有动态请求、没有 ESM 语句、没有 JSX）。
 * **校验不过就退出码非零、不写任何文件** —— 宁可构建失败，也不产出一个会在
 * 用户机器上激活失败的包。
 *
 * 用法：
 *   `npm run build`         组装 lib/
 *   `npm run build:check`   只校验不写（漂移检查；返回非零表示 lib/ 过期）
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeBundle } from './client-contract.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const HOST_SRC = join(ROOT, 'src/host')
const CLIENT_SRC = join(ROOT, 'src/client/client.js')
const LIB = join(ROOT, 'lib')
const CLIENT_OUT = join(LIB, 'client.js')
const checkOnly = process.argv.includes('--check')

/** 从生成内容算一个短指纹，写进文件头 —— 用来一眼看出 `lib/client.js` 是不是旧的。 */
function shortHash(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

/**
 * 生成头。
 *
 * **刻意不写时间戳**：带时间戳的产物每次构建都不一样，于是"产物是否与源码一致"
 * 这件事永远无法用比较来判断（每次比都不等），漂移检查会退化成一句空话。
 */
function banner(packageName, version, hash) {
  return [
    '/*',
    ` * ${packageName}@${version} —— 客户端 bundle（生成产物，请勿手改）`,
    ' *',
    ' * 由 scripts/build.mjs 从 src/client/client.js 生成。',
    ' * 改客户端请改源文件，然后跑 `npm run build`。',
    ` * 源内容指纹：${hash}`,
    ' */',
    '',
  ].join('\n')
}

/** 生成最终写入 `lib/client.js` 的完整文本（build 与 test 共用同一算法）。 */
export function renderBundle(source, packageName, version) {
  return banner(packageName, version, shortHash(source)) + source
}

/**
 * 列出 `src/host/**` 下所有 `.js` 文件，返回 `相对 src/host 的路径 → 绝对路径`。
 * 递归、稳定排序（排序让构建与检查的输出可复现）。
 */
async function listHostSources(dir = HOST_SRC, prefix = '', out = new Map()) {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) await listHostSources(abs, rel, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) out.set(rel, abs)
  }
  return out
}

/** 列出 `lib/` 下已存在的所有 `.js`（用于发现"源里删了、产物里还在"的孤儿文件）。 */
async function listLibFiles(dir = LIB, prefix = '', out = new Set()) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    const abs = join(dir, entry.name)
    if (entry.isDirectory()) await listLibFiles(abs, rel, out)
    else if (entry.isFile() && entry.name.endsWith('.js')) out.add(rel)
  }
  return out
}

/** 组装完整计划：`lib/ 相对路径 → {contents, source}`。 */
async function plan(pkg) {
  const source = await readFile(CLIENT_SRC, 'utf8')
  const bundle = renderBundle(source, pkg.name, pkg.version)
  const files = new Map([['client.js', { contents: bundle, source: 'src/client/client.js（生成）' }]])

  for (const [rel, abs] of await listHostSources()) {
    // `src/host/index.js` → `lib/index.js`（宿主入口跟着 main/exports 一起搬）
    const target = rel === 'index.js' ? 'index.js' : rel
    files.set(target, { contents: await readFile(abs, 'utf8'), source: `src/host/${rel}（逐字节复制）` })
  }
  return files
}

async function main() {
  const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
  const source = await readFile(CLIENT_SRC, 'utf8')

  // ---- 关口：客户端 bundle 契约 ----
  const report = analyzeBundle(renderBundle(source, pkg.name, pkg.version), {
    packageName: pkg.name,
    external: pkg.dsh?.client?.external ?? [],
  })
  if (!report.ok) {
    console.error(`✗ client bundle 契约校验未通过（${relative(ROOT, CLIENT_SRC)}）：`)
    for (const problem of report.problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(`✓ 契约校验通过：装载 id = ${report.ids[0]}；请求模块 = ${report.requires.join('、') || '（无）'}`)

  // ---- 计划与漂移 ----
  const planned = await plan(pkg)
  const existingLib = await listLibFiles()

  const stale = []
  const missing = []
  for (const [rel, item] of planned) {
    const actual = await readFile(join(LIB, rel), 'utf8').catch(() => null)
    if (actual === null) missing.push(rel)
    else if (actual !== item.contents) stale.push(rel)
  }
  const orphans = [...existingLib].filter((rel) => !planned.has(rel)).sort()

  if (checkOnly) {
    const problems = [
      ...missing.map((rel) => `缺少 ${rel}`),
      ...stale.map((rel) => `${rel} 与源文件不一致`),
      ...orphans.map((rel) => `${rel} 在 lib/ 里但源里已不存在（孤儿产物，会被一起发布出去）`),
    ]
    if (problems.length === 0) {
      console.log(`✓ lib/ 与 src/ 一致（${planned.size} 个文件）`)
      return
    }
    console.error(`✗ lib/ 已过期（${problems.length} 处）—— 请跑 \`npm run build\`：`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }

  // ---- 写入 ----
  await mkdir(LIB, { recursive: true })
  for (const [rel, item] of planned) {
    const target = join(LIB, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, item.contents, 'utf8')
  }
  // 孤儿产物必须删掉：留着它就会被打进包，而且它可能是个已经删掉的旧实现的入口。
  for (const rel of orphans) await rm(join(LIB, rel), { force: true })

  console.log(`✓ 已组装 lib/：${planned.size} 个文件（其中 client.js 为生成产物，其余为逐字节复制）`)
  if (orphans.length > 0) console.log(`  清理了 ${orphans.length} 个孤儿产物：${orphans.join('、')}`)
  if (missing.length > 0) console.log(`  新建：${missing.join('、')}`)
  if (stale.length > 0) console.log(`  更新：${stale.join('、')}`)
}

/** 交付面自检：`lib/` 必须能独立存在（P1-07 验收 ①）。 */
async function assertLibSelfContained() {
  const info = await stat(LIB).catch(() => null)
  if (info === null) throw new Error('lib/ 不存在 —— 先跑 npm run build')
  const entry = await readFile(join(LIB, 'index.js'), 'utf8').catch(() => null)
  if (entry === null) throw new Error('lib/index.js 不存在 —— 发布产物没有宿主入口')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
  if (!checkOnly && process.exitCode === undefined) await assertLibSelfContained()
}
