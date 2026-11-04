// @vitest-environment jsdom
/**
 * Project export menu row: the label, the dismissal, and the streaming export
 * URL the browser's download manager receives.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ProjectExportMenuItem } from '../src/client/ProjectExportMenuItem.tsx'
import type { ProjectExportMenuProps } from '../src/client/slots.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

describe('ProjectExportMenuItem', () => {
  it('dismisses the menu and hands the project export URL to the download manager', () => {
    const setMenuOpen = vi.fn()
    const clicked: string[] = []
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this.getAttribute('href') ?? '')
    })
    try {
      const props = {
        workspaceId: 'w1',
        useMenuOpenState: () => [true, setMenuOpen],
        t: (key: keyof typeof zh) => zh[key],
      } as unknown as ProjectExportMenuProps
      render(<ProjectExportMenuItem {...props} />)

      fireEvent.click(screen.getByRole('menuitem', { name: zh.menuExportProject }))

      expect(setMenuOpen).toHaveBeenCalledExactlyOnceWith(false)
      expect(clicked).toHaveLength(1)
      const url = new URL(clicked[0] ?? '', 'http://localhost')
      expect(url.pathname).toBe('/api/prism.transfer/export')
      expect(url.searchParams.get('projects')).toBe('w1')
      expect(url.searchParams.get('settings')).toBe('0')
      expect(url.searchParams.get('secrets')).toBe('0')
    } finally {
      click.mockRestore()
    }
  })
})
