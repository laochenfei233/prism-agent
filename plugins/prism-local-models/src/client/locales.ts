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
  | 'path'
  | 'kind.ocr'
  | 'kind.translation'
  | 'kind.embedding'
  | 'device.cuda'
  | 'status.idle'
  | 'status.downloading'
  | 'status.provisioning'
  | 'status.ready'
  | 'status.error'
  | 'action.install'
  | 'action.cancel'
  | 'action.remove'
  | 'action.probe'
  | 'probe.running'
  | 'probe.ok'
  | 'probe.fail'
  | 'remove.confirm'
  | 'load.error'
  | 'note.ocr'

/** English copy. */
export const en: Record<LocalModelsLocaleKey, string> = {
  title: 'Local models',
  path: 'Models directory',
  'kind.ocr': 'OCR',
  'kind.translation': 'Translation',
  'kind.embedding': 'Embedding',
  'device.cuda': 'CUDA',
  'status.idle': 'Not installed',
  'status.downloading': 'Downloading',
  'status.provisioning': 'Setting up',
  'status.ready': 'Ready',
  'status.error': 'Failed',
  'action.install': 'Install',
  'action.cancel': 'Cancel',
  'action.remove': 'Remove',
  'action.probe': 'Test',
  'probe.running': 'Test running',
  'probe.ok': 'Test passed: {detail}',
  'probe.fail': 'Test failed: {error}',
  'remove.confirm': 'Remove the installed model files from the models directory?',
  'load.error': 'The local-model service did not answer: {error}',
  'note.ocr': 'RapidOCR is the default OCR engine; PaddleOCR requires a Python environment.',
}

/** Chinese copy. */
export const zh: Record<LocalModelsLocaleKey, string> = {
  title: '本地模型',
  path: '模型目录',
  'kind.ocr': 'OCR',
  'kind.translation': '翻译',
  'kind.embedding': '向量',
  'device.cuda': 'CUDA',
  'status.idle': '未安装',
  'status.downloading': '下载中',
  'status.provisioning': '配置中',
  'status.ready': '已就绪',
  'status.error': '失败',
  'action.install': '安装',
  'action.cancel': '取消',
  'action.remove': '删除',
  'action.probe': '检测',
  'probe.running': '检测中',
  'probe.ok': '检测通过：{detail}',
  'probe.fail': '检测失败：{error}',
  'remove.confirm': '从模型目录删除已安装的模型文件？',
  'load.error': '本地模型服务未响应：{error}',
  'note.ocr': 'RapidOCR 为默认 OCR 引擎；PaddleOCR 需要 Python 环境。',
}
