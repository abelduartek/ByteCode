const { ROOT, SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('session')
useConfig({
  model: 'mock/tiny',
  provider: { mock: { npm: fixtureUrl('mock-perf.mjs'), models: { tiny: { id: 'tiny', limit: { context: 1000000, output: 4096 } } } } },
  assets: { agents: [fixture('agentassets', 'agents')], skills: ['./none'], commands: ['./none'] },
  instructions: [],
  compaction: { enabled: false },
  permissions: { defaultMode: 'bypassPermissions' },
  subagentDepth: 1,
})

const { promises: fsp } = await import('node:fs')
const nodePath = await import('node:path')

// Data dir isolado por execucao: o teste nao pode ver nem sujar sessoes reais.
const DATA = `${S}\\hx-session-data`
await fsp.rm(DATA, { recursive: true, force: true })

const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const { runTurn } = await import(`${R}/core/loop.ts`)
const sessions = await import(`${R}/core/sessions.ts`)
const mock = await import(fixtureUrl('mock-perf.mjs'))

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const cwd = ROOT
const loaded = await loadConfig(cwd)
const config = { ...loaded.config, dataDir: DATA }

async function newSession(sessionId?: string) {
  const s = new Session({ config, cwd, modelRef: config.model!, sessionId })
  await s.init(() => {})
  registerTools(s)
  s.emit = () => {}
  s.requestPermission = async () => true
  return s
}

console.log('--- persistencia ---')
const first = await newSession()
{
  mock.reset()
  mock.script.push(mock.text('primeira resposta'))
  await runTurn(first, 'como funciona o retry do loop?')

  const all = await sessions.listSessions(config, cwd)
  check('sessao gravada apos o turno', all.length === 1, JSON.stringify(all.map(s => s.short)))
  check('id casa com o transcript', all[0]?.id === first.transcript.sessionId, all[0]?.id)
  check('titulo vem da 1a mensagem do usuario', all[0]?.title === 'como funciona o retry do loop?', all[0]?.title)
  check('contou 1 turno', all[0]?.turns === 1, String(all[0]?.turns))
  check('short tem 8 chars', all[0]?.short.length === 8, all[0]?.short)
  check('modelo registrado', all[0]?.modelRef === config.model, all[0]?.modelRef)

  mock.script.push(mock.text('segunda resposta'))
  await runTurn(first, 'e o backoff?')
  const after = await sessions.listSessions(config, cwd)
  check('mesma sessao, nao uma nova', after.length === 1, String(after.length))
  check('contou 2 turnos', after[0]?.turns === 2, String(after[0]?.turns))
  check('createdAt preservado', after[0]?.createdAt === all[0]?.createdAt, '')
  check('updatedAt avancou', Date.parse(after[0]!.updatedAt) >= Date.parse(all[0]!.updatedAt), '')
}

console.log('--- titulo ignora os blocos do harness ---')
{
  const clean = sessions.titleFrom([
    { role: 'user', content: '<system-reminder>\nroster gigante\n</system-reminder>\n\npergunta real' },
  ] as never)
  check('system-reminder nao vira titulo', clean === 'pergunta real', JSON.stringify(clean))

  const cmd = sessions.titleFrom([
    { role: 'user', content: '<command-name>/review</command-name>\n<command-args>x</command-args>\ncorpo' },
  ] as never)
  check('command-name entra sem as tags', cmd.includes('/review') && !cmd.includes('<'), JSON.stringify(cmd))
  check('sem mensagem de usuario vira placeholder', sessions.titleFrom([] as never) === '(sem título)', '')
}

console.log('--- resume ---')
const savedId = first.transcript.sessionId
const savedMessages = first.messages.length
await first.mcp.close()
{
  const fresh = await newSession()
  check('sessao nova comeca vazia', fresh.messages.length === 0, String(fresh.messages.length))

  const state = await sessions.loadSession(config, cwd, savedId)
  check('state carregado', Boolean(state?.messages?.length), String(state?.messages?.length))
  fresh.resumeFrom(state!)

  check('historico restaurado', fresh.messages.length === savedMessages, `${fresh.messages.length} vs ${savedMessages}`)
  check('transcript aponta pra mesma sessao', fresh.transcript.sessionId === savedId, fresh.transcript.sessionId)
  check('bootstrap marcado como feito', fresh.bootstrapped === true, '')
  check('tool-calls preservados (nao lossy)',
    JSON.stringify(fresh.messages).includes('"role":"assistant"'), '')

  // Continuar a sessao retomada grava no mesmo id
  mock.reset()
  mock.script.push(mock.text('terceira'))
  await runTurn(fresh, 'terceira pergunta')
  const all = await sessions.listSessions(config, cwd)
  check('continua a mesma sessao, sem duplicar', all.length === 1, JSON.stringify(all.map(s => s.short)))
  check('turnos acumularam', all[0]?.turns === 3, String(all[0]?.turns))
  await fresh.mcp.close()
}

console.log('--- resume por prefixo ---')
{
  const short = savedId.slice(0, 8)
  const byPrefix = await sessions.loadSession(config, cwd, short)
  check('prefixo de 8 resolve', byPrefix?.id === savedId, byPrefix?.id)
  check('id inexistente devolve null', (await sessions.loadSession(config, cwd, 'zzzzzzzz')) === null, '')

  const s2 = await newSession()
  mock.script.push(mock.text('outra'))
  await runTurn(s2, 'outra conversa')
  const two = await sessions.listSessions(config, cwd)
  check('duas sessoes agora', two.length === 2, String(two.length))
  check('mais recente primeiro', two[0]?.id === s2.transcript.sessionId, two[0]?.short)

  const latest = await sessions.latestSession(config, cwd)
  check('latestSession devolve a mais nova', latest?.id === s2.transcript.sessionId, latest?.id)
  await s2.mcp.close()
}

console.log('--- modo de permissao NAO e restaurado ---')
{
  const escalated = await newSession()
  escalated.mode = 'bypassPermissions'
  mock.reset()
  mock.script.push(mock.text('ok'))
  await runTurn(escalated, 'algo perigoso')
  const id = escalated.transcript.sessionId
  await escalated.mcp.close()

  const back = await newSession()
  back.mode = 'default'
  back.resumeFrom((await sessions.loadSession(config, cwd, id))!)
  check('retomar nao reativa bypassPermissions', back.mode === 'default', back.mode)
  await back.mcp.close()
}

console.log('--- subagente nao cria sessao ---')
{
  const parent = await newSession()
  const before = (await sessions.listSessions(config, cwd)).length
  const child = parent.child({ agentType: 'x' })
  await child.init(() => {})
  registerTools(child)
  child.emit = () => {}
  mock.reset()
  mock.script.push(mock.text('filho respondeu'))
  await runTurn(child, 'tarefa do filho')
  const after = (await sessions.listSessions(config, cwd)).length
  check('turno de subagente nao vira sessao retomavel', after === before, `${before} -> ${after}`)
  await child.mcp.close()
  await parent.mcp.close()
}

console.log('--- model curto no frontmatter do agent ---')
{
  // Agent files do Claude Code dizem `model: opus`, não `provider/model`.
  // Antes isso estourava: 'model must be "provider/model", got "opus"'.
  const parent = await newSession()
  const agentName = parent.assets.agents[0]?.name
  const events: string[] = []
  parent.emit = e => {
    if (e.type === 'error') events.push(`ERR:${e.text}`)
  }
  parent.requestPermission = async () => true

  if (agentName) {
    mock.reset()
    mock.script.push(
      mock.tools([{ name: 'Agent', input: { subagent_type: agentName, prompt: 'x', description: 'd', model: 'tiny' } }]),
      mock.text('filho ok'),
      mock.text('pai ok'),
    )
    await runTurn(parent, 'delega com model curto')
    const toolText = JSON.stringify(parent.messages.filter(m => m.role === 'tool'))
    check('nome curto resolve para provider/model', !toolText.includes('must be "provider/model"'),
      JSON.stringify(events.slice(0, 2)))
    check('subagente respondeu', toolText.includes('filho ok'), toolText.slice(0, 200))

    mock.reset()
    mock.script.push(
      mock.tools([{ name: 'Agent', input: { subagent_type: agentName, prompt: 'x', description: 'd', model: 'nao-existe-zzz' } }]),
      mock.text('filho fallback'),
      mock.text('pai ok'),
    )
    await runTurn(parent, 'delega com model inexistente')
    const fallback = JSON.stringify(parent.messages.filter(m => m.role === 'tool'))
    check('model desconhecido cai no modelo da sessão em vez de estourar',
      fallback.includes('filho fallback'), fallback.slice(-200))
  }
  await parent.mcp.close()
}

console.log('--- subagent fica no provider da sessão ---')
{
  // Dois providers declaram a MESMA chave de modelo. Um subagente com
  // `model: sonnet` tem que ficar no provider da sessão, que é o autenticado —
  // pular para outro provider era o que gerava 401 só no filho.
  const twoProviders = {
    ...config,
    model: 'mine/sonnet',
    provider: {
      other: { npm: config.provider!.mock.npm, models: { sonnet: { id: 'o-sonnet' }, opus: { id: 'o-opus' } } },
      mine: { npm: config.provider!.mock.npm, models: { sonnet: { id: 'm-sonnet' }, sonnet5: { id: 'm-s5' } } },
    },
  } as never

  const s = new Session({ config: twoProviders, cwd, modelRef: 'mine/sonnet' })
  await s.init(() => {})
  registerTools(s)
  s.emit = () => {}
  s.requestPermission = async () => true

  const agentName = s.assets.agents[0]?.name
  if (agentName) {
    const refs: string[] = []
    const original = s.child.bind(s)
    s.child = opts => {
      refs.push(String(opts.modelRef))
      return original(opts)
    }

    mock.reset()
    mock.script.push(
      mock.tools([{ name: 'Agent', input: { subagent_type: agentName, prompt: 'x', description: 'd', model: 'sonnet' } }]),
      mock.text('filho'),
      mock.text('pai'),
    )
    await runTurn(s, 'delega')
    check('ficou no provider da sessão', refs[0] === 'mine/sonnet', JSON.stringify(refs))

    refs.length = 0
    mock.reset()
    mock.script.push(
      mock.tools([{ name: 'Agent', input: { subagent_type: agentName, prompt: 'x', description: 'd', model: 'opus' } }]),
      mock.text('filho'),
      mock.text('pai'),
    )
    await runTurn(s, 'delega opus')
    check('modelo que só existe noutro provider ainda é achado', refs[0] === 'other/opus', JSON.stringify(refs))

    refs.length = 0
    mock.reset()
    mock.script.push(
      mock.tools([{ name: 'Agent', input: { subagent_type: agentName, prompt: 'x', description: 'd', model: 'provider/explicito' } }]),
      mock.text('filho'),
      mock.text('pai'),
    )
    await runTurn(s, 'delega explicito')
    check('ref completo é respeitado como está', refs[0] === 'provider/explicito', JSON.stringify(refs))
  }
  await s.mcp.close()
}

console.log('--- 401 diz onde colocar a chave ---')
{
  const s = await newSession()
  const errors: string[] = []
  s.emit = e => { if (e.type === 'error') errors.push(e.text) }

  mock.reset()
  mock.script.push(mock.failure({ status: 401, message: 'Authentication Error, No api key passed in.' }))
  // Uma falha permanente do provider REJEITA o turno — é assim que um subagent
  // ou um passo de workflow descobre que não recebeu resposta nenhuma.
  let rejeitou = false
  await runTurn(s, 'oi').catch(() => { rejeitou = true })
  check('falha permanente rejeita o turno', rejeitou, '')

  const text = errors.join('\n')
  check('nomeia o provider/modelo', text.includes('mock/tiny'), text.slice(0, 200))
  check('nomeia a env var convencional', text.includes('$MOCK_API_KEY'), text.slice(0, 300))
  check('aponta o comando connect', text.includes('bytecode connect mock'), text.slice(0, 300))
  check('aponta o auth.json', /auth\.json/.test(text), text.slice(0, 300))
  check('mostra a forma na config', text.includes('"apiKey"'), text.slice(0, 400))

  // erro que não é de auth não ganha a dica
  errors.length = 0
  mock.reset()
  mock.script.push(mock.failure({ status: 400, message: 'bad request' }))
  await runTurn(s, 'oi').catch(() => {})
  check('erro sem relação não ganha a dica', !errors.join('\n').includes('Sem credencial'), errors.join('\n').slice(0, 120))
  await s.mcp.close()
}

console.log('--- formatWhen ---')
{
  const now = Date.parse('2026-07-29T15:00:00')
  const f = (iso: string) => sessions.formatWhen(Date.parse(iso), now)
  check('agora', f('2026-07-29T14:59:40') === 'agora', f('2026-07-29T14:59:40'))
  check('minutos', f('2026-07-29T14:20:00') === 'há 40 min', f('2026-07-29T14:20:00'))
  check('hoje com hora', f('2026-07-29T09:05:00') === 'hoje 09:05', f('2026-07-29T09:05:00'))
  check('ontem com hora', f('2026-07-28T22:41:00') === 'ontem 22:41', f('2026-07-28T22:41:00'))
  check('mes abreviado no mesmo ano', f('2026-03-11T10:00:00') === '11 mar', f('2026-03-11T10:00:00'))
  check('ano cheio se for outro ano', f('2025-12-02T10:00:00') === '02/12/2025', f('2025-12-02T10:00:00'))
  check('sem data', sessions.formatWhen(0, now) === '—', '')
}

console.log('--- eventos de subagente (nao poluem o transcript) ---')
{
  const parent = await newSession()
  const events: string[] = []
  const toolBlocks: string[] = []
  parent.emit = e => {
    events.push(e.type)
    if (e.type === 'agent-start') events.push(`start:${e.agentType}:${e.label}`)
    if (e.type === 'agent-event') {
      const inner = e.event
      events.push(`fwd:${inner.type}${inner.type === 'tool-start' ? `:${inner.name}` : ''}`)
    }
    if (e.type === 'agent-end') events.push(`end:${e.ok}`)
    // o que o pai registraria como bloco de tool
    if (e.type === 'tool-start') toolBlocks.push(e.name)
  }
  parent.requestPermission = async () => true

  const agentName = parent.assets.agents[0]?.name
  check('existe agent no disco pra testar', Boolean(agentName), String(agentName))

  if (agentName) {
    mock.reset()
    // `tester` declara apenas Read e Glob no frontmatter.
    mock.script.push(
      mock.tools([{ name: 'Agent', input: { subagent_type: agentName, prompt: 'investigue', description: 'teste rapido' } }]),
      // turno do filho: usa uma tool e responde
      mock.tools([{ name: 'Glob', input: { pattern: 'src/**/*.ts' } }]),
      mock.text('RELATORIO'),
      mock.text('pai fechou'),
    )
    await runTurn(parent, 'delega')

    const agentResult = JSON.stringify(parent.messages.filter(m => m.role === 'tool'))
    check('emitiu agent-start', events.some(e => e.startsWith('start:')), JSON.stringify(events.filter(e => e.includes(':'))))
    check('label vem do description', events.some(e => e === `start:${agentName}:teste rapido`), JSON.stringify(events.filter(e => e.startsWith('start'))))
    check('encaminhou os eventos do filho', events.includes('fwd:tool-start:Glob'), JSON.stringify(events.filter(e => e.startsWith('fwd'))))
    check('encaminhou o texto do filho também', events.includes('fwd:text'), JSON.stringify(events.filter(e => e.startsWith('fwd'))))
    check('emitiu agent-end ok', events.includes('end:true'), `${JSON.stringify(events.filter(e => e.startsWith('end')))} result=${agentResult.slice(0, 300)}`)
    check('tool do filho NAO virou bloco no pai', !toolBlocks.includes('Glob'), JSON.stringify(toolBlocks))
    check('pai registrou so a tool Agent', toolBlocks.filter(t => t === 'Agent').length === 1, JSON.stringify(toolBlocks))
    check('texto do filho nao vazou pra resposta do pai',
      !JSON.stringify(parent.messages.filter(m => m.role === 'assistant')).includes('RELATORIO') ||
      JSON.stringify(parent.messages.filter(m => m.role === 'tool')).includes('RELATORIO'), '')

    // transcript: registros do filho marcados como sidechain
    await parent.transcript.flush()
    const records = await parent.transcript.read()
    const side = records.filter(r => r.isSidechain)
    check('registros do filho marcados isSidechain', side.length > 0, String(side.length))
    check('sidechain carrega o agentId', side.every(r => r.agentId === agentName), JSON.stringify([...new Set(side.map(r => r.agentId))]))
    check('registros do pai nao sao sidechain', records.some(r => !r.isSidechain), '')
  }
  await parent.mcp.close()
}

await fsp.rm(DATA, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
