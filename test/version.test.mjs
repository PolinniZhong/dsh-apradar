/**
 * 版本常量与清单的一致性。
 *
 * `src/host/version.js` 里的 `PLUGIN_VERSION` 是**手写常量** —— 因为读 `package.json`
 * 需要 `node:fs`，而 `node:` 前缀被 G-NET-2 闸门禁止。手写常量必然会漂移，
 * 所以这个文件的作用就是**把漂移变成红灯**。
 *
 * 运行：`npm test`
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { PLUGIN_VERSION } from '../src/host/version.js'
import { name as pluginName } from '../src/host/index.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('PLUGIN_VERSION 与 package.json 的 version 逐字相同', () => {
  assert.equal(
    PLUGIN_VERSION,
    pkg.version,
    '改了 package.json 的版本就要同步 src/host/version.js（这是刻意的重复，由本测试锁住）',
  )
})

test('PLUGIN_VERSION 是合法 SemVer 且不是占位符', () => {
  assert.match(PLUGIN_VERSION, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)
  assert.ok(!/unknown|placeholder|x\.y\.z/i.test(PLUGIN_VERSION))
})

test('插件导出的 name 与 package.json 的 name 一致', () => {
  assert.equal(pluginName, pkg.name)
})

test('元数据不泄漏本机路径（公开文件里不得出现绝对路径）', () => {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  assert.ok(!raw.includes('/Users/'), 'package.json 里出现了本机绝对路径')
  assert.ok(!raw.includes('/Volumes/'), 'package.json 里出现了挂载卷路径')
  // P1-07 起本包**是要发布的**，所以这里不再断言 `private`；改由
  // `test/publish.test.mjs` 断言 files 白名单只收运行树（不泄漏开发材料）。
  assert.notEqual(pkg.private, true, 'private: true 会让 npm pack/publish 直接拒绝')
})
