const { ROOT, SRC: R, scratch, fixture, fixtureUrl, useConfig } = await import('./helpers.ts')
const S = await scratch('doctor')

// Casa isolada: setup/import mexem em HOME, então HOME aponta pro scratchpad.
const HOME = `${S}\\fakehome`
const { promises: fsp } = await import('node:fs')
await fsp.rm(HOME, { recursive: true, force: true })
await fsp.mkdir(HOME, { recursive: true })
process.env.USERPROFILE = HOME
process.env.HOME = HOME
process.env.HOMEDRIVE = ''
process.env.HOMEPATH = ''
delete process.env.LOCALAPPDATA

const doctor = await import(`${R}/core/doctor.ts`)
const paths = await import(`${R}/util/paths.ts`)
const { authPath, readAuthFile } = await import(`${R}/provider/auth.ts`)
const nodePath = await import('node:path')

let pass = 0
let fail = 0
const check = (n: string, ok: boolean, d = '') => {
  if (ok) { pass++; console.log(`  ok   ${n}`) } else { fail++; console.log(`  FAIL ${n} ${d}`) }
}

const cwd = ROOT
const baseConfig = {
  model: 'p/m',
  provider: {
    p: { env: ['P_KEY'], options: { baseURL: 'https://x.invalid/v1' }, models: { m: { id: 'm' } } },
    inline: { options: { apiKey: 'sk-emtexto' }, models: { m: {} } },
    store: { models: { m: {} } },
    nada: { models: { m: {} } },
  },
} as never

console.log('--- estado inicial: nada próprio existe ---')
{
  paths.resetPathCache()
  const r = await doctor.runDoctor(baseConfig, cwd)
  const own = r.files.find(f => f.path.endsWith(`.config\\bytecode\\bytecode.jsonc`))
  check('lista o caminho próprio de config', Boolean(own), JSON.stringify(r.files.map(f => f.path).slice(0, 3)))
  check('caminho próprio marcado como não existente', own?.exists === false, String(own?.exists))
  check('avisa que falta config própria', r.warnings.some(w => w.includes('Sem config própria')), JSON.stringify(r.warnings))
  check('avisa chave em texto puro', r.warnings.some(w => w.includes('texto puro') && w.includes('inline')), JSON.stringify(r.warnings))
}

console.log('--- opencode ignorado sem opt-in ---')
{
  const openCodeDir = nodePath.join(HOME, '.local', 'share', 'opencode')
  await fsp.mkdir(openCodeDir, { recursive: true })
  await fsp.writeFile(
    nodePath.join(openCodeDir, 'auth.json'),
    JSON.stringify({ store: { type: 'api', key: 'sk-do-opencode' }, extra: { key: 'sk-outro' } }),
    'utf8',
  )
  paths.resetPathCache()

  const off = await doctor.runDoctor(baseConfig, cwd)
  const ocFile = off.files.find(f => f.path.includes('opencode'))
  check('arquivo do opencode aparece no relatório', Boolean(ocFile), '')
  check('existe no disco', ocFile?.exists === true, '')
  check('marcado como NÃO usado', ocFile?.used === false, String(ocFile?.used))
  check('nota diz que está ignorado', (ocFile?.note ?? '').includes('IGNORADAS'), ocFile?.note ?? '')

  const store = off.credentials.find(c => c.provider === 'store')
  check('credencial do opencode NÃO é usada', store?.source.kind === 'none', JSON.stringify(store))

  const on = await doctor.runDoctor({ ...baseConfig, openCodeAuth: true } as never, cwd)
  const onFile = on.files.find(f => f.path.includes('opencode'))
  check('com opt-in passa a ser usado', onFile?.used === true, String(onFile?.used))
  const onStore = on.credentials.find(c => c.provider === 'store')
  check('com opt-in resolve do store do opencode', onStore?.source.kind === 'store', JSON.stringify(onStore))
  check('diz qual arquivo', (onStore?.source.detail ?? '').includes('opencode'), onStore?.source.detail ?? '')
}

console.log('--- ordem de resolução da credencial ---')
{
  paths.resetPathCache()
  process.env.P_KEY = 'sk-do-ambiente'
  const r = await doctor.runDoctor(baseConfig, cwd)
  const byProvider = Object.fromEntries(r.credentials.map(c => [c.provider, c.source]))
  check('env var vence', byProvider.p.kind === 'env', JSON.stringify(byProvider.p))
  check('aponta o nome da var', byProvider.p.detail === '$P_KEY', byProvider.p.detail)
  check('apiKey na config é reportada como config', byProvider.inline.kind === 'config', JSON.stringify(byProvider.inline))
  check('sem nada é reportado como none', byProvider.nada.kind === 'none', JSON.stringify(byProvider.nada))
  check('nunca imprime o segredo',
    !JSON.stringify(r).includes('sk-do-ambiente') && !JSON.stringify(r).includes('sk-emtexto') && !JSON.stringify(r).includes('sk-do-opencode'), '')
  delete process.env.P_KEY
}

console.log('--- escreve no novo, lê do antigo ---')
{
  paths.resetPathCache()
  check('stateDir é sempre o nome novo', paths.stateDir().endsWith('.bytecode'), paths.stateDir())
  check('authPath grava no novo', authPath().includes('.bytecode'), authPath())

  // Só existe o diretório antigo com uma credencial: tem que ser LIDA.
  const legacy = nodePath.join(HOME, '.hx')
  await fsp.rm(nodePath.join(HOME, '.bytecode'), { recursive: true, force: true })
  await fsp.mkdir(legacy, { recursive: true })
  await fsp.writeFile(nodePath.join(legacy, 'auth.json'), JSON.stringify({ antigo: { key: 'sk-antigo' } }), 'utf8')

  const { readAuth, saveCredential } = await import(`${R}/provider/auth.ts`)
  check('credencial antiga é lida', Boolean((await readAuth()).antigo), '')
  check('stateDir NÃO virou o antigo', paths.stateDir().endsWith('.bytecode'), paths.stateDir())
  check('hasLegacyState detecta', paths.hasLegacyState() === true, '')

  // Gravar uma nova cria o diretório NOVO, não escreve no antigo.
  const file = await saveCredential('novo', { type: 'api', key: 'sk-novo' })
  check('gravou no diretório novo', file.includes('.bytecode'), file)
  check('não tocou no arquivo antigo',
    !Boolean((await readAuthFile(nodePath.join(legacy, 'auth.json'))).novo), '')
  const merged = await readAuth()
  check('as duas aparecem juntas', Boolean(merged.antigo) && Boolean(merged.novo),
    JSON.stringify(Object.keys(merged)))

  // Mesmo provider nos dois: o novo vence, porque é onde se escreve.
  await fsp.writeFile(
    nodePath.join(legacy, 'auth.json'),
    JSON.stringify({ antigo: { key: 'sk-antigo' }, novo: { key: 'sk-versao-velha' } }),
    'utf8',
  )
  check('novo vence em conflito', (await readAuth()).novo?.key === 'sk-novo',
    JSON.stringify((await readAuth()).novo))
}

console.log('--- sessões: lista dos dois diretórios ---')
{
  const sessions = await import(`${R}/core/sessions.ts`)
  const slug = (await import(`${R}/util/fs.ts`)).slugForCwd(cwd)
  const legacyProjects = nodePath.join(HOME, '.hx', 'projects', slug)
  await fsp.mkdir(legacyProjects, { recursive: true })
  await fsp.writeFile(
    nodePath.join(legacyProjects, 'old1.meta.json'),
    JSON.stringify({ id: 'old1', cwd, modelRef: 'p/m', title: 'sessao antiga', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', turns: 1, messages: 2 }),
    'utf8',
  )
  await fsp.writeFile(
    nodePath.join(legacyProjects, 'old1.state.json'),
    JSON.stringify({ id: 'old1', cwd, modelRef: 'p/m', messages: [{ role: 'user', content: 'antiga' }] }),
    'utf8',
  )

  const cfg = { ...baseConfig, dataDir: undefined } as never
  const listed = await sessions.listSessions(cfg, cwd)
  check('sessão antiga aparece na lista', listed.some(s => s.id === 'old1'), JSON.stringify(listed.map(s => s.id)))
  const loaded = await sessions.loadSession(cfg, cwd, 'old1')
  check('sessão antiga abre', loaded?.messages?.length === 1, JSON.stringify(loaded?.id))

  // Uma nova gravada vai para o diretório novo e as duas convivem.
  await sessions.saveSessionState(cfg, {
    id: 'new1',
    cwd,
    modelRef: 'p/m',
    messages: [{ role: 'user', content: 'nova' }] as never,
  })
  const nova = nodePath.join(HOME, '.bytecode', 'projects', slug, 'new1.meta.json')
  check('sessão nova gravada no diretório novo', await fsp.stat(nova).then(() => true, () => false), nova)
  const both = await sessions.listSessions(cfg, cwd)
  check('lista traz as duas', both.some(s => s.id === 'old1') && both.some(s => s.id === 'new1'),
    JSON.stringify(both.map(s => s.id)))
}

console.log('--- auth.json quebrado é denunciado, não silenciado ---')
{
  const authFile = nodePath.join(HOME, '.bytecode', 'auth.json')
  await fsp.mkdir(nodePath.dirname(authFile), { recursive: true })
  // vírgula sobrando: o erro clássico
  await fsp.writeFile(authFile, '{ "store": { "type": "api", "key": "sk-x" }, }', 'utf8')
  paths.resetPathCache()

  const { readAuth, brokenAuthFiles } = await import(`${R}/provider/auth.ts`)
  const store = await readAuth()
  check('só as entradas do arquivo quebrado somem', !store.store, JSON.stringify(Object.keys(store)))
  check('o outro arquivo continua valendo', Boolean(store.antigo), JSON.stringify(Object.keys(store)))
  const broken = brokenAuthFiles()
  check('mas o arquivo é apontado', broken.some(b => b.file === authFile), JSON.stringify(broken.map(b => b.file)))
  check('com a razão do parse', broken.some(b => b.error.length > 0), JSON.stringify(broken))

  const r = await doctor.runDoctor(baseConfig, cwd)
  check('doctor avisa em vez de dizer "sem credencial"',
    r.warnings.some(w => w.includes('não é JSON válido')), JSON.stringify(r.warnings))
  check('aviso não expõe o conteúdo', !JSON.stringify(r.warnings).includes('sk-x'), '')

  // consertar limpa o registro
  await fsp.writeFile(authFile, '{ "store": { "type": "api", "key": "sk-x" } }', 'utf8')
  await readAuth()
  check('arquivo corrigido sai da lista', brokenAuthFiles().every(b => b.file !== authFile),
    JSON.stringify(brokenAuthFiles()))
}

console.log('--- setup cria a estrutura própria ---')
{
  // estado legado com uma credencial, para o setup carregar
  const legacy = nodePath.join(HOME, '.hx')
  await fsp.mkdir(legacy, { recursive: true })
  await fsp.writeFile(nodePath.join(legacy, 'auth.json'), JSON.stringify({ legado: { key: 'sk-legado' } }), 'utf8')
  await fsp.mkdir(nodePath.join(HOME, '.config', 'hx'), { recursive: true })
  await fsp.writeFile(nodePath.join(HOME, '.config', 'hx', 'hx.jsonc'), '{ "model": "p/m" }\n', 'utf8')
  paths.resetPathCache()
  const done = await doctor.runSetup()
  paths.resetPathCache()

  const target = nodePath.join(HOME, '.bytecode')
  check('criou ~/.bytecode', await fsp.stat(target).then(s => s.isDirectory(), () => false), '')
  check('criou projects/', await fsp.stat(nodePath.join(target, 'projects')).then(s => s.isDirectory(), () => false), '')
  check('criou workflows/', await fsp.stat(nodePath.join(target, 'workflows')).then(s => s.isDirectory(), () => false), '')
  check('criou auth.json próprio', await fsp.stat(nodePath.join(target, 'auth.json')).then(() => true, () => false), '')
  check('trouxe a credencial legada', Boolean((await readAuthFile(nodePath.join(target, 'auth.json'))).legado),
    JSON.stringify(Object.keys(await readAuthFile(nodePath.join(target, 'auth.json')))))
  check('copiou a config legada', await fsp.readFile(nodePath.join(HOME, '.config', 'bytecode', 'bytecode.jsonc'), 'utf8').then(t => t.includes('p/m'), () => false), '')
  check('relatou o que fez', done.length >= 3, JSON.stringify(done))

  check('depois do setup nada mais é legado', paths.hasLegacyState() === false, paths.stateDir())
  check('authPath aponta pro próprio', authPath().includes('.bytecode'), authPath())

  // legado permanece intacto — nada é movido
  check('não moveu o legado', Boolean((await readAuthFile(nodePath.join(legacy, 'auth.json'))).legado), '')

  const after = await doctor.runDoctor(baseConfig, cwd)
  check('sem aviso de dir legado depois do setup', !after.warnings.some(w => w.includes('nome antigo')), JSON.stringify(after.warnings))
  check('sem aviso de config faltando', !after.warnings.some(w => w.includes('Sem config própria')), JSON.stringify(after.warnings))
}

console.log('--- setup é idempotente ---')
{
  const authFile = nodePath.join(HOME, '.bytecode', 'auth.json')
  await fsp.writeFile(authFile, JSON.stringify({ meu: { key: 'sk-meu' } }), 'utf8')
  const done = await doctor.runSetup()
  const store = await readAuthFile(authFile)
  check('não sobrescreve auth existente', store.meu?.key === 'sk-meu', JSON.stringify(store.meu))
  check('mas termina a migração do que falta', Boolean(store.legado), JSON.stringify(Object.keys(store)))
  check('relata o que copiou', done.some(l => l.includes('legado')), JSON.stringify(done))

  // rodar de novo não muda mais nada
  const again = await doctor.runSetup()
  check('segunda rodada não copia nada', again.some(l => l.includes('nada novo')), JSON.stringify(again))
}

console.log('--- import explícito do opencode ---')
{
  paths.resetPathCache()
  const result = await doctor.importOpenCodeCredentials()
  const store = await readAuthFile(result.file)
  check('importou os providers do opencode', result.providers.includes('store') && result.providers.includes('extra'),
    JSON.stringify(result.providers))
  check('gravou no auth próprio', result.file.includes('.bytecode'), result.file)
  check('preservou o que já existia', Boolean(store.meu), JSON.stringify(Object.keys(store)))
  check('marcou data da importação', Boolean(store.store?.connectedAt), JSON.stringify(store.store))

  const again = await doctor.importOpenCodeCredentials()
  check('reimportar não duplica nem sobrescreve', again.providers.length === 0, JSON.stringify(again.providers))
}

await fsp.rm(HOME, { recursive: true, force: true })
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
