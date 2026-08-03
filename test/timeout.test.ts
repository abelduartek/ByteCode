// A provider that stalls mid-body — a real proxy pause longer than undici's
// default 300s, or a stalled test double — used to be undiagnosable without
// waiting five minutes. `timeoutFetch` makes the wait configurable per
// provider; this suite proves the override actually takes effect (Node's own
// global fetch was verified NOT to accept an externally constructed undici
// `Agent` as its dispatcher — `UND_ERR_INVALID_ARG`, "invalid onRequestStart
// method" — so this has to go through undici's own fetch, which is the thing
// under test here).

const { reporter, SRC: R } = await import('./helpers.ts')
const { check, log, done } = reporter()
const { timeoutFetch } = await import(`${R}/provider/timeout.ts`)
const http = await import('node:http')

/** A server that sends headers, writes one chunk, then goes silent forever. */
function stalledServer(): Promise<{ port: number; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.write('start')
      // Never writes more, never ends — the body simply stalls.
    })
    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({
        port,
        close: () => {
          server.closeAllConnections()
          server.close()
        },
      })
    })
  })
}

/** Reads the body so a stall actually blocks the call — headers arrive instantly either way. */
async function readBody(fetchFn: (url: string, init?: unknown) => Promise<Response>, url: string, init?: unknown): Promise<{ code: string }> {
  try {
    const res = await fetchFn(url, init)
    await (res as Response).text()
    return { code: '' }
  } catch (err: any) {
    return { code: err?.cause?.code ?? err?.code ?? err?.name ?? 'unknown' }
  }
}

log('--- timeoutFetch aplica um bodyTimeout curto ---')
{
  const { port, close } = await stalledServer()
  try {
    const fetchWithShortTimeout = timeoutFetch(1)
    const t0 = Date.now()
    const { code } = await readBody(fetchWithShortTimeout, `http://127.0.0.1:${port}/`)
    const elapsed = Date.now() - t0
    check('desiste com UND_ERR_BODY_TIMEOUT', code === 'UND_ERR_BODY_TIMEOUT', code)
    check('desiste perto de 1s, não de 300s', elapsed < 5_000, `${elapsed}ms`)
  } finally {
    close()
  }
}

log('--- timeoutFetch com timeout maior aguenta o mesmo silêncio ---')
{
  // Prova que o timeout de 30s não dispara antes disso: aborta a própria
  // chamada em 1.5s (depois do 1s que já provou derrubar a anterior) e checa
  // que o motivo foi o abort, não um UND_ERR_BODY_TIMEOUT prematuro. O abort
  // também garante que a conexão não fica pendurada até o fim do processo.
  const { port, close } = await stalledServer()
  try {
    const fetchWithLongTimeout = timeoutFetch(30)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 1_500)
    const t0 = Date.now()
    const { code } = await readBody(fetchWithLongTimeout, `http://127.0.0.1:${port}/`, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    check(
      'o motivo foi o abort do teste, não o bodyTimeout de 1s',
      code !== 'UND_ERR_BODY_TIMEOUT',
      `${code} após ${Date.now() - t0}ms`,
    )
  } finally {
    close()
  }
}

log('--- duas chamadas com o mesmo timeout se comportam igual (Agent reaproveitado) ---')
{
  const { port, close } = await stalledServer()
  try {
    const fetchFn = timeoutFetch(1)
    const first = await readBody(fetchFn, `http://127.0.0.1:${port}/`)
    const second = await readBody(fetchFn, `http://127.0.0.1:${port}/`)
    check(
      'as duas terminam com UND_ERR_BODY_TIMEOUT',
      first.code === 'UND_ERR_BODY_TIMEOUT' && second.code === 'UND_ERR_BODY_TIMEOUT',
      `${first.code} / ${second.code}`,
    )
  } finally {
    close()
  }
}

done()
