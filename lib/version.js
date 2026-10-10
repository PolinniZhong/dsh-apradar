/**
 * 插件版本常量。
 *
 * ## 为什么是常量而不是运行时读 `package.json`
 *
 * 本项目有一条闸门（G-NET-2，见 `test/gate-scan.mjs`）：`src/` 下的代码**不允许**
 * 出现 `node:` 前缀的导入。读 `package.json` 需要 `node:fs`，因此不能走运行时读取。
 *
 * 代价是这里与 `package.json` 的 `version` 可能漂移 —— 所以它**由测试锁住**：
 * `test/version.test.mjs` 断言两者相等，并对 `package.json` 的 `dsh` 段做形状校验。
 * 漂移会在测试里立刻暴露，不会流到用户手上。
 *
 * @module dsh-apradar/src/host/version
 */

/** 必须与 `package.json` 的 `version` 逐字相同（由 `test/version.test.mjs` 断言）。 */
export const PLUGIN_VERSION = '0.1.0'
