// Provider simulado para a suite de paridade: a primeira chamada de cada turno
// pede uma tool que exige permissao (Write), a seguinte fecha com texto. E o
// bastante para exercitar PermissionRequest / Notification / PermissionDenied
// sem depender de shell nem de rede.

import { MockLanguageModelV4, simulateReadableStream } from '../../node_modules/ai/dist/test/index.js'

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  totalTokens: 10,
}

let calls = 0
let target = 'out.txt'

/** Chamado entre os cenarios: cada um comeca pedindo a tool de novo. */
export function reset(file) {
  calls = 0
  if (file) target = file
}

export const stats = {
  get calls() {
    return calls
  },
}

function stream(chunks) {
  return simulateReadableStream({ chunks, chunkDelayInMs: 0, initialDelayInMs: 0 })
}

/** Opcoes que o registry passou na ultima construcao — o `fetch` do cache entra aqui. */
export const built = { options: null }

export function createOpenAICompatible(options) {
  built.options = options
  return () =>
    new MockLanguageModelV4({
      doStream: async () => {
        calls++
        if (calls === 1) {
          return {
            stream: stream([
              { type: 'stream-start', warnings: [] },
              {
                type: 'tool-call',
                toolCallId: 'call-1',
                toolName: 'Write',
                input: JSON.stringify({ file_path: target, content: 'oi' }),
              },
              { type: 'finish', finishReason: 'tool-calls', usage },
            ]),
          }
        }
        return {
          stream: stream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'pronto' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage },
          ]),
        }
      },
    })
}
