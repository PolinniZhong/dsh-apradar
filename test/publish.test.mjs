/**
 * P1-07 —— 发布准备（npm 包能不能装、装了能不能跑）。
 *
 * 对应 `MVP-BACKLOG.md` P1-07 的三条验收：
 *
 *   1. 全新 profile 安装后**无需源码**即可运行
 *   2. **缺失 bundle 时能给出明确的自诊断信息**
 *   3. **记录精确依赖版本**
 *
 * 这三条都不是"跑一次成功就算数"的东西 —— 它们是**约束**，会随着以后每一次
 * 改动而被破坏。所以这里把它们钉成测试：包清单、bundle 契约、产物与源的一致性、
 * 依赖面。第 1 条的真实验证在干净 profile 里做（见 `TECH-SPIKE.md` §6.12），
 * 这里守住的是"以后不会悄悄改坏"。
 */

import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { renderBundle } from '../scripts/build.mjs'
import { BASELINE_MODULES, analyzeBundle, stripComments } from '../scripts/client-contract.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'))
const sourceText = await readFile(join(ROOT, 'src/client/client.js'), 'utf8')

/** 递归列出某个目录下的全部 `.js`（返回相对 `minus` 的路径，稳定排序）。 */
async function collectJs(dir, minus = dir) {
  const { readdir } = await import('node:fs/promises')
  const out = []
  async function walk(current, prefix) {
    const entries = await readdir(current, { withFileTypes: true }).catch(() => [])
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) await walk(join(current, entry.name), rel)
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(rel.startsWith(`${minus}/`) ? rel.slice(minus.length + 1) : rel)
    }
  }
  await walk(dir, '')
  return out
}

/** 从 `exports["./client"]` 取值，规则与 DSH 的 `clientExportOf()` 一致。 */
function clientEntryOf(manifest) {
  const client = manifest?.exports?.['./client']
  if (typeof client === 'string') return client
  if (typeof client === 'object' && client !== null && typeof client.default === 'string') return client.default
  return undefined
}

test('P1-07：exports["./client"] 的形状与目标文件都必须真实存在', async () => {
  const entry = clientEntryOf(pkg)
  // 形状错了 DSH 侧是**直接抛错**（clientExportOf），不是警告 —— 装上去就是激活失败。
  assert.equal(typeof entry, 'string', 'exports["./client"] 必须是字符串，或带字符串 default 的对象')
  // `exports["."]`（宿主半边）同理，缺了连 load 都过不去。
  assert.equal(typeof pkg.exports?.['.'], 'string', 'exports["."] 必须指向宿主半边入口')
  assert.equal(typeof pkg.main, 'string', 'main 必须存在（部分设施只读 main）')

  for (const [label, rel] of [
    ['exports["."]', pkg.exports['.']],
    ['main', pkg.main],
    ['exports["./client"]', entry],
    ['dsh.bundle.patch', pkg.dsh?.bundle?.patch],
    ['exports["./cordis.patch.yml"]', pkg.exports['./cordis.patch.yml']],
  ]) {
    if (typeof rel !== 'string') continue
    const info = await stat(join(ROOT, rel)).catch(() => null)
    assert.ok(info?.isFile(), `${label} 指向的文件不存在：${rel}`)
  }
})

test('P1-07：客户端 bundle 必须满足 loader 契约（装载 id、基座请求、经典脚本）', async () => {
  const built = await readFile(join(ROOT, clientEntryOf(pkg)), 'utf8')
  const report = analyzeBundle(built, { packageName: pkg.name, external: pkg.dsh?.client?.external ?? [] })
  assert.deepEqual(report.problems, [], `bundle 契约校验未通过：\n  - ${report.problems.join('\n  - ')}`)
  // 装载 id 必须等于包名（`WebBootEntry.id` 原文："Entry name == package name"）。
  assert.deepEqual(report.ids, [pkg.name])
})

test('P1-07：bundle 请求的模块必须落在「基座 ∪ dsh.client.external」里', async () => {
  const built = await readFile(join(ROOT, clientEntryOf(pkg)), 'utf8')
  const report = analyzeBundle(built, { packageName: pkg.name, external: pkg.dsh?.client?.external ?? [] })
  const allowed = new Set([...BASELINE_MODULES, ...report.externals])
  const outside = report.requires.filter((name) => !allowed.has(name))
  assert.deepEqual(
    outside,
    [],
    `bundle 请求了基座之外的模块却没声明：${outside.join('、')}。` +
      `基座之外的东西必须同时（a）写进 dsh.client.external，（b）确有提供方。`,
  )
  // 反向：声明了 external 就得真的用到 —— 空声明、或声明了又不用，都是过期的清单。
  for (const declared of report.externals) {
    assert.ok(
      report.requires.includes(declared),
      `dsh.client.external 声明了 ${declared}，但 bundle 并没有请求它`,
    )
  }
})

test('P1-07：lib/client.js 必须与 src/client/client.js 一致（漂移守卫）', async () => {
  const entry = clientEntryOf(pkg)
  const built = await readFile(join(ROOT, entry), 'utf8')
  const expected = renderBundle(sourceText, pkg.name, pkg.version)
  assert.equal(
    built,
    expected,
    `${entry} 与源文件不一致 —— 改完客户端请跑 \`npm run build\`。` +
      `（这个"构建"只是一次带校验的复制，但产物不一致意味着用户装到的客户端不是你正在改的那份。）`,
  )
  // 生成头必须写明它是产物，否则下一个人会直接手改 lib/ 然后改动被下一次构建抹掉。
  assert.match(built, /生成产物，请勿手改/)
  assert.match(built, /npm run build/)
})

test('P1-07：包里只发运行树（lib/），源码与开发材料一律不发布', () => {
  const files = pkg.files
  assert.ok(Array.isArray(files) && files.length > 0, 'files 白名单必须存在（否则会把整个工作目录发出去）')
  assert.ok(files.includes('lib'), 'files 必须包含 lib（运行树：宿主半边 + 客户端 bundle）')
  assert.ok(files.includes('cordis.patch.yml'), 'files 必须包含 cordis.patch.yml（否则插件挂不上）')

  // 发 `src/` 就等于把源码目录也留在包里 —— 而验收 ① 要的正是"无需源码即可运行"。
  assert.ok(!files.includes('src'), 'files 不应包含 src（运行树已经组装进 lib/）')

  // 用户硬约束：不得把 Demo 的模拟数据搬进正式插件。最直接的守法就是**不发它**。
  for (const forbidden of ['demo', 'test', 'spike', 'scripts', 'src']) {
    assert.ok(
      !files.some((entry) => entry === forbidden || entry.startsWith(`${forbidden}/`)),
      `files 不应包含 ${forbidden}/`,
    )
  }
  assert.notEqual(pkg.private, true, 'private: true 会让 npm pack/publish 直接拒绝')
})

test('P1-07：宿主入口必须落在 lib/，且 lib/ 自洽到「删掉 src/ 照样能跑」', async () => {
  // main 与 exports["."] 都必须指向 lib/ —— 指回 src/ 就等于发布了源码路径。
  assert.equal(pkg.main, './lib/index.js')
  assert.equal(pkg.exports['.'], './lib/index.js')

  // 逐个检查 lib/ 里的**相对**导入是否都能在 lib/ 内解析。这一步等价于
  // "把 src/ 删掉之后包还能不能加载"：只要有任何一个相对导入仍指向 src/，
  // 它就会悬空，而 npm 装出来的包里没有 src/。
  const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*(['"])(\.\.?\/[^'"]+)\1/g
  const libRoot = join(ROOT, 'lib')
  const libFiles = await collectJs(libRoot)
  assert.ok(libFiles.length >= 20, `lib/ 里的文件数不合理（${libFiles.length}），组装可能没跑`)

  for (const rel of libFiles) {
    const abs = join(libRoot, rel)
    const text = await readFile(abs, 'utf8')
    for (const match of stripComments(text).matchAll(RELATIVE_IMPORT)) {
      const spec = match[2]
      const resolved = resolve(dirname(abs), spec)
      assert.ok(
        resolved.startsWith(join(ROOT, 'lib')),
        `${rel} 里的相对导入 ${spec} 指向了 lib/ 之外（解析为 ${resolved}）—— 发布包里没有它`,
      )
      const info = await stat(resolved).catch(() => null)
      assert.ok(info?.isFile(), `${rel} 里的相对导入 ${spec} 在 lib/ 里不存在`)
    }
  }

  // `lib/index.js` 必须是宿主半边的真入口（与 src 侧逐字节相同）。
  const srcEntry = await readFile(join(ROOT, 'src/host/index.js'), 'utf8')
  const libEntry = await readFile(join(ROOT, 'lib/index.js'), 'utf8')
  assert.equal(libEntry, srcEntry, 'lib/index.js 与 src/host/index.js 不一致（宿主半边是逐字节复制）')
})

test('P1-07：lib/ 里不得留孤儿产物（源里删了的文件会被一起发出去）', async () => {
  const planned = new Set(['client.js'])
  for (const rel of await collectJs(join(ROOT, 'src/host'), join(ROOT, 'src/host'))) planned.add(rel)
  const orphans = (await collectJs(join(ROOT, 'lib'))).filter((rel) => !planned.has(rel))
  assert.deepEqual(orphans, [], `lib/ 里有源里已不存在的产物：${orphans.join('、')} —— 跑 \`npm run build\` 会清掉`)
})

test('P1-07：零第三方运行时依赖，且精确记录验证过的引擎版本', () => {
  // 这正是 T22「依赖面收敛」要守的东西：没有 dependencies 就没有供应链面。
  const runtimeDeps = Object.keys(pkg.dependencies ?? {})
  assert.deepEqual(runtimeDeps, [], `不得引入运行时依赖（实际：${runtimeDeps.join('、')}）`)
  // 也刻意不用 optionalDependencies / bundledDependencies 绕过去。
  assert.deepEqual(Object.keys(pkg.optionalDependencies ?? {}), [])
  assert.deepEqual(Object.keys(pkg.bundledDependencies ?? pkg.bundleDependencies ?? {}), [])

  // 验收 ③「记录精确依赖版本」：本插件没有第三方依赖，所以要记录的是**运行环境**的
  // 版本要求 —— 而且必须是一个具体值，不能是 `*` 或缺失。
  assert.match(String(pkg.engines?.node ?? ''), /^>=?\d+\.\d+/, 'engines.node 必须给出具体版本下界')
  assert.match(String(pkg.engines?.dsh ?? ''), /^>=?\d+\.\d+\.\d+/, 'engines.dsh 必须给出具体版本下界')
})

test('P1-07：构建脚本必须存在且是幂等的（--check 与 build 结论一致）', async () => {
  assert.equal(typeof pkg.scripts?.build, 'string', '必须有一个 build 脚本产出 lib/client.js')
  assert.equal(typeof pkg.scripts?.['build:check'], 'string', '必须有一个只校验不写的入口（供 CI / 提交前用）')
  assert.equal(typeof pkg.scripts?.prepack, 'string', 'pack 前必须自动构建，避免发出过期的 bundle')

  // `--check` 在当前工作区必须是绿的 —— 否则说明有人改了源没跑构建。
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const run = promisify(execFile)
  const result = await run(process.execPath, [join(ROOT, 'scripts/build.mjs'), '--check'], { cwd: ROOT })
  assert.match(result.stdout, /契约校验通过/)
})

test('P1-07：剥注释这一步本身必须是可靠的（否则契约检查是假的）', () => {
  // 行注释、块注释都要去掉。
  assert.equal(stripComments("const a = 1 // require('x')\n").includes("require('x')"), false)
  assert.equal(stripComments('/* require("y") */ const a = 1').includes('require("y")'), false)
  // 字符串里的 `//` 不能被当注释（否则会把后面的代码整段吃掉）。
  assert.match(stripComments("const u = 'https://example.com'\nconst b = 2"), /const b = 2/)
  // 模板串里的 `${}` 内嵌表达式仍按代码处理，模板串里的注释是内容。
  assert.match(stripComments('const t = `a ${/* c */ b} d`'), /\$\{\s*b\}/)
  // 真实源文件的文档注释里就写着装载调用 —— 剥掉之后必须只剩 1 次真实调用。
  const code = stripComments(sourceText)
  assert.equal(code.split('__ModuleLoader__.load(').length - 1, 1, '剥注释后必须只剩 1 次真实装载调用')
})
