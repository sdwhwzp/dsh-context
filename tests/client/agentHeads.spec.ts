import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeAgentHeads, makeHeadFetcher } from '../../src/client/agentHeads'

function headResponse(model = 'deepseek-v4-flash'): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      value: { rev: 1, head: { ok: true, current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 0, total: 10 }, model } },
    }),
  }
}

describe('makeHeadFetcher', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('sends the head-only body and re-proves the served head', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return headResponse()
    })
    const head = await makeHeadFetcher('s1')!()
    assert.deepEqual(bodies, [{ sessionId: 's1', head: true }])
    assert.equal(head?.model, 'deepseek-v4-flash')
    assert.equal(head?.current.total, 10)
  })

  test('an empty session id arms no fetch; a failed or malformed read rejects', async () => {
    assert.equal(makeHeadFetcher(''), undefined)
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }))
    await assert.rejects(makeHeadFetcher('s1')!())
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { rev: 1, head: 7 } }),
    }))
    await assert.rejects(makeHeadFetcher('s1')!(), /malformed/)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    await assert.rejects(makeHeadFetcher('s1')!())
  })

  test('an absent value (the session left the live set) resolves null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    assert.equal(await makeHeadFetcher('s1')!(), null)
  })
})

describe('makeAgentHeads', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('one read per id replays the cached promise; the head:true body rides every miss', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return headResponse()
    })
    const heads = makeAgentHeads()
    const first = heads.headOf('s1')
    assert.ok(await first !== null)
    assert.ok(heads.headOf('s1') === first, 'the cached promise replays')
    assert.deepEqual(bodies, [{ sessionId: 's1', head: true }])
  })

  test('the page-lifetime map stays bounded; the oldest idle read is dropped first', async () => {
    vi.stubGlobal('fetch', async () => headResponse())
    const heads = makeAgentHeads()
    for (let i = 0; i < 130; i++) void heads.headOf(`s${i}`)
    // Re-read the oldest id: it was demoted, so its fetch fires again; the newest stays cached.
    const bodies: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push((JSON.parse(init.body) as { sessionId: string }).sessionId)
      return headResponse()
    })
    await heads.headOf('s129')
    await heads.headOf('s0')
    assert.deepEqual(bodies, ['s0'], 'only the demoted oldest id refetched')
  })

  test('a rejected read still caches (a broken session never hammers the route)', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      throw new Error('down')
    })
    const heads = makeAgentHeads()
    await heads.headOf('bad').catch(() => null)
    await heads.headOf('bad').catch(() => null)
    assert.equal(calls, 1)
  })
})
