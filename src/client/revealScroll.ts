export function revealInScrollParent(anchor: Element): boolean {
  try {
    for (let el = anchor.parentElement; el !== null && el !== document.body; el = el.parentElement) {
      const oy = window.getComputedStyle(el).overflowY
      // The OPERATIVE scroller: a content-growing box reports auto yet never moves.
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight) {
        el.scrollTop += anchor.getBoundingClientRect().top - el.getBoundingClientRect().top
        return true
      }
    }
  } catch { /* the reveal degrades to nothing */ }
  return false
}

/** Scroll only the nearest overflowing ancestor INSIDE `card`: the page and the card's fixed head must never move. */
export function revealRowInCard(card: Element | null, row: Element | null): void {
  if (card === null || row === null || !card.contains(row)) return
  let scroller: HTMLElement | null = row.parentElement
  while (scroller !== null && scroller !== card && scroller.scrollHeight <= scroller.clientHeight) {
    scroller = scroller.parentElement
  }
  /* v8 ignore next 1 -- a contained row's parent chain always reaches the card; the null bound is unreachable. */
  if (scroller === null || scroller === card) return
  const rb = row.getBoundingClientRect()
  const sb = scroller.getBoundingClientRect()
  // The row only has to reach the scrollport's VISIBLE slice: the pane often extends below the window fold.
  const visTop = Math.max(sb.top, 0)
  const visBottom = Math.min(sb.bottom, window.innerHeight)
  if (rb.top < visTop) scroller.scrollTop -= visTop - rb.top
  else if (rb.bottom > visBottom) scroller.scrollTop += rb.bottom - visBottom
}
