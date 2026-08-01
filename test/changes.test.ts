// Rastreio de arquivos alterados + o diff unificado que a tela do ctrl+g mostra.

const { ROOT, SRC: R, scratch, mockProvider, useConfig, reporter } = await import('./helpers.ts')
const S = await scratch('changes')
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
const changes = await import(`${R}/core/changes.ts`)

const { config } = await loadConfig(ROOT)
const session: any = new Session({ config, cwd: S, modelRef: config.model! })
await session.init(() => {})
registerTools(session)
session.emit = () => {}
session.requestPermission = async () => true

log('--- diff de linhas ---')
{
  const ops = changes.diffLines(['a', 'b', 'c'], ['a', 'x', 'c'])
  check('mantem o contexto', ops.filter(o => o.marker === ' ').length === 2, JSON.stringify(ops))
  check('marca a removida e a adicionada',
    ops.some(o => o.marker === '-' && o.text === 'b') && ops.some(o => o.marker === '+' && o.text === 'x'),
    JSON.stringify(ops))

  const igual = changes.diffLines(['a', 'b'], ['a', 'b'])
  check('sem mudanca, so contexto', igual.every(o => o.marker === ' '), JSON.stringify(igual))

  const meio = changes.diffLines(['1', '2', '3', '4', '5'], ['1', '2', 'novo', '3', '4', '5'])
  check('insercao no meio nao reescreve o resto',
    meio.filter(o => o.marker !== ' ').length === 1, JSON.stringify(meio.filter(o => o.marker !== ' ')))
}

log('--- rastreio pelas tools ---')
{
  const alvo = nodePath.join(S, 'src', 'app.ts')
  const write = session.registry.get('Write')
  const edit = session.registry.get('Edit')
  const ctx = { session, cwd: S, depth: 0 }

  await write.execute({ file_path: alvo, content: 'linha 1\nlinha 2\n' }, ctx)
  let lista = changes.changedFiles(session)
  check('Write entra na lista', lista.length === 1 && lista[0].file === alvo, JSON.stringify(lista.map(c => c.file)))
  check('arquivo novo tem before null', lista[0].before === null, JSON.stringify(lista[0].before))

  await edit.execute({ file_path: alvo, old_string: 'linha 2', new_string: 'linha dois' }, ctx)
  lista = changes.changedFiles(session)
  check('Edit nao duplica a entrada', lista.length === 1, String(lista.length))
  check('baseline continua sendo a primeira', lista[0].before === null, JSON.stringify(lista[0].before))
  check('contou as duas escritas', lista[0].edits === 2, String(lista[0].edits))
  check('conteudo atual e o ultimo', lista[0].after.includes('linha dois'), lista[0].after)

  const outro = nodePath.join(S, 'docs', 'nota.md')
  await fsp.mkdir(nodePath.dirname(outro), { recursive: true })
  await fsp.writeFile(outro, 'antes\n', 'utf8')
  await edit.execute({ file_path: outro, old_string: 'antes', new_string: 'depois' }, ctx)
  lista = changes.changedFiles(session)
  check('arquivo pre-existente guarda o conteudo anterior',
    lista.find(c => c.file === outro)?.before === 'antes\n', JSON.stringify(lista.find(c => c.file === outro)?.before))

  const grupos = changes.groupByDirectory(lista, S)
  check('agrupa por diretorio', grupos.length === 2, JSON.stringify(grupos.map(g => g.dir)))
  check('mostra caminho relativo ao cwd',
    grupos.some(g => g.dir === 'docs') && grupos.some(g => g.dir === 'src'), JSON.stringify(grupos.map(g => g.dir)))
  check('nome do arquivo separado do diretorio',
    grupos.find(g => g.dir === 'src')?.files[0].name === 'app.ts', JSON.stringify(grupos))

  const stats = changes.changeStats(lista.find(c => c.file === outro)!)
  check('conta adicionadas e removidas', stats.added === 1 && stats.removed === 1, JSON.stringify(stats))
}

log('--- diff unificado ---')
{
  const alvo = changes.changedFiles(session).find(c => c.file.endsWith('nota.md'))!
  const texto = changes.unifiedDiff(alvo, 'docs/nota.md')
  check('tem cabecalho git', texto.startsWith('diff --git a/docs/nota.md b/docs/nota.md'), texto.split('\n')[0])
  check('tem hunk com numeros', /@@ -1,\d+ \+1,\d+ @@/.test(texto), JSON.stringify(texto.split('\n')[1]))
  check('linha removida com -', texto.includes('\n-antes'), JSON.stringify(texto))
  check('linha adicionada com +', texto.includes('\n+depois'), JSON.stringify(texto))

  const novo = changes.changedFiles(session).find(c => c.file.endsWith('app.ts'))!
  const criado = changes.unifiedDiff(novo, 'src/app.ts')
  check('arquivo novo marcado como new file', criado.includes('new file mode'), criado.split('\n')[1])
  check('arquivo novo so tem adicoes',
    criado.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length === 0, criado)

  // O renderer da TUI tem de aceitar o que geramos aqui: é o mesmo caminho do
  // `git diff` colado numa resposta.
  const render = await import(`${R}/tui/render.ts`)
  check('renderer reconhece o diff gerado', render.looksLikeUnifiedDiff(texto), '')
  const desenhado = render.renderDiff(texto, 80).map((l: string) => render.stripAnsi(l))
  check('desenha o nome do arquivo', desenhado[0].includes('docs/nota.md'), desenhado[0])
  check('desenha as duas versoes',
    desenhado.some((l: string) => l.includes('antes')) && desenhado.some((l: string) => l.includes('depois')),
    JSON.stringify(desenhado))
}

log('--- isolamento por sessao ---')
{
  const filha = session.child({ agentType: 'dispatcher' })
  check('subagent enxerga a lista da raiz',
    changes.changedFiles(filha).length === changes.changedFiles(session).length, '')

  changes.recordChange(filha, { file: nodePath.join(S, 'de-subagent.txt'), before: null, after: 'x' })
  const doSub = changes.changedFiles(session).find(c => c.file.endsWith('de-subagent.txt'))
  check('escrita de subagent sobe para a raiz', Boolean(doSub), '')
  check('marca o agente que escreveu', JSON.stringify(doSub?.by) === '["dispatcher"]', JSON.stringify(doSub?.by))

  const compartilhado = nodePath.join(S, 'src', 'app.ts')
  changes.recordChange(filha, { file: compartilhado, before: null, after: 'z' })
  check('arquivo tocado pelos dois lista os dois',
    JSON.stringify(changes.changedFiles(session).find(c => c.file === compartilhado)?.by) === '["main","dispatcher"]',
    JSON.stringify(changes.changedFiles(session).find(c => c.file === compartilhado)?.by))
  check('mesmo autor nao entra duas vezes',
    (() => {
      changes.recordChange(filha, { file: compartilhado, before: null, after: 'zz' })
      return changes.changedFiles(session).find(c => c.file === compartilhado)?.by.length === 2
    })(), '')

  changes.clearChanges(session)
  check('clear zera a lista', changes.changedFiles(session).length === 0, '')
}

log('--- desfazer (rewind) ---')
{
  const write = session.registry.get('Write')
  const edit = session.registry.get('Edit')
  const read = session.registry.get('Read')
  const ctx = { session, cwd: S, depth: 0 }
  changes.clearChanges(session)

  // Arquivo que já existia: desfazer devolve o conteúdo anterior à sessão, não
  // à última edição — cinco edits são uma alteração para revisar.
  const antigo = nodePath.join(S, 'antigo.txt')
  await fsp.writeFile(antigo, 'estado original\n', 'utf8')
  await read.execute({ file_path: antigo }, ctx)
  await edit.execute({ file_path: antigo, old_string: 'original', new_string: 'primeira' }, ctx)
  await edit.execute({ file_path: antigo, old_string: 'primeira', new_string: 'segunda' }, ctx)

  const restaurado = await changes.revertChange(session, antigo)
  check('desfazer arquivo existente restaura', restaurado.ok === true && restaurado.action === 'restored', JSON.stringify(restaurado))
  check('volta ao estado anterior à sessão inteira',
    (await fsp.readFile(antigo, 'utf8')) === 'estado original\n',
    JSON.stringify(await fsp.readFile(antigo, 'utf8')))
  check('e sai da lista de alterações',
    !changes.changedFiles(session).some(c => c.file === antigo), JSON.stringify(changes.changedFiles(session).map(c => c.file)))

  // Arquivo criado pela sessão: desfazer é apagar.
  const criado = nodePath.join(S, 'criado.txt')
  await write.execute({ file_path: criado, content: 'nasceu aqui\n' }, ctx)
  const apagado = await changes.revertChange(session, criado)
  check('desfazer arquivo criado apaga', apagado.ok === true && apagado.action === 'deleted', JSON.stringify(apagado))
  check('o arquivo sumiu mesmo', !(await fsp.stat(criado).then(() => true, () => false)), '')

  // Depois de desfeito, o arquivo pode ser escrito de novo sem exigir leitura —
  // a guarda foi atualizada junto.
  const denovo = await write.execute({ file_path: criado, content: 'de novo\n' }, ctx)
  check('recriar depois de desfazer passa', !denovo.isError, JSON.stringify(denovo.text))

  const inexistente = await changes.revertChange(session, nodePath.join(S, 'nunca-mexido.txt'))
  check('desfazer o que não foi alterado recusa', inexistente.ok === false, JSON.stringify(inexistente))

  // Alteração externa depois da escrita da sessão: desfazer restauraria por cima
  // do trabalho de outra pessoa, então é recusado.
  const disputado = nodePath.join(S, 'disputado-rewind.txt')
  await fsp.writeFile(disputado, 'v1\n', 'utf8')
  await read.execute({ file_path: disputado }, ctx)
  await edit.execute({ file_path: disputado, old_string: 'v1', new_string: 'v2' }, ctx)
  await fsp.writeFile(disputado, 'salvo no editor\n', 'utf8')
  const futuro = new Date(Date.now() + 2000)
  await fsp.utimes(disputado, futuro, futuro)

  const recusado = await changes.revertChange(session, disputado)
  check('desfazer recusa se mudou no disco', recusado.ok === false, JSON.stringify(recusado))
  check('e diz que mudou no disco',
    recusado.ok === false && recusado.reason.includes('changed on disk'),
    JSON.stringify(recusado))
  check('o arquivo de quem editou sobreviveu',
    (await fsp.readFile(disputado, 'utf8')) === 'salvo no editor\n', '')
  check('continua listado como alterado',
    changes.changedFiles(session).some(c => c.file === disputado), '')
}

await session.mcp.close()
done()
