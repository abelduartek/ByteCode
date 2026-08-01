import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CatalogProvider } from './catalog.ts'
import {
  describeProvider,
  loadCatalog,
  SUGGESTED_PROVIDERS,
  searchProviders,
} from './catalog.ts'
import { connectedProviders, maskKey, readAuth, removeCredential, saveCredential } from './auth.ts'

// The `/connect` flow: pick a provider from the models.dev catalog, store a key,
// and the provider becomes usable immediately — no config file editing. The IO
// surface is abstracted so the same flow runs from the CLI and from the TUI.

export type ConnectIO = {
  write: (text: string) => void
  ask: (question: string) => Promise<string>
  askSecret: (question: string) => Promise<string>
}

export type ConnectResult = {
  providerId: string
  models: string[]
  file: string
  npmMissing?: string
}

const require_ = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
)

function isInstalled(npmName: string): boolean {
  try {
    require_.resolve(`${npmName}/package.json`)
    return true
  } catch {
    try {
      require_.resolve(npmName)
      return true
    } catch {
      return false
    }
  }
}

/** Newest models first — that is what people usually want to see. */
export function topModels(provider: CatalogProvider, limit = 8): string[] {
  return Object.entries(provider.models ?? {})
    .sort(([, a], [, b]) => (b.release_date ?? '').localeCompare(a.release_date ?? ''))
    .slice(0, limit)
    .map(([key]) => key)
}

async function pickProvider(
  io: ConnectIO,
  catalog: Record<string, CatalogProvider>,
  query: string | undefined,
): Promise<CatalogProvider | null> {
  let term = query

  for (let attempt = 0; attempt < 5; attempt++) {
    if (!term) {
      const connected = await connectedProviders()
      io.write('Connected: ' + (connected.join(', ') || '(none)') + '\n')
      const suggestions = SUGGESTED_PROVIDERS.filter(id => catalog[id]).slice(0, 10)
      io.write(`Popular: ${suggestions.join(', ')}\n`)
      io.write(`${Object.keys(catalog).length} providers available.\n`)
      term = (await io.ask('provider (name or search): ')).trim()
      if (!term) return null
    }

    const matches = searchProviders(catalog, term)
    if (matches.length === 0) {
      io.write(`no provider matches "${term}"\n`)
      term = undefined
      continue
    }
    if (matches.length === 1 || matches[0].id.toLowerCase() === term.toLowerCase()) {
      return matches[0]
    }

    io.write('matches:\n')
    matches.slice(0, 15).forEach((p, i) => io.write(`  ${i + 1}. ${describeProvider(p)}\n`))
    const choice = (await io.ask('pick a number (or type another search): ')).trim()
    const index = Number(choice)
    if (Number.isInteger(index) && index >= 1 && index <= Math.min(matches.length, 15)) {
      return matches[index - 1]
    }
    term = choice || undefined
  }
  return null
}

export async function runConnect(
  io: ConnectIO,
  opts: {
    provider?: string
    key?: string
    baseURL?: string
    /** Providers declared in the config, which never appear in the catalog. */
    local?: Record<string, LocalProvider>
  } = {},
): Promise<ConnectResult | null> {
  // A key on the command line means "do not ask me anything".
  const nonInteractive = Boolean(opts.key)

  // A config-declared provider still needs a credential. Connect to it directly
  // instead of searching models.dev and reporting "unknown provider".
  const local = opts.provider ? opts.local?.[opts.provider] : undefined
  if (local) return connectLocal(io, opts.provider as string, local, opts)

  io.write('loading provider catalog...\n')
  const catalog = await loadCatalog()

  const provider = await pickProvider(io, catalog, opts.provider)
  if (!provider) {
    io.write('cancelled\n')
    return null
  }

  const npmName = provider.npm ?? '@ai-sdk/openai-compatible'
  io.write(`\n${describeProvider(provider)}\n`)
  if (provider.doc) io.write(`docs: ${provider.doc}\n`)

  const npmMissing = isInstalled(npmName) ? undefined : npmName
  if (npmMissing) {
    io.write(
      `note: the SDK package "${npmName}" is not installed here.\n` +
        `      run  npm install ${npmName}  before using this provider.\n`,
    )
  }

  let key = opts.key
  if (!key) {
    const envName = provider.env?.[0]
    const fromEnv = envName ? process.env[envName] : undefined
    if (fromEnv) {
      const use = (await io.ask(`use ${envName} from the environment? [Y/n] `)).trim().toLowerCase()
      if (use === '' || use === 'y' || use === 'yes') key = fromEnv
    }
  }
  if (!key) {
    key = (await io.askSecret(`API key for ${provider.id}: `)).trim()
  }
  if (!key) {
    io.write('no key given — nothing saved\n')
    return null
  }

  let baseURL = opts.baseURL
  if (!baseURL && !nonInteractive) {
    const defaultBase = provider.api ?? ''
    const answer = (
      await io.ask(
        `base URL${defaultBase ? ` [${defaultBase}]` : ' (blank for provider default)'}: `,
      )
    ).trim()
    baseURL = answer || undefined
  }

  const file = await saveCredential(provider.id, { type: 'api', key, baseURL })
  const models = topModels(provider)

  io.write(`\nsaved ${maskKey(key)} for "${provider.id}" in ${file}\n`)
  if (models.length > 0) {
    io.write('models:\n')
    for (const m of models) io.write(`  ${provider.id}/${m}\n`)
    io.write(`\nuse it:  bytecode -m ${provider.id}/${models[0]}\n`)
  }

  return { providerId: provider.id, models, file, npmMissing }
}

export type LocalProvider = {
  name?: string
  env?: string[]
  options?: Record<string, unknown>
  models?: Record<string, unknown>
}

async function connectLocal(
  io: ConnectIO,
  providerId: string,
  provider: LocalProvider,
  opts: { key?: string; baseURL?: string },
): Promise<ConnectResult | null> {
  const baseURL = (provider.options?.baseURL as string | undefined) ?? '(default do provider)'
  const envName = provider.env?.[0]

  let key = opts.key ?? (envName ? process.env[envName] : undefined)
  if (key && envName && !opts.key) io.write(`usando ${envName} do ambiente\n`)
  if (!key) {
    io.write(`${providerId} — ${provider.name ?? providerId} · ${baseURL}\n`)
    key = (await io.askSecret(`API key for ${providerId}: `)).trim()
  }
  if (!key) {
    io.write('no key given — nothing saved\n')
    return null
  }

  const file = await saveCredential(providerId, { type: 'api', key, baseURL: opts.baseURL })
  const models = Object.keys(provider.models ?? {}).slice(0, 8)
  io.write(`\nsaved ${maskKey(key)} for "${providerId}" in ${file}\n`)
  for (const model of models) io.write(`  ${providerId}/${model}\n`)
  return { providerId, models, file }
}

export async function runDisconnect(io: ConnectIO, providerId?: string): Promise<boolean> {
  const connected = await connectedProviders()
  if (connected.length === 0) {
    io.write('nothing connected\n')
    return false
  }

  let target = providerId
  if (!target) {
    io.write(`connected: ${connected.join(', ')}\n`)
    target = (await io.ask('disconnect which provider? ')).trim()
  }
  if (!target) return false

  const removed = await removeCredential(target)
  io.write(removed ? `disconnected "${target}"\n` : `"${target}" was not connected\n`)
  return removed
}

export async function listConnections(io: ConnectIO): Promise<void> {
  const store = await readAuth()
  const ids = Object.keys(store).sort()
  if (ids.length === 0) {
    io.write('no providers connected — run `bytecode connect`\n')
    return
  }
  for (const id of ids) {
    const entry = store[id]
    const key = entry.key ?? entry.apiKey ?? entry.token ?? ''
    const base = entry.baseURL ? ` @ ${entry.baseURL}` : ''
    io.write(`  ${id}  ${key ? maskKey(key) : '(no key)'}${base}\n`)
  }
}
