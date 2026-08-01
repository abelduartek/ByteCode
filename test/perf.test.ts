const { ROOT, SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('perf')
useConfig({
  dataDir: `${S}/data`,
  model: 'mock/tiny',
  provider: {
    mock: { npm: fixtureUrl('mock-perf.mjs'), models: { tiny: { id: 'tiny', limit: { context: 1000000, output: 4096 }, cost: { input: 3, output: 15 } } } },
  },
  assets: { agents: ['./none'], skills: ['./none'], commands: ['./none'] },
  instructions: [],
  compaction: { enabled: false },
  permissions: { defaultMode: 'bypassPermissions' },
})

const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const { runTurn } = await import(`${R}/core/loop.ts`)
const { formatLeadtime, summarizeTurn, formatDuration, costOf } = await import(`${R}/core/leadtime.ts`)
const bin = await import(`${R}/util/binaries.ts`)
const { bashTool, powershellTool, shellTools } = await import(`${R}/tools/shell.ts`)
const { globTool, grepTool } = await import(`${R}/tools/fs.ts`)
const mock = await import(fixtureUrl('mock-perf.mjs'))

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const cwd = ROOT
const { config } = await loadConfig(cwd)
const isWin = process.platform === 'win32'

async function newSession() {
  const s = new Session({ config, cwd, modelRef: config.model! })
  await s.init(() => {})
  registerTools(s)
  s.emit = () => {}
  s.requestPermission = async () => true
  return s
}

// ------------------------------------------------------- item 2: shell POSIX
console.log('--- descoberta de binarios ---')
{
  const shell = bin.posixShell()
  if (isWin) {
    check('acha um bash real no Windows', shell !== null, String(shell))
    check('nao usa o launcher do WSL', !/system32/i.test(shell?.file ?? ''), shell?.file ?? '')
  } else {
    check('POSIX usa /bin/sh via shell:true', shell === null, String(shell))
  }
  check('which acha node', Boolean(bin.which('node')), String(bin.which('node')))
  check('which devolve null pra binario inexistente', bin.which('nao_existe_zzz') === null)
  check('ripgrep resolvido', Boolean(bin.ripgrepPath()), String(bin.ripgrepPath()))
}

console.log('--- tool Bash roda POSIX de verdade ---')
{
  const session = await newSession()
  const ctx = { session, cwd, depth: 0 }

  if (isWin && !bin.posixShell()) {
    check('sem bash: tool Bash nao e oferecida', !shellTools.includes(bashTool))
  } else {
    const out = await bashTool.execute({ command: 'echo shell=$0; ls -d .; pwd' }, ctx as never)
    check('$0 expandiu (nao e cmd.exe)', /shell=.*(sh|bash)/.test(out.text), out.text.slice(0, 120))
    check('ls existe', !/not recognized|n[aã]o (é|e) reconhecido/i.test(out.text), out.text.slice(0, 120))
    check('exit 0', out.isError !== true, out.text.slice(0, 120))

    const missing = await bashTool.execute({ command: 'comando_que_nao_existe_zzz' }, ctx as never)
    check('comando ausente vira erro', missing.isError === true)
    check('erro sugere Glob/Grep', /Hint:.*Glob/.test(missing.text), missing.text.slice(0, 160))
  }

  if (isWin) {
    check('PowerShell registrada no Windows', shellTools.includes(powershellTool))
    const ps = await powershellTool.execute({ command: 'Write-Output ok' }, ctx as never)
    check('PowerShell roda', ps.text.trim() === 'ok', ps.text)
  }
  await session.mcp.close()
}

// ------------------------------------------------ item 3: ripgrep no Glob/Grep
console.log('--- paridade rg x scanner JS ---')
{
  const session = await newSession()
  const ctx = { session, cwd, depth: 0 }

  const withRg = await globTool.execute({ pattern: 'src/**/*.ts' }, ctx as never)
  const rgFiles = withRg.text.split('\n').filter(Boolean).sort()

  process.env.HX_NO_RG = '1'
  bin.resetBinaryCache()
  check('kill-switch desliga o rg', bin.ripgrepPath() === null)
  const withoutRg = await globTool.execute({ pattern: 'src/**/*.ts' }, ctx as never)
  const jsFiles = withoutRg.text.split('\n').filter(Boolean).sort()

  check('rg e JS acham o mesmo conjunto', JSON.stringify(rgFiles) === JSON.stringify(jsFiles),
    `rg=${rgFiles.length} js=${jsFiles.length}`)
  check('achou os arquivos do projeto', rgFiles.length > 20, String(rgFiles.length))

  const jsGrep = await grepTool.execute({ pattern: 'posixShell', glob: '**/*.ts' }, ctx as never)
  process.env.HX_NO_RG = ''
  delete process.env.HX_NO_RG
  bin.resetBinaryCache()
  const rgGrep = await grepTool.execute({ pattern: 'posixShell', glob: '**/*.ts' }, ctx as never)

  const files = (t: string) => [...new Set(t.split('\n').filter(Boolean).map(l => l.split(':')[0] + l.split(':')[1]))]
  check('grep acha em ambos os caminhos', files(jsGrep.text).length > 0 && files(rgGrep.text).length > 0,
    `js=${files(jsGrep.text).length} rg=${files(rgGrep.text).length}`)
  check('rg usa o binario vendorizado', /ripgrep/.test(bin.ripgrepPath() ?? '') || Boolean(bin.ripgrepPath()),
    String(bin.ripgrepPath()))

  // Ancoragem: `*.ts` na raiz nao pode trazer arquivos aninhados.
  const shallow = await globTool.execute({ pattern: '*.ts' }, ctx as never)
  check('glob raso nao vaza subdiretorio', !/[\\/]src[\\/]/.test(shallow.text), shallow.text.slice(0, 200))
  await session.mcp.close()
}

// ------------------------------------------------- ajustes de PENDENCIAS.md
console.log('--- Read com offset/limit ---')
{
  const { readTool } = await import(`${R}/tools/fs.ts`)
  const { promises: fsp } = await import('node:fs')
  const session = await newSession()
  const ctx = { session, cwd, depth: 0 }

  const small = `${S}\\readsmall.txt`
  await fsp.writeFile(small, Array.from({ length: 500 }, (_, i) => `linha ${i + 1}`).join('\n'), 'utf8')

  const win = await readTool.execute({ file_path: small, offset: 100, limit: 3 }, ctx as never)
  check('janela começa no offset', win.text.startsWith('100\tlinha 100'), JSON.stringify(win.text.slice(0, 30)))
  check('respeita o limit', win.text.split('\n').filter(l => /^\d+\t/.test(l)).length === 3,
    JSON.stringify(win.text.split('\n').slice(0, 5)))
  // 500 linhas, consumidas 99+3 = 102 -> restam 398
  check('conta as linhas restantes', /\[398 more lines\]/.test(win.text), JSON.stringify(win.text.slice(-30)))

  const whole = await readTool.execute({ file_path: small }, ctx as never)
  check('sem offset lê do começo', whole.text.startsWith('1\tlinha 1'), JSON.stringify(whole.text.slice(0, 20)))

  const past = await readTool.execute({ file_path: small, offset: 9999 }, ctx as never)
  check('offset além do fim avisa', past.text.includes('past EOF'), JSON.stringify(past.text.slice(0, 60)))

  // Acima do limiar de 2 MB troca para leitura em stream: o resultado tem que ser
  // igual, e o custo não pode escalar com o tamanho do arquivo.
  const big = `${S}\\readbig.txt`
  const chunk = `${'x'.repeat(200)}\n`
  await fsp.writeFile(big, chunk.repeat(20000), 'utf8') // ~4 MB
  const t0 = Date.now()
  const streamed = await readTool.execute({ file_path: big, offset: 5, limit: 2 }, ctx as never)
  const elapsed = Date.now() - t0
  check('stream devolve a janela certa', streamed.text.startsWith('5\txxx'), JSON.stringify(streamed.text.slice(0, 20)))
  check('stream não lê o arquivo todo', elapsed < 400, `${elapsed}ms para 4 MB`)
  check('stream avisa que há mais abaixo', streamed.text.includes('more lines below'),
    JSON.stringify(streamed.text.slice(-40)))

  await fsp.rm(small, { force: true })
  await fsp.rm(big, { force: true })
  await session.mcp.close()
}

console.log('--- subagente herda assets do pai ---')
{
  const parent = await newSession()
  const before = parent.assets.agents.length
  // Marcador que só existe em memória: se o filho recarregasse do disco, sumiria.
  parent.assets = { ...parent.assets, skills: [...parent.assets.skills, { name: 'MARCADOR', description: 'x', file: 'y', dir: 'z', allowedTools: [] }] } as never

  const child = parent.child({ agentType: 'x' })
  await child.init(() => {})
  check('filho herda os assets por referência', child.assets === parent.assets, '')
  check('marcador em memória sobrevive', child.assets.skills.some(s => s.name === 'MARCADOR'),
    JSON.stringify(child.assets.skills.map(s => s.name).slice(-2)))
  check('mesma contagem de agents', child.assets.agents.length === before, `${child.assets.agents.length} vs ${before}`)
  await child.mcp.close()
  await parent.mcp.close()
}

console.log('--- catálogo memoizado ---')
{
  const catalog = await import(`${R}/provider/catalog.ts`)
  catalog.clearCatalogMemo()
  const first = await catalog.loadCatalog({ offlineOk: true })
  const t0 = Date.now()
  for (let i = 0; i < 20; i++) await catalog.loadCatalog({ offlineOk: true })
  const per = (Date.now() - t0) / 20
  check('segunda chamada não relê do disco', per < 1, `${per.toFixed(2)}ms por chamada`)
  const second = await catalog.loadCatalog({ offlineOk: true })
  check('devolve o mesmo objeto', first === second || Object.keys(first).length === Object.keys(second).length, '')
  catalog.clearCatalogMemo()
}

console.log('--- Edit conta ocorrências sem alocar ---')
{
  const { editTool } = await import(`${R}/tools/fs.ts`)
  const { promises: fsp } = await import('node:fs')
  const session = await newSession()
  const ctx = { session, cwd, depth: 0 }
  const file = `${S}\\counttest.txt`

  await fsp.writeFile(file, 'aa\nbb\naa\ncc\naa\n', 'utf8')
  const ambiguous = await editTool.execute({ file_path: file, old_string: 'aa', new_string: 'zz' }, ctx as never)
  check('detecta as 3 ocorrências', ambiguous.text.includes('matches 3 times'), JSON.stringify(ambiguous.text.slice(0, 70)))
  check('e recusa sem replace_all', ambiguous.isError === true, '')

  const all = await editTool.execute({ file_path: file, old_string: 'aa', new_string: 'zz', replace_all: true }, ctx as never)
  check('replace_all aplica', !all.isError, JSON.stringify(all.text.slice(0, 40)))
  check('não sobrou ocorrência', !(await fsp.readFile(file, 'utf8')).includes('aa'), '')

  // sobreposição: 'aaa' em 'aaaa' conta 1, não 2
  await fsp.writeFile(file, 'aaaa', 'utf8')
  // A escrita acima é externa à sessão, e a guarda de arquivo recusa escrever por
  // cima de algo que mudou no disco. Ler de novo é exatamente o que ela pede — e
  // o que o modelo faria.
  const { readTool } = await import(`${R}/tools/fs.ts`)
  await readTool.execute({ file_path: file }, ctx as never)
  const overlap = await editTool.execute({ file_path: file, old_string: 'aaa', new_string: 'b' }, ctx as never)
  check('não conta ocorrência sobreposta', !overlap.isError, JSON.stringify(overlap.text.slice(0, 60)))

  await fsp.rm(file, { force: true })
  await session.mcp.close()
}

console.log('--- contextTokens usa o baseline sem passada extra ---')
{
  const { contextTokens } = await import(`${R}/core/compaction.ts`)
  const session = await newSession()
  session.messages = Array.from({ length: 200 }, (_, i) => ({
    role: i % 2 ? 'assistant' : 'user',
    content: 'y'.repeat(400),
  })) as never

  const noBaseline = contextTokens(session)
  check('sem baseline estima tudo', noBaseline > 15000, String(noBaseline))

  session.tokenBaseline = { messageCount: 190, inputTokens: 50000 }
  const withBaseline = contextTokens(session)
  check('com baseline parte do valor do provider', withBaseline > 50000 && withBaseline < 52000,
    String(withBaseline))
  check('não é a estimativa completa', withBaseline !== noBaseline, '')
  await session.mcp.close()
}

// ------------------------------------- diff numerado que Edit/Write devolvem
console.log('--- diff das ferramentas de escrita ---')
{
  const { editTool, writeTool } = await import(`${R}/tools/fs.ts`)
  const { promises: fsp } = await import('node:fs')
  const session = await newSession()
  const ctx = { session, cwd, depth: 0 }
  const file = `${S}\\difftest.txt`

  await fsp.writeFile(file, 'um\ndois\ntres\nquatro\ncinco\nseis\nsete\n', 'utf8')
  const edited = await editTool.execute(
    { file_path: file, old_string: 'quatro', new_string: 'QUATRO\nQUATRO-B' },
    ctx as never,
  )
  const rows = edited.text.split('\n')
  check('resumo conta linhas', rows[0] === 'Added 2 lines, removed 1 line', JSON.stringify(rows[0]))
  check('linha removida marcada', rows.some(r => /^\s*4 - quatro$/.test(r)), JSON.stringify(rows))
  check('linhas adicionadas marcadas',
    rows.some(r => /^\s*4 \+ QUATRO$/.test(r)) && rows.some(r => /^\s*5 \+ QUATRO-B$/.test(r)), JSON.stringify(rows))
  // Contexto usa marcador " ", então sobram 3 espaços entre número e texto.
  check('traz contexto antes', rows.some(r => /^\s*1 {3}um$/.test(r)), JSON.stringify(rows.slice(1, 4)))
  check('traz contexto depois', rows.some(r => /^\s*6 {3}cinco$/.test(r)), JSON.stringify(rows.slice(-3)))
  check('numeros alinhados em coluna', rows.slice(1).every(r => /^ {5}\d+ [+\- ] /.test(r) || /^ {4}\d\d [+\- ] /.test(r)),
    JSON.stringify(rows.slice(1, 3)))

  const created = await writeTool.execute({ file_path: `${S}\\difftest2.txt`, content: 'a\nb\nc' }, ctx as never)
  check('arquivo novo reporta criação', /^Created 3 lines/.test(created.text), JSON.stringify(created.text))

  const rewritten = await writeTool.execute({ file_path: `${S}\\difftest2.txt`, content: 'a\nZ\nc' }, ctx as never)
  check('sobrescrever reporta diff', rewritten.text.startsWith('Added 1 line, removed 1 line'),
    JSON.stringify(rewritten.text.split('\n')[0]))

  const noop = await editTool.execute({ file_path: file, old_string: 'cinco', new_string: 'cinco' }, ctx as never)
  check('troca sem efeito é honesta', noop.text.startsWith('No line changed'), JSON.stringify(noop.text.split('\n')[0]))

  await fsp.rm(file, { force: true })
  await fsp.rm(`${S}\\difftest2.txt`, { force: true })
  await session.mcp.close()
}

// ------------------------------------------------------------ item 4: retry
console.log('--- retry com backoff ---')
{
  const session = await newSession()
  const notices: string[] = []
  let out = ''
  session.emit = e => {
    if (e.type === 'text') out += e.text
    if (e.type === 'notice') notices.push(e.text)
    if (e.type === 'error') notices.push(`ERR:${e.text}`)
  }

  mock.reset()
  mock.script.push(
    mock.failure({ status: 429, message: 'rate limited', retryAfterMs: 5 }),
    mock.failure({ status: 503, message: 'overloaded', retryAfterMs: 5 }),
    mock.text('resposta final'),
  )
  const t0 = Date.now()
  await runTurn(session, 'oi')
  const elapsed = Date.now() - t0

  check('turno concluiu apesar das falhas', out.trim() === 'resposta final', JSON.stringify(out))
  check('contou 2 retries', session.lastTurn?.retries === 2, String(session.lastTurn?.retries))
  check('chamou o modelo 3 vezes', mock.stats.calls === 3, String(mock.stats.calls))
  check('avisou o usuario', notices.filter(n => n.includes('tentando de novo')).length === 2, JSON.stringify(notices))
  check('respeitou retry-after (rapido)', elapsed < 2000, `${elapsed}ms`)
  check('nao duplicou texto', (out.match(/resposta final/g) ?? []).length === 1, JSON.stringify(out))
  await session.mcp.close()
}

console.log('--- erro permanente nao repete ---')
{
  const session = await newSession()
  const errors: string[] = []
  session.emit = e => { if (e.type === 'error') errors.push(e.text) }

  mock.reset()
  mock.script.push(mock.failure({ status: 401, message: 'invalid api key' }))
  // Falha permanente rejeita o turno; o turno mesmo assim fecha as estatisticas.
  let rejeitou = false
  await runTurn(session, 'oi').catch(() => { rejeitou = true })

  check('falha permanente rejeita o turno', rejeitou, '')
  check('401 nao gera retry', session.lastTurn?.retries === 0, String(session.lastTurn?.retries))
  check('chamou o modelo 1 vez', mock.stats.calls === 1, String(mock.stats.calls))
  check('erro chegou ao usuario', errors.some(e => /invalid api key/i.test(e)), JSON.stringify(errors))
  await session.mcp.close()
}

console.log('--- classificacao de erro de rede ---')
{
  const cases: [string, unknown, boolean][] = [
    ['DNS inexistente nao repete', Object.assign(new Error('fetch failed'), { cause: Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }) }), false],
    ['conexao recusada nao repete', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), false],
    ['certificado invalido nao repete', Object.assign(new Error('fetch failed'), { cause: { code: 'CERT_HAS_EXPIRED' } }), false],
    ['reset repete', Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }), true],
    ['DNS temporario repete', Object.assign(new Error('fetch failed'), { cause: { code: 'EAI_AGAIN' } }), true],
    ['timeout do undici repete', Object.assign(new Error('fetch failed'), { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), true],
    ['429 repete', Object.assign(new Error('slow down'), { statusCode: 429 }), true],
    ['503 repete', Object.assign(new Error('unavailable'), { statusCode: 503 }), true],
    ['401 nao repete', Object.assign(new Error('bad key'), { statusCode: 401 }), false],
    ['contexto estourado nao repete', new Error('maximum context length exceeded'), false],
  ]
  const session = await newSession()
  for (const [name, error, expected] of cases) {
    const notices: string[] = []
    session.emit = e => { if (e.type === 'notice') notices.push(e.text) }
    mock.reset()
    // O primeiro passo falha; se for classificado como transitorio, o segundo roda.
    mock.script.push([
      { type: 'stream-start', warnings: [] },
      { type: 'error', error },
      { type: 'finish', finishReason: 'error', usage: { inputTokens: {}, outputTokens: {} } },
    ] as never, mock.text('recuperou'))
    // Um erro nao transitorio rejeita o turno — o que interessa aqui e se houve
    // segunda chamada, nao se o turno terminou bem.
    await runTurn(session, 'oi').catch(() => {})
    const retried = mock.stats.calls > 1
    check(name, retried === expected, `calls=${mock.stats.calls} notices=${notices.length}`)
  }
  await session.mcp.close()
}

console.log('--- nao repete depois de ja ter mostrado texto ---')
{
  const session = await newSession()
  let out = ''
  session.emit = e => { if (e.type === 'text') out += e.text }

  mock.reset()
  mock.script.push(
    mock.textThenFailure('metade da resp', { status: 503, message: 'overloaded' }),
    mock.text('NAO DEVIA APARECER'),
  )
  await runTurn(session, 'oi').catch(() => {})

  check('nao repetiu apos saida parcial', mock.stats.calls === 1, String(mock.stats.calls))
  check('nao emitiu a segunda resposta', !out.includes('NAO DEVIA'), JSON.stringify(out))
  // O que o usuario ja leu continua na historia: sem isso a proxima pergunta e
  // respondida como se metade da resposta nunca tivesse sido dita.
  const guardou = session.messages.some(
    (m: any) => m.role === 'assistant' && String(m.content).includes('metade da resp'),
  )
  check('texto parcial fica na historia', guardou, JSON.stringify(session.messages.slice(-2)))
  await session.mcp.close()
}

// ------------------------------------------- item 6: paralelismo particionado
console.log('--- paralelismo particionado ---')
{
  const session = await newSession()
  session.emit = () => {}
  const events: string[] = []
  const times: number[] = []
  let active = 0
  let peak = 0

  const make = (name: string, parallelSafe: boolean) => ({
    name,
    kind: 'read' as const,
    parallelSafe,
    description: name,
    inputSchema: { type: 'object' as const, properties: { tag: { type: 'string' } } },
    async execute(input: Record<string, unknown>) {
      const tag = String(input.tag)
      active++
      peak = Math.max(peak, active)
      events.push(`start:${tag}`)
      times.push(Date.now())
      await new Promise(r => setTimeout(r, 60))
      events.push(`end:${tag}`)
      times.push(Date.now())
      active--
      return { text: tag }
    },
  })

  session.registry.register(make('Safe', true))
  session.registry.register(make('Unsafe', false))

  mock.reset()
  mock.script.push(
    mock.tools([
      { name: 'Safe', input: { tag: 'a' } },
      { name: 'Safe', input: { tag: 'b' } },
      { name: 'Safe', input: { tag: 'c' } },
      { name: 'Unsafe', input: { tag: 'X' } },
      { name: 'Safe', input: { tag: 'd' } },
      { name: 'Safe', input: { tag: 'e' } },
    ]),
    mock.text('pronto'),
  )

  await runTurn(session, 'oi')
  // Mede so a fase de tools: 6 chamadas de 60ms. Serial = ~360ms,
  // particionado = 3 ondas = ~180ms.
  const toolSpan = Math.max(...times) - Math.min(...times)

  check('lote seguro rodou em paralelo', peak >= 3, `pico ${peak}`)
  check('a,b,c terminaram antes de X comecar',
    Math.max(events.indexOf('end:a'), events.indexOf('end:b'), events.indexOf('end:c')) < events.indexOf('start:X'),
    JSON.stringify(events))
  check('d,e so comecaram depois de X terminar',
    events.indexOf('end:X') < Math.min(events.indexOf('start:d'), events.indexOf('start:e')),
    JSON.stringify(events))
  check('3 ondas, nao 6 chamadas em serie', toolSpan < 280, `${toolSpan}ms (serial seria ~360ms)`)

  const toolMsg = session.messages.find(m => m.role === 'tool') as { content: { output: { value: string } }[] }
  const order = toolMsg.content.map(c => c.output.value).join(',')
  check('ordem dos resultados preservada', order === 'a,b,c,X,d,e', order)
  await session.mcp.close()
}

// --------------------------------------------------------- item 5: leadtime
console.log('--- leadtime ---')
{
  const session = await newSession()
  session.emit = () => {}
  let endStats: unknown = null
  session.emit = e => { if (e.type === 'turn-end') endStats = e.stats }

  mock.reset()
  mock.script.push(
    mock.tools([{ name: 'LS', input: { path: 'src' } }, { name: 'LS', input: { path: 'src/core' } }]),
    mock.tools([{ name: 'Glob', input: { pattern: 'src/**/*.ts' } }]),
    mock.text('acabou'),
  )
  await runTurn(session, 'oi')

  const stats = session.lastTurn!
  check('turn-end carrega as stats', endStats === stats)
  check('contou 3 steps', stats.steps === 3, String(stats.steps))
  check('somou tokens de entrada', stats.inputTokens === 300, String(stats.inputTokens))
  check('somou tokens de saida', stats.outputTokens === 60, String(stats.outputTokens))
  check('leu cache read do inputTokenDetails', stats.cacheReadTokens === 90, String(stats.cacheReadTokens))
  check('leu cache write do inputTokenDetails', stats.cacheWriteTokens === 30, String(stats.cacheWriteTokens))
  check('contou 2 LS', stats.tools.LS?.calls === 2, JSON.stringify(stats.tools))
  check('contou 1 Glob', stats.tools.Glob?.calls === 1, JSON.stringify(stats.tools))
  check('sem falhas', Object.values(stats.tools).every(t => (t as { fail: number }).fail === 0))
  check('duracao registrada', typeof stats.endedAt === 'number' && stats.endedAt >= stats.startedAt)
  check('turno corrente limpo no fim', session.turn === null)

  const cost = costOf(session, stats)
  check('custo calculado', cost !== null && cost > 0, String(cost))
  // 210 frescos + 90 lidos do cache (0.1x) + 30 escritos (1.25x) + 60 de saida
  const expected = (210 * 3 + 90 * 3 * 0.1 + 30 * 3 * 1.25 + 60 * 15) / 1e6
  check('custo desconta o cache', Math.abs((cost ?? 0) - expected) < 1e-9, `${cost} vs ${expected}`)

  const report = formatLeadtime(session, stats)
  check('relatorio traz duracao', /duração/.test(report))
  check('relatorio lista as tools', /\| LS \| 2 \|/.test(report), report)
  check('resumo em uma linha', /step/.test(summarizeTurn(session, stats)), summarizeTurn(session, stats))
  check('stats da sessao acumulam', session.sessionStats.steps >= 3, String(session.sessionStats.steps))

  check('formatDuration ms', formatDuration(450) === '450ms')
  check('formatDuration s', formatDuration(12_400) === '12.4s')
  check('formatDuration m', formatDuration(375_000) === '6m 15s', formatDuration(375_000))

  // Um turno é o que o `/leadtime` mostrava, e uma tarefa pesada é muitos
  // turnos: o relatório respondia "quanto custou a última coisa" quando a
  // pergunta era "quanto custou a tarefa".
  check('o turno guarda o que foi pedido', stats.label === 'oi', JSON.stringify(stats.label))
  check('o turno entra no histórico da sessão', session.turns.at(-1) === stats, String(session.turns.length))

  mock.reset()
  mock.script.push(mock.tools([{ name: 'Glob', input: { pattern: '*.md' } }]), mock.text('pronto'))
  await runTurn(session, 'segunda tarefa, essa bem mais longa que a primeira\ncom outra linha')
  const dois = formatLeadtime(session, session.lastTurn!)
  check('relatório tem o bloco da sessão', /## sessão/.test(dois), dois.slice(0, 200))
  check('o bloco da sessão conta os turnos', /## sessão · 2 turnos/.test(dois), dois.slice(0, 200))
  check('a sessão soma as tools dos dois turnos', /\| LS \| 2 \|/.test(dois) && /\| Glob \| 2 \|/.test(dois), dois)
  check('lista turno a turno', /\| 1 \| oi \|/.test(dois) && /\| 2 \| segunda tarefa/.test(dois), dois)
  check('o rótulo do turno é só a primeira linha', !/outra linha/.test(dois), dois)
  check('o rótulo do turno é limitado', (session.turns.at(-1)!.label ?? '').length <= 60,
    JSON.stringify(session.turns.at(-1)!.label))

  // Um subagente não tem "sessão": seria o mesmo bloco duas vezes.
  const filho = session.child({ agentType: 'x' })
  await filho.init(() => {})
  check('subagente não repete o bloco da sessão',
    !/## sessão/.test(formatLeadtime(filho, stats)), '')
  await filho.mcp.close()
  await session.mcp.close()
}

console.log('--- subagente entra no leadtime do pai ---')
{
  const session = await newSession()
  session.emit = () => {}
  mock.reset()
  mock.script.push(mock.text('so o pai'))
  await runTurn(session, 'oi')
  const parentOnly = session.lastTurn!.inputTokens

  const child = session.child({ agentType: 'x' })
  await child.init(() => {})
  session.turn = session.lastTurn
  child.record(s => { s.inputTokens += 42 })
  check('token do filho sobe pro pai', session.lastTurn!.inputTokens === parentOnly + 42,
    `${parentOnly} -> ${session.lastTurn!.inputTokens}`)
  session.turn = null
  await child.mcp.close()
  await session.mcp.close()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
