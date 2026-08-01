const { ROOT, SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('compact')
const N = new URL('../node_modules', import.meta.url).href

useConfig({
  dataDir: `${S}/data`,
  model: 'fake/tiny',
  provider: {
    fake: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://example.invalid/v1' },
      models: { tiny: { id: 'tiny', limit: { context: 1000, output: 256 } } },
    },
  },
  compaction: { threshold: 0.5, keepRecentTurns: 2 },
  instructions: [],
  assets: { skills: ['./none'], agents: ['./none'], commands: ['./none'] },
})

const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const {
  findCutIndex,
  estimateMessagesTokens,
  contextTokens,
  contextLimit,
  shouldCompact,
  compact,
} = await import(`${R}/core/compaction.ts`)
const { MockLanguageModelV4, simulateReadableStream } = await import(`${N}/ai/dist/test/index.js`)

// Compaction summarises through streamText, so the fake model needs doStream.
function mockStreaming(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: text },
          { type: 'text-end', id: '1' },
          {
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        ],
        chunkDelayInMs: 0,
        initialDelayInMs: 0,
      }),
    }),
  })
}

function mockFailing(message: string) {
  return new MockLanguageModelV4({
    doStream: async () => {
      throw new Error(message)
    },
  })
}

const cwd = ROOT
let pass = 0
let fail = 0
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`  ok   ${name}`) }
  else { fail++; console.log(`  FAIL ${name} ${detail}`) }
}

// A history with tool round trips, so cut points can orphan tool results.
function history() {
  return [
    { role: 'user', content: 'turn 1 ' + 'x'.repeat(400) },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'a', toolName: 'Read', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'Read', output: { type: 'text', value: 'y'.repeat(400) } }] },
    { role: 'assistant', content: 'did turn 1' },
    { role: 'user', content: 'turn 2 ' + 'x'.repeat(400) },
    { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'b', toolName: 'Grep', input: {} }] },
    { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'b', toolName: 'Grep', output: { type: 'text', value: 'z'.repeat(400) } }] },
    { role: 'assistant', content: 'did turn 2' },
    { role: 'user', content: 'turn 3' },
    { role: 'assistant', content: 'did turn 3' },
    { role: 'user', content: 'turn 4' },
    { role: 'assistant', content: 'did turn 4' },
  ] as any[]
}

console.log('--- findCutIndex never orphans a tool result ---')
for (const keep of [1, 2, 3, 4, 10]) {
  const msgs = history()
  const cut = findCutIndex(msgs, keep)
  const tail = msgs.slice(cut)
  const startsUser = cut === 0 || msgs[cut].role === 'user'
  const orphan = tail.some((m: any, i: number) => {
    if (m.role !== 'tool') return false
    const ids = new Set(
      tail.slice(0, i).flatMap((p: any) =>
        Array.isArray(p.content) ? p.content.filter((c: any) => c.type === 'tool-call').map((c: any) => c.toolCallId) : [],
      ),
    )
    return m.content.some((c: any) => !ids.has(c.toolCallId))
  })
  check(`keep=${keep} cut=${cut} lands on user turn`, startsUser)
  check(`keep=${keep} no orphan tool-result in tail`, !orphan)
}

console.log('--- token accounting ---')
const { config } = await loadConfig(cwd)
const session = new Session({ config, cwd, modelRef: config.model })
await session.init(() => {})
session.messages = history()

const est = estimateMessagesTokens(session.messages)
check('estimate > 0', est > 0, `got ${est}`)
check('limit read from model config = 1000', contextLimit(session) === 1000, String(contextLimit(session)))
check('contextTokens == estimate without baseline', contextTokens(session) === est)

session.tokenBaseline = { messageCount: 4, inputTokens: 5000 }
const withBaseline = contextTokens(session)
check('baseline dominates estimate', withBaseline > 5000 && withBaseline < 5000 + est, String(withBaseline))
session.tokenBaseline = undefined

console.log('--- threshold ---')
check('shouldCompact true over 50% of 1000', shouldCompact(session), `tokens=${contextTokens(session)}`)
session.compactionSuspended = true
check('suspended blocks compaction', !shouldCompact(session))
session.compactionSuspended = false

console.log('--- compact() success path (mock model) ---')
;(session as any).languageModel = mockStreaming('## Task\nbuild hx\n## Work done\ncompaction')
const before = session.messages.length
const r = await compact(session, { trigger: 'manual' })
check('compacted', r.compacted === true, r.reason ?? '')
check('after < before tokens', r.after < r.before, `${r.before} -> ${r.after}`)
check('history shrank', session.messages.length < before, `${before} -> ${session.messages.length}`)
check('first message is user summary block', session.messages[0].role === 'user' && String(session.messages[0].content).includes('<compaction-summary>'))
check('summary text carried over', String(session.messages[0].content).includes('build hx'))
check('tail starts at a user turn', session.messages[1]?.role === 'user', session.messages[1]?.role)
check('tokenBaseline invalidated', session.tokenBaseline === undefined)

await session.transcript.flush()
const records = await session.transcript.read()
check('transcript has compaction record', records.some((x: any) => x.type === 'compaction'))

console.log('--- compact() failure path keeps history ---')
session.messages = history()
;(session as any).languageModel = mockFailing('provider exploded')
const snapshot = session.messages.length
const bad = await compact(session, { trigger: 'manual' })
check('not compacted', bad.compacted === false)
check('reason mentions failure', String(bad.reason).includes('provider exploded'), String(bad.reason))
check('history untouched', session.messages.length === snapshot)

console.log('--- PreCompact hook can block ---')
session.config.hooks = {
  PreCompact: [{ hooks: [{ type: 'command', command: 'node -e "process.exit(2)"', timeout: 15 }] }],
}
const { HookRunner } = await import(`${R}/core/hooks.ts`)
;(session as any).hooks = new HookRunner(session.config.hooks, cwd)
;(session as any).languageModel = mockStreaming('should not run')
const blocked = await compact(session, { trigger: 'auto' })
check('blocked by PreCompact', blocked.compacted === false, blocked.reason ?? '')
check('history untouched after block', session.messages.length === snapshot)

await session.transcript.flush()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
