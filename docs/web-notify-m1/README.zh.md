# Web 通知 M1（动态插件原型）

[English](README.md) | 中文

本目录保存 DSH Web GUI 会话通知能力的第一版（M1）动态 Cordis 插件快照：会话需要用户输入、任务完成、或异常时，在 GUI 内提醒，并在页面打开或挂后台时把提醒送到 Android 系统通知栏。

## 触发与行为

| 通知类型 | 触发信号（Host `session/event` / `agent/status` / `agent/error`） | 行为 |
| --- | --- | --- |
| needs-input（需输入） | `approval/asked`（审批）、`tool/call` 中 `ask_user_question`（提问） | 记录置 `active`，由 `approval/decided` / `tool/result` 消解为 `resolved`（✓）；1.5 秒内自动决策的记录静默删除 |
| completed（完成） | `agent/status` 由 `running` 转 `idle` | 单次记录；同会话 30 秒冷却 |
| error（异常） | `agent/error` | 单次记录；同会话 60 秒冷却 |

记录上限 500 条，按 `dedupeKey` 去重（`approval:<id>` / `question:<callId>` / `done:<sessionId>:<seq>`）。

## 架构

Host 半区（根上下文，跨会话可见）生成记录并提供三个 RPC：`notify/list`（全量 + 未读数）、`notify/markRead`、`notify/markAllRead`；同时经 `webServer.register` 提供 `/sw.js` 路由（最小 Service Worker：`skipWaiting` + `claim` + `notificationclick` 把 `sessionId` 经 `dsh-ntfy-open` 消息转发给页面）。

Client 半区注册 `sidebar.footer.action` 铃铛（未读角标）与 `shell.overlay` 通知中心面板：类型彩色标签、时间、已消解 ✓、点击跳转会话（`sessions.open`）、toast（4 秒自动消失）、权限状态与"测试系统通知"诊断按钮。

系统通知通道：优先 `ServiceWorkerRegistration.showNotification()`（Android Chrome 的 `new Notification()` 构造器不可用，抛 Illegal constructor），桌面降级 `new Notification()`；页面可见与否均可推送（面板开关可关），授权成功后补发未读记录。

驱动方式：页面每 4 秒轮询 `notify/list`，切回前台立即刷新；后台标签页受浏览器节流影响（最长约 1 分钟一次），挂后台时系统通知由 SW 通道负责。

## 文件

- [plugin-host.js](plugin-host.js) — Host 半区源码快照（定义时作为 `code.host`）
- [plugin-client.js](plugin-client.js) — Client 半区源码快照（定义时作为 `code.client`）

## 定义与运行

动态插件定义于当前进程，进程重启即丢失；本目录源码是唯一持久副本。定义方式：`cordis_define(kind: existing, pluginId: ntfy-4)`，以上述两个文件分别作为 `code.host` / `code.client`；运行方式：`cordis_run(pluginId: ntfy-4, packageId: <新包id>, mode: update)`。Client 半区需要用户在界面允许后才挂载。

## 验证状态

真机 Android（Chrome，HTTPS 隧道访问）：授予通知权限后，系统通知可达通知栏。本机 Playwright（桌面 Chrome）：`/sw.js` 返回 200 + `application/javascript`，SW 注册与 `showNotification` 调用路径验证通过（未授权时按预期拒绝）。

## 已知限制

- Client 半区只在批准那一刻所在的页面挂载，刷新后消失，需重新 `cordis_run`（动态插件机制）。
- 记录仅存于内存，进程重启丢失；需要持久化时迁移宿主插件（`storageDomain`）。
- 浏览器进程被划掉后无法提醒（无 Web Push）；纯内网无外网环境无法使用任何浏览器后台推送通道。
- 页面非 HTTPS（如 `http://局域网IP`）时 `Notification` 不存在，自动降级为纯站内提示。
- 插件停止后 `/sw.js` 路由消失，但浏览器已注册的 SW 保留旧脚本。

## 后续方向

- M2：迁移为宿主 composition 插件（`cordis.yml` 行），记录与订阅持久化、刷新不丢、事件驱动替代轮询。
- 原生 Android App：伴侣 App 常驻连接 + 厂商推送通道，覆盖浏览器被杀的场景。
