import type { ModelMessage, SystemModelMessage } from 'ai'
import type { Config, ResolvedModel } from '../config/types.ts'

// Prompt caching. Anthropic charges a cached prefix at ~10% of input, so in an
// agent loop — where every step resends the whole history — it is the cheapest
// win available. The prefix only pays off because it is *stable*: the system
// prompt is built from cwd/model/mode and does not change mid-session, and the
// bootstrap reminders are appended once.
//
// Two breakpoints, never more: the end of the system message, and the end of the
// request. The second is the rolling one — the cache this step writes is the
// prefix the next step reads. Anthropic allows four; spending them on every
// message would write four caches per step and read one.

/**
 * Where the breakpoint has to be written.
 *
 * `sdk` — the provider understands `providerOptions.anthropic.cacheControl`, so
 * the AI SDK carries it. `wire` — it does not, and the marker has to be put in
 * the request body itself (`provider/promptcache.ts`), because the OpenAI-shaped
 * conversion emits the system prompt as a plain string with no block to mark.
 */
export type CacheStyle = 'sdk' | 'wire'
export type CachePolicy = { ttl?: '5m' | '1h'; style: CacheStyle }

/**
 * Providers whose SDK understands `providerOptions.anthropic.cacheControl`.
 * Anything else drops the field silently — which is exactly what used to happen
 * when `cache.enabled` was turned on for an OpenAI-compatible proxy: the request
 * shape changed and nothing was ever cached.
 */
const NATIVE_CACHE_PACKAGES = new Set(['@ai-sdk/anthropic'])

/**
 * `cache.enabled` forces it on for a proxy that speaks Anthropic's dialect
 * behind an OpenAI-compatible surface, or off when a provider bills cache writes
 * in a way the user does not want.
 *
 * It stays **opt-in** for those proxies: `cache_control` is an extension, and a
 * strict OpenAI server that has never seen it should not start receiving it
 * because of a default.
 */
export function cachePolicy(config: Config, resolved: ResolvedModel): CachePolicy | null {
  const cache = config.cache
  if (cache?.enabled === false) return null
  const npm = resolved.provider.npm ?? '@ai-sdk/openai-compatible'
  if (NATIVE_CACHE_PACKAGES.has(npm)) return { ttl: cache?.ttl, style: 'sdk' }
  if (cache?.enabled !== true) return null
  return { ttl: cache?.ttl, style: 'wire' }
}

type ProviderOptions = NonNullable<SystemModelMessage['providerOptions']>

function breakpoint(policy: CachePolicy): ProviderOptions {
  return {
    anthropic: { cacheControl: { type: 'ephemeral', ...(policy.ttl ? { ttl: policy.ttl } : {}) } },
  }
}

/**
 * The system prompt as a system *message*, which is the only shape that can
 * carry provider options — `streamText({ system: string })` has nowhere to hang
 * them, and a system message inside `messages` is rejected outright by the SDK
 * (`System messages are not allowed in the prompt or messages fields`), which
 * fails the whole turn rather than the caching.
 */
export function cachedSystem(system: string, policy: CachePolicy): SystemModelMessage {
  return { role: 'system', content: system, providerOptions: breakpoint(policy) }
}

/**
 * Marks the end of the request — the rolling breakpoint. The cache this step
 * writes is the prefix the next step reads.
 *
 * Nothing is mutated: `session.messages` is the session's own array and provider
 * options are a wire concern, not history.
 */
export function withCacheControl(messages: ModelMessage[], policy: CachePolicy): ModelMessage[] {
  const last = messages.at(-1)
  if (!last) return messages
  return [...messages.slice(0, -1), { ...last, providerOptions: breakpoint(policy) } as ModelMessage]
}
