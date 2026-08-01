// A guarda de escrita: recusa sobrescrever arquivo que a sessão não leu, e
// recusa escrever por cima do que mudou no disco depois da leitura.
//
// Os dois casos são silenciosos sem ela — o `Write` grava, o `Edit` grava, e a
// alteração de quem estava com o arquivo aberto no editor some sem erro nenhum.

const { ROOT, SRC: R, scratch, mockProvider, useConfig, reporter } = await import('./helpers.ts')
const S = await scratch('fileguard')
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
const { registerTools } = await import(`${R}/tools/index.ts`)
const { seenFile, forgetFiles, guardWrite } = await import(`${R}/core/filestate.ts`)

const { config } = await loadConfig(ROOT)

async function newSession(overrides: Record<string, unknown> = {}): Promise<any> {
  const session: any = new Session({ config: { ...config, ...overrides }, cwd: S, modelRef: config.model! })
  await session.init(() => {})
  registerTools(session)
  session.emit = () => {}
  session.requestPermission = async () => true
  return session
}

/** Mexe no arquivo por fora, como faria um editor aberto do lado. */
async function externalWrite(file: string, content: string): Promise<void> {
  await fsp.writeFile(file, content, 'utf8')
  // O mtime tem granularidade grosseira em alguns sistemas de arquivos; empurrar
  // o timestamp garante que o teste mede a regra, não o relógio.
  const future = new Date(Date.now() + 2000)
  await fsp.utimes(file, future, future)
}

const session = await newSession()
const ctx = { session, cwd: S, depth: 0 }
const read = session.registry.get('Read')
const write = session.registry.get('Write')
const edit = session.registry.get('Edit')

log('--- criar arquivo novo é sempre livre ---')
{
  const novo = nodePath.join(S, 'novo.txt')
  const out = await write.execute({ file_path: novo, content: 'um\n' }, ctx)
  check('Write cria sem exigir leitura', !out.isError, JSON.stringify(out.text))
  check('e a sessão passa a conhecer o arquivo', Boolean(seenFile(session, novo)), '')
  check('Write logo em seguida continua valendo',
    !(await write.execute({ file_path: novo, content: 'dois\n' }, ctx)).isError, '')
}

log('--- Write sobre arquivo não lido é recusado ---')
{
  const alheio = nodePath.join(S, 'alheio.txt')
  await fsp.writeFile(alheio, 'conteudo que ninguem viu\n', 'utf8')

  const out = await write.execute({ file_path: alheio, content: 'apagado\n' }, ctx)
  check('Write recusa', out.isError === true, JSON.stringify(out.text))
  check('e diz por quê', out.text.includes('has not been read'), out.text)
  check('o arquivo não foi tocado',
    (await fsp.readFile(alheio, 'utf8')) === 'conteudo que ninguem viu\n', '')

  await read.execute({ file_path: alheio }, ctx)
  const depois = await write.execute({ file_path: alheio, content: 'agora sim\n' }, ctx)
  check('depois de ler, passa', !depois.isError, JSON.stringify(depois.text))
  check('e gravou mesmo', (await fsp.readFile(alheio, 'utf8')) === 'agora sim\n', '')
}

log('--- Edit sobre arquivo não lido continua permitido ---')
{
  // Um `Edit` já falha alto quando erra o alvo (`old_string not found`), então
  // exigir leitura custaria um round trip para provar o que o match prova.
  const doGrep = nodePath.join(S, 'do-grep.txt')
  await fsp.writeFile(doGrep, 'linha alvo\n', 'utf8')
  const out = await edit.execute({ file_path: doGrep, old_string: 'alvo', new_string: 'trocado' }, ctx)
  check('Edit sem leitura prévia passa', !out.isError, JSON.stringify(out.text))
  check('aplicou', (await fsp.readFile(doGrep, 'utf8')).includes('trocado'), '')
}

log('--- alteração externa depois da leitura bloqueia os dois ---')
{
  const disputado = nodePath.join(S, 'disputado.txt')
  await fsp.writeFile(disputado, 'versao 1\n', 'utf8')
  await read.execute({ file_path: disputado }, ctx)

  await externalWrite(disputado, 'versao do editor, salva à mão\n')

  const porWrite = await write.execute({ file_path: disputado, content: 'versao do agente\n' }, ctx)
  check('Write recusa', porWrite.isError === true, JSON.stringify(porWrite.text))
  check('e explica que mudou no disco', porWrite.text.includes('changed on disk'), porWrite.text)

  const porEdit = await edit.execute({ file_path: disputado, old_string: 'versao', new_string: 'v' }, ctx)
  check('Edit também recusa', porEdit.isError === true, JSON.stringify(porEdit.text))
  check('o trabalho de quem editou sobreviveu',
    (await fsp.readFile(disputado, 'utf8')) === 'versao do editor, salva à mão\n', '')

  await read.execute({ file_path: disputado }, ctx)
  const relido = await edit.execute({ file_path: disputado, old_string: 'editor', new_string: 'EDITOR' }, ctx)
  check('reler destrava', !relido.isError, JSON.stringify(relido.text))
}

log('--- escrita da própria sessão não se auto-bloqueia ---')
{
  const meu = nodePath.join(S, 'meu.txt')
  await write.execute({ file_path: meu, content: 'a\n' }, ctx)
  const seguidas = []
  for (let i = 0; i < 3; i++) {
    seguidas.push(await edit.execute({ file_path: meu, old_string: 'a', new_string: 'a' + i }, ctx))
  }
  check('três edições seguidas passam', seguidas.every((r: any) => !r.isError), JSON.stringify(seguidas.map((r: any) => r.text)))
}

log('--- subagent enxerga a leitura do pai e vice-versa ---')
{
  const compartilhado = nodePath.join(S, 'compartilhado.txt')
  await fsp.writeFile(compartilhado, 'base\n', 'utf8')

  const filha = session.child({ agentType: 'investigador' })
  const ctxFilha = { session: filha, cwd: S, depth: 1 }

  const semLeitura = await write.execute({ file_path: compartilhado, content: 'x\n' }, ctxFilha)
  check('filho também é barrado no arquivo não lido', semLeitura.isError === true, JSON.stringify(semLeitura.text))

  await read.execute({ file_path: compartilhado }, ctx)
  const comLeituraDoPai = await write.execute({ file_path: compartilhado, content: 'do filho\n' }, ctxFilha)
  check('leitura do pai libera o filho', !comLeituraDoPai.isError, JSON.stringify(comLeituraDoPai.text))
  check('e a escrita do filho é vista pelo pai',
    seenFile(session, compartilhado)?.size === Buffer.byteLength('do filho\n'),
    JSON.stringify(seenFile(session, compartilhado)))
}

log('--- desligável, e zerável ---')
{
  const semGuarda = await newSession({ fileGuard: false })
  const alvo = nodePath.join(S, 'sem-guarda.txt')
  await fsp.writeFile(alvo, 'original\n', 'utf8')
  const out = await semGuarda.registry
    .get('Write')
    .execute({ file_path: alvo, content: 'passou\n' }, { session: semGuarda, cwd: S, depth: 0 })
  check('fileGuard:false volta ao comportamento antigo', !out.isError, JSON.stringify(out.text))
  await semGuarda.mcp.close()

  const zerado = nodePath.join(S, 'zerado.txt')
  await fsp.writeFile(zerado, 'v1\n', 'utf8')
  await read.execute({ file_path: zerado }, ctx)
  check('lido antes do clear', Boolean(seenFile(session, zerado)), '')
  forgetFiles(session)
  check('clear esquece o que foi lido', seenFile(session, zerado) === undefined, '')
  const depoisDoClear = await write.execute({ file_path: zerado, content: 'v2\n' }, ctx)
  check('e a guarda volta a exigir leitura', depoisDoClear.isError === true, JSON.stringify(depoisDoClear.text))
}

log('--- casos degenerados ---')
{
  const sumido = nodePath.join(S, 'nao-existe', 'nada.txt')
  const v = await guardWrite(session, sumido, { whole: true })
  check('arquivo inexistente libera', v.ok === true, JSON.stringify(v))

  const apagado = nodePath.join(S, 'apagado.txt')
  await fsp.writeFile(apagado, 'x\n', 'utf8')
  await read.execute({ file_path: apagado }, ctx)
  await fsp.rm(apagado)
  const recriar = await write.execute({ file_path: apagado, content: 'de novo\n' }, ctx)
  check('recriar arquivo apagado passa', !recriar.isError, JSON.stringify(recriar.text))
}

await session.mcp.close()
done()
