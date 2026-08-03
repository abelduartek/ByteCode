import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config, ProviderConfig, ResolvedModel } from '../config/types.ts'
import type { CachePolicy } from '../core/cache.ts'
import { cachingFetch } from './promptcache.ts'
import { parallelToolsFetch } from './paralleltools.ts'
import { timeoutFetch } from './timeout.ts'
import { keyOf, openCodeAuthPaths, readAuth, readAuthFile } from './auth.ts'
import { loadCatalog, toProviderConfig } from './catalog.ts'
import { stateFiles } from '../util/paths.ts'

// Provider factories are loaded from npm at runtime, opencode-style: the config
// names a package (`npm`) and the harness imports it. That is what makes the
// provider layer open-ended instead of a fixed switch statement.

type LanguageModel = unknown
type ProviderFactory = (options: Record<string, unknown>) => unknown

const require_ = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
)

const FACTORY_NAMES = [
  'createOpenAICompatible',
  'createAnthropic',
  'createOpenAI',
  'createGoogleGenerativeAI',
  'createMistral',
  'createGroq',
  'createCerebras',
  'createXai',
  'createDeepSeek',
  'default',
]

const DEFAULT_NPM = '@ai-sdk/openai-compatible'

const factoryCache = new Map<string, ProviderFactory>()
const providerCache = new Map<string, unknown>()

export function parseModelRef(ref: string): { providerId: string; modelKey: string } {
  const idx = ref.indexOf('/')
  if (idx === -1) {
    throw new Error(`model must be "provider/model", got "${ref}"`)
  }
  return { providerId: ref.slice(0, idx), modelKey: ref.slice(idx + 1) }
}

function isDisabled(config: Config, providerId: string): boolean {
  return (config.disabledProviders ?? []).includes(providerId)
}

export function resolveModel(config: Config, ref: string): ResolvedModel {
  const { providerId, modelKey } = parseModelRef(ref)
  if (isDisabled(config, providerId)) {
    throw new Error(`provider "${providerId}" is listed in disabledProviders`)
  }
  const provider = config.provider?.[providerId]
  if (!provider) {
    const known = Object.keys(config.provider ?? {}).join(', ') || '(none)'
    throw new Error(`unknown provider "${providerId}". Configured: ${known}`)
  }
  const model = provider.models?.[modelKey]
  if (!model) {
    const known = Object.keys(provider.models ?? {}).join(', ') || '(none)'
    throw new Error(`unknown model "${modelKey}" on "${providerId}". Configured: ${known}`)
  }
  return {
    providerId,
    modelKey,
    modelId: model.id ?? modelKey,
    provider,
    model,
  }
}

async function loadFactory(npmName: string): Promise<ProviderFactory> {
  const cached = factoryCache.get(npmName)
  if (cached) return cached

  let mod: Record<string, unknown>
  try {
    mod = (await import(npmName)) as Record<string, unknown>
  } catch (esmError) {
    // Fall back to CJS resolution for packages without an ESM entry.
    try {
      mod = require_(npmName) as Record<string, unknown>
    } catch (err) {
      // "Not installed" is only true when the module could not be *found*. A
      // package that is installed but throws while loading — a version mismatch,
      // a broken native binding — reported the same thing, and `npm install`
      // then changed nothing at all.
      const code = (err as { code?: string }).code
      const missing = code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND'
      if (missing) {
        throw new Error(
          `provider package "${npmName}" is not installed (${(err as Error).message}). ` +
            `Run: npm install ${npmName}`,
        )
      }
      throw new Error(
        `provider package "${npmName}" is installed but failed to load: ` +
          `${(esmError as Error).message} / ${(err as Error).message}`,
      )
    }
  }

  for (const name of FACTORY_NAMES) {
    const candidate = mod[name]
    if (typeof candidate === 'function') {
      const fn = candidate as ProviderFactory
      factoryCache.set(npmName, fn)
      return fn
    }
  }
  const exported = Object.keys(mod).join(', ')
  throw new Error(
    `no provider factory found in "${npmName}". Exports: ${exported}`,
  )
}

/** Own store first (current name, then pre-rename), opencode only on opt-in. */
function authStorePaths(useOpenCode: boolean): string[] {
  const own = stateFiles('auth.json')
  return useOpenCode ? [...own, ...openCodeAuthPaths()] : own
}

async function apiKeyFor(
  providerId: string,
  provider: ProviderConfig,
  useOpenCodeAuth: boolean,
): Promise<string | undefined> {
  const fromOptions = provider.options?.apiKey
  if (typeof fromOptions === 'string' && fromOptions) return fromOptions

  let stored: string | undefined
  let ignoreEnv = false
  for (const file of authStorePaths(useOpenCodeAuth)) {
    const entry = (await readAuthFile(file))[providerId]
    if (entry?.ignoreEnv) ignoreEnv = true
    const key = keyOf(entry)
    if (key && !stored) stored = key
  }

  // `connect` offers the environment variable and takes no for an answer: a user
  // who declined it and typed a key had that key stored and then ignored, since
  // the variable was still read first at every call.
  if (!ignoreEnv) {
    for (const name of provider.env ?? []) {
      const v = process.env[name]
      if (v) return v
    }
    // Conventional fallback: <PROVIDER_ID>_API_KEY, upper-snake-cased.
    const conventional =
      process.env[`${providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`]
    if (conventional) return conventional
  }

  return stored
}

/**
 * Adds providers the user connected with `bytecode connect` but never wrote into
 * a config file, deriving their definition from the models.dev catalog. Config
 * entries always win; the catalog only fills gaps.
 */
export async function withConnectedProviders(config: Config): Promise<Config> {
  const store = await readAuth()
  const missing = Object.keys(store).filter(id => !config.provider?.[id])
  if (missing.length === 0) return config

  const catalog = await loadCatalog({ offlineOk: true })
  const provider: Record<string, ProviderConfig> = { ...(config.provider ?? {}) }
  for (const id of missing) {
    const entry = catalog[id]
    if (!entry) continue
    provider[id] = toProviderConfig(entry, { baseURL: store[id]?.baseURL })
  }
  return { ...config, provider }
}

/**
 * Instantiates the AI SDK language model for a resolved reference.
 * Per-model headers are merged over per-provider headers.
 */
export async function createLanguageModel(
  resolved: ResolvedModel,
  opts: { openCodeAuth?: boolean; cache?: CachePolicy | null } = {},
): Promise<LanguageModel> {
  const { provider, providerId, modelId, model } = resolved
  const npmName = provider.npm ?? DEFAULT_NPM

  const options: Record<string, unknown> = {
    name: providerId,
    ...(provider.options ?? {}),
  }
  // Innermost first: `timeoutFetch` is what actually performs the request when
  // configured, and the wrappers below only rewrite `init.body`/reuse whatever
  // is already in `options.fetch` and call through — order between them and
  // this one does not matter, but they must wrap this, not the other way round.
  if (typeof provider.timeout === 'number') {
    options.fetch = timeoutFetch(provider.timeout)
  }
  // The `wire` style has to reach the request body, which no provider option
  // exposes — so the provider's own fetch is wrapped. See `promptcache.ts` for
  // why `providerOptions` cannot carry it on an OpenAI-shaped surface.
  if (opts.cache?.style === 'wire') {
    options.fetch = cachingFetch(options.fetch as never, opts.cache)
  }
  // The AI SDK's own tool-calling is provider-agnostic and the model decides on
  // its own whether to batch — but some OpenAI-compatible proxies default
  // `parallel_tool_calls` to false or omit it, which serialises every
  // independent call the model would otherwise have emitted together. See
  // `paralleltools.ts`: not exposed as a provider option, so it goes in through
  // the same fetch-wrapping the cache breakpoint uses.
  if (npmName === DEFAULT_NPM) {
    options.fetch = parallelToolsFetch(options.fetch as never)
  }
  // An OpenAI-compatible server does not report token usage on a *streamed*
  // response unless the request asks for it, and the SDK only asks when told to
  // (`stream_options: { include_usage: true }`, openai-compatible
  // `dist/index.js:701`). Without it every turn reported 0 tokens and $0.00 —
  // and worse, `tokenBaseline` never got set, so the compaction threshold was
  // decided on an estimate and cache hits were invisible. Opt-out stays possible
  // for a proxy that rejects the field.
  if (npmName === DEFAULT_NPM && options.includeUsage === undefined) {
    options.includeUsage = true
  }
  // Some proxies need no key at all. Sending a placeholder makes them reject
  // with a confusing message, so the header is simply omitted when unresolved.
  const apiKey = await apiKeyFor(providerId, provider, opts.openCodeAuth ?? false)
  if (apiKey) options.apiKey = apiKey
  else delete options.apiKey

  const providerHeaders = (provider.options?.headers ?? {}) as Record<string, string>
  const headers = { ...providerHeaders, ...(model.headers ?? {}) }
  if (Object.keys(headers).length > 0) options.headers = headers

  // The policy is part of the key: the same provider with and without the
  // caching fetch are two different instances, and reusing one for the other
  // would either lose the marker or keep it after it was turned off.
  //
  // So are the credential and the endpoint. Keyed only by name, a `/connect`
  // that replaced an expired key mid-session kept handing back the instance
  // built with the old one — the session went on failing to authenticate until
  // it was restarted, with a key on disk that was perfectly good.
  const identity = JSON.stringify([apiKey ?? null, options.baseURL ?? null, headers])
  const cacheKey = `${npmName}::${providerId}::${identity}::${
    opts.cache?.style === 'wire' ? `wire-${opts.cache.ttl ?? 'default'}` : 'plain'
  }`
  let instance = providerCache.get(cacheKey)
  if (!instance) {
    const factory = await loadFactory(npmName)
    instance = factory(options)
    providerCache.set(cacheKey, instance)
  }

  const asFn = instance as (id: string) => LanguageModel
  if (typeof asFn === 'function') return asFn(modelId)

  const asObj = instance as {
    languageModel?: (id: string) => LanguageModel
    chat?: (id: string) => LanguageModel
  }
  if (typeof asObj.languageModel === 'function') return asObj.languageModel(modelId)
  if (typeof asObj.chat === 'function') return asObj.chat(modelId)

  throw new Error(`provider "${providerId}" did not return a callable model factory`)
}

export function listModels(config: Config): string[] {
  const out: string[] = []
  for (const [providerId, provider] of Object.entries(config.provider ?? {})) {
    if (isDisabled(config, providerId)) continue
    for (const modelKey of Object.keys(provider.models ?? {})) {
      out.push(`${providerId}/${modelKey}`)
    }
  }
  return out.sort()
}
