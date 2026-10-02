// PRISM-DIVERGENCE: replay list in docs/compose/spec/fork-upstream-divergence.md (S2).
/** `brand` namespace dictionary: the product name the official wordmark draws. */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  name: 'PRISM AGENT',
} satisfies Record<string, string>

/** The brand namespace key union. */
export type BrandKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  name: 'PRISM AGENT',
} satisfies Record<BrandKey, string>
