/**
 * 静态闸门的自检（G-NET-1 / G-NET-2 / G-NET-3）。
 *
 * 一个从不失败的闸门等于没有闸门。所以这个文件做两件事：
 *   1. 断言**当前仓库**零违规；
 *   2. 断言扫描器**能抓到**每一类违规 —— 用合成的源码样本，而不是靠"看起来对"。
 *
 * 第 2 件事是重点：如果哪天有人把 `FORBIDDEN_LOADING` 写坏成永远匹配不到，
 * 第 1 件事依然会通过，只有第 2 件事会红。
 *
 * 运行：`npm test`
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ALLOWED_SPECIFIER_PATTERNS,
  DYNAMIC_IMPORT_ALLOWLIST,
  REPO_ROOT,
  WEB_ACCESS_ALLOWLIST,
  collectSpecifiers,
  scanRepo,
  scanSource,
  stripComments,
} from './gate-scan.mjs'

const GATEWAY = 'src/host/fetch/gateway.js'
const SERVICE = 'src/host/service.js'

test('当前仓库零违规', () => {
  const { files, violations, specifiers } = scanRepo(REPO_ROOT)
  assert.ok(files.length >= 20, `扫描到的文件太少（${files.length}），扫描器可能坏了`)
  assert.ok(specifiers.length >= 20, `扫描到的说明符太少（${specifiers.length}）`)
  assert.deepEqual(
    violations,
    [],
    violations.map((v) => `${v.file}:${v.line} [${v.rule}] ${v.detail}`).join('\n'),
  )
})

test('白名单是正向的：相对路径与 cordis 通过，其它一律拒绝', () => {
  const allows = (specifier) => ALLOWED_SPECIFIER_PATTERNS.some((pattern) => pattern.test(specifier))
  for (const ok of ['./a.js', '../b/c.js', '@deepseek-ai/cordis']) assert.equal(allows(ok), true, ok)
  for (const bad of ['node:fs', 'zod', 'undici', 'axios', '@deepseek-ai/dsh-storage-domain', 'lodash']) {
    assert.equal(allows(bad), false, bad)
  }
})

test('放行动态 import 的只有一处，且目标包写死', () => {
  assert.equal(DYNAMIC_IMPORT_ALLOWLIST.size, 1)
  assert.equal(DYNAMIC_IMPORT_ALLOWLIST.get('src/host/store/index.js'), 1)
  assert.equal(WEB_ACCESS_ALLOWLIST.size, 1)
  assert.ok(WEB_ACCESS_ALLOWLIST.has(GATEWAY))
})

test('剥离注释后仍然保留字符串内容与行号', () => {
  const code = ['// import x from "node:http"', 'const a = "node:net"', '/* node:dns */', 'const b = 1'].join('\n')
  const stripped = stripComments(code)
  assert.equal(stripped.split('\n').length, code.split('\n').length, '行数必须保持一致')
  assert.ok(!stripped.includes('node:http'), '行注释里的内容应被抹掉')
  assert.ok(!stripped.includes('node:dns'), '块注释里的内容应被抹掉')
  assert.ok(stripped.includes('"node:net"'), '字符串字面量必须保留 —— 否则漏报')
})

test('注释里提到 node:http / node:os 不算违规（否则文档性说明会误伤）', () => {
  const code = `
/**
 * 我们刻意不用 node:http，也不用 node:os。
 * 参见 \`node:fs\` 与 createRequire()。
 */
import { a } from './a.js'
`
  assert.deepEqual(scanSource(code, SERVICE).violations, [])
})

test('抓到 node: 前缀的静态 import（同时命中白名单与加载形态两条规则）', () => {
  const { violations } = scanSource('import { readFileSync } from "node:fs"\n', SERVICE)
  assert.equal(violations.length, 2, '两条不同的规则各报一次，比合并成一条更有诊断价值')
  assert.deepEqual(violations.map((v) => v.rule).sort(), ['G-NET-2', 'G-NET-3'])
  for (const violation of violations) assert.equal(violation.line, 1)
})

test('抓到白名单之外的第三方包', () => {
  const { violations } = scanSource("import got from 'got'\n", SERVICE)
  assert.equal(violations.length, 1)
  assert.equal(violations[0].rule, 'G-NET-2')
  assert.match(violations[0].detail, /got/)
})

test('抓到 require / createRequire / getBuiltinModule / binding', () => {
  const cases = [
    ["const http = require('http')\n", /require|加载形态/],
    ["import { createRequire } from './x.js'\nconst r = createRequire(import.meta.url)\n", /createRequire/],
    ["const m = process.getBuiltinModule('http')\n", /getBuiltinModule/],
    ["const b = process.binding('tcp_wrap')\n", /binding/],
  ]
  for (const [code, expected] of cases) {
    const { violations } = scanSource(code, SERVICE)
    assert.ok(violations.length >= 1, `未抓到：${code.trim()}`)
    assert.ok(
      violations.some((v) => v.rule === 'G-NET-3' && expected.test(v.detail)),
      `违规内容不匹配：${JSON.stringify(violations)}`,
    )
  }
})

test('抓到白名单之外的动态 import', () => {
  const { violations } = scanSource("const m = await import('axios')\n", SERVICE)
  assert.equal(violations.length, 1)
  assert.match(violations[0].detail, /动态 import/)
})

test('动态 import 的目标被写死：即使位置对、包名错也要报', () => {
  const { violations } = scanSource("const m = await import('zod')\n", 'src/host/store/index.js')
  assert.equal(violations.length, 1)
  assert.match(violations[0].detail, /超出了唯一放行的包/)
})

test('放行位置上的正确动态 import 不报', () => {
  const { violations } = scanSource("const m = await import('@deepseek-ai/dsh-storage-domain')\n", 'src/host/store/index.js')
  assert.deepEqual(violations, [])
})

test('抓到原生出网入口', () => {
  const cases = [
    ["const r = await globalThis.fetch('https://x.test')\n", 'globalThis.fetch'],
    ["const x = new XMLHttpRequest()\n", 'XMLHttpRequest'],
    ["const ws = new WebSocket('wss://x.test')\n", 'WebSocket'],
    ["navigator.sendBeacon('https://x.test')\n", 'sendBeacon'],
  ]
  for (const [code, name] of cases) {
    const { violations } = scanSource(code, SERVICE)
    assert.ok(
      violations.some((v) => v.rule === 'G-NET-2' && v.detail.includes(name)),
      `未抓到 ${name}：${JSON.stringify(violations)}`,
    )
  }
})

test('G-NET-1：ctx.web 只在 gateway 里允许出现', () => {
  const bad = "const web = ctx.get('web')\n"
  assert.equal(scanSource(bad, SERVICE).violations.length, 1)
  assert.equal(scanSource(bad, SERVICE).violations[0].rule, 'G-NET-1')
  assert.deepEqual(scanSource(bad, GATEWAY).violations, [])
})

test('说明符抽取覆盖三种形态且不重不漏', () => {
  const code = `
import a from './a.js'
export { b } from '../b.js'
const c = await import('@deepseek-ai/dsh-storage-domain')
`
  const specifiers = collectSpecifiers(stripComments(code)).map((entry) => entry.specifier)
  assert.deepEqual(specifiers, ['./a.js', '../b.js', '@deepseek-ai/dsh-storage-domain'])
})
