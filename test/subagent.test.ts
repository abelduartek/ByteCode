// `schema` na tool Agent e continuação de subagente (AgentResume).
//
// Duas coisas que o roadmap listava como U1/U2. A investigação corrigiu uma
// premissa pelo caminho: o `schema` do Workflow nunca validou nada — é um sufixo
// de prompt e um `JSON.parse` do primeiro `{`. O que faltava era a segunda
// chance quando esse parse estoura, que é o modo de falha real (o modelo
// responde com prosa antes do JSON).

const { ROOT, SRC: R, scratch, fixture, fixtureUrl, mockProvider, useConfig, reporter } = await import('./helpers.ts')
const S = await scratch('subagent')

useConfig({
  dataDir: `${S}/data`,
  model: 'mock/tiny',
  provider: { mock: mockProvider('mock-structured.mjs') },
  assets: {
    agents: [fixture('agentassets', 'agents')],
    skills: ['./none'],
    commands: ['./none'],
  },
  instructions: [],
  compaction: { enabled: false },
  permissions: { defaultMode: 'bypassPermissions' },
  subagentDepth: 1,
})

const { check, log, done } = reporter()
const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const meta = await import(`${R}/tools/meta.ts`)
const structured = await import(`${R}/core/structured.ts`)
const mock = await import(fixtureUrl('mock-structured.mjs'))

const { config } = await loadConfig(ROOT)
const session: any = new Session({ config, cwd: S, modelRef: config.model! })
await session.init(() => {})
registerTools(session)
session.emit = () => {}
session.requestPermission = async () => true

const ctx = { session, cwd: S, depth: 0, callId: '' }
const agent = session.registry.get('Agent')
const resume = session.registry.get('AgentResume')

const SCHEMA = {
  type: 'object',
  properties: { achado: { type: 'string' }, confianca: { type: 'string' } },
  required: ['achado'],
}

log('--- o módulo comum ---')
{
  const instrucao = structured.schemaInstruction({ type: 'object' })
  check('a frase que a fixture do workflow usa continua lá',
    instrucao.includes('JSON Schema'), JSON.stringify(instrucao.slice(0, 80)))

  check('lê JSON puro', (structured.parseStructured('{"a":1}') as any).a === 1, '')
  check('lê JSON em fence', (structured.parseStructured('```json\n{"a":2}\n```') as any).a === 2, '')
  check('lê JSON depois de prosa', (structured.parseStructured('Aqui está:\n{"a":3}') as any).a === 3, '')
  check('sem JSON, estoura', (() => {
    try { structured.parseStructured('só prosa'); return false } catch { return true }
  })(), '')
  check('a instrução de reparo diz o erro e repete o schema', (() => {
    const r = structured.repairInstruction({ type: 'object' }, 'no JSON found')
    return r.includes('no JSON found') && r.includes('"type"')
  })(), '')
}

log('--- Agent com schema devolve objeto, não prosa ---')
{
  mock.setMode('json')
  const out = await agent.execute(
    { subagent_type: 'tester', prompt: 'ache o bug', schema: SCHEMA },
    { ...ctx, callId: 'call-json' },
  )
  check('não é erro', !out.isError, JSON.stringify(out.text).slice(0, 120))
  check('o texto inteiro é JSON parseável', (() => {
    try { JSON.parse(out.text); return true } catch { return false }
  })(), JSON.stringify(out.text).slice(0, 160))
  check('com os campos pedidos', JSON.parse(out.text).achado === 'loop.ts:42', out.text)
  check('sem linha de agent_id colada no JSON', !out.text.includes('agent_id'), out.text)
  check('uma chamada só ao modelo', mock.calls.length === 1, String(mock.calls.length))
  check('o schema foi para o prompt', mock.calls[0].text.includes('JSON Schema'), mock.calls[0].text.slice(-80))
}

log('--- prosa na primeira tentativa dispara um reparo ---')
{
  mock.setMode('prose-then-json')
  const out = await agent.execute(
    { subagent_type: 'tester', prompt: 'ache o bug', schema: SCHEMA },
    { ...ctx, callId: 'call-repair' },
  )
  check('o reparo recupera', !out.isError, JSON.stringify(out.text).slice(0, 160))
  check('e o resultado é o JSON, não a prosa', JSON.parse(out.text).achado === 'loop.ts:42', out.text)
  check('custou duas chamadas', mock.calls.length === 2, String(mock.calls.length))
  check('a segunda foi a instrução de reparo',
    mock.calls[1].text.includes('could not be read as JSON'), mock.calls[1].text.slice(0, 90))
  // O bug que o desenho evita: `collected` é append-only e `parseStructured`
  // pega o PRIMEIRO `{`. Sem ler só o delta, o reparo devolveria a prosa da
  // primeira tentativa e chamaria de sucesso.
  check('não devolveu o texto da primeira tentativa', !out.text.includes('Vou explicar'), out.text)
}

log('--- prosa sempre: falha dizendo o que veio ---')
{
  mock.setMode('always-prose')
  const out = await agent.execute(
    { subagent_type: 'tester', prompt: 'ache o bug', schema: SCHEMA },
    { ...ctx, callId: 'call-prose' },
  )
  check('é erro', out.isError === true, JSON.stringify(out.text).slice(0, 120))
  check('diz que não veio JSON', out.text.includes('did not answer with JSON'), out.text.slice(0, 120))
  check('e mostra o que o agente disse', out.text.includes('nao vou responder em json'), out.text.slice(0, 200))
  check('tentou duas vezes antes de desistir', mock.calls.length === 2, String(mock.calls.length))
}

log('--- JSON grande demais não vira JSON truncado ---')
{
  mock.setMode('huge')
  const out = await agent.execute(
    { subagent_type: 'tester', prompt: 'despeje tudo', schema: SCHEMA },
    { ...ctx, callId: 'call-huge' },
  )
  check('recusa em vez de entregar fragmento', out.isError === true, JSON.stringify(out.text).slice(0, 120))
  check('e explica o limite', out.text.includes('would be truncated'), out.text.slice(0, 200))
  check('a saída em si é curta', out.text.length < 500, String(out.text.length))
}

log('--- sem schema, o id do agente volta para poder continuar ---')
{
  mock.setMode('json')
  const out = await agent.execute(
    { subagent_type: 'tester', prompt: 'investigue' },
    { ...ctx, callId: 'call-plain' },
  )
  check('o texto do agente está lá', out.text.includes('achado'), out.text.slice(0, 80))
  check('com o id no fim', out.text.includes('[agent_id: call-plain'), out.text.slice(-90))
  check('e o agente ficou guardado',
    meta.parkedAgents(session).some((a: any) => a.id === 'call-plain'), JSON.stringify(meta.parkedAgents(session).map((a: any) => a.id)))
}

log('--- AgentResume continua a MESMA conversa ---')
{
  mock.setMode('echo')
  const primeiro = await agent.execute(
    { subagent_type: 'tester', prompt: 'primeira pergunta' },
    { ...ctx, callId: 'call-resume' },
  )
  const vistasNoPrimeiro = Number(primeiro.text.match(/vi (\d+) mensagens/)?.[1] ?? 0)
  check('o primeiro turno viu poucas mensagens', vistasNoPrimeiro > 0, String(vistasNoPrimeiro))

  const seguinte = await resume.execute({ agent_id: 'call-resume', prompt: 'e agora?' }, ctx)
  check('resume não é erro', !seguinte.isError, JSON.stringify(seguinte.text).slice(0, 140))
  const vistasNoSegundo = Number(seguinte.text.match(/vi (\d+) mensagens/)?.[1] ?? 0)
  check('o segundo turno enxergou o histórico do primeiro',
    vistasNoSegundo > vistasNoPrimeiro, `${vistasNoPrimeiro} -> ${vistasNoSegundo}`)
  check('continua resumível', seguinte.text.includes('still resumable'), seguinte.text.slice(-60))
}

log('--- AgentResume: erros ---')
{
  const inexistente = await resume.execute({ agent_id: 'nao-existe', prompt: 'x' }, ctx)
  check('id desconhecido é erro', inexistente.isError === true, '')
  check('e lista os que existem', inexistente.text.includes('call-resume'), inexistente.text.slice(0, 200))

  const profundo = await resume.execute({ agent_id: 'call-resume', prompt: 'x' }, { ...ctx, depth: 1 })
  check('subagente não pode continuar outro subagente',
    profundo.isError === true && profundo.text.includes('depth'), JSON.stringify(profundo.text))
}

log('--- o store é limitado e zerável ---')
{
  mock.setMode('json')
  for (let i = 0; i < 6; i++) {
    await agent.execute({ subagent_type: 'tester', prompt: 'x' }, { ...ctx, callId: `lote-${i}` })
  }
  const guardados = meta.parkedAgents(session)
  check('não guarda mais que o teto', guardados.length === 4, String(guardados.length))
  check('descarta os mais antigos',
    guardados.every((a: any) => a.id.startsWith('lote-')) && guardados.some((a: any) => a.id === 'lote-5'),
    JSON.stringify(guardados.map((a: any) => a.id)))
  check('o mais velho do lote saiu',
    !guardados.some((a: any) => a.id === 'lote-0'), JSON.stringify(guardados.map((a: any) => a.id)))

  meta.clearParkedAgents(session)
  check('clear zera', meta.parkedAgents(session).length === 0, '')
  const depois = await resume.execute({ agent_id: 'lote-5', prompt: 'x' }, ctx)
  check('e depois do clear o id não resolve mais', depois.isError === true, '')
  check('avisando que não há nenhum guardado', depois.text.includes('None are kept'), depois.text.slice(0, 120))
}

log('--- subagente guardado não fala mais com a UI ---')
{
  mock.setMode('json')
  const eventos: any[] = []
  session.emit = (e: any) => eventos.push(e)
  await agent.execute({ subagent_type: 'tester', prompt: 'x' }, { ...ctx, callId: 'call-mudo' })
  const guardado = meta.parkedAgents(session).find((a: any) => a.id === 'call-mudo')!
  const antes = eventos.length
  guardado.session.emit({ type: 'text', text: 'não deveria aparecer' })
  check('o emit do agente parkeado é mudo', eventos.length === antes, String(eventos.length - antes))
  session.emit = () => {}
}

await session.mcp.close()
done()
