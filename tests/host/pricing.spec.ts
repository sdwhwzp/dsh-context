import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  estimateMessage,
  estimateToolSchema,
  estimateToolsTotal,
  firstText,
  imageCountOf,
  injectionSourceName,
  isInjection,
  toolCallNames,
} from '../../src/host/pricing'
import type { ContentBlock } from '../../src/host/pricing'

describe('estimateToolsTotal', () => {
  test('an empty tool list prices zero; a non-empty one prices the whole-array JSON plus one block', () => {
    assert.equal(estimateToolsTotal([]), 0)
    const tools = [{ name: 'bash', description: 'run a command' }]
    assert.equal(estimateToolsTotal(tools), Math.ceil(JSON.stringify(tools).length / 4) + 4)
  })
})

describe('estimateMessage', () => {
  test('text, reasoning, tool-call, retired wrapper and unknown blocks price their own arm plus block and role overhead', () => {
    // 16 chars → 4, +4 block, +4 role
    assert.equal(estimateMessage({ content: [{ type: 'text', text: '0123456789abcdef' }] }), 12)
    assert.equal(estimateMessage({ content: [{ type: 'reasoning', text: '0123456789abcdef' }] }), 12)
    assert.equal(estimateMessage({ content: [{ type: 'text' }] }), 8, 'a text block with no text is overhead only')
    // 'bash' → 1, '{}' → 1, +4 block, +4 role
    assert.equal(estimateMessage({ content: [{ type: 'tool-call', name: 'bash', arguments: '{}' }] }), 10)
    assert.equal(estimateMessage({ content: [{ type: 'tool-call' }] }), 8)
    // The supported log generation carries no wrapper blocks; a hostile one prices through the structural-JSON arm.
    for (const block of [
      { type: 'tool-result', content: [{ type: 'text', text: 'ok' }] },
      { type: 'mystery', payload: { a: 1 } },
    ]) {
      assert.equal(estimateMessage({ content: [block] }), 4 + Math.ceil(JSON.stringify(block).length / 4) + 4)
    }
  })

  test('image blocks price through the vision calculator only with two finite dimensions', () => {
    assert.equal(
      estimateMessage({ content: [{ type: 'image', attachment: { width: 800, height: 600 } }] }),
      341 + 8,
    )
    for (const attachment of [null, 'ref', { width: 800 }, { width: NaN, height: 100 }]) {
      const block = { type: 'image', attachment } as unknown as ContentBlock
      assert.equal(estimateMessage({ content: [block] }), Math.ceil(JSON.stringify(block).length / 4) + 8, JSON.stringify(attachment))
    }
  })

  test('a message without an array content pays role framing only; emptyIsZero short-circuits empties to zero', () => {
    assert.equal(estimateMessage({}), 4)
    assert.equal(estimateMessage({ content: 'not-an-array' as never }), 4)
    assert.equal(estimateMessage(null), 4)
    assert.equal(estimateMessage(undefined), 4)
    assert.equal(estimateMessage(null, true), 0)
    assert.equal(estimateMessage(undefined, true), 0)
    assert.equal(estimateMessage({}, true), 0)
    assert.equal(estimateMessage({ content: [] }, true), 0)
    assert.equal(estimateMessage({ content: 'x' as never }, true), 0)
    assert.equal(estimateMessage({ content: [{ type: 'text', text: 'abcd' }] }, true), 9)
  })
})

describe('estimateToolSchema', () => {
  test('prices the tool JSON plus one block', () => {
    const tool = { name: 'bash' }
    assert.equal(estimateToolSchema(tool), Math.ceil(JSON.stringify(tool).length / 4) + 4)
  })
})

describe('imageCountOf', () => {
  test('counts image blocks, recursing into nested content; non-array input counts zero', () => {
    assert.equal(imageCountOf([
      { type: 'image' },
      { type: 'tool-result', content: [{ type: 'image' }, { type: 'text', text: 'x' }] },
      { type: 'text', text: 'y' },
    ]), 2)
    assert.equal(imageCountOf(undefined), 0)
    assert.equal(imageCountOf('x' as never), 0)
  })
})

describe('firstText', () => {
  test('returns the first non-blank text block, whitespace-normalized and truncated to 80', () => {
    const long = 'word '.repeat(30) // 150 chars
    const out = firstText([{ type: 'text', text: long }])
    assert.equal(out.length, 80)
    assert.ok(!out.includes('  '))
  })

  test('skips non-text blocks, non-string text, and whitespace-only text; non-array input yields empty', () => {
    assert.equal(firstText([
      { type: 'image' },
      { type: 'text' },
      { type: 'text', text: '   \n\t ' },
      { type: 'text', text: '  real   text ' },
    ]), 'real text')
    assert.equal(firstText(undefined), '')
    assert.equal(firstText(null as never), '')
  })
})

describe('toolCallNames', () => {
  test('collects tool-call block names in order; non-array input yields an empty list', () => {
    assert.deepEqual(toolCallNames([
      { type: 'tool-call', name: 'bash' },
      { type: 'text', text: 'x' },
      { type: 'tool-call', name: 'read' },
      { type: 'tool-call' }, // no name: skipped
    ]), ['bash', 'read'])
    assert.deepEqual(toolCallNames(undefined), [])
  })
})

describe('injectionSourceName', () => {
  test('agent-instructions sources name their deduped change paths; plugin ids, kinds, and unreadable sources degrade', () => {
    assert.equal(injectionSourceName({
      kind: 'agent-instructions',
      changes: [{ path: 'AGENTS.md' }, { path: 'AGENTS.md' }, { path: 'docs/TEAM.md' }],
    }), 'AGENTS.md, docs/TEAM.md')
    assert.equal(injectionSourceName({
      kind: 'agent-instructions',
      changes: [null, { path: '' }, { path: 'A.md' }],
    }), 'A.md')
    for (const source of [
      { kind: 'agent-instructions', changes: [null] },
      { kind: 'agent-instructions', changes: [] },
      { kind: 'agent-instructions' },
    ]) {
      assert.equal(injectionSourceName(source), 'agent-instructions')
    }
    assert.equal(injectionSourceName({ kind: 'plugin', plugin: 'dsh-agent-presets' }), 'dsh-agent-presets')
    assert.equal(injectionSourceName({ kind: 'plugin', plugin: '' }), 'plugin')
    assert.equal(injectionSourceName({ kind: 'goal' }), 'goal')
    assert.equal(injectionSourceName({ kind: '' }), '')
    assert.equal(injectionSourceName({}), '')
    assert.equal(injectionSourceName(undefined), '', 'a missing source degrades to empty instead of throwing (issue #69)')
    assert.equal(injectionSourceName(null), '')
  })
})

describe('isInjection', () => {
  test('any non-user kind or a transport form marks an injection; null and plain user sources do not', () => {
    assert.equal(isInjection(null), false)
    assert.equal(isInjection(undefined), false)
    assert.equal(isInjection({ kind: 'user' }), false)
    assert.equal(isInjection({ kind: '' }), false)
    assert.equal(isInjection({}), false)
    assert.equal(isInjection({ kind: 'plugin', form: 'notice' }), true)
    // Any transport form marks an injection even with kind 'user' (the 'user-rpc' spelling).
    assert.equal(isInjection({ kind: 'user', form: 'rpc' }), true)
    assert.equal(isInjection({ form: 'notice' }), true)
  })
})

describe('hostile block shapes', () => {
  test('null and primitive elements degrade to overhead instead of throwing', () => {
    const junk = [null, 7, 'x'] as never
    assert.ok(estimateMessage({ content: junk }) > 0)
    assert.equal(imageCountOf(junk), 0)
    assert.equal(firstText(junk), '')
    assert.deepEqual(toolCallNames(junk), [])
    const nested = [{ type: 'tool-result', content: [null, { type: 'image' }] }] as never
    assert.equal(imageCountOf(nested), 1)
    assert.ok(estimateMessage({ content: nested }) > 0)
  })
})
