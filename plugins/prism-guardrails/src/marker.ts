/**
 * The comment prefix Ponytail markers carry, so prose that merely mentions the
 * convention is not a marker.
 *
 * `shortcut:` is the current spelling in the Ponytail skill set; `ponytail:` is
 * the older one those skills still accept, so code written under either
 * convention is held to the upgrade-path rule.
 */
export const PONYTAIL_MARKER = /(?:#|\/\/|\/\*|\*)\s*(?:shortcut|ponytail):/u
