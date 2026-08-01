// Provider simulado carregado pelo registry real (campo "npm" aponta para este
// arquivo). Pai e subagente compartilham a instancia, entao um contador de
// passos descreve o roteiro inteiro do teste.

import { MockLanguageModelV4, simulateReadableStream } from '../../node_modules/ai/dist/test/index.js'

let step = 0
export const steps = []

function stream(chunks) {
  return simulateReadableStream({ chunks, chunkDelayInMs: 0, initialDelayInMs: 0 })
}

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 }

function textChunks(text) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: text },
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: 'stop', usage },
  ]
}

function toolChunks(name, input) {
  return [
    { type: 'stream-start', warnings: [] },
    {
      type: 'tool-call',
      toolCallId: `call-${++step}`,
      toolName: name,
      input: JSON.stringify(input),
    },
    { type: 'finish', finishReason: 'tool-calls', usage },
  ]
}

export function createOpenAICompatible() {
  return () =>
    new MockLanguageModelV4({
      doStream: async options => {
        const tools = (options.tools ?? []).map(t => t.name)
        steps.push(tools)
        const n = steps.length

        // 1: pai delega  2: filho tenta uma tool proibida  3: filho responde
        // 4: pai fecha
        if (n === 1) {
          return {
            stream: stream(
              toolChunks('Agent', {
                subagent_type: 'tester',
                prompt: 'investigue o repo',
                description: 'teste',
              }),
            ),
          }
        }
        if (n === 2) return { stream: stream(toolChunks('Bash', { command: 'echo proibido' })) }
        if (n === 3) return { stream: stream(textChunks('RELATORIO DO SUBAGENTE')) }
        return { stream: stream(textChunks('pai concluiu')) }
      },
    })
}
