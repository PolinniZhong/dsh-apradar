/**
 * 适配器注册表（SDD §3.2）。
 *
 * 注册表在**模块加载时**就构造完毕：任何一个适配器不符合契约（缺少 `parse`
 * 或 `type` 不合法），插件会在加载期直接失败，而不是等到用户点「刷新」才炸。
 * 这是刻意的 —— 加载期失败在启动日志里一眼可见，运行期失败会伪装成「抓取失败」。
 *
 * @module dsh-apradar/src/host/adapters
 */

import { githubReleasesAdapter, GITHUB_TEMPLATES } from './github-releases.js'
import { githubRepoAdapter } from './github-repo.js'
import { npmPackageAdapter, NPM_TEMPLATES } from './npm-package.js'
import { rssAtomAdapter } from './rss-atom.js'
import { htmlStaticAdapter } from './html-static.js'
import { SourceConfigError, AdapterParseError, StructureUnsupportedError, resolveRequests } from './types.js'

/** 全部适配器，按 `type` 索引。 */
export const ADAPTERS = new Map([
  [githubReleasesAdapter.type, githubReleasesAdapter],
  [githubRepoAdapter.type, githubRepoAdapter],
  [npmPackageAdapter.type, npmPackageAdapter],
  [rssAtomAdapter.type, rssAtomAdapter],
  [htmlStaticAdapter.type, htmlStaticAdapter],
])

/**
 * 支持的来源类型顺序 —— 界面上的选择列表按此顺序展示。
 *
 * **地址由代码拼接的排前面**：用户不需要填一个可能抄错的 URL，也不可能把
 * 地址填成别的东西。需要用户自己找 RSS 地址的类型排后面。
 */
export const ADAPTER_ORDER = ['github_releases', 'github_repo', 'npm_package', 'rss_atom', 'html_static']

/**
 * 取一个适配器。
 * @param {string} type 类型标识
 * @returns {object|undefined}
 */
export function getAdapter(type) {
  return ADAPTERS.get(type)
}

/**
 * 取一个适配器，取不到就抛 `ADAPTER_CONFIG_INVALID`。
 * @param {string} type 类型标识
 * @returns {object}
 */
export function requireAdapter(type) {
  const adapter = ADAPTERS.get(type)
  if (!adapter) throw new SourceConfigError(`不支持的来源类型：${type}`, { type })
  return adapter
}

/**
 * 供界面渲染「添加来源」用。只暴露展示需要的信息，不泄漏实现。
 * @returns {object[]}
 */
export function listAdapters() {
  return ADAPTER_ORDER.map((type) => {
    const adapter = ADAPTERS.get(type)
    return {
      type: adapter.type,
      label: adapter.label,
      summary: adapter.summary ?? '',
      testable: adapter.testable === true,
      fields: adapter.fields ?? [],
      /**
       * 「有条件支持」的标记：界面必须把限制说清楚，不能让用户以为一定能用。
       *
       * 判据是**地址是不是代码拼的**：拼出来的地址不依赖用户抄对，也不依赖
       * 站点页面的结构；用户自填地址的类型（RSS、静态网页）则要如实警告
       * 「站点改版后可能失效」。这里刻意做成显式声明（`addressIsGenerated`）
       * 而不是「不是 github_releases 就算有条件」—— 后者会在每加一个受控类型时
       * 悄悄多出一条错误警告。
       */
      conditional: adapter.addressIsGenerated !== true,
    }
  })
}

/**
 * 预置来源模板。
 *
 * 只放**地址由代码拼接**的 GitHub Releases 模板 —— 这类地址的形状在代码里
 * 就写死了，不存在「假设某个站点有 RSS」的风险。用户仍需自己点「添加」，
 * 我们不会在安装时偷偷写进存储。
 *
 * 其余站点（OpenAI、Google 公告页等）的地址必须**逐个人工核实可访问性与
 * 结构**之后才能进这张表，未核实的不要凭印象加进来。
 *
 * @returns {object[]}
 */
export function listTemplates() {
  // 说明这几条模板为什么是安全的：地址不是用户填的，是代码拼的。
  const note = '地址由插件按 owner/repo 拼接，不依赖站点结构。'
  const npmNote = '地址由插件按包名拼接，不依赖站点结构。'
  const releases = GITHUB_TEMPLATES.map((tpl) => ({
    id: `github_releases:${tpl.owner}/${tpl.repo}`,
    type: 'github_releases',
    name: tpl.name,
    config: { owner: tpl.owner, repo: tpl.repo },
    note,
    verified: true,
  }))
  // 同一批仓库再给一份「仓库动态」模板：问的是不同的问题（他们说自己做什么，
  // 而不是他们发了什么），所以是两条独立的来源，由用户自己决定加哪一条。
  const repos = GITHUB_TEMPLATES.map((tpl) => ({
    id: `github_repo:${tpl.owner}/${tpl.repo}`,
    type: 'github_repo',
    name: `${tpl.owner}/${tpl.repo} 仓库动态`,
    config: { owner: tpl.owner, repo: tpl.repo },
    note,
    verified: true,
  }))
  const packages = NPM_TEMPLATES.map((tpl) => ({
    id: `npm_package:${tpl.packageName}`,
    type: 'npm_package',
    name: tpl.label,
    config: { name: tpl.packageName, tag: 'latest' },
    note: npmNote,
    verified: true,
  }))
  return [...releases, ...repos, ...packages]
}

export { SourceConfigError, AdapterParseError, StructureUnsupportedError, resolveRequests }
