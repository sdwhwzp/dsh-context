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
  if (sessionId === undefined) return !isAccountRequest(ctx, principal)
  return (await readableAccountSessions(ctx, principal, [sessionId], signal)).length > 0
}

export function isAccountRequest(ctx: { get(name: string): unknown }, principal: unknown): boolean {
  return principal !== undefined || ctx.get('principalAccess') !== undefined || ctx.get('requestPrincipal') !== undefined
}

export async function readableAccountSessions(
  ctx: { get(name: string): unknown },
  principal: unknown,
  sessionIds: readonly string[],
  signal: AbortSignal,
): Promise<string[]> {
  signal.throwIfAborted()
  if (sessionIds.length === 0) return []
  if (!isAccountRequest(ctx, principal)) {
    return [...sessionIds]
  }
  const grant = await resolveAccountReads(ctx, principal, { sessionIds }, signal)
  return sessionIds.filter(id => grant?.readableSessionIds.has(id))
}

interface ReadSubjects {
  sessionIds: readonly string[]
  workspaceIds?: readonly string[]
  attachmentIds?: readonly string[]
}

interface ReadGrant {
  readableSessionIds: ReadonlySet<string>
  readableWorkspaceIds?: ReadonlySet<string>
  readableAttachmentIds?: ReadonlySet<string>
}

export interface PrincipalAccessFace {
  resolve?(principal: unknown, subjects: ReadSubjects, signal: AbortSignal): Promise<ReadGrant>
  assertAuthenticated?(principal: unknown): void | Promise<void>
}

export class AccountAccessUnavailableError extends Error {
  constructor(cause?: unknown) {
    super('account access unavailable', { cause })
  }
}

export async function isActiveAccount(
  ctx: { get(name: string): unknown },
  principal: unknown,
  signal: AbortSignal,
): Promise<boolean> {
  if (principal == null || signal.aborted) return false
  try {
    const access = ctx.get('principalAccess') as PrincipalAccessFace | undefined
    if (typeof access?.resolve !== 'function' || typeof access.assertAuthenticated !== 'function') return false
    await access.assertAuthenticated(principal)
    return !signal.aborted
  } catch {
    return false
  }
}

export async function resolveAccountReads(
  ctx: { get(name: string): unknown },
  principal: unknown,
  subjects: ReadSubjects,
  signal: AbortSignal,
): Promise<ReadGrant | null> {
  signal.throwIfAborted()
  if (principal == null) return null
  try {
    const access = ctx.get('principalAccess') as PrincipalAccessFace | undefined
    if (typeof access?.resolve !== 'function') return null
    const grant = await access.resolve(principal, subjects, signal)
    signal.throwIfAborted()
    return grant
  } catch (error) {
    signal.throwIfAborted()
    throw new AccountAccessUnavailableError(error)
  }
}
