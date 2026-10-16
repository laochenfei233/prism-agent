/**
 * The memory layer axis: what a claim is *about*, as distinct from what sort of
 * statement it is (`kind`) and who may see it (`scope`).
 *
 * The three axes are independent and each answers a different question, which is
 * why recall quality improves when a caller can name all three. A claim is a
 * `preference` (kind) held by `this user` (layer `user`) and visible from `every
 * session` (scope `global`).
 *
 * Two consequences of the layer axis are encoded here rather than in the
 * service:
 *
 * 1. **Layers decide the always-on set.** Records on an identity layer are
 *    injected on a session's first turn without waiting for a keyword match,
 *    because a preference or a hard rule is relevant before it is mentioned.
 * 2. **Layers weight relevance.** A matched hard rule or lesson outranks a
 *    matched encyclopedic fact.
 *
 * A record that declares no layer — every record written before this axis
 * existed — is ranked as {@link DEFAULT_LAYER}, which is deliberately a
 * relevance layer and not an identity one. That keeps an existing corpus
 * byte-identical in what it injects: no legacy record silently becomes
 * always-on.
 *
 * @module @prism/prism-memory/layers
 */

import type { MemoryKind } from './memory.ts'

/** Durable memory layers, in the order the protocol text names them. */
export const MEMORY_LAYERS = ['soul', 'user', 'project', 'fact', 'lesson', 'topic', 'rule'] as const

/** One durable memory layer. */
export type MemoryLayer = (typeof MEMORY_LAYERS)[number]

/**
 * The layer a record is ranked as when it declares none. Chosen as a relevance
 * layer on purpose: identity layers inject on a first turn without a keyword
 * match, so deriving one for a legacy record would change what an existing
 * corpus injects the moment this plugin is upgraded.
 */
export const DEFAULT_LAYER: MemoryLayer = 'fact'

/** Layers whose records inject on a session's first turn without a keyword match. */
export const SHIPPED_IDENTITY_LAYERS: readonly MemoryLayer[] = ['soul', 'user', 'rule']

/** One sentence of guidance per layer, for the protocol text and operator reports. */
export const LAYER_GLOSS: Readonly<Record<MemoryLayer, string>> = {
  soul: 'stable settings of the assistant itself: persona, language, working style',
  user: 'the user: preferences, habits, how they want to be spoken to',
  project: 'this working directory: its layout, conventions, and current state',
  fact: 'an objective fact about the world or the code',
  lesson: 'a mistake made and what it taught',
  topic: 'domain knowledge worth recalling on its own terms',
  rule: 'a hard constraint: something that must or must not happen',
}

/**
 * Relevance premium per layer. A matched constraint or lesson is worth more
 * than a matched encyclopedic fact; the identity layers carry no premium here
 * because they are already reached by the always-on path.
 */
const LAYER_WEIGHT: Readonly<Record<MemoryLayer, number>> = {
  rule: 1.25,
  lesson: 1.2,
  user: 1.15,
  project: 1.1,
  soul: 1.05,
  topic: 1,
  fact: 1,
}

/** The relevance premium one layer carries. */
export function layerWeight(layer: MemoryLayer): number {
  return LAYER_WEIGHT[layer]
}

/**
 * The layer a record declares, or {@link DEFAULT_LAYER} when it declares none.
 * @param record - any stored record or write candidate carrying an optional layer.
 * @returns the layer to rank, render, and group the record under.
 */
export function layerOf(record: { readonly layer?: MemoryLayer | undefined }): MemoryLayer {
  return record.layer ?? DEFAULT_LAYER
}

/**
 * The claim class a layer implies, for a source that names only the layer.
 *
 * Imported files and inferred sentences say what they are about long before they
 * say what kind of statement they are, so this is the mapping that lets a layer
 * alone produce a complete record.
 * @param layer - the layer the source named.
 * @returns the claim class to store with it.
 */
export function kindForLayer(layer: MemoryLayer): MemoryKind {
  switch (layer) {
    case 'user': return 'preference'
    case 'rule': return 'decision'
    case 'lesson': return 'pitfall'
    case 'soul':
    case 'project':
    case 'fact':
    case 'topic': return 'fact'
  }
}

/**
 * Filter and order an operator-supplied identity-layer list.
 *
 * Order is significant because it is the injection order, so a duplicate or a
 * value outside the taxonomy is a configuration error rather than something to
 * silently drop: an inaccessible layer name would look accepted and do nothing.
 * @param layers - the configured layer names, in injection order.
 * @returns the same list, validated.
 */
export function assertIdentityLayers(layers: readonly string[]): MemoryLayer[] {
  const seen = new Set<string>()
  return layers.map(layer => {
    if (!(MEMORY_LAYERS as readonly string[]).includes(layer)) {
      throw new Error(`prism-memory identityLayers names an unknown layer: ${layer}`)
    }
    if (seen.has(layer)) {
      throw new Error(`prism-memory identityLayers names ${layer} twice`)
    }
    seen.add(layer)
    return layer as MemoryLayer
  })
}
