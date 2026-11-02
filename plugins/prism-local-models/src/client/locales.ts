/**
 * Local-models card copy. The plugin owns its namespace.
 *
 * @module @prism/prism-local-models/client/locales
 */

/** Dictionary namespace owned by this plugin. */
export const NS = 'prism-local-models.card'

/** Every key the plugin's dictionaries define. */
export type LocalModelsLocaleKey =
  | 'title'
  | 'intro'
  | 'path'
  | 'variant.label'
  | 'progress.label'
  | 'kind.ocr'
  | 'kind.translation'
  | 'kind.embedding'
  | 'device.cuda'
  | 'variant.provisioned'
  | 'status.idle'
  | 'status.downloading'
  | 'status.provisioning'
  | 'status.ready'
  | 'status.error'
  | 'action.install'
  | 'action.cancel'
  | 'action.remove'
  | 'action.probe'
  | 'action.close'
  | 'action.failed'
  | 'probe.running'
  | 'probe.ok'
  | 'probe.fail'
  | 'remove.title'
  | 'remove.confirm'
  | 'load.error'
  | 'note.ocr'

/** English copy. */
export const en: Record<LocalModelsLocaleKey, string> = {
  title: 'Local models',
  intro: 'These models serve Prism\'s own OCR, translation, and embeddings, not chat.',
  path: 'Models directory',
  'variant.label': 'Version of {model}',
  'progress.label': '{model} download progress',
  'kind.ocr': 'OCR',
  'kind.translation': 'Translation',
  'kind.embedding': 'Embedding',
  'device.cuda': 'CUDA',
  'variant.provisioned': 'runtime provisioned',
  'status.idle': 'Not installed',
  'status.downloading': 'Downloading',
  'status.provisioning': 'Setting up',
  'status.ready': 'Ready',
  'status.error': 'Failed',
  'action.install': 'Install',
  'action.cancel': 'Cancel',
  'action.remove': 'Remove',
  'action.probe': 'Test',
  'action.close': 'Close',
  'action.failed': 'Could not finish {model}: {error}',
  'probe.running': 'Testing',
  'probe.ok': 'Test passed: {detail}',
  'probe.fail': 'Test failed: {error}',
  'remove.title': 'Remove {model}?',
  'remove.confirm': 'Remove the installed model files from the models directory?',
  'load.error': 'The local-model service did not answer: {error}',
  'note.ocr': 'RapidOCR is the default OCR engine; PaddleOCR requires a Python environment.',
}

/** Chinese copy. */
export const zh: Record<LocalModelsLocaleKey, string> = {
  title: '本地模型',
  intro: 'Prism 自用的 OCR、翻译与向量模型，不属于对话模型。',
  path: '模型目录',
  'variant.label': '{model} 的版本',
  'progress.label': '{model} 下载进度',
  'kind.ocr': 'OCR',
  'kind.translation': '翻译',
  'kind.embedding': '向量',
  'device.cuda': 'CUDA',
  'variant.provisioned': '供给运行时',
  'status.idle': '未安装',
  'status.downloading': '下载中',
  'status.provisioning': '配置中',
  'status.ready': '已就绪',
  'status.error': '失败',
  'action.install': '安装',
  'action.cancel': '取消',
  'action.remove': '删除',
  'action.probe': '检测',
  'action.close': '关闭',
  'action.failed': '{model} 操作失败：{error}',
  'probe.running': '检测中',
  'probe.ok': '检测通过：{detail}',
  'probe.fail': '检测失败：{error}',
  'remove.title': '删除 {model}？',
  'remove.confirm': '从模型目录删除已安装的模型文件？',
  'load.error': '本地模型服务未响应：{error}',
  'note.ocr': 'RapidOCR 为默认 OCR 引擎；PaddleOCR 需要 Python 环境。',
}
