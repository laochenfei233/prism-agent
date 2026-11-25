---
type: fixed
breaking: false
audience: user
---
Read the host connection through ctx.get in the hachimodock bridge

The hachimodock plugin used to read the host `connection` service with
`Reflect.get(ctx, 'connection')`. The resynced cordis context proxy rejects
undeclared property access, so every activation failed with "cannot get
property \"connection\" without inject" and the desktop-side bridge entry
never came up after the 0.2.2-rc.1 update. The plugin now reads the service
through `ctx.get`, which needs no inject declaration and returns `undefined`
when the service is absent, so the activation stream stays optional exactly
as the surrounding guard intends.
