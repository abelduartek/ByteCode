import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import type { Config } from '../config/types.ts'
import { defaultDataDir } from './session.ts'
import { ensureDir, slugForCwd } from '../util/fs.ts'
import { stateFiles as legacyDataDirs } from '../util/paths.ts'

// Session persistence. The JSONL transcript is the append-only history for
// humans and tooling; resuming needs the exact `ModelMessage[]` the provider saw,
// including tool-call ids, so that lives in its own snapshot beside it.
//
// Each session writes two files:
//   <id>.state.json  the full message array (can be large)
//   <id>.meta.json   a small summary, so listing never parses the big one
//
// Per-session files rather than a shared index: two bytecode instances in the
// same project would race on a single file and silently drop each other's
// entries.

export type TokenBaseline = { messageCount: number; inputTokens: number }

export type SessionState = {
  id: string
  cwd: string
  modelRef: string
  messages: ModelMessage[]
  tokenBaseline?: TokenBaseline
}

export type SessionMeta = {
  id: string
  cwd: string
  modelRef: string
  title: string
  createdAt: string
  updatedAt: string
  turns: number
  messages: number
}

export type SessionSummary = SessionMeta & {
  /** First 8 characters of the id — what `/resume` and the picker accept. */
  short: string
  updated: number
}

/** Where sessions are written. */
function projectDir(config: Config, cwd: string): string {
  return path.join(config.dataDir ?? defaultDataDir(), slugForCwd(cwd))
}

/**
 * Every directory to read from, write target first. An explicit `dataDir` is
 * taken at its word; otherwise the pre-rename location is still searched, so
 * sessions saved before the rename keep showing up in the list.
 */
function projectDirs(config: Config, cwd: string): string[] {
  if (config.dataDir) return [projectDir(config, cwd)]
  const slug = slugForCwd(cwd)
  return legacyDataDirs('projects').map(root => path.join(root, slug))
}

function stateFile(config: Config, cwd: string, id: string): string {
  return path.join(projectDir(config, cwd), `${id}.state.json`)
}

function metaFile(config: Config, cwd: string, id: string): string {
  return path.join(projectDir(config, cwd), `${id}.meta.json`)
}

/** Text of a user message with the harness's own blocks removed. */
export function visibleUserText(message: ModelMessage): string {
  const content = message.content
  const raw =
    typeof content === 'string'
      ? content
      : (content as { type: string; text?: string }[])
          .filter(part => part.type === 'text')
          .map(part => part.text ?? '')
          .join(' ')
  return raw
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<command-name>([\s\S]*?)<\/command-name>/g, '$1')
    .replace(/<command-(args|message)>[\s\S]*?<\/command-\1>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function titleFrom(messages: ModelMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = visibleUserText(message)
    if (text) return text.slice(0, 72)
  }
  return '(sem título)'
}

export function countTurns(messages: ModelMessage[]): number {
  return messages.filter(m => m.role === 'user').length
}

/** Writes to a temp file and renames, so a crash cannot leave half a snapshot. */
async function writeAtomic(file: string, body: string): Promise<void> {
  await ensureDir(path.dirname(file))
  const temp = `${file}.tmp`
  await fs.writeFile(temp, body, 'utf8')
  await fs.rename(temp, file)
}

/**
 * `createdAt` per session id, so a save does not read `meta.json` back from disk
 * every turn just to preserve it.
 */
const createdAtCache = new Map<string, string>()

export async function saveSessionState(
  config: Config,
  state: SessionState & { createdAt?: string },
): Promise<void> {
  const now = new Date().toISOString()

  let createdAt = createdAtCache.get(state.id) ?? state.createdAt
  if (!createdAt) {
    createdAt = (await readMeta(config, state.cwd, state.id))?.createdAt ?? now
  }
  createdAtCache.set(state.id, createdAt)

  const meta: SessionMeta = {
    id: state.id,
    cwd: state.cwd,
    modelRef: state.modelRef,
    title: titleFrom(state.messages),
    createdAt,
    updatedAt: now,
    turns: countTurns(state.messages),
    messages: state.messages.length,
  }

  await writeAtomic(stateFile(config, state.cwd, state.id), JSON.stringify(state))
  await writeAtomic(metaFile(config, state.cwd, state.id), JSON.stringify(meta, null, 2))
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

async function readMeta(config: Config, cwd: string, id: string): Promise<SessionMeta | null> {
  return readJson<SessionMeta>(metaFile(config, cwd, id))
}

function toSummary(meta: SessionMeta): SessionSummary {
  return {
    ...meta,
    short: meta.id.slice(0, 8),
    updated: Date.parse(meta.updatedAt) || 0,
  }
}

/** Sessions for this project, most recently used first. */
export async function listSessions(config: Config, cwd: string): Promise<SessionSummary[]> {
  // First directory wins on a duplicate id: a session that was resumed exists in
  // both, and the current location is the one still being written.
  const byId = new Map<string, SessionMeta>()

  for (const dir of projectDirs(config, cwd)) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    const metas = await Promise.all(
      entries
        .filter(name => name.endsWith('.meta.json'))
        .map(name => readJson<SessionMeta>(path.join(dir, name))),
    )
    for (const meta of metas) {
      if (meta?.id && !byId.has(meta.id)) byId.set(meta.id, meta)
    }
  }

  return [...byId.values()].map(toSummary).sort((a, b) => b.updated - a.updated)
}

/**
 * Loads a session by full id or by any unambiguous prefix. Returns null when
 * nothing matches; throws only when a prefix matches more than one session.
 */
/** Reads a state file from whichever directory has it, current location first. */
async function readState(config: Config, cwd: string, id: string): Promise<SessionState | null> {
  for (const dir of projectDirs(config, cwd)) {
    const found = await readJson<SessionState>(path.join(dir, `${id}.state.json`))
    if (found?.messages) return found
  }
  return null
}

export async function loadSession(
  config: Config,
  cwd: string,
  idOrPrefix: string,
): Promise<SessionState | null> {
  const direct = await readState(config, cwd, idOrPrefix)
  if (direct) return direct

  const matches = (await listSessions(config, cwd)).filter(s => s.id.startsWith(idOrPrefix))
  if (matches.length === 0) return null
  if (matches.length > 1) {
    throw new Error(
      `"${idOrPrefix}" matches ${matches.length} sessions: ${matches.map(m => m.short).join(', ')}`,
    )
  }
  return readState(config, cwd, matches[0].id)
}

/** The most recent session for this project, for `--continue`. */
export async function latestSession(config: Config, cwd: string): Promise<SessionState | null> {
  const [newest] = await listSessions(config, cwd)
  if (!newest) return null
  return readState(config, cwd, newest.id)
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE

/** "agora", "há 12 min", "hoje 14:32", "ontem 09:11", "27 jul", "27/07/2024". */
export function formatWhen(when: number, now = Date.now()): string {
  if (!when) return '—'
  const delta = now - when
  if (delta < MINUTE) return 'agora'
  if (delta < HOUR) return `há ${Math.floor(delta / MINUTE)} min`

  const date = new Date(when)
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  const midnight = new Date(now)
  midnight.setHours(0, 0, 0, 0)

  if (when >= midnight.getTime()) return `hoje ${clock}`
  if (when >= midnight.getTime() - 24 * HOUR) return `ontem ${clock}`

  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  if (new Date(when).getFullYear() === new Date(now).getFullYear()) {
    return `${date.getDate()} ${months[date.getMonth()]}`
  }
  return `${String(date.getDate()).padStart(2, '0')}/${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`
}
