const { ROOT, SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('tui')
useConfig({
  dataDir: `${S}/data`,
  model: 'fake/tiny',
  provider: {
    fake: {
      npm: '@ai-sdk/openai-compatible',
      options: { baseURL: 'https://example.invalid/v1' },
      models: { tiny: { id: 'tiny', limit: { context: 1000, output: 256 } } },
    },
  },
  compaction: { threshold: 0.5, keepRecentTurns: 2 },
  instructions: [],
  assets: { skills: ['./none'], agents: ['./none'], commands: ['./none'] },
})
process.env.COLORTERM = 'truecolor'
process.env.HX_FAKE_CLIPBOARD = '1'
// A config é mesclada do diretório do usuário para cima, então sem isso a suíte
// sobe os servidores MCP reais da máquina (e o relatório muda com a máquina).
process.env.BYTECODE_NO_MCP = '1'
delete process.env.NO_COLOR

const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g')
const strip = (s: string) => s.replace(ANSI, '')

// A TUI que desenha incrementalmente escreve so as linhas que mudaram, entao o
// probe reconstroi a tela a partir dos patches (mini emulador de terminal).
const screen: string[] = []
let bytes = 0
let writes = 0
const realWrite = process.stdout.write.bind(process.stdout)
;(process.stdout as any).write = (chunk: any) => {
  const s = String(chunk)
  bytes += s.length
  writes++
  if (s.includes('\x1b[2J')) screen.length = 0
  const re = /\x1b\[(\d+);1H/g
  const marks: { row: number; at: number; textAt: number }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(s))) marks.push({ row: Number(m[1]), at: m.index, textAt: m.index + m[0].length })
  for (let i = 0; i < marks.length; i++) {
    const end = i + 1 < marks.length ? marks[i + 1].at : s.length
    screen[marks[i].row - 1] = s.slice(marks[i].textAt, end)
  }
  return true
}
Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true })
Object.defineProperty(process.stdout, 'rows', { value: 34, configurable: true })
Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
;(process.stdin as any).setRawMode = () => process.stdin
;(process.stdin as any).isTTY = true

const log = (...a: unknown[]) => realWrite(a.join(' ') + '\n')
let pass = 0
let fail = 0
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; log(`  ok   ${name}`) } else { fail++; log(`  FAIL ${name} ${detail}`) }
}

const cwd = ROOT
const { config } = await loadConfig(cwd)

// Duas sessoes salvas antes de subir a TUI, para a tela inicial ter o que listar.
// dataDir isolado: o teste nunca le nem escreve o historico real.
const { promises: fsp } = await import('node:fs')
const DATA = config.dataDir as string
await fsp.rm(DATA, { recursive: true, force: true })
const sessionsApi = await import(`${R}/core/sessions.ts`)
const OLD_ID = 'aaaaaaaa-1111-4111-8111-111111111111'
const NEW_ID = 'bbbbbbbb-2222-4222-8222-222222222222'
await sessionsApi.saveSessionState(config, {
  id: OLD_ID,
  cwd,
  modelRef: 'fake/tiny',
  messages: [
    { role: 'user', content: 'conversa antiga sobre retry' },
    { role: 'assistant', content: 'resposta antiga' },
  ] as never,
})
await new Promise(r => setTimeout(r, 30))
await sessionsApi.saveSessionState(config, {
  id: NEW_ID,
  cwd,
  modelRef: 'fake/tiny',
  messages: [
    { role: 'user', content: 'conversa nova sobre selecao' },
    { role: 'assistant', content: 'resposta nova' },
    { role: 'user', content: 'segundo turno' },
    { role: 'assistant', content: 'segunda resposta' },
  ] as never,
})

const session = new Session({ config, cwd, modelRef: config.model })
await session.init(() => {})
registerTools(session)

const theme = await import(`${R}/tui/theme.ts`)
theme.applyTheme(config.theme)

const { runFullscreenTui } = await import(`${R}/tui/fullscreen.ts`)

const tick = (ms = 160) => new Promise(r => setTimeout(r, ms))
const waitFor = async (fn: () => boolean, ms = 15000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (fn()) return true
    await tick(200)
  }
  return false
}
const key = (s: string) => process.stdin.emit('data', Buffer.from(s, 'utf8'))
const rawFrame = () => screen.map(l => l ?? '').join('\n')
const lines = () => screen.map(l => strip(l ?? ''))
const has = (needle: string) => lines().some(l => l.includes(needle))
const composerIdle = () => lines().some(l => l.includes('❯') && l.includes('pergunte, cole'))

const running = runFullscreenTui(session)
await tick(400)

log('--- tela inicial: janela de sessões à direita ---')
{
  check('janela desenhada com título', lines().some(l => l.includes('sessões') && l.includes('╭')), '')
  check('convida a buscar com ctrl+f', has('ctrl+f busca'), '')
  check('rodapé da janela', has('↑↓ navega · enter abre'), '')
  check('mostra o id curto', has(`#${NEW_ID.slice(0, 8)}`), '')
  check('mostra quando foi usada', has('agora') || has('há'), '')
  check('nada preselecionado por padrão', !rawFrame().includes('48;5;237'), '')

  // A janela fica na direita, o conteúdo à esquerda, na mesma linha.
  const panelRow = lines().find(l => l.includes(`#${NEW_ID.slice(0, 8)}`)) ?? ''
  const idCol = panelRow.indexOf(`#${NEW_ID.slice(0, 8)}`)
  check('painel está na metade direita', idCol > 60, `coluna ${idCol} de ${panelRow.length}`)
  check('coluna da esquerda tem o conteúdo', has('skills') && has('agents'), '')
  check('conteúdo da esquerda vem antes do painel',
    (lines().find(l => l.includes('skills')) ?? '').indexOf('skills') < idCol, '')

  // compact/assets logo abaixo do wordmark, não flutuando no meio da tela
  const compactRow = lines().findIndex(l => l.includes('compact'))
  check('info de compact fica perto do topo', compactRow >= 3 && compactRow <= 8,
    `linha ${compactRow} de ${lines().length}`)
  check('assets vem junto', Math.abs(lines().findIndex(l => l.includes('skills')) - compactRow) <= 2, '')

  // o painel é largo o bastante para não cortar título nem data
  const panelWidth = panelRow.length - idCol
  check('painel largo (>= 44 colunas)', panelWidth >= 44, `${panelWidth} colunas`)
  check('data não fica truncada', !lines().some(l => /h[áa] \d+ m…/.test(l)),
    JSON.stringify(lines().filter(l => l.includes('…')).slice(0, 2)))

  // ↑↓ navega
  key(`${ESC}[B`)
  await tick(160)
  check('seta destaca uma linha', rawFrame().includes('48;5;237'), '')
  const firstPick = lines().find(l => l.includes(`#${NEW_ID.slice(0, 8)}`)) ?? ''
  check('a primeira destacada é a mais recente', firstPick.includes('❯'), JSON.stringify(firstPick.slice(-40)))

  key(`${ESC}[B`)
  await tick(160)
  const second = lines().find(l => l.includes(`#${OLD_ID.slice(0, 8)}`)) ?? ''
  check('desce para a próxima', second.includes('❯'), JSON.stringify(second.slice(-40)))

  key(ESC)
  await tick(160)
  check('esc desmarca tudo', !rawFrame().includes('48;5;237'), '')
}

log('--- busca é campo próprio, não o composer ---')
{
  // `lastBox` global só existe mais abaixo no arquivo; helper local aqui.
  const boxAt = (rows: string[]) => rows.reduce((acc, l, i) => (l.includes('╭') ? i : acc), -1)
  const composerText = () => lines()[boxAt(lines()) + 1] ?? ''
  const lastBox = boxAt
  // Digitar sem ctrl+f vai SÓ para o composer — o bug era aparecer nos dois.
  key('teste')
  await tick(220)
  check('composer recebeu o texto', (lastBox(lines()) >= 0 ? lines()[lastBox(lines()) + 1] : '').includes('teste'),
    JSON.stringify(lines()[lastBox(lines()) + 1]?.trim().slice(0, 30)))
  check('painel NÃO ecoa o que foi digitado', has('ctrl+f busca'), '')
  check('painel não filtrou nada', has('11 salvas') || has('2 salvas'),
    JSON.stringify(lines().find(l => l.includes('salvas'))))
  // O cursor pisca, então o invariante é "nunca dois", não "sempre um".
  check('nunca dois cursores na tela', (rawFrame().match(/▉/g) ?? []).length <= 1,
    String((rawFrame().match(/▉/g) ?? []).length))
  for (let i = 0; i < 5; i++) key('\x7f')
  await tick(180)

  // ctrl+f abre a busca; o composer para de receber
  key('\x06')
  await tick(200)
  check('ctrl+f abre a busca', has('buscando sessões'), '')
  key('antiga')
  await tick(220)
  check('texto foi para a busca', has('1 de 2'), JSON.stringify(lines().find(l => l.includes(' de '))))
  check('mantém quem casa', has(`#${OLD_ID.slice(0, 8)}`), '')
  check('esconde quem não casa', !has(`#${NEW_ID.slice(0, 8)}`), '')
  check('composer segue vazio', !(lines()[lastBox(lines()) + 1] ?? '').includes('antiga'),
    JSON.stringify(lines()[lastBox(lines()) + 1]?.trim().slice(0, 40)))
  check('nunca dois cursores durante a busca', (rawFrame().match(/▉/g) ?? []).length <= 1,
    String((rawFrame().match(/▉/g) ?? []).length))

  key(`${ESC}[B`)
  await tick(180)
  const only = lines().find(l => l.includes(`#${OLD_ID.slice(0, 8)}`)) ?? ''
  check('seta navega dentro do filtro', only.includes('❯'), JSON.stringify(only.slice(-40)))

  key('x')
  await tick(180)
  check('filtro sem resultado avisa', has('nenhuma sessão casa'), '')
  for (let i = 0; i < 7; i++) key('\x7f')
  await tick(200)
  check('apagar traz todas de volta', has(`#${NEW_ID.slice(0, 8)}`) && has(`#${OLD_ID.slice(0, 8)}`), '')

  // esc sai da busca e devolve o teclado ao composer
  key(ESC)
  await tick(200)
  check('esc fecha a busca', has('ctrl+f busca'), '')
  key('depois')
  await tick(200)
  check('depois do esc o texto volta pro composer',
    (lines()[lastBox(lines()) + 1] ?? '').includes('depois'),
    JSON.stringify(lines()[lastBox(lines()) + 1]?.trim().slice(0, 30)))
  check('painel não recebeu', !has('1 de 2'), '')
  for (let i = 0; i < 6; i++) key('\x7f')
  await tick(180)
}

// Retomar apaga o transcript inteiro (splash incluído), então os testes que
// abrem sessão rodam no fim, depois das asserções de layout inicial.
const laterSessionTests = async () => {
log('--- retomar pelo enter ---')
{
  key('/sessions\r')
  await waitFor(() => has('ctrl+f busca'), 6000)
  key(`${ESC}[B`)
  await tick(160)
  key('\r')
  await waitFor(() => has('sessão retomada'), 6000)
  check('divisor de sessão retomada', has('sessão retomada'), '')
  check('histórico da sessão aparece', has('conversa nova sobre selecao'), '')
  check('resposta anterior aparece', has('resposta nova'), '')
  check('id da sessão retomada no divisor', has(NEW_ID.slice(0, 8)), '')
  check('a lista sai da tela', !has('ctrl+f busca'), '')
  check('transcript passou a ser o da sessão retomada',
    session.transcript.sessionId === NEW_ID, session.transcript.sessionId)
  check('mensagens restauradas na sessão', session.messages.length === 4, String(session.messages.length))
  check('status avisa que o modo não muda', has('modo de permissão continua'), '')
}

log('--- /sessions traz a lista de volta ---')
{
  key('/sessions\r')
  await waitFor(() => has('ctrl+f busca'), 6000)
  check('/sessions relista', has('ctrl+f busca'), '')
  check('/sessions já destaca a primeira', rawFrame().includes('48;5;237'), '')

  // clicar numa linha de sessão abre ela
  const rowIdx = lines().findIndex(l => l.includes(`#${OLD_ID.slice(0, 8)}`))
  check('linha da sessão antiga na tela', rowIdx >= 0, String(rowIdx))
  key(`${ESC}[<0;12;${rowIdx + 1}M`)
  await tick(120)
  key(`${ESC}[<0;12;${rowIdx + 1}m`)
  await waitFor(() => session.transcript.sessionId === OLD_ID, 6000)
  check('clique abriu a sessão clicada', session.transcript.sessionId === OLD_ID, session.transcript.sessionId)
  check('histórico da antiga carregado', has('conversa antiga sobre retry'), '')
  check('mensagens da antiga', session.messages.length === 2, String(session.messages.length))
}

log('--- /resume por id ---')
{
  key(`/resume ${NEW_ID.slice(0, 8)}\r`)
  await waitFor(() => session.transcript.sessionId === NEW_ID, 6000)
  check('/resume por prefixo funciona', session.transcript.sessionId === NEW_ID, session.transcript.sessionId)

  key('/resume zzzzzzzz\r')
  await waitFor(() => has('não encontrada'), 6000)
  check('id inexistente vira erro visível', has('não encontrada'), '')
}

log('--- strip de subagents: ABAIXO do input ---')
{
  const composerRowBefore = lastBox(lines())

  session.emit({ type: 'agent-start', id: 'a1', agentType: 'code-reviewer', label: 'revisar o loop' })
  session.emit({ type: 'agent-start', id: 'a2', agentType: 'test-engineer', label: 'cobrir o retry' })
  await tick(200)

  check('strip aparece', has('subagents'), '')
  check('conta quantos rodam', has('2 rodando'), '')
  check('mostra o tipo do agente', has('code-reviewer') && has('test-engineer'), '')
  check('mostra o label', has('revisar o loop'), '')
  check('ensina o atalho', has('ctrl+a foca'), '')

  const stripRow = lines().findIndex(l => l.includes('subagents'))
  const composerRow = lastBox(lines())
  check('strip fica ABAIXO do composer', stripRow > composerRow, `composer=${composerRow} strip=${stripRow}`)
  check('composer não desceu ao surgir o strip', composerRow <= composerRowBefore,
    `${composerRowBefore} -> ${composerRow}`)
  // "ctx" também aparece no header, então vale o ÚLTIMO match.
  const statusRow = lines().reduce((acc, l, i) => (l.includes('ctx') ? i : acc), -1)
  check('status bar continua sendo a última linha', statusRow > stripRow,
    `strip=${stripRow} status=${statusRow}`)

  // A tool do filho alimenta o strip e a sessão dele, nunca o transcript do pai
  session.emit({ type: 'agent-event', id: 'a1', event: { type: 'tool-start', id: 't1', name: 'Grep', summary: 'grep foo' } })
  await tick(200)
  check('mostra a tool corrente do filho', has('Grep'), '')
  check('tool do filho não virou bloco do transcript',
    !lines().some(l => l.includes('grep foo') && l.includes('ctrl+r')), '')

  // teto de linhas
  for (let i = 3; i <= 8; i++) {
    session.emit({ type: 'agent-start', id: `a${i}`, agentType: `agente${i}`, label: `tarefa ${i}` })
  }
  await tick(220)
  check('conta os 8', has('8 rodando'), '')
  check('avisa quantos não couberam', has('+3'), '')
  const rowsShown = lines().filter(l => /agente\d|code-reviewer|test-engineer/.test(l)).length
  check('no máximo 5 linhas de agente', rowsShown <= 5, String(rowsShown))
}

log('--- clicar na linha do subagent abre a sessão dele ---')
{
  // A faixa é o único lugar onde um agente que ainda está RODANDO pode ser
  // alcançado com o mouse: o bloco clicável do transcript só existe depois que
  // ele termina.
  session.emit({ type: 'agent-event', id: 'a2', event: { type: 'text', text: 'AQUI FALA O TEST-ENGINEER' } })
  await tick(200)

  const linha = lines().findIndex((l: string) => l.includes('test-engineer'))
  check('linha do subagent localizada', linha >= 0, String(linha))
  key(`${ESC}[<0;12;${linha + 1}M`)
  await tick(120)
  key(`${ESC}[<0;12;${linha + 1}m`)
  await tick(260)

  check('abriu a sessão do agente clicado', has('AQUI FALA O TEST-ENGINEER'),
    JSON.stringify(lines().slice(0, 8)))
  check('e o cabeçalho é o do agente certo',
    lines().some((l: string) => l.includes('test-engineer') && l.includes('esc volta')),
    JSON.stringify(lines().slice(0, 4)))

  key(ESC)
  await tick(220)
  check('esc volta para a sessão principal', !has('AQUI FALA O TEST-ENGINEER'), '')
}

log('--- dobra também dentro do subagent ---')
{
  for (let i = 0; i < 6; i++) {
    session.emit({ type: 'agent-event', id: 'a2', event: { type: 'tool-start', id: `s${i}`, name: 'LS', summary: `ls d${i}`, subject: `dir-${i}` } })
    session.emit({ type: 'agent-event', id: 'a2', event: { type: 'tool-end', id: `s${i}`, name: 'LS', ok: true, preview: 'vazio' } })
  }
  await tick(260)

  const linha = lines().findIndex((l: string) => l.includes('test-engineer'))
  key(`${ESC}[<0;12;${linha + 1}M`)
  await tick(120)
  key(`${ESC}[<0;12;${linha + 1}m`)
  await tick(300)

  check('a sessão do agente dobra a sequência', has('6 chamadas'), JSON.stringify(lines().slice(0, 12)))
  check('mantendo o assunto da última', has('dir-5'), JSON.stringify(lines().slice(0, 12)))
  check('e sem listar as do meio', !has('dir-2'), JSON.stringify(lines().slice(0, 12)))

  key(ESC)
  await tick(220)
}

log('--- atalhos: focar, abrir e voltar do subagent ---')
{
  // conteúdo na sessão do filho a1
  session.emit({ type: 'agent-event', id: 'a1', event: { type: 'tool-end', id: 't1', name: 'Grep', ok: true, preview: 'src/a.ts:1:foo' } })
  session.emit({ type: 'agent-event', id: 'a1', event: { type: 'text', text: 'RELATORIO DO FILHO' } })
  await tick(200)
  check('texto do filho não aparece na sessão principal', !has('RELATORIO DO FILHO'), '')

  key('\x01') // ctrl+a
  await tick(200)
  check('ctrl+a foca o primeiro subagent', has('subagent 1/8'), '')
  check('linha focada com destaque', rawFrame().includes('48;5;237'), '')

  key('\x01')
  await tick(180)
  check('ctrl+a anda para o próximo', has('subagent 2/8'), '')

  key(`${ESC}[A`)
  await tick(180)
  check('seta volta para o anterior', has('subagent 2/8') || rawFrame().includes('48;5;237'), '')

  // volta o foco para a1 e abre
  while (!has('subagent 1/8')) { key('\x01'); await tick(120) }
  key('\r')
  await waitFor(() => has('RELATORIO DO FILHO'), 4000)
  check('enter abre a sessão do subagent', has('RELATORIO DO FILHO'), '')
  check('cabeçalho da sessão do filho', has('code-reviewer') && has('rodando'), '')
  check('tool do filho aparece na sessão dele', has('grep foo'), '')
  check('avisa como voltar', has('esc volta'), '')
  check('transcript principal fica escondido', !has('sessão retomada'), '')

  key(ESC)
  await tick(220)
  check('esc volta para a sessão principal', has('de volta na sessão principal'), '')
  check('conteúdo do filho saiu da tela', !has('RELATORIO DO FILHO'), '')

  // ctrl+a de dentro do viewer também volta
  while (!has('subagent 1/8')) { key('\x01'); await tick(120) }
  key('\r')
  await waitFor(() => has('RELATORIO DO FILHO'), 4000)
  key('\x01')
  await tick(220)
  check('ctrl+a de dentro do viewer volta', !has('RELATORIO DO FILHO'), '')
}

log('--- rodando fica só no strip, terminado vai pro transcript ---')
{
  // Enquanto roda, NÃO existe linha de Agent no transcript: a faixa já mostra.
  session.emit({ type: 'tool-start', id: 'a1', name: 'Agent', summary: 'revisar o loop', subject: 'code-reviewer' })
  await tick(200)
  const agentLinesRunning = lines().filter(l => l.includes('Agent('))
  check('rodando não cria linha no transcript', agentLinesRunning.length === 0, JSON.stringify(agentLinesRunning))
  check('mas continua na faixa', has('code-reviewer') && has('subagents'), '')

  session.emit({ type: 'agent-end', id: 'a1', ok: true, chars: 100 })
  await tick(200)
  check('saiu da faixa ao terminar', !(lines().find(l => l.includes('subagents')) ?? '').includes('8 rodando'), '')
  check('faixa conta só quem roda', has('7 rodando'), '')

  session.emit({ type: 'tool-end', id: 'a1', name: 'Agent', ok: true, preview: 'RELATORIO DO FILHO' })
  await tick(220)
  check('terminado aparece no transcript', lines().some(l => l.includes('Agent(code-reviewer)')),
    JSON.stringify(lines().filter(l => l.includes('Agent(')).slice(0, 2)))
  check('convida a clicar', has('clique para abrir a sessão'), '')

  // clicar na linha abre a sessão do subagent (não expande preview)
  const agentRow = lines().findIndex(l => l.includes('Agent(code-reviewer)'))
  key(`${ESC}[<0;12;${agentRow + 1}M`)
  await tick(120)
  key(`${ESC}[<0;12;${agentRow + 1}m`)
  await waitFor(() => has('RELATORIO DO FILHO') && has('esc volta'), 5000)
  check('clique abriu a sessão do subagent', has('esc volta'), '')
  check('mostra o que o filho fez', has('grep foo') || has('RELATORIO DO FILHO'), '')
  key(ESC)
  await tick(220)

  for (let i = 2; i <= 8; i++) {
    session.emit({ type: 'agent-end', id: `a${i}`, ok: true, chars: 10 })
  }
  await tick(220)
  check('faixa desaparece quando nada roda', !has('subagents'), '')
  check('linha do terminado permanece', lines().some(l => l.includes('Agent(code-reviewer)')), '')

  // sobrevive ao fim do turno: ainda clicável
  session.emit({ type: 'turn-end' })
  await tick(220)
  check('turn-end não apaga a linha do agente', lines().some(l => l.includes('Agent(code-reviewer)')), '')
  const rowAfter = lines().findIndex(l => l.includes('Agent(code-reviewer)'))
  key(`${ESC}[<0;12;${rowAfter + 1}M`)
  await tick(120)
  key(`${ESC}[<0;12;${rowAfter + 1}m`)
  await waitFor(() => has('esc volta'), 5000)
  check('ainda abre depois do turno terminar', has('esc volta'), '')
  key(ESC)
  await tick(200)
}

log('--- layout de tool: ● Name(subject) + └ detalhe ---')
{
  session.emit({ type: 'tool-start', id: 'x1', name: 'Bash', summary: 'ver status', subject: 'git status' })
  await tick(180)
  const running = lines().find(l => l.includes('git status')) ?? ''
  check('rodando usa spinner, não bolinha', !running.includes('●'), JSON.stringify(running.trim().slice(0, 40)))
  check('formato Name(subject)', running.includes('Bash(git status)'), JSON.stringify(running.trim().slice(0, 40)))

  session.emit({ type: 'tool-end', id: 'x1', name: 'Bash', ok: true, preview: 'clean' })
  await tick(200)
  const okRow = lines().find(l => l.includes('Bash(git status)')) ?? ''
  check('bolinha substitui o check no início', okRow.trimStart().startsWith('●'),
    JSON.stringify(okRow.trim().slice(0, 40)))
  check('não sobrou ✔', !okRow.includes('✔'), JSON.stringify(okRow.trim().slice(0, 40)))
  check('só uma bolinha na linha', (okRow.match(/●/g) ?? []).length === 1, JSON.stringify(okRow.trim().slice(0, 40)))
  {
    // A linha crua tem ANSI entre "Bash" e "(git status)", então busca só o subject.
    const raw = screen.find(l => (l ?? '').includes('git status') && (l ?? '').includes('●')) ?? ''
    const dotAt = raw.indexOf('●')
    check('bolinha é verde (ok=108)', raw.slice(Math.max(0, dotAt - 20), dotAt).includes('38;5;108'),
      JSON.stringify(raw.slice(Math.max(0, dotAt - 24), dotAt + 2)))
  }

  session.emit({ type: 'tool-start', id: 'x2', name: 'Bash', summary: 'ruim', subject: 'comando ruim' })
  session.emit({ type: 'tool-end', id: 'x2', name: 'Bash', ok: false, preview: 'boom' })
  await tick(200)
  {
    const raw = screen.find(l => (l ?? '').includes('comando ruim')) ?? ''
    const dotAt = raw.indexOf('●')
    check('falha usa bolinha vermelha (167)', dotAt >= 0 && raw.slice(Math.max(0, dotAt - 20), dotAt).includes('38;5;167'),
      JSON.stringify(raw.slice(Math.max(0, dotAt - 24), dotAt + 2)))
  }
}

log('--- diff numerado com faixa colorida ---')
{
  const diff = [
    'Added 2 lines, removed 1 line',
    '    83     endLine()',
    '    84     write(algo)',
    '    86 -   case antigo:',
    '    86 +   // comentario novo',
    '    87 +   case novo:',
    '    89     break',
  ].join('\n')

  session.emit({ type: 'tool-start', id: 'e1', name: 'Edit', summary: 'edit x', subject: 'src\\tui\\app.ts' })
  session.emit({ type: 'tool-end', id: 'e1', name: 'Edit', ok: true, preview: diff })
  await tick(220)

  const head = lines().find(l => l.includes('Edit(src\\tui\\app.ts)')) ?? ''
  check('chamada mostra o arquivo', head.length > 0, JSON.stringify(head.trim().slice(0, 40)))
  check('detalhe vem do resumo do diff', has('Added 2 lines, removed 1 line'), '')
  check('detalhe fica na linha do └', lines().some(l => l.includes('└') && l.includes('Added 2 lines')),
    JSON.stringify(lines().filter(l => l.includes('└')).slice(0, 2)))
  check('diff colapsado por padrão', !has('comentario novo'), '')

  key('\x12') // ctrl+r
  await tick(220)
  check('ctrl+r abre o diff', has('comentario novo'), '')
  check('mostra número de linha', lines().some(l => /\b86 \+/.test(l)), '')
  {
    const added = screen.find(l => (l ?? '').includes('comentario novo')) ?? ''
    const removed = screen.find(l => (l ?? '').includes('case antigo')) ?? ''
    // Pastel claro com texto escuro, como uma ferramenta de review — 24 bits
    // quando o terminal aceita, senao os pasteis do cubo 256.
    check('linha adicionada com banda verde clara',
      /48;2;230;255;236m|48;5;194m/.test(added), JSON.stringify(added.slice(0, 70)))
    check('linha removida com banda vermelha clara',
      /48;2;255;235;233m|48;5;224m/.test(removed), JSON.stringify(removed.slice(0, 70)))
    check('texto dentro da banda fica escuro',
      /38;2;36;41;47m|38;5;235m/.test(added), JSON.stringify(added.slice(0, 90)))
    // A faixa é preenchida com espaços até a largura: o fundo cobre a linha toda
    // mesmo com o texto curto.
    check('faixa cobre a largura toda', strip(added).length > 100, String(strip(added).length))
  }
  key('\x12')
  await tick(200)
  check('ctrl+r fecha de novo', !has('comentario novo'), '')
}

log('--- expandir a tool que eu escolher ---')
{
  // três tools com preview distinto, para saber qual expandiu
  for (const [i, name] of ['ALFA', 'BETA', 'GAMA'].entries()) {
    session.emit({ type: 'tool-start', id: `p${i}`, name: 'Read', summary: `s${i}`, subject: `arq-${name}.ts` })
    session.emit({
      type: 'tool-end',
      id: `p${i}`,
      name: 'Read',
      ok: true,
      preview: `corpo-${name}\nsegunda linha ${name}`,
    })
  }
  await tick(250)
  check('as três aparecem', has('arq-ALFA.ts') && has('arq-BETA.ts') && has('arq-GAMA.ts'), '')
  check('nenhuma expandida', !has('corpo-ALFA') && !has('corpo-BETA') && !has('corpo-GAMA'), '')

  // ctrl+r sem foco continua pegando a última
  key('\x12')
  await tick(220)
  check('ctrl+r sem foco pega a última', has('corpo-GAMA') && !has('corpo-ALFA'), '')
  key('\x12')
  await tick(200)

  // clicar na linha da PRIMEIRA expande aquela, não a última
  const alfaRow = lines().findIndex(l => l.includes('arq-ALFA.ts'))
  check('linha da ALFA localizada', alfaRow >= 0, String(alfaRow))
  key(`${ESC}[<0;10;${alfaRow + 1}M`)
  await tick(120)
  key(`${ESC}[<0;10;${alfaRow + 1}m`)
  await tick(250)
  check('clique expandiu a clicada', has('corpo-ALFA'), '')
  check('clique não expandiu a última', !has('corpo-GAMA'), '')
  check('marcador de foco na linha clicada',
    (lines().find(l => l.includes('arq-ALFA.ts')) ?? '').trimStart().startsWith('❯'),
    JSON.stringify((lines().find(l => l.includes('arq-ALFA.ts')) ?? '').trim().slice(0, 30)))

  // clicar de novo colapsa
  const alfaRow2 = lines().findIndex(l => l.includes('arq-ALFA.ts'))
  key(`${ESC}[<0;10;${alfaRow2 + 1}M`)
  await tick(120)
  key(`${ESC}[<0;10;${alfaRow2 + 1}m`)
  await tick(250)
  check('clicar de novo colapsa', !has('corpo-ALFA'), '')

  // ctrl+r agora age na focada, não na última
  key('\x12')
  await tick(220)
  check('ctrl+r segue a focada', has('corpo-ALFA') && !has('corpo-GAMA'), '')
  key('\x12')
  await tick(200)

  // alt+↓ move o foco sem mouse
  key(`${ESC}[1;3B`)
  await tick(200)
  check('alt+↓ move o foco', (lines().find(l => l.includes('arq-BETA.ts')) ?? '').trimStart().startsWith('❯'),
    JSON.stringify((lines().find(l => l.includes('arq-BETA.ts')) ?? '').trim().slice(0, 30)))
  key('\x12')
  await tick(220)
  check('ctrl+r expande a que o alt+↓ escolheu', has('corpo-BETA') && !has('corpo-ALFA'), '')
  key('\x12')
  await tick(200)

  key(`${ESC}[1;3A`)
  await tick(200)
  check('alt+↑ volta', (lines().find(l => l.includes('arq-ALFA.ts')) ?? '').trimStart().startsWith('❯'), '')

  // clique fora de tool não faz nada
  const clipApi = await import(`${R}/util/clipboard.ts`)
  const before = clipApi.lastClipboardWrite()
  const emptyRow = lines().findIndex((l, i) => i > 6 && l.trim() === '')
  if (emptyRow > 0) {
    key(`${ESC}[<0;10;${emptyRow + 1}M`)
    await tick(120)
    key(`${ESC}[<0;10;${emptyRow + 1}m`)
    await tick(200)
    check('clique em linha vazia não copia nem expande', clipApi.lastClipboardWrite() === before, '')
  }
}
}

log('--- 10 · spec: cores e layout ---')
check('256-color foreground em uso (38;5;)', rawFrame().includes('38;5;'), '')
check('accent default NAO e o terracota do claude (173)', !rawFrame().includes('38;5;173'), '')
check('accent violeta 141 em uso', rawFrame().includes('38;5;141'), '')
check('preset terracotta ainda disponivel', theme.PRESETS.terracotta.accent === 173, '')
check('info 109 presente', rawFrame().includes('38;5;109'), '')
check('barra com background 236', rawFrame().includes('48;5;236'), '')
let L = lines()
check('ocupa a largura toda por padrao', L[0].length >= 138, `header tem ${L[0].length} de 140`)
check('sem indentacao no header', !/^\s{3}/.test(L[0]), JSON.stringify(L[0].slice(0, 10)))
check('nenhuma linha estoura a largura', L.every(l => l.length <= 140), String(Math.max(...L.map(l => l.length))))
// A tela inicial desenha a janela de sessoes tambem com borda, entao o composer
// e sempre a ULTIMA caixa do quadro.
const lastBox = (rows: string[]) => rows.reduce((acc, l, i) => (l.includes('╭') ? i : acc), -1)
{
  const composerRow = lastBox(L)
  check('composer atravessa a tela', L[composerRow].trim().length >= 138, `${L[composerRow].trim().length}`)
}

log('--- layout: conteudo ancorado no topo quando cabe ---')
{
  const body = L.slice(3)
  check('duas linhas em branco separam header e conteudo',
    body[0].trim() === '' && body[1].trim() === '' && body[2].trim() !== '',
    JSON.stringify(body.slice(0, 3).map(l => l.slice(0, 20))))
  const firstContent = body.findIndex(l => l.trim().length > 0)
  check('sem lacuna grande acima do conteudo', firstContent <= 4, `primeira linha com conteudo: ${firstContent}`)
  const composerTop = lastBox(body)
  const lastContent = body.reduce((acc, l, i) => (l.trim() && i < composerTop ? i : acc), 0)
  check('espaco entre o ultimo bloco e o composer', composerTop - lastContent >= 2, `${lastContent} -> ${composerTop}`)
}

log('--- /width ---')
{
  key('/width 120\r')
  await tick(250)
  const c1 = lines()
  const composer1 = [...c1].reverse().find(l => l.includes('╭')) ?? ''
  check('/width 120 centraliza', /^ {10,12}\S/.test(composer1), JSON.stringify(composer1.slice(0, 14)))
  check('/width 120 estreita a caixa', composer1.trim().length === 118, String(composer1.trim().length))
  check('avisa como fixar na config', has('maxWidth'), '')

  key('/width full\r')
  await tick(250)
  const c2 = lines()
  const composer2 = [...c2].reverse().find(l => l.includes('╭')) ?? ''
  check('/width full volta a tela cheia', composer2.trim().length >= 138, String(composer2.trim().length))
  check('sem sobra da coluna estreita', c2[0].length >= 138, String(c2[0].length))

  key('/width abc\r')
  await tick(220)
  check('largura invalida vira erro', has('largura inválida'), '')
  key('/width full\r')
  await tick(220)
}

log('--- header fixo (wordmark) ---')
{
  const head = lines().slice(0, 3)
  check('duas linhas em branco entre header e conteudo',
    lines()[3].trim() === '' && lines()[4].trim() === '',
    JSON.stringify([lines()[3]?.slice(0, 20), lines()[4]?.slice(0, 20)]))
  check('primeiro bloco vem depois do respiro', lines()[5].trim().length > 0, JSON.stringify(lines()[5]?.slice(0, 30)))
  check('wordmark nas 3 primeiras linhas', head.every(l => l.includes('█')), JSON.stringify(head[0]?.slice(0, 20)))
  // O header não tem mais fundo: com background, cada RESET interno cortava a
  // barra e sobrava uma mancha cinza só atrás do logo.
  check('header sem background', screen.slice(0, 3).every(l => !(l ?? '').includes('48;5;236')),
    JSON.stringify((screen[0] ?? '').slice(0, 30)))
  {
    const statusRaw = screen.reduce((acc, l) => ((l ?? '').includes('ctx') ? l ?? '' : acc), '')
    check('status bar mantém o fundo', statusRaw.includes('48;5;236'), JSON.stringify(statusRaw.slice(0, 30)))
    // A barra reabre o fundo depois de cada reset, então não fica meio pintada.
    const resets = (statusRaw.match(/\x1b\[0m/g) ?? []).length
    const opens = (statusRaw.match(/48;5;236/g) ?? []).length
    check('fundo reaberto após cada reset', opens >= resets, `${opens} aberturas, ${resets} resets`)
  }
  check('wordmark soletra BYTECODE', head[0].includes('█▀▄ █ █ ▀█▀ █▀▀'), JSON.stringify(head[0]?.slice(0, 40)))
  check('modelo no header', head.join(' ').includes('fake/tiny'), '')
  check('cwd no header', head.join(' ').includes('harness'), '')
}

log('--- 01 · splash ---')
check('linha assets', has('assets') && has('skills') && has('agents'), '')
check('linha compact', has('compact'), '')
check('dica de teclas', has('shift+tab'), '')
check('splash nao repete o wordmark', lines().slice(3).every(l => !l.includes('█')), '')

log('--- box-drawing (nao ASCII) ---')
check('canto ╭', has('╭'), '')
check('canto ╯', has('╯'), '')
check('vertical │', has('│'), '')
check('sem + - | do ASCII antigo', !L.some(l => l.includes('+---')), '')

log('--- composer ---')
check('prompt ❯', has('❯'), '')
check('placeholder', has('pergunte, cole um erro'), '')

log('--- status bar ---')
check('modo ask', has('ask'), '')
check('ctx', has('ctx'), '')
check('atalho ao lado do modo', has('shift+tab ') && has('ask'), JSON.stringify(lines().at(-1)?.slice(0, 60)))
check('atalho ao lado do agente', has('tab ') && has('build'), JSON.stringify(lines().at(-1)?.slice(0, 60)))
check('separador ▏', has('▏'), '')

log('--- paste com quebra de linha + multilinha ---')
{
  const paste = 'linha um\nlinha dois\nlinha tres'
  key(`${ESC}[200~${paste}${ESC}[201~`)
  await tick(200)
  check('paste nao envia sozinho', !has('▌ linha um'), '')
  check('composer mostra a 1a linha', has('linha um'), '')
  check('composer mostra a 3a linha', has('linha tres'), '')
  check('composer avisa quantas linhas', has('3 linhas'), '')
  check('composer ensina o atalho', has('alt+enter quebra'), '')

  // alt+enter insere quebra sem enviar
  key(`${ESC}\r`)
  await tick(150)
  check('alt+enter quebra sem enviar', has('4 linhas'), '')
  // ctrl+J tambem
  key('\n')
  await tick(150)
  check('ctrl+j tambem quebra', has('5 linhas'), '')

  key('\r')
  await tick(400)
  check('enter envia o bloco inteiro', has('▌ linha um'), '')
  check('bloco do usuario preservou as linhas', has('linha dois') && has('linha tres'), '')
  await waitFor(() => composerIdle(), 30000)
}

log('--- paste vai para quem tem o teclado, não para o composer ---')
{
  // Um valor com a cara de uma chave, para o teste falhar alto se ela aparecer
  // em texto puro na tela — foi exatamente esse o bug: colar no modal do
  // `connect` escrevia no composer atrás dele.
  const FAKE_KEY = 'sk-ant-teste-NAO-REAL-0123456789abcdef'
  const boxTop = (rows: string[]) => rows.reduce((acc, l, i) => (l.includes('╭') ? i : acc), -1)
  const composer = () => lines()[boxTop(lines()) + 1] ?? ''

  key('/connect fake\r')
  const opened = await waitFor(() => has('connect fake') && has('API key'), 8000)
  check('connect de provider declarado abre sem baixar catálogo', opened,
    JSON.stringify(lines().filter(l => l.trim()).slice(0, 4)))

  key(`${ESC}[200~${FAKE_KEY}\n${ESC}[201~`)
  await tick(220)
  check('composer NÃO recebeu a chave', !composer().includes('sk-ant'), JSON.stringify(composer().trim().slice(0, 50)))
  check('chave não aparece em texto puro em nenhuma linha', !rawFrame().includes(FAKE_KEY), '')
  check('modal mostra a chave mascarada', (rawFrame().match(/•/g) ?? []).length >= FAKE_KEY.length,
    String((rawFrame().match(/•/g) ?? []).length))
  check('a quebra de linha do paste não confirmou nada', has('API key'),
    JSON.stringify(lines().filter(l => l.includes('connect')).slice(0, 2)))

  key(ESC)
  await tick(200)
  check('esc cancela sem gravar', has('connect cancelado'), JSON.stringify(lines().at(-2)?.slice(0, 60)))
  check('e o composer continua vazio', !composer().includes('sk-ant'), JSON.stringify(composer().trim().slice(0, 40)))

  // Picker: o paste filtra a lista, também sem cair no composer.
  key('/mode\r')
  await waitFor(() => has('filtro'), 5000)
  key(`${ESC}[200~plan${ESC}[201~`)
  await tick(200)
  check('paste no picker vai para o filtro', lines().some(l => l.includes('filtro') && l.includes('plan')),
    JSON.stringify(lines().find(l => l.includes('filtro'))))
  check('picker: composer intocado', !composer().includes('plan'), JSON.stringify(composer().trim().slice(0, 40)))
  key(ESC)
  await tick(200)

  // Sem modal, volta a ser o composer.
  key(`${ESC}[200~texto normal${ESC}[201~`)
  await tick(200)
  check('sem modal o paste é do composer', composer().includes('texto normal'),
    JSON.stringify(composer().trim().slice(0, 40)))
  for (let i = 0; i < 12; i++) key('\x7f')
  await tick(180)
}

log('--- 03 · popup sem borda ---')
key('/co')
await tick()
L = lines()
const popupHeader = L.find(l => l.includes('comandos'))
check('cabecalho "comandos · N de M"', Boolean(popupHeader), '')
check('hints do popup', has('↑↓ move · tab completa · enter roda'), '')
check('popup nao tem borda propria', !L.some(l => l.includes('╭') && l.includes('comandos')), '')
check('linha selecionada com bg', rawFrame().includes('48;5;237'), '')
check('mostra /compact', has('/compact'), '')

// A janela do popup era um `slice(0, 7)` fixo com o realce tirado módulo 7:
// `↓` além do sétimo movia uma seleção que já estava fora da lista, e os outros
// quarenta comandos só existiam para quem soubesse o nome de cor.
key('\x7f\x7f\x7f')
await tick(180)
key('/')
await tick(200)
{
  const total = Number((lines().find(l => l.includes('comandos'))?.match(/de (\d+)/) ?? [])[1] ?? 0)
  check('o popup conhece todos os comandos', total > 7, String(total))
  const primeiros = lines().filter(l => /^\s*[❯ ]\s*\//.test(l)).map(l => l.trim().split(/\s/)[0])
  for (let i = 0; i < 10; i++) key(`${ESC}[B`)
  await tick(220)
  const cabecalho = lines().find(l => l.includes('comandos')) ?? ''
  check('o cabeçalho segue a posição', /\b11 de \d+/.test(cabecalho), JSON.stringify(cabecalho.slice(0, 50)))
  const agora = lines().filter(l => /^\s*[❯ ]\s*\//.test(l)).map(l => l.trim().split(/\s/)[0])
  check('a janela rolou com a seleção', agora.join(',') !== primeiros.join(','),
    JSON.stringify({ primeiros, agora }))
  check('diz quantos ficaram acima e abaixo', lines().some(l => l.includes('↑ ') && l.includes('↓ ')),
    JSON.stringify(lines().filter(l => l.includes('↓ ')).slice(0, 2)))
  check('o selecionado está entre os visíveis',
    agora.some(nome => lines().some(l => l.trim().startsWith('❯ ') && l.includes(nome))),
    JSON.stringify(agora))
}
key('\x7f')
await tick(180)

log('--- 02 · rail do usuario + tool ---')
key('\x7f\x7f\x7f')
await tick()
key('/help\r')
await tick(300)
check('bloco assistant renderizado', has('modos de permissão') || has('teclas'), '')

// Turno real: o provider de teste é inválido de propósito, então o bloco do
// usuário aparece e o turno termina em erro — que é o que queremos verificar.
key('por que a compactacao nao cortou nada?\r')
// O provider de teste falha, mas o AI SDK ainda faz retry com backoff — espera
// o turno realmente terminar antes de seguir, senão as teclas seguintes entram
// na fila do composer em vez de abrir o modal.
// Ocupado = o composer troca o "❯" pelo spinner. Precisa esperar o turno COMEÇAR
// e so entao terminar: checar so o ocioso passa de primeira, antes do loop pegar
// a linha, e o resto do teste roda com o turno ainda vivo.
const idle = () => composerIdle()
await waitFor(() => !idle(), 20000)

// Com o turno rodando, `/` mostrava um composer vazio: a lista era escondida
// enquanto `busy`. O comando já ia para a fila e rodava no fim do turno — só não
// dava para ver o nome de nada.
{
  key('/')
  await tick(240)
  check('o popup de comandos abre durante o turno', has('↑↓ move · tab completa · enter roda'),
    JSON.stringify(lines().slice(-8).map(l => l.slice(0, 60))))
  check('o popup lista comandos durante o turno', has('/leadtime') || has('/help'),
    JSON.stringify(lines().slice(-10).map(l => l.slice(0, 40))))
  key('\x7f')
  await tick(200)
  check('apagar fecha o popup', !has('↑↓ move · tab completa · enter roda'), '')
}

await waitFor(idle, 90000)
await tick(300)
// "sem build" so existe no splash — /help tambem fala de shift+tab e ctrl+c.
check('splash some depois do primeiro turno', !has('sem build'), '')
check('WORDMARK CONTINUA no header depois da mensagem', lines().slice(0, 3).every(l => l.includes('█')), '')
check('identidade continua no header', lines().slice(0, 3).every(l => l.includes('█')), '')
check('rail ▌ na fala do usuario', has('▌'), '')
check('texto do usuario em destaque', has('por que a compactacao'), '')
check('erro com glifo ✕', has('✕'), '')

log('--- 04 · modal de permissao (borda ambar) ---')
const permission = session.requestPermission({
  tool: 'Bash',
  summary: 'executa um comando no shell',
  subject: 'node --test src/core/compaction.test.ts',
  verdict: { decision: 'ask', rule: 'Bash(*)' },
  input: {},
} as any)
await tick(250)
check('titulo permissão', has('permissão'), '')
check('comando destacado', has('node --test'), '')
check('regra citada', has('Bash(*)'), '')
check('teclas y/a/n', has('permitir uma vez') && has('negar'), '')
check('dica do AUTO', has('shift+tab 2×'), '')
check('borda warn 179', rawFrame().includes('38;5;179'), '')
key('n')
await tick(150)
check('permission resolvida como deny', (await permission) === false, '')

log('--- 05 · picker teal ---')
key('/mode\r')
await tick(400)
check('picker com filtro', has('filtro'), '')
check('contador N de M', has('de 5'), '')
check('rodape do picker', has('enter seleciona'), '')
check('borda info 109', rawFrame().includes('38;5;109'), '')
key(`${ESC}[B`)
await tick(120)
key('\r')
await tick(200)
check('modo trocou para plan', session.mode === 'plan', session.mode)

log('--- shift+tab ---')
key(`${ESC}[Z`)
await tick(150)
check('shift+tab -> AUTO', session.mode === 'bypassPermissions', session.mode)
check('AUTO em vermelho 167', rawFrame().includes('38;5;167'), '')
check('AUTO permite Bash', session.evaluatePermission({ tool: 'Bash', kind: 'exec', subject: 'echo oi' }).decision === 'allow')
check('AUTO ainda nega rm -rf', session.evaluatePermission({ tool: 'Bash', kind: 'exec', subject: 'rm -rf /' }).decision === 'deny')
key(`${ESC}[Z`)
await tick(150)

log('--- ctrl+r expande a tool ---')
session.emit({ type: 'tool-start', id: 't1', name: 'Read', summary: 'src/core/compaction.ts' })
await tick(120)
session.emit({ type: 'tool-end', id: 't1', name: 'Read', ok: true, preview: 'linha 1\nlinha 2\nlinha 3' })
await tick(150)
check('tool concluida marcada com bolinha', has('●'), '')
check('sem check duplicado no bloco de tool',
  !(lines().find(l => l.includes('Read(')) ?? '').includes('✔'), '')
check('affordance ⌄ ctrl+r', has('ctrl+r'), '')
check('preview escondida', !has('linha 2'), '')
key('\x12')
await tick(150)
check('ctrl+r expandiu', has('linha 2'), '')
key('\x12')
await tick(150)
check('ctrl+r colapsou', !has('linha 2'), '')

log('--- 08 · divisor de compactacao ---')
session.emit({ type: 'notice', text: 'compacted: ~5659 -> ~371 tokens' })
await tick(150)
check('divisor com label', has('contexto compactado'), '')
check('divisor em magenta 139', rawFrame().includes('38;5;139'), '')

log('--- streaming: custo de quadro com transcript grande ---')
{
  // 120 blocos de prosa, como uma sessão longa; depois simula o streaming
  // token a token e mede o custo por quadro.
  for (let i = 0; i < 120; i++) {
    session.emit({ type: 'text', text: `bloco ${i} ` + 'palavra '.repeat(40) })
    session.emit({ type: 'tool-start', id: `x${i}`, name: 'Read', summary: `file-${i}.ts` })
    session.emit({ type: 'tool-end', id: `x${i}`, name: 'Read', ok: true, preview: 'a\nb\nc' })
  }
  await tick(200)

  // Custo por quadro: forca um desenho por delta, medindo bytes enviados ao
  // terminal — que era o gargalo real (repaint inteiro = ~20 KB por quadro).
  bytes = 0
  writes = 0
  const start = performance.now()
  for (let i = 0; i < 60; i++) {
    session.emit({ type: 'text', text: `token${i} ` })
    await tick(35)
  }
  const elapsed = performance.now() - start
  const perDraw = writes > 0 ? Math.round(bytes / writes) : 0
  log(`       360 blocos · 60 deltas · ${writes} desenhos · ${Math.round(bytes / 1024)}KB total · ${perDraw}B por desenho · ${Math.round(elapsed)}ms`)
  check('escreve pouco por quadro (< 2KB)', perDraw < 2048, `${perDraw}B`)
  check('desenhou de fato', writes > 20, `${writes}`)

  const cols = 140
  check('patch e muito menor que a tela cheia', perDraw < cols * 34 * 0.3, `${perDraw}B vs ${cols * 34}B`)
}

log('--- scroll ---')
{
  // Le a quantidade real de linhas roladas do status bar.
  const scrolled = () => {
    const m = lines().join('\n').match(/rolado (\d+) linhas/)
    return m ? Number(m[1]) : 0
  }
  const snapshot = () => lines().slice(2, 8).join('|')

  const bottom = snapshot()
  check('no fim, sem indicador', scrolled() === 0, String(scrolled()))

  key(`${ESC}[5~`) // page up
  await tick(160)
  check('pgup rola 10 linhas de verdade', scrolled() === 10, `rolou ${scrolled()}`)
  check('conteudo visivel mudou', snapshot() !== bottom, '')
  check('status ensina ctrl+end', has('ctrl+end'), '')

  const afterFirst = snapshot()
  key(`${ESC}[5~`)
  await tick(160)
  check('pgup acumula (20)', scrolled() === 20, `rolou ${scrolled()}`)
  check('conteudo mudou de novo', snapshot() !== afterFirst, '')

  key(`${ESC}[<64;10;10M`) // roda para cima
  await tick(140)
  check('roda do mouse sobe 3', scrolled() === 23, `rolou ${scrolled()}`)
  key(`${ESC}[<65;10;10M`) // roda para baixo
  await tick(140)
  check('roda do mouse desce 3', scrolled() === 20, `rolou ${scrolled()}`)

  // Variantes que outros terminais mandam para End/Home.
  for (const variant of [`${ESC}[4~`, `${ESC}OF`, `${ESC}[8~`]) {
    key(`${ESC}[5~`)
    await tick(120)
    key(variant)
    await tick(120)
    check(`variante de End ${JSON.stringify(variant.replace(ESC, 'ESC'))} volta ao fim`, scrolled() === 0, String(scrolled()))
  }
  for (const variant of [`${ESC}[1~`, `${ESC}OH`, `${ESC}[7~`]) {
    key(variant)
    await tick(120)
    check(`variante de Home ${JSON.stringify(variant.replace(ESC, 'ESC'))} sobe`, scrolled() > 0, String(scrolled()))
    key(`${ESC}[1;5F`)
    await tick(120)
  }

  key(`${ESC}[1;5H`) // ctrl+home
  await tick(160)
  const top = scrolled()
  check('ctrl+home vai ao topo do transcript', top > 100, `rolou ${top}`)
  // O bloco mais antigo do transcript e o aviso do /width, la do inicio do teste.
  check('no topo aparece o bloco mais antigo', has('largura'), '')

  key(`${ESC}[1;5F`) // ctrl+end
  await tick(160)
  check('ctrl+end volta ao fim', scrolled() === 0, `rolou ${scrolled()}`)
  check('voltou para o mesmo fim', snapshot() === bottom, '')

  key(`${ESC}[<65;10;10M`)
  await tick(140)
  check('scroll nao fica negativo no fim', scrolled() === 0, String(scrolled()))

  key(`${ESC}[6~`) // pgdn no fim
  await tick(140)
  check('pgdn no fim nao quebra', scrolled() === 0, String(scrolled()))

  // Bloco novo tem de grudar de volta no fim.
  key(`${ESC}[5~`)
  await tick(140)
  check('rolado antes do bloco novo', scrolled() === 10, String(scrolled()))
  session.emit({ type: 'notice', text: 'bloco novo chegou' })
  await tick(160)
  check('bloco novo gruda no fim', scrolled() === 0, String(scrolled()))
}

log('--- seleção por caractere ---')
{
  const fs = await import(`${R}/tui/fullscreen.ts`)
  const clip = await import(`${R}/util/clipboard.ts`)
  const P = (row: number, col: number) => ({ row, col })

  // matematica pura do span
  check('span vazio quando nao arrastou', fs.spanOf({ anchor: P(5, 10), head: P(5, 10) }).empty, '')
  check('span nao vazio ao mover 1 coluna', !fs.spanOf({ anchor: P(5, 10), head: P(5, 11) }).empty, '')
  {
    const s = fs.spanOf({ anchor: P(8, 30), head: P(5, 2) })
    check('arrasto pra tras normaliza', s.start.row === 5 && s.start.col === 2 && s.end.row === 8, JSON.stringify(s))
  }
  {
    const r = fs.rowRange(5, P(5, 4), P(5, 9), 140)
    check('faixa numa linha so inclui a ponta', r.from === 3 && r.to === 9, JSON.stringify(r))
  }
  {
    const first = fs.rowRange(5, P(5, 4), P(7, 9), 140)
    const mid = fs.rowRange(6, P(5, 4), P(7, 9), 140)
    const last = fs.rowRange(7, P(5, 4), P(7, 9), 140)
    check('1a linha vai ate o fim', first.from === 3 && first.to === 140, JSON.stringify(first))
    check('linha do meio inteira', mid.from === 0 && mid.to === 140, JSON.stringify(mid))
    check('ultima linha para na ponta', last.from === 0 && last.to === 9, JSON.stringify(last))
  }

  // integracao: arrasta sobre um bloco conhecido
  key(`${ESC}[1;5F`) // ctrl+end, garante fim do transcript
  await tick(160)
  session.emit({ type: 'notice', text: 'ALVOSELECAO abcdefghij FIM' })
  await tick(200)

  const rowIdx = lines().findIndex(l => l.includes('ALVOSELECAO'))
  check('bloco alvo na tela', rowIdx >= 0, String(rowIdx))
  const rowText = lines()[rowIdx]
  const startCol = rowText.indexOf('abcdefghij') + 1

  // clique sem arrastar: nada selecionado, nada copiado
  const before = clip.lastClipboardWrite()
  key(`${ESC}[<0;${startCol};${rowIdx + 1}M`)
  await tick(120)
  check('clique nao pinta selecao', !rawFrame().includes('48;5;237'), '')
  key(`${ESC}[<0;${startCol};${rowIdx + 1}m`)
  await tick(160)
  check('clique nao copia', clip.lastClipboardWrite() === before, JSON.stringify(clip.lastClipboardWrite()))
  check('clique nao vira mensagem de copia', !has('copiado'), '')

  // arrasta 'cdefg' (offset 2..6 dentro de abcdefghij)
  key(`${ESC}[<0;${startCol + 2};${rowIdx + 1}M`)
  await tick(100)
  key(`${ESC}[<32;${startCol + 6};${rowIdx + 1}M`)
  await tick(120)
  check('destaque aparece durante o arrasto', rawFrame().includes('48;5;237'), '')
  {
    const painted = screen[rowIdx] ?? ''
    const marked = painted.slice(painted.indexOf('48;5;237'))
    check('destaque nao pega a linha toda', !marked.includes('ALVOSELECAO'), marked.slice(0, 60))
  }
  key(`${ESC}[<0;${startCol + 6};${rowIdx + 1}m`)
  await tick(200)
  check('copiou exatamente o trecho', clip.lastClipboardWrite() === 'cdefg', JSON.stringify(clip.lastClipboardWrite()))
  check('status conta caracteres', has('5 caracteres copiados'), '')
  check('destaque some ao soltar', !rawFrame().includes('48;5;237'), '')

  // arrasto de tras pra frente devolve o mesmo trecho
  key(`${ESC}[<0;${startCol + 6};${rowIdx + 1}M`)
  await tick(100)
  key(`${ESC}[<32;${startCol + 2};${rowIdx + 1}M`)
  await tick(100)
  key(`${ESC}[<0;${startCol + 2};${rowIdx + 1}m`)
  await tick(200)
  check('arrasto reverso copia igual', clip.lastClipboardWrite() === 'cdefg', JSON.stringify(clip.lastClipboardWrite()))

  // clique no composer nao copia nada
  const composerRow = lines().findIndex(l => l.includes('❯')) + 1
  const beforeComposer = clip.lastClipboardWrite()
  key(`${ESC}[<0;20;${composerRow}M`)
  await tick(100)
  key(`${ESC}[<0;20;${composerRow}m`)
  await tick(180)
  check('clique no composer nao copia', clip.lastClipboardWrite() === beforeComposer, JSON.stringify(clip.lastClipboardWrite()))
}

log('--- marca ByteCode ---')
{
  const head = lines().slice(0, 3)
  const ART = [
    '█▀▄ █ █ ▀█▀ █▀▀ ▄▀▀ ▄▀▄ █▀▄ █▀▀',
    '█▀▄ ▀▄▀  █  █▀▀ █   █ █ █ █ █▀▀',
    '█▄▀  █   █  █▄▄ ▀▄▄ ▀▄▀ █▄▀ █▄▄',
  ]
  check('as 3 linhas do wordmark batem', ART.every((row, i) => head[i]?.includes(row)),
    JSON.stringify(head.map(l => l.slice(0, 34))))
  check('todas as linhas tem a mesma largura de arte', new Set(ART.map(r => r.length)).size === 1, '')
  check('BYTE e CODE em cores diferentes', /38;5;\d+m█▀▄ █ █ ▀█▀ █▀▀/.test(screen[0] ?? ''), (screen[0] ?? '').slice(0, 60))
  check('sem HardX em lugar nenhum', !rawFrame().includes('HardX'), '')
  check('nao repete o nome em texto ao lado da arte', !head.join(' ').includes('ByteCode'), '')
  check('versao ao lado da arte', head.join(' ').includes('v0.1'), '')
  check('header nao estoura a largura', head.every(l => l.length <= 140), JSON.stringify(head.map(l => l.length)))

  // Terminal estreito: nao cabe arte + texto, entao volta a identidade textual.
  Object.defineProperty(process.stdout, 'columns', { value: 46, configurable: true })
  process.stdout.emit('resize')
  await tick(260)
  const narrow = lines()
  check('estreito colapsa a arte', !narrow[0].includes('█▀▄'), JSON.stringify(narrow[0]?.slice(0, 40)))
  check('estreito mostra o nome em texto', narrow[0].includes('ByteCode'), JSON.stringify(narrow[0]?.slice(0, 40)))

  Object.defineProperty(process.stdout, 'columns', { value: 140, configurable: true })
  process.stdout.emit('resize')
  await tick(260)
  check('voltou a arte ao alargar', lines()[0].includes('█▀▄ █ █ ▀█▀ █▀▀'), JSON.stringify(lines()[0]?.slice(0, 40)))
}

await laterSessionTests()

log('--- input longo não trunca: quebra e mostra o que se digita ---')
{
  const fs = await import(`${R}/tui/fullscreen.ts`)

  // matemática do wrap
  check('curto não quebra', JSON.stringify(fs.wrapInput('oi', 20)) === '["oi"]', '')
  check('não perde caractere', fs.wrapInput('a'.repeat(250), 40).join('') === 'a'.repeat(250), '')
  check('nenhuma linha passa da largura', fs.wrapInput('a'.repeat(250), 40).every(l => l.length <= 40), '')
  {
    const frase = 'palavra '.repeat(20).trim()
    const rows = fs.wrapInput(frase, 40)
    check('quebra em espaço quando dá', rows.slice(0, -1).every(r => r.endsWith(' ') || r.length === 40), JSON.stringify(rows.slice(0, 2)))
    check('remonta a frase', rows.join('') === frase, '')
  }
  {
    // token sem espaço tem que ser cortado à força, não estourar
    const rows = fs.wrapInput(`C:\\${'x'.repeat(120)}`, 30)
    check('token gigante é cortado à força', rows.every(r => r.length <= 30), JSON.stringify(rows.map(r => r.length)))
  }

  // integração: digitar mais que a largura
  key(ESC)
  await tick(150)
  const longo = 'ABC'.repeat(90) // 270 chars, muito além das 140 colunas
  key(longo)
  await tick(280)

  check('sem elipse de truncamento', !has('…'), JSON.stringify((lines().find(l => l.includes('ABC')) ?? '').slice(-30)))
  check('início do texto visível', has('ABCABC'), '')
  check('FIM do texto visível', lines().some(l => l.includes(longo.slice(-12))),
    JSON.stringify(longo.slice(-12)))
  {
    const inputRows = lines().filter(l => l.includes('ABC'))
    check('quebrou em várias linhas', inputRows.length >= 2, String(inputRows.length))
    check('nenhuma linha estoura a tela', inputRows.every(l => l.length <= 140),
      String(Math.max(...inputRows.map(l => l.length))))
    // todo o texto digitado está na tela, em ordem
    const remontado = inputRows.map(l => (l.match(/(ABC)+/g) ?? []).join('')).join('')
    check('nada foi perdido', remontado.length >= longo.length - 6, `${remontado.length} de ${longo.length}`)
  }
  check('borda direita intacta', (lines().find(l => l.includes('ABC')) ?? '').includes('│'),
    JSON.stringify((lines().find(l => l.includes('ABC')) ?? '').slice(-6)))

  // cursor não senta na borda quando a linha enche exatamente
  key(ESC)
  await tick(150)
  key('y'.repeat(134))
  await tick(250)
  check('linha cheia não empurra o cursor pra borda',
    lines().filter(l => l.includes('y')).every(l => l.length <= 140), '')

  key(ESC)
  await tick(200)
  check('esc limpa', !has('ABCABC') && !has('yyyy'), '')
}

log('--- tab troca o agente ativo (opencode-style) ---')
{
  // agentes primary injetados no bundle carregado
  session.assets.agents = [
    { name: 'dispatcher', description: 'roteia', tools: [], model: undefined, prompt: 'sou o dispatcher', file: 'x', mode: 'primary', permissions: { allow: ['Edit(*)'] } },
    { name: 'lean', description: 'enxuto', tools: [], model: undefined, prompt: 'sou lean', file: 'y', mode: 'primary', permissions: { deny: ['Agent(*)'] } },
    { name: 'dev', description: 'subagente', tools: [], model: undefined, prompt: 'dev', file: 'z', mode: 'subagent' },
  ] as never
  await tick(180)

  check('status bar mostra build por padrão', has('build'), JSON.stringify(lines().at(-1)?.slice(0, 60)))

  key('\t')
  await tick(220)
  check('tab entra no primeiro primary', has('dispatcher'), JSON.stringify(lines().at(-1)?.slice(0, 70)))
  check('sessão sabe qual agente está ativo', session.primaryAgent?.name === 'dispatcher', String(session.primaryAgent?.name))

  key('\t')
  await tick(220)
  check('tab anda para o próximo', session.primaryAgent?.name === 'lean', String(session.primaryAgent?.name))
  check('subagent não entra no ciclo', session.primaryAgent?.name !== 'dev', String(session.primaryAgent?.name))

  key('\t')
  await tick(220)
  check('ciclo volta para build', session.primaryAgent === null, String(session.primaryAgent?.name))

  // permissão do agente vale de verdade
  key('\t')
  await tick(200)
  const verdict = session.evaluatePermission({ tool: 'Edit', kind: 'write', subject: 'a.ts' })
  check('permissão do agente ativo é aplicada', verdict.decision === 'allow', JSON.stringify(verdict))

  // com o popup de comandos aberto, tab volta a completar
  const before = session.primaryAgent?.name
  key('/mod')
  await tick(200)
  key('\t')
  await tick(200)
  check('tab completa comando quando o popup está aberto', session.primaryAgent?.name === before,
    `${before} -> ${session.primaryAgent?.name}`)
  check('completou o comando', (lines()[lastBox(lines()) + 1] ?? '').includes('/mode'),
    JSON.stringify(lines()[lastBox(lines()) + 1]?.trim().slice(0, 30)))
  key(ESC)
  await tick(160)

  // /agent por nome
  key('/agent lean\r')
  await tick(300)
  check('/agent por nome funciona', session.primaryAgent?.name === 'lean', String(session.primaryAgent?.name))
  key('/agent build\r')
  await tick(300)
  check('/agent build sai do agente', session.primaryAgent === null, String(session.primaryAgent?.name))
  key('/agent naoexiste\r')
  await tick(300)
  check('/agent com nome errado avisa', has('não encontrado'), '')
}

log('--- modal de tasks (ctrl+t) ---')
{
  const { getTodos } = await import(`${R}/tools/meta.ts`)
  check('sem tasks ainda', getTodos(session).length === 0, String(getTodos(session).length))

  check('status bar mostra tasks(0) antes de existir task', has('tasks(0)'),
    JSON.stringify(lines().at(-1)?.slice(0, 90)))

  key('\x14')
  await tick(220)
  check('ctrl+t abre mesmo vazio', has('tasks'), '')
  check('explica que ainda não há tasks', has('ainda não quebrou o trabalho'), '')
  key('\x14')
  await tick(200)
  check('ctrl+t fecha', !has('ainda não quebrou o trabalho'), '')

  // o modelo cria tasks via TodoWrite
  const { allTools } = await import(`${R}/tools/index.ts`)
  const todoTool = allTools.find(t => t.name === 'TodoWrite')!
  await todoTool.execute(
    {
      todos: [
        { content: 'ler o loop', status: 'completed' },
        { content: 'consertar o retry', status: 'in_progress' },
        { content: 'escrever teste', status: 'pending' },
      ],
    },
    { session, cwd, depth: 0 } as never,
  )
  await tick(220)

  check('status bar mostra tasks(N) com o atalho', has('ctrl+t ') && has('tasks(3)'),
    JSON.stringify(lines().at(-1)?.slice(0, 90)))
  check('tasks fica ao lado do agente',
    (lines().at(-1) ?? '').indexOf('tasks(3)') > (lines().at(-1) ?? '').indexOf('build'),
    JSON.stringify(lines().at(-1)?.slice(0, 90)))

  key('\x14')
  await tick(240)
  check('modal lista as três', has('ler o loop') && has('consertar o retry') && has('escrever teste'), '')
  check('cabeçalho conta as concluídas', has('1/3'), JSON.stringify(lines().find(l => l.includes('tasks'))))
  {
    const doneRow = lines().find(l => l.includes('ler o loop')) ?? ''
    const pendingRow = lines().find(l => l.includes('escrever teste')) ?? ''
    check('concluída marcada com ✔', doneRow.includes('✔'), JSON.stringify(doneRow.trim().slice(0, 30)))
    check('pendente marcada com ○', pendingRow.includes('○'), JSON.stringify(pendingRow.trim().slice(0, 30)))
  }
  check('ensina como fechar', has('esc ou ctrl+t fecha'), '')

  key(ESC)
  await tick(220)
  check('esc fecha o modal', !has('esc ou ctrl+t fecha'), '')

  key('/tasks\r')
  await tick(300)
  check('/tasks abre o mesmo modal', has('consertar o retry'), '')
  key(ESC)
  await tick(200)

  // Task escrita dentro de um subagent: o estado ficava preso na Session filha, a
  // lista aparecia no transcript e o ctrl+t continuava vazio.
  const filho = session.child({ agentType: 'dispatcher' })
  await todoTool.execute(
    {
      todos: [
        { content: 'alterar o JSP', status: 'in_progress' },
        { content: 'ajustar o controller', status: 'pending' },
      ],
    },
    { session: filho, cwd, depth: 1 } as never,
  )
  // Em execução real o filho emite pelo pai (`agent-event`) e a tela redesenha
  // sozinha; aqui a tool é chamada direto, então força-se um quadro.
  key(ESC)
  await tick(220)

  check('task de subagent conta na status bar', has('tasks(5)'),
    JSON.stringify(lines().at(-1)?.slice(0, 90)))
  key('\x14')
  await tick(240)
  check('modal mostra a lista do subagent', has('alterar o JSP') && has('ajustar o controller'), '')
  check('e continua mostrando a da principal', has('consertar o retry'), '')
  check('separa por quem escreveu', has('dispatcher') && has('main'),
    JSON.stringify(lines().filter(l => l.includes('dispatcher') || l.includes('main')).slice(0, 3)))
  check('cada grupo conta o seu', has('1/3') && has('0/2'),
    JSON.stringify(lines().filter(l => /\d\/\d/.test(l)).slice(0, 4)))
  key(ESC)
  await tick(200)

  // Lista vazia some em vez de virar um grupo fantasma.
  await todoTool.execute({ todos: [] }, { session: filho, cwd, depth: 1 } as never)
  key(ESC)
  await tick(220)
  check('lista zerada some do rollup', has('tasks(3)'), JSON.stringify(lines().at(-1)?.slice(0, 90)))
}

log('--- indicador de trabalho tem respiro acima ---')
{
  // Um bloco identificável no fim do transcript, para medir a distância até ele.
  session.emit({ type: 'tool-start', id: 'w1', name: 'Bash', summary: 'algo', subject: 'grep MARCADOR' })
  session.emit({ type: 'tool-end', id: 'w1', name: 'Bash', ok: true, preview: 'ok' })
  await tick(220)

  const idleRows = lines()
  const idleTool = idleRows.findIndex(l => l.includes('grep MARCADOR'))
  const idleComposer = lastBox(idleRows)
  check('parado: linha em branco entre transcript e composer',
    idleComposer - idleTool >= 2 && (idleRows[idleComposer - 1] ?? '').trim() === '',
    `tool=${idleTool} composer=${idleComposer}`)

  // Entra em "trabalhando" pelo caminho real (submit no composer). O provider de
  // teste aponta para host invalido e falha em poucos ms, entao o poll e apertado
  // e o quadro e capturado no instante em que o indicador esta visivel.
  let busyRows: string[] = []
  key('algo demorado')
  await tick(60)
  key('\r')
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 5))
    const rows = lines()
    if (rows.some(l => /esc interrompe\)/.test(l))) {
      busyRows = rows
      break
    }
  }

  const verbRow = busyRows.findIndex(l => /esc interrompe\)/.test(l))
  const toolRow = busyRows.findIndex(l => l.includes('grep MARCADOR'))
  check('indicador aparece', verbRow >= 0, String(verbRow))
  check('não fica colado na última linha do chat',
    verbRow - toolRow >= 2 && (busyRows[verbRow - 1] ?? '').trim() === '',
    `tool=${toolRow} indicador=${verbRow} entre=${JSON.stringify(busyRows[verbRow - 1])}`)
  check('composer continua abaixo do indicador', lastBox(busyRows) > verbRow,
    `indicador=${verbRow} composer=${lastBox(busyRows)}`)

  await waitFor(() => composerIdle(), 8000)
}

log('--- comando multilinha não corrompe o quadro ---')
{
  const rowsBefore = screen.length
  // Exatamente o caso do bug: comando de shell com newline no meio.
  const cmd = 'cd /c/repo && echo "---\nlinha dois\nlinha tres" && git pull origin main 2>&1'
  const { shellTools } = await import(`${R}/tools/shell.ts`)
  const bash = shellTools.find(t => t.name === 'Bash') ?? shellTools[0]

  check('subject do Bash já vem em uma linha', !(bash.subject?.({ command: cmd }) ?? '').includes('\n'),
    JSON.stringify(bash.subject?.({ command: cmd })?.slice(0, 60)))

  // E mesmo se algo escapar, o quadro não deve conter newline nenhum.
  session.emit({ type: 'tool-start', id: 'ml', name: 'Bash', summary: 'multi', subject: cmd })
  session.emit({ type: 'tool-end', id: 'ml', name: 'Bash', ok: true, preview: 'linha1\nlinha2' })
  await tick(260)

  const raw = screen.map(l => l ?? '')
  check('nenhuma linha do quadro contém newline', raw.every(l => !l.includes('\n')),
    JSON.stringify(raw.filter(l => l.includes('\n')).slice(0, 2)))
  check('nem CR nem tab', raw.every(l => !/[\r\t]/.test(l)), '')
  check('altura do quadro não mudou', screen.length === rowsBefore, `${rowsBefore} -> ${screen.length}`)
  check('a chamada aparece numa única linha',
    lines().filter(l => l.includes('linha dois')).length <= 1,
    JSON.stringify(lines().filter(l => l.includes('linha dois'))))
  check('sem fragmento órfão na coluna 0',
    !lines().some(l => /^[a-z]{2,}.*…\)$/.test(l)),
    JSON.stringify(lines().filter(l => /^[a-z]{2,}.*…\)$/.test(l))))

  // sanitizador direto
  const { oneLine } = await import(`${R}/tui/render.ts`)
  check('oneLine troca newline por espaço', oneLine('a\nb') === 'a b', JSON.stringify(oneLine('a\nb')))
  check('oneLine troca CR e tab', oneLine('a\r\tb') === 'a  b', JSON.stringify(oneLine('a\r\tb')))
  check('oneLine preserva sequências ANSI', oneLine(`${ESC}[1mx${ESC}[0m`) === `${ESC}[1mx${ESC}[0m`, '')
}

log('--- mensagem na fila fica destacada até ser enviada ---')
{
  // Turno em voo, e duas mensagens digitadas durante ele.
  key('primeiro turno')
  await tick(60)
  key('\r')

  let busyRows: string[] = []
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 5))
    if (lines().some(l => /esc interrompe\)/.test(l))) break
  }

  key('FILA UM')
  await tick(40)
  key('\r')
  key('FILA DOIS')
  await tick(40)
  key('\r')
  await tick(120)
  busyRows = lines()

  const oneRow = busyRows.find(l => l.includes('FILA UM')) ?? ''
  const twoRow = busyRows.find(l => l.includes('FILA DOIS')) ?? ''
  check('mensagem enfileirada aparece na tela', oneRow.length > 0, JSON.stringify(oneRow.slice(0, 40)))
  check('a segunda também', twoRow.length > 0, JSON.stringify(twoRow.slice(0, 40)))
  check('ordem preservada', busyRows.indexOf(oneRow) < busyRows.indexOf(twoRow), '')
  check('diz que está na fila', oneRow.includes('na fila'), JSON.stringify(oneRow.trim().slice(0, 60)))

  {
    const raw = screen.find(l => (l ?? '').includes('FILA UM')) ?? ''
    // fundo claro (bright=255) com texto escuro (bg=235): invertido
    check('fundo contrastante na linha da fila', raw.includes('48;5;255') && raw.includes('38;5;235'),
      JSON.stringify(raw.slice(0, 60)))
    check('destaque cobre a linha toda', strip(raw).length >= 130, String(strip(raw).length))
  }
  {
    const rawSent = screen.find(l => (l ?? '').includes('primeiro turno')) ?? ''
    check('a que já foi enviada NÃO tem o destaque', !rawSent.includes('48;5;255'),
      JSON.stringify(rawSent.slice(0, 50)))
  }

  // O turno falha (host inválido) e a fila é consumida uma a uma.
  await waitFor(() => {
    const raw = screen.find(l => (l ?? '').includes('FILA UM')) ?? ''
    return raw.length > 0 && !raw.includes('48;5;255')
  }, 15000)
  {
    const raw = screen.find(l => (l ?? '').includes('FILA UM')) ?? ''
    check('ao ser enviada volta ao normal', !raw.includes('48;5;255'), JSON.stringify(raw.slice(0, 60)))
    check('e ganha o rail de usuário', strip(raw).includes('▌'), JSON.stringify(strip(raw).trim().slice(0, 40)))
    check('não diz mais "na fila"', !strip(raw).includes('na fila'), '')
  }

  await waitFor(() => {
    const raw = screen.find(l => (l ?? '').includes('FILA DOIS')) ?? ''
    return raw.length > 0 && !raw.includes('48;5;255')
  }, 15000)
  check('a segunda também sai da fila', !((screen.find(l => (l ?? '').includes('FILA DOIS')) ?? '').includes('48;5;255')), '')
  check('nenhuma linha ficou destacada', !rawFrame().includes('48;5;255'), '')
  check('não duplicou a mensagem', lines().filter(l => l.includes('FILA UM')).length === 1,
    String(lines().filter(l => l.includes('FILA UM')).length))

  await waitFor(() => composerIdle(), 10000)
}

log('--- comando na fila não deixa bolha ---')
{
  key('outro turno')
  await tick(60)
  key('\r')
  for (let i = 0; i < 400; i++) {
    await new Promise(r => setTimeout(r, 5))
    if (lines().some(l => /esc interrompe\)/.test(l))) break
  }
  key('/mode')
  await tick(40)
  key('\r')
  await tick(120)
  check('comando enfileirado aparece destacado', has('/mode'), '')

  // `/mode` sem argumento abre um picker — o comando enfileirado roda de verdade,
  // inclusive abrindo o modal dele. Fecha antes de seguir, senão o picker engole
  // as teclas dos testes seguintes.
  await waitFor(() => has('filtro'), 15000)
  check('comando enfileirado roda de verdade (abriu o picker)', has('filtro'), '')
  key(ESC)
  await tick(250)
  check('depois de rodar não sobra bolha do comando',
    !lines().some(l => l.includes('/mode') && l.includes('▌')),
    JSON.stringify(lines().filter(l => l.includes('/mode')).slice(0, 2)))
  check('nenhum destaque sobrando', !rawFrame().includes('48;5;255'), '')
  await waitFor(() => composerIdle(), 15000)
}

log('--- ctrl+p abre os MCPs ---')
{
  check('status bar mostra mcp(N) com o atalho', has('ctrl+p ') && has('mcp('),
    JSON.stringify(lines().at(-1)?.slice(0, 110)))
  check('mcp fica ao lado das tasks',
    (lines().at(-1) ?? '').indexOf('mcp(') > (lines().at(-1) ?? '').indexOf('tasks('),
    JSON.stringify(lines().at(-1)?.slice(0, 110)))

  key('\x10')
  await tick(240)
  check('ctrl+p abre o modal', has('conectados') || has('nenhum servidor MCP'), '')
  check('modal ensina como fechar', has('esc ou ctrl+p fecha'), '')
  check('aponta o /context-all', has('/context-all'), '')

  key('\x10')
  await tick(200)
  check('ctrl+p fecha', !has('esc ou ctrl+p fecha'), '')

  key('/mcp\r')
  await tick(320)
  check('/mcp abre o mesmo modal', has('esc ou ctrl+p fecha'), '')
  key(ESC)
  await tick(200)
  check('esc fecha', !has('esc ou ctrl+p fecha'), '')
}

log('--- assinatura oculta no canto ---')
{
  const primeira = screen[0] ?? ''
  check('assinatura está no buffer', strip(primeira).includes('Desenvolvido por Abel Duarte'),
    JSON.stringify(strip(primeira).slice(-40)))
  check('assinatura vai escondida (conceal + cor de fundo)',
    primeira.includes(`${ESC}[8m`) && primeira.includes('38;5;235'), JSON.stringify(primeira.slice(-70)))
  check('assinatura fica colada na direita',
    strip(primeira).trimEnd().endsWith('Desenvolvido por Abel Duarte'), JSON.stringify(strip(primeira).slice(-45)))
  check('assinatura não empurra o cabeçalho',
    strip(primeira).includes('multi-provider agent harness'), JSON.stringify(strip(primeira).slice(0, 60)))
  check('linha não passa da largura do terminal', strip(primeira).length <= 140, String(strip(primeira).length))
}

log('--- ctrl+g: tela de arquivos alterados ---')
{
  const { recordChange, clearChanges } = await import(`${R}/core/changes.ts`)
  const nodePath2 = await import('node:path')

  key('\x07')
  await tick(240)
  check('sem alteração, ctrl+g avisa e não abre',
    has('nenhum arquivo alterado') && !has('↑↓ arquivo'), JSON.stringify(lines().at(-1)?.slice(0, 90)))

  recordChange(session, {
    file: nodePath2.join(session.cwd, 'src', 'core', 'loop.ts'),
    before: 'const a = 1\nconst b = 2\n',
    after: 'const a = 1\nconst b = 3\n',
  })
  recordChange(session.child({ agentType: 'dispatcher' }), {
    file: nodePath2.join(session.cwd, 'docs', 'nota.md'),
    before: null,
    after: 'nova nota\n',
  })

  key('\x07')
  await tick(320)
  check('ctrl+g abre a tela', has('alterações') && has('↑↓ arquivo'), JSON.stringify(lines().slice(0, 6)))
  check('lista agrupada pelo caminho', has('src\\core') || has('src/core'), JSON.stringify(lines().slice(0, 12)))
  check('mostra os dois arquivos', has('loop.ts') && has('nota.md'), JSON.stringify(lines().slice(0, 14)))
  check('conta as linhas por arquivo', lines().some(l => /\+\d+ -\d+/.test(l)), JSON.stringify(lines().slice(0, 14)))
  check('mostra o diff do selecionado ao lado', has('const b = 3') || has('nova nota'), JSON.stringify(lines().slice(0, 16)))
  check('status bar ganha o contador', has('alterações(2)'), JSON.stringify(lines().at(-1)?.slice(0, 120)))
  // Arquivo escrito por subagent entra na mesma lista, com o nome do agente ao
  // lado — sem isso, um diff que ninguém lembra de ter pedido fica sem autor.
  check('escrita de subagent aparece com o autor', has('dispatcher'), JSON.stringify(lines().slice(0, 14)))

  const antes = lines().join('\n')
  key(`${ESC}[B`)
  await tick(260)
  check('seta troca o arquivo mostrado', lines().join('\n') !== antes, '')

  key(ESC)
  await tick(260)
  check('esc volta para a conversa', !has('↑↓ arquivo'), JSON.stringify(lines().slice(0, 4)))
  check('a sessão continua viva depois de sair',
    session.messages.length > 0 && composerIdle(), String(session.messages.length))
  clearChanges(session)
}

// Quarenta e sete arquivos com nome comprido: o caso que quebrou na tela do
// usuário. O nome ao lado do `+n -n` estourava a coluna, a linha inteira passava
// da largura do terminal e o console jogava a sobra na linha de baixo — e a
// lista não rolava, então o arquivo selecionado ficava fora da tela.
log('--- ctrl+g: lista longa não estoura nem esconde a seleção ---')
{
  const { recordChange, clearChanges } = await import(`${R}/core/changes.ts`)
  const nodePath3 = await import('node:path')
  const nomes = [
    'PixWebhookTesteFalhouException', 'CresolPixWebhookController', 'PixWebhookEntregaResponse',
    'PixWebhookValidationException', 'PixWebhookNotFoundException', 'PixWebhookConflictException',
    'PixWebhookRetryProperties', 'PixWebhookDeliveryPoller', 'PixQrCodeDisponivelDados',
    'PixWebhookEventoEnvelope', 'PixWebhookCadastroResponse', 'PixWebhookEventoStatus',
  ]
  for (let i = 0; i < 47; i++) {
    const nome = `${nomes[i % nomes.length]}${i < nomes.length ? '' : i}`
    recordChange(session, {
      file: nodePath3.join(session.cwd, 'src', `pacote${i % 4}`, `${nome}.java`),
      before: null,
      after: Array.from({ length: 10 + i }, (_, n) => `linha ${n}`).join('\n'),
    })
  }

  key('\x07')
  await tick(320)
  check('abre com a lista longa', has('47 arquivo'), JSON.stringify(lines().slice(0, 3)))
  // A checagem que pega o bug: uma linha mais larga que o terminal quebra e
  // desloca tudo abaixo dela.
  const largura = lines().map(l => l.length)
  check('nenhuma linha passa da largura do terminal', largura.every(n => n <= 140),
    JSON.stringify(largura.filter(n => n > 140)))
  // Só as linhas de conteúdo do diff: a caixa do composer também usa `│`.
  const corpo = () => lines().filter(l => /\d+ \+ linha \d+/.test(l))
  const colunas = new Set(corpo().map(l => l.indexOf('│')))
  check('a coluna do diff continua alinhada', colunas.size === 1 && !colunas.has(-1),
    JSON.stringify([...colunas]))

  const { changedFiles } = await import(`${R}/core/changes.ts`)
  const antesDaLista = corpo().length > 0 ? lines().slice(2, 12).join('|') : ''
  // Desce até bem depois do fim da primeira tela: o arquivo selecionado tem que
  // continuar visível na coluna da esquerda.
  for (let i = 0; i < 30; i++) key(`${ESC}[B`)
  await tick(400)
  const cabecalho = lines().find(l => l.includes('de 47 arquivos')) ?? ''
  const posicao = Number((cabecalho.match(/(\d+) de 47/) ?? [])[1] ?? 0)
  check('o cabeçalho diz onde está', posicao > 25 && posicao <= 47, JSON.stringify(cabecalho.slice(0, 60)))
  const selecionado = changedFiles(session)[posicao - 1]
  const base = nodePath3.basename(selecionado?.file ?? '').slice(0, 14)
  check('o arquivo selecionado está visível na lista',
    lines().some(l => l.slice(0, 42).includes(base)), JSON.stringify({ base, lista: lines().slice(4, 10).map(l => l.slice(0, 42)) }))
  check('a lista rolou junto com a seleção', lines().slice(2, 12).join('|') !== antesDaLista, '')
  const depois = lines().map(l => l.length)
  check('continua sem estourar depois de rolar', depois.every(n => n <= 140),
    JSON.stringify(depois.filter(n => n > 140)))

  key(ESC)
  await tick(240)
  clearChanges(session)
}

log('--- r desfaz o arquivo selecionado ---')
{
  const { recordChange, clearChanges, changedFiles } = await import(`${R}/core/changes.ts`)
  const { noteFile } = await import(`${R}/core/filestate.ts`)
  const { promises: fsp2 } = await import('node:fs')
  const nodePath3 = await import('node:path')

  // Arquivo de verdade, dentro do scratch da suíte. Os outros blocos gravam
  // caminhos do repositório com conteúdo fabricado, e desfazer escreve no disco.
  const alvo = nodePath3.join(S, 'rewind-alvo.txt')
  await fsp2.writeFile(alvo, 'como estava antes\n', 'utf8')
  await noteFile(session, alvo)
  await fsp2.writeFile(alvo, 'o que o agente escreveu\n', 'utf8')
  await noteFile(session, alvo)
  recordChange(session, { file: alvo, before: 'como estava antes\n', after: 'o que o agente escreveu\n' })

  key('\x07')
  await tick(320)
  check('a tela anuncia o atalho de desfazer', has('r desfaz'), JSON.stringify(lines().slice(0, 4)))

  key('r')
  await tick(320)
  check('r pede confirmação antes de escrever', has('permissão') && has('desfazer'),
    JSON.stringify(lines().filter(l => l.includes('permiss') || l.includes('desfaz')).slice(0, 3)))
  check('a pergunta diz o que vai acontecer', has('restaurar') && has('rewind-alvo.txt'),
    JSON.stringify(lines().filter(l => l.includes('restaurar')).slice(0, 2)))

  key('n')
  await tick(320)
  check('recusar não escreve',
    (await fsp2.readFile(alvo, 'utf8')) === 'o que o agente escreveu\n',
    JSON.stringify(await fsp2.readFile(alvo, 'utf8')))
  check('e o arquivo continua na lista', changedFiles(session).some((c: any) => c.file === alvo), '')

  key('r')
  await tick(320)
  key('y')
  await tick(360)
  check('confirmar restaura o conteúdo anterior',
    (await fsp2.readFile(alvo, 'utf8')) === 'como estava antes\n',
    JSON.stringify(await fsp2.readFile(alvo, 'utf8')))
  check('e sai da lista de alterações', !changedFiles(session).some((c: any) => c.file === alvo), '')
  check('a tela fecha quando não sobra alteração', !has('↑↓ arquivo'), JSON.stringify(lines().slice(0, 4)))
  check('e diz o que fez', has('restaurado'), JSON.stringify(lines().at(-1)?.slice(0, 110)))

  clearChanges(session)
}

log('--- sequência longa da mesma tool dobra numa linha ---')
{
  // Turno novo: além de reproduzir a sequência real, isso exercita o reset do
  // foco — sem ele o `ctrl+r` continuaria abrindo uma tool de turnos atrás.
  // O caso real: o modelo caçando um arquivo dispara oito Glob seguidos, e as
  // oito linhas dizendo "No files matched" enterram o que importava.
  for (let i = 0; i < 8; i++) {
    session.emit({ type: 'tool-start', id: `f${i}`, name: 'Glob', summary: `glob p${i}`, subject: `**/p${i}*` })
    session.emit({ type: 'tool-end', id: `f${i}`, name: 'Glob', ok: true, preview: 'No files matched.' })
  }
  await tick(320)

  check('mostra a contagem em vez de oito linhas', has('8 chamadas'), JSON.stringify(lines().slice(-14)))
  const comGlob = lines().filter((l: string) => l.includes('Glob')).length
  check('uma linha só para a sequência', comGlob === 1, String(comGlob))
  check('e não lista os padrões do meio', !has('**/p5*'), JSON.stringify(lines().slice(-10)))
  // O assunto da última chamada fica: dobrar não pode trocar ruído por mistério.
  check('mas mantém o assunto da última', has('**/p7*'), JSON.stringify(lines().slice(-10)))

  // A dobra tem de ser destrancável, e pelo gesto que a própria linha anuncia:
  // `ctrl+r`. Uma sequência que só some não é resumo, é informação perdida.
  // Destrancável: clicar na linha dobrada abre a sequência inteira. Uma dobra
  // que só some não é resumo, é informação perdida.
  const dobrada = lines().findIndex((l: string) => l.includes('8 chamadas'))
  check('linha dobrada localizada', dobrada >= 0, String(dobrada))
  key(`${ESC}[<0;10;${dobrada + 1}M`)
  await tick(120)
  key(`${ESC}[<0;10;${dobrada + 1}m`)
  await tick(300)
  check('clicar abre a sequência', !has('8 chamadas'), JSON.stringify(lines().slice(-16)))
  check('e os padrões do meio voltam', has('**/p5*'), JSON.stringify(lines().slice(-16)))

  // Depois de aberta ela FICA aberta enquanto o foco estiver dentro: quem
  // entrou na sequência quer ver a sequência. Ela volta a dobrar no turno
  // seguinte, quando o foco é limpo.
  key('\x12')
  await tick(300)
  check('continua aberta com o foco dentro', has('**/p5*'), JSON.stringify(lines().slice(-12)))
}

log('--- ctrl+y alterna o layout do diff ---')
{
  key('\x19')
  await tick(240)
  check('ctrl+y liga o lado a lado', has('lado a lado'), JSON.stringify(lines().at(-1)?.slice(0, 110)))
  key('\x19')
  await tick(240)
  check('ctrl+y volta pro agrupado', has('diff agrupado'), JSON.stringify(lines().at(-1)?.slice(0, 110)))

  // Clicar só vale no próprio rótulo do atalho: clicar em qualquer linha de uma
  // resposta longa remontava o diff sem que ninguém tivesse pedido.
  session.emit({ type: 'text', text: '\n\n```\ndiff --git a/x.ts b/x.ts\n@@ -1,1 +1,1 @@\n-antes\n+depois\n```\n' })
  session.emit({ type: 'turn-end' })
  await tick(320)

  const hintRow = lines().findIndex(l => l.includes('ctrl+y'))
  check('a régua do diff mostra o atalho', hintRow >= 0, JSON.stringify(lines().slice(0, 6)))
  const proseRow = lines().findIndex(l => l.includes('pergunte, cole um erro'))
  const naProsa = proseRow >= 0 ? proseRow : 1
  key(`${ESC}[<0;5;${naProsa + 1}M`)
  key(`${ESC}[<0;5;${naProsa + 1}m`)
  await tick(240)
  check('clique fora do rótulo não alterna', !has('lado a lado —'), JSON.stringify(lines().at(-1)?.slice(0, 110)))

  if (hintRow >= 0) {
    key(`${ESC}[<0;${lines()[hintRow].indexOf('ctrl+y') + 2};${hintRow + 1}M`)
    key(`${ESC}[<0;${lines()[hintRow].indexOf('ctrl+y') + 2};${hintRow + 1}m`)
    await tick(280)
    check('clique no rótulo alterna', has('lado a lado'), JSON.stringify(lines().at(-1)?.slice(0, 110)))
    key('\x19')
    await tick(200)
  }
}

log('--- /workflows mostra a rodada ---')
{
  key('/workflows\r')
  await tick(320)
  check('/workflows abre o visualizador', has('workflows') && has('desligados'),
    JSON.stringify(lines().filter(l => l.includes('workflow')).slice(0, 3)))
  check('diz como ligar', has('/workflows on liga'), '')
  key(ESC)
  await tick(200)

  key('/workflows on\r')
  await tick(320)
  check('/workflows on liga', has('workflows ligados'), '')

  // Uma rodada de verdade contra o provider falso: o visualizador só é útil se
  // mostrar passo, fase e estado enquanto a coisa anda.
  const { runWorkflow } = await import(`${R}/core/workflow.ts`)
  await runWorkflow(session, {
    script: `export const meta = { name: 'demo', description: 'um passo' }
phase('Passo unico')
log('rodando')
return await agent('diga ok', { label: 'passo-a' })
`,
  })

  key('/workflows\r')
  await tick(400)
  check('mostra o nome da rodada', has('demo'), JSON.stringify(lines().filter(l => l.includes('demo')).slice(0, 2)))
  check('mostra a fase', has('Passo unico'), '')
  check('mostra o passo', has('passo-a'), '')
  check('mostra o log', has('rodando'), '')
  check('diz que terminou', has('terminado'), '')
  key(ESC)
  await tick(200)
  check('esc fecha o visualizador', !has('Passo unico'), '')

  key('/workflows off\r')
  await tick(320)
  check('/workflows off desliga', has('workflows desligados'), '')
}

log('--- /context-all detalha o contexto ---')
{
  // O relatório é longo: na tela só cabe o rabo dele. Então o conteúdo é
  // verificado no formatador, e a tela só precisa provar que ele foi renderizado.
  const { contextReport, formatContextReport } = await import(`${R}/core/contextreport.ts`)
  const text = formatContextReport(session)

  check('mostra o modelo', text.includes('fake/tiny'), '')
  check('mostra a janela', text.includes('| janela |'), '')
  check('separa o setup', /## setup — [\d.]+ tokens/.test(text),
    JSON.stringify(text.split('\n').find(l => l.includes('setup'))))
  check('lista o prompt de sistema', /\| system \| prompt base/.test(text), '')
  check('conta as tools', /## tools — \d+ ativas/.test(text),
    JSON.stringify(text.split('\n').find(l => l.includes('## tools'))))
  check('seção de mcp', /## mcp — \d+\/\d+ conectados/.test(text), '')
  check('seção de assets', /## assets — \d+ skills/.test(text), '')
  check('diz se é medido ou estimado',
    text.includes('estimado') || text.includes('reportado pelo provider'), '')
  check('mostra o agente ativo', /\| agente \| \w+/.test(text), '')
  check('quebra a conversa por papel', text.includes('## conversa') && /\| (user|assistant) \|/.test(text),
    JSON.stringify(text.split('\n').filter(l => l.startsWith('| user')).slice(0, 1)))
  check('lista as tools deferred quando existem',
    !text.includes('deferred') || text.includes('ToolSearch'), '')
  // Os rótulos do setup vinham de uma lista posicional, e bootstrapBlocks descarta
  // os blocos vazios — então tudo depois do primeiro ausente ficava com nome errado.
  check('rótulo do setup não mente sobre MCP',
    !text.includes('| instruções MCP |') || text.includes('conectados'),
    JSON.stringify(text.split('\n').filter(l => l.includes('MCP')).slice(0, 2)))
  check('bloco de ambiente aparece com o próprio nome', text.includes('| ambiente |'),
    JSON.stringify(text.split('\n').filter(l => l.startsWith('| ')).slice(0, 8)))

  key('/context-all\r')
  await waitFor(() => has('tokens') && has('skills'), 6000)
  await tick(300)
  check('renderizado na tela', has('tokens'), JSON.stringify(lines().slice(-14)))
  check('sem servidor MCP da máquina no relatório', /## mcp — 0\/0/.test(text),
    JSON.stringify(text.split('\n').filter(l => l.includes('## mcp'))))

  const r = contextReport(session)
  check('slices têm tokens > 0', r.slices.every(s => s.tokens >= 0) && r.slices.length > 0,
    JSON.stringify(r.slices.map(s => `${s.label}=${s.tokens}`)))
  check('system aparece nos slices', r.slices.some(s => s.label === 'system' && s.tokens > 0),
    JSON.stringify(r.slices.map(s => s.label)))
  check('tools ativas listadas', r.tools.active.length > 0, String(r.tools.active.length))
  check('conversa contabilizada por papel', r.messages.length > 0, JSON.stringify(r.messages))
  check('limite vem do modelo', r.limit === 1000, String(r.limit))
}

log('--- exit ---')
key('\x04')
await tick(200)
await Promise.race([running, tick(1500)])

;(process.stdout as any).write = realWrite
log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
