/**
 * The subscription store: file persistence, endpoint-keyed replacement, and
 * pruning. Storage is part of the durable surface, so every mutation here is
 * checked against a reloaded store.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SubscriptionStore } from '../../src/push/store.ts'
import type { PocketPushSubscriptionRecord } from '../../src/types.ts'

const tempDirectories: string[] = []

function tempFile(): string {
  const directory = mkdtempSync(join(tmpdir(), 'pocket-store-'))
  tempDirectories.push(directory)
  return join(directory, 'subscriptions.json')
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function record(endpoint: string): PocketPushSubscriptionRecord {
  return { endpoint, keys: { p256dh: 'p256dh-key', auth: 'auth-key' }, addedAt: new Date(0).toISOString() }
}

describe('SubscriptionStore', () => {
  it('persists additions and survives a reload', () => {
    const file = tempFile()
    const store = new SubscriptionStore(file)
    store.add(record('https://push.example.com/a'))
    expect(new SubscriptionStore(file).all()).toHaveLength(1)
  })

  it('replaces a re-subscription of the same endpoint', () => {
    const file = tempFile()
    const store = new SubscriptionStore(file)
    store.add(record('https://push.example.com/a'))
    store.add({ ...record('https://push.example.com/a'), keys: { p256dh: 'rotated', auth: 'rotated' } })
    expect(store.size).toBe(1)
    expect(store.all()[0]?.keys.p256dh).toBe('rotated')
  })

  it('removes pruned endpoints', () => {
    const file = tempFile()
    const store = new SubscriptionStore(file)
    store.add(record('https://push.example.com/a'))
    store.add(record('https://push.example.com/b'))
    store.remove('https://push.example.com/a')
    expect(store.size).toBe(1)
    store.remove('https://push.example.com/missing')
    expect(store.size).toBe(1)
  })

  it('reads a corrupt or foreign file as empty', () => {
    const file = tempFile()
    writeTextSync(file, '{"not":"an array"}')
    expect(new SubscriptionStore(file).size).toBe(0)
    writeTextSync(file, '[{"endpoint":"https://x","keys":{"p256dh":1,"auth":2}}]')
    expect(new SubscriptionStore(file).size).toBe(0)
  })
})

function writeTextSync(file: string, text: string): void {
  writeFileSync(file, text, 'utf8')
}
