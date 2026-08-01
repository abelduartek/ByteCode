// Provider simulado dirigido por um roteiro que o probe monta. Cada entrada de
// `script` e uma lista de chunks; o mock consome uma por chamada.

import { MockLanguageModelV4, simulateReadableStream } from '../../node_modules/ai/dist/test/index.js'

export const script = []
export const stats = { calls: 0 }

export function reset() {
  script.length = 0
  stats.calls = 0
}

// LanguageModelV4Usage e aninhado: o SDK achata isso em result.usage.
const usage = {
  inputTokens: { total: 100, noCache: 70, cacheRead: 30, cacheWrite: 10 },
  outputTokens: { total: 20, text: 20, reasoning: 0 },
}

function stream(chunks) {
  return simulateReadableStream({ chunks, chunkDelayInMs: 0, initialDelayInMs: 0 })
}

export function text(value) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: value },
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: 'stop', usage },
  ]
}

/** Varias tool calls num unico step, na ordem dada. */
export function tools(calls) {
  return [
    { type: 'stream-start', warnings: [] },
    ...calls.map((c, i) => ({
      type: 'tool-call',
      toolCallId: `call-${i}-${Math.random().toString(36).slice(2, 8)}`,
      toolName: c.name,
      input: JSON.stringify(c.input ?? {}),
    })),
    { type: 'finish', finishReason: 'tool-calls', usage },
  ]
}

export function failure({ status, message, retryAfterMs }) {
  const error = Object.assign(new Error(message), { statusCode: status })
  if (retryAfterMs !== undefined) error.responseHeaders = { 'retry-after-ms': String(retryAfterMs) }
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'error', error },
    { type: 'finish', finishReason: 'error', usage },
  ]
}

/** Emite texto e SO DEPOIS falha: retry duplicaria o que ja foi mostrado. */
export function textThenFailure(value, { status, message }) {
  return [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    { type: 'text-delta', id: '1', delta: value },
    { type: 'text-end', id: '1' },
    { type: 'error', error: Object.assign(new Error(message), { statusCode: status }) },
    { type: 'finish', finishReason: 'error', usage },
  ]
}

export function createOpenAICompatible() {
  return () =>
    new MockLanguageModelV4({
      doStream: async () => {
        stats.calls++
        const chunks = script.shift() ?? text('fim')
        return { stream: stream(chunks) }
      },
    })
}
