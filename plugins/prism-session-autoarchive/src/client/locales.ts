/** Product copy for the archived-projects settings section. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.projectAutoarchive'

/** Chinese dictionary; the key set is this plugin's copy contract. */
export const zh: Record<string, string> = {
  nav: '已归档项目',
  intro: '不再有可见对话且超过设定天数的项目会移到这里。恢复后回到原位置，或重新添加同一路径的文件夹。',
  empty: '没有已归档的项目。',
  count: '共 {count} 个',
  restore: '恢复',
  restoring: '正在恢复…',
  restored: '已恢复“{title}”',
  restoreFailed: '无法恢复“{title}”，请稍后重试。',
  lastActivity: '最后活动 {when}',
  never: '从未使用',
}

/** English dictionary, checked complete against the zh key set. */
export const en: Record<string, string> = {
  nav: 'Archived projects',
  intro: 'Projects with no visible conversation past the configured number of days move here. Restoring one puts it back in place, or add the same folder again.',
  empty: 'No archived projects.',
  count: '{count} archived',
  restore: 'Restore',
  restoring: 'Restoring…',
  restored: 'Restored "{title}"',
  restoreFailed: 'Could not restore "{title}". Try again.',
  lastActivity: 'Last activity {when}',
  never: 'Never used',
}
