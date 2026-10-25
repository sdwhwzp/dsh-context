import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeCommandPanel } from '../../../src/client/components/commandPanel'
import type { Command } from '../../../src/client/commands'
import { makeKit, mount, query, queryAll, text, click } from '../helpers/kit'
import type { ConversationNodeLike } from '../../../src/client/services'

const kit = makeKit()
const Panel = makeCommandPanel(kit)

const T0 = 1700000000000

function cmd(seq: number, over: Partial<Command> = {}): Command {
  return {
    seq,
    time: T0 + seq * 1000,
    tool: 'bash',
    cmd: 'git status',
    start: T0 + seq * 1000,
    end: T0 + seq * 1000 + 100,
    status: 'completed',
    err: false,
    ...over,
  }
}

function richCommands(): Command[] {
  return [
    cmd(1, { cmd: 'git status --short', description: 'check the tree', resultSeq: 51, cwd: '/repo' }),
    cmd(2, {
      cmd: 'pnpm exec vitest run tests/client',
      description: 'run the affected tests',
      status: 'failed',
      exit: 1,
      start: T0 + 2000,
      end: T0 + 22000,
      resultSeq: 52,
      stderr: true,
      outChars: 6200,
    }),
    cmd(3, { cmd: 'node .tmp/serve.mjs', status: 'running', background: true, end: undefined, resultSeq: 53 }),
    cmd(4, {
      cmd: "cd /repo && python3 - <<'PY'\nprint('hi')\nPY",
      description: 'inline script',
      start: T0 + 4000,
      end: T0 + 4400,
      derived: true,
      resultSeq: 54,
    }),
  ]
}

function rowTexts(container: ParentNode): string[] {
  return queryAll(container, '.lc-cmd-row').map(r => text(r))
}

async function typeSearch(container: ParentNode, value: string): Promise<void> {
  const input = query<HTMLInputElement>(container, 'input.lc-fa-search')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('CommandPanel — rendering', () => {
  test('rows render time-first with status, duration, badges and the step stamp', async () => {
    const m = await mount(h(Panel, {
      commands: richCommands(),
      workspace: '/repo',
      stampOf: seq => ({ turn: 1, step: seq - 50 }),
    }))
    try {
      const rows = rowTexts(m.container)
      assert.equal(rows.length, 4)
      // Latest first by default.
      assert.ok(rows[0].includes("python3 - <<'PY'"), 'the workspace cd prefix is hidden')
      assert.ok(!rows[0].includes('cd /repo'))
      assert.ok(rows[0].includes('3 lines'))
      assert.ok(rows[0].includes('heredoc'))
      assert.ok(rows[0].includes('T1 S4'))
      assert.ok(rows[1].includes('node .tmp/serve.mjs'))
      assert.ok(rows[1].includes('bg'))
      assert.ok(rows[1].includes('Running'))
      assert.ok(rows[2].includes('pnpm exec vitest run tests/client'))
      assert.ok(rows[2].includes('20.0s'))
      assert.ok(rows[3].includes('git status --short'))
      // The rail's tally counts the list when no whole-log stats arrive.
      const kpis = queryAll(m.container, '.lc-cmd-kpi b').map(b => text(b))
      assert.deepEqual(kpis, ['3', '1', '20.5s', '1'])
    } finally {
      await m.unmount()
    }
  })

  test('the whole-log stats win the rail tally over the list count', async () => {
    const m = await mount(h(Panel, {
      commands: richCommands(),
      stats: { runs: 128, failed: 9, ms: 42700, bg: 2 },
    }))
    try {
      const kpis = queryAll(m.container, '.lc-cmd-kpi b').map(b => text(b))
      assert.deepEqual(kpis, ['128', '9', '42.7s', '2'])
    } finally {
      await m.unmount()
    }
  })

  test('the coverage note appears only with a floor', async () => {
    const withFloor = await mount(h(Panel, { commands: richCommands(), floor: 10 }))
    try {
      assert.ok(text(withFloor.container).includes('Covering the latest 4 runs'))
    } finally {
      await withFloor.unmount()
    }
    const without = await mount(h(Panel, { commands: richCommands() }))
    try {
      assert.ok(!text(without.container).includes('Covering'))
    } finally {
      await without.unmount()
    }
  })
})

describe('CommandPanel — command coloring', () => {
  test('the collapsed row and the expanded command carry the harness token runs', async () => {
    const m = await mount(h(Panel, { commands: [cmd(1, { cmd: 'git status --short', resultSeq: 51 })] }))
    try {
      const preview = query(m.container, '.lc-cmd-cmd')
      const runs = queryAll(preview, 'span')
      assert.ok(runs.length > 1, 'a span per token run')
      assert.equal(runs[0].style.color, 'var(--shiki-token-function)')
      assert.equal(text(preview), 'git status --short', 'the runs carry the preview verbatim')

      await click(query(m.container, '.lc-cmd-row'))
      const full = query(m.container, '.lc-cmd-full')
      assert.ok(queryAll(full, 'span').length > 1, 'the detail colors the whole command')
      assert.equal(text(full), 'git status --short')
    } finally {
      await m.unmount()
    }
  })

  test('the expanded command keeps its source newlines between the colored lines', async () => {
    const source = "cd /repo && python3 - <<'PY'\nprint('hi')\nPY"
    const m = await mount(h(Panel, { commands: [cmd(1, { cmd: source, resultSeq: 51 })] }))
    try {
      await click(query(m.container, '.lc-cmd-row'))
      const full = query(m.container, '.lc-cmd-full')
      assert.equal(text(full), source, 'the runs carry the command text verbatim')
      assert.ok(queryAll(full, 'span').length > 3, 'every line carries its token runs')
    } finally {
      await m.unmount()
    }
  })

  test('a tool the panel does not color, and an over-long line, render plain', async () => {
    const long = 'x'.repeat(1001)
    const m = await mount(h(Panel, {
      commands: [
        cmd(1, { tool: 'run_code', cmd: 'return 1 + 1' }),
        cmd(2, { cmd: long }),
        cmd(3, { tool: 'pwsh', cmd: 'Get-ChildItem -Recurse' }),
      ],
    }))
    try {
      // Latest first: the pwsh run leads, then the over-long line, then the code-mode program.
      const rows = queryAll(m.container, '.lc-cmd-cmd')
      // The pwsh grammar loads lazily: the preview text reads the same colored or plain.
      assert.ok(text(rows[0]).endsWith('Get-ChildItem -Recurse'), 'the pwsh preview renders')
      assert.equal(queryAll(rows[1], 'span').length, 0)
      assert.equal(text(rows[1]), long)
      assert.equal(queryAll(rows[2], '.lc-cmd-tool').length, 1)
      assert.ok(text(rows[2]).endsWith('return 1 + 1'), 'the code program stays plain')
      assert.equal(queryAll(rows[2], '.lc-cmd-tool + span').length, 0, 'no token runs follow the tool tag')
    } finally {
      await m.unmount()
    }
  })
})

describe('CommandPanel — filtering, search, sort', () => {
  test('the chips filter the list and toggle back off', async () => {
    const m = await mount(h(Panel, { commands: richCommands() }))
    try {
      const chip = (label: string) => {
        const hit = queryAll(m.container, '.lc-cmd-chips .lc-gran-btn').find(b => text(b).startsWith(label))
        if (hit === undefined) throw new Error(`chip not found: ${label}`)
        return hit
      }
      for (const [label, cls] of [['All', 'all'], ['Failed', 'failed'], ['Slow', 'slow'], ['Background', 'background']] as const) {
        assert.ok(chip(label).className.includes('lc-cmd-chip-' + cls), `the ${label} chip carries its tone class`)
      }
      assert.ok(chip('All').className.includes('lc-gran-on'), 'All starts active')
      await click(chip('Failed'))
      assert.equal(rowTexts(m.container).length, 1)
      assert.ok(rowTexts(m.container)[0].includes('vitest'))
      assert.ok(!chip('All').className.includes('lc-gran-on') && chip('Failed').className.includes('lc-gran-on'), 'the active tone follows the pick')
      await click(chip('Slow'))
      assert.equal(rowTexts(m.container).length, 1, 'the failed 20s run is also the slow one')
      await click(chip('Background'))
      assert.equal(rowTexts(m.container).length, 1)
      assert.ok(rowTexts(m.container)[0].includes('serve.mjs'))
      await click(chip('Background'))
      assert.equal(rowTexts(m.container).length, 4, 'clicking the active chip resets to all')
    } finally {
      await m.unmount()
    }
  })

  test('search narrows by command, description and cwd', async () => {
    const m = await mount(h(Panel, { commands: richCommands(), workspace: '/repo' }))
    try {
      await typeSearch(m.container, 'vitest')
      assert.equal(rowTexts(m.container).length, 1)
      await typeSearch(m.container, 'affected')
      assert.equal(rowTexts(m.container).length, 1)
      await typeSearch(m.container, '/repo')
      assert.equal(rowTexts(m.container).length, 2, 'the cwd match joins the command match')
      await typeSearch(m.container, 'nothing-matches')
      assert.ok(text(m.container).includes('No commands match the current filters'))
    } finally {
      await m.unmount()
    }
  })

  test('slowest sorts by wall time', async () => {
    const m = await mount(h(Panel, { commands: richCommands() }))
    try {
      const slowest = queryAll(m.container, '.lc-cmd-ctl .lc-gran-btn').find(b => text(b) === 'Slowest')
      assert.ok(slowest !== undefined)
      await click(slowest)
      const rows = rowTexts(m.container)
      assert.ok(rows[0].includes('vitest'))
      assert.ok(rows.at(-1)?.includes('serve.mjs'), 'the running (duration-less) run lands last')
    } finally {
      await m.unmount()
    }
  })
})

describe('CommandPanel — the row detail and actions', () => {
  test('clicking a row expands the full command, facts and actions', async () => {
    const m = await mount(h(Panel, {
      commands: richCommands(),
      workspace: '/repo',
      stampOf: seq => ({ turn: 1, step: seq - 50 }),
      onLocate: () => {},
    }))
    try {
      const rows = queryAll(m.container, '.lc-cmd-row')
      await click(rows[2]) // the failed vitest run
      const detail = query(m.container, '.lc-cmd-detail')
      assert.ok(text(detail).includes('run the affected tests'))
      assert.ok(text(query(m.container, '.lc-cmd-full')).includes('pnpm exec vitest run tests/client'))
      assert.ok(text(detail).includes('exit 1'))
      assert.ok(text(detail).includes('6.2k chars'))
      assert.ok(text(detail).includes('stderr'))
      assert.ok(query(m.container, '.lc-cmd-detail .lc-find-btn') !== null, 'the reveal affordance rides the head')
      await click(rows[2])
      assert.equal(queryAll(m.container, '.lc-cmd-detail').length, 0, 'clicking again collapses')
    } finally {
      await m.unmount()
    }
  })

  test('the derived run marks its duration; the reveal bridge fires with the record', async () => {
    const located: Command[] = []
    const m = await mount(h(Panel, {
      commands: richCommands(),
      workspace: '/repo',
      stampOf: seq => ({ turn: 1, step: seq - 50 }),
      onLocate: rec => { located.push(rec) },
    }))
    try {
      // The derived row (python heredoc, latest) shows the ≈ mark.
      const first = queryAll(m.container, '.lc-cmd-row')[0]
      assert.ok(text(first).includes('≈'))
      // Clicking the trailing time reveals instead of expanding.
      const time = query(first, '.lc-cmd-time')
      await click(time)
      assert.equal(located.length, 1)
      assert.equal(located[0].seq, 4)
      assert.equal(queryAll(m.container, '.lc-cmd-detail').length, 0, 'the reveal does not expand the row')
    } finally {
      await m.unmount()
    }
  })

  test('a running row without a result offers no reveal link', async () => {
    const m = await mount(h(Panel, {
      commands: [cmd(1, { status: 'running', end: undefined })],
      onLocate: () => {},
    }))
    try {
      assert.equal(queryAll(m.container, '.lc-cmd-time-link').length, 0)
      assert.equal(queryAll(m.container, '.lc-cmd-time').length, 1)
    } finally {
      await m.unmount()
    }
  })

  test('the copy action flashes the confirmation when the clipboard lands', async () => {
    const writes: string[] = []
    const Panel2 = makeCommandPanel(kit)
    const m = await mount(h(Panel2, { commands: richCommands() }))
    try {
      const clipboard = { writeText: (t: string) => { writes.push(t); return Promise.resolve() } }
      Object.defineProperty(globalThis.navigator, 'clipboard', { value: clipboard, configurable: true })
      const rows = queryAll(m.container, '.lc-cmd-row')
      await click(rows[3]) // git status --short
      const copyBtn = query(m.container, '.lc-cmd-detail .lc-rich-copy')
      await click(copyBtn)
      assert.deepEqual(writes, ['git status --short'])
    } finally {
      await m.unmount()
    }
  })
})

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

  test('the rail shows the KPIs, the top programs, and the attention items', async () => {
    const m = await mount(h(Panel, {
      commands: railCommands(),
      workspace: '/repo',
      stats: { runs: 4, failed: 1, ms: 95000, bg: 1 },
    }))
    try {
      const rail = query(m.container, '.lc-cmd-rail')
      const txt = text(rail)
      assert.ok(txt.includes('Summary'))
      assert.ok(txt.includes('Programs · 2'), 'two distinct programs (git, pnpm)')
      assert.ok(txt.includes('Attention'))
      assert.ok(txt.includes('git'), 'git tops the program ranking')
      assert.ok(txt.includes('Slowest'))
      assert.ok(txt.includes('Failing'))
      assert.ok(txt.includes('Repeats'))
      assert.ok(txt.includes('Background'))
      // The share label is the program's share of ALL listed runs: git ×3 of 5 → 60%.
      const gitRow = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
      assert.ok(gitRow !== undefined)
      assert.ok(text(gitRow).includes('60%'))
    } finally {
      await m.unmount()
    }
  })

  test('with two failing programs, the Failing row lands on exactly its own program’s failures', async () => {
    const commands: Command[] = [
      cmd(1, { cmd: 'vitest run a', status: 'failed', exit: 1 }),
      cmd(2, { cmd: 'vitest run b', status: 'failed', exit: 1 }),
      cmd(3, { cmd: 'eslint src', status: 'failed', exit: 2 }),
      cmd(4, { cmd: 'git status' }),
    ]
    const m = await mount(h(Panel, { commands }))
    try {
      // vitest fails twice, eslint once: the rail names vitest.
      const failing = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Failing'))
      assert.ok(failing !== undefined)
      assert.ok(text(failing).includes('vitest'))
      await click(failing)
      const rows = queryAll(m.container, '.lc-cmd-row')
      assert.equal(rows.length, 2, 'only vitest’s failures show')
      assert.ok(rows.every(r => r.textContent.includes('vitest')))
    } finally {
      await m.unmount()
    }
  })

  test('an attention click drives the list lens; a program click searches it', async () => {
    const m = await mount(h(Panel, { commands: railCommands(), workspace: '/repo' }))
    try {
      const rowTextsNow = () => queryAll(m.container, '.lc-cmd-row').map(r => text(r))
      // Slowest → the slow sort: the 90s vitest run tops the list.
      const slowestBtn = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Slowest'))
      assert.ok(slowestBtn !== undefined)
      await click(slowestBtn)
      assert.ok(rowTextsNow()[0].includes('vitest'))
      // Failing → the failed filter.
      const failingBtn = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Failing'))
      assert.ok(failingBtn !== undefined)
      await click(failingBtn)
      assert.equal(rowTextsNow().length, 1)
      assert.ok(rowTextsNow()[0].includes('vitest'))
      const latestChip = queryAll(m.container, '.lc-fa-sort .lc-gran-btn').find(b => text(b).startsWith('Latest'))
      assert.ok(latestChip?.className.includes('lc-gran-on'), 'the previous slowest sort is cleared')
      // Repeats → search the repeated command, clearing the previous failed filter.
      const repeatsBtn = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Repeats'))
      assert.ok(repeatsBtn !== undefined)
      await click(repeatsBtn)
      const withRepeats = rowTextsNow()
      assert.equal(withRepeats.length, 2, 'the lens clears the failed filter; both git status runs show')
      assert.ok(withRepeats.every(r => r.includes('git status')))
      const allChip = queryAll(m.container, '.lc-cmd-chips .lc-gran-btn').find(b => text(b).startsWith('All'))
      assert.ok(allChip?.className.includes('lc-gran-on'), 'the All chip is active again')
      // A program row click filters the list to that program (git status ×2 + git diff ×1).
      const gitBtn = queryAll(m.container, '.lc-cmd-prog').find(b => text(b).startsWith('git'))
      assert.ok(gitBtn !== undefined)
      await click(gitBtn)
      assert.equal(rowTextsNow().length, 3)
      // The Background attention row drives its chip too, clearing the previous search.
      const bgBtn = queryAll(m.container, '.lc-cmd-attn-row').find(b => text(b).includes('Background'))
      assert.ok(bgBtn !== undefined)
      await click(bgBtn)
      assert.equal(rowTextsNow().length, 1)
      assert.ok(rowTextsNow()[0].includes('pnpm dev'))
      assert.equal(query<HTMLInputElement>(m.container, '.lc-fa-search')?.value, '', 'the previous search is cleared')
    } finally {
      await m.unmount()
    }
  })

  test('an empty log shows a zero summary and a blank list; a quiet log keeps the real rail', async () => {
    const empty = await mount(h(Panel, { commands: [] }))
    try {
      assert.ok(query(empty.container, '.lc-cmd-rail') !== null, 'the summary renders with real zeroes')
      assert.deepEqual(queryAll(empty.container, '.lc-cmd-kpi b').map(b => text(b)), ['0', '0', '0', '0'])
      assert.equal(queryAll(empty.container, '.lc-cmd-progs').length, 0, 'no empty program ranking')
      assert.equal(queryAll(empty.container, '.lc-cmd-attn').length, 0, 'no attention section without notable items')
      assert.equal(queryAll(empty.container, '.lc-cmd-item').length, 0, 'the list stays blank')
      assert.ok(text(empty.container).includes('No commands executed in this session'))
    } finally {
      await empty.unmount()
    }
    const quiet = await mount(h(Panel, { commands: [cmd(1, { start: 0, end: 50 })] }))
    try {
      assert.ok(query(quiet.container, '.lc-cmd-rail') !== null, 'the summary still renders')
      assert.equal(queryAll(quiet.container, '.lc-cmd-attn').length, 0, 'no attention section without notable items')
      assert.ok(query(quiet.container, '.lc-cmd-progs') !== null, 'a non-empty log still ranks programs')
    } finally {
      await quiet.unmount()
    }
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
    try {
      // Seven programs clear the search threshold.
      const search = query<HTMLInputElement>(m.container, '.lc-cmd-prog-search')
      assert.ok(search !== undefined)
      assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 7, 'all programs listed, not just a top cut')
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(search, 'gi')
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      assert.equal(queryAll(m.container, '.lc-cmd-prog').length, 1, 'git alone survives the rail search')
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(search, 'nothing-matches')
        search.dispatchEvent(new Event('input', { bubbles: true }))
      })
      assert.ok(query(m.container, '.lc-cmd-prog-none') !== null, 'the no-match note renders')
      // The duration heat tiers land on the rows.
      const durClass = (label: string) => queryAll(m.container, '.lc-cmd-row').find(r => r.textContent.includes(label))?.querySelector('.lc-cmd-dur')?.className ?? ''
      assert.ok(durClass('fast').endsWith('lc-cmd-dur'))
      assert.ok(durClass('one-sec').includes('lc-cmd-dur-1'))
      assert.ok(durClass('slow-ish').includes('lc-cmd-dur-2'))
      assert.ok(durClass('very-slow').includes('lc-cmd-dur-3'))
    } finally {
      await m.unmount()
    }
  })
})

describe('CommandPanel — the result block', () => {
  const RESULT: ConversationNodeLike = { kind: 'tool', seq: 52, content: [{ type: 'text', text: 'progress 21:40\nVERDICT: PASS' }] }

  test('the result block reads the target node through fetchContent; a cached re-expand skips the loading note', async () => {
    const m = await mount(h(Panel, {
      commands: richCommands(),
      fetchContent: async (seq) => (seq === 52 ? RESULT : null),
    }))
    try {
      await click(queryAll(m.container, '.lc-cmd-row')[2]) // the failed vitest run → resultSeq 52
      const cards = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')
      assert.equal(cards.length, 2, 'one card for the command, one for the result')
      assert.ok(text(cards[1]).includes('VERDICT: PASS'))
      assert.ok(text(cards[1]).includes('2 lines'), 'the result head counts its lines')
      assert.ok(query(cards[1], '.lc-cmd-detail-facts') !== null, 'the facts band closes the result card')
      assert.equal(queryAll(cards[0], '.lc-cmd-detail-facts').length, 0, 'the command card stays clean')
      await click(queryAll(m.container, '.lc-cmd-row')[2])
      assert.equal(queryAll(m.container, '.lc-cmd-detail').length, 0, 'collapse')
      await click(queryAll(m.container, '.lc-cmd-row')[2])
      assert.ok(text(query(m.container, '.lc-cmd-detail')).includes('VERDICT: PASS'), 'the ready text survives the re-expand')
    } finally {
      await m.unmount()
    }
  })

  test('both cards carry the copy and find actions; the result copy writes the result text', async () => {
    const writes: string[] = []
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve() } },
      configurable: true,
    })
    const m = await mount(h(Panel, {
      commands: richCommands(),
      fetchContent: async (seq) => (seq === 52 ? RESULT : null),
    }))
    try {
      await click(queryAll(m.container, '.lc-cmd-row')[2]) // the failed vitest run
      const cards = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')
      assert.equal(cards.length, 2)
      for (const card of cards) {
        assert.ok(query(card, '.lc-rich-copy') !== null, 'the copy rides the head')
        assert.equal(queryAll(card, '.lc-find-btn').length, 1, 'the find toggle rides the head')
      }
      await click(query(cards[1], '.lc-rich-copy'))
      assert.deepEqual(writes, ['progress 21:40\nVERDICT: PASS'], 'the result copy writes the result text')
    } finally {
      await m.unmount()
    }
  })

  test('the find lens opens in a detail card and marks matches inside its own body', async () => {
    const m = await mount(h(Panel, {
      commands: [cmd(1, { cmd: 'git status --short', description: 'check the tree', resultSeq: 2 })],
      fetchContent: async () => ({ kind: 'tool', seq: 2, content: [{ type: 'text', text: 'nothing here' }] }),
    }))
    try {
      await click(query(m.container, '.lc-cmd-row'))
      const cards = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')
      await click(query(cards[0], '.lc-find-btn'))
      const input = query<HTMLInputElement>(cards[0], '.lc-find-input')
      assert.equal(document.activeElement, input, 'the find input takes focus on open')
      const find = async (value: string): Promise<void> => {
        await act(async () => {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          setter?.call(input, value)
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
      }
      await find('status')
      assert.equal(query(cards[0], '.lc-find-count')?.textContent, '1/1', 'one match in the command card')
      assert.ok(query(cards[0], '.lc-find-mark') !== null, 'the match is marked in the command body')
      assert.equal(queryAll(cards[1], '.lc-find').length, 0, 'the lens stays scoped to its own card')
      // The colored body leaves the command's tokens in separate runs; a phrase crossing them still matches.
      await find('git status')
      assert.equal(query(cards[0], '.lc-find-count')?.textContent, '1/1', 'the phrase matches across token runs')
      assert.ok(queryAll(cards[0], '.lc-find-mark').length > 1, 'one mark per run the phrase covers')
      assert.equal(queryAll(cards[0], '.lc-find-mark').map(x => text(x)).join(''), 'git status')
    } finally {
      await m.unmount()
    }
  })

  test('a pending read shows the loading note; a null, rejected, or text-less read shows the miss note', async () => {
    let release: (node: unknown) => void = () => {}
    const deferred = new Promise(resolve => { release = resolve })
    const m = await mount(h(Panel, {
      commands: [cmd(1, { resultSeq: 2 })],
      fetchContent: () => deferred as Promise<null>,
    }))
    try {
      await click(query(m.container, '.lc-cmd-row'))
      assert.ok(text(query(m.container, '.lc-cmd-result-note')).includes('Loading history…'))
      const resultCard = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')[1]
      assert.equal(queryAll(resultCard, '.lc-rich-copy, .lc-find-btn').length, 0, 'a note-only result card carries no actions')
      await act(async () => { release(null) })
      assert.ok(text(query(m.container, '.lc-cmd-result-note')).includes('outside the loaded message window'), 'a null read misses')
    } finally {
      await m.unmount()
    }
    const rejected = await mount(h(Panel, {
      commands: [cmd(1, { resultSeq: 2 })],
      fetchContent: () => Promise.reject(new Error('down')),
    }))
    try {
      await click(query(rejected.container, '.lc-cmd-row'))
      await act(async () => {})
      assert.ok(text(query(rejected.container, '.lc-cmd-result-note')).includes('Result failed to load'), 'a rejection states the failure')
    } finally {
      await rejected.unmount()
    }
    const textless = await mount(h(Panel, {
      commands: [cmd(1, { resultSeq: 2 })],
      fetchContent: async () => ({ kind: 'tool', seq: 2, content: [{ type: 'image' }] }),
    }))
    try {
      await click(query(textless.container, '.lc-cmd-row'))
      await act(async () => {})
      assert.ok(text(query(textless.container, '.lc-cmd-result-note')).includes('No text output'), 'no text blocks — the empty note serves')
    } finally {
      await textless.unmount()
    }
  })

  test('a late answer after unmount writes nothing', async () => {
    let settle: (node: ConversationNodeLike | null, reject?: boolean) => void = () => {}
    const fetcher = (): Promise<ConversationNodeLike | null> => new Promise((res, rej) => {
      settle = (node, reject) => (reject === true ? rej(new Error('down')) : res(node))
    })
    for (const [node, reject] of [[RESULT, false], [null, true]] as const) {
      const m = await mount(h(Panel, { commands: [cmd(1, { resultSeq: 2 })], fetchContent: fetcher }))
      try {
        await click(query(m.container, '.lc-cmd-row'))
      } finally {
        await m.unmount()
      }
      await act(async () => { settle(node, reject) })
    }
  })

  test('without a fetcher the detail carries no result card and the facts close the command card', async () => {
    const m = await mount(h(Panel, { commands: richCommands() }))
    try {
      await click(queryAll(m.container, '.lc-cmd-row')[2])
      const cards = queryAll(m.container, '.lc-cmd-detail .lc-ts-card')
      assert.equal(cards.length, 1, 'no fetcher — no result card')
      assert.ok(query(cards[0], '.lc-cmd-detail-facts') !== null, 'the facts band closes the command card')
    } finally {
      await m.unmount()
    }
  })
})

describe('CommandPanel — empty and channel states', () => {
  test('an empty log, a loading channel, and a failed channel each render their note', async () => {
    const empty = await mount(h(Panel, { commands: [] }))
    try {
      assert.ok(text(empty.container).includes('No commands executed in this session'))
    } finally {
      await empty.unmount()
    }
    const loading = await mount(h(Panel, { commands: [], state: 'loading' }))
    try {
      assert.equal(queryAll(loading.container, '.lc-detail-note, .lc-empty').length > 0, true)
      assert.equal(queryAll(loading.container, '.lc-cmd-rail').length, 0, 'a pending channel owns the full width')
    } finally {
      await loading.unmount()
    }
    const failed = await mount(h(Panel, { commands: [], state: 'failed', onRetry: () => {} }))
    try {
      assert.equal(queryAll(failed.container, 'button').length > 0, true, 'the retry note carries a button')
      assert.equal(queryAll(failed.container, '.lc-cmd-rail').length, 0, 'a failed channel owns the full width')
    } finally {
      await failed.unmount()
    }
    const failedNoRetry = await mount(h(Panel, { commands: [], state: 'failed' }))
    try {
      assert.ok(text(failedNoRetry.container).includes('History failed to load'), 'no retry still reads as a failure')
      assert.equal(queryAll(failedNoRetry.container, '.lc-cmd-rail').length, 0)
    } finally {
      await failedNoRetry.unmount()
    }
  })

  test('a nested code-mode run shows its badge and reveals on its parent', async () => {
    const located: Command[] = []
    const nested = cmd(7, { codeMode: true, parent: 99, cmd: 'git diff', resultSeq: undefined })
    const m = await mount(h(Panel, {
      commands: [nested],
      stampOf: () => ({ turn: 2, step: 3 }),
      onLocate: rec => { located.push(rec) },
    }))
    try {
      const row = query(m.container, '.lc-cmd-row')
      assert.ok(text(row).includes('nested'))
      await click(query(row, '.lc-cmd-time'))
      assert.equal(located.length, 1)
      assert.equal(located[0].parent, 99)
    } finally {
      await m.unmount()
    }
  })

  test('killed and stopped runs carry their own glyphs; a pwsh run shows its tool tag', async () => {
    const m = await mount(h(Panel, {
      commands: [
        cmd(1, { status: 'killed', signal: 'SIGTERM' }),
        cmd(2, { status: 'killed', stopped: true }),
        cmd(3, { tool: 'pwsh', cmd: 'Get-ChildItem' }),
      ],
    }))
    try {
      assert.equal(queryAll(m.container, '.lc-cmd-st-kill').length, 2)
      assert.ok(rowTexts(m.container).some(r => r.includes('pwsh')))
    } finally {
      await m.unmount()
    }
  })

  test('the detail lists every fact family and its Reveal action locates the record', async () => {
    const located: Command[] = []
    const full = cmd(9, {
      cmd: 'curl -s https://x',
      description: 'fetch it',
      status: 'failed',
      exit: 28,
      timedOut: true,
      denied: true,
      signal: 'SIGTERM',
      timeoutMs: 40000,
      cwd: '/repo/deep',
      outChars: 30000,
      outTruncated: true,
      stderr: true,
      sandbox: 'full',
      resultSeq: 90,
      start: T0 + 9000,
      end: T0 + 49000,
    })
    const m = await mount(h(Panel, {
      commands: [full],
      stampOf: () => ({ turn: 3, step: 2 }),
      onLocate: rec => { located.push(rec) },
    }))
    try {
      await click(query(m.container, '.lc-cmd-row'))
      const detail = text(query(m.container, '.lc-cmd-detail'))
      for (const part of ['fetch it', 'exit 28', '40.0s', '/repo/deep', 'timeout 40.0s', '30.0k chars', 'truncated', 'stderr', 'timed out', 'sandbox denied', 'signal SIGTERM', 'asked full']) {
        assert.ok(detail.includes(part), `detail shows: ${part}`)
      }
      const reveal = query(m.container, '.lc-cmd-detail .lc-find-btn')
      assert.ok((reveal.getAttribute('title') ?? '').includes('T3 S2'), 'the action carries the step stamp')
      await click(reveal)
      assert.deepEqual(located, [full])
    } finally {
      await m.unmount()
    }
  })

  test('the detail hides the exit badge for run_code and shows the inferred ≈', async () => {
    const m = await mount(h(Panel, {
      commands: [
        cmd(1, { tool: 'run_code', cmd: 'await x()', exit: 0, exitInferred: true }),
        cmd(2, { exit: 0, exitInferred: true, resultSeq: 55 }),
      ],
    }))
    try {
      const rows = queryAll(m.container, '.lc-cmd-row')
      await click(rows[0]) // latest-first: the seq-2 bash row
      assert.ok(text(query(m.container, '.lc-cmd-detail-facts')).includes('exit 0 ≈'), 'the inferred exit is marked')
      await click(rows[0])
      await click(queryAll(m.container, '.lc-cmd-row')[1]) // the run_code row
      assert.ok(!text(query(m.container, '.lc-cmd-detail-facts')).includes('exit 0'), 'a code program has no shell exit code')
    } finally {
      await m.unmount()
    }
  })

  test('the copy action needs a clipboard and survives a rejection', async () => {
    const m = await mount(h(Panel, { commands: [cmd(1, { resultSeq: 2 })] }))
    try {
      await click(query(m.container, '.lc-cmd-row'))
      const copyBtn = query(m.container, '.lc-cmd-detail .lc-rich-copy')
      // No clipboard at all: the click is a silent no-op.
      Object.defineProperty(globalThis.navigator, 'clipboard', { value: undefined, configurable: true })
      await click(copyBtn)
      assert.equal(copyBtn.getAttribute('title'), 'Copy Raw Text')
      // A failing write never claims the copy.
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: { writeText: () => Promise.reject(new Error('denied')) },
        configurable: true,
      })
      await click(copyBtn)
      await act(async () => {})
      assert.equal(copyBtn.getAttribute('title'), 'Copy Raw Text')
      // A landed write flashes the label, then resets after the timeout.
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: { writeText: () => Promise.resolve() },
        configurable: true,
      })
      await click(copyBtn)
      await act(async () => {})
      assert.equal(copyBtn.getAttribute('title'), 'Copied')
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1300)) })
      assert.equal(copyBtn.getAttribute('title'), 'Copy Raw Text')
    } finally {
      await m.unmount()
    }
  })

  test('the detail of a running, truncated, or stamp-less record renders its honest edges', async () => {
    const m = await mount(h(Panel, {
      commands: [
        cmd(1, { status: 'running', end: undefined, cmd: 'npm run watch' }),
        cmd(2, { cmd: 'x'.repeat(30), cmdTruncated: true, derived: true, resultSeq: 60 }),
        cmd(3, { cmd: 'node -e "console.log(1)"', resultSeq: 61 }),
      ],
      onLocate: () => {},
      // No stampOf: the reveal action renders without a stamp suffix.
    }))
    try {
      const rows = queryAll(m.container, '.lc-cmd-row')
      // The inline badge marks the one-liner script.
      assert.ok(text(rows[0]).includes('inline'))
      // Expand the running row: no duration fact, still Running.
      await click(rows.at(-1)!)
      let detail = query(m.container, '.lc-cmd-detail')
      assert.ok(text(detail).includes('npm run watch'))
      assert.ok(!text(detail).includes('≈'))
      await click(rows.at(-1)!)
      // Expand the derived+truncated row: ≈ on the duration, the ellipsis on the command body.
      await click(queryAll(m.container, '.lc-cmd-row')[1])
      detail = query(m.container, '.lc-cmd-detail')
      assert.ok(text(detail).includes('≈'))
      assert.ok(text(query(m.container, '.lc-cmd-full')).includes('…'))
      assert.ok(query(m.container, '.lc-cmd-detail .lc-find-btn') !== null, 'no stamp suffix when the stamp lookup misses')
    } finally {
      await m.unmount()
    }
  })

  test('a second copy within the flash window keeps the newer label lit', async () => {
    const m = await mount(h(Panel, {
      commands: [cmd(1, { resultSeq: 2 }), cmd(2, { cmd: 'git diff', resultSeq: 3 })],
    }))
    try {
      Object.defineProperty(globalThis.navigator, 'clipboard', {
        value: { writeText: () => Promise.resolve() },
        configurable: true,
      })
      const rows = queryAll(m.container, '.lc-cmd-row')
      await click(rows[0])
      const firstCopy = query(m.container, '.lc-cmd-detail .lc-rich-copy')
      await click(firstCopy)
      await act(async () => {})
      assert.equal(firstCopy.getAttribute('title'), 'Copied')
      await click(rows[0]) // collapse the first row
      await click(queryAll(m.container, '.lc-cmd-row')[1])
      const secondCopy = query(m.container, '.lc-cmd-detail .lc-rich-copy')
      await click(secondCopy)
      await act(async () => {})
      assert.equal(secondCopy.getAttribute('title'), 'Copied')
      // The first row's timer now fires while the SECOND seq is lit: it must not clear the newer flash.
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 1300)) })
      assert.equal(secondCopy.getAttribute('title'), 'Copy Raw Text')
    } finally {
      await m.unmount()
    }
  })
})
