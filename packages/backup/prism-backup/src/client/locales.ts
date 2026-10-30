/**
 * Backup settings copy. Chinese is the key-set source of truth and English
 * mirrors it, so a missing translation fails the type check rather than the
 * i18n gate.
 * @module @prism/prism-backup/client/locales
 */

/** Every user-visible string the backup page renders. */
export const zh = {
  nav: '备份',
  title: '备份',
  lead: '把配置、记忆和项目文件夹打包复制到你自己的服务器。',
  warning: '备份包内含 Harness 主目录下的 .env 与 .credentials.yaml。请只备份到你信任的服务器。',

  destination: '备份目标',
  protocol: '协议',
  targetWebdav: 'WebDAV',
  targetS3: 'S3',
  targetSmb: 'SMB',
  webdavUrl: 'WebDAV 地址',
  webdavUrlHint: '含服务器 WebDAV 路径的完整地址，例如 https://example.com/dav。',
  s3Endpoint: 'S3 端点',
  s3EndpointHint: '留空表示使用所选区域的 AWS 端点；MinIO 等自建服务请填写完整地址。',
  s3Region: '区域',
  s3Bucket: '存储桶',
  s3PathStyle: '使用 path-style 寻址',
  s3PathStyleHint: 'MinIO 与多数自建 S3 服务需要开启。',
  s3AccessKeyId: 'Access Key ID',
  s3SecretKey: 'Secret Access Key',
  smbPath: 'SMB 路径',
  smbPathHint: '例如 \\\\server\\share\\backup，或已映射的盘符目录。',
  username: '用户名',
  usernameHint: 'WebDAV 与 SMB 使用；S3 忽略此项。',
  webdavPassword: 'WebDAV 密码',
  smbPassword: 'SMB 密码',
  passwordHint: '密码保存在本机凭据文件里，不写入配置。SMB 留空时使用系统已连接的会话。',
  secretStored: '已保存',
  secretMissing: '未保存',
  secretClear: '清除',
  remoteDir: '远程目录',
  remoteDirHint: '归档写在该目标下的这个目录里。',

  content: '备份内容',
  includeSettings: '配置',
  includeSettingsHint: 'profile 与主目录的 cordis.patch.yml、.env、.credentials.yaml。',
  includeMemory: '记忆',
  includeMemoryHint: '长期记忆存储里的全部记录。',
  includeProjects: '项目文件夹',
  includeProjectsHint: '工作区注册表，以及每个已注册项目文件夹里的文件。',
  excludes: '排除的目录名',
  excludesHint: '每行一个目录名；遍历项目文件夹时跳过这些目录。',
  maxBackups: '保留份数',
  maxBackupsHint: '每次成功后只保留最新的这么多份；填 0 表示全部保留。',

  actions: '操作',
  test: '测试连接',
  testing: '正在测试…',
  testOk: '连接正常。',
  run: '立即备份',
  running: '正在备份…',
  runOk: '备份完成。',
  runFailed: '备份失败。',
  saveFailed: '这项设置没有保存成功，请重试。',
  unreachable: '无法连接本机的备份服务。',
  httpStatus: 'HTTP {status}',
  save: '保存',
  saving: '正在保存…',
  unavailable: '当前部署没有提供备份设置。',
  readOnly: '这个部署的配置是只读的。',
  overridden: '已修改',
  reset: '恢复默认',
  invalidNumber: '请填写一个非负整数。',

  history: '备份历史',
  historyEmpty: '还没有备份记录。',
  historySuccess: '成功',
  historyFailed: '失败',
  historyTarget: '目标',
  historySize: '大小',
} satisfies Record<string, string>

/** English mirror of {@link zh}. */
export const en: Record<keyof typeof zh, string> = {
  nav: 'Backup',
  title: 'Backup',
  lead: 'Copy your configuration, memory, and project folders to a server you control.',
  warning: 'The archive contains .env and .credentials.yaml from your Harness home. Back up only to a server you trust.',

  destination: 'Destination',
  protocol: 'Protocol',
  targetWebdav: 'WebDAV',
  targetS3: 'S3',
  targetSmb: 'SMB',
  webdavUrl: 'WebDAV URL',
  webdavUrlHint: 'The full address including the server\'s WebDAV path, such as https://example.com/dav.',
  s3Endpoint: 'S3 endpoint',
  s3EndpointHint: 'Leave empty for the AWS endpoint of the selected region; self-hosted services such as MinIO need their own address.',
  s3Region: 'Region',
  s3Bucket: 'Bucket',
  s3PathStyle: 'Use path-style addressing',
  s3PathStyleHint: 'Required by MinIO and most self-hosted S3 services.',
  s3AccessKeyId: 'Access key id',
  s3SecretKey: 'Secret access key',
  smbPath: 'SMB path',
  smbPathHint: 'For example \\\\server\\share\\backup, or a mapped drive directory.',
  username: 'User name',
  usernameHint: 'Used by WebDAV and SMB; S3 ignores it.',
  webdavPassword: 'WebDAV password',
  smbPassword: 'SMB password',
  passwordHint: 'Passwords live in this machine\'s credential file, never in the configuration. An empty SMB password uses the session Windows already opened.',
  secretStored: 'Stored',
  secretMissing: 'Not stored',
  secretClear: 'Clear',
  remoteDir: 'Remote directory',
  remoteDirHint: 'Archives are written to this directory below the target.',

  content: 'What to back up',
  includeSettings: 'Configuration',
  includeSettingsHint: 'The profile and home cordis.patch.yml, .env, and .credentials.yaml.',
  includeMemory: 'Memory',
  includeMemoryHint: 'Every record in the long-term memory store.',
  includeProjects: 'Project folders',
  includeProjectsHint: 'The workspace registry and the files inside every registered project folder.',
  excludes: 'Excluded directory names',
  excludesHint: 'One directory name per line; project folder walks skip them.',
  maxBackups: 'Archives kept',
  maxBackupsHint: 'After each successful run only the newest this many remain; 0 keeps every archive.',

  actions: 'Actions',
  test: 'Test connection',
  testing: 'Testing…',
  testOk: 'Connection works.',
  run: 'Back up now',
  running: 'Backing up…',
  runOk: 'Backup finished.',
  runFailed: 'Backup failed.',
  saveFailed: 'That setting did not save. Try again.',
  unreachable: 'The backup service on this machine is unreachable.',
  httpStatus: 'HTTP {status}',
  save: 'Save',
  saving: 'Saving…',
  unavailable: 'This deployment serves no backup settings.',
  readOnly: 'This deployment stores configuration read-only.',
  overridden: 'Changed',
  reset: 'Reset',
  invalidNumber: 'Enter a whole number of zero or more.',

  history: 'Backup history',
  historyEmpty: 'No backups yet.',
  historySuccess: 'Succeeded',
  historyFailed: 'Failed',
  historyTarget: 'Target',
  historySize: 'Size',
}

/**
 * Render the HTTP status fallback the page shows when the service answers
 * without a JSON envelope.
 * @param status - the numeric status.
 * @returns the localized sentence.
 */
export function httpStatusText(status: number): string {
  return zh.httpStatus.replace('{status}', String(status))
}

/** Key set of the backup page dictionaries. */
export type BackupLocaleKey = keyof typeof zh
