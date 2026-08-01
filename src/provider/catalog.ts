import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModelConfig, ProviderConfig } from '../config/types.ts'
import { ensureDir, readTextIfExists } from '../util/fs.ts'
import { stateFile } from '../util/paths.ts'

// models.dev is the same catalog opencode uses: one JSON document describing
// every known provider, its npm AI SDK package, its env var, and its models with
// context limits and pricing. Connecting a provider therefore needs nothing more
// than an API key — the rest is derived from here.

const CATALOG_URL = 'https://models.dev/api.json'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export type CatalogModel = {
  id: string
  name?: string
  reasoning?: boolean
  tool_call?: boolean
  attachment?: boolean
  release_date?: string
  limit?: { context?: number; output?: number }
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number }
  modalities?: { input?: string[]; output?: string[] }
}

export type CatalogProvider = {
  id: string
  name?: string
  npm?: string
  api?: string
  env?: string[]
  doc?: string
  models: Record<string, CatalogModel>
}

export type Catalog = Record<string, CatalogProvider>

function cachePath(): string {
  return stateFile('models-dev.json')
}

/**
 * Parsed catalog for this process. The on-disk cache is ~3 MB, and reading plus
 * parsing it cost ~25ms every time — paid at boot, on reload, in the `/connect`
 * picker and again after connecting, in the same session.
 */
let memo: { fetchedAt: number; catalog: Catalog } | null = null

async function readCache(): Promise<{ fetchedAt: number; catalog: Catalog } | null> {
  if (memo) return memo
  const raw = await readTextIfExists(cachePath())
  if (!raw) return null
  try {
    memo = JSON.parse(raw) as { fetchedAt: number; catalog: Catalog }
    return memo
  } catch {
    return null
  }
}

/** Test seam, and what `force` uses to guarantee a real refetch. */
export function clearCatalogMemo(): void {
  memo = null
}

async function writeCache(catalog: Catalog): Promise<void> {
  await ensureDir(path.dirname(cachePath()))
  await fs.writeFile(cachePath(), JSON.stringify({ fetchedAt: Date.now(), catalog }), 'utf8')
}

/** At most one background refresh in flight, and it never rejects into a caller. */
let refreshing: Promise<void> | null = null

function refreshInBackground(): Promise<void> {
  if (refreshing) return refreshing
  refreshing = (async () => {
    try {
      const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) })
      if (!response.ok) return
      const catalog = (await response.json()) as Catalog
      memo = { fetchedAt: Date.now(), catalog }
      await writeCache(catalog)
    } catch {
      /* the stale copy already answered; this is best effort */
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/**
 * Returns the catalog, refreshing at most once a day. A network failure falls
 * back to the cache; only a cold cache with no network is an error.
 */
export async function loadCatalog(
  opts: { force?: boolean; offlineOk?: boolean } = {},
): Promise<Catalog> {
  if (opts.force) clearCatalogMemo()
  const cached = await readCache()
  const fresh = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS
  if (cached && fresh && !opts.force) return cached.catalog

  // A stale copy is still a copy. Blocking startup for up to 30 seconds on a
  // slow or captive network — to refresh a list of model names that changes
  // about once a week — is a bad trade; the refresh happens in the background
  // and the next run gets the new one.
  if (cached && !opts.force) {
    void refreshInBackground()
    return cached.catalog
  }

  try {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const catalog = (await response.json()) as Catalog
    memo = { fetchedAt: Date.now(), catalog }
    // Written after the result is already good. Failing to save it is a reason
    // to fetch again next time, not a reason to throw away what was fetched and
    // report the whole thing as a load failure.
    await writeCache(catalog).catch(() => {})
    return catalog
  } catch (err) {
    if (cached) return cached.catalog
    if (opts.offlineOk) return {}
    throw new Error(
      `could not load the provider catalog (${err instanceof Error ? err.message : String(err)}) ` +
        `and no cached copy exists at ${cachePath()}`,
    )
  }
}

/** Ranked provider matches: exact id first, then prefix, then substring. */
export function searchProviders(catalog: Catalog, query: string): CatalogProvider[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const scored: { provider: CatalogProvider; score: number }[] = []
  for (const provider of Object.values(catalog)) {
    const id = provider.id.toLowerCase()
    const name = (provider.name ?? '').toLowerCase()
    let score = 0
    if (id === q) score = 100
    else if (id.startsWith(q)) score = 60
    else if (name.startsWith(q)) score = 50
    else if (id.includes(q)) score = 30
    else if (name.includes(q)) score = 20
    if (score > 0) scored.push({ provider, score })
  }
  return scored
    .sort((a, b) => b.score - a.score || a.provider.id.localeCompare(b.provider.id))
    .map(s => s.provider)
}

/** Providers people reach for first, when there is nothing to search on. */
export const SUGGESTED_PROVIDERS = [
  'anthropic',
  'openai',
  'google',
  'openrouter',
  'groq',
  'mistral',
  'deepseek',
  'xai',
  'cerebras',
  'ollama',
]

function modelKey(id: string): string {
  return id
}

/** Turns a catalog entry into the ProviderConfig shape the registry consumes. */
export function toProviderConfig(
  provider: CatalogProvider,
  overrides: { baseURL?: string } = {},
): ProviderConfig {
  const models: Record<string, ModelConfig> = {}
  for (const [key, model] of Object.entries(provider.models ?? {})) {
    models[modelKey(key)] = {
      id: model.id ?? key,
      name: model.name,
      reasoning: model.reasoning,
      limit: model.limit ? { context: model.limit.context, output: model.limit.output } : undefined,
      cost: model.cost ? { input: model.cost.input, output: model.cost.output } : undefined,
    }
  }

  const baseURL = overrides.baseURL ?? provider.api
  return {
    npm: provider.npm ?? '@ai-sdk/openai-compatible',
    name: provider.name ?? provider.id,
    env: provider.env,
    options: baseURL ? { baseURL } : {},
    models,
  }
}

export function describeProvider(provider: CatalogProvider): string {
  const count = Object.keys(provider.models ?? {}).length
  const npm = provider.npm ?? '@ai-sdk/openai-compatible'
  return `${provider.id} — ${provider.name ?? provider.id} (${count} models, ${npm})`
}
