import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-webserver'
import { installRestartEndpoint, RESTART_PATH } from '../src/restart-endpoint.ts'
import type { ProcessShutdown } from '../src/process-shutdown.ts'

const TOKEN = 'test-token'
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

async function mountServer(token: string | undefined): Promise<{
  port: number
  interrupted: () => number | undefined
}> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 })
  let code: number | undefined
  const shutdown: ProcessShutdown = {
    shutdown: (exitCode) => { code = exitCode; return Promise.resolve() },
    interrupt: (exitCode) => { code = exitCode },
  }
  installRestartEndpoint(ctx, shutdown, token)
  return { port: (ctx.get('webServer') as WebServer).port, interrupted: () => code }
}

async function request(port: number, init?: RequestInit): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${RESTART_PATH}`, init)
}

describe('restart endpoint', () => {
  it('stays absent when no token is configured', async () => {
    const { port } = await mountServer(undefined)
    const res = await request(port)
    expect(res.status).toBe(404)
  })

  it('reports liveness on GET', async () => {
    const { port } = await mountServer(TOKEN)
    const res = await request(port)
    expect(res.status).toBe(200)
    const body = await res.json() as { pid: number; uptimeMs: number }
    expect(body.pid).toBe(process.pid)
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0)
  })

  it('rejects a wrong token with 401 and does not interrupt', async () => {
    const { port, interrupted } = await mountServer(TOKEN)
    const res = await request(port, { method: 'POST', headers: { authorization: 'Bearer wrong' } })
    expect(res.status).toBe(401)
    expect(interrupted()).toBeUndefined()
  })

  it('answers 202 and interrupts shutdown after responding for the right token', async () => {
    const { port, interrupted } = await mountServer(TOKEN)
    const res = await request(port, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` } })
    expect(res.status).toBe(202)
    await new Promise(resolve => setImmediate(resolve))
    expect(interrupted()).toBe(0)
  })

  it('rejects other methods with 405', async () => {
    const { port } = await mountServer(TOKEN)
    const res = await request(port, { method: 'PUT' })
    expect(res.status).toBe(405)
  })
})
