---
description: "IANA time-zone canonicalization and local-reading-to-instant projection for maintainers accepting a caller-reported zone, or resolving a rule stated in one."
kind: "package-library"
---

# dsh-util-time

English | [中文](README.zh.md)

## Summary

Zero-dependency zone vocabulary for the boundaries that accept a caller's time zone and for the rules stated in one. `canonicalClientTimeZone` admits `UTC` or an IANA `Area/Location` name and answers the platform-canonical spelling of it, so an alias never reaches a durable record. `resolveLocalInstants` enumerates the instants one wall-clock reading denotes in a zone — one, two across a repeated hour, or none where the zone skips it — and `localCalendarEpoch` provides the UTC-shaped value that projection compares against. The library formats no output, holds no state, and raises no domain code.

## Table of Contents

- [Use this package](#use-this-package)
- [API](#api)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

It is a **library, not a service or plugin**: no `ctx`, registers nothing, holds no state.

No runtime invariant companion is published because this pure utility owns no event stream or mutable runtime data; unit tests verify zone canonicalization and the local-reading projection, including a zone's repeated and skipped hours.

Call `canonicalClientTimeZone` at the boundary that receives the zone, before the value reaches anything durable. An unusable name answers `undefined`, and the caller raises its own refusal — `session/invalid-time-zone` for the Session prompt, `subagent/invalid-time-zone` for a subagent continuation.

Call `resolveLocalInstants` where a stored or configured rule states a wall-clock time in a zone. The answer is data: the caller decides which instant a rule means when the zone repeated the reading, and what to do when the zone skipped it. A reading that names no real calendar time is a caller defect rather than domain data, so it throws `RangeError`.

-----

<a id="api"></a>
## API

```ts
import { canonicalClientTimeZone, localCalendarEpoch, resolveLocalInstants } from '@deepseek-ai/dsh-util-time'
```

| Export | Role |
|---|---|
| `canonicalClientTimeZone(value)` | Canonical `UTC` or IANA `Area/Location` name for an accepted zone, `undefined` for a blank, padded, abbreviated, single-segment, or platform-unsupported one. |
| `resolveLocalInstants(parts, timeZone)` | The ascending instants one wall-clock reading denotes in the zone: one ordinarily, two across a repeated hour, none where the zone skips it, plus whether the reading falls outside the represented range. |
| `localCalendarEpoch(parts)` | The UTC-shaped epoch carrying the reading's fields, which is what the projection compares candidates against; `RangeError` when the reading names no real calendar time. |
| `MIN_FOUR_DIGIT_YEAR_MS`, `MAX_FOUR_DIGIT_YEAR_MS` | The earliest and latest instants this vocabulary represents, so a caller can reject an out-of-range rule with its own code. |

<a id="model-experience"></a>
## Model Experience

Indirectly, through the consumer that records a canonical zone on a durable message, from which `dsh-time-context` renders the turn's model-visible zone instruction and timestamp.

#### KV Cache effect

None of its own. The consumer that injects a zone-derived line into a request owns that request's cache behavior.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Alias resolution follows the runtime's ICU data** — which name an alias group canonicalizes to is the platform's answer, so two processes on different Node builds can disagree about it.
- **Zone offsets also follow the runtime's ICU data** — the projection samples offsets through `Intl`, so a zone whose rules changed in a tzdata release resolves against the rules the running Node carries, not the ones in force when the rule was written.
- **Projection, not a rule engine** — the library reports the instants one reading denotes and stops there: it has no notion of recurrence, intervals, calendars, or which of two instants a rule means, and it holds no failure vocabulary for the caller's own refusals.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
