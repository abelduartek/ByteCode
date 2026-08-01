// O schema JSON da config, e a guarda contra ele envelhecer.
//
// O schema é escrito à mão (não há build step aqui, então nada reflete sobre os
// tipos). O que o mantém honesto é este arquivo: ele lê `src/config/types.ts` e
// falha quando existe chave lá que não existe no schema. Adicionar opção de
// config e esquecer de declará-la é o único drift realista — foi o que aconteceu
// com seis chaves numa única tarde.

const { ROOT, SRC: R, reporter } = await import('./helpers.ts')
const { promises: fsp, existsSync } = await import('node:fs')
const nodePath = await import('node:path')

const { check, log, done } = reporter()
const { configSchema, configSchemaText } = await import(`${R}/config/schema.ts`)

const typesSource = await fsp.readFile(nodePath.join(ROOT, 'src', 'config', 'types.ts'), 'utf8')

/**
 * Chaves declaradas num `export type X = { ... }`, lendo o texto do arquivo.
 *
 * Parsear fonte é frágil para qualquer coisa geral, mas a pergunta aqui é
 * estreita — "esta chave aparece neste bloco?" — e o custo de errar é um teste
 * vermelho, não um bug em produção.
 */
function keysOfType(name: string): string[] {
  const start = typesSource.indexOf(`export type ${name} = {`)
  if (start === -1) return []
  let depth = 0
  let end = start
  for (let i = typesSource.indexOf('{', start); i < typesSource.length; i++) {
    if (typesSource[i] === '{') depth++
    else if (typesSource[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  const body = typesSource.slice(start, end)
  const keys = new Set<string>()
  // Só o nível 1 do bloco: uma chave aninhada pertence a outro tipo.
  let nesting = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    const before = nesting
    nesting += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length
    if (before !== 1) continue
    const m = trimmed.match(/^([A-Za-z_$][A-Za-z0-9_$]*)\??\s*:/)
    if (m) keys.add(m[1])
  }
  return [...keys]
}

const schema = configSchema()
const props = schema.properties as Record<string, Record<string, unknown>>

log('--- o schema é um schema ---')
{
  check('declara o dialeto', String(schema.$schema).includes('json-schema.org'), String(schema.$schema))
  check('é um objeto', schema.type === 'object', String(schema.type))
  check('recusa chave desconhecida', schema.additionalProperties === false, String(schema.additionalProperties))
  check('serializa como JSON válido', (() => {
    try { JSON.parse(configSchemaText()); return true } catch { return false }
  })(), '')
  check('termina com quebra de linha', configSchemaText().endsWith('\n'), '')
}

log('--- toda chave de Config está no schema ---')
{
  const declared = keysOfType('Config').filter(k => k !== '$schema')
  check('achou as chaves do tipo', declared.length > 15, `${declared.length} chaves`)

  const faltando = declared.filter(k => !(k in props))
  check('nenhuma chave de Config ficou de fora do schema',
    faltando.length === 0,
    `faltam: ${faltando.join(', ')}`)

  const sobrando = Object.keys(props).filter(k => k !== '$schema' && !declared.includes(k))
  check('e o schema não inventa chave que o tipo não tem',
    sobrando.length === 0,
    `sobram: ${sobrando.join(', ')}`)
}

log('--- os blocos aninhados também ---')
{
  const casos: [string, Record<string, unknown>][] = [
    ['McpServerConfig', (props.mcp as any).additionalProperties.properties],
    ['ProviderConfig', (props.provider as any).additionalProperties.properties],
    ['ModelConfig', (props.provider as any).additionalProperties.properties.models.additionalProperties.properties],
    ['PermissionsConfig', (props.permissions as any).properties],
    ['AssetsConfig', (props.assets as any).properties],
    ['WebConfig', (props.web as any).properties],
    ['CompactionConfig', (props.compaction as any).properties],
    ['HookDefinition', (props.hooks as any).additionalProperties.items.properties.hooks.items.properties],
  ]
  for (const [nome, declaradas] of casos) {
    const doTipo = keysOfType(nome)
    const faltando = doTipo.filter(k => !(k in declaradas))
    check(`${nome}: todas as chaves declaradas`, faltando.length === 0, `faltam: ${faltando.join(', ')}`)
  }
}

log('--- as chaves novas de 2026-07-31 estão lá ---')
{
  // Foram exatamente estas que existiam no tipo e em lugar nenhum mais.
  for (const chave of ['fileGuard', 'maxSteps', 'subagentConcurrency', 'web', 'cache']) {
    check(`${chave} declarada`, chave in props, JSON.stringify(Object.keys(props)))
  }
  check('mcp.parallelSafe declarada',
    'parallelSafe' in (props.mcp as any).additionalProperties.properties, '')
  check('e cada uma explica o que faz',
    ['fileGuard', 'maxSteps', 'subagentConcurrency'].every(k => typeof props[k].description === 'string'),
    JSON.stringify(Object.keys(props).map(k => [k, Boolean(props[k].description)])))
}

log('--- o arquivo no disco bate com o módulo ---')
{
  const file = nodePath.join(ROOT, 'bytecode.schema.json')
  const emDisco = await fsp.readFile(file, 'utf8').catch(() => null)
  check('bytecode.schema.json existe na raiz', emDisco !== null,
    'rode `node bin/bytecode.mjs schema` para gerar')
  check('e está em dia com src/config/schema.ts', emDisco === configSchemaText(),
    'desatualizado — rode `node bin/bytecode.mjs schema`')
}

log('--- o hx.jsonc do repo aponta para um arquivo que existe ---')
{
  const raw = await fsp.readFile(nodePath.join(ROOT, 'hx.jsonc'), 'utf8')
  const declarado = raw.match(/"\$schema":\s*"\.\/([^"]+)"/)?.[1]
  check('declara um $schema', Boolean(declarado), String(declarado))
  const existe = await fsp
    .stat(nodePath.join(ROOT, declarado ?? 'nada'))
    .then(() => true, () => false)
  check('e o arquivo apontado existe', existe, String(declarado))

  // Mais forte que "o arquivo existe": o schema tem `additionalProperties: false`,
  // então uma chave a mais no hx.jsonc do repo é erro vermelho no editor de quem
  // abrir. Este check é o que transforma o schema em algo que vale a pena ter.
  const { parseJsonc } = await import(`${R}/config/load.ts`)
  const cfg = parseJsonc(raw, 'hx.jsonc') as Record<string, unknown>
  const desconhecidas = Object.keys(cfg).filter(k => !(k in props))
  check('e o hx.jsonc do repo valida contra ele',
    desconhecidas.length === 0, `chaves fora do schema: ${desconhecidas.join(', ')}`)

  // O mesmo para o bloco mcp, que é onde a chave nova de hoje entrou.
  const servidores = Object.values((cfg.mcp ?? {}) as Record<string, Record<string, unknown>>)
  const mcpProps = (props.mcp as any).additionalProperties.properties
  const foraDoMcp = servidores.flatMap(s => Object.keys(s).filter(k => !(k in mcpProps)))
  check('e os servidores MCP também', foraDoMcp.length === 0, `fora: ${foraDoMcp.join(', ')}`)
}

// A versão vive em dois lugares: no `package.json`, que é o que o npm publica, e
// em `util/paths.ts`, que é o que `--version` e o transcript gravam. Publicar um
// pacote 0.2.0 cujo binário se apresenta como 0.1.0 é o tipo de coisa que só
// aparece num relato de bug meses depois.
log('--- versão única ---')
{
  const pkg = JSON.parse(await fsp.readFile(nodePath.join(ROOT, 'package.json'), 'utf8'))
  const { VERSION } = await import(`${R}/util/paths.ts`)
  check('package.json e util/paths.ts dizem a mesma versão',
    pkg.version === VERSION, `package.json ${pkg.version} vs VERSION ${VERSION}`)

  // O pacote publica JavaScript, não a fonte: o Node recusa apagar tipos dentro
  // de `node_modules`, que é onde um CLI instalado mora. O launcher escolhe
  // `dist/` quando existe e cai em `src/` quando não — é assim que o mesmo
  // arquivo serve o pacote e o repositório.
  const files: string[] = pkg.files ?? []
  check('o pacote publica bin/ e dist/',
    files.includes('bin') && files.includes('dist'), JSON.stringify(files))
  check('e existe um script que produz o dist/',
    typeof pkg.scripts?.build === 'string' && pkg.scripts.build.includes('tsconfig.build.json'),
    String(pkg.scripts?.build))

  const launcher = await fsp.readFile(nodePath.join(ROOT, 'bin', 'bytecode.mjs'), 'utf8')
  check('o launcher conhece os dois modos',
    launcher.includes("'dist'") && launcher.includes("'src'"), '')
  check('o binário declarado é o que existe no disco',
    Object.values(pkg.bin as Record<string, string>).every(p =>
      existsSync(nodePath.join(ROOT, String(p)))),
    JSON.stringify(pkg.bin))
}

done()
