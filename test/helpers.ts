import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Shared plumbing for the suites.
//
// Everything is derived from `import.meta.url` rather than hardcoded — the suites
// used to live outside the repo with absolute `C:\...` paths baked in, which meant
// they only ran on one machine and were lost with the temp directory.

const here = path.dirname(fileURLToPath(import.meta.url))

/** Repo root. */
export const ROOT = path.resolve(here, '..')
/** `src/` as a file URL, for the dynamic imports the suites use. */
export const SRC = pathToFileURL(path.join(ROOT, 'src')).href.replace(/\/$/, '')
export const FIXTURES = path.join(here, 'fixtures')

/** Scratch directory for a suite, wiped before use. */
export async function scratch(name: string): Promise<string> {
  const dir = path.join(ROOT, 'node_modules', '.bytecode-test', name)
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export function fixture(...parts: string[]): string {
  return path.join(FIXTURES, ...parts)
}

/** A fixture as a file URL, which is what the `npm` field of a provider needs. */
export function fixtureUrl(...parts: string[]): string {
  return pathToFileURL(fixture(...parts)).href
}

/**
 * Installs a config for the process under test.
 *
 * `BYTECODE_CONFIG_CONTENT` instead of a `.jsonc` file on disk: the provider
 * `npm` field must be an absolute URL to the mock, and that can only be computed
 * at runtime.
 */
export function useConfig(config: Record<string, unknown>): void {
  delete process.env.HX_CONFIG
  delete process.env.BYTECODE_CONFIG
  process.env.BYTECODE_CONFIG_CONTENT = JSON.stringify(config)
}

/** A provider backed by one of the mock modules in `fixtures/`. */
export function mockProvider(
  mock:
    | 'mock-perf.mjs'
    | 'mock-provider.mjs'
    | 'mock-workflow.mjs'
    | 'mock-parity.mjs'
    | 'mock-endless.mjs'
    | 'mock-structured.mjs',
  models: Record<string, unknown> = { tiny: { id: 'tiny', limit: { context: 1_000_000, output: 4096 } } },
): Record<string, unknown> {
  return { npm: fixtureUrl(mock), models }
}

export type Counter = { pass: number; fail: number }

export function reporter(): {
  check: (name: string, ok: boolean, detail?: string) => void
  log: (...parts: unknown[]) => void
  done: () => never
  counter: Counter
} {
  const counter: Counter = { pass: 0, fail: 0 }
  const write = (line: string) => process.stdout.write(`${line}\n`)
  return {
    counter,
    log: (...parts: unknown[]) => write(parts.join(' ')),
    check(name, ok, detail = '') {
      if (ok) {
        counter.pass++
        write(`  ok   ${name}`)
      } else {
        counter.fail++
        write(`  FAIL ${name} ${detail}`)
      }
    },
    done(): never {
      write(`\n${counter.pass} passed, ${counter.fail} failed`)
      process.exit(counter.fail === 0 ? 0 : 1)
    },
  }
}
