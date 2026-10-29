import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import { assistantMessage, compaction, header, stepEnd, stepStart } from './helpers/events'

test('content subsets survive checkpoint suffix recovery and invalidate older checkpoint rows', async () => {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx as never)
  const dispose = registry.register(createContextTimelineDefinition({}, () => false) as never)
  try {
    await dispose
    const log = [
      { seq: 0, time: 0, type: 'session/created', data: {} },
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
      stepStart(2),
      assistantMessage(3, { content: [{ type: 'reasoning', text: 'first reasoning block' }, { type: 'text', text: 'first reply' }, { type: 'tool-call', name: 'read', arguments: '{}' }], usage: { inputTokens: 10, outputTokens: 20, reasoningTokens: 3 } }),
      stepEnd(4),
      assistantMessage(5, { content: [{ type: 'reasoning', text: 'second reasoning block' }, { type: 'text', text: 'second reply' }, { type: 'tool-call', name: 'read', arguments: '{}' }], usage: { inputTokens: 15, outputTokens: 30, reasoningTokens: 7 } }),
      compaction(6, 'summary', { shadowedSeqs: [3] }),
      assistantMessage(7, { content: [{ type: 'text', text: 'summary' }], surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }),
      { seq: 8, time: 8000, type: 'session/end-seed', data: { inherited: true } },
      assistantMessage(9, { content: [{ type: 'reasoning', text: 'own reasoning block' }, { type: 'text', text: 'own reply' }, { type: 'tool-call', name: 'read', arguments: '{}' }], usage: { inputTokens: 8, outputTokens: 12, reasoningTokens: 4 } }),
    ]
    const session = { id: 'reasoning-recovery', version: 1, createdAt: 1, cwd: '/tmp/reasoning-recovery', isSeeded: false }
    const prefix = registry.restore({}, log.slice(0, 5) as never, 0 as never, session as never, 0 as never)
    const row = prefix.checkpoint.contextTimeline
    assert.equal(row.ver, 36)
    const parsed = createContextTimelineDefinition({}, () => false).stateSchema.parse(row.val)
    assert.ok(parsed.assistantReasoning > 0)
    assert.equal(parsed.generatedReasoning, 3)
    assert.ok(parsed.assistantAnswerTokens > 0 && parsed.assistantCallTokens > 0)
    assert.ok((parsed.generatedAnswerTokens ?? 0) > 0 && (parsed.generatedCallTokens ?? 0) > 0)
    const cold = registry.restore({}, log as never, 0 as never, session as never, 0 as never)
    const suffix = registry.restore(prefix.checkpoint, log.slice(4) as never, 4 as never, session as never, 0 as never)
    assert.deepEqual(suffix, cold)
    const current = createContextTimelineDefinition({}, () => false).stateSchema.parse(cold.checkpoint.contextTimeline.val)
    assert.equal(current.generatedReasoning, 4)
    assert.equal(current.generatedAnswerTokens, 7)
    assert.equal(current.generatedCallTokens, 6)
    assert.deepEqual(current.billedGenerated, { reasoning: 4, answers: 4, calls: 4, unclassified: 0 })
    assert.equal(current.surface.some(node => node.seq === 3), false)
    const { billedGenerated: _billed, ...v34State } = parsed
    const { assistantAnswerTokens: _answers, assistantCallTokens: _calls, generatedAnswerTokens: _generatedAnswers, generatedCallTokens: _generatedCalls, ...v32State } = v34State
    const { assistantReasoning: _reasoning, generatedReasoning: _generated, ...v31State } = v32State
    for (const [ver, val] of [[31, v31State], [32, v32State], [34, v34State], [35, parsed]] as const) {
      const stale = { contextTimeline: { ...row, ver, val } }
      assert.equal(registry.viewCheckpoint(stale).contextTimeline, undefined)
      assert.deepEqual(registry.restore(stale, log as never, 0 as never, session as never, 0 as never), cold)
    }
  } finally {
    await dispose()
  }
})
