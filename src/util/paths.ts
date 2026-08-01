import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// Naming and on-disk locations, in one place.
//
// The project was called `hx` before, and the rename must not orphan anything a
// user already has: stored credentials, saved sessions, `hx.jsonc` files, or
// `HX_*` variables already exported in a shell profile. So every lookup here
// prefers the new name and falls back to the old one; nothing is ever moved.

export const CLI = 'bytecode'
export const LEGACY_CLI = 'hx'
export const VERSION = '1.0.1'

const HOME_DIR = `.${CLI}`
const LEGACY_HOME_DIR = `.${LEGACY_CLI}`

/**
 * Where credentials, sessions, workflows and the catalog cache are **written**.
 * Always the current name — an earlier version kept writing to `~/.hx` whenever
 * that directory existed, which meant the rename never actually took effect on a
 * machine that had used the old name once.
 */
export function stateDir(): string {
  return path.join(homedir(), HOME_DIR)
}

/** The pre-rename directory. Still **read**, never written to. */
export function legacyStateDir(): string {
  return path.join(homedir(), LEGACY_HOME_DIR)
}

/** Write target. */
export function stateFile(...parts: string[]): string {
  return path.join(stateDir(), ...parts)
}

/**
 * Every place to look when reading, current name first. Nothing is migrated
 * implicitly: old data stays readable where it is until `setup` copies it.
 */
export function stateFiles(...parts: string[]): string[] {
  return [path.join(stateDir(), ...parts), path.join(legacyStateDir(), ...parts)]
}

/** True when there is pre-rename data that the read fallback is covering. */
export function hasLegacyState(): boolean {
  return existsSync(legacyStateDir()) && !existsSync(stateDir())
}

/** Both spellings of the per-project directory, new name first. */
export const PROJECT_DIRS = [`.${CLI}`, `.${LEGACY_CLI}`]

/** Config basenames to look for at each level, in precedence order. */
export const CONFIG_BASENAMES = [`${CLI}.jsonc`, `${CLI}.json`, `${LEGACY_CLI}.jsonc`, `${LEGACY_CLI}.json`]
export const LOCAL_CONFIG_BASENAMES = [
  `${CLI}.local.jsonc`,
  `${CLI}.local.json`,
  `${LEGACY_CLI}.local.jsonc`,
  `${LEGACY_CLI}.local.json`,
]

/** Where `init` and `import` write, and where the user config is read from. */
export function userConfigDir(): string {
  const current = path.join(homedir(), '.config', CLI)
  const legacy = path.join(homedir(), '.config', LEGACY_CLI)
  return !existsSync(current) && existsSync(legacy) ? legacy : current
}

/** Every user-level config directory to search, new name first. */
export function userConfigDirs(): string[] {
  return [
    path.join(homedir(), '.config', CLI),
    path.join(homedir(), '.config', LEGACY_CLI),
    stateFile(),
  ]
}

/**
 * Reads `BYTECODE_<name>`, falling back to `HX_<name>` — a profile that already
 * exports the old variable keeps working.
 */
export function envOption(name: string): string | undefined {
  return process.env[`BYTECODE_${name}`] ?? process.env[`HX_${name}`]
}

/** Test seam: forces the directory probes to run again. */
export function resetPathCache(): void {
  // Nothing is cached any more: every path is derived from `homedir()` on each
  // call, so a test that moves HOME sees the change immediately.
}
