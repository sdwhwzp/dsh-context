/** Escape-to-close overlays: capture-phase keydown so the harness's bubble-phase Escape routing never sees the key. */

import { useEffect, useRef } from 'react'
import { isBareEscape, isClearableField, ownsClearEscape } from './clearableInput'

/** `onClose` rides a latest ref: a per-render resubscribe would rerun cleanup's focus restore and yank focus from overlay inputs. */
export function useEscapeClose(active: boolean, onClose: () => void): void {
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    if (!active) return undefined
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const onKey = (ev: KeyboardEvent): void => {
      if (!isBareEscape(ev)) return
      /* A focused clearable field keeps Escape away from the overlay: it clears when it has content, and
         during IME composition the key stays with the IME while the overlay holds still. */
      const target = ev.target
      if (isClearableField(target) && (ev.isComposing || ownsClearEscape(target))) {
        if (ev.isComposing) ev.stopPropagation()
        return
      }
      ev.preventDefault()
      ev.stopPropagation()
      close.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      if (previous !== null && document.contains(previous)) previous.focus()
    }
  }, [active])
}
