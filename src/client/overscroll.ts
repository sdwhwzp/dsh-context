/** WebKit ignores `overscroll-behavior-x: contain` (bug 240183) and still navigates, hence the canceled wheel below. */

/** Must be non-passive (React's wheel seat is passive); cancels only the horizontal-dominant gestures the scroller cannot consume. */
export function containHorizontalOverscroll(el: HTMLElement): () => void {
  const onWheel = (e: WheelEvent): void => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return
    const atStart = e.deltaX < 0 && el.scrollLeft <= 0
    // 1px tolerance: fractional device-pixel scroll offsets land just short of the exact end.
    const atEnd = e.deltaX > 0 && el.scrollLeft + el.clientWidth >= el.scrollWidth - 1
    if (atStart || atEnd) e.preventDefault()
  }
  el.addEventListener('wheel', onWheel, { passive: false })
  return () => { el.removeEventListener('wheel', onWheel) }
}
