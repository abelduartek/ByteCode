const { ROOT, SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('think')
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

const { ThinkFilter, stripThinking } = await import(`${R}/core/reasoning.ts`)
const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const { runTurn } = await import(`${R}/core/loop.ts`)
const { MockLanguageModelV4, simulateReadableStream } = await import(`${N}/ai/dist/test/index.js`)

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

console.log('--- ThinkFilter ---')
{
  const f = new ThinkFilter()
  const r = f.push('<think>raciocinio</think>resposta')
  check('separa em uma so passada', r.text === 'resposta' && r.reasoning === 'raciocinio', JSON.stringify(r))
}
{
  // Tag quebrada entre deltas — o caso que aparece no streaming de verdade.
  const f = new ThinkFilter()
  let text = ''
  let reasoning = ''
  for (const chunk of ['<th', 'ink>', 'pen', 'sando', '</thi', 'nk>', 'Res', 'posta']) {
    const r = f.push(chunk)
    text += r.text
    reasoning += r.reasoning
  }
  const t = f.flush()
  text += t.text
  check('tag partida entre deltas', text === 'Resposta', JSON.stringify(text))
  check('raciocinio capturado', reasoning === 'pensando', JSON.stringify(reasoning))
}
{
  const f = new ThinkFilter()
  const r = f.push('texto normal sem tag')
  check('sem tag passa direto', r.text === 'texto normal sem tag' && r.reasoning === '', JSON.stringify(r))
}
{
  const f = new ThinkFilter()
  const r = f.push('antes <think>meio')
  check('marca que esta pensando', f.isThinking === true, '')
  check('entrega o que ja da para entregar', r.text === 'antes ' && r.reasoning === 'meio', JSON.stringify(r))
  // Bloco nao fechado: o flush nao pode vazar o resto para o texto visivel.
  const t = new ThinkFilter()
  t.push('resposta <think>pensando sem fechar')
  check('flush de bloco aberto nao vira texto', t.flush().text === '', JSON.stringify(t.flush()))
}
{
  const f = new ThinkFilter()
  const r = f.push('a<thinking>x</thinking>b<reasoning>y</reasoning>c')
  check('aceita <thinking> e <reasoning>', r.text === 'abc' && r.reasoning === 'xy', JSON.stringify(r))
}
{
  const f = new ThinkFilter()
  const r = f.push('resposta com < sinal de menor e 3<4')
  check('"<" solto nao e engolido', r.text + f.flush().text === 'resposta com < sinal de menor e 3<4', JSON.stringify(r))
}
check('stripThinking limpa texto pronto', stripThinking('<think></think>Oi') === 'Oi', stripThinking('<think></think>Oi'))

console.log('--- turno completo com modelo simulado ---')
{
  const cwd = ROOT
  const { config } = await loadConfig(cwd)
  const session = new Session({ config, cwd, modelRef: config.model })
  await session.init(() => {})
  registerTools(session)

  const chunks = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: '1' },
    // Exatamente o formato que o 9router manda: tag partida entre deltas.
    { type: 'text-delta', id: '1', delta: '<th' },
    { type: 'text-delta', id: '1', delta: 'ink>vou analisar o projeto' },
    { type: 'text-delta', id: '1', delta: '</think>' },
    { type: 'text-delta', id: '1', delta: 'Este projeto e um harness ' },
    { type: 'text-delta', id: '1', delta: 'multi-provider.' },
    { type: 'text-end', id: '1' },
    { type: 'finish', finishReason: 'stop', usage: { inputTokens: 10, outputTokens: 8, totalTokens: 18 } },
  ]
  ;(session as any).languageModel = new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({ chunks, chunkDelayInMs: 0, initialDelayInMs: 0 }),
    }),
  })

  let text = ''
  let reasoning = ''
  session.emit = (e: any) => {
    if (e.type === 'text') text += e.text
    if (e.type === 'reasoning') reasoning += e.text
  }
  await runTurn(session, 'Quero que me explique tudo oque esse projeto e')

  check('nenhuma tag <think> no texto visivel', !text.includes('<think>') && !text.includes('</think>'), JSON.stringify(text))
  check('texto visivel correto', text.trim() === 'Este projeto e um harness multi-provider.', JSON.stringify(text))
  check('raciocinio foi para o canal certo', reasoning === 'vou analisar o projeto', JSON.stringify(reasoning))

  const records = await (async () => {
    await session.transcript.flush()
    return session.transcript.read()
  })()
  const assistant = records.find((r: any) => r.type === 'assistant')
  const stored = String((assistant as any)?.message?.text ?? '')
  check('transcript tambem sem tag', !stored.includes('<think>'), JSON.stringify(stored))

  await session.mcp.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
