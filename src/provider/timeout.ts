import { Agent, fetch as undiciFetch } from 'undici'

// undici's default is 300s of silence between response chunks before it gives
// up (`bodyTimeout`/`headersTimeout`). That is generous for a normal turn, but
// a provider that streams one very large completion with a real proxy-side
// pause longer than that trips it mid-answer — and by the time it fails, text
// has usually already reached the user, so the loop's retry is correctly
// refused (see `loop.ts`: a retry is only safe while nothing has been shown).
// The fix has to be a longer timeout, not a retry.
//
// Node's own global `fetch` cannot take an externally constructed `Agent` as
// its `dispatcher` — verified empirically: it throws `UND_ERR_INVALID_ARG`
// ("invalid onRequestStart method"), because Node's *internal* bundled undici
// and this npm package speak different internal handler shapes even at the
// same nominal version. So a custom timeout has to go through undici's own
// `fetch`, paired with undici's own `Agent` — not the global one.
//
// Only built when a provider actually configures `timeout`: every provider
// that does not ask for something different keeps using the plain fetch it
// already had, untouched.

const agents = new Map<number, Agent>()

function agentFor(seconds: number): Agent {
  let agent = agents.get(seconds)
  if (!agent) {
    agent = new Agent({ bodyTimeout: seconds * 1000, headersTimeout: seconds * 1000 })
    agents.set(seconds, agent)
  }
  return agent
}

type FetchLike = (input: unknown, init?: { [key: string]: unknown }) => Promise<Response>

/**
 * A fetch that uses undici's own client with the given per-provider timeout,
 * instead of whatever `base` would otherwise have used. Meant to be the
 * innermost fetch in the chain — `cachingFetch`/`parallelToolsFetch` wrap
 * *this*, not the other way around, since both only rewrite `init.body` and
 * call through to whatever performs the actual request.
 */
export function timeoutFetch(seconds: number): FetchLike {
  const dispatcher = agentFor(seconds)
  return (input, init) =>
    undiciFetch(input as never, { ...init, dispatcher } as never) as unknown as Promise<Response>
}
