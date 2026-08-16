/**
 * Playwright Web Debugger — launch or attach to a real browser and drive it
 * through Playwright: navigate pages, evaluate JavaScript in the page context,
 * click/fill/type/select with Playwright auto-waiting, snapshot the
 * accessibility tree, capture console and network activity per session, and
 * take screenshots. Registers the model-facing `playwright_web_debug` tool.
 *
 * Implementation notes:
 * - Full-Node plugin. The browser process tree is owned by Playwright itself,
 *   so no bridge process or subprocess service is needed.
 * - `launch` starts a browser with `browser.launch` (row config picks the
 *   engine and channel; `channel: msedge` drives an installed Edge/Chrome
 *   without any Playwright browser download). `attach` connects with
 *   `chromium.connectOverCDP` to an already-running debug endpoint; that
 *   external browser is never stopped, and `quit` only drops this plugin's
 *   handle to it.
 * - Sessions are named Playwright pages. Sessions created by `launch`,
 *   `open-page`, or fallback re-creation own their BrowserContext (cookie
 *   isolation per session); sessions bound with `bind`/`attach` reference an
 *   existing page and never close it.
 * - All commands for one process-wide browser are serialized through a promise
 *   queue.
 * @module @deepseek-ai/dsh-tool-playwright-debug
 */

import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import {
  chromium, firefox, webkit,
} from 'playwright'
import type {
  Browser, BrowserContext, BrowserType, ConsoleMessage, Page, Request, Response,
} from 'playwright'

/** Loader-visible plugin name. */
export const name = 'tool-playwright-debug'

/** Services this plugin consumes. */
export const inject = ['tools']

const ENGINES: Record<string, BrowserType> = { chromium, firefox, webkit }

const WAIT_UNTIL_VALUES = ['load', 'domcontentloaded', 'networkidle', 'commit'] as const
const WAIT_FOR_STATES = ['attached', 'detached', 'visible', 'hidden'] as const
const LOAD_STATES = ['load', 'domcontentloaded', 'networkidle'] as const
const INTERNAL_PAGE = /^(edge|chrome|devtools|chrome-extension|brave|opera|vivaldi):/

/** Deployment configuration for the playwright debug tool. Fields are optional by default; defaults fill the row config. */
export interface Config {
  /** Browser engine used by launch. */
  browser: string
  /**
   * Browser distribution channel (chromium only). `msedge` drives an installed
   * Microsoft Edge without a Playwright browser download. Empty string uses
   * the bundled Playwright build.
   */
  channel: string
  /** Explicit browser executable path; wins over channel when set. */
  executablePath: string
  /** CDP debugging port used by attach (the external browser must be started with --remote-debugging-port). */
  cdpPort: number
  /** Launch the browser headless when the call does not say otherwise. */
  headless: boolean
  /** Launch window width; 0 leaves the viewport to the browser. */
  windowWidth: number
  /** Launch window height; 0 leaves the viewport to the browser. */
  windowHeight: number
  /** Default timeout for click/fill/type/select/wait actions. */
  actionTimeoutMs: number
  /** Default timeout for navigation and launch waits. */
  navigationTimeoutMs: number
  /** Cap on the aria snapshot string returned by snapshot. */
  maxSnapshotChars: number
  /** Cap on the serialized eval result; oversized results are returned as a truncated preview. */
  maxResultChars: number
  /** Console entries kept per session. */
  consoleBufferSize: number
  /** Network entries kept per session. */
  networkBufferSize: number
}

export const Config: z<Config> = z.object({
  browser: z.string().default('chromium'),
  channel: z.string().default('msedge'),
  executablePath: z.string().default(''),
  cdpPort: z.number().default(9333),
  headless: z.boolean().default(false),
  windowWidth: z.number().default(0),
  windowHeight: z.number().default(0),
  actionTimeoutMs: z.number().default(30000),
  navigationTimeoutMs: z.number().default(45000),
  maxSnapshotChars: z.number().default(20000),
  maxResultChars: z.number().default(20000),
  consoleBufferSize: z.number().default(200),
  networkBufferSize: z.number().default(200),
})

/** Standard-schema view of the Config, mirroring the Loader's own validation. */
interface StandardValidated {
  value?: unknown
  issues?: readonly unknown[]
}

/**
 * Apply the Config schema so defaults materialize even when apply() is called
 * directly without the Loader's validation step; invalid raw config fails loud.
 */
function resolveConfig(config: unknown): Config {
  const schema = Config as unknown as {
    '~standard'?: { validate(input: unknown): StandardValidated }
  }
  const standard = schema['~standard']
  if (!standard) return config as Config
  const result = standard.validate(config)
  if (result.issues && result.issues.length > 0) {
    throw new Error(`invalid tool-playwright-debug config: ${JSON.stringify(result.issues)}`)
  }
  return result.value as Config
}

interface ConsoleEntry {
  type: string
  text: string
  location: string | null
}

interface PageErrorEntry {
  message: string
}

interface NetworkEntry {
  method: string
  url: string
  status: number | null
  resourceType: string
  failed: boolean
  error?: string
}

/** One named Playwright page plus its bounded capture buffers. */
interface Session {
  name: string
  /** Owning context; null when the session references an external page it must never close. */
  context: BrowserContext | null
  page: Page
  console: ConsoleEntry[]
  errors: PageErrorEntry[]
  network: NetworkEntry[]
  unwire: (() => void) | null
}

interface State {
  /** 'owned' (we launched the browser) | 'attached' (external endpoint) | null. */
  mode: 'owned' | 'attached' | null
  browser: Browser | null
  browserName: string | null
  sessions: Map<string, Session>
}

/** The validated `playwright_web_debug` argument object, as defined by the tool schema below. */
interface ToolArgs {
  action?: 'launch' | 'attach' | 'status' | 'pages' | 'bind' | 'open-page' | 'navigate' | 'reload' | 'back' | 'forward'
    | 'eval' | 'snapshot' | 'click' | 'fill' | 'type' | 'select' | 'wait' | 'console' | 'network' | 'screenshot'
    | 'close-session' | 'quit'
  url?: string
  headless?: boolean
  browser?: string
  channel?: string
  executablePath?: string
  windowWidth?: number
  windowHeight?: number
  session?: string
  page?: string
  expression?: string
  selector?: string
  index?: number
  value?: string
  text?: string
  delayMs?: number
  by?: 'value' | 'label'
  waitUntil?: typeof WAIT_UNTIL_VALUES[number]
  state?: typeof WAIT_FOR_STATES[number]
  loadState?: typeof LOAD_STATES[number]
  fullPage?: boolean
  maxChars?: number
  timeoutMs?: number
  path?: string
  clear?: boolean
}

export function apply(ctx: Context, config: unknown = {}): void {
  const cfg = resolveConfig(config)
  if (cfg.browser && !ENGINES[cfg.browser]) {
    throw new Error(`unsupported browser "${cfg.browser}" — use chromium, firefox, or webkit`)
  }
  if (cfg.channel && cfg.browser !== 'chromium') {
    throw new Error('config channel is only supported with browser: chromium')
  }

  const state: State = {
    mode: null,
    browser: null,
    browserName: null,
    sessions: new Map(),
  }

  function getBrowser(): Browser {
    if (state.browser === null || !state.browser.isConnected()) {
      throw new Error('no browser — call action "launch" or "attach" first')
    }
    return state.browser
  }

  function normalizeUrl(url: string | undefined): string {
    if (!url) return ''
    const u = String(url).trim()
    if (!u) return ''
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(u)) return u
    return 'http://' + u
  }

  function pushBounded<T>(list: T[], item: T, cap: number): void {
    list.push(item)
    if (list.length > cap) list.shift()
  }

  /** Attach console / network / pageerror capture to one page; returns the disposer. */
  function wireSession(s: Session): () => void {
    const page = s.page
    const onConsole = (msg: ConsoleMessage): void => {
      const loc = msg.location()
      pushBounded(s.console, {
        type: msg.type(),
        text: msg.text(),
        location: loc ? `${loc.url}:${loc.lineNumber}` : null,
      }, cfg.consoleBufferSize)
    }
    const onPageError = (err: Error): void => {
      pushBounded(s.errors, { message: String(err && err.message || err) }, cfg.consoleBufferSize)
    }
    const onResponse = (res: Response): void => {
      const req = res.request()
      pushBounded(s.network, {
        method: req.method(),
        url: req.url(),
        status: res.status(),
        resourceType: req.resourceType(),
        failed: false,
      }, cfg.networkBufferSize)
    }
    const onRequestFailed = (req: Request): void => {
      const failure = req.failure()
      pushBounded(s.network, {
        method: req.method(),
        url: req.url(),
        status: null,
        resourceType: req.resourceType(),
        failed: true,
        error: failure ? failure.errorText : 'request failed',
      }, cfg.networkBufferSize)
    }
    page.on('console', onConsole)
    page.on('pageerror', onPageError)
    page.on('response', onResponse)
    page.on('requestfailed', onRequestFailed)
    return () => {
      page.off('console', onConsole)
      page.off('pageerror', onPageError)
      page.off('response', onResponse)
      page.off('requestfailed', onRequestFailed)
    }
  }

  async function safeTitle(page: Page): Promise<string> {
    try {
      return await page.title()
    } catch {
      return ''
    }
  }

  /** Close one session: owned contexts are closed, bound pages are only detached. */
  async function closeSession(name: string): Promise<boolean> {
    const s = state.sessions.get(name)
    if (!s) return false
    state.sessions.delete(name)
    if (s.unwire) s.unwire()
    if (s.context && !s.page.isClosed()) {
      try { await s.context.close() } catch { /* browser may already be gone */ }
    }
    return true
  }

  /** Create a fresh context + page owned by a named session. */
  async function openOwnedSession(
    name: string,
    url: string | null,
    viewport: { width: number; height: number } | null,
  ): Promise<{ session: Session; navError: string | null }> {
    await closeSession(name)
    const contextOptions = viewport ? { viewport } : {}
    const context = await getBrowser().newContext(contextOptions)
    const page = await context.newPage()
    const s: Session = { name, context, page, console: [], errors: [], network: [], unwire: null }
    s.unwire = wireSession(s)
    state.sessions.set(name, s)
    let navError: string | null = null
    if (url) {
      try {
        await page.goto(normalizeUrl(url), { waitUntil: 'load', timeout: cfg.navigationTimeoutMs })
      } catch (error) {
        navError = String(error instanceof Error ? error.message : error)
      }
    }
    return { session: s, navError }
  }

  async function ensureSession(session: string | undefined): Promise<Session> {
    const name = session ? session : 'default'
    const existing = state.sessions.get(name)
    if (existing && !existing.page.isClosed()) return existing
    const { session: created } = await openOwnedSession(name, null, null)
    return created
  }

  function safeUrl(page: Page): string {
    try {
      return page.url()
    } catch {
      return '(closed)'
    }
  }

  async function sessionList(): Promise<Array<{ name: string; ownsContext: boolean; url: string; title: string }>> {
    const out = []
    for (const s of state.sessions.values()) {
      out.push({ name: s.name, ownsContext: !!s.context, url: safeUrl(s.page), title: await safeTitle(s.page) })
    }
    return out
  }

  function sessionNameOf(page: Page): string | null {
    for (const s of state.sessions.values()) {
      if (s.page === page) return s.name
    }
    return null
  }

  interface PageInfo {
    id: string
    context: number
    page: number
    url: string
    title: string
    session: string | null
  }

  async function listPages(): Promise<PageInfo[]> {
    const out: PageInfo[] = []
    let contextIndex = 0
    for (const context of getBrowser().contexts()) {
      let pageIndex = 0
      for (const page of context.pages()) {
        out.push({
          id: `c${contextIndex}.p${pageIndex}`,
          context: contextIndex,
          page: pageIndex,
          url: page.url(),
          title: await safeTitle(page),
          session: sessionNameOf(page),
        })
        pageIndex += 1
      }
      contextIndex += 1
    }
    return out
  }

  interface StatusValue {
    mode: 'owned' | 'attached' | null
    browser: string | null
    sessions: Array<{ name: string; ownsContext: boolean; url: string }>
  }

  function status(): StatusValue {
    return {
      mode: state.mode,
      browser: state.browserName,
      sessions: [...state.sessions.values()].map(s => ({ name: s.name, ownsContext: !!s.context, url: safeUrl(s.page) })),
    }
  }

  async function doLaunch(args: ToolArgs): Promise<JsonValue> {
    if (state.mode === 'attached') {
      throw new Error(`attached to an external browser on port ${cfg.cdpPort} — quit first`)
    }
    if (state.mode === 'owned' && state.browser && state.browser.isConnected()) {
      return { ok: true, alreadyRunning: true, ...status() }
    }
    const engineKey = args.browser || cfg.browser
    const engine = ENGINES[engineKey]
    if (!engine) throw new Error(`unsupported browser "${engineKey}" — use chromium, firefox, or webkit`)
    const channel = args.channel ?? cfg.channel
    const executablePath = args.executablePath || cfg.executablePath
    if (engineKey !== 'chromium' && channel) {
      throw new Error('channel is only supported with browser: chromium')
    }
    const headless = args.headless ?? cfg.headless
    const options = {
      headless,
      ...(channel ? { channel } : {}),
      ...(executablePath ? { executablePath } : {}),
    }

    const browser = await engine.launch(options)
    state.browser = browser
    state.browserName = engineKey
    state.mode = 'owned'

    const width = args.windowWidth ?? cfg.windowWidth
    const height = args.windowHeight ?? cfg.windowHeight
    const viewport = width > 0 && height > 0 ? { width, height } : null
    const url = normalizeUrl(args.url)
    const { navError } = await openOwnedSession('default', url || null, viewport)

    // process() is not part of Playwright's public surface; read the pid best-effort.
    const processView = browser as unknown as { process?: () => { pid?: number } | null }
    const pid = processView.process?.()?.pid ?? null
    return {
      ok: true,
      mode: 'owned',
      browser: engineKey,
      channel: channel || null,
      executablePath: executablePath || null,
      headless,
      version: browser.version(),
      pid,
      pageError: navError,
      sessions: await sessionList(),
    }
  }

  async function doAttach(args: ToolArgs): Promise<JsonValue> {
    if (state.mode === 'owned' && state.browser && state.browser.isConnected()) {
      throw new Error('an owned browser is running — quit it first')
    }
    if (state.mode === 'attached' && state.browser && state.browser.isConnected()) {
      return { ok: true, alreadyAttached: true, port: cfg.cdpPort, ...status() }
    }
    let browser: Browser
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cfg.cdpPort}`, { timeout: 15000 })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw new Error(`no debug endpoint on port ${cfg.cdpPort} — start Edge/Chrome with --remote-debugging-port=${cfg.cdpPort} first (${detail})`)
    }
    state.browser = browser
    state.browserName = 'chromium'
    state.mode = 'attached'
    state.sessions.clear()

    const pages = browser.contexts().flatMap(c => c.pages())
    if (pages.length > 0) {
      const page = pages.find(p => !INTERNAL_PAGE.test(p.url())) ?? pages[0]
      if (!page) throw new Error('no page target available to bind')
      const s: Session = { name: 'default', context: null, page, console: [], errors: [], network: [], unwire: null }
      s.unwire = wireSession(s)
      state.sessions.set('default', s)
    } else {
      const url = normalizeUrl(args.url)
      await openOwnedSession('default', url || null, null)
    }
    return {
      ok: true,
      mode: 'attached',
      port: cfg.cdpPort,
      version: browser.version(),
      // PageInfo lacks JsonValue's index signature only because it is an interface.
      pages: await listPages() as unknown as JsonValue[],
      sessions: await sessionList(),
      note: 'external browser — quit only detaches the debugger, it does not stop the browser',
    }
  }

  async function doOpenPage(args: ToolArgs): Promise<JsonValue> {
    const name = args.session ? args.session : 'default'
    const url = normalizeUrl(args.url)
    const { session, navError } = await openOwnedSession(name, url || null, null)
    return {
      ok: true,
      session: session.name,
      url: session.page.url(),
      title: await safeTitle(session.page),
      pageError: navError,
    }
  }

  async function doBind(args: ToolArgs): Promise<JsonValue> {
    getBrowser()
    const pageId = args.page ?? ''
    const match = /^c(\d+)\.p(\d+)$/.exec(pageId)
    if (!match) throw new Error('page must be an id from the pages action, e.g. c0.p1')
    const context = getBrowser().contexts()[Number(match[1])]
    if (!context) throw new Error(`context ${match[1]} not found — list pages first`)
    const page = context.pages()[Number(match[2])]
    if (!page) throw new Error(`page ${pageId} not found — list pages first`)
    const name = args.session ? args.session : 'default'
    await closeSession(name)
    const s: Session = { name, context: null, page, console: [], errors: [], network: [], unwire: null }
    s.unwire = wireSession(s)
    state.sessions.set(name, s)
    return { ok: true, session: name, page: pageId, url: page.url(), title: await safeTitle(page) }
  }

  async function doNavigate(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    const url = normalizeUrl(args.url)
    if (!url) throw new Error('navigate requires url')
    const waitUntil = args.waitUntil || 'load'
    await s.page.goto(url, {
      waitUntil,
      timeout: args.timeoutMs ?? cfg.navigationTimeoutMs,
    })
    return { ok: true, url: s.page.url(), title: await safeTitle(s.page) }
  }

  async function doReload(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    const waitUntil = args.waitUntil || 'load'
    await s.page.reload({
      waitUntil,
      timeout: args.timeoutMs ?? cfg.navigationTimeoutMs,
    })
    return { ok: true, url: s.page.url(), title: await safeTitle(s.page) }
  }

  async function doBack(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    const waitUntil = args.waitUntil || 'load'
    await s.page.goBack({
      waitUntil,
      timeout: args.timeoutMs ?? cfg.navigationTimeoutMs,
    })
    return { ok: true, url: s.page.url(), title: await safeTitle(s.page) }
  }

  async function doForward(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    const waitUntil = args.waitUntil || 'load'
    await s.page.goForward({
      waitUntil,
      timeout: args.timeoutMs ?? cfg.navigationTimeoutMs,
    })
    return { ok: true, url: s.page.url(), title: await safeTitle(s.page) }
  }

  async function doEval(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    if (!args.expression) throw new Error('eval requires expression')
    let value: unknown
    if (args.selector) {
      value = await s.page.evaluate(({ sel, expr }: { sel: string; expr: string }) => {
        const el = document.querySelector(sel)
        if (!el) throw new Error(`selector not found: ${sel}`)
        const fn = new Function('el', `return (${expr})`)
        return fn(el)
      }, { sel: args.selector, expr: args.expression })
    } else {
      // The string form is an evaluated expression; Playwright awaits promises.
      value = await s.page.evaluate<string | undefined>(args.expression)
    }
    if (value === undefined) {
      return { ok: true, undefined: true, note: 'the expression returned undefined or an unserializable value' }
    }
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text.length <= cfg.maxResultChars) {
      // Playwright's evaluate serializes through the protocol, so the value is JSON-safe.
      return { ok: true, type, value: value as JsonValue }
    }
    return {
      ok: true,
      type,
      truncated: true,
      maxChars: cfg.maxResultChars,
      preview: text.slice(0, cfg.maxResultChars),
    }
  }

  async function doSnapshot(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    const target = args.selector ? s.page.locator(args.selector).first() : s.page.locator('body')
    let text = await target.ariaSnapshot()
    const max = args.maxChars ?? cfg.maxSnapshotChars
    const truncated = text.length > max
    if (truncated) text = text.slice(0, max)
    return {
      ok: true,
      url: s.page.url(),
      title: await safeTitle(s.page),
      chars: text.length,
      truncated,
      snapshot: text,
    }
  }

  async function doClick(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    if (!args.selector) throw new Error('click requires selector')
    const index = args.index ?? 0
    await s.page.locator(args.selector).nth(index).click({ timeout: args.timeoutMs ?? cfg.actionTimeoutMs })
    return { ok: true, clicked: args.selector, url: s.page.url() }
  }

  async function doFill(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    if (!args.selector) throw new Error('fill requires selector')
    const index = args.index ?? 0
    const value = args.value ?? ''
    await s.page.locator(args.selector).nth(index).fill(value, { timeout: args.timeoutMs ?? cfg.actionTimeoutMs })
    return { ok: true, filled: args.selector, url: s.page.url() }
  }

  async function doType(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    if (!args.selector) throw new Error('type requires selector')
    const index = args.index ?? 0
    const text = args.text ?? ''
    const delay = args.delayMs ?? 0
    await s.page.locator(args.selector).nth(index).pressSequentially(text, {
      delay,
      timeout: args.timeoutMs ?? cfg.actionTimeoutMs,
    })
    return { ok: true, typed: args.selector, url: s.page.url() }
  }

  async function doSelect(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    if (!args.selector) throw new Error('select requires selector')
    if (args.value === undefined || args.value === null) throw new Error('select requires value')
    const index = args.index ?? 0
    const option = args.by === 'label' ? { label: args.value } : { value: args.value }
    await s.page.locator(args.selector).nth(index).selectOption(option, { timeout: args.timeoutMs ?? cfg.actionTimeoutMs })
    return { ok: true, selected: args.selector, url: s.page.url() }
  }

  async function doWait(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    const page = s.page
    const timeout = args.timeoutMs ?? cfg.actionTimeoutMs
    if (args.selector) {
      await page.waitForSelector(args.selector, { state: args.state || 'visible', timeout })
    } else if (args.url) {
      await page.waitForURL(args.url, { timeout })
    } else if (args.loadState) {
      await page.waitForLoadState(args.loadState, { timeout })
    } else if (typeof args.timeoutMs === 'number') {
      await page.waitForTimeout(args.timeoutMs)
    } else {
      throw new Error('wait requires one of: selector, url, loadState, timeoutMs')
    }
    return { ok: true, url: page.url() }
  }

  async function doConsole(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    // The entry records are plain JSON-shaped data; the casts close the
    // interface-to-index-signature gap against JsonValue's object form.
    const out: JsonValue = {
      ok: true,
      session: s.name,
      entries: s.console.slice() as unknown as JsonValue[],
      errors: s.errors.slice() as unknown as JsonValue[],
    }
    if (args.clear) {
      s.console.length = 0
      s.errors.length = 0
    }
    return out
  }

  async function doNetwork(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    const out: JsonValue = {
      ok: true,
      session: s.name,
      entries: s.network.slice() as unknown as JsonValue[],
    }
    if (args.clear) s.network.length = 0
    return out
  }

  async function doScreenshot(args: ToolArgs): Promise<JsonValue> {
    const s = await ensureSession(args.session)
    const saveTo = args.path ? args.path : join(tmpdir(), `dsh-playwright-${Date.now()}.png`)
    mkdirSync(dirname(saveTo), { recursive: true })
    let buffer: Buffer
    if (args.selector) {
      buffer = await s.page.locator(args.selector).first().screenshot({ path: saveTo, timeout: args.timeoutMs ?? cfg.actionTimeoutMs })
    } else {
      buffer = await s.page.screenshot({ path: saveTo, fullPage: args.fullPage === true, timeout: args.timeoutMs ?? cfg.actionTimeoutMs })
    }
    return { ok: true, savedTo: saveTo, bytes: buffer.length }
  }

  async function doCloseSession(args: ToolArgs): Promise<JsonValue> {
    const name = args.session ? args.session : 'default'
    const existed = await closeSession(name)
    return { ok: true, session: name, existed }
  }

  async function doQuit(): Promise<JsonValue> {
    const out: Record<string, JsonValue> = { ok: true, mode: state.mode }
    for (const s of [...state.sessions.values()]) {
      await closeSession(s.name)
    }
    if (state.mode === 'owned' && state.browser) {
      try {
        await state.browser.close()
        out.browserStopped = true
      } catch (error) {
        out.closeError = String(error instanceof Error ? error.message : error)
      }
    } else if (state.mode === 'attached' && state.browser) {
      // browser.close() on a connectOverCDP browser disconnects from the
      // browser server and never stops the external browser.
      try {
        await state.browser.close()
        out.browserDisconnected = true
      } catch (error) {
        out.closeError = String(error instanceof Error ? error.message : error)
      }
      out.note = 'attached mode — external browser left running'
    } else {
      out.alreadyStopped = true
    }
    state.browser = null
    state.browserName = null
    state.mode = null
    return out
  }

  // Serialize all commands through one queue: one shared browser, one driver.
  let commandQueue: Promise<unknown> = Promise.resolve()
  function enqueue(work: () => Promise<JsonValue>): Promise<JsonValue> {
    const run = commandQueue.then(work, work)
    commandQueue = run.then(() => undefined, () => undefined)
    return run
  }

  const tool = defineTool({
    name: 'playwright_web_debug',
    description: 'Launch or attach to a real browser with Playwright and debug web pages hands-on.\n'
      + 'Actions:\n'
      + '- launch: start a browser instance (engine/channel come from row config browser/channel — default chromium via the installed Edge; args can override browser/channel/executablePath/headless/windowWidth/windowHeight). Opens a fresh default session; url is loaded best-effort (a failed start page is reported, not fatal).\n'
      + '- attach: connect with chromium.connectOverCDP to an ALREADY-RUNNING browser on the configured cdpPort (start Edge/Chrome with --remote-debugging-port=9333). The external browser is never stopped; quit only detaches. The default session binds to its first non-internal page (edge://, chrome://, extensions are skipped).\n'
      + '- status: mode (owned/attached), engine, and the session list.\n'
      + '- pages: list every open page as id c<context>.p<page> with url/title and which session it is bound to.\n'
      + '- bind: bind a named session (default \'default\') to an existing page id from pages. The bound page is never closed by this tool.\n'
      + '- open-page: create a fresh isolated context+page bound to a session name (default \'default\'); optional url to open.\n'
      + '- navigate: goto url (http:// auto-prefixed) and wait for waitUntil (default \'load\').\n'
      + '- reload / back / forward: the corresponding navigation with the same waitUntil choices.\n'
      + '- eval: evaluate a JavaScript expression in the page (Playwright auto-awaits promises). With selector, the expression runs with `el` bound to the first matching element. Returns the JSON value, or a truncated preview when it exceeds maxResultChars; undefined/unserializable results are reported as such.\n'
      + '- snapshot: accessibility tree (ariaSnapshot) of the body, or of the element matching selector. The best way to "see" a page: roles, names, and inputs. Bounded by maxChars.\n'
      + '- click / fill / type / select: drive the first (or index-th) element matching selector with Playwright auto-waiting. fill sets an input\'s value; type presses keys one by one (delayMs optional); select picks a <select> option by value or, with by:\'label\', by visible label.\n'
      + '- wait: wait for selector (state: attached/detached/visible/hidden, default visible), a url glob (waitForURL), a loadState (load/domcontentloaded/networkidle), or timeoutMs of wall-clock time. Exactly one of these is required.\n'
      + '- console: buffered console messages + page errors for the session; clear:true flushes after reading.\n'
      + '- network: buffered requests/responses (method, url, status, resourceType, failed) for the session; clear:true flushes after reading.\n'
      + '- screenshot: capture the page (fullPage:true for the whole page) or an element (selector) as a PNG written to path (absolute path recommended, e.g. inside the session workspace) or a temp file; returns savedTo and bytes so you can read_image the file.\n'
      + '- close-session: drop one named session. Sessions created by launch/open-page close their tab; sessions bound with bind/attach are only detached.\n'
      + '- quit: owned mode terminates the browser; attached mode detaches only and leaves the external browser running.\n'
      + 'Usage: launch or attach once, then reuse the default session. One browser at a time; quit before launching a different engine.',
    parameters: {
      action: {
        type: 'string', required: true,
        enum: ['launch', 'attach', 'status', 'pages', 'bind', 'open-page', 'navigate', 'reload', 'back', 'forward', 'eval', 'snapshot', 'click', 'fill', 'type', 'select', 'wait', 'console', 'network', 'screenshot', 'close-session', 'quit'],
        description: 'What to do.',
      },
      url: { type: 'string', description: 'launch/open-page: start page. navigate: destination URL. wait: url glob to wait for.' },
      headless: { type: 'boolean', description: 'launch: run the browser headless (overrides the row config).' },
      browser: { type: 'string', description: 'launch: engine override (chromium/firefox/webkit).' },
      channel: { type: 'string', description: 'launch: channel override (chromium only, e.g. msedge/chrome).' },
      executablePath: { type: 'string', description: 'launch: explicit browser executable path.' },
      windowWidth: { type: 'integer', description: 'launch: window width.' },
      windowHeight: { type: 'integer', description: 'launch: window height.' },
      session: { type: 'string', description: 'Session name (default \'default\').' },
      page: { type: 'string', description: 'bind: page id from pages, e.g. c0.p1.' },
      expression: { type: 'string', description: 'eval: JavaScript expression evaluated in the page.' },
      selector: { type: 'string', description: 'eval/click/fill/type/select/snapshot/screenshot/wait: CSS selector the action targets.' },
      index: { type: 'integer', description: 'click/fill/type/select: 0-based match index (default 0).' },
      value: { type: 'string', description: 'fill/select: value to set or option value/label.' },
      text: { type: 'string', description: 'type: text to press key by key.' },
      delayMs: { type: 'integer', description: 'type: delay between keystrokes.' },
      by: { type: 'string', enum: ['value', 'label'], description: 'select: match option by value or visible label (default value).' },
      waitUntil: { type: 'string', enum: [...WAIT_UNTIL_VALUES], description: 'navigate/reload/back/forward: when to consider navigation done (default load).' },
      state: { type: 'string', enum: [...WAIT_FOR_STATES], description: 'wait: selector state (default visible).' },
      loadState: { type: 'string', enum: [...LOAD_STATES], description: 'wait: page load state to wait for.' },
      fullPage: { type: 'boolean', description: 'screenshot: capture the full scrollable page.' },
      maxChars: { type: 'integer', description: 'snapshot: result cap (default from row config).' },
      timeoutMs: { type: 'integer', description: 'Per-call timeout override; wait: sleep duration.' },
      path: { type: 'string', description: 'screenshot: absolute output path for the PNG.' },
      clear: { type: 'boolean', description: 'console/network: flush the buffers after reading.' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      exec.signal.throwIfAborted()
      const action = args.action
      return enqueue(async () => {
        exec.signal.throwIfAborted()
        switch (action) {
          case 'launch': return doLaunch(args)
          case 'attach': return doAttach(args)
          case 'status':
            // StatusValue lacks JsonValue's index signature only because it is an interface.
            return status() as unknown as JsonValue
          case 'pages':
            getBrowser()
            return { ok: true, pages: await listPages() as unknown as JsonValue[] }
          case 'bind': return doBind(args)
          case 'open-page': return doOpenPage(args)
          case 'navigate': return doNavigate(args)
          case 'reload': return doReload(args)
          case 'back': return doBack(args)
          case 'forward': return doForward(args)
          case 'eval': return doEval(args)
          case 'snapshot': return doSnapshot(args)
          case 'click': return doClick(args)
          case 'fill': return doFill(args)
          case 'type': return doType(args)
          case 'select': return doSelect(args)
          case 'wait': return doWait(args)
          case 'console': return doConsole(args)
          case 'network': return doNetwork(args)
          case 'screenshot': return doScreenshot(args)
          case 'close-session': return doCloseSession(args)
          case 'quit': return doQuit()
        }
      })
    },
  })

  ctx.tools.register(tool)
  ctx.effect(() => () => {
    // Disposal runs in the fiber context; close owned sessions and release the
    // browser (owned: terminate it; attached: disconnect only).
    for (const s of [...state.sessions.values()]) {
      if (s.unwire) s.unwire()
      state.sessions.delete(s.name)
      if (s.context) {
        s.context.close().catch(() => {})
      }
    }
    if (state.browser) {
      state.browser.close().catch(() => {})
    }
    state.browser = null
    state.browserName = null
    state.mode = null
  })
}
