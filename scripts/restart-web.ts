/**
 * Supervised restart for a source-launched `dsh web` backend.
 *
 * `status` reports the pidfile, process liveness, and endpoint health.
 * `restart` runs the stable sequence: lock → token-authenticated POST to the
 * backend's /-/restart endpoint → wait for graceful exit → wait for the port
 * to release → spawn a detached successor (logs to the profile log file) →
 * health gate. `--rollback <git-ref>` checks the working tree back to that
 * ref and retries the spawn once when the health gate fails.
 *
 * Usage: `tsx scripts/restart-web.ts status|restart [--profile web] [--port 3080] [--rollback <git-ref>]`
 * Requires DSH_RESTART_TOKEN in the environment (the same value the backend
 * was launched with).
 */

import { spawn, spawnSync } from 'node:child_process'
import { connect } from 'node:net'
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const root = resolve(import.meta.dirname, '..')
const DEFAULT_PROFILE = 'web'
const DEFAULT_PORT = 3080
const GRACE_EXIT_MS = 30_000
const PORT_RELEASE_MS = 10_000
const HEALTH_TIMEOUT_MS = 60_000
const POLL_MS = 250

export interface SupervisorPaths {
  dir: string
  pidfile: string
  lockfile: string
  log: string
}

/** Supervisor state lives under ~/.dsh/supervisor, per profile. */
export function statePaths(profile: string): SupervisorPaths {
  const dir = join(homedir(), '.dsh', 'supervisor')
  return {
    dir,
    pidfile: join(dir, `${profile}.pid`),
    lockfile: join(dir, `${profile}.restart.lock`),
    log: join(dir, `${profile}.log`),
  }
}

/** Read the recorded pid, or undefined when absent or malformed. */
export function readPidfile(path: string): number | undefined {
  if (!existsSync(path)) return undefined
  const parsed = Number.parseInt(readFileSync(path, 'utf8'), 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** Record the live pid for the supervisor's next run. */
export function writePidfile(path: string, pid: number): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${pid}\n`)
}

/** Probe process liveness without signaling. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll the endpoint until any HTTP response arrives or the deadline passes. */
export async function probeHttp(url: string, timeoutMs: number, pollMs = POLL_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(Math.min(pollMs, Math.max(deadline - Date.now(), 1))) })
      return true
    } catch {
      if (Date.now() >= deadline) return false
      await sleep(pollMs)
    }
  }
}

/** POST the restart request; throws when the backend is unreachable. */
export async function postRestart(url: string, token: string): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  })
  return res.status
}

/** Wait for the recorded pid to exit. */
export async function waitForExit(pid: number, timeoutMs: number, pollMs = POLL_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true
    await sleep(pollMs)
  }
  return !isProcessAlive(pid)
}

/** Wait for the port to stop accepting connections. */
export function waitForPortFree(port: number, timeoutMs: number, pollMs = POLL_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  const attempt = (): Promise<boolean> => new Promise((resolve) => {
    const probe = connect({ host: '127.0.0.1', port })
    probe.once('connect', () => {
      probe.destroy()
      resolve(false)
    })
    probe.once('error', () => { resolve(true) })
  })
  return (async () => {
    for (;;) {
      if (await attempt()) return true
      if (Date.now() >= deadline) return false
      await sleep(pollMs)
    }
  })()
}

export interface SpawnOptions {
  profile: string
  port: number
  token: string
  extraArgs: string[]
  log: string
}

/** Spawn the detached successor; the caller owns the health gate. */
export function spawnBackend(options: SpawnOptions): number {
  mkdirSync(dirname(options.log), { recursive: true })
  const logFd = openSync(options.log, 'a')
  const child = spawn(process.execPath, [
    '--import', 'tsx/esm',
    'apps/cli/src/bin.ts',
    '--profile', options.profile,
    ...options.extraArgs,
  ], {
    cwd: root,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      DSH_RESTART_TOKEN: options.token,
      DSH_TELEMETRY_DISABLED: '1',
      ...options.port === DEFAULT_PORT ? {} : { DSH_RESTART_PORT: String(options.port) },
    },
  })
  child.unref()
  if (child.pid === undefined) throw new Error('restart-web: successor spawn returned no pid')
  return child.pid
}

function fail(message: string): never {
  console.error(`restart-web: ${message}`)
  process.exit(1)
}

function parseArgs(argv: string[]): {
  command: 'status' | 'restart'
  profile: string
  port: number
  rollback: string | undefined
  extraArgs: string[]
} {
  const command = argv[0]
  if (command !== 'status' && command !== 'restart') {
    fail('usage: tsx scripts/restart-web.ts status|restart [--profile web] [--port 3080] [--rollback <git-ref>]')
  }
  let profile = DEFAULT_PROFILE
  let port = DEFAULT_PORT
  let rollback: string | undefined
  const extraArgs: string[] = []
  for (let index = 1; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--profile') { profile = argv[++index] ?? profile }
    else if (arg === '--port') { port = Number.parseInt(argv[++index] ?? '', 10) }
    else if (arg === '--rollback') { rollback = argv[++index] }
    else if (arg !== undefined) extraArgs.push(arg)
  }
  if (!Number.isSafeInteger(port) || port <= 0) fail('invalid --port')
  return { command, profile, port, rollback, extraArgs }
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined
  && import.meta.url === pathToFileURL(resolve(invokedPath)).href
if (isMain) {
  const args = parseArgs(process.argv.slice(2))
  const paths = statePaths(args.profile)
  const url = `http://127.0.0.1:${args.port}/-/restart`
  if (args.command === 'status') {
    const pid = readPidfile(paths.pidfile)
    console.log(`profile: ${args.profile}`)
    console.log(`pidfile: ${paths.pidfile}`)
    console.log(`recorded pid: ${pid ?? 'none'}`)
    if (pid !== undefined) console.log(`process alive: ${isProcessAlive(pid)}`)
    console.log(`healthy: ${await probeHttp(url, 1_000)}`)
    process.exit(0)
  }
  const token = process.env.DSH_RESTART_TOKEN
  if (token === undefined || token === '') fail('DSH_RESTART_TOKEN is required for restart')
  if (existsSync(paths.lockfile)) fail('another restart is in progress (lockfile present)')
  mkdirSync(paths.dir, { recursive: true })
  writeFileSync(paths.lockfile, `${process.pid}\n`)
  try {
    const pid = readPidfile(paths.pidfile)
    if (pid === undefined || !isProcessAlive(pid)) fail('no live backend found; start one before restarting')
    const status = await postRestart(url, token)
    if (status !== 202) fail(`backend answered ${status} to the restart request`)
    console.log(`restart requested; waiting for pid ${pid} to exit`)
    if (!await waitForExit(pid, GRACE_EXIT_MS)) fail(`pid ${pid} did not exit within ${GRACE_EXIT_MS}ms`)
    console.log('backend exited; waiting for the port to release')
    if (!await waitForPortFree(args.port, PORT_RELEASE_MS)) fail(`port ${args.port} did not release within ${PORT_RELEASE_MS}ms`)

    const launch = (): number => {
      console.log(`spawning successor (log: ${paths.log})`)
      const newPid = spawnBackend({
        profile: args.profile,
        port: args.port,
        token,
        extraArgs: args.extraArgs,
        log: paths.log,
      })
      writePidfile(paths.pidfile, newPid)
      return newPid
    }
    let newPid = launch()
    if (!await probeHttp(url, HEALTH_TIMEOUT_MS)) {
      console.error('restart-web: successor failed the health gate')
      if (args.rollback !== undefined) {
        console.error(`restart-web: rolling back the working tree to ${args.rollback} and retrying once`)
        try {
          spawnSync('git', ['-C', root, 'checkout', args.rollback], { stdio: 'inherit' })
          newPid = launch()
        } catch {
          // The next health check owns the failure verdict.
        }
        if (!await probeHttp(url, HEALTH_TIMEOUT_MS)) fail(`rollback successor also failed the health gate; logs: ${paths.log}`)
      } else {
        fail(`successor failed the health gate; logs: ${paths.log} (retry with --rollback <git-ref> to restore the previous revision)`)
      }
    }
    console.log(`restart complete: pid ${newPid} healthy at ${url}`)
  } finally {
    if (existsSync(paths.lockfile)) rmSync(paths.lockfile, { force: true })
  }
}
