# MVP-BACKLOG — AI 产品雷达（AI Product Radar）

> 第一版实施待办 · P0 必需 / P1 增强 / P2 探索
> 配套文档：[PRD.md](PRD.md)、[SDD.md](SDD.md)、[COMPATIBILITY.md](COMPATIBILITY.md)

**字段说明**
- **用户价值**：这项交付对用户意味着什么（不是技术描述）。
- **依赖**：前置项（其它编号）或外部条件。
- **验收标准**：可判定的完成条件。
- **测试条件**：怎么测；引用 [COMPATIBILITY.md](COMPATIBILITY.md) §9 的 `T*` 编号。`L1`–`L4` 指 [SDD.md](SDD.md) §9.1 的测试层。

---

## P0 · 第一版必需

> P0 的边界：**受控来源（GitHub Releases / Atom + 预置官方来源模板）+ RSS / Atom，手动刷新、快照、去重、变化检测、原文查看、标记与机会池。** 静态 HTML 与任意 URL 来源为**有条件支持**。**不含**任何模型调用、定时任务、第三方运行时依赖（**实测后已收紧为「零运行时依赖」**，见下）。

### 实现进度（2026-10-09，P0 全量落地）

| 项 | 状态 | 已完成 | 仍未做 |
|---|---|---|---|
| **P0-00** 技术验证 Spike | ✅ **完成** | Q1–Q4 在 Desktop 与隔离 Web Profile 双向通过；异常态五项判定全 true；卸载清理（重启后）通过 | — |
| **P0-01** 插件骨架与清单 | ✅ **完成** | `package.json`（`dsh.bundle.patch` / `dsh.client` / `exports` / `engines.node >= 22.19`）、`cordis.patch.yml`、Host 入口（`inject(['webServer'])` + `apply` + `ctx.effect` 注销）、Client bundle（`__ModuleLoader__.load` + 仅 `require('react')`，无 JSX、无构建步骤）、`README.md`、**测试套件随 P1 增长至 323 项 `node --test` 全通过**（P0 完成时为 236 项）、装入真实 `tauri` Profile 且宿主 HMR 免重启生效 | —（`engines.dsh` 与 Client 的 npm 发布形态已由 **P1-07** 补齐：`engines.dsh >= 0.2.0-rc.1`、`npm run build` 组装 `lib/` 运行树，`npm pack` 出 33 个文件、无 `src/`） |
| **P0-02** 右栏三页签 + 三视图外壳 | ✅ **完成** | **0.1.1（2026-10-10）起为三个独立右栏页签**：「变化」（`id: dsh-apradar:inbox`、`kind: apradar:inbox`）/「关注源」（`…:sources`）/「机会池」（`…:opps`），各自注册正文与标题席位，可分别开关与并排；跨视图跳转 = 打开另一个页签并带上记录 id。0.1.0 的形态是单页签（`id: dsh-apradar:main`、`kind: apradar`）+ 页内分段控件，**真实宿主实测：面板只在右栏（x 793..1440），主区无面板**（该实测属 0.1.0） | 三页签形态**尚未在真实宿主上跑过**（只过了 336 项离线测试）；会话头部入口按钮只打开「变化」页签 |
| **P0-03** 持久化：4 个 domain | ✅ **完成** | 4 个 domain 真实落盘（`$DSH_HOME/storages/ai_product_radar_sources.json` 等）；`openCount` 1→2→…→46 **跨进程/跨重启递增**、`firstOpenedAt` 保留；`ctx.effect` 释放里 `close()`；`ctx.get()` 读服务 + 「永不抛出」纪律；无 zod（改为零依赖的数据形状字面量 spec） | `backup-and-skip`（V2）与 `version-mismatch`（V3）只有单测覆盖，未在真实畸形文件上实测 |
| **P0-04** 受管出网闸门 | ✅ **完成** | `src/host/fetch/gateway.js`（`resolveService()` 走 `ctx.get`、`normalizeFetchResult()`、`createFakeGateway()`）；`src/host/fetch/url.js`（协议白名单、拒凭据、拒 localhost/私有网段/IPv6 回环与 v4-mapped、`MAX_URL_LENGTH=2048`）；**G-NET-4 测试 5/5**（完整刷新只走 `ctx.web.fetch`、服务不可用时如实失败且绝不回落原生 fetch、透传取消信号、缺字段给安全默认） | 未声称「完整 SSRF 防护」—— 真正的防线在 DSH 抓取层，本插件只做字面量快速失败 |
| **P0-05** 适配器框架 + GitHub Releases | ✅ **完成** | `defineAdapter` 校验（`buildRequest` / `buildRequests` / `parse` / `normalizeConfig`）；**双端点**：首选 `api.github.com/repos/<o>/<r>/releases?per_page=10`，备用 `github.com/<o>/<r>/releases.atom`；`resolveRequests()` 按优先级返回候选；按内容嗅探（首个非空白字符 `[`/`{` → JSON，否则 Atom）；3 条预置模板 | — |
| **P0-06** RSS / Atom 适配器 | ✅ **完成** | 零依赖 XML 解析器（`src/host/parse/xml.js`）＋实体解码（`entities.js`）＋HTML 转文本（`html-text.js`）；**4 个真实 Feed 端到端抓通**（blog.google 20 条 / techcrunch 20 条 / theverge 10 条 / simonwillison 30 条，后者 89.8 KB 贴宿主上限） | — |
| **P0-07** 规范化 / 指纹 / 去重 | ✅ **完成** | `normalize.js`（含行首空白规则）＋`fingerprint.js`；**真实内容幂等性实测通过**：同一上游连续两次刷新 `newChanges: 0` | — |
| **P0-08** 差异检测与变化记录生成 | ✅ **完成** | `diff.js` + `buildChanges()`；**真实差异实测**：把来源配置切到另一个真实 Feed → `newChanges: 20`，记录含真实 `title` / `itemUrl` / `diffSummary` / `excerpt` | `added` 非空时 `removed` 不记录（SDD §4.4 现状，**待人工确认是否要改**） |
| **P0-09** Host ⇄ Client 通信 | ✅ **完成** | `ROUTE_PREFIX = '/apradar'` + `webServer.register({kind:'prefix'})`；**端点全部实现**（P0 时 18 条，P1-01/02/05 增至 **21 条**），路由表测试断言数量与唯一性；回环校验、方法与 404 分支、`no-store`、`nosniff`、响应体不含本机绝对路径；客户端 5 种 outcome；**写路径全部走字段白名单**（含创建路径，防止拼错字段变成"假保存成功"） | — |
| **P0-10** 变化收件箱 | ✅ **完成** | 状态筛选 + 搜索 + 「刷新全部来源」+ 逐来源 `RefreshReport`；真实宿主实测渲染 30 条真实变化 | — |
| **P0-11** 变化详情 | ✅ **完成** | 事实 / 差异 / 前后快照 / 备注 / 入池；`GET /changes/:id` 返回前后快照 | — |
| **P0-12** 关注源管理 | ✅ **完成** | 按 `meta.adapters[].fields` 动态表单、`/sources/test`（抓一次但不写存储）、预置模板（**只填表单，不自动写入**）、启停 / 立即刷新 / 测试抓取 / 删除 | — |
| **P0-13** 产品机会池 | ✅ **完成** | 增删改 + 状态筛选；**一键沉淀会带 `changeId`**，服务端据此回写 `opportunityId`，两个方向都不再断链 | — |
| **P0-14** 刷新编排、上限控制与状态反馈 | ✅ **完成** | `mapWithConcurrency`（默认 2）、`LIMITS_SNAPSHOT` 全量上限、逐来源结果与汇总、部分失败不影响其余来源 | 定时刷新属 P1-01 |
| **P0-15** 持久化状态与显式清除 | ✅ **完成** | `GET /state` 暴露 `openCount`/`firstOpenedAt`/`lastOpenedAt`/`lastRefreshAt`/`specMode`/`reason`；`POST /maintenance/purge` 需要显式 `confirm` | — |
| **P0-16** 安全边界与测试闸门 | ✅ **完成** | G-NET 全闸门 + `test/gate-scan.mjs` 静态扫描（禁 `node:` 内建、禁原生 `fetch`、禁第三方依赖） | — |
| **P0-17** 离线测试套件与 fixture | ✅ **完成** | **测试套件随 P1 增长至 323 项 `node --test` 全通过**（P0 完成时为 236 项）；`test/fixtures/feeds/` 离线 fixture；**测试绝不真出网**（内存替身） | — |
| **P0-18** 有条件支持的静态 HTML 来源 | ✅ **完成** | `html-static.js`（含 `assertBodyNotTruncated`） | 无真实页面端到端实测（真实页面普遍超宿主上限，会被明确拒绝） |

> 进度行的判据一律是**已在本机运行时实测**（见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.4 / §6.5 / §6.6），不是代码审查结论。
>
> **一个必须记住的教训**：注册类缺陷只有目标席位真正挂载时才暴露（会话头部席位只在会话里挂载），而容量类缺陷只有真出网才暴露。凡涉及会话内席位或真实网络的验收，探针必须先打开一个真实会话 / 真的抓一次。

### P0-00 技术验证 Spike（**前置闸门，阻塞全部 UI 工作**）—— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 在投入界面开发之前，先确认「Client 能不能安全地拿到 Host 的数据」这个地基是实的，避免把 UI 建在一个没验证的通信假设上。 |
| **交付** | 一个**独立目录**下的最小验证插件（`spike/apradar-spike/`，**不是产品代码、不是 Demo、不进入 `src/`**）：①Host 端 `ctx.inject(['webServer'], …)` + `webServer.register({kind:'prefix', path:'/apradar-spike', handler})`，提供 `/ping`、`/boom`、`/not-json`、`/nope`、`/hang`；②Client 端手写 bundle，注册一个右栏页签与入口按钮，页内探针按钮把结果/错误码渲染出来。 |
| **依赖** | 无（与 P0-01 并行，但**先于**所有 UI 项） |
| **验收标准** | 1) **Desktop profile** 与 **Web profile** 下右栏都能出现 Spike 页签；2) 正常请求同源可达并拿到 JSON；3) 异常请求能拿到错误码且 UI 不崩溃；4) 网络失败/超时时 UI 有明确的失败态；5) ~~Desktop 下若不可达 → 转入 Typert RPC 验证~~（**未触发**，Desktop 可达）；6) **全程未修改任何现有插件（含 Knit）的任何文件**。 |
| **实测结果** | ✅ **全部通过**。Desktop：真实桌面宿主（PID 84103）渲染进程内六项判定全 true、右栏面板真实渲染（截图已目视确认）、`pageErrors: []`。隔离 Web Profile：同样六项全 true。**限制**：Tauri 自己的 WKWebView 无 CDP 端点，Desktop 证据来自同一宿主同页面源的真实 Chromium 渲染进程。证据：[TECH-SPIKE.md](TECH-SPIKE.md) §6.1 / §6.2 / §6.2b |
| **测试条件** | V1、V6；T1、T2、T17、T17b → 均已执行通过 |
| **依据** | [SDD.md](SDD.md) §6.1 前置闸门、§9.3 V1/V6；[COMPATIBILITY.md](COMPATIBILITY.md) §9.1 T17；[TECH-SPIKE.md](TECH-SPIKE.md) |

### P0-01 插件骨架与清单 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 插件能被 DSH 正确加载，这是其它一切的前提。 |
| **交付** | `package.json`（`dsh.bundle.patch`、`dsh.client`（`platform:'web'`、`inject:['@deepseek-ai/dsh-client-ui-sidebar-right']`）、`exports['.']`/`exports['./client']`、`engines.node>=22.19`、`engines.dsh`）、`cordis.patch.yml`、Host 插件入口（`inject` + `apply`）、Client bundle 骨架（`window.__ModuleLoader__.load({id, factory})`，工厂返回 `exports.apply` + `exports.inject`）。 |
| **依赖** | 无 |
| **验收标准** | 1) 安装后插件在 profile 中可见且启用；2) 无 bundle 缺失/激活失败报错；3) 客户端 bundle 加载期仅 `require` 平台基线模块。 |
| **测试条件** | T1、V6；L4 → **已执行通过**（`test/manifest.test.mjs`） |
| **依据** | [COMPATIBILITY.md](COMPATIBILITY.md) §3.1；[SDD.md](SDD.md) §10.1 |

### P0-02 右栏三页签 + 三视图外壳 —— ✅ 已完成

> **0.1.1 变更（2026-10-10）**：用户要求把三个视图放到右栏的**三个独立页签**上（原话「变化一个界面、关注人一个界面、机会池一个界面」，
> 见 [PRD.md](PRD.md) §5.1）。0.1.0 的「单页签 + 页内分段控件」形态就此作废 —— **不是**被新条目取代，而是同一条 P0-02 的实现换了。

| 项 | 内容 |
|---|---|
| **用户价值** | 三个视图可以同时并排开着：看变化详情时点「打开机会详情」，机会池是**另一个页签**，变化那一页原样留在旁边（筛选、搜索、滚动位置都不丢）。页内切换做不到这一点。 |
| **交付** | `for (const pane of PANES)` 三次 `sidebarRightTabs.register({id: pane.id, kind: pane.kind, priority:'extension', title: PANE_TITLES[pane.key], guide:[…]})`；每次配一对 `ctx.slots.register({name:'sidebar.right.pane.tab', key: pane.id}, PANE_BODIES[pane.key])` 与 `…pane.tab.title`；三份正文共用一个 `RadarPane({paneKey, useTabInfo})`，各持一片 `slice` 状态；跨视图跳转走 `tab.actions.openTab(kind, {params:{detailId}, revealIfOpened:true})`；刷新按钮 + 刷新状态行 + 详情态返回。**不使用标题栏/工具栏席位。** |
| **依赖** | P0-01 |
| **验收标准** | 1) 右栏出现三个页签（变化 / 关注源 / 机会池），可分别开关、可并排；2) 每个页签只承载自己那一个视图，页内**没有**分段控件；3) 详情态为内容区替换且有返回（回到**本页签**的列表）；4) 变化详情里的「打开机会详情 ›」会打开机会池页签并用真实 id 定位到那一条，且变化页签内容不被替换；5) 300px 窄面板下无横向溢出；6) 浅色/深色均可读。 |
| **测试条件** | T2、T3、T4；L4。（`test/client.test.mjs`「三个页签真的各自注册」+「三个页签各自的正文都能渲染」已通过；`test/detail.test.mjs` ⑦ 覆盖双向跨页签跳转） |
| **依据** | [PRD.md](PRD.md) §5.1、§6.1；[SDD.md](SDD.md) §6.4；[COMPATIBILITY.md](COMPATIBILITY.md) §3.2、§4.4 N4/N5 |

### P0-03 持久化：4 个 domain 与句柄生命周期 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 关注源、快照、变化、机会在重开插件后仍然存在。 |
| **交付** | `ai_product_radar_sources`（`single`，v1）、`ai_product_radar_snapshots`（`per-record` + `invalidRecords:'backup-and-skip'`，v1）、`ai_product_radar_changes`（`per-record` + `backup-and-skip`，v1）、`ai_product_radar_opportunities`（`single`，v1）。**schema 采用插件自带的极小校验器（零依赖），spec 用数据形状字面量声明，并在运行时动态探测官方 helper 作为「最佳努力」** —— 原「显式声明 zod」的做法已实测为不可行（`link:` 插件解析不到该包），详见 [SDD.md](SDD.md) §5.0。 |
| **依赖** | P0-01 |
| **验收标准** | 1) 写入后重开 domain 数据一致 → **已通过**（跨进程 `openCount` 1→2、`firstOpenedAt` 不变）；2) `version-mismatch` 时抛阻塞式错误且**不删数据**（V3，未实测）；3) `snapshots`/`changes` 的单条坏记录被移走并跳过，`sources`/`opportunities` 的坏记录使 `open` 以 `invalid-record` 拒绝并指出表与键（V2，未实测）；4) 重复 open 不会 `already-open`（未实测）；5) ~~schema 由插件自己声明的 zod 副本构造~~ → **改为**：`open()` 在零依赖 schema 下校验通过，且存储失败时 `openRadarStore` 返回失败句柄而非抛出（**已通过**） |
| **测试条件** | T5、T6(V2)、T7(V3)；L2 |
| **依据** | [SDD.md](SDD.md) §5.0–§5.7；[COMPATIBILITY.md](COMPATIBILITY.md) §3.3、§4.1 A4/A5 |

### P0-04 受管出网闸门（G-NET 的出口侧）—— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 抓取行为被约束在安全边界内，不会去访问内网或本地文件。 |
| **交付** | `src/host/fetch/gateway.ts` 作为**唯一**出网点，只调用 `ctx.web.fetch(url)`；把 DSH 的稳定错误码映射为统一内部错误；其它 Host 模块不得 import 任何网络模块；**gateway 只接受适配器传入的已构造 URL，不接受来自 Client 的任意 URL 参数**。 |
| **依赖** | P0-01 |
| **验收标准** | 1) **G-NET-2 静态白名单扫描**通过：`src/host/**` 的 import 说明符只落在白名单（相对路径 + `@deepseek-ai/cordis`；**已无 zod**）内，白名单外任一说明符即失败（**正向白名单，不是黑名单**）；2) **G-NET-3 动态加载扫描**通过：`src/host/fetch/**` 之外无 `import(`、`createRequire`、`process.getBuiltinModule`、`process.binding`、`require(`、`node:` 前缀；3) 8 个 DSH 错误码全部有中文文案映射；4) **门禁不得宣称「无法绕过」**——文档与注释必须保留 §8.1 的诚实声明。 |
| **测试条件** | T9、T10、T11、V10；L3。 |
| **依据** | [SDD.md](SDD.md) §8.1、§8.1.1 G-NET-1…G-NET-5、§8.1.2；[COMPATIBILITY.md](COMPATIBILITY.md) §6.2 |

> **本轮收紧点**：P0-04 的原验收标准把「阻断 `globalThis.fetch` 后流程仍跑通」当作主要证据。按本轮要求，它被明确降级为 **G-NET-4 的必要条件**（只证明「我们没走那条路」），**不能证明网络请求无法绕过**。阻断项改为 G-NET-2/G-NET-3 的**静态源码扫描**。详见 [SDD.md](SDD.md) §8.1。

### P0-05 适配器框架 + GitHub Releases / Atom 适配器 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 能追踪 DSH 官方仓库、自己的项目和竞品仓库的发布。 |
| **交付** | `SourceAdapter` 契约（**不接收 `ctx`**，因此不可能自己出网）；`github_releases` 适配器：`owner`/`repo` 白名单校验、**由代码拼接** `releases.atom`（不接受用户填 URL）、解析 `<entry>` 列表、提取 tag 与正文；适配器注册表 + **预置官方来源模板**（URL 为代码内常量）。 |
| **依赖** | P0-03、P0-04 |
| **验收标准** | 1) 非法 `owner`/`repo` 被拒并给出可读原因；2) 对 fixture 解析出正确的条目数、tag、正文纯文本；3) 仓库不存在（404）返回可读失败原因而非空列表；4) 真实仓库连续刷新 3 次，第 1 次建基线不产生变化，后续产生正确变化（V5）；5) **该适配器是 P0 唯一「完全受控」的来源类型**（输入不是 URL，而是 `owner`/`repo`）。 |
| **测试条件** | T13、T14(V5)；L1。 |
| **依据** | [SDD.md](SDD.md) §3.2 范围声明、§3.2.1、§8.1.2；[PRD.md](PRD.md) §6.3、§8.1 |

### P0-06 RSS / Atom 适配器（零依赖解析器）—— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 有标准 Feed 的官方公告、博客、Changelog 都能被追踪。 |
| **交付** | 零依赖严格子集解析器（RSS 2.0 + Atom 1.0 + `releases.atom`）：CDATA、命名空间前缀、命名/数字实体、自闭合标签、BOM；**不解析 DTD 与外部实体**；`rss_atom` 适配器：`feedUrl` 校验（http/https、≤ 2048）、条目 id 优先 `guid`/`id`、时间解析 RFC 822 / RFC 3339、正文优先级 `content:encoded` > `description`/`summary`；**自定义 `feedUrl` 在 UI 上标注为「有条件支持」**（见 [SDD.md](SDD.md) §8.1.2）。 |
| **依赖** | P0-04 |
| **验收标准** | 1) **核心 fixture（[SDD.md](SDD.md) §9.2.1 的 C1–C5）100% 通过；有一项失败即本项验收不通过**；2) 畸形输入返回结构化错误而非崩溃或静默空结果；3) 空 Feed（合法零条目）被识别为合法结果；4) 不引入任何第三方依赖；5) UI 明确标注自定义 URL 属于有条件支持，且不宣称完整 SSRF 防护。 |
| **测试条件** | T13；L1。 |
| **依据** | [SDD.md](SDD.md) §3.2.2、§9.2.3、§10.2；[COMPATIBILITY.md](COMPATIBILITY.md) §6.3 |

> **本轮收紧点**：原验收为「7 类 fixture 全部通过」。现按用户要求拆分为**核心 fixture（100% 阻断）**与**参考 fixture（非阻断，仅用于评估额外真实来源兼容性）**，并明确：**参考 fixture 的通过率不能替代核心验收**。见 [SDD.md](SDD.md) §9.2.1–§9.2.3。

### P0-07 规范化 / 指纹 / 去重 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 「变了什么」是可信的：不会因为无关渲染差异产生噪声，也不会重复冒出同一条。 |
| **交付** | 文本规范化流水线（剥离 `script`/`style`/`noscript`、标签剥离保块级换行、实体解码、空白归一、控制字符剥离、100,000 字符裁剪）；`itemFingerprint` / `contentFingerprint` / `dedupeKey`；URL 规范化（小写 host、去 fragment、去 `utm_*` 等跟踪参数、去尾斜杠）。 |
| **依赖** | P0-03 |
| **验收标准** | 1) 同一输入产出同一输出（无时间/随机/locale 依赖）；2) 同内容连续刷新 3 次条目数不增长；3) 跟踪参数变化不产生新条目；4) 规范化结果超过上限时标记 `truncated`。 |
| **测试条件** | T15；L1。 |
| **依据** | [SDD.md](SDD.md) §4.1、§4.3 |

### P0-08 差异检测与变化记录生成 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 看到的是「相对上一版本新增/删除/修改了什么」，而不是一篇新闻摘要。 |
| **交付** | 条目级差异（`added`/`removed`/`modified` 基于 `itemId` + `itemFingerprint`）；文本级差异（行级公共前后缀裁剪）；`change` 记录写入规则（首次抓取不产生变化、抓取失败不产生变化、仅 removed 合并为一条汇总、全空则不产生）。 |
| **依赖** | P0-07 |
| **验收标准** | 1) 首次抓取产出 `baseline: true` 且不产生 change；2) 新增条目产生一条 `kind:'added'`；3) 内容修改产生 `kind:'modified'`；4) 抓取失败不写 snapshot、不写 change；5) 截断内容产生的变化带 `truncated: true`。 |
| **测试条件** | T14；L1。 |
| **依据** | [SDD.md](SDD.md) §4.4；[PRD.md](PRD.md) §7.3 |

### P0-09 Host ⇄ Client 通信（`/apradar/*` 路由）—— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 界面能拿到数据并写回用户操作。 |
| **交付** | `ctx.webServer.register({kind:'prefix', path:'/apradar', handler})`（前缀为模块常量，释放函数里 `unregister()`）；统一 JSON 响应 `{ok:true,data}` / `{ok:false,error:{code,message}}`；**handler 内部捕获全部异常**（不依赖框架 400 兜底）；端点清单见 [SDD.md](SDD.md) §6.1。 |
| **依赖** | P0-03 |
| **验收标准** | 1) 每个端点对非法入参返回 `ok:false` 且不抛异常（**最小路径已通过**：非回环 403、非 GET 405、未知路径 404 且三者 code 各不相同）；2) 单响应 ≤ 256 KB（未做）；3) **接口不接受任何外部 URL 参数**（未做，因尚未有 refresh/test 端点）；4) 插件卸载后路由被移除（**已在隔离 profile 实测通过**：重启后路由 404 且响应体为空；**注意 `node_modules` 软链会残留**）。 |
| **测试条件** | T16（部分）、T17(V1) → **已通过**、T19 → 部分通过；L4、L5。 |
| **依据** | [SDD.md](SDD.md) §6.1–§6.2；[COMPATIBILITY.md](COMPATIBILITY.md) §3.4、§4.2 C7；[TECH-SPIKE.md](TECH-SPIKE.md) §6.4 |

### P0-10 变化收件箱 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 一眼看完「上次之后发生了什么」，并快速分流。 |
| **交付** | 列表（产品·来源类型 / 发现时间 / 标题 / 一行差异摘要 / 官方发布日期）；筛选（产品、来源类型、处理状态多选）；关键词搜索（标题+摘要+来源名，纯本地过滤）；排序（发现时间/发布时间，升降序，默认发现时间倒序）；标记（未处理/已查看/已忽略/已加入机会池）；**不展示相关度分数、不展示图表**。 |
| **依赖** | P0-09、P0-08 |
| **验收标准** | 1) 四种筛选可组合；2) 搜索输入即过滤且不发网络请求；3) 排序切换正确；4) 打开详情后条目自动变「已查看」；5) 刷新期间列表保持可读（不整体替换为加载态）。 |
| **测试条件** | T3、T4；L4。 |
| **依据** | [PRD.md](PRD.md) §6.2 |

### P0-11 变化详情（事实 / 推测分区）—— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 能分清哪句是官方说的，哪句是我自己猜的。 |
| **交付** | A 区事实字段（产品名、原始来源链接、官方发布日期或`未获取`、发现时间、原文标题、原文摘录+截断说明、与上一快照差异、来源获取状态、当前/上一版本标识或`未识别`）；B 区用户处理（状态、备注、关联机会）；C 区「我的判断（未经来源证实）」；D 区抓取元信息（时间、HTTP 状态、是否截断、字符数）。 |
| **依赖** | P0-10 |
| **验收标准** | 1) 首次抓取显示「首次抓取，无对比基线」；2) 抓取失败时事实区显示失败原因且**不显示差异**；3) 截断时明示；4) 事实区与推测区视觉/文案不可混淆；5) 来源链接可点开且为抓取结果里的 `url`（`WebFetchResult.url`，是重定向后的最终地址）。 |
| **测试条件** | T8、T12；L4。 |
| **依据** | [PRD.md](PRD.md) §6.4、§7.3 |

### P0-12 关注源管理 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 能自己决定盯哪些来源，并在来源坏掉时知道为什么。 |
| **交付** | 来源列表（类型徽标、名称、URL、最后成功检查时间、状态与失败原因）；增/改/启停/删（删除二次确认并明示影响）；手动测试（**可访问性与可解析性两个独立结论**）；少量**已核实**的预置模板；失败原因用可读分类（不暴露堆栈）。 |
| **依赖** | P0-09、P0-05、P0-06 |
| **验收标准** | 1) 错误 URL 返回具体失败原因；2) 失败来源**不产生任何虚构数据、不显示「无更新」**；3) 停用后不参与刷新但历史记录保留；4) 模板填入后 URL 可被正确校验。 |
| **测试条件** | T10、T11、T8；L4。 |
| **依据** | [PRD.md](PRD.md) §6.3；[SDD.md](SDD.md) §3.3 |

### P0-13 产品机会池 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 把一条变化变成「我打算验证什么」，并保留证据链。 |
| **交付** | 从变化详情一键转机会（自动关联来源与变化）；可编辑：标题、关联项目、用户判断、待验证问题（多条）、下一步行动、状态（待研究/验证中/已进入规划/不再跟进）；列表+筛选+跳回关联变化。 |
| **依赖** | P0-11、P0-03 |
| **验收标准** | 1) 转机会后原变化状态变「已加入机会池」；2) 机会可跳回对应变化与原始来源；3) **不生成、不修改任何用户项目的版本路线图**；4) 未填字段不影响保存。 |
| **测试条件** | L4、L5。 |
| **依据** | [PRD.md](PRD.md) §6.5 |

### P0-14 刷新编排、上限控制与状态反馈 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 刷新是可控的：不会卡住、不会越跑越大、失败了能看到原因。 |
| **交付** | `POST /apradar/refresh`（整体/指定源）；串行批次 + `FETCH_CONCURRENCY = 2`（DSH 无并发闸门 → 自建）；`limits.ts` 全部上限常量与幂等 `trim()`；`GET /apradar/meta` 暴露 limits 与占用估算；刷新状态行（上次刷新时间、失败来源数）。 |
| **依赖** | P0-04、P0-08 |
| **验收标准** | 1) 刷新失败只更新该来源状态，不改快照与变化；2) 快照数 ≤ 20/源、变化 ≤ 200/源与 ≤ 2000 全局、机会 ≤ 500；3) 只保留最近 2 份完整正文，更旧的截到 2,000 字符；4) 重开后重跑 `trim()` 幂等无副作用。 |
| **测试条件** | T5、T8、T15；L1、L2。 |
| **依据** | [SDD.md](SDD.md) §5.4、§7 |

### P0-15 持久化状态与显式清除数据 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 知道东西到底存下来没有；也能真正删掉；在卸载之前就知道卸载**不会**删数据。 |
| **交付** | ①顶部持久化状态行（`已保存` / `保存中` / `保存失败（原因）`），**只有写入 resolve 后才显示「已保存」**；②`POST /apradar/maintenance/purge` + **二次确认 UI**（确认文案必须写明将删除的数据量：N 个来源 / M 条变化 / K 条机会，并写明**卸载插件不会自动删除这些数据**）；③逐表 best-effort 删除 + **部分失败报告**（「已删除 X / 共 Y，原因 Z」），purge 可重复执行；④`README.md` 的「数据与隐私」小节**明示**：数据存在 `$DSH_HOME/storages/` 下、卸载不清理、如何手动清除；⑤插件「关于/诊断」区同样明示。 |
| **依赖** | P0-03、P0-09 |
| **验收标准** | 1) 写成功前不显示「已保存」；2) 写失败显示具体原因且内存态已回滚（[SDD.md](SDD.md) §5.8.2）；3) purge 有二次确认且确认文案包含数据量与卸载行为说明；4) purge 部分失败时如实报告成功/失败条数，**不假装全部成功**；5) purge 连续执行两次第二次不报错；6) 卸载后重装数据仍在（README 与 UI 均已明示）；7) **上述限制在用户点击确认之前就可见**。 |
| **测试条件** | T5、T19、T20；L2、L4。 |
| **依据** | [PRD.md](PRD.md) §6.6；[SDD.md](SDD.md) §5.8.2、§5.8.6；[COMPATIBILITY.md](COMPATIBILITY.md) §4.4 N10 |

### P0-16 安全边界与测试闸门（G-NET 全闸门 + 信任边界）—— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 插件不会因为抓网页而执行网页里的东西，也不会碰内网。 |
| **交付** | ①`test/gate-scan.mjs`：**静态 import 正白名单扫描（G-NET-2）+ 动态加载形态扫描（G-NET-3）**，作为 CI 阻断项；②`test/no-native-fetch.test.ts`：阻断 `globalThis.fetch`/`XMLHttpRequest` 后跑完整刷新流程（**G-NET-4，仅作为必要条件，不得单独宣称「无法绕过」**）；③字段级写权限（`PATCH /changes/:id` 只能改 `status`/`userNote`，改事实字段返回 `FIELD_NOT_WRITABLE`）；④添加来源时的授权提示文案（含「地址由你提供，本插件不额外提供完整 SSRF 防护」）；⑤残余风险 R1/R2 写入「关于/诊断」与 README；⑥代码注释与 README 中的信任边界声明 + §8.1 的**诚实声明**（本插件的行为约束 ≠ 运行期隔离）。 |
| **依赖** | P0-04、P0-09 |
| **验收标准** | 1) **G-NET-2/G-NET-3 静态扫描全绿，且用一个「故意违规」的样例文件验证扫描器确实会失败**（证明闸门不是空转）；2) 阻断原生 fetch 后流程正常；3) 前端无法改写事实字段；4) HTML 处理**不构建 DOM、不执行脚本**；5) `.local` 与代理不固定连接两项残余风险已在 UI/文档中明示；6) README 中含 §8.1 的诚实声明原文；7) **文档、UI、对外说明中均不出现「具备完整 SSRF 防护」这类表述**。 |
| **测试条件** | T9、T10、T11、T16、V10；L3。 |
| **依据** | [SDD.md](SDD.md) §8.1–§8.4；[COMPATIBILITY.md](COMPATIBILITY.md) §6.2 |

### P0-17 离线测试套件与 fixture —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 回归成本低，升级 DSH 后敢改。 |
| **交付** | [SDD.md](SDD.md) §9.2.1 的**核心 fixture C1–C7**（GitHub Atom / RSS 2.0 / Atom 1.0 / 畸形 Feed / 空 Feed / 损坏存储文档 / 列表查询契约）+ §9.2.2 的**参考 fixture**（静态 Changelog、真实来源样本，单独目录）+ L1–L4 测试；**CI 不出网**（适配器接收注入的 fetch 替身）。 |
| **依赖** | P0-06、P0-08、P0-03、P0-14 |
| **验收标准** | 1) 全部测试离线可跑；2) **核心 fixture 100% 通过（阻断）**；3) 参考 fixture 的通过率单独报告，**不影响核心验收结果**；4) 覆盖解析、规范化、指纹、差异、上限、列表查询契约、存储往返、路由契约、安全闸门；5) fixture 随仓库提交。 |
| **测试条件** | L1–L4 全绿。 |
| **依据** | [SDD.md](SDD.md) §9.1–§9.2.3 |

### P0-18 有条件支持的静态 HTML 来源 —— ✅ 已完成（未做真实页面端到端）

| 项 | 内容 |
|---|---|
| **用户价值** | 没有 Feed 的官方 Changelog 页也能盯，但只在真的能稳定解析时。 |
| **交付** | `html_static` 适配器：标签剥离 + `h1`–`h4` 块切分；结构判据（连续两次抓取结构指纹一致）；不满足时返回 `ADAPTER_STRUCTURE_UNSUPPORTED` 并**拒绝把该来源置为可用**；UI 文案「暂不支持该页面结构」；明确不支持动态渲染/登录态/反爬页面。 |
| **依赖** | P0-07、P0-08 |
| **验收标准** | 1) 结构固定的 Changelog 页可产生变化；2) JS 渲染页明确报不支持，**不注册成功且不返回 0 变化的假成功**；3) 结构指纹变化时来源转为失败状态。 |
| **测试条件** | T13、T8；L1。 |
| **依据** | [SDD.md](SDD.md) §3.2 范围声明、§3.2.3、§8.1.2；[PRD.md](PRD.md) §8.1 |

> **排序约束**：P0-18 是 P0 中**最后一个**开工项。原因：它依赖用户提供的任意 URL，是本产品 SSRF 面最大的一项；在 V7（`.local`）、V8（OS 级 egress）、R1（代理不固定连接）有实测结论之前，不应把它排到关键路径上。UI 上必须标注为「有条件支持」，并复用 P0-16 的授权提示文案。

---

## P1 · 基础验证完成后的增强

> 进入条件：P0 全部验收通过，且 [COMPATIBILITY.md](COMPATIBILITY.md) §9.1 的两个阻塞项（T17/V1 路由可达性、T13 解析器达标）已解决。

### P1 实现进度（2026-10-09）

| 项 | 状态 | 结论 / 证据 |
|---|---|---|
| **P1-01** 单源定时刷新 | ✅ 完成 | 一个 60 秒循环 + `inFlight` + 连续 3 次失败自动停用；**实测自动 tick 抓到真实变化**（`due:1, newChanges:1`） |
| **P1-02** 快照历史查看 | ✅ 完成 | `listSnapshots` / `getSnapshot` + `chainLink()` + 显式 `retention` 字段；真实宿主取到 5496 字符真实正文 |
| **P1-03** 目录索引缓存 | ⏸️ 刻意不做 | 只在出现真实性能问题时才做 |
| **P1-04** 更多来源类型 | ✅ 完成 | 新增 `github_repo` 与 `npm_package`（共 **5 类**、**9 条**预置模板）；先 curl 测可达性与体积再选型；顺带修掉一次 **schema 漂移事故**（曾让整个域不可访问） |
| **P1-05** 机会池导出 Markdown | ✅ 完成 | 事实 / 推测分区 + 证据链 + 不可信内容转义 + 只读；走 `RAW_RESULT` 原始响应出口；`safeInline` 被还原时会真的挂 2 条测试 |
| **P1-06** typert RPC 迁移评估 | ✅ 完成（**结论：不迁移**） | V4 判据现场成立（23 包 / 126 条 local 描述符），但生成器是开发期工具、且客户端面无发现机制 → 保留同源 HTTP；**T16 路由契约 7 项全通过** |
| **P1-07** npm 发布准备 | ✅ 完成 | `npm run build` 组装自洽 `lib/` 运行树；`npm pack` 33 个文件、**无 `src/`**；全新 profile 从 tarball 安装并启动**无需源码**、零依赖；**顺带发现两件事**：①「缺 bundle 时平台完全不报错」→ 改由本插件自己诊断；②「HMR 重载泄漏存储域句柄 → 整个存储不可用」→ 已修 + 自愈（实测无需重启即恢复，数据逐项还原）|
| **P1-08** 第三方 feed 解析库 | ⏸️ 条件触发 | 门槛（核心 fixture 100%）已达到，但零依赖现状良好，暂不引入 |

### P1-01 单源定时刷新 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 不用记得手动点刷新。 |
| **交付** | `src/host/scheduler.js`（**一个 60 秒循环**，不是"每来源一个定时器"）+ 服务层 `selectDueSources()` / `refreshDue()` / `inFlight` 并发闸门 + `PATCH /sources/:id {intervalMinutes}`（夹取 `[15, 1440]`，`0` 表示关闭）+ 连续 3 次失败自动停用（`autoDisabledReason`）+ 客户端「定时刷新」下拉框与自动停用提示。复用 `@deepseek-ai/cordis-plugin-timer` 的 `ctx.interval()`（**释放感知**：HMR 重载时句柄自动清理，不留残留）。 |
| **依赖** | P0-14；DSH 调度能力核验 → **已核实**：`@deepseek-ai/dsh-schedule` **不可用**（它是按会话绑定的**提醒投递**服务，且 README 明确「随发行版交付的 Web 组合不含 `schedule` 行」，必须启用 **experimental** bundle —— 违反"不得依赖 experimental 包"）；`@deepseek-ai/cordis-plugin-timer` **可用**（`dsh-base` 必挂载，实跑 `degraded:false` 证实）。 |
| **验收标准** | 1) 可对单个来源设间隔 ✅；2) 定时与手动刷新互不冲突（同一来源不并发）✅（`inFlight` 集合放在**服务层**，因为手动与定时走的是同一个 `refresh()`，各自维护会出现"两边都以为自己在刷"）；3) 失败达阈值后自动停用并在 UI 提示 ✅。 |
| **测试条件** | 新增定时相关测试 + 并发冲突测试 → **已补**（当时 **239 项全通过**，此后随 P1-02/P1-05 增至 260 项，含 `nextRunAt` 的"不能编造下次时刻"用例与两个数据安全用例）。 |
| **实测结果** | ✅ 定时器真实挂载（`scheduler: {available:true, running:true, degraded:false, tickMs:60000}`）；间隔夹取 `1→15 / 99999→1440 / 0→0 / -5→0 / "45"→45 / "abc"→0`（不报错）；未到期时 `POST /refresh {due:true}` → `due: []`；**23:08:19 与 23:09:19 自动 tick 各一次（`due:0`，当时确实没到期）**；**23:10:20 自动 tick 抓到真实数据：`due:1, succeeded:1, failed:0, newChanges:1`** —— 调度器自己判定 `www.theverge.com` 到期并抓回一条真实变化（总数 30→31），全程无人工触发；客户端「定时刷新」下拉框与「下次大约」在真实宿主渲染正确、且与 `上次检查 + 15 分钟` 一致。证据：[TECH-SPIKE.md](TECH-SPIKE.md) §6.7 |
| **依据** | [PRD.md](PRD.md) §10；[SDD.md](SDD.md) §4.6（调度与并发） |

> **P1-01 顺带修掉的三个真实缺陷**（都是真实宿主实测才暴露的，详见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.7.3）：
> ① `DELETE /sources/:id` **从来没有成功过** —— `store.del()` 用 `table.keys().includes(id)` 判存在，真实 storage-domain 后端的 `keys()` 不返回数组；更糟的是它在删完从属记录之后才抛错，于是每次点击删除都会**无条件删掉该来源的全部快照与变化**再报失败。
> ② **判重比的是过时的 `id`** —— 来源改过地址后，用同一个新地址能再加一个来源（两个来源轮询同一 URL、同一条内容记成两条变化），而原地址反而加不回来。
> ③ **新来源会按键覆盖旧来源** —— 派生 `id` 与一条已脱钩的旧记录撞车时，`store.put` 直接覆盖，那条来源连同它的历史一起消失（真实事故中确实丢了一条来源）。

### P1-02 快照历史查看 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 能看到「上周是什么样」，而不只是「和上次比变了什么」。 |
| **交付** | 服务层 `listSnapshots(sourceId)` / `getSnapshot(id)`（**列表只给摘要、正文按需取**：20 份快照各带 10 万字符就是数兆字节）+ 两条新路由 `GET /apradar/sources/:id/snapshots`、`GET /apradar/snapshots/:id`（路由表 18 → **20**）+ `chainLink()` 差异链（集合差算 `added/removed/modified`，并标 `baseline` / `capped`）+ `retentionOf()` 保留等级 + 客户端来源卡片「历史」按钮与内联时间线（每行可展开正文，正文有 20000 字符查看上限且如实说明裁了多少）。 |
| **依赖** | P0-11、P0-14 ✅ |
| **验收标准** | 1) 可切换查看最近 ≤ 20 份快照 ✅（`MAX_SNAPSHOT_HISTORY = MAX_SNAPSHOTS_PER_SOURCE = 20`，注释写明"保留多少就能看多少，界面不出现'存储里有、列表里看不到'"）；2) 超过正文保留策略的旧快照明示「仅保留摘录」✅（新增显式 `retention` 字段，**不靠 `textTruncated` 反推** —— 见下方纪律）。 |
| **测试条件** | L2 + 人工走查 → **已补**（当时 **245 项全通过**，此后随 P1-05 增至 260 项，含 4 条路由用例 + `retentionOf` 纯函数用例 + 客户端 `SnapshotRow` 渲染用例；「旧快照明示 excerpt」用例在修复前**真的失败过**，证明非空转）。 |
| **实测结果** | ✅ 真实宿主（headless Chromium 打 `127.0.0.1:3080`）：`a_会话态下主区有面板: false`、`e_面板在右半屏: true`、`d_面板矩形 [793,38 647x719]`（仍只在右栏，主区干净）。点「历史」后页面出现 `最近 2 份快照（共 2 份）… 2026-10-09 23:05 20 条 +20 新增 · −30 移除 … 2026-10-09 22:54 30 条 基线：首次抓取，没有可对比的上一版`；点「正文」后取出**真抓到的 TechCrunch 正文 5496 字符**（开头 `TechCrunch Automattic loses its interim CFO just weeks after boardroom shakeup…`），不是占位符。证据：[TECH-SPIKE.md](TECH-SPIKE.md) §6.8 |
| **依据** | [SDD.md](SDD.md) §4.7（快照历史与保留等级） |

> **P1-02 定下的一条纪律**：`textTruncated` 有**两个来源** —— ① 规范化阶段正文超长被截（此时 `textChars` 顶到 `MAX_NORMALIZED_TEXT_CHARS`），② 裁剪阶段旧快照被压成摘录（此时 `textChars ≤ MAX_OLD_SNAPSHOT_CHARS`）。两者对用户的意义完全不同（前者是"来源本身很长"，后者是"我们只留了摘录"），界面必须能分开说，所以保留等级**显式落字段**（`retention: 'full' | 'excerpt'`），`retentionOf()` 的回退推断只服务于 P1-02 之前落盘的旧记录。
> **另一条**：「新增 20 条」旁边写「1 条变化记录」不是自相矛盾 —— 幂等规则（[SDD.md](SDD.md) §4.4）会让重复看到的同一条内容不再产生记录。界面改为「这份快照关联 N 条变化记录」并**如实说明**其余条目在更早的抓取里已经记过，而不是把数字悄悄对齐。

### P1-03 目录索引缓存（仅当出现性能问题）

| 项 | 内容 |
|---|---|
| **用户价值** | 数据量大时列表仍然即时。 |
| **交付** | 按 [SDD.md](SDD.md) §5.5 的索引缓存：`index` 表单记录、写后更新、`open()` 后 `reconcile()` 校验、失败降级为全表扫描。**索引永不作为唯一真相。** |
| **依赖** | P0-03、P0-14；**性能问题实测证据**（无证据不做） |
| **验收标准** | 1) 索引与真实键集合一致才可信；2) 人为破坏索引后自动重建；3) 索引写失败不影响记录持久化。 |
| **测试条件** | L2 新增：索引漂移与崩溃恢复用例。 |
| **依据** | [SDD.md](SDD.md) §5.5 |

### P1-04 更多来源类型 —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 覆盖更多平台的发布形态。 |
| **交付** | 新增 **2 类结构适配器**：`github_repo`（`src/host/adapters/github-repo.js`，看**仓库自身的定位信息**：描述 / 主页 / Topics / 语言 / 默认分支 / 许可 / 可见性 / 归档 / Stars 里程碑）与 `npm_package`（`src/host/adapters/npm-package.js`，看**单版本清单**：版本 / 运行时依赖 / peer 依赖 / 运行环境要求 / 废弃标记）。抽出 `src/host/adapters/github-common.js` 供两个 GitHub 适配器共用（`normalizeIdentifier` / `toEpochMs` / `readJsonBody` / `describeGithubError`），并据此重构 `github-releases.js`（原来它自己抄了一份）。预置模板 3 → **9 条**（三个类型各 3 条）。 |
| **依赖** | P0-05 ✅、P0-18 ✅ |
| **验收标准** | 1) 每个新类型必须有 fixture 测试 + 明确的失败状态 ✅（新建 `test/adapters.test.mjs` **21 项**，fixture 是 2026-10-09 从真实端点抓的**完整未裁剪**响应；两个适配器的失败阶梯逐条断言：截断优先于"不是合法 JSON"、空体、非 JSON、数组、缺字段、GitHub 404/限流文案、npm 的 `"Not Found"` 字符串、`{error}` 体）；2) 不得用脆弱通用抓取器提高"覆盖率" ✅（两个都是**结构明确**的 JSON API，不是启发式选择器）。 |
| **测试条件** | L1 fixture + T14 类真实验证 → **已补**（测试套件 260 → **281 项全通过**；真实宿主机实测见下）。 |
| **实测结果** | ✅ 两项都在真实宿主上跑通：`POST /sources/test` `github_repo` → 200 / **508 ms** / 11 条（`openai/openai-node 仓库动态`）；`npm_package` `@anthropic-ai/sdk` → 200 / **1344 ms** / `@anthropic-ai/sdk@0.132.1`。基线抓取 → **第二次刷新 `newChanges: 0`**（幂等）；把来源 PATCH 到另一个真实仓库 → `newChanges: 4`（仓库描述 / Topics / 项目主页 / 开源许可，excerpt 都是真实内容如 `MIT`、`Access to Anthropic's safety-first language model APIs in TypeScript`）；npm 侧 PATCH 到 `openai` → `新增：openai@7.31.0` + `内容有修改：peer 依赖（6 个）` + `内容有修改：运行环境要求`。证据：[TECH-SPIKE.md](TECH-SPIKE.md) §6.10 |
| **尚未做（已明确排除，非遗漏）** | Tag 列表类适配器、Changelog 结构适配器：前者与 `github_releases` 信息高度重叠（同一 API、同一仓库粒度），后者必然退化成脆弱通用抓取器 —— 与验收标准 2 直接冲突。 |

> **顺带修掉的两个真实缺陷（都由实测暴露，不是测试）**
>
> 1. **一处 schema 漂移让整个关注源域不可访问**（[TECH-SPIKE.md](TECH-SPIKE.md) §6.10.4）：`src/host/store/domains.js` 的 `SOURCE_TYPES` 是一张**手写的三元素清单**，加适配器时没同步，于是新类型的记录过不了持久化设施 `open()` 时的逐条校验 → **整个域打不开**，`GET /sources`、`POST /sources`、刷新、导出全部返回 `STORAGE_OPEN_FAILED`。磁盘数据一字未丢，却完全不可访问。修法是把类型清单**改为从适配器注册表推导**（`listAdapters().map(a => a.type)`），从根上消灭"加了类型忘了改域"这一类开关。
> 2. **同一处还漏声明了 P1-01 的两个字段**：`intervalMinutes` / `failureStreak` 没写进 `sourceRecord`，未声明的键会被结构校验器丢掉 —— 实测就是"设成 15 分钟、看着生效、重开域回到 0"。这两个字段现已声明，并用「设 30/60 → 强制重开域（`openCount` 97→98）→ 读回仍是 30/60」实测证明真的持久了。

### P1-05 机会池导出 Markdown —— ✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 研究结论能带走、能贴进自己的笔记或仓库。 |
| **交付** | `src/host/export.js`（**纯函数模块，无 ctx 依赖**，便于单测）+ 服务层 `exportOpportunities(query)`（`?ids=` 指定就按给定顺序导出，**其中任何一个找不到就整体失败**）+ 路由 `GET /apradar/export/opportunities`（路由表 20 → **21**，走新加的 `RAW_RESULT` 原始响应出口回 `text/markdown` + `content-disposition`）+ 客户端「导出 Markdown」（全部）与每条机会的「导出」（单条）。 |
| **依赖** | P0-13 ✅ |
| **验收标准** | 1) 导出内容保留事实/推测分区 ✅（两个分区来自**不同数据源**：事实只能来自 `changes`/`snapshots`/`sources` 三张表 —— 全部由真实抓取写入，无一条来自模型；推测只能来自用户自己写的字段。一边为空时**明说为空**，不留空标题）；2) 链接可用 ✅（`http(s)` 之外一律不写成链接，见下方纪律）；3) 导出不修改任何用户项目 ✅（**只读**：不写任何记录；客户端用 `Blob` + `<a download>`，**不经过任何后端写文件** —— 插件永远不碰用户的项目目录）。 |
| **测试条件** | 快照式比对测试 → **已补**（**260 项全通过**：新建 `test/export.test.mjs` 12 项含**完整输出快照**、3 项路由用例、`test/helpers.mjs` 的 `call()` 改为不硬解析 JSON；把 `safeInline` 临时还原成 `inline` 会让 2 条用例**真的失败**，证明非空转）。 |
| **实测结果** | ✅ 真实宿主：`curl -D- http://127.0.0.1:3080/apradar/export/opportunities` → 200 / `content-type: text/markdown; charset=utf-8` / `content-disposition: attachment; filename="ai-product-radar-opportunities-20261009-2322.md"` / **3211 字节真实内容**（含真抓到的 The Verge 摘录、正确的来源/快照/条目链接，以及第二条"没有关联任何一次抓取记录"的诚实说明）。CDP 探针 `eval-ui-export.js`：`a_会话态下主区有面板: false`、`e_面板在右半屏: true`、`f_导出按钮存在: true`、`g_导出按钮被禁用: false`、**Blob 真的被创建（size 3211、type `text/markdown;charset=utf-8`，与 curl 的字节数一致）**、下载文件名 `ai-product-radar-opportunities-20261009-2325.md`、提示 `已导出 ai-product-radar-opportunities-20261009-2325.md（2118 字符）。保存位置由浏览器决定 —— 插件没有、也不会写你的项目目录。`、`pageErrors: []`。证据：[TECH-SPIKE.md](TECH-SPIKE.md) §6.9 |
| **依据** | [PRD.md](PRD.md) §10；[SDD.md](SDD.md) §4.8（导出与不可信内容） |

> **P1-05 定下的一条纪律**：导出文件会被贴到别人的笔记或仓库里，而里面既有使用者写的自由文本，也有**从公网抓回来的原文摘录**。所以内容按**不可信**处理：非 `http(s)` 的 URI 方案被拆掉（`javascript:` → `javascript：`，全角冒号），能构成**链接、自动链接、代码段或原始 HTML** 的字符（`[ ] < > \``）被反斜杠转义。安全做法不是"记得别那么写"，而是**让它不可能是一个合法 URI**。强调标记（`*` `_`）**刻意不转义** —— 它们最多改变外观，到处加反斜杠会让源文件不可读。
> **另一条**：**事实与推测的分区不是排版技巧，是数据来源的边界**。事实区的每一行都能追到一次真实抓取（条目链接、来源、快照 id、抓取时间、原文摘录），推测区的每一行都出自使用者本人。一条没有关联任何抓取记录的机会，导出时会**明说**"它是在没有来源证据的情况下创建的"，而不会把使用者的判断挪进事实区充数。

### P1-06 typert RPC 迁移评估 —— ✅ 已完成（结论：**不迁移**）

| 项 | 内容 |
|---|---|
| **用户价值** | 更少的样板错误、端到端类型。 |
| **交付** | ① **V4 验证**：把「typert 代码生成在打包运行时是否可用」变成**可现场复核的运行事实**，而不是只留在一次性的终端记录里 —— 新增 `src/host/capabilities.js`（`describeTypert(get)`，永不抛、不猜）并把结果挂到 `GET /apradar/meta` 的 `runtime.typert`，启动日志同步打印一行；② **结论**：**运行时可用，但本插件不迁移** → **保留 `/apradar/*` 同源 HTTP 路径**（三条理由见下）。 |
| **依赖** | P0-09 ✅；V4 验证 ✅ |
| **验收标准** | 1) **V4 有明确结论** ✅ —— **判据成立**：真实 tauri Profile 下 `ctx.typert.local.list()` = **126** 条本环境调用描述符、**23** 个包贡献了生成反射、`ctx.typert` 已挂载、本插件 `ownPackageRegistered: false`。**结论**：本插件不迁移；2) 若迁移则一元调用按 `RemoteResult` 处理 —— **未触发**（不迁移）；3) Client 行为与迁移前一致 ✅ —— **零改动**（客户端一行没动，295 → 303 项测试全绿；`runtime.typert` 只是 `meta()` 里新增的一个只读区块）。 |
| **测试条件** | T16 重跑（两种载体）→ **已补**：新建 `test/contract.test.mjs` **7 项**，**21/21 条路由全覆盖**（表与 `ROUTES` 双向比对，实测「故意删掉一条覆盖即失败」）；另新建 `test/capabilities.test.mjs` **12 项**守着"探测永不抛、`null` 与 `false` 必须分开"。全套 **303 项全通过**。 |
| **实测结果** | ✅ `GET /apradar/meta` → `runtime.typert = {available: true, packages: 23, schemas: 0, descriptors: 126, remoteDescriptors: 0, ownPackageRegistered: false}`。`schemas: 0` **不是"没有 schema"**，而是按需惰性物化、没人读过时列表就是空的。证据：[TECH-SPIKE.md](TECH-SPIKE.md) §6.11 |
| **依据** | [COMPATIBILITY.md](COMPATIBILITY.md) §4.3 / §4.3.1（V1/T17 与 V4）、§4.2 C10；[SDD.md](SDD.md) §6.3 |

> **为什么不迁移（三条理由，每条都独立成立）**：
> **① 生成器是开发期工具，运行时里根本没有它。** 运行时只有 `dsh-typert-loader` / `dsh-typert-protocol` / `dsh-typert-registry` 三个包，**289 个官方包里没有任何 `*generator*`**；生成器 `@deepseek-ai/dsh-typert-generator` 是独立发布的 npm 包（描述原文 "**TypeScript project analyzer** and model-driven Typert artifact generator"），通过 `exports["./tsdown"]` **以 tsdown 插件形态接入构建**，产物落在 `lib/typert.host.js`；而**运行时里没有 `tsdown`**。本插件目前是**纯 JS、零运行时依赖、无构建步骤**（`dsh.client` 直接指源码，改完刷新页面即生效）—— 采用它等于把插件改成 TypeScript 工程并引入 TS + tsdown + 生成器整套构建链。
> **② 客户端面没有 typert 发现机制。** `dsh-typert-loader` README 的已知限制原文：「**仅宿主侧** —— 发现机制只会导入宿主侧 `./typert` 产物；**在为客户端运行时添加等价的发现机制之前**，需要先有独立的组合所有者。」而本插件的主要消费方**正是客户端面**（右侧边栏）。就算宿主侧产物齐备，客户端也拿不到等价的调用面。
> **③ 更早的决策已经定过这件事的走向。** `T17 / V1`（[COMPATIBILITY.md](COMPATIBILITY.md) §4.3）已判定：Desktop 与隔离 Web Profile 双向实测均通过 → **同源 HTTP 方案维持不变**，`SDD.md` §6.1 无需改写、V4 不升为 P0。
>
> 这不是"因为做不到而放弃" —— **判据本身是满足的**。这是"成本与风险换不来收益，且已有一个经双向实测的合格方案"。若将来走发布路线并需要端到端类型，本条记录就是重新评估的起点；**届时第 ② 条必须先行**，否则迁移只能覆盖一半。

### P1-07 npm 发布准备（Client 构建产物）✅ 已完成

| 项 | 内容 |
|---|---|
| **用户价值** | 其他人能一条命令装上。 |
| **交付** | ✅ `npm run build`（`scripts/build.mjs`）组装自洽运行树：`src/client/client.js` → `lib/client.js`（加来源说明头，含内容指纹、**不含时间戳**，否则漂移检查无法用比较判断），其余 `src/host/**` 29 个文件**逐字节复制**进 `lib/`。✅ 发布前校验：`scripts/client-contract.mjs` 被构建与测试**共用同一份**判据（基座模块表抄自外壳源码 `index-5SrrfWpU.js` 的 `staticModules: rM()`；六条检查：恰好一次 `__ModuleLoader__.load(`、装载 id == 包名、`requires ⊆ 基座 ∪ external`、禁动态 `require`/`import()`、禁 ESM 语句、禁 JSX；**必须先剥注释再扫**，否则文件头文档注释里的示例会触发假失败）。✅ `dsh.client.external: []`（本插件只 `require('react')`，测试反向要求"声明了就必须真用到"）。✅ 安装与升级说明写进 [README.md](README.md)。✅ 客户端半边自诊断：`describeClientHalf()` + 启动日志 + `/apradar/meta` 的 `runtime.clientHalf`。 |
| **依赖** | 全部 P0 |
| **验收标准** | 1) 全新 profile 安装后**无需源码**即可运行 ✅（`files` 只收 `lib/`；实测装出来的包里 `ls src` → `No such file or directory`）；2) 缺失 bundle 时能给出明确的自诊断信息 ✅（**平台不给 —— 实测见 §6.12.4，由本插件自己给**）；3) 记录精确依赖版本 ✅（零第三方依赖；`engines.node >=22.19`、`engines.dsh >=0.2.0-rc.1`） |
| **测试条件** | T1、T22 在干净 profile 下重跑 ✅。`test/publish.test.mjs` **10 项**（含 `lib/` 自洽性：扫全部相对导入确认解析到 `lib/` 内、无孤儿产物、`lib/index.js` 与源逐字节相同、`--check` 实跑 exit 0、`stripComments` 自身可靠性）。全套 **323 项 `node --test` 全通过** |
| **实测结果** | ①`npm pack` → **33 个文件**（`lib/**` + `README.md` + `cordis.patch.yml` + `package.json`），`grep -cE "package/(src\|demo\|test\|spike\|scripts)/"` → **0**；②全新 `DSH_HOME` + `plugin --profile web add <tarball>` → **442ms、`Packages: +1`**，`dsh.profile.bundles` 末位出现 `dsh-apradar`；③启动日志 5 行齐全 + `runtime: clientHalf.composed=true path=…/node_modules/dsh-apradar/lib/client.js`，`grep -icE "activation\|failed\|missing bundle"` → **0**，`/apradar/ping` 200；④页面探针 `pageErrors: []`、console `[apradar] 官方右侧栏页签已注册：kind = apradar`、**服务的是生成产物**；⑤**缺 bundle 对照实验**：手工删掉 `lib/client.js` 打包（用 `tar` 以免 `prepack` 补回）→ 宿主**照常启动**、日志与页面**零提示**、HTML 里 `apradar` 出现 **0 次**、`hitCount: 0`；加了自诊断后日志出现 `client half NOT composed: …（含包名与修法）` |
| **依据** | [COMPATIBILITY.md](COMPATIBILITY.md) §3.1、§4.2 C8；[TECH-SPIKE.md](TECH-SPIKE.md) §6.12 |

> **两条值得记住的纪律**（完整推理见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.12）：
>
> 1. **源与产物之间必须能用"比较"判断一致性。** 生成头里放时间戳会让每次构建的产物都不同，于是"改完客户端忘跑构建"这件事就再也测不出来了。放内容指纹则可以 —— 实测给 `lib/index.js` 追加一行注释就触发 2 条断言失败。
> 2. **生命周期钩子必须在第一个 `await` 之前注册。** 重载时上一个实例的 in-flight promise 会继续跑完，而那时它的 fiber 已经释放 —— 之后注册的 `ctx.effect` 落在死作用域上，disposer 永不执行、资源永久泄漏。真实代价：四个存储域全部泄漏，新实例拿到 `already-open`，**整个存储不可用**，而磁盘数据完好（看起来像数据损坏）。除了修时序，还对**本插件独占命名**的资源加了自愈回收（关掉遗留句柄后重试一次）。实测**无需重启即恢复**。
>
> 3. **平台不报的错必须自己报，而且必须分清"没有观察到"和"观察到了没有"。** 官方 README 承诺缺失 bundle 会明确报错，实测**没有**。本插件的 `describeClientHalf()` 因此严格区分 `available:false`（没观察能力）与 `composed:false`（确定的坏消息）—— 把前者写成后者就是在撒谎。

### P1-08 引入第三方 feed 解析库（**条件触发**）

| 项 | 内容 |
|---|---|
| **用户价值** | 对非标准 Feed 的兼容性更好。 |
| **交付** | 仅当**核心 fixture C1–C7 已 100% 通过**、且业务确实需要超出 RSS 2.0 / Atom 1.0 子集范围（[SDD.md](SDD.md) §3.2）的格式时才启动；按 [COMPATIBILITY.md](COMPATIBILITY.md) §6.3.2 的选型标准、安装方式与 6 步兼容性验证执行。**参考 fixture 通过率低本身不构成引入理由**（用户 m00370 决策③）。 |
| **依赖** | P0-06 的实测失败率证据 |
| **验收标准** | 6 步验证全部通过，且解析输出与自研实现一致或更优。 |
| **测试条件** | T13 全量 fixture 对比 + T22。 |

---

## P2 · 未来探索

> 以下均为**探索方向**，不是承诺。任何一项在启动前都必须先完成对应的能力核验。

### P2-01 显式 AI 解读（严格受限）

| 项 | 内容 |
|---|---|
| **用户价值** | 对选中的变化获得一份加速理解的说明。 |
| **约束（硬）** | 1) **只能由用户显式对某一条变化触发**，永不自动运行；2) 输出**只写入「推测区」**，与事实字段物理分离；3) 页面内容必须包裹官方同款外部内容告示（`EXTERNAL_WEB_CONTENT_NOTICE` 模式），并声明其为不可信数据；4) 必须先核验 DSH 当前公开支持的模型/Agent 接口（**本阶段不实现、不调用**）。 |
| **依赖** | DSH 模型/Agent 接口核验；P0 全部 |
| **验收标准** | 1) 未触发时不产生任何模型调用；2) 输出与事实区在数据层与 UI 层都不可混淆；3) 不在 P0 链路的任何位置引入模型。 |
| **依据** | [PRD.md](PRD.md) §10；[SDD.md](SDD.md) §8.3 R4 |

### P2-02 变化关联聚类

| 项 | 内容 |
|---|---|
| **用户价值** | 同一能力被多个来源提及时能一起看。 |
| **约束** | 必须是无模型的确定性方法（如关键词/实体交集），或明确标注为推测。 |
| **依赖** | P0-08 |
| **验收标准** | 聚类结果可解释、可关闭。 |

### P2-03 跨设备 / 跨进程同步

| 项 | 内容 |
|---|---|
| **用户价值** | 多台机器共享同一份研究记录。 |
| **约束** | 依赖 DSH 存储层是否提供跨进程可见性（当前 `domain/changed` 明确是进程内事件，跨进程不可见）。**在 DSH 提供前不做任何自建同步后端。** |
| **依赖** | DSH 存储层能力变化 |
| **验收标准** | 有官方跨进程机制可用，且不引入外部 SaaS 后端。 |

### P2-04 更多来源类型的结构化差异

| 项 | 内容 |
|---|---|
| **用户价值** | 对 API 文档、定价页、模型列表等结构化页面的变化更精确。 |
| **约束** | 必须放弃"通用抓取"，改为每种结构一个显式适配器 + 明确的失败状态。 |
| **依赖** | P1-04 |
| **验收标准** | 每类都有 fixture 与失败路径测试。 |

### P2-05 通知与提醒

| 项 | 内容 |
|---|---|
| **用户价值** | 关键时刻被打断一下。 |
| **约束** | 依赖 DSH 的通知能力（**未核实**）；只做本地提醒，不做社交发布。 |
| **依赖** | DSH 通知能力核验 |
| **验收标准** | 可完全关闭；不引入外部服务。 |

---

## 依赖关系速览

```
P0-00 技术 Spike（V1/V6）  ← ⛔ 前置闸门：不通过不得开工任何 UI
 ├─ 通过 ─────────────────────────────────────────────► 允许 UI 开发
 └─ 不通过（Desktop 路由不可达）────► 先验 V4（typert RPC），再回到 §6.1 改方案

P0-01 骨架
 ├─ P0-02 右栏三页签 ─────────────────┐   （须在 P0-00 通过之后）
 ├─ P0-03 持久化 ─┬─ P0-07 规范化/去重 ─ P0-08 差异 ─┬─ P0-10 收件箱 ─ P0-11 详情 ─ P0-13 机会池
 │                ├─ P0-09 路由 ──────────────────────┘        │
 │                └─ P0-15 持久化状态/purge                      │
 ├─ P0-04 出网闸门 G-NET-1…3 ─┬─ P0-05 GitHub 适配器 ─┐        │
 │                            ├─ P0-06 RSS/Atom 适配器 ─┼─ P0-12 来源管理 ─┘
 │                            └─ P0-14 刷新编排/上限 ───┘
 ├─ P0-16 安全边界与闸门（G-NET-4/5 + 字段级写权限 + 信任边界）
 ├─ P0-17 离线测试套件与 fixture（核心 C1–C7 100% 阻断）
 └─ P0-18 静态 HTML（有条件支持，**排在最后**）

阻塞项：~~T17/V1（Desktop 路由可达性）~~ → ✅ **已解除**（2026-10-09 实测通过，P0-02/P0-10/P0-11/P0-12/P0-13 可开工）
        T13（核心 fixture 100%）   → 阻断 P0-06 验收；通过后才是 P1-08 是否启动的判据
        V7/V8/R1（残余风险）        → 阻塞 P0-18 的排期，且禁止任何「完整 SSRF 防护」表述
        V2/V3（backup-and-skip、version-mismatch）→ 只影响 P0-03 的两条容错验收（第 2、3 条）
```

## 推荐的第一版开发顺序

0. **P0-00 技术验证 Spike（最先，阻塞一切 UI）** —— 在与产品代码隔离的目录里验证右栏注册 + Client→Host 同源请求 + 正常/异常响应；Desktop 与 Web 两个 profile 各跑一遍。**结论不通过就不进入第 1 步以下的任何 UI 工作。**
1. **P0-17 的 fixture 与测试骨架先行** + **P0-01 骨架** —— 先把「能被加载」和「能离线测」立起来（含核心 fixture C1–C7 的空壳与列表查询契约 fixture）。
2. **P0-03 持久化** + **P0-15 状态反馈** —— 数据层是所有视图的地基；顺带完成 V2/V3 验证；实现 §5.8 的写链、部分失败策略、purge（含二次确认与部分失败报告）。
3. **P0-04 出网闸门（G-NET-1…3）** + **P0-16 安全闸门** —— 安全边界必须在第一个真实请求之前就位，且**静态扫描要先用一个故意违规的样例验证它确实会失败**。
4. **P0-06 解析器**（先 RSS/Atom，核心 fixture 最全，**必须 100% 通过**）+ **P0-07/P0-08 规范化与差异**。
5. **P0-09 路由** —— 复用 P0-00 已验证的通信方案。
6. **P0-02 外壳** → **P0-10 / P0-11 / P0-13**（**注意：这一步在 P0-00 通过的前提下才允许开始**）。
7. **P0-05 GitHub 适配器** + **P0-14 刷新编排** —— 接上真实来源（**P0 的主要来源类型**）。
8. **P0-12 来源管理** —— 含自定义 URL 的「有条件支持」标注与授权提示。
9. **P0-18 静态 HTML** —— 有条件支持，放最后。

---

## 附录 A · 跨文档追溯矩阵

每一行表示：**PRD 里的一项需求，落到哪个数据模型/接口，依据是什么，由哪个编号验收。** 任何一行若有空白，说明该需求尚未形成闭环。

| # | PRD 需求 | SDD 数据模型 / 接口 | COMPATIBILITY 依据 | MVP-BACKLOG 交付 | 验收 |
|---|---|---|---|---|---|
| 1 | §5.1 单一右栏入口，页内三视图 + 详情态 | §1.3 耦合点、§10.1 客户端形态 | §4.1 A2、§4.2 C1、§4.4 N4/N5 | P0-02 | T2、T3、T4、V6 |
| 2 | §6.2 变化收件箱（筛选/搜索/排序/标记） | §5.3 `change`、§6.1 `GET /changes` | §4.1 A4、§4.2 C3 | P0-10 | T3、T4 |
| 3 | §6.2 不展示相关度分数与图表 | —（负向需求，无数据模型） | §4.4 N7（无模型评分能力，也不引入） | P0-10 | 人工走查 |
| 4 | §6.3 关注源管理（增删改启停/测试/模板） | §3.1–§3.3 适配器、§5.3 `source`、`/sources*`、`/templates` | §4.1 A4/A7、§4.2 C5/C6、§4.4 N1–N3 | P0-05、P0-06、P0-12、P0-18 | T10、T11、T13、T14 |
| 5 | §6.3 手动测试给出「可访问 / 可解析」两个独立结论 | §6.1 `POST /sources/test` | §4.2 C6 | P0-12 | T10、T11 |
| 6 | §6.4 详情页事实 / 推测分区 | §5.3 `change`+`snapshot`、§6.1 `GET /changes/:id`、§6.1 字段级写权限 | §4.1 A4/A7 | P0-11、P0-16 | T8、T12、T16 |
| 7 | §6.5 产品机会池（可编辑、可跳回原变化） | §5.3 `opportunity`、`/opportunities*` | §4.1 A4 | P0-13 | L4、L5 |
| 8 | §6.5 不生成、不修改用户项目的版本路线图 | —（负向需求） | §4.4 N8 | P0-13 验收标准第 3 条 | 人工走查 |
| 9 | §6.6 四类状态（空/加载/失败/持久化） | §6.1 统一响应格式 `{ok,data}/{ok,error}` | — | P0-02、P0-15 | T5 |
| 10 | §7.1 来源级状态机 | §5.3 `source.lastStatus/lastError`、§7.1 错误码表 | §6.2 网络限制生效值 | P0-12、P0-14 | T8、T10、T11 |
| 11 | §7.2 条目级状态机 | §5.3 `change.status` | §4.1 A4 | P0-10、P0-13 | 人工走查 |
| 12 | §7.3 失败处理原则（不虚构、不断言「无更新」） | §7.2 失败不变量 | — | P0-08、P0-11、P0-14 | T8、T14 |
| 13 | §7.4 去重与幂等 | §4.3 指纹（`itemFingerprint`/`contentFingerprint`/`dedupeKey`） | §4.1 A4 | P0-07 | T15 |
| 14 | §8.1 来源类型 1：GitHub Releases / `releases.atom` | §3.2.1 `github_releases` 适配器 | §4.1 A7、§4.3 V5 | P0-05 | T14（含 V5） |
| 15 | §8.1 来源类型 2：RSS / Atom | §3.2.2 `rss_atom` + 零依赖解析器 | §4.1 A7、§6.3.1 零依赖选型 | P0-06、P0-17 | T13 |
| 16 | §8.1 静态 HTML「有条件支持」 | §3.2.3 `html_static` + 结构判据 | §4.2 C6、§4.4 N1–N3 | P0-18 | T13 |
| 17 | §8.1 手动刷新（整体 / 单源） | §6.1 `POST /refresh`、§2.3 数据流 | §4.2 C4（无并发闸门 → 自建） | P0-14 | T8、T15 |
| 18 | §8.1 本地快照与变化检测 | §4.4 差异、§5.3 `snapshot`+`change` | §4.1 A4/A5 | P0-08 | T14 |
| 19 | §8.1 有界请求 / 响应 / 存储 | §5.4 上限常量、§6.1 单响应 256 KB | §6.2 生效限制值（30s / 5 MB / 100 K / 5 跳 / 2048 字符） | P0-14 | T12 |
| 20 | §8.1 可核验的原始来源链接 | §5.3 `snapshot.url`（`WebFetchResult.url`）、§4.3 `normalizedUrl` 规则 | §3.5 `url` 字段、§4.1 A6 | P0-11 | 人工走查 |
| 21 | §8.2 「不做」清单（无定时/无搜索/无登录态/无模型） | §1.2 架构原则、§10.2 依赖策略 | §4.4 N1–N11、§6.1（**实测后为「零运行时依赖」**） | P0 范围声明、P2-01 约束 | 代码审查、T22 |
| 22 | §9.2 成功标准 A7：出网全部经受管接口 | §8.1 出网纪律（唯一出网点） | §4.1 A6 + §8.3 残余风险 R1/R2 | P0-04、P0-16 | T9、T10、T11 |
| 23 | §9.2 成功标准 A6：重载后数据仍在 | §5.7 句柄生命周期 | §4.1 A4/A5、§4.4 N10 | P0-03、P0-15 | T5、T18、T19、T20 |
| 24 | §5.3 状态归属（UI 偏好不落库） | §2.2 Client 冻结契约 | §4.2 C9（仅 localStorage） | P0-02 | 人工走查 |
| 25 | **用户决策①**：JSON 单后端有条件接受——集合查询/索引结构/数据上限/写入失败恢复/索引重建五项必须写明 | §5.1 枚举能力表、**§5.1.1 列表查询契约**、§5.4 上限、§5.5 索引结构、**§5.8 写入失败恢复与索引重建**（§5.8.5 重建、§5.8.6 purge）、**§5.0 实测定稿** | §3.3 Storage 依据、§4.1 A4/A5、§4.2（无 SQLite、无跨表事务） | P0-03、P0-14、P0-15、P0-17 | T5（✅ 已通过：跨进程 `openCount` 1→2）、T6(V2)、T7(V3)；L2 |
| 26 | **用户决策②**：T17/V1 必须先验证再开发 UI | §6.1 前置闸门（✅ **已通过，闸门解除**）、§9.3 V1/V6 | §4.3 V1、§4.3.1、§9.1 T17 | **P0-00 技术 Spike（✅ 已完成）**、Milestone 1 专项复验 | ✅ 已执行：Desktop（真实桌面宿主渲染进程）+ 隔离 Web Profile 各跑一遍，Q1–Q4 全通过；证据 [TECH-SPIKE.md](TECH-SPIKE.md) §6.1/§6.2/§6.4 |
| 27 | **用户决策③**：核心 Fixture 必须 100%，一项失败即不通过；5% 只作参考 | §9.2.1 核心 fixture C1–C7、§9.2.2 参考 fixture、§9.2.3 验收闸门、§10.2 第三方库判据与安装纪律 | §6.3 RSS/Atom 解析依赖选型与安装方式 | P0-06、P0-17 | T13；核心 fixture 100% |
| 28 | **用户决策④**：卸载后数据保留有条件接受——清空入口/操作确认/部分失败/README 明示 | §5.8.6 显式清除数据（范围/顺序/部分失败/可重入/README 明示） | §4.4 N10（卸载不清理 storages） | P0-15 | T19、T20 |
| 29 | **网络残余风险升为正式 P0 闸门**：唯一受管出网 + 静态源码检查 + 不得声称完整 SSRF 防护 | §8.1 G-NET-1…G-NET-5、§8.1.2 P0 来源范围收敛、§3.2 范围声明 | §6.2 网络限制生效值、§4.2/§4.3（抓取层保护范围与缺口） | P0-04、P0-05、P0-06、P0-16、P0-18 | T9、T10、T11、V10；L3 |
| 30 | **列表查询可行性必须有接口级证据**（不能只靠单条 put/get） | §5.1 枚举能力表（`entries`/`keys`/`size`）、§5.1.1 契约与强制方式、§5.4 上限是前提 | §3.3 存储公开接口依据 | P0-03、P0-17 | 列表查询契约 fixture（C7）；L2 |

**一致性检查结论（本次）**

- 30 行全部有闭环，无空白单元格。
- **本次（Milestone 0 + 1 收尾）最关键的一处反转**：上一轮把「zod 是唯一例外依赖」写成结论（第 21、25 行与 §10.2），**实测证明这条路走不通** —— 外部 `link:` 插件**解析不到** `@deepseek-ai/dsh-storage-domain`（`ERR_MODULE_NOT_FOUND`），且 `link:` 协议**不会为被链接包安装其 `dependencies`**，因此在插件 `package.json` 里声明 zod 也无法让自己 `import 'zod'` 成功。已改为**零运行时依赖 + 数据形状字面量 spec + 动态探测官方 helper**（[SDD.md](SDD.md) §5.0）。第 21、25 行、§10.2、P0-03 验收第 5 条、T22 已同步。
- **已验证项从「推断」升级为「实测」**：P0-00 的 Q1–Q4（原第 26 行）与持久化的跨进程判据（第 25 行 T5）均已执行通过，证据见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.4。因此第 26 行不再是阻塞项。
- **一处仍单向依赖且已如实标注**：第 19 行的体积/超时值来自 [COMPATIBILITY.md](COMPATIBILITY.md) §6.2 的**当前默认值**，非 API 契约。第 24 行的 `localStorage` 能力来自 §4.2 C9。两者若变化，只需改 COMPATIBILITY 与本矩阵对应行，不动 PRD 需求。
- **限制必须随结论一起传播**：Desktop 侧的可达性证据来自**同一宿主、同一页面源的真实 Chromium 渲染进程**，不是 Tauri 自己的 WKWebView（本机无法自动化它，无 CDP 端点）。任何对外表述都不得省略这句。真实桌面宿主**重启后** `openCount` 是否递增**未执行**（重启会终止当前会话）。
- **仍然有效的阻塞/风险项已在两处文档中一致登记**：[COMPATIBILITY.md](COMPATIBILITY.md) §9.1 与 [SDD.md](SDD.md) §9.3 —— T13（核心 fixture 100%，阻断 P0-06 验收并决定 P1-08）、V7/V8/R1（残余风险，阻断 P0-18 排期且禁止「完整 SSRF 防护」表述）、V10（不阻塞开工，只影响 G-NET 闸门完整性声明）、V2/V3（只影响 P0-03 的两条容错验收）。
