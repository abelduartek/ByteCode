// Execução em background: `run_in_background`, BashOutput por cursor, KillShell.
//
// Os testes são sobre o que quebraria a sessão de quem NÃO usa a feature: job
// que morre junto com o turno, buffer que cresce sem fim, saída truncada
// justamente no fim, e processo que sobrevive e trava a saída do harness.

const { ROOT, SRC: R, scratch, mockProvider, useConfig, reporter } = await import('./helpers.ts')
const S = await scratch('jobs')

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
const jobs = await import(`${R}/core/jobs.ts`)

const { config } = await loadConfig(ROOT)
const session: any = new Session({ config, cwd: S, modelRef: config.model! })
await session.init(() => {})
registerTools(session)
const notices: string[] = []
session.emit = (e: any) => {
  if (e.type === 'notice') notices.push(e.text)
}
session.requestPermission = async () => true

const ctx = { session, cwd: S, depth: 0 }
const shellName = session.registry.get('Bash') ? 'Bash' : 'PowerShell'
const shell = session.registry.get(shellName)
const output = session.registry.get('BashOutput')
const kill = session.registry.get('KillShell')

/** Um comando que imprime e sai, na sintaxe do shell disponível. */
const echo = (text: string) => (shellName === 'Bash' ? `echo ${text}` : `Write-Output "${text}"`)
/** Um comando que não termina sozinho. */
const forever = shellName === 'Bash' ? 'sleep 120' : 'Start-Sleep -Seconds 120'

const waitFor = async (test: () => boolean, ms = 8000) => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (test()) return true
    await new Promise(r => setTimeout(r, 40))
  }
  return test()
}

log('--- as tools existem e o teto de tools do agente as alcança ---')
{
  check('BashOutput registrada', Boolean(output), '')
  check('KillShell registrada', Boolean(kill), '')
  check('BashOutput é leitura e paraleliza', output.kind === 'read' && output.parallelSafe === true, output.kind)
  check('KillShell é exec', kill.kind === 'exec', kill.kind)
  check('KillShell casa permissão pelo id do job, não por pid',
    kill.subject({ bash_id: 'bash_9' }) === 'bash_9', String(kill.subject({ bash_id: 'bash_9' })))
}

log('--- run_in_background devolve na hora ---')
{
  const antes = Date.now()
  const out = await shell.execute({ command: forever, run_in_background: true }, ctx)
  const levou = Date.now() - antes
  check('voltou sem esperar o comando', levou < 3000, `${levou}ms`)
  check('não é erro', !out.isError, JSON.stringify(out.text))
  const id = out.text.match(/bash_\d+/)?.[0]
  check('devolveu um id', Boolean(id), out.text.slice(0, 120))
  check('e diz como ler', out.text.includes('BashOutput'), out.text.slice(0, 160))

  const job = jobs.getJob(session, id!)
  check('o job está rodando', job?.state === 'running', JSON.stringify(job?.state))

  // O ponto que mais importa: o job NÃO herda o AbortSignal do turno. Se
  // herdasse, um esc na conversa mataria a suíte de testes lançada nela.
  const ac = new AbortController()
  const comSignal = await shell.execute(
    { command: forever, run_in_background: true },
    { ...ctx, signal: ac.signal },
  )
  const idComSignal = comSignal.text.match(/bash_\d+/)![0]
  ac.abort()
  await new Promise(r => setTimeout(r, 300))
  check('abortar o turno NÃO mata o job',
    jobs.getJob(session, idComSignal)?.state === 'running',
    JSON.stringify(jobs.getJob(session, idComSignal)?.state))

  jobs.killJob(jobs.getJob(session, id!)!)
  jobs.killJob(jobs.getJob(session, idComSignal)!)
}

log('--- BashOutput lê por cursor, não o buffer inteiro ---')
{
  const out = await shell.execute({ command: echo('primeira-linha'), run_in_background: true }, ctx)
  const id = out.text.match(/bash_\d+/)![0]

  await waitFor(() => jobs.getJob(session, id)?.state !== 'running')

  const leitura = await output.execute({ bash_id: id }, ctx)
  check('a saída aparece', leitura.text.includes('primeira-linha'), leitura.text.slice(0, 200))
  check('com o estado do job', /exited 0/.test(leitura.text), leitura.text.slice(0, 120))

  const segunda = await output.execute({ bash_id: id }, ctx)
  // O cabeçalho repete o comando (`echo primeira-linha`), então a comparação tem
  // de ser sobre o corpo — é ele que não pode vir duas vezes.
  const corpo = (t: string) => t.split('\n\n').slice(1).join('\n\n')
  check('a segunda leitura não repete o que já foi entregue',
    !corpo(segunda.text).includes('primeira-linha'), JSON.stringify(corpo(segunda.text)))
  check('e diz que não veio nada novo', segunda.text.includes('no new output'), segunda.text.slice(0, 200))
  check('a primeira leitura tinha corpo', corpo(leitura.text).includes('primeira-linha'), JSON.stringify(corpo(leitura.text)))
}

log('--- buffer com teto que declara o que descartou ---')
{
  const job = jobs.listJobs(session)[0]
  const falso: any = {
    ...job,
    id: 'bash_fake',
    produced: 0,
    dropped: 0,
    cursor: 0,
    buffer: '',
    state: 'running',
  }
  // Empurra mais do que cabe, pela porta da frente da estrutura.
  const grande = 'y'.repeat(250_000)
  falso.produced = grande.length
  falso.buffer = grande.slice(-200_000)
  falso.dropped = grande.length - 200_000

  const { text, lost } = jobs.readJob(falso)
  check('o que sobrou respeita o teto', text.length === 200_000, String(text.length))
  check('e o descartado é contado', lost === 50_000, String(lost))
  check('o cursor avança para o fim', falso.cursor === falso.produced, String(falso.cursor))

  const nada = jobs.readJob(falso)
  check('ler de novo não devolve nada', nada.text === '' && nada.lost === 0, JSON.stringify(nada))
}

log('--- KillShell mata e diz a verdade ---')
{
  const out = await shell.execute({ command: forever, run_in_background: true }, ctx)
  const id = out.text.match(/bash_\d+/)![0]

  const morto = await kill.execute({ bash_id: id }, ctx)
  check('responde que está matando', morto.text.includes('Killing'), morto.text)
  const parou = await waitFor(() => jobs.getJob(session, id)?.state === 'killed')
  check('o job vai para killed', parou, JSON.stringify(jobs.getJob(session, id)?.state))
  const fechou = await waitFor(() => jobs.getJob(session, id)?.endedAt !== undefined)
  check('e o processo fechou de verdade', fechou, JSON.stringify(jobs.getJob(session, id)?.endedAt))

  const denovo = await kill.execute({ bash_id: id }, ctx)
  check('matar de novo não mente', denovo.text.includes('already finished'), denovo.text)
}

log('--- ids desconhecidos ---')
{
  const semJob = await output.execute({ bash_id: 'bash_999' }, ctx)
  check('BashOutput recusa id desconhecido', semJob.isError === true, '')
  check('e lista os que existem', /bash_\d+/.test(semJob.text), semJob.text.slice(0, 160))

  const semKill = await kill.execute({ bash_id: 'bash_999' }, ctx)
  check('KillShell recusa id desconhecido', semKill.isError === true, semKill.text)
}

log('--- o fim do job avisa na tela ---')
{
  notices.length = 0
  const out = await shell.execute({ command: echo('pronto'), run_in_background: true }, ctx)
  const id = out.text.match(/bash_\d+/)![0]
  await waitFor(() => notices.some(n => n.includes(id)))
  check('a sessão recebe um aviso quando o job termina',
    notices.some(n => n.includes(id) && n.includes('terminou')), JSON.stringify(notices))
}

log('--- killAllJobs limpa tudo ---')
{
  await shell.execute({ command: forever, run_in_background: true }, ctx)
  await shell.execute({ command: forever, run_in_background: true }, ctx)
  check('há jobs rodando', jobs.listJobs(session).some((j: any) => j.state === 'running'), '')

  jobs.killAllJobs(session)
  const limpou = await waitFor(() => jobs.listJobs(session).every((j: any) => j.state !== 'running'))
  check('nenhum job fica de pé depois do teardown', limpou,
    JSON.stringify(jobs.listJobs(session).map((j: any) => [j.id, j.state])))
}

await session.mcp.close()
done()
