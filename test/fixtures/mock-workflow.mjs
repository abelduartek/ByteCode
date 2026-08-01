// Provider simulado para os testes de workflow: ecoa um marcador do prompt e
// devolve JSON quando o passo pede schema. Conta as chamadas reais ao modelo,
// que e como o teste de resume prova que o cache funcionou.

import { MockLanguageModelV4, simulateReadableStream } from '../../node_modules/ai/dist/test/index.js'

export const stats = { calls: 0, concurrent: 0, peak: 0 }

// Forma do provider (LanguageModelV4): aninhada. A flat e a do nivel core, e um
// provider que a emitisse faria o SDK reportar tokens indefinidos — foi o que
// escondia o gasto dos passos do orcamento.
const usage = {
  inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 3, text: 3, reasoning: undefined },
  totalTokens: 6,
}

function lastUserText(prompt) {
  const messages = Array.isArray(prompt) ? prompt : []
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'user') continue
    const content = m.content
    if (typeof content === 'string') return content
    if (Array.isArray(content)) {
      const text = content.filter(p => p.type === 'text').map(p => p.text).join('')
      if (text) return text
    }
  }
  return ''
}

export function createOpenAICompatible() {
  return () =>
    new MockLanguageModelV4({
      doStream: async options => {
        stats.calls++
        stats.concurrent++
        stats.peak = Math.max(stats.peak, stats.concurrent)
        await new Promise(r => setTimeout(r, 40))
        stats.concurrent--

        const text = lastUserText(options.prompt)
        const marker = (text.match(/MARK:([A-Za-z0-9_.-]+)/) ?? [])[1] ?? 'sem-marcador'
        const body = text.includes('JSON Schema')
          ? JSON.stringify({ marker, ok: true })
          : `RESP:${marker}`

        return {
          stream: simulateReadableStream({
            chunks: [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: body },
              { type: 'text-end', id: '1' },
              { type: 'finish', finishReason: 'stop', usage },
            ],
            chunkDelayInMs: 0,
            initialDelayInMs: 0,
          }),
        }
      },
    })
}
