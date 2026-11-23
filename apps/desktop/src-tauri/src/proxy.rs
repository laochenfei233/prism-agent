//! Loopback proxy for the app window.
//!
//! The webview's cookie pipeline cannot be relied on to carry the shell's
//! session: WKWebView stores the `dsh-auth-*` cookie but withholds it from the
//! app document's own requests, and WebView2 treats the framed app as a third
//! party whose `Set-Cookie` it may drop, while cookies ignore ports and so
//! outlive every loopback port change. Instead of fighting that pipeline, the
//! window talks to this proxy: every request (HTTP and the WebSocket upgrade)
//! leaves with the session injected as a `Cookie` header, a rewritten `Host`,
//! and a rewritten `Origin`/`Referer`, so the dsh server authenticates it
//! exactly like a browser request that carried the cookie. The webview's own
//! cookie jar is no longer involved.
//!
//! One request per client connection: non-upgrade requests are forwarded with
//! `Connection: close` so the response framing never needs parsing, and upgrade
//! requests (the WebSocket handshake) become a raw duplex pipe after the
//! injected handshake.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{OnceLock, RwLock};

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};

use crate::dsh_runner::append_startup_log;

/// Upstream target and session of the app window's proxy. Updated on every
/// readiness; connections read it once, so a restarted server on another port
/// takes effect without touching the window.
#[derive(Clone, Debug)]
pub(crate) struct Session {
    /// Loopback port of the live `dsh web` server.
    pub(crate) upstream_port: u16,
    /// `name=value` of the signed browser-session cookie.
    pub(crate) cookie: String,
}

static SESSION: RwLock<Option<Session>> = RwLock::new(None);
static PROXY_PORT: OnceLock<u16> = OnceLock::new();
static START_LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
static CHECKED: AtomicBool = AtomicBool::new(false);

/// Point the proxy at the live server and session. The proxy keeps its own
/// port and the app window keeps its origin, so this is all a restart needs.
pub(crate) fn session_updated(upstream_port: u16, cookie: String) {
    *SESSION.write().expect("proxy session lock") = Some(Session {
        upstream_port,
        cookie,
    });
}

/// Bind the proxy on a free loopback port (once per app run) and return it.
pub(crate) async fn ensure_started() -> Result<u16, String> {
    if let Some(port) = PROXY_PORT.get() {
        return Ok(*port);
    }
    let _guard = START_LOCK.lock().await;
    if let Some(port) = PROXY_PORT.get() {
        return Ok(*port);
    }
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|e| format!("app proxy bind failed: {e}"))?;
    let port = listener
        .local_addr()
        .map_err(|e| format!("app proxy address failed: {e}"))?
        .port();
    let _ = PROXY_PORT.set(port);
    tauri::async_runtime::spawn(accept_loop(listener));
    append_startup_log(&format!("app proxy listening on 127.0.0.1:{port}"));
    Ok(port)
}

/// Fetch the index through the proxy once per app run and record the status.
///
/// The exchange proves the token; this proves the path the window actually
/// takes — injected Cookie, rewritten Host — authenticates, so the next 401 in
/// the window is distinguishable from a proxy-side rejection by one startup
/// log line instead of another field round trip.
pub(crate) async fn self_check() {
    if CHECKED.swap(true, Ordering::SeqCst) {
        return;
    }
    let Some(port) = PROXY_PORT.get().copied() else {
        return;
    };
    let status = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|e| format!("connect failed: {e}"))?;
        stream
            .write_all(
                format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n")
                    .as_bytes(),
            )
            .await
            .map_err(|e| format!("write failed: {e}"))?;
        let mut head = [0u8; 128];
        let read = stream
            .read(&mut head)
            .await
            .map_err(|e| format!("read failed: {e}"))?;
        Ok::<String, String>(
            String::from_utf8_lossy(&head[..read])
                .lines()
                .next()
                .unwrap_or("no response")
                .to_owned(),
        )
    }
    .await;
    match status {
        Ok(line) => append_startup_log(&format!("app proxy self-check: {line}")),
        Err(err) => append_startup_log(&format!("app proxy self-check failed: {err}")),
    }
}

async fn accept_loop(listener: TcpListener) {
    loop {
        match listener.accept().await {
            Ok((client, _peer)) => {
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = serve(client).await {
                        append_startup_log(&format!("app proxy connection: {err}"));
                    }
                });
            }
            Err(err) => {
                append_startup_log(&format!("app proxy accept failed: {err}"));
                tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            }
        }
    }
}

/// Read one request head, rewrite it for the upstream server, forward it with
/// the session attached, then pipe both directions until either side closes.
async fn serve(mut client: TcpStream) -> Result<(), String> {
    let session = SESSION
        .read()
        .expect("proxy session lock")
        .clone()
        .ok_or("app proxy has no session yet")?;
    let mut buffer = Vec::with_capacity(8 * 1024);
    let mut chunk = [0u8; 4 * 1024];
    let head_len = loop {
        if let Some(len) = find_head_end(&buffer) {
            break len;
        }
        if buffer.len() > 64 * 1024 {
            return Err("request head exceeds 64 KiB".to_owned());
        }
        let read = client
            .read(&mut chunk)
            .await
            .map_err(|e| format!("client read failed: {e}"))?;
        if read == 0 {
            return Ok(());
        }
        buffer.extend_from_slice(&chunk[..read]);
    };
    let head = rewrite_head(&buffer[..head_len], &session).ok_or("malformed request head")?;
    let body = &buffer[head_len..];
    let mut upstream = TcpStream::connect(("127.0.0.1", session.upstream_port))
        .await
        .map_err(|e| format!("upstream connect failed: {e}"))?;
    upstream
        .write_all(&head)
        .await
        .map_err(|e| format!("upstream write failed: {e}"))?;
    if !body.is_empty() {
        upstream
            .write_all(body)
            .await
            .map_err(|e| format!("upstream write failed: {e}"))?;
    }
    // A reset after the upstream finished its response is not a forwarding
    // failure: the bytes already reached the webview, so only record it.
    if let Err(err) = tokio::io::copy_bidirectional(&mut client, &mut upstream).await {
        append_startup_log(&format!("app proxy pipe: {err}"));
    }
    let _ = client.shutdown().await;
    Ok(())
}

/// Index just past the blank line that ends a request head.
fn find_head_end(buffer: &[u8]) -> Option<usize> {
    buffer
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .map(|at| at + 4)
}

/// Authority the webview used to reach this proxy, from the request's own
/// `Host` header; the window loads the proxy origin, so this is its origin.
fn client_authority(text: &str) -> Option<&str> {
    text.split("\r\n").find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("host").then(|| value.trim())
    })
}

/// Rewrite one request head for the upstream server: the `Cookie` header is
/// replaced with the session, `Host` points at the server authority the
/// session was minted for, and `Origin`/`Referer` lose the proxy origin.
/// Non-upgrade requests are made one-shot (`Connection: close`) so no request
/// framing is needed past the head. Returns the rewritten head (including the
/// terminating blank line) and whether the request upgrades.
fn rewrite_head(head: &[u8], session: &Session) -> Option<Vec<u8>> {
    let text = std::str::from_utf8(head).ok()?;
    let mut lines = text.split("\r\n");
    let request_line = lines.next()?;
    if !request_line.contains(" HTTP/1.") {
        return None;
    }
    let upgrade = text.to_ascii_lowercase().contains("\r\nupgrade:");
    let client = client_authority(text)?;
    let upstream = format!("127.0.0.1:{}", session.upstream_port);
    let proxy_origin = format!("http://{client}");
    let trusted_origin = format!("http://{upstream}");
    let mut out = String::with_capacity(text.len() + session.cookie.len() + 64);
    out.push_str(request_line);
    out.push_str("\r\n");
    for line in lines {
        if line.is_empty() {
            continue;
        }
        let lower = line.to_ascii_lowercase();
        if lower.starts_with("host:") {
            out.push_str(&format!("Host: {upstream}\r\n"));
            continue;
        }
        if lower.starts_with("cookie:") {
            // Replaced wholesale: the webview's stale cookie jar never leaks
            // into the upstream request.
            continue;
        }
        if lower.starts_with("origin:") || lower.starts_with("referer:") {
            out.push_str(&line.replace(&proxy_origin, &trusted_origin));
            out.push_str("\r\n");
            continue;
        }
        out.push_str(line);
        out.push_str("\r\n");
    }
    out.push_str(&format!("Cookie: {}\r\n", session.cookie));
    if !upgrade {
        out.push_str("Connection: close\r\n");
    }
    out.push_str("\r\n");
    Some(out.into_bytes())
}

#[cfg(test)]
mod tests {
    use super::{find_head_end, rewrite_head, serve, Session, SESSION};

    fn session() -> Session {
        Session {
            upstream_port: 3081,
            cookie: "dsh-auth-abc=value".to_owned(),
        }
    }

    fn head(text: &str) -> String {
        let bytes = rewrite_head(text.as_bytes(), &session()).unwrap();
        String::from_utf8(bytes).unwrap()
    }

    #[test]
    fn find_head_end_reports_just_past_the_blank_line() {
        assert_eq!(
            find_head_end(b"GET / HTTP/1.1\r\nA: b\r\n\r\nrest"),
            Some(24)
        );
        assert_eq!(find_head_end(b"GET / HTTP/1.1\r\nA: b"), None);
    }

    #[test]
    fn rewrite_replaces_host_cookie_and_origin() {
        let out = head(
            "GET /index.html HTTP/1.1\r\nHost: 127.0.0.1:40000\r\nCookie: stale=1; other=2\r\nOrigin: http://127.0.0.1:40000\r\nReferer: http://127.0.0.1:40000/index.html\r\nAccept: */*\r\n\r\n",
        );
        assert!(out.starts_with("GET /index.html HTTP/1.1\r\n"));
        assert!(out.contains("Host: 127.0.0.1:3081\r\n"));
        assert!(!out.contains("stale=1"));
        assert!(!out.contains("other=2"));
        assert_eq!(out.matches("Cookie: ").count(), 1);
        assert!(out.contains("Cookie: dsh-auth-abc=value\r\n"));
        assert!(out.contains("Origin: http://127.0.0.1:3081\r\n"));
        assert!(out.contains("Referer: http://127.0.0.1:3081/index.html\r\n"));
        assert!(out.contains("Accept: */*\r\n"));
        assert!(out.ends_with("Connection: close\r\n\r\n"));
    }

    #[test]
    fn rewrite_keeps_upgrade_connections_open() {
        let out = head(
            "GET /api/remote.mux HTTP/1.1\r\nHost: 127.0.0.1:40000\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: x\r\n\r\n",
        );
        assert!(!out.contains("Connection: close"));
        assert!(out.contains("Cookie: dsh-auth-abc=value\r\n"));
        assert!(out.contains("Host: 127.0.0.1:3081\r\n"));
    }

    #[test]
    fn rewrite_rejects_non_http_heads() {
        assert!(rewrite_head(b"not a request\r\n\r\n", &session()).is_none());
        assert!(rewrite_head(&[0xff, 0x00, 0x0d], &session()).is_none());
        // No Host line: the proxy origin cannot be derived, so the request is
        // refused instead of forwarding a header set it cannot vouch for.
        assert!(rewrite_head(b"GET / HTTP/1.1\r\nAccept: */*\r\n\r\n", &session()).is_none());
    }

    #[tokio::test]
    async fn serve_forwards_an_authenticated_request_and_relays_the_response() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        use tokio::net::TcpListener;

        // Stand-in for dsh: capture the head the proxy sends and answer it.
        let upstream = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let upstream_port = upstream.local_addr().unwrap().port();
        let seen = tokio::spawn(async move {
            let (mut socket, _) = upstream.accept().await.unwrap();
            let mut buffer = [0u8; 1024];
            let read = socket.read(&mut buffer).await.unwrap();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .await
                .unwrap();
            String::from_utf8_lossy(&buffer[..read]).into_owned()
        });

        *SESSION.write().unwrap() = Some(Session {
            upstream_port,
            cookie: "dsh-auth-abc=value".to_owned(),
        });
        let browser = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let browser_port = browser.local_addr().unwrap().port();
        let mut client = tokio::net::TcpStream::connect(("127.0.0.1", browser_port))
            .await
            .unwrap();
        let (webview, _) = browser.accept().await.unwrap();

        let proxied = tokio::spawn(async move { serve(webview).await });
        client
            .write_all(
                format!(
                    "GET / HTTP/1.1\r\nHost: 127.0.0.1:{browser_port}\r\nOrigin: http://127.0.0.1:{browser_port}\r\nCookie: stale=1\r\n\r\n"
                )
                .as_bytes(),
            )
            .await
            .unwrap();
        // Half-close like a client that is done sending: the proxy forwards the
        // body-less request and relays the response until the upstream closes.
        client.shutdown().await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert!(String::from_utf8_lossy(&response).starts_with("HTTP/1.1 200 OK"));
        assert!(String::from_utf8_lossy(&response).ends_with("ok"));

        proxied.await.unwrap().unwrap();
        let head = seen.await.unwrap();
        assert!(
            head.contains(&format!("Host: 127.0.0.1:{upstream_port}\r\n")),
            "{head}"
        );
        assert!(head.contains("Cookie: dsh-auth-abc=value\r\n"), "{head}");
        assert!(!head.contains("stale=1"), "{head}");
        assert!(
            head.contains(&format!("Origin: http://127.0.0.1:{upstream_port}\r\n")),
            "{head}"
        );
    }
}
