/** Command palette visibility and query, shared by its command and its overlay. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

type State = { open: boolean; query: string; focusRequest: number }
type Actions = { open(draft: State): void; close(draft: State): void; search(draft: State, query: string): void }

/**
 * Declare the command palette store.
 * @returns root-scoped visibility, query, and focus request actions.
 */
export function createCommandPaletteStore(): EngineStoreHandle<State, Actions> {
  return defineStore({
    init: (): State => ({ open: false, query: '', focusRequest: 0 }),
    actions: {
      open: (d) => { d.open = true; d.query = ''; d.focusRequest++ },
      close: (d) => { d.open = false; d.query = '' },
      search: (d, query: string) => { d.query = query },
    },
  })
}
