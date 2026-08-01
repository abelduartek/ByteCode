import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModelConfig, ProviderConfig } from './types.ts'
import { ancestorDirs, ensureDir, exists, readTextIfExists } from '../util/fs.ts'
import {
  CLI,
  CONFIG_BASENAMES,
  LOCAL_CONFIG_BASENAMES,
  PROJECT_DIRS,
  userConfigDir,
  userConfigDirs,
} from '../util/paths.ts'

// Writing back into a config the user hand-wrote.
//
// `JSON.stringify` on a parsed config would be a data-losing round trip: the
// configs here are JSONC, and the comments in them are the only record of *why*
// a block looks the way it does (`hx.jsonc` carries a paragraph explaining which
// env var the Azure DevOps MCP actually reads). So nothing is re-serialised —
// the new member is spliced into the existing text, and every byte the user
// wrote stays where it was.

/** Index of the `}` matching the `{` at `open`, honouring strings and comments. */
export function matchBrace(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '"') {
      i = endOfString(text, i)
      continue
    }
    if (c === '/' && next === '/') {
      i = text.indexOf('\n', i)
      if (i === -1) return -1
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

/** Index of the closing quote of the string literal starting at `start`. */
function endOfString(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++
      continue
    }
    if (text[i] === '"') return i
  }
  return text.length - 1
}

/** First `{` that is real syntax rather than a character inside a comment. */
function rootObject(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i)
      if (nl === -1) return -1
      i = nl
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return -1
      i = end + 1
      continue
    }
    if (c === '{') return i
  }
  return -1
}

export type Member = { key: string; keyStart: number; valueStart: number }

/**
 * Direct members of the object opening at `open`, in source order. Only the
 * depth of that object is inspected — a `"provider"` key nested inside a model
 * definition is not one of them.
 */
export function membersOf(text: string, open: number): Member[] {
  const close = matchBrace(text, open)
  if (close === -1) return []
  const out: Member[] = []
  let depth = 0

  for (let i = open; i < close; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? close : nl
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? close : end + 1
      continue
    }
    if (c === '{' || c === '[') {
      depth++
      continue
    }
    if (c === '}' || c === ']') {
      depth--
      continue
    }
    if (c !== '"' || depth !== 1) {
      if (c === '"') i = endOfString(text, i)
      continue
    }
    const keyEnd = endOfString(text, i)
    const after = skipBlanks(text, keyEnd + 1)
    if (text[after] !== ':') {
      i = keyEnd
      continue
    }
    out.push({
      key: text.slice(i + 1, keyEnd),
      keyStart: i,
      valueStart: skipBlanks(text, after + 1),
    })
    i = keyEnd
  }
  return out
}

/** Forward past whitespace and comments. */
function skipBlanks(text: string, from: number): number {
  let i = from
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] === '/' && text[i + 1] === '/') {
      const nl = text.indexOf('\n', i)
      if (nl === -1) return text.length
      i = nl + 1
      continue
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      if (end === -1) return text.length
      i = end + 2
      continue
    }
    return i
  }
}

/**
 * Last index inside `open`..`close` holding actual syntax — trailing comments
 * and blank lines do not count. `-1` when the object is empty, which is what
 * tells an insert to open a fresh body instead of appending to a list.
 */
function lastSignificant(text: string, open: number, close: number): number {
  let last = -1
  for (let i = open + 1; i < close; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (/\s/.test(c)) continue
    if (c === '/' && next === '/') {
      const nl = text.indexOf('\n', i)
      i = nl === -1 ? close : nl
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? close : end + 1
      continue
    }
    if (c === '"') {
      i = endOfString(text, i)
      last = i
      continue
    }
    last = i
  }
  return last
}

/** Leading whitespace of the line `index` falls on. */
function indentAt(text: string, index: number): string {
  const start = text.lastIndexOf('\n', index - 1) + 1
  const line = text.slice(start, index)
  return line.slice(0, line.length - line.trimStart().length)
}

/** CRLF when the file already uses it — an editor diff should be one block. */
function newlineOf(text: string): string {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** JSON value re-indented so it sits under `indent` at every nesting level. */
function renderValue(value: unknown, indent: string, unit: string, eol: string): string {
  const body = JSON.stringify(value, null, unit) ?? 'null'
  return body.split('\n').join(`${eol}${indent}`)
}

export class ConfigWriteError extends Error {}

/**
 * Splices `"<key>": <value>` into the object opening at `open`.
 *
 * Appends rather than prepends: a config is read top to bottom, and what was
 * just added being last matches the order it was added in. A trailing comma
 * already in the file is left as it was — normalising it would be an edit the
 * user did not ask for, and both the loader and JSONC tolerate it.
 */
export function insertMember(
  text: string,
  open: number,
  key: string,
  value: unknown,
  unit: string,
): string {
  const close = matchBrace(text, open)
  if (close === -1) throw new ConfigWriteError('unbalanced braces — the config is not valid JSONC')

  const eol = newlineOf(text)
  const existing = membersOf(text, open)
  const indent = existing[0]
    ? indentAt(text, existing[0].keyStart)
    : indentAt(text, open) + unit
  const rendered = `${JSON.stringify(key)}: ${renderValue(value, indent, unit, eol)}`

  const last = lastSignificant(text, open, close)
  if (last === -1) {
    const closeIndent = indentAt(text, open)
    return (
      text.slice(0, open + 1) +
      `${eol}${indent}${rendered}${eol}${closeIndent}` +
      text.slice(close)
    )
  }

  const separator = text[last] === ',' ? '' : ','
  const tail = text[last] === ',' ? ',' : ''
  return (
    text.slice(0, last + 1) +
    `${separator}${eol}${indent}${rendered}${tail}` +
    text.slice(last + 1)
  )
}

/** Indent unit the file already uses, inferred from its first indented line. */
export function indentUnit(text: string): string {
  const match = text.match(/\n([ \t]+)\S/)
  if (!match) return '  '
  return match[1].startsWith('\t') ? '\t' : match[1]
}

/**
 * Adds a provider to a config file's `provider` block, creating the block when
 * the file has none. Returns the new file contents; nothing is written here, so
 * a caller can show the result before committing to it.
 */
export function withProvider(
  text: string,
  id: string,
  provider: ProviderConfig,
): string {
  const root = rootObject(text)
  if (root === -1) throw new ConfigWriteError('no JSON object found in the config file')

  const unit = indentUnit(text)
  const block = membersOf(text, root).find(m => m.key === 'provider')
  if (!block) return insertMember(text, root, 'provider', { [id]: provider }, unit)

  if (text[block.valueStart] !== '{') {
    throw new ConfigWriteError('"provider" is not an object in this config file')
  }
  if (membersOf(text, block.valueStart).some(m => m.key === id)) {
    throw new ConfigWriteError(`provider "${id}" is already declared in this file`)
  }
  return insertMember(text, block.valueStart, id, provider, unit)
}

/**
 * Adds a model to an existing provider's `models` block.
 *
 * Throws when the provider is not in *this* file: a config is a merge of several
 * files, so the one governing the cwd is often not the one declaring the
 * provider. Guessing wrong would write a second, partial declaration of it —
 * `findProviderFile` is what answers that question first.
 */
export function withModel(
  text: string,
  providerId: string,
  modelKey: string,
  model: ModelConfig,
): string {
  const root = rootObject(text)
  if (root === -1) throw new ConfigWriteError('no JSON object found in the config file')

  const unit = indentUnit(text)
  const block = membersOf(text, root).find(m => m.key === 'provider')
  if (!block || text[block.valueStart] !== '{') {
    throw new ConfigWriteError('this config file has no "provider" block')
  }

  const provider = membersOf(text, block.valueStart).find(m => m.key === providerId)
  if (!provider || text[provider.valueStart] !== '{') {
    throw new ConfigWriteError(`provider "${providerId}" is not declared in this file`)
  }

  const models = membersOf(text, provider.valueStart).find(m => m.key === 'models')
  if (!models) return insertMember(text, provider.valueStart, 'models', { [modelKey]: model }, unit)

  if (text[models.valueStart] !== '{') {
    throw new ConfigWriteError(`"models" of "${providerId}" is not an object`)
  }
  if (membersOf(text, models.valueStart).some(m => m.key === modelKey)) {
    throw new ConfigWriteError(`model "${modelKey}" already exists on "${providerId}"`)
  }
  return insertMember(text, models.valueStart, modelKey, model, unit)
}

export type ConfigTarget = {
  file: string
  /** False when the file has to be created — the UI says so before writing. */
  present: boolean
}

/**
 * Where a provider added from the UI should land: the project config already in
 * effect, or the user-level one when the project has none.
 *
 * `*.local.*` overrides are deliberately not candidates. They are the personal,
 * usually gitignored layer, and silently writing there would produce a provider
 * that works on one machine and is missing from the repo everyone else clones.
 */
export async function findConfigTarget(cwd: string): Promise<ConfigTarget> {
  // Nearest directory first: the config governing this cwd is the one deepest
  // in the tree, which is also the one `loadConfig` gives highest precedence.
  for (const dir of ancestorDirs(cwd).reverse()) {
    for (const nested of [...PROJECT_DIRS, '']) {
      for (const base of CONFIG_BASENAMES) {
        const file = path.join(dir, nested, base)
        if (await exists(file)) return { file, present: true }
      }
    }
  }
  return { file: path.join(userConfigDir(), `${CLI}.jsonc`), present: false }
}

/**
 * The config file that actually declares `providerId`, or null when none does —
 * a provider materialised from the models.dev catalog by `connect` lives in no
 * file at all, and a model cannot be added to it.
 *
 * Searched in the same order `loadConfig` merges, highest precedence first, so
 * the file found is the one whose declaration is in effect.
 */
export async function findProviderFile(
  cwd: string,
  providerId: string,
): Promise<string | null> {
  const candidates: string[] = []
  for (const dir of ancestorDirs(cwd).reverse()) {
    for (const nested of [...PROJECT_DIRS, '']) {
      for (const base of [...LOCAL_CONFIG_BASENAMES, ...CONFIG_BASENAMES]) {
        candidates.push(path.join(dir, nested, base))
      }
    }
  }
  for (const dir of userConfigDirs()) {
    for (const base of CONFIG_BASENAMES) candidates.push(path.join(dir, base))
  }

  for (const file of candidates) {
    const raw = await readTextIfExists(file)
    if (raw === null) continue
    const root = rootObject(raw)
    if (root === -1) continue
    const block = membersOf(raw, root).find(m => m.key === 'provider')
    if (!block || raw[block.valueStart] !== '{') continue
    if (membersOf(raw, block.valueStart).some(m => m.key === providerId)) return file
  }
  return null
}

/** Writes the model into the provider declared in `file`. */
export async function addModel(
  file: string,
  providerId: string,
  modelKey: string,
  model: ModelConfig,
): Promise<string> {
  const raw = await readTextIfExists(file)
  if (raw === null) throw new ConfigWriteError(`${file} does not exist`)
  await fs.writeFile(file, withModel(raw, providerId, modelKey, model), 'utf8')
  return file
}

const NEW_FILE = (id: string, provider: ProviderConfig, eol: string): string =>
  [
    '{',
    `  "$schema": "./${CLI}.schema.json",`,
    '  "provider": {',
    `    ${JSON.stringify(id)}: ${JSON.stringify(provider, null, 2).split('\n').join(`${eol}    `)}`,
    '  }',
    '}',
    '',
  ].join(eol)

/**
 * Writes the provider into `file`, creating it when absent. Returns the path
 * written, so the caller can name it without repeating the resolution.
 */
export async function addProvider(
  file: string,
  id: string,
  provider: ProviderConfig,
): Promise<string> {
  const raw = await readTextIfExists(file)
  if (raw === null) {
    await ensureDir(path.dirname(file))
    await fs.writeFile(file, NEW_FILE(id, provider, '\n'), 'utf8')
    return file
  }
  const next = withProvider(raw, id, provider)
  await fs.writeFile(file, next, 'utf8')
  return file
}
