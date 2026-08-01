// Primitivos de render + degradacao. A trilha vem do ambiente, porque os
// modulos leem env no load — cada trilha roda num processo proprio.
const { SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const strip = (s: string) => s.replace(ANSI, '')

Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })

const theme = await import(`${R}/tui/theme.ts`)
const render = await import(`${R}/tui/render.ts`)

const track = process.argv[2] ?? '256'
let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) pass++
  else { fail++; console.log(`FAIL [${track}] ${n} ${d}`) }
}

if (track === '256') {
  check('level 2 (256 cores)', theme.level === 2, String(theme.level))
  check('accent indice 173', theme.c.accent('x').includes('38;5;173'))
  check('info indice 109', theme.c.info('x').includes('38;5;109'))
  check('warn indice 179', theme.c.warn('x').includes('38;5;179'))
  check('danger indice 167', theme.c.danger('x').includes('38;5;167'))
  check('meta indice 139', theme.c.meta('x').includes('38;5;139'))
  check('bar background 236', theme.barLine('x').includes('48;5;236'))
  check('selected background 237', theme.selected('x').includes('48;5;237'))
  check('glifo box unicode', theme.g.boxTopLeft === '╭')
  check('spinner braille', theme.g.spinner[0] === '⠋')

  const b = render.box(['linha'], 30, { title: 'demo', paint: theme.c.info })
  check('box 3 linhas', b.length === 3, String(b.length))
  check('box largura exata', b.every((l: string) => render.visibleWidth(l) === 30), b.map((l: string) => render.visibleWidth(l)).join(','))
  check('box titulo no topo', strip(b[0]).startsWith('╭─ demo '), strip(b[0]))

  const r = render.rule(40, { label: 'contexto compactado', detail: '5.6k', paint: theme.c.meta })
  check('rule largura', render.visibleWidth(r) === 40, String(render.visibleWidth(r)))
  check('rule com label', strip(r).includes('contexto compactado'))

  check('split alinha direita', render.visibleWidth(render.split('a', 'b', 20)) === 20)
  // Uma linha mais larga que a coluna quebra no terminal e desloca todas as de
  // baixo — foi o que um nome de arquivo comprido ao lado do `+n -n` fez na tela
  // de alterações. `split` corta a esquerda em vez de estourar.
  {
    const largo = render.split('  PixWebhookTesteFalhouException.java', '+13 -0 ', 38)
    check('split nunca passa da largura', render.visibleWidth(largo) === 38, String(render.visibleWidth(largo)))
    check('split preserva a direita ao cortar', strip(largo).trimEnd().endsWith('+13 -0'), JSON.stringify(strip(largo)))
    check('split marca o corte', strip(largo).includes(theme.g.ellipsis), JSON.stringify(strip(largo)))
    const colorido = render.split(theme.c.fg('  ArquivoComNomeMuitoLongoDemais.java'), theme.c.ok('+9 -0 '), 30)
    check('split conta largura visível, não bytes ANSI',
      render.visibleWidth(colorido) === 30, String(render.visibleWidth(colorido)))
  }
  check('truncate respeita largura', render.visibleWidth(render.truncate('x'.repeat(50), 10)) === 10)
  check('gauge largura', render.visibleWidth(render.gauge(0.5, 20)) === 20)
  check('sparkline 8 niveis', theme.sparkline([0, 0.5, 1]) === '▁▅█', theme.sparkline([0, 0.5, 1]))

  const md = render.renderMarkdown('# Titulo\n- item **forte** e `code`\n> citado', 40)
  check('markdown heading sem #', !strip(md[0]).includes('#'), strip(md[0]))
  check('markdown h1 ganha regua', /^[─]+$/.test(strip(md[1]).trim()), strip(md[1]))
  check('markdown bullet com rail', strip(md[2]).includes('▏'), strip(md[2]))
  check('markdown citacao com rail', strip(md[3]).includes('▏'), strip(md[3]))

  const TABELA = [
    '| provider | modelo | janela |',
    '|---|---|---:|',
    '| anthropic | opus | 1000000 |',
    '| 9router | sonnet | 32000 |',
  ].join('\n')
  const tab = render.renderMarkdown(TABELA, 60).map(strip)
  check('tabela nao vaza pipe do markdown', !tab.some(l => l.includes('|---')), JSON.stringify(tab[1]))
  check('tabela cabe na largura', tab.every(l => render.visibleWidth(l) <= 60), JSON.stringify(tab.map(l => l.length)))
  check('tabela tem regua de cabecalho', /^─+┼─+┼─+$/.test(tab[1]), JSON.stringify(tab[1]))
  check('colunas alinhadas na mesma coluna',
    tab[2].indexOf('│') === tab[3].indexOf('│') && tab[2].indexOf('│') === tab[0].indexOf('│'),
    JSON.stringify(tab.slice(0, 4)))
  check('numero vai para a direita', /1000000$/.test(tab[2]) && /32000$/.test(tab[3]), JSON.stringify(tab.slice(2)))
  check('sem linha entre linhas curtas', tab.length === 4, JSON.stringify(tab))

  // Célula que não cabe **quebra**, não some: truncar a única coluna que carrega
  // a resposta é o defeito que motivou o renderer de tabela.
  const LONGA = [
    '| chave | descricao |',
    '|---|---|',
    '| a | um texto bem mais longo do que a coluna aguenta e que precisa quebrar |',
  ].join('\n')
  const longa = render.renderMarkdown(LONGA, 40).map(strip)
  check('celula larga quebra em varias linhas', longa.length > 3, JSON.stringify(longa))
  check('nada de reticencia na celula', !longa.some(l => l.includes('…')), JSON.stringify(longa))
  check('continuacao fica na coluna certa',
    longa[3].indexOf('│') === longa[2].indexOf('│'), JSON.stringify(longa.slice(2, 4)))

  // Larga demais para grade: vira registro em vez de picar palavra ao meio.
  const registro = render.renderMarkdown(
    ['| provider | modelo | janela | custo |', '|---|---|---|---|', '| anthropic | claude-opus-5 | 1000000 | 25.00 |'].join('\n'),
    40,
  ).map(strip)
  check('estreito vira registro', registro.some(l => l.startsWith('▌ anthropic')), JSON.stringify(registro))
  check('registro rotula os campos', registro.some(l => l.includes('modelo') && l.includes('claude-opus-5')), JSON.stringify(registro))
  check('registro nao parte palavra', !registro.some(l => /provid$/.test(l)), JSON.stringify(registro))

  const pipe = render.renderMarkdown(['| re | uso |', '|---|---|', '| `a\\|b` | alterna |'].join('\n'), 60).map(strip)
  check('pipe escapado nao vira coluna', pipe[2].includes('a|b'), JSON.stringify(pipe))

  const inline = strip(render.renderMarkdown('*enfase* ~~riscado~~ [texto](http://x.dev)', 60)[0])
  check('marcadores inline somem', !inline.includes('*') && !inline.includes('~~') && !inline.includes('['), inline)
  check('link mantem url visivel', inline.includes('texto') && inline.includes('http://x.dev'), inline)
  check('snake_case intacto', strip(render.renderMarkdown('tool_input e __init__', 60)[0]) === 'tool_input e __init__',
    strip(render.renderMarkdown('tool_input e __init__', 60)[0]))

  const DIFF = [
    'diff --git a/src/Boleto.java b/src/Boleto.java',
    'index e4926ec..8275ef5 100644',
    '--- a/src/Boleto.java',
    '+++ b/src/Boleto.java',
    '@@ -10,3 +10,4 @@ class Boleto',
    '     private final Repo repo;',
    '-    void cancelar(Long id) {',
    '+    void cancelar(Long id, String motivo) {',
    '+        auditoria.registrar(id);',
    ' }',
  ].join('\n')
  const dif = render.renderDiff(DIFF, 60)
  const plain = dif.map(strip)
  check('diff mostra o arquivo no topo', plain[0].includes('src/Boleto.java'), plain[0])
  check('diff esconde index/---/+++', !plain.some(l => l.includes('index e4926ec') || l.includes('+++ b/')), JSON.stringify(plain))
  check('diff mostra a faixa do hunk', plain[1].includes('10,3') && plain[1].includes('10,4'), plain[1])
  check('diff leva o contexto do hunk', plain[1].includes('class Boleto'), plain[1])
  check('diff numera os dois lados', /^\s+10\s+10\s/.test(plain[2]), JSON.stringify(plain[2]))
  check('linha removida so tem numero antigo', /^\s+11\s+-\s/.test(plain[3]) && !/11\s+11/.test(plain[3]), JSON.stringify(plain[3]))
  check('linha adicionada so tem numero novo', /^\s{5}\s+11\s\+/.test(plain[4]), JSON.stringify(plain[4]))
  check('linhas novas continuam a numeracao', /\s12\s\+/.test(plain[5]), JSON.stringify(plain[5]))
  check('diff preserva indentacao do codigo', plain[2].includes('    private final Repo repo;'), JSON.stringify(plain[2]))
  check('faixa cobre a largura', dif.slice(3, 6).every(l => render.visibleWidth(l) === 60),
    JSON.stringify(dif.slice(3, 6).map(l => render.visibleWidth(l))))
  // 256 ou 24 bits: o que importa é a banda reabrir depois de cada reset.
  check('banda sobrevive ao reset interno',
    (dif[4].match(/48;(5;22|2;\d+;\d+;\d+)m/g) ?? []).length > 1, JSON.stringify(dif[4]).slice(0, 120))
  check('banda usa o pastel claro', /48;2;230;255;236m|48;5;194m/.test(dif[4]), JSON.stringify(dif[4]).slice(0, 80))
  check('texto dentro da banda fica escuro', /38;2;36;41;47m|38;5;235m/.test(dif[4]), JSON.stringify(dif[4]).slice(0, 120))

  // Realce intra-linha vale para par 1:1 (uma removida, uma adicionada). Um bloco
  // de 1 removida e 2 adicionadas é reescrita, não edição de linha.
  // O realce do trecho mudado e um fundo pastel mais forte, nao negrito.
  const SPAN = new RegExp(`${ESC}\\[(?:48;2;166;240;186|48;5;157)m`)
  const par = render.renderDiff(
    ['@@ -1,1 +1,1 @@', '-    status = CANCELADO;', '+    status = CANCELADO_PELO_USUARIO;'].join('\n'),
    60,
  )
  check('realce marca o trecho que mudou', SPAN.test(par[2]), JSON.stringify(par[2]).slice(0, 200))
  const spanAt = par[2].search(SPAN)
  check('realce cobre so o sufixo novo',
    strip(par[2].slice(spanAt)).startsWith('_PELO_USUARIO'),
    JSON.stringify(strip(par[2].slice(spanAt))).slice(0, 120))
  const semPar = render.renderDiff(
    ['@@ -1,1 +1,2 @@', '-    a();', '+    b();', '+    c();'].join('\n'),
    60,
  )
  check('bloco reescrito nao inventa realce',
    !semPar.slice(1).some(l => SPAN.test(l)), JSON.stringify(semPar).slice(0, 200))

  const largo = render.renderDiff(
    ['@@ -1,1 +1,1 @@', '+        if (valor == null || valor.compareTo(BigDecimal.ZERO) <= 0) { return false; }'].join('\n'),
    46,
  ).map(strip)
  check('linha longa quebra em vez de sumir', largo.length > 2, JSON.stringify(largo))
  check('quebra nao come a indentacao', largo[1].includes('        if (valor'), JSON.stringify(largo[1]))
  check('continuacao fica pendurada sob o codigo', /^\s{15,}/.test(largo[2]), JSON.stringify(largo[2]))

  // O caso real: o modelo roda `git diff` e cola a saída na resposta. Dentro de
  // cerca ou solto, tem de sair como diff — antes virava código cinza atrás do
  // trilho, sem número e sem banda.
  const cercado = render.renderMarkdown(
    ['Resultado:', '', '```', 'diff --git a/A.java b/A.java', '@@ -1,1 +1,2 @@', ' ctx', '+nova', '```', 'Fim.'].join('\n'),
    50,
  )
  const cercadoPlano = cercado.map(strip)
  check('diff dentro de cerca vira diff', cercadoPlano.some(l => l.includes('A.java') && l.includes('───')),
    JSON.stringify(cercadoPlano))
  check('diff cercado ganha numeracao', cercadoPlano.some(l => /^\s+1\s+1\s+ctx/.test(l)), JSON.stringify(cercadoPlano))
  check('texto fora da cerca continua texto',
    cercadoPlano[0] === 'Resultado:' && cercadoPlano.at(-1) === 'Fim.', JSON.stringify(cercadoPlano.slice(0, 2)))

  const java = render.renderMarkdown(['```java', 'int x = 1;', '```'].join('\n'), 40).map(strip)
  check('codigo que nao e diff mantem o trilho', java[0].startsWith('▏'), JSON.stringify(java))

  const solto = render.renderMarkdown(['Veja:', '@@ -1,1 +1,2 @@', ' ctx', '+nova', '', 'Depois.'].join('\n'), 50).map(strip)
  check('diff sem cerca tambem e detectado', solto.some(l => /^\s+1\s+1\s+ctx/.test(l)), JSON.stringify(solto))
  check('paragrafo depois do diff sobrevive', solto.at(-1) === 'Depois.', JSON.stringify(solto.slice(-2)))

  const DIFF_PAR = [
    'diff --git a/A.java b/A.java',
    '@@ -1,3 +1,3 @@',
    ' contexto',
    '-    int x = 1;',
    '+    int x = 2;',
  ].join('\n')
  const lado = render.renderDiff(DIFF_PAR, 100, { layout: 'split', hint: 'ctrl+y agrupado' }).map(strip)
  check('lado a lado tem duas colunas', lado[2].split('│').length === 2, JSON.stringify(lado[2]))
  check('lado a lado alinha antes e depois na mesma linha',
    lado[3].includes('int x = 1;') && lado[3].includes('int x = 2;'), JSON.stringify(lado[3]))
  check('cada coluna tem o proprio numero', /^\s+1\s+contexto/.test(lado[2]) && lado[2].split('│')[1].includes('1'),
    JSON.stringify(lado[2]))
  check('dica do atalho aparece na regua', lado[0].includes('ctrl+y agrupado'), JSON.stringify(lado[0]))
  check('largura exata nas duas colunas', lado.slice(2).every(l => render.visibleWidth(l) === 100),
    JSON.stringify(lado.slice(2).map(l => render.visibleWidth(l))))

  // O bug que aparecia na tela: a linha longa quebrava e a continuacao passava do
  // quadro, entao o truncate final comia os ultimos caracteres do lado direito.
  const LONGA_SPLIT = [
    'diff --git a/A.java b/A.java',
    '@@ -1,1 +1,1 @@',
    '-    private static final Logger log = Logger.getLogger(BoletoService.class.getName());',
    '+    private static final Logger log = Logger.getLogger(BoletoServiceNovo.class.getName());',
  ].join('\n')
  for (const largura of [100, 120, 140]) {
    const linhas = render.renderDiff(LONGA_SPLIT, largura, { layout: 'split' })
    check(`split ${largura}: nenhuma linha passa da largura`,
      linhas.every(l => render.visibleWidth(l) <= largura),
      JSON.stringify(linhas.map(l => render.visibleWidth(l))))
    const linhasU = render.renderDiff(LONGA_SPLIT, largura, { layout: 'unified' })
    check(`agrupado ${largura}: nenhuma linha passa da largura`,
      linhasU.every(l => render.visibleWidth(l) <= largura),
      JSON.stringify(linhasU.map(l => render.visibleWidth(l))))
  }
  const quebrada = render.renderDiff(LONGA_SPLIT, 100, { layout: 'split' }).map(strip)
  check('continuacao guarda o texto inteiro',
    quebrada.join('').includes('getName());'), JSON.stringify(quebrada))

  const estreito = render.renderDiff(DIFF_PAR, 50, { layout: 'split' }).map(strip)
  check('estreito volta pro agrupado', estreito.some(l => /^\s+2\s+\d+\s+-/.test(l) || /-\s+int x = 1;/.test(l)),
    JSON.stringify(estreito))
  check('agrupado nao tem coluna dupla', !estreito.slice(2).some(l => l.includes('│')), JSON.stringify(estreito))

  const numerado = render.renderDiff('  12 + adicionada\n  13 - removida', 40).map(strip)
  check('formato numerado das tools segue funcionando',
    numerado[0].includes('12 + adicionada') && numerado[1].includes('13 - removida'), JSON.stringify(numerado))

  const listas = render.renderMarkdown('1. um\n2. dois\n- [x] feito\n- [ ] pendente\n\n---', 40).map(strip)
  check('lista ordenada mantem numero', listas[0].startsWith('1. um') && listas[1].startsWith('2. dois'), JSON.stringify(listas))
  check('task marcada com check', listas[2].startsWith('✔'), JSON.stringify(listas[2]))
  check('task pendente com circulo', listas[3].startsWith('○'), JSON.stringify(listas[3]))
  check('regua horizontal ocupa a largura', render.visibleWidth(listas.at(-1) ?? '') === 40, String(render.visibleWidth(listas.at(-1) ?? '')))
} else if (track === 'nocolor') {
  check('NO_COLOR -> level 0', theme.level === 0, String(theme.level))
  check('sem sequencia de cor', !theme.c.accent('x').includes('38;5;'))
  check('mantem glifos', theme.g.ok === '✔')
  check('peso por dim', theme.c.dim('x').includes('2m'))
  check('peso por bold', theme.strong('x').includes('1m'))
  const b = render.box(['x'], 20)
  check('mantem box-drawing', strip(b[0]).startsWith('╭'), strip(b[0]))
  check('barLine sem background', theme.barLine('x') === 'x')
} else if (track === 'ascii') {
  check('box vira +-|', theme.g.boxTopLeft === '+' && theme.g.boxH === '-' && theme.g.boxV === '|')
  check('braille vira |/-\\', theme.g.spinner.join('') === '|/-\\')
  check('prompt vira >', theme.g.prompt === '>')
  check('estado vira v/x', theme.g.ok === 'v' && theme.g.fail === 'x')
  const b = render.box(['x'], 20, { title: 't' })
  check('box sem unicode', !/[╭╮╰╯│─]/.test(strip(b.join(''))), strip(b[0]))
  check('largura mantida', b.every((l: string) => render.visibleWidth(l) === 20))

  const tab = render
    .renderMarkdown(['| a | b |', '|---|---|', '| 1 | 2 |'].join('\n'), 40)
    .map(strip)
  check('tabela sem box-drawing', !/[│─┼╌]/.test(tab.join('')), JSON.stringify(tab))
  check('tabela usa | e -', tab[0].includes('|') && /^[-+]+$/.test(tab[1]), JSON.stringify(tab.slice(0, 2)))
}

console.log(`[${track}] ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
