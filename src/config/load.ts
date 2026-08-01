import path from 'node:path'
import type { Config } from './types.ts'
import {
  ancestorDirs,
  expandHome,
  readTextIfExists,
  resolvePath,
} from '../util/fs.ts'
import {
  CONFIG_BASENAMES,
  LOCAL_CONFIG_BASENAMES,
  PROJECT_DIRS,
  envOption,
  userConfigDirs,
} from '../util/paths.ts'

export type LoadedConfig = {
  config: Config
  /** Files that contributed, lowest precedence first. */
  sources: string[]
  cwd: string
}

/** Strips `//` and block comments plus trailing commas, then JSON.parses. */
export function parseJsonc(text: string, file: string): unknown {
  let out = ''
  let inString = false
  let inLine = false
  let inBlock = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]

    if (inLine) {
      if (c === '\n') {
        inLine = false
        out += c
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out += c
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      out += c
      continue
    }
    if (c === '/' && next === '/') {
      inLine = true
      i++
      continue
    }
    if (c === '/' && next === '*') {
      inBlock = true
      i++
      continue
    }
    out += c
  }

  out = out.replace(/,(\s*[}\]])/g, '$1')

  try {
    return JSON.parse(out)
  } catch (err) {
    throw new Error(`invalid config at ${file}: ${(err as Error).message}`)
  }
}

// `bytecode.jsonc` first, then the legacy `hx.jsonc` — a project that still has
// the old filename keeps loading, and a repo can hold both during a migration.
function userConfigCandidates(): string[] {
  const out: string[] = []
  for (const dir of userConfigDirs()) {
    for (const base of CONFIG_BASENAMES) out.push(path.join(dir, base))
  }
  return out
}

function projectConfigCandidates(cwd: string): string[] {
  const out: string[] = []
  for (const dir of ancestorDirs(cwd)) {
    for (const base of CONFIG_BASENAMES) {
      out.push(path.join(dir, base))
      for (const nested of PROJECT_DIRS) out.push(path.join(dir, nested, base))
    }
  }
  // Local override sits highest among file sources.
  for (const nested of PROJECT_DIRS) {
    for (const base of LOCAL_CONFIG_BASENAMES) out.push(path.join(cwd, nested, base))
  }
  return out
}

export async function loadConfig(
  cwd = process.cwd(),
  overrides: Partial<Config> = {},
): Promise<LoadedConfig> {
  const candidates = [...userConfigCandidates(), ...projectConfigCandidates(cwd)]
  const explicit = envOption('CONFIG')
  if (explicit) candidates.push(resolvePath(explicit, cwd))

  let merged: Config = {}
  const sources: string[] = []

  for (const file of candidates) {
    const raw = await readTextIfExists(file)
    if (raw === null) continue
    // Normalise per file, before merging: otherwise a snake_case key in a
    // higher-precedence file loses to a camelCase one already in the merge.
    const parsed = normalizeAliases(parseJsonc(raw, file) as Config)
    merged = mergeConfig(merged, parsed)
    sources.push(file)
  }

  const inline = envOption('CONFIG_CONTENT')
  if (inline) {
    merged = mergeConfig(
      merged,
      normalizeAliases(parseJsonc(inline, '$BYTECODE_CONFIG_CONTENT') as Config),
    )
    sources.push('$BYTECODE_CONFIG_CONTENT')
  }

  merged = mergeConfig(merged, overrides as Config)
  merged = (await substitute(merged, cwd)) as Config

  return { config: merged, sources, cwd }
}

/**
 * opencode spells several top-level keys in snake_case. Accepting both means an
 * opencode config can be pasted in as-is.
 */
const KEY_ALIASES: Record<string, string> = {
  disabled_providers: 'disabledProviders',
  small_model: 'smallModel',
  subagent_depth: 'subagentDepth',
  max_output_tokens: 'maxOutputTokens',
  data_dir: 'dataDir',
  deferred_tools: 'deferredTools',
  disabled_tools: 'disabledTools',
}

export function normalizeAliases(config: Config): Config {
  const out = { ...config } as Record<string, unknown>
  for (const [from, to] of Object.entries(KEY_ALIASES)) {
    if (from in out && !(to in out)) {
      out[to] = out[from]
      delete out[from]
    }
  }
  return out as Config
}

const UNION_LIST_KEYS = new Set(['allow', 'ask', 'deny'])

/** Deep merge. Objects merge, permission lists union, other arrays replace. */
export function mergeConfig<T>(base: T, patch: T): T {
  if (patch === undefined || patch === null) return base
  if (Array.isArray(base) && Array.isArray(patch)) return patch as T
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch

  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) }
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    const prev = out[key]
    if (UNION_LIST_KEYS.has(key) && Array.isArray(prev) && Array.isArray(value)) {
      out[key] = [...new Set([...(prev as unknown[]), ...value])]
      continue
    }
    out[key] = mergeConfig(prev, value)
  }
  return out as T
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Resolves `{env:VAR}`, `{file:path}` and `{base64:text}` inside every string.
 *
 * `base64` runs last, so it encodes what the other two produced —
 * `{base64::{file:~/.bytecode/ado-pat}}` turns a file holding a raw token into the
 * Basic credential a server expects. It exists because hand-encoding a secret is a
 * step that fails silently: the wrong encoding authenticates as nobody and the
 * server answers 401 with no hint of why.
 */
async function substitute(value: unknown, cwd: string): Promise<unknown> {
  if (typeof value === 'string') {
    let out = value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) =>
      process.env[name] ?? '',
    )
    const fileRefs = [...out.matchAll(/\{file:([^}]+)\}/g)]
    for (const ref of fileRefs) {
      const target = resolvePath(expandHome(ref[1].trim()), cwd)
      const content = (await readTextIfExists(target)) ?? ''
      out = out.replace(ref[0], content.trim())
    }
    // An empty inner value encodes to an empty string rather than to `base64("")`,
    // so a missing credential still reads as missing downstream.
    out = out.replace(/\{base64:([^}]*)\}/g, (_, inner: string) =>
      inner === '' || inner === ':' ? '' : Buffer.from(inner, 'utf8').toString('base64'),
    )
    return out
  }
  if (Array.isArray(value)) {
    return Promise.all(value.map(v => substitute(v, cwd)))
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = await substitute(v, cwd)
    return out
  }
  return value
}
