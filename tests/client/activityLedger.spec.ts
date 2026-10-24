import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { activityOf, costFullyQuantified } from '../../src/client/activityLedger'

describe('activityOf', () => {
  test('absent or non-record values stay null (an older host serves no such key)', () => {
    assert.equal(activityOf(null), null)
    assert.equal(activityOf(undefined), null)
    assert.equal(activityOf(7), null)
    assert.equal(activityOf('x'), null)
    assert.equal(activityOf({}), null, 'a record without a days map')
    assert.equal(activityOf({ days: 7 }), null)
    assert.equal(activityOf({ days: [] }), null, 'an array is not a ledger')
  })

  test('a well-formed payload passes through untouched (reference-stable)', () => {
    const wire = { days: { '2026-09-16': { tokens: 15, requests: 1 }, '2026-09-15': { tokens: 0, requests: 3 } } }
    assert.ok(activityOf(wire) === (wire as never))
    assert.deepEqual(activityOf({ days: {} }), { days: {} })
  })

  test('malformed entries drop individually; the readable days survive', () => {
    const out = activityOf({
      days: {
        '2026-09-16': { tokens: 15, requests: 1 },
        '09-16': { tokens: 1, requests: 1 },
        '2026-09-17': null,
        '2026-09-18': [1, 2],
        '2026-09-19': { tokens: 'x', requests: 1 },
        '2026-09-20': { tokens: Number.NaN, requests: 1 },
        '2026-09-21': { tokens: -3, requests: 1 },
        '2026-09-22': { tokens: 1, requests: 'x' },
        '2026-09-23': { tokens: 1, requests: Number.POSITIVE_INFINITY },
        '2026-09-24': { tokens: 1, requests: -1 },
      },
    })
    assert.deepEqual(out, { days: { '2026-09-16': { tokens: 15, requests: 1 } } })
  })

  test('a well-formed pricing record rides both the pass-through and the sanitized copy', () => {
    const cost = { deepseek: { 'deepseek-v4': { peak: { uncached: 10, cacheRead: 5, cacheWrite: 0, output: 2 } } } }
    const wire = { days: { '2026-09-16': { tokens: 15, requests: 1, cost } } }
    assert.ok(activityOf(wire) === (wire as never))
    const dirty = { days: { '2026-09-16': { tokens: 15, requests: 1, cost }, '09-16': { tokens: 1, requests: 1 } } }
    assert.deepEqual(activityOf(dirty), { days: { '2026-09-16': { tokens: 15, requests: 1, cost } } })
  })

  test('a malformed pricing record drops the fee whole; the day survives', () => {
    const out = activityOf({
      days: {
        '2026-09-16': { tokens: 15, requests: 1, cost: 'x' },
        '2026-09-15': { tokens: 3, requests: 1, cost: { deepseek: 7 } },
      },
    })
    assert.deepEqual(out, {
      days: { '2026-09-16': { tokens: 15, requests: 1 }, '2026-09-15': { tokens: 3, requests: 1 } },
    })
  })

  test('a sparse bucket rides by reference; a garbage leaf repairs its own day only', () => {
    const sparse = { deepseek: { 'deepseek-v4': { peak: { uncached: 1 } } } }
    const sparseWire = { days: { '2026-09-16': { tokens: 15, requests: 1, cost: sparse } } }
    assert.ok(activityOf(sparseWire) === (sparseWire as never), 'missing fields are not malformed')
    const garbage = { deepseek: { 'deepseek-v4': { peak: { uncached: 'x', cacheRead: 5, cacheWrite: 0, output: 2 } } } }
    const mixed = activityOf({
      days: {
        '2026-09-16': { tokens: 15, requests: 1, cost: garbage },
        '2026-09-15': { tokens: 3, requests: 1 },
      },
    })
    assert.deepEqual(mixed, {
      days: {
        '2026-09-16': { tokens: 15, requests: 1, cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 0, cacheRead: 5, cacheWrite: 0, output: 2 } } } } },
        '2026-09-15': { tokens: 3, requests: 1 },
      },
    }, 'the malformed leaf zero-fills; the sibling day rides untouched')
  })

  test('empty fee and skill records drop (costOf and skillTalliesOf answered undefined for them)', () => {
    const out = activityOf({
      days: {
        '2026-09-16': { tokens: 15, requests: 1, cost: {} },
        '2026-09-15': { tokens: 3, requests: 1, skills: {} },
      },
    })
    assert.deepEqual(out, {
      days: { '2026-09-16': { tokens: 15, requests: 1 }, '2026-09-15': { tokens: 3, requests: 1 } },
    })
  })

  test('the clean proof reads own keys only; an inherited key neither proves nor drops a record', () => {
    const day = Object.assign(Object.create({ injected: { tokens: 1, requests: 1 } }), { tokens: 15, requests: 1 })
    const wire = { days: Object.assign(Object.create({ '1999-01-01': { tokens: 1, requests: 1 } }), { '2026-09-16': day }) }
    assert.ok(activityOf(wire) === (wire as never))
  })

  test('a malformed fee repairs deterministically: a bad level drops, a bad leaf zero-fills', () => {
    const inheritedCost = Object.assign(Object.create({ 'injected-model': { peak: { uncached: 1, cacheRead: 1, cacheWrite: 1, output: 1 } } }), {})
    const cases: [unknown, unknown][] = [
      [inheritedCost, undefined],
      [{}, undefined],
      [{ deepseek: 7 }, undefined],
      [{ deepseek: [1] }, undefined],
      [{ deepseek: { 'deepseek-v4': [1] } }, { deepseek: {} }],
      [{ deepseek: { 'deepseek-v4': 7 } }, { deepseek: {} }],
      [{ deepseek: { 'deepseek-v4': { peak: { uncached: 1, cacheRead: 1, cacheWrite: 1, output: 'x' } } } },
        { deepseek: { 'deepseek-v4': { peak: { uncached: 1, cacheRead: 1, cacheWrite: 1, output: 0 } } } }],
    ]
    for (const [cost, expected] of cases) {
      const out = activityOf({ days: { '2026-09-16': { tokens: 1, requests: 1, cost } } })
      const day = (out as unknown as { days: Record<string, Record<string, unknown>> }).days['2026-09-16']
      assert.deepEqual(day.cost ?? undefined, expected, `cost fixture ${JSON.stringify(cost)}`)
      assert.deepEqual(day.tokens, 1)
    }
  })

  test('the skill proof fails exactly where the old dirty flag fired', () => {
    const inheritedSkills = Object.assign(Object.create({ ghost: { n: 1, last: 1 } }), { tdd: { n: 2, last: 3 } })
    const rebuilt = activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: inheritedSkills } } })
    assert.deepEqual((rebuilt as unknown as { days: Record<string, Record<string, unknown>> }).days['2026-09-16'].skills, { tdd: { n: 2, last: 3 } })
    const dropped = activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: { tdd: 7 } } } })
    assert.deepEqual((dropped as unknown as { days: Record<string, Record<string, unknown>> }).days['2026-09-16'].skills, undefined)
    const array = activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: [1] } } })
    assert.deepEqual((array as unknown as { days: Record<string, Record<string, unknown>> }).days['2026-09-16'].skills, undefined)
    const badTally = activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: { tdd: { n: -1, last: 3 } } } } })
    assert.deepEqual((badTally as unknown as { days: Record<string, Record<string, unknown>> }).days['2026-09-16'].skills, undefined)
    // An own-key-less table (only inherited keys) dirties too: the rebuild's own-key walk would find nothing.
    const inheritedOnly = Object.create({ ghost: { n: 1, last: 1 } }) as Record<string, unknown>
    const inheritedOnlyOut = activityOf({ days: { '2026-09-16': { tokens: 15, requests: 1, skills: inheritedOnly } } })
    assert.deepEqual((inheritedOnlyOut as unknown as { days: Record<string, Record<string, unknown>> }).days['2026-09-16'].skills, undefined)
  })

  test('a well-formed skill table rides the pass-through; malformed tallies drop per name', () => {
    const skills = { tdd: { n: 2, last: 1_758_000_000_000 } }
    const wire = { days: { '2026-09-16': { tokens: 15, requests: 1, skills } } }
    assert.ok(activityOf(wire) === (wire as never))
    const out = activityOf({
      days: {
        '2026-09-16': {
          tokens: 15,
          requests: 1,
          skills: {
            tdd: { n: 1, last: 5 },
            'bad-count': { n: 'x', last: 5 },
            'bad-last': { n: 1, last: Number.NaN },
            'neg-count': { n: -1, last: 5 },
            'not-record': null,
          },
        },
        '2026-09-17': { tokens: 1, requests: 1, skills: 'x' },
        '2026-09-18': { tokens: 1, requests: 1, skills: [] },
        '2026-09-19': { tokens: 1, requests: 1, skills: {} },
      },
    })
    assert.deepEqual(out, {
      days: {
        '2026-09-16': { tokens: 15, requests: 1, skills: { tdd: { n: 1, last: 5 } } },
        '2026-09-17': { tokens: 1, requests: 1 },
        '2026-09-18': { tokens: 1, requests: 1 },
        '2026-09-19': { tokens: 1, requests: 1 },
      },
    }, 'non-record and empty-after-scrubbing tables drop whole; the days survive')
  })

  test('the daily tallies ride the pass-through and the sanitized copy; malformed figures drop alone', () => {
    const tallies = { turns: 2, toolCalls: 3, toolsMs: 4.5, wallMs: 5 }
    const wire = { days: { '2026-09-16': { tokens: 15, requests: 1, ...tallies } } }
    assert.ok(activityOf(wire) === wire, 'a clean payload keeps its reference')
    const dirty = { days: { '2026-09-16': { tokens: 15, requests: 1, ...tallies }, bad: { tokens: 1, requests: 1 } } }
    assert.deepEqual(activityOf(dirty), { days: { '2026-09-16': { tokens: 15, requests: 1, ...tallies } } })
    const out = activityOf({
      days: { '2026-09-16': { tokens: 15, requests: 1, turns: 'x', toolCalls: -1, toolsMs: Number.NaN, wallMs: Number.POSITIVE_INFINITY } },
    })
    assert.deepEqual(out, { days: { '2026-09-16': { tokens: 15, requests: 1 } } }, 'each malformed tally drops, the day survives')
  })
})

describe('costFullyQuantified', () => {
  test('a merged-shape record aliases; every deviation sends the rebuild', () => {
    const bucket = { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 }
    assert.equal(costFullyQuantified({ deepseek: { 'deepseek-v4': { peak: bucket, off: { ...bucket } } } }), true)
    assert.equal(costFullyQuantified(undefined), false, 'undefined is not a merged record')
    assert.equal(costFullyQuantified(null), false)
    assert.equal(costFullyQuantified(7), false)
    assert.equal(costFullyQuantified([1]), false)
    assert.equal(costFullyQuantified({}), false, 'no bucket ever merged')
    assert.equal(costFullyQuantified({ deepseek: 7 }), false, 'a non-record model level')
    assert.equal(costFullyQuantified({ deepseek: [1] }), false)
    assert.equal(costFullyQuantified({ deepseek: { m: 7 } }), false, 'a non-record periods level')
    assert.equal(costFullyQuantified({ deepseek: { m: [1] } }), false)
    assert.equal(costFullyQuantified({ deepseek: { m: { peak: { uncached: 'x', cacheRead: 1, cacheWrite: 1, output: 1 } } } }), false, 'a non-numeric bucket field')
    assert.equal(costFullyQuantified({ deepseek: { m: { peak: [1] } } }), false)
    assert.equal(costFullyQuantified({ deepseek: { m: { peak: { uncached: 1, cacheRead: 2 } } } }), false, 'a sparse bucket')
  })

  test('a garbage day repairs its scalar fields too; a malformed period or non-record fee drops the fee', () => {
    const out = activityOf({
      days: {
        // Non-numeric scalars and a non-record period repair the day in place.
        '2026-09-16': {
          tokens: 5, requests: 1, turns: 'x', toolCalls: -1, toolsMs: Number.NaN, wallMs: 7,
          cost: { deepseek: { m: { peak: [1], off: { uncached: 2, cacheRead: 2, cacheWrite: 2, output: 2 } } } },
        },
        '2026-09-15': { tokens: 5, requests: 1, skills: { tdd: { n: 0, last: 5 } } },
      },
    })
    assert.deepEqual(out, {
      days: {
        // The array-valued `peak` drops, the readable `off` bucket survives.
        '2026-09-16': {
          tokens: 5, requests: 1, wallMs: 7,
          cost: { deepseek: { m: { off: { uncached: 2, cacheRead: 2, cacheWrite: 2, output: 2 } } } },
        },
        '2026-09-15': { tokens: 5, requests: 1, skills: { tdd: { n: 0, last: 5 } } },
      },
    })
  })

  test('a repaired day keeps its readable counters, and a bad tally `last` fails the proof on its own', () => {
    const out = activityOf({
      days: {
        '2026-09-16': {
          tokens: 9, requests: 2, turns: 3, toolCalls: 4, toolsMs: 500, wallMs: 900,
          cost: { deepseek: 7 },
          skills: { tdd: { n: 1, last: 'x' } },
        },
      },
    })
    assert.deepEqual(out, {
      days: { '2026-09-16': { tokens: 9, requests: 2, turns: 3, toolCalls: 4, toolsMs: 500, wallMs: 900 } },
    }, 'the malformed fee drops, the bad-last tally drops the table, the counters stay')
    // A non-finite `last` (not a non-number) is its own failing arm of the same guard.
    const nanLast = activityOf({ days: { '2026-09-16': { tokens: 1, requests: 1, skills: { tdd: { n: 1, last: Number.NaN } } } } })
    assert.deepEqual(nanLast, { days: { '2026-09-16': { tokens: 1, requests: 1 } } })
  })

  test('an own __proto__ key at either level never aliases (the merge it stands in for drops it)', () => {
    // Only JSON text can carry an own `__proto__` key (an object literal would set the prototype instead).
    const protoProvider = JSON.parse('{"__proto__":{"m":{"peak":{"uncached":1,"cacheRead":2,"cacheWrite":3,"output":4}}}}') as Record<string, unknown>
    assert.ok(Object.keys(protoProvider).includes('__proto__'), 'the fixture really holds an own __proto__ key')
    assert.equal(costFullyQuantified(protoProvider), false)
    const protoModel = JSON.parse('{"deepseek":{"__proto__":{"peak":{"uncached":1,"cacheRead":2,"cacheWrite":3,"output":4}}}}') as Record<string, unknown>
    assert.equal(costFullyQuantified(protoModel), false)
  })
})
