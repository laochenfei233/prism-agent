// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-sidebar.md (S5).
/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allowOnce: '允许一次',
  'rejectFor': '拒绝：{title}',
  'allowOnceFor': '允许一次：{title}',
  'hint.progress': '在进展面板审批',
  'hint.list': '在对话列表审批',
  'settings.title': '审批位置',
  'settings.description': '「拒绝」与「允许一次」显示在哪里；另一处只显示请求内容。',
  'settings.progress': '进展面板',
  'settings.list': '对话列表',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allowOnce: 'Allow once',
  'rejectFor': 'Reject for {title}',
  'allowOnceFor': 'Allow once for {title}',
  'hint.progress': 'Approve in Progress',
  'hint.list': 'Approve in the session list',
  'settings.title': 'Where approvals are answered',
  'settings.description': 'Reject and Allow once appear here; the other place keeps showing the request.',
  'settings.progress': 'Progress panel',
  'settings.list': 'Session list',
} satisfies Record<ApprovalKey, string>
