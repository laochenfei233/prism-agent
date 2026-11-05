/**
 * Bot credential and binding persistence: one JSON body beside the VAPID
 * keys, rewritten atomically on every change with owner-only permissions.
 * Reads never trust the file; entries that no longer validate are dropped.
 *
 * @module @prism/prism-pocket/bots
 */

import { randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { BotChannelId, BotConfig, BotEntry, BotStoreBody } from './types.ts'
import { BOT_CHANNELS } from './types.ts'
import { reviveBotConfig } from './validate.ts'
import { timingSafeStringEquals } from './shared/sign.ts'

/** The unambiguous pairing-code alphabet: no 0/O/1/l/I. */
const PAIRING_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'

/** Pairing-code length: eight symbols over thirty-one keep casual guessing infeasible. */
const PAIRING_CODE_LENGTH = 8

/** Generate one pairing code from crypto randomness. */
function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH)
  let code = ''
  for (const byte of bytes) code += PAIRING_ALPHABET[byte % PAIRING_ALPHABET.length]
  return code
}

/** Read a store body without trusting it; corrupt or missing yields empty. */
function readBody(file: string): BotStoreBody {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return { version: 1, bots: {} }
    const root = parsed as { version?: unknown; bots?: unknown; pairingCode?: unknown }
    if (typeof root.bots !== 'object' || root.bots === null) return { version: 1, bots: {} }
    const bots: Partial<Record<BotChannelId, BotEntry>> = {}
    for (const [channel, entry] of Object.entries(root.bots as Record<string, unknown>)) {
      const revived = reviveEntry(entry)
      if (revived !== undefined) bots[channel as BotChannelId] = revived
    }
    return {
      version: 1,
      bots,
      ...(typeof root.pairingCode === 'string' && root.pairingCode.length > 0 ? { pairingCode: root.pairingCode } : {}),
    }
  } catch {
    return { version: 1, bots: {} }
  }
}

/** Re-validate one persisted entry; enabled defaults false, binding survives only with a config. */
function reviveEntry(value: unknown): BotEntry | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const candidate = value as { config?: unknown; enabled?: unknown; sessionId?: unknown; chatId?: unknown; senderId?: unknown }
  if (typeof candidate.config !== 'object' || candidate.config === null) return undefined
  const config = candidate.config as { channel?: unknown; fields?: unknown }
  if (typeof config.channel !== 'string') return undefined
  const validated = reviveBotConfig(config.channel as BotChannelId, config.fields)
  if (validated === undefined) return undefined
  const sessionId = typeof candidate.sessionId === 'string' && candidate.sessionId.length > 0 ? candidate.sessionId : undefined
  const chatId = typeof candidate.chatId === 'string' && candidate.chatId.length > 0 ? candidate.chatId : undefined
  // A persisted senderId stays verbatim (including '' — the platform supplied none);
  // anything else reads as legacy, which keeps chatId-only authority.
  const senderId = typeof candidate.senderId === 'string' ? candidate.senderId : undefined
  return {
    config: validated,
    enabled: candidate.enabled === true,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(chatId !== undefined ? { chatId } : {}),
    ...(senderId !== undefined ? { senderId } : {}),
  }
}

/** The bot store: small, file-backed, synchronous. */
export class BotStore {
  private body: BotStoreBody

  /**
   * @param file - absolute path of the bots JSON file; created on first persist.
   */
  constructor(private readonly file: string) {
    this.body = readBody(file)
  }

  /** The stored entry of one channel, when present. */
  entry(channel: BotChannelId): BotEntry | undefined {
    return this.body.bots[channel]
  }

  /** The stored config of one channel, when present. */
  config(channel: BotChannelId): BotConfig | undefined {
    return this.body.bots[channel]?.config
  }

  /** Whether one channel is enabled. */
  enabled(channel: BotChannelId): boolean {
    return this.body.bots[channel]?.enabled === true
  }

  /**
   * Replace one channel's config, keeping the switch and the binding.
   * @param config - the validated config from the PUT route.
   */
  setConfig(config: BotConfig): void {
    const existing = this.body.bots[config.channel]
    this.body = {
      version: 1,
      bots: {
        ...this.body.bots,
        [config.channel]: {
          config,
          enabled: existing?.enabled === true,
          ...(existing?.sessionId !== undefined ? { sessionId: existing.sessionId } : {}),
          ...(existing?.chatId !== undefined ? { chatId: existing.chatId } : {}),
          ...(existing?.senderId !== undefined ? { senderId: existing.senderId } : {}),
        },
      },
    }
    this.persist()
  }

  /**
   * Set one channel's enabled flag; a channel with no config cannot enable.
   * @param channel - the channel to switch.
   * @param enabled - the new switch state.
   * @returns whether the switch was applied.
   */
  setEnabled(channel: BotChannelId, enabled: boolean): boolean {
    const existing = this.body.bots[channel]
    if (existing === undefined && enabled) return false
    if (existing === undefined) return false
    if (existing.enabled === enabled) return true
    this.body = { version: 1, bots: { ...this.body.bots, [channel]: { ...existing, enabled } } }
    this.persist()
    return true
  }

  /**
   * Bind one channel to a session, the chat that earned it, and the operator
   * sender identity the binding answers to. Every claim records a senderId —
   * `''` when the platform supplies none — so only legacy alpha bindings run
   * on chatId-only authority.
   * @param channel - the channel to bind.
   * @param sessionId - the session the bot drives.
   * @param chatId - the chat replies go to.
   * @param senderId - the operator's platform sender identity (may be `''`).
   */
  bind(channel: BotChannelId, sessionId: string, chatId: string, senderId: string): void {
    const existing = this.body.bots[channel]
    if (existing === undefined) return
    this.body = { version: 1, bots: { ...this.body.bots, [channel]: { ...existing, sessionId, chatId, senderId } } }
    this.persist()
  }

  /**
   * The active pairing code the Pocket page displays, generating and
   * persisting one on first read.
   * @returns the code to send as `/start <code>` from the operator's chat.
   */
  pairingCode(): string {
    return this.body.pairingCode ?? this.rotatePairingCode()
  }

  /**
   * Replace the active pairing code with a fresh one.
   * @returns the new code, already persisted.
   */
  rotatePairingCode(): string {
    const code = generatePairingCode()
    this.body = { ...this.body, pairingCode: code }
    this.persist()
    return code
  }

  /**
   * Consume one pairing attempt; a match rotates the code so a displayed
   * code can never pair twice.
   * @param code - the code the chat sent.
   * @returns whether the code matched the active one.
   */
  consumePairingCode(code: string): boolean {
    const active = this.body.pairingCode
    if (active === undefined || code.length === 0) return false
    if (!timingSafeStringEquals(active, code)) return false
    this.rotatePairingCode()
    return true
  }

  /** Every channel currently enabled, in page order. */
  enabledChannels(): readonly BotChannelId[] {
    return BOT_CHANNELS.filter(channel => this.body.bots[channel]?.enabled === true)
  }

  /** Rewrite the file atomically with owner-only permissions. */
  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.body, undefined, 2), { mode: 0o600, encoding: 'utf8' })
    renameSync(temp, this.file)
  }
}
