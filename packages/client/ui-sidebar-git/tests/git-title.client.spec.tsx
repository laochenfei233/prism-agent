// @vitest-environment jsdom
/** The chip title: the branch glyph before the tab's captured title. */
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { GitTitle } from '../src/client/GitTitle.tsx'

describe('GitTitle', () => {
  it('draws the branch glyph and the tab title', () => {
    const view = render(<GitTitle useTabInfo={() => ({ tab: { title: '更改' } })} />)
    expect(view.container.textContent).toBe('更改')
    expect(view.container.querySelector('svg')).not.toBeNull()
  })
})
