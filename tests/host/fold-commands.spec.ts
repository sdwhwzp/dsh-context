import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { buildTimelineDetail } from '../../src/host/fold'
import { resolveBounds } from '../../src/host/config'
import type { CommandStateRecord } from '../../src/host/foldState'
import { codeDispatch, codeDispatchStart, jobRegistered, jobSettled, toolCall, toolResult } from './helpers/events'
import { assertStable, assertStatesPlainJson, driveTimeline, timelineDef } from './helpers/projection'

function bashCall(seq: number, callId: string, args: Record<string, unknown>, time?: number): TimelineEvent {
  return toolCall(seq, { callId, name: 'bash', arguments: JSON.stringify(args), turn: 1, step: 1, time })
}

function bashResult(seq: number, callId: string, text: string, opts: { error?: boolean; meta?: unknown; time?: number } = {}): TimelineEvent {
  return toolResult(seq, { callId, content: [{ type: 'text', text }], error: opts.error, meta: opts.meta, time: opts.time })
}

function cmdsOf(state: { commands: CommandStateRecord[] }): CommandStateRecord[] {
  return state.commands
}

describe('the command log — call/result lifecycle', () => {
  test('a call books a running record; the result settles it with the envelope-derived outcome', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'git status', description: 'check the tree', workdir: '/repo', timeoutMs: 5000 }),
      bashResult(2, 'c1', 'clean'),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.cmd, 'git status')
    assert.equal(rec.description, 'check the tree')
    assert.equal(rec.cwd, '/repo')
    assert.equal(rec.timeoutMs, 5000)
    assert.equal(rec.status, 'completed')
    assert.equal(rec.exit, 0)
    assert.equal(rec.exitInferred, true, 'a clean exit logs no marker — the 0 is inferred')
    assert.equal(rec.derived, true)
    assert.equal(rec.resultSeq, 2)
    assert.equal(rec.err, false)
    assert.equal(rec.outChars, 5)
    assert.equal(rec.end !== undefined && rec.end >= rec.start, true)
  })

  test('the exit marker fails the run; stderr/truncation/meta.cwd land on the record', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'vitest run', description: 'tests' }),
      bashResult(2, 'c1', '1 failed\n[stderr]\nerror here\n[exit code: 1]', { meta: { cwd: '/repo/sub' } }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'failed')
    assert.equal(rec.exit, 1)
    assert.equal(rec.exitInferred, undefined)
    assert.equal(rec.stderr, true)
    assert.equal(rec.cwd, '/repo/sub', 'the result meta cwd wins over the argument')
  })

  test('a kill, a timeout, and a denial each carry their own flag', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'a' }),
      bashResult(2, 'c1', 'x\n[killed by signal: SIGKILL]'),
      bashCall(3, 'c2', { command: 'b' }),
      bashResult(4, 'c2', 'x\n[timed out after 5000ms]\n[exit code: 28]'),
      bashCall(5, 'c3', { command: 'c' }),
      bashResult(6, 'c3', '[sandbox: file access denied under strict mode]'),
    ])
    const [killed, timedOut, denied] = cmdsOf(state)
    assert.equal(killed.status, 'killed')
    assert.equal(killed.signal, 'SIGKILL')
    assert.equal(timedOut.status, 'failed')
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.exit, 28)
    assert.equal(denied.status, 'failed')
    assert.equal(denied.denied, true)
  })

  test('an infrastructure error (isError) fails the run without inventing an exit code', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'ls' }),
      bashResult(2, 'c1', 'spawn failed', { error: true }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'failed')
    assert.equal(rec.err, true)
    assert.equal(rec.exit, undefined)
  })

  test('a call without a parseable command books nothing; an unpaired result is skipped', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ description: 'no command' }) }),
      toolCall(2, { callId: 'c2', name: 'read', arguments: JSON.stringify({ file_path: 'a.ts' }) }),
      bashResult(3, 'ghost', 'orphan'),
      bashResult(4, 'c2', 'file body'),
    ])
    assert.equal(cmdsOf(state).length, 0)
  })

  test('a result settles a record that is not the newest (the callId scan walks back)', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'first' }),
      bashCall(2, 'c2', { command: 'second' }),
      bashResult(3, 'c1', 'one'),
      bashResult(4, 'c2', 'two'),
    ])
    assert.deepEqual(cmdsOf(state).map(r => [r.cmd, r.status]), [['first', 'completed'], ['second', 'completed']])
  })

  test('a result with a hostile content payload books the envelope facts only', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'x' }),
      toolResult(2, { callId: 'c1', content: [null, { type: 'image' }, { type: 'text', text: 'ok' }] as never }),
      bashCall(3, 'c2', { command: 'y' }),
      // No content array at all: no text to parse, the outcome still derives.
      toolResult(4, { callId: 'c2', content: 'junk' as never }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'completed')
    assert.equal(rec.outChars, 2, 'only the text block measures')
    const bare = cmdsOf(state)[1]
    assert.equal(bare.status, 'completed')
    assert.equal(bare.outChars, undefined)
  })

  test('truncation and stop markers land on the record; a call can carry every argument', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', {
        command: 'long',
        description: 'd',
        sandbox_permissions: 'full',
      }),
      bashResult(2, 'c1', 'partial\n[output truncated; full output: /tmp/x]'),
      bashCall(3, 'c2', { command: 'halt' }),
      bashResult(4, 'c2', 'x\n[stopped: user request]'),
    ])
    const [truncated, stopped] = cmdsOf(state)
    assert.equal(truncated.outTruncated, true)
    assert.equal(truncated.sandbox, 'full')
    assert.equal(truncated.turn, 1)
    assert.equal(stopped.status, 'killed')
    assert.equal(stopped.stopped, true)
  })

  test('the command text caps at maxCommandChars with the truncation flag', () => {
    const { state } = driveTimeline([
      // No turn/step on this envelope: those optional fields stay absent.
      toolCall(1, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'x'.repeat(40), description: 'd' }) }),
    ], { maxCommandChars: 16 })
    const rec = cmdsOf(state)[0]
    assert.equal(rec.cmd, 'x'.repeat(16))
    assert.equal(rec.cmdTruncated, true)
    assert.equal('turn' in rec, false)
    assert.equal('step' in rec, false)
  })

  test('a run_code call books the program source as the command', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'await x()', description: 'batch it' }) }),
      toolResult(2, { callId: 'rc1', content: [{ type: 'text', text: 'done' }] }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.tool, 'run_code')
    assert.equal(rec.cmd, 'await x()')
    assert.equal(rec.description, 'batch it')
    assert.equal(rec.status, 'completed')
  })

  test('every intermediate state is plain JSON', () => {
    const drive = driveTimeline([
      bashCall(1, 'c1', { command: 'ls', description: 'list' }),
      jobRegistered(2, { callId: 'c1', startedAt: 500 }),
      bashResult(3, 'c1', 'ok'),
      jobSettled(4, { callId: 'c1', finishedAt: 900, status: 'completed', detail: 'exit code: 0' }),
    ])
    assertStatesPlainJson(drive)
  })
})

describe('the command log — job events', () => {
  test('registered refines the start; settled lands the precise end and clears the derived flag', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'build', description: 'make' }, 1000),
      jobRegistered(2, { callId: 'c1', startedAt: 1100 }),
      jobSettled(3, { callId: 'c1', finishedAt: 5200, status: 'completed', detail: 'exit code: 2' }),
      bashResult(4, 'c1', 'wrote dist', { time: 5300 }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.start, 1100)
    assert.equal(rec.end, 5200)
    assert.equal(rec.status, 'failed', 'a nonzero command exit rides the completed job status with the detail code')
    assert.equal(rec.exit, 2)
    assert.equal(rec.derived, undefined)
    assert.equal(rec.resultSeq, 4, 'the result node stays the locate target even when the job settles first')
    // The tally fired exactly once (at the running → terminal transition), not again at the result.
    assert.equal(state.commandStats?.runs, 1)
    assert.equal(state.commandStats?.failed, 1)
    assert.equal(state.commandStats?.ms, 4100)
  })

  test('a killed job reports its signal; job events for unknown calls return the same state', () => {
    const def = timelineDef()
    let state = def.init()
    assertStable(state, jobRegistered(1, { callId: 'ghost', startedAt: 1 }), def)
    assertStable(state, jobSettled(2, { callId: 'ghost', finishedAt: 2, status: 'completed' }), def)
    state = def.apply(state, bashCall(3, 'c1', { command: 'x' }, 1000))
    state = def.apply(state, jobSettled(4, { callId: 'c1', finishedAt: 2000, status: 'killed', detail: 'signal: SIGTERM' }))
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'killed')
    assert.equal(rec.signal, 'SIGTERM')
    assert.equal(rec.end, 2000)
  })

  test('a malformed job envelope drops whole', () => {
    const def = timelineDef()
    let state = def.init()
    state = def.apply(state, bashCall(1, 'c1', { command: 'x' }))
    const before = state
    state = def.apply(state, jobSettled(2, { callId: 'c1', finishedAt: 'later', status: 'completed' }))
    assert.equal(state, before)
    state = def.apply(state, jobSettled(3, { callId: 'c1', finishedAt: 5, status: 'exploded' }))
    assert.equal(state, before)
    state = def.apply(state, { type: 'job/registered', seq: 4, time: 4, data: null } as unknown as TimelineEvent)
    assert.equal(state, before)
    state = def.apply(state, jobSettled(5, { finishedAt: 9, status: 'completed' }))
    assert.equal(state, before, 'no toolCall pairing at all')
    state = def.apply(state, jobRegistered(6, { callId: 42, startedAt: 9 }))
    assert.equal(state, before, 'a non-string callId pairs nothing')
  })
})

describe('the command log — background runs', () => {
  test('a background dispatch stays running past its ack and settles at the job record', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'pnpm dev', description: 'serve', run_in_background: true }, 1000),
      bashResult(2, 'c1', 'started background job j1', { time: 1200 }),
      jobSettled(3, { callId: 'c1', finishedAt: 999000, status: 'completed', detail: 'exit code: 0' }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.background, true)
    assert.equal(rec.status, 'completed')
    assert.equal(rec.exit, 0)
    assert.equal(rec.end, 999000)
    assert.equal(state.commandStats?.bg, 1)
    assert.equal(state.commandStats?.runs, 1, 'the tally fired once, at the terminal transition')
  })

  test('a promoted foreground call (wait timeout) marks the run background at its ack', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'slow', description: 's' }),
      // The real renderPromoted text: the marker followed by the fixed hand-off guidance.
      bashResult(2, 'c1', 'partial\n[still running after 10000ms; moved to background job j9]\n'
        + 'The command keeps running in the background. You will be notified when it finishes; '
        + 'read newer output with job_output, stop it with job_kill.'),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.background, true)
    assert.equal(rec.status, 'running', 'the ack is no outcome')
    assert.equal(rec.end, undefined)
    assert.deepEqual(state.commandStats, { runs: 0, failed: 0, ms: 0, bg: 1 }, 'the dispatch tallies at the ack; nothing terminal yet')
  })

  test('a promoted run tallies exactly once — at its terminal job record, not at the ack', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'slow', description: 's' }, 1000),
      jobRegistered(2, { callId: 'c1', startedAt: 1100 }),
      bashResult(3, 'c1', '[still running after 10000ms; moved to background job j9]\n'
        + 'The command keeps running in the background. You will be notified when it finishes; '
        + 'read newer output with job_output, stop it with job_kill.', { time: 11000 }),
      jobSettled(4, { callId: 'c1', finishedAt: 999000, status: 'killed', detail: 'signal: SIGTERM' }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'killed')
    assert.equal(rec.signal, 'SIGTERM')
    assert.equal(rec.background, true)
    assert.equal(rec.exitInferred, undefined, 'no phantom inferred exit survives the job outcome')
    assert.equal(state.commandStats?.runs, 1)
    assert.equal(state.commandStats?.failed, 1)
    assert.equal(state.commandStats?.bg, 1)
    assert.equal(state.commandStats?.ms, 997900)
  })

  test('the persistent-shell failure family fails the run honestly', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'sleep 999' }),
      bashResult(2, 'c1', 'out\n[Command timed out or OOM]\n[shell reset for the next call]'),
      bashCall(3, 'c2', { command: 'exit' }),
      bashResult(4, 'c2', 'bye\n[shell exited: code 3]\n[shell reset for the next call]'),
      bashCall(5, 'c3', { command: 'kill -9 $$' }),
      bashResult(6, 'c3', 'x\n[shell killed by signal: SIGKILL]\n[shell reset for the next call]'),
    ])
    const [timedOut, exited, killed] = cmdsOf(state)
    assert.equal(timedOut.status, 'failed')
    assert.equal(timedOut.timedOut, true)
    assert.equal(timedOut.exit, undefined)
    assert.equal(exited.status, 'failed')
    assert.equal(exited.exit, 3)
    assert.equal(killed.status, 'killed')
    assert.equal(killed.signal, 'SIGKILL')
  })

  test('a run_code program settles without a shell exit code', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'await x()', description: 'batch' }) }),
      toolResult(2, { callId: 'rc1', content: [{ type: 'text', text: 'done' }] }),
    ])
    const rec = cmdsOf(state)[0]
    assert.equal(rec.status, 'completed')
    assert.equal('exit' in rec, false, 'a code program carries no exit code')
    assert.equal('exitInferred' in rec, false)
  })

  test('on a job-less log a background run stays dispatched, never tallied as failed', () => {
    const { state } = driveTimeline([
      bashCall(1, 'c1', { command: 'server', run_in_background: true }),
      bashResult(2, 'c1', 'started background job j2'),
    ])
    assert.equal(cmdsOf(state)[0].status, 'running')
    assert.deepEqual(state.commandStats, { runs: 0, failed: 0, ms: 0, bg: 1 }, 'the dispatch counts at creation')
  })
})

describe('the command log — Code Mode (PTC) sub-dispatches', () => {
  test('a precise nested job outcome survives a later contradictory dispatch result', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'nested', name: 'bash', arguments: { command: 'build' } }),
      jobRegistered(3, { callId: 'nested', startedAt: 20 }),
      jobSettled(4, { callId: 'nested', finishedAt: 40, status: 'completed', detail: 'exit code: 2' }),
      codeDispatch(5, { rootCallId: 'rc1', subCallId: 'nested', name: 'bash', content: [{ type: 'text', text: 'late\n[exit code: 0]' }] }),
      toolResult(6, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    const nested = cmdsOf(state).find(r => r.codeMode === true)
    assert.ok(nested !== undefined)
    assert.equal(nested.status, 'failed')
    assert.equal(nested.exit, 2)
    assert.equal(nested.start, 20)
    assert.equal(nested.end, 40)
    assert.equal(nested.derived, undefined)
    assert.equal(nested.exitInferred, undefined)
    assert.equal(nested.outChars, 19)
    assert.equal(state.commandStats?.failed, 1)
    assert.equal(state.commandStats?.runs, 2)
  })

  test('a nested dispatch buffers at start, settles at its dispatch event, and flushes on the root result', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'program', description: 'batch' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'git status', description: 'check' } }),
      codeDispatch(3, {
        rootCallId: 'rc1',
        subCallId: 'rc1:ptc:0',
        name: 'bash',
        arguments: { command: 'git status' },
        isError: false,
        content: [{ type: 'text', text: 'clean\n[exit code: 0]' }],
      }),
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'program done' }] }),
    ])
    assert.equal(state.pendingCodeCmds, undefined, 'the buffer flushed and emptied')
    // The root books at its own call; the nested record flushes BEHIND it at the root's result.
    const [root, nested] = cmdsOf(state)
    assert.equal(nested.cmd, 'git status')
    assert.equal(nested.codeMode, true)
    assert.equal(nested.parent, 4, 'the locate target is the root result row')
    assert.equal(nested.status, 'completed')
    assert.equal(nested.exit, 0)
    assert.equal(root.tool, 'run_code')
    assert.equal(root.status, 'completed')
    assert.equal(state.commandStats?.runs, 2, 'both the root and the nested run tallied')
  })

  test('a non-command dispatch buffers nothing; the buffer stays bounded when the root never settles', () => {
    const events: TimelineEvent[] = [toolCall(1, { callId: 'rc1', name: 'run_code', arguments: '{}' })]
    events.push(codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:r', name: 'read', arguments: { file_path: 'a' } }))
    events.push(codeDispatchStart(3, { rootCallId: 'rc1', subCallId: 'rc1:ptc:b', name: 'bash', arguments: '{}' }))
    for (let i = 0; i < 210; i++) {
      events.push(codeDispatchStart(10 + i, { rootCallId: 'rc1', subCallId: `rc1:ptc:${i}`, name: 'bash', arguments: { command: `c${i}` } }))
    }
    const { state } = driveTimeline(events)
    assert.equal((state.pendingCodeCmds?.rc1 ?? []).length, 200, 'the cap holds')
  })

  test('a dispatch settle without a buffered start is skipped; a junk envelope drops whole', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatch(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:9', name: 'bash', arguments: { command: 'x' } }),
      { type: 'tool/ptc-dispatch-start', seq: 3, time: 3, data: null } as unknown as TimelineEvent,
      // No subCallId at all: the settle pairs with nothing.
      { type: 'tool/ptc-dispatch', seq: 5, time: 5, data: { rootCallId: 'rc1', name: 'bash', isError: false, content: [] } } as unknown as TimelineEvent,
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.equal(cmdsOf(state).length, 1, 'only the run_code root')
  })

  test('a nested command text caps at maxCommandChars with the truncation flag', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'y'.repeat(40) } }),
    ], { maxCommandChars: 16 })
    const rec = state.pendingCodeCmds?.rc1[0]
    assert.equal(rec?.cmd, 'y'.repeat(16))
    assert.equal(rec?.cmdTruncated, true)
  })

  test('a nested dispatch carries its full argument set, and an error settle marks it without an exit code', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, {
        rootCallId: 'rc1',
        subCallId: 'rc1:ptc:0',
        name: 'bash',
        arguments: {
          command: 'deploy',
          description: 'ship it',
          workdir: '/srv',
          timeoutMs: 3000,
          run_in_background: true,
          sandbox_permissions: 'full',
        },
      }),
      codeDispatch(3, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'deploy' }, isError: true }),
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    const nested = cmdsOf(state).find(r => r.codeMode === true)
    assert.ok(nested !== undefined)
    assert.equal(nested.cwd, '/srv')
    assert.equal(nested.timeoutMs, 3000)
    assert.equal(nested.sandbox, 'full')
    assert.equal(nested.background, true)
    assert.equal(nested.status, 'failed', 'an isError settle fails without an exit marker')
    assert.equal(nested.exit, undefined)
    assert.equal(nested.exitInferred, undefined)
  })

  test('a nested background run takes its job events while still buffered behind the root', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'serve', run_in_background: true } }),
      codeDispatch(3, {
        rootCallId: 'rc1',
        subCallId: 'rc1:ptc:0',
        name: 'bash',
        arguments: { command: 'serve' },
        content: [{ type: 'text', text: 'started background job j8' }],
      }),
      // The job registers and settles while the run_code program is still running.
      jobRegistered(4, { callId: 'rc1:ptc:0', startedAt: 2000 }),
      jobSettled(5, { callId: 'rc1:ptc:0', finishedAt: 62000, status: 'completed', detail: 'exit code: 0' }),
      toolResult(6, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    const nested = cmdsOf(state).find(r => r.codeMode === true)
    assert.ok(nested !== undefined)
    assert.equal(nested.status, 'completed', 'the buffered record took its job settlement')
    assert.equal(nested.start, 2000, 'the registered spawn instant reached the buffer')
    assert.equal(nested.end, 62000)
    assert.equal(nested.derived, undefined)
    assert.equal(state.commandStats?.runs, 2, 'root + nested each tallied once')
    assert.equal(state.commandStats?.bg, 1)
  })

  test('a nested job event for an unknown sub-call returns the state unchanged', () => {
    const def = timelineDef()
    let state = def.init()
    state = def.apply(state, toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }))
    const before = state
    state = def.apply(state, jobSettled(2, { callId: 'rc1:ptc:9', finishedAt: 5, status: 'completed', detail: 'exit code: 0' }))
    assert.equal(state, before, 'no such buffered record — no change')
    state = def.apply(state, jobRegistered(3, { callId: 'rc1:ptc:9', startedAt: 5 }))
    assert.equal(state, before)
  })

  test('a job event naming no buffered sub-call of an EXISTING buffer still returns the state unchanged', () => {
    const def = timelineDef()
    let state = def.init()
    state = def.apply(state, toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }))
    state = def.apply(state, codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' } }))
    const before = state
    state = def.apply(state, jobRegistered(3, { callId: 'rc1:ptc:ghost', startedAt: 5 }))
    assert.equal(state, before)
    state = def.apply(state, jobSettled(4, { callId: 'rc1:ptc:ghost', finishedAt: 9, status: 'completed' }))
    assert.equal(state, before)
  })

  test('a job event skips buffers that do not hold the call (multi-root scan)', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'a' }) }),
      toolCall(2, { callId: 'rc2', name: 'run_code', arguments: JSON.stringify({ code: 'b' }) }),
      codeDispatchStart(3, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' } }),
      codeDispatchStart(4, { rootCallId: 'rc2', subCallId: 'rc2:ptc:0', name: 'bash', arguments: { command: 'two' } }),
      jobRegistered(5, { callId: 'rc2:ptc:0', startedAt: 777 }),
    ])
    assert.equal(state.pendingCodeCmds?.rc2[0].start, 777, 'the second root’s record took the stamp')
    assert.notEqual(state.pendingCodeCmds?.rc1[0].start, 777)
  })

  test('a nested background ack stays open past its settle and flushes running', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'serve' } }),
      codeDispatch(3, {
        rootCallId: 'rc1',
        subCallId: 'rc1:ptc:0',
        name: 'bash',
        arguments: { command: 'serve' },
        content: [{ type: 'text', text: 'started background job j7' }],
      }),
      toolResult(4, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    const nested = cmdsOf(state).find(r => r.codeMode === true)
    assert.ok(nested !== undefined)
    assert.equal(nested.status, 'running', 'the ack is no outcome, even at flush')
    assert.equal(nested.background, true)
    assert.equal(state.commandStats?.runs, 1, 'only the root tallied')
  })

  test('two interleaved roots keep independent buffers; one settling keeps the other pending', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'a' }) }),
      toolCall(2, { callId: 'rc2', name: 'run_code', arguments: JSON.stringify({ code: 'b' }) }),
      codeDispatchStart(3, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' } }),
      codeDispatchStart(4, { rootCallId: 'rc2', subCallId: 'rc2:ptc:0', name: 'bash', arguments: { command: 'two' } }),
      codeDispatch(5, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'bash', arguments: { command: 'one' }, content: [{ type: 'text', text: 'ok' }] }),
      toolResult(6, { callId: 'rc1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.deepEqual(cmdsOf(state).filter(r => r.codeMode === true).map(r => r.cmd), ['one'])
    assert.equal((state.pendingCodeCmds?.rc2 ?? []).length, 1, 'the other root stays buffered')
  })
})

describe('the command log — retention, stats, and the served payload', () => {
  test('the log drops the oldest SETTLED records first and stamps the coverage floor; running records stay', () => {
    const events: TimelineEvent[] = []
    for (let i = 0; i < 5; i++) {
      events.push(bashCall(10 + i * 2, `c${i}`, { command: `cmd${i}` }))
      events.push(bashResult(11 + i * 2, `c${i}`, 'ok'))
    }
    // One still-running record sits between the settled ones.
    events.push(bashCall(20, 'keep', { command: 'running' }))
    const { state } = driveTimeline(events, { maxCommands: 3 })
    const kept = cmdsOf(state).map(r => r.cmd)
    assert.deepEqual(kept, ['cmd3', 'cmd4', 'running'])
    assert.equal(state.commandsFloor, 14, 'the newest dropped record was the cmd2 call (a record’s seq is its call’s)')
  })

  test('a log of never-settling calls is still bounded', () => {
    const events: TimelineEvent[] = []
    for (let i = 0; i < 10; i++) events.push(bashCall(10 + i, `c${i}`, { command: `cmd${i}` }))
    const { state } = driveTimeline(events, { maxCommands: 4 })
    assert.equal(cmdsOf(state).length, 4)
    assert.equal(state.commandsFloor, 15)
  })

  test('the whole-log stats survive list trimming', () => {
    const events: TimelineEvent[] = []
    for (let i = 0; i < 6; i++) {
      events.push(bashCall(10 + i * 2, `c${i}`, { command: `cmd${i}` }))
      events.push(bashResult(11 + i * 2, `c${i}`, i % 2 === 0 ? 'ok' : 'x\n[exit code: 1]'))
    }
    const { state } = driveTimeline(events, { maxCommands: 2 })
    assert.equal(cmdsOf(state).length, 2)
    assert.equal(state.commandStats?.runs, 6, 'the tally covers the complete log')
    assert.equal(state.commandStats?.failed, 3)
  })

  test('the state schema accepts a state carrying commands; the detail serves detached, key-stripped copies', () => {
    const { def, state } = driveTimeline([
      bashCall(1, 'c1', { command: 'ls', description: 'list' }),
      bashResult(2, 'c1', 'ok'),
    ])
    def.stateSchema.parse(structuredClone(state))
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.equal(detail.commands?.length, 1)
    assert.notEqual(detail.commands?.[0], state.commands[0], 'the served record never aliases the state')
    assert.equal('call' in (detail.commands?.[0] ?? {}), false, 'the fold pairing key stays off the wire')
    assert.equal(detail.commandStats?.runs, 1)
  })

  test('the slim head does NOT carry the command log; the inline value does and validates', () => {
    const events = [
      bashCall(1, 'c1', { command: 'ls', description: 'list' }),
      bashResult(2, 'c1', 'ok'),
    ]
    const slim = timelineDef({}, true)
    const inline = timelineDef({}, false)
    const { state } = driveTimeline(events)
    assert.equal('commands' in slim.wire.view(state), false)
    const full = inline.wire.view(state)
    assert.equal(full.commands?.length, 1)
    assert.equal(inline.wire.viewSchema.safeParse(full).success, true)
  })
})
