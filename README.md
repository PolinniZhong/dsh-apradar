# AI 产品雷达（AI Product Radar）

面向 AI 产品经理、Agent Harness 重度用户与独立开发者的**产品变化研究工具**，以 DeepSeek Harness 插件形式提供，入口在官方右侧栏。

它不试图做通用 AI 新闻阅读器。它要回答的是这几个问题：

- 我关注的这些产品/开源项目，**这一版相对上一版到底变了吗、变了什么**？
- 这个结论的**原始证据**在哪？官方日期是什么？我是什么时候发现的？
- 这条变化**和我自己的项目有什么关系**？值不值得我进一步验证？

## 当前状态：P0 全量完成 + P1 已完成的项

**这是一个能真实抓取、真实比较、真实留下证据的工具。** 下表按"证据等级"分开写，不把"跑通了"和"没做"混在一起说。

**已经在真实宿主里跑通、且被测试守着的部分：**

| 部分 | 状态 |
| :--- | :--- |
| Host 同源路由（`/apradar`） | 已实现，**22 条端点** |
| 右栏三个页签 + 三视图 | 已实现：**变化** / **关注源** / **机会池** 各是一个独立的官方右栏页签（`apradar:inbox` / `apradar:sources` / `apradar:opps`），可分别开关、并排；**只在右侧边栏**渲染 |
| 真实出网抓取 | **已实测**（`api.github.com` 与 4 个真实 Feed，见 [TECH-SPIKE.md](TECH-SPIKE.md) §6.6） |
| 解析适配器 | **5 类**：`github_releases`（api 优先双端点，因为本机 `github.com` 不可达）/ `github_repo`（仓库定位信息，Stars 只做里程碑）/ `npm_package`（单版本清单）/ `rss_atom` / `html_static`；另有 9 条预置模板 |
| 规范化 · 指纹去重 · 差异检测 | 已实现，**幂等**（内容没变时不产生假变化，已用真实数据验证） |
| 快照与保留等级 | 已实现，可查看最近 20 份快照的差异链，旧快照明示「仅保留摘录」 |
| 定时刷新 | 已实现（15 分钟 – 24 小时；连续 3 次失败自动停用并说明原因），**已实测自动触发** |
| 机会池导出 Markdown | 已实现（事实 / 推测分区 + 证据链，按不可信内容转义） |
| 四个域的声明式存储 | 已实现，跨重启持久化**已实测通过** |
| **可发布的 npm 包形态** | 已实现：`npm run build` 组装出自洽的 `lib/` 运行树，`npm pack` 出 **34 个文件、无 `src/`、无 `demo/`、无 `test/`**；在**全新 profile** 里从 tarball 安装并启动**无需源码**，零第三方依赖 |
| 客户端半边自诊断 | 已实现：缺失 `lib/client.js` 时平台**不会**报错（实测），本插件在启动时自己喊出来（`TECH-SPIKE.md` §6.12.4） |
| 离线测试套件 | **336 项 `node --test` 全通过**；测试绝不真出网（内存替身） |

**还没做的：**

| 部分 | 状态 |
| :--- | :--- |
| 目录索引缓存（P1-03） | 刻意不做，只在出现真实性能问题时才做 |
| 第三方 feed 解析库（P1-08） | 条件触发（门槛是核心 fixture 100%，已达到） |

界面上不会出现任何模拟数据、假刷新、假的"已保存"。抓不到就说抓不到，被截断就说是截断，失败原因一路带到你面前。

## 安装

**从本地目录安装（开发时最常用）：**

```bash
dsh plugin --profile <profile> add "<本仓库绝对路径>"
```

**从打包产物安装（模拟真实分发）：**

```bash
npm run build                       # 组装 lib/ 运行树（必做，见下）
npm pack                            # 产出 dsh-apradar-<version>.tgz
dsh plugin --profile <profile> add ./dsh-apradar-0.1.1.tgz
```

**升级：**

```bash
git pull
npm run build                       # 改了客户端就必须重建，否则装出来的包里是旧客户端
npm pack
dsh plugin --profile <profile> add ./dsh-apradar-<新版本>.tgz
```

之后**重启 Harness**（Desktop 直接退出重开，Web 重新执行 `dsh web --profile <profile>`），右栏会出现三个页签：**变化**、**关注源**、**机会池**（新建页签的引导页里也是这三张卡片）。会话头部的入口按钮打开的是「变化」页签。

> ⚠️ **宿主在启动时解析并缓存客户端的产物路径。** 只改客户端源码时刷新页面即可（`link:` 安装下宿主直接取源码）；但只要你动了 `package.json` 的 `exports["./client"]` 或把安装方式从 `link:` 换成 tarball，就**必须重启宿主**才生效 —— 这一点是实测出来的（`TECH-SPIKE.md` §6.12.5），不是推测。

技术验证用的 Spike 是**另一个包**（`spike/apradar-spike`，id `dsh-apradar-spike`），两者路由前缀与右栏标识都不冲突，可以同时安装 —— 但日常使用只需要装这一个。

## 开发

```bash
node --test 'test/*.test.mjs'
```

- **零运行时依赖**：`package.json` 里没有 `dependencies`，这是刻意的，理由写在 `src/host/store/schema.js` 顶部（`link:` 安装不会为被链接包安装依赖；官方 `@deepseek-ai/*` 无法从 profile 解析）。
- **客户端无转译，但有一条构建命令**：`src/client/client.js` 本身就是 loader bundle 本体（`window.__ModuleLoader__.load({...})`，禁止 JSX、禁止打包器、只 `require('react')`）。P1-07 起用 `npm run build` 把它组装成 `lib/client.js`（加一行来源说明头），并把 `src/host/**` 逐字节复制进 `lib/` —— 这个"构建"**不转译、不打包、不引依赖**，`prepack` 会自动跑。**改完客户端不跑构建，`test/publish.test.mjs` 会拦住你。**
- `npm run build:check` 只校验不写，用于 CI 或提交前自检。
- 测试用 Node 内建 `node --test`，不引入测试框架。

## 数据与隐私

- **数据存在哪里**：本插件使用 DSH 官方的领域存储设施（`dsh-storage-domain`，`backend: json`），文件落在 `$DSH_HOME/storages/` 下，文件名以 `ai_product_radar_` 开头。
- **卸载不会清理这些文件**。这是 DSH 当前的行为（已实测：卸载会移除 profile 的 bundle 记录与依赖声明，但不会碰 `storages/`），也是刻意的保守选择 —— 宁可留下数据，不要在卸载时误删用户的研究记录。要彻底清除，请手动删除 `$DSH_HOME/storages/ai_product_radar_*`。
- **本插件不读取你的项目代码，不访问登录态页面，不自动修改任何项目**。产品机会池里的"关联项目"只是你自己填的文本。
- **导出的 Markdown 由浏览器保存**（`Blob` + `<a download>`），插件不经过任何后端写文件 —— 它没有、也不会写你的项目目录。
- 采集、去重、差异计算与导出**全部不调用任何模型**；导出文件里"事实"与"推测"两个分区的区别是**数据来源**的区别（事实只能来自真实抓取落盘的记录），导出时会明确说出这一点。

## 安全边界

- Host 侧的对外请求一律走 DSH 已核验的 `ctx.web.fetch()`，**不使用 Node 原生 `fetch` 绕过**其 URL 校验、SSRF 公有地址白名单、超时与响应体上限。
- 插件路由通过 `webServer.register({ kind: 'prefix', path: '/apradar' })` 注册，**只服务回环地址**；非回环请求一律 403。
- 抓到的网页内容是**外部数据**，永远不作为指令执行；导出的 Markdown 里，来自公网抓取的摘录也按**不可信**处理（拆掉非 `http(s)` 的 URI 方案，转义能构成链接 / 自动链接 / 代码段 / 原始 HTML 的字符）。
- **不宣称"具备完整的 SSRF 防护"，也不宣称"网络请求无法被绕过"**：真正的防线在 DSH 抓取层，本插件只做地址字面量的快速失败。

## 文档

产品与设计文档在仓库根目录：

- `PRD.md` —— 产品背景、定位、信息架构、页面与交互需求、MVP 范围
- `SDD.md` —— 技术架构、Host/Client 职责、适配器、持久化 schema、安全边界
- `COMPATIBILITY.md` —— 实际核验的 DSH 版本、API 依据、能力矩阵、已知风险
- `MVP-BACKLOG.md` —— P0/P1/P2 拆分与验收标准
- `TECH-SPIKE.md` —— 技术验证 Spike 的实测记录与证据
- `CHANGELOG.md` —— 每个版本的发布内容（GitHub Release 正文取自这里）

## 许可证

MIT
