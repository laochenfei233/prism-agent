/**
 * Browser UI renderer. It installs the slot renderer after its Cordis
 * dependencies activate and exposes the mount operation used by the web boot
 * kernel after the complete client roster settles.
 */
import { createElement, useLayoutEffect, useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, hydrateRoot, type Root } from 'react-dom/client'
import type { Context } from '@deepseek-ai/cordis'
import { createSlotRenderer } from './scoped-slots.tsx'
import { buildRenderApp } from './app.tsx'
import { RenderFailureBoundary } from './render-failure.ts'
import { SlotRegistry } from './registry.ts'

export { SlotRegistry } from './registry.ts'
export type { RootOwnerProps } from './registry.ts'

export type {
  ChainRenderOpts, HostObservable, RenderOpts, SnapshotSelectorHook, SlotRenderer,
  ScopedStandardSourceBinding, SlotRendererHost, SlotScopeAdapter,
  StandardSourceBinding, StoreInstanceLike,
} from '@deepseek-ai/dsh-client-ui-slots'

/** Mount operation exposed to the framework-free boot kernel. */
export interface UiRendererService {
  /**
   * Mount the assembled application into the supplied element. A render
   * failure is caught by the mount's top-level boundary, reported through the
   * host logger, and replaced by the built-in crash face; a failed render never
   * leaves the container blank.
   * @param container - Application mount point.
   * @returns Disposer that unmounts the React root.
   */
  mount: (container: HTMLElement) => () => void
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * An ordinary Slot declaration or entry registration set changed. Factory
     * definitions publish through `subscribeFactory()` instead.
     * @mode emit
     * @param key - mutated SlotMap key.
     */
    'slots/changed'(key: string): void
  }
  interface Context {
    /** Renderer-owned UI composition registry. */
    slots: SlotRegistry
    /** Mount face provided after the UI renderer activates. */
    uiRenderer: UiRendererService
  }
}

/** Services required before application assembly. */
export const inject: string[] = []

interface BootSnapshot {
  className: string
  html: string
}

/** Hydrate the kernel-owned loading DOM before replacing it with the application. */
function BootHandoff(props: { app: () => ReactNode; boot: BootSnapshot }): ReactNode {
  const [ready, setReady] = useState(false)
  useLayoutEffect(() => { setReady(true) }, [])
  if (ready) return props.app()
  return createElement('div', {
    className: props.boot.className,
    'data-dsh-boot': '',
    dangerouslySetInnerHTML: { __html: props.boot.html },
  })
}

/** Render the application factory below the failure boundary. */
function AppRoot({ app }: { app: () => ReactNode }): ReactNode {
  return app()
}

/**
 * Guard the mount tree: without a boundary, a render error unmounts the React
 * root after the boot page has handed off, leaving an empty document.
 */
function guardApp(children: ReactNode, onError: (error: unknown) => void): ReactNode {
  return createElement(RenderFailureBoundary, { onError, children })
}

/** Mount React while preserving the framework-free boot DOM through hydration. */
function mountApp(container: HTMLElement, app: () => ReactNode, onError: (error: unknown) => void): Root {
  const boot = container.querySelector<HTMLElement>(':scope > [data-dsh-boot]')
  if (boot !== null) {
    return hydrateRoot(container, guardApp(createElement(BootHandoff, {
      app,
      boot: { className: boot.className, html: boot.innerHTML },
    }), onError))
  }
  const root = createRoot(container)
  flushSync(() => { root.render(guardApp(createElement(AppRoot, { app }), onError)) })
  return root
}

/**
 * Install the slot renderer and provide the application mount face.
 * @param ctx - Plugin context.
 */
export function apply(ctx: Context): void {
  const slots = new SlotRegistry(ctx)
  slots.install(createSlotRenderer())
  const onError = (error: unknown): void => {
    try { ctx.logger.error(error) } catch (logError) {
      // The crash face must render even when the logger is the failed dependency.
      console.error('render failure logging failed:', logError)
    }
  }
  ctx.reflect.provide('uiRenderer', {
    mount: (container: HTMLElement): (() => void) => {
      const root = mountApp(container, buildRenderApp({ ctx }), onError)
      return () => { root.unmount() }
    },
  })
}
