const { SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('agentmode')

// Arvore .opencode sintetica: o teste nao depende de nenhum repo real.
const { promises: fsp } = await import('node:fs')
const nodePath = await import('node:path')
const PROJ = nodePath.join(S, 'opencodeproj')
await fsp.rm(PROJ, { recursive: true, force: true })
await fsp.mkdir(nodePath.join(PROJ, '.opencode', 'agents'), { recursive: true })

const write = (name: string, body: string) =>
  fsp.writeFile(nodePath.join(PROJ, '.opencode', 'agents', name), body, 'utf8')

// Formato exato do opencode, com CRLF e quotes escapadas como no repo real.
await write(
  'dispatcher.md',
  [
    '---',
    'description: Roteia mensagens para o agente correto.',
    'mode: primary',
    'model: mock/tiny',
    'permission:',
    '  edit: allow',
    '  bash:',
    '    "powershell -Command \\"Get-Date*\\"": allow',
    '    "*": ask',
    '---',
    '',
    'Voce e o dispatcher.',
  ].join('\r\n'),
)
await write(
  'lean.md',
  ['---', 'description: Modo enxuto.', 'mode: primary', 'permission:', '  task: deny', '  todowrite: deny', '---', 'Sem delegar.'].join('\r\n'),
)
await write(
  'dev.md',
  ['---', 'description: Implementa.', 'mode: subagent', 'tools: Read, Glob', '---', 'Escreva codigo.'].join('\r\n'),
)
await write('semfm.md', 'Agent sem frontmatter nenhum.')

useConfig({
  model: 'mock/tiny',
  provider: { mock: { npm: fixtureUrl('mock-perf.mjs'), models: { tiny: { id: 'tiny', limit: { context: 1000000, output: 4096 } } } } },
  assets: { agents: [fixture('agentassets', 'agents')], skills: ['./none'], commands: ['./none'] },
  instructions: [],
  compaction: { enabled: false },
  permissions: { defaultMode: 'bypassPermissions' },
  subagentDepth: 1,
})
const { loadConfig } = await import(`${R}/config/load.ts`)
const { loadAgents } = await import(`${R}/assets/index.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const loaded = await loadConfig(PROJ)
// assets: undefined => usa a descoberta por convencao, que e o que se testa
const config = { ...loaded.config, assets: undefined, dataDir: `${S}\\agentmode-data` }

console.log('--- descobre .opencode/agents ---')
const agents = await loadAgents(config as never, PROJ)
const byName = Object.fromEntries(agents.map(a => [a.name, a]))
check('achou o dispatcher', Boolean(byName.dispatcher), JSON.stringify(agents.map(a => a.name)))
check('achou o lean', Boolean(byName.lean), '')
check('achou o subagent dev', Boolean(byName.dev), '')
check('arquivo sem frontmatter ainda carrega', Boolean(byName.semfm), '')

console.log('--- mode: primary x subagent ---')
check('dispatcher é primary', byName.dispatcher?.mode === 'primary', byName.dispatcher?.mode)
check('lean é primary', byName.lean?.mode === 'primary', byName.lean?.mode)
check('dev é subagent', byName.dev?.mode === 'subagent', byName.dev?.mode)
check('sem mode declarado vira subagent', byName.semfm?.mode === 'subagent', byName.semfm?.mode)
check('model do frontmatter lido', byName.dispatcher?.model === 'mock/tiny', byName.dispatcher?.model)
check('tools do frontmatter lidas', JSON.stringify(byName.dev?.tools) === '["Read","Glob"]', JSON.stringify(byName.dev?.tools))

console.log('--- bloco permission aninhado ---')
{
  const p = byName.dispatcher?.permissions
  check('edit: allow -> Edit(*)', Boolean(p?.allow?.includes('Edit(*)')), JSON.stringify(p))
  check('bash aninhado com quotes escapadas', Boolean(p?.allow?.some(r => r.includes('Get-Date*'))), JSON.stringify(p?.allow))
  check('desescapa as quotes', Boolean(p?.allow?.some(r => r.includes('"Get-Date*"') && !r.includes('\\"'))), JSON.stringify(p?.allow))
  check('bash vale para Bash e PowerShell',
    Boolean(p?.allow?.some(r => r.startsWith('Bash(')) && p?.allow?.some(r => r.startsWith('PowerShell('))), JSON.stringify(p?.allow))
  check('wildcard aninhado vai pro ask', Boolean(p?.ask?.includes('Bash(*)')), JSON.stringify(p?.ask))

  const lean = byName.lean?.permissions
  check('task: deny mapeia para Agent', Boolean(lean?.deny?.includes('Agent(*)')), JSON.stringify(lean?.deny))
  check('todowrite: deny casa o nome real', Boolean(lean?.deny?.includes('TodoWrite(*)')), JSON.stringify(lean?.deny))
  check('agent sem permission fica sem regras', byName.dev?.permissions !== undefined || byName.semfm?.permissions === undefined, '')
}

console.log('--- trocar o agente ativo na sessão ---')
{
  const session = new Session({ config: config as never, cwd: PROJ, modelRef: config.model! })
  await session.init(() => {})
  registerTools(session)
  session.emit = () => {}

  const baseModel = session.modelRef
  const baseTools = session.registry.active().length
  check('começa sem agente primary', session.primaryAgent === null, '')

  session.setPrimaryAgent(byName.dispatcher)
  check('assume o agente', session.primaryAgent?.name === 'dispatcher', '')
  check('modelo segue o agente', session.modelRef === 'mock/tiny', session.modelRef)

  // permissões do agente entram na avaliação
  const verdict = session.evaluatePermission({ tool: 'Edit', kind: 'write', subject: 'x.ts' })
  check('permissão do agente vale', verdict.decision === 'allow', JSON.stringify(verdict))

  session.setPrimaryAgent(byName.lean)
  const denied = session.evaluatePermission({ tool: 'Agent', kind: 'meta', subject: 'dev' })
  check('task: deny bloqueia o Agent', denied.decision === 'deny', JSON.stringify(denied))
  check('agente sem model volta pro modelo base', session.modelRef === baseModel, session.modelRef)

  session.setPrimaryAgent(null)
  check('sair do agente restaura o modelo', session.modelRef === baseModel, session.modelRef)
  check('sair limpa o agente', session.primaryAgent === null, '')

  // tools restritas do frontmatter
  session.registry.clear()
  registerTools(session, byName.dev!.tools)
  const names = session.registry.active().map(t => t.name)
  check('tools restritas aplicadas', names.includes('Read') && names.includes('Glob') && !names.includes('Bash'),
    JSON.stringify(names))
  session.registry.clear()
  registerTools(session)
  check('registry reconstruído por completo', session.registry.active().length === baseTools,
    `${session.registry.active().length} vs ${baseTools}`)

  // model inexistente não derruba o agente
  session.setPrimaryAgent({ ...byName.lean!, model: 'nao/existe' } as never)
  check('model inválido no agente não estoura', typeof session.modelRef === 'string', session.modelRef)
  await session.mcp.close()
}

await fsp.rm(PROJ, { recursive: true, force: true })
await fsp.rm(`${S}\\agentmode-data`, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
