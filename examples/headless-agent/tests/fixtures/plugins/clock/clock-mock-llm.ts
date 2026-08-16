import type { Context } from '@deepseek-ai/cordis'
import { CallId, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** Keyless clock adapter: one `clock` tool call followed by a final answer. */
class ClockMockAdapter extends LlmAdapter {
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const toolResult = options.messages.at(-1)?.content.find(block => block.type === 'tool-result')
    if (toolResult === undefined) {
      const args = JSON.stringify({ timeZone: 'UTC', format: 'iso' })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'tool-call-delta', index: 0, id: CallId('clock-smoke-call'), name: 'clock', argumentsDelta: args }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: CallId('clock-smoke-call'), name: 'clock', arguments: args } }
      yield { type: 'usage', usage: { inputTokens: 11, outputTokens: 3, cacheReadTokens: 2 } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    const toolText = toolResult.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    const reply = `Clock tool round trip complete: ${toolText}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: reply }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
    yield { type: 'usage', usage: { inputTokens: 7, outputTokens: 5, reasoningTokens: 1 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export const name = 'clock-mock-llm'
export const inject = ['llm']

/** Register the keyless `clock-mock` adapter. */
export function apply(ctx: Context): void {
  ctx.llm.registerAdapter(['clock-mock'], new ClockMockAdapter())
}
