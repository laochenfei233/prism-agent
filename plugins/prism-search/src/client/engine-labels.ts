/**
 * Display names of the keyless engines, for the settings section's coverage
 * line. The host half owns the engine specs; this list repeats only the names,
 * and `tests/engines.spec.ts` fails when the ids drift out of order.
 *
 * @module @prism/prism-search/client/engine-labels
 */

/** One engine's id and display name, in catalog order. */
export interface EngineLabel {
  /** Engine id the host registers. */
  readonly id: string
  /** Display name shown in the section. */
  readonly label: string
}

/** Every engine the host half queries, in catalog order. */
export const ENGINE_LABELS: readonly EngineLabel[] = [
  { id: 'google', label: 'Google' },
  { id: 'bing', label: 'Bing' },
  { id: 'duckduckgo', label: 'DuckDuckGo' },
  { id: 'brave', label: 'Brave' },
  { id: 'startpage', label: 'Startpage' },
  { id: 'yahoo', label: 'Yahoo' },
  { id: 'yandex', label: 'Yandex' },
  { id: 'mojeek', label: 'Mojeek' },
  { id: 'marginalia', label: 'Marginalia' },
  { id: 'qwant', label: 'Qwant' },
  { id: 'baidu', label: '百度' },
  { id: 'sogou', label: '搜狗' },
  { id: 'so360', label: '360 搜索' },
  { id: 'bilibili', label: '哔哩哔哩' },
  { id: 'wikipedia', label: 'Wikipedia' },
  { id: 'github', label: 'GitHub' },
  { id: 'hackernews', label: 'Hacker News' },
  { id: 'stackexchange', label: 'Stack Exchange' },
]
