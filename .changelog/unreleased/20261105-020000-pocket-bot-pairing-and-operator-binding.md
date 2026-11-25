---
type: fixed
breaking: false
audience: user
commits: 1e1a8a8fcb
---
Pocket bot bindings now record the operator's sender identity, so a group member or a stranger in another chat can no longer rebind with `/new`, drive the session, or approve tool executions from the bound chat. A channel never claims a binding on its first message either: the Pocket page shows a pairing code beside the QR (copyable, rotatable in one click) and `/start <code>` from your chat binds the bot; the code rotates on every successful pairing. `/new` still rebinds — but only for the operator, whose sender identity also recovers the session from any other chat. The callback-signing tokens (WeCom/WeChat token, WhatsApp verify token) are now masked in the list route like the other secrets, callback signature checks compare in constant time, and replayed callback messages are deduplicated before any handling. The QR caption now notes that the scan is a login link and should not be shared or screenshotted.
