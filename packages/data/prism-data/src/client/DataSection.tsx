/**
 * The 数据 settings section: one page title, three tabs, and the feature-owned
 * pages behind them. The storage tab is owned here; backup, archive transfer,
 * and cross-agent import register their pages into `settings.data.page`.
 */

import { useEffect, useId, useState, type ReactNode } from 'react'
import { SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { StoragePage } from './StoragePage.tsx'
import css from './DataSection.module.css'

/** Registration-side business face for the section. */
export interface DataSectionInjected {
  /**
   * Ask the operator for one directory.
   * @param signal - optional cancellation.
   * @returns the absolute directory, or `null` on cancel.
   */
  readonly pickDirectory: (signal?: AbortSignal) => Promise<string | null>
}

/** Props the renderer binds for the section. */
export type DataSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.data'>
  & PropsRenderSlots<'settings.data.page'>
  & InjectFace<DataSectionInjected>

/** Tabs in render order; the ids are the contribution ids they host. */
const TAB_IDS = ['storage', 'backup', 'transfer'] as const

/** One tab of the section. */
type TabId = (typeof TAB_IDS)[number]

/** Slot contribution ids rendered inside each tab. */
const PAGE_IDS: Readonly<Record<TabId, readonly string[]>> = {
  storage: [],
  backup: ['backup'],
  transfer: ['transfer', 'cross-agent'],
}

/**
 * Render the data settings page.
 * @param props - localized copy, the section runtime, child slots, and services.
 * @returns the title and the three tab panels.
 */
export function DataSection({ t, renderSlot, pickDirectory }: DataSectionProps): ReactNode {
  const tabsId = useId()
  const [active, setActive] = useState<TabId>('storage')
  const [visited, setVisited] = useState<ReadonlySet<TabId>>(() => new Set(['storage']))

  // A tab mounts when first selected and then stays mounted while hidden, so a
  // staged backup form, a transfer preview, or a scanned import source survives
  // switching between the three views.
  useEffect(() => {
    setVisited((previous) => {
      if (previous.has(active)) return previous
      return new Set([...previous, active])
    })
  }, [active])

  const label = (tab: TabId): string => {
    switch (tab) {
      case 'storage': return t('tabStorage')
      case 'backup': return t('tabBackup')
      case 'transfer': return t('tabTransfer')
    }
  }

  return <section className={css.section}>
    <h2 className={css.title}>{t('title')}</h2>
    <p className={css.intro}>{t('intro')}</p>
    <SegmentedTabs<TabId>
      className={css.tabs}
      label={t('tabsLabel')}
      value={active}
      onChange={setActive}
      items={[
        { value: 'storage', label: label('storage'), id: `${tabsId}-storage`, panelId: `${tabsId}-storage-panel` },
        { value: 'backup', label: label('backup'), id: `${tabsId}-backup`, panelId: `${tabsId}-backup-panel` },
        { value: 'transfer', label: label('transfer'), id: `${tabsId}-transfer`, panelId: `${tabsId}-transfer-panel` },
      ]}
    />
    {TAB_IDS.filter(tab => visited.has(tab)).map(tab => (
      <div
        key={tab}
        id={`${tabsId}-${tab}-panel`}
        className={css.panel}
        role="tabpanel"
        aria-labelledby={`${tabsId}-${tab}`}
        hidden={tab !== active}
      >
        {tab === 'storage' ? <StoragePage t={t} pick={pickDirectory} /> : null}
        {PAGE_IDS[tab].map(id => (
          <div key={id} className={css.page}>{renderSlot('settings.data.page', {}, { only: id })}</div>
        ))}
      </div>
    ))}
  </section>
}
