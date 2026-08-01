const { SRC: R, scratch, reporter } = await import('./helpers.ts')
const S = await scratch('configwrite')

const { promises: fs } = await import('node:fs')
const path = await import('node:path')

const {
  withProvider,
  addProvider,
  findConfigTarget,
  indentUnit,
  ConfigWriteError,
  withModel,
  addModel,
  findProviderFile,
} = await import(`${R}/config/write.ts`)
const { parseJsonc } = await import(`${R}/config/load.ts`)

const { check, log, done } = reporter()

const PROVIDER = {
  npm: '@ai-sdk/openai-compatible',
  name: 'Gateway',
  env: ['GW_API_KEY'],
  options: { baseURL: 'https://gw.internal/v1' },
  models: { sonnet: { id: 'claude-sonnet-5', limit: { context: 128000, output: 16384 } } },
}

// O ponto do módulo inteiro: o arquivo é JSONC escrito à mão, e os comentários
// dentro dele são o único registro do *porquê* de cada bloco. Um round trip por
// JSON.parse/JSON.stringify apagaria todos.
log('--- insere preservando comentários ---')
{
  const source = [
    '{',
    '  "$schema": "./bytecode.schema.json",',
    '  "model": "gw/sonnet",',
    '  "mcp": {',
    '    // este comentário explica o PAT e não pode sumir',
    '    "azure-devops": { "type": "local", "enabled": true }',
    '  },',
    '  "provider": {',
    '    /* bloco existente */',
    '    "anthropic": {',
    '      "npm": "@ai-sdk/anthropic",',
    '      "models": { "opus": { "id": "claude-opus-5" } }',
    '    }',
    '  }',
    '}',
    '',
  ].join('\n')

  const out = withProvider(source, 'gw', PROVIDER)
  check('comentário de linha sobrevive', out.includes('este comentário explica o PAT'))
  check('comentário de bloco sobrevive', out.includes('/* bloco existente */'))
  check('provider anterior continua lá', out.includes('"anthropic"'))

  const parsed = parseJsonc(out, 'test') as any
  check('o resultado ainda parseia', typeof parsed === 'object')
  check('provider novo presente', parsed.provider.gw?.options?.baseURL === 'https://gw.internal/v1')
  check('provider antigo intacto', parsed.provider.anthropic?.npm === '@ai-sdk/anthropic')
  check('resto da config intacto', parsed.model === 'gw/sonnet' && parsed.mcp['azure-devops'].enabled === true)
  check('modelo aninhado correto', parsed.provider.gw.models.sonnet.limit.context === 128000)
}

log('--- cria o bloco provider quando não existe ---')
{
  const source = '{\n  "model": "x/y"\n}\n'
  const parsed = parseJsonc(withProvider(source, 'gw', PROVIDER), 'test') as any
  check('bloco criado', Boolean(parsed.provider?.gw))
  check('chave anterior preservada', parsed.model === 'x/y')
}

log('--- objeto provider vazio ---')
{
  const parsed = parseJsonc(withProvider('{\n  "provider": {}\n}\n', 'gw', PROVIDER), 'test') as any
  check('insere no objeto vazio', parsed.provider.gw.name === 'Gateway')
}

log('--- vírgula final existente ---')
{
  // O loader tolera vírgula sobrando, então normalizar seria uma edição que o
  // usuário não pediu — mas o resultado tem de continuar parseável.
  const source = '{\n  "provider": {\n    "a": { "models": {} },\n  },\n}\n'
  const parsed = parseJsonc(withProvider(source, 'gw', PROVIDER), 'test') as any
  check('não quebra com vírgula final', Boolean(parsed.provider.gw) && Boolean(parsed.provider.a))
}

log('--- não sobrescreve em silêncio ---')
{
  let threw = ''
  try {
    withProvider('{"provider":{"gw":{"models":{}}}}', 'gw', PROVIDER)
  } catch (err) {
    threw = String(err)
  }
  check('duplicata é recusada', threw.includes('already declared'), threw)
  check('erro é do tipo próprio', ConfigWriteError.name === 'ConfigWriteError')
}

log('--- chave "provider" que não é objeto ---')
{
  let threw = ''
  try {
    withProvider('{"provider": "nope"}', 'gw', PROVIDER)
  } catch (err) {
    threw = String(err)
  }
  check('recusa em vez de corromper', threw.includes('not an object'), threw)
}

log('--- "provider" dentro de string ou comentário não confunde ---')
{
  const source = [
    '{',
    '  // provider: isto é só um comentário',
    '  "model": "a/b",',
    '  "instructions": ["{ \\"provider\\": 1 }"]',
    '}',
    '',
  ].join('\n')
  const parsed = parseJsonc(withProvider(source, 'gw', PROVIDER), 'test') as any
  check('cria bloco real, não edita a string', Boolean(parsed.provider?.gw))
  check('a string ficou intacta', parsed.instructions[0] === '{ "provider": 1 }')
}

log('--- preserva CRLF e indentação do arquivo ---')
{
  const crlf = '{\r\n\t"provider": {\r\n\t\t"a": { "models": {} }\r\n\t}\r\n}\r\n'
  const out = withProvider(crlf, 'gw', PROVIDER)
  check('sem LF solto', !/[^\r]\n/.test(out))
  check('indentação por tab detectada', indentUnit(crlf) === '\t')
  check('linhas novas usam tab', out.split('\r\n').some(l => l.startsWith('\t\t"gw"')))

  const spaces = '{\n    "provider": {\n        "a": { "models": {} }\n    }\n}\n'
  check('indentação de 4 espaços detectada', indentUnit(spaces) === '    ')
}

log('--- grava em disco ---')
{
  const file = path.join(S, 'bytecode.jsonc')
  await fs.writeFile(file, '{\n  "model": "a/b"\n}\n', 'utf8')
  const written = await addProvider(file, 'gw', PROVIDER)
  check('devolve o caminho', written === file)
  const parsed = parseJsonc(await fs.readFile(file, 'utf8'), file) as any
  check('gravou o provider', parsed.provider.gw.models.sonnet.id === 'claude-sonnet-5')
}

log('--- cria o arquivo quando não existe ---')
{
  const file = path.join(S, 'novo', 'bytecode.jsonc')
  await addProvider(file, 'gw', PROVIDER)
  const parsed = parseJsonc(await fs.readFile(file, 'utf8'), file) as any
  check('arquivo novo é válido', parsed.provider.gw.name === 'Gateway')
  check('já aponta para o schema', String(parsed.$schema).includes('schema.json'))
}

log('--- alvo: config de projeto mais próximo ---')
{
  const root = path.join(S, 'repo')
  const deep = path.join(root, 'src', 'nested')
  await fs.mkdir(deep, { recursive: true })
  await fs.writeFile(path.join(root, 'bytecode.jsonc'), '{}\n', 'utf8')

  const fromDeep = await findConfigTarget(deep)
  check('acha subindo a árvore', fromDeep.file === path.join(root, 'bytecode.jsonc'), fromDeep.file)
  check('marca como existente', fromDeep.present === true)

  // O mais fundo ganha: é o que o loader trata como maior precedência, então
  // gravar no de cima produziria um provider que o próprio harness ignora.
  await fs.writeFile(path.join(root, 'src', 'bytecode.jsonc'), '{}\n', 'utf8')
  const nearest = await findConfigTarget(deep)
  check('prefere o mais próximo', nearest.file === path.join(root, 'src', 'bytecode.jsonc'), nearest.file)

  // `*.local.*` é a camada pessoal e normalmente gitignorada: gravar lá daria um
  // provider que funciona numa máquina e some para o resto do time.
  await fs.writeFile(path.join(root, 'src', 'bytecode.local.jsonc'), '{}\n', 'utf8')
  const notLocal = await findConfigTarget(deep)
  check('ignora o override .local', !notLocal.file.includes('.local.'), notLocal.file)
}

const MODEL = { id: 'claude-opus-5', limit: { context: 200000, output: 32000 } }

const WITH_PROVIDER = [
  '{',
  '  "provider": {',
  '    "gw": {',
  '      // este comentário tem de sobreviver ao add-model também',
  '      "npm": "@ai-sdk/openai-compatible",',
  '      "models": {',
  '        "sonnet": { "id": "claude-sonnet-5" }',
  '      }',
  '    }',
  '  }',
  '}',
  '',
].join('\n')

log('--- add-model: insere no provider certo ---')
{
  const out = withModel(WITH_PROVIDER, 'gw', 'opus', MODEL)
  check('comentário do provider sobrevive', out.includes('sobreviver ao add-model'))
  const parsed = parseJsonc(out, 'test') as any
  check('modelo novo presente', parsed.provider.gw.models.opus.id === 'claude-opus-5')
  check('modelo anterior intacto', parsed.provider.gw.models.sonnet.id === 'claude-sonnet-5')
  check('limites gravados', parsed.provider.gw.models.opus.limit.context === 200000)
  check('npm do provider intacto', parsed.provider.gw.npm === '@ai-sdk/openai-compatible')
}

log('--- add-model: cria o bloco models quando falta ---')
{
  const source = '{\n  "provider": {\n    "gw": { "npm": "x" }\n  }\n}\n'
  const parsed = parseJsonc(withModel(source, 'gw', 'opus', MODEL), 'test') as any
  check('bloco models criado', parsed.provider.gw.models.opus.id === 'claude-opus-5')
  check('resto do provider intacto', parsed.provider.gw.npm === 'x')
}

log('--- add-model: recusas ---')
{
  const cases: [string, string, string][] = [
    // O provider pode estar declarado noutro arquivo do merge; escrever aqui
    // criaria uma segunda declaração parcial dele.
    ['provider ausente', 'não declarado neste arquivo', 'not declared in this file'],
    ['modelo duplicado', 'não sobrescreve', 'already exists'],
    ['sem bloco provider', 'arquivo sem provider', 'no "provider" block'],
  ]
  const attempts = [
    () => withModel(WITH_PROVIDER, 'outro', 'opus', MODEL),
    () => withModel(WITH_PROVIDER, 'gw', 'sonnet', MODEL),
    () => withModel('{"model":"a/b"}', 'gw', 'opus', MODEL),
  ]
  attempts.forEach((run, i) => {
    let threw = ''
    try {
      run()
    } catch (err) {
      threw = String(err)
    }
    check(cases[i][1], threw.includes(cases[i][2]), threw || '(não lançou)')
  })
}

log('--- add-model: preserva CRLF ---')
{
  const crlf = WITH_PROVIDER.split('\n').join('\r\n')
  const out = withModel(crlf, 'gw', 'opus', MODEL)
  check('sem LF solto', !/[^\r]\n/.test(out))
}

log('--- add-model: grava em disco ---')
{
  const file = path.join(S, 'models.jsonc')
  await fs.writeFile(file, WITH_PROVIDER, 'utf8')
  await addModel(file, 'gw', 'opus', MODEL)
  const parsed = parseJsonc(await fs.readFile(file, 'utf8'), file) as any
  check('gravou o modelo', parsed.provider.gw.models.opus.limit.output === 32000)
  check('e manteve o irmão', Boolean(parsed.provider.gw.models.sonnet))
}

log('--- acha o arquivo que declara o provider ---')
{
  const root = path.join(S, 'busca')
  const deep = path.join(root, 'src')
  await fs.mkdir(deep, { recursive: true })
  await fs.writeFile(path.join(root, 'bytecode.jsonc'), WITH_PROVIDER, 'utf8')
  // O config mais próximo não declara `gw`: escrever nele seria o erro que
  // `findProviderFile` existe para evitar.
  await fs.writeFile(path.join(deep, 'bytecode.jsonc'), '{\n  "model": "gw/sonnet"\n}\n', 'utf8')

  const found = await findProviderFile(deep, 'gw')
  check('acha quem realmente declara', found === path.join(root, 'bytecode.jsonc'), String(found))

  const missing = await findProviderFile(deep, 'nao-existe')
  check('null quando ninguém declara', missing === null, String(missing))
}

done()
