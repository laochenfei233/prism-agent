/**
 * Locale dictionaries for the Prism Search settings section.
 *
 * @module @prism/prism-search/client/locales
 */

/** Locale namespace this section registers. */
export const NS = 'prism-search.settings'

/** Chinese copy. */
export const zh = {
  nav: '搜索',
  title: 'Prism Search',
  intro: '并行查询 18 个免费搜索引擎，融合排序并抓取正文，再用你在模型管理里选定的模型重排。',
  engines: '{count} 个免费引擎：{list}',
  'source.title': '搜索来源',
  'source.current': '当前：',
  'source.default': '默认搜索源',
  'source.enable': '用 Prism Search 提供 web_search',
  'source.hint': '关闭后回到默认搜索源。',
  'model.title': '重排模型',
  'model.none': '不使用模型重排',
  'model.hint': '来自模型管理，共 {count} 个可选。',
  'model.empty': '模型管理里还没有可用模型，先在那里添加。',
  'model.unavailable': '模型列表读取失败：{message}',
  'action.save': '保存',
  'action.saving': '保存中…',
  'status.saved': '已保存',
  'status.loading': '读取中…',
  'error.load': '读取设置失败：{message}',
  'error.save': '保存失败：{message}',
  'error.unwritable': '当前 profile 不可写，修改不会保存。',
}

/** Every key the section translates. */
export type SearchLocaleKey = keyof typeof zh

/** English copy. */
export const en: Record<SearchLocaleKey, string> = {
  nav: 'Search',
  title: 'Prism Search',
  intro: 'Queries 18 free search engines in parallel, fuses their rankings, reads the top pages, then orders the result with the model you select in Models.',
  engines: '{count} free engines: {list}',
  'source.title': 'Search source',
  'source.current': 'Current: ',
  'source.default': 'default source',
  'source.enable': 'Provide web_search through Prism Search',
  'source.hint': 'Turning this off returns to the default search source.',
  'model.title': 'Ordering model',
  'model.none': 'No model ordering',
  'model.hint': 'Comes from Models; {count} available.',
  'model.empty': 'Models has no available model yet; add one there first.',
  'model.unavailable': 'Could not read the model list: {message}',
  'action.save': 'Save',
  'action.saving': 'Saving…',
  'status.saved': 'Saved',
  'status.loading': 'Loading…',
  'error.load': 'Could not read the settings: {message}',
  'error.save': 'Could not save: {message}',
  'error.unwritable': 'This profile is read-only; changes will not be saved.',
}
