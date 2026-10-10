# dsh-apradar-spike · P0-00 技术验证插件

> **这不是产品代码，也不是 Demo。**
> 它是「AI 产品雷达」正式开发前的前置闸门：只回答四个问题，回答完即可卸载。

## 它验证什么

| # | 问题 | 判据 |
|---|---|---|
| ① | 右栏页签能否注册 | 右侧栏出现「产品雷达 Spike」页签，且会话头部出现同名入口按钮 |
| ② | Client 能否**同源**访问插件注册的 HTTP 路由 | 面板顶部「页面来源」与路由 host 一致；`/ping` 返回 200 |
| ③ | Host 正常响应能否解析 | `/ping` 的 `code` 显示为 `spike/pong`，含 `ts`/`host`/`origin`/`pid` |
| ④ | 异常态能否区分且界面不崩溃 | 六条探针各自给出**不同**结论：500 错误码 / 200 非 JSON / 超时 / 空体 / 404 / 正常 |

## 路由

全部为 `GET`，仅服务回环地址：

| 路由 | 期望 |
|---|---|
| `/apradar-spike/ping` | `200` + `{ok:true, code:'spike/pong', ts, host, origin, pid, node, …}` |
| `/apradar-spike/boom` | `500` + `{ok:false, code:'spike/boom'}` |
| `/apradar-spike/not-json` | `200` + `text/html`（**不是** JSON） |
| `/apradar-spike/hang` | 10 秒后才响应 → Client 侧 4 秒主动超时 |
| `/apradar-spike/empty` | `200` + `content-length: 0` |
| 其它 | `404` + `{ok:false, code:'spike/not-found-route'}` |

非回环地址一律 `403 spike/loopback-only`；非 `GET` 一律 `405 spike/method-not-allowed`。

## 安装（需要写 `~/.dsh/profiles/<profile>`）

```bash
# Desktop 用的 profile
dsh plugin --profile tauri add "<本目录的绝对路径>"

# Web 用的 profile
dsh plugin --profile web add "<本目录的绝对路径>"
```

`dsh plugin add` 会把参数转发给 pnpm；本包无任何依赖，因此不会下载任何东西，也不会触发供应链闸门。

## 卸载

```bash
dsh plugin --profile tauri remove dsh-apradar-spike
dsh plugin --profile web remove dsh-apradar-spike
```

或直接从对应 profile 的 `package.json` 依赖中删除 `dsh-apradar-spike` 一行。

**本插件不写任何持久化数据**，因此卸载不会留下任何需要清理的残留。

## 已知边界

- 动态渲染 / 登录态 / 反爬页面与本 Spike 无关。
- `dsh.client.inject` 里的 `@deepseek-ai/dsh-client-ui-sidebar-right` 是**声明性**的，不是 Cordis 注入；
  真正的注入发生在 Client 代码里的 `ctx.inject(['sidebarRightTabs'], …)`。
- 客户端无构建步骤：`src/client/client.js` 是手写脚本，由 `window.__ModuleLoader__.load({...})` 直接装载，
  **禁止 JSX**（一律 `React.createElement`）。
