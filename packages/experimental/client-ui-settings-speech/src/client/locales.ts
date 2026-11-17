/** Speech settings copy, zh and en; zh is the key-set source of truth. */

/** zh dictionary. */
export const zh = {
  /** Settings navigation label. */
  nav: '语音识别',
  /** Page title. */
  title: '语音识别',
  /** One-paragraph page introduction. */
  intro: '管理转写服务与默认识别器。服务列表来自语音 HTTP 插件的配置；密钥保存在凭据库，不写入配置文件。',
  /** Default-recognizer switcher label. */
  defaultRecognizer: '默认识别器',
  /** Heading over the configured service list. */
  services: '转写服务',
  /** Add-service button. */
  add: '添加服务',
  /** Save-card button. */
  save: '保存',
  /** Remove-service button. */
  remove: '删除',
  /** Confirm text of the remove action. */
  removeConfirm: '删除这条转写服务？',
  /** Label of the display-name field. */
  name: '名称',
  /** Label of the registration-id field. */
  providerId: '识别器 ID',
  /** Label of the request-form field. */
  mode: '请求形态',
  /** Label of the endpoint field. */
  endpoint: '端点',
  /** Label of the model field. */
  model: '模型',
  /** Label of the credential-reference field. */
  apiKeyEnv: '密钥引用',
  /** Key state when the reference resolves. */
  keyConfigured: '密钥已配置',
  /** Key state when the reference resolves to nothing. */
  keyMissing: '密钥未配置',
  /** New-key input placeholder. */
  keyPlaceholder: '粘贴 API 密钥',
  /** Set-key button. */
  keySet: '设置密钥',
  /** Remove-key button. */
  keyRemove: '移除密钥',
  /** Hint under the credential row. */
  keyHint: '密钥按引用名存入凭据库；识别器在每次请求时解析它。',
  /** Toast for one saved card. */
  saved: '已保存',
  /** Toast for one refused write. */
  writeFailed: '保存失败',
  /** Hint when the speech remote is not served by this deployment. */
  rosterUnavailable: '此部署未启用语音注册表，默认识别器跟随会议页选择。',
  /** Toast for one changed default recognizer. */
  selected: '已切换默认识别器',
}

/** en dictionary, keyed exactly as zh. */
export const en: typeof zh = {
  nav: 'Speech recognition',
  title: 'Speech recognition',
  intro: 'Manage transcription services and the default recognizer. The service list comes from the speech HTTP plugin configuration; keys live in the credential store, never in configuration files.',
  defaultRecognizer: 'Default recognizer',
  services: 'Transcription services',
  add: 'Add service',
  save: 'Save',
  remove: 'Delete',
  removeConfirm: 'Delete this transcription service?',
  name: 'Name',
  providerId: 'Recognizer ID',
  mode: 'Request form',
  endpoint: 'Endpoint',
  model: 'Model',
  apiKeyEnv: 'Credential reference',
  keyConfigured: 'Key configured',
  keyMissing: 'Key missing',
  keyPlaceholder: 'Paste an API key',
  keySet: 'Set key',
  keyRemove: 'Remove key',
  keyHint: 'Keys are stored under the reference name in the credential store; the recognizer resolves it per request.',
  saved: 'Saved',
  writeFailed: 'Save failed',
  rosterUnavailable: 'This deployment serves no speech registry; the default recognizer follows the meeting page selection.',
  selected: 'Default recognizer switched',
}

/** Keys of the speech settings dictionary. */
export type SpeechLocaleKey = keyof typeof zh
