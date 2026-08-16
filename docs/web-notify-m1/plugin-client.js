/**
 * Web 站内通知 M1 —— Client 半区（动态 Cordis 插件）
 * Plugin: ntfy-4 / Package: pkg-11 (v4) / Run: run-11
 *
 * 职责：
 *  - sidebar.footer.action 铃铛 + 未读角标；shell.overlay 通知中心面板（toast + 列表）
 *  - 轮询 notify/list（可见 4s / 切回前台立即），增量处理新记录
 *  - 系统通知：优先 Service Worker 通道（registration.showNotification，Android 唯一合法通道），
 *    桌面降级 new Notification 构造器；面板含权限状态/测试按钮/错误显示
 *  - SW 注册 /sw.js（Host 半区提供路由）；notificationclick 由 SW 转发 dsh-ntfy-open 消息，本页跳转会话
 *
 * 定义方式：cordis_define(kind: existing, pluginId: ntfy-4)，本文件内容作为 code.client。
 * 运行方式：cordis_run(pluginId: ntfy-4, packageId: <新包id>, mode: update)
 */
return {
  inject: ['slots', 'timer'],
  apply(ctx) {
    const slots = ctx.get('slots')
    if (slots === undefined) return
    const sessions = ctx.get('sessions')

    const listeners = new Set()
    const state = {
      open: false,
      records: [],
      unread: 0,
      toast: null,
      systemOn: true,
      sysSupport: typeof Notification !== 'undefined',
      testResult: null,
      lastSysError: null,
    }
    const setState = (patch) => { Object.assign(state, patch); listeners.forEach(fn => fn()) }
    const useNotify = () => {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const fn = () => force(n => n + 1)
        listeners.add(fn)
        return () => listeners.delete(fn)
      }, [])
      return state
    }

    // ---- Service Worker registration (Android system notifications need it) ----
    const swState = {
      support: typeof navigator !== 'undefined' && !!navigator.serviceWorker,
      status: 'checking',
      error: null,
    }
    let swRegPromise = null
    try {
      if (swState.support) {
        swRegPromise = navigator.serviceWorker.register('/sw.js')
        swRegPromise.then(() => {
          swState.status = 'registered'
          setState({})
        }, (err) => {
          swState.status = 'error'
          swState.error = (err && err.message) ? err.message : String(err)
          setState({})
        })
      } else {
        swState.status = 'unsupported'
      }
    } catch (e) {
      swState.status = 'error'
      swState.error = (e && e.message) ? e.message : String(e)
    }
    const swReady = () => {
      if (!swRegPromise) return Promise.reject(new Error('SW 不可用'))
      return Promise.race([
        swRegPromise.then(() => navigator.serviceWorker.ready),
        new Promise((_, reject) => { ctx.timeout(() => reject(new Error('SW 激活超时')), 8000) }),
      ])
    }

    // ---- system notification: SW path first (Android), Notification constructor fallback (desktop) ----
    const sysNotify = async (rec) => {
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden'
      if (!(hidden || state.systemOn)) return false
      if (typeof navigator !== 'undefined' && navigator.serviceWorker && swState.support) {
        try {
          const reg = await swReady()
          await reg.showNotification(rec.title, {
            body: rec.body,
            tag: rec.dedupeKey || rec.id,
            data: { sessionId: rec.sessionId },
          })
          return true
        } catch (e) {
          const msg = (e && e.message) ? e.message : String(e)
          console.error('sw notification failed', e)
          setState({ lastSysError: 'sw: ' + msg })
        }
      }
      if (typeof Notification !== 'undefined') {
        try {
          const n = new Notification(rec.title, { body: rec.body, tag: rec.dedupeKey || rec.id, data: { sessionId: rec.sessionId } })
          n.onclick = () => {
            if (typeof window !== 'undefined') window.focus()
            if (sessions && rec.sessionId) sessions.open(rec.sessionId)
          }
          return true
        } catch (e) {
          const msg = (e && e.message) ? e.message : String(e)
          console.error('system notification failed', e)
          setState({ lastSysError: msg })
        }
      }
      return false
    }

    // ---- SW notificationclick → navigate this page to the session ----
    const onSwMessage = (event) => {
      const data = event && event.data
      if (data && data.type === 'dsh-ntfy-open' && data.sessionId && sessions) {
        sessions.open(data.sessionId)
      }
    }
    if (typeof navigator !== 'undefined' && navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener('message', onSwMessage)
      ctx.effect(() => () => navigator.serviceWorker.removeEventListener('message', onSwMessage))
    }

    const seen = new Set()
    const showFor = async (rec, force) => {
      if (seen.has(rec.id)) return
      seen.add(rec.id)
      if (rec.status !== 'active' && rec.status !== 'unread') return
      if (!force && Date.now() - rec.createdAt > 15000) return
      const shown = await sysNotify(rec)
      if (!shown) setState({ toast: rec })
    }

    const sendTest = async () => {
      setState({ testResult: '发送中…' })
      const rec = {
        id: 'test', type: 'completed', status: 'unread',
        title: 'DSH 通知测试', body: '如果你看到了这条通知，说明系统通知链路可用',
        dedupeKey: 'dsh-ntfy-test', sessionId: null, createdAt: Date.now(),
      }
      const ok = await sysNotify(rec)
      setState({ testResult: ok ? '已发送（调用成功，请查看通知栏）' : '未发送（见上方错误）' })
    }

    const refresh = async () => {
      try {
        const res = await host.call('notify/list', {})
        if (!res || typeof res !== 'object') return
        const records = Array.isArray(res.records) ? res.records : []
        const fresh = records.filter(r => !seen.has(r.id) && (r.status === 'active' || r.status === 'unread'))
        fresh.forEach(showFor)
        setState({
          records,
          cursor: typeof res.cursor === 'number' ? res.cursor : state.cursor,
          unread: typeof res.unread === 'number' ? res.unread : state.unread,
        })
      } catch (e) { console.error('notify poll failed', e) }
    }

    const markRead = async (id) => {
      try { await host.call('notify/markRead', { id }) } catch (e) { console.error(e) }
      const records = state.records.map(r => r.id === id && r.status !== 'resolved' ? { ...r, status: 'read' } : r)
      const unread = records.filter(r => r.status === 'active' || r.status === 'unread').length
      setState({ records, unread })
    }
    const markAllRead = async () => {
      try { await host.call('notify/markAllRead', {}) } catch (e) { console.error(e) }
      const records = state.records.map(r => r.status !== 'resolved' ? { ...r, status: 'read' } : r)
      setState({ records, unread: 0 })
    }
    const requestSys = async () => {
      if (typeof Notification === 'undefined') return
      try {
        const perm = await Notification.requestPermission()
        setState({})
        if (perm === 'granted') {
          for (const r of state.records) {
            if (r.status === 'active' || r.status === 'unread') { seen.delete(r.id); showFor(r, true) }
          }
        }
      } catch (e) { console.error(e) }
    }

    const usePoller = () => {
      React.useEffect(() => {
        let alive = true
        const tick = async () => { if (alive) await refresh() }
        tick()
        const disposers = []
        try {
          disposers.push(ctx.interval(tick, 4000))
          if (typeof window !== 'undefined' && typeof document !== 'undefined') {
            const onVis = () => tick()
            window.addEventListener('visibilitychange', onVis)
            window.addEventListener('focus', onVis)
            disposers.push(() => {
              window.removeEventListener('visibilitychange', onVis)
              window.removeEventListener('focus', onVis)
            })
          }
        } catch (e) { console.error('notify poller setup failed', e) }
        return () => { alive = false; disposers.forEach(d => d()) }
      }, [])
    }

    const CHIP = {
      'needs-input': { label: '需输入', color: '#e5484d', bg: 'rgba(229,72,77,.14)' },
      'completed': { label: '完成', color: '#30a46c', bg: 'rgba(48,164,108,.14)' },
      'error': { label: '异常', color: '#f76b15', bg: 'rgba(247,107,21,.16)' },
    }
    const panelStyle = {
      position: 'fixed', top: 60, right: 16, width: 340, maxHeight: '70vh',
      overflowY: 'auto', background: 'rgba(22,22,28,.97)', color: '#eee',
      borderRadius: 10, boxShadow: '0 8px 30px rgba(0,0,0,.4)', zIndex: 9999,
      padding: '10px 12px', fontSize: 13, fontFamily: 'system-ui, sans-serif',
    }
    const toastStyle = {
      position: 'fixed', top: 14, left: '50%', transform: 'translateX(-50%)',
      maxWidth: 380, background: 'rgba(22,22,28,.97)', color: '#eee',
      borderRadius: 8, padding: '10px 14px', cursor: 'pointer',
      boxShadow: '0 6px 24px rgba(0,0,0,.4)', zIndex: 9999, fontSize: 13,
      fontFamily: 'system-ui, sans-serif',
    }
    const badgeStyle = {
      position: 'absolute', top: -4, right: -6, background: '#e5484d', color: '#fff',
      fontSize: 10, lineHeight: '14px', borderRadius: 8, padding: '0 4px', minWidth: 14,
      textAlign: 'center',
    }
    const rowStyle = { display: 'flex', alignItems: 'center', gap: 6 }
    const btnStyle = {
      background: 'rgba(255,255,255,.1)', border: '1px solid rgba(255,255,255,.2)',
      color: '#eee', borderRadius: 6, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
    }
    const hintStyle = { fontSize: 12, opacity: 0.75, padding: '4px 0' }
    const monoStyle = { fontSize: 11, opacity: 0.9, fontFamily: 'monospace' }

    const fmtTime = (ts) => {
      try {
        return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      } catch (e) { return '' }
    }

    function Bell() {
      usePoller()
      const s = useNotify()
      return React.createElement('button', {
        onClick: () => setState({ open: !s.open }),
        title: '通知中心',
        style: { position: 'relative', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: 16, padding: '4px 6px', lineHeight: 1 },
      },
        '🔔',
        s.unread > 0 ? React.createElement('span', { style: badgeStyle }, s.unread > 99 ? '99+' : String(s.unread)) : null,
      )
    }

    function NotifyOverlay() {
      const s = useNotify()
      React.useEffect(() => {
        if (!s.toast) return
        const t = ctx.timeout(() => { if (state.toast) setState({ toast: null }) }, 4000)
        return t
      }, [s.toast ? s.toast.id : null])

      const els = []
      if (s.toast) {
        els.push(React.createElement('div', {
          key: 'toast',
          onClick: () => { setState({ toast: null }); if (sessions) sessions.open(s.toast.sessionId) },
          style: toastStyle,
        },
          React.createElement('div', { style: { fontWeight: 600 } }, s.toast.title),
          React.createElement('div', { style: { fontSize: 12, opacity: 0.85, marginTop: 2 } }, s.toast.body),
        ))
      }
      if (s.open) {
        const permNow = s.sysSupport ? Notification.permission : 'unsupported'
        const swLine = (() => {
          if (!swState.support) return 'SW=不支持'
          if (swState.status === 'checking') return 'SW=注册中…'
          if (swState.status === 'error') return 'SW=失败：' + swState.error
          return 'SW=已就绪'
        })()
        const sys = (() => {
          if (!s.sysSupport) {
            return React.createElement('div', null,
              React.createElement('div', { style: hintStyle }, '当前页面不是 HTTPS 安全上下文，浏览器不支持系统通知，仅站内提示。'),
              React.createElement('div', { style: monoStyle }, swLine),
            )
          }
          const perm = Notification.permission
          if (perm === 'default') {
            return React.createElement('div', { style: hintStyle },
              '未授权系统通知。',
              React.createElement('button', { onClick: requestSys, style: { ...btnStyle, marginLeft: 6 } }, '开启系统通知'),
            )
          }
          if (perm === 'denied') {
            return React.createElement('div', { style: hintStyle },
              '系统通知被拒绝：请在浏览器站点设置（地址栏左侧图标 → 通知）中改为允许后刷新。')
          }
          return React.createElement('div', null,
            React.createElement('label', { style: rowStyle },
              React.createElement('input', {
                type: 'checkbox',
                checked: s.systemOn,
                onChange: (e) => setState({ systemOn: e.target.checked }),
              }),
              '页面可见时也弹系统通知（默认开启）',
            ),
            React.createElement('div', { style: { ...rowStyle, marginTop: 6 } },
              React.createElement('button', { onClick: sendTest, style: btnStyle }, '测试系统通知'),
              React.createElement('span', { style: monoStyle }, '权限=' + perm),
            ),
            React.createElement('div', { style: monoStyle }, swLine),
            s.testResult ? React.createElement('div', { style: { ...hintStyle, color: s.testResult.startsWith('已发送') ? '#30a46c' : '#f76b15' } }, s.testResult) : null,
            s.lastSysError ? React.createElement('div', { style: { ...hintStyle, color: '#f76b15' } }, '最近错误：' + s.lastSysError) : null,
          )
        })()

        const list = s.records.length === 0
          ? React.createElement('div', { style: hintStyle }, '暂无通知')
          : s.records.slice().sort((a, b) => b.createdAt - a.createdAt).map(rec => {
            const chip = CHIP[rec.type] || { label: rec.type, color: '#8b8b93', bg: 'rgba(139,139,147,.15)' }
            const done = rec.status === 'resolved'
            return React.createElement('div', {
              key: rec.id,
              onClick: () => { markRead(rec.id); if (sessions) sessions.open(rec.sessionId) },
              style: {
                cursor: 'pointer', padding: '8px 4px', borderBottom: '1px solid rgba(255,255,255,.08)',
                opacity: done ? 0.55 : 1,
              },
            },
              React.createElement('div', { style: rowStyle },
                React.createElement('span', {
                  style: { fontSize: 11, color: chip.color, background: chip.bg, borderRadius: 4, padding: '1px 6px' },
                }, chip.label),
                React.createElement('span', { style: { fontSize: 11, opacity: 0.6 } }, fmtTime(rec.createdAt)),
                done ? React.createElement('span', { style: { fontSize: 11, color: '#30a46c' } }, '✓') : null,
              ),
              React.createElement('div', { style: { fontWeight: 600, marginTop: 3 } }, rec.title),
              React.createElement('div', { style: { fontSize: 12, opacity: 0.8, marginTop: 1, wordBreak: 'break-all' } }, rec.body),
            )
          })

        els.push(React.createElement('div', { key: 'panel', style: panelStyle },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 } },
            React.createElement('span', { style: { fontWeight: 700, fontSize: 14 } }, '通知中心'),
            React.createElement('span', { style: rowStyle },
              React.createElement('button', { onClick: markAllRead, style: btnStyle }, '全部已读'),
              React.createElement('button', {
                onClick: () => setState({ open: false }),
                style: { ...btnStyle, marginLeft: 6 },
              }, '关闭'),
            ),
          ),
          React.createElement('div', { style: { borderBottom: '1px solid rgba(255,255,255,.12)', paddingBottom: 8, marginBottom: 4 } }, sys),
          list,
        ))
      }
      return els.length ? React.createElement('div', null, ...els) : null
    }

    slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: 'ntfy.bell', order: 90, label: '通知' },
      () => React.createElement(Bell),
    ))
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'ntfy.overlay', order: 500, label: '通知中心' },
      () => React.createElement(NotifyOverlay),
    ))
  },
}
