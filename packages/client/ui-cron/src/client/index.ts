/**
 * Scheduled-task plugin, browser half: contributes one Session-header action
 * that renders the deployment's scheduled tasks and the commands a human
 * issues against them. Rows, the follow stream, and every mutation go through
 * the `cronJobs` client service; this plugin holds no transport state.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { CronJobId } from '@deepseek-ai/dsh-api-cron-controller/client'
import { CronPanel } from './CronPanel.tsx'
import type { CronPanelInjected } from './CronPanel.tsx'
import type { CronDraftRequest } from './logic.ts'
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ui-conversation SlotMap merge for the header-actions seat.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import { en, NS, zh, type CronPanelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Scheduled-task panel copy. */
    'cron.panel': CronPanelKey
  }
}

export type { CronPanelInjected, CronPanelProps, CronPanelSource } from './CronPanel.tsx'
export type { CronDraft, CronDraftRequest, CronRunSummary } from './logic.ts'

/** Required services: the scheduled-task rows and commands, the slot registry, and dictionaries. */
export const inject = ['cronJobs', 'slots', 'locale']

/**
 * Client plugin body: register the dictionaries and the header action.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-cron: dictionaries')
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'cron-panel',
      // Scheduled work follows static Session identity and background jobs.
      order: 30,
      locale: NS,
      inject: (): CronPanelInjected => ({
        hooks: { cron: ctx.cronJobs.state },
        // Every command reports the Host's stable reason as a line the panel
        // shows in place, so a refusal never has to reach the renderer as a throw.
        create: async request => reasonOf(() => ctx.cronJobs.create(createRequest(request))),
        update: async request => reasonOf(() => ctx.cronJobs.update(updateRequest(request))),
        setEnabled: async (jobId: CronJobId, enabled: boolean) => reasonOf(() => ctx.cronJobs.setEnabled(jobId, enabled)),
        remove: async (jobId: CronJobId) => reasonOf(() => ctx.cronJobs.remove(jobId)),
        runNow: async (jobId: CronJobId) => reasonOf(() => ctx.cronJobs.runNow(jobId)),
      }),
    }, CronPanel),
  )
}

function createRequest(request: CronDraftRequest): Parameters<ClientContext['cronJobs']['create']>[0] {
  return {
    expression: request.expression,
    timeZone: request.timeZone,
    target: request.target,
    prompt: request.prompt,
    overlapPolicy: request.overlapPolicy,
    misfirePolicy: request.misfirePolicy,
    ...request.maxRunMs === undefined ? {} : { maxRunMs: request.maxRunMs },
  }
}

function updateRequest(request: CronDraftRequest & { readonly jobId: CronJobId }): Parameters<ClientContext['cronJobs']['update']>[0] {
  return { ...createRequest(request), jobId: request.jobId }
}

/**
 * Run one command and reduce its refusal to the line the panel shows.
 * @param command - the service call to attempt.
 * @returns `null` when the command succeeded, otherwise its stable reason.
 */
async function reasonOf(command: () => Promise<unknown>): Promise<string | null> {
  try {
    await command()
    return null
  } catch (error: unknown) {
    // A refusal is read field by field off the caught value, because a caught
    // error is untyped here and this package may not value-import the service's
    // error class (a feature plugin collaborates through Cordis services). The
    // service rejects only with a failure carrying both fields, so a value
    // without them is a defect this surface must not swallow into a rendered
    // line.
    const rpcError = (error as { rpcError?: { readonly code: string; readonly message: string } }).rpcError
    if (rpcError === undefined) throw error
    return `${rpcError.message} (${rpcError.code})`
  }
}
