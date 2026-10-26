import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Command } from '../../../src/client/commands'
import { click, mount, query, queryAll, text } from '../helpers/kit'
import { Panel, T0, cmd, typeInto, typeSearch } from './commandPanelHarness'

describe('CommandPanel — the summary rail', () => {
  function railCommands(): Command[] {
    return [
      cmd(1, { cmd: 'cd /repo && git status', resultSeq: 51 }),
      cmd(2, { cmd: 'cd /repo && git diff', resultSeq: 52 }),
      cmd(3, { cmd: 'cd /repo && git status', resultSeq: 53 }),
      cmd(4, {
        cmd: 'cd /repo && pnpm exec vitest run tests/client/components/commandPanel.spec.ts --reporter=verbose',
        status: 'failed',
        exit: 1,
        start: T0 + 4000,
        end: T0 + 94000,
        resultSeq: 54,
      }),
      cmd(5, { cmd: 'pnpm dev', status: 'running', background: true, end: undefined }),
    ]
  }

  test('with two failing programs, the Failing row lands on exactly its own program’s failures', async () => {
    const commands: Command[] = [
      cmd(1, { cmd: 'vitest run a', status: 'failed', exit: 1 }),
      cmd(2, { cmd: 'vitest run b', status: 'failed', exit: 1 }),
      cmd(3, { cmd: 'eslint src', status: 'failed', exit: 2 }),
      cmd(4, { cmd: 'git status' }),
    ]
    const m = await mount(h(Panel, { commands }))
    // vitest fails twice, eslint once: the rail names vitest.
    const failing = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Failing'))
    assert.ok(failing !== undefined)
    assert.ok(text(failing).includes('vitest'))
    await click(failing)
    const rows = queryAll(m.container, '.lc-cmd-row')
    assert.equal(rows.length, 2, 'only vitest’s failures show')
    assert.ok(rows.every(r => r.textContent.includes('vitest')))
    await m.unmount()
  })

  test('the rail shows the summary, programs, and attention items, and each one drives the list lens', async () => {
    const m = await mount(h(Panel, { commands: railCommands(), workspace: '/repo' }))
    const rail = text(query(m.container, '.lc-cmd-rail'))
    assert.ok(rail.includes('Summary'))
    assert.ok(rail.includes('Programs · 2'), 'two distinct programs (git, pnpm)')
    assert.ok(rail.includes('Attention'))
    assert.ok(rail.includes('Slowest'))
    assert.ok(rail.includes('Failing'))
    assert.ok(rail.includes('Repeats'))
    assert.ok(rail.includes('Background'))
    const gitShare = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(gitShare !== undefined)
    assert.ok(text(gitShare).includes('60%'))
    const rowTextsNow = () => queryAll(m.container, '.lc-cmd-row').map(r => text(r))
    const slowestBtn = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Slowest'))
    assert.ok(slowestBtn !== undefined)
    await click(slowestBtn)
    assert.ok(rowTextsNow()[0].includes('vitest'))
    const failingBtn = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Failing'))
    assert.ok(failingBtn !== undefined)
    await click(failingBtn)
    assert.equal(rowTextsNow().length, 1)
    assert.ok(rowTextsNow()[0].includes('vitest'))
    const latestChip = queryAll(m.container, '.lc-fa-sort .lc-gran-btn').find(b => text(b).startsWith('Latest'))
    assert.ok(latestChip?.className.includes('lc-gran-on'), 'the previous slowest sort is cleared')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 2, 'the ranking stays global')
    const failingPick = queryAll(m.container, '.lc-cmd-prog-on').find(b => text(b).startsWith('pnpm'))
    assert.ok(failingPick !== undefined, 'the failing program is marked')
    assert.ok(!queryAll(m.container, '.lc-cmd-attn-row').some(b => text(b).includes('Repeats')))
    await click(failingPick)
    const allChipReset = queryAll(m.container, '.lc-cmd-chips .lc-gran-btn').find(b => text(b).startsWith('All'))
    assert.ok(allChipReset !== undefined)
    await click(allChipReset)
    await typeSearch(m.container, '')
    const repeatsBtn = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Repeats'))
    assert.ok(repeatsBtn !== undefined)
    await click(repeatsBtn)
    const withRepeats = rowTextsNow()
    assert.equal(withRepeats.length, 2, 'both git status runs show')
    assert.ok(withRepeats.every(r => r.includes('git status')))
    const allChip = queryAll(m.container, '.lc-cmd-chips .lc-gran-btn').find(b => text(b).startsWith('All'))
    assert.ok(allChip?.className.includes('lc-gran-on'), 'the All chip is active again')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 2, 'the ranking stays global under the search lens')
    assert.ok(!queryAll(m.container, '.lc-cmd-attn-row').some(b => text(b).includes('Background')), 'the rail drops the rows outside the lens')
    await typeSearch(m.container, '')
    const gitBtn = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(gitBtn !== undefined)
    await click(gitBtn)
    assert.equal(rowTextsNow().length, 3)
    assert.equal(query<HTMLInputElement>(m.container, '.lc-fa-search')?.value, '', 'the pick does not write the search box')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 2, 'the ranking stays whole')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 1, 'the pick is marked')
    assert.equal(gitBtn.getAttribute('aria-pressed'), 'true')
    const picked = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(picked !== undefined)
    await click(picked)
    assert.equal(rowTextsNow().length, 5)
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 0)
    const bgBtn = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Background'))
    assert.ok(bgBtn !== undefined)
    await click(bgBtn)
    assert.equal(rowTextsNow().length, 1)
    assert.ok(rowTextsNow()[0].includes('pnpm dev'))
    assert.equal(query<HTMLInputElement>(m.container, '.lc-fa-search')?.value, '', 'the previous search is cleared')
    await m.unmount()
  })

  test('an empty log shows a zero summary and a blank list; a quiet log keeps the real rail', async () => {
    const empty = await mount(h(Panel, { commands: [] }))
    assert.ok(query(empty.container, '.lc-cmd-rail') !== null, 'the summary renders with real zeroes')
    assert.deepEqual(queryAll(empty.container, '.lc-cmd-kpi b').map(b => text(b)), ['0', '0', '0', '0'])
    assert.equal(queryAll(empty.container, '.lc-cmd-progs').length, 0, 'no empty program ranking')
    assert.equal(queryAll(empty.container, '.lc-cmd-attn').length, 0, 'no attention section without notable items')
    assert.equal(queryAll(empty.container, '.lc-cmd-item').length, 0, 'the list stays blank')
    assert.ok(text(empty.container).includes('No commands executed in this session'))
    await empty.unmount()
    const quiet = await mount(h(Panel, { commands: [cmd(1, { start: 0, end: 50 })] }))
    assert.ok(query(quiet.container, '.lc-cmd-rail') !== null, 'the summary still renders')
    assert.equal(queryAll(quiet.container, '.lc-cmd-attn').length, 0, 'no attention section without notable items')
    assert.ok(query(quiet.container, '.lc-cmd-progs') !== null, 'a non-empty log still ranks programs')
    await quiet.unmount()
  })

  test('a long program ranking gets its own search; the duration column heats with wall time', async () => {
    const commands: Command[] = ['grep', 'git', 'pnpm', 'node', 'python3', 'cat', 'sed'].flatMap((prog, i) =>
      Array.from({ length: i + 1 }, (_, j) => cmd(i * 10 + j, { cmd: `${prog} task-${j}` })))
    const m = await mount(h(Panel, {
      commands: [
        ...commands,
        cmd(100, { cmd: 'grep fast', start: 0, end: 500 }),
        cmd(101, { cmd: 'grep one-sec', start: 0, end: 1500 }),
        cmd(102, { cmd: 'grep slow-ish', start: 0, end: 15_000 }),
        cmd(103, { cmd: 'grep very-slow', start: 0, end: 90_000 }),
      ],
    }))
    // Seven programs clear the search threshold.
    const search = query<HTMLInputElement>(m.container, '.lc-cmd-prog-search')
    assert.ok(search !== undefined)
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 7, 'all programs listed, not just a top cut')
    const gitProg = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(gitProg !== undefined)
    await click(gitProg)
    assert.equal(queryAll(m.container, '.lc-cmd-row').length, 2, 'the two git-headed runs')
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'pnpm')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 2, 'pnpm plus the picked git')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 1)
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'nothing-matches')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1, 'the picked program survives the rail search')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-on').length, 1)
    await typeInto(m.container, 'input.lc-cmd-prog-search', '')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 7)
    const gitUnpick = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
    assert.ok(gitUnpick !== undefined)
    await click(gitUnpick)
    assert.equal(queryAll(m.container, '.lc-cmd-row').length, 32)
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'gi')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1, 'git alone survives the rail search')
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'nothing-matches')
    assert.ok(query(m.container, '.lc-cmd-prog-none') !== null, 'the no-match note renders')
    await typeSearch(m.container, 'grep')
    assert.ok(query(m.container, '.lc-cmd-prog-search') !== null, 'the rail search stays visible')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 0, 'the rail query still applies')
    assert.equal(queryAll(m.container, '.lc-cmd-row').length, 5, 'the list search narrows the rows')
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'grep')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1)
    await typeInto(m.container, 'input.lc-cmd-prog-search', '')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 7, 'the ranking is still global')
    assert.ok(query(m.container, '.lc-cmd-prog-search') !== null, 'seven programs keep the rail search')
    const durClass = (label: string) => queryAll(m.container, '.lc-cmd-row').find(r => r.textContent.includes(label))?.querySelector('.lc-cmd-dur')?.className ?? ''
    assert.ok(durClass('fast').endsWith('lc-cmd-dur'))
    assert.ok(durClass('one-sec').includes('lc-cmd-dur-1'))
    assert.ok(durClass('slow-ish').includes('lc-cmd-dur-2'))
    assert.ok(durClass('very-slow').includes('lc-cmd-dur-3'))
    await typeInto(m.container, 'input.lc-cmd-prog-search', 'git')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1)
    await m.update(h(Panel, {
      commands: [
        cmd(10, { cmd: 'git status' }),
        cmd(11, { cmd: 'pnpm build' }),
        cmd(12, { cmd: 'node app.js' }),
      ],
    }))
    assert.ok(query(m.container, '.lc-cmd-prog-search') !== null, 'the typed query keeps its input visible')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1, 'the query still applies')
    assert.ok(text(queryAll(m.container, '.lc-cmd-prog')[0]).startsWith('git'))
    await typeInto(m.container, 'input.lc-cmd-prog-search', '')
    assert.equal(queryAll(m.container, '.lc-cmd-prog-search').length, 0, 'the input hides below the threshold')
    assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 3)
    await m.unmount()
  })
  test.each(['all', 'failed', 'slow', 'background'] as const)('the Failing shortcut preserves the search and %s scope', async (filter) => {
    const commands: Command[] = [
      cmd(1, { cmd: 'git status slow', status: 'failed', exit: 1, start: 0, end: 20_000, background: true }),
      cmd(2, { cmd: 'git diff slow', status: 'failed', exit: 1, start: 0, end: 20_000, background: true }),
      cmd(3, { cmd: 'git status fast', status: 'failed', exit: 1 }),
      cmd(4, { cmd: 'git status completed', start: 0, end: 20_000, background: true }),
      cmd(5, { cmd: 'eslint status', status: 'failed', exit: 1, start: 0, end: 20_000, background: true }),
    ]
    const m = await mount(h(Panel, { commands }))
    try {
      await typeSearch(m.container, 'status')
      await click(query(m.container, '.lc-cmd-chip-' + filter))
      const failing = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Failing'))
      assert.ok(failing !== undefined)
      const expected = filter === 'slow' || filter === 'background' ? 1 : 2
      assert.ok(text(failing).includes('git×' + expected))
      await click(failing)
      const rows = queryAll(m.container, '.lc-cmd-row')
      assert.equal(rows.length, expected, 'the destination matches the shortcut count')
      assert.ok(rows.every(row => text(row).includes('git status')))
      assert.equal(query<HTMLInputElement>(m.container, '.lc-fa-search').value, 'status')
      assert.ok(query(m.container, '.lc-cmd-chip-failed').classList.contains('lc-gran-on'))
      if (filter === 'slow' || filter === 'background') {
        assert.ok(query(m.container, '.lc-cmd-chip-' + filter).classList.contains('lc-gran-on'), 'the preserved scope stays visible')
      }
      await click(query(m.container, '.lc-cmd-chip-all'))
      assert.equal(queryAll(m.container, '.lc-cmd-row').length, 3, 'All clears both predicates within the selected program and search')
    } finally {
      await m.unmount()
    }
  })


})
