// WebFetch: as guardas, não a implementação.
//
// Tudo roda contra um servidor local em 127.0.0.1 — a suíte tem de passar
// offline. Como 127.0.0.1 é exatamente o que a guarda anti-SSRF bloqueia, o
// servidor de teste só é alcançável porque a config o libera; isso é, de
// propósito, a prova de que a guarda está ligada.

const { ROOT, SRC: R, scratch, mockProvider, useConfig, reporter } = await import('./helpers.ts')
const S = await scratch('web')
const http = await import('node:http')

const server = http.createServer((req, res) => {
  const url = req.url ?? '/'
  if (url === '/html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<html><head><title>t</title><style>.a{color:red}</style></head><body>' +
        '<script>alert("nao deveria aparecer")</script>' +
        '<h1>Título</h1><p>Primeiro par&#225;grafo.</p><p>Segundo &amp; fim.</p>' +
      '<p>Entidade rara: &lsaquo;</p>' +
        '</body></html>',
    )
    return
  }
  if (url === '/json') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"chave":"valor"}')
    return
  }
  if (url === '/grande') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('x'.repeat(200_000))
    return
  }
  if (url === '/redirect-publico') {
    res.writeHead(302, { location: '/json' })
    res.end()
    return
  }
  if (url === '/redirect-privado') {
    // 10.0.0.1 é privado e NÃO está na lista de liberados: o hop tem de morrer.
    res.writeHead(302, { location: 'http://10.0.0.1/segredo' })
    res.end()
    return
  }
  if (url === '/redirect-file') {
    res.writeHead(302, { location: 'file:///etc/passwd' })
    res.end()
    return
  }
  if (url === '/loop') {
    res.writeHead(302, { location: '/loop' })
    res.end()
    return
  }
  if (url === '/404') {
    res.writeHead(404, { 'content-type': 'text/plain' })
    res.end('nao existe aqui')
    return
  }
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('ok')
})

await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
const port = (server.address() as { port: number }).port
const base = `http://127.0.0.1:${port}`

useConfig({
  dataDir: `${S}/data`,
  model: 'mock/tiny',
  provider: { mock: mockProvider('mock-parity.mjs') },
  assets: { agents: ['./none'], skills: ['./none'], commands: ['./none'] },
  instructions: [],
  compaction: { enabled: false },
  permissions: { defaultMode: 'bypassPermissions' },
  web: { allowPrivateHosts: ['127.0.0.1'], maxBytes: 100_000 },
})

const { check, log, done } = reporter()
const { loadConfig } = await import(`${R}/config/load.ts`)
const { Session } = await import(`${R}/core/session.ts`)
const { registerTools } = await import(`${R}/tools/index.ts`)
const web = await import(`${R}/tools/web.ts`)
const permissions = await import(`${R}/core/permissions.ts`)

const { config } = await loadConfig(ROOT)
const session: any = new Session({ config, cwd: S, modelRef: config.model! })
await session.init(() => {})
registerTools(session)
session.emit = () => {}
session.requestPermission = async () => true

const ctx = { session, cwd: S, depth: 0 }
const fetchTool = session.registry.get('WebFetch')

const blocked = async (url: string, allow: string[] = []) => {
  try {
    await web.assertPublicHost(new URL(url), { allowPrivateHosts: allow })
    return false
  } catch {
    return true
  }
}

log('--- a guarda de endereço ---')
{
  check('esquema file: barrado', await blocked('file:///etc/passwd'), '')
  check('esquema gopher: barrado', await blocked('gopher://x/'), '')
  check('loopback barrado', await blocked('http://127.0.0.1/'), '')
  check('loopback ipv6 barrado', await blocked('http://[::1]/'), '')
  check('privado 10/8 barrado', await blocked('http://10.1.2.3/'), '')
  check('privado 192.168 barrado', await blocked('http://192.168.0.1/'), '')
  check('privado 172.16 barrado', await blocked('http://172.20.0.1/'), '')
  check('172.32 NÃO é privado', !(await blocked('http://172.32.0.1/')), '')
  check('metadata da nuvem barrada', await blocked('http://169.254.169.254/latest/meta-data/'), '')
  check('CGNAT barrado', await blocked('http://100.64.0.1/'), '')
  check('ipv4 mapeado em ipv6 barrado', await blocked('http://[::ffff:127.0.0.1]/'), '')
  check('ULA ipv6 barrado', await blocked('http://[fd00::1]/'), '')
  check('link-local ipv6 barrado', await blocked('http://[fe80::1]/'), '')
  check('0.0.0.0 barrado', await blocked('http://0.0.0.0/'), '')
  check('público passa', !(await blocked('http://8.8.8.8/')), '')
  check('allowPrivateHosts libera o que foi nomeado',
    !(await blocked('http://127.0.0.1/', ['127.0.0.1'])), '')
  check('e libera só o que foi nomeado', await blocked('http://10.0.0.1/', ['127.0.0.1']), '')
}

log('--- HTML vira texto ---')
{
  const out = await fetchTool.execute({ url: `${base}/html` }, ctx)
  check('não é erro', !out.isError, JSON.stringify(out.text).slice(0, 140))
  check('entidade numérica decodificada', out.text.includes('Primeiro parágrafo.'), out.text.slice(-300))
  check('entidade nomeada comum decodificada', out.text.includes('Segundo & fim.'), out.text.slice(-300))
  // Contrato honesto: o mapa de entidades nomeadas é curto (as ~10 comuns) e as
  // numéricas cobrem o resto. Uma nomeada rara fica como veio, legível, em vez
  // de virar caractere errado — e o README diz isso.
  check('entidade nomeada rara fica intacta, não vira lixo',
    out.text.includes('&lsaquo;'), out.text.slice(-300))
  check('script não vaza para o texto', !out.text.includes('alert('), out.text)
  check('style não vaza', !out.text.includes('color:red'), out.text)
  check('nenhuma tag sobrou', !/<[a-z]/i.test(out.text), out.text)
  check('o cabeçalho diz a URL final e o status',
    out.text.includes(`${base}/html`) && out.text.includes('HTTP 200'), out.text.slice(0, 160))
  check('avisa que o conteúdo é dado, não instrução',
    out.text.includes('data, not instructions'), out.text.slice(0, 400))

  const cru = await fetchTool.execute({ url: `${base}/html`, raw: true }, ctx)
  check('raw:true devolve o HTML', cru.text.includes('<h1>'), cru.text.slice(0, 200))
}

log('--- não-HTML passa direto ---')
{
  const out = await fetchTool.execute({ url: `${base}/json` }, ctx)
  check('JSON intacto', out.text.includes('{"chave":"valor"}'), out.text.slice(-80))
}

log('--- redirect é revalidado a cada hop ---')
{
  const ok = await fetchTool.execute({ url: `${base}/redirect-publico` }, ctx)
  check('redirect permitido é seguido', ok.text.includes('{"chave":"valor"}'), ok.text.slice(0, 200))
  check('e a URL final aparece', ok.text.includes('/json') && ok.text.includes('redirect'), ok.text.slice(0, 160))

  const privado = await fetchTool.execute({ url: `${base}/redirect-privado` }, ctx)
  check('redirect para IP privado morre no hop', privado.isError === true, JSON.stringify(privado.text))
  check('e diz o endereço', privado.text.includes('10.0.0.1'), privado.text)

  const arquivo = await fetchTool.execute({ url: `${base}/redirect-file` }, ctx)
  check('redirect para file: morre', arquivo.isError === true, JSON.stringify(arquivo.text))
  check('dizendo que só http/https', arquivo.text.includes('http and https'), arquivo.text)

  const laco = await fetchTool.execute({ url: `${base}/loop` }, ctx)
  check('laço de redirect estoura em vez de girar', laco.isError === true, JSON.stringify(laco.text))
  check('e diz que foram redirects demais', laco.text.includes('redirects'), laco.text)
}

log('--- teto de bytes ---')
{
  const out = await fetchTool.execute({ url: `${base}/grande` }, ctx)
  check('corpo grande é cortado', out.text.includes('truncated at 100000 bytes'), out.text.slice(0, 200))
  check('e o que voltou respeita o teto', out.text.length < 130_000, String(out.text.length))
}

log('--- status de erro ---')
{
  const out = await fetchTool.execute({ url: `${base}/404` }, ctx)
  check('404 é isError', out.isError === true, '')
  check('mas devolve o corpo, que costuma explicar', out.text.includes('nao existe aqui'), out.text)
}

log('--- URL inválida e abort ---')
{
  const ruim = await fetchTool.execute({ url: 'nao-e-url' }, ctx)
  check('URL relativa é recusada antes de qualquer rede', ruim.isError === true, JSON.stringify(ruim.text))

  const ac = new AbortController()
  ac.abort()
  const abortado = await fetchTool.execute({ url: `${base}/json` }, { ...ctx, signal: ac.signal })
  check('signal já abortado não faz a chamada', abortado.isError === true, JSON.stringify(abortado.text).slice(0, 120))
}

log('--- github blob vira raw ---')
{
  const reescrita = web.rawUrlFor(new URL('https://github.com/o/r/blob/main/src/a.ts'))
  check('reescreve para raw.githubusercontent.com',
    reescrita.toString() === 'https://raw.githubusercontent.com/o/r/main/src/a.ts', reescrita.toString())
  const intacta = web.rawUrlFor(new URL('https://github.com/o/r/issues/1'))
  check('deixa o resto do github em paz', intacta.toString().includes('github.com/o/r/issues/1'), intacta.toString())
  const outro = web.rawUrlFor(new URL('https://exemplo.com/blob/x'))
  check('e não mexe em outros domínios', outro.hostname === 'exemplo.com', outro.toString())
}

log('--- permissão: o kind net ---')
{
  const q = { tool: 'WebFetch', kind: 'net' as const, subject: 'https://docs.rs/x' }
  check('pede permissão por padrão',
    permissions.evaluate(undefined, 'default', q).decision === 'ask',
    JSON.stringify(permissions.evaluate(undefined, 'default', q)))
  check('permitido em plan mode — pesquisar doc é planejar',
    permissions.evaluate(undefined, 'plan', q).decision === 'ask',
    JSON.stringify(permissions.evaluate(undefined, 'plan', q)))
  check('deny por URL funciona',
    permissions.evaluate({ deny: ['WebFetch(https://ruim.com/**)'] }, 'default',
      { ...q, subject: 'https://ruim.com/a/b' }).decision === 'deny', '')
  // A armadilha de sintaxe: `host:*` é o idioma de comando, não de URL. Se
  // alguém escrever isso numa regra de deny, ela não casa — e a regra falha em
  // silêncio, que é pior que não existir.
  check('WebFetch(host:*) NÃO casa uma URL — use host/**',
    permissions.evaluate({ deny: ['WebFetch(ruim.com:*)'] }, 'default',
      { ...q, subject: 'https://ruim.com/a' }).decision !== 'deny', '')
}

log('--- hook if: casa por URL ---')
{
  const { HookRunner } = await import(`${R}/core/hooks.ts`)
  const runner: any = new HookRunner(undefined, S)
  // `ifMatches` é interno; o comportamento é observável pelo motor de permissão,
  // que tem de concordar com ele — `net` é segmentado, como caminho.
  const casa = (pattern: string, url: string) =>
    permissions.ruleMatches(pattern, { tool: 'WebFetch', kind: 'net', subject: url })
  check('** cruza barras', casa('WebFetch(https://x.com/**)', 'https://x.com/a/b/c'), '')
  check('* não cruza barra', !casa('WebFetch(https://x.com/*)', 'https://x.com/a/b'), '')
  check('runner construído sem hooks não dispara nada', runner.has('PreToolUse') === false, '')
}

// Esperado de verdade: sair com o handle do servidor em fechamento derruba o
// processo com uma asserção do libuv (`UV_HANDLE_CLOSING`, win/async.c) — a
// suíte passa e o runner marca falha pelo exit code.
await new Promise<void>(resolve => server.close(() => resolve()))
await session.mcp.close()
done()
