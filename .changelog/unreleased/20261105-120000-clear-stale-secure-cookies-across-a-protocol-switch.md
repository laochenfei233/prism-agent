---
type: fixed
breaking: false
audience: user
commits: 04d321abea
draft: true
---
After a switch from an HTTPS listener back to plain HTTP, the stale Secure session cookie an earlier authority left behind is deleted again: mint responses now expire every stale session-cookie name with both secure variants of the deletion Set-Cookie, because a non-secure Set-Cookie cannot delete a Secure-only cookie (RFC 6265bis). Previously that cookie survived the prune and could push the browser's Cookie header back past the listener's request-header bound, wedging the launch-token exchange.
