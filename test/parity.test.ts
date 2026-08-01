// Paridade com o Claude Code: prompt caching, hooks de permissão e comandos de
// usuário (`~/.claude/commands/*.md`) — os três gaps que o
// `docs/claude-code-vs-bytecode.md` lista como prioridade.

const { ROOT, SRC: R, scratch, fixtureUrl, mockProvider, useConfig, reporter } = await import('./helpers.ts')
const S = await scratch('parity')
const { promises: fsp } = await import('node:fs')
const nodePath = await import('node:path')

const MARK = nodePath.join(S, 'hooks.log')
const OUT = nodePath.join(S, 'escrito.txt')

useConfig({
  dataDir: `${S}/data`,
  model: 'mock/tiny',
  provider: { mock: mockProvider('mock-parity.mjs') },
  assets: { agents: ['./none'], skills: ['./none'], commands: [`${S}/commands`] },
  instructions: [],
  compaction: { enabled: false },
  permissions: { defaultMode: 'default' },
})

const { check, log, done } = reporter()
const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const { runTurn } = await import(`${R}/core/loop.ts`)
const { cachePolicy, cachedSystem, withCacheControl } = await import(`${R}/core/cache.ts`)
const { markRequestBody, cachingFetch } = await import(`${R}/provider/promptcache.ts`)
const { HookRunner } = await import(`${R}/core/hooks.ts`)
const { loadCommands, expandCommandBody } = await import(`${R}/assets/index.ts`)
const mock = await import(fixtureUrl('mock-parity.mjs'))

const cwd = ROOT
const { config } = await loadConfig(cwd)

// ---------------------------------------------------------------- caching

log('--- política de cache ---')
{
  const anthropic = { npm: '@ai-sdk/anthropic', models: {} }
  const compat = { npm: '@ai-sdk/openai-compatible', models: {} }
  const resolved = (provider: any) => ({ providerId: 'p', modelKey: 'm', modelId: 'm', provider, model: {} }) as any

  check('provider anthropic liga sozinho', cachePolicy({} as any, resolved(anthropic)) !== null, '')
  check('openai-compatible fica de fora', cachePolicy({} as any, resolved(compat)) === null, '')
  check('enabled:true força em qualquer provider',
    cachePolicy({ cache: { enabled: true } } as any, resolved(compat)) !== null, '')
  check('enabled:false desliga até no anthropic',
    cachePolicy({ cache: { enabled: false } } as any, resolved(anthropic)) === null, '')
  check('ttl chega na política',
    cachePolicy({ cache: { enabled: true, ttl: '1h' } } as any, resolved(compat))?.ttl === '1h', '')

  // O estilo é o que decide ONDE o marcador é escrito. Errar isso foi o bug:
  // marcava via providerOptions num provider que descarta providerOptions.
  check('anthropic marca pelo SDK',
    cachePolicy({} as any, resolved(anthropic))?.style === 'sdk',
    JSON.stringify(cachePolicy({} as any, resolved(anthropic))))
  check('openai-compatible marca no corpo do request',
    cachePolicy({ cache: { enabled: true } } as any, resolved(compat))?.style === 'wire',
    JSON.stringify(cachePolicy({ cache: { enabled: true } } as any, resolved(compat))))
  check('provider sem npm conta como openai-compatible',
    cachePolicy({ cache: { enabled: true } } as any, resolved({ models: {} }))?.style === 'wire', '')
}

log('--- breakpoints de cache ---')
{
  const messages: any[] = [
    { role: 'user', content: 'oi' },
    { role: 'assistant', content: 'ola' },
    { role: 'user', content: 'de novo' },
  ]
  const before = JSON.stringify(messages)
  const sdk = { ttl: '1h', style: 'sdk' } as any
  const out = withCacheControl(messages as any, sdk) as any[]
  const sys = cachedSystem('SYSTEM', sdk) as any

  const mark = (m: any) => m?.providerOptions?.anthropic?.cacheControl
  check('system vira mensagem de sistema', sys.role === 'system' && sys.content === 'SYSTEM', JSON.stringify(sys).slice(0, 80))
  check('system marcado', mark(sys)?.type === 'ephemeral', JSON.stringify(mark(sys)))
  check('ttl repassado', mark(sys)?.ttl === '1h', JSON.stringify(mark(sys)))
  check('última mensagem marcada (breakpoint rolante)', mark(out.at(-1))?.type === 'ephemeral', '')
  check('um breakpoint no histórico', out.filter(m => mark(m)).length === 1, String(out.filter(m => mark(m)).length))
  check('meio da conversa intacto', mark(out[0]) === undefined && mark(out[1]) === undefined, '')
  check('não muta o histórico da sessão', JSON.stringify(messages) === before, '')

  const semTtl = { style: 'sdk' } as any
  check('histórico vazio não quebra', (withCacheControl([] as any, semTtl) as any[]).length === 0, '')
  check('sem ttl não inventa campo', mark(cachedSystem('S', semTtl))?.ttl === undefined, JSON.stringify(mark(cachedSystem('S', semTtl))))
}

log('--- marcação no corpo do request (openai-compatible) ---')
{
  const wire = { style: 'wire' } as any
  const parse = (raw: string) => JSON.parse(raw)
  const marker = (m: any) => (Array.isArray(m?.content) ? m.content.at(-1)?.cache_control : undefined)

  const body = JSON.stringify({
    model: 'x',
    messages: [
      { role: 'system', content: 'SYSTEM' },
      { role: 'user', content: 'oi' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1' }] },
      { role: 'tool', tool_call_id: 't1', content: 'resultado' },
    ],
  })
  const out = parse(markRequestBody(body, wire))

  check('system vira bloco de conteúdo', Array.isArray(out.messages[0].content), JSON.stringify(out.messages[0]).slice(0, 120))
  check('system marcado', marker(out.messages[0])?.type === 'ephemeral', JSON.stringify(out.messages[0]).slice(0, 160))
  check('texto do system preservado', out.messages[0].content[0].text === 'SYSTEM', JSON.stringify(out.messages[0].content))
  check('fim do request marcado', marker(out.messages[3])?.type === 'ephemeral', JSON.stringify(out.messages[3]))
  check('meio da conversa intacto', out.messages[1].content === 'oi', JSON.stringify(out.messages[1]))
  check('assistant só com tool_calls é pulado', out.messages[2].content === null, JSON.stringify(out.messages[2]))
  check('exatamente dois breakpoints',
    out.messages.filter((m: any) => marker(m)).length === 2,
    String(out.messages.filter((m: any) => marker(m)).length))
  check('ttl entra quando pedido',
    marker(parse(markRequestBody(body, { style: 'wire', ttl: '1h' } as any)).messages[0])?.ttl === '1h', '')
  check('sem ttl não inventa campo no corpo', marker(out.messages[0])?.ttl === undefined, '')

  // Nunca quebrar o request é a regra: qualquer forma inesperada passa reto.
  check('corpo que não é JSON passa reto', markRequestBody('nao-e-json', wire) === 'nao-e-json', '')
  check('corpo sem messages passa reto',
    markRequestBody('{"model":"x"}', wire) === '{"model":"x"}', '')
  check('lista de mensagens vazia passa reto',
    markRequestBody('{"messages":[]}', wire) === '{"messages":[]}', '')
  check('nada marcável passa reto sem reserializar',
    markRequestBody('{"messages":[{"role":"assistant","content":null}]}', wire)
      === '{"messages":[{"role":"assistant","content":null}]}', '')

  // Só o system: o breakpoint rolante não pode recair sobre ele e virar dois no
  // mesmo lugar.
  const soSystem = parse(markRequestBody(JSON.stringify({ messages: [{ role: 'system', content: 'S' }] }), wire))
  check('só system marca uma vez',
    soSystem.messages.filter((m: any) => marker(m)).length === 1,
    JSON.stringify(soSystem.messages))

  // Conteúdo já em blocos: marca o último texto, não o primeiro.
  const blocos = parse(markRequestBody(JSON.stringify({
    messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'image_url' }, { type: 'text', text: 'b' }] }],
  }), wire))
  check('marca o último bloco de texto',
    blocos.messages[0].content[2].cache_control?.type === 'ephemeral'
      && blocos.messages[0].content[0].cache_control === undefined,
    JSON.stringify(blocos.messages[0].content))
}

log('--- o registry instala o fetch quando o estilo é wire ---')
{
  const { createLanguageModel } = await import(`${R}/provider/registry.ts`)
  const resolved: any = {
    providerId: 'mock',
    modelKey: 'tiny',
    modelId: 'tiny',
    provider: config.provider!.mock,
    model: {},
  }

  await createLanguageModel(resolved, {})
  check('sem política, nenhum fetch injetado', mock.built.options?.fetch === undefined, String(typeof mock.built.options?.fetch))

  await createLanguageModel(resolved, { cache: { style: 'wire' } as any })
  check('com wire, fetch é injetado', typeof mock.built.options?.fetch === 'function', String(typeof mock.built.options?.fetch))

  // As duas versões do provider são entradas distintas no cache de instâncias.
  // Se compartilhassem a chave, ligar o cache manteria o marcador depois de
  // desligado — ou pior, o contrário. A prova é a fábrica não ser chamada de
  // novo para nenhuma das duas: cada uma tem a sua, e as duas sobrevivem.
  mock.built.options = null
  await createLanguageModel(resolved, {})
  check('instância sem cache continua no cache', mock.built.options === null, JSON.stringify(mock.built.options))

  mock.built.options = null
  await createLanguageModel(resolved, { cache: { style: 'wire' } as any })
  check('instância com wire continua no cache', mock.built.options === null, JSON.stringify(mock.built.options))

  mock.built.options = null
  await createLanguageModel(resolved, { cache: { style: 'sdk' } as any })
  check('estilo sdk usa a instância sem fetch', mock.built.options === null, String(typeof mock.built.options?.fetch))
}

log('--- o fetch do provider aplica a marcação ---')
{
  const wire = { style: 'wire' } as any
  let visto = ''
  const fake = async (_input: unknown, init: any) => {
    visto = String(init?.body ?? '')
    return new Response('ok')
  }
  const wrapped = cachingFetch(fake as any, wire)

  await wrapped('http://x', { body: JSON.stringify({ messages: [{ role: 'system', content: 'S' }] }) } as any)
  check('corpo string é reescrito', visto.includes('cache_control'), visto)

  visto = ''
  const buffer = Buffer.from('binario')
  await wrapped('http://x', { body: buffer } as any)
  check('corpo não-string passa intacto', visto === 'binario', visto)

  visto = ''
  await wrapped('http://x', undefined as any)
  check('request sem init não quebra', visto === '', visto)
}

log('--- o loop usa a política ---')
{
  // O provider simulado é openai-compatible, ou seja, estilo `wire`: o marcador
  // é escrito no corpo do request pelo fetch, não em `providerOptions`. O que o
  // loop tem de fazer é justamente NÃO mexer no `system` nem nas mensagens —
  // marcar ali era o bug, porque `@ai-sdk/openai-compatible` descarta
  // `providerOptions.anthropic` sem dizer nada.
  const seen: any[] = []
  let errored = ''
  const session: any = new Session({ config, cwd, modelRef: config.model! })
  await session.init(() => {})
  registerTools(session)
  session.emit = (e: any) => {
    if (e.type === 'error') errored += e.text
  }
  session.requestPermission = async () => false
  session.mode = 'bypassPermissions'
  mock.reset(OUT)

  const model = await session.model()
  const original = model.doStream.bind(model)
  model.doStream = async (opts: any) => {
    seen.push(opts.prompt)
    return original(opts)
  }
  session.languageModel = model

  await runTurn(session, 'sem cache')
  const semCache = seen.at(-1) ?? []
  check('sem cache, nenhuma marca',
    semCache.every((m: any) => !m.providerOptions?.anthropic), JSON.stringify(semCache[0]).slice(0, 100))

  session.config.cache = { enabled: true }
  mock.reset(OUT)
  errored = ''
  await runTurn(session, 'com cache')
  const comCache = seen.at(-1) ?? []
  check('turno com cache não quebra', errored === '', errored.slice(0, 200))
  check('estilo wire não marca via providerOptions',
    comCache.every((m: any) => !m.providerOptions?.anthropic),
    JSON.stringify(comCache.at(-1) ?? null).slice(0, 160))
  // O SDK sempre normaliza o `system` para uma mensagem no prompt interno; o que
  // não pode existir é opção de provider pendurada nela — é isso que o
  // openai-compatible descarta.
  check('estilo wire não pendura nada no system',
    comCache[0]?.role === 'system' && comCache[0]?.providerOptions === undefined,
    JSON.stringify(comCache[0] ?? null).slice(0, 160))
  session.config.cache = undefined
  await session.mcp.close()
}

// ---------------------------------------------------------------- hooks

const hookCmd = (label: string, extra = '') => ({
  hooks: [
    {
      type: 'command' as const,
      command: process.execPath,
      args: [
        '-e',
        `require('fs').appendFileSync(${JSON.stringify(MARK)}, '${label}\\n'); ${extra}`,
      ],
      timeout: 20,
    },
  ],
})

async function marks(): Promise<string[]> {
  const raw = await fsp.readFile(MARK, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean)
}

async function turnWith(hooks: Record<string, unknown>, grant: boolean) {
  await fsp.rm(MARK, { force: true })
  await fsp.rm(OUT, { force: true })
  mock.reset(OUT)
  const session: any = new Session({ config: { ...config, hooks } as any, cwd, modelRef: config.model! })
  await session.init(() => {})
  registerTools(session)
  session.emit = () => {}
  let asked = false
  session.requestPermission = async () => {
    asked = true
    return grant
  }
  session.hooks = new HookRunner(hooks as any, cwd)
  await runTurn(session, 'escreva o arquivo')
  const results = session.messages
    .flatMap((m: any) => (Array.isArray(m.content) ? m.content : []))
    .filter((p: any) => p.type === 'tool-result')
    .map((p: any) => JSON.stringify(p.output))
  await session.mcp.close()
  return { asked, results, session }
}

log('--- hook PermissionRequest decide pelo usuário ---')
{
  const denied = await turnWith(
    {
      PermissionRequest: [
        hookCmd(
          'PermissionRequest',
          `process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'deny',permissionDecisionReason:'proibido pelo hook'}}))`,
        ),
      ],
      PermissionDenied: [hookCmd('PermissionDenied')],
      Notification: [hookCmd('Notification')],
    },
    true,
  )
  const log1 = await marks()
  check('PermissionRequest disparou', log1.includes('PermissionRequest'), JSON.stringify(log1))
  check('hook nega sem perguntar ao usuário', denied.asked === false, '')
  check('sem Notification quando o hook decide', !log1.includes('Notification'), JSON.stringify(log1))
  check('PermissionDenied disparou', log1.includes('PermissionDenied'), JSON.stringify(log1))
  check('motivo do hook chega ao modelo',
    denied.results.some((r: string) => r.includes('proibido pelo hook')), JSON.stringify(denied.results).slice(0, 160))
  check('arquivo não foi escrito', !(await fsp.stat(OUT).catch(() => null)), '')
}

log('--- hook PermissionRequest pode permitir ---')
{
  const allowed = await turnWith(
    {
      PermissionRequest: [
        hookCmd(
          'PermissionRequest',
          `process.stdout.write(JSON.stringify({hookSpecificOutput:{permissionDecision:'allow'}}))`,
        ),
      ],
      Notification: [hookCmd('Notification')],
      PermissionDenied: [hookCmd('PermissionDenied')],
    },
    false,
  )
  const log2 = await marks()
  check('não perguntou ao usuário', allowed.asked === false, '')
  check('nenhum PermissionDenied', !log2.includes('PermissionDenied'), JSON.stringify(log2))
  check('a tool rodou de verdade', (await fsp.readFile(OUT, 'utf8').catch(() => '')) === 'oi', '')
}

log('--- Notification antes de bloquear no usuário ---')
{
  const refused = await turnWith(
    {
      PermissionRequest: [hookCmd('PermissionRequest')],
      Notification: [hookCmd('Notification')],
      PermissionDenied: [hookCmd('PermissionDenied')],
    },
    false,
  )
  const log3 = await marks()
  check('perguntou ao usuário', refused.asked === true, '')
  check('Notification veio antes do prompt',
    log3.indexOf('Notification') > log3.indexOf('PermissionRequest') && log3.includes('Notification'), JSON.stringify(log3))
  check('recusa do usuário dispara PermissionDenied', log3.includes('PermissionDenied'), JSON.stringify(log3))
  check('modelo é avisado da recusa',
    refused.results.some((r: string) => r.includes('declined')), JSON.stringify(refused.results).slice(0, 160))
}

// ---------------------------------------------------------------- comandos

log('--- comandos de usuário ---')
{
  const dir = nodePath.join(S, 'commands')
  await fsp.mkdir(nodePath.join(dir, 'git'), { recursive: true })
  await fsp.writeFile(
    nodePath.join(dir, 'analise.md'),
    `---\ndescription: Analisa uma US\nargument-hint: <numero>\nmodel: tiny\nallowed-tools: Read, Grep\n---\nAnalise a US $1 no repo $2. Tudo: $ARGUMENTS\n`,
    'utf8',
  )
  await fsp.writeFile(nodePath.join(dir, 'git', 'pr.md'), '# Abre PR\n', 'utf8')

  const commands = await loadCommands({ ...config, assets: { ...config.assets, commands: [dir] } } as any, cwd)
  const analise = commands.find(c => c.name === 'analise')
  check('lê o comando', Boolean(analise), JSON.stringify(commands.map(c => c.name)))
  check('description do frontmatter', analise?.description === 'Analisa uma US', analise?.description ?? '')
  check('argument-hint do frontmatter', analise?.argumentHint === '<numero>', analise?.argumentHint ?? '')
  check('model do frontmatter', analise?.model === 'tiny', analise?.model ?? '')
  check('allowed-tools vira lista', JSON.stringify(analise?.allowedTools) === '["Read","Grep"]', JSON.stringify(analise?.allowedTools))
  check('frontmatter fora do corpo', !analise?.body.includes('description:'), analise?.body.slice(0, 40) ?? '')
  check('subdiretório vira namespace', commands.some(c => c.name === 'git:pr'), JSON.stringify(commands.map(c => c.name)))
  check('comando sem frontmatter não inventa campos',
    commands.find(c => c.name === 'git:pr')?.description === undefined, '')

  const body = expandCommandBody(analise!.body, '4321 confesol_api')
  check('$1 e $2 posicionais', body.includes('US 4321 no repo confesol_api'), body)
  check('$ARGUMENTS inteiro', body.includes('Tudo: 4321 confesol_api'), body)
  const vazio = expandCommandBody('a $1 b $2 c', '')
  check('posicional ausente vira vazio', vazio === 'a  b  c', JSON.stringify(vazio))
}

log('--- overrides do comando são do turno ---')
{
  // O que o `applyCommandOverrides` da TUI faz: troca modelo e roster, e desfaz.
  const session: any = new Session({ config, cwd, modelRef: config.model! })
  await session.init(() => {})
  registerTools(session)
  const antes = session.registry.active().map((t: any) => t.name).length
  const modelo = session.modelRef

  registerTools(session, ['Read', 'Grep'])
  const restrito = session.registry.active().map((t: any) => t.name)
  check('allowed-tools restringe o roster',
    restrito.includes('Read') && restrito.includes('Grep') && !restrito.includes('Write') && !restrito.includes('Bash'),
    JSON.stringify(restrito))
  check('ToolSearch sobrevive à restrição', restrito.includes('ToolSearch'), JSON.stringify(restrito))
  session.setModel('mock/tiny')
  registerTools(session)
  check('roster volta ao normal depois do turno', session.registry.active().length === antes, `${session.registry.active().length} vs ${antes}`)
  check('modelo restaurado', session.modelRef === modelo, session.modelRef)
  await session.mcp.close()
}

done()
