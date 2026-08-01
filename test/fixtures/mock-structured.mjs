// Provider simulado para schema + resume da tool Agent.
//
// O modo decide o que o "subagente" responde; o registro de prompts e o que
// permite provar que um resume continuou a MESMA conversa em vez de comecar
// outra do zero.

import { MockLanguageModelV4, simulateReadableStream } from '../../node_modules/ai/dist/test/index.js'

const usage = {
  inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
  totalTokens: 10,
}

/** Uma entrada por chamada ao modelo: quantas mensagens o prompt tinha e o texto do ultimo user. */
export const calls = []

let mode = 'json'

/** `json` | `prose-then-json` | `always-prose` | `huge` | `echo` */
export function setMode(next) {
  mode = next
  calls.length = 0
}

function lastUserText(prompt) {
  for (let i = prompt.length - 1; i >= 0; i--) {
    const m = prompt[i]
    if (m.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      return content.map(p => (typeof p === 'string' ? p : (p.text ?? ''))).join('')
    }
  }
  return ''
}

function answerFor(prompt) {
  const text = lastUserText(prompt)
  const isRepair = text.includes('could not be read as JSON')

  if (mode === 'always-prose') return 'nao vou responder em json, desculpe'
  if (mode === 'huge') {
    return JSON.stringify({ achado: 'x'.repeat(40_000) })
  }
  if (mode === 'echo') {
    // Prova de continuidade: devolve quantas mensagens o modelo enxergou.
    return `vi ${prompt.length} mensagens`
  }
  if (mode === 'prose-then-json' && !isRepair) {
    return 'Claro! Vou explicar antes de responder. O arquivo parece bom.'
  }
  return '```json\n{"achado":"loop.ts:42","confianca":"alta"}\n```'
}

export function createOpenAICompatible() {
  return () =>
    new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        calls.push({ messages: prompt.length, text: lastUserText(prompt) })
        const answer = answerFor(prompt)
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '0' },
              { type: 'text-delta', id: '0', delta: answer },
              { type: 'text-end', id: '0' },
              { type: 'finish', finishReason: 'stop', usage },
            ],
            chunkDelayInMs: 0,
            initialDelayInMs: 0,
          }),
        }
      },
    })
}
