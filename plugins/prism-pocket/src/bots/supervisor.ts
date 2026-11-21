/**
 * The bot supervisor: one adapter handle per enabled channel, restarted on
 * config change, with every status transition observed by the routes.
 *
 * @module @prism/prism-pocket/bots
 */

import type { BotAdapterFactory, BotAdapterHooks, BotChannelId, BotConfig, BotHandle, BotInbound, BotStatus } from './types.ts'
import { BOT_ADAPTERS } from './adapters/index.ts'

/** What the supervisor reports upward. */
export interface BotSupervisorHooks {
  /** An inbound chat message arrived on one channel. */
  onInbound(channel: BotChannelId, message: BotInbound): void
  /** One channel's status changed. */
  onStatus(channel: BotChannelId, status: BotStatus, detail?: string): void
}

/** The recorded state of one channel. */
export interface BotChannelState {
  readonly status: BotStatus
  readonly detail?: string
}

/** The supervisor: owns every running adapter handle. */
export class BotSupervisor {
  private readonly handles = new Map<BotChannelId, BotHandle>()
  private readonly states = new Map<BotChannelId, BotChannelState>()
  private readonly starts = new Map<BotChannelId, Promise<void>>()

  /**
   * @param hooks - the upward hooks.
   * @param adapters - adapter factories, overridable for tests.
   */
  constructor(
    private readonly hooks: BotSupervisorHooks,
    private readonly adapters: Readonly<Record<BotChannelId, BotAdapterFactory>> = BOT_ADAPTERS,
  ) {}

  /** The recorded state of one channel. */
  state(channel: BotChannelId): BotChannelState {
    return this.states.get(channel) ?? { status: 'off' }
  }

  /** The running handle of one channel, when started. */
  handle(channel: BotChannelId): BotHandle | undefined {
    return this.handles.get(channel)
  }

  /**
   * Start (or restart after a config change) one channel; concurrent starts
   * on one channel run in submission order, so no handle is orphaned.
   * @param channel - the channel to start.
   * @param config - the channel's validated config.
   */
  async start(channel: BotChannelId, config: BotConfig): Promise<void> {
    const previous = this.starts.get(channel) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(async () => {
      await this.stop(channel)
      this.record(channel, 'starting')
      const handle = this.adapters[channel](config.fields, this.adapterHooks(channel))
      this.handles.set(channel, handle)
      try {
        await handle.start()
      } catch (cause: unknown) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        this.record(channel, 'error', detail)
        this.handles.delete(channel)
        // A failed start is a state, not a throw: the page shows the detail.
        return
      }
      if (this.handles.get(channel) === handle) this.record(channel, 'online')
    })
    this.starts.set(channel, current)
    try {
      await current
    } finally {
      if (this.starts.get(channel) === current) this.starts.delete(channel)
    }
  }

  /**
   * Stop one channel.
   * @param channel - the channel to stop.
   */
  async stop(channel: BotChannelId): Promise<void> {
    const handle = this.handles.get(channel)
    if (handle === undefined) {
      if (this.state(channel).status !== 'off') this.record(channel, 'off')
      return
    }
    this.handles.delete(channel)
    try {
      await handle.stop()
    } catch (cause: unknown) {
      // A broken stop must not block the switch; the state already moved on.
      this.hooks.onStatus(channel, 'off', cause instanceof Error ? cause.message : String(cause))
    }
    if (this.handles.get(channel) === undefined) this.record(channel, 'off')
  }

  /** Stop every channel; disposal-time. */
  async dispose(): Promise<void> {
    for (const channel of [...this.handles.keys()]) {
      await this.stop(channel)
    }
  }

  private record(channel: BotChannelId, status: BotStatus, detail?: string): void {
    const previous = this.states.get(channel)
    const next: BotChannelState = { status, ...(detail !== undefined ? { detail } : {}) }
    this.states.set(channel, next)
    if (previous?.status !== status || previous?.detail !== detail) {
      this.hooks.onStatus(channel, status, detail)
    }
  }

  private adapterHooks(channel: BotChannelId): BotAdapterHooks {
    return {
      onInbound: message => { this.hooks.onInbound(channel, message) },
      onStatus: (status, detail) => {
        // A live adapter reporting a failure stays recorded even though start() resolved.
        if (this.handles.get(channel) !== undefined || status === 'off') this.record(channel, status, detail)
      },
    }
  }
}
