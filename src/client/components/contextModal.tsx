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
import { useSessionDetailWarm } from '../prefetch'
import { useTimelineSource } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { useConversationSurface } from './useConversationSurface'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeDetailNote } from './detailNote'
import { makeErrorBoundary } from './errorBoundary'
import { useEscapeClose } from './escapeClose'
import { makeLegend, makeStackedBar } from './stackedBar'

export interface ContextModalProps extends SessionStandardProps {
  /** Bound selector hook over the per-session open flag (hooks compartment). */
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
  /** Set by the input-overlay registration: the always-mounted gate warms this session's detail. */
  warm?: boolean
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

  /** Reads the open flag without mounting the reader: a closed modal must not subscribe to or fetch session data. */
  function ContextModalGate(props: ContextModalProps): ReactElement | null {
    // One warm-up per session, from the always-mounted input overlay: not a listener per assistant message. Only the
    // registration opts in, so a directly-mounted dialog keeps its closed-modal no-reader contract.
    const warm = props.warm === true
    useSessionDetailWarm(warm ? props.sessionId : undefined, warm ? props.useProjection : undefined)
    const open = typeof props.useContextModal === 'function' ? props.useContextModal(s => s) : false
    return open ? h(ContextModalBody, props) : null
  }

  /** Mounted only while open. */
  function ContextModalBody(props: ContextModalProps): ReactElement {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    // Shares the tab's per-session detail store, so an open tab's detail serves the modal with no refetch.
    const source = useTimelineSource(props)
    const data = source.data
    const pressure = projectionOf(props, 'contextPressure', contextPressureOf)
    const breakdown = projectionOf(props, 'contextBreakdown', contextBreakdownOf)
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    const convNodes = conversationNodesOf(props)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    const [dock, setDock] = useState({ left: 0, right: 0 })
    const anchorRef = useRef<HTMLSpanElement | null>(null)
    useConversationSurface(anchorRef, 'modal')
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

    useEscapeClose(true, close)

    // The shell anchor preserves track measurement while the body portal escapes skin filters and containing blocks.
    useLayoutEffect(() => {
      const dock = measureDock(anchorRef.current)
      setDock({ left: dock.left, right: dock.right })
      if (dock.frame === null) return undefined
      const observer = new MutationObserver(() => {
        const next = measureDock(anchorRef.current)
        setDock({ left: next.left, right: next.right })
      })
      observer.observe(dock.frame, { attributes: true, attributeFilter: ['style'] })
      return () => { observer.disconnect() }
    }, [])

    const head = data !== null ? headlineOf(data, pressure, breakdown) : null
    const subtitle = data !== null ? providerModelLabelOf(data.provider, data.model, data.reasoningEffort) : ''

    return (
      <>
        <span ref={anchorRef} hidden />
        {createPortal(
          <div className="lc-modal-backdrop" style={dock} onClick={close}>
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
    return h(ErrorBoundary, null, h(ContextModalGate, props))
  }
}
