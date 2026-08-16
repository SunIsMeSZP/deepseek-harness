/**
 * Loopback-only restart control endpoint for supervised deployments.
 * Installed only when DSH_RESTART_TOKEN is set: GET reports liveness, POST
 * bearing the token answers 202 and then triggers the graceful shutdown.
 * @module apps/cli restart endpoint
 */

import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { WebRoute } from '@deepseek-ai/dsh-webserver'
import type { ProcessShutdown } from './process-shutdown.ts'

/** Path served on the app's own web server. */
export const RESTART_PATH = '/-/restart'

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

function isLoopback(req: IncomingMessage): boolean {
  return LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')
}

/** Timing-safe token comparison over equal-length SHA-256 digests. */
function tokenMatches(supplied: string, expected: string): boolean {
  const suppliedDigest = createHash('sha256').update(supplied).digest()
  const expectedDigest = createHash('sha256').update(expected).digest()
  return timingSafeEqual(suppliedDigest, expectedDigest)
}

function respond(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/**
 * Install the restart endpoint on the settled root's web server.
 * @param ctx - settled root context carrying the webServer service.
 * @param shutdown - owning process shutdown controller.
 * @param token - DSH_RESTART_TOKEN; unset or empty means no endpoint.
 */
export function installRestartEndpoint(
  ctx: Context,
  shutdown: ProcessShutdown,
  token: string | undefined,
): void {
  if (token === undefined || token === '') return
  const webServer = ctx.get('webServer')
  if (webServer === undefined) return
  const startedAt = Date.now()
  const route: WebRoute = {
    kind: 'exact',
    path: RESTART_PATH,
    handler: (req, res) => {
      if (!isLoopback(req)) {
        respond(res, 403, { error: 'restart endpoint is loopback-only' })
        return
      }
      if (req.method === 'GET') {
        respond(res, 200, { pid: process.pid, uptimeMs: Date.now() - startedAt })
        return
      }
      if (req.method !== 'POST') {
        respond(res, 405, { error: 'restart endpoint accepts GET and POST only' })
        return
      }
      const supplied = (req.headers.authorization ?? '').replace(/^Bearer\s+/, '')
      if (!tokenMatches(supplied, token)) {
        respond(res, 401, { error: 'invalid restart token' })
        return
      }
      respond(res, 202, { restarting: true })
      // Answer before handing over: interrupt disposes the whole tree
      // (persistence flush, webserver close) and exits 0.
      setImmediate(() => { shutdown.interrupt(0) })
    },
  }
  webServer.register(route)
}
