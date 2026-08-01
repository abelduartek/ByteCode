import type { CachePolicy } from '../core/cache.ts'

// Prompt caching for providers that speak the OpenAI wire format in front of an
// Anthropic model — LiteLLM, OpenRouter, and the proxies built on them.
//
// Why this lives at the fetch layer and not in `providerOptions`:
// `@ai-sdk/openai-compatible` reads message provider options **only** under the
// key `openaiCompatible` (`dist/index.js:113`) and spreads them onto the wire
// message, and it emits the system prompt as a plain string (`dist/index.js:133`)
// — there is no content block to hang `cache_control` on. Both LiteLLM and
// OpenRouter document the marker **inside a content part**, so the only place
// that shape can be produced is the request body itself.
//
// The rule this module follows without exception: a caching optimisation must
// never break a request. Anything unexpected — a body that is not JSON, a shape
// without `messages`, a message with nothing markable — passes through untouched.

type Part = { type?: string; text?: string; [key: string]: unknown }
type WireMessage = { role?: string; content?: unknown; [key: string]: unknown }

/** Roles whose content may carry a marked text part. */
const MARKABLE = new Set(['system', 'user', 'assistant', 'tool'])

function control(policy: CachePolicy): Record<string, unknown> {
  return { type: 'ephemeral', ...(policy.ttl ? { ttl: policy.ttl } : {}) }
}

/**
 * The same message with `cache_control` on its last text part, or `null` when
 * there is nothing to mark — an assistant turn that is only `tool_calls` has
 * `content: null`, and marking it would be marking nothing.
 */
function marked(message: WireMessage, policy: CachePolicy): WireMessage | null {
  if (!MARKABLE.has(String(message.role))) return null
  const content = message.content

  if (typeof content === 'string') {
    if (content.length === 0) return null
    return { ...message, content: [{ type: 'text', text: content, cache_control: control(policy) }] }
  }

  if (Array.isArray(content)) {
    const parts = content as Part[]
    // The breakpoint covers the prefix up to and including where it sits, so it
    // belongs on the **last** text part rather than the first.
    const at = parts.map(p => p?.type === 'text').lastIndexOf(true)
    if (at === -1) return null
    const next = parts.slice()
    next[at] = { ...next[at], cache_control: control(policy) }
    return { ...message, content: next }
  }

  return null
}

/**
 * Two breakpoints, the same two the Anthropic-native path uses: the end of the
 * system prompt, and the end of the request.
 *
 * The second is the rolling one — the cache this call writes is the prefix the
 * next call reads. It walks backwards because the last message is often an
 * assistant turn carrying only `tool_calls`, which has no content to mark.
 */
export function markRequestBody(raw: string, policy: CachePolicy): string {
  let body: { messages?: unknown[] } & Record<string, unknown>
  try {
    body = JSON.parse(raw)
  } catch {
    return raw
  }
  if (!Array.isArray(body.messages) || body.messages.length === 0) return raw

  const messages = (body.messages as WireMessage[]).slice()
  let changed = false

  const systemAt = messages.findIndex(m => m.role === 'system')
  if (systemAt !== -1) {
    const next = marked(messages[systemAt], policy)
    if (next) {
      messages[systemAt] = next
      changed = true
    }
  }

  for (let i = messages.length - 1; i >= 0; i--) {
    if (i === systemAt) break
    const next = marked(messages[i], policy)
    if (next) {
      messages[i] = next
      changed = true
      break
    }
  }

  if (!changed) return raw
  try {
    return JSON.stringify({ ...body, messages })
  } catch {
    return raw
  }
}

type FetchLike = (input: unknown, init?: { body?: unknown; [key: string]: unknown }) => Promise<Response>

/**
 * Wraps the provider's fetch so every outgoing request carries the breakpoints.
 * A non-string body (a stream, a buffer) is left alone: rewriting one would cost
 * more than the cache saves, and it is not a shape this provider produces.
 */
export function cachingFetch(base: FetchLike | undefined, policy: CachePolicy): FetchLike {
  const inner: FetchLike = base ?? ((input, init) => fetch(input as never, init as never))
  return (input, init) => {
    if (init && typeof init.body === 'string') {
      return inner(input, { ...init, body: markRequestBody(init.body, policy) })
    }
    return inner(input, init)
  }
}
