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
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const argv = process.argv.slice(2)

// Two shapes, and the difference is where this copy came from.
//
// From the repository there is only `src/`, and the Node runtime erases the
// types on load — no build, edit and run. Installed from npm the package ships
// `dist/`, because Node refuses to strip types under `node_modules`
// (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`) and a published CLI lives
// exactly there.
const built = existsSync(join(root, 'dist', 'index.js'))
const dir = built ? 'dist' : 'src'
const ext = built ? '.js' : '.ts'
const entry = join(root, dir, `index${ext}`)

/**
 * Commands that print and exit. They finish about as fast as the animation would
 * start, and a splash flashing before `--version` is noise, not welcome.
 */
const QUIET = new Set([
  '-v', '--version', '-h', '--help', '-p', '--print',
  'init', 'import', 'models', 'config', 'schema', 'mcp', 'doctor', 'setup',
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
  ['lendo a configuração', [dir, 'config', `load${ext}`]],
  ['conectando o provider', [dir, 'provider', `registry${ext}`]],
  ['carregando agents e skills', [dir, 'assets', `index${ext}`]],
  ['preparando o MCP', [dir, 'mcp', `client${ext}`]],
  ['montando a interface', [dir, 'tui', `fullscreen${ext}`]],
]

// Já é JavaScript, ou o Node desta máquina apaga os tipos sozinho.
if (built || major >= 23) {
  const splash = interactive
    ? (await import(url(dir, 'tui', `splash${ext}`))).startSplash()
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
