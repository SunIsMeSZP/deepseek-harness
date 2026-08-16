# Agent Note: Web notification M1 (dynamic plugin)

Status: implemented

English | [中文](2026-08-17-web-notify-m1.zh.md)

## Problem

The DSH Web GUI gives no proactive alert when a session needs user input, completes, or fails: a user on a phone or with the page backgrounded only discovers the state by looking. The target environment is an Android phone on a private LAN with no external internet, which rules out every browser push channel (FCM and any other push service live on the public internet).

## Decision

The M1 prototype is a dynamic Cordis plugin (`ntfy-4`, package v4) with a host half and a browser half, delivered as a snapshot in [docs/web-notify-m1](../../../../docs/web-notify-m1/README.md).

The host half listens on the root context to `session/event` (`approval/asked`, `approval/decided`, `tool/call`/`tool/result` for `ask_user_question`), `agent/status` (`running` → `idle`), and `agent/error`, and keeps up to 500 notification records in memory with `dedupeKey`-based dedup (approval and question keys resolve `active` → `resolved`; records decided within 1.5 s are dropped as noise; error and completion have per-session cooldowns of 60 s and 30 s). It exposes three RPC handlers (`notify/list`, `notify/markRead`, `notify/markAllRead`) and registers an exact `/sw.js` route on `webServer` that serves a minimal service worker (skipWaiting, claim, and a `notificationclick` handler that forwards the session id to the page as a `dsh-ntfy-open` message).

The browser half registers a bell with an unread badge in `sidebar.footer.action` and a notification-center panel in `shell.overlay`, polls `notify/list` every 4 s (immediately on focus), shows toasts when the page is visible, and pushes system notifications. System notifications go through `ServiceWorkerRegistration.showNotification()` first, with the desktop-only `new Notification()` constructor as fallback: Chrome for Android does not expose the constructor to pages and throws "Illegal constructor", so the service worker path is the only legal channel there. The panel carries live permission state, a one-click test notification, and the last delivery error.

Delivery is poll-driven rather than event-pushed because the dynamic client half has no server-push channel other than `host.call`.

## Alternatives considered

**Host-composition plugin from the start.** A real plugin row in `cordis.yml` would survive refreshes and restarts and could store records in `storageDomain`. It lost for M1 because the dynamic-plugin loop gives faster iteration on UI and trigger tuning; the migration is the M2 track.

**Web Push / FCM.** The standard browser push channel, but Chrome on Android fixes the push service to Google FCM, which needs Google Play Services and public-internet reach; the target LAN has neither. Rejected for this environment.

**`new Notification()` constructor.** Works on desktop Chrome but throws "Illegal constructor" on Chrome for Android; the error message itself mandates the service-worker API. Kept only as a desktop fallback.

**Native Android app.** A companion app with a foreground WebSocket plus vendor push channels would cover browser-killed scenarios and mainland-China devices, at the cost of a second codebase. Deferred to the next iteration.

## Consequences

The dynamic-plugin lifecycle bounds the prototype: the browser half mounts only on the page that approved the run and vanishes on refresh (a re-run restores it), and records live only in process memory.

Android system notifications work while the tab is alive, including backgrounded, with up to ~1 minute polling latency under background throttling; swiping the browser away ends delivery. The page must be HTTPS or localhost for `Notification` to exist at all.

The `sw.js` route disappears when the plugin stops, but an already-registered service worker keeps running its last script, so notifications can outlive a stop until the browser clears it.

The prototype verified on a real Android device: after granting the notification permission, system notifications reach the notification bar over the service-worker path; the `sw.js` route, registration, and `showNotification` call path were also verified on desktop Chrome.

The M1 gain is a working in-app plus Android system-notification loop for all three alert classes; the cost is the ephemeral lifecycle and polling latency that the M2 host-plugin migration and the native app address.
