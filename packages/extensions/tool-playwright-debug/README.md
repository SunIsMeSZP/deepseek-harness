# dsh-tool-playwright-debug

English | [中文](README.zh.md)

Launch or attach to a real browser and drive it with Playwright: navigate
pages, evaluate JavaScript in the page context, click/fill/type/select with
Playwright auto-waiting, snapshot the accessibility tree, capture console and
network activity per session, and take screenshots. Registers the
model-facing `playwright_web_debug` tool.

## Model experience

`playwright_web_debug` actions: `launch`, `attach`, `status`, `pages`, `bind`,
`open-page`, `navigate`, `reload`, `back`, `forward`, `eval`, `snapshot`,
`click`, `fill`, `type`, `select`, `wait`, `console`, `network`, `screenshot`,
`close-session`, `quit`.

- `launch` starts a browser with `browser.launch`. The row config picks the
  engine and channel; the default (`browser: chromium`, `channel: msedge`)
  drives the installed Microsoft Edge without any Playwright browser download.
  Each launch call may override `browser`, `channel`, `executablePath`,
  `headless`, and the window size.
- `attach` connects with `chromium.connectOverCDP` to an already-running debug
  endpoint on the configured port (any Edge/Chrome started with
  `--remote-debugging-port`). The external browser's lifetime is never
  touched; `quit` only drops this plugin's handle to it.
- Sessions are named Playwright pages (default `default`). Sessions created by
  `launch`/`open-page` own an isolated BrowserContext (fresh cookies per
  session); sessions bound with `bind`/`attach` reference an existing page and
  never close it.
- `eval` runs a JavaScript expression in the page context
  (`page.evaluate`, promises auto-awaited). With `selector`, the expression
  runs with `el` bound to the first matching element. Results are returned as
  JSON; oversized values come back as a truncated preview.
- `snapshot` returns the accessibility tree (`ariaSnapshot`) of the body or of
  one element — the intended way for the model to "see" a page. Bounded by
  `maxChars`.
- `click`/`fill`/`type`/`select` use Playwright locators with auto-waiting, so
  elements are acted on when they become actionable.
- `console` and `network` replay per-session ring buffers of console messages,
  page errors, and request/response entries; `clear: true` flushes after
  reading.
- `screenshot` writes a PNG to the requested path (full-page or one element
  via `selector`); the result reports `savedTo` and `bytes` so the image can
  be read back.

Implementation is a full-Node plugin: Playwright owns the browser process tree
directly, so no bridge process or subprocess service is needed. Commands are
serialized through one promise queue because the browser instance is
process-wide.

## Configuration

| key | type | default | meaning |
| --- | --- | --- | --- |
| `browser` | string | `chromium` | engine used by `launch`: `chromium`, `firefox`, or `webkit` |
| `channel` | string | `msedge` | browser distribution channel (chromium only); empty string uses the bundled Playwright build |
| `executablePath` | string | — | explicit browser executable; wins over `channel` |
| `cdpPort` | number | `9333` | CDP debugging port used by `attach` |
| `headless` | boolean | `false` | launch headless when the call does not say otherwise |
| `windowWidth` / `windowHeight` | number | `0` | launch window size; `0` leaves the viewport to the browser |
| `actionTimeoutMs` | number | `30000` | default timeout for click/fill/type/select/wait |
| `navigationTimeoutMs` | number | `45000` | default timeout for navigation and launch waits |
| `maxSnapshotChars` | number | `20000` | cap on the `snapshot` result |
| `maxResultChars` | number | `20000` | cap on the serialized `eval` result |
| `consoleBufferSize` / `networkBufferSize` | number | `200` | entries kept per session |

Bundled-browser note: `channel: msedge` (or `chrome`) drives the installed
browser and needs no download. To use the bundled Playwright Chromium instead,
set `channel` to `''` and run `npx playwright install chromium` once.

## Known Limitations and Deferred Work

- `attach` is chromium-only (`connectOverCDP` speaks CDP); Firefox/WebKit can
  be `launch`ed but not attached.
- In attached mode, `quit` disconnects via `browser.close()`, which never
  stops the external browser (verified against Edge on Windows); pre-existing
  tabs stay open.
- Screenshots are PNG only; video and trace recording are not exposed.
- The tool evaluates arbitrary JavaScript in the debugged page and can
  screenshot any content; deployments that treat this as sensitive should
  gate it behind an approval policy (`ask`).
