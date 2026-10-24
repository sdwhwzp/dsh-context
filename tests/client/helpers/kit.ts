import { act, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DICT_EN, DICT_ZH } from '../../../src/client/i18n'
import type { Translate } from '../../../src/client/i18n'
import { makeViewKit, type ViewKit } from '../../../src/client/viewkit'
import type { SurfaceNode } from '../../../src/shared/types'

export function surfaceNode(over: Partial<SurfaceNode> & { seq: number }): SurfaceNode {
  return { cat: 'user', tokens: 5, ...over }
}

export function surfaceNodeAt(seq: number, over: Partial<SurfaceNode> = {}): SurfaceNode {
  return { seq, cat: 'user', tokens: 1, ...over }
}

/** The harness locale chain (active → en → key) over the plugin's REAL dictionaries, so assertions stay shipped-accurate. */
export function makeTranslate(active: 'en' | 'zh' = 'en', dicts?: Record<string, Record<string, string>>): Translate {
  const table: Record<string, Record<string, string>> = dicts ?? { zh: DICT_ZH, en: DICT_EN }
  return (key, params) => {
    let s = table[active]?.[key] ?? table.en[key] ?? key
    if (params) for (const k in params) s = s.replace('{' + k + '}', String(params[k]))
    return s
  }
}

export function makeKit(active: 'en' | 'zh' = 'en'): ViewKit {
  return makeViewKit(makeTranslate(active))
}

export interface Mounted {
  container: HTMLElement
  root: Root
  update(el: ReactElement): Promise<void>
  unmount(): Promise<void>
}

export async function mount(el: ReactElement): Promise<Mounted> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(el)
  })
  return {
    container,
    root,
    async update(next) {
      await act(async () => {
        root.render(next)
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

export async function flush(): Promise<void> {
  await act(async () => {})
}

/** Poll until the predicate holds, one short act() scope per tick, so timer/promise updates are
 * act-attributed and committed before the next check. `message` labels the give-up failure. */
export async function until(fn: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await act(async () => {
      if (fn()) return
      await new Promise(resolve => setTimeout(resolve, 5))
    })
    if (fn()) return
  }
  throw new Error(message)
}

/** Silence a deliberately-thrown render error: React 18 dev replays it as a fake DOM event jsdom reports as
 * uncaught; preventing the default keeps the throw inside the test. */
export function silenceWindowErrors(): () => void {
  const onError = (e: Event) => { e.preventDefault() }
  window.addEventListener('error', onError)
  return () => { window.removeEventListener('error', onError) }
}

export function text(container: HTMLElement): string {
  return container.textContent ?? ''
}

/** The composition bar's tooltip rows, so specs assert the bubble's structure instead of textContent. */
export function tipRows(tip: HTMLElement): (string | null)[] {
  return ['.lc-bar-tip-head', '.lc-bar-tip-fig', '.lc-bar-tip-note']
    .map(sel => tip.querySelector<HTMLElement>(sel)?.textContent ?? null)
}

export function query<T extends Element = HTMLElement>(container: ParentNode, selector: string): T {
  const el = container.querySelector<T>(selector)
  if (el === null) throw new Error(`element not found: ${selector}`)
  return el
}

export function queryAll<T extends Element = HTMLElement>(container: ParentNode, selector: string): T[] {
  return [...container.querySelectorAll<T>(selector)]
}

/** Pin a jsdom element's boxes: jsdom lays nothing out, so measuring components need geometry. */
export function pinRect(el: Element, width: number, height = 0): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width, height, right: width, bottom: height }),
  })
}

export async function click(el: HTMLElement): Promise<void> {
  await act(async () => {
    el.click()
  })
}

/** The native value setter plus the input event React's onChange listens for (a plain assignment is swallowed). */
export async function typeText(el: HTMLTextAreaElement | HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** React 18 synthesizes onMouseEnter/Leave from the BUBBLING mouseover/mouseout pair. */
export async function hover(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
  })
}

export async function unhover(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
  })
}

/** React synthesizes onFocus/onBlur from the BUBBLING focusin/focusout pair. */
export async function focus(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
  })
}

export async function blur(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  })
}

export async function keydown(key: string, target: HTMLElement | Window = window): Promise<void> {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
  })
}

export function wheel(el: Element, deltaX: number, deltaY: number): boolean {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY })
  el.dispatchEvent(event)
  return event.defaultPrevented
}

export type { ReactElement, ReactNode }
