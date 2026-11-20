// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { SlotRegistry } from '../src/client/registry.ts'
import type { SlotScopeAdapter, StandardSourceBinding } from '../src/client/index.ts'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-renderer'
import * as UiRenderer from '../src/client/index.ts'

const mounted: (() => void)[] = []

afterEach(() => {
  act(() => { for (const unmount of mounted.splice(0)) unmount() })
  vi.restoreAllMocks()
  cleanup()
  document.body.innerHTML = ''
})

const stabilize = async (fn: () => void | Promise<void>): Promise<void> => {
  await act(async () => { await fn() })
}

async function bench() {
  const ctx = new Context()
  const fiber = ctx.plugin({ inject: [...UiRenderer.inject], apply: UiRenderer.apply })
  await fiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  const absentBinding: StandardSourceBinding = {
    key: undefined,
    hooks: {},
    keyedHooks: {},
    props: {},
  }
  const current = {
    getSnapshot: () => absentBinding,
    subscribe: () => () => {},
  }
  const adapter: SlotScopeAdapter = {
    current,
    bindingSource: () => current,
  }
  slots.installScope('session', adapter)
  return { ctx, slots, fiber }
}

function container(): HTMLElement {
  const el = document.createElement('div')
  document.body.append(el)
  return el
}

describe('UI renderer plugin', () => {
  it('provides no host-side behavior', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })

  it('installs the renderer and mounts the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const renderer = ctx.get('uiRenderer')
    expect(renderer).toBeDefined()
    const el = container()
    act(() => { mounted.push(renderer!.mount(el)) })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
  })

  it('hydrates the boot page before switching to the assembled application', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    el.innerHTML = '<div class="boot" data-dsh-boot=""><div><div class="spinner" data-dsh-boot-spinner="" style="--dsh-boot-arc: 180deg"></div><div>Loading plugins…</div></div></div>'
    const boot = el.firstElementChild
    const observer = new MutationObserver(() => {})
    observer.observe(el, { childList: true, subtree: true })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    const records = observer.takeRecords()
    observer.disconnect()
    expect(error).not.toHaveBeenCalled()
    error.mockRestore()
    expect(el.querySelector('[data-testid="root-probe"]')).toBeTruthy()
    expect(records.some(record => record.target === boot)).toBe(false)
  })

  it('renders the crash face instead of leaving an empty root when the application render throws', async () => {
    const { ctx } = await bench()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const el = container()

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    expect(el.querySelector('[data-render-failure]')).not.toBeNull()
    expect(el.textContent).toContain('The interface failed to render')
    expect(el.textContent).toContain("'root' has no registration")
    const button = el.querySelector('button')
    expect(button?.textContent).toBe('Reload')
    act(() => { button?.click() })
    expect(error).toHaveBeenCalled()
  })

  it('renders a thrown non-Error value', async () => {
    const { ctx, slots } = await bench()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure: unknown = 'render boom'
    vi.spyOn(slots, 'renderSlot').mockImplementation(() => { throw failure })
    const el = container()

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    expect(el.querySelector('[data-render-failure]')).not.toBeNull()
    expect(el.textContent).toContain('render boom')
    expect(error).toHaveBeenCalled()
  })

  it('keeps the crash face visible when the failure logger throws', async () => {
    const { ctx } = await bench()
    const logger = vi.spyOn(ctx.logger, 'error').mockImplementation(() => { throw new Error('logger down') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const el = container()

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    expect(el.querySelector('[data-render-failure]')).not.toBeNull()
    expect(error).toHaveBeenCalledWith('render failure logging failed:', expect.any(Error))
    logger.mockRestore()
  })

  it('replaces the boot page with the crash face when the application render throws', async () => {
    const { ctx } = await bench()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const el = container()
    el.innerHTML = '<div class="boot" data-dsh-boot=""><div><div class="spinner" data-dsh-boot-spinner="" style="--dsh-boot-arc: 180deg"></div><div>Loading plugins…</div></div></div>'

    act(() => { mounted.push(ctx.get('uiRenderer')!.mount(el)) })

    expect(el.querySelector('[data-dsh-boot]')).toBeNull()
    expect(el.querySelector('[data-render-failure]')).not.toBeNull()
    expect(error).toHaveBeenCalled()
  })

  it('returns an unmount disposer', async () => {
    const { ctx, slots } = await bench()
    slots.register({ name: 'root' }, () => <div data-testid="root-probe" />)
    const el = container()
    let unmount: () => void = () => {}
    act(() => { unmount = ctx.get('uiRenderer')!.mount(el) })
    act(() => { unmount() })
    expect(el.querySelector('[data-testid="root-probe"]')).toBeNull()
  })

  it('retracts the service and renderer with its fiber', async () => {
    const { ctx, slots, fiber } = await bench()
    await stabilize(() => fiber.dispose())
    expect(ctx.get('uiRenderer')).toBeUndefined()
    expect(() => slots.renderSlot('root', {})).toThrow('not installed')
  })
})
