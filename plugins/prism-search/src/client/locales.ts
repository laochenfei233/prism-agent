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
  title: 'Prism Search 多引擎搜索',
  description: '并行查询 18 个免费搜索引擎（Google、Bing、DuckDuckGo、百度、Brave 等），按倒数排名融合后抓取网页正文，再交给你在「模型管理」里选定的模型重排。',
  'provider.enable': '用 Prism Search 提供 web_search',
  'provider.current': '当前搜索源：{provider}',
  'provider.composed': '默认',
  'provider.enableHint': '关闭后回到默认搜索源。',
  'model.label': '重排模型',
  'model.none': '不使用模型重排',
  'model.hint': '模型来自「模型管理」，共 {count} 个可选。',
  'model.empty': '「模型管理」里还没有可用模型，先在那里添加模型。',
  'model.unavailable': '模型列表读取失败：{message}',
  'action.save': '保存',
  'action.saving': '保存中…',
  'status.saved': '已保存',
  'error.load': '读取设置失败：{message}',
  'error.save': '保存失败：{message}',
  'error.unwritable': '当前 profile 不可写。',
}

/** Every key the section translates. */
export type SearchLocaleKey = keyof typeof zh

/** English copy. */
export const en: Record<SearchLocaleKey, string> = {
  nav: 'Search',
  title: 'Prism Search multi-engine search',
  description: 'Queries 18 free search engines in parallel (Google, Bing, DuckDuckGo, Baidu, Brave, and more), fuses their rankings, reads the top pages, then orders the result with the model you select in Models.',
  'provider.enable': 'Provide web_search through Prism Search',
  'provider.current': 'Current search source: {provider}',
  'provider.composed': 'default',
  'provider.enableHint': 'Turning this off returns to the default search source.',
  'model.label': 'Ordering model',
  'model.none': 'No model ordering',
  'model.hint': 'Models come from Models; {count} are available.',
  'model.empty': 'Models has no available model yet; add one there first.',
  'model.unavailable': 'The model list could not be read: {message}',
  'action.save': 'Save',
  'action.saving': 'Saving…',
  'status.saved': 'Saved',
  'error.load': 'Could not read the settings: {message}',
  'error.save': 'Could not save: {message}',
  'error.unwritable': 'This profile is read-only.',
}
