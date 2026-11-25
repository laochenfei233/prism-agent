/**
 * The anonymous page a phone opens to ask for access. It holds no credential
 * of its own: the applicant generates a ticket secret in this browser, shows
 * the host-issued code, and polls until the owner decides here on the desktop.
 *
 * @module @prism/prism-pocket/pairing/page
 */

/** Self-contained document: no scripts, fonts, or images leave this origin. */
export const PAIRING_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<title>Prism</title>
<style>
:root { color-scheme: dark }
body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
  background: #0b0e14; color: #c8d3f5; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif }
main { width: min(360px, 88vw); padding: 28px 22px; border: 1px solid #232a3b; border-radius: 14px; background: #11151f }
h1 { margin: 0 0 6px; font-size: 17px; font-weight: 600 }
p { margin: 8px 0; color: #8b95b5; font-size: 14px }
#code { display: block; margin: 18px 0; padding: 12px 0; border: 1px solid #2c3450; border-radius: 10px;
  font: 600 24px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 4px; text-align: center; color: #e7ecff }
#status { min-height: 20px; font-size: 14px }
#actions { display: flex; gap: 10px; margin-top: 14px }
button { flex: 1; padding: 10px 12px; border-radius: 9px; border: 1px solid #2c3450; background: #182034;
  color: #c8d3f5; font: inherit; font-size: 14px }
button[hidden] { display: none }
</style>
</head>
<body>
<main>
  <h1 id="title">Allow this phone</h1>
  <p id="hint">Compare this code with the one shown in Prism → Settings → Pocket on your computer, then approve it there.</p>
  <code id="code">····</code>
  <p id="status">Requesting…</p>
  <div id="actions">
    <button id="retry" hidden></button>
    <button id="cancel"></button>
  </div>
</main>
<script>
(() => {
  const zh = ((navigator.language || 'en') + '').toLowerCase().startsWith('zh')
  const t = zh ? {
    title: '允许这台手机接入', hint: '把下面的接入码和电脑上 Prism → 设置 → Pocket 里显示的码比对，然后在电脑上点“允许”。',
    requesting: '正在申请…', waiting: '等待在电脑上批准…', network: '连不上这台电脑，稍后重试。',
    denied: '请求被拒绝。', expired: '请求已过期。', cancelled: '请求已取消。', unavailable: '这台电脑暂时不可用。',
    retry: '重新申请', cancel: '取消',
  } : {
    title: 'Allow this phone', hint: 'Compare this code with the one shown in Prism → Settings → Pocket on your computer, then approve it there.',
    requesting: 'Requesting…', waiting: 'Waiting for approval on the computer…', network: 'Cannot reach the computer. Retrying.',
    denied: 'The request was denied.', expired: 'The request expired.', cancelled: 'The request was cancelled.', unavailable: 'The computer is not available.',
    retry: 'Request again', cancel: 'Cancel',
  }
  const el = id => document.getElementById(id)
  el('title').textContent = t.title
  el('hint').textContent = t.hint
  el('retry').textContent = t.retry
  el('cancel').textContent = t.cancel
  const b64url = bytes => btoa(String.fromCharCode.apply(null, bytes))
    .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/u, '')
  // getRandomValues works on insecure origins; randomUUID does not, and the
  // LAN transport serves plain http. The id is an opaque token, not a UUID.
  const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, '0')).join('')
  const ticket = () => ({
    id: randomId(),
    secret: b64url(crypto.getRandomValues(new Uint8Array(32))),
  })
  let current = null
  let timer = 0
  const stop = () => { if (timer) { clearInterval(timer); timer = 0 } }
  const settle = message => {
    stop()
    el('status').textContent = message
    el('retry').hidden = false
    el('cancel').hidden = true
  }
  const post = async (path, body) => {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify(body),
    })
    const payload = await response.json().catch(() => undefined)
    if (!response.ok || typeof payload !== 'object' || payload === null) throw new Error('request failed')
    return payload
  }
  const poll = async () => {
    if (current === null) return
    try {
      const answer = await post('/pocket-pair/status', current)
      if (answer.status === 'approved') {
        stop()
        location.replace(answer.url)
        return
      }
      if (answer.status === 'pending' || answer.status === 'slow-down') {
        el('status').textContent = t.waiting
        return
      }
      settle(t[answer.status] ?? t.unavailable)
    } catch {
      el('status').textContent = t.network
    }
  }
  const start = async () => {
    stop()
    el('retry').hidden = true
    el('cancel').hidden = false
    el('status').textContent = t.requesting
    el('code').textContent = '····'
    current = ticket()
    try {
      const answer = await post('/pocket-pair/request', current)
      el('code').textContent = answer.code
      el('status').textContent = t.waiting
      timer = setInterval(poll, 2000)
    } catch {
      settle(t.network)
    }
  }
  el('retry').addEventListener('click', start)
  el('cancel').addEventListener('click', async () => {
    stop()
    if (current !== null) await post('/pocket-pair/cancel', current).catch(() => undefined)
    settle(t.cancelled)
  })
  start()
  addEventListener('pagehide', stop)
})()
</script>
</body>
</html>
`
