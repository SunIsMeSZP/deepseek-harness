# Web notification M1 (dynamic plugin prototype)

English | [中文](README.zh.md)

This directory holds the first-version (M1) snapshot of the DSH Web GUI session-notification capability as a dynamic Cordis plugin: when a session needs user input, completes, or fails, the GUI alerts in-app, and while the page is open or backgrounded the alert also reaches the Android system notification bar.

## Triggers and behavior

| Notification type | Trigger signal (Host `session/event` / `agent/status` / `agent/error`) | Behavior |
| --- | --- | --- |
| needs-input | `approval/asked` (approval), `tool/call` with `ask_user_question` (question) | Record becomes `active`; `approval/decided` / `tool/result` resolves it to `resolved` (✓); records decided within 1.5 s are dropped as noise |
| completed | `agent/status` transitions `running` → `idle` | One-shot record; 30 s per-session cooldown |
| error | `agent/error` | One-shot record; 60 s per-session cooldown |

The record list is capped at 500 entries and deduplicated by `dedupeKey` (`approval:<id>` / `question:<callId>` / `done:<sessionId>:<seq>`).

## Architecture

The host half runs on the root context (cross-session visibility), produces records, and exposes three RPC handlers: `notify/list` (full list + unread count), `notify/markRead`, `notify/markAllRead`; it also registers an exact `/sw.js` route through `webServer.register` that serves a minimal service worker (`skipWaiting` + `claim` + a `notificationclick` handler that forwards the session id to the page as a `dsh-ntfy-open` message).

The browser half registers a bell with an unread badge in `sidebar.footer.action` and a notification-center panel in `shell.overlay`: per-type colored chips, timestamps, resolved check marks, click-to-open session (`sessions.open`), toasts (auto-dismiss after 4 s), permission state, and a one-click "test system notification" diagnostic button.

System notifications go through `ServiceWorkerRegistration.showNotification()` first — the only legal channel on Android Chrome, whose `new Notification()` constructor throws "Illegal constructor" — with the desktop `new Notification()` constructor as fallback; they fire whether or not the page is visible (the panel toggle can disable the visible case), and granting permission replays the unread records.

Delivery is poll-driven: the page polls `notify/list` every 4 s and immediately on regaining focus; background tabs are subject to browser throttling (about 1 minute worst case), where the service-worker channel takes over system delivery.

## Files

- [plugin-host.js](plugin-host.js) — host-half source snapshot (define as `code.host`)
- [plugin-client.js](plugin-client.js) — browser-half source snapshot (define as `code.client`)

## Define and run

A dynamic plugin lives only in the current process and is lost on restart; these files are the only durable copy. Define with `cordis_define(kind: existing, pluginId: ntfy-4)` using the two files as `code.host` / `code.client`; run with `cordis_run(pluginId: ntfy-4, packageId: <new-package-id>, mode: update)`. The browser half mounts only after the user approves it in the GUI.

## Verification status

Verified on a real Android device (Chrome, HTTPS tunnel access): after granting the notification permission, system notifications reach the notification bar. Verified on desktop Chrome with Playwright: `/sw.js` returns 200 with `application/javascript`, service-worker registration and the `showNotification` call path succeed (rejected as expected without permission).

## Known limitations

- The browser half mounts only on the page that approved the run and vanishes on refresh; re-running restores it (dynamic-plugin mechanism).
- Records live in memory only and are lost on process restart; the host-plugin migration (`storageDomain`) provides persistence.
- Delivery stops when the browser process is swiped away (no Web Push); a private LAN without external internet has no usable browser push channel at all.
- On a non-HTTPS page (such as `http://<LAN-IP>`), `Notification` does not exist and the plugin degrades to in-app alerts only.
- When the plugin stops, the `/sw.js` route disappears but the browser keeps the last registered service-worker script.

## Next directions

- M2: migrate to a host-composition plugin (a `cordis.yml` row) with persisted records and subscriptions, refresh-surviving UI, and event-driven delivery instead of polling.
- Native Android app: a companion app with a persistent connection plus vendor push channels covering the browser-killed scenario.
