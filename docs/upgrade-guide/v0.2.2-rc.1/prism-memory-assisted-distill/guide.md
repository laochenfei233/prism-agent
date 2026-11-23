---
kind: upgrade-guide
description: "prism-memory's model-assisted distillation now admits candidates through the source trust tiers, and the assistedDistillConfidence key is gone."
---

# prism-memory model-read claims follow the source trust tiers

English | [中文](guide.zh.md)

## Change

Through v0.2.2-rc.1, a model-assisted distillation candidate was written `pending` with `assistedDistillConfidence` (default `0.5`) no matter who said the line it was grounded in, so every model-read claim waited in the review inbox. Now a candidate lands on the same trust tiers as the form distiller's claims, keyed by the speaker of the message it cites: a candidate grounded in the person's own message writes at `autoDistillUserConfidence` (default `0.7`) and can go `active` on the shipped defaults, and one grounded in the assistant's account writes at `autoDistillConfidence` (default `0.4`) and parks until the write path or a consolidation pass corroborates it. The `assistedDistillConfidence` configuration key is removed. Deployments that set that key, and deployments that depend on every model-read claim waiting for review, are affected.

## Migration

1. In the deployment's `cordis.yml`, patch, or overlay, delete the `assistedDistillConfidence` row under the prism-memory config; the plugin no longer reads it.
2. If model-read claims must keep waiting for a person's approval, set `autoDistillStatus: pending` in the same config row — that returns every automatic producer, this channel included, to review-first.
3. Restart and open the memory page: the claims the window wrote after the upgrade carry the tier evidence note, and the review inbox lists only what the tier policy parks.
