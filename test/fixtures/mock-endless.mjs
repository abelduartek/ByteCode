// Provider simulado que NUNCA para: toda chamada devolve mais um tool call.
// E o bastante para exercitar o orcamento de steps do loop sem depender de rede.

import { MockLanguageModelV4, simulateReadableStream } from '../../node_modules/ai/dist/test/index.js'

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  totalTokens: 10,
}

let calls = 0

export const stats = {
  get calls() {
    return calls
  },
}

export function reset() {
  calls = 0
}

export function createOpenAICompatible() {
  return () =>
    new MockLanguageModelV4({
      doStream: async () => {
        calls++
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: `call-${calls}`,
                toolName: 'LS',
                input: JSON.stringify({ path: '.' }),
              },
              { type: 'finish', finishReason: 'tool-calls', usage },
            ],
            chunkDelayInMs: 0,
            initialDelayInMs: 0,
          }),
        }
      },
    })
}
