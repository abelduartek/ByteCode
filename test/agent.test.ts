// Valida subagents no caminho real: registry carrega um provider simulado, o
// modelo do pai delega via tool Agent, o filho roda com contexto e tool set
// proprios, e o texto final dele volta como tool_result.
const { ROOT, SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('agent')
useConfig({
  dataDir: `${S}/data`,
  model: 'mock/tiny',
  provider: { mock: { npm: fixtureUrl('mock-provider.mjs'), models: { tiny: { id: 'tiny', limit: { context: 1000000, output: 4096 } } } } },
  assets: {
    agents: [fixture('agentassets', 'agents')],
    skills: [fixture('agentassets', 'skills')],
    commands: [fixture('agentassets', 'commands')],
  },
  instructions: [],
  compaction: { enabled: false },
  subagentDepth: 1,
  permissions: {
    allow: ['Read(**)', 'Glob(**)', 'Grep(**)', 'LS(**)', 'Agent(*)'],
    ask: ['Bash(*)'],
    defaultMode: 'default',
  },
})

const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const { runTurn } = await import(`${R}/core/loop.ts`)
const mock = await import(fixtureUrl('mock-provider.mjs'))

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const cwd = ROOT
const { config } = await loadConfig(cwd)
const session = new Session({ config, cwd, modelRef: config.model })
await session.init(() => {})
registerTools(session)

console.log('--- roster ---')
check('agent do disco carregado', session.assets.agents.some((a: any) => a.name === 'tester'), '')
const def = session.assets.agents.find((a: any) => a.name === 'tester')
check('tools do frontmatter lidas', JSON.stringify(def?.tools) === '["Read","Glob"]', JSON.stringify(def?.tools))
check('tool Agent registrada', Boolean(session.registry.get('Agent')), '')

console.log('--- turno com delegacao ---')
const events: any[] = []
session.emit = (e: any) => events.push(e)
session.requestPermission = async () => false // Bash exigiria permissao: deve ser negado
await runTurn(session, 'delegue para o subagente')

const toolStarts = events.filter(e => e.type === 'tool-start').map(e => e.name)
const text = events.filter(e => e.type === 'text').map(e => e.text).join('')

check('pai chamou a tool Agent', toolStarts.includes('Agent'), JSON.stringify(toolStarts))
check('pai fechou com texto proprio', text.includes('pai concluiu'), JSON.stringify(text))
check('texto do subagente NAO vazou para o pai', !text.includes('RELATORIO DO SUBAGENTE'), JSON.stringify(text))

console.log('--- isolamento de tools ---')
// steps[0] = pai, steps[1..2] = filho. O filho so pode enxergar Read/Glob + ToolSearch.
const parentTools: string[] = mock.steps[0] ?? []
const childTools: string[] = mock.steps[1] ?? []
check('pai enxerga o conjunto completo', parentTools.includes('Bash') && parentTools.includes('Agent'), JSON.stringify(parentTools))
check('filho restrito ao frontmatter', childTools.includes('Read') && childTools.includes('Glob'), JSON.stringify(childTools))
check('filho sem Bash', !childTools.includes('Bash'), JSON.stringify(childTools))
check('filho sem Agent (sem recursao)', !childTools.includes('Agent'), JSON.stringify(childTools))
check('filho mantem ToolSearch', childTools.includes('ToolSearch'), JSON.stringify(childTools))

console.log('--- transcript ---')
await session.transcript.flush()
const records = await session.transcript.read()
const sidechain = records.filter((r: any) => r.isSidechain)
check('turnos do subagente marcados como sidechain', sidechain.length > 0, String(sidechain.length))
check('sidechain identifica o agente', sidechain.some((r: any) => r.agentId === 'tester'), '')
check('transcript unico (pai e filho)', new Set(records.map((r: any) => r.sessionId)).size === 1, '')

const toolResults = records.filter((r: any) => r.type === 'tool_result')
const agentResult = toolResults
  .flatMap((r: any) => r.results ?? [])
  .find((r: any) => r.toolName === 'Agent')
check('resultado do Agent voltou como tool_result', Boolean(agentResult), '')
check('resultado carrega o texto do subagente', String(agentResult?.text ?? '').includes('RELATORIO DO SUBAGENTE'), JSON.stringify(agentResult?.text))

const childBash = toolResults
  .flatMap((r: any) => r.results ?? [])
  .find((r: any) => r.toolName === 'Bash')
check('Bash do filho foi barrado', String(childBash?.text ?? '').includes('Unknown tool'), JSON.stringify(childBash?.text))

console.log('--- limite de profundidade ---')
{
  const deep = new Session({ config: { ...config, subagentDepth: 0 }, cwd, modelRef: config.model })
  await deep.init(() => {})
  registerTools(deep)
  const agent = deep.registry.get('Agent')
  const out = await agent.execute(
    { subagent_type: 'tester', prompt: 'x' },
    { session: deep, cwd, depth: 0 },
  )
  check('depth 0 recusa delegar', out.isError === true && out.text.includes('depth'), JSON.stringify(out.text))
  await deep.mcp.close()
}

await session.mcp.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
