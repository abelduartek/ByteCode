// Some OpenAI-compatible proxies default `parallel_tool_calls` to false, or omit
// it entirely and behave as if it were — the field is optional in the spec, and
// a proxy tuned for a model that cannot batch reliably has a reason to turn it
// off by default. That silently serialises every independent tool call the
// model would otherwise have emitted together.
//
// `@ai-sdk/openai-compatible` does not expose this as a provider option (checked
// against the installed version: no `parallelToolCalls` anywhere in its dist), so
// the only place to set it is the request body itself — same reasoning, and same
// fetch-wrapping technique, as `promptcache.ts`.
//
// The rule this module follows without exception, same as `promptcache.ts`: this
// must never break a request. A body that is not JSON, that has no `tools`, or
// that already states a `parallel_tool_calls` value (a user's own `provider.options`
// or a future SDK version) passes through untouched.

/** The same request body with `parallel_tool_calls: true` added, or unchanged. */
export function markParallelToolCalls(raw: string): string {
  let body: { tools?: unknown; parallel_tool_calls?: unknown } & Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!Array.isArray(body.tools) || body.tools.length === 0) return raw
  if (body.parallel_tool_calls !== undefined) return raw

  try {
    return JSON.stringify({ ...body, parallel_tool_calls: true })
  } catch {
    return raw
  }
}

type FetchLike = (input: unknown, init?: { body?: unknown; [key: string]: unknown }) => Promise<Response>

/** Wraps the provider's fetch so every request with tools asks for them in parallel. */
export function parallelToolsFetch(base: FetchLike | undefined): FetchLike {
  const inner: FetchLike = base ?? ((input, init) => fetch(input as never, init as never))
  return (input, init) => {
    if (init && typeof init.body === 'string') {
      return inner(input, { ...init, body: markParallelToolCalls(init.body) })
    }
    return inner(input, init)
  }
}
