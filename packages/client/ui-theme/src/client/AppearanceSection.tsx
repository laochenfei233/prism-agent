/**
 * The Appearance settings section: the theme gallery, the custom theme
 * controls, and the font settings, all fed by the one section store mirror of
 * the theme snapshot.
 */
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { CustomThemeInputs, FontRole } from '../theme-settings.ts'
import type { createAppearanceSectionStore } from './settings-store.ts'
import { AppearanceRow } from './AppearanceRow.tsx'
import { CustomThemeGroup } from './CustomThemeGroup.tsx'
import { FontSettingsGroup } from './FontSettingsGroup.tsx'
import css from './AppearanceSection.module.css'

/** Injected business face: every write the section's groups offer. */
export interface AppearanceSectionInjected {
  /** Switch the theme preference; accepts any registered theme id, `system`, or `custom`. */
  setTheme: (id: string) => void
  /** Change the custom theme inputs; the service switches the preference to `custom`. */
  setCustom: (patch: Partial<CustomThemeInputs>) => void
  /** Change one role's font size (integer px within its FONT_SIZE_SPECS range). */
  setFontSize: (role: FontRole, px: number) => void
  /** Change one role's font list (normalized by the theme service). */
  setFontFamily: (role: FontRole, value: string) => void
}

/** Full component props: section runtime share + store share + locale seat + injected face. */
export type AppearanceSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsStore<ReturnType<typeof createAppearanceSectionStore>>
  & PropsLocale<'settings.theme'> & AppearanceSectionInjected

/**
 * Render the Appearance section content column.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function AppearanceSection(props: AppearanceSectionComponentProps) {
  const { t, useStore, actions, setTheme, setCustom, setFontSize, setFontFamily } = props
  return (
    <div className={css.section}>
      <AppearanceRow t={t} useStore={useStore} actions={actions} setTheme={setTheme} />
      <CustomThemeGroup t={t} useStore={useStore} actions={actions} setCustom={setCustom} />
      <FontSettingsGroup t={t} useStore={useStore} actions={actions} setFontSize={setFontSize} setFontFamily={setFontFamily} />
    </div>
  )
}
