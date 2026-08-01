import { existsSync, promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Config } from '../config/types.ts'
import { brokenAuthFiles, openCodeAuthPaths, authPath, readAuthFile } from '../provider/auth.ts'
import { CLI, LEGACY_CLI, hasLegacyState, legacyStateDir, stateDir, stateFiles } from '../util/paths.ts'
import { resolveModel } from '../provider/registry.ts'
import { discoverMcpServers, inheritableMcpServers } from '../mcp/discover.ts'

// `bytecode doctor` answers, from the code rather than by guessing: which files
// are actually read, which are ignored, and where each credential comes from.
//
// The reason this exists: asked "where is the auth.json bytecode reads?", a model
// ran `find` over the home directory, spotted opencode's store and concluded
// ByteCode ran on opencode's backend. It does not. Inference from a filesystem
// scan cannot tell an ignored file from a used one — only the resolution order
// can, so it is printed.

export type FileReport = {
  path: string
  exists: boolean
  used: boolean
  note: string
}

export type CredentialSource =
  | { kind: 'config'; detail: string }
  | { kind: 'env'; detail: string }
  | { kind: 'store'; detail: string }
  | { kind: 'none'; detail: string }

export type DoctorReport = {
  files: FileReport[]
  credentials: { provider: string; source: CredentialSource }[]
  model: { ref: string; resolved: boolean; note: string }
  /** Where each MCP server comes from, and whether it is actually being used. */
  mcp: { name: string; source: string; used: boolean; note: string }[]
  warnings: string[]
}

/** Mirrors `apiKeyFor` in the registry — same order, without reading any secret. */
async function credentialSource(
  providerId: string,
  config: Config,
): Promise<CredentialSource> {
  const provider = config.provider?.[providerId]
  if (!provider) return { kind: 'none', detail: 'provider não declarado' }

  if (typeof provider.options?.apiKey === 'string' && provider.options.apiKey) {
    return { kind: 'config', detail: 'options.apiKey (em arquivo de config)' }
  }

  // Both stores are read here, in the same order the resolver reads them —
  // including the pre-rename file. Skipping it made `doctor` report "nenhuma
  // credencial" for a provider that was authenticating perfectly well from
  // ~/.hx/auth.json, which is the opposite of what this command is for.
  const stores = stateFiles('auth.json')
  let storeFile: string | undefined
  let ignoreEnv = false
  for (const file of stores) {
    const entry = (await readAuthFile(file))[providerId]
    if (!entry) continue
    if (entry.ignoreEnv) ignoreEnv = true
    storeFile ??= file
  }

  if (!ignoreEnv) {
    for (const name of provider.env ?? []) {
      if (process.env[name]) return { kind: 'env', detail: `$${name}` }
    }
    const conventional = `${providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
    if (process.env[conventional]) return { kind: 'env', detail: `$${conventional}` }
  }

  if (storeFile) {
    return {
      kind: 'store',
      detail: ignoreEnv ? `${storeFile} (env ignorada a pedido do connect)` : storeFile,
    }
  }

  if (config.openCodeAuth) {
    for (const file of openCodeAuthPaths()) {
      const store = await readAuthFile(file)
      if (store[providerId]) return { kind: 'store', detail: `${file} (openCodeAuth: true)` }
    }
  }

  return {
    kind: 'none',
    detail: `nenhuma credencial resolvida — endpoint pode não exigir auth`,
  }
}

export async function runDoctor(config: Config, cwd: string): Promise<DoctorReport> {
  const warnings: string[] = []
  const files: FileReport[] = []

  const add = (p: string, used: boolean, note: string) =>
    files.push({ path: p, exists: existsSync(p), used, note })

  // Config. The canonical path is printed literally, not through the fallback
  // helper — otherwise a machine without the new directory would be told its own
  // config lives under the old name, which is the opposite of the point.
  add(path.join(homedir(), '.config', CLI, `${CLI}.jsonc`), true, 'config do usuário (própria)')
  add(path.join(homedir(), '.config', LEGACY_CLI, `${LEGACY_CLI}.jsonc`), true, 'config legada (fallback)')
  add(path.join(cwd, `${CLI}.jsonc`), true, 'config do projeto')
  add(path.join(cwd, `${LEGACY_CLI}.jsonc`), true, 'config do projeto, nome legado (fallback)')

  // Estado. Tudo é escrito no diretório atual; o antigo continua sendo lido.
  add(authPath(), true, 'credenciais — GRAVADAS aqui')
  add(path.join(legacyStateDir(), 'auth.json'), true, 'credenciais de antes do rename (só leitura)')
  add(path.join(stateDir(), 'projects'), true, 'sessões e transcripts — GRAVADOS aqui')
  add(path.join(legacyStateDir(), 'projects'), true, 'sessões de antes do rename (só leitura)')
  add(path.join(stateDir(), 'workflows'), true, 'scripts e journals de workflow')

  // opencode — lido só com opt-in
  for (const file of openCodeAuthPaths()) {
    add(
      file,
      Boolean(config.openCodeAuth),
      config.openCodeAuth
        ? 'credenciais do opencode (openCodeAuth: true)'
        : 'credenciais do opencode — IGNORADAS (openCodeAuth não está ligado)',
    )
  }

  if (hasLegacyState()) {
    warnings.push(
      `Existe estado em ${legacyStateDir()} (de antes do rename) e nada em ${stateDir()} ainda. ` +
        `Ele continua sendo lido; \`${CLI} setup\` copia para o nome novo.`,
    )
  }
  if (!existsSync(path.join(homedir(), '.config', CLI, `${CLI}.jsonc`))) {
    warnings.push(`Sem config própria: rode \`${CLI} setup\` para criar ~/.config/${CLI}/${CLI}.jsonc.`)
  }

  // Reported before anything else: a broken store looks exactly like an empty one
  // to the resolver, and "no credential" would send the reader hunting the wrong
  // thing entirely.
  for (const broken of brokenAuthFiles()) {
    warnings.push(
      `${broken.file} não é JSON válido (${broken.error}) — as credenciais dele são ignoradas.`,
    )
  }

  const inlineKeys = Object.entries(config.provider ?? {})
    .filter(([, p]) => typeof p.options?.apiKey === 'string' && p.options.apiKey)
    .map(([id]) => id)
  if (inlineKeys.length > 0) {
    warnings.push(
      `Chave em texto puro na config para: ${inlineKeys.join(', ')}. Prefira env var ou ${authPath()}.`,
    )
  }

  const credentials = await Promise.all(
    Object.keys(config.provider ?? {}).map(async provider => ({
      provider,
      source: await credentialSource(provider, config),
    })),
  )

  // MCP: own block, plus what would be inherited. A server that exists in another
  // tool's config but is not being used has to say so — otherwise the absence of a
  // tool looks like a bug instead of a setting.
  const mcp: DoctorReport['mcp'] = []
  for (const server of await discoverMcpServers(config, cwd)) {
    const enabled = server.config.enabled !== false
    mcp.push({
      name: server.name,
      source: server.source,
      used: enabled,
      note: enabled
        ? server.source === 'own'
          ? 'bloco "mcp" desta config'
          : `herdado de ${server.source} (${server.file ?? '?'})`
        : '"enabled": false — declarado e não conectado',
    })
  }
  const declared = new Set(mcp.map(s => s.name))
  for (const server of await inheritableMcpServers(config, cwd)) {
    if (declared.has(server.name)) continue
    mcp.push({
      name: server.name,
      source: server.source,
      used: false,
      note: `existe em ${server.source} (${server.file ?? '?'}) — IGNORADO, "inheritMcp" não inclui essa origem`,
    })
  }
  const ignored = mcp.filter(s => !s.used && s.source !== 'own' && s.note.includes('IGNORADO'))
  if (ignored.length > 0) {
    warnings.push(
      `${ignored.length} servidor(es) MCP de outra ferramenta não estão sendo usados: ` +
        `${ignored.map(s => s.name).join(', ')}. Ligue com "inheritMcp": true ou copie com \`${CLI} mcp import\`.`,
    )
  }

  const ref = config.model ?? '(nenhum)'
  let model = { ref, resolved: false, note: 'nenhum modelo configurado' }
  if (config.model) {
    try {
      const r = resolveModel(config, config.model)
      model = {
        ref,
        resolved: true,
        note: `${r.providerId} → ${r.modelId} @ ${String(r.provider.options?.baseURL ?? 'default')}`,
      }
    } catch (err) {
      model = { ref, resolved: false, note: err instanceof Error ? err.message : String(err) }
    }
  }

  return { files, credentials, model, mcp, warnings }
}

/**
 * Creates ByteCode's own structure. Copies from the legacy directory when there
 * is one; never touches opencode's files, and never moves anything — the old
 * paths stay readable until the user removes them.
 */
export async function runSetup(): Promise<string[]> {
  const done: string[] = []
  const target = stateDir()
  const legacy = legacyStateDir()

  await fs.mkdir(path.join(target, 'projects'), { recursive: true })
  await fs.mkdir(path.join(target, 'workflows'), { recursive: true })
  done.push(`criado ${target}/ (projects, workflows)`)

  // Merge rather than create-only: running setup after already having connected
  // something new must still finish the migration, and a provider present in both
  // keeps the newer entry.
  const targetAuth = path.join(target, 'auth.json')
  const existed = existsSync(targetAuth)
  const current = existed ? await readAuthFile(targetAuth) : {}
  const legacyAuth = path.join(legacy, 'auth.json')
  const carried = existsSync(legacyAuth) ? await readAuthFile(legacyAuth) : {}
  const added = Object.keys(carried).filter(id => !(id in current))

  await fs.writeFile(
    targetAuth,
    `${JSON.stringify({ ...carried, ...current }, null, 2)}\n`,
    'utf8',
  )
  try {
    await fs.chmod(targetAuth, 0o600)
  } catch {
    /* best effort */
  }
  done.push(
    added.length > 0
      ? `${existed ? 'atualizado' : 'criado'} ${targetAuth} — ${added.length} credencial(is) copiada(s) de ${legacyAuth}: ${added.join(', ')}`
      : existed
        ? `${targetAuth} já existe — nada novo para copiar`
        : `criado ${targetAuth} (vazio)`,
  )

  const configDir = path.join(homedir(), '.config', CLI)
  const configFile = path.join(configDir, `${CLI}.jsonc`)
  if (!existsSync(configFile)) {
    await fs.mkdir(configDir, { recursive: true })
    const legacyConfig = path.join(homedir(), '.config', LEGACY_CLI, `${LEGACY_CLI}.jsonc`)
    if (existsSync(legacyConfig)) {
      await fs.copyFile(legacyConfig, configFile)
      done.push(`copiado ${legacyConfig} → ${configFile}`)
    } else {
      await fs.writeFile(configFile, `{\n  "$schema": "./${CLI}.schema.json"\n}\n`, 'utf8')
      done.push(`criado ${configFile} (vazio)`)
    }
  } else {
    done.push(`${configFile} já existe — mantido`)
  }

  return done
}

/**
 * Copies credentials out of opencode's store into ByteCode's own, explicitly.
 * The alternative — reading opencode's file at runtime — is what makes it look
 * like ByteCode depends on opencode. This makes the copy a decision with a date.
 */
export async function importOpenCodeCredentials(): Promise<{ file: string; providers: string[] }> {
  const own = await readAuthFile(authPath())
  const providers: string[] = []

  for (const file of openCodeAuthPaths()) {
    const store = await readAuthFile(file)
    for (const [id, entry] of Object.entries(store)) {
      if (own[id]) continue
      own[id] = { ...entry, connectedAt: entry.connectedAt ?? new Date().toISOString() }
      providers.push(id)
    }
  }

  const target = authPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, `${JSON.stringify(own, null, 2)}\n`, 'utf8')
  try {
    await fs.chmod(target, 0o600)
  } catch {
    /* best effort */
  }
  return { file: target, providers }
}
