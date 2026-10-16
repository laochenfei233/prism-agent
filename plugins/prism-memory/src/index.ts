/**
 * Plugin entry: the durable long-term memory service.
 *
 * This module exports one form only — a service class as the default export —
 * because the Loader discards a function plugin's namespace when a module mixes
 * the two forms. The model-facing tools and the operator command are separate
 * entries (`./tools`, `./commands`) with their own rows.
 *
 * @module @prism/prism-memory
 */

export { PrismMemoryService as default, PrismMemoryService, PrismMemoryError } from './service.ts'
export type {
  AdmissionStatus,
  DreamReport,
  ExportResult,
  ImportReport,
  MaintenanceReport,
  MemoryAdmission,
  PrismMemoryConfig,
  RememberInput,
  RememberResult,
} from './service.ts'
export type { ConversationBucket, MemoryHit, MemoryKind, MemoryOrigin, MemoryScope, MemoryStatus } from './memory.ts'
export {
  assertIdentityLayers,
  DEFAULT_LAYER,
  kindForLayer,
  LAYER_GLOSS,
  layerOf,
  layerWeight,
  MEMORY_LAYERS,
  SHIPPED_IDENTITY_LAYERS,
} from './layers.ts'
export type { MemoryLayer } from './layers.ts'
export { distillCandidates } from './distill.ts'
export { DREAM_TAG, planDream, REFLECTION_TAG, renderDreamJournal, renderReflection, TOPIC_TAG } from './dream.ts'
export type { Conflict, Corroboration, DreamPlan, TopicDigest } from './dream.ts'
export { collectMemoryFiles, IMPORT_SOURCES, IMPORT_SOURCE_IDS, parseMemoryClaims, readMemoryFile } from './import.ts'
export type { DiscoveredFile, ImportedClaim, ImportSourceSpec } from './import.ts'
export { dayPartOf, renderOrientation, renderTail } from './recall.ts'
export type { DayPart, TailParts } from './recall.ts'
export type { MemoryRecord } from './domain.ts'
export type { MemoryChainEntry, MemoryProvenance, MemoryView, PrismMemoryInjectedState } from './types.ts'
