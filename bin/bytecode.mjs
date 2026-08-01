#!/usr/bin/env node
// Launcher.
//
// Node >= 23 strips TypeScript types with no flag, so there it imports the entry
// directly — the old unconditional respawn cost a whole second Node boot (73 ms
// measured) to pass a flag that version does not need. Older Node still needs
// `--experimental-strip-types`, which can only be given to a fresh process.
//
// The splash starts *before* the entry is imported. That ordering is the whole
// point: the modules being waited on include everything that could draw, so
// anything loaded later cannot show that it is loading.
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const entry = join(root, 'src', 'index.ts')
const argv = process.argv.slice(2)

/**
 * Commands that print and exit. They finish about as fast as the animation would
 * start, and a splash flashing before `--version` is noise, not welcome.
 */
const QUIET = new Set([
  '-v', '--version', '-h', '--help', '-p', '--print',
  'init', 'models', 'config', 'schema', 'mcp', 'doctor', 'setup',
  'sessions', 'connect', 'disconnect', 'auth',
])
const interactive = !argv.some(a => QUIET.has(a))

const major = Number(process.versions.node.split('.')[0])

const url = (...parts) => pathToFileURL(join(root, ...parts)).href

/**
 * The load, broken into the pieces worth naming — measured, not guessed: the MCP
 * SDK alone is ~307 ms of the ~500, which is why it gets its own line instead of
 * hiding inside "starting".
 *
 * Each stage is set immediately before its own `import`, and the import really
 * does pull that subgraph. The final `index.ts` import then finds everything
 * already in the module cache, so nothing is loaded twice to make a nicer
 * progress line.
 */
const STAGES = [
  ['lendo a configuração', ['src', 'config', 'load.ts']],
  ['conectando o provider', ['src', 'provider', 'registry.ts']],
  ['carregando agents e skills', ['src', 'assets', 'index.ts']],
  ['preparando o MCP', ['src', 'mcp', 'client.ts']],
  ['montando a interface', ['src', 'tui', 'fullscreen.ts']],
]

if (major >= 23) {
  const splash = interactive
    ? (await import(url('src', 'tui', 'splash.ts'))).startSplash()
    : { stop: () => {}, stage: () => {} }
  try {
    // Handed to the app so the animation lasts until the first frame is ready,
    // not until the imports happen to finish.
    globalThis.__bytecodeSplash = splash
    if (interactive) {
      for (const [label, parts] of STAGES) {
        splash.stage(label)
        await import(url(...parts))
      }
    }
    await import(pathToFileURL(entry).href)
  } catch (err) {
    splash.stop()
    throw err
  }
} else {
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', entry, ...argv],
    { stdio: 'inherit' },
  )
  process.exit(r.status ?? 1)
}
