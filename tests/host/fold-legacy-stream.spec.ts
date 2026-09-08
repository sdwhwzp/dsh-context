import { expect, test, vi } from 'vitest'
import { assistantMessage, stepStart, stepEnd } from './helpers/events'
import { driveTimeline } from './helpers/projection'

vi.mock('@deepseek-ai/dsh-llm', () => ({ expandAssistantStream: undefined }))

test('keeps message accounting when an older SDK has no embedded stream decoder', () => {
  const message = assistantMessage(1, { time: 2000 })
  const { state } = driveTimeline([
    stepStart(0, { time: 1000 }),
    { ...message, data: { ...message.data, stream: [] } },
    stepEnd(2, { time: 3000 }),
  ])
  expect(state.timing?.calls).toBe(1)
  expect(state.timing?.ttftMs).toBe(0)
})
