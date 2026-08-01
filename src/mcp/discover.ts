import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { Config, McpServerConfig } from '../config/types.ts'
import { readTextIfExists } from '../util/fs.ts'

// MCP servers declared in other tools.
//
// ByteCode's own `mcp` block always wins. Beyond that it can *inherit* a server
// it does not define — opencode uses the same shape, Claude Code uses a different
// one and gets translated. Nothing is inherited unless `inheritMcp` says so:
// inheriting means spawning a process, and a config written for another tool is
// not consent to run it from this one.

export type McpSource = 'own' | 'opencode' | 'claude'

export type DiscoveredServer = {
  name: string
  config: McpServerConfig
  source: McpSource
  /** Where it was read from, for `doctor`. */
  file?: string
}

/** Claude Code's shape, which is not opencode's. */
type ClaudeServer = {
  type?: 'stdio' | 'sse' | 'http'
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

function parseJsonc<T>(raw: string): T | null {
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map(line => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n')
  try {
    return JSON.parse(stripped) as T
  } catch {
    return null
  }
}

async function readJsonc<T>(file: string): Promise<T | null> {
  const raw = await readTextIfExists(file)
  return raw ? parseJsonc<T>(raw) : null
}

function opencodeConfigFiles(cwd: string): string[] {
  return [
    path.join(cwd, '.opencode', 'opencode.jsonc'),
    path.join(cwd, '.opencode', 'opencode.json'),
    path.join(cwd, 'opencode.jsonc'),
    path.join(cwd, 'opencode.json'),
    path.join(homedir(), '.config', 'opencode', 'opencode.jsonc'),
    path.join(homedir(), '.config', 'opencode', 'opencode.json'),
  ]
}

/** Translates Claude Code's server shape into this harness's. */
export function fromClaude(server: ClaudeServer): McpServerConfig | null {
  if (server.url || server.type === 'sse' || server.type === 'http') {
    if (!server.url) return null
    return { type: 'remote', url: server.url, headers: server.headers }
  }
  if (!server.command) return null
  return {
    type: 'local',
    command: [server.command, ...(server.args ?? [])],
    environment: server.env && Object.keys(server.env).length > 0 ? server.env : undefined,
  }
}

async function fromOpenCode(cwd: string): Promise<DiscoveredServer[]> {
  const out: DiscoveredServer[] = []
  const seen = new Set<string>()
  for (const file of opencodeConfigFiles(cwd)) {
    const data = await readJsonc<{ mcp?: Record<string, McpServerConfig> }>(file)
    for (const [name, config] of Object.entries(data?.mcp ?? {})) {
      // Project config wins over the user one; first file listed wins.
      if (seen.has(name)) continue
      seen.add(name)
      out.push({ name, config, source: 'opencode', file })
    }
  }
  return out
}

/**
 * Claude Code keeps servers in `~/.claude.json`, both global and keyed by project
 * path, plus an optional `.mcp.json` in the project. The cwd's own entry is
 * preferred over the global one; path separators are normalised because the same
 * directory appears with both slashes in that file.
 */
async function fromClaudeCode(cwd: string): Promise<DiscoveredServer[]> {
  const out: DiscoveredServer[] = []
  const seen = new Set<string>()
  const add = (name: string, raw: ClaudeServer, file: string) => {
    if (seen.has(name)) return
    const config = fromClaude(raw)
    if (!config) return
    seen.add(name)
    out.push({ name, config, source: 'claude', file })
  }

  const projectFile = path.join(cwd, '.mcp.json')
  const project = await readJsonc<{ mcpServers?: Record<string, ClaudeServer> }>(projectFile)
  for (const [name, raw] of Object.entries(project?.mcpServers ?? {})) add(name, raw, projectFile)

  const globalFile = path.join(homedir(), '.claude.json')
  const data = await readJsonc<{
    mcpServers?: Record<string, ClaudeServer>
    projects?: Record<string, { mcpServers?: Record<string, ClaudeServer> }>
  }>(globalFile)
  if (!data) return out

  const key = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/$/, '').toLowerCase()
  const wanted = key(cwd)
  for (const [project, entry] of Object.entries(data.projects ?? {})) {
    if (key(project) !== wanted) continue
    for (const [name, raw] of Object.entries(entry?.mcpServers ?? {})) add(name, raw, globalFile)
  }
  for (const [name, raw] of Object.entries(data.mcpServers ?? {})) add(name, raw, globalFile)

  return out
}

function wantedSources(config: Config): McpSource[] {
  const inherit = config.inheritMcp
  if (!inherit) return []
  if (inherit === true) return ['opencode', 'claude']
  return inherit.filter((s): s is 'opencode' | 'claude' => s === 'opencode' || s === 'claude')
}

/**
 * Everything ByteCode should offer, own servers first. A name declared locally is
 * never overridden — inheritance only fills gaps.
 */
export async function discoverMcpServers(config: Config, cwd: string): Promise<DiscoveredServer[]> {
  const out: DiscoveredServer[] = []
  const names = new Set<string>()

  for (const [name, server] of Object.entries(config.mcp ?? {})) {
    names.add(name)
    out.push({ name, config: server, source: 'own' })
  }

  const sources = wantedSources(config)
  for (const source of sources) {
    const found = source === 'opencode' ? await fromOpenCode(cwd) : await fromClaudeCode(cwd)
    for (const server of found) {
      if (names.has(server.name)) continue
      names.add(server.name)
      out.push(server)
    }
  }

  return out
}

/** The map `McpManager` takes. */
export async function resolveMcpServers(
  config: Config,
  cwd: string,
): Promise<Record<string, McpServerConfig> | undefined> {
  const found = await discoverMcpServers(config, cwd)
  if (found.length === 0) return config.mcp
  return Object.fromEntries(found.map(s => [s.name, s.config]))
}

/** Inheritable servers ByteCode does not define, regardless of `inheritMcp`. */
export async function inheritableMcpServers(
  config: Config,
  cwd: string,
): Promise<DiscoveredServer[]> {
  const own = new Set(Object.keys(config.mcp ?? {}))
  const found = [...(await fromOpenCode(cwd)), ...(await fromClaudeCode(cwd))]
  const out: DiscoveredServer[] = []
  const seen = new Set<string>()
  for (const server of found) {
    if (own.has(server.name) || seen.has(server.name)) continue
    seen.add(server.name)
    out.push(server)
  }
  return out
}

/** Anything that looks like a credential rather than a setting. */
const SECRET_KEY = /(pat|token|secret|key|password|passwd|credential|auth)/i

/**
 * A server definition safe to write into a config file.
 *
 * Literal secrets are replaced by `{env:NAME}` references. `~/.claude.json` holds
 * an Azure DevOps PAT in plain text; copying that into a second file — one that
 * may well be committed — would spread it instead of migrating it. The caller
 * reports which variables now need a value.
 */
export function redactForConfig(
  name: string,
  server: McpServerConfig,
): { config: McpServerConfig; envVars: string[] } {
  const envVars: string[] = []
  const env = server.environment
  if (!env) return { config: server, envVars }

  const safe: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    const looksSecret = SECRET_KEY.test(key) && value.length >= 16 && !/^\{(env|file):/.test(value)
    if (looksSecret) {
      const varName = key.toUpperCase().replace(/[^A-Z0-9]/g, '_')
      safe[key] = `{env:${varName}}`
      envVars.push(varName)
    } else {
      safe[key] = value
    }
  }
  return { config: { ...server, environment: safe }, envVars }
}

/**
 * Copies inheritable servers into the user config. Disabled unless asked: an
 * import should not start spawning processes as a side effect.
 */
export async function importMcpServers(
  config: Config,
  cwd: string,
  opts: { target: string; enable?: boolean } = { target: '' },
): Promise<{ file: string; imported: string[]; envVars: string[]; skipped: string[] }> {
  const inheritable = await inheritableMcpServers(config, cwd)
  const existingRaw = await readTextIfExists(opts.target)
  const existing = (existingRaw ? parseJsonc<Config>(existingRaw) : null) ?? {}
  const mcp: Record<string, McpServerConfig> = { ...(existing.mcp ?? {}) }

  const imported: string[] = []
  const skipped: string[] = []
  const envVars = new Set<string>()

  for (const server of inheritable) {
    if (mcp[server.name]) {
      skipped.push(server.name)
      continue
    }
    const { config: safe, envVars: vars } = redactForConfig(server.name, server.config)
    mcp[server.name] = { ...safe, enabled: opts.enable === true }
    for (const v of vars) envVars.add(v)
    imported.push(server.name)
  }

  const merged: Config = { ...existing, mcp }
  await fs.mkdir(path.dirname(opts.target), { recursive: true })
  await fs.writeFile(opts.target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

  return { file: opts.target, imported, envVars: [...envVars], skipped }
}
