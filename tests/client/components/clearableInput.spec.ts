import { act, createElement as h, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { ClearableInput } from '../../../src/client/components/clearableInput'
import { click, keydown, mount, query, typeText } from '../helpers/kit'

function Field(props: {
  initial?: string
  type?: 'search' | 'text'
  onKeyDown?: (ev: ReactKeyboardEvent<HTMLInputElement>) => void
}): ReactElement {
  const [value, setValue] = useState(props.initial ?? '')
  return h(ClearableInput, {
    value,
    onChange: setValue,
    className: 'lc-fa-search',
    placeholder: 'Filter…',
    clearLabel: 'Clear input',
    ...(props.type !== undefined ? { type: props.type } : {}),
    ...(props.onKeyDown !== undefined ? { onKeyDown: props.onKeyDown } : {}),
  })
}

describe('ClearableInput', () => {
  test('an empty field shows no clear control until typing fills it', async () => {
    const m = await mount(h(Field, {}))
    const box = query(m.container, '.lc-searchbox')
    assert.equal(box.className, 'lc-searchbox')
    assert.equal(m.container.querySelector('.lc-searchbox-x'), null)
    const input = query<HTMLInputElement>(m.container, 'input')
    assert.equal(input.className, 'lc-fa-search')
    assert.equal(input.type, 'text')
    assert.equal(input.getAttribute('aria-label'), 'Filter…', 'the placeholder names the field')
    await typeText(input, 'worker')
    assert.equal(input.value, 'worker')
    assert.equal(box.className, 'lc-searchbox lc-searchbox-on')
    assert.equal(query<HTMLButtonElement>(m.container, '.lc-searchbox-x').getAttribute('aria-label'), 'Clear input')
    await m.unmount()
  })

  test('the clear control empties the field and keeps focus in the input', async () => {
    const m = await mount(h(Field, { initial: 'worker' }))
    const input = query<HTMLInputElement>(m.container, 'input')
    const clear = query<HTMLButtonElement>(m.container, '.lc-searchbox-x')
    assert.equal(clear.type, 'button')
    assert.equal(clear.title, 'Clear input')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => { clear.dispatchEvent(down) })
    assert.equal(down.defaultPrevented, true, 'the press never steals focus from the input')
    await click(clear)
    assert.equal(input.value, '')
    assert.equal(document.activeElement, input)
    assert.equal(m.container.querySelector('.lc-searchbox-x'), null)
    await m.unmount()
  })

  test('the search type, caller ref and key handler pass through', async () => {
    const seen: string[] = []
    const ref = { current: null as HTMLInputElement | null }
    function Bound(): ReactElement {
      return h(ClearableInput, {
        value: 'x',
        onChange: () => {},
        className: 'lc-ov-search',
        placeholder: 'Search',
        clearLabel: 'Clear input',
        type: 'search',
        inputRef: ref,
        onKeyDown: (ev: ReactKeyboardEvent<HTMLInputElement>) => { seen.push(ev.key) },
      })
    }
    const m = await mount(h(Bound, {}))
    const input = query<HTMLInputElement>(m.container, 'input')
    assert.equal(input.type, 'search')
    assert.equal(ref.current, input)
    await keydown('Enter', input)
    assert.deepEqual(seen, ['Enter'])
    await m.unmount()
  })
})
