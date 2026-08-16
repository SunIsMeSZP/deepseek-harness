# Agent Note: Web notification M1 (dynamic plugin)

Status: implemented

[English](2026-08-17-web-notify-m1.md) | 中文

## Problem

DSH Web GUI 在会话需要用户输入、完成或失败时没有任何主动提醒：用户拿着手机或页面挂后台时，只有去看才能发现状态。目标环境是纯内网（无外网）的 Android 手机，这排除了所有浏览器推送通道——FCM 及任何推送服务都架设在公网上。

## Decision

M1 原型是动态 Cordis 插件（`ntfy-4`，v4 包），含 Host 半区与浏览器半区，快照存放于 [docs/web-notify-m1](../../../../docs/web-notify-m1/README.md)。

Host 半区挂载于根上下文，监听 `session/event`（`approval/asked`、`approval/decided`、`ask_user_question` 的 `tool/call`/`tool/result`）、`agent/status`（`running` → `idle`）与 `agent/error`，在内存中维护最多 500 条通知记录，按 `dedupeKey` 去重（审批与提问键将 `active` 消解为 `resolved`；1.5 秒内即决策的记录作为噪音删除；error 与完成分别有 60 秒与 30 秒的会话级冷却）。它暴露三个 RPC（`notify/list`、`notify/markRead`、`notify/markAllRead`），并在 `webServer` 上注册精确路由 `/sw.js`，提供最小 Service Worker（skipWaiting、claim、`notificationclick` 处理器把会话 id 以 `dsh-ntfy-open` 消息转发给页面）。

浏览器半区在 `sidebar.footer.action` 注册带未读角标的铃铛，在 `shell.overlay` 注册通知中心面板，每 4 秒轮询 `notify/list`（聚焦时立即刷新），页面可见时显示 toast，并推送系统通知。系统通知优先走 `ServiceWorkerRegistration.showNotification()`，桌面专用 `new Notification()` 构造器仅作降级：Chrome for Android 不向页面暴露该构造器，调用即抛 "Illegal constructor"，因此 SW 通道是那里唯一合法渠道。面板携带实时权限状态、一键测试通知与最近投递错误。

投递采用轮询而非事件推送，因为动态 Client 半区除 `host.call` 外没有服务端推送通道。

## Alternatives considered

**一开始就做宿主插件。** `cordis.yml` 中的正式插件行可跨刷新与重启存活，并可用 `storageDomain` 持久化记录。对 M1 而言输在迭代速度上——动态插件回路更适合快速调触发与 UI；迁移是 M2 轨道。

**Web Push / FCM。** 标准浏览器推送通道，但 Android Chrome 把推送服务写死为 Google FCM，需要 Google Play Services 与公网可达；目标局域网两者皆无。已拒绝。

**`new Notification()` 构造器。** 桌面 Chrome 可用，但 Chrome for Android 抛 "Illegal constructor"，错误信息本身要求改用 SW API。仅保留为桌面降级路径。

**原生 Android App。** 伴侣 App（常驻 WebSocket + 厂商推送通道）可覆盖浏览器被杀与大陆设备的场景，代价是第二套代码库。推迟到下一迭代。

## Consequences

动态插件生命周期限制原型：浏览器半区只挂载在批准运行的那个页面，刷新即消失（重新 run 可恢复），记录仅存于进程内存。

Android 系统通知在标签页存活期间可用，包括挂后台（后台节流下轮询延迟最长约 1 分钟）；划掉浏览器即停止投递。页面必须是 HTTPS 或 localhost，`Notification` 才存在。

插件停止后 `/sw.js` 路由消失，但已注册的 Service Worker 继续运行最后一份脚本，通知可存活到浏览器清理为止。

原型经真机 Android 验证：授予通知权限后，系统通知经 SW 通道到达通知栏；`/sw.js` 路由、SW 注册与 `showNotification` 调用路径另在桌面 Chrome 验证。

M1 的所得是三类提醒的站内 + Android 系统通知闭环；代价是易失生命周期与轮询延迟，由 M2 宿主插件迁移与原生 App 解决。
