---
type: added
breaking: false
audience: user
commits: d7306fb147
---
Give prism-guardrails a stuck-nudge rail that reminds instead of enforcing

When one turn piles up `stuckNudgeAfterFailures` consecutive failed calls (3 by default), a one-shot judge call through the agent's own provider route decides whether the failures are one loop. A confident yes attaches a reminder to the failing call's accepted result — change the approach, or say plainly that you are stuck and stop — and the call itself is never refused. Any success clears the run, a new turn starts fresh, `stuckNudgePerTurn` bounds the reminders, and the rail ships on because it refuses nothing: `stuckNudgeAfterFailures: 0` turns it off. `/guardrails` lists the rail and records each reminder as a `steer`.
