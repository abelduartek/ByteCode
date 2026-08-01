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
  /**
   * Set when the user was offered the environment variable during `connect` and
   * chose to type a key instead. Without it, the variable they just declined
   * went on winning at every model call.
   */
  ignoreEnv?: boolean
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
  // Merged over what was there. Replacing the entry outright meant that
  // rotating a key dropped the `baseURL` saved with it, and the next call went
  // to the provider's default endpoint instead of the one that was configured.
  const previous = store[providerId] ?? {}
  store[providerId] = {
    ...previous,
    type: 'api',
    connectedAt: new Date().toISOString(),
    ...entry,
  }
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  // No-op on Windows, meaningful everywhere else.
  try {
    await fs.chmod(file, 0o600)
  } catch {
    /* best effort */
  }
  return file
}

/**
 * Removes a credential from every store the resolver reads.
 *
 * The pre-rename file counts: deleting only from the current one left the old
 * copy in place, `disconnect` reported success, and the provider went on
 * authenticating with the credential the user had just removed.
 */
export async function removeCredential(providerId: string): Promise<boolean> {
  let removed = false
  for (const file of stateFiles('auth.json')) {
    const store = await readAuthFile(file)
    if (!(providerId in store)) continue
    delete store[providerId]
    await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
    removed = true
  }
  return removed
}

export async function connectedProviders(): Promise<string[]> {
  return Object.keys(await readAuth()).sort()
}

/**
 * Never log a key; this is what gets shown instead.
 *
 * The ends are shown only when there is enough key for them to be a hint rather
 * than the key: at nine characters, `abcd...fghi` was eight of the nine. Short
 * keys mask to a fixed width so the output does not leak the length either.
 */
export function maskKey(key: string): string {
  if (key.length < 16) return '*'.repeat(8)
  return `${key.slice(0, 4)}${'*'.repeat(6)}${key.slice(-4)}`
}
