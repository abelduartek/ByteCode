import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { envOption } from './paths.ts'

// External binaries the harness prefers when present. Every lookup is derived
// from the environment (PATH, well-known env roots) or from an explicit override
// — never from a literal install path, so the same build works on macOS, Linux
// and Windows.

const isWindows = process.platform === 'win32'

const require_ = createRequire(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'),
)

/** PATH lookup, honouring PATHEXT on Windows. */
export function which(name: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '')
    .split(path.delimiter)
    .filter(Boolean)
  const exts = isWindows
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    : ['']

  for (const dir of dirs) {
    for (const ext of exts) {
      const full = path.join(dir, name + ext)
      if (existsSync(full)) return full
    }
  }
  return null
}

export type PosixShell = {
  /** Executable to spawn. */
  file: string
  /** MSYS tool directory to prepend to the child PATH, when there is one. */
  toolPath?: string
}

let shellCache: PosixShell | null | undefined

/**
 * A shell where POSIX commands mean what the model thinks they mean.
 *
 * On macOS and Linux `spawn(cmd, { shell: true })` already runs `/bin/sh`, so
 * this returns null and the caller keeps that path. On Windows the same option
 * resolves to `cmd.exe`, where `ls` and `cat` do not exist and `find` is an
 * unrelated program — so a real bash has to be located, or the Bash tool must
 * not be offered at all.
 */
export function posixShell(): PosixShell | null {
  if (shellCache !== undefined) return shellCache
  shellCache = isWindows ? findWindowsBash() : null
  return shellCache
}

function findWindowsBash(): PosixShell | null {
  const override = envOption('BASH')
  if (override && existsSync(override)) return withToolPath(override)

  // Git for Windows ships bash plus the MSYS coreutils. `<root>/bin/bash.exe`
  // is the wrapper that sets those up; `<root>/usr/bin/bash.exe` does not.
  const git = which('git')
  if (git) {
    const fromGit = path.join(path.dirname(path.dirname(git)), 'bin', 'bash.exe')
    if (existsSync(fromGit)) return withToolPath(fromGit)
  }

  const localPrograms = process.env.LOCALAPPDATA
    ? path.join(process.env.LOCALAPPDATA, 'Programs')
    : undefined
  const roots = [
    process.env.ProgramW6432,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    localPrograms,
  ]
  for (const root of roots) {
    if (!root) continue
    const candidate = path.join(root, 'Git', 'bin', 'bash.exe')
    if (existsSync(candidate)) return withToolPath(candidate)
  }

  // Last resort: bash on PATH, excluding the WSL launcher in System32. That one
  // runs in a separate filesystem namespace (/mnt/c/...), so the session cwd and
  // every path the model produces would be wrong.
  const onPath = which('bash')
  if (onPath && !/[\\/]system32[\\/]/i.test(onPath)) return withToolPath(onPath)

  return null
}

function withToolPath(file: string): PosixShell {
  const root = path.dirname(path.dirname(file))
  const usrBin = path.join(root, 'usr', 'bin')
  return existsSync(usrBin) ? { file, toolPath: usrBin } : { file }
}

let ripgrepCache: string | null | undefined

/**
 * ripgrep, in order of preference: an explicit override, the binary vendored by
 * `@vscode/ripgrep` (optional dependency — it may not have been installed), then
 * whatever is on PATH. Null means the callers fall back to the built-in scanner.
 */
export function ripgrepPath(): string | null {
  if (ripgrepCache !== undefined) return ripgrepCache
  ripgrepCache = findRipgrep()
  return ripgrepCache
}

function findRipgrep(): string | null {
  // Escape hatch for comparing the two search paths, and for the rare tree where
  // ripgrep's ignore rules hide something the built-in scanner would find.
  if (envOption('NO_RG')) return null

  const override = envOption('RG')
  if (override && existsSync(override)) return override

  try {
    const vendored = (require_('@vscode/ripgrep') as { rgPath?: string }).rgPath
    if (vendored && existsSync(vendored)) return vendored
  } catch {
    // Optional dependency: absent, or its postinstall download did not run.
  }

  return which('rg')
}

/** Test seam: forces the next lookup to run again. */
export function resetBinaryCache(): void {
  shellCache = undefined
  ripgrepCache = undefined
}
