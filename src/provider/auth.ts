import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { ensureDir, readTextIfExists } from '../util/fs.ts'
import { stateFile, stateFiles } from '../util/paths.ts'

// Credential store, kept out of the config so a config file can be committed.
// Same shape opencode uses, so the two can share a store if the user wants.

export type AuthEntry = {
  type?: 'api' | 'oauth'
  key?: string
  apiKey?: string
  token?: string
  /** Set when the user connected to a non-default endpoint. */
  baseURL?: string
  connectedAt?: string
}

export type AuthStore = Record<string, AuthEntry>

export function authPath(): string {
  return stateFile('auth.json')
}

export function openCodeAuthPaths(): string[] {
  const home = homedir()
  const paths = [path.join(home, '.local', 'share', 'opencode', 'auth.json')]
  if (process.env.LOCALAPPDATA) {
    paths.push(path.join(process.env.LOCALAPPDATA, 'opencode', 'auth.json'))
  }
  return paths
}

/** Set when a store exists but could not be parsed, so the UI can say so. */
const brokenStores = new Map<string, string>()

export function brokenAuthFiles(): { file: string; error: string }[] {
  return [...brokenStores.entries()].map(([file, error]) => ({ file, error }))
}

export async function readAuthFile(file: string): Promise<AuthStore> {
  const raw = await readTextIfExists(file)
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw) as AuthStore
    brokenStores.delete(file)
    return parsed
  } catch (err) {
    // A stray comma used to make every credential vanish and the failure surface
    // as "no credential", pointing at the wrong problem entirely. Record it so
    // `doctor` and the 401 hint can name the real cause.
    brokenStores.set(file, err instanceof Error ? err.message : String(err))
    return {}
  }
}

/**
 * The store as the resolver sees it: pre-rename credentials still count, but a
 * provider present in both wins from the current file, since that is the one
 * every write goes to.
 */
export async function readAuth(): Promise<AuthStore> {
  const [current, legacy] = stateFiles('auth.json')
  return { ...(await readAuthFile(legacy)), ...(await readAuthFile(current)) }
}

export function keyOf(entry: AuthEntry | undefined): string | undefined {
  const key = entry?.key ?? entry?.apiKey ?? entry?.token
  return typeof key === 'string' && key ? key : undefined
}

export async function saveCredential(
  providerId: string,
  entry: AuthEntry,
): Promise<string> {
  const file = authPath()
  await ensureDir(path.dirname(file))
  const store = await readAuthFile(file)
  store[providerId] = { type: 'api', connectedAt: new Date().toISOString(), ...entry }
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  // No-op on Windows, meaningful everywhere else.
  try {
    await fs.chmod(file, 0o600)
  } catch {
    /* best effort */
  }
  return file
}

export async function removeCredential(providerId: string): Promise<boolean> {
  const file = authPath()
  const store = await readAuthFile(file)
  if (!(providerId in store)) return false
  delete store[providerId]
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  return true
}

export async function connectedProviders(): Promise<string[]> {
  return Object.keys(await readAuth()).sort()
}

/** Never log a key; this is what gets shown instead. */
export function maskKey(key: string): string {
  if (key.length <= 8) return '*'.repeat(key.length)
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}
