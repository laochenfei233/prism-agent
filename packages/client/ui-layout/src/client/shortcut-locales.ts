/** Layout command labels. */
export const zh = { toggle: '展开／收起左侧栏', 'focus.cycle': '聚焦下一个区域', 'focus.reverse': '聚焦上一个区域', 'focus.none': '当前没有可聚焦的区域' }
/** English labels for the same layout commands. */
export const en: Record<keyof typeof zh, string> = {
  toggle: 'Toggle left sidebar', 'focus.cycle': 'Focus next region', 'focus.reverse': 'Focus previous region',
  'focus.none': 'No region can take focus',
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'toggle': '左サイドバーを切り替え',
  'focus.cycle': '次の領域へフォーカス',
  'focus.reverse': '前の領域へフォーカス',
  'focus.none': 'フォーカスできる領域がありません',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  toggle: 'Alternar barra lateral izquierda',
  'focus.cycle': 'Enfocar la siguiente región',
  'focus.reverse': 'Enfocar la región anterior',
  'focus.none': 'No hay ninguna región que pueda recibir el foco',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  toggle: 'Basculer la barre latérale gauche',
  'focus.cycle': 'Focus sur la région suivante',
  'focus.reverse': 'Focus sur la région précédente',
  'focus.none': 'Aucune région ne peut recevoir le focus',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  toggle: 'Linke Seitenleiste umschalten',
  'focus.cycle': 'Zum nächsten Bereich springen',
  'focus.reverse': 'Zum vorherigen Bereich springen',
  'focus.none': 'Es gibt keinen fokussierbaren Bereich',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  toggle: 'Переключить левую боковую панель',
  'focus.cycle': 'Фокус на следующую область',
  'focus.reverse': 'Фокус на предыдущую область',
  'focus.none': 'Нет области, которая может принять фокус',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  toggle: 'Alternar barra lateral esquerda',
  'focus.cycle': 'Focar a próxima região',
  'focus.reverse': 'Focar a região anterior',
  'focus.none': 'Não há região que possa receber o foco',
} satisfies Record<keyof typeof en, string>
