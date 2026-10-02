/** `settings.theme` namespace dictionaries (the theme gallery and font-size rows' copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'appearance.title': '主题',
  'appearance.system': '跟随系统',
  'appearance.light': '浅色',
  'appearance.dark': '深色',
  'appearance.graphGlass': '方格纸玻璃卡',
  'appearance.monoAccent': '单强调色',
  'appearance.strataDark': '暗底明度分层',
  'fontSize.title': '字号大小',
  'fontSize.description': '仅影响会话内容的字号',
  'fontSize.unit': 'px',
  'fontSize.increase': '增大字号',
  'fontSize.decrease': '减小字号',
} satisfies Record<string, string>

/** The settings.theme namespace key union. */
export type ThemeKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'appearance.title': 'Theme',
  'appearance.system': 'System',
  'appearance.light': 'Light',
  'appearance.dark': 'Dark',
  'appearance.graphGlass': 'Graph Paper Glass',
  'appearance.monoAccent': 'Single Accent',
  'appearance.strataDark': 'Lightness Strata',
  'fontSize.title': 'Font size',
  'fontSize.description': 'Only affects conversation content',
  'fontSize.unit': 'px',
  'fontSize.increase': 'Increase font size',
  'fontSize.decrease': 'Decrease font size',
} satisfies Record<ThemeKey, string>

/**
 * Display-copy key per selectable preference id. Ids absent from this map are
 * registered by other packages and render as their own id.
 */
export const THEME_LABEL_KEYS: Readonly<Record<string, ThemeKey>> = {
  system: 'appearance.system',
  light: 'appearance.light',
  dark: 'appearance.dark',
  'graph-glass': 'appearance.graphGlass',
  'mono-accent': 'appearance.monoAccent',
  'strata-dark': 'appearance.strataDark',
}
