import { BrandWordmark, PrismBadgeLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Props of the official brand-name occupant: the brand locale seat and nothing else. */
export type OfficialBrandNameProps = PropsLocale<'brand'>

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the Prism mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <PrismBadgeLogo size={size} />
}

/**
 * Render the official name artwork without its independently slotted mark.
 * @param props - Slot props carrying the brand locale seat.
 * @returns the official name wordmark.
 */
export function OfficialBrandName({ t }: OfficialBrandNameProps) {
  return <BrandWordmark name={t('name')} includeMark={false} />
}
