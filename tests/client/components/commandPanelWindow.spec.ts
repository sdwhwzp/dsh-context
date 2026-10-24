import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import { makeCommandPanel } from '../../../src/client/components/commandPanel'
import { rowWindowFor } from '../../../src/client/components/useRowWindow'
import type { Command } from '../../../src/client/commands'
import { makeKit, mount, query, queryAll, text, until } from '../helpers/kit'

const Panel = makeCommandPanel(makeKit())

const PITCH = 43
const GAP = 2
const T0 = 1_700_000_000_000
/** Mixed and unlaid-out rows must keep the full list: spacers need uniform heights. */
let mixedRows = false
let zeroRows = false
let originals: [string, PropertyDescriptor | undefined][] = []

/** jsdom lays nothing out: give the list a 320px viewport and the rows a 43px pitch so the panel's own
 *  measurement → window path runs for real. */
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    observe = (): void => {}
    disconnect = (): void => {}
  })
  originals = (['clientHeight', 'getBoundingClientRect'] as const)
    .map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as [string, PropertyDescriptor | undefined])
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains('lc-cmd-list')) return 320
      const own = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get
      return own === undefined ? 0 : own.call(this)
    },
  })
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value as () => DOMRect
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this.classList.contains('lc-cmd-item')) {
        const items = [...(this.parentElement?.querySelectorAll('.lc-cmd-item') ?? [])]
        const i = items.indexOf(this)
        const heightOf = (j: number): number => (zeroRows ? 0 : (mixedRows && j % 7 === 0 ? PITCH + 20 : PITCH) - GAP)
        let top = 0
        for (let j = 0; j < i; j++) top += heightOf(j) + GAP
        return { left: 0, top, width: 500, height: heightOf(i), right: 500, bottom: top + heightOf(i), x: 0, y: top, toJSON: () => ({}) } as DOMRect
      }
      return rect.call(this) as DOMRect
    },
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
  for (const [name, desc] of originals) {
    if (desc === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(HTMLElement.prototype, name, desc)
  }
})

function commandsOf(count: number): Command[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    time: T0 + i * 1000,
    tool: 'bash',
    cmd: `echo item-${i}`,
    description: `run item-${i}`,
    start: T0 + i * 1000,
    end: T0 + i * 1000 + 100,
    status: 'completed' as const,
    err: false,
  }))
}

async function typeSearch(container: ParentNode, value: string): Promise<void> {
  const input = query<HTMLInputElement>(container, 'input.lc-fa-search')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('CommandPanel row windowing', () => {
  test('renders a measured window with full-height pads and follows the scroll', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    try {
      const list = query<HTMLElement>(m.container, '.lc-cmd-list')
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'the list windows after measuring')
      const start = rowWindowFor(0, 320, PITCH, 120)
      assert.equal(queryAll(m.container, '.lc-cmd-item').length, start.to - start.from + 1)
      const [bottomOnly] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(bottomOnly.style.height, `${(119 - start.to) * PITCH - GAP}px`)

      list.scrollTop = 900
      await new Promise(resolve => setTimeout(resolve, 40))
      list.dispatchEvent(new Event('scroll'))
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'a top pad appears after scrolling')
      const mid = rowWindowFor(900, 320, PITCH, 120)
      assert.equal(queryAll(m.container, '.lc-cmd-item').length, mid.to - mid.from + 1)
      const [topPad, bottomPad] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(topPad.style.height, `${mid.from * PITCH - GAP}px`)
      assert.equal(bottomPad.style.height, `${(119 - mid.to) * PITCH - GAP}px`)

      list.scrollTop = 100_000
      list.dispatchEvent(new Event('scroll'))
      await until(() => {
        const pads = queryAll<HTMLElement>(m.container, '.lc-row-pad')
        return pads.length === 1 && Number.parseFloat(pads[0].style.height) > 1000
      }, 'the tail window drops its bottom pad')
      assert.ok(text(m.container).includes('item-0'), 'the oldest row is reachable')
    } finally {
      await m.unmount()
    }
  })

  test('mixed row heights keep the full list so the scroll geometry stays truthful', async () => {
    mixedRows = true
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(queryAll(m.container, '.lc-cmd-item').length, 120)
      assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
    } finally {
      mixedRows = false
      await m.unmount()
    }
  })

  test('an unlaid-out list (zero heights) keeps the full list', async () => {
    zeroRows = true
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    try {
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(queryAll(m.container, '.lc-cmd-item').length, 120)
      assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
    } finally {
      zeroRows = false
      await m.unmount()
    }
  })

  test('an expanded row falls back to the full list, then windows again when closed', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    try {
      const list = query<HTMLElement>(m.container, '.lc-cmd-list')
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'windowed')
      list.scrollTop = 900
      await new Promise(resolve => setTimeout(resolve, 40))
      list.dispatchEvent(new Event('scroll'))
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'scrolled mid-list')
      query<HTMLElement>(m.container, '.lc-cmd-row').click()
      await until(() => queryAll(m.container, '.lc-cmd-item').length === 120, 'the expanded row shows the full list')
      query<HTMLElement>(m.container, '.lc-cmd-item-on .lc-cmd-row').click()
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'closing the row re-windows')
    } finally {
      await m.unmount()
    }
  })

  test('a row opened below the threshold defers measuring until it closes', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(4), workspace: '/repo' }))
    try {
      query<HTMLElement>(m.container, '.lc-cmd-row').click()
      await until(() => m.container.querySelector('.lc-cmd-detail') !== null, 'the row expands')
      await m.update(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
      await new Promise(resolve => setTimeout(resolve, 30))
      assert.equal(queryAll(m.container, '.lc-cmd-item').length, 120, 'no windowing while a row is open')
      assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
      const openRow = queryAll<HTMLElement>(m.container, '.lc-cmd-row')
        .find(row => query<HTMLElement>(row, '.lc-cmd-cmd').textContent?.endsWith('item-3') === true)
      assert.ok(openRow !== undefined)
      openRow.click()
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'closing the row measures and windows')
    } finally {
      await m.unmount()
    }
  })

  test('a filter below the threshold puts every match back in the DOM', async () => {
    const commands = commandsOf(120).map((rec, i) => ({ ...rec, cmd: `${i % 2 === 0 ? 'echo alpha' : 'echo beta'}-${i}` }))
    const m = await mount(h(Panel, { commands, workspace: '/repo' }))
    try {
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'windowed')
      await typeSearch(m.container, 'alpha')
      await until(() => queryAll(m.container, '.lc-cmd-item').length === 60, 'all sixty matches render')
      assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
      await typeSearch(m.container, '')
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'clearing restores the window')
    } finally {
      await m.unmount()
    }
  })

  test('zebra parity follows the absolute row index through a window shift', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    try {
      const list = query<HTMLElement>(m.container, '.lc-cmd-list')
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'windowed')
      const check = (from: number): void => {
        const rows = queryAll<HTMLElement>(m.container, '.lc-cmd-item')
        for (let i = 0; i < rows.length; i++) {
          assert.equal(rows[i].classList.contains('lc-cmd-item-alt'), (from + i) % 2 === 1, `row ${from + i}`)
        }
      }
      check(rowWindowFor(0, 320, PITCH, 120).from)
      list.scrollTop = PITCH * 21
      await new Promise(resolve => setTimeout(resolve, 40))
      list.dispatchEvent(new Event('scroll'))
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'scrolled past the overscan')
      check(rowWindowFor(PITCH * 21, 320, PITCH, 120).from)
    } finally {
      await m.unmount()
    }
  })

  test('a shrinking result set under a stale window still renders its rows', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(120), workspace: '/repo' }))
    try {
      const list = query<HTMLElement>(m.container, '.lc-cmd-list')
      await until(() => queryAll(m.container, '.lc-cmd-item').length < 120, 'windowed')
      list.scrollTop = 3000
      await new Promise(resolve => setTimeout(resolve, 40))
      list.dispatchEvent(new Event('scroll'))
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'scrolled mid-list')
      await typeSearch(m.container, 'item-119')
      await until(() => queryAll(m.container, '.lc-cmd-item').length === 1, 'the one match renders')
      assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
    } finally {
      await m.unmount()
    }
  })
})
