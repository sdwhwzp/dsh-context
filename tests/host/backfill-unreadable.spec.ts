import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { watchActivityBackfill } from '../../src/host/backfill'
import { arm, captureLogs, FAST_PACING, fakeState, trigger, unsupportedFormatError, until } from './helpers/backfill'
import { deferred } from './helpers/ctx'

describe('watchActivityBackfill host-refused logs', () => {
  test('a host-refused log reports unreadable instead of a fold failure and is retried on the next pass', async ({ onTestFinished }) => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'good', cwd: '/repo/good' } },
      { header: { id: 'corrupt', cwd: '/repo/corrupt' } },
    ])
    let refuse = true
    const readingAgain = deferred()
    const resume = deferred()
    const route = arm(ctx, state, {
      sessionPersistence: {
        open: async (id: string) => {
          if (id === 'corrupt' && refuse) {
            const error = new Error('stored log is corrupt: assistant/message repeats advertised tool call abc')
            error.name = 'SessionPersistenceCorruptionError'
            throw error
          }
          if (id === 'corrupt') {
            readingAgain.resolve()
            await resume.promise
          }
          return {
            header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
            inheritedEventCount: 0,
            read: async () => ({ events: [] }),
            close: async () => {},
          }
        },
      },
    })
    const lines = captureLogs(ctx)
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    onTestFinished(() => { resume.resolve(); handle() })
    await trigger(route)
    await until(() => (handle.coverage().complete ? true : undefined), 'the unreadable pass settled')
    assert.deepEqual(handle.coverage(), {
      complete: true,
      remaining: 0,
      failed: 0,
      running: false,
      total: 2,
      covered: 1,
      unsupported: 0,
      unreadable: 1,
      unreadableSessions: [{
        id: 'corrupt',
        reason: 'SessionPersistenceCorruptionError: stored log is corrupt: assistant/message repeats advertised tool call abc',
      }],
    })
    const warns = lines.filter(line => line.level === 'warn')
    assert.equal(warns.length, 1, 'one warn names the refused log')
    assert.match(warns[0].text, /cannot read "corrupt"/)
    assert.match(warns[0].text, /SessionPersistenceCorruptionError/)
    assert.ok(lines.some(line => line.level === 'info' && /left 1 session\(s\) unreadable/.test(line.text)))
    const refusal = { kind: 'unreadable', reason: handle.coverage().unreadableSessions?.[0].reason }
    assert.deepEqual(handle.statusOf?.('corrupt'), { running: false, refusal })
    refuse = false
    state.served.add('corrupt')
    await trigger(route)
    await readingAgain.promise
    assert.deepEqual(handle.statusOf?.('corrupt'), { running: true, refusal })
    resume.resolve()
    await until(
      () => (handle.coverage().unreadable === 0 && handle.coverage().covered === 2 ? true : undefined),
      'the next pass retried the log once the host could read it',
    )
    assert.deepEqual(handle.coverage(), {
      complete: true, remaining: 0, failed: 0, running: false, total: 2, covered: 2, unsupported: 0, unreadable: 0,
    })
    assert.equal(handle.statusOf?.('corrupt'), undefined)
  })

  test('unreadable detail is bounded, with truncated reasons available for every refused ID', async ({ onTestFinished }) => {
    const ctx = new Context()
    const ids = Array.from({ length: 17 }, (_, index) => `bad${index}`)
    const state = fakeState(ids.map(id => ({ header: { id, cwd: `/repo/${id}` } })))
    const route = arm(ctx, state, {
      sessionPersistence: {
        open: async () => {
          const error = new Error('x'.repeat(400))
          error.name = 'SessionPersistenceCorruptionError'
          throw error
        },
      },
    })
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    onTestFinished(handle)
    await trigger(route)
    await until(() => (handle.coverage().complete ? true : undefined), 'the unreadable pass settled')
    const coverage = handle.coverage()
    assert.equal(coverage.unreadable, 17)
    assert.equal(coverage.unreadableSessions?.length, 16, 'the detail stays bounded')
    assert.equal(coverage.unreadableSessions?.[0].id, 'bad0')
    const reason = coverage.unreadableSessions?.[0].reason ?? ''
    assert.ok(reason.endsWith('…'))
    assert.equal(reason.length, 181)
    assert.deepEqual(handle.statusOf?.('bad16'), { running: false, refusal: { kind: 'unreadable', reason } })
    assert.equal(coverage.failed, 0)
    assert.equal(coverage.remaining, 0)
  })

  test('retry transitions replace earlier refusals and removal discards the last reason', async ({ onTestFinished }) => {
    const ctx = new Context()
    const id = 'retry'
    const state = fakeState([{ header: { id, cwd: '/repo/retry' } }])
    const route = arm(ctx, state)
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    onTestFinished(handle)
    const run = async () => {
      await trigger(route)
      await until(() => !handle.coverage().running ? true : undefined, 'the retry settled')
    }

    state.failReads.set(id, new Error('temporary'))
    await run()
    assert.equal(handle.coverage().failed, 1)
    assert.deepEqual(handle.statusOf?.(id), { running: false, refusal: { kind: 'failed' } })
    for (const message of ['first refusal', 'updated refusal']) {
      const version = handle.version()
      const error = new Error(message)
      error.name = 'SessionPersistenceCorruptionError'
      state.failReads.set(id, error)
      await run()
      assert.equal(handle.coverage().complete, true)
      assert.equal(handle.coverage().failed, 0)
      assert.equal(handle.coverage().unreadable, 1)
      const reason = String(error)
      assert.deepEqual(handle.coverage().unreadableSessions, [{ id, reason }])
      assert.deepEqual(handle.statusOf?.(id), { running: false, refusal: { kind: 'unreadable', reason } })
      assert.ok(handle.version() > version)
    }

    state.failReads.set(id, unsupportedFormatError('SessionFormatUnsupportedError'))
    await run()
    assert.deepEqual(handle.statusOf?.(id), { running: false, refusal: { kind: 'unsupported' } })
    const unsupported = handle.coverage()
    assert.equal(unsupported.unsupported, 1)
    assert.equal(unsupported.covered, 0)
    assert.equal(unsupported.unreadableSessions, undefined)
    await run()
    assert.deepEqual(handle.coverage(), unsupported)
    assert.equal(state.coldReads.length, 4)

    state.listed = [{ header: { id } }]
    await run()
    assert.equal(handle.statusOf?.(id), undefined)
    assert.equal(handle.coverage().total, 0)
  })
})
