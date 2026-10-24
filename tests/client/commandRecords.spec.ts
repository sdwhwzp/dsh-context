import assert from 'node:assert/strict'
import { test } from 'vitest'
import { commandRecordsOf, isCommandRecord } from '../../src/client/commandRecords'
import { collectionsOf, timelineOf } from '../../src/client/services'
import type { CommandRecord } from '../../src/shared/types'

const command: CommandRecord = { seq: 1, time: 2, start: 2, tool: 'bash', cmd: 'ls', status: 'running', err: false }

test('command wire entries retain valid records and discard malformed siblings in both delivery paths', () => {
  const hostile = Object.defineProperty({}, 'seq', { get() { throw new Error('damaged entry') } })
  const malformed = [null, [], {}, 1, hostile, { ...command, cmd: 1 }]
  assert.deepEqual(collectionsOf({ commands: [...malformed, command] }).commands, [command])
  const full = {
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
    requests: [], events: [], nodes: [], archive: [], commands: [command],
  }
  assert.equal(timelineOf(full), full)
  assert.deepEqual(timelineOf({ ...full, commands: [...malformed, command] })?.commands, [command])
  assert.deepEqual(timelineOf({ ...full, commands: 'bad' })?.commands, [])
  assert.deepEqual(commandRecordsOf(undefined), [])
})

test('command fields reject wrong types and nonfinite numbers without rejecting optional omissions', () => {
  assert.equal(isCommandRecord(command), true)
  for (const field of ['seq', 'time', 'start', 'tool', 'cmd', 'err', 'status']) {
    assert.equal(isCommandRecord({ ...command, [field]: undefined }), false, field)
  }
  assert.equal(isCommandRecord({ ...command, status: 'missing' }), false)
  for (const status of ['completed', 'failed', 'killed']) assert.equal(isCommandRecord({ ...command, status }), true)
  for (const field of ['seq', 'time', 'start', 'resultSeq', 'timeoutMs', 'parent', 'turn', 'step', 'end', 'exit', 'outChars', 'gone']) {
    assert.equal(isCommandRecord({ ...command, [field]: NaN }), false, field)
    assert.equal(isCommandRecord({ ...command, [field]: '1' }), false, field)
    assert.equal(isCommandRecord({ ...command, [field]: 0 }), true, field)
  }
  for (const field of ['description', 'cwd', 'sandbox', 'signal']) {
    assert.equal(isCommandRecord({ ...command, [field]: 3 }), false, field)
    assert.equal(isCommandRecord({ ...command, [field]: 'value' }), true, field)
  }
  for (const field of ['cmdTruncated', 'background', 'codeMode', 'exitInferred', 'timedOut', 'stopped', 'denied', 'outTruncated', 'stderr', 'derived']) {
    assert.equal(isCommandRecord({ ...command, [field]: false }), false, field)
    assert.equal(isCommandRecord({ ...command, [field]: true }), true, field)
  }
})
