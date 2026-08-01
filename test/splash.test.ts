// A tela de carregamento do launcher.
//
// O que importa aqui não é ser bonita: é não sujar o terminal de quem não pediu
// (pipe, CI, `--version`), não segurar o processo vivo, ficar centrada, e
// entregar a tela alternativa para a TUI sem piscar o shell no meio.

const { SRC: R, reporter } = await import('./helpers.ts')
const { check, log, done } = reporter()

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g

/** Um stdout falso: registra tudo que foi escrito, sem precisar de terminal. */
function fakeOut(opts: { isTTY?: boolean; columns?: number; rows?: number } = {}): any {
  const chunks: string[] = []
  return {
    isTTY: opts.isTTY ?? true,
    columns: opts.columns ?? 80,
    rows: opts.rows ?? 24,
    write: (s: string) => {
      chunks.push(s)
      return true
    },
    /** O que foi escrito a partir de um índice — para isolar o que o `stop` fez. */
    since: (n: number) => chunks.slice(n).join(''),
    all: () => chunks.join(''),
    visible: () => chunks.join('').replace(ANSI, ''),
    count: () => chunks.length,
  }
}

/**
 * Cada pedaço posicionado: `ESC[linha;colunaH` seguido do texto até o próximo
 * posicionamento. É assim que dá para afirmar coisa sobre layout — sem isso, o
 * `visible()` cola tudo numa linha só e qualquer medida de largura é ficção.
 */
function pieces(raw: string): { row: number; col: number; text: string }[] {
  const out: { row: number; col: number; text: string }[] = []
  const re = /\x1b\[(\d+);(\d+)H/g
  let m: RegExpExecArray | null
  const marks: { row: number; col: number; at: number }[] = []
  while ((m = re.exec(raw))) {
    marks.push({ row: Number(m[1]), col: Number(m[2]), at: m.index + m[0].length })
  }
  marks.forEach((mark, i) => {
    const end = i + 1 < marks.length ? raw.lastIndexOf('\x1b[', marks[i + 1].at) : raw.length
    out.push({ row: mark.row, col: mark.col, text: raw.slice(mark.at, end).replace(ANSI, '') })
  })
  return out
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const antes: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(vars)) {
    antes[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    await fn()
  } finally {
    for (const [k, v] of Object.entries(antes)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  }
}

const { startSplash } = await import(`${R}/tui/splash.ts`)
const { PRESETS, DEFAULT_PRESET } = await import(`${R}/tui/theme.ts`)

log('--- desenha o que foi pedido ---')
{
  const out = fakeOut()
  const s = startSplash(out)
  await wait(150)
  s.stop()
  const vis = out.visible()

  check('mostra o nome', vis.includes('█▀▄ █ █ ▀█▀ █▀▀'), JSON.stringify(vis.slice(0, 60)))
  check('mostra a frase', vis.includes('Relaxa que eu não vou dominar o mundo, ou melhor, ainda não.'), '')
  check('mostra a barra', /[█▓░]/.test(vis), '')
  check('animou (mais de um frame)', out.count() > 3, String(out.count()))
}

log('--- limpa e centraliza ---')
{
  const out = fakeOut({ columns: 100, rows: 30 })
  const s = startSplash(out)
  await wait(80)
  const inicio = out.all()
  s.stop()

  check('entra na tela alternativa', inicio.startsWith('\x1b[?1049h'), JSON.stringify(inicio.slice(0, 20)))
  check('esconde o cursor', inicio.includes('\x1b[?25l'), '')
  check('limpa a tela antes de desenhar', inicio.includes('\x1b[2J'), '')

  const p = pieces(inicio)
  check('tem os pedaços do bloco (3 do nome + barra + estágio + frase)', p.length >= 5, String(p.length))

  const linhas = [...new Set(p.map(x => x.row))].sort((a, b) => a - b)
  const alto = linhas[0]
  const baixo = linhas.at(-1)!
  // Centrado na vertical: o espaço acima e abaixo do bloco tem de bater.
  check('centrado na vertical', Math.abs(alto - 1 - (30 - baixo)) <= 1, `topo ${alto}, base ${baixo}, de 30`)

  // Centrado na horizontal: cada pedaço com conteúdo tem o mesmo espaço dos dois
  // lados. Os vazios são o posicionamento da limpeza de linha do estágio, não
  // texto — medir centralização neles seria medir o cursor.
  const desalinhado = p
    .filter(x => x.text.length > 0)
    .filter(x => Math.abs(x.col - 1 - (100 - (x.col - 1 + x.text.length))) > 1)
  check('cada pedaço centrado na horizontal', desalinhado.length === 0,
    JSON.stringify(desalinhado.map(x => [x.col, x.text.length])))
}

log('--- linha de estágio ---')
{
  const out = fakeOut({ columns: 100, rows: 30 })
  const s = startSplash(out)
  await wait(40)
  const semEstagio = pieces(out.all())
  check('sem estágio, nada é escrito ali',
    !semEstagio.some(x => x.text.includes('lendo')), JSON.stringify(semEstagio.map(x => x.text)))

  const antes = out.count()
  s.stage('lendo a configuração')
  check('stage pinta na hora, sem esperar o tick', out.count() > antes, '')
  const comEstagio = pieces(out.since(antes))
  check('o rótulo aparece', comEstagio.some(x => x.text.includes('lendo a configuração')),
    JSON.stringify(comEstagio.map(x => x.text)))

  // Espaçamento: linha em branco entre o nome e a barra, e outra entre o
  // estágio e a frase — sem isso vira três linhas empilhadas.
  const linhas = [...new Set(pieces(out.all()).filter(x => x.text.trim()).map(x => x.row))].sort((a, b) => a - b)
  const nome = linhas.slice(0, 3)
  const barra = linhas[3]
  const estagio = linhas[4]
  const frase = linhas.at(-1)!
  check('linha em branco entre o nome e a barra', barra === nome.at(-1)! + 2, JSON.stringify(linhas))
  check('estágio logo abaixo da barra', estagio === barra + 1, JSON.stringify(linhas))
  check('linha em branco entre o estágio e a frase', frase === estagio + 2, JSON.stringify(linhas))

  const antesTroca = out.count()
  s.stage('preparando o MCP')
  const troca = out.since(antesTroca)
  check('trocar de estágio limpa a linha inteira antes',
    troca.includes('[2K'), JSON.stringify(troca.slice(0, 80)))
  check('e o rótulo antigo não sobra',
    !pieces(troca).some(x => x.text.includes('lendo')), JSON.stringify(pieces(troca).map(x => x.text)))

  s.stage('x'.repeat(200))
  const longo = pieces(out.since(out.count() - 1)).find(x => x.text.includes('x'))
  check('rótulo comprido é truncado, não estoura', (longo?.text.length ?? 0) <= 100, String(longo?.text.length))

  s.stop()
  const antesFim = out.count()
  s.stage('depois do fim')
  check('stage depois do stop não escreve', out.count() === antesFim, '')
}

log('--- a barra realmente se move ---')
{
  const out = fakeOut()
  const s = startSplash(out)
  await wait(260)
  s.stop()
  const barras = new Set(
    pieces(out.all())
      .filter(x => /[█▓░]/.test(x.text) && !x.text.includes('▀'))
      .map(x => x.text),
  )
  check('a barra muda entre frames', barras.size > 1, `${barras.size} estados distintos`)
}

log('--- entrega a tela para a TUI, ou devolve ao shell ---')
{
  const paraTui = fakeOut()
  const a = startSplash(paraTui)
  await wait(60)
  const antesA = paraTui.count()
  a.stop({ keepAltScreen: true })
  const doStopA = paraTui.since(antesA)
  check('handover limpa a tela', doStopA.includes('\x1b[2J'), JSON.stringify(doStopA))
  check('e NÃO sai da tela alternativa', !doStopA.includes('\x1b[?1049l'), JSON.stringify(doStopA))

  const paraShell = fakeOut()
  const b = startSplash(paraShell)
  await wait(60)
  const antesB = paraShell.count()
  b.stop()
  const doStopB = paraShell.since(antesB)
  check('sem handover sai da tela alternativa', doStopB.includes('\x1b[?1049l'), JSON.stringify(doStopB))
  check('e devolve o cursor', doStopB.includes('\x1b[?25h'), JSON.stringify(doStopB))
  check('sem deixar nada visível', doStopB.replace(ANSI, '').trim() === '', JSON.stringify(doStopB.replace(ANSI, '')))

  const depois = paraShell.count()
  b.stop()
  check('stop duas vezes não escreve de novo', paraShell.count() === depois, '')
}

log('--- a cor vem do tema, não de um número solto ---')
{
  const out = fakeOut()
  const s = startSplash(out)
  await wait(60)
  s.stop()
  const esperado = `38;5;${PRESETS[DEFAULT_PRESET]!.accent}m`
  check('o accent é o do preset padrão do tema', out.all().includes(esperado), esperado)
  check('e não é a cor rosa que estava chumbada', !out.all().includes('38;5;175m'), '')

  await withEnv({ BYTECODE_THEME: 'emerald' }, async () => {
    const o = fakeOut()
    const t = startSplash(o)
    await wait(60)
    t.stop()
    check('BYTECODE_THEME troca o accent',
      o.all().includes(`38;5;${PRESETS.emerald!.accent}m`), `esperava ${PRESETS.emerald!.accent}`)
  })
}

log('--- não desenha onde não deve ---')
{
  const semTty = fakeOut({ isTTY: false })
  startSplash(semTty).stop()
  check('pipe/redirecionamento não recebe nada', semTty.count() === 0, String(semTty.count()))

  await withEnv({ BYTECODE_NO_SPLASH: '1' }, async () => {
    const out = fakeOut()
    startSplash(out).stop()
    check('BYTECODE_NO_SPLASH desliga', out.count() === 0, String(out.count()))
  })
}

log('--- se adapta ao terminal ---')
{
  const estreito = fakeOut({ columns: 24, rows: 12 })
  const s = startSplash(estreito)
  await wait(60)
  s.stop()
  const p = pieces(estreito.all())
  check('terminal estreito usa o nome curto',
    p.some(x => x.text.includes('ByteCode')), JSON.stringify(p.map(x => x.text)))
  const estoura = p.filter(x => x.col - 1 + x.text.length > 24)
  check('nenhum pedaço passa da largura', estoura.length === 0,
    JSON.stringify(estoura.map(x => [x.col, x.text.length, x.text])))

  await withEnv({ BYTECODE_ASCII: '1' }, async () => {
    const out = fakeOut()
    const a = startSplash(out)
    await wait(60)
    a.stop()
    const v = out.visible()
    check('modo ascii não usa bloco', !/[█▓░▀▄]/.test(v), JSON.stringify(v.slice(0, 80)))
    check('e ainda mostra a frase', v.includes('Relaxa'), '')
  })

  await withEnv({ NO_COLOR: '1' }, async () => {
    const out = fakeOut()
    const a = startSplash(out)
    await wait(60)
    a.stop()
    check('NO_COLOR não emite cor', !out.all().includes('38;5;'), '')
  })
}

log('--- não segura o processo vivo ---')
{
  const out = fakeOut()
  const s = startSplash(out)
  // O timer é unref'd: se não fosse, um `bytecode` que falhasse antes do stop
  // ficaria pendurado para sempre em vez de sair.
  const handles = (process as never as { _getActiveHandles?: () => unknown[] })._getActiveHandles?.() ?? []
  const vivos = handles.filter(
    (h: any) => h?.constructor?.name === 'Timeout' && h.hasRef?.() && h._idleTimeout === 60,
  )
  check('o timer da animação não conta como handle ativo', vivos.length === 0, String(vivos.length))
  s.stop()
}

done()
