/**
 * The backup page's browser half: one `settings.data.page` entry rendered by
 * {@link BackupSection} inside the 数据 settings page's 备份 tab. The page
 * edits the `prism-backup` settings namespace through the shared configuration
 * forms, drives the run and test calls over the plugin's POST route, and
 * manages passwords through the credential surface. It owns no page chrome and
 * supplies all of its own copy.
 */

// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the ctx.configForms merge and the 数据 section's `settings.data.page` SlotMap entry.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the ctx.remote merge and the forwarded-event key face for credentials.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@prism/prism-data/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { BackupSection } from './BackupSection.tsx'
import { BACKUP_ENTRY_ID, createBackupSection, type BackupSectionFace, type BackupSettings } from './page-controller.ts'
import { en, zh, type BackupLocaleKey } from './locales.ts'

export type { BackupSectionProps } from './BackupSection.tsx'
export type {
  BackupFieldDraft, BackupFormState, BackupRunState, BackupSectionFace, BackupSettings, PageSecrets,
} from './page-controller.ts'
export type { BackupLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Backup settings page copy. */
    'settings.backup': BackupLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'settings.backup'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.credentials']

/**
 * Build the face the section's slot entry injects.
 * @param ctx - the browser plugin context.
 * @returns the staged form, run state, and the page's actions.
 */
export function createBackupFace(ctx: ClientContext): BackupSectionFace {
  return createBackupSection(ctx, ctx.configForms.get<BackupSettings>(BACKUP_ENTRY_ID))
}

/**
 * Register the backup page inside the 数据 settings section.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'prism-backup: dictionaries')
  const face = createBackupFace(ctx)
  ctx.effect(() => ctx.slots.inject('settings.data.page', () => ctx.slots.register({
    name: 'settings.data.page',
    id: 'backup',
    locale: NS,
    inject: () => face,
  }, BackupSection)), 'prism-backup: settings page')
}
