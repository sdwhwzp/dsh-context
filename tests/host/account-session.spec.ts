import { describe, expect, test } from 'vitest'
import { canReadAccountSession } from '../../src/host/connection'

describe('account session grants', () => {
  const signal = new AbortController().signal
  const principal = { id: '1' }
  const access = { resolve: async () => ({ readableSessionIds: new Set(['own']) }) }
  const ctx = (services: Record<string, unknown>) => ({ get: (name: string) => services[name] })

  test('permits single-user hosts without account services', async () => {
    expect(await canReadAccountSession(ctx({}), undefined, undefined, signal)).toBe(true)
  })

  test('requires the service, identity and session when account mode is present', async () => {
    for (const [services, caller, session] of [
      [{ requestPrincipal: {} }, undefined, 'own'],
      [{}, principal, 'own'],
      [{ principalAccess: access }, undefined, 'own'],
      [{ principalAccess: access }, principal, undefined],
    ] as const) {
      expect(await canReadAccountSession(ctx(services), caller, session, signal)).toBe(false)
    }
  })

  test('requires the exact session in the resolved grant', async () => {
    expect(await canReadAccountSession(ctx({ principalAccess: access }), principal, 'own', signal)).toBe(true)
    expect(await canReadAccountSession(ctx({ principalAccess: access }), principal, 'foreign', signal)).toBe(false)
  })
})
