---
type: added
breaking: false
audience: user
commits: c3a864baaf
---
Give prism-memory an opt-in model-assisted distillation window and a `/memory bootstrap` pass over past sessions

With `assistedDistill` on, the turn-stopping path keeps a rolling buffer of recent turns and, every `assistedDistillEveryTurns` turns, asks the deployment's own model to propose the durable claims the form-recognizing reader cannot see. Every candidate is written `pending` — the model proposes, a person promotes — and one that names its source message is cited with the same fingerprint `/memory verify` re-reads. `/memory bootstrap apply` closes a fresh install's cold start: it distills past sessions of the calling working directory through the same protocol, once per session, skipping sessions a completed pass already processed, and fails loud when the session-query engine, the llm service, or a routed model is missing.
