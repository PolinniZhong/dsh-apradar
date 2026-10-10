# TECH-SPIKE.md · P0-00 技术验证记录

> 对应 `SDD.md` §6.1 的 ⛔ 前置闸门、`MVP-BACKLOG.md` 的 **P0-00**、`COMPATIBILITY.md` §4.3 的 **V1 / V6**、§9 的 **T17 / T17b**。
> 本文件记录**技术验证的方案、步骤与实测结论**。它不是产品 Demo：不含任何产品功能、不写任何持久化数据、不修改任何现有插件。
>
> **更新（Milestone 1 收尾）**：§6.1–§6.3 为 Milestone 0 的 Spike 结论；§6.4 为**正式插件 `dsh-apradar`** 的专项复验，它同时补齐了原 §7 里「持久化未验证」这一空缺。

---

## 1. 为什么必须先做这一步

正式 UI 的整套数据流建立在一个假设上：

> **插件注册的 HTTP 路由，能被 DSH 客户端（Desktop 的 Tauri webview 与浏览器）以同源相对路径访问到。**

`COMPATIBILITY.md` §4.2 的 C7 只记录了 **Host 侧**（`curl`）旁证；这**不等于**渲染进程内可达。若 Desktop 不可达，`SDD.md` §6.1 的 Host→Client 通信方案必须整体改写为 typert RPC（V4）。因此在拿到实测结论前，**不开发任何正式 UI**（用户 m00370 决策②）。

## 2. 要回答的四个问题

| # | 问题 | 通过判据 |
|---|---|---|
| Q1 | 右栏页签能否注册 | 右侧栏出现「产品雷达 Spike」页签；会话头部出现同名入口按钮 |
| Q2 | Client 能否**同源**访问插件注册的路由 | 面板顶部「页面来源」的 origin 与路由 host 一致；`/ping` 返回 `200` |
| Q3 | Host 正常响应能否解析 | `/ping` 的 `code` 显示为 `spike/pong`，且含 `ts` / `host` / `origin` / `pid` |
| Q4 | 异常态能否区分且界面不崩溃 | 六条探针各自给出**不同**结论：正常 / 500 错误码 / 200 非 JSON / 超时 / 空体 / 404 |

## 3. 验证插件的设计与实现

目录：`spike/apradar-spike/`（**不在 `src/` 内、不进入产品代码树**）

| 文件 | 作用 |
|---|---|
| `package.json` | `name: dsh-apradar-spike`、`dsh.bundle.patch`、`dsh.client`、`engines.node` |
| `cordis.patch.yml` | `- insert:` 一行 `{id, name}`，把插件挂进 loader |
| `src/host/index.js` | `ctx.inject(['webServer'], …)` + `webServer.register({kind:'prefix', path:'/apradar-spike'})` |
| `src/client/client.js` | 手写客户端（`window.__ModuleLoader__.load`，禁 JSX），注册右栏页签 + 入口按钮 |
| `README.md` | 安装 / 卸载 / 判据 / 已知边界 |

**关键设计取舍：**

1. **零依赖** —— `package.json` 不声明任何 `dependencies`，因此安装不下载任何包、不触发 pnpm 供应链闸门（`ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION`）。
2. **照抄本机已验证的 Knit 形态**，不发明新接口：Host 侧 `sendJson` / `isLoopback` / `webServer.register` 与 `08_Knit/knit/src/host/index.js` 同形；Client 侧装载、`sidebarRightTabs.register`、三处 slot、`sidebarRight.openTab(KIND)` 与 `08_Knit/knit/src/client/client.js` 同形。
3. **双入口** —— 除右栏页签外，另在 `conversation.session.header.utilities` 注册一个入口按钮。即便右栏注册失败，也能在界面上确认插件已加载（并把失败本身变成一条结论）。
4. **六条探针覆盖四类判别**，避免只测「正常路径」就宣布通过。
5. **`README.md` 明示本插件不写任何持久化数据**，因此卸载零残留。

## 4. 已取得的旁证（勘察阶段，只读）

这些是 **Host 侧 / 环境侧**证据，**不能替代** Q2 的渲染进程内实测：

| 证据 | 内容 |
|---|---|
| 路由确实由插件注册并被服务 | Knit 注册 `/knit` 前缀路由后，`curl 127.0.0.1:3080/knit/api/recent` 与 `:3082/knit/api/recent` 均 `200` 且正文一致；`/knit/nope` → `404 {"ok":false,"code":"knit/not-found-route"}` |
| 两个端口同属一个 host 进程 | `lsof` 显示 `3080`/`3082` 均由同一个 node 进程服务 |
| Desktop webview 的页面来源 | `desktop.log` 中 Desktop 窗口 URL 为 `http://127.0.0.1:3080/?token=…` → **页面 origin 与插件路由同源** |
| 同源相对路径在生产中已被使用 | `08_Knit/knit/src/client/client.js:658-666` 全部是同源相对路径，由 `:3610` / `:4136` / `:4189` / `:5253` 的 `fetch` 调用 |
| 无需重启即可生效 | `dsh-plugin-manager/README.md:14`「With HMR enabled in YAML, configuration changes apply immediately; without HMR, the running composition remains until restart」；`:67` 活 profile 会 recompose 并报 `applied`；tauri profile 已启用 HMR |

## 5. 执行步骤

```bash
# ① 装入 Desktop 使用的 profile
dsh plugin --profile tauri add "<项目绝对路径>"

# ② 装入 Web 使用的 profile
dsh plugin --profile web add "<同一绝对路径>"
```

> ⚠️ 这两条命令会写 `~/.dsh/profiles/<profile>/`，在 workspace-write 沙箱下会被拒绝（`EPERM: operation not permitted, open '…/package.json.lock'`），需以 danger-full-access 提权执行。

**隔离安装（不碰 `~/.dsh` 的做法，本次实测采用）**：

```bash
# dsh 启动器 shim 会硬编码 export DSH_HOME="$HOME/.dsh" 并覆盖外部同名变量，
# 所以隔离必须绕开 shim，直接执行 bin.js。
DSH_HOME=/tmp/apradar-web-home /opt/homebrew/bin/node \
  "<安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js" \
  plugin --profile web add "<项目绝对路径>"
```

> **CLI 用法纠正**：`dsh web --profile web` 会报 `error: option '--profile <name>' argument 'web' is invalid. select a profile only once`。启动一个 web 实例的正确形式是 `dsh --profile web [--port 0] [--no-open]`（`dsh web --help` 的 Usage 行本身写的就是 `dsh --profile web [options]`）。

**预期**：tauri profile 已启用 HMR，配置变更被 watcher 捕获后**重新组合当前运行中的 composition**，插件**无需重启**即挂载并报 `applied`。

**若需回退**：

```bash
dsh plugin --profile tauri remove dsh-apradar-spike
dsh plugin --profile web remove dsh-apradar-spike
```

## 6. 实测记录

> 状态：**已执行完毕**（Milestone 0 的 Q1–Q4 全部通过；Milestone 1 的专项复验见 §6.4）。未取到结论的格子一律保留 `未执行`/`未通过`，不推断。

### 6.0 已确认：Host 侧路由注册 + 免重启热挂载 ✅

装入 `tauri` profile 后，**未重启任何进程**即生效：

```
$ dsh plugin --profile tauri add "<…>/spike/apradar-spike"
+ dsh-apradar-spike link:/Users/…/13_AI Product Radar_AI 产品雷达/spike/apradar-spike
Done in 4m 42.7s using pnpm v11.7.0        (exit 0)

$ curl -s http://127.0.0.1:3080/apradar-spike/ping
{"ok":true,"code":"spike/pong","ts":"2026-10-09T11:29:10.119Z",
 "host":"127.0.0.1:3080","method":"GET","url":"/apradar-spike/ping",
 "userAgent":"curl/8.7.1","pid":84103,"node":"v26.5.0"}

$ curl -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/knit/api/recent   → 200
$ curl -o /dev/null -w "%{http_code}" http://127.0.0.1:3080/                  → 200
```

**结论（已确认为事实）：**

1. **插件安装后无需重启 DSH 即可挂载** —— `pid: 84103` 与勘察阶段记录的宿主进程号一致，说明 `apply()` 是在**原本就在运行的那个 Host 进程内**执行的。这印证了 `dsh-plugin-manager/README.md:14` 的「With HMR enabled in YAML, configuration changes apply immediately」。
2. `ctx.inject(['webServer'], …)` + `webServer.register({kind:'prefix', path, handler})` 的写法在真实 Host 中**确实注册成功**（不是类型层面的假设）。
3. 现有插件与 GUI **未受影响**（Knit 路由与首页仍为 `200`）。

**⚠️ 安装过程观察到的两点副作用（需留意，非本 Spike 设计缺陷）：**

- pnpm 输出 `Packages: -56` —— 本次 `pnpm add` 顺带裁掉了 56 个未被 profile 清单引用的包。
- 多个 registry 请求失败：`ERR_PNPM_META_FETCH_FAIL: GET https://registry.npmjs.org/… (DEPTH_ZERO_SELF_SIGNED_CERT)`（本地代理证书问题），另有 `missing the "time" field; skipping the minimumReleaseAge check` 告警。
- 复核结果：Knit 路由、GUI 首页在安装后均仍返回 `200`，**未观察到功能性破坏**；但这说明「在活 profile 上跑 pnpm」本身带有副作用，正式安装流程应把它当作一次需要告知用户的操作。

### 6.1 Desktop（profile `tauri`，客户端 = Tauri webview）

> 6.0 只证明了 **Host 侧**；本节是**渲染进程内**的验证结果。

**证据获取方式的限制（必须如实披露）**：本机**无法自动化 Tauri 自己的 WKWebView 渲染进程**（没有可用的 CDP 端点）。因此本节证据来自**同一宿主、同一页面源、真实 Chromium 渲染进程**：用系统 Google Chrome 154.0.8037.99（headless）访问 `http://127.0.0.1:3080/` —— 这正是 Tauri 窗口加载的那个页面源（Tauri 侧只是多了 `/?token=…`）。这不是「Tauri WebView 本体」的截图证据。

工具：`spike/apradar-spike/test/cdp-run.mjs` + `spike/apradar-spike/test/ws-raw.mjs`（自写 CDP 客户端，零依赖）。
> 为什么不用 Playwright：本机 Playwright 缓存中的 Chromium（rev 1243）与已装 `playwright@1.61.1`（要 rev 1228）/`playwright-core@1.62.1`（要 rev 1234）都不匹配；`node_repl` 又是只读沙箱无法落盘。
> 两个已踩实的坑：①Node 26 全局 `WebSocket`（undici）连 Chrome CDP 会在握手成功后立刻 `CLOSE 1006`，而裸 socket 手工握手返回 `101` → **必须自写 RFC6455 客户端**；②Chrome 在 DSH 文件沙箱下 crashpad/sandbox 写不了自己的目录，会**在收到第一个帧后立刻关闭 DevTools 会话**，必须加 `--no-sandbox --disable-crash-reporter --disable-crashpad`。

| 项 | 结果 | 记录 |
|---|---|---|
| 插件是否被加载（HMR 是否 apply） | ✅ 通过 | console `[apradar-spike] client apply(); origin = http://127.0.0.1:3080`；同批可见 `[knit] registered on the official right sidebar: kind = knit`、`[dsh-aigc-asset-center] 右栏 tab 已注册`、`[loreflow-copilot] 未检测到 DSH 自带右栏 sidebarRightTabs` |
| Q1 右栏页签 | ✅ 通过 | console `[apradar-spike] 官方右侧栏页签已注册：kind = apradar-spike`；**页面真实打开面板**并渲染出标题条「产品雷达 Spike」与正文 |
| Q1 头部入口按钮 | ✅ 通过 | 点 `aria-label="打开右侧边栏"` → 点 `geFEbW_entry`（文本「AI 产品雷达 · 技术验证」）→ 面板出现。截图 `/tmp/apr-3080-panel2.png` 已目视确认 |
| Q2 页面 origin 与路由 host 是否一致 | ✅ 通过 | 面板正文 `页面来源：http://127.0.0.1:3080` / `完整地址：http://127.0.0.1:3080/` / `路由前缀：/apradar-spike`；Host 回显 `host: 127.0.0.1:3080`、`referer: http://127.0.0.1:3080/`、`pid: 84103`、`node: v26.5.0`；`hostHeaderMatchesPageOrigin: true` |
| Q3 `/ping` 解析 | ✅ 通过 | `pingIsJsonWithCode`：200 + `spike/pong` |
| Q4 异常态可区分性 | ✅ 通过 | `boomIs5xxWithCode`（500 + `spike/boom`）、`notJsonDetected`（200 + `text/html`）、`emptyBodyDetected`（200 + 0 字节）、`notFoundDetected`（404 + `spike/not-found-route`）、`timeoutDetected`（`/hang` 在 1500ms 主动 abort → `outcome: timeout`）—— **五项全部为 true** |
| 界面是否崩溃 / 控制台错误 | ✅ 通过 | `pageErrors: []`；`bootReady: true`；仅 1 条 `net::ERR_CONNECTION_REFUSED`（第三方插件自有端口，与本插件无关） |

> 为在**无会话态**下也能开面板，Spike 客户端里加了一个**只存在于 Spike、绝不进入正式插件**的测试钩子 `window.__apradarSpike = { kind, tabId, openTab() }`（内部走官方 `ctx.get('sidebarRight').openTab(KIND)`）。

### 6.2 隔离 Web Profile（profile `web`，客户端 = 浏览器）

**做法**：`dsh` 启动器 shim **硬编码 `export DSH_HOME="$HOME/.dsh"`**（绝对路径，带本机用户名），会覆盖外部同名变量；`resolveDshHome` 的优先级是「显式 configured > `$DSH_HOME` > `~/.dsh`」。因此要隔离必须**绕开 shim**，直接跑 `node "<安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js"` 并设 `DSH_HOME=/tmp/apradar-web-home`。**全程未写 `~/.dsh`。**

| 项 | 结果 | 记录 |
|---|---|---|
| 基线（未装 Spike） | — | `/` → 401（不带 token）；`/apradar-spike/ping` → 404；首页未注入 spike client |
| 隔离 profile 能否引导 | ✅ 通过 | `--profile web` 直接从 shipped 包解析，**无需联网安装**；`dsh web: http://127.0.0.1:60490/?token=…` |
| 安装 Spike | ✅ 通过 | `plugin --profile web add "<spike 绝对路径>"` → **405ms、exit 0、无下载、无供应链闸门** |
| 插件是否被加载 | ✅ 通过 | 重启后启动日志出现 `[dsh-apradar-spike] spike route ready: …`；页面启动模块清单含 `apradar-spike/client.js` |
| Q1 右栏页签（注册） | ✅ 通过 | console `[apradar-spike] client apply(); origin = http://127.0.0.1:60491` 与 `官方右侧栏页签已注册：kind = apradar-spike` |
| Q1 右栏面板（打开） | ⚠️ **环境阻塞，非插件缺陷** | `ctx.get('sidebarRight').openTab(KIND)` 抛 **`Error: sidebarRight: no session surface is mounted`**。全新 profile 无会话/无凭据，即使已点「新会话」、composer DOM 已存在、已清掉「预览版说明」与「添加一个 API Key 开始使用」弹窗仍如此；stock web 界面里也**不存在** `aria-label="打开右侧边栏"` 的按钮（Desktop 侧存在）。**面板可开性已在 6.1 的真实渲染进程中证明** |
| Q2 同源可达 | ✅ 通过 | `hostHeaderMatchesPageOrigin: true`；Host 回显 `host: 127.0.0.1:60491`、`referer: http://127.0.0.1:60491/` |
| Q3 `/ping` 解析 | ✅ 通过 | 200 + `spike/pong` |
| Q4 异常态可区分性 | ✅ 通过 | 与 6.1 相同的五项判定**全部为 true**（500 `spike/boom`、200 `text/html`、200 空体、404 `spike/not-found-route`、timeout） |
| 界面是否崩溃 / 控制台错误 | ✅ 通过 | `pageErrors: []` |

### 6.2b 卸载清理（在隔离 home 上做，`~/.dsh` 全程未动）

| 项 | 结果 | 记录 |
|---|---|---|
| `plugin --profile web remove dsh-apradar-spike` | ✅ 通过 | 347ms、exit 0；profile `package.json` 的 `dependencies` 整段消失、`dsh.profile.bundles` 由 `[base, web-app, dsh-apradar-spike]` 回到 `[base, web-app]` |
| 路由是否注销 | ✅ 通过（**重启后**） | `/apradar-spike/ping` 与 `/boom` 均 404 且**响应体为空**，区别于插件自己的 `{"ok":false,"code":"spike/not-found-route"}` |
| 客户端是否撤注 | ✅ 通过（**重启后**） | 首页 HTML 中 `apradar-spike` 出现次数 **0** |
| ⚠️ 残留 | 已记录 | **`node_modules/dsh-apradar-spike` 符号链接残留**（指向项目 `spike/`）→ 卸载会清 bundle 层与依赖声明，但会留下一个失效的 `node_modules` 软链 |
| 对照项未被破坏 | ✅ 通过 | `~/.dsh/profiles/tauri/package.json` 仍有 `"dsh-apradar-spike": "link:…"` 且 `dsh.profile.bundles` 末位含它（该 profile 的 bundle 记录写在 `package.json` 的 `dsh.profile.bundles`，**不在** `cordis.patch.yml` 里） |

### 6.3 结论

**Q1–Q4 全部通过 → 三视图 + 详情页所依赖的三条技术假设全部成立。**

- [x] Q1 通过 → 右栏页签方案成立
- [x] Q2 通过 → Host→Client 同源 HTTP 方案成立（Desktop 与隔离 Web Profile 双向验证），`SDD.md` §6.1 无需改写
- [x] Q3 / Q4 通过 → 错误态与失败态文案设计有实测支撑
- [x] 附带通过：**免重启热挂载**、**卸载清理（重启后）**

**由此被迫收窄的设计（不改产品模型，只改实现前提）：**

1. 右栏没有标题行/格级工具栏席位 → 所有操作必须放在插件自身页面内容里（已按用户 m00223 的决策执行）。
2. 只能走 JSON 单后端，没有 SQLite。
3. 抓取是**匿名**的，且 DSH 抓取层不做 HTML 正文提取 → 「任意静态 HTML 页面」只能是**有条件支持**。

### 6.4 Milestone 1 专项复验（正式插件 `dsh-apradar`，2026-10-09）

Milestone 0 的 Spike 已证明通道成立；本节回答的是**正式插件在自己的包结构下**是否同样成立。

| 项 | 结果 | 记录 |
|---|---|---|
| 单元测试 | ✅ **60 项全通过** | `/opt/homebrew/bin/node --test test/*.test.mjs`（`node --test test/` 在 Node 26 下报 `Cannot find module '.../test'`，故 `scripts.test` 写 `node --test 'test/*.test.mjs'`） |
| 隔离 Web Profile 安装 | ✅ 通过 | `plugin --profile web add "<项目目录>"` → **366ms、exit 0、零下载** |
| 真实 `tauri` Profile 安装 | ✅ 通过 | `plugin --profile tauri add "<项目目录>"` → **5.9s、零下载**；输出含 `[WARN] Issues with peer dependencies found`、`Packages: -56`、`Added 1 entry to minimumReleaseAgeExclude in pnpm-workspace.yaml: billion-context@0.1.189` |
| 免重启热挂载到**正在运行的桌面宿主** | ✅ 通过 | 宿主 **PID 84103 未变**（uptime 06:22:12）；`curl http://127.0.0.1:3080/apradar/ping` → 200 且 `pid:84103` |
| 客户端是否被注入并注册 | ✅ 通过 | 页面 HTML 启动模块清单含 `apradar/client.js&rev=…`；console `[apradar] 官方右侧栏页签已注册：kind = apradar`；`pageErrors: []` |
| 右栏面板真实渲染 | ✅ 通过 | 面板正文 `页面来源 http://127.0.0.1:3080` / `路由前缀 /apradar` / `右栏标识 apradar` / `HTTP 200 · 4 ms` + Host 原始 JSON（`persisted: true`、`openCount: 1`）。截图 `/tmp/apr-desktop-formal3.png` 已目视确认 |
| 失败态可区分 | ✅ 通过 | 点「测试错误响应」→ `HTTP 500 · 服务端返回错误（apradar/boom）` + 原始体 `{"ok":false,"code":"apradar/boom","reason":"…"}` |
| **持久化跨进程成立** | ✅ 通过（**决定性判据**） | 隔离宿主杀掉再启 → `storage ready: domain=ai_product_radar_sources specMode=inline **openCount=2**`；JSON 文件中 `firstOpenedAt` 保持首次时间、`lastOpenedAt` 更新、`openCount: 2` |

**Milestone 1 最有价值的发现（已修，且已加回归测试）：**

首次启动直接把整个宿主进程打崩，退出码 1：

```
[dsh-apradar] host route ready: /apradar/ping, /state, /boom
[dsh-apradar] 无法解析 @deepseek-ai/dsh-storage-domain（ERR_MODULE_NOT_FOUND: Cannot find package
              '@deepseek-ai/dsh-storage-domain' imported from …/src/host/store/index.js），改用同形状字面量 spec
dsh: fatal load failure: Error: cannot get property "storageDomain" without inject
    at openRadarStore (file:///…/src/host/store/index.js:119:23)
[dsh-apradar] host route removed: /apradar      → exit 1
```

- **根因**：Cordis 上下文在读取**没有 `inject` 声明**的服务属性时**会抛错**（不是返回 `undefined`）。而 `storageDomain` 恰恰是外部插件在本机**解析不到**的那个包（见 `COMPATIBILITY.md` §6.1）。
- **官方免 inject 读法**：`@deepseek-ai/cordis/lib/types/reflect.d.ts` 的 `ctx.get(name, strict?)` —— 注释原文 "Read a service from the store **without the inject requirement**"；`strict` 默认 `true`（仅返回提供方 fiber 处于活动状态的实现）。
- **修法**：`src/host/store/index.js` 用 `ctx.get('storageDomain')` 取代属性读取，并把 `openRadarStore` 拆成「外层 `try/catch` 保证**永不抛出**」+ `openRadarStoreInner`；`src/host/index.js` 给该 promise 补 `.catch()`。**一个未处理的拒绝会把整个宿主进程打成 fatal load failure —— 这不是本插件的 bug 域，而是所有 Host 插件的通用纪律。**
- **由此证明的第二件事**：官方后端**接受以数据形状字面量声明的 `DomainSpec`**（无需 zod）。落盘文件 `/private/tmp/apradar-web-home/storages/ai_product_radar_sources.json` 内容为
  `{"unit":{"name":"ai_product_radar_sources","version":1},"global":{"schemaVersion":1,"openCount":1,"firstOpenedAt":"…","lastOpenedAt":"…"},"tables":{"sources":{}}}`
  → 这直接支撑了 `SDD.md` §5.1 的「inline 字面量 spec + 零运行时依赖」决策。

**未通过 / 未执行（如实记录）：**

| 项 | 状态 | 原因 |
|---|---|---|
| 隔离 Web Profile 上**点开面板** | 未通过（**环境阻塞**） | 全新 profile 无会话面 → `sidebarRight: no session surface is mounted`；面板可开性由 6.1/6.4 的 Desktop 侧证明 |
| 真实桌面宿主**重启后** `openCount` 递增 | ✅ **已补执行并通过**（2026-10-09 21:20） | 用户自行重启 Desktop：宿主 `PID 84103 → 71800`（起始 21:20:16），`/apradar/state` 返回 `openCount: 2`、`firstOpenedAt` 仍为 `2026-10-09T12:58:38.949Z`、`lastOpenedAt` = `2026-10-09T13:20:19.881Z`，磁盘文件同步。→ 真实环境跨重启持久化成立 |
| `plugin --profile <p> remove <包>` 卸载路径 | ❌ **失败（DSH/pnpm 侧缺陷）** | `ERR_PNPM_RESOLUTION_POLICY_VIOLATIONS_UNHANDLED`（`minimumReleaseAge` 产生了违规，但卸载路径没有接 `handleResolutionPolicyViolations` 回调）。失败是干净的：`dependencies` 与 `dsh.profile.bundles` 均未变。可用替代：在 profile 的 `cordis.patch.yml` 追加 `disabled: true` 覆盖项 —— **有 HMR 时热生效**（本机实测 `/apradar-spike/ping` 立即 404、宿主 PID 未变） |
| Tauri WKWebView 本体自动化 | 未执行（**工具限制**） | 无 CDP 端点（见 6.1） |

## 6.5 缺陷与修复：面板被渲染进会话头部（2026-10-09 修复并已复验）

| 项 | 内容 |
|---|---|
| 现象 | 用户**打开会话后**，整个雷达面板出现在**主区顶部**，把会话区顶成一大块；右栏里反而只剩「开始」入口列表 |
| 复现前提 | **必须先打开一个真实会话** —— 无会话时 `conversation.session.header.utilities` 席位根本不渲染，因此早期全部「无会话」探针都看不到该缺陷（假阳性） |
| DOM 证据（修复前） | `P.apr-note ← DIV.apr-body ← DIV.apr-root [664,10 728x639] ← DIV.wSkVaW_headerUtilities [505,10 887x639] ← DIV.wSkVaW_titleRow` |
| 根因 | `src/client/client.js` 的会话头部注册写成 `ctx.slots.register({ …, component: () => …入口按钮 }, RadarBody)`。DSH 的 `slots.register(options, Component)` **取第 2 个位置参数作为组件**，于是整个面板正文 `RadarBody` 被当成了头部席位的内容 |
| 修法 | 与 Knit 完全同形（`08_Knit/knit/src/client/client.js:5581-5588`）：options 里**不写** `component`，组件**只**走位置参数（`RadarEntryButton`） |
| 复验（修复后，同一探针） | 会话态 `panel: null`（主区无面板）；`wSkVaW_headerUtilities` 的文本只剩 `AI 产品雷达`；点入口后面板祖先链为 `DIV.apr-root [793,38 647x719] ← DIV.P3OORG_tabBody ← DIV._tabHostBody_6nhg2 ← SECTION._tabHost_/_pane_ [792,0 648x757] ← DIV._tabCell_6nhg2` → **落在右栏列（x 792..1440）内，不在会话头部** |
| 回归测试 | `test/manifest.test.mjs` 新增 2 条：①会话头部注册块（去注释后）不得出现 `RadarBody`、不得出现 `component:`，且必须以 `RadarEntryButton` 作位置参数；②`sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 的 `key` 必须是 `TAB_ID`。**62 项全通过** |
| 探针 | `spike/apradar-spike/test/eval-header-check.js`（会话态主区是否出现面板）、`eval-final-check.js`（会话态：开右栏 → 点入口 → 断言面板只在右栏列） |
| 限制 | 仍在 headless Chrome（同一宿主、同一页面源）上验证，未自动化 Tauri WKWebView 本体（见 6.1） |

**教训（须写进测试策略）**：注册类缺陷只有在**目标席位真正挂载**时才暴露。凡涉及会话内席位的验证，探针必须先打开一个真实会话，否则会得到假阳性。

## 6.6 P0 全量实测：第一次真实出网 · 三视图真实宿主验证（2026-10-09）

这是本项目**第一次真的从公网取回内容**，也是第一次在真实宿主里把三个视图都渲染出来。

### 6.6.1 真实出网：三个必须分开报告的结果

| 结果 | 端点 | 实测 |
|---|---|---|
| ✅ 成功 | `api.github.com/repos/openai/openai-node/releases?per_page=10` | HTTP 200 / 749 ms，`itemCount: 10`，`sampleTitles: ["v7.31.0","v7.30.1","v7.30.0"]` |
| ✅ 成功 | 4 个真实 Feed（blog.google / techcrunch / theverge / simonwillison） | 20 / 20 / 10 / 30 条，均在上限内；simonwillison 为 **89,841 B**，贴宿主 100,000 字符上限的边界 |
| ❌ 环境不可达 | `github.com/.../releases.atom` | 本机 `curl` → `000`（15–20 s 超时，exit 28）。**不是插件缺陷** |
| ⛔ 明确拒绝 | `github.blog/feed/`（1.24 MB）、`openai.com/blog/rss.xml`（768 KB）等 | 超宿主 `maxBodyChars: 100000`，返回可读的截断错误而不是解析错误 |

### 6.6.2 三个由真实测试（而非 fixture）暴露的缺陷

1. **`github.com` 在本机完全不可达** —— `curl https://github.com/` → `000`（15 s 超时），`.../releases.atom` → `000`（20 s）；而同域的 `api.github.com` 200 / 2.5 s。适配器当时**只有** `releases.atom` 一个端点，在这个网络里注定失败。**修法**：`buildRequests()` 返回双端点，`api.github.com` 优先、`releases.atom` 兜底（博客/代理/企业网关会各挡一边）；`resolveRequests()` 按优先级依次尝试，首个成功即返回，全失败时报**首选端点**的原因并把每个候选的失败挂进 `detail.attempts`。`buildRequest()` 保留为首选端点，向后兼容。
2. **宿主截断被报成了来源自身的格式错误** —— `github.blog/feed/` 实测 1,235,394 B，远超 `maxBodyChars: 100000`，XML 解析器于是报 `CDATA 段未闭合` / `标签未闭合：<item>`。这个错误会把排查方向带偏到"Feed 格式有问题"。**修法**：`assertBodyNotTruncated(result, hint)` 在三处适配器入口先判截断，抛 `AdapterParseError(…, { truncated: true, maxBodyChars: 100000 })` 并给出可行动提示。**设计决定：截断的前缀不拿去解析** —— 哪怕前缀能解析出半页条目，缺失的尾部也会让差异比较得出"这些条目被删除了"的结论，那是我们无权做出的断言（[SDD.md](SDD.md) §7.2）。
3. **错误对象里的真实原因被丢掉了两轮** —— ① `toWireError()` 对已知码只回自己的中文文案，把宿主 `err.message` 整句丢掉；② 修好之后 `attachProvider()` 又直接 `wire.detail = { providerMessage }`，把抛错方附上的 `detail`（含 `attempts`）覆盖掉。**修法**：新增 `describeCause(err)` 沿 `cause` 链最多 4 层收集 `message`/`code`/`address`/`hostname`/`port`；`toWireError` 改成合并而非覆盖 `detail`，并把具体文案放在主位、通用文案降为 `detail.note`。**没有这两步就拿到那句关键证据**：`Connect Timeout Error (attempted address: github.com:443, timeout: 10000ms)`。

> `~/.dsh/logs` 在本机**不存在**，2 小时内也没有任何 `*.log` —— 宿主没有可读的日志文件，错误对象是唯一的信息来源。这一点决定了"错误里必须留住 cause 链"不是可选项。

### 6.6.3 真实端到端链路（不是模拟数据）

| 步骤 | 实测结果 |
|---|---|
| 建立来源 | `POST /sources` → `src_7c5e7e1d593e6cdd`，`canonicalUrl` 即 api.github.com 地址 |
| 基线刷新 | `{ baseline: true, itemCount: 10, newChanges: 0 }` |
| **二次刷新（上游未变）** | `{ baseline: false, itemCount: 10, newChanges: 0 }` → **真实内容上幂等，指纹漂移没有制造假的「有变化」** |
| **真实差异** | 把某来源配置切到另一个真实 Feed → `newChanges: 20`；`GET /changes` → `total: 20`，含真实 `title` / `itemUrl` / `diffSummary` / `excerpt` |
| 入池与沉淀 | 变化 → `pooled` → 机会记录创建，服务端回写 `opportunityId` |

### 6.6.4 真实宿主三视图验证

探针 `spike/apradar-spike/test/eval-ui-views.js`（`__VIEW__` 占位符替换为 inbox / sources / opps，交给零依赖驱动 `cdp-run.mjs`）。

三个视图**全部实测通过**，诊断一致：

- `主区有面板: false`（用户最初报的缺陷不再出现）
- `面板矩形 [793, 38 647x719]`，`视口宽 1440` → **只在右栏列**
- 祖先链 `DIV.apr-root ← DIV.P3OORG_tabBody ← DIV._tabHostBody_6nhg2 ← SECTION._tabHost_/_pane_ [792,0 648x757] ← DIV._tabCell_6nhg2`，`在会话头部内: false`
- `页签数: 3`、`存储不可用: false`、`pageErrors: []`

面板文字证明渲染的是**真实数据**：变化收件箱 30 条（`Meta is banning TikTok ads across its platforms` 等）、关注源 3 条（含真实 canonicalUrl 与上次检查时间）、机会池 2 条。

**同一轮实测发现的界面缺陷（已修）**：底部提示行恒显示「最近一次 —，上次刷新 —」。根因是 `fmtTime()` 只接受 number，而宿主 `storage` 块的 `firstOpenedAt` / `lastOpenedAt` / `lastRefreshAt` 是 **ISO 字符串** —— 数字判断把真时间当成了缺值，界面于是撒谎说"没有时间"。改为 `toEpochMs()` 同时接受两种形态，并补了回归测试。

## 6.7 P1-01 实测：定时刷新 · 调度能力核验 · 三个数据安全缺陷（2026-10-09）

### 6.7.1 调度能力核验：一个被否掉的候选，一个被采用的设施

`P1-01` 的前提是"复用 DSH 既有的调度能力"。真实核验的结果是**两个包，一个能用、一个不能用**：

| 包 | 版本 | 判定 | 依据 |
|---|---|---|---|
| `@deepseek-ai/dsh-schedule` | 0.2.0-rc.2 | ❌ **不可用** | 它是**按会话绑定的提醒/任务投递**服务（一次性 `after_seconds`/`at`、固定 `every_seconds`、`daily`/`weekly`/`cron`），把后续消息投递回**原会话**，不是给插件代码用的通用后台定时器。且其 README 原文：「**随发行版交付的 Web 组合不含 `schedule` 行**」—— 要启用必须挂 **实验性** bundle `@deepseek-ai/dsh-experimental-schedule-bundle` 或把它列进 profile 的 `dsh.profile.bundles`。依赖它等于依赖 experimental 包，`MVP-BACKLOG.md` P1-01 明令禁止。 |
| `@deepseek-ai/cordis-plugin-timer` | 1.1.6 | ✅ **采用** | Cordis 的**释放感知（disposal-aware）**定时器服务。API：`ctx.timeout/interval/throttle/debounce`（`ctx.setTimeout`/`ctx.setInterval` 是已废弃别名）。README 原文：「Timer handles are registered on the current fiber, so they are cleared automatically when the plugin that created them is disposed.」—— 正是 HMR 反复重载时最需要的性质。 |

依赖面 `grep` 证实 `@deepseek-ai/cordis-plugin-timer` 被 `dsh-base` / `dsh-app-boot` / `dsh-cordis-host-runner` / `dsh-hmr` / `dsh-plugin-manager` 等依赖 → **`dsh-base` 必挂载**。实跑证实：`GET /apradar/meta` → `scheduler: {"available":true,"running":true,"degraded":false,"tickMs":60000,...}`，**`degraded:false` 直接证明用的是 Cordis 定时器而不是全局 `setInterval` 兜底**。

**设计决定：不把 `timer` 写进 `ctx.inject`。** 与 `src/host/index.js` 既有注释同一理由 —— 设施永远不出现时 inject 回调永不执行，插件会以"完全不存在"的方式失败；改为 `ctx.get('timer')` 主动探测，探测不到就降级到全局 `setInterval` 并标注 `degraded: true`，连全局定时器都没有才报 `available: false` + `reason`（客户端据此**禁用**间隔选择器并显示原因）。

### 6.7.2 为什么是"一个循环"而不是"每个来源一个定时器"

`src/host/scheduler.js` 只有一个 60 秒循环。200 个来源就是 200 个定时器，每个都要自己处理"上一次没跑完"、释放、HMR 重载三件事 —— 三处都容易各错一次；一个循环之后**并发控制只剩服务层那一份 `inFlight` 集合**。副作用是好的：宿主休眠错过的时点会在下次唤醒自然补上（判定条件是 `lastCheckedAt + interval <= now`，不是"距上次 tick 多久"），慢来源也不阻塞其它来源的到期判断。

`selectDueSources()` **刻意不用 `lastSuccessAt`**：一直失败的来源若按"上次成功"算就永远不再重试，自动停用机制反而永远触发不了。

### 6.7.3 三个只有真实宿主实测才暴露的数据安全缺陷

三个缺陷都属于同一类：**在内存替身里全对，碰真实 storage-domain 后端就错**，而且都不报错或报错很晚。

**① `DELETE /sources/:id` 从来没有成功过，而且是"部分破坏"。**

实测响应：`{"ok":false,"error":{"code":"INTERNAL","message":"table.keys(...).includes is not a function"}}`。

根因在 `src/host/store/index.js`：`del()` 用 `table.keys().includes(id)` 判断记录是否存在，而真实后端的 `keys()` **不返回数组**。危害加倍：`deleteSource()` 原本是**先删该来源的全部 snapshots 与 changes、最后才删来源记录**，异常恰好抛在最后一步 —— 于是界面上那个「删除」按钮不仅一次都没成功，每次点击还会**无条件删掉那个来源的全部历史**，然后报一个看不懂的内部错误。

修法：存在性判断改用 `table.get(id) === undefined`（本文件别处已在用、经过验证的 API）；并把顺序改成**先删来源记录、再删从属记录** —— 最坏情况变成"来源没了、历史还在"（残留数据不可达但可见、可清理），而不是"历史没了、来源还在"。实测复验：`DELETE` → `{"deleted":true,"removedSnapshots":0,"removedChanges":0}`；删不存在的 id → `SOURCE_NOT_FOUND`（而不再是 `INTERNAL`）。

**② 判重比的是过时的 `id`，于是同时犯两个相反的错。**

来源 id 是**创建时**由 `type|canonicalUrl` 派生的，而 PATCH 改配置时**只更新 `canonicalUrl`、刻意不改 `id`**（id 被快照与变化记录引用，改了会产生孤儿）。于是 id 随每次改地址而变得过时：

- **误报**：把来源改到新地址后，**原地址反而加不回来了**（明明已经没人用它）。
- **漏报（更严重）**：把来源改到新地址后，**用同一个新地址能再加一个来源** —— 实测拿到了两个都指向 `www.theverge.com/rss/index.xml` 的来源，同一条内容会被记成两条变化。

修法：判重比 `type` + `canonicalUrl`（"当下事实"，谁现在占着这个地址就拦住谁），`type` 也参与比较因为同一 URL 用不同解析器是合法的两个来源。实测复验：`CONFLICT` 且 `detail.existingId` 点名是谁占着；原地址空出来后可以正常加回来。

**③ 新来源会按键覆盖旧来源 —— 真实丢了一条来源。**

这是 ② 的后果，也是本轮最严重的一个。真实事故：一条来源的记录被 PATCH 到 simonwillison，但它的 id 仍是当初按 techcrunch 派生的 `src_1c338a28c22616e8`。用户随后**重新添加 techcrunch** 时，修复后的判重只看 `canonicalUrl`（techcrunch 确实没人占，放行），而新记录的派生 id 又恰好等于那条旧记录的 id → `store.put` **按键覆盖**，simonwillison 来源连同它的全部历史一起消失。

诊断过程与排查方向（记下来，因为很容易误判成哈希碰撞）：`hashId()` 是纯函数 `` `${prefix}_${sha256Hex(seed).slice(0,16)}` ``，实测三值互不相同 —— `rss_atom|https://techcrunch.com/feed/` → `src_1c338a28c22616e8`、`…simonwillison.net/atom/everything/` → `src_caff31632ef50b8d`、`…www.theverge.com/rss/index.xml` → `src_2d13dbc4a42bc430`，**没有碰撞**。直接读原始存储文件 `~/.dsh/storages/ai_product_radar_sources.json`（结构 `{unit:{name,version}, global, tables:{sources:{<key>:<record>}}}`）才看清是 id 与内容脱钩导致的按键覆盖。

修法：**"判重"与"分配 id"是两件必须分开做的事** —— 前者管逻辑上重不重复，后者管物理上覆不覆盖。新增纯函数 `allocateId(preferred, existing)`：优先用派生 id，被占用就追加 `-2`、`-3`… 取第一个空闲的，**绝不覆盖已有记录，也绝不改动已有记录的 id **。实测复验：在真实宿主上精确复现该场景 → 新来源拿到 `src_463b39ee0cdfc61c-2`，旧记录 `src_463b39ee0cdfc61c` 内容原样保留。

补充修掉的一个一致性问题：`intervalMinutes` / `failureStreak` 是后加字段，在那之前落盘的记录里没有这两个键。新增 `normalizeSourceRecord()` 在读路径补齐（**存储可以稀疏，接口必须完整**），并**刻意不回写存储** —— 读操作顺手改用户的磁盘是最容易出事的一类副作用。

### 6.7.4 实时验证结果

| 检查 | 结果 |
|---|---|
| 定时器能力 | `available: true`、`running: true`、**`degraded: false`**（Cordis 释放感知定时器已挂载） |
| 间隔夹取 | `1→15`、`99999→1440`、`0→0`、`-5→0`、`30→30`、`"45"→45`、`"abc"→0`（**不报错**：间隔是可选偏好，填错不该让整个来源保存失败） |
| 未到期 | `POST /refresh {due:true}` → `due: []`、summary 全 0（`lastCheckedAt` 早于 15 分钟前才到期） |
| 自动 tick（空转） | **23:08:19 / 23:09:19 各自发执行一次**：`tickCount:1` 与 `2`、`lastTickAt` 有值、`lastResult = {due:0, …}` 结构完整、`lastError: null`（此时两个 15 分钟来源都还没到期，判定正确） |
| **自动 tick（真实抓取）** | **23:10:20 `tickCount:3` → `due=1, succeeded=1, failed=0, newChanges=1`** —— 调度器自己发现 `www.theverge.com` 到期（`lastCheckedAt` 22:54:41 + 15 min = 23:09:41 已过），自动抓取成功并写入了**一条真实变化**（变化总数 30 → 31）。这是"定时刷新"第一次真的替用户抓到了东西，全程无人工触发 |
| 客户端 UI 复验 | 真实宿主探针（`eval-ui-views.js`，`__VIEW__=sources`）：`主区有面板: false`、`面板在右半屏: true`、`面板矩形 [793,38 647x719]`、`页签数: 3`、`pageErrors: []`。面板里每张来源卡片都渲染出**可用的**「定时刷新」下拉框（实测停在「每 15 分钟」）与「下次大约 2026-10-09 23:20 / 23:25」——两个时间都等于各自 `上次检查 + 15 分钟`，与真实 tick 行为一致 |
| `DELETE /sources/:id` | 修复后 `{"deleted":true,...}`；不存在的 id → `SOURCE_NOT_FOUND` |
| id 碰撞防护 | 新来源拿到 `…-2`，旧记录未被覆盖 |
| 测试套件 | **`node --test 'test/*.test.mjs'` → 239 / 239 pass**（新增 3 条：判重看当前地址、id 撞车不覆盖、`nextRunAt` 不编造下次时刻） |

三条新测试**都验证过"不是空转"**：把对应修复逐条还原后跑，每条都真的失败（判重还原 → 2 条失败；id 分配还原 → 2 条失败），还原修复后重新 239/239 全绿。

## 6.8 P1-02 实测：快照历史

> 结论先说：**历史是"照实说"的功能** —— 它最容易犯的错不是少显示，而是把"我们没留"说成"当时就是这样"。本节记录为此定下的字段与一条只有真实数据才暴露出来的界面歧义。

### 6.8.1 一个必须先解决的问题：`textTruncated` 有两种完全不同的含义

存储里早就有 `textTruncated` 布尔，但它在两个地方被置真，对用户的意义**完全相反**：

| 场景 | 何时发生 | 当时的 `textChars` | 用户该看到什么 |
|---|---|---|---|
| ① 来源本身很长，规范化阶段就截了 | 正文 > `MAX_NORMALIZED_TEXT_CHARS`（100000） | 顶到 100000 | 「来源很长」—— 与我们留没留无关 |
| ② 旧快照被压成摘录（裁剪阶段） | 超过 `MAX_FULL_TEXT_SNAPSHOTS`（保留 2 份全文） | ≤ `MAX_OLD_SNAPSHOT_CHARS`（2000） | 「**仅保留摘录**」—— 这是 P1-02 验收第 2 条要求明示的 |

所以**不能靠 `textTruncated` 反推保留等级**。修法：快照记录**显式落 `retention: 'full' | 'excerpt'`**（`refreshOne` 写 `'full'`；`planTrim()`【在 `src/host/limits.js`】压成摘录时写 `'excerpt'`），并导出 `retentionOf(snapshot)`：显式字段优先，回退推断只服务于 P1-02 之前落盘的旧记录（`textTruncated === true && textChars <= MAX_OLD_SNAPSHOT_CHARS` → excerpt）。

**这里踩了一个坑，值得记下来**：第一版的修改是用脚本往 `src/host/service.js` 里找 `shrinkSnapshots.push({...})` 加字段 —— 但那段代码其实在 `src/host/limits.js` 的 `planTrim()` 里，**替换静默 no-op**，测试里旧快照仍然是 `retention: 'full'`。教训：跨文件的同名代码块，替换前要 `assert old in s`，事后要 grep 复核落点。

### 6.8.2 `chainLink()`：差异链是在快照上重算的，不是读变化记录

- 用 `itemIds` + `itemHashes` 做集合差与指纹比对，得出 `{baseline, added, removed, modified}`。
- **刻意不用 `itemCount` 相减**：那会把"删了 3 条又加了 3 条"说成"没有变化"。
- `capped = itemCount > after.size`：`itemIds` 被 `MAX_ITEM_IDS`（500）截断，超限时计数**只是下限**，必须如实标注，不能当成精确值。
- **分页不会伪造基线**：`listSnapshots()` 取 `previous = full[index + 1]`（取被截断掉的那一份），所以列表尽头的链依然是真的，不会因为"没取上一份"而显示成"首次抓取"。

### 6.8.3 `snapshotSummary()` 刻意不返回正文

20 份快照各带 10 万字符就是数兆字节，一次响应塞进 648px 宽的右栏毫无意义。列表只给摘要 + `excerpt`（`clampText(trim, MAX_EXCERPT_CHARS)`）；正文走 `GET /apradar/snapshots/:id` 按需取，并有 `MAX_SNAPSHOT_VIEW_CHARS = 20000` 的查看上限，超限时回 `textTruncatedByView` 与 `maxViewChars`，界面如实说"只显示前 20000 字符（实际 N 字符）"。

### 6.8.4 真实宿主验证

探针 `spike/apradar-spike/test/eval-ui-history.js`（① 开真实会话 → ② 开右栏 → ③ 点「AI 产品雷达」→ ④ 切「关注源」→ ⑤ 点「历史」→ ⑥ 点「正文」）实测：

| 检查 | 结果 |
|---|---|
| 面板位置 | `主区有面板: false`、`面板在右半屏: true`、矩形 `[793,38 647x719]`、入口候选 4 —— 仍只在右栏 |
| 历史行 | `出现历史提示: true`、`历史行含真实时间: true` |
| 实际文字 | `最近 2 份快照（共 2 份）… 2026-10-09 23:05 20 条 +20 新增 · −30 移除 … 2026-10-09 22:54 30 条 基线：首次抓取，没有可对比的上一版` |
| 「仅保留摘录」 | `出现_仅保留摘录: false` —— **当时只有 2 份快照，全文保留上限恰好就是 2，所以这是正确结果**（不能为了"看到徽章"去造旧数据） |
| 正文 | `正文元素存在: true`、`正文字符数: 5496`、开头 `TechCrunch Automattic loses its interim CFO just weeks after boardroom shakeup…` —— **真抓到的内容**，不是占位符 |
| 测试套件 | **245 / 245 pass**（路由数 18 → 20 的断言同步；新增 4 条路由用例 + `retentionOf` 纯函数用例 + 客户端 `SnapshotRow` 渲染用例） |

### 6.8.5 只有真实数据才暴露的界面歧义：「+20 新增」旁边写「1 条变化记录」

真实历史行一度长这样：`2026-10-09 23:05 · 20 条 · +20 新增 · −30 移除 · 1 条变化记录`。看起来自相矛盾，排查结论是**设计行为**：

- 幂等规则（[SDD.md](SDD.md) §4.4）下，19 条新增内容的 `dedupeKey` 在更早的抓取里已经存在，`refreshOne` 只更新它们的 `lastSeenAt`、**不新建记录**；那些旧记录仍指向**更旧**的快照，所以只有 1 条新记录指向这份新快照。
- 但对用户来说这是个谎：不能说"20 条新增"又给一个 1。修法是**把原因说出来**而不是把数字对齐 —— 文案改为「这份快照关联 N 条变化记录」，并在 `added + modified > changeIds.length && !baseline` 时追加「其余新增/修改的条目在更早的抓取里已经记过，按幂等规则不重复记录」。
- 复验：`GET /apradar/sources/src_1c338a28c22616e8/snapshots` → `mv13kaky` items=20 chain `{added:20, removed:30}` changes=**1**；`mv136qnd` items=30 baseline changes=0。数字与界面文案一致。

## 6.9 P1-05 实测：机会池导出 Markdown · 不可信内容防护（2026-10-09）

### 6.9.1 为什么必须有一个"绕过 JSON 信封"的出口

插件 Host 的默认契约是：handler 的返回值一律包成 JSON 信封（`{ok:true,data}` / `{ok:false,error}`）。这个契约不能为了一个功能就破 —— Client 和宿主都依赖它。但 Markdown 导出若也走信封，浏览器里打开就是**一坨 JSON**，用户拿不到文件。

做法是留一个**显式**出口而不是改默认行为：`http.js` 导出 `RAW_RESULT = Symbol('apradar.rawResult')`，handler 返回 `{ [RAW_RESULT]: { text, contentType, filename } }` 时才绕过信封，其余 20 条路由的行为**一个字节都没变**。原始出口自己负责：

- `content-disposition: attachment; filename="…"`（文件名先过 `replace(/[^A-Za-z0-9._-]/g, '_')`，不让文件名里的引号或换行破坏响应头）；
- 体积闸门（复用 `MAX_RESPONSE_BYTES`，超限回 500 `INTERNAL` + `responseTooLarge`，并给出"请分批导出（用 `?ids=` 指定几条）"的可行动提示）；
- `REDACT`（和其他响应一样，绝不回显本机绝对路径）。

### 6.9.2 事实 / 推测分区是**数据来源**的边界，不是排版技巧

`src/host/export.js` 里两个分区的内容来自**不同的表**，这条规则写在模块文档里：

| 分区 | 唯一允许的来源 | 为空时 |
|---|---|---|
| 事实 | `changes` / `snapshots` / `sources` 三张表 —— **全部由真实抓取写入，无一条来自模型** | 明说"没有关联任何一次抓取记录，它是在没有来源证据的情况下创建的" |
| 推测与判断 | 使用者自己写的 `judgment` / `questions` / `nextAction` | 明说"（还没有写。这条机会目前只有上面的事实部分。）" |

- **不留空标题**：一边为空就说出为什么为空。空标题会让读者以为是渲染失败，或者更糟 —— 以为是"没有异常"。
- **不把使用者的判断挪进事实区充数**：真实数据里正好有一条机会（`opp_7fd9905d74338b52`）是客户端早期版本创建的、**没有 `changeId`**，导出的第 2 条于是走了"没有关联抓取记录"的分支。这是它该有的样子。

### 6.9.3 导出的内容按**不可信**处理（这一节是 P1-05 的核心决定）

导出文件会被贴进别人的笔记或仓库。里面既有使用者写的自由文本，也有**从公网抓回来的原文摘录** —— 后者是我们完全不控制的内容。因此 `src/host/export.js` 做了两件事：

1. **拆掉非 `http(s)` 的 URI 方案**（`neutralizeSchemes`）：`javascript:alert(1)` → `javascript：alert(1)`（半角冒号换全角）。只匹配"方案 + 冒号 + 非空白"，所以 `Releases: v1` 这类正常英文冒号不受影响。
2. **转义能构成链接、自动链接、代码段或原始 HTML 的字符**（`MARKDOWN_ESCAPE = /[\[\]<>\`]/g`，反斜杠转义）。

**为什么是这两件事**：`javascript:` 作为纯文本不会被点开，但只要它出现在 `[文字](这里)` 或 `<这里>` 的位置就成了可点击的陷阱。安全做法不是"记得别那么写"，而是**让它不可能是一个合法 URI**。

**刻意不做的事**：强调标记（`*` `_`）**不转义**。它们最多改变外观，而到处加反斜杠会让源文件不可读 —— 安全处理不应该以牺牲可读性来表达"我很小心"。

`safeInline()` 是这条纪律的唯一实现，正文里一切"贴进去的文字"（标题、状态、项目名回退、变化的标题/类型/摘要、来源名/类型、判断、问题、下一步）都走它。`quoted()` 也逐行走它 —— 摘录来自公网。

**验证过不是空转**：把 `safeInline` 临时还原成 `inline`，`test/export.test.mjs` 的第 ⑤ 与 ⑪ 两条**真的失败**（12 → 10 pass），还原后 12/12。

### 6.9.4 真实宿主验证

**HTTP 层**（`curl -D- http://127.0.0.1:3080/apradar/export/opportunities`）：

```
HTTP/1.1 200 OK
content-type: text/markdown; charset=utf-8
content-length: 3211
cache-control: no-store
x-content-type-options: nosniff
content-disposition: attachment; filename="ai-product-radar-opportunities-20261009-2322.md"
```

正文 3211 字节，含**真抓到的** The Verge 摘录（`Meta has banned ads from TikTok's Chinese parent company ByteDance across the US and several other countries…`）、真实的来源/快照/条目链接，以及第 2 条机会"没有关联任何一次抓取记录"的诚实说明。

**界面层**（CDP 探针 `spike/apradar-spike/test/eval-ui-export.js`，headless Chromium 打 `127.0.0.1:3080`）：

| 检查 | 结果 |
|---|---|
| `a_会话态下主区有面板` | **false**（主区仍然干净） |
| `e_面板在右半屏` / `d_面板矩形` | true / `[793,38 647x719]` |
| `f_导出按钮存在` / `g_导出按钮被禁用` | true / **false** |
| `h_机会池卡片数` | 2 |
| **Blob 真的被创建** | size **3211**、type `text/markdown;charset=utf-8` |
| 下载文件名 | `ai-product-radar-opportunities-20261009-2325.md` |
| 结果提示 | `已导出 ai-product-radar-opportunities-20261009-2325.md（2118 字符）。保存位置由浏览器决定 —— 插件没有、也不会写你的项目目录。` |
| `pageErrors` | `[]` |

探针刻意 hook 了 `URL.createObjectURL` 与 `HTMLAnchorElement.prototype.click`：只有**浏览器真的创建了 Blob、真的拿到了带 `download` 的锚点**，才能证明"点了按钮"不只是改了一句提示。Blob 的 3211 字节与 `curl` 拿到的 `content-length` **完全一致** —— 两条独立路径得到同一个数。

### 6.9.5 一个只有测试才暴露的缺陷：空池导出的文件名

`exportFilename()` 对"一条"走 `ai-product-radar-<id>.md`。空池分支最初图省事写成 `exportFilename([{ id: 'empty' }], at)` → 文件名成了 `ai-product-radar-empty.md`，一个**看起来像真的机会 id** 的假名字。改为 `exportFilename([], at)` 走复数时间戳分支，注释写明"不要为了凑一个名字塞一条假记录进去"。这条是 `test/route.test.mjs` 的文件名断言抓出来的。

## 6.10 P1-04 实测：两类新结构适配器 · 一次 schema 漂移事故

#### 6.10.1 选型先做可达性与体积实测，再写代码

P1-04 要求"至少 2 类结构适配器"。**先测端点，再选类型** —— 本机 `curl` 实测（2026-10-09，字节）：

| 端点 | 结果 | 结论 |
|---|---|---|
| `api.github.com/repos/openai/openai-node` | 200 / **6,938 B** | ✅ 选作 `github_repo` |
| `registry.npmjs.org/openai/latest` | 200 / **7,826 B** | ✅ 选作 `npm_package` |
| `registry.npmjs.org/openai`（完整 packument） | 200 / **4,496,833 B** | ⛔ **唯一一个直接撞上 `maxBodyChars: 100000` 的形状**（44.9×），所以 npm 适配器只用单版本端点 |
| `openrouter.ai/api/v1/models` | 200 / 782,040 B | ⛔ 超限 7.8× |
| `pypi.org/pypi/openai/json` | 200 / 683,641 B | ⛔ 超限 6.8× |
| `pypi.org/rss/project/openai/releases.xml` | 200 / 11,440 B | ✅ 可用（RSS，不需要新适配器） |
| `api.npmjs.org/downloads/point/last-week/openai` | 200 / 81 B | ✅ 可用 |
| `huggingface.co/api/models/...` | **`000`** | ⛔ 不可达 |
| `raw.githubusercontent.com/...` | **`000`** | ⛔ 不可达 |

**可达性再次证明是逐主机名的**（§6.2.1 已记过 `github.com` 不可达而同域的 `api.github.com` 可达）—— 同一台机器上 `registry.npmjs.org` 通、`pypi.org` 的 JSON 通但太大、`huggingface.co` 与 `raw.githubusercontent.com` 完全不达。**选适配器类型之前必须先 curl。**

#### 6.10.2 `github_repo`：Stars 只做里程碑，不做精确数值

`stargazers_count` 几乎每次抓取都在变。若把它当作可 diff 的条目，每次刷新都会产出「内容有修改：Stars」，**真实信号被自己的噪声埋掉**。做法是只保留 `STAR_MILESTONES = [1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000]`，跨过一道门槛才产生**一条新增**。

**这一点还有一层**：里程碑条目的正文也**不能带当前计数**。第一版正文写成 `当前 Stars：11,213、Forks：…`，自己写的测试立刻证明「9999 → 10001 时 `stars:1000` 的指纹会变」→ 每次刷新给**每一道已跨过的门槛**报一次「内容有修改」。正文改为一句稳定的说明后，实测第二次刷新 `newChanges: 0`。

> 教训：**"这条记录会不会在内容没变时改变指纹"必须当成一条测试来写**，而不是靠肉眼审查字段列表。

`pushed_at` 同理不进条目；`topics` 必须**排序后** join（键序变化会造假变化）。`groupDigits()` 手写千位分隔而**刻意不用 `toLocaleString()`** —— 后者的输出依赖运行环境的 ICU 数据与默认区域，快照式比对会不稳定。

#### 6.10.3 `npm_package`：版本号进条目 id

条目 id 是 `version:7.31.0` 而**不是**固定的 `version`，于是发版在差异里读作「**新增：openai@7.31.0**」——最直接的一句话。依赖则用稳定 id（`dependencies` / `peerDependencies` / `engines`），增减读作「内容有修改：运行时依赖（N 个）」。实测三条真实记录：`新增：openai@7.31.0`、`内容有修改：peer 依赖（6 个）`、`内容有修改：运行环境要求`。

两个刻意的"不写"：
- **不写发布时间**（`publishedAt` 恒为 `null`）：单版本清单里没有发布时间，只有完整 packument 的 `time` 有，而它超限。**不编时间** —— 界面照实写"插件发现时间"。
- **不把 Node 要求重复写进版本条目正文**：重复会让一次运行环境变化同时修改两个条目，差异里出现两条指向同一件事的记录。

依赖文本必须 `Object.entries().sort()` —— JSON 键序不保证稳定。

#### 6.10.4 ⚠️ 一次 schema 漂移让**整个域**不可访问（真实事故）

**症状**：加完两个适配器、测试 281/281 全绿之后，真实宿主上的**所有写操作与大部分读操作**开始失败：

```
{"ok":false,"error":{"code":"STORAGE_OPEN_FAILED",
 "message":"本地存储打开失败，本次不做任何保存",
 "detail":{"reason":"打开域 ai_product_radar_sources 失败（invalid-record: domain
 'ai_product_radar_sources': stored record 'src_1db0065ded8a4342' in table 'sources'
 does not match its schema）"}}}
```

**根因**：`src/host/store/domains.js` 的 `SOURCE_TYPES` 是一张**手写的三元素清单**（`github_releases` / `rss_atom` / `html_static`）。加了 `github_repo` / `npm_package` 之后，新类型的记录过不了持久化设施 `open()` 时的逐条校验。

**为什么代价是整个域而不是一条记录**：`sourcesDomain` **刻意不声明 `invalidRecords`**（见 `domains.js:154-157` 的注释：来源配置是权威数据，静默丢弃比启动失败更糟）。这个决定本身是对的，但它把"一条记录不合 schema"放大成"用户数据一字未丢却完全无法访问"。

**为什么测试没抓到**：测试用的替身存储不走持久化设施的 `open()` 校验 —— 校验只在**从磁盘加载**时发生。所以这条只有真实宿主能暴露。

**修法（从根上消灭这类开关）**：把类型清单**改为从适配器注册表推导**：

```js
import { listAdapters } from '../adapters/index.js'
export const SOURCE_TYPES = listAdapters().map((adapter) => adapter.type)
```

注册一个适配器就自动获得"能被存下来"的资格。加类型的人不可能再忘记改这里，因为他根本不需要改。

**同一处还有第二个漂移（P1-01 留下的）**：`sourceRecord` 没有声明 `intervalMinutes` / `failureStreak`，而未声明的键会被结构校验器**静默丢掉**。实测症状正是"设成 15 分钟、看着生效、重开域回到 0"——比报错更难查，因为它只在重启之后才显形。两个字段现已声明为 `withDefault(count(), 0)`。

**修后实测（同一台真实宿主，PID 77234，`openCount` 97 → 98 证明域真的重开过）**：

| 步骤 | 结果 |
|---|---|
| `PATCH intervalMinutes=30 / 60` | ✅ 立刻生效 |
| `touch src/host/index.js` 触发 HMR → 域从磁盘重开 | `openCount` **97 → 98** |
| 重开后读回 | ✅ `techcrunch.com iv=30`、`www.theverge.com iv=60` —— **这次真的持久了**（修复前同一步会读回 0） |
| `GET /sources`、`POST /sources`、`POST /refresh` | ✅ 全部恢复（5/5 刷新成功） |

**防它的测试**（`test/domains.test.mjs`，3 条）：①`SOURCE_TYPES` 与 `listAdapters().map(a => a.type)` **逐字相同**；②每一个已注册类型都必须能被 `sourceRecord` 通过（失败信息直接写明"它会拖垮整个域"）；③P1-01 的两个字段 parse 后仍在，缺省补 0。

#### 6.10.5 第三个"写在两处"的地方：来源的默认名字

**症状**：`github_repo` 来源的展示名就是字面量 `github_repo` —— 一张叫"github_repo"的卡片认不出是哪个仓库。

**根因**：`service.js` 的 `defaultNameFor(type, config)` 硬编码了 `if (type === 'github_releases') return owner/repo`，其余类型一律去配置里找 `feedUrl ?? pageUrl` 取主机名。而两个新类型的配置里**没有 URL 字段**，于是落到 `catch { return type }`。

**修法**：把命名规则**交给适配器**（`defaultName(config)`），`defaultNameFor` 只在适配器没给时才回退到主机名逻辑。理由：名字的规则和配置的形状绑在一起，新增类型的人顺手就会写对，而不是要去 service 里找那张 if 表。三个适配器分别给出 `openai/openai-node`、`openai/openai-node`、`ai`（tag 非 `latest` 时 `@anthropic-ai/sdk@beta`）。

**同一节的三条合起来是一件事**：*同一件真相被写在两处时，改动一处就会留下一处过时的拷贝，而它的失效方式往往是静默的或全局的。* 见 [SDD.md](SDD.md) §3.1.1。

## 6.11 P1-06 实测：V4 —— typert 代码生成在打包运行时到底可不可用（2026-10-09）

### 6.11.1 判据本身

V4 的原判据是「查 `ctx.typert.local` 是否有生成描述符」。这句话必须**现场测**，不能靠读文档回答：文档说的是设计意图，"这台机器上的宿主到底挂没挂注册表、注册了哪个包的产物"是运行事实，而两者的差别恰恰是这个项目的全部风险所在。

为了让结论以后还能被复核（而不是只留在一次性的终端记录里），把它做成了插件的常驻能力报告：`GET /apradar/meta` 的 `runtime.typert`。探测逻辑在 `src/host/capabilities.js`。

### 6.11.2 现场结果（真实 tauri Profile，宿主 PID 77234）

```json
{
  "available": true,
  "reason": null,
  "packages": 23,
  "schemas": 0,
  "descriptors": 126,
  "remoteDescriptors": 0,
  "ownPackageRegistered": false,
  "sample": ["@deepseek-ai/dsh-llm", "@deepseek-ai/dsh-user-questions",
             "@deepseek-ai/dsh-permission-presets", "@deepseek-ai/dsh-commands",
             "@deepseek-ai/dsh-command-feedback"]
}
```

| 字段 | 实测 | 含义 |
|---|---|---|
| `available` | `true` | `ctx.typert` 已挂载（`dsh-base` 带 `dsh-typert-registry`） |
| `packages` | **23** | 23 个包贡献了生成反射（运行时共 26 个包声明 `"./typert"` 导出） |
| `schemas` | `0` | `ctx.typert.list()` 为空 —— **不是"没有 schema"**，而是 schema 按需惰性物化，没人读过之前列表就是空的 |
| **`descriptors`** | **126** | **V4 的判据**：`ctx.typert.local.list()` 有 **126 条**本环境调用描述符 |
| `remoteDescriptors` | `0` | 宿主进程里没有消费方选定的 Remote（符合预期） |
| `ownPackageRegistered` | **`false`** | 本插件不贡献任何生成产物 |

→ **判据成立：打包运行时里 typert 代码生成的产物是存在且正在被使用的。**

### 6.11.3 但"运行时能用"不等于"本插件能用"

这是本节真正要记下来的区别。三条原因，每条都独立成立：

**① 生成器是开发期工具，运行时里根本没有它。**

- 运行时里只有三个 typert 包：`dsh-typert-loader`、`dsh-typert-protocol`、`dsh-typert-registry`；**289 个 `@deepseek-ai` 包里没有任何 `*generator*`**。
- 生成器是独立发布的 npm 包 `@deepseek-ai/dsh-typert-generator`（描述原文："**TypeScript project analyzer** and model-driven Typert artifact generator"，依赖 `typescript ^6.0.3`）。
- 它通过 `exports["./tsdown"]` 以 **tsdown 插件**形态接入构建 —— 官方产 Typert 产物的包，`scripts` 就是 `{ "bundle": "tsdown", "watch": "tsdown --watch" }`，产物落在 `./lib/typert.host.js`（+ `.d.ts`）与 `./lib/typert.remote-client.js`。
- **运行时里没有 `tsdown`**（`.bin/` 与 `node_modules/` 都没有）。
- 本插件目前是**纯 JS、零运行时依赖、无构建步骤**（`dsh.client` 直接指源码 `src/client/client.js`，改完刷新页面即生效）。采用它 = 把插件改成 TypeScript 工程 + 引入 tsdown + 生成器 + `typescript@6`。

**② 客户端面没有 typert 发现机制。**

`dsh-typert-loader` README 的「已知限制」原文：

> **仅宿主侧** —— 发现机制只会导入宿主侧 `./typert` 产物；**在为客户端运行时添加等价的发现机制之前**，需要先有独立的组合所有者。

本插件的主要消费方**正是客户端面**（右侧边栏）。就算宿主侧产物齐备，客户端也拿不到等价的调用面。

**③ 更早的决策已经定过这件事的走向。**

`T17 / V1`（`COMPATIBILITY.md` §4.3）：Desktop 与隔离 Web Profile 双向实测均通过 → **Host→Client 同源 HTTP 方案维持不变**，无需改用 typert RPC，`SDD.md` §6.1 无需改写、**V4 不升为 P0**。

### 6.11.4 结论

**V4 结清：运行时可用（126 条 local 描述符），但本插件不迁移，保留 `/apradar/*` 同源 HTTP 路径。**

这不是"因为做不到而放弃" —— 判据本身是满足的。这是"成本与风险换不来收益，且已有一个经双向实测的合格方案"。如果将来本插件要走发布路线（P1-07）并需要端到端类型，这条记录里的三条原因就是重新评估的起点；**届时第 ② 条必须先行**，否则迁移只能覆盖一半。

### 6.11.5 探测模块自己的两个坑（都被测试当场抓住）

**坑一：把"消费一次"的迭代器遍历两遍。**

第一版为了省事，先用 `countEntries()` 数一遍、再遍历一遍取名字样例。若注册表返回的是迭代器而不是数组，第二遍就是空的 —— 于是会得出**"包数为 0、本插件没注册"这种看起来完全确定、实际完全错误**的结论。改为**一趟遍历同时得出总数、名字样例、有没有本插件**。

**坑二：用不完整的采样做否定结论。**

名字样例只取前 5 条（为了让人看得清）。第一版用 `names.includes(OWN_PACKAGE)` 得出 `ownPackageRegistered`，于是"本插件排在第 6 位"和"本插件没注册"给出同一个答案 `false`。现在样例只用于显示，**判断走完整遍历**；遍历中断时才回落到 `null`。

两个坑的共性是同一个：**`null`（没问出来）和 `false` / `0`（确实没有）必须分开**。前者只能支撑"这次没测出来"，后者才支撑"不采用"这样的结论。`test/capabilities.test.mjs`（12 项）就是守着这条线。

### 6.11.6 T16 路由契约（P1-06 的测试条件）

`COMPATIBILITY.md` 的 T16 此前一直是「未执行」。补上 `test/contract.test.mjs`（7 项）后：

- **21/21 条路由全覆盖** —— 表与 `ROUTES` **双向**比对，新增端点忘了补契约测试会直接失败。实测：故意删掉一条覆盖 → `有 1 条路由没有契约测试：GET /snapshots/:id`。
- 输入不合法时**一律 `ok:false` 且带 `code`**，HTTP 状态码逐条写死（`ADAPTER_CONFIG_INVALID` / `SOURCE_NOT_FOUND` / `NOT_FOUND` / `VALIDATION_FAILED`）。
- 未知路径 404、方法不符 405、非回环地址 403 —— 三种都是信封，不是空响应或断连。
- 三条 PATCH 的**字段级写权限**：多余字段当场 `FIELD_NOT_WRITABLE`，并同时给出 `detail.fields`（哪个字段）与 `detail.allowed`（哪些能写）；再反向验证一个合法字段确实写得进去，防止"所有 PATCH 都坏了"也能让前一条通过。
- Markdown 导出走**原始响应载体**：`content-type: text/markdown` 且 `body === null` —— 两种载体不能长得一样。

## 6.12 P1-07 实测：npm 发布形态 · 一条平台不会报的错（2026-10-09）

### 6.12.1 为什么把**整个**运行树组装进 `lib/`

验收 ① 的原话是"全新 profile 安装后**无需源码**即可运行"。宿主半边原本住在 `src/host/**`，如果 `files` 里保留 `src/`，这条验收只能靠"源码本身也是可执行 JS"含糊带过 —— 而那不是"无需源码"，那是"源码恰好能跑"。

所以 `npm run build`（`scripts/build.mjs`）做两件事：

| 产物 | 来源 | 变换 |
| :--- | :--- | :--- |
| `lib/client.js` | `src/client/client.js` | 加一行来源说明头（含**内容指纹**，**不含时间戳**） |
| `lib/**`（其余 29 个） | `src/host/**` | **逐字节复制**，不改一个字符 |

逐字节复制之所以成立：宿主半边是纯 ESM，没有 TS、没有 JSX、没有需要打包的依赖，连版本号都是常量（`src/host/version.js` 刻意不读 `package.json`，因为读它需要 `node:fs`，而 G-NET-2 禁止 Host 半边导入 `node:`）。

**头里刻意不写时间戳**：带时间戳的产物每次构建都不同，于是"产物与源是否一致"永远无法用比较判断 —— 漂移检查会退化成一句空话。改成内容指纹之后，`test/publish.test.mjs` 的漂移守卫才真的能抓住"改了源没重建"（实测：给 `lib/index.js` 追加一行注释 → 2 条断言失败；恢复后 30 个文件全部一致）。

### 6.12.2 客户端契约关口：基座模块表是**抄来的**，不是猜的

`window.__ModuleLoader__.load({ id, factory })` 的 bundle 只能请求"基座 ∪ `dsh.client.external`"里的模块。基座到底是什么，权威来源是外壳的源码：`@deepseek-ai/dsh-web-frontend/dist/assets/index-5SrrfWpU.js` 里 `staticModules: rM()`，`rM` 的函数体逐字为：

```
react · react/jsx-runtime · react-dom · react-dom/client ·
@deepseek-ai/cordis · @deepseek-ai/dsh-client-store ·
@deepseek-ai/dsh-client-ui-slots · @deepseek-ai/dsh-client-ui-primitives ·
@deepseek-ai/dsh-client-ui-dockkit
```

`scripts/client-contract.mjs` 把这张表写成冻结常量并注明出处，构建与测试共用**同一份**判据（写两处就会漂移）。本插件只 `require('react')`，所以 `dsh.client.external: []` 是正确的，测试还会**反向**要求"声明了 external 就必须真的用到它"。

`analyzeBundle()` 的六条检查里有一条值得单说：**必须先剥注释再扫**。第一次构建就失败了 —— `必须恰好有 1 次 __ModuleLoader__.load(…) ，实际 2 次`，第二次来自 `src/client/client.js` 文件头文档注释里的示例。`stripComments()` 用手写状态机（不能用正则：`https://` 里的 `//` 与模板串里的 `/*` 都会误判），它剥注释但**原样保留字符串**，模板串的 `${…}` 内嵌表达式递归当代码处理。

### 6.12.3 打包与干净 profile 的实测证据

```
npm pack                     -> dsh-apradar-0.1.0.tgz，total files: 33
tar -tzf ... | grep -cE "package/(src|demo|test|spike|scripts)/"   -> 0
```

33 个文件 = `package.json` + `README.md` + `cordis.patch.yml` + `lib/**`（30 个）。

装进全新 `DSH_HOME`：

```
plugin --profile web add /tmp/dsh-apradar-0.1.0.tgz   -> 442ms，Packages: +1
profiles/web/package.json:  dsh.profile.bundles = ["@deepseek-ai/dsh-base","@deepseek-ai/dsh-web-app","dsh-apradar"]
profiles/web/node_modules/dsh-apradar/  -> 只有 lib/ + cordis.patch.yml + package.json + README.md（无 src/）
```

启动（`--port 60842 --no-open`）后的日志：

```
[dsh-apradar] host route ready: 21 endpoints under /apradar
[dsh-apradar] scheduler started: tick=60000ms degraded=false
[dsh-apradar] scheduler capability: timerService=yes available=true degraded=false
[dsh-apradar] runtime: typert.available=true packages=23 descriptors=126 ownPackageRegistered=false
[dsh-apradar] runtime: clientHalf.composed=true path=/private/tmp/apr-clean-home/profiles/web/node_modules/dsh-apradar/lib/client.js
[dsh-apradar] storage ready: domain=ai_product_radar_sources specMode=official openCount=1 sources=0
dsh web: http://127.0.0.1:60842/?token=...
```

`grep -icE "activation|failed|missing bundle|未找到|缺失"` → **0**；`/apradar/ping` 200。页面探针：`pageErrors: []`、console `[apradar] 官方右侧栏页签已注册：kind = apradar`、**服务的是生成产物**（注解头在组合后的 combo 里）。

### 6.12.4 ⚠️ 核心发现：平台承诺的"缺失 bundle 会明确报错"**没有发生**

`@deepseek-ai/dsh-client-modules/README.zh.md` §构建要求原文：「宿主提供的是已构建的客户端 bundle，因此启动前 `pnpm run build` 必须已产出每个 `lib/client.js`；**缺失 bundle 会明确导致激活失败，并给出一条构建说明及包／路径列表**。」

代码里确实有这套设施（`lib/index.js`）：

- `:128` `const CLIENT_BUNDLE_BUILD_INSTRUCTION = "run \`pnpm run build\` before launch"`
- `:130-142` `class MissingClientBundleError extends Error`，消息三行 `client-modules: client bundle not found; run \`pnpm run build\` before launch:` / `  package: ${packageName}` / `  path: ${clientPath}`，并把 `packageName`、`clientPath` 留成结构化字段
- `:144-157` `class ClientPackageCompositionError extends AggregateError`，把缺失项渲染成 `    - package: …` / `      path: …`
- `:544` `if (failures.length > 0) throw new ClientPackageCompositionError(failures)`
- `:569` `clientPath(id) { return this.table.get(id)?.meta.clientPath }`
- `:811-822` `initialBundleSnapshot()` 在 `ENOENT` 时抛 `MissingClientBundleError`
- `:939` `if (!existsSync(clientPath)) return void 0`（chunk 路径上的**静默跳过**）

**但实测走的是静默路径。** 手工造了一个包（`lib/` 里删掉 `client.js`，用 `tar` 直接打包以免 `prepack` 补回来），装进第二个全新 profile 并启动：

| 观察点 | 结果 |
| :--- | :--- |
| 宿主启动 | **正常**，5 行插件日志齐全 |
| 宿主日志里的错误/警告 | **无**（grep `client bundle` / `compose` / `client-modules` 无匹配） |
| 页面 HTML（40461 字节）里 `apradar` 出现次数 | **0** |
| 页面里的 `failed to compose` / `client bundle not found` / `pnpm run build` | **都没有** |
| CDP 探针 | `pageErrors: []`、console **空**、`hitCount: 0` |
| 整个 `DSH_HOME` 里 grep `client bundle` | 无匹配 |

**用户会看到的**：一个"什么都没发生"的界面 —— 右栏没有雷达页签，也没有任何一句话解释为什么。

**处置（本插件自己报）**：`src/host/capabilities.js` 新增 `describeClientHalf(get, packageName = OWN_PACKAGE)`，用 `ctx.get('clientModules')` 的 `clientPath(id)` 做权威查询，**不碰文件系统**（Host 半边禁止 `node:` 导入）。三种回答严格分开：

| 情况 | 返回 | 为什么必须分开 |
| :--- | :--- | :--- |
| 没有 `clientModules` 服务（或 `get` 不是函数 / 查询抛错） | `available:false` + `reason`，`composed: null` | 我们**没有观察能力**；此时说 `false` 就是撒谎 |
| 服务在，但 `clientPath(本包)` 是空 | `available:true`、`composed:false` + 含包名、`exports["./client"]`、`npm run build`、"重启宿主"的 reason | 这是**确定的坏消息** |
| 服务在，查得到路径 | `composed:true` + `path` | 供人工核对 |

`src/host/index.js` 在启动时即调用它：`composed === false` 时 `warn(\`client half NOT composed: …\`)`，`composed === true` 时 `log(\`runtime: clientHalf.composed=true path=…\`)`，否则说明"没有观察能力"。实测两条对照：

```
（正常包）[dsh-apradar] runtime: clientHalf.composed=true path=/private/tmp/apr-clean-home/profiles/web/node_modules/dsh-apradar/lib/client.js
（缺 bundle）[dsh-apradar] client half NOT composed: 宿主没有为本包（dsh-apradar）组合出客户端入口。常见原因：exports["./client"] 指向的文件不存在（没跑构建），或包没有声明 dsh.client。修法：在包目录里跑 `npm run build`，然后重启宿主（宿主在启动时解析并缓存该路径）。
```

`/apradar/meta` 的 `runtime.clientHalf` 同形状持续可见（正常：`{available:true,composed:true,path:"…/dsh-apradar/lib/client.js"}`；缺 bundle：`{available:true,composed:false,path:null,reason:"…"}`）。

**另加一道闸门**：`prepack` 会跑构建，构建不过就**不写任何文件**并 exit 1 —— 也就是说这种包本来就发不出去。自诊断是给"绕过构建直接分发的包"与"手工改坏了安装目录"准备的第二道防线。

### 6.12.5 两个必须分清的"什么时候重启宿主"

| 场景 | 要不要重启宿主 | 依据 |
| :--- | :--- | :--- |
| 改客户端源码（`link:` 安装） | **不用**，刷新页面即可 | 宿主按 `exports` 解析路径，`link:` 指向仓库，读到的就是源码 |
| 改 `package.json` 的 `exports["./client"]` | **要重启** | 宿主在启动时把 `clientPath` 解析进 `pkgMeta` 并缓存（`dsh-client-modules/lib/index.js:723` 与 `:729`）。实测：把 `exports["./client"]` 改成 `./lib/client.js` 后 `touch package.json` **不足以**让宿主改用新路径，页面仍在加载旧路径 |
| `link:` 安装换成 tarball 安装 | **要重启** | 同上，路径变了 |

## 6.13 P1-07 收尾实测：一次 HMR 泄漏让整个存储不可用（2026-10-09）

### 6.13.1 现象

在真实 Desktop 宿主（PID 77234，端口 3080）上复核 P1-07 时发现：

```
/apradar/state -> storage.ok = false
reason = 打开域 ai_product_radar_sources 失败（already-open: domain 'ai_product_radar_sources' is already open）
counts = {sources: 0, snapshots: 0, changes: 0, opportunities: 0}
scheduler.lastError = {code: 'STORAGE_OPEN_FAILED', message: '本地存储打开失败，本次不做任何保存'}
```

**磁盘上的数据一条没少**（`sources.json` 3412 B、`opportunities.json` 933 B，结构完整），只是**读不进来也写不进去** —— 界面上是一个空雷达。

用户会怎么理解这件事？"我的数据没了。" 而实际原因是本插件的缺陷。

### 6.13.2 根因：释放钩子注册在 `await` 之后

`src/host/store/index.js` 的 `openRadarStoreInner()` 最初的写法是**先开完所有域、再注册释放钩子**：

```js
for (const domain of DOMAINS) {
  handle = await facility.open(spec)      // ← 先 await
  opened.set(domain.name, handle)
}
if (typeof ctx.effect === 'function') {
  ctx.effect(() => () => closeAll(opened), 'dsh-apradar: storage domain close')  // ← 后注册
}
```

HMR 重载时的真实时序：

1. 旧实例正在 `await facility.open(...)`（in-flight）。
2. 宿主释放旧实例的 fiber，调用它已注册的 disposer。
3. **旧实例的 promise 继续跑完**（没人取消它）。
4. 它这才执行 `ctx.effect(...)` —— 而此时它所在的 fiber **早就释放了**。
5. 于是这个 effect 注册到一个死作用域上，**disposer 永远不会被调用**。
6. 域句柄永久泄漏，`DomainFacility.reserved` 里那个名字再也不被释放。
7. 新实例 `open()` 同一个名字 → `already-open` → **整个存储初始化失败**。

一个值得记住的细节：**失败是"干净地正确"的** —— 泄漏的是句柄而不是数据，磁盘文件完好。所以从日志上它看起来像数据损坏，从盘上看又完全正常。这两种信号同时出现，指向的就是"资源没还回去"。

### 6.13.3 为什么测试没抓到

`test/store.test.mjs` 用的是**瞬时 resolve 的假设施**，而泄漏需要"打开的 promise 跨越了实例释放"这个时序。测出来的东西和真实的重载时序根本不是一回事 —— 这是**只有真实 HMR 才能暴露**的缺陷。

### 6.13.4 修法（两层）

**第一层：把释放钩子移到第一个 `await` 之前。**

`openRadarStore` 是异步函数，它的同步段在 `apply()` 里被调用，所以把注册放在函数最前面仍在有效的 fiber 内。再加上一个 `disposed` 标记处理"卸载发生在句柄还没 open 出来"的那一瞬间：

- disposer：`disposed = true; return closeAll(opened)`
- `await loadSpecBuilders()` 之后自查：已卸载 → 返回「存储初始化期间插件已被卸载，本次没有打开任何域」
- 每次 `opened.set()` 之后自查：已卸载 → `await closeAll(opened)` 并返回「…已关闭本次打开的域」

**第二层：`already-open` 自愈。**

即使还有别的时序能漏掉句柄，也不该让用户重启才能恢复。`src/host/store/index.js` 新增 `openDomainRecovering(domain, spec)`：捕获到 `already-open` 时，用设施的公开诊断接口 `facility.get(name)` 取回那个遗留句柄，`await stale.close()`，然后**重试一次**。

安全性来自三点，缺一不可：

| 前提 | 依据 |
| :--- | :--- |
| 四个域名由本插件独占（`ai_product_radar_*`） | 设施里挂着同名域的只可能是**本插件上一个实例**的残留 |
| 只在错误码**确实是** `already-open` 时做 | 其它错误（`malformed-medium` 等）一次都不重试、一次都不碰诊断接口（有测试钉着） |
| `facility.get(name)` 是官方公开接口 | `dsh-storage-domain` 的 `DomainFacility.get(name)`（注释写明是 diagnostic surface），返回的句柄 `close()` 幂等且会真正释放底层 unit |

失败时的文案也改了：从「重启 Harness 即可恢复」改为「**自动释放没有成功**…重启 Harness 即可恢复；你的数据没有损坏」—— 因为到这一步自愈已经试过了，而"数据没损坏"这句话必须留着。

### 6.13.5 实测：**不需要重启就恢复了**

改完 `src/host/store/index.js` 触发真实宿主的 HMR 重载，随后轮询 `/apradar/state`：

```
修复前： ok=false  openCount=0   counts={sources:0, snapshots:0, changes:0, opportunities:0}
修复后： ok=true   openCount=101 counts={sources:5, snapshots:29, changes:41, opportunities:2}
```

`counts` 与本插件停机前的记录**逐项相同**，`openCount` 继续从 98 往上走。也就是说：泄漏的句柄被自愈逻辑关掉了，域重新打开，**用户的数据一条不少地回来了，全程没有重启 Harness**。

### 6.13.6 测试

`test/store.test.mjs` 新增 **6 条**（套件 317 → **323**）：

1. 「open 已发出但还没落地时被卸载 —— 那只句柄必须被关掉」（**旧实现下真的失败**：实测 `实际关掉 0 个 / 0 !== 4`）
2. 「第一次 await 之前就被卸载时，一个域都不该打开」
3. 「关闭钩子必须把关闭的 promise 交回 Cordis」（`disposer.dispose()` 必须返回 Promise）
4. 「already-open 时关掉上一个实例的遗留句柄并重试一次」（断言四个域的遗留句柄全被关、四个域全被重开）
5. 「already-open 且拿不到遗留句柄时，如实失败并给出可行动的提示」（断言文案含 `重启 Harness` 与 `数据没有损坏`）
6. 「非 already-open 的打开失败不做自愈尝试」（断言 `attempts === 1` 且 `getCalls === 0`）

## 6.14 P0 详情页与跨视图闭环：真实宿主三路径实跑（2026-10-10）

### 6.14.1 为什么离线测试不够，必须再跑一次真实浏览器

`test/detail.test.mjs` 用的是自写的极简 React 替身（`test/client-harness.mjs`）。它**没有
CSS 引擎、没有真实布局、没有真实滚动容器**。它能证明的是：真实的 `src/client/client.js`
被加载、真实 Hook 序列、真实请求路径与请求体、真实 `nav` 状态机（含 `scrollTop` 的存取）。
它**不能**证明这四件事，而它们正好是这一轮的核心风险：

1. 详情真的在**页面内部**打开，而不是开了新页签 / 新增了 DSH 侧栏页签；
2. 滚动位置在**真实滚动容器**上真的被记住与写回（替身里的 `scrollTop` 只是个可写数字）；
3. 窄侧栏下**不出现横向溢出**（溢出是布局事实，静态读 CSS 证明不了）；
4. React 的**受控 textarea 真的接受了输入**并原样发请求（替身里的 value 是直接赋的，
   绕过了 React 的受控更新路径）。

探针：`spike/apradar-spike/test/eval-p0-three-paths.js`，由零依赖的
`spike/apradar-spike/test/cdp-run.mjs` 驱动（自写 RFC6455 客户端，不引入 puppeteer）。
环境：真实宿主 `http://127.0.0.1:3080`、headless Chrome、视口 **1440×757**。
**`pageErrors` 为空**；`failedRequests` 只有 1 条与本插件无关的 `net::ERR_CONNECTION_REFUSED`。

### 6.14.2 三条路径的实跑结果（全部通过）

| 路径 | 结果 |
| :--- | :--- |
| ① 变化列表 → 变化详情 → 读原文与差异 → **写备注** | ✅ `详情已打开`、来源与类型 / 官方发布时间 / 本次发现时间 / 原文摘录 / 差异区 / 处理状态**全部出现**、`详情滚动位置归零`；真实写入 `[P0 探针] …` → **`显示已保存`**（真实落盘）→ 随后**已还原原备注**；返回后 `滚动位置已恢复 240`、列表行数 20 |
| ② 关注源列表 → 来源详情 → 历史快照 → **试抓一次** | ✅ 5 个来源行的入口都是 `<button>`、**`行内动作与标题分离`**（行内的刷新/启停不会冒泡成导航）、规范化地址 / 上次成功 / 连续失败次数 / 上次抓取状态 / 快照历史 / 保留限制说明**全部出现**、`快照条数 5`；点「试抓一次」**真实出网**并拿到真实抓取结果 |
| ③ 机会列表 → 机会详情 → 改判断与问题 → **保存** → 跨对象跳到来源变化 | ✅ `机会行数 2`、**`手工机会是否明示 true`**（真机上那条无 `changeId` 的机会确实被标出「没有关联任何一次抓取记录」）、编辑表单 → 真实保存 → `详情含探针写入` → 随后 `已还原原判断`；跨对象跳转 `已跳转到关联变化`、crumb 变为 `‹ 返回变化列表`、**返回后回到机会详情**（来路栈生效） |

同轮量到的几何与可达性：

- **DSH 页签数仍是 3** —— 详情没有新增任何侧栏页签（任务书 §5 的硬约束）。
- **横向溢出**：真实侧栏宽度 **647px** → `文档横向溢出 0`、`内部溢出元素数 0`；
  强制 **320px** → 同样 **0 / 0**。
- **键盘**：`可聚焦元素数 9`、未禁用的**全部可聚焦**、被禁用的按钮 0。
- 截图由 `cdp-run.mjs` 的第 3 个参数指定，落在临时目录（本次为 `/tmp/apr-p0-paths.png`）；
  **它是一次性证据，没有进仓库** —— 要复现就重跑上面那条命令。上面这些数字才是留在文档里的记录。

### 6.14.3 ⚠️ 这一轮的验证**没有**覆盖到的部分（如实记录，不用静态检查冒充）

- **窄侧栏是模拟的，不是真实拖拽**：320px 那一组是脚本直接改 `panelRoot().style.width`
  量的，**不是**拖动 DSH 侧栏手柄到最窄。真实拖拽下的宽度、滚动条占位、以及 DSH 自身的
  容器约束都没量过。
- **焦点环的对比度没有逐主题量过**：只静态确认了 `.apr-row:focus-visible` 与
  `.apr-rowlink:focus-visible` 有 `outline` 规则；浅色/深色两套主题下的实际对比度
  没有截图取样。
- **没有覆盖"定时刷新真的等到某个来源到期"**：调度器在真实宿主上确实在跑
  （`scheduler { available:true, running:true, degraded:false, tickMs:60000 }`），
  但没有做跨越一个真实间隔（≥15 分钟）的等待实测。
- **一次探针跑的只是一条数据**：变化详情读的是当时列表第一条、来源详情读的是
  `openai` 那条 npm 源。不同适配器（RSS/Atom、HTML、GitHub Releases）的详情页
  只被离线测试与各自的真实抓取覆盖，没有逐适配器各跑一遍详情页。

### 6.14.4 ⚠️ 两个"看起来像插件 bug、其实是探针 bug"的坑（教训留着）

这两条如果没识别出来，会直接导致**误报**（把好好的功能当成坏的）：

1. **返回按钮点不动**：`ChangeDetail` 的返回栏里**只有一个按钮、没有标题 span**
   （`src/client/client.js:767`），于是 `.apr-crumb` 这个 `div` 与它里面的 `<button>`
   的 `textContent` **完全相同**。原探针按"文字精确相等"在 `querySelectorAll('*')` 里挑，
   DOM 顺序先返回外层 `div`，对它调 `.closest('button')` 得到 `null`，
   `div.click()` 什么都不做 —— 现象是"返回没生效、列表行数 0、滚动位置没恢复"。
   → 修法：**先查 `button` 精确匹配**，再退到"任意元素 + closest"，最后退到"以该文字开头的
   `button`"（页签文字后面跟着计数徽标，如 `关注源5`）。
   **推论**：DOM 查询里"文本相等"不等于"点得到"，`querySelectorAll('*')` 的祖先优先
   顺序会让这条错得很安静。
2. **返回文案与容器类名记错**：来源详情的返回按钮是 **`‹ 返回关注源列表`**，
   不是 `‹ 返回来源列表`；快照行的容器是 **`.apr-card`**（`SnapshotRow`，
   `src/client/client.js:970-972`），不是 `.apr-row` —— 来源行与机会行的外层容器
   同样是 `.apr-card`，标题入口是里面的 `button.apr-rowlink`，行内动作在**兄弟**
   `.apr-actions` 里。
   另外"禁用按钮不可聚焦"是**正常行为**，键盘判据不能写成
   `every((el) => el.tabIndex >= 0 && !el.disabled)`。

### 6.14.5 顺带修掉的记录级 404 文案（真 bug，非探针问题）

实测 `curl /apradar/opportunities/opp_nope` 得到的是默认文案「**找不到该接口**」——
听起来像插件装坏了，而接口明明找到了，找不到的是**那条记录**。这会让详情页同时显示
"读不出来：找不到该接口"和"没有这条机会"两句自相矛盾的话。

- `src/host/http.js:438` 的路径失配**本来就**有独立文案（`没有这个接口：<method> <path>`），
  `matchRoute`（`src/host/http.js:377`）的 `:id` 匹配任意单段，所以 `opp_nope` 确实
  命中了新路由、走进了 `getOpportunity` 的抛错分支 —— 两件事互不干扰。
- `src/host/errors.js` 新增 `notFoundError(what, detail)` →
  `new RadarError('NOT_FOUND', \`找不到这条${what}\`, detail)`；`src/host/service.js` 里
  **8 处**记录级抛错（快照 / 变化 ×2 / 机会 ×4 / 创建机会时 changeId 找不到）全部换掉，
  改完 `grep -n "radarError('NOT_FOUND'" src/host/service.js` **零命中**。
- `test/route.test.mjs` 新增表驱动 7 用例断言「说的是找不到这条记录，而不是找不到该接口」，
  并额外断言 `/apradar/nope` **仍然**是「没有这个接口」那套文案 —— 两者不能被混为一谈。
- 真实宿主热更新后：`/apradar/opportunities/opp_nope` → `找不到这条机会`，
  `/apradar/changes/chg_nope` → `找不到这条变化`。


## 7. 已知边界

- 本 Spike **不验证**采集、解析、去重、差异计算、安全闸门 —— 那些属于 P0-04 及以后。**持久化**已由 Milestone 1 的专项复验（6.4）补齐；**真实出网与三视图**由 6.6 补齐；**定时刷新与调度能力**由 6.7 补齐；**快照历史与保留等级**由 6.8 补齐；**V4 的 typert 代码生成结论与 T16 路由契约**由 6.11 补齐；**机会池导出与不可信内容防护**由 6.9 补齐；**新适配器选型、里程碑防噪声与 schema 漂移事故**由 6.10 补齐；**P0 详情页与跨视图操作闭环（含记录级 404 文案）**由 6.14 补齐。
- **本 Spike 不覆盖跨月/跨时区的定时语义**：调度器用的是 `lastCheckedAt + interval <= now` 的**时长**判定，不是本地钟表时间，因此不受时区与夏令时影响；但这也意味着界面显示的"下次大约"是一个**估算**（循环粒度 60 秒），不能当成承诺时刻。
- `dsh.client.inject` 中的 `@deepseek-ai/dsh-client-ui-sidebar-right` 是**声明性**的，不是 Cordis 注入；真正的注入在 Client 代码的 `ctx.inject(['sidebarRightTabs'], …)`。
- 客户端**无转译**（禁止 JSX、禁止打包器、只 `require('react')`），但 P1-07 起有一条 `npm run build` 把源组装成 `lib/` 运行树；**发布形态、客户端契约关口，以及「缺 bundle 时平台不报错」这条发现**由 6.12 补齐。
- 本 Spike 不覆盖 better-sidebar 备选路径（Knit 同时实现了该路径）；若官方右栏在未来版本失效，需另开验证。
- **不覆盖** npm registry 上的真实发布（本机未执行 `npm publish`）；**HMR 重载下的资源生命周期**由 6.13 补齐（含一次真实泄漏及其自愈）。：验证到 tarball + 全新 profile 安装 + 启动 + 客户端组合为止；`npm publish` 侧的账号、凭据与 registry 策略未验证。
- 本节所有结论的**有效性以 `COMPATIBILITY.md` §2 记录的三套版本号为准**；DSH 没有接口稳定性承诺（§8），升级后必须重跑本 Spike。
