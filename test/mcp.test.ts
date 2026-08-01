const { SRC: R, scratch } = await import('./helpers.ts')
const S = await scratch('mcp')

// HOME isolada: a descoberta lê ~/.config/opencode e ~/.claude.json, e nenhum
// teste pode depender (nem escrever) na casa real da máquina.
const nodePath = await import('node:path')
const { promises: fsp } = await import('node:fs')
const HOME = nodePath.join(S, 'fakehome')
await fsp.mkdir(HOME, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.HOMEDRIVE = ''
process.env.HOMEPATH = ''

const discover = await import(`${R}/mcp/discover.ts`)
const { McpManager, childEnv, explainFailure } = await import(`${R}/mcp/client.ts`)

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const write = async (file: string, text: string) => {
  await fsp.mkdir(nodePath.dirname(file), { recursive: true })
  await fsp.writeFile(file, text, 'utf8')
}

const PROJECT = nodePath.join(S, 'projeto')
await fsp.mkdir(PROJECT, { recursive: true })

// Um PAT de verdade tem tamanho suficiente para acionar a heurística de segredo.
const FAKE_PAT = 'x'.repeat(84)

// ------------------------------------------------------------ configs sintéticas

await write(
  nodePath.join(HOME, '.config', 'opencode', 'opencode.jsonc'),
  `{
  // comentário: o parser tem que tolerar
  "mcp": {
    "azure-devops": {
      "type": "local",
      "command": ["npx", "-y", "@azure-devops/mcp", "org"],
      "environment": { "ADO_PAT": "${FAKE_PAT}" },
      "enabled": true
    },
    "so-do-opencode": { "type": "local", "command": ["node", "servidor.mjs"] },
    "colide": { "type": "local", "command": ["node", "opencode-user.mjs"] }
  }
}
`,
)

await write(
  nodePath.join(PROJECT, '.opencode', 'opencode.json'),
  JSON.stringify({
    mcp: { colide: { type: 'local', command: ['node', 'opencode-projeto.mjs'] } },
  }),
)

await write(
  nodePath.join(HOME, '.claude.json'),
  JSON.stringify({
    mcpServers: {
      supabase: { type: 'stdio', command: 'npx', args: ['-y', '@supabase/mcp'], env: {} },
      global: { type: 'stdio', command: 'node', args: ['global.mjs'] },
      remoto: { type: 'sse', url: 'https://exemplo.invalid/sse', headers: { 'X-Tok': 'abc' } },
      quebrado: { type: 'stdio' },
    },
    projects: {
      // Mesmo diretório com a outra barra: é assim que aparece no arquivo real.
      [PROJECT.replace(/\\/g, '/')]: {
        mcpServers: { global: { type: 'stdio', command: 'node', args: ['do-projeto.mjs'] } },
      },
      [nodePath.join(S, 'outro')]: {
        mcpServers: { de_outro: { type: 'stdio', command: 'node', args: ['nao.mjs'] } },
      },
    },
  }),
)

await write(
  nodePath.join(PROJECT, '.mcp.json'),
  JSON.stringify({ mcpServers: { doProjeto: { command: 'node', args: ['p.mjs'] } } }),
)

const ownConfig = {
  mcp: {
    meu: { type: 'local', command: ['node', 'meu.mjs'] },
    colide: { type: 'local', command: ['node', 'meu-colide.mjs'] },
  },
} as never

console.log('--- sem inheritMcp nada é herdado ---')
{
  const found = await discover.discoverMcpServers(ownConfig, PROJECT)
  check('só os próprios', found.length === 2, JSON.stringify(found.map(s => s.name)))
  check('marcados como own', found.every(s => s.source === 'own'), JSON.stringify(found.map(s => s.source)))

  const empty = await discover.discoverMcpServers({} as never, PROJECT)
  check('config sem mcp e sem inheritMcp resolve vazio', empty.length === 0, JSON.stringify(empty))
}

console.log('--- inheritMcp preenche só as lacunas ---')
{
  const config = { ...(ownConfig as object), inheritMcp: true } as never
  const found = await discover.discoverMcpServers(config, PROJECT)
  const byName = Object.fromEntries(found.map(s => [s.name, s]))

  check('nome próprio não é sobrescrito', byName.colide?.source === 'own', JSON.stringify(byName.colide))
  check('comando próprio preservado',
    JSON.stringify(byName.colide?.config.command).includes('meu-colide'),
    JSON.stringify(byName.colide?.config))
  check('herda do opencode', byName['so-do-opencode']?.source === 'opencode', JSON.stringify(byName['so-do-opencode']))
  check('herda do claude', byName.supabase?.source === 'claude', JSON.stringify(byName.supabase))
  check('own vem antes dos herdados', found[0]?.source === 'own' && found[1]?.source === 'own',
    JSON.stringify(found.map(s => s.source)))
  check('nenhum nome duplicado',
    new Set(found.map(s => s.name)).size === found.length, JSON.stringify(found.map(s => s.name)))
  check('aponta o arquivo de origem',
    (byName.supabase?.file ?? '').includes('.claude.json'), byName.supabase?.file ?? '')
}

console.log('--- inheritMcp aceita lista de origens ---')
{
  const so = await discover.discoverMcpServers({ inheritMcp: ['opencode'] } as never, PROJECT)
  check('só opencode', so.every(s => s.source === 'opencode'), JSON.stringify(so.map(s => s.source)))
  check('claude fora', !so.some(s => s.name === 'supabase'), JSON.stringify(so.map(s => s.name)))

  const cl = await discover.discoverMcpServers({ inheritMcp: ['claude'] } as never, PROJECT)
  check('só claude', cl.every(s => s.source === 'claude'), JSON.stringify(cl.map(s => s.source)))

  const lixo = await discover.discoverMcpServers({ inheritMcp: ['nada'] } as never, PROJECT)
  check('origem desconhecida é ignorada', lixo.length === 0, JSON.stringify(lixo))
}

console.log('--- precedência dentro de cada ferramenta ---')
{
  const found = await discover.discoverMcpServers({ inheritMcp: true } as never, PROJECT)
  const byName = Object.fromEntries(found.map(s => [s.name, s]))

  check('config do projeto vence a do usuário (opencode)',
    JSON.stringify(byName.colide?.config.command).includes('opencode-projeto'),
    JSON.stringify(byName.colide?.config))
  check('entrada do cwd vence a global (claude), mesmo com barra trocada',
    JSON.stringify(byName.global?.config.command).includes('do-projeto.mjs'),
    JSON.stringify(byName.global?.config))
  check('projeto de outro diretório não entra', !byName.de_outro, JSON.stringify(Object.keys(byName)))
  check('.mcp.json do projeto é lido', byName.doProjeto?.source === 'claude', JSON.stringify(byName.doProjeto))
}

console.log('--- tradução do formato do Claude Code ---')
{
  const found = await discover.discoverMcpServers({ inheritMcp: ['claude'] } as never, PROJECT)
  const byName = Object.fromEntries(found.map(s => [s.name, s]))

  check('stdio virou local', byName.supabase?.config.type === 'local', JSON.stringify(byName.supabase?.config))
  check('command + args viraram um argv',
    JSON.stringify(byName.supabase?.config.command) === JSON.stringify(['npx', '-y', '@supabase/mcp']),
    JSON.stringify(byName.supabase?.config.command))
  check('env vazio não vira environment', byName.supabase?.config.environment === undefined,
    JSON.stringify(byName.supabase?.config))
  check('sse virou remote', byName.remoto?.config.type === 'remote', JSON.stringify(byName.remoto?.config))
  check('url preservada', byName.remoto?.config.url === 'https://exemplo.invalid/sse', JSON.stringify(byName.remoto?.config))
  check('headers preservados', byName.remoto?.config.headers?.['X-Tok'] === 'abc', JSON.stringify(byName.remoto?.config))
  check('entrada sem command nem url é descartada', !byName.quebrado, JSON.stringify(Object.keys(byName)))

  check('fromClaude sem command devolve null', discover.fromClaude({ type: 'stdio' } as never) === null, '')
  check('fromClaude http sem url devolve null', discover.fromClaude({ type: 'http' } as never) === null, '')
  check('fromClaude com url e sem type vira remote',
    discover.fromClaude({ url: 'https://x.invalid' } as never)?.type === 'remote', '')
}

console.log('--- inheritableMcpServers independe do inheritMcp ---')
{
  const extra = await discover.inheritableMcpServers(ownConfig, PROJECT)
  const names = extra.map(s => s.name)
  check('lista mesmo com inheritMcp desligado', extra.length > 0, JSON.stringify(names))
  check('exclui os próprios', !names.includes('meu') && !names.includes('colide'), JSON.stringify(names))
  check('traz de ambas as origens',
    extra.some(s => s.source === 'opencode') && extra.some(s => s.source === 'claude'),
    JSON.stringify(extra.map(s => s.source)))
  check('sem duplicados', new Set(names).size === names.length, JSON.stringify(names))
}

console.log('--- config ilegível não derruba a descoberta ---')
{
  const quebrada = nodePath.join(S, 'quebrada')
  await write(nodePath.join(quebrada, '.opencode', 'opencode.json'), '{ "mcp": { , } }')
  const found = await discover.discoverMcpServers({ inheritMcp: ['opencode'] } as never, quebrada)
  check('cai para a config do usuário', found.some(s => s.name === 'so-do-opencode'),
    JSON.stringify(found.map(s => s.name)))
  check('nada explodiu', Array.isArray(found), '')
}

console.log('--- redactForConfig nunca copia segredo literal ---')
{
  const { config, envVars } = discover.redactForConfig('azure-devops', {
    type: 'local',
    command: ['npx', 'x'],
    environment: {
      ADO_PAT: FAKE_PAT,
      AZURE_DEVOPS_PAT: FAKE_PAT,
      ORG_NAME: 'selbettidev',
      SHORT_TOKEN: 'abc',
      JA_REFERENCIADO: '{env:OUTRO}',
    },
  } as never)

  check('PAT virou referência', config.environment?.ADO_PAT === '{env:ADO_PAT}', JSON.stringify(config.environment))
  check('segundo PAT também', config.environment?.AZURE_DEVOPS_PAT === '{env:AZURE_DEVOPS_PAT}',
    JSON.stringify(config.environment))
  check('valor que não é segredo fica', config.environment?.ORG_NAME === 'selbettidev', JSON.stringify(config.environment))
  check('valor curto fica (não é chave)', config.environment?.SHORT_TOKEN === 'abc', JSON.stringify(config.environment))
  check('referência existente não é mexida', config.environment?.JA_REFERENCIADO === '{env:OUTRO}',
    JSON.stringify(config.environment))
  check('lista as vars que faltam preencher',
    envVars.includes('ADO_PAT') && envVars.includes('AZURE_DEVOPS_PAT'), JSON.stringify(envVars))
  check('o literal não aparece em lugar nenhum', !JSON.stringify(config).includes(FAKE_PAT), '')
  check('sem environment devolve o servidor intacto',
    discover.redactForConfig('x', { type: 'local', command: ['a'] } as never).envVars.length === 0, '')
}

console.log('--- mcp import escreve na config do usuário ---')
{
  const target = nodePath.join(S, 'destino', 'bytecode.jsonc')
  await write(target, JSON.stringify({ model: 'p/m', mcp: { meu: { type: 'local', command: ['node', 'meu.mjs'] } } }))

  const result = await discover.importMcpServers(ownConfig, PROJECT, { target })
  const written = JSON.parse(await fsp.readFile(target, 'utf8'))

  check('importou o que faltava', result.imported.includes('so-do-opencode') && result.imported.includes('supabase'),
    JSON.stringify(result.imported))
  check('não tocou no que já existia', result.skipped.includes('meu') || !result.imported.includes('meu'),
    JSON.stringify(result))
  check('preservou o resto da config', written.model === 'p/m', JSON.stringify(written).slice(0, 80))
  check('preservou o servidor que já estava',
    JSON.stringify(written.mcp.meu.command).includes('meu.mjs'), JSON.stringify(written.mcp.meu))
  check('importados vêm desligados',
    written.mcp['so-do-opencode'].enabled === false, JSON.stringify(written.mcp['so-do-opencode']))
  check('o PAT NÃO foi copiado em texto puro', !JSON.stringify(written).includes(FAKE_PAT), '')
  check('ficou como referência de env',
    written.mcp['azure-devops'].environment.ADO_PAT === '{env:ADO_PAT}',
    JSON.stringify(written.mcp['azure-devops'].environment))
  check('reportou as vars a preencher', result.envVars.includes('ADO_PAT'), JSON.stringify(result.envVars))

  // Reimportar não duplica nem reabilita.
  const again = await discover.importMcpServers(ownConfig, PROJECT, { target })
  check('segunda importação não traz nada', again.imported.length === 0, JSON.stringify(again.imported))
  check('e diz o que já existia', again.skipped.length > 0, JSON.stringify(again.skipped))

  const enabledTarget = nodePath.join(S, 'destino2', 'bytecode.jsonc')
  const on = await discover.importMcpServers({} as never, PROJECT, { target: enabledTarget, enable: true })
  const written2 = JSON.parse(await fsp.readFile(enabledTarget, 'utf8'))
  check('--enable liga os importados', written2.mcp[on.imported[0]].enabled === true,
    JSON.stringify(written2.mcp[on.imported[0]]))
  check('cria o arquivo se não existir', on.imported.length > 0, JSON.stringify(on.imported))
}

console.log('--- McpManager.use carrega origem e estado ---')
{
  const manager = new McpManager(undefined, PROJECT)
  check('sem servidores é vazio', manager.isEmpty === true, '')

  manager.use(
    {
      desligado: { type: 'local', command: ['node', 'nunca.mjs'], enabled: false },
      outro: { type: 'local', command: ['node', 'tambem-nao.mjs'], enabled: false },
    },
    { desligado: 'claude', outro: 'own' },
  )
  check('depois do use não é vazio', manager.isEmpty === false, '')

  // Só desligados: connect não abre processo nenhum.
  await manager.connect()
  const status = manager.status()
  check('desligado aparece no status', status.length === 2, JSON.stringify(status))
  check('marcado como disabled', status.every(s => s.disabled === true), JSON.stringify(status))
  check('não conta como conectado', status.every(s => !s.connected), JSON.stringify(status))
  check('sem erro (não foi tentado)', status.every(s => !s.error), JSON.stringify(status))
  check('origem preservada', status.find(s => s.name === 'desligado')?.source === 'claude', JSON.stringify(status))

  manager.use({ tarde: { type: 'local', command: ['node', 'x.mjs'] } })
  check('use depois de conectar é ignorado',
    manager.status().every(s => s.name !== 'tarde'), JSON.stringify(manager.status().map(s => s.name)))
}

console.log('--- credencial vazia é dita, não discada ---')
{
  // `{env:VAR}` sem valor virou string vazia na substituição. Discar assim faz o
  // servidor subir, recusar a auth e morrer com "Connection closed", que não diz
  // nada. O nome da variável tem que aparecer.
  const manager = new McpManager(undefined, PROJECT)
  const avisos: string[] = []
  manager.use({
    semchave: {
      type: 'local',
      command: ['node', 'nunca-vai-rodar.mjs'],
      environment: { PERSONAL_ACCESS_TOKEN: '', ORG: 'selbettidev' },
    },
  })

  const t0 = Date.now()
  await manager.connect(text => avisos.push(text))
  const ms = Date.now() - t0

  const status = manager.status()
  check('marcado como falha', status[0]?.connected === false, JSON.stringify(status))
  check('erro nomeia a variável vazia', (status[0]?.error ?? '').includes('PERSONAL_ACCESS_TOKEN'),
    status[0]?.error ?? '')
  check('erro diz o que fazer', (status[0]?.error ?? '').includes('{env:'), status[0]?.error ?? '')
  check('cobre também referência de arquivo', (status[0]?.error ?? '').includes('{file:'), status[0]?.error ?? '')
  check('não menciona a variável preenchida', !(status[0]?.error ?? '').includes('ORG'), status[0]?.error ?? '')
  check('avisou na hora', avisos.some(a => a.includes('semchave')), JSON.stringify(avisos))
  check('nem tentou subir o processo (rápido)', ms < 400, `${ms}ms`)
}

console.log('--- o stderr do servidor entra na mensagem de erro ---')
{
  // "Connection closed" não diz nada. A causa está no stderr do servidor, que era
  // descartado para não corromper o quadro da TUI — descartar apagava a única
  // explicação que existia.
  const fatal =
    '{"authentication":"pat","level":"info","message":"Starting Azure DevOps MCP Server"}\n' +
    '{"level":"error","message":"Fatal error in main(): Environment variable ' +
    "'PERSONAL_ACCESS_TOKEN' is not set or empty.\"}\n"
  const enriched = explainFailure(new Error('MCP error -32000: Connection closed'), fatal)
  check('mantém o erro do cliente', enriched.message.includes('Connection closed'), enriched.message)
  check('acrescenta o que o servidor disse', enriched.message.includes('PERSONAL_ACCESS_TOKEN'), enriched.message)
  check('desembrulha o "message" do log JSON', !enriched.message.includes('"level"'), enriched.message)
  check('pega a última linha significativa, não a primeira',
    !enriched.message.includes('Starting Azure DevOps'), enriched.message)

  const texto = explainFailure(new Error('x'), 'linha antiga\nfalhou de verdade\n\n')
  check('funciona com stderr em texto puro', texto.message === 'x — the server said: falhou de verdade', texto.message)

  const vazio = explainFailure(new Error('x'), '   \n\n')
  check('sem stderr o erro fica intacto', vazio.message === 'x', vazio.message)

  const soJson = explainFailure(new Error('x'), '{"level":"debug"}\n{"nada":1}')
  check('JSON sem "message" não polui o erro', soJson.message === 'x', soJson.message)

  const gigante = explainFailure(new Error('x'), 'y'.repeat(900))
  check('mensagem longa é truncada', gigante.message.length < 400 && gigante.message.endsWith('…'),
    String(gigante.message.length))
}

console.log('--- ambiente do processo é herdado, como no opencode ---')
{
  // O whitelist do SDK (`getDefaultEnvironment`) derrubava credencial ambiente, e
  // config escrita para o opencode — que spawna com `{...process.env, ...environment}`
  // — morria aqui com erro de handshake que não nomeia nada.
  process.env.SEGREDO_DE_TESTE = 'valor-ambiente'
  process.env.FUNCAO_EXPORTADA = '() { echo oi; }'

  const herda = childEnv({ type: 'local', command: ['x'] } as never)
  check('variável ambiente chega ao servidor', herda.SEGREDO_DE_TESTE === 'valor-ambiente',
    JSON.stringify(herda.SEGREDO_DE_TESTE))
  check('defaults do transporte continuam lá', typeof herda.PATH === 'string' || typeof herda.Path === 'string',
    JSON.stringify(Object.keys(herda).filter(k => /^path$/i.test(k))))
  check('função exportada é descartada', herda.FUNCAO_EXPORTADA === undefined,
    JSON.stringify(herda.FUNCAO_EXPORTADA))

  const restrito = childEnv({ type: 'local', command: ['x'], inheritEnv: false } as never)
  check('inheritEnv: false corta o ambiente', restrito.SEGREDO_DE_TESTE === undefined,
    JSON.stringify(restrito.SEGREDO_DE_TESTE))
  check('mas mantém os defaults do transporte',
    typeof restrito.PATH === 'string' || typeof restrito.Path === 'string',
    JSON.stringify(Object.keys(restrito).length))

  const sobrescrito = childEnv({
    type: 'local',
    command: ['x'],
    environment: { SEGREDO_DE_TESTE: 'valor-da-config' },
  } as never)
  check('"environment" vence o ambiente herdado', sobrescrito.SEGREDO_DE_TESTE === 'valor-da-config',
    JSON.stringify(sobrescrito.SEGREDO_DE_TESTE))

  delete process.env.SEGREDO_DE_TESTE
  delete process.env.FUNCAO_EXPORTADA
}

console.log('--- {base64:} na substituição da config ---')
{
  // Codificar a credencial à mão é passo que falha calado: encoding errado
  // autentica como ninguém e o servidor responde 401 sem dizer por quê.
  const patFile = nodePath.join(S, 'ado-pat')
  await write(patFile, 'pat-cru-de-teste\n')
  const ref = patFile.replace(/\\/g, '/')

  process.env.BYTECODE_CONFIG_CONTENT = JSON.stringify({
    mcp: {
      s: {
        type: 'local',
        command: ['node', 'x.mjs'],
        environment: {
          BASIC: `{base64::{file:${ref}}}`,
          PLAIN: `{base64:{file:${ref}}}`,
          LITERAL: '{base64:abc}',
          VAZIO: '{base64::{env:NAO_EXISTE_MESMO}}',
          NADA: '{base64:}',
        },
      },
    },
  })
  const { loadConfig } = await import(`${R}/config/load.ts`)
  const { config } = await loadConfig(PROJECT)
  const env = config.mcp?.s?.environment ?? {}
  delete process.env.BYTECODE_CONFIG_CONTENT

  const dec = (v?: string) => Buffer.from(v ?? '', 'base64').toString('utf8')
  check('base64 roda depois do {file:}', dec(env.BASIC) === ':pat-cru-de-teste', JSON.stringify(dec(env.BASIC)))
  check('o arquivo é trimado antes de codificar', !dec(env.BASIC).includes('\n'), JSON.stringify(dec(env.BASIC)))
  check('sem o ":" codifica só o valor', dec(env.PLAIN) === 'pat-cru-de-teste', JSON.stringify(dec(env.PLAIN)))
  check('literal também é codificado', env.LITERAL === 'YWJj', String(env.LITERAL))
  check('referência que não resolve fica vazia (não vira base64 de ":")', env.VAZIO === '', JSON.stringify(env.VAZIO))
  check('{base64:} vazio fica vazio', env.NADA === '', JSON.stringify(env.NADA))
  check('o valor cru não aparece na config', !JSON.stringify(config.mcp).includes('pat-cru-de-teste'),
    JSON.stringify(env))
}

console.log('--- resolveMcpServers alimenta o manager ---')
{
  const map = await discover.resolveMcpServers({ ...(ownConfig as object), inheritMcp: true } as never, PROJECT)
  check('devolve um mapa por nome', Boolean(map?.meu) && Boolean(map?.supabase), JSON.stringify(Object.keys(map ?? {})))
  check('mantém o próprio em conflito',
    JSON.stringify(map?.colide?.command).includes('meu-colide'), JSON.stringify(map?.colide))

  const semNada = await discover.resolveMcpServers({} as never, nodePath.join(S, 'vazio'))
  check('sem nada devolve undefined', semNada === undefined, JSON.stringify(semNada))
}

console.log('--- concorrência das tools MCP ---')
{
  const { ToolRegistry } = await import(`${R}/core/tools.ts`)

  // `readOnlyHint` é opcional no protocolo e a maioria dos servidores não
  // preenche, então sem a saída da config todo `list_*`/`get_*` roda um por vez.
  const remotos = [
    { name: 'list_projects', description: 'lista', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_item', description: 'lê', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'anotada',
      description: 'declara sozinha',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    },
    { name: 'create_item', description: 'escreve', inputSchema: { type: 'object', properties: {} } },
  ]

  const registrar = (config: Record<string, unknown>) => {
    const manager: any = new McpManager(undefined, S)
    manager.connections = [
      { name: 'ado', client: { getInstructions: () => undefined }, config, tools: remotos, hasResources: false },
    ]
    const registry = new ToolRegistry()
    manager.registerInto(registry)
    const seguro = (n: string) => registry.get(`mcp__ado__${n}`)?.parallelSafe === true
    return seguro
  }

  {
    const seguro = registrar({})
    check('sem config, só a anotada é paralela', seguro('anotada'), '')
    check('sem config, list_* fica em série', !seguro('list_projects'), '')
    check('sem config, create_* fica em série', !seguro('create_item'), '')
  }
  {
    const seguro = registrar({ parallelSafe: true })
    check('parallelSafe:true libera todas', seguro('list_projects') && seguro('get_item') && seguro('create_item'), '')
  }
  {
    const seguro = registrar({ parallelSafe: ['list_projects', 'get_item'] })
    check('lista libera só as nomeadas', seguro('list_projects') && seguro('get_item'), '')
    check('e o que ficou de fora continua em série', !seguro('create_item'), '')
    check('a anotada continua valendo mesmo fora da lista', seguro('anotada'), '')
  }
  {
    const seguro = registrar({ parallelSafe: [] })
    check('lista vazia não libera nada além da anotada',
      !seguro('list_projects') && seguro('anotada'), '')
  }
}

await fsp.rm(HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
