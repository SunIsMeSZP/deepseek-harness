import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  isProcessAlive,
  postRestart,
  probeHttp,
  readPidfile,
  statePaths,
  waitForExit,
  waitForPortFree,
  writePidfile,
} from './restart-web.ts'

const tempDirs: string[] = []
const servers: ReturnType<typeof createServer>[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  }
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempPath(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-restart-web-'))
  tempDirs.push(dir)
  return join(dir, name)
}

async function listen(handler: (authorization: string | undefined) => number): Promise<number> {
  const server = createServer((req, res) => {
    const status = handler(req.headers.authorization)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify({}))
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

describe('restart-web helpers', () => {
  it('round-trips the pidfile and tolerates missing or malformed files', () => {
    const path = tempPath('web.pid')
    expect(readPidfile(path)).toBeUndefined()
    writePidfile(path, 4242)
    expect(readPidfile(path)).toBe(4242)
    writeFileSync(path, 'not-a-pid\n')
    expect(readPidfile(path)).toBeUndefined()
  })

  it('reports process liveness without signaling', () => {
    expect(isProcessAlive(process.pid)).toBe(true)
    expect(isProcessAlive(999_999_999)).toBe(false)
  })

  it('probes HTTP health until the deadline', async () => {
    const port = await listen(() => 200)
    expect(await probeHttp(`http://127.0.0.1:${port}/-/restart`, 1_000)).toBe(true)
    expect(await probeHttp('http://127.0.0.1:1/-/restart', 300)).toBe(false)
  })

  it('posts the restart request and surfaces the status', async () => {
    const port = await listen(authorization => authorization === 'Bearer right' ? 202 : 401)
    expect(await postRestart(`http://127.0.0.1:${port}/-/restart`, 'right')).toBe(202)
    expect(await postRestart(`http://127.0.0.1:${port}/-/restart`, 'wrong')).toBe(401)
  })

  it('waits for a pid to exit and times out on a live pid', async () => {
    const child = spawn(process.execPath, ['-e', ''])
    await waitForExit(child.pid ?? 0, 5_000)
    expect(child.exitCode).toBe(0)
    expect(await waitForExit(process.pid, 200)).toBe(false)
  })

  it('waits for a port to release', async () => {
    const port = await listen(() => 200)
    expect(await waitForPortFree(port, 200)).toBe(false)
    expect(await waitForPortFree(1, 200)).toBe(true)
  })

  it('places supervisor state under the home directory per profile', () => {
    const paths = statePaths('web')
    expect(paths.pidfile).toContain('web.pid')
    expect(paths.lockfile).toContain('web.restart.lock')
  })
})
