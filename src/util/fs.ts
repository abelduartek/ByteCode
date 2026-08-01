import { promises as fs } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

export function expandHome(p: string): string {
  if (p === '~') return homedir()
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return path.join(homedir(), p.slice(2))
  }
  return p
}

export function resolvePath(p: string, cwd = process.cwd()): string {
  return path.resolve(cwd, expandHome(p))
}

/** Strips a UTF-8 BOM: Windows editors add one, and it breaks both JSON.parse
 * and any parser that anchors on the first character. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

export async function readTextIfExists(p: string): Promise<string | null> {
  try {
    return stripBom(await fs.readFile(p, 'utf8'))
  } catch {
    return null
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p)
    return true
  } catch {
    return false
  }
}

export async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory()
  } catch {
    return false
  }
}

export async function listDir(p: string): Promise<string[]> {
  try {
    return await fs.readdir(p)
  } catch {
    return []
  }
}

export async function ensureDir(p: string): Promise<void> {
  await fs.mkdir(p, { recursive: true })
}

/** Filesystem-safe slug for a working directory, used to key transcript folders. */
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[:\\/]+/g, '-').replace(/^-+|-+$/g, '')
}

/** Walk from `cwd` up to the filesystem root, nearest-last. */
export function ancestorDirs(cwd: string): string[] {
  const out: string[] = []
  let dir = path.resolve(cwd)
  for (;;) {
    out.push(dir)
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return out.reverse()
}
