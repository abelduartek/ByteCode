const { ROOT, SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('workflow')
useConfig({
  dataDir: `${S}/data`,
  model: 'mock/tiny',
  provider: { mock: { npm: fixtureUrl('mock-workflow.mjs'), models: { tiny: { id: 'tiny', limit: { context: 1000000, output: 4096 } } } } },
  assets: { agents: ['./none'], skills: ['./none'], commands: ['./none'] },
  instructions: [],
  compaction: { enabled: false },
  permissions: { allow: ['Read(**)', 'Glob(**)', 'Grep(**)', 'LS(**)'], defaultMode: 'default' },
})

const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const { extractMeta, listWorkflows, resolveWorkflowScript, runWorkflow, workflowRuns } = await import(`${R}/core/workflow.ts`)
const mock = await import(fixtureUrl('mock-workflow.mjs'))

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const cwd = ROOT
const { config } = await loadConfig(cwd)

console.log('--- meta ---')
{
  const meta = extractMeta(`export const meta = { name: 'x', description: 'd', phases: [{ title: 'A' }] }\nreturn 1`)
  check('le nome e descricao', meta.name === 'x' && meta.description === 'd', JSON.stringify(meta))
  check('le fases', meta.phases?.[0]?.title === 'A', JSON.stringify(meta.phases))
}
{
  let threw = ''
  try { extractMeta('const x = 1') } catch (e) { threw = String(e) }
  check('exige o bloco meta', threw.includes('export const meta'), threw)
}
{
  let threw = ''
  try { extractMeta('export const meta = { name: nomeDinamico, description: "d" }') } catch (e) { threw = String(e) }
  check('meta precisa ser literal puro', threw.includes('literal'), threw)
}

console.log('--- opt-in ---')
{
  const off = new Session({ config, cwd, modelRef: config.model })
  await off.init(() => {})
  registerTools(off)
  check('tool Workflow ausente por padrao', !off.registry.get('Workflow'), '')

  const on = new Session({ config: { ...config, workflows: { enabled: true } }, cwd, modelRef: config.model })
  await on.init(() => {})
  registerTools(on)
  check('tool Workflow presente quando habilitada', Boolean(on.registry.get('Workflow')), '')
  check('Workflow pede permissao (kind exec)', on.registry.get('Workflow')?.kind === 'exec', '')

  const child = on.child({ agentType: 'x' })
  await child.init(() => {})
  registerTools(child)
  check('subagente nao recebe Workflow (sem recursao)', !child.registry.get('Workflow'), '')
  await off.mcp.close(); await on.mcp.close(); await child.mcp.close()
}

console.log('--- execucao: phase, log, agent, parallel, pipeline, schema ---')
const session = new Session({ config: { ...config, workflows: { enabled: true, maxConcurrency: 3 } }, cwd, modelRef: config.model })
await session.init(() => {})
registerTools(session)
session.emit = () => {}
session.requestPermission = async () => true

const script = `export const meta = {
  name: 'teste',
  description: 'exercita as primitivas',
  phases: [{ title: 'Fan-out' }, { title: 'Pipeline' }]
}

phase('Fan-out')
log('comecando')
const fan = await parallel([
  () => agent('MARK:a', { label: 'a' }),
  () => agent('MARK:b', { label: 'b' }),
  () => agent('MARK:c', { label: 'c' }),
])

phase('Pipeline')
const piped = await pipeline(
  args.items,
  (item) => agent('MARK:' + item, { label: 'stage1-' + item }),
  (prev, item) => agent('MARK:' + item + '.2', { label: 'stage2-' + item }),
)

const structured = await agent('MARK:estruturado', { schema: { type: 'object', properties: { marker: { type: 'string' } } } })

return { fan, piped, structured }
`

const progress: string[] = []
const run = await runWorkflow(session, {
  script,
  args: { items: ['x', 'y'] },
  onProgress: e => progress.push(e.type),
})

const result = run.result as any
check('meta lida na execucao', run.meta.name === 'teste', run.meta.name)
check('parallel devolveu 3', result.fan.length === 3, JSON.stringify(result.fan))
check('parallel chamou os 3 agentes', result.fan.join('|') === 'RESP:a|RESP:b|RESP:c', JSON.stringify(result.fan))
check('pipeline devolveu 2 itens', result.piped.length === 2, JSON.stringify(result.piped))
check('pipeline passou pelos 2 estagios', result.piped[0] === 'RESP:x.2' && result.piped[1] === 'RESP:y.2', JSON.stringify(result.piped))
check('schema virou objeto', result.structured?.marker === 'estruturado' && result.structured?.ok === true, JSON.stringify(result.structured))
check('contou 8 agentes', run.agents === 8, String(run.agents))
check('sem erros', run.errors.length === 0, JSON.stringify(run.errors))
check('progresso emitiu fases', progress.includes('phase') && progress.includes('log'), JSON.stringify([...new Set(progress)]))
check('progresso emitiu agentes', progress.filter(p => p === 'agent-start').length === 8, String(progress.filter(p => p === 'agent-start').length))

console.log('--- concorrencia ---')
check('respeitou maxConcurrency 3', mock.stats.peak <= 3, `pico ${mock.stats.peak}`)
check('modelo chamado 8 vezes', mock.stats.calls === 8, String(mock.stats.calls))

console.log('--- journal e resume ---')
const { promises: fsp } = await import('node:fs')
const journal = await fsp.readFile(run.journalPath, 'utf8')
const entries = journal.split('\n').filter(Boolean).map(l => JSON.parse(l))
check('journal tem uma entrada por agente', entries.filter(e => e.type === 'agent').length === 8, String(entries.length))
check('journal fecha com resumo', entries.at(-1)?.type === 'end', JSON.stringify(entries.at(-1)))

const before = mock.stats.calls
const resumed = await runWorkflow(session, { script, args: { items: ['x', 'y'] }, resumeFromRunId: run.runId })
check('resume devolve o mesmo resultado', JSON.stringify(resumed.result) === JSON.stringify(run.result), '')
check('resume nao chamou o modelo de novo', mock.stats.calls === before, `${mock.stats.calls - before} chamadas novas`)

// A aprovação vale para o texto que foi lido, não para a intenção dele. Retomar
// reaproveita passos já pagos; se o corpo pudesse mudar no meio, o "sim" do
// usuário passaria a cobrir um script que ele nunca viu.
console.log('--- o resume exige o mesmo script ---')
{
  check('journal abre declarando o hash',
    entries[0]?.type === 'begin' && typeof entries[0]?.sha256 === 'string' && entries[0].sha256.length === 64,
    JSON.stringify(entries[0]))

  const alterado = `${script}\n// uma linha a mais muda o hash`
  let recusa = ''
  try {
    await runWorkflow(session, { script: alterado, args: { items: ['x', 'y'] }, resumeFromRunId: run.runId })
  } catch (err) {
    recusa = err instanceof Error ? err.message : String(err)
  }
  check('script alterado não retoma', recusa.includes('mudou desde que o run'), recusa)
  check('e a recusa diz o que fazer', recusa.includes('resumeFromRunId'), recusa)

  // Journal de antes desta verificação não tem a linha `begin`; retomar
  // continua valendo, senão a mudança quebraria runs já gravados no disco.
  const semBegin = run.journalPath.replace(/\.jsonl$/, '-legado.jsonl')
  const runIdLegado = `${run.runId}-legado`
  await fsp.writeFile(semBegin, journal.split('\n').filter(l => l && !l.includes('"begin"')).join('\n') + '\n', 'utf8')
  const legado = await runWorkflow(session, {
    script: alterado,
    args: { items: ['x', 'y'] },
    resumeFromRunId: runIdLegado,
  })
  check('journal antigo, sem hash, ainda retoma', legado.runId !== run.runId, legado.runId)
}

console.log('--- falha do script ---')
{
  let message = ''
  try {
    await runWorkflow(session, { script: `export const meta = { name: 'x', description: 'd' }\nthrow new Error('estourou')` })
  } catch (e) {
    message = String(e)
  }
  check('erro do script sobe com contexto', message.includes('estourou') && message.includes('failed'), message)
}

console.log('--- rodada ao vivo (o que /workflows le) ---')
{
  const runs = workflowRuns(session)
  const live = runs.find(r => r.runId === run.runId)
  check('a rodada fica registrada na sessao', Boolean(live), JSON.stringify(runs.map(r => r.runId)))
  check('registrou um passo por agente', live?.steps.length === 8, String(live?.steps.length))
  check('todos os passos terminaram', live?.steps.every(s => s.state !== 'running') === true, JSON.stringify(live?.steps.map(s => s.state)))
  check('guardou as fases dos passos', live?.steps.some(s => s.phase === 'Fan-out') === true && live?.steps.some(s => s.phase === 'Pipeline') === true, JSON.stringify(live?.steps.map(s => s.phase)))
  check('guardou o log do script', live?.logs.includes('comecando') === true, JSON.stringify(live?.logs))
  check('marcou como terminada', live?.done === true && live?.ok === true, '')
  check('contou tokens de saida', (live?.tokens ?? 0) > 0, String(live?.tokens))

  const replay = workflowRuns(session).find(r => r.runId === resumed.runId)
  check('resume marca os passos como cache', replay?.steps.every(s => s.state === 'cached') === true, JSON.stringify(replay?.steps.map(s => s.state)))

  const child = session.child({ agentType: 'x' })
  check('subagente enxerga a rodada da raiz', workflowRuns(child).length === workflowRuns(session).length, '')
}

console.log('--- workflow aninhado ---')
{
  const dir = `${S}/proj/.bytecode/workflows`
  await fsp.mkdir(dir, { recursive: true })
  const childFile = `${dir}/filho.js`
  await fsp.writeFile(childFile, `export const meta = { name: 'filho', description: 'um passo so' }
phase('Filho')
log('rodando')
return await agent('MARK:' + args.marker, { label: 'filho-1' })
`, 'utf8')

  const parent = `export const meta = { name: 'pai', description: 'chama o filho' }
phase('Pai')
const filho = await workflow(${JSON.stringify({ scriptPath: childFile })}, { marker: 'z' })
const meu = await agent('MARK:pai', { label: 'pai-1' })
return { filho, meu }
`
  const nested = await runWorkflow(session, { script: parent })
  const out = nested.result as any
  check('sub-workflow devolve o resultado dele', out.filho === 'RESP:z', JSON.stringify(out))
  check('o pai continua depois do filho', out.meu === 'RESP:pai', JSON.stringify(out))
  check('contador de agentes e compartilhado', nested.agents === 2, String(nested.agents))

  const live = workflowRuns(session).find(r => r.runId === nested.runId)
  check('fase do filho vem prefixada', live?.steps.some(s => s.phase === '▸ filho Filho') === true, JSON.stringify(live?.steps.map(s => s.phase)))
  check('fase do pai fica intacta', live?.steps.some(s => s.phase === 'Pai') === true, JSON.stringify(live?.steps.map(s => s.phase)))
  check('log do filho vem prefixado', live?.logs.includes('▸ filho rodando') === true, JSON.stringify(live?.logs))

  const entries = (await fsp.readFile(nested.journalPath, 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l))
  check('journal unico para pai e filho', entries.filter(e => e.type === 'agent').length === 2, String(entries.length))

  const byName = await resolveWorkflowScript('filho', `${S}/proj`)
  check('resolve workflow salvo pelo nome', byName.file.endsWith('filho.js') && byName.script.includes("name: 'filho'"), byName.file)
  const saved = await listWorkflows(`${S}/proj`)
  check('lista os workflows salvos', saved.some(w => w.name === 'filho' && w.description === 'um passo so'), JSON.stringify(saved))

  let unknown = ''
  try { await resolveWorkflowScript('nao-existe', `${S}/proj`) } catch (e) { unknown = String(e) }
  check('nome desconhecido diz o que existe', unknown.includes('unknown workflow') && unknown.includes('filho'), unknown)
}

console.log('--- aninhamento so um nivel ---')
{
  const dir = `${S}/proj/.bytecode/workflows`
  await fsp.writeFile(`${dir}/neto.js`, `export const meta = { name: 'neto', description: 'tenta aninhar de novo' }
return await workflow('filho', { marker: 'n' })
`, 'utf8')
  let message = ''
  try {
    await runWorkflow(session, { script: `export const meta = { name: 'avo', description: 'dois niveis' }
return await workflow(${JSON.stringify({ scriptPath: `${dir}/neto.js` })})
` })
  } catch (e) { message = String(e) }
  check('segundo nivel e recusado', message.includes('um nível'), message)
}

console.log('--- orcamento ---')
{
  const script3 = `export const meta = { name: 'orcado', description: 'tres passos' }
await agent('MARK:o1', { label: 'o1' })
await agent('MARK:o2', { label: 'o2' })
await agent('MARK:o3', { label: 'o3' })
return 'fim'
`
  let message = ''
  try { await runWorkflow(session, { script: script3, budget: 4 }) } catch (e) { message = String(e) }
  check('teto de tokens corta a rodada', message.includes('budget'), message)
  const live = workflowRuns(session).at(-1)
  check('parou nos passos que cabiam', live?.steps.length === 2, JSON.stringify(live?.steps.map(s => s.label)))
  check('rodada estourada fica marcada', live?.ok === false, '')

  const introspect = await runWorkflow(session, {
    script: `export const meta = { name: 'introspec', description: 'le o proprio orcamento' }
const antes = { total: budget.total, restante: budget.remaining() }
await agent('MARK:i1')
return { antes, gasto: budget.spent(), restante: budget.remaining() }
`,
    budget: 100,
  })
  const seen = introspect.result as any
  check('budget.total visivel no script', seen.antes.total === 100, JSON.stringify(seen))
  check('remaining cai conforme gasta', seen.restante === 100 - seen.gasto && seen.gasto > 0, JSON.stringify(seen))

  const semTeto = await runWorkflow(session, {
    script: `export const meta = { name: 'sem-teto', description: 'sem orcamento' }
return { total: budget.total, restante: budget.remaining() }
`,
  })
  const free = semTeto.result as any
  check('sem teto total e null', free.total === null, JSON.stringify(free))
  check('sem teto remaining e Infinity', free.restante === Infinity, JSON.stringify(free))
}

// O que aparece no pedido de permissão é o que o usuário tem para decidir. Nome
// sozinho é aprovar no escuro: o que está sendo autorizado é uma frota.
console.log('--- a aprovação descreve as fases ---')
{
  const { workflowTool } = await import(`${R}/tools/workflow.ts`)
  const comFases = workflowTool.summary!({
    script: `export const meta = {
  name: 'revisao',
  description: 'revisa o diff',
  phases: [
    { title: 'Review', detail: '7 revisores' },
    { title: 'Verify' },
  ],
}
`,
  })
  check('nomeia o workflow', comFases.includes('workflow revisao'), comFases)
  check('diz quantas fases', comFases.includes('2 fases'), comFases)
  check('lista as fases na ordem', /1 Review — 7 revisores[\s\S]*2 Verify/.test(comFases), comFases)

  const semFases = workflowTool.summary!({
    script: `export const meta = { name: 'simples', description: 'sem fases' }`,
  })
  check('sem fases declaradas continua uma linha', semFases === 'workflow simples', semFases)

  // Um script que nem parseia não pode derrubar o pedido de permissão.
  const quebrado = workflowTool.summary!({ script: 'não é um workflow', name: 'algum' })
  check('script ilegível cai no nome', quebrado.includes('algum'), quebrado)
}

// O workflow que vem junto. Sem nenhum exemplo, todo mundo reinventa o padrão
// adversarial — e erra a assimetria, que é a parte que importa.
console.log('--- workflow embutido ---')
{
  const { listWorkflows, extractMeta } = await import(`${R}/core/workflow.ts`)
  const { promises: fsp2 } = await import('node:fs')

  const achados = await listWorkflows(S)
  const embutido = achados.find((w: any) => w.name === 'code-review')
  check('code-review é descoberto de qualquer diretório', embutido !== undefined,
    JSON.stringify(achados.map((w: any) => w.name)))

  if (embutido) {
    const src = await fsp2.readFile(embutido.file, 'utf8')
    const meta = extractMeta(src)
    check('declara as fases, então a aprovação as mostra', (meta.phases ?? []).length === 2,
      JSON.stringify(meta.phases))
    // A regra de 2 de 3 é a decisão de projeto do arquivo: o default é manter o
    // achado, porque deixar passar defeito custa mais que ler um falso positivo.
    check('mantém o achado quando a maioria não refuta', src.includes('refutacoes < 2'), '')
    check('usa pipeline, não uma barreira por fase', src.includes('await pipeline('), '')
  }
}

await session.mcp.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
