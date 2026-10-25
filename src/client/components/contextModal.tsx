/** The `/context` command's centered dialog: the same pushed `contextTimeline` as the Context tab, distilled to the current
 * composition and the shared browser. */

import { createElement as h, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { createPortal } from 'react-dom'
import { providerModelLabelOf } from '../agentTree'
import { makeAttachmentOpener } from '../attachmentSource'
import { measureDock } from '../dockMeasure'
import { headlineOf } from '../headline'
import { modalStoreOf, takePendingConsume } from '../modalStore'
import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
import type { ContextSettings } from '../settings'
import { contextBreakdownOf, contextPressureOf, conversationNodesOf, headersOf, imageLoaderOf, projectionOf, sessionAddressOf, workspaceOf } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useTimelineSource } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeDetailNote } from './detailNote'
import { makeErrorBoundary } from './errorBoundary'
import { useEscapeClose } from './escapeClose'
import { makeLegend, makeStackedBar } from './stackedBar'

export interface ContextModalProps extends SessionStandardProps {
  /** Bound selector hook over the per-session open flag (hooks compartment). */
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
}

export function makeContextModal(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
): (props: ContextModalProps) => ReactElement | null {
  const { t } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const ContextBrowser = makeContextBrowser(kit, StackedBar, settings)
  const DetailNote = makeDetailNote(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  /** The slot outlet re-renders this body on a locale switch; the browser's memoized labels follow the prop. */
  function activeLocale(): string {
    const locale = ctx.locale
    /* v8 ignore next 1 -- older Host halves may serve no locale service; the live shell always does. */
    return typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
  }

  function ContextModalBody(props: ContextModalProps): ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const open = typeof props.useContextModal === 'function' ? props.useContextModal(s => s) : false
    // Shares the tab's per-session detail store, so an open tab's detail serves the modal with no refetch.
    const source = useTimelineSource(props)
    const data = source.data
    const pressure = projectionOf(props, 'contextPressure', contextPressureOf)
    const breakdown = projectionOf(props, 'contextBreakdown', contextBreakdownOf)
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    // Read unconditionally, before the closed early return, so hook order stays stable across open/close.
    const convNodes = conversationNodesOf(props)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    // Dock the mask beside the shell sidebar: 0 until the frame measure lands
    // (the layout effect below resolves it before first paint).
    const [dockInsets, setDockInsets] = useState({ left: 0, right: 0 })
    const anchorRef = useRef<HTMLSpanElement | null>(null)
    // Session-authorized durable-image loader for the browser's attachment cards, resolved through the harness `uiConversation` service
    // (`imageUrl`); absent service/session degrades the cards to metadata-only, never an error. Same parity as the Context tab.
    const loadImage = useMemo(
      () => imageLoaderOf(ctx, sessionId !== '' ? sessionId : undefined),
      [ctx, sessionId],
    )
    const openAttachment = useMemo(
      () => makeAttachmentOpener(ctx, sessionId !== '' ? sessionId : undefined, workspaceOf(ctx, sessionId !== '' ? sessionId : undefined)),
      [ctx, sessionId],
    )

    // A watch rebuild can remount this overlay before the declared inject re-fires: rebuild the fetchers when the face lands.
    const historyFace = useHistoryFace()

    const fetchContent = useMemo(
      () => (sessionId !== '' && historyFace !== undefined
        ? makeContentFetcher(() => sessionAddressOf(ctx, sessionId))
        : undefined),
      [ctx, sessionId, historyFace],
    )
    const fetchHeader = useMemo(
      () => (sessionId !== '' && historyFace !== undefined
        ? makeHeaderFetcher(() => sessionAddressOf(ctx, sessionId))
        : undefined),
      [ctx, sessionId, historyFace],
    )

    const close = useCallback(() => {
      if (sessionId === '') return
      modalStoreOf(sessionId).set(false)
      // The sessions service is read at CLOSE time because capturing it at apply would race the finer module composition.
      const guard = takePendingConsume(sessionId)
      const sessions = ctx.get('sessions') as SessionsFace | undefined
      if (guard === undefined || sessions === undefined) return
      const scope = sessions.scope(sessionId)
      if (scope !== undefined) scope.bail(scope, 'slash/input-consume-token', { guard })
    }, [ctx, sessionId])

    useEscapeClose(open, close)

    // Keep the measurement anchor in the composer; the body portal escapes its skin filters and containing blocks.
    // Dock the mask to the main column: measure both sidebar tracks once before
    // first paint, then follow the frame's inline template while open (sidebar
    // drags, collapse toggles and narrow-viewport re-solves all rewrite it).
    // An unresolved frame keeps the full-viewport mask.
    useLayoutEffect(() => {
      if (!open) return undefined
      const dock = measureDock(anchorRef.current)
      setDockInsets({ left: dock.left, right: dock.right })
      if (dock.frame === null) return undefined
      const observer = new MutationObserver(() => {
        const next = measureDock(anchorRef.current)
        setDockInsets({ left: next.left, right: next.right })
      })
      observer.observe(dock.frame, { attributes: true, attributeFilter: ['style'] })
      return () => { observer.disconnect() }
    }, [open])

    if (!open) return null

    const head = data !== null ? headlineOf(data, pressure, breakdown) : null
    const subtitle = data !== null ? providerModelLabelOf(data.provider, data.model, data.reasoningEffort) : ''

    return (
      <>
        <span ref={anchorRef} hidden />
        {createPortal(
          <div className="lc-modal-backdrop" style={dockInsets} onClick={close}>
            <div className="lc-modal-card lc-modal-fill" onClick={(ev) => { ev.stopPropagation() }}>
              <div className="lc-modal-head">
                <span className="lc-modal-title">{t('tab.context')}</span>
                <button className="lc-modal-close hover:text-(--dsw-alias-label-primary) hover:bg-(--dsw-alias-interactive-bg-hover)" aria-label={t('cmd.close')} onClick={close}>×</button>
              </div>

              {data === null || head === null ? (
                source.detailState === 'failed' ? (
                  <DetailNote state="failed" onRetry={source.retryDetail} />
                ) : (
                  <div className="lc-empty">{t('loading')}</div>
                )
              ) : (
                <div className="lc-modal-body">
                  <CurrentComposition
                    head={head}
                    subtitle={subtitle}
                    hoverKey={hoverCat}
                    onHoverKey={setHoverCat}
                  />
                  <ContextBrowser
                    data={data}
                    headers={headers}
                    convNodes={convNodes}
                    fetchContent={fetchContent}
                    fetchHeader={fetchHeader}
                    loadImage={loadImage}
                    openAttachment={openAttachment}
                    locale={activeLocale()}
                    hoverKey={hoverCat}
                    onHoverKey={setHoverCat}
                    detailState={source.detailState}
                    onDetailRetry={source.retryDetail}
                  />
                </div>
              )}
            </div>
          </div>,
          document.body,
        )}
      </>
    )
  }

  return function ContextModal(props: ContextModalProps): ReactElement | null {
    return h(ErrorBoundary, null, h(ContextModalBody, props))
  }
}
