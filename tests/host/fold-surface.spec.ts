import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { assistantMessage, at, compaction, toolCall, toolResult, userMessage } from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]

describe('applySurface assistant branch', () => {
  test('assistant text lands on the node preview; a text-less message lists its tool-call names capped at three, or neither', () => {
    const spoken = driveTimeline([assistantMessage(1, { content: text('hello world') })]).state.surface.at(-1)
    assert.equal(spoken?.text, 'hello world')
    assert.equal(spoken?.cat, 'assistant')
    const named = driveTimeline([assistantMessage(1, {
      content: [
        { type: 'tool-call', name: 'bash', arguments: '{}' },
        { type: 'tool-call', name: 'read', arguments: '{}' },
        { type: 'tool-call', name: 'edit', arguments: '{}' },
        { type: 'tool-call', name: 'grep', arguments: '{}' },
      ],
    })]).state.surface.at(-1)
    assert.equal(named?.text, undefined)
    assert.deepEqual(named?.calls, ['bash', 'read', 'edit'])
    const unnamed = driveTimeline([assistantMessage(1, { content: [{ type: 'tool-call', arguments: '{}' }] })]).state.surface.at(-1)
    assert.equal(unnamed?.text, undefined)
    assert.equal(unnamed?.calls, undefined)
  })
})

describe('applySurface tool/result branch', () => {
  test('a source callId armed by tool/call names the node, is consumed, and leaves other pending calls armed', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolCall(2, { callId: 'c2', name: 'read' }),
      toolResult(3, { callId: 'c1', content: text('ok') }),
    ])
    const node = state.surface.at(-1)
    assert.equal(node?.tool, 'bash')
    assert.equal(node?.err, undefined, 'no error flag without the message mark')
    assert.deepEqual(Object.keys(state.callNames), ['c2'], 'the consumed entry leaves the persisted map')
    assert.equal(state.callNames.c2?.name, 'read', 'the unanswered call stays armed')
  })

  test('an untraced result with an unknown or missing source callId pairs nothing and leaves callNames untouched', () => {
    const unknown = driveTimeline([toolResult(1, { callId: 'ghost', content: text('ok') })]).state
    assert.equal(unknown.surface.at(-1)?.tool, undefined)
    assert.deepEqual(unknown.callNames, {})
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 2, time: at(),
      data: { message: { role: 'tool', toolCallId: 'keep', content: text('ok') } },
      surfaceOp: 'append',
    }
    const sourceless = driveTimeline([toolCall(1, { callId: 'keep', name: 'read' }), ev]).state
    assert.equal(sourceless.surface.at(-1)?.tool, undefined)
    assert.equal(sourceless.callNames.keep?.name, 'read')
  })

  test('the message isError flags the node; the retired envelope-only mark no longer does', () => {
    const flagged = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolResult(2, { callId: 'c1', content: text('boom'), error: true }),
    ]).state.surface.at(-1)
    assert.deepEqual([flagged?.err, flagged?.tool], [true, 'bash'], 'the message mark flags while the source callId still pairs')
    // The pre-V4 spelling (an event-level `data.error` with no message mark) is unreachable through the
    // supported harnesses' admission validation; a hostile replay carrying it degrades to an unflagged node.
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 2, time: at(),
      data: {
        error: true,
        message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: text('boom') },
      },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([toolCall(1, { callId: 'c1', name: 'bash' }), ev])
    assert.deepEqual([state.surface.at(-1)?.err, state.surface.at(-1)?.tool], [undefined, 'bash'])
  })
})

describe('applySurface user-message previews', () => {
  test('skill sources carry the skill name, or ? when nameless; the catalog joins the bucket unnamed', () => {
    const named = driveTimeline([userMessage(1, text('run it'), { kind: 'skill-invocation', name: 'pdf' })]).state
    assert.equal(named.surface.at(-1)?.skill, 'pdf')
    assert.equal(named.surface.at(-1)?.cat, 'skill')
    const nameless = driveTimeline([userMessage(1, text('run it'), { kind: 'skill-invocation' })]).state
    assert.equal(nameless.surface.at(-1)?.skill, '?')
    const catalog = driveTimeline([userMessage(1, text('<available_skills>'), { kind: 'skill-catalog', form: 'catalog' })]).state
    assert.equal(catalog.surface.at(-1)?.cat, 'skill')
    assert.equal(catalog.surface.at(-1)?.skill, undefined)
    assert.equal(catalog.surface.at(-1)?.form, 'catalog')
  })

  test('plugin notice sources preview the summary; snapshots join section names, skipping nulls, truncated to 80', () => {
    const notice = driveTimeline([
      userMessage(1, text('injected'), { kind: 'plugin', form: 'notice', plugin: 'dsh-x', summary: 'Skill injected (pdf)' }),
    ]).state.surface.at(-1)
    assert.equal(notice?.text, 'Skill injected (pdf)')
    assert.equal(notice?.form, 'notice')
    const sections = [{ name: 'a'.repeat(50) }, null, { name: 'b'.repeat(50) }, {}]
    const snapshot = driveTimeline([
      userMessage(1, text('snapshot'), { kind: 'plugin', form: 'snapshot', sections }),
    ]).state.surface.at(-1)
    const expected = `${'a'.repeat(50)}, ${'b'.repeat(50)}`.slice(0, 80)
    assert.equal(expected.length, 80, 'fixture must actually exceed the truncation bound')
    assert.equal(snapshot?.text, expected)
  })

  test('other plugin forms preview the first text, or nothing without one', () => {
    const withText = driveTimeline([
      userMessage(1, text('plain body'), { kind: 'plugin', form: 'instructions' }),
    ]).state
    assert.equal(withText.surface.at(-1)?.text, 'plain body')
    const empty = driveTimeline([userMessage(1, [], { kind: 'plugin', form: 'instructions' })]).state
    assert.equal(empty.surface.at(-1)?.text, undefined)
  })

  test('a plain user message previews its text and image count, or nothing without text', () => {
    const withText = driveTimeline([userMessage(1, text('hi there'))]).state
    const node = withText.surface.at(-1)
    assert.equal(node?.text, 'hi there')
    assert.equal(node?.cat, 'user')
    assert.equal(node?.form, undefined, 'no source, no form stamp')
    const empty = driveTimeline([userMessage(1, [])]).state
    assert.equal(empty.surface.at(-1)?.text, undefined)
    const image = driveTimeline([
      userMessage(1, [{ type: 'image', attachment: { width: 800, height: 600 } }]),
    ]).state.surface.at(-1)
    assert.equal(image?.imgs, 1)
  })
})

describe('shadow-price claim lifecycle', () => {
  test('the next surface event consumes and DELETES the armed claim', () => {
    const { state } = driveTimeline([
      compaction(1, 'summary', { shadowedTokenCount: 10, shadowedSeqs: [1] }),
      userMessage(2, text('after')),
    ])
    assert.ok(!('pendingShadowedSeqs' in state), 'consumed claims are deleted, not undefined-valued')
    assert.ok(!('pendingShadowEventSeq' in state))
    assertPlainJson(state)
  })
})

describe('surfaceOp variants', () => {
  const big = 'a'.repeat(16) // 12 tokens: ceil(16/4) + 4 block + 4 role

  test('a null, non-object, or non-replace surfaceOp appends', () => {
    for (const surfaceOp of [null, 'append', undefined, { op: 'insert', startSeq: 0, endSeq: 0 }]) {
      const ev: TimelineEvent = { type: 'user/message', seq: 1, time: at(), data: { content: text('x') }, surfaceOp }
      const { state } = driveTimeline([ev])
      assert.deepEqual(state.surface.map(n => n.seq), [1], JSON.stringify(surfaceOp))
    }
  })

  test('a replace with an armed claim removes by seqs and rewrites the metering event net-freed, clamped at zero', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)), // 12 tokens
      userMessage(2, text(big)), // 12 tokens
      userMessage(3, text(big)), // 12 tokens — NOT shadowed, survives the replace
      compaction(4, 'summary', { shadowedTokenCount: 100, shadowedSeqs: [1, 2] }),
      userMessage(5, text('bbbbbbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }), // 10 tokens
    ])
    assert.deepEqual(
      [state.surface.map(n => n.seq), state.sums.user, state.archived.map(n => [n.seq, n.gone]), state.events[0].tokens],
      [[3, 5], 22, [[1, 5], [2, 5]], 14],
      'removed nodes archived as stamped copies, the metering row rewritten net-freed',
    )
    assertPlainJson(state)
    const clamped = driveTimeline([
      userMessage(1, text(big)), // 12 tokens
      compaction(2, 'prune', { shadowedTokenCount: 12, shadowedSeqs: [1] }),
      userMessage(3, text('x'.repeat(400)), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }), // 108 tokens
    ]).state
    assert.equal(clamped.events[0].tokens, 0)
    assert.equal(clamped.sums.user, 108)
  })

  test('the range path splices in place and never rewrites the metering event; missing endpoints append', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')), // 9 tokens
      userMessage(2, text('bbbb')), // 9 tokens
      compaction(3, 'summary', { shadowedTokenCount: 50, shadowedSeqs: [] }),
      userMessage(4, text('cccc'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [4], 'range replace splices the node in place')
    assert.equal(state.sums.user, 9)
    assert.deepEqual(state.archived.map(n => n.seq), [1, 2])
    assert.equal(state.events[0].tokens, 50, 'the range path never rewrites the metering event')
    assert.ok(!('pendingShadowedSeqs' in state))
    const single = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb')),
      userMessage(3, text('cccc')),
      userMessage(4, text('dddddddd'), undefined, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }),
    ]).state
    assert.deepEqual(single.surface.map(n => n.seq), [1, 4, 3])
    assert.deepEqual(single.archived.map(n => [n.seq, n.gone]), [[2, 4]])
    for (const surfaceOp of [{ op: 'replace', startSeq: 99, endSeq: 100 }, { op: 'replace', startSeq: 1, endSeq: 99 }]) {
      const missing = driveTimeline([
        userMessage(1, text('aaaa')),
        userMessage(2, text('bbbb'), undefined, { surfaceOp }),
      ]).state
      assert.deepEqual(missing.surface.map(n => n.seq), [1, 2], JSON.stringify(surfaceOp))
    }
  })

  test('restored state: a claim whose metering event cannot be rewritten skips the rewrite', () => {
    // A checkpoint restore may carry the claim fields partially — def.apply accepts any TimelineState.
    const def = timelineDef({})
    const base = driveTimeline([userMessage(1, text(big))]).state
    const withoutSeq = def.apply(
      { ...base, pendingShadowedSeqs: [1] },
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    )
    assert.deepEqual(withoutSeq.surface.map(n => n.seq), [2])
    assert.equal(withoutSeq.archived.length, 1)
    assert.equal(withoutSeq.events.length, 0, 'no event to rewrite, no crash')
    assert.ok(!('pendingShadowedSeqs' in withoutSeq))
    assertPlainJson(withoutSeq)
    const missingEvent = def.apply(
      { ...base, pendingShadowedSeqs: [1], pendingShadowEventSeq: 999 },
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    )
    assert.deepEqual(missingEvent.surface.map(n => n.seq), [2])
    assert.equal(missingEvent.events.length, 0)
    assert.ok(!('pendingShadowEventSeq' in missingEvent))
  })
})
