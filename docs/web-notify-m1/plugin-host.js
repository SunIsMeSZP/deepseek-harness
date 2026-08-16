/**
 * Web 站内通知 M1 —— Host 半区（动态 Cordis 插件）
 * Plugin: ntfy-4 / Package: pkg-11 (v4) / Run: run-11
 *
 * 职责：
 *  - 监听会话事件，生成三类通知记录：needs-input / completed / error
 *  - 去重与消解：approval/question 的 active → resolved；1.5s 内自动决策的静默删除
 *  - 冷却：error 60s、completed 30s 防刷屏
 *  - RPC：notify/list、notify/markRead、notify/markAllRead
 *  - 注册 /sw.js 路由：Android 系统通知所需的 Service Worker（notificationclick 转发会话跳转）
 *
 * 定义方式：cordis_define(kind: existing, pluginId: ntfy-4)，本文件内容作为 code.host。
 * 运行方式：cordis_run(pluginId: ntfy-4, packageId: <新包id>, mode: update)
 */
return {
  apply(ctx) {
    const records = []
    let seq = 0
    const byKey = new Map()
    const lastStatus = new Map()
    const lastErrorAt = new Map()
    const lastDoneAt = new Map()
    const COOLDOWN_ERR = 60000
    const COOLDOWN_DONE = 30000

    const record = (type, severity, sessionId, title, body, key) => {
      if (key !== null && key !== undefined && byKey.has(key)) return
      const rec = {
        id: 'n' + (++seq),
        seq,
        type,
        severity,
        sessionId: String(sessionId),
        title: String(title).slice(0, 120),
        body: String(body === undefined ? '' : body).slice(0, 300),
        dedupeKey: key === undefined ? null : key,
        status: type === 'needs-input' ? 'active' : 'unread',
        createdAt: Date.now(),
      }
      records.push(rec)
      if (records.length > 500) {
        const removed = records.splice(0, records.length - 500)
        for (const r of removed) if (byKey.get(r.dedupeKey) === r) byKey.delete(r.dedupeKey)
      }
      if (key !== undefined && key !== null) byKey.set(key, rec)
      return rec
    }
    const resolve = (key) => {
      const rec = byKey.get(key)
      if (!rec) return
      if (Date.now() - rec.createdAt < 1500) {
        const idx = records.findIndex(r => r.id === rec.id)
        if (idx >= 0) records.splice(idx, 1)
        byKey.delete(key)
        return
      }
      rec.status = 'resolved'
    }
    const cooldownOk = (map, sessionId, ms) => {
      const last = map.get(sessionId) || 0
      const now = Date.now()
      if (now - last < ms) return false
      map.set(sessionId, now)
      return true
    }
    const errorText = (err) => {
      if (err && typeof err === 'object' && 'message' in err) return String(err.message)
      try { return JSON.stringify(err) } catch (e) { return String(err) }
    }

    ctx.on('session/event', (session, event) => {
      const sid = session && typeof session.id === 'string' ? session.id : '?'
      const data = event && typeof event === 'object' ? event.data : undefined
      if (!data || typeof data !== 'object') return
      switch (event.type) {
        case 'approval/asked': {
          const toolName = typeof data.toolName === 'string' && data.toolName ? data.toolName : '未知工具'
          const reason = typeof data.reason === 'string' && data.reason ? data.reason : undefined
          record('needs-input', 'warning', sid, '需要你的审批',
            '工具 ' + toolName + ' 请求审批' + (reason ? '：' + reason : ''),
            'approval:' + String(data.id))
          break
        }
        case 'approval/decided':
          resolve('approval:' + String(data.id))
          break
        case 'tool/call':
          if (data.name === 'ask_user_question') {
            let body = '需要你的回答'
            try {
              const parsed = JSON.parse(data.arguments)
              const first = Array.isArray(parsed.questions) ? parsed.questions[0] : parsed
              if (first && typeof first.question === 'string' && first.question) body = first.question
              else if (parsed && typeof parsed.question === 'string' && parsed.question) body = parsed.question
            } catch (e) { /* keep fallback */ }
            record('needs-input', 'warning', sid, '需要你的回答', body, 'question:' + String(data.callId))
          }
          break
        case 'tool/result': {
          const block = data.message && data.message.content && data.message.content[0]
          if (block && typeof block.toolCallId === 'string') resolve('question:' + block.toolCallId)
          break
        }
      }
    })

    ctx.on('agent/status', (payload) => {
      const agent = payload && payload.agent
      const sid = agent && typeof agent.id === 'string' ? agent.id : undefined
      if (!sid) return
      const prev = lastStatus.get(sid)
      lastStatus.set(sid, payload.status)
      if (prev === 'running' && payload.status === 'idle') {
        if (cooldownOk(lastDoneAt, sid, COOLDOWN_DONE)) {
          record('completed', 'info', sid, '任务完成', '会话已完成一轮运行', 'done:' + sid + ':' + (seq + 1))
        }
      }
    })

    ctx.on('agent/error', (payload) => {
      const agent = payload && payload.agent
      const sid = agent && typeof agent.id === 'string' ? agent.id : undefined
      if (!sid) return
      if (cooldownOk(lastErrorAt, sid, COOLDOWN_ERR)) {
        record('error', 'critical', sid, '会话出现异常', errorText(payload.error).slice(0, 300), null)
      }
    })

    const webServer = ctx.get('webServer')
    if (webServer) {
      const SW_SCRIPT = [
        "self.addEventListener('install', () => { self.skipWaiting() })",
        "self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()) })",
        "self.addEventListener('notificationclick', (event) => {",
        "  event.notification.close()",
        "  const sid = event.notification.data && event.notification.data.sessionId",
        "  event.waitUntil((async () => {",
        "    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })",
        "    for (const win of wins) {",
        "      try { win.focus() } catch (e) {}",
        "      if (sid) win.postMessage({ type: 'dsh-ntfy-open', sessionId: sid })",
        "      return",
        "    }",
        "    await self.clients.openWindow(self.location.origin + '/')",
        "  })())",
        "})",
      ].join('\n')
      ctx.effect(() => webServer.register({
        kind: 'exact',
        path: '/sw.js',
        handler: (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/javascript', 'Cache-Control': 'no-store' })
          res.end(SW_SCRIPT)
        },
      }))
    }

    harness.handle('notify/list', (args) => {
      return {
        records: records.map(r => ({
          id: r.id, seq: r.seq, type: r.type, severity: r.severity,
          sessionId: r.sessionId, title: r.title, body: r.body,
          dedupeKey: r.dedupeKey, status: r.status, createdAt: r.createdAt,
        })),
        cursor: seq,
        unread: records.filter(r => r.status === 'active' || r.status === 'unread').length,
      }
    })

    harness.handle('notify/markRead', (args) => {
      const id = args && typeof args.id === 'string' ? args.id : null
      if (id) {
        const rec = records.find(r => r.id === id)
        if (rec && rec.status !== 'resolved') rec.status = 'read'
      }
      return { ok: true }
    })

    harness.handle('notify/markAllRead', () => {
      for (const rec of records) if (rec.status !== 'resolved') rec.status = 'read'
      return { ok: true }
    })
  },
}
