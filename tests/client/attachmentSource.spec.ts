import assert from 'node:assert/strict'
import { afterEach, test, vi } from 'vitest'
import { makeAttachmentOpener } from '../../src/client/attachmentSource'
import { resetClientScope } from '../../src/client/timelineSource'
import type { AttachmentRef } from '../../src/shared/attachment'
import { asClientCtx, TestClientCtx } from './helpers/harness'

const FILE: AttachmentRef = { kind: 'file', attachmentId: 'sha256:shared', name: 'report.md' }

const SESSION = 'shared-session-id'

function opener() {
  const openResource = vi.fn()
  const ctx = new TestClientCtx({ services: { sidebarRight: { openResource } } })
  const open = makeAttachmentOpener(asClientCtx(ctx), SESSION, undefined)
  assert.ok(open)
  return { open, openResource }
}

function reply(account: string): Response {
  return Response.json({ ok: true, value: { path: `/synthetic/${account}/report.md` } })
}

afterEach(() => {
  resetClientScope(true)
  vi.unstubAllGlobals()
})

test.each([401, 403])('HTTP %i prevents reopening the same attachment after revocation', async (status) => {
  const fetch = vi.fn().mockResolvedValueOnce(reply('account-a')).mockResolvedValueOnce(new Response(null, { status }))
  vi.stubGlobal('fetch', fetch)
  const { open, openResource } = opener()
  assert.equal(await open(FILE), true)
  assert.equal(await open(FILE), false)
  assert.equal(openResource.mock.calls.length, 1)
  assert.deepEqual(fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]), [
    ['api/dsh-context/attachment', { sessionId: SESSION, attachmentId: FILE.attachmentId }],
    ['api/dsh-context/attachment', { sessionId: SESSION, attachmentId: FILE.attachmentId }],
  ])
})

test('switching accounts cancels a preview and ignores a reply that still arrives', async () => {
  let resolveOld!: (response: Response) => void
  const oldReply = new Promise<Response>(resolve => { resolveOld = resolve })
  const fetch = vi.fn().mockReturnValueOnce(oldReply).mockResolvedValueOnce(reply('account-b'))
  vi.stubGlobal('fetch', fetch)
  const { open, openResource } = opener()
  const oldOpen = open(FILE)
  resetClientScope(false)
  assert.equal(fetch.mock.calls[0]?.[1].signal.aborted, true)
  assert.equal(await open(FILE), false)
  resetClientScope(true)
  assert.equal(await open(FILE), true)
  resolveOld(reply('account-a'))
  assert.equal(await oldOpen, false)
  assert.equal(fetch.mock.calls.length, 2)
  assert.equal(openResource.mock.calls.length, 1)
  assert.match(String(openResource.mock.calls[0]?.[0]), /account-b/)
})

test('revocation cancels an older preview that still has an authorized response', async () => {
  let resolveOld!: (response: Response) => void
  const oldReply = new Promise<Response>(resolve => { resolveOld = resolve })
  const fetch = vi.fn().mockReturnValueOnce(oldReply).mockResolvedValueOnce(new Response(null, { status: 403 }))
  vi.stubGlobal('fetch', fetch)
  const { open, openResource } = opener()
  const oldOpen = open(FILE)
  assert.equal(await open(FILE), false)
  assert.equal(fetch.mock.calls[0]?.[1].signal.aborted, true)
  resolveOld(reply('account-a'))
  assert.equal(await oldOpen, false)
  assert.equal(openResource.mock.calls.length, 0)
})
