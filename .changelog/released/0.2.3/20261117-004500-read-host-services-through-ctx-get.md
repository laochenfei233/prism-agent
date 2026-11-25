---
type: fixed
breaking: false
audience: user
---
Read host services through ctx.get in prism-pocket and prism-local-models

Both plugins still read host services with `Reflect.get(ctx, name)`. The
resynced cordis context proxy rejects undeclared property access, so those
reads fail with "cannot get property ... without inject" the moment they run
in a fiber context — the same failure that broke the hachimodock bridge
entry after the 0.2.2-rc.1 update. All reads now go through `ctx.get`, which
needs no inject declaration and returns `undefined` when the service is
absent; the guards around the required services keep their localized errors.
pocket's tsconfig maps cordis to the built vendor types like prism-hachimodock
already does, and local-models widens its pinned cordis declaration with
`ctx.get` beside the existing `ctx.provide` widening.
