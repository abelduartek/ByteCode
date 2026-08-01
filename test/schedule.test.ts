// Como o loop agenda as tool calls de um mesmo step, e o corte global do Grep.
//
// Duas mudanças medidas em `docs/roadmap-performance.md`: subagents deixaram de
// rodar em fila (P1) e o Grep deixou de bufferizar a saída inteira do ripgrep
// para devolver 200 linhas (P3). As duas são silenciosas quando quebram — o
// resultado continua certo, só fica lento —, então valem teste próprio.

const { ROOT, SRC: R, scratch, mockProvider, useConfig, reporter } = await import('./helpers.ts')
const S = await scratch('schedule')
const { promises: fsp } = await import('node:fs')
const nodePath = await import('node:path')

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
const { Session } = await import(`${R}/core/session.ts`)
const { executeCalls } = await import(`${R}/core/loop.ts`)

const { config } = await loadConfig(ROOT)

/**
 * Uma tool falsa que registra quando entrou e quando saiu. A sobreposição das
 * janelas é a única evidência honesta de que rodaram juntas.
 */
type Window = { name: string; start: number; end: number }

function fakeSession(windows: Window[], overrides: Record<string, unknown> = {}): any {
  const session: any = new Session({
    config: { ...config, ...overrides },
    cwd: S,
    modelRef: config.model!,
  })
  session.emit = () => {}
  session.requestPermission = async () => true

  const make = (name: string, ms: number, extra: Record<string, unknown>) => ({
    name,
    kind: 'read',
    description: name,
    inputSchema: { type: 'object', properties: {} },
    ...extra,
    async execute() {
      const start = Date.now()
      await new Promise(r => setTimeout(r, ms))
      windows.push({ name, start, end: Date.now() })
      return { text: name }
    },
  })

  session.registry.register(make('FakeAgent', 60, { parallelGroup: 'agent' }))
  session.registry.register(make('FakeRead', 60, { parallelSafe: true }))
  session.registry.register(make('FakeWrite', 60, {}))
  return session
}

const call = (toolName: string, n: number) => ({
  toolCallId: `${toolName}-${n}`,
  toolName,
  input: {},
})

/** Maior número de janelas que se sobrepõem em algum instante. */
function maxOverlap(windows: Window[]): number {
  const edges = windows.flatMap(w => [{ at: w.start, d: 1 }, { at: w.end, d: -1 }])
  edges.sort((a, b) => a.at - b.at || a.d - b.d)
  let live = 0
  let peak = 0
  for (const e of edges) {
    live += e.d
    peak = Math.max(peak, live)
  }
  return peak
}

log('--- subagents do mesmo step rodam juntos ---')
{
  const windows: Window[] = []
  const session = fakeSession(windows)
  const calls = [call('FakeAgent', 1), call('FakeAgent', 2), call('FakeAgent', 3)]
  const started = Date.now()
  const results = await executeCalls(session, calls as never, 'p')
  const elapsed = Date.now() - started

  check('os tres rodaram sobrepostos', maxOverlap(windows) === 3, JSON.stringify(windows))
  check('custou uma janela, nao tres', elapsed < 150, `${elapsed}ms`)
  check(
    'a ordem do resultado segue a ordem da chamada',
    results.map((r: any) => r.toolCallId).join(',') === 'FakeAgent-1,FakeAgent-2,FakeAgent-3',
    JSON.stringify(results.map((r: any) => r.toolCallId)),
  )
  await session.mcp.close()
}

log('--- grupos diferentes nao se misturam ---')
{
  const windows: Window[] = []
  const session = fakeSession(windows)
  // Um Read emitido antes de um Agent tem de terminar antes: o subagente
  // escreve, e deixar os dois correrem juntos seria a corrida que o
  // `parallelSafe` existe para impedir.
  await executeCalls(session, [call('FakeRead', 1), call('FakeAgent', 1)] as never, 'p')
  check('read e agent nao se sobrepoem', maxOverlap(windows) === 1, JSON.stringify(windows))
  await session.mcp.close()
}

log('--- tool sem grupo continua sozinha ---')
{
  const windows: Window[] = []
  const session = fakeSession(windows)
  const calls = [call('FakeRead', 1), call('FakeRead', 2), call('FakeWrite', 1), call('FakeRead', 3)]
  await executeCalls(session, calls as never, 'p')

  const reads = windows.filter(w => w.name === 'FakeRead')
  check('os dois reads adjacentes se sobrepoem', maxOverlap(reads.slice(0, 2)) === 2, JSON.stringify(reads))
  check('o write ficou sozinho', maxOverlap(windows) === 2, JSON.stringify(windows))
  const write = windows.find(w => w.name === 'FakeWrite')!
  const last = reads.at(-1)!
  check('o read depois do write so comecou depois dele', last.start >= write.end - 5, JSON.stringify({ write, last }))
  await session.mcp.close()
}

log('--- subagentConcurrency limita ---')
{
  const windows: Window[] = []
  const session = fakeSession(windows, { subagentConcurrency: 1 })
  const calls = [call('FakeAgent', 1), call('FakeAgent', 2), call('FakeAgent', 3)]
  await executeCalls(session, calls as never, 'p')
  check('com teto 1 volta a ser fila', maxOverlap(windows) === 1, JSON.stringify(windows))
  await session.mcp.close()
}
{
  const windows: Window[] = []
  const session = fakeSession(windows, { subagentConcurrency: 2 })
  const calls = [call('FakeAgent', 1), call('FakeAgent', 2), call('FakeAgent', 3), call('FakeAgent', 4)]
  const results = await executeCalls(session, calls as never, 'p')
  check('com teto 2 nunca passa de dois', maxOverlap(windows) === 2, JSON.stringify(windows))
  check('e ainda assim devolve os quatro em ordem',
    results.map((r: any) => r.toolCallId).join(',') === 'FakeAgent-1,FakeAgent-2,FakeAgent-3,FakeAgent-4',
    JSON.stringify(results.map((r: any) => r.toolCallId)))
  await session.mcp.close()
}

log('--- a mesma leitura repetida para de rodar ---')
{
  // Visto numa sessão real: o mesmo `Grep` quatro vezes, mesmo `No matches`, três
  // minutos e meio. O harness não tinha memória do turno para notar.
  let execucoes = 0
  const session: any = new Session({ config, cwd: S, modelRef: config.model! })
  session.emit = () => {}
  session.requestPermission = async () => true
  session.registry.register({
    name: 'FakeGrep',
    kind: 'read',
    parallelSafe: true,
    description: 'x',
    inputSchema: { type: 'object', properties: {} },
    async execute(input: any) {
      execucoes++
      return { text: `No matches for ${input.pattern}` }
    },
  })
  session.registry.register({
    name: 'FakeBash',
    kind: 'exec',
    description: 'x',
    inputSchema: { type: 'object', properties: {} },
    async execute() {
      execucoes++
      return { text: 'ok' }
    },
  })

  const grep = (n: number) => ({ toolCallId: `g${n}`, toolName: 'FakeGrep', input: { pattern: '156501' } })
  const memoria = { calls: new Map() }

  const r1 = await executeCalls(session, [grep(1)] as never, 'p', memoria as never)
  const r2 = await executeCalls(session, [grep(2)] as never, 'p', memoria as never)
  check('as duas primeiras rodam', execucoes === 2, String(execucoes))
  check('e devolvem o resultado de verdade', r1[0].text.includes('No matches') && !r1[0].isError, r1[0].text)
  check('sem marcar erro na segunda', !r2[0].isError, r2[0].text)

  const r3 = await executeCalls(session, [grep(3)] as never, 'p', memoria as never)
  check('a terceira NÃO roda', execucoes === 2, String(execucoes))
  check('e avisa que está se repetindo', r3[0].text.includes('already ran'), r3[0].text.slice(0, 90))
  check('mostrando o que tinha voltado', r3[0].text.includes('No matches'), r3[0].text.slice(0, 200))
  check('e mandando mudar de abordagem', r3[0].text.includes('Change the approach'), r3[0].text.slice(-120))
  check('marcada como erro, para aparecer em vermelho', r3[0].isError === true, '')

  // Argumento diferente é chamada diferente.
  await executeCalls(
    session,
    [{ toolCallId: 'g9', toolName: 'FakeGrep', input: { pattern: 'outro' } }] as never,
    'p',
    memoria as never,
  )
  check('padrão diferente continua rodando', execucoes === 3, String(execucoes))

  // A ordem das chaves não pode mudar a identidade da chamada.
  const memoria2 = { calls: new Map() }
  const call = (id: string, input: any) => ({ toolCallId: id, toolName: 'FakeGrep', input })
  const antesOrdem = execucoes
  await executeCalls(session, [call('a', { pattern: 'x', path: 'src' })] as never, 'p', memoria2 as never)
  await executeCalls(session, [call('b', { path: 'src', pattern: 'x' })] as never, 'p', memoria2 as never)
  const bloqueada = await executeCalls(session, [call('c', { pattern: 'x', path: 'src' })] as never, 'p', memoria2 as never)
  check('chaves fora de ordem contam como a mesma chamada',
    execucoes - antesOrdem === 2 && bloqueada[0].isError === true, String(execucoes - antesOrdem))

  // Um comando pode ser repetido de propósito: polling, retry, esperar mudar.
  const memoria3 = { calls: new Map() }
  const antesBash = execucoes
  for (let i = 0; i < 4; i++) {
    await executeCalls(
      session,
      [{ toolCallId: `b${i}`, toolName: 'FakeBash', input: { command: 'git status' } }] as never,
      'p',
      memoria3 as never,
    )
  }
  check('exec repetido não é bloqueado', execucoes - antesBash === 4, String(execucoes - antesBash))

  // A memória é do turno: o turno seguinte começa limpo.
  const outroTurno = { calls: new Map() }
  const antesNovo = execucoes
  await executeCalls(session, [grep(4)] as never, 'p', outroTurno as never)
  check('turno novo pode repetir a busca', execucoes - antesNovo === 1, String(execucoes - antesNovo))

  await session.mcp.close()
}

log('--- Grep: corte global e linha longa ---')
{
  const session: any = new Session({ config, cwd: S, modelRef: config.model! })
  await session.init(() => {})
  const { registerTools } = await import(`${R}/tools/index.ts`)
  registerTools(session)
  session.emit = () => {}
  session.requestPermission = async () => true
  const ctx = { session, cwd: S, depth: 0 }
  const grep = session.registry.get('Grep')

  // Vinte arquivos com dez ocorrências cada: 200 no total, e o `-m` do ripgrep
  // é por arquivo, então sem corte global o limite de 5 devolveria 100 linhas.
  const dir = nodePath.join(S, 'muitos')
  await fsp.mkdir(dir, { recursive: true })
  for (let i = 0; i < 20; i++) {
    await fsp.writeFile(
      nodePath.join(dir, `f${i}.txt`),
      Array.from({ length: 10 }, (_, k) => `alvo ${i}-${k}`).join('\n'),
      'utf8',
    )
  }

  const out = await grep.execute({ pattern: 'alvo', path: 'muitos', head_limit: 5 }, ctx)
  const lines = out.text.split('\n').filter(Boolean)
  check('devolve exatamente o limite pedido', lines.length === 5, `${lines.length} linhas`)
  check('e sao linhas de match de verdade', lines.every((l: string) => l.includes('alvo')), out.text)

  const sem = await grep.execute({ pattern: 'nao-existe-em-lugar-nenhum', path: 'muitos' }, ctx)
  check('sem match continua dizendo que nao achou', sem.text === 'No matches.', sem.text)

  // Uma linha minificada: o resultado não pode carregar o arquivo inteiro.
  const longa = nodePath.join(S, 'min.js')
  await fsp.writeFile(longa, `var x=1;${'a'.repeat(50_000)}//marcador\n`, 'utf8')
  const corte = await grep.execute({ pattern: 'marcador', path: 'min.js' }, ctx)
  check('linha longa e truncada', corte.text.length < 500, `${corte.text.length} chars`)
  check('e diz quanto cortou', /\[\+\d+ chars\]/.test(corte.text), corte.text.slice(0, 120))

  await session.mcp.close()
}

done()
