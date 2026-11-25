/** Pairing ticket state machine: creation, decisions, collection, and expiry. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAIRING_LIMITS, PairingRequests } from '../../src/pairing/requests.ts'

/** One caller-generated credential, as the browser sends it. */
const credential = (id = 'ticket-1', secret = 's'.repeat(43)): { id: string; secret: string } => ({ id, secret })

/** Mint one approved ticket; the URL the collect step would hand to the phone. */
const loginUrl = 'http://127.0.0.1:3080/?token=once'

afterEach(() => {
  vi.useRealTimers()
})

describe('pairing requests', () => {
  it('issues a display code and lists the request without its secret', () => {
    const requests = new PairingRequests()
    const ticket = requests.create('192.168.1.7', credential())

    expect(ticket).toMatchObject({ code: expect.stringMatching(/^[2-9A-HJ-NP-Z]{8}$/u) })
    expect(ticket?.expiresInMs).toBe(PAIRING_LIMITS.requestTtlMs)
    const [row] = requests.list()
    expect(row).toEqual({
      id: 'ticket-1',
      code: ticket?.code,
      sourceIp: '192.168.1.7',
      expiresInMs: expect.any(Number),
    })
    expect(row).not.toHaveProperty('secret')
  })

  it('answers a repeated creation with the retained ticket and refuses a secret conflict', () => {
    const requests = new PairingRequests()
    const first = requests.create(null, credential())
    const again = requests.create(null, credential())
    expect(again?.code).toBe(first?.code)
    expect(requests.create(null, credential('ticket-1', 'x'.repeat(43)))).toBeUndefined()
    expect(requests.list()).toHaveLength(1)
  })

  it('rate-limits creation and caps the pool', () => {
    vi.useFakeTimers()
    const requests = new PairingRequests()
    expect(requests.create(null, credential('ticket-1'))).toBeDefined()
    expect(requests.create(null, credential('ticket-2'))).toBeUndefined()

    for (let index = 2; index <= PAIRING_LIMITS.maxRequests; index += 1) {
      vi.advanceTimersByTime(PAIRING_LIMITS.requestIntervalMs)
      expect(requests.create(null, credential(`ticket-${String(index)}`))).toBeDefined()
    }
    vi.advanceTimersByTime(PAIRING_LIMITS.requestIntervalMs)
    expect(requests.create(null, credential('ticket-full'))).toBeUndefined()
  })

  it('collects one login URL after approval and delivers the same URL on a retry', () => {
    vi.useFakeTimers()
    const requests = new PairingRequests()
    requests.create(null, credential())
    expect(requests.decide('ticket-1', 'allow')).toBe('approved')
    expect(requests.poll('ticket-1', credential().secret, false, () => loginUrl)).toEqual({ status: 'approved', url: loginUrl })
    // A lost response is retryable until the request expires; the URL does not change.
    vi.advanceTimersByTime(PAIRING_LIMITS.pollIntervalMs)
    expect(requests.poll('ticket-1', credential().secret, false, () => 'http://127.0.0.1:3080/?token=other'))
      .toEqual({ status: 'approved', url: loginUrl })
    // The decided request no longer waits for a decision.
    expect(requests.list()).toEqual([])
  })

  it('keeps the first decision when the owner retries or races', () => {
    const requests = new PairingRequests()
    requests.create(null, credential())
    expect(requests.decide('ticket-1', 'deny')).toBe('denied')
    expect(requests.decide('ticket-1', 'allow')).toBe('denied')
    expect(requests.poll('ticket-1', credential().secret, false, () => loginUrl)).toEqual({ status: 'denied' })
    expect(requests.decide('missing', 'allow')).toBe('unavailable')
  })

  it('withdraws a pending request and refuses to decide it afterwards', () => {
    const requests = new PairingRequests()
    requests.create(null, credential())
    expect(requests.poll('ticket-1', credential().secret, true, () => loginUrl)).toEqual({ status: 'cancelled' })
    expect(requests.decide('ticket-1', 'allow')).toBe('unavailable')
    expect(requests.list()).toEqual([])
  })

  it('expires requests and their decisions after the lifetime', () => {
    vi.useFakeTimers()
    const requests = new PairingRequests()
    requests.create(null, credential())
    vi.advanceTimersByTime(PAIRING_LIMITS.requestTtlMs + 1)
    expect(requests.list()).toEqual([])
    expect(requests.poll('ticket-1', credential().secret, false, () => loginUrl)).toEqual({ status: 'expired' })
    expect(requests.decide('ticket-1', 'allow')).toBe('unavailable')
  })

  it('refuses a poll with the wrong secret and throttles repeated polls', () => {
    vi.useFakeTimers()
    const requests = new PairingRequests()
    requests.create(null, credential())
    expect(requests.poll('ticket-1', 'x'.repeat(43), false, () => loginUrl)).toEqual({ status: 'expired' })
    expect(requests.poll('ticket-1', credential().secret, false, () => loginUrl)).toEqual({ status: 'pending' })
    expect(requests.poll('ticket-1', credential().secret, false, () => loginUrl)).toEqual({ status: 'slow-down' })
    vi.advanceTimersByTime(PAIRING_LIMITS.pollIntervalMs)
    expect(requests.poll('ticket-1', credential().secret, false, () => loginUrl)).toEqual({ status: 'pending' })
  })

  it('keeps an approval available when the login URL cannot be minted yet', () => {
    vi.useFakeTimers()
    const requests = new PairingRequests()
    requests.create(null, credential())
    requests.decide('ticket-1', 'allow')
    expect(requests.poll('ticket-1', credential().secret, false, () => undefined)).toEqual({ status: 'unavailable' })
    vi.advanceTimersByTime(PAIRING_LIMITS.pollIntervalMs)
    expect(requests.poll('ticket-1', credential().secret, false, () => loginUrl)).toEqual({ status: 'approved', url: loginUrl })
  })

  it('drops every ticket on clear', () => {
    const requests = new PairingRequests()
    requests.create(null, credential())
    requests.clear()
    expect(requests.list()).toEqual([])
    expect(requests.poll('ticket-1', credential().secret, false, () => loginUrl)).toEqual({ status: 'expired' })
  })
})
