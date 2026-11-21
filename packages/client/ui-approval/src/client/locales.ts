// PRISM-DIVERGENCE: replay list in docs/compose/spec/approval-panel.md (S5).
/** `approval` namespace dictionaries. */

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  waiting: '等待审批',
  'detail.aria': '审批详情',
  escalation: '工具 {toolName} 请求越权执行',
  reject: '拒绝',
  allow: '允许',
  allowOnce: '允许一次',
  'rejectFor': '拒绝：{title}',
  'allowOnceFor': '允许一次：{title}',
  'hint.progress': '在进展面板审批',
  'hint.list': '在对话列表审批',
  'settings.title': '审批位置',
  'settings.description': '「拒绝」与「允许一次」显示在哪里；另一处只显示请求内容。',
  'settings.progress': '进展面板',
  'settings.list': '对话列表',
  allowAlways: '始终允许',
} satisfies Record<string, string>

/** Approval dictionary key union. */
export type ApprovalKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  waiting: 'Waiting for approval',
  'detail.aria': 'Approval details',
  escalation: 'Tool {toolName} requests privileged execution',
  reject: 'Reject',
  allow: 'Allow',
  allowOnce: 'Allow once',
  'rejectFor': 'Reject for {title}',
  'allowOnceFor': 'Allow once for {title}',
  'hint.progress': 'Approve in Progress',
  'hint.list': 'Approve in the session list',
  'settings.title': 'Where approvals are answered',
  'settings.description': 'Reject and Allow once appear here; the other place keeps showing the request.',
  'settings.progress': 'Progress panel',
  'settings.list': 'Session list',
  allowAlways: 'Always allow',
} satisfies Record<ApprovalKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'waiting': '承認待ち',
  'detail.aria': '承認の詳細',
  'escalation': 'ツール {toolName} が特権実行を要求しています',
  'reject': '拒否',
  'allow': '許可',
  'allowOnce': '1 回だけ許可',
  'rejectFor': '却下：{title}',
  'allowOnceFor': '1 回だけ許可：{title}',
  'hint.progress': '進行パネルで承認',
  'hint.list': 'セッション一覧で承認',
  'settings.title': '承認の回答場所',
  'settings.description': '「却下」と「1 回だけ許可」をここに表示します。もう一方の場所では要求内容だけを表示します。',
  'settings.progress': '進行パネル',
  'settings.list': 'セッション一覧',
  'allowAlways': '常に許可',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  waiting: 'Esperando aprobación',
  'detail.aria': 'Detalles de aprobación',
  escalation: 'La herramienta {toolName} solicita ejecución privilegiada',
  reject: 'Rechazar',
  allow: 'Permitir',
  allowOnce: 'permitir una vez',
  rejectFor: 'Rechazar: {title}',
  allowOnceFor: 'Permitir una vez: {title}',
  'hint.progress': 'Aprobar en el panel de progreso',
  'hint.list': 'Aprobar en la lista de sesiones',
  'settings.title': 'Dónde se responden las aprobaciones',
  'settings.description': 'Rechazar y Permitir una vez aparecen aquí; el otro lugar sigue mostrando la solicitud.',
  'settings.progress': 'Panel de progreso',
  'settings.list': 'Lista de sesiones',
  allowAlways: 'Permitir siempre',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  waiting: "En attente d'approbation",
  'detail.aria': "Détails de l'approbation",
  escalation: "L'outil {toolName} demande une exécution privilégiée",
  reject: 'Rejeter',
  allow: 'Autoriser',
  allowOnce: 'Autoriser une fois',
  rejectFor: 'Rejeter : {title}',
  allowOnceFor: 'Autoriser une fois : {title}',
  'hint.progress': 'Approuver dans le panneau de progression',
  'hint.list': 'Approuver dans la liste des sessions',
  'settings.title': 'Où les approbations sont traitées',
  'settings.description': 'Rejeter et Autoriser une fois apparaissent ici ; l’autre emplacement continue d’afficher la demande.',
  'settings.progress': 'Panneau de progression',
  'settings.list': 'Liste des sessions',
  allowAlways: 'Toujours autoriser',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  waiting: 'Warten auf Genehmigung',
  'detail.aria': 'Einzelheiten zur Genehmigung',
  escalation: 'Tool {toolName} fordert privilegierte Ausführung an',
  reject: 'Ablehnen',
  allow: 'Erlauben',
  allowOnce: 'Einmal zulassen',
  rejectFor: 'Ablehnen: {title}',
  allowOnceFor: 'Einmal zulassen: {title}',
  'hint.progress': 'Im Fortschrittsbereich genehmigen',
  'hint.list': 'In der Sitzungsliste genehmigen',
  'settings.title': 'Wo Genehmigungen beantwortet werden',
  'settings.description': 'Ablehnen und Einmal zulassen erscheinen hier; die andere Stelle zeigt weiterhin die Anfrage.',
  'settings.progress': 'Fortschrittsbereich',
  'settings.list': 'Sitzungsliste',
  allowAlways: 'Immer zulassen',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  waiting: 'Ожидание одобрения',
  'detail.aria': 'Детали утверждения',
  escalation: 'Инструмент {toolName} запрашивает привилегированное выполнение',
  reject: 'Отклонить',
  allow: 'Разрешить',
  allowOnce: 'Разрешить один раз',
  rejectFor: 'Отклонить: {title}',
  allowOnceFor: 'Разрешить один раз: {title}',
  'hint.progress': 'Одобрить на панели прогресса',
  'hint.list': 'Одобрить в списке сессий',
  'settings.title': 'Где даётся ответ на утверждения',
  'settings.description': '«Отклонить» и «Разрешить один раз» появляются здесь; в другом месте запрос продолжает отображаться.',
  'settings.progress': 'Панель прогресса',
  'settings.list': 'Список сессий',
  allowAlways: 'Всегда разрешать',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  waiting: 'Aguardando aprovação',
  'detail.aria': 'Detalhes de aprovação',
  escalation: 'A ferramenta {toolName} solicita execução privilegiada',
  reject: 'Rejeitar',
  allow: 'Permitir',
  allowOnce: 'Permitir uma vez',
  rejectFor: 'Rejeitar: {title}',
  allowOnceFor: 'Permitir uma vez: {title}',
  'hint.progress': 'Aprovar no painel de progresso',
  'hint.list': 'Aprovar na lista de sessões',
  'settings.title': 'Onde as aprovações são respondidas',
  'settings.description': 'Rejeitar e Permitir uma vez aparecem aqui; o outro local continua exibindo a solicitação.',
  'settings.progress': 'Painel de progresso',
  'settings.list': 'Lista de sessões',
  allowAlways: 'Sempre permitir',
} satisfies Record<keyof typeof en, string>
