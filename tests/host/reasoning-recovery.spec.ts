import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import { assistantMessage, compaction, header, stepEnd, stepStart } from './helpers/events'

test('reasoning totals survive checkpoint suffix recovery and invalidate a v31 row', async () => {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx as never)
  const dispose = registry.register(createContextTimelineDefinition({}, () => false) as never)
  try {
    await dispose
    const log = [
      { seq: 0, time: 0, type: 'session/created', data: {} },
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
      stepStart(2),
      assistantMessage(3, { content: [{ type: 'reasoning', text: 'first reasoning block' }], usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 3 } }),
      stepEnd(4),
      assistantMessage(5, { content: [{ type: 'reasoning', text: 'second reasoning block' }], usage: { inputTokens: 15, outputTokens: 30, reasoningTokens: 7 } }),
      compaction(6, 'summary', { shadowedSeqs: [3] }),
      assistantMessage(7, { content: [{ type: 'text', text: 'summary' }], surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }),
      { seq: 8, time: 8000, type: 'session/end-seed', data: { inherited: true } },
      assistantMessage(9, { content: [{ type: 'reasoning', text: 'own reasoning block' }], usage: { inputTokens: 8, outputTokens: 12, reasoningTokens: 4 } }),
    ]
    const session = { id: 'reasoning-recovery', version: 1, createdAt: 1, cwd: '/tmp/reasoning-recovery', isSeeded: false }
    const prefix = registry.restore({}, log.slice(0, 5) as never, 0 as never, session as never, 0 as never)
    const row = prefix.checkpoint.contextTimeline
    assert.equal(row.ver, 32)
    const parsed = createContextTimelineDefinition({}, () => false).stateSchema.parse(row.val)
    assert.ok(parsed.assistantReasoning > 0)
    assert.equal(parsed.generatedReasoning, 3)
    const cold = registry.restore({}, log as never, 0 as never, session as never, 0 as never)
    const suffix = registry.restore(prefix.checkpoint, log.slice(4) as never, 4 as never, session as never, 0 as never)
    assert.deepEqual(suffix, cold)
    const current = createContextTimelineDefinition({}, () => false).stateSchema.parse(cold.checkpoint.contextTimeline.val)
    assert.equal(current.generatedReasoning, 4)
    assert.equal(current.surface.some(node => node.seq === 3), false)
    const { assistantReasoning: _reasoning, generatedReasoning: _generated, ...oldState } = parsed
    const stale = { contextTimeline: { ...row, ver: 31, val: oldState } }
    assert.equal(registry.viewCheckpoint(stale).contextTimeline, undefined)
    assert.deepEqual(registry.restore(stale, log as never, 0 as never, session as never, 0 as never), cold)
  } finally {
    await dispose()
  }
})
