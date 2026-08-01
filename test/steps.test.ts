// Orçamento de chamadas ao modelo por turno.
//
// Antes o teto era fixo em 64 e o turno morria com `stopped after 64 steps` —
// erro, sem aviso prévio e sem caminho de volta. Um refactor longo perdia junto
// o resumo do que já tinha feito.

const { ROOT, SRC: R, scratch, fixtureUrl, mockProvider, useConfig, reporter } = await import('./helpers.ts')
const S = await scratch('steps')

useConfig({
  dataDir: `${S}/data`,
  model: 'mock/tiny',
  provider: { mock: mockProvider('mock-endless.mjs') },
  assets: { agents: ['./none'], skills: ['./none'], commands: ['./none'] },
  instructions: [],
  compaction: { enabled: false },
  permissions: { defaultMode: 'bypassPermissions' },
  maxSteps: 4,
})

const { check, log, done } = reporter()
const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const { runTurn } = await import(`${R}/core/loop.ts`)
const mock = await import(fixtureUrl('mock-endless.mjs'))

const { config } = await loadConfig(ROOT)

async function newSession(overrides: Record<string, unknown> = {}): Promise<any> {
  const session: any = new Session({ config: { ...config, ...overrides }, cwd: S, modelRef: config.model! })
  await session.init(() => {})
  registerTools(session)
  session.requestPermission = async () => true
  return session
}

log('--- o teto para o turno sem chamar de erro ---')
{
  mock.reset()
  const session = await newSession()
  const events: any[] = []
  session.emit = (e: any) => events.push(e)

  await runTurn(session, 'faça para sempre')

  check('parou exatamente no teto', mock.stats.calls === 4, String(mock.stats.calls))
  check('contabilizou os steps', session.sessionStats.steps === 4, String(session.sessionStats.steps))
  check('não emitiu erro', !events.some(e => e.type === 'error'), JSON.stringify(events.filter(e => e.type === 'error')))

  const aviso = events.filter(e => e.type === 'notice').map(e => e.text).join(' | ')
  check('avisou que parou no teto', aviso.includes('parado em 4 chamadas'), aviso)
  check('e diz como seguir', aviso.includes('continue'), aviso)
  check('e diz qual botão mexer', aviso.includes('maxSteps'), aviso)

  await session.mcp.close()
}

log('--- o modelo é avisado antes de acabar o orçamento ---')
{
  mock.reset()
  const session = await newSession()
  session.emit = () => {}
  await runTurn(session, 'faça para sempre')

  const lembretes = session.messages.filter(
    (m: any) => typeof m.content === 'string' && m.content.includes('model calls'),
  )
  check('avisou uma vez só', lembretes.length === 1, String(lembretes.length))
  // 75% de 4 = 3: o aviso sai depois do terceiro step, sobrando um para fechar.
  check('avisou no ponto certo', lembretes[0]?.content.includes('3 of 4'), JSON.stringify(lembretes[0]?.content))
  check('manda convergir, não começar coisa nova',
    lembretes[0]?.content.includes('Do not begin new work'), JSON.stringify(lembretes[0]?.content))

  await session.mcp.close()
}

log('--- o histórico sobrevive, então dá para continuar ---')
{
  mock.reset()
  const session = await newSession()
  session.emit = () => {}
  await runTurn(session, 'primeira metade')
  const depoisDoPrimeiro = session.messages.length
  check('histórico intacto', depoisDoPrimeiro > 0, String(depoisDoPrimeiro))

  await runTurn(session, 'continue')
  check('o segundo turno roda de novo com o teto cheio', mock.stats.calls === 8, String(mock.stats.calls))
  check('e o histórico cresceu em vez de reiniciar',
    session.messages.length > depoisDoPrimeiro, `${depoisDoPrimeiro} -> ${session.messages.length}`)

  await session.mcp.close()
}

log('--- teto configurável ---')
{
  mock.reset()
  const session = await newSession({ maxSteps: 2 })
  session.emit = () => {}
  await runTurn(session, 'x')
  check('maxSteps:2 para em dois', mock.stats.calls === 2, String(mock.stats.calls))

  mock.reset()
  const zero = await newSession({ maxSteps: 0 })
  zero.emit = () => {}
  await runTurn(zero, 'x')
  check('maxSteps:0 ainda faz uma chamada (não trava o turno)', mock.stats.calls === 1, String(mock.stats.calls))

  await session.mcp.close()
  await zero.mcp.close()
}

done()
