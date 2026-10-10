/**
 * schema 版本迁移的入口点。
 *
 * 约定（与 `dsh-storage-domain` 的版本语义对齐，见 `lib/types/spec.d.ts`）：
 *   - 每个域的 `version` 是**当前**格式版本，只有非负整数有意义。
 *   - `compatibleVersions` 列出仍能被当前 schema 读懂的旧版本；写入总是打上当前版本。
 *   - `per-record` 布局按记录粒度做版本检查：**不被接受的记录文档直接被丢弃，绝不迁移**
 *     （`lib/types/per-record-unit.d.ts`）。所以迁移必须在域打开后、业务读写前显式做，
 *     不能指望后端代劳。
 *
 * 本文件当前是 v1，`MIGRATIONS` 为空。新增版本时：
 *   1. 在 `domains.js` 里把 `version` 提到新值，把仍可读的旧值加进该域的 `compatibleVersions`；
 *   2. 在 `MIGRATIONS` 里加一条 `{ from, to, description, run }`；
 *   3. `run` 必须**幂等**且可重入 —— 崩溃后下次打开会再跑一遍。
 *
 * @module dsh-apradar/src/host/store/migrate
 */

/**
 * 一条迁移。
 * @typedef {object} Migration
 * @property {number} from 起始版本
 * @property {number} to 目标版本
 * @property {string} description 人类可读说明
 * @property {(context: {domain: {name: string}, log: (message: string) => void}) => Promise<void>} run 迁移动作，必须幂等
 */

/** 已注册的迁移，按 `from` 升序。当前版本为 1，因此为空。 */
export const MIGRATIONS = /** @type {Migration[]} */ ([])

/**
 * 规划从 `from` 到 `to` 的迁移路径。
 *
 * 明确拒绝降级：存储里的版本比代码新，说明用户曾运行过更新的插件版本，
 * 此时**不能**猜测兼容性继续写 —— 调用方应当进入只读/降级模式并把原因告知用户。
 *
 * @param {number} from 存储中的 schemaVersion
 * @param {number} to 代码当前的 schemaVersion
 * @returns {{ok: true, steps: Migration[]} | {ok: false, code: 'downgrade' | 'no-path', reason: string}}
 */
export function planMigration(from, to) {
  if (!Number.isInteger(from) || from < 0) {
    return { ok: false, code: 'no-path', reason: `存储中的 schemaVersion 不是非负整数：${String(from)}` }
  }
  if (from > to) {
    return {
      ok: false,
      code: 'downgrade',
      reason: `存储中的 schemaVersion 为 ${from}，高于当前代码支持的 ${to}；拒绝猜测兼容性，进入降级模式`,
    }
  }
  if (from === to) return { ok: true, steps: [] }

  /** @type {Migration[]} */
  const steps = []
  let cursor = from
  while (cursor < to) {
    const next = MIGRATIONS.find((migration) => migration.from === cursor)
    if (!next) {
      return { ok: false, code: 'no-path', reason: `没有从 schemaVersion ${cursor} 到 ${cursor + 1} 的迁移` }
    }
    steps.push(next)
    cursor = next.to
  }
  return { ok: true, steps }
}

/**
 * 顺序执行迁移步骤。
 * @param {Migration[]} steps 由 {@link planMigration} 规划出的步骤
 * @param {{domain: {name: string}, log: (message: string) => void}} context 迁移上下文
 * @returns {Promise<void>}
 */
export async function runMigrations(steps, context) {
  for (const step of steps) {
    context.log(`迁移 ${context.domain.name}: ${step.from} → ${step.to}（${step.description}）`)
    await step.run(context)
  }
}
