/**
 * 清单与打包契约的结构测试。
 *
 * 这些断言不碰运行时，只回答一个问题：**这个包按 DSH 的公开约定声明齐全了吗**。
 * 依据是 `@deepseek-ai/dsh-package-manifest/lib/types/types.d.ts`（清单 schema）
 * 与本机已验证的在用实现（`08_Knit/knit/package.json`）。
 *
 * 运行：`node --test test/`
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

test('package.json：名称、类型与入口', () => {
  assert.equal(pkg.name, 'dsh-apradar')
  assert.equal(pkg.type, 'module')
  // P1-07 之前这里断言的是 `private: true`（当时是本地插件）。P1-07「npm 发布准备」
  // 明确要求它可被发布，所以断言随之翻转 —— 理由记在 MVP-BACKLOG 的 P1-07 与
  // TECH-SPIKE §6.12，而不是悄悄改掉。
  assert.notEqual(pkg.private, true, 'private: true 会让 npm pack/publish 直接拒绝')
  // 入口指向**运行树**（lib/），不是源码目录：验收 ① 要的是"无需源码即可运行"。
  assert.equal(pkg.main, './lib/index.js')
  assert.equal(pkg.exports?.['.'], './lib/index.js')
  assert.ok(existsSync(join(ROOT, pkg.main)), `main 指向的文件不存在：${pkg.main}`)
})

test('package.json：exports 每一项都真实存在', () => {
  for (const [key, target] of Object.entries(pkg.exports ?? {})) {
    assert.ok(existsSync(join(ROOT, target)), `exports["${key}"] 指向不存在的文件：${target}`)
  }
  assert.ok(pkg.exports['./client'], '必须导出 ./client —— DSH 据此注入客户端半边')
  assert.ok(pkg.exports['./cordis.patch.yml'], '必须导出 bundle patch')
})

test('package.json：dsh 清单段', () => {
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml')
  assert.ok(existsSync(join(ROOT, pkg.dsh.bundle.patch)))
  assert.equal(pkg.dsh.client.platform, 'web', '本插件只声明 web 平台')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-sidebar-right'])
})

test('package.json：零运行时依赖（这是刻意的，不是遗漏）', () => {
  // 依据：`link:` 安装不会为被链接包安装其 dependencies，且官方 `@deepseek-ai/*`
  // 无法从 profile 解析（已实测）。任何运行时依赖都必须先解决这个前提才能加。
  assert.equal(pkg.dependencies, undefined, '不得声明运行时依赖')
  assert.equal(pkg.optionalDependencies, undefined)
})

test('bundle patch：id 唯一，且与 Spike 不冲突', () => {
  const patch = readFileSync(join(ROOT, 'cordis.patch.yml'), 'utf8')
  assert.match(patch, /-\s*insert:/)
  assert.match(patch, /id:\s*dsh-apradar\b/)
  assert.match(patch, /name:\s*'dsh-apradar'/)

  const spikePatchPath = join(ROOT, 'spike/apradar-spike/cordis.patch.yml')
  if (existsSync(spikePatchPath)) {
    const spikePatch = readFileSync(spikePatchPath, 'utf8')
    assert.match(spikePatch, /id:\s*dsh-apradar-spike\b/)
    assert.ok(
      !/"name":\s*"dsh-apradar"/.test(pkg.name) || pkg.name !== 'dsh-apradar-spike',
      '正式插件与 Spike 必须是不同的包名',
    )
  }
})

test('路由前缀与右栏标识不得与 Spike 相同', () => {
  const http = readFileSync(join(ROOT, 'src/host/http.js'), 'utf8')
  const client = readFileSync(join(ROOT, 'src/client/client.js'), 'utf8')

  assert.match(http, /ROUTE_PREFIX = '\/apradar'/)
  assert.ok(!/ROUTE_PREFIX = '\/apradar-spike'/.test(http), '路由前缀不得与 Spike 重叠')

  assert.match(client, /KIND = 'apradar'/)
  assert.match(client, /TAB_ID = 'dsh-apradar:main'/)
  assert.ok(!/KIND = 'apradar-spike'/.test(client), '右栏 kind 不得与 Spike 重叠')
})

test('客户端半边：遵守手写加载器约束（无 JSX、无构建产物）', () => {
  const client = readFileSync(join(ROOT, 'src/client/client.js'), 'utf8')
  assert.match(client, /window\.__ModuleLoader__\.load\(/)
  assert.ok(!/<[A-Z][A-Za-z]*[\s>]/.test(client.replace(/\/\*[\s\S]*?\*\//g, '')), '不得使用 JSX')
  const required = [...client.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1])
  assert.deepEqual(required, ['react'], `只允许 require 基线模块，实际：${required.join(', ')}`)
})

test('回归：会话头部席位只能渲染入口按钮，绝不能渲染面板正文', () => {
  const client = readFileSync(join(ROOT, 'src/client/client.js'), 'utf8')
  const marker = "ctx.slots.inject('conversation.session.header.utilities'"
  const start = client.indexOf(marker)
  assert.ok(start > -1, '必须注册会话头部入口按钮')

  const end = client.indexOf('\n      )\n', start)
  assert.ok(end > start, '会话头部注册块必须能被界定')
  // 去掉注释再断言：注释里为了解释历史故障会提到 component / RadarBody
  const code = client
    .slice(start, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  // 实测故障：register({…, component: …}, RadarBody) 会把整块面板渲染进会话头部
  // （DOM 祖先链 apr-root → wSkVaW_headerUtilities → wSkVaW_titleRow）。
  assert.ok(!code.includes('RadarBody'), '会话头部席位不得出现面板正文 RadarBody')
  assert.ok(!/component\s*:/.test(code), '组件只能走位置参数，options 里不得再写 component')
  assert.match(code, /RadarEntryButton,\s*\),?\s*$/, '必须以 RadarEntryButton 作位置参数传入')
})

test('右栏正文与标题席位必须用同一个 key（= TAB_ID）', () => {
  const client = readFileSync(join(ROOT, 'src/client/client.js'), 'utf8')
  for (const slot of ['sidebar.right.pane.tab', 'sidebar.right.pane.tab.title']) {
    const re = new RegExp(`name: '${slot.replace(/\./g, '\\.')}', key: (\\w+)`)
    const m = client.match(re)
    assert.ok(m, `${slot} 必须以 name+key 注册`)
    assert.strictEqual(m[1], 'TAB_ID', `${slot} 的 key 必须是 TAB_ID`)
  }
})
