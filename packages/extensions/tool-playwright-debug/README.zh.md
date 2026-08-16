# dsh-tool-playwright-debug

[English](README.md) | 中文

启动或附着真实浏览器并用 Playwright 驱动：跳转页面、在页面上下文里执行
JavaScript、以 Playwright 自动等待完成 click/fill/type/select、抓取可访问性
树快照、按会话捕获 console 与网络活动、截图。注册面向模型的
`playwright_web_debug` 工具。

## 模型体验

`playwright_web_debug` 动作：`launch`、`attach`、`status`、`pages`、`bind`、
`open-page`、`navigate`、`reload`、`back`、`forward`、`eval`、`snapshot`、
`click`、`fill`、`type`、`select`、`wait`、`console`、`network`、
`screenshot`、`close-session`、`quit`。

- `launch` 用 `browser.launch` 启动浏览器。行配置决定引擎与渠道；默认
  （`browser: chromium`、`channel: msedge`）直接驱动已安装的 Microsoft
  Edge，无需下载 Playwright 浏览器。每次 launch 调用可覆盖 `browser`、
  `channel`、`executablePath`、`headless` 与窗口尺寸。
- `attach` 用 `chromium.connectOverCDP` 连接一个已在跑的调试端点（配置端口，
  任何以 `--remote-debugging-port` 启动的 Edge/Chrome）。外部浏览器的生命周期
  永不被触碰；`quit` 只丢弃本插件对它的句柄。
- 会话是具名的 Playwright 页面（默认 `default`）。`launch`/`open-page` 创建的
  会话拥有隔离的 BrowserContext（每个会话全新 cookie）；`bind`/`attach` 绑定的
  会话引用现有页面且永不关闭它。
- `eval` 在页面上下文执行 JavaScript 表达式（`page.evaluate`，promise 自动
  await）。带 `selector` 时，表达式以 `el` 绑定首个匹配元素运行。结果以 JSON
  返回；超大值返回截断预览。
- `snapshot` 返回 body 或单个元素的可访问性树（`ariaSnapshot`）——模型“看见”
  页面的既定方式。受 `maxChars` 限制。
- `click`/`fill`/`type`/`select` 使用带自动等待的 Playwright locator，元素可
  操作时才执行。
- `console` 与 `network` 回放每个会话的环形缓冲：console 消息、页面错误与
  请求/响应条目；`clear: true` 读取后清空。
- `screenshot` 把 PNG 写入请求路径（整页或经 `selector` 的单个元素）；结果
  报告 `savedTo` 与 `bytes`，便于回读图像。

实现是全 Node 插件：Playwright 直接拥有浏览器进程树，无需桥接进程或
subprocess 服务。命令经单个 promise 队列串行化，因为浏览器实例是进程级的。

## 配置

| 键 | 类型 | 默认 | 含义 |
| --- | --- | --- | --- |
| `browser` | string | `chromium` | `launch` 使用的引擎：`chromium`、`firefox` 或 `webkit` |
| `channel` | string | `msedge` | 浏览器发行渠道（仅 chromium）；空串使用随包的 Playwright 构建 |
| `executablePath` | string | — | 显式浏览器可执行文件；优先于 `channel` |
| `cdpPort` | number | `9333` | `attach` 使用的 CDP 调试端口 |
| `headless` | boolean | `false` | 调用未指定时以无头方式启动 |
| `windowWidth` / `windowHeight` | number | `0` | 启动窗口尺寸；`0` 交由浏览器决定视口 |
| `actionTimeoutMs` | number | `30000` | click/fill/type/select/wait 的默认超时 |
| `navigationTimeoutMs` | number | `45000` | 导航与启动等待的默认超时 |
| `maxSnapshotChars` | number | `20000` | `snapshot` 结果上限 |
| `maxResultChars` | number | `20000` | 序列化 `eval` 结果上限 |
| `consoleBufferSize` / `networkBufferSize` | number | `200` | 每会话保留的条目数 |

随包浏览器说明：`channel: msedge`（或 `chrome`）驱动已安装的浏览器，无需
下载。改用随包的 Playwright Chromium 时，把 `channel` 设为 `''` 并运行一次
`npx playwright install chromium`。

## 已知限制与后续工作

- `attach` 仅支持 chromium（`connectOverCDP` 说 CDP）；Firefox/WebKit 只能
  `launch` 不能附着。
- attached 模式下 `quit` 经 `browser.close()` 断开，永不停止外部浏览器（已在
  Windows 的 Edge 上验证）；既有标签页保持打开。
- 截图仅 PNG；未暴露视频与 trace 录制。
- 该工具在被调试页面执行任意 JavaScript，也能对任何内容截图；把它视为敏感
  能力的部署应置于审批策略（`ask`）之后。
