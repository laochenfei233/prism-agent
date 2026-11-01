/**
 * Product copy for the memory page.
 *
 * One namespace, two dictionaries with the same key set. The page receives a
 * translator bound to this namespace and never renders a literal string, so a
 * missing translation is a compile error rather than English leaking into a
 * Chinese build.
 *
 * @module @prism/prism-memory/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'prismMemory.panel'

/** Chinese dictionary; its key set is this plugin's copy contract. */
export const zh = {
  panel: '记忆',
  title: '长期记忆',
  counts: '共 {total} 条 · {pending} 条待审 · {layers} 个层',
  searchHint: '按关键词查找记忆',
  searchAction: '查找',
  searchClear: '清除',
  addHint: '记住一条事实：一句话，脱离本次对话也能看懂',
  addAction: '记住',
  layerLabel: '归入',
  reviewHeading: '待审（通过后才进入模型视野）',
  reviewApprove: '通过',
  reviewReject: '驳回',
  recentHeading: '最近的记忆',
  searchHeading: '匹配结果',
  empty: '还没有任何记忆。用上面的输入框记住第一条。',
  noMatch: '没有匹配的记忆。',
  loading: '读取中…',
  failed: '无法读取记忆：{reason}',
  retry: '重试',
  stored: '已记住 {id}',
  existing: '已存在同一条，复用计数 +1：{id}',
  approved: '已通过 {id}',
  rejected: '已驳回 {id}',
  scopeLabel: '范围',
}

/** English dictionary, keyed identically to {@link zh}. */
export const en: Record<MemoryLocaleKey, string> = {
  panel: 'Memory',
  title: 'Long-term memory',
  counts: '{total} records · {pending} awaiting review · {layers} layers',
  searchHint: 'Search memory by keyword',
  searchAction: 'Search',
  searchClear: 'Clear',
  addHint: 'One fact: a sentence that stands on its own outside this conversation',
  addAction: 'Remember',
  layerLabel: 'Layer',
  reviewHeading: 'Awaiting review (nothing is injected until approved)',
  reviewApprove: 'Approve',
  reviewReject: 'Reject',
  recentHeading: 'Recent memory',
  searchHeading: 'Matches',
  empty: 'No memory yet. Use the field above to remember the first claim.',
  noMatch: 'No memory matched.',
  loading: 'Loading…',
  failed: 'Could not read memory: {reason}',
  retry: 'Retry',
  stored: 'Remembered {id}',
  existing: 'The same claim already stood; its reuse count rose: {id}',
  approved: 'Approved {id}',
  rejected: 'Rejected {id}',
  scopeLabel: 'Scope',
}

/** Every key this namespace defines. */
export type MemoryLocaleKey = keyof typeof zh

/** Translate one key of this namespace. */
export type Translate = (key: MemoryLocaleKey, params?: Record<string, string | number>) => string
