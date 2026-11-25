/**
 * Product copy for the team panel, owned by one typed dictionary per locale.
 *
 * @module prism-team/client/locales
 */

import type {} from '@deepseek-ai/dsh-client-ui-slots'

/** Dictionary namespace this plugin registers. */
export const NS = 'prism-team'

/** English copy. */
export const en = {
  'view.team': 'Team',
  'empty': 'This session is not on a team yet. Create a teammate to start one.',
  'needsAPerson': 'needs a person',
  'working': 'working',
  'tasks': 'tasks',
  'members': 'members',
  'refresh': 'Refresh',
  'loading': 'Loading the team…',
  'failed': 'The team panel could not load.',
  'offline': 'The team is not running right now; reports below are the last this session recorded.',
} as const

/** Chinese copy. */
export const zh = {
  'view.team': '团队',
  'empty': '本会话还没有团队。创建一个 teammate 即开始。',
  'needsAPerson': '需要人',
  'working': '进行中',
  'tasks': '任务',
  'members': '成员',
  'refresh': '刷新',
  'loading': '正在读取团队…',
  'failed': '团队面板读取失败。',
  'offline': '团队当前没有在运行；下面是本会话记录到的汇报。',
} as const

/** Every key the component asks for. */
export type TeamKey = keyof typeof en

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The team header entry and panel copy. */
    'prism-team': TeamKey
  }
}
