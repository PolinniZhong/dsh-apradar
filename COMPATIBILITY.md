# COMPATIBILITY — AI 产品雷达 × DeepSeek Harness

> 兼容性核验报告 · 第一版（MVP）
> 配套文档：[PRD.md](PRD.md)、[SDD.md](SDD.md)、[MVP-BACKLOG.md](MVP-BACKLOG.md)

**路径记号**：`$PKG` = DSH 运行时包目录（`node_modules/@deepseek-ai`）；`$DSH_HOME` = DSH 用户数据目录；`$PROFILE` = 当前生效 profile 目录；`$APP` = Desktop 应用 resources 目录。
**本仓库文档不记录本机绝对路径**；所有绝对路径仅在本机核验时使用。

**证据分级**（全文严格遵守，不把推断写成已验证事实）

| 标记 | 含义 |
|---|---|
| `[已核实]` | 本机读取源码 / 官方包 README / 落盘物证确认 |
| `[待确认]` | 尚未取得证据，需执行 [SDD.md](SDD.md) §9.3 的最小验证 |
| `[外部]` | 来自外部公开资料，未在本机实测 |
| `[不支持]` | 已确认当前环境不提供 |

---

## 1. 核验范围与方法

| 项 | 方法 |
|---|---|
| 运行时版本 | 读 `$PKG/dsh/package.json`、DSH installation 的 `package.json`、版本记录文件 |
| Desktop 版本 | 读运行中的 DMG 卷 App 的 `Info.plist` 与 `manifest.jsonc`；对照 `/Applications` 内的旧副本 |
| 官方 API | 读 `$PKG/*/README.md`（280+ 份，本机最权威的接口文档）、`$PKG/*/lib/types/**/*.d.ts`、必要时读 `lib/index.js` |
| 组合与加载 | 读 `$PKG/dsh-base/cordis.patch.yml`、`$PKG/dsh-web-app/cordis.patch.yml`、`$PROFILE/cordis.patch.yml`、`$PROFILE/package.json` |
| 落盘物证 | 读 `$DSH_HOME/storages/*` 实际文件形态 |
| 同类实现参照 | 读本机已验证的第三方插件 Knit 的 `package.json`、Host 路由注册、Client 页签注册与 Remote 调用点 |

**核验未采用的方式**：不依赖记忆、不依赖 0.1.5 时代的旧文档、不依赖未验证的内部方法或 DOM 结构。

---

## 2. 版本真相（三套号互不正交地叠加，必须分开记录）

| 身份 | 版本 | 依据 | 状态 |
|---|---|---|---|
| **DSH 运行内核**（本插件真正要兼容的对象） | **`@deepseek-ai/dsh` 0.2.0-rc.2** | `$PKG/dsh/package.json` 的 `version`；DSH installation 的 `package.json` 依赖声明 | `[已核实]` |
| 内核版本标签 | `dsh-0.2.0-rc.2-36556493178`（commit `36556493178`） | 版本记录文件中的 `dsh_pkg_tag` / `dsh_pkg_commit` | `[已核实]` |
| **打包壳**（易被误认为内核版本） | `deepseek-harness-pkg` **0.2.0-rc.1**（`private: true`） | DSH installation 的 `package.json` 的 `name`/`version` | `[已核实]` |
| **Desktop 应用外壳**（Tauri，与本插件兼容性无关） | **0.22.4** | 运行中的 DMG 卷 App `Info.plist` 的 `CFBundleShortVersionString` | `[已核实]` |
| Desktop 推荐内核 | `{"dsh": {"recommend": "0.2.0-rc.2"}}` | `$APP/manifest.jsonc` | `[已核实]` |
| `/Applications` 内的另一份 Desktop 副本 | 0.16.0（**未运行**），其 `version-recommend.json` 仍写 `0.1.5-rc.3`（陈旧） | 该副本 `Info.plist` | `[已核实]` |
| **本地源码克隆**（仅作背景参考，**不是本机运行来源**） | **0.1.5-rc.2** | 源码克隆的 `package.json` | `[已核实]` |

**结论与风险**：

1. **必须以 0.2.0-rc.2 为准**。本地源码克隆落后一个大版本（0.1.5-rc.2），其文档只能当背景，任何 API 引用都必须回到 `$PKG` 下的 0.2.0-rc.2 文档复核。`[已核实]`
2. `0.2.0-rc.1` 是打包壳版本，**不是**内核版本；把两者混为一谈会得出错误的兼容范围。
3. profile **不锁定内核版本**：`$PROFILE` 的 lockfile 里没有 `@deepseek-ai/dsh@` 条目，profile 的 `node_modules/@deepseek-ai` 只含 2 个非内核包 → 内核 bundle 从 installation 解析。**即：内核升级会直接改变本插件的宿主版本，而 profile 层面不会给出提示。** `[已核实]`
4. 运行中的 Desktop 从 DMG 挂载卷启动，profile 内十余条依赖是 `link:` 到该卷的路径。**弹出 DMG 即断链。** `[已核实]`

---

## 3. 官方 API 与插件接入依据

### 3.1 插件清单与加载

| 能力 | 依据 | 状态 |
|---|---|---|
| `package.json` 的 `dsh.bundle.patch` = 一个路径或有序路径数组 | `$PKG/dsh-package-manifest/lib/types/types.d.ts`；消费点 `$PKG/dsh-app-boot/lib/index.js`（`bundlePatchPaths`） | `[已核实]` |
| `dsh.client` 声明：`platform`（必填，`'web'`）、`inject`（**仅信息性，不是 Cordis 注入**）、`immediately`、`external` | 同上 | `[已核实]` |
| `exports["./client"]` 必须是字符串或 `{default: string}` | `$PKG/dsh-client-modules/lib/index.js`（`clientExportOf`） | `[已核实]` |
| Client bundle 契约：`window.__ModuleLoader__.load({id, factory})`，`factory(require) → Record<string, unknown>`，返回对象即 Cordis 插件（`exports.apply` + `exports.inject`） | `$PKG/dsh-client-modules/lib/types/client/manifest.d.ts`；`$PKG/dsh-client-locale/lib/client.js` 尾部为实例 | `[已核实]` |
| 基线模块表（加载期可直接 `require`） | 构建产物中的 `staticModules` + `$PKG/dsh-client-ui-primitives` / `dsh-client-ui-dockkit` 等 | `[已核实]` |
| 超出基线的请求必须列入 `dsh.client.external` | `$PKG/dsh-client-modules/README.zh.md` | `[已核实]` |
| 宿主提供**已构建**的 Client bundle → npm 安装路径必须先构建出 `lib/client.js` | 同上 | `[已核实]` |
| `engines.dsh` 是 SemVer 范围但**不强制**：安装器与加载器都不校验 | `$PKG/dsh-package-manifest/README.md`（"Compatibility is declarative…"） | `[已核实]` |

### 3.2 右侧栏接入（本产品的 UI 唯一入口）

| 能力 | 依据 | 状态 |
|---|---|---|
| 只注册**一个**页签：`ctx.sidebarRightTabs.register({id, kind, priority, title, guide?})`，返回 disposer；同一 `id` 二次注册抛错 | `$PKG/dsh-client-ui-sidebar-right` README 与 `lib/types/client/tab-registry.d.ts` | `[已核实]` |
| 页签正文：`ctx.slots.register({name:'sidebar.right.pane.tab', key: definition.id}, Body)`，用框架注入的 `useTabInfo()` 读 `{sidebar, panel, tab}` | 同上（`contract/slots.d.ts`） | `[已核实]` |
| 打开：`ctx.sidebarRight.openTab(kind)`；`openResource(address, options?)` | 同上 | `[已核实]` |
| 优先级档 `extension` 最高，第三方插件默认用它 | `tab-registry.d.ts` 的 `SidebarRightTabPriority` | `[已核实]` |
| 其它可用席位：`sidebar.right.tab.guide`（替换引导页正文）、`sidebar.right.tab.menu.item`（页签菜单项） | 同上 | `[已核实]` |
| **面板无标题行**；**没有格级动作 / 折叠态控件的席位** | 同上（原文：「目前没有面向格级动作或折叠态控件的席位」） | `[已核实]` |
| 面板宽度**不可由插件声明**：最小 300px、最大 0.7 倍、默认 0.45 倍 | `$PKG/dsh-client-ui-layout/lib/types/client/columns.d.ts` 的 `RIGHTBAR_MIN` / `RIGHTBAR_MAX_RATIO` / `RIGHTBAR_DEFAULT_RATIO` | `[已核实]` |
| 保活：`keepMounted`；显式关闭回调 `registerCloseHandler`；折叠/展示变化/插件卸载**不**触发关闭回调 | `$PKG/dsh-client-ui-sidebar-right` README | `[已核实]` |
| 布局持久化在 **localStorage**（`dsh.sidebar-right.v1.<sessionId>`），不跨设备 | 同上 | `[已核实]` |
| 第三方实际接入成功案例 | Knit 的 `sidebarRightTabs.register` + `slots.inject/register` + `sidebarRight.openTab` 调用点 | `[已核实]` |

### 3.3 持久化

| 能力 | 依据 | 状态 |
|---|---|---|
| 存储栈已在 base bundle 挂载：`dsh-storage` + `dsh-storage-json`（`root = $DSH_HOME/storages`）+ `dsh-storage-domain`（`backend: json`） | `$PKG/dsh-base/cordis.patch.yml`（注释原文："the storage hub, the json backend, and the schema-validated domain form over them"） | `[已核实]` |
| 落盘物证 | `$DSH_HOME/storages/` 下同时存在 `single` 形态（`*.json`）与 `per-record` 形态（目录树） | `[已核实]` |
| `defineDomain({name, version, layout?, compatibleVersions?, invalidRecords?, global?, tables})` + `domainTable(zodSchema)` | `$PKG/dsh-storage-domain/lib/types/spec.d.ts` | `[已核实]` |
| **记录枚举**：`KvTable.get/entries/keys/size`；写：`put/delete/update` | `$PKG/dsh-storage-domain/lib/types/domain.d.ts` | `[已核实]` |
| **无分页 / 无筛选 / 无排序 / 无二级索引 / 无跨表事务** | 同上 + `dsh-storage-domain/README.zh.md` | `[已核实]` |
| 迭代是「内存快照」且**未声明有序** | `domain.d.ts` 原文注释 | `[已核实]` |
| 写语义：先后端持久化 → 再改内存 → 再发 `domain/changed`；被拒的写不触碰内存 | 同上 | `[已核实]` |
| `domain/changed` 是**进程内**事件，跨进程不可见 | `dsh-storage-domain/README.zh.md` 已知限制 | `[已核实]` |
| `invalidRecords: 'backup-and-skip'` 需要 `per-record` 布局 + 后端具备 `backupRecord` | `spec.d.ts`；`$PKG/dsh-storage-json/lib/types/per-record-unit.d.ts`（`backupRecord`）与 `lib/index.js` 实现 | `[已核实]` |
| 名称规则：domain/表名匹配 `/^[a-z][a-z0-9_]*$/`；记录键匹配 `/^[a-zA-Z0-9_-]+$/` | `$PKG/dsh-storage/lib/index.js`（`UNIT_NAME_RE`）、`$PKG/dsh-storage-json/lib/index.js`（`SAFE_KEY_RE`） | `[已核实]` |
| **SQLite 后端不存在** | `$PKG` 下仅有 `dsh-session-query-sqlite`（会话全文检索，非 storage 后端） | `[不支持]` |
| Domain 错误码 `already-open / facet-unsupported / invalid-record / missing-key / closed`；后端错误原样透传 | `$PKG/dsh-storage-domain/lib/types/error.d.ts` | `[已核实]` |
| `global` 的 schema 不得接受 `null`（`null` 是「从未写过」的哨兵） | `spec.d.ts` | `[已核实]` |
| 卸载插件**不清理** `$DSH_HOME/storages/*` | `$PKG/dsh-plugin-manager/README.md`（恢复只重写快照的两个文件）；plugin-manager 包内 grep `storages` 零命中 | `[已核实]` |
| **`ctx.storageDomain` 必须用 `ctx.get('storageDomain')` 读取**；直接读属性会抛 `Error: cannot get property "storageDomain" without inject` | 本机实测（首发自带插件的 `apply()` 因此把宿主打成 `dsh: fatal load failure`，exit 1）；官方免 inject 读法见 `$PKG/cordis/lib/types/reflect.d.ts` 的 `get(name, strict?)` 注释 "Read a service from the store without the inject requirement" | `[已实测]` |
| **外部（`link:`）插件解析不到 `@deepseek-ai/dsh-storage-domain`** —— 该包不在 profile 的 `node_modules` 里，插件裸 import 会 `ERR_MODULE_NOT_FOUND` | 本机实测：`~/.dsh/profiles/tauri/node_modules/@deepseek-ai/` 下只有 `cosmokit`、`schemastery`；同一位置 `import '@deepseek-ai/dsh-settings'` 亦为 `ERR_MODULE_NOT_FOUND`。**`link:` 协议不会为被链接包安装其 `dependencies`**，所以在插件 `package.json` 里声明 `zod` 也不会让 `import 'zod'` 在其目录内可解析 | `[已实测]` |
| **官方后端接受「以数据形状字面量声明的 `DomainSpec`」**（`domainTable(schema)` 就是 `{valueSchema: schema}`；facility 只调用 `safeParse(null)` / `parse(raw)`，全文件无 `instanceof`） | 本机实测：零依赖的正式插件用字面量 spec 成功打开 `ai_product_radar_sources` 并落盘 `$DSH_HOME/storages/ai_product_radar_sources.json` | `[已实测]` |
| 领域存储 + JSON 后端**在本机真实可跑**（打开、写 global、跨进程读回） | 本机实测：隔离宿主重启后 `openCount` 由 `1` 变 `2`，`firstOpenedAt` 保持不变 | `[已实测]` |

### 3.4 Host → Client 通信

| 路径 | 能力 | 依据 | 状态 |
|---|---|---|---|
| A（**P0 采用**） | `ctx.webServer.register({kind:'exact'\|'prefix', path, handler})` / `registerUpgrade`，返回 disposer | `$PKG/dsh-host-webserver/README.zh.md` | `[已核实]` |
| A | 同表重复路径抛错；匹配顺序：精确 → 最长前缀 → fallback；`registerFallback` 唯一席位 | 同上 | `[已核实]` |
| A | `host` 只接受 `127.0.0.1`（默认）或 `0.0.0.0`；**服务器自身不带 TLS / 认证 / 来源策略** | 同上 | `[已核实]` |
| A | handler 抛错 → 该请求 400（头已发出则销毁 socket）+ warning，**不退出进程** | 同上 | `[已核实]` |
| A | 第三方实际接入成功案例：Knit 的 `ctx.inject(['webServer','sessions'], …)` + `webServer.register({kind:'prefix', …})`、Client 侧同源 `fetch` | Knit 源码调用点 | `[已核实]` |
| B（P1 候选） | `ctx.typertGateway`（Host）与 `@deepseek-ai/dsh-api-gateway/client` 的 `ctx.remote`（Client），一元调用返回 `RemoteResult<T>`，不因载体问题 reject | `$PKG/dsh-api-gateway/README.zh.md` | `[已核实]` |
| B | 严格模式需要**生成的 `InvocationDescriptor`**（从 `ctx.typert.local` 读取）；SRC 模式只是开发期回退 | 同上 | `[已核实]` |
| B | 在打包运行时中生成描述符的工具链是否可用 | — | `[待确认]` |

### 3.5 出网

| 能力 | 依据 | 状态 |
|---|---|---|
| 受管出网 seam：`ctx.web.fetch(url)` / `ctx.web.search()` | `$PKG/dsh-web/lib/types/index.d.ts`；挂载于 `$PKG/dsh-base/cordis.patch.yml` | `[已核实]` |
| 真正抓网页的 provider 是 `dsh-web-fetch-http`（provider id `http`） | `$PKG/dsh-base/cordis.patch.yml`；`$PKG/dsh-web-fetch-http/lib/types/provider.d.ts` | `[已核实]` |
| `dsh-tool-web` 是**模型面向工具层、非网络层**，且在 web-app 组合里默认 `disabled: true` | `$PKG/dsh-web-app/cordis.patch.yml`；`presets/standard.patch.yml` | `[已核实]` |
| **`fetch()` 不含页面提取（HTML→正文）能力**，`web_extract` 类能力明确延期 | `$PKG/dsh-web/README.zh.md` | `[已核实]` |
| 运行时**没有任何 RSS/Atom/HTML/XML 解析包** | `$PKG` 包名全量核对（`*rss*`/`*atom*`/`*feed*`/`*xml*`/`*cheerio*` 零命中） | `[不支持]` |
| Accept 头为 `text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8` | `$PKG/dsh-web-fetch-http/lib/index.js` | `[已核实]` |
| `application/rss+xml` / `application/atom+xml` 因 `+xml` 后缀被分类为 `text` → **RSS/Atom 可抓** | `$PKG/dsh-web-fetch-http/lib/index.js` 的分类函数 | `[已核实]` |
| `application/json` 分类为 `text` → GitHub REST 可用 | 同上 | `[已核实]` |
| `WebFetchResult` = `{ url, statusCode, body, truncated }`：`url` 是**重定向后的最终地址**，`statusCode` 为非 2xx 时也照常返回（非 2xx 是结果不是错误） | `$PKG/dsh-web/lib/types/types.d.ts:68-77` | `[已核实]` |
| `WebFetchBody` 是 `dsh-web` **拥有的封闭判别联合**，只有 `{kind:'html',content}` 与 `{kind:'text',content}` 两种；新增 kind 是跨包协同变更、非插件扩展点（类型注释明确要求消费方 `switch` 以 `default: assertNever(...)` 收尾） | `$PKG/dsh-web/lib/types/types.d.ts:78-93` | `[已核实]` |

---

## 4. 能力分级

### 4.1 已确认可用（可直接进入设计与实现）

| # | 能力 | 本产品用途 |
|---|---|---|
| A1 | `dsh.bundle.patch` + `dsh.client`（`platform:'web'`）+ `exports['./client']` | 插件清单 |
| A2 | 右栏页签注册（`sidebarRightTabs.register`）+ 正文席位（`sidebar.right.pane.tab`） | **唯一 UI 入口** |
| A3 | `useTabInfo()` 读取页签上下文 | 页内路由与标题 |
| A4 | `ctx.storageDomain.open(spec)` + `KvTable.get/entries/keys/size/put/delete/update` | 来源/快照/变化/机会持久化。**读服务必须用 `ctx.get('storageDomain')`**（见 §3.3）；**已在本机实测落盘并通过跨进程读回**（`openCount` 1→2） |
| A5 | `per-record` 布局 + `invalidRecords:'backup-and-skip'` + `compatibleVersions` | 大记录存储与损坏记录容错（API 已核实；本产品尚未实测 `backup-and-skip` 的实际行为，见 V2） |
| A6 | `ctx.web.fetch()`（协议白名单、公有地址白名单、体积/超时/重定向上限、匿名） | 唯一出网方式 |
| A7 | `application/rss+xml` / `+xml` / `application/json` 被分类为 `text` | RSS/Atom/GitHub Releases Atom 可抓 |
| A8 | `ctx.webServer.register({kind:'prefix', …})` + 同源 Client `fetch` | Host→Client 数据接口 |
| A9 | Cordis `ctx.effect` / `ctx.inject([...])` | 生命周期 |
| A10 | HMR 覆盖 Host Node 模块图 | 开发期 |
| A11 | Client 单文件免构建路径（`__ModuleLoader__.load` + 平台基线模块） | 客户端形态 |

### 4.2 条件可用（可用，但有明确前提）

| # | 能力 | 前提条件 |
|---|---|---|
| C1 | 三视图 + 详情在**一个**右栏页签内实现 | 必须自己在页面内容里做分段控件与返回导航；面板无标题行、无格级工具栏席位 `[已核实]` |
| C2 | 右栏宽度适配 | 插件不可声明宽度；框架最小 300px、最大 0.7 倍 → 按 300–560px 单列设计 |
| C3 | 列表查询（筛选/排序/分页） | 只能在 Host 内存中做；枚举靠 `entries()/keys()/size`，**无分页/排序接口** |
| C4 | 大规模数据 | `open()` 会全量载入内存 → 必须自建上限控制（[SDD.md](SDD.md) §5.4） |
| C5 | 固定域名之外的任意网页 | 仅 `html_static`，且结构判据不满足时**必须拒绝**该来源 |
| C6 | 跨源跳转的站点 | 抓取层跨源重定向直接失败 → 必须让用户填最终 URL |
| C7 | Desktop 下 Client 访问插件路由 | ✅ **已实测通过（不再是条件项）**。`/apradar/ping` 与 `/apradar/state` 在真实桌面宿主的渲染进程内以同源相对路径取到 `200`，面板正文渲染出 Host 原始 JSON；隔离 Web Profile 上六项往返判定同样全为 true。证据见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.1 / §6.2 / §6.4（**限制**：Tauri 自己的 WKWebView 无 CDP 端点，该证据来自同一宿主、同一页面源的真实 Chromium 渲染进程） |
| C8 | 发布为 npm 包 | 必须先构建出 `lib/client.js`，否则激活失败。**实测补充（P1-07，2026-10-09）**：缺 bundle 时 `dsh web` **照常启动、页面照常渲染、日志与页面都没有任何提示**，本插件的客户端条目只是从启动图里消失 —— 官方 README 承诺的那条构建说明并**没有**出现。因此本插件在启动时自己诊断（`ctx.clientModules.clientPath(id)`）：缺失时 `warn` 一条含包名与修法的信息，`/apradar/meta` 的 `runtime.clientHalf` 也持续报告。见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.12.4 |
| C9 | 布局/视图状态的持久化 | 只能用 localStorage（Client 侧）；不可跨设备 |
| C10 | 类型化 RPC | 生成描述符在运行时**已被使用**（23 个包 / 126 条 local 描述符），但生成器是开发期工具且客户端面无发现机制 → **本插件不采用**（V4 已结清，见 §4.3.1） |

### 4.3 待验证（**不得在实现中当作已成立的事实**）

| # | 待验证项 | 影响 | 最小验证 |
|---|---|---|---|
| V1 | Desktop（Tauri/IPC）下 Client 能否同源访问 `/apradar/*` | 若不可达，Host→Client 通信方案需整体更换为 typert RPC；**用户 m00370 决策②：此项未通过前不得开发任何正式 UI** | 见 P0-00 Spike：最小验证插件注册 `GET /apradar-spike/ping`，在 **Desktop 与 Web 两个 profile** 各由 Client 按钮调用并记录结果 |
| V10 | 静态闸门（G-NET-2/G-NET-3）能否覆盖运行期绕过形态 | G-NET 闸门的**完整性声明**（不阻塞开工） | 实测 `process.getBuiltinModule('http')`、`createRequire(import.meta.url)('node:http')`、动态 `import('node:http')` 是否被扫描器捕获 |
| V2 | `backup-and-skip` 的实际效果 | 损坏记录容错策略 | 手工放置坏文档，重开 domain 观察 |
| V3 | `version-mismatch` 的界面化恢复流程 | 升级路径 | 手工改落盘 `version` 后重开 |
| ~~V4~~ | typert 严格模式代码生成在打包运行时是否可用 | P1 RPC 迁移可行性 | ✅ **已结清**（2026-10-09，P1-06）：**运行时可用**（`ctx.typert.local` 实测 **126** 条生成描述符、23 个包）；**但本插件不迁移** → 保留同源 HTTP。见 §4.3.1 |
| V5 | GitHub `releases.atom` 实际可用性与速率表现 | P0 首选来源类型 | 对 1 个公开仓库连续抓 3 次，记录状态码/体积/耗时 |
| V6 | Client 单文件免构建路径在本插件上直接可用 | 客户端形态 | 以本地路径安装最小插件并打开右栏 |
| V7 | `.local` 域名是否会被抓取层拒绝 | 安全边界完整性 | 实测一次（预期取决于 DNS 解析结果） |
| V8 | 是否存在 OS 级 egress 拦截（防火墙/强制代理） | 网络可用性 | 检查系统代理与防火墙设置 |
| V9 | 插件显式声明的 `zod` 能否被 `domainTable` 接受 | 存储 schema 的可实现性（`domainTable` 形参类型即 zod schema） | 以插件自带 zod 构造 table schema 并 `open()`，确认校验通过；记录安装是否触发供应链闸门 |

### 4.3.1 已结清的待验证项（P0-00 Spike + Milestone 1 实测）

| # | 原待验证项 | 结论 | 证据 |
|---|---|---|---|
| **V1** | Desktop（Tauri/IPC）下 Client 能否同源访问 `/apradar/*` | ✅ **可达**。真实桌面宿主（PID 84103，免重启热挂载）内，Client 以同源相对路径取 `/apradar/state` 得 `200` 并渲染出 Host 原始 JSON；失败态 `/apradar/boom` 得 `500` 且可与 404 区分 | [TECH-SPIKE.md](TECH-SPIKE.md) §6.1、§6.4 |
| **V6** | Client 单文件免构建路径在本插件上直接可用 | ✅ **可用**。`dsh-apradar` 的 `src/client/client.js` 无构建步骤、无 JSX，右栏页签在 Desktop 与隔离 Web Profile 上均注册成功（console `官方右侧栏页签已注册：kind = apradar`） | [TECH-SPIKE.md](TECH-SPIKE.md) §6.4 |
| **V9** | 插件显式声明的 `zod` 能否被 `domainTable` 接受 | ⚠️ **问题前提不成立 → 已改为不使用 zod**。①`link:` 协议不会为被链接包安装 `dependencies`，插件内 `import 'zod'` 解析不到自己声明的版本（本机实测 `ERR_MODULE_NOT_FOUND` 同类失败已见于 `@deepseek-ai/dsh-storage-domain`）；②**官方后端接受数据形状字面量 spec**，无需 zod。因此正式插件走零运行时依赖路径（[SDD.md](SDD.md) §5.1） | [TECH-SPIKE.md](TECH-SPIKE.md) §6.4 |
| **V4** | typert 严格模式代码生成在打包运行时是否可用 | ✅ **已结清，结论是「运行时可用，但本插件不采用」**。**可用面（现场实测 `/apradar/meta` 的 `runtime.typert`）**：`ctx.typert` 已挂载；**23** 个包贡献了生成反射；`ctx.typert.local.list()` = **126** 条本环境调用描述符；`ctx.typert.remotes.list()` = 0（宿主进程无消费方选定 Remote）；本插件 `ownPackageRegistered: false`。**不采用的三条理由**：① 生成器 `@deepseek-ai/dsh-typert-generator` 是 **TypeScript 项目分析器**，通过 `exports["./tsdown"]` 挂在 `tsdown` 构建上（官方包脚本即 `"bundle": "tsdown"`），而**运行时里没有 `tsdown`** —— 生成属开发期流水线；本插件目前是**纯 JS、零运行时依赖、无构建步骤**，采用它等于引入 TS + tsdown + 生成器一整套构建链。② `dsh-typert-loader` README 的已知限制原文：「**仅宿主侧** —— 发现机制只会导入宿主侧 `./typert` 产物；**在为客户端运行时添加等价的发现机制之前**，需要先有独立的组合所有者」→ **客户端面没有 typert 发现机制**，而本插件的主要消费方正是客户端面。③ 更早的决策 V1/T17 已判定：Desktop 与隔离 Web Profile 双向实测均通过 → **同源 HTTP 方案维持不变**，V4 不升为 P0 | [TECH-SPIKE.md](TECH-SPIKE.md) §6.11 |
| — | 持久化是否真的落盘（原 §7「本 Spike 不验证持久化」） | ✅ **已由 Milestone 1 补齐**。隔离宿主重启后 `openCount` 由 1 变 2、`firstOpenedAt` 不变；真实 profile 下 `$DSH_HOME/storages/ai_product_radar_sources.json`（273 B）生成 | [TECH-SPIKE.md](TECH-SPIKE.md) §6.4 |

**仍未结清的高风险项**：V2（`backup-and-skip` 实际行为）、V3（`version-mismatch` 恢复流程）、V5（GitHub `releases.atom` 真实表现）、V7（`.local`）、V8（OS 级 egress）、V10（静态闸门覆盖面）。（V4 已于 2026-10-09 由 P1-06 结清，见下表。）
**仍未验证的环境事实（本条已于 2026-10-09 21:20 结清）**：~~真实桌面宿主重启后 `openCount` 是否递增~~ → ✅ **已实测通过**。用户自行重启 Desktop 后宿主进程由 `PID 84103` 变为 `PID 71800`（起始 21:20:16），`/apradar/state` 返回 `openCount: 2`，`firstOpenedAt` 仍是首次的 `2026-10-09T12:58:38.949Z`、`lastOpenedAt` 更新为 `2026-10-09T13:20:19.881Z`，磁盘文件同步为 `openCount: 2` → **真实 Desktop 环境下的跨重启持久化成立**，与隔离宿主结论一致。
**新增已实测的限制（插件卸载路径）**：`plugin --profile tauri remove <包>` 在本机**失败**，pnpm 报
`ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED: 1 resolution-policy violation was produced but no handleResolutionPolicyViolations callback was wired to react to them`
（`Internal: resolveDependencies needs a handleResolutionPolicyViolations callback whenever a policy that can produce violations (today: minimumReleaseAge) is active`）。→ **安装路径会接上该回调、卸载路径没有接**，属插件管理器侧缺陷。失败是干净的：`package.json` 的 `dependencies` 与 `dsh.profile.bundles` **均未改变**，无半成品状态。**可用的替代做法**：在 profile 的 `cordis.patch.yml` 末尾追加 `- id: <包名>` / `name: '<包名>'` / `disabled: true` —— 有 HMR 时**热生效、无需重启**（本机实测：追加后 Spike 的 `/apradar-spike/ping` 立即变为 `404` 且响应体为空，宿主 PID 未变），且完全可逆。

### 4.4 已确认不支持（设计上必须绕开或明确排除）

| # | 不支持的能力 | 影响的决策 |
|---|---|---|
| N1 | SQLite 存储后端 | 只能用 JSON 后端；依赖 `per-record` 布局承载大记录 |
| N2 | 存储层的**跨表事务 / 二级索引 / 多段键 / 数据迁移** | 索引不可作唯一真相；schema 只增可选字段，否则手工迁移 |
| N3 | `domain/changed` 跨进程可见 | 不能依赖事件推送；本产品用手动刷新 + 请求/响应，天然规避 |
| N4 | 右栏**标题行**、格级动作席位、折叠态控件席位 | 所有按钮必须放在插件自己的页面内容里 |
| N5 | 右侧栏宽度由插件声明 | 按 300–560px 单列设计 |
| N6 | 官方 RSS/Atom/HTML/XML 解析能力 | 解析器必须自带（P0 采用零依赖自研，见 §6.3） |
| N7 | `fetch()` 的页面正文提取 | 必须自己做标签剥离与块切分 |
| N8 | 抓取层发送凭据 / 支持登录态 | 登录态页面明确排除在 MVP 之外 |
| N9 | 每条路径的独立 install/uninstall/enable 命令 | 只能 `dsh plugin --profile <p> <pnpm 参数>` 透传，或用 `plugin_manager` agent tool（要求 danger-full-access） |
| N10 | 卸载时清理插件数据 | 必须自带显式「清除全部数据」并告知用户数据会留存 |
| N11 | 官方 API 稳定性承诺 | 见 §8：必须在清单里声明 `engines.dsh` 并自留回归测试 |

---

## 5. Web / Desktop 兼容性差异

| 方面 | Web Profile | Desktop（Tauri） | 对本插件的影响 |
|---|---|---|---|
| Host 运行时 | `dsh --profile web` 启动 `dsh/lib/bin.js` | Tauri 应用启动**同一个** `dsh/lib/bin.js` | **出网限制完全一致** `[已核实]` |
| bundle 组合 | 前缀同为 `dsh-base` + `dsh-web-app` | 同 | 两个 profile 都未覆盖 web-fetch-http → **抓取默认值一致** `[已核实]` |
| 入站 HTTP | `node:http` 服务器 | 注释称 Electron 侧以 `file://` 加载 dist 并经 IPC 桥接承载 fetch | **插件路由在 Desktop 下的可达性是 V1 待确认项** `[待确认]` |
| `--host 0.0.0.0` | 被硬拦 | 被硬拦 | 只能回环 |
| `/api` 入站 | browser-trust fence | 同 | 本插件复用 DSH 入站边界，不自建 |
| Client 加载 | 同为 `__ModuleLoader__` + `/plugins` | 同 | 客户端形态一致 |
| HMR | 覆盖 Host Node 模块图 | 同；Client 模块图另有独立加载机制 | Client 改动需刷新页面 |
| 布局持久化 | localStorage | localStorage | 每个浏览器/窗口独立 |
| 官方文档可读性 | `$PKG` 目录可直接读 | 注释警告：Desktop 下该目录在 `app.asar` 内，shell/rg/node/pnpm 读不到 | **开发期一律在可读环境下核验接口** |

**结论**：出网、存储、UI 三项核心能力在两个 Profile 下同构；**唯一的实质差异在入站 HTTP 的可达性（V1）**。

---

## 6. 依赖分析

### 6.0 定时器能力（P1-01 核验，2026-10-09）

| 包 | 版本 | 判定 | 依据 |
|---|---|---|---|
| `@deepseek-ai/dsh-schedule` | 0.2.0-rc.2 | ❌ **不可用** | 它是**按会话绑定的提醒/任务投递**服务（一次性 `after_seconds`/`at`、固定 `every_seconds`、`daily`/`weekly`/`cron`），把后续消息投递回**原会话**，不是给插件代码用的通用后台定时器。其 README 原文：「**随发行版交付的 Web 组合不含 `schedule` 行**」—— 启用必须挂**实验性** bundle `@deepseek-ai/dsh-experimental-schedule-bundle` 或把它列进 profile 的 `dsh.profile.bundles` `[已核实]` |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.6 | ✅ **采用** | Cordis 的**释放感知**定时器服务。API `ctx.timeout/interval/throttle/debounce`（`ctx.setTimeout`/`ctx.setInterval` 为已废弃别名）。README 原文：「Timer handles are registered on the current fiber, so they are cleared automatically when the plugin that created them is disposed.」 `[已核实]` |
| 是否已挂载 | — | ✅ | 被 `dsh-base` / `dsh-app-boot` / `dsh-cordis-host-runner` / `dsh-hmr` / `dsh-plugin-manager` / `dsh-sdk-minimal` / `dsh-settings` 依赖 → `dsh-base` 必挂载。**实跑证实**：`GET /apradar/meta` → `scheduler: {available:true, running:true, degraded:false, tickMs:60000}` `[已实测]` |
| **但不要写进 `ctx.inject`** | — | ⚠️ | 设施永远不出现时 inject 回调永不执行，插件会以"完全不存在"的方式失败。用 `ctx.get('timer')` 主动探测；探测不到降级到全局 `setInterval` 并标注 `degraded: true`；都没有才报 `available:false` + `reason` |

### 6.1 Storage 依赖

| 项 | 结论 |
|---|---|
| 需要哪些包 | `dsh-storage`（hub）+ `dsh-storage-json`（后端）+ `dsh-storage-domain`（数据形式）——三者缺一不可 |
| 当前 Profile 是否已加载 | ✅ 三者均由 `dsh-base` 的 patch 挂载，`$DSH_HOME/storages/` 有实际落盘物证 `[已核实]` |
| 后端 | **仅 JSON**（`backend: json`，`root = $DSH_HOME/storages`）；无 SQLite `[不支持]` |
| 插件是否需要声明依赖 | 需要在 Host 插件里 `ctx.inject([...])` 等待服务就绪；`dsh.client.inject` 是**信息性字段，不是 Cordis 注入** `[已核实]`。**但读 `storageDomain` 时不能靠「不 inject 直接读属性」**：那会抛 `cannot get property "storageDomain" without inject` 并打死宿主，必须走 `ctx.get('storageDomain')` `[已实测]` |
| **插件能否 `import` 到 `dsh-storage-domain`** | ❌ **不能**。该包不在 profile 的 `node_modules` 里；`link:` 协议也不会为被链接包安装 `dependencies` → 插件内裸 import 报 `ERR_MODULE_NOT_FOUND`（同类失败亦见于 `@deepseek-ai/dsh-settings`）`[已实测]` |
| `zod` 从哪来 | `domainTable(schema: ZodType<V>)`（`$PKG/dsh-storage-domain/lib/types/spec.d.ts`）在类型上要求 zod schema。但 `link:` 场景下插件**声明了也解析不到**（见上一行）；Profile 顶层另有一份 **4.1.8** 的 hoisted 副本（来自 `billion-context`），**未声明**在 `$PROFILE/package.json` 中 → **幻影依赖，不可依赖** `[已核实]` |
| facility 如何校验 schema | **鸭子类型**：只调 `.safeParse()` / `.parse()`，全文件**无 `instanceof`**（`$PKG/dsh-storage-domain/lib/index.js:74, 371, 383`）；`defineDomain(spec)` **纯校验后原样返回 spec**，`domainTable(schema)` 就是 `{ valueSchema: schema }` `[已核实]` |
| **本产品采纳的路子** | **零运行时依赖 + 数据形状字面量 spec**：先用 `await import('@deepseek-ai/dsh-storage-domain')` 动态探测（**动态**才不会在解析期整体失败），拿到官方 helper 就用，拿不到就退回字面量。**已在本机实测落盘成功**（`$DSH_HOME/storages/ai_product_radar_sources.json`）`[已实测]` |
| 数据在卸载后是否保留 | ✅ 保留（DSH 不清理 storages）→ 必须在 UI 明示 + 提供显式清除 |
| 跨进程可见性 | ❌ 不可见 → 单进程设计，客户端刷新靠请求/响应 |

### 6.2 网络请求限制（生效值，全部为当前默认，Profile 未覆盖）

| 限制 | 值 | 依据 |
|---|---|---|
| 协议 | 仅 `http:` / `https:`，且 URL 不得内嵌凭据 | `[已核实]` |
| URL 长度上限 | **2,048 字符（不可配）** | `[已核实]` |
| 超时 | `timeoutMs` = 30,000 ms | `[已核实]` |
| 响应体上限 | `maxResponseBytes` = 5,000,000 字节 | `[已核实]` |
| 正文上限 | `maxBodyChars` = 100,000 字符 | `[已核实]` |
| 重定向上限 | `maxRedirects` = 5；**跨源重定向直接失败** | `[已核实]` |
| SSRF | **公有地址白名单**：解析结果中任一地址非公共单播即整体拒绝 | `[已核实]` |
| 内容类型 | 仅 `html` / `text`；二进制与未知类型拒绝 | `[已核实]` |
| 凭据 | 不发送任何凭据 | `[已核实]` |
| User-Agent | `deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)` | `[已核实]` |
| 并发闸门 | **DSH 全仓无并发限制常量** → 本插件自带 `FETCH_CONCURRENCY = 2` | `[已核实]`（否定证据） |

**残余风险**：命中代理时不固定连接、由代理解析（R1）；`.local` 无专门规则（R2，V7）。详见 [SDD.md](SDD.md) §8.3。

**⚠️ 上表的保护是"自愿使用的 seam"，不是运行时沙箱**（用户 m00370 已将其升为正式 P0 闸门）：

| 事实 | 依据 |
|---|---|
| 动态插件 Host 半在 `node:vm` 内、`fetch`/`require` 有 trap，但官方自认 **"is not containment"**（host-realm helper 仍是逃逸路径） | `[已核实]` |
| **静态 profile 插件经 `import(name)` 直入 Host 进程，不经 vm** | `[已核实]` |
| `dsh-sandbox` 的能力词表中**不含网络**；macOS Seatbelt 策略只有 `(allow default)` + `(deny file-write*)` | `[已核实]` |
| 因此静态 Host 插件可直接用内建 `fetch` / `node:http` 出网，**绕开上表全部 URL 校验、SSRF 白名单、体积与重定向上限** | `[已核实]`（推论，依据同上三条） |
| 阻断 `globalThis.fetch` 只是**必要条件，不是充分条件**：`import('node:http')`、`createRequire(import.meta.url)('node:http')`、`process.getBuiltinModule('http')` 都不经过 `globalThis` | `[已核实]`（待 V10 实测覆盖面） |

**结论**：`ctx.web.fetch()` 是**本插件代码纪律约定的唯一业务出网入口**（G-NET-1），并由 G-NET-2/G-NET-3 静态扫描 + G-NET-4 运行期替身断言 + G-NET-5 评审清单共同约束（[SDD.md](SDD.md) §8.1.1）。**但 DSH 当前不提供网络沙箱，因此本插件不得宣称"网络请求无法被绕过"，也不得宣称"具备完整的 SSRF 防护"。** 在 V7/V8/R1 有实测结论之前，P0 优先实现受控的 GitHub 与官方来源适配器（[SDD.md](SDD.md) §8.1.2），静态 HTML 排在 P0 最后。

#### 6.2.1 实测：真实出网的可用面与不可用面（2026-10-09）

上表是**契约值**。以下是本机**实测值** —— 两者不等价的地方才是真正的坑。

| 事实 | 实测证据 | 对本插件的含义 |
|---|---|---|
| `github.com` 在本机**完全不可达** | `curl` → `000`（15–20 s 超时，exit 28），含 `.../releases.atom` | 可达性是**逐主机名**的，不能按域推断。适配器必须有候选端点（见 P0-05 双端点） |
| `api.github.com` 可达 | 200 / 2.5 s（`curl`）；插件内 200 / **749 ms** / 10 条 | 首选端点选它 |
| `maxBodyChars: 100000` 是**真实功能天花板**，不是理论值 | `github.blog/feed/` = 1,235,394 B（**12.4×**）、`openai.com/blog/rss.xml` = 767,810 B（7.7×）、`marktechpost` / `deepmind` 各 368 KB（3.7×） | 大型 Feed **必须**先判截断再解析，否则解析器会把容量限制报成"Feed 格式错误"（详见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.6.2） |
| 截断发生时宿主**不会**报错 | 返回 `truncated: true` + 被截断的前缀 | 责任在本插件：`assertBodyNotTruncated()` 拒绝解析被截断的前缀 |
| 出网失败的真实原因**只在 `err.cause` 里** | 外层是 `WebError("web fetch failed: TypeError: fetch failed", "WEB_PROVIDER_ERROR", { cause })`，可用信息全在 cause 链：`Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms) (UND_ERR_CONNECT_TIMEOUT)` | 错误归一化**必须**沿 `cause` 链取文案（`describeCause()`），否则用户只看到"出网请求失败" |
| DNS 被宿主固定解析 | `dsh-web-fetch-http` 用 undici `Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses) } })` + `redirect: 'manual'`；`resolvePublicAddresses()` 只要答案集里有一个非公网地址就**整体拒绝**（`WEB_BLOCKED_URL`） | 代理/DNS 相关失败无法在本插件侧修复，只能如实透出 |
| 宿主**没有可读的日志文件** | `~/.dsh/logs` 不存在，`~/.dsh` 下 2 小时内无任何 `*.log` | 错误对象是唯一信息源 → "错误里必须留住 cause 链"不是可选项 |
| **另一个** GitHub 主机 `api.github.com/repos/{o}/{r}` 可达 | 200 / **6,938 B**；插件内 200 / **508 ms** / 11 条 | P1-04 的 `github_repo` 用同一主机的另一个端点 |
| `registry.npmjs.org` 可达，但**只有单版本端点可用** | `/{pkg}/latest` 200 / **7,826 B**；完整 packument `/{pkg}` 200 / **4,496,833 B**（**44.9× 上限**） | npm 适配器只用 `/{pkg}/{tag}`；完整 packument 是实测唯一直接撞上 `maxBodyChars` 的形状 |
| `api.npmjs.org` 可达且极小 | `/downloads/point/last-week/openai` 200 / **81 B** | 可用，但目前没有适配器消费它 |
| `pypi.org` 的 JSON **超限**、RSS **可用** | `/pypi/openai/json` 200 / 683,641 B（6.8×）；`/rss/project/openai/releases.xml` 200 / 11,440 B | PyPI 只能走 RSS（复用 `rss_atom`，不需要新适配器） |
| `openrouter.ai` / `huggingface.co` / `raw.githubusercontent.com` | openrouter 200 / 782,040 B（7.8×）；huggingface 与 raw.githubusercontent **`000` 不可达** | 都不在 P1-04 的候选里 —— **可达性是逐主机名的，选适配器类型之前必须先 curl** |

**边界值实测（证明上限两侧都能正确工作）**：`simonwillison.net/atom/everything/` = 89,841 B（**贴 100,000 字符上限**）→ 正常解析出 30 条；再大一点（368 KB 起）→ 稳定给出可读的截断错误。

### 6.3 RSS / Atom 解析依赖：选型、安装方式与兼容性验证步骤

**前提事实**：本运行时**没有任何官方 feed 解析能力** `[不支持]`，因此解析能力必须自带。这是本产品唯一的"硬依赖缺口"。

#### 6.3.1 P0 选型：零依赖自研严格子集解析器（**采用**）

| 项 | 内容 |
|---|---|
| 范围 | RSS 2.0 的 `channel/item/title/link/guid/pubDate/description/content:encoded`；Atom 1.0 的 `feed/entry/id/title/link/updated/summary/content`；GitHub `releases.atom` |
| 实现 | 单遍词法扫描 + 小状态机；处理 CDATA、命名空间前缀、常见命名实体、`&#x..;`/`&#..;` 数字实体、自闭合标签、BOM；不做 DTD、不解析外部实体（**同时消除 XXE 类风险**） |
| 代码量估计 | 约 300–500 行 + 实体表 |
| 优点 | 无安装步骤、不触发供应链闸门、无 `engines.dsh` 兼容问题、DSH 升级重建 profile 时零成本、可在 CI 离线全量 fixture 测试 |
| 缺点 | 需要自己维护边界用例；对非标准 feed 的容忍度低于成熟库 |
| 接受条件 | **§9.2.1 核心 fixture C1–C7 必须 100% 通过，其中一项失败即整体不通过**（用户 m00370 决策③）；§9.2.2 参考 fixture 通过率只作参考，不能抵扣或放宽核心验收；对畸形输入返回结构化错误而非崩溃 |

#### 6.3.2 P1 备选：引入第三方 feed 解析库（**暂不采用**）

**触发条件（用户 m00370 决策③收紧后）**：**核心 fixture C1–C7 必须已经 100% 通过**，且业务确实需要超出 RSS 2.0 / Atom 1.0 子集（§6.3.1 范围行）的格式。**参考 fixture 的失败率（含此前设想的 > 5%）本身不构成引入理由**，也不得用来替代核心验收。即：引入第三方库解决的是"覆盖更多真实来源"，不是"核心解析没做对"。

**选型标准（按优先级）**

| # | 标准 | 理由 |
|---|---|---|
| 1 | 纯 JS、无原生编译产物 | 避免与 Node 版本 / 平台绑定 |
| 2 | 零或极少传递依赖 | 供应链闸门按 lockfile 条目数校验，依赖越多越容易被拒 |
| 3 | 声明 `engines.node` 兼容（需 `>=22.19`） | 与 DSH 运行时一致 |
| 4 | 不发起网络请求、不解析外部实体 | 安全边界不被破坏 |
| 5 | 维护活跃、许可证宽松（MIT/Apache-2.0） | 长期可维护 |
| 6 | 体积小（关注 Client bundle 不受影响；仅 Host 使用） | 保持依赖面最小 |

**安装方式**（在实现阶段执行，本阶段不执行）

```bash
# 1) 查看当前 profile 与已装插件
dsh plugin --profile <profile> list

# 2) 安装到目标 profile（dsh plugin 把剩余参数原样转发给 pnpm）
dsh plugin --profile <profile> add <package>@<pinned-version>

# 3) 若被供应链策略拒绝（观测到的形态）：
#    ✗ Lockfile failed supply-chain policy check
#    [ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION] … entries failed verification
#    正确做法（用户 m00370 决策③：不绕过最小发布年龄检查）：
#      a) 等该版本达到最小发布年龄后重试；或
#      b) 改选一个已经满足年龄要求的固定版本；或
#      c) 无法满足时保持零依赖，并收窄承诺范围。
#    禁止：--config.minimumReleaseAge=0、删除 minimumReleaseAge、手工写 node_modules 假装安装成功。
#    minimumReleaseAgeExclude 只能由用户在明确知情后手动添加，不由插件自行追加。
```

**兼容性验证步骤（安装后必须逐条完成）**

| # | 步骤 | 通过判据 |
|---|---|---|
| 1 | 读安装后包的 `engines.dsh` / `engines.node` | 与本机内核 0.2.0-rc.2、Node ≥ 22.19 兼容；**注意 `engines.dsh` 不被工具强制**，必须人工判断 |
| 2 | 检查 lockfile 条目数与新增传递依赖 | 条目数增量可接受；无原生模块 |
| 3 | 在插件内**只在 Host 侧** import，Client bundle 不引用 | `dsh.client.external` 不需要新增条目 |
| 4 | 用 §9.2 全部 fixture 跑解析测试，与自研实现对比 | 输出一致或在已知边界上更优 |
| 5 | 触发一次 DSH 内核升级演练，确认升级后插件可重建 | 升级会新建 profile、插件不迁移 → 记录重建步骤 |
| 6 | 记录精确版本号进本文件与 `package.json` | 版本固定，不用浮动范围 |

**当前结论**：P0 采用 6.3.1；6.3.2 仅在触发条件满足时启动，且必须先完成上表 6 步验证。

---

## 7. 安装 / 升级 / 卸载 / 重载风险

| # | 风险 | 事实依据 | 缓解措施 |
|---|---|---|---|
| 1 | **升级会新建 profile，第三方插件与 patch 定制不随之迁移** | `$PROFILE/cordis.patch.yml` 注释明确记录 0.1.7→0.2.0 迁移时三方插件与本 patch 定制未随之迁移；实测 0.1.7 的 settings/settings-core 兼容补丁与 better-sidebar 配置整段失效 `[已核实]` | 把本插件写进自己的安装脚本/清单；每次内核升级后按 §9 矩阵重跑 |
| 2 | **preset 矩阵会按内核版本自动删除插件** | `$APP/README.md`：无匹配 matrix 条目 → 标记 unsupported 并**移除已装副本**；条目匹配但版本越界 → 移除待重装 `[已核实]` | 本插件清单声明 `engines.dsh`（声明性，但为矩阵判定提供依据）；不依赖"装上就一直都在" |
| 3 | **供应链闸门可能直接拒装** | 本机 `plugin-errors.json` 记录 4 个插件被拒：`✗ Lockfile failed supply-chain policy check` + `[ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION]` `[已核实]` | P0 零第三方依赖；若引入依赖，按 §6.3.2 的豁免流程处理 |
| 4 | 版本不兼容在 pnpm 之前即被拒 | `dsh-plugin-manager` README：不兼容的 DSH peer 会在 pnpm 运行前使操作失败，不下载任何内容、不运行构建脚本 `[已核实]` | 声明准确的 `engines.dsh` |
| 5 | 豁免不继承 | 豁免保存在 profile 的 `compatibility.json`，把精确 `package-name@version` 映射到精确运行时版本；**插件升级与 DSH 升级都不继承授权** `[已核实]` | 每次升级后重新申请豁免；本机当前**不存在** `compatibility.json`（即无任何豁免） |
| 6 | 卸载不清理数据 | 卸载顺序为「移出 `dsh.profile.bundles` → 卸载运行时贡献 → `pnpm remove`」；恢复只重写两个快照文件，**应用数据保持不动** `[已核实]` | 用户 m00370 决策④：提供「清除全部本地数据」入口 + 二次确认（含数据量与部分失败如实报告）+ `README.md`「数据与隐私」明示；**该限制必须在用户点击确认之前就可见** |
| 7 | 卸载失败可能留下半改依赖 | 诊断日志位于 profile 的 `.plugin-manager/logs` `[已核实]` | 卸载失败时读日志，不盲目重试 |
| 8 | 替换已安装包版本必须重启 | official README：包替换需要重启进程；HMR 不覆盖 | 版本升级 = 重启 |
| 9 | HMR 只覆盖 Host Node 模块图 | 官方明示浏览器 Client 模块图保留独立的浏览器侧加载机制 `[已核实]` | Client 改动需刷新页面（除非另有构建监视器在跑） |
| 10 | Desktop 从 DMG 卷启动 | profile 内十余条依赖 `link:` 到该卷路径 `[已核实]` | 开发/自测时告知用户不要弹出 DMG |
| 11 | 无官方文档站可依赖 | GitHub 仓库 `has_wiki: false`、`has_pages: false`；权威文档实为本机 280+ 份包级 README `[已核实]` | 接口判断一律回读 `$PKG` 下 README 与 `.d.ts`，不查记忆 |
| 12 | **Desktop 下 `$PKG` 在 `app.asar` 内不可读** | 内置插件开发 skill 明确警告 shell/rg/node/pnpm 都读不到 `app.asar` | 接口核验在可读环境下进行；不要假设运行期能读源码 |

---

## 8. 接口稳定性

### 8.1 结论：**没有官方稳定性承诺**

| 检查 | 结果 |
|---|---|
| 在 `dsh` / `dsh-plugin-manager` / `dsh-hmr` 的 README 中搜索 `stability` / `stable api` / `breaking` / `semver` | **无有效命中**（否定证据）`[已核实]` |
| 唯一的兼容性约定 | `engines.dsh`（作者声明的 SemVer 范围，含精确预发布版本） |
| 是否被强制 | ❌ 安装器与加载器**都不校验** `dsh.manifestVersion` 或 `engines.dsh`（官方原文）`[已核实]` |
| 实验性包 | 11 个 `dsh-experimental-*` 包，全部 0.2.0-rc.2；其中含明确声明 "carries no stability promise" `[已核实]` |
| 配置 dump 稳定性 | `renderConfigDump` 的输出**不承诺跨包版本的字节稳定性**；JSON Schema 输出遵循单独的 pre-stable 兼容性规则 `[已核实]` |
| 内核版本本身 | `0.2.0-rc.2` —— **预发布版本**，按 SemVer 语义不构成稳定承诺 |

### 8.2 版本风险应对

| 措施 | 说明 |
|---|---|
| 只使用 §3 表中列出的公开接口 | 不使用 `@internal`（如侧栏的 `_undo`）、不读未文档化的 DOM、不依赖全局对象 |
| 在清单里声明 `engines.dsh` | 声明性，但为 preset 矩阵与人工判断提供依据 |
| 接口集中化 | 所有 DSH 接口调用收敛到 `src/host/routes.ts`、`src/host/domain.ts`、`src/host/fetch/gateway.ts` 与 `src/client/client.js` 顶部，升级时改动面可控 |
| 每次内核升级后跑 §9 矩阵 | 尤其是 A2（右栏注册）、A4（存储）、A6（出网）、A8（路由）四项 |
| 记录每个已用接口的"证据位置" | 即 §3 表格；升级后逐条复核 |

---

## 9. 兼容性测试矩阵

**执行时机**：首次安装后、每次 DSH 内核升级后、每次插件依赖变更后。

| # | 测试项 | 验证的能力 | 方法 | 通过判据 | 当前状态 |
|---|---|---|---|---|---|
| T1 | 插件加载 | A1 | 安装后在 profile 的插件列表中可见并已启用 | 无激活失败、无 bundle 缺失报错 | ✅ **已通过**（2026-10-09，P1-07）。全新 `DSH_HOME=/tmp/apr-clean-home` + `plugin --profile web add <tarball>` （442ms，`dsh.profile.bundles` 末位出现 `dsh-apradar`）→ 启动后插件 5 行日志齐全、`grep -icE "activation|failed|missing bundle"` 为 **0**、`/apradar/ping` 200、客户端半边 `composed=true` 且路径落在**已安装包的 `lib/client.js`**（包内没有 `src/`）|
| T2 | 右栏单页签 | A2 / C1 | 打开右栏，确认只出现一个「AI 产品雷达」页签 | 只有一个页签且能打开 | 未执行 |
| T3 | 页内三视图切换 | C1 | 在页内切 收件箱/关注源/机会池 | 无需切换 DSH 页签，状态正确 | 未执行 |
| T4 | 窄/宽面板与深浅色 | C2 | 右栏拉到 300px 与 0.7 倍宽；切浅色/深色 | 无溢出、无对比度问题 | 未执行 |
| T5 | 存储读写往返 | A4 | 新建来源 → 重载插件 → 数据仍在 | 数据一致、`已保存` 状态正确 | 未执行 |
| T6 | 损坏记录容错 | A5 / V2 | 手工放置一份坏 `per-record` 文档 | 坏记录被移走、其余可读、有日志原因 | 未执行（V2） |
| T7 | 版本不匹配 | V3 | 手工改落盘 `version` | 阻塞式错误 + 可执行恢复步骤，**数据未被删除** | 未执行（V3） |
| T8 | 受管出网 | A6 | 刷新一个 RSS 来源 | 抓取成功；错误码与文案映射正确 | 未执行 |
| T9 | 出网纪律（必要性断言） | A6 / N9 | 跑 `test/no-native-fetch.test.ts`（G-NET-4） | 阻断 `globalThis.fetch`/`XMLHttpRequest` 时流程失败，说明未走这两条；**此项通过不等于"无法绕过"** | 未执行（V10） |
| T9b | 出网纪律（**充分性**闸门） | A6 / N9 | 跑 `test/gate-scan.mjs`：G-NET-2 静态 import 正白名单 + G-NET-3 动态加载形态扫描 | 全绿；**并用一个故意违规的样例文件确认扫描器会失败**（证明闸门不是空转） | 未执行 |
| T10 | SSRF 防护 | A6 | 添加 `http://127.0.0.1:...` 与 `http://10.0.0.1/` 来源 | 返回 `WEB_BLOCKED_URL` + 可读文案；**仅限受控来源类型下验证，不得据此宣称"完整 SSRF 防护"** | 未执行 |
| T11 | 协议限制 | A6 | 添加 `file:///etc/passwd` 与内嵌凭据 URL | 返回 `WEB_INVALID_URL` | 未执行 |
| T12 | 体积与超时 | A6 | 抓一个超大页面 | `truncated` 标记出现，UI 明示截断 | 未执行 |
| T13 | RSS/Atom 解析 | A7 | 用 §9.2 fixture 跑解析测试 | **核心 C1–C7 100% 通过（硬门槛，一项失败即不通过）**；参考 fixture 通过率单独报告，不影响结论；畸形输入给结构化错误 | 未执行 |
| T14 | GitHub Releases | A7 / V5 | 对 1 个公开仓库连续刷新 3 次 | 首次建基线不产生变化；后续产生正确变化；状态码正常 | 未执行（V5） |
| T15 | 去重幂等 | A4 | 同内容连续刷新 3 次 | 条目数不增长 | 未执行 |
| T16 | 路由契约 | A8 | 逐端点测入参校验与错误码 | 一律 `ok:false` 且不抛异常；字段级写权限生效 | ✅ **已通过**（2026-10-09）。`test/contract.test.mjs` **7 项**：**21/21 条路由全覆盖**（表与 `ROUTES` 双向比对，实测「故意删掉一条覆盖即失败」）、未知路径 404 / 方法不符 405 / 非回环 403 都是信封、三条 PATCH 的字段级写权限都给出 `FIELD_NOT_WRITABLE` + `detail.fields` + `detail.allowed`、Markdown 导出走原始载体且 `body === null`。<br>**2026-10-10 复跑：22/22 条**（P0 详情页补齐新增 `GET /opportunities/:id`）。契约表同步补入 `GET /opportunities/opp_nope → 404 NOT_FOUND`；**这个双向比对闸门真的会挡住漏补** —— 新路由加进 `ROUTES` 而没进契约表时 `test/contract.test.mjs` 直接失败，不是形式检查 |
| T17 | **Desktop 路由可达性（⛔ 前置闸门）** | C7 / V1 | 按 P0-00 Spike：在 **Desktop 与 Web 两个 profile** 下，从 Client 调用插件路由 | 两个 profile 均返回 200 | ✅ **已通过**（2026-10-09）。Desktop：真实桌面宿主渲染进程内 `/apradar/state` 200；隔离 Web Profile：六项往返判定全 true。**限制**：Tauri 自己的 WKWebView 无 CDP 端点，Desktop 证据来自同一宿主同页面源的真实 Chromium 渲染进程。详见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.1/§6.2/§6.4 |
| T17b | **Spike 异常态** | C7 / V1 | 调用 `/boom` 与一个非 JSON 响应 | 异常可区分、界面不崩溃、失败态文案明确 | ✅ **已通过**。500+错误码 / 200 非 JSON / 200 空体 / 404 / 超时**五项判定全 true**；桌面面板点「测试错误响应」显示 `HTTP 500 · 服务端返回错误（apradar/boom）` 且 `pageErrors: []` |
| T18 | 生命周期 | A9 / A10 | Host 模块热重载；Client 改动后刷新页面 | 数据不丢；Host 重载后句柄重开成功 | ✅ **已通过**（2026-10-09）。真实 Desktop 宿主经历数十次 HMR 重载，数据全程不丢（`openCount` 持续递增、`counts` 恒定）。**过程中抓到并修掉一个真实泄漏**：释放钩子注册在 `await` 之后 → 旧实例的 in-flight 打开落在已释放的 fiber 上 → 域句柄永久泄漏 → 新实例 `already-open`、整个存储不可用。修法为「钩子前置 + `disposed` 自查」并加「`already-open` 自愈（关掉遗留句柄后重试一次）」。**实测无需重启即恢复**：`ok:false → true`、`openCount 98 → 101`、`counts` 逐项还原为 `{sources:5,snapshots:29,changes:41,opportunities:2}`。详见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.13 |
| T19 | 卸载与数据保留 | N10 | 卸载插件 → 查 `$DSH_HOME/storages/` | 数据仍在；重新安装后可读 | ⚠️ **部分通过**。在隔离 profile 上实测 `plugin --profile web remove`：`dependencies` 整段消失、`dsh.profile.bundles` 复原、**重启后路由 404 且响应体为空**、首页不再注入客户端脚本 → 卸载清理成立；**但 `node_modules/<pkg>` 软链会残留**。数据保留侧：DSH 不清理 `storages/`（依据见 §7-6），正式插件的真实文件已落盘 | 未执行（完整往返） |
| T20 | 显式清除数据 | N10 | 调用 purge 接口（含二次确认路径与部分失败路径） | 二次确认文案含数据量与「卸载不会自动删除」；部分失败如实报告「已删除 X / 共 Y」；可重入；数据被清除且 UI 状态一致 | 未执行 |
| T21 | 升核重建 | §7-1/2 | 模拟内核升级 | 记录重建步骤可执行 | 未执行 |
| T22 | 依赖面收敛 | §6.3.1 / §6.1 | 全新 profile 安装 | 零第三方依赖；安装未触发供应链闸门 | ✅ **已通过**。`plugin --profile web add` **366ms、exit 0、零下载**；`plugin --profile tauri add` **5.9s、零下载**（仅 `Added 1 entry to minimumReleaseAgeExclude: billion-context@0.1.189`，该条目由 pnpm 自动追加，非本插件声明）。**插件包 `dependencies` 为空**。**P1-07 复核（打包产物）**：`npm pack` 出的 tarball 仅 33 个文件（`lib/**` + `README.md` + `cordis.patch.yml` + `package.json`），装进全新 profile 后 `package.json` 的 `dependencies`/`optionalDependencies`/`bundledDependencies` 全为 `undefined`，安装输出 `Packages: +1`（只加本包，无任何第三方下载）|
| T23 | **列表查询契约**（用户决策①要求"不能只靠单条 put/get 证明列表查询可行"） | A4 / A5 | 跑列表查询契约 fixture（C7）：空表 / 单条 / 恰好 limit / limit+1 / offset 越界 / limit 钳制 / 每个 sort 枚举值 / 过滤后为空 / 大小写与中文关键词 | 逐项符合 §5.1.1 契约；`total` 与 `items` 取自同一快照；路由层未直接遍历表 | 未执行 |
| T24 | **写入失败恢复与索引重建** | A4 / A5 | 注入单次写入失败、跨记录部分失败、以及一次索引不一致 | 内存态回滚且不显示「已保存」；来源状态 `ok` + `partialWrite:true` + 失败计数；`reconcile()` 判据 `index.tableSize === table.size` 且键集合相等，失败时降级全表扫描 | 未执行 |

### 9.1 阻塞项（未通过前不应进入实现收尾）

| 项 | 阻塞内容 | 阻塞范围 |
|---|---|---|
| ~~**T17 / V1**~~ | ✅ **已解除**（2026-10-09）。Desktop 与隔离 Web Profile 双向实测均通过 → **Host→Client 同源 HTTP 方案维持不变**，无需改用 typert RPC，`SDD.md` §6.1 无需改写、V4 不升为 P0 | **P0-02 / P0-10 / P0-11 / P0-12 / P0-13 已解除阻塞**，可开工 |
| **T13 / §6.3.1** | 核心 fixture C1–C7 未 100% 通过时，P0-06 不通过验收；若核心已 100% 但真实来源覆盖面不足，才考虑启动 §6.3.2 的依赖引入流程 | 阻塞 P0-06 验收；决定 P1-08 是否启动（门槛已由"5% 失败率"改为"核心 100%"） |
| **V7 / V8 / R1（残余风险）** | `.local` 是否被拒、是否存在 OS 级 egress 拦截、代理路径下的连接固定，三项均未实测 | 阻塞 **P0-18（静态 HTML，SSRF 面最大）** 的排期；在有结论之前，任何文档/UI/对外说明均不得出现「具备完整 SSRF 防护」这类表述 |
| **V10** | 静态闸门（G-NET-2/G-NET-3）能否覆盖 `process.getBuiltinModule('http')`、`createRequire(import.meta.url)('node:http')`、动态 `import('node:http')` 等运行期绕过形态 | **不阻塞开工**，只影响 G-NET 闸门完整性声明：结论出来前，§8.1 只能声称"已阻断已枚举的形态"，不得声称"无法绕过" |
