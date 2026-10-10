# SDD — AI 产品雷达（AI Product Radar）

> DSH 插件系统设计文档 · 第一版（MVP）· 只描述基于当前环境可论证的接口设计
> 配套文档：[PRD.md](PRD.md)、[COMPATIBILITY.md](COMPATIBILITY.md)、[MVP-BACKLOG.md](MVP-BACKLOG.md)

**路径记号**（本机绝对路径仅作为本地核验证据，不写入本仓库文档）：

| 记号 | 含义 |
|---|---|
| `$PKG` | DSH 运行时包目录（`node_modules/@deepseek-ai`，位于 DSH installation 内） |
| `$DSH_HOME` | DSH 用户数据目录（`~/.dsh`） |
| `$PROFILE` | 当前生效 profile 目录（`$DSH_HOME/profiles/<name>`） |
| `$APP` | Desktop 应用的 resources 目录 |

**证据标记**：`[已核实]` = 本机读源码/README/落盘物证确认；`[待确认]` = 未取得证据，需最小验证；`[外部]` = 来自外部公开资料，未在本机实测。

---

## 1. 总体技术架构

### 1.1 组件图

```
┌──────────────────────────── DSH 右侧栏（浏览器渲染进程） ────────────────────────────┐
│ Client 插件（单文件 bundle，无构建步）                                                │
│  · 一个页签注册（sidebar.right.pane.tab 正文席位）                                    │
│  · 三个视图 + 详情态（插件自己的分段控件切换，不用 DSH 页签/工具栏席位）                 │
│  · 只调用同源 /apradar/* 接口；不直接访问外网、不碰文件系统、不碰持久化                  │
└───────────────────────────────────┬─────────────────────────────────────────────────┘
                                    │ HTTP（同源 JSON）/ 或 typert RPC（P1 候选）
┌───────────────────────────────────▼─────────────────────────────────────────────────┐
│ Host 插件（DSH Node 运行时）                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────┐  ┌────────────────────────┐  │
│  │ 路由层 routes │→│ 服务层 service │→│ 适配器 adapters │→│ 抓取闸门 fetch/gateway  │  │
│  │ /apradar/*   │  │ 编排/查询/写入 │  │ 三类来源解析   │  │ 唯一出网口 ctx.web.fetch│  │
│  └──────────────┘  └──────┬───────┘  └───────────────┘  └────────────────────────┘  │
│                           │                                                          │
│                    ┌──────▼────────┐   ┌──────────────┐   ┌───────────────────┐     │
│                    │ 差异 diff      │   │ 指纹/规范化    │   │ 上限 limits        │     │
│                    └──────┬────────┘   └──────────────┘   └───────────────────┘     │
│                           │                                                          │
│                    ┌──────▼─────────────────────────────────────────────────────┐    │
│                    │ 持久化：ctx.storageDomain（4 个 domain，JSON 后端）           │    │
│                    └────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 1.2 架构原则

| 原则 | 落地方式 |
|---|---|
| **模型不参与** | 采集/解析/去重/差异全部是确定性代码；第一版不注册任何模型调用 |
| **Client 不碰外部世界** | Client 只做渲染与用户操作；所有 I/O 在 Host |
| **唯一出网口** | 所有外网请求集中在 `fetch/gateway.ts`，只调用 `ctx.web.fetch()` |
| **事实与推测在数据层就分离** | 事实字段来自抓取与差异结果；推测字段是独立 record 字段，物理上不同字段 |
| **一切有界** | 网络、解析、存储、列表、差异条目全部有显式上限常量 |
| **单入口** | 右栏只注册一个页签；三个视图是内部路由 |

### 1.3 与 DSH 的耦合点（全部为公开接口）

| 耦合点 | 接口 | 状态 |
|---|---|---|
| 右栏页签注册 | `ctx.sidebarRightTabs.register({id, kind, priority, title, guide})` | `[已核实]` |
| 页签正文 | `ctx.slots.register({name:'sidebar.right.pane.tab', key:id}, Body)` + `useTabInfo()` | `[已核实]` |
| 打开发送 | `ctx.sidebarRight.openTab(kind)` | `[已核实]`（Knit 实现在用） |
| 持久化 | `ctx.storageDomain.open(spec)` → `Domain.table().get/entries/keys/put/delete/update/size` | `[已核实]` §5 |
| 出网 | `ctx.web.fetch(url)` | `[已核实]` |
| 入站路由 | `ctx.webServer.register({kind:'prefix', path, handler})` | `[已核实]`（Knit 实现在用） |
| 生命周期 | Cordis `ctx.effect` / `ctx.inject([...])` | `[已核实]` |
| 可选：类型化 RPC | `ctx.typertGateway` + `@deepseek-ai/dsh-api-gateway/client` 的 `ctx.remote` | ❌ **不采用**（生成描述符需开发期 TS + tsdown + 生成器，且客户端面无发现机制；见 §6.3） |

---

## 2. Host / Client 职责

### 2.1 Host

**职责**
1. 持有并管理 4 个 storage domain 的句柄生命周期。
2. 通过 `ctx.web.fetch()` 获取公开网页（唯一出网点）。
3. 解析来源（GitHub Releases / RSS-Atom / 静态 HTML），产出规范化内容。
4. 计算内容指纹、执行去重、与上一快照做差异计算。
5. 执行上限裁剪（快照、变化、机会、正文长度）。
6. 通过 `ctx.webServer` 注册 `/apradar/*` 前缀路由，向前端提供查询与变更接口。
7. 管理来源刷新错误与失败原因（结构化错误码）。
8. 提供显式的「清除全部数据」能力。

**不做**：不做任何 UI 渲染；不在 Client 侧做持久化；不调用模型。

### 2.2 Client

**职责**
1. 注册唯一右栏页签与正文组件。
2. 渲染三视图 + 详情态、分段控件、空/加载/失败/持久化状态。
3. 搜索、筛选、排序、导航、标记、备注、机会编辑的前端交互（过滤在有界数据上进行）。
4. 调用 Host 的 `/apradar/*` 接口并展示结果。

**面板里不重复产品名**（2026-10-09 按使用者要求改定）
右栏的页签 chip（`RadarTitle`）上已经写着「AI 产品雷达」，正文里再放一遍标题 + 副标题既重复又白占一行高度。所以 `.apr-head` 整块已删除，`修改` `关注源` `机会池` 的视图页签栏就是面板的第一行（实测距面板顶部 0px）。**别"顺手"把标题加回来** —— 名字只有一处，就在页签上；`test/client.test.mjs` 有一条断言钉着"面板正文里不该出现产品名"。

**明确不做**（硬约束）
- ❌ 不直接访问任意外部网站（无 `fetch(外部URL)`、无 `<img src=外部>`）
- ❌ 不操作宿主文件系统
- ❌ 不直接访问持久化后端（不 import storage 相关包）
- ❌ 不读取 DOM 结构或全局对象绕过 DSH 接口

### 2.3 数据流（一次手动刷新）

```
Client: POST /apradar/refresh {sourceIds?}
  → Host routes: 校验入参（只接受本机已知 sourceId）
  → Host service: 读取 sources 表，筛出 enabled 且被指定的源
  → 逐源（串行，最多 2 并发）：
        adapter.buildRequest(source)        → { url, acceptHint }
        gateway.fetch(url)                  → WebFetchResult | WebFetchError
        adapter.parse(result)               → NormalizedFeed { items[], title, publishedAt }
        normalize + fingerprint
        与最新快照比对 → diff
        写入 snapshot / change 记录（dup 判定）
  → limits.trim()
  → 返回 {checked, succeeded, failed:[{sourceId, code, message}]}
Client: 重新拉取 GET /apradar/changes 与 GET /apradar/state
```

**幂等**：同一次刷新重复执行不会产生重复 change（去重键约束）。

---

## 3. 关注源适配器设计

### 3.1 适配器契约

```ts
// 纯函数式：不自己出网，不做持久化
interface SourceAdapter<C = unknown> {
  readonly type: SourceType;                     // 'github_releases' | 'github_repo' | 'npm_package' | 'rss_atom' | 'html_static'
  readonly displayName: string;                  // 中文名，Client 直接展示
  /** 校验并归一化用户填入的配置；非法时抛 SourceConfigError（可读原因） */
  normalizeConfig(input: unknown): C;
  /** 规范化 URL + 请求提示；用于去重键，不发起请求。buildRequests 缺省时作为唯一端点 */
  buildRequest(source: SourceRecord, config: C): { url: string; acceptHint?: string };
  /**
   * 候选端点（按优先级，首选在前）。存在时优先于 buildRequest。
   * 实测动机：可达性是逐主机名的 —— 本机 `github.com` 超时不可达，而 `api.github.com` 200/749ms，
   * 只有一个端点的适配器在真实网络里必然有一部分用户完全用不了（TECH-SPIKE §6.6.2）。
   * 多个端点必须真的返回同一份内容语义（同一仓库 / 同一站点），否则差异检测会误报。
   */
  buildRequests?(source: SourceRecord, config: C): Array<{ url: string; acceptHint?: string }>;
  /** 解析已获取的结果；不可解析时抛 AdapterParseError（含可读原因），不返回空数组假装成功 */
  parse(input: WebFetchResult, config: C): NormalizedFeed;
  /** 该类型是否支持「测试可访问性/可解析性」 */
  readonly testable: boolean;
}

interface NormalizedFeed {
  title: string;
  publishedAt?: number;
  items: NormalizedItem[];   // 每个 item 代表来源内一个可独立追踪的条目
}

interface NormalizedItem {
  itemId: string;            // 来源内稳定 id（release tag / feed entry id / 内容指纹）
  title: string;
  publishedAt?: number;
  text: string;              // 规范化后的纯文本（已剥离标签）
  url?: string;
}
```

**设计约束**
- 适配器**不接收 `ctx`**，因此物理上不可能自己出网 → 安全边界在架构层就成立。
- `parse()` 对空结果与解析失败必须区分：空 Feed 是合法结果；解析失败是错误。
- 所有 `parse()` 都必须有 fixture 单测，CI 不出网。
- **多端点由服务层驱动，适配器只声明候选**：`resolveRequests(adapter, source, config)`（`src/host/adapters/types.js`）返回候选数组（有 `buildRequests` 用它，否则把 `buildRequest` 包成单元素），`fetchAndParse()` 依次尝试，**首个成功即返回**；全部失败时抛**首选端点**的错误（它才是用户想用的那条路），并把每个候选的失败挂进 `detail.attempts`（仅当候选多于一个）。**地址拼错（`assertFetchableUrl` 失败）立即抛出，不静默回退** —— 回退会把"插件拼错了 URL"伪装成"网络不通"。

### 3.2 P0 适配器

**P0 范围收敛声明（与 §8.1.2 一致，不得放宽）**：P0 的承诺范围是**受控来源**——`github_releases`（用户只填 `owner`/`repo`，URL 由代码拼接）+ **预置官方来源模板**（URL 为代码内常量）。`rss_atom` 与 `html_static` 允许用户提供 URL，但列为**有条件支持**，必须同时满足：①UI 明示「地址由你提供，本插件不额外提供完整 SSRF 防护」；②依赖 DSH 抓取层的协议白名单 + 公有地址白名单；③在 V7/V8/R1 有实测结论前，文档不得宣称完整防护。

| 适配器 | 状态 | 用户输入 |
|---|---|---|
| `github_releases` | ✅ P0 开放 | `owner` / `repo`（白名单字符集，非 URL） |
| `github_repo`（P1-04） | ✅ 开放 | `owner` / `repo`（同上） |
| `npm_package`（P1-04） | ✅ 开放 | `name`（含 scope）/ `tag`（默认 `latest`；白名单字符集，非 URL） |
| 预置来源模板（`rss_atom` / `html_static` 的固定实例） | ✅ P0 开放 | 无（URL 是代码内常量） |
| `rss_atom`（自定义 `feedUrl`） | ⚠️ 有条件支持 | 任意 http/https URL |
| `html_static`（自定义 `pageUrl`） | ⚠️ 有条件支持，**排在 P0 最后**（P0-18） | 任意 http/https URL |

#### 3.1.1 适配器的三个"共享真相"必须只有一份

P1-04 一次加了两个适配器，同时暴露了三个"同一件事被写在两处"的地方。三处都已收敛：

| 真相 | 唯一来源 | 曾经漂移的代价 |
|---|---|---|
| 有哪些来源类型 | **适配器注册表**（`listAdapters()`）；`domains.js` 的 `SOURCE_TYPES` 由它推导 | 持久化设施 `open()` 逐条校验记录，一条记录的 `type` 不在枚举里 → **整个域打不开**，所有读写全部 `STORAGE_OPEN_FAILED`（[TECH-SPIKE.md](TECH-SPIKE.md) §6.10.4） |
| 来源的默认名字 | **适配器自己的 `defaultName(config)`**；`service.js` 的 `defaultNameFor()` 只是回退 | 配置里没有 URL 的类型会退化成字面量类型名，界面出现一张叫 `github_repo` 的卡片 |
| owner/repo 的合法字符集、ISO 时间解析、GitHub 错误文案 | `adapters/github-common.js` | 两个适配器各写一份，改一处忘一处 |

**由此得到两条硬规则**：

1. **任何"取值集合"都不得手写第二份** —— 枚举类型的权威是注册表，能推导就推导。手写第二份清单等于给自己留一个"加了东西忘了改这里"的开关。
2. **每一个会被持久化的字段都必须在 `domains.js` 里声明**。未声明的键会被结构校验器**静默丢掉**，症状是"设置完看着生效、重开域又回到默认值"—— 一个只在重启后才暴露的静默失效（P1-01 的 `intervalMinutes` 就真的这样丢过）。

#### 3.2.1 `github_releases`

| 项 | 设计 |
|---|---|
| 首选数据源 | `https://github.com/<owner>/<repo>/releases.atom` — 公开 Atom Feed，结构化、无鉴权 `[外部]` |
| 配置 | `{ owner: string, repo: string }`，`owner`/`repo` 必须匹配 `^[A-Za-z0-9._-]+$`（拒绝 `/`、`..`、空格） |
| 规范化 URL | 由 `owner`/`repo` 拼接，不接受用户直接填 URL（消除 SSRF 面） |
| 条目粒度 | 每个 `<entry>` = 一个 release；`itemId` = entry 的 `<id>` |
| 版本识别 | 从 `<title>` 提取 tag（形如 `dsh-0.2.0-rc.2-...`） |
| 失败原因 | `401/404` → 仓库不存在或非公开；非 XML 内容类型 → 结构不匹配 |
| 备用路线（P1） | GitHub REST `/repos/{o}/{r}/releases?per_page=N`（`application/json`，分类为 `text`）`[已核实内容类型分类]`；未鉴权调用有速率限制 `[外部]`，**未在本机实测** |

#### 3.2.2 `rss_atom`

| 项 | 设计 |
|---|---|
| 配置 | `{ feedUrl: string }`，必须是 `http:`/`https:`，长度 ≤ 2048（与 DSH 抓取上限一致） |
| 接受的内容类型 | `application/rss+xml` / `application/atom+xml`（`+xml` 后缀）/ `application/xml` / `text/xml`。DSH 抓取层把 `+xml` 归为 `text`，因此可用 `[已核实]` |
| 条目粒度 | 每个 `<item>`（RSS 2.0）或 `<entry>`（Atom）一条；`itemId` 优先 `<guid>`/`<id>`，缺失时用内容指纹 |
| 正文优先级 | `<content:encoded>` > `<description>`/`<summary>` > `<title>` |
| 时间 | `<pubDate>`（RFC 822）/ `<updated>`（RFC 3339）；解析失败则置空，不猜测 |

#### 3.2.3 `html_static`（**有条件支持**）

| 项 | 设计 |
|---|---|
| 配置 | `{ pageUrl: string }` + 可选 `{ itemSelectorHint?: 'date-heading' \| 'changelog-heading' \| 'none' }` |
| 支持判据 | 抓取成功 **且** 正文抽取产出 ≥ 1 个有效区块 **且** 结构稳定（连续两次抓取的结构指纹一致） |
| 不支持时 | 明确返回 `ADAPTER_STRUCTURE_UNSUPPORTED`，**不创建该来源为可用状态**，UI 显示「暂不支持该页面结构」 |
| 抽取策略 | 见 §4.2；不使用通用「正文算法」，只做保守的标签剥离 + 块切分 |
| 条目粒度 | 按标题级块（`h1`–`h4`）切分；无法切分时整页作为单个条目，`itemId` = 内容指纹 |
| 明确不支持 | JS 动态渲染、需登录、反爬跳转、`<script>` 注入内容的页面 |

**「不使用脆弱通用抓取器制造虚假可用性」的实现方式**：`html_static` 在结构判据不满足时**拒绝注册成功**，而不是注册成功但永远返回 0 变化。

### 3.3 适配器注册表

`adapters/registry.ts` 导出 `Record<SourceType, SourceAdapter>` 与 `listTemplates()`（预置模板）。新增类型只需新增文件 + 注册，不改路由/存储/服务层。

---

## 4. 内容规范化与差异检测

### 4.1 规范化（deterministic）

```
原始响应体（分类 html|text）
  → 编码归一（charset 由抓取层解码，Host 不再二次猜测）
  → 剥离 <script>/<style>/<noscript> 及其内容
  → 剥离注释、标签，保留块级换行（</p> </div> <br> <li> <hN> → \n）
  → HTML 实体解码（&amp; &lt; &gt; &quot; &#39; &#x..; &#..; 常见命名实体）
  → 空白归一：连续空行压成一个 \n\n，行尾空白删除，\r\n → \n
  → 不可见字符剥离（除 \n \t 外的 C0/C1）
  → 长度裁剪到 MAX_NORMALIZED_TEXT_CHARS = 100000
  → 产出 normalizedText
```

- 同一输入必须产出同一输出（无时间、无随机、无 locale 依赖）。
- `normalizedText` 是**唯一**参与指纹与差异的文本，原始响应体**不落盘**。

### 4.2 结构化抽取

| 类型 | 方法 |
|---|---|
| GitHub Releases Atom | 规范化文本 + 额外解析 `<entry>` 列表 |
| RSS / Atom | 同上，按 entry 列表 |
| 静态 HTML | 标签剥离得到块列表 → 按 `h1`–`h4` 切分 → 每块保存标题与正文 |

### 4.3 指纹

```
itemFingerprint  = sha256(canonicalize(item.title) + "\n" + canonicalize(item.text))
contentFingerprint = sha256(normalizedText)
dedupeKey        = sha256(normalizedUrl + "|" + itemFingerprint)
```

- `canonicalize()` = 归一空白 + 大小写折叠（仅 ASCII）+ 去首尾。
- `normalizedUrl` 规则：小写 host、去 fragment、去跟踪参数（`utm_*`、`ref`、`source`、`fbclid` 等白名单外一律保留以保守）、去末尾 `/`、保留 query 的字典序（保守：**有 query 就全部保留并按 key 排序**）。
- **去重幂等**：刷新前先查已有 change 的 `dedupeKey` 集合；命中则只更新 `lastSeenAt`，不新建记录。

### 4.4 差异检测（无模型）

**条目级差异**（结构化来源）

```
added    = 新 items 中 itemId 不在上一快照的集合
removed  = 上一快照的 itemId 不在新 items 中
modified = itemId 相同但 itemFingerprint 不同
```

**文本级差异**（静态 HTML / 无法结构化的来源）

```
按行切分 → 公共前缀/后缀裁剪 → 中段逐行比对
产出 { addedLines, removedLines }，各截断到 MAX_DIFF_ITEMS = 200
```

**产出写入 change 记录**：

| 情况 | 是否新建 change |
|---|---|
| `added` 非空 | 是（每条新增一个 change） |
| `modified` 非空 | 是（该 item 一个 change） |
| 仅 `removed` | 是，但合并为一条汇总 change |
| 全部为空 | 否，只更新 `snapshot` 与来源 `lastCheckedAt` |

**边界**
- **首次抓取无上一快照** → 不产生 change，记录 `baseline: true`，详情页显示「首次抓取，无对比基线」。
- **抓取失败** → 不产生 change，不改 snapshot，只更新来源失败状态。
- **内容被截断**（`truncated: true`）→ 必须在 change 上标记 `truncated: true`，详情页明示，差异结论降级为「基于截断内容」。

---

## 4.6 调度与并发（P1-01，已实测定稿）

### 4.6.1 为什么是"一个循环"

调度器（`src/host/scheduler.js`）只有**一个 60 秒循环**，不是"每个来源一个定时器"。200 个来源就是 200 个定时器，每个都要自己处理"上一次没跑完"、释放、HMR 重载三件事 —— 三处都容易各错一次。一个循环之后**并发控制只剩服务层那一份 `inFlight` 集合**。

副产品是好的：宿主休眠错过的时点会在下次唤醒自然补上（判定条件是 `lastCheckedAt + interval <= now`，**不是**"距上次 tick 多久"），慢来源也不阻塞其它来源的到期判断。

### 4.6.2 到期判定的两条纪律

1. **用 `lastCheckedAt`，不用 `lastSuccessAt`。** 一直失败的来源若按"上次成功"算就永远不再重试，自动停用机制反而永远触发不了。
2. **从未检查过 → 立刻到期。** 用户刚打开开关就该看到一次真实结果，而不是等一个间隔周期。

### 4.6.3 并发控制的唯一落点

`inFlight` 集合放在**服务层**，因为手动刷新与定时刷新走的是同一个 `refresh()`；各自维护会出现"两边都以为自己在刷"。已经在飞的来源在下次 `refresh()` 里被归入 `skipped`，错误码 `REFRESH_IN_FLIGHT`。

### 4.6.4 定时器设施的选择与降级

采用 `@deepseek-ai/cordis-plugin-timer` 的 `ctx.interval()`（**释放感知**：句柄注册在当前 fiber 上，插件被 dispose 时自动清理）。`@deepseek-ai/dsh-schedule` **不可用** —— 它是按会话绑定的提醒投递服务，且要启用必须挂实验性 bundle。

**`timer` 不写进 `ctx.inject`**：设施永远不出现时 inject 回调永不执行，插件会以"完全不存在"的方式失败。改为 `ctx.get('timer')` 主动探测；探测不到就降级到全局 `setInterval` 并标注 `degraded: true`；连全局定时器都没有才报 `available: false` + `reason`，客户端据此**禁用**间隔选择器并显示原因。

### 4.6.5 失败与自动停用

- 间隔夹取 `[15, 1440]` 分钟，`0` 表示关闭。`normalizeIntervalMinutes()` **契约是不抛错**（间隔是可选偏好，填错不该让整个来源保存失败）。
- 连续 `AUTO_DISABLE_FAILURE_STREAK = 3` 次失败 → `enabled = false` + `autoDisabledAt` + `autoDisabledReason`（人话，含最近一次错误码）。**自动停用必须可见**，否则它就是静默丢弃。
- 重新启用时**清零计数并清掉自动停用的痕迹**：不重置的话重新启用后第一次失败就再撞阈值，用户会觉得开关坏了。

---

### 4.7 快照历史与保留等级（P1-02）

#### 4.7.1 保留等级必须显式落字段

快照记录的 `textTruncated` 在**两个地方**被置真，对用户的意义完全相反：

| 场景 | 触发点 | 当时的 `textChars` | 用户该看到 |
|---|---|---|---|
| 来源本身很长 | 规范化阶段超过 `MAX_NORMALIZED_TEXT_CHARS` | 顶到上限 | 「来源很长」 |
| 我们只留了摘录 | 裁剪阶段超过 `MAX_FULL_TEXT_SNAPSHOTS` | ≤ `MAX_OLD_SNAPSHOT_CHARS` | 「**仅保留摘录**」 |

因此快照记录新增 `retention: 'full' | 'excerpt'`（写入侧：`refreshOne` 写 `'full'`，`planTrim()` 压成摘录时写 `'excerpt'`；**`planTrim()` 在 `src/host/limits.js`，不在 `service.js`** —— 改错文件会静默 no-op）。读取侧统一走 `retentionOf(snapshot)`：显式字段优先，长度回退推断**只服务于 P1-02 之前落盘的旧记录**。

#### 4.7.2 差异链在快照上重算，不读变化记录

`chainLink(previous, snapshot)` 用 `itemIds` + `itemHashes` 做集合差与指纹比对，得出 `{baseline, added, removed, modified, itemCount, capped}`。

- **不得用 `itemCount` 相减**推断增删 —— 那会把"删了 3 条又加了 3 条"说成"没有变化"。
- `capped` 必须暴露：`itemIds` 被 `MAX_ITEM_IDS` 截断，超限时计数**只是下限**。
- **分页不得伪造基线**：`listSnapshots()` 的 `previous` 取 `full[index + 1]`（被截断掉的那一份），列表尽头的链依然是真的。

#### 4.7.3 列表不给正文

`snapshotSummary()` **刻意不返回 `normalizedText`**（20 份 × 10 万字符 = 数兆字节）。列表只给摘要与 `excerpt`；正文走 `GET /snapshots/:id` 按需取，并受 `MAX_SNAPSHOT_VIEW_CHARS = 20000` 约束，超限时回 `textTruncatedByView` 与 `maxViewChars`，界面如实说明裁了多少。

#### 4.7.4 「新增 N 条」与「M 条变化记录」不是同一件事

幂等规则（§4.4）下，重复看到的内容不新建记录，于是真实历史里会出现「+20 新增 / 1 条变化记录」。**这不是矛盾，但界面上必须把原因说出来**，文案为「这份快照关联 N 条变化记录」，并在 `added + modified > changeIds.length && !baseline` 时追加「其余新增/修改的条目在更早的抓取里已经记过，按幂等规则不重复记录」。**不得把数字悄悄对齐**。

---

### 4.8 导出与不可信内容（P1-05）

#### 4.8.1 导出必须走一个**显式**的原始响应出口

插件 Host 的默认契约是所有 handler 返回值包成 JSON 信封。Markdown 导出若也走信封，用户在浏览器里打开就是**一坨 JSON**，拿不到文件。做法是 `http.js` 导出 `RAW_RESULT`（一个 `Symbol`）：只有 handler 显式返回 `{ [RAW_RESULT]: { text, contentType, filename } }` 时才绕过信封，**其余路由的行为一个字节都不变**。原始出口自己负责：

- `content-disposition: attachment; filename="…"`，文件名先过 `replace(/[^A-Za-z0-9._-]/g, '_')`（不让文件名里的引号或换行破坏响应头）；
- 体积闸门（复用 `MAX_RESPONSE_BYTES`），超限回 500 `INTERNAL` + `responseTooLarge` + 可行动提示（"请分批导出，用 `?ids=` 指定几条"）；
- `REDACT`（和其他响应一样，绝不回显本机绝对路径）。

**不许**为了让某个功能好用而改默认信封 —— 那是 Client 与宿主之间的契约。

#### 4.8.2 事实 / 推测分区是**数据来源**的边界

| 分区 | 唯一允许的来源 |
|---|---|
| 事实 | `changes` / `snapshots` / `sources` 三张表（**全部由真实抓取写入，无一条来自模型**） |
| 推测与判断 | 使用者自己写的 `judgment` / `questions` / `nextAction` |

- 一边为空时**明说为空**（"没有关联任何一次抓取记录…"/"（还没有写…）"），**不留空标题** —— 空标题会被读成渲染失败或"没有异常"。
- **不得**把使用者的判断挪进事实区充数。

#### 4.8.3 导出内容按**不可信**处理

导出文件会被贴进别人的笔记或仓库，而里面既有使用者写的自由文本，也有**从公网抓回来的原文摘录**。因此 `safeInline()` 是"贴进正文的文字"的唯一通道，做两件事：

1. **拆掉非 `http(s)` 的 URI 方案**（`javascript:` → `javascript：`）；
2. **转义能构成链接、自动链接、代码段或原始 HTML 的字符**（`[ ] < > \``）。

理由：`javascript:` 作为纯文本不会被点开，但只要出现在 `[文字](这里)` 或 `<这里>` 的位置就成了可点击的陷阱。安全做法不是"记得别那么写"，而是**让它不可能是一个合法 URI**。`quoted()`（原文摘录）逐行也走 `safeInline()`。**强调标记（`*` `_`）刻意不转义**：它们最多改变外观，到处加反斜杠会让源文件不可读。

#### 4.8.4 导出是**只读**的，且永远不写用户的项目目录

- 服务层 `exportOpportunities()` 不写任何记录（有测试断言导出前后四张表逐字节相同）。
- `?ids=` 指定时**任何一个找不到就整体失败**（`NOT_FOUND`）—— 导出一半、静默漏掉几条比导出失败更糟，用户会以为文件是完整的。
- 落盘由**浏览器**完成（`Blob` + `<a download>`），**不经过任何后端写文件**。界面上的提示必须说清这一点。

## 5. 持久化 schema

### 5.0 实测定稿（2026-10-09，Milestone 1）——**先读这一节**

本节记录的结论**已经在本机运行时实测**，优先级高于其后的设计推演。证据见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.4。

| 决定 | 内容 | 理由（实测） |
|---|---|---|
| **D-1 零运行时依赖** | 插件 `package.json` **不声明任何 `dependencies`**；不用 zod、不用第三方 schema 库 | ①外部（`link:`）插件**解析不到** `@deepseek-ai/dsh-storage-domain`（`ERR_MODULE_NOT_FOUND`）；②`link:` 协议**不会为被链接包安装其 `dependencies`**，所以声明 zod 也不会让 `import 'zod'` 在自己的目录内可解析；③官方后端**接受以数据形状字面量声明的 `DomainSpec`** |
| **D-2 官方 helper 为「最佳努力」** | 用 `await import('@deepseek-ai/dsh-storage-domain')` **动态**探测：拿得到 `defineDomain` / `domainTable` 就走官方 helper（记为 `specMode: 'official'`）；拿不到就退回**同形状字面量**（`specMode: 'inline'`）。**必须是动态 import** —— 静态 import 会让插件在解析期整体失败 | `defineDomain(spec)` 是**纯校验后原样返回**；`domainTable(schema)` 就是 `{ valueSchema: schema }`；facility 只调用 `.safeParse(null)` / `.parse(raw)`，全文件**无 `instanceof`** → 两条路径语义等价 |
| **D-3 自带极小校验器** | `src/host/store/schema.js` 实现与 zod **同表面**的 `{parse, safeParse}` 校验器（`SchemaError` 带 `issues`），只在 Host 侧使用 | 保住「坏记录必须被拒绝」的语义，同时不引入依赖 |
| **D-4 读服务必须用 `ctx.get()`** | `ctx.get('storageDomain')`，**不得写 `ctx.storageDomain`** | 直接读未 `inject` 的服务属性会抛 `Error: cannot get property "storageDomain" without inject`，进而在 `apply()` 内变成一个**未处理的拒绝**，把整个宿主进程打成 `dsh: fatal load failure`（已实测触发一次） |
| **D-5 存储初始化永不抛出** | `openRadarStore()` 外层 `try/catch` 兜底，任何失败都返回 `{ok:false, specMode, reason}` 并由 UI 显示原因；调用方对返回的 promise 补 `.catch()` | 同上：**一个未处理的拒绝 = 整个宿主进程死亡**，不是本插件自己的失败 |
| **D-6 持久化判据** | `global.openCount` 每次成功打开自增并写回；**重启后必须变大** | 这是「存储真的成立」唯一的可证伪判据。实测：隔离宿主重启后 `1 → 2`，`firstOpenedAt` 保持不变 |
| **D-7 后端** | 只用 JSON 后端（`root = $DSH_HOME/storages`）；**不做 SQLite 假设** | 运行时无 SQLite storage 后端 |

**实测落盘形状**（`$DSH_HOME/storages/ai_product_radar_sources.json`，273 B）：

```json
{
  "unit": { "name": "ai_product_radar_sources", "version": 1 },
  "global": { "schemaVersion": 1, "openCount": 1, "firstOpenedAt": "…", "lastOpenedAt": "…" },
  "tables": { "sources": {} }
}
```

> `src/host/store/index.js` 里 `resolveFacility(ctx)` 的写法（**这是本文件里最容易写错的一处**）：
> `typeof ctx?.get === 'function' ? ctx.get('storageDomain') : /* 仅单测假 ctx 用 */ …`。
> 已为其加了 3 条回归测试（用 `Object.defineProperty` 造一个「属性读取必抛」的 ctx，断言实现只走 `ctx.get`）。

### 5.1 存储接口核验结论（先于 schema）

**核验对象**：`$PKG/dsh-storage`、`$PKG/dsh-storage-json`、`$PKG/dsh-storage-domain` 的 README 与 `lib/types/**/*.d.ts`、`lib/index.js`。

**结论：记录枚举是公开支持的，无需自建目录索引即可实现收件箱/来源/机会三类列表。**

| 能力 | 是否有公开接口 | 依据 |
|---|---|---|
| 单条读 | ✅ `KvTable.get(key): V \| undefined`（同步，来自内存） | `dsh-storage-domain/lib/types/domain.d.ts` |
| **枚举全部记录** | ✅ `KvTable.entries(): IterableIterator<[K,V]>` | 同上 |
| **枚举全部键** | ✅ `KvTable.keys(): IterableIterator<K>` | 同上 |
| 记录数 | ✅ `KvTable.size: number` | 同上 |
| 写 / 删 / 原子改 | ✅ `put` / `delete` / `update(key, fn)` | 同上 |
| **分页** | ❌ 无接口 | 需自行在内存分页 |
| **筛选 / 排序** | ❌ 无接口 | 需自行在内存 filter/sort |
| 二级索引 / 多段键 | ❌ 无（README 明示） | `dsh-storage-domain/README.zh.md` |
| 跨表事务 | ❌ 无 | 同上 |
| 迭代顺序保证 | ❌ **未声明有序**；语义是「快照，不是实时视图」 | `domain.d.ts` 原文：*A snapshot, not a live view: iteration stays stable while queued writes land* |

**因此的设计决定**
1. **列表查询（筛选/排序/分页）在 Host 内存中完成**：`open()` 时全部记录已被校验并加载进内存，`entries()` 是内存快照迭代，全表扫描成本可控。
2. **永远显式排序**：迭代顺序未声明，任何列表输出都必须带明确的排序键（`discoveredAt` desc 为默认）。
3. **必须做上限控制**：因为 `open()` 会把整个 unit 载入内存，记录数不能无界增长（见 §5.4）。
4. **不需要目录索引**。仅在 P1 若出现性能问题，才按 §5.5 引入可选的索引缓存（该设计仍完整给出，因为它同时是「部分失败/崩溃恢复/一致性」的通用答案）。

#### 5.1.1 列表查询契约（**不得只依赖单条 `get`/`put` 证明列表可行**）

产品的三个列表（变化收件箱、关注源、产品机会池）都是**集合查询**。仅证明「能写一条、能读一条」不能证明列表可行。本插件因此把列表查询写成一条**明确的、与存储能力逐项对齐的契约**，并逐条标注它依赖 §5.1 表格中的哪一个公开接口：

```ts
// src/host/store/query.ts —— 所有列表的唯一实现，路由与其它模块不得自行遍历 `entries()`
type SortKey = 'discoveredAt' | 'publishedAt' | 'sourceName' | 'status'
interface ListQuery {
  filter?: Record<string, string | string[] | undefined>  // 来源 id / 来源类型 / 处理状态
  search?: string          // 关键词（对 title、excerpt、userNote 做大小写无关子串匹配）
  sort?: SortKey           // 默认 'discoveredAt'
  dir?: 'asc' | 'desc'     // 默认 'desc'
  offset?: number          // 默认 0，必须 >= 0
  limit?: number           // 默认 PAGE_SIZE_DEFAULT(50)，上限 PAGE_SIZE_MAX(100)
}
function query<K, V>(table: KvTable<K, V>, q: ListQuery): { items: V[]; total: number; offset: number; limit: number }
```

映射关系（每一项都指向一个 `[已核实]` 的公开接口，**无一项依赖未声明的能力**）：

| 契约步骤 | 依赖的公开接口 | 说明 |
|---|---|---|
| 取全量候选集 | `KvTable.entries()` | 内存快照；`open()` 已完成校验与载入，无需额外读盘 |
| 过滤（来源 / 类型 / 状态） | 纯内存 `Array.prototype.filter` | 存储层无筛选接口，故在 Host 完成 |
| 关键词搜索 | 纯内存子串匹配 | 不引入全文检索；规模上限见 §5.4 |
| 排序 | 纯内存 `sort`（显式键 + 稳定次序 tie-break） | 迭代顺序未声明有序，**必须显式排序** |
| 计数 | 排序前 `filtered.length` → `total` | 不用 `KvTable.size`（那是全表大小，不是过滤后大小） |
| 分页 | `sorted.slice(offset, offset + limit)` | 存储层无分页接口，故在 Host 完成 |

**契约的强制方式**
1. 所有 `/apradar/*` 的列表端点**只能**调用 `query()`；代码评审禁止在路由层直接写 `for (const [k, v] of table.entries())`。
2. 契约测试（L2）必须覆盖：空表、单条、恰好 `limit` 条、`limit + 1` 条、`offset` 越界、`limit` 超上限被钳制、`sort` 为每个枚举值、过滤后为空但 `total` 正确、关键词含大小写与中文。
3. **`total` 与 `items` 必须来自同一次快照遍历**，避免出现「先 count 再 list」导致的两个不一致视图。

**为什么这在当前规模下成立**：`open()` 已把整个 unit 载入内存，最坏情况是 `MAX_CHANGES = 2000` 条 + `MAX_SOURCES = 200` 条 + `MAX_OPPORTUNITIES = 500` 条，单次全表扫描 + filter + sort 都在毫秒级，且只在用户操作时发生（无定时后台任务）。**上限控制（§5.4）是这条契约成立的前提**，二者必须一起实现，不能只做其一。

### 5.2 Domain 划分

领域名与表名必须匹配 `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/`（`$PKG/dsh-storage/lib/index.js:80` `[已核实]`）；记录键必须匹配 `SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/`（`$PKG/dsh-storage-json/lib/index.js:302` `[已核实]`）。**因此所有 id 采用 `[0-9a-z]` + `-` 的 ULID 风格字符串，禁止 `.`、`:`、`/`。**

| Domain | 版本 | `layout` | `invalidRecords` | 理由 |
|---|---|---|---|---|
| `ai_product_radar_sources` | 1 | `single`（默认） | 不设（默认拒绝） | 权威配置，损坏必须立刻暴露，不能静默丢弃 |
| `ai_product_radar_snapshots` | 1 | `per-record` | `'backup-and-skip'` | 记录大、稀疏、可单独丢弃；正是 `per-record` 的设计场景 |
| `ai_product_radar_changes` | 1 | `per-record` | `'backup-and-skip'` | 派生数据，单条损坏不应导致整个 unit 打不开 |
| `ai_product_radar_opportunities` | 1 | `single`（默认） | 不设（默认拒绝） | 用户手写内容，权威，绝不静默丢弃 |

只使用 **JSON 后端**（`backend: json`）——本运行时**没有** `dsh-storage-sqlite` `[已核实]`（`$PKG` 下仅有 `dsh-session-query-sqlite`，那是会话全文检索，不是 storage 后端）。

### 5.3 记录 schema

所有 schema 用**本插件自带的极小校验器**声明（`src/host/store/schema.js`，与 zod 同表面：`{parse, safeParse}`），经 `domainTable(schema)` 注入 —— 该形参在**类型**上是 `ZodType<V>`（`$PKG/dsh-storage-domain/lib/types/spec.d.ts` `[已核实]`），但 facility **运行时只调用 `safeParse`/`parse`，无 `instanceof`**，因此同表面的对象即可（`[已实测]`：正式插件用字面量 spec 成功落盘）。时间统一为 **epoch 毫秒整数**（JSON 友好、可排序、无时区歧义）。

**为什么不再用 zod（2026-10-09 实测反转，取代本节的旧结论）**

- 旧结论是「在插件 `dependencies` 里显式声明 zod」。**实测证明这条路走不通**：
  1. 外部（`link:`）插件**解析不到** `@deepseek-ai/dsh-storage-domain` —— 它不在 profile 的 `node_modules` 里（`~/.dsh/profiles/tauri/node_modules/@deepseek-ai/` 下只有 `cosmokit`、`schemastery`），插件裸 import 报 `ERR_MODULE_NOT_FOUND`（同类失败亦见于 `@deepseek-ai/dsh-settings`）；
  2. **`link:` 协议不会为被链接包安装其 `dependencies`** → 在插件 `package.json` 里写 `"zod": "^4.4.3"` 也**不会**让 `import 'zod'` 在自己目录内可解析；
  3. profile 顶层那份 zod 是 **4.1.8** 且**未声明**（来自 `billion-context`）→ 幻影依赖，低于该 API 声明的 `^4.4.3`，不可依赖。
- **替代方案**（见 §5.0）：插件自带校验器 + **数据形状字面量 spec** + 启动时 `await import('@deepseek-ai/dsh-storage-domain')` 动态探测官方 helper（拿到就用，拿不到就退回字面量，记为 `specMode: 'official' | 'inline'`）。
- **必须是动态 import**：静态 import 会让插件在**模块解析期**就整体失败，连解释都留不下。
- `defineDomain(spec)` 是**纯校验后原样返回 spec**、`domainTable(schema)` 就是 `{ valueSchema: schema }` `[已核实]` → 两条路径语义等价。

**`sources`**

```ts
{
  id: string,                       // ulid
  type: 'github_releases' | 'github_repo' | 'npm_package' | 'rss_atom' | 'html_static',
  name: string,                     // ≤ 80
  config: Record<string, unknown>,  // 由 adapter.normalizeConfig 产出
  canonicalUrl: string,             // ≤ 2048，去重与展示用
  enabled: boolean,
  createdAt: number,
  updatedAt: number,
  lastCheckedAt?: number,
  lastSuccessAt?: number,
  lastStatus?: 'ok' | 'failed',
  lastError?: { code: SourceErrorCode, message: string, at: number },  // message ≤ 300
  structureFingerprint?: string     // html_static 的稳定性判据
}
```

**`snapshots`**

```ts
{
  id: string,                       // `${sourceId}_${fetchedAtBase36}`
  sourceId: string,
  fetchedAt: number,
  url: string,                        // = WebFetchResult.url（重定向后的最终地址）
  statusCode: number,
  contentFingerprint: string,
  normalizedText: string,           // ≤ MAX_NORMALIZED_TEXT_CHARS
  textChars: number,
  truncated: boolean,               // 来自抓取层 truncated 或本地上限
  itemCount: number,
  itemIds: string[],                // ≤ MAX_ITEM_IDS = 500，用于条目级差异
  itemHashes: Record<string,string>,// itemId → 内容指纹，用于判定 modified
  baseline: boolean,                // 是否首次抓取
  retention: 'full' | 'excerpt'     // 保留等级；见 §4.7.1。旧记录可能缺此键，读时走 retentionOf()
}
```

**`changes`**

```ts
{
  id: string,                       // ulid
  sourceId: string,
  snapshotId: string,
  previousSnapshotId?: string,
  dedupeKey: string,                // sha256 十六进制
  title: string,                    // ≤ 300，来自原文标题，不润色
  publishedAt?: number,             // 官方发布日期，仅当来源给出
  discoveredAt: number,             // 本地发现时间
  kind: 'added' | 'removed' | 'modified' | 'summary',
  diffSummary: string,              // ≤ 500
  diffDetail?: {                    // 各数组 ≤ MAX_DIFF_ITEMS
    added: string[], removed: string[], modified: string[]
  },
  excerpt: string,                  // ≤ MAX_EXCERPT_CHARS = 4000，原文摘录
  truncated: boolean,
  status: 'unread' | 'seen' | 'ignored' | 'pooled',
  lastSeenAt: number,
  userNote?: string,                // ≤ 2000
  opportunityId?: string
}
```

**`opportunities`**

```ts
{
  id: string,
  title: string,                    // ≤ 200
  sourceId?: string,
  changeId?: string,
  projectRef?: string,              // ≤ 200，用户填写的项目标识
  judgment?: string,                // ≤ 4000 —— 用户判断（推测区）
  questions?: string[],             // ≤ 20 条，每条 ≤ 300
  nextAction?: string,              // ≤ 300
  status: 'to_research' | 'verifying' | 'planned' | 'dropped',
  createdAt: number,
  updatedAt: number
}
```

**事实与推测在数据层的分离**：`title`/`publishedAt`/`diffDetail`/`excerpt`/`snapshotId` 属于**事实字段**，只由 Host 从抓取结果写入，Client 无写权限；`userNote`/`judgment`/`questions`/`nextAction`/`projectRef` 属于**推测字段**，只由用户写入。两类字段在 PATCH 接口层就分开鉴权（见 §6.2），不可能被互相覆盖。

### 5.4 上限控制

```ts
// limits.ts —— 单一事实来源，同时暴露给 UI（GET /apradar/meta）
MAX_SOURCES               = 200
MAX_SNAPSHOTS_PER_SOURCE  = 20      // per-record，超出删最旧
MAX_FULL_TEXT_SNAPSHOTS   = 2       // 只保留最近 2 份完整正文
MAX_OLD_SNAPSHOT_CHARS    = 2000    // 更旧的快照只留摘录
MAX_CHANGES               = 2000    // 全局
MAX_CHANGES_PER_SOURCE    = 200
MAX_OPPORTUNITIES         = 500
MAX_NORMALIZED_TEXT_CHARS = 100000  // 与抓取层 maxBodyChars 默认值一致 [已核实]
MAX_EXCERPT_CHARS         = 4000
MAX_DIFF_ITEMS            = 200
MAX_ITEM_IDS              = 500
FETCH_CONCURRENCY         = 2       // DSH 全仓无并发闸门常量 [已核实]，本插件自带
PAGE_SIZE_DEFAULT         = 50
PAGE_SIZE_MAX             = 100
```

**裁剪时机**：每次成功写入批次结束后调用 `limits.trim()`；裁剪是幂等的，可在 `open()` 后安全重跑。

**单源快照总正文上限估算**：`2 × 100,000 + 18 × 2,000 ≈ 236,000 字符/源`；200 源上限 → 最坏约 47 MB。因此 `MAX_SOURCES` 之外还应提供「当前占用」提示（`GET /apradar/meta` 返回 `estimateBytes`），并在超过软阈值时在 UI 提示。

### 5.5 目录索引（可选，P1，非 P0 关键路径）

**前提**：正确性**不依赖**它——`keys()`/`entries()` 已是权威枚举来源。索引只是「避免全表扫描」的缓存，且**永远不可作为唯一真相**。

若引入，设计如下：

| 项 | 策略 |
|---|---|
| 形态 | 在同 domain 内增加 `index` 表，只放一条记录，键固定为 `index`，值为 `{ ids: string[], updatedAt: number, tableSize: number }` |
| 更新 | 每次 `put`/`delete` 成功后，在同一领域写链上 `update('index', …)`。**不保证原子**：`KvTable` 每次写入只触碰一条记录，无跨表事务 `[已核实]` |
| 部分失败 | 记录写成功但索引写失败 → 记录仍已持久；索引落后。**读路径永远走 `entries()`**，索引不参与正确性 |
| 崩溃恢复 | `open()` 成功后执行 `reconcile()`：比较 `index.ids` 与 `new Set(table.keys())`；不一致即用真实键集合重写索引，并把 `tableSize` 对齐。全表扫描在内存中完成，代价可控 |
| 一致性判据 | 只有 `index.tableSize === table.size` **且** 集合相等时索引才被视为可信 |
| 兜底 | `reconcile()` 抛错时禁用索引并降级为全表扫描，记 warning，不影响功能 |

**结论**：索引在当前记录规模（≤ 2000 变化 + ≤ 200 来源 + ≤ 500 机会）下**不必要**，列为 P1 可选优化。

### 5.6 版本迁移与损坏记录

| 场景 | 行为 |
|---|---|
| 版本一致 | 正常 `open()` |
| 需新增可选字段 | 保持 `version` 不变，新字段声明为 optional → 旧记录仍能被 schema 接受，**无需迁移** |
| 必须改字段语义 | `version++`，同时把旧版本列入 `compatibleVersions`（须保证当前 schema 也能接受旧记录），由 Host 在 `open()` 后执行一次性 `migrate()` 重写记录 |
| 无 `compatibleVersions` 且版本不符 | `open()` 以 `version-mismatch` 拒绝 → **UI 显示阻塞式错误 + 恢复步骤**，绝不自动删除数据 |
| `snapshots`/`changes` 单条损坏 | `invalidRecords: 'backup-and-skip'`：后端把该记录文档移走（`KvUnit.backupRecord`，`$PKG/dsh-storage-json/lib/types/per-record-unit.d.ts:69` `[已核实]`），记日志，`open` 继续，该记录视为不存在 |
| `sources`/`opportunities` 单条损坏 | 默认拒绝：`open()` 抛 `invalid-record`（`DomainError.detail = {table, key}`）→ UI 显示是哪张表哪个键坏了 + 备份路径指引；**不自动丢弃用户数据** |
| global 槽损坏 | 永远拒绝（官方语义）`[已核实]` |

**注意**：`invalidRecords: 'backup-and-skip'` 只在 `layout: 'per-record'` 且后端具备 `backupRecord` 时生效；否则回退为拒绝 `[已核实]`。这也是把 `snapshots`/`changes` 设为 `per-record` 的原因之一。

### 5.7 句柄生命周期

```ts
ctx.effect(async () => {
  const domains = {
    sources:       await ctx.storageDomain.open(sourcesSpec),
    snapshots:     await ctx.storageDomain.open(snapshotsSpec),
    changes:       await ctx.storageDomain.open(changesSpec),
    opportunities: await ctx.storageDomain.open(opportunitiesSpec),
  };
  await limits.trim(domains);          // 崩溃后重启的兜底裁剪
  return async () => {                 // disposer：调用方拥有句柄生命周期
    await Promise.all(Object.values(domains).map(d => d.close()));
  };
});
```

- **句柄所有者是插件**，不是 facility；必须显式 `close()`（通常在 `ctx.effect` 的释放函数里）。
- 领域名 `already-open` 是编程错误 → 用模块级 promise 保证只打开一次。
- **卸载插件不会清理 `$DSH_HOME/storages/*`** `[已核实]`（plugin-manager 恢复只重写快照的两个文件）→ 数据会留存，UI 必须告知用户，并提供显式「清除全部数据」。

### 5.8 写入失败恢复与索引重建（JSON 单后端的必答项）

选择 JSON 单后端（不引入 SQLite）意味着**没有事务、没有索引、没有并发控制**。因此必须显式回答四件事：写入失败怎么办、部分失败怎么办、崩溃后怎么办、索引（若启用）怎么重建。

#### 5.8.1 并发与写链

- 同一个 `KvTable` 的写入必须**串行化**。实现方式：宿主端每条 domain 持有自己的 `Promise` 队列（`writeChain = writeChain.then(op)`），所有 `put`/`delete`/`update`/`trim` 都进这条链。
- `KvTable.update(key, fn)` 本身在写链上原子读改写 `[已核实]`，但它**不覆盖跨记录**的读改写，所以跨记录的读改写（例如「写快照 + 写变化」）必须在**我们自己的**写链上串行。
- 不使用 `await Promise.all()` 去写同一张表的多个键（会交错）。

#### 5.8.2 单次写入失败

| 步骤 | 失败时的行为 |
|---|---|
| 组装记录 → schema 校验 | 校验失败是**编程错误**，不进存储：抛错并记 error 日志，UI 显示「内部错误」，不显示「保存失败」 |
| `table.put()` 被拒绝 | 记录**未写入**。来源刷新本身**仍然完成**（快照/变化的内存态丢弃或标记为未持久化），UI 显示「保存失败：<原因>」，**绝不显示「已保存」** |
| 内存态已更新但写失败 | 内存态必须**回滚**到写之前的值（写前先取旧值，失败即恢复），否则 UI 会显示一个并不存在的数据 |
| 键不合法（不匹配 `SAFE_KEY_RE`） | 写入期即拒绝 `[已核实]`，视为编程错误，同上 |

**统一不变量**：UI 的「已保存」只能由一次**成功 resolve 的写入**触发（见 [PRD.md](PRD.md) §6.6）。任何 unresolved / rejected 的写入都不得显示为已保存。

#### 5.8.3 跨记录部分失败

一次刷新可能写「1 条来源状态 + N 条快照 + M 条变化」。JSON 单后端**没有跨表事务** `[已核实]`，因此无法做到全有全无。采用**有方向的收窄策略**：

1. **写入顺序固定为：快照 → 变化 → 来源状态**。原因：来源状态是「这次检查成功了」的断言，必须最后写，否则会出现「状态说成功但快照没落下」。
2. 快照写失败 → **中止本次刷新的写入批次**，不写变化、不写来源状态；来源状态标记为 `failed(persist)`，UI 显示明确原因。
3. 快照成功但某条变化写失败 → 保留已写的快照与已写的变化，来源状态写为**部分成功**（`status: 'ok'` + `partialWrite: true` + 失败计数），UI 在来源行显示「部分写入失败（N 条）」。
4. 无论哪一步失败，都**不改动**本次失败之前已经持久化的历史记录——没有「回滚整个来源」的操作。
5. 崩溃恢复只做**幂等补偿**：`open()` 后重跑 `limits.trim()`（§5.4），并重算来源的 `lastSuccessAt`/失败计数（从已持久化的快照与变化推导），不做「补写」尝试。

#### 5.8.4 崩溃恢复

| 崩溃时点 | 重启后的状态 | 处理 |
|---|---|---|
| `put()` 返回前 | 该条记录要么在、要么不在（JSON 后端按文档原子写）`[已核实]` | 无需处理；下一次刷新会重新判定 |
| 批次进行到一半 | 已写的在，未写的缺 | 由 §5.8.3 的顺序保证「缺失的一定是较后的步骤」；重跑 `trim()` 后由用户手动再次刷新 |
| domain `open()` 抛 `invalid-record` | 见 §5.6 | UI 给阻塞式错误与恢复步骤，**绝不自动删除** |
| `open()` 抛 `version-mismatch` | 见 §5.6 | 同上 |

**不做**：不做 WAL、不做崩溃后的自动重放、不做「未完成任务队列」持久化——这些都需要事务语义，JSON 单后端不提供。宁可让用户手动再刷新一次。

#### 5.8.5 索引重建策略（仅在启用 §5.5 索引时适用）

索引**永远不是唯一真相**（§5.5）。因此重建是**无条件的、幂等的、可随时执行的**：

```
reconcile(table, indexHandle):
  1. if (index.tableSize === table.size) 且 keySet(index.ids) === keySet(table.keys()) → 索引可信，直接返回
  2. 否则：读 table.keys()（内存快照，不读盘）→ 按当前 sort 键重排 → update('index', () => ({ ids, updatedAt: Date.now(), tableSize: table.size }))
  3. 第 2 步失败 → 禁用索引（进程内标志），记 warning，**读路径永久降级为 `entries()` 全表扫描**，功能不受影响
```

触发时机（**三处都必须有**）：
1. 插件启动、`open()` 成功之后（覆盖「上次崩溃时索引落后」）。
2. 每一次 `put`/`delete` 成功之后（写后更新；失败不抛给调用方，只降级）。
3. 用户点「修复数据」时（P0-15 的诊断入口可复用）。

**一致性判据是唯一门槛**：`index.tableSize === table.size` **且** 键集合相等。不满足就重建，不做增量修补（增量修补在没有事务的前提下无法证明正确）。

#### 5.8.6 显式清除数据（`POST /apradar/maintenance/purge`）

JSON 后端把每个 domain 落成 `$DSH_HOME/storages/` 下的目录，**没有单条「drop」接口**，所以清除是按 `delete(key)` 逐条执行：

| 项 | 设计 |
|---|---|
| 范围 | `sources` / `snapshots` / `changes` / `opportunities` **四张表全部** |
| 二次确认 | UI 要求输入确认（或勾选「我明白这会删除全部本地数据」），确认文案必须**写明数据量**（N 个来源 / M 条变化 / K 条机会） |
| 顺序 | 先 `changes` → `snapshots`（派生、量大） → `opportunities` → `sources`；先删派生数据可让中途失败的结果处在「可继续删」而非「半残配置」状态 |
| 部分失败 | **逐条 best-effort**：`delete()` 返回 `false`（键不存在）不算失败 `[已核实]`；真实异常则停止并报告「已删除 X / 共 Y，原因是 Z」，**不假装成功** |
| 可重入 | purge 必须可重复执行，第二次对已删键返回 `false` 而非报错 |
| 索引 | 若启用了 §5.5 索引，purge 后**必须**跑一次 `reconcile()`（或直接丢弃索引） |
| 卸载行为 | **卸载插件不清理 `$DSH_HOME/storages/*`** `[已核实]`。此限制必须在**用户做出选择之前**可见：`README.md` 明示 + 插件「关于/诊断」区明示 + purge 的确认框里写明「卸载插件不会自动删除这些数据」 |

---

## 6. Host / Client 数据通信

### 6.1 P0 选定方案：自注册 HTTP 路由

**理由**：该路径有本机已验证的第三方实现（Knit 用 `ctx.inject(['webServer','sessions'], …)` + `webServer.register({kind:'prefix', path, handler})`，客户端用同源 `fetch` 调用）`[已核实]`；而 typert RPC 的严格模式需要生成的调用描述符，其在本打包运行时的可用性**未核实**。

> **✅ 闸门已通过（2026-10-09）——本节方案维持不变**
>
> V1 / T17 / T17b 已在 Milestone 0 与 Milestone 1 两轮实测中结清：
> 1. 右侧栏页签注册成功（Desktop 与隔离 Web Profile 均报 `官方右侧栏页签已注册：kind = apradar`）；
> 2. Client → Host 的同源请求可达（真实桌面宿主渲染进程内 `/apradar/state` → `200`，面板渲染出 Host 原始 JSON）；
> 3. Host 正常响应被正确解析；
> 4. **异常态**（500 错误码 / 200 非 JSON / 200 空体 / 404 / 超时）五项判定全为 true，界面不崩溃（`pageErrors: []`）。
>
> 因此**不需要**改用 Typert RPC（§6.3 / V4 已由 P1-06 结清为「运行时可用但本插件不采用」，且始终不升为 P0），正式 UI 可以开工。全部证据与限制见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.1 / §6.2 / §6.4。
>
> **一处必须如实披露的限制**：本机**无法自动化 Tauri 自己的 WKWebView**（无 CDP 端点），Desktop 侧证据来自**同一宿主、同一页面源、真实 Chromium 渲染进程**（系统 Chrome 访问 `http://127.0.0.1:3080/`）。这不是「Tauri WebView 本体」的证据。
>
> **开工具备的另一项实证**：正式插件装入正在运行的桌面宿主后**无需重启**即挂载（宿主 PID 84103 不变），`apply()` 直接在原进程内执行。

| 项 | 设计 |
|---|---|
| 前缀 | 常量 `ROUTE_PREFIX = '/apradar'`，`kind: 'prefix'` |
| 注册 | `const unregister = ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })`，在 `ctx.effect` 释放函数里 `unregister()` |
| 重复路径 | 同一张路由表内重复路径会抛错 `[已核实]` → 前缀必须是模块常量，禁止动态拼接 |
| 响应格式 | 一律 JSON：`{ ok: true, data }` / `{ ok: false, error: { code, message, detail? } }` |
| 错误 | **handler 内部捕获所有异常并返回 200 + `ok:false`**（不依赖框架的 400 兜底，也不让它记 warning） |
| 入参校验 | 每个字段显式校验（类型、长度、枚举、id 存在性）；拒绝未知字段 |
| 体积 | 单响应 ≤ 256 KB；超限时截断并返回 `truncated: true` |
| 缓存 | `Cache-Control: no-store` |
| 方法 | 只允许 `GET` / `POST` / `PATCH` / `DELETE`；其它 404 |
| 认证 | 服务器本身不携带 TLS/认证/来源策略 `[已核实]` → 依赖 DSH 的入站边界；接口**只提供本机数据读写，不提供任何代理/抓取转发能力**（即不接受外部 URL 作为参数） |

**端点清单**

| 方法 | 路径 | 用途 | 关键入参 |
|---|---|---|---|
| GET | `/apradar/meta` | 版本、limits、数据用量估算、存储状态 | — |
| GET | `/apradar/state` | 来源摘要 + 计数 + 上次刷新摘要 | — |
| POST | `/apradar/refresh` | 手动刷新 | `{ sourceIds?: string[] }` |
| POST | `/apradar/sources/test` | 单源可访问性/可解析性测试 | `{ sourceId }` 或 `{ type, config }` |
| GET | `/apradar/sources` | 来源列表 | — |
| POST | `/apradar/sources` | 新建来源 | `{ type, name, config, enabled }` |
| PATCH | `/apradar/sources/:id` | 改名称/URL/启用态 | 白名单字段 |
| DELETE | `/apradar/sources/:id` | 删除来源 | — |
| GET | `/apradar/templates` | 预置模板列表 | — |
| GET | `/apradar/changes` | 收件箱查询 | `status? sourceId? q? sort? dir? offset? limit?` |
| GET | `/apradar/changes/:id` | 详情（事实区 + 快照元信息 + 差异） | — |
| PATCH | `/apradar/changes/:id` | 只改**用户字段** | `{ status?, userNote? }` |
| GET | `/apradar/opportunities` | 机会列表 | `status? q? offset? limit?` |
| GET | `/apradar/opportunities/:id` | **机会详情**（含关联的变化与来源，关联缺失时如实标注） | — |
| POST | `/apradar/opportunities` | 从变化创建机会 | `{ changeId?, title, ... }` |
| PATCH | `/apradar/opportunities/:id` | 编辑 | 白名单字段 |
| DELETE | `/apradar/opportunities/:id` | 删除 | — |
| POST | `/apradar/maintenance/purge` | 显式清除全部数据 | `{ confirm: true }` |

**字段级写权限**（保证事实区不可被前端篡改）

| 端点 | 可写字段 | 不可写（服务端忽略并返回 `FIELD_NOT_WRITABLE`） |
|---|---|---|
| `PATCH /changes/:id` | `status`, `userNote` | `title` `excerpt` `diffDetail` `snapshotId` `dedupeKey` `publishedAt` `discoveredAt` |
| `PATCH /opportunities/:id` | `title` `projectRef` `judgment` `questions` `nextAction` `status` | `createdAt` `changeId` |
| `POST /sources` `PATCH /sources/:id` | `type`(仅创建) `name` `config` `enabled` | `lastCheckedAt` `lastStatus` `lastError` `canonicalUrl` |

### 6.2 安全相关

- **绝不把外部 URL 作为接口参数**：`refresh` 只接受 `sourceIds`，`test` 只接受 `sourceId` 或 `{type, config}`（config 由 adapter 白名单校验并自行拼接 URL）。因此接口层无法被用作 SSRF 跳板。
- Client 只请求同源相对路径（`/apradar/...`），不带凭据。

### 6.3 P1 候选：typert RPC —— **已评估，不采用**（P1-06，2026-10-09）

`$PKG/dsh-api-gateway` 提供 `ctx.typertGateway`（Host）与 `@deepseek-ai/dsh-api-gateway/client` 的 `ctx.remote`（Client），一元调用返回 `RemoteResult<T>`（`{ok:true,value}` / `{ok:false,error}`），**不因载体问题 reject** `[已核实]`。

**未采用的阻塞点**：严格模式从 `ctx.typert.local` 读取**生成的 `InvocationDescriptor`**；SRC 模式只是开发期回退（解析简单参数名、不校验业务类型、绝不推断可选字段）`[已核实]`。

**P1-06 已把这件事查清（结论：不采用）**。生成描述符的工具链在**运行时不提供**，但它产出的描述符在运行时**确实在被使用** —— 真实 tauri Profile 实测 `ctx.typert.local.list()` 有 **126** 条调用描述符、**23** 个包贡献了生成反射。**判据成立，但迁移对本插件不划算**，三条独立理由：

1. **生成器是开发期工具。** 运行时只有 `dsh-typert-loader` / `dsh-typert-protocol` / `dsh-typert-registry`（289 个官方包中无任何 `*generator*`）；生成器 `@deepseek-ai/dsh-typert-generator` 是独立 npm 包（描述原文为 TypeScript project analyzer，依赖 `typescript@^6`），以 **tsdown 插件**形态接入构建（官方包 `scripts.bundle = tsdown`），而运行时里没有 `tsdown`。本插件则是**纯 JS、零运行时依赖、无构建步骤**。
2. **客户端面没有 typert 发现机制。** `dsh-typert-loader` README 原文：「仅宿主侧 —— 发现机制只会导入宿主侧 `./typert` 产物；在为客户端运行时添加等价的发现机制之前，需要先有独立的组合所有者。」而本插件的主要消费方正是客户端面。
3. **§6.1 的传输决策已经定过。** `T17 / V1` 双向实测通过 → 同源 HTTP 维持不变，V4 不升为 P0。

**因此 `/apradar/*` 保持同源 HTTP**，`RemoteResult` 这一层不存在（不迁移就不需要它）。判据的现场证据由插件的常驻能力报告持续提供：`GET /apradar/meta` 的 `runtime.typert`（`src/host/capabilities.js`）—— 这样结论以后还能被复核，而不是只留在一次性的终端记录里。详见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.11、[COMPATIBILITY.md](COMPATIBILITY.md) §4.3.1。

---

### 6.4 客户端导航状态机：列表 ↔ 详情态（P0 详情页补齐，2026-10-10）

三个视图（变化 / 关注源 / 机会池）共用**一个**导航状态，全部由右栏内的 `RadarBody`
持有 —— **不新增 DSH 侧栏页签**，详情在面板内部打开。

```js
nav = {
  view: 'inbox' | 'sources' | 'opps',
  stack: [...],                     // 来路：从哪里跳出去的
  inbox:  { status, query, offset, detailId, scrollTop, loadedAt },
  sources:{ detailId, scrollTop, loadedAt },
  opps:   { status, query, offset, detailId, scrollTop, loadedAt },
}
```

**列表的筛选/搜索/分页状态属于 `nav`，不属于视图组件。** 视图组件卸载后这些状态必须还在
（`test/client-harness.mjs` 的替身按树的路径保存 Hook 槽位，所以"切走再切回"能不能保住
状态是可测的）。三个视图因此都是**受控**的：读写走 `slice` 与 `patchSlice(key, patch)`。

四条不变量：

1. **`openDetail(key, id)` 必须一次写对三样东西**：`view`、`stack` 追加来路、来路的
   `scrollTop`。同视图内打开详情时 `key === from`，两个字段会落在同一个键上 ——
   必须先把 `next` 建好，再分别基于 `next[from]` 与 `next[key]` 展开。
   **早先的实现正是踩了这个坑**：后写的计算属性覆盖了先写的，`scrollTop` 被丢弃，
   "返回后恢复滚动位置"永远是 0。
2. **`back()` 先弹栈**：栈顶是**另一个**视图时回到那个视图**并保留它当时的 `detailId`**
   （用户是从那条变化跳到机会的，返回就该回到那条变化）；栈空或栈顶就是本视图时才只关掉
   本视图的详情。点页签直接切视图（`switchView`）**清空来路栈** —— 那不是一次"跳出去"。
3. **滚动位置恢复只能恢复一次**（`restoredRef`），否则会一直和用户的滚动打架；
   而且要等列表数据回来（`loadedAt` 由 `load()` 成功时打点）再写 `scrollTop` ——
   太早写会被随后撑开的内容重置掉。进入详情时 `scrollTop` 归零。
4. **详情不能是死胡同**：读取中、读取失败、记录不存在三种状态下都要有返回入口
   （`ChangeDetail` 的 `.apr-crumb` 在三个分支里都渲染）。

**为什么详情要独立读一次，而不是从列表里找**：从一条变化跳到机会时，那条机会可能不在当前页
（列表有分页与状态筛选），刷新页面后也要能按 id 恢复。所以 `GET /opportunities/:id` 是必需的，
不是"列表里已经有了"就能省掉的。

**写路径的诚实性约束**（这三条有专门的测试钉着）：

- 保存失败时**保留用户输入并显示失败原因**，只有服务端确认写入之后才显示「已保存」。
- 删除失败时**不离开详情页、不动任何本地状态**（不能"前端先删了、后端报错"）。
- 关联对象已被清理（`changeMissing` / `sourceMissing`）时**如实标注**，
  **绝不按标题相同推断关联**。

**`GET /opportunities/:id` 的响应形状**（`src/host/service.js` 的 `getOpportunity`）：

```js
{
  opportunity,
  change: decorateChange(change) | null,
  changeMissing: Boolean(record.changeId) && !change,   // 注意：手工机会这里是 false
  source: { id, name, type, canonicalUrl } | null,
  sourceMissing: Boolean(change?.sourceId) && !source,
}
```

`changeMissing` **必须**区分「从来没有关联过」（`changeId` 为空 → `false`）与
「关联对象不见了」（有 `changeId` 但查不到 → `true`）—— 这是两句不同的话，
客户端要给出不同的文案。记录本身不存在时抛 `notFoundError('机会', { id })`
（**不**是默认的「找不到该接口」，那条文案属于路径失配，见 §7.1）。

---

## 7. 错误处理与生命周期

### 7.1 错误码

**来源获取失败码**（直接来自 DSH 抓取层，稳定错误码 `[已核实]`）

| 码 | 用户可见文案 |
|---|---|
| `WEB_INVALID_URL` | 网址格式不正确 |
| `WEB_BLOCKED_URL` | 该网址不可访问（仅允许公开站点） |
| `WEB_FETCH_TOO_LARGE` | 内容超过大小上限 |
| `WEB_FETCH_TIMEOUT` | 获取超时 |
| `WEB_REDIRECT_BLOCKED` | 跳转被拒绝（跨站跳转不支持） |
| `WEB_UNSUPPORTED_CONTENT_TYPE` | 内容类型不支持 |
| `WEB_ABORTED` | 已取消 |
| `WEB_PROVIDER_ERROR` | 抓取服务错误 |

**本插件自有码**

```
SOURCE_NOT_FOUND / SOURCE_DISABLED / SOURCE_AUTO_DISABLED / SOURCE_LIMIT_REACHED
REFRESH_IN_FLIGHT / CONFLICT / NOT_FOUND
ADAPTER_CONFIG_INVALID / ADAPTER_PARSE_FAILED / ADAPTER_STRUCTURE_UNSUPPORTED
STORAGE_OPEN_FAILED / STORAGE_VERSION_MISMATCH / STORAGE_RECORD_INVALID
STORAGE_WRITE_FAILED / FIELD_NOT_WRITABLE / PAYLOAD_TOO_LARGE / INTERNAL
```

> `SOURCE_DISABLED`（用户自己停用）与 `SOURCE_AUTO_DISABLED`（连续失败后自动停用）**必须是两个码**：前者用户知道原因，后者必须带上 `autoDisabledReason` 才说得清。`CONFLICT` 用于判重命中，其 `detail` 必须带上**已存在那条记录的 id 与名称**，否则用户只被告知"重复了"却不知道重复的是谁。

每个码在 `errors.ts` 里同时定义 `code → 中文文案` 映射，**Client 不再自行拼装错误文案**。

### 7.2 失败不变量

1. 抓取失败**不修改** snapshot、不创建 change。
2. 解析失败**不修改** snapshot、不创建 change，来源标记 `failed` 并保留 `lastSuccessAt`。
3. 存储写失败 → 内存与介质一致（DSH 语义：先持久化再改内存，拒绝的写不触碰内存 `[已核实]`）→ 返回 `STORAGE_WRITE_FAILED`，UI 显示 `保存失败`。
4. 任何失败都不产生「没有更新」这类结论。
5. **被截断的响应体绝不进入解析器**（`assertBodyNotTruncated()`，上限 `HOST_MAX_BODY_CHARS = 100000`）。理由：截断只丢尾部，若把前缀当完整内容解析，差异检测会得出"这些条目被删除了"的结论 —— 那是我们无权做出的断言。宁可报一个可读的容量错误（`detail: { truncated: true, maxBodyChars: 100000 }`）。
6. **真实失败原因必须一路留到用户面前**：`toWireError()` **合并**（不是覆盖）抛错方已有的 `detail`；沿 `cause` 链最多 4 层用 `describeCause()` 收集 `message`/`code`/`address`/`hostname`/`port` 并挂到 `detail.providerMessage`；适配器自己写的具体文案占 `message` 主位，插件的通用文案（含"本次检查失败，不代表来源没有更新"这类限定）降为 `detail.note`。理由：宿主**没有可读日志文件**（`~/.dsh/logs` 不存在），错误对象是唯一信息源 —— 丢掉 cause 链等于把唯一线索扔掉（实测代价：[TECH-SPIKE.md](TECH-SPIKE.md) §6.6.2 第 3 条）。
7. **只认白名单、其余静默忽略**的接口是不可接受的：写路径（含**创建**路径）一律走 `assertWritable(input, FIELDS)`，未知字段当场 `FIELD_NOT_WRITABLE` 并列出 `detail.fields` 与 `detail.allowed`。理由：静默忽略会把客户端一个拼写错误变成"保存成功但内容丢了"，对一个用来记录判断的工具这是最坏的失败形态。
8. **删除顺序：先删主记录，再删从属记录。** 删从属记录是无条件批量删除，中途抛错会留下"历史没了、来源还在"的半损坏状态；反过来最坏只是"来源没了、历史还在"（残留数据不可达但可见、可清理，而且来源不见了界面上就看得出来）。实测代价：[TECH-SPIKE.md](TECH-SPIKE.md) §6.7.3 ① —— `DELETE /sources/:id` 因为一个后端 API 误用**从来没有成功过**，而它每次都在删完全部快照与变化之后才抛错。
9. **分配 id 不得覆盖已有记录。** 本插件的 id 由内容派生，而改内容时刻意不重算 id（快照与变化记录都引用它），所以 id 可能与一条旧记录的内容脱钩，并恰好等于"按旧内容新建"的 id。因此 `createSource` 写库前必须用 `allocateId()` 取一个空闲 id（撞车就加 `-2`、`-3`…）。判重与分配 id 是**两件必须分开做**的事：前者管逻辑上重不重复，后者管物理上覆不覆盖。实测代价：一条真实来源被 `store.put` 按键覆盖、连同历史一起消失（[TECH-SPIKE.md](TECH-SPIKE.md) §6.7.3 ③）。
10. **存储可以稀疏，接口必须完整。** 后加的字段（`intervalMinutes` / `failureStreak` / `autoDisabledAt`…）在旧记录里不存在，读路径一律用 `normalizeSourceRecord()` 补齐后再对外，**且刻意不回写存储** —— 读操作顺手改用户的磁盘是最容易出事的一类副作用。理由：不补的话同一个概念在不同代码里会有两种缺失写法（`undefined` 与 `0`），一定有人漏判。
11. **导出/输出类接口必须只读。** 导出前后所有表的序列化结果必须逐字节相同（有测试守着）。理由：一个"顺手修一下格式"的导出会让用户以为文件是权威副本，而他真正的数据已经被改过一次。
12. **贴进文档的文字一律按不可信处理**（`safeInline()`：拆非 http(s) 方案 + 转义 `[ ] < > \``）。来源包括**从公网抓回来的原文摘录** —— 我们完全不控制它。理由：导出的 Markdown 会被贴到别人的仓库里，一个可点击的 `javascript:` 链接是由我们交出去的（[TECH-SPIKE.md](TECH-SPIKE.md) §6.9.3）。
13. **分不清"看到的"和"猜的"等于没有记录。** 导出文件里"事实"与"推测"必须分区，且两区的数据来源不同（事实只能来自抓取落盘的记录）。一边为空时**明说为空**，不留空标题、不用使用者的判断充数。
14. **域 schema 必须与真实记录逐字段对齐，取值集合必须从权威处推导。** 一条记录过不了 `open()` 的校验，代价不是"这条记录读不出来"，而是**整个域不可访问**（`STORAGE_OPEN_FAILED`，读写全停）。两次真实触发：`SOURCE_TYPES` 手写清单漏了两个新类型；`sourceRecord` 漏声明 `intervalMinutes` / `failureStreak`（后者表现为"设置完看着生效、重开域回到默认值"，比报错更难查）。防它的测试在 `test/domains.test.mjs`：断言注册表与域声明的取值集合**逐字相同**、每个已注册类型都能真的存下来、P1-01 的两个字段 parse 后仍在。

15. **源与产物之间必须能用"比较"判断一致性。** 任何生成物都不得把时间戳（或任何每次运行都不同的东西）写进内容 —— 否则"改了源没重建"这件事就再也测不出来，漂移守卫退化成一句空话。生成头里放**内容指纹**（`src/client/client.js` 的 sha256 前 12 位），`test/publish.test.mjs` 逐字节比对 `lib/client.js` 与 `renderBundle(源)`，并比对 `lib/index.js` 与 `src/host/index.js`。实测：给 `lib/index.js` 追加一行注释即触发 2 条断言失败。
16. **平台不报的错必须自己报，而且必须分清"没有观察到"与"观察到了没有"。** 官方 README 承诺"缺失 bundle 会明确导致激活失败并给出构建说明"，**实测没有**：缺 `lib/client.js` 时宿主照常启动、页面照常渲染、日志与页面零提示，客户端条目只是从启动图里消失（见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.12.4）。因此 `describeClientHalf()` 严格区分 `available:false`（宿主上没有 `clientModules` 服务／查询抛错 —— **我们没观察能力**）与 `composed:false`（服务在、查得到、结果为空 —— **确定的坏消息**，必须带包名与修法）。把前者写成后者就是撒谎。同一条纪律此前已用在 `describeTypert()` 的 `null` vs `0` 上。
17. **发布物必须是自洽的运行树，而不是"源码恰好能跑"。** `files` 只收 `lib/` + `cordis.patch.yml` + `README.md`；`main`/`exports["."]`/`exports["./client"]` 一律指向 `lib/`。宿主半边是纯 ESM，所以组装就是**逐字节复制**（不改一个字符 —— 改了就要问"为什么源和产物不一致"）。防它的测试扫 `lib/**/*.js` 的**全部相对导入**，确认每一个都解析到 `lib/` 内且文件存在 —— 这一步等价于"把 `src/` 删掉之后包还能不能加载"。

18. **生命周期钩子必须在第一个 `await` 之前注册。** 异步初始化函数里，任何 `ctx.effect(...)` 都必须挂在**第一个 `await` 之前**：HMR 重载时，上一个实例的 in-flight promise 会继续跑完，而那时它的 fiber 早已释放 —— 之后注册的钩子落到死作用域上，disposer **永远不会执行**，资源永久泄漏。这不是理论风险：`openRadarStore()` 的四个存储域曾因此全部泄漏，新实例拿到 `already-open`，**整个存储读写全停**，而磁盘数据完好（看起来像数据损坏，实际是资源没还回去）。两处防线：①钩子前置 + `disposed` 标记在每次 `open` 落地后自查；②对**本插件独占命名**的资源允许自愈式回收（`already-open` 时用 `facility.get(name)` 取回遗留句柄、`close()` 后重试**一次**；非该错误码一次都不重试、一次都不碰诊断接口）。见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.13。

### 7.3 生命周期

| 事件 | 行为 |
|---|---|
| 插件加载 | `ctx.inject([...])` 等待 `storageDomain`/`web`/`webServer` 就绪 → 打开 4 个 domain → 注册路由 → 注册页签与正文 |
| 热重载（Host 模块改动） | HMR 覆盖 Host Node 模块图 `[已核实]` → domain 句柄随 `ctx.effect` 释放并重开，数据不丢 |
| 热重载（Client 源码改动） | HMR **不覆盖**浏览器 Client 模块图（官方明示）`[已核实]` → 需页面刷新（开发期由外部构建监视器重出 bundle 后可免刷新，需事先确认该监视器在跑） |
| 插件卸载 | 释放路由与句柄；**存储数据保留**（DSH 不清理 storages）`[已核实]` → UI 需事先告知 |
| 异常退出 | 重开时 `open()` 校验每条记录；`per-record` 域的坏记录被移走并跳过；重启后跑 `limits.trim()` 兜底 |
| 版本不兼容 | `version-mismatch` → 阻塞式错误 + 恢复指引，不自动删数据 |
| DSH 升级 | **新内核版本会新建 profile，第三方插件与 patch 定制不随之迁移** `[已核实]` → 需按 [COMPATIBILITY.md](COMPATIBILITY.md) §7 重新安装 |

---

## 8. 安全边界

### 8.1 出网纪律（**正式 P0 闸门 G-NET**）

**规则**：本插件的 Host 业务代码**只允许**通过 `ctx.web.fetch()` 出网。

```
唯一允许：ctx.web.fetch(url)                    ← 经 src/host/fetch/gateway.ts 封装
禁止（业务模块）：globalThis.fetch / XMLHttpRequest / undici / node:http / node:https /
                 node:http2 / node:net / node:dns / node:tls / node:dgram /
                 axios / got / node-fetch / superagent / 任何第三方 http 客户端
```

**为什么这是纪律而不是运行时保证**（来自核验，必须原样记录在文档里）：

- `ctx.web.fetch()` 的保护（协议白名单、URL 内嵌凭据拒绝、公有地址白名单、每跳重解析、体积/超时/重定向上限）**是自愿使用的 seam，不是强制沙箱** `[已核实]`。
- 静态 profile 插件用 `import(name)` 直接进入 Host 进程、无 vm 隔离（`$PKG/cordis-plugin-loader`）`[已核实]`；DSH 的 sandbox 词汇表明确把 Network 排除在外，macOS Seatbelt 配置只有 `(allow default)` + `(deny file-write*)`，全仓没有 network-policy 包 `[已核实]`。
- **即：一个不守规矩的 Host 插件可以绕过全部 §8.2 的保护。** 因此必须用工程手段保证**我们自己的**代码守规矩。

**为什么「阻断 `globalThis.fetch` 就算验证过」是错的**（本轮明确的收紧点）：
- Node 的原生出网入口至少有 `node:http`、`node:https`、`node:http2`、`node:net`（裸 TCP）、`node:dns`（可用于 DNS 外泄）、`node:tls`、`node:dgram`（UDP），以及 `undici`。
- 动态 `import('node:http')`、`createRequire(import.meta.url)('node:http')`、`process.getBuiltinModule('http')` 都能在运行期绕过任何「先删掉几个全局对象」的做法。
- **所以：「替换 `globalThis.fetch` 为抛错桩后流程仍跑通」只能证明我们没有走那条路，不能证明网络请求无法绕过。** 它是**必要条件，不是充分条件**。

#### 8.1.1 五道闸门（G-NET-1 … G-NET-5，全部为 P0 阻断项）

| # | 闸门 | 形态 | 通过判据 |
|---|---|---|---|
| G-NET-1 | **唯一出网点** | 架构约束 | 只有 `src/host/fetch/gateway.ts` 可以引用 `ctx.web`；其它模块只能依赖 gateway 暴露的接口 |
| G-NET-2 | **静态 import 白名单扫描**（阻断） | CI 脚本 `test/gate-scan.mjs`，解析 `src/host/**` 的**全部** import 与 `require` 说明符 | 业务模块的 import **白名单**：只允许本仓相对路径 + `@deepseek-ai/cordis`（**已无 zod**；唯一允许的动态 `import()` 是 §5.0 的 `@deepseek-ai/dsh-storage-domain` 探测，且必须由 G-NET-3 单独列出）。白名单之外**任何**说明符即失败（**正向白名单，不是黑名单**——黑名单永远漏项） |
| G-NET-3 | **动态加载扫描**（阻断） | 同一脚本，正则扫描 `import(`、`createRequire`、`process.getBuiltinModule`、`process.binding`、`node:` 前缀、`require(` | `src/host/fetch/**` 之外出现任一形态即失败；gateway 内也只允许 `ctx.web` |
| G-NET-4 | **运行期替身断言** | `test/no-native-fetch.test.ts`（L3） | 把 `globalThis.fetch`/`XMLHttpRequest` 换成抛错桩后，完整刷新流程仍跑通（断言 `ctx.web` 替身被调用、抛错桩零调用）。**这一项只作为必要条件记录，不得单独作为「无法绕过」的证据** |
| G-NET-5 | **评审清单** | `CONTRIBUTING`/PR 模板 | 固定问一句：「这次改动有没有新增出网调用？有没有新增 import 说明符？」 |

**诚实声明（必须出现在 README 的「安全边界」小节）**：
> 本插件通过代码纪律保证自己只经由 DSH 提供的受管接口访问网络；这不是运行时的强制隔离。DSH 当前不提供网络沙箱，因此**任何**已安装的 Host 插件在技术上都能绕过这些限制。G-NET-1…G-NET-5 保证的是本插件的代码行为，不是同机其它插件的行为。

#### 8.1.2 P0 来源范围收敛（与 G-NET 配套）

在 V7（`.local`）、V8（OS 级 egress 拦截）、R1（代理不固定连接）三项残余风险**得到实测结论之前**，P0 **不默认开放任意 URL**：

| 优先级 | 能力 | P0 是否开放 | 理由 |
|---|---|---|---|
| P0 | `github_releases`：用户只填 `owner`/`repo`，URL 由代码拼接 | ✅ 开放 | 输入不构成任意 URL，SSRF 面最小 |
| P0 | **预置官方来源模板**（URL 已在 [COMPATIBILITY.md](COMPATIBILITY.md) 核实过的固定地址） | ✅ 开放 | URL 是代码内常量，非用户输入 |
| P0 | `rss_atom`：用户填任意 `feedUrl` | ⚠️ **有条件开放** | 允许，但 UI 必须显示「地址由你提供；本插件依赖 DSH 抓取层的公有地址白名单，不额外提供完整 SSRF 防护」 |
| P0 | `html_static`：用户填任意 `pageUrl` | ⚠️ 有条件开放（P0-18，排在最后） | 同 `rss_atom`，且额外受结构判据约束 |
| P1+ | 任何「自动发现来源」「按关键词搜全网」 | ❌ | 属于 MVP 明确不做 |

**因此：不得在文档、UI 或对外说明中宣称本插件「具备完整的 SSRF 防护」。** 准确的表述是：本插件把出网收敛到唯一受管入口，该入口提供协议白名单与公有地址白名单；这两项防护由 DSH 提供，且**未覆盖代理路径（R1）**。

### 8.2 依赖 DSH 抓取层提供的保护（均为 `[已核实]`）

| 保护 | 具体行为 |
|---|---|
| 协议 | 只允许 `http:` / `https:`（无内嵌凭据）；URL 长度上限 2048（不可配） |
| SSRF | **公有地址白名单**：解析结果中任一 IPv4/IPv6 非「公共单播」即整体拒绝；连接固定到已校验地址；IPv6 检查覆盖 IPv4-mapped 与有效 DNS64 前缀转换地址 |
| 重定向 | `maxRedirects` 默认 5；**跨源重定向直接失败**并要求重新调用；同源每跳重新解析 + 固定 |
| 超时 | `timeoutMs` 默认 30,000（提供方兜底） |
| 体积 | `maxResponseBytes` 默认 5,000,000；`maxBodyChars` 默认 100,000 |
| 凭据 | **不发送任何凭据**（匿名抓取），无 Cookie 支持 |
| 内容类型 | 仅 `html` 或 `text`；二进制与未知类型拒绝。`WebFetchBody` 是 `dsh-web` **拥有的封闭判别联合**（`{kind:'html'|'text'}`），新增一种 kind 属于跨包协同变更、**不是插件可扩展点** → 本插件对 body 的 `switch` 必须带 `default: assertNever(...)`，以便未来 DSH 加 kind 时在编译期暴露而不是运行期静默 |
| 标识 | 发送显式产品 `User-Agent` |
| 非 2xx | 作为**结果**返回（含 `statusCode`），不是错误 |

### 8.3 残余风险（必须记录，不得掩盖）

| # | 风险 | 说明 | 缓解 |
|---|---|---|---|
| R1 | **代理路径不做地址固定** | 命中 HTTP 代理时走 `requestVia`，不 pin 连接、由代理解析、无本地二次校验 `[已核实]` | 第一版不主动配置代理；若用户环境设有代理，在 UI 的「关于/诊断」里明示该限制 |
| R2 | `.local` 无专门拒绝规则 | 抓取层没有针对 `.local` 的专门判断，结果取决于 DNS 解析出的 IP `[已核实]` | 来源 URL 由用户显式填写；`github_releases` 与 `html_static` 不接受任意 host 之外的输入；文档明示 |
| R3 | 服务端「守卫」在 Client 侧不可强制 | Client 只被约定不得直接出网，无运行时阻止 | Client 代码不 import 任何网络能力；只调用同源 `/apradar/*`；评审 + 测试断言 |
| R4 | 提示词注入 | 抓取到的网页文本是**不可信外部数据** | 第一版**完全没有模型在链路里**；页面文本不进入任何 agent 指令/系统提示；后续 P2 引入 AI 解读时必须包裹官方同款外部内容告示（`$PKG/dsh-tool-web/lib/types/trust.d.ts` 的 `EXTERNAL_WEB_CONTENT_NOTICE` 模式 `[已核实]`）并把输出严格限制在「推测区」 |
| R5 | HTML 处理 | 解析恶意/畸形 HTML 可能造成 CPU 抖动 | 不做通用正文算法；限制输入长度（≤ 100,000 字符）；纯字符串处理、**不构建 DOM、不执行脚本、不解析 URL 之外的任何资源** |
| R6 | 无并发闸门 | DSH 全仓无并发限制常量 `[已核实]` | 本插件自带 `FETCH_CONCURRENCY = 2`，串行批次，禁无界扇出 |
| R7 | 入站路由无认证 | webserver 不携带 TLS/认证/来源策略 `[已核实]` | 接口只读写本机数据；不接受外部 URL 参数；复用 DSH 自身入站边界 |
| R8 | 用户添加来源时的授权 | 用户可能填入非公开或不该抓的地址 | 添加来源时展示一行提示：「仅用于获取公开页面，不会携带你的账号凭据」；`WEB_BLOCKED_URL` 时给出明确解释 |

### 8.4 信任边界声明（写进代码注释与 UI）

> 抓取到的公开网页内容是**外部数据**。它不能成为可执行指令，不能因为采集网页就执行页面中的脚本或命令，也不能改变本插件的采集策略、URL 白名单或写入目标。

---

## 9. 测试策略

### 9.1 分层

| 层 | 范围 | 是否出网 | 关键断言 |
|---|---|---|---|
| L1 单元 | 适配器解析、实体解码、XML 子集解析、URL 规范化、指纹、差异、上限裁剪 | ❌ 全用 fixture | 给定输入 → 确定性输出；畸形输入 → 结构化错误而非静默空结果 |
| L2 存储契约 | 4 个 domain 的 open/write/close/reopen 往返 | ❌ | 写入后重开数据一致；迭代顺序不确定但排序后稳定；`version-mismatch` / `invalid-record` 行为符合预期 |
| L3 安全闸门 | 原生 `fetch` 阻断、import 扫描、字段级写权限 | ❌ | 未走受管接口即失败；前端无法改写事实字段 |
| L4 路由契约 | 每个 `/apradar/*` 端点的入参校验、错误码、体积上限 | ❌（用 `ctx.web` 替身） | 错误返回 `ok:false` 且不抛异常 |
| L5 集成（手动） | 真实来源抓取、右栏渲染、重载保留 | ✅ 人工触发，少量真实请求 | 见 [COMPATIBILITY.md](COMPATIBILITY.md) §4 的验证矩阵 |

### 9.2 必备 fixture（**离线、随仓库提交**）

fixture 分为**核心**与**参考**两级。**两者的验收地位不同，不得混用**（见 §9.2.2 的闸门）。

#### 9.2.1 核心 fixture（**阻断项：必须 100% 通过**）

| # | fixture | 覆盖点 |
|---|---|---|
| C1 | GitHub `releases.atom` 样例 | `<entry>`、`<content type="html">`、CDATA、tag 从 `<title>` 提取 |
| C2 | RSS 2.0 样例 | `<guid>`、`<pubDate>` RFC 822、`<content:encoded>` 带命名空间前缀 |
| C3 | Atom 1.0 样例 | `<updated>` RFC 3339、`<summary>`、相对链接 |
| C4 | 畸形 Feed 样例集（未闭合标签、错误实体、BOM、GBK 声明但 UTF-8 内容、重复 `<item>`、空 `<title>`） | **必须返回结构化错误或明确降级，不得崩溃、不得静默返回空结果** |
| C5 | 空 Feed（合法但零条目） | 与「解析失败」明确区分 |
| C6 | 损坏存储文档（手工放置一份不符合 schema 的 `per-record` 文档） | `backup-and-skip` 行为（V2） |
| C7 | 列表查询契约 fixture（空表 / 单条 / 恰好 limit / limit+1 / offset 越界 / limit 超上限 / 每个 sort 枚举值 / 过滤后为空 / 大小写与中文关键词） | §5.1.1 契约的每一条断言 |

#### 9.2.2 参考 fixture（**非阻断，用于评估额外真实来源兼容性**）

静态 Changelog 页样例（`h2` + 段落 + `<script>` + 注释）、真实世界来源的线上抓取样本（L5 手动）、各类真实站点 Feed 变体。

**用途仅限**：估计「额外真实来源」的兼容比例，作为 P0-06/P1-08 是否需要引入第三方解析库的**参考指标**。

#### 9.2.3 验收闸门（**本轮按用户要求收紧**）

> **P0 解析器验收以核心 fixture 为准：C1–C7 必须 100% 通过。核心 fixture 有一项失败即整体不通过验收。**
>
> 参考 fixture 的通过率（如「≥ 95% 的真实来源可解析」）**只能**作为评估额外来源兼容性的参考，**不能替代、不能抵扣、也不能用来放宽核心验收**。禁止用「总体通过率很高」掩盖某一类核心 fixture 的失败。

在核心 fixture 100% 通过之前，**不得**启动 P1-08（引入第三方 feed 解析库）——先证明自研子集解析器在承诺范围内的正确性，再讨论超出承诺范围的兼容性。

### 9.3 最小验证方案（针对本阶段未能核实的项）

| # | 待确认项 | 最小验证 | 状态 |
|---|---|---|---|
| V1 | Desktop（Tauri/IPC）下 Client 能否通过同源 `fetch` 访问插件注册的 `/apradar/*` | **技术 Spike（独立目录，不是产品代码）**：Host 注册 `GET /apradar-spike/ping` 返回 `{ok:true}`；Client 一个按钮调用并显示结果；同时验证异常态。见 [TECH-SPIKE.md](TECH-SPIKE.md) | ⏳ 本轮执行（**阻塞正式 UI 开发**） |
| V2 | `per-record` 布局下 `backup-and-skip` 的真实效果 | 手工往 `$DSH_HOME/storages/<unit>/<table>/` 放一份坏文档，重开 domain，确认坏文档被移走、其余记录可读、日志有原因 | 待执行 |
| V3 | `version-mismatch` 的界面化恢复流程 | 手工把落盘 `version` 从 1 改为 2，重开，确认 `open()` 抛错且 UI 给出可执行的恢复步骤 | 待执行 |
| V4 | typert 严格模式代码生成是否可用 | 查 `ctx.typert.local` 在打包运行时是否有生成的描述符；无则确认只能走 SRC 回退 | 待执行（**V1 失败时的后备方案**） |
| V5 | GitHub `releases.atom` 的实际可用性与速率表现 | 对 1 个公开仓库连续抓取 3 次，记录 `statusCode`、体积、耗时 | 待执行 |
| V6 | Client 单文件免构建路径在本地链接插件下是否直接可用 | 以本地路径安装最小插件（`exports['./client']` 指向手写 `.js`），确认右栏能打开。Knit 是既有证据，仍需在本插件上复现一次 | ⏳ 与 V1 同一个 Spike 一并验证 |
| V7 | `.local` 域名是否会被抓取层拒绝 | 实测添加一个 `.local` 来源，观察它落到 `WEB_BLOCKED_URL`、DNS 解析失败、还是正常抓取（抓取层无专门规则，预期取决于解析出的 IP）→ 结论回写 [COMPATIBILITY.md](COMPATIBILITY.md) §4.3 | 待执行（**P0 不开放任意 URL 的原因之一**） |
| V8 | 是否存在 OS 级 egress 拦截（系统防火墙 / 强制代理） | 检查目标机器的系统代理与防火墙设置，确认抓取不会被静默拦截 | 待执行（同上） |
| V9 | ~~插件显式声明的 `zod` 能否被 `domainTable` 接受~~ | ✅ **已结清并反转**：`link:` 插件解析不到 `zod` 也解析不到 `@deepseek-ai/dsh-storage-domain`；官方后端接受**数据形状字面量 spec**。结论：**不声明 zod、走零依赖路径**，见 §5.0 | ✅ 已实测（落盘成功） |
| V10 | 静态闸门（G-NET-2/G-NET-3）能否覆盖运行期绕过形态 | 在本运行时实测 `process.getBuiltinModule('http')`、`createRequire(import.meta.url)('node:http')`、动态 `import('node:http')` 是否可用；可用即在扫描脚本中显式列入并写进文档 | 待执行 |

---

## 10. 模块划分与建议目录结构

```
（工作区根）
├── PRD.md  SDD.md  COMPATIBILITY.md  MVP-BACKLOG.md
├── package.json                 # dsh.bundle.patch / dsh.client{platform:'web', ...} / exports{'.','./client'}
├── cordis.patch.yml             # 插件组合行
├── src/
│   ├── host/
│   │   ├── index.ts             # 插件入口：inject + effect + apply
│   │   ├── domain.ts            # 4 个 defineDomain spec + open/close + migrate
│   │   ├── routes.ts            # /apradar 前缀路由 + 统一响应封装
│   │   ├── service.ts           # 刷新编排、查询、变更、purge
│   │   ├── adapters/
│   │   │   ├── types.ts         # SourceAdapter 契约
│   │   │   ├── registry.ts      # 类型 → 适配器 + 预置模板
│   │   │   ├── github-releases.ts
│   │   │   ├── rss-atom.ts
│   │   │   └── html-static.ts
│   │   ├── fetch/
│   │   │   ├── gateway.ts       # 唯一出网点（只调 ctx.web.fetch）
│   │   │   └── url.ts           # 规范化、去跟踪参数、长度校验
│   │   ├── parse/
│   │   │   ├── xml.ts           # 零依赖 RSS2.0 / Atom1.0 子集解析
│   │   │   ├── html-text.ts     # 标签剥离 + 块切分
│   │   │   └── entities.ts      # 实体解码
│   │   ├── normalize.ts
│   │   ├── fingerprint.ts
│   │   ├── diff.ts
│   │   ├── limits.ts
│   │   └── errors.ts            # 错误码 + 中文文案映射
│   └── client/
│       └── client.js            # 手写、无 JSX、无打包器（见下）
└── test/
    ├── fixtures/
    ├── adapters.test.ts
    ├── xml.test.ts
    ├── diff.test.ts
    ├── limits.test.ts
    ├── storage.test.ts
    ├── routes.test.ts
    └── no-native-fetch.test.ts
```

### 10.1 客户端形态决定

采用**手写单文件 Client bundle**，理由与依据：

- 本机已验证的同类实现（Knit）走的就是这条路：由 `window.__ModuleLoader__.load({ id, factory })` 注册工厂，`factory(require)` 返回 Cordis 插件对象（`exports.apply` + `exports.inject`）`[已核实]`。
- 官方明确：加载期只能 `require` 冻结的基线模块表（React、React DOM、Cordis、以及静态 UI 库）；超出基线的请求必须列进 `dsh.client.external` `[已核实]`。
- 因此：**不使用 JSX**（用 `React.createElement`），**不引入打包器**，样式写在一个模板字符串里，静态资源内联。
- **仅当插件要发布为 npm 包**时，才必须预先产出 `lib/client.js` 构建产物（宿主提供的是已构建 bundle，缺失会明确激活失败）`[已核实]` → 列为 P1 发布准备项。

### 10.2 依赖策略决定

**不新增任何需要下载安装的第三方运行时依赖**（XML/HTML 解析器、HTTP 客户端、状态管理、UI 组件库、schema 库一律不引）。**没有任何例外** —— 早先版本写的「唯一例外是 `zod`」已被实测推翻：`link:` 插件既解析不到 `zod`、也解析不到 `@deepseek-ai/dsh-storage-domain`，而且 `link:` 协议不会为被链接包安装其 `dependencies`，所以「显式声明」并不能解决可解析性。现改用**插件自带极小校验器 + 数据形状字面量 spec + 动态探测官方 helper**（§5.0 / §5.3）。依据：

- 本运行时**没有**任何官方 RSS/Atom/HTML/XML 解析包 `[已核实]`，所以无论如何都得自带解析能力。
- 安装第三方包会触发 profile 的供应链策略闸门：本机已观测到 4 个插件因 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 被拒装 `[已核实]`。
- `link:` 协议下**声明的 `dependencies` 根本不会被安装** `[已实测]` → 声明依赖不仅无用，还会给读者一个「已声明即可解析」的错误印象。
- `engines.dsh` 是**声明性**的，安装器与加载器都不强制 `[已核实]` → 依赖的兼容性风险不会被工具提前拦住，只能靠我们自己控制。
- DSH 升级会新建 profile、第三方插件不迁移 `[已核实]` → 依赖越少，重建成本越低。

**结论**：P0 用自研的严格子集解析器（RSS 2.0 / Atom 1.0 / `releases.atom`）+ 保守的 HTML 文本抽取，配 §9.2 的 fixture 套件。依赖清单为：**零运行时依赖**（唯一的非相对导入是 `@deepseek-ai/cordis` 的类型/运行时引用与 §5.0 的 `@deepseek-ai/dsh-storage-domain` **动态探测**，两者都不是需要安装的包）。

**是否引入第三方解析库的判据（本轮按用户要求调整）**：

| 判据 | 结论 |
|---|---|
| 核心 fixture（§9.2.1 的 C1–C7） | **必须 100% 通过**；有一项失败即 P0 验收不通过 → 此时**不是**去引依赖，而是先修解析器或**收窄 P0 承诺的格式范围** |
| 参考 fixture（§9.2.2）通过率偏低 | 记为「超出 P0 承诺范围」的已知限制；**不构成**引入依赖的理由 |
| 触发 P1-08 的唯一条件 | 核心 fixture 已 100%，且**业务上确实需要**超出 RSS 2.0 / Atom 1.0 子集之外的格式（如 RSS 1.0/RDF、JSON Feed） |

**引入第三方库时的安装纪律（硬约束）**：
1. 选择**版本固定**的成熟库（精确版本，不用 `^`/`~`），并记录选择理由。
2. 走 `dsh plugin --profile <name> add` 的官方路径安装到目标 profile。
3. **绝不绕过 pnpm 的最小发布年龄检查**：不得使用 `--config.minimumReleaseAge=0`、不得删除 `.npmrc`/`pnpm-workspace.yaml` 中的 `minimumReleaseAge`、不得手工把包写进 `node_modules` 假装安装成功。若被 `ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION` 拒绝，**正确做法是等待该版本达到最小年龄，或改选一个已满足年龄要求的版本**；`minimumReleaseAgeExclude` 白名单只能由用户在明确知情后手动添加（参见 [COMPATIBILITY.md](COMPATIBILITY.md) §6.3）。
4. 若因闸门无法安装，则**保持零依赖方案并收窄承诺范围**，不得以「功能不全」为由绕过闸门。
