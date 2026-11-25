---
type: changed
breaking: true
audience: user
commits:
---
The memory plugin's model-assisted distillation now admits each candidate through the same source trust tiers as the form distiller, keyed by the speaker of the message the candidate cites: a claim grounded in the person's own message can land active on the shipped defaults, while one grounded in the assistant's account parks until corroborated. The `assistedDistillConfidence` key is removed, and the per-turn `llmDistill` channel that existed only on an unreleased branch is retired in favor of the assisted window, whose call keeps the `memory-distill` purpose stamp for cost attribution.
