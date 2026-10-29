export interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request, principal?: unknown) => Response | Promise<Response>
    }): () => void
  }
}

function fetchRouteRegistrar(connection: ConnectionHostFace | undefined) {
  return typeof connection?.fetch?.register === 'function'
    ? connection.fetch.register.bind(connection.fetch)
    : undefined
}

interface EffectScope {
  effect(effect: () => () => void, hint?: string): unknown
}

export function registerPostRoute(
  c: EffectScope,
  connection: ConnectionHostFace | undefined,
  path: string,
  fetch: (request: Request, principal?: unknown) => Response | Promise<Response>,
  label: string,
): boolean {
  const register = fetchRouteRegistrar(connection)
  if (register === undefined) return false
  try {
    c.effect(() => register({ path, methods: ['POST'], requestBody: 'buffered', fetch }), label)
  } catch {
    return false
  }
  return true
}

/** Authenticated deployments require an explicit session grant before plugin-owned reads. */
export async function canReadAccountSession(
  ctx: { get(name: string): unknown },
  principal: unknown,
  sessionId: string | undefined,
  signal: AbortSignal,
): Promise<boolean> {
  const access = ctx.get('principalAccess') as {
    resolve(principal: unknown, subjects: { sessionIds: string[] }, signal: AbortSignal):
    Promise<{ readableSessionIds: ReadonlySet<string> }>
  } | undefined
  if (access === undefined && principal === undefined && ctx.get('requestPrincipal') === undefined) return true
  if (access === undefined || principal === undefined || sessionId === undefined) return false
  const grant = await access.resolve(principal, { sessionIds: [sessionId] }, signal)
  return grant.readableSessionIds.has(sessionId)
}
