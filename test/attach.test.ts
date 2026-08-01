// Sem isto o suite so passa via `npm test`: rodado direto, ele iria falar com
// o clipboard real da maquina.
process.env.BYTECODE_FAKE_CLIPBOARD = '1'

const { SRC: R } = await import('./helpers.ts')

// Anexos: colar imagem e dobrar texto grande no composer.

const A = await import(`${R}/tui/attach.ts`)
const clip = await import(`${R}/util/clipboard.ts`)

let pass = 0
let fail = 0
const log = (...a: unknown[]) => process.stdout.write(a.join(' ') + '\n')
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) {
    pass++
    log(`  ok   ${name}`)
  } else {
    fail++
    log(`  FAIL ${name} ${detail}`)
  }
}

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(64, 7),
])
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 3)])

log('--- 01 · sniff de formato ---')
{
  check('png', clip.sniffImageType(PNG) === 'image/png', String(clip.sniffImageType(PNG)))
  check('jpeg', clip.sniffImageType(JPEG) === 'image/jpeg', String(clip.sniffImageType(JPEG)))
  check('gif', clip.sniffImageType(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(16)])) === 'image/gif', '')
  check(
    'webp',
    clip.sniffImageType(
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(16)]),
    ) === 'image/webp',
    '',
  )
  // Texto não vira imagem: colar um log não pode ser lido como anexo binário.
  check('texto não é imagem', clip.sniffImageType(Buffer.from('erro: NullPointer'.repeat(4))) === null, '')
  check('buffer curto não estoura', clip.sniffImageType(Buffer.from([0x89])) === null, '')
}

log('--- 02 · quando dobrar um paste ---')
{
  check('linha curta não dobra', !A.shouldFold('só uma linha de erro'), '')
  check('paste de 3 linhas não dobra', !A.shouldFold('a\nb\nc'), '')
  check('paste longo dobra', A.shouldFold('x'.repeat(A.PASTE_FOLD_CHARS)), '')
  check('paste alto dobra', A.shouldFold('linha\n'.repeat(A.PASTE_FOLD_LINES + 2)), '')
  check('conta linhas', A.countLines('a\nb\nc') === 3, String(A.countLines('a\nb\nc')))
}

log('--- 03 · placeholder e expansão ---')
{
  const store = new A.AttachmentStore()
  const stack = 'at com.foo.Bar(Bar.java:42)\n'.repeat(80)
  const att = store.addText(stack)
  const marker = A.placeholderFor(att)

  check('marcador tem id e tamanho', /^\[Pasted text #1 \+81 lines\]$/.test(marker), marker)

  const input = `olha esse erro ${marker} o que é?`
  const out = A.expand(input, store)
  check('expande de volta ao texto original', out.text.includes(stack), '')
  check('mantém o que foi digitado em volta', out.text.startsWith('olha esse erro '), '')
  check('termina com o resto da frase', out.text.endsWith(' o que é?'), '')
  check('sem imagens', out.images.length === 0, '')

  // O marcador é o controle: apagou o marcador, o anexo não vai junto.
  const semMarcador = A.expand('olha esse erro  o que é?', store)
  check('apagar o marcador remove o anexo', !semMarcador.text.includes('com.foo.Bar'), '')
}

log('--- 04 · imagem vira content part ---')
{
  const store = new A.AttachmentStore()
  const img = store.addImage(PNG, 'image/png')
  const input = `o que tem em ${A.placeholderFor(img)}?`
  const out = A.expand(input, store)

  check('marcador de imagem fica no texto', out.text.includes('[Image #1]'), out.text)
  check('imagem sai como anexo', out.images.length === 1, String(out.images.length))

  const content = A.userContent(out.text, out.images) as { type: string; image?: Buffer; mediaType?: string }[]
  check('vira array de partes', Array.isArray(content), typeof content)
  check('primeira parte é o texto', content[0].type === 'text', content[0].type)
  check('segunda parte é a imagem', content[1].type === 'image', content[1].type)
  check('carrega os bytes', Buffer.isBuffer(content[1].image) && content[1].image.equals(PNG), '')
  check('carrega o mediaType', content[1].mediaType === 'image/png', String(content[1].mediaType))

  // Sem imagem o content continua string: o caminho comum não muda de forma.
  check('sem imagem continua string', typeof A.userContent('oi', []) === 'string', '')
}

log('--- 05 · várias imagens e ordem ---')
{
  const store = new A.AttachmentStore()
  const a = store.addImage(PNG, 'image/png')
  const b = store.addImage(JPEG, 'image/jpeg')
  const out = A.expand(`antes ${A.placeholderFor(a)} meio ${A.placeholderFor(b)} fim`, store)
  check('duas imagens', out.images.length === 2, String(out.images.length))
  check('na ordem em que aparecem', out.images[0].id === a.id && out.images[1].id === b.id, '')
  check('ids não repetem', a.id !== b.id, '')
  // A mesma imagem citada duas vezes é enviada uma vez só.
  const twice = A.expand(`${A.placeholderFor(a)} e de novo ${A.placeholderFor(a)}`, store)
  check('não duplica a mesma imagem', twice.images.length === 1, String(twice.images.length))
}

log('--- 06 · store esquece o que saiu do composer ---')
{
  const store = new A.AttachmentStore()
  const a = store.addText('x'.repeat(2000))
  const b = store.addImage(PNG, 'image/png')
  check('dois anexos vivos', store.size === 2, String(store.size))
  check('live lê do input', store.live(A.placeholderFor(b)).length === 1, '')

  store.sweep(A.placeholderFor(a))
  check('sweep mantém o referenciado', store.get(a.id) !== undefined, '')
  check('sweep descarta o resto', store.get(b.id) === undefined, '')
  store.sweep('')
  check('sweep vazio limpa tudo', store.size === 0, String(store.size))
}

log('--- 07 · caminho de imagem colado ---')
{
  check('png simples', A.imagePathIn('/tmp/foto.png') === '/tmp/foto.png', '')
  check('com aspas', A.imagePathIn('"C:\\fotos\\a b.png"') === 'C:\\fotos\\a b.png', String(A.imagePathIn('"C:\\fotos\\a b.png"')))
  check('espaço escapado', A.imagePathIn('/tmp/a\\ b.jpg') === '/tmp/a b.jpg', String(A.imagePathIn('/tmp/a\\ b.jpg')))
  check('maiúscula', A.imagePathIn('/tmp/A.PNG') === '/tmp/A.PNG', '')
  check('com espaço em volta', A.imagePathIn('  /tmp/x.gif \n') === '/tmp/x.gif', String(A.imagePathIn('  /tmp/x.gif \n')))
  // Não é caminho de imagem: tem que continuar sendo texto normal.
  check('texto comum não vira caminho', A.imagePathIn('me ajuda com isso') === null, '')
  check('.ts não é imagem', A.imagePathIn('/src/app.ts') === null, '')
  check('multi-linha não é caminho', A.imagePathIn('/tmp/a.png\n/tmp/b.png') === null, '')
  check('vazio', A.imagePathIn('   ') === null, '')
}

log('--- 08 · ler arquivo de imagem ---')
{
  const { promises: fsp } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bytecode-attach-'))

  const good = path.join(dir, 'ok.png')
  await fsp.writeFile(good, PNG)
  const ok = await A.readImageFile(good, dir)
  check('lê png do disco', ok.ok === true && ok.mediaType === 'image/png', JSON.stringify(ok))

  // Caminho relativo resolve contra o cwd da sessão.
  const rel = await A.readImageFile('ok.png', dir)
  check('caminho relativo resolve', rel.ok === true, JSON.stringify(rel))

  const fake = path.join(dir, 'fake.png')
  await fsp.writeFile(fake, 'isto não é uma imagem, é texto puro com extensão errada')
  const bad = await A.readImageFile(fake, dir)
  check('extensão mentirosa é recusada', bad.ok === false, JSON.stringify(bad))

  const missing = await A.readImageFile(path.join(dir, 'nao-existe.png'), dir)
  check('arquivo ausente não estoura', missing.ok === false, JSON.stringify(missing))
  check('erro explica o motivo', missing.ok === false && missing.reason.length > 0, '')

  await fsp.rm(dir, { recursive: true, force: true })
}

log('--- 09 · clipboard fake ---')
{
  // A suíte roda com FAKE_CLIPBOARD, então nada toca o clipboard real.
  clip.setFakeClipboardImage(null)
  check('sem imagem devolve null', (await clip.readImageFromClipboard()) === null, '')
  clip.setFakeClipboardImage({ data: PNG, mediaType: 'image/png' })
  const got = await clip.readImageFromClipboard()
  check('devolve a imagem posta', got?.mediaType === 'image/png', JSON.stringify(got?.mediaType))
  check('com os bytes certos', Boolean(got && got.data.equals(PNG)), '')
  clip.setFakeClipboardImage(null)
}

log('--- 10 · descrição mostrada no composer ---')
{
  const store = new A.AttachmentStore()
  const t = store.addText('linha\n'.repeat(50))
  const i = store.addImage(PNG, 'image/png', '/tmp/tela.png')
  check('texto diz linhas e tamanho', /#1 texto 51 linhas \d+/.test(A.describeAttachment(t)), A.describeAttachment(t))
  check('imagem diz tipo e tamanho', /#2 imagem tela\.png png \d+ B/.test(A.describeAttachment(i)), A.describeAttachment(i))
  check('bytes legíveis', A.formatBytes(2048) === '2 KB', A.formatBytes(2048))
  check('mega legível', A.formatBytes(3 * 1024 * 1024) === '3.0 MB', A.formatBytes(3 * 1024 * 1024))
}

log('--- 11 · imagem nao explode a estimativa de contexto ---')
{
  const { estimateMessagesTokens } = await import(`${R}/core/compaction.ts`)
  const big = Buffer.alloc(300 * 1024, 9)
  const comImagem = [
    { role: 'user', content: [{ type: 'text', text: 'oi' }, { type: 'image', image: big, mediaType: 'image/png' }] },
  ] as never
  const tokens = estimateMessagesTokens(comImagem)
  // Sem isso, 300 KB de PNG viravam ~150k tokens e disparavam compactacao a toa.
  check('imagem grande nao vira 150k tokens', tokens < 5000, String(tokens))
  check('mas ainda custa alguma coisa', tokens > 500, String(tokens))
}

log('--- 12 · sessao salva sem os bytes da imagem ---')
{
  const { promises: fsp } = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'bytecode-sess-'))
  const { saveSessionState, loadSession } = await import(`${R}/core/sessions.ts`)

  const cfg = { dataDir: dir } as never
  const ID = '11111111-1111-4111-8111-111111111111'
  const msgs = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'olha essa tela [Image #1]' },
        { type: 'image', image: Buffer.alloc(200 * 1024, 9), mediaType: 'image/png' },
      ],
    },
  ] as never

  await saveSessionState(cfg, { id: ID, cwd: process.cwd(), modelRef: 'fake/tiny', messages: msgs })

  const proj = (await fsp.readdir(dir))[0]
  let total = 0
  for (const f of await fsp.readdir(path.join(dir, proj))) {
    total += (await fsp.stat(path.join(dir, proj, f))).size
  }
  // O snapshot e reescrito a cada turno; carregar 200 KB de PNG nele custa caro.
  check('snapshot nao carrega o PNG', total < 5000, `${total} bytes`)

  const back = await loadSession(cfg, process.cwd(), ID)
  const parts = back?.messages[0].content as { type: string; image?: unknown }[]
  check('sessao retomada tem as partes', Array.isArray(parts) && parts.length === 2, JSON.stringify(parts))
  // Uma parte de imagem sem bytes seria recusada pelo provider na hora de enviar.
  check('nao sobra parte de imagem vazia', !parts.some(p => p.type === 'image'), JSON.stringify(parts))
  check('texto original preservado', parts[0].type === 'text', JSON.stringify(parts[0]))

  await fsp.rm(dir, { recursive: true, force: true })
}

const resumo = String.fromCharCode(10) + pass + ' passed, ' + fail + ' failed'
log(resumo)
process.exit(fail === 0 ? 0 : 1)
