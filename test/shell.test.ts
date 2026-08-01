// Codificação da saída do shell e uso de tokens do provider.
//
// Os dois vieram de uma sessão real: um `/ado-workitem` mostrou
// `PIX---Expans�o` na saída do PowerShell e `tokens entrada 0 · custo $0.0000`
// no `/leadtime`, com 8 chamadas ao modelo.

const { ROOT, SRC: R, scratch, mockProvider, useConfig, reporter, fixtureUrl } = await import('./helpers.ts')
const S = await scratch('shell')

useConfig({
  dataDir: `${S}/data`,
  model: 'mock/tiny',
  provider: { mock: mockProvider('mock-parity.mjs') },
  assets: { agents: ['./none'], skills: ['./none'], commands: ['./none'] },
  instructions: [],
  compaction: { enabled: false },
  permissions: { defaultMode: 'bypassPermissions' },
})

const { check, log, done } = reporter()
const { loadConfig } = await import(`${R}/config/load.ts`)
const { shellTools } = await import(`${R}/tools/shell.ts`)
const { createLanguageModel } = await import(`${R}/provider/registry.ts`)
const mock = await import(fixtureUrl('mock-parity.mjs'))

const { config } = await loadConfig(ROOT)
const ctx = { session: { config } as never, cwd: ROOT, depth: 0 }

log('--- acento sobrevive à volta do shell ---')
{
  const ACENTOS = 'Expansão ção ãé çü'
  const ps = shellTools.find(t => t.name === 'PowerShell')
  if (ps) {
    // PowerShell 5.1 escreve na codepage do console (850 numa máquina pt-BR) e
    // este processo decodifica UTF-8 — sem a correção, `Expans<?>o`.
    const out = await ps.execute({ command: `Write-Output "${ACENTOS}"` }, ctx)
    check('PowerShell devolve acento intacto', out.text.includes(ACENTOS), JSON.stringify(out.text))
    check('e não vaza o preâmbulo de encoding',
      !out.text.includes('OutputEncoding'), JSON.stringify(out.text.slice(0, 120)))

    const erro = await ps.execute({ command: 'Write-Error "falha ção"' }, ctx)
    check('erro do PowerShell também vem acentuado', erro.text.includes('falha ção'), JSON.stringify(erro.text.slice(0, 90)))
    check('e sem o preâmbulo', !erro.text.includes('OutputEncoding'), JSON.stringify(erro.text.slice(0, 120)))

    const code = await ps.execute({ command: 'exit 3' }, ctx)
    check('o preâmbulo não muda o exit code', code.text.includes('exit code 3'), JSON.stringify(code.text))
    check('e exit != 0 continua sendo erro', code.isError === true, '')
  } else {
    check('PowerShell não registrada nesta plataforma — nada a checar', true, '')
  }

  const bash = shellTools.find(t => t.name === 'Bash')
  if (bash) {
    const out = await bash.execute({ command: `echo "${ACENTOS}"` }, ctx)
    check('Bash já vinha certo e continua', out.text.includes(ACENTOS), JSON.stringify(out.text))
  }
}

log('--- o provider pede as métricas de uso ---')
{
  const resolved: any = {
    providerId: 'mock',
    modelKey: 'tiny',
    modelId: 'tiny',
    provider: config.provider!.mock,
    model: {},
  }
  // Contra o pacote real: ele guarda a opção em `model.config`, então dá para
  // afirmar o que sai na rede sem chamar rede nenhuma.
  // Id distinto por caso: o cache de instâncias é chaveado por `providerId`, e
  // numa config real um id tem exatamente um bloco de `options` — reusar o mesmo
  // id aqui devolveria a instância do caso anterior.
  const compat = (id: string, options: Record<string, unknown> = {}) => ({
    providerId: id,
    modelKey: 'm',
    modelId: 'm',
    provider: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://exemplo.invalid/v1', ...options }, models: {} },
    model: {},
  })

  // Um servidor OpenAI-compatible não manda `usage` numa resposta em stream a
  // menos que o request peça (`stream_options: { include_usage: true }`) — foi
  // por isso que todo turno reportava 0 tokens, $0.00, e o `tokenBaseline` nunca
  // era preenchido.
  const ligado: any = await createLanguageModel(compat('usage-on') as any, {})
  check('includeUsage vai para o provider openai-compatible',
    ligado?.config?.includeUsage === true, JSON.stringify(ligado?.config?.includeUsage))

  const desligado: any = await createLanguageModel(compat('usage-off', { includeUsage: false }) as any, {})
  check('mas a config do usuário vence',
    desligado?.config?.includeUsage === false, JSON.stringify(desligado?.config?.includeUsage))

  // Um provider que não é o pacote openai-compatible não deve receber a opção:
  // ela não significa nada fora dele.
  mock.built.options = null
  await createLanguageModel(resolved, {})
  check('provider de outro pacote não recebe o campo',
    mock.built.options !== null && mock.built.options.includeUsage === undefined,
    JSON.stringify(mock.built.options?.includeUsage))
}

done()
