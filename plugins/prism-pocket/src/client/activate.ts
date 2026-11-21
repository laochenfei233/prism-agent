/**
 * Activation: when the pocket adaptations apply.
 *
 * The decision is pure (`shouldActivate`); this module owns the DOM side —
 * the remembered `?pocket=` override and the `prism-active` class on the
 * document element — and notifies the owner whenever the verdict flips.
 *
 * @module @prism/prism-pocket/client/activate
 */

import { shouldActivate, type PocketOverride } from './pure.ts'

/** localStorage key holding the last explicit choice. */
export const POCKET_STORAGE_KEY = 'prism-pocket.mode'

/** Minimal storage view for tests. */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/**
 * Read the `?pocket=` URL override, remembering the last explicit value.
 * @param search - the location search string.
 * @param storage - the persistence backing the remembered choice.
 */
export function readOverride(search: string, storage: StorageLike): PocketOverride | undefined {
  const value = new URLSearchParams(search).get('pocket')
  if (value === '1' || value === '0') {
    const remembered: PocketOverride = value === '1' ? 'on' : 'off'
    storage.setItem(POCKET_STORAGE_KEY, remembered)
    return remembered
  }
  const stored = storage.getItem(POCKET_STORAGE_KEY)
  return stored === 'on' || stored === 'off' ? stored : undefined
}

/**
 * Watch the activation verdict.
 * @param storage - persistence for the remembered override.
 * @param onChange - called on every verdict change; called once synchronously.
 * @returns the disposer.
 */
export function watchActivation(storage: StorageLike, onChange: (active: boolean) => void): () => void {
  const coarse = matchMedia('(pointer: coarse)')
  let last: boolean | null = null
  const evaluate = (): void => {
    const active = shouldActivate(window.innerWidth, coarse.matches, readOverride(window.location.search, storage))
    document.documentElement.classList.toggle('prism-active', active)
    if (active !== last) {
      last = active
      onChange(active)
    }
  }
  evaluate()
  const viewport = (): void => { evaluate() }
  window.addEventListener('resize', viewport)
  coarse.addEventListener('change', viewport)
  return () => {
    window.removeEventListener('resize', viewport)
    coarse.removeEventListener('change', viewport)
    document.documentElement.classList.remove('prism-active')
  }
}
