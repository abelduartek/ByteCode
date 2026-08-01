import path from 'node:path'
import { homedir } from 'node:os'
import { promises as fs } from 'node:fs'
import { loadConfig, normalizeAliases, parseJsonc } from './config/load.ts'
import { configSchemaText } from './config/schema.ts'
import type { Config, PermissionMode } from './config/types.ts'
import { Session, BYTECODE_VERSION } from './core/session.ts'
import { McpManager } from './mcp/client.ts'
import { discoverMcpServers, importMcpServers, inheritableMcpServers } from './mcp/discover.ts'
import { ToolRegistry } from './core/tools.ts'
import { registerTools } from './tools/index.ts'
import { describeError, runTurn } from './core/loop.ts'
import { killAllJobs } from './core/jobs.ts'

/**
 * Ends the launcher's loading animation. A no-op when it never started — under
 * Bun, under old Node, or for a command that prints and exits.
 *
 * `keepAltScreen` hands the alternate screen to the full-screen UI instead of
 * leaving it: leaving would flash the user's terminal back for one frame between
 * the splash and the first paint. Every other path has to give the terminal back.
 */
function stopSplash(keepAltScreen = false): void {
  splashHandle()?.stop?.({ keepAltScreen })
}

type SplashHandle = {
  stop?: (opts?: { keepAltScreen?: boolean }) => void
  stage?: (label: string) => void
}

function splashHandle(): SplashHandle | undefined {
  return (globalThis as { __bytecodeSplash?: SplashHandle }).__bytecodeSplash
}

/** Names the work about to start, for the loading screen. Silent when there is none. */
function splashStage(label: string): void {
  splashHandle()?.stage?.(label)
}
import { formatWhen, latestSession, listSessions, loadSession } from './core/sessions.ts'
import { listModels, withConnectedProviders } from './provider/registry.ts'
import { listConnections, runConnect, runDisconnect } from './provider/connect.ts'
import { createCliIO } from './tui/prompt.ts'
import { runTui } from './tui/app.ts'
import { runFullscreenTui } from './tui/fullscreen.ts'
import { applyTheme } from './tui/theme.ts'
import { ensureDir, exists, readTextIfExists } from './util/fs.ts'
import { CLI, hasLegacyState, userConfigDir } from './util/paths.ts'
import { importOpenCodeCredentials, runDoctor, runSetup } from './core/doctor.ts'

type Args = {
  prompt?: string
  model?: string
  mode?: PermissionMode
  cwd: string
  command?:
    | 'init'
    | 'models'
    | 'config'
    | 'schema'
    | 'mcp'
    | 'connect'
    | 'disconnect'
    | 'auth'
    | 'import'
    | 'sessions'
    | 'doctor'
    | 'setup'
    | 'help'
    | 'version'
  /** Positional argument for connect/disconnect. */
  target?: string
  key?: string
  baseURL?: string
  simple?: boolean
  enableMcp?: boolean
  workflows?: boolean
  /** `--resume` with no id opens the picker; with one, resumes it directly. */
  resume?: string | true
  /** `--continue` resumes the most recent session for this cwd. */
  continue?: boolean
  /** `setup --import-opencode` copies opencode's credentials into our store. */
  importOpenCode?: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = { cwd: process.cwd() }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '-p':
      case '--print':
        args.prompt = argv[++i]
        break
      case '-m':
      case '--model':
        args.model = argv[++i]
        break
      case '--mode':
        args.mode = argv[++i] as PermissionMode
        break
      case '--key':
        args.key = argv[++i]
        break
      case '--base-url':
        args.baseURL = argv[++i]
        break
      case '--simple':
        args.simple = true
        break
      case '--workflows':
        args.workflows = true
        break
      case '-r':
      case '--resume':
        args.resume = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : true
        break
      case '-c':
      case '--continue':
        args.continue = true
        break
      case 'sessions':
        args.command = 'sessions'
        break
      case 'doctor':
        args.command = 'doctor'
        break
      case 'setup':
        args.command = 'setup'
        break
      case '--import-opencode':
        args.importOpenCode = true
        break
      case '-C':
      case '--cwd':
        args.cwd = path.resolve(argv[++i])
        break
      case '-h':
      case '--help':
        args.command = 'help'
        break
      case '-v':
      case '--version':
        args.command = 'version'
        break
      case 'init':
        args.command = 'init'
        break
      case 'models':
        args.command = 'models'
        break
      case 'config':
        args.command = 'config'
        break
      case 'schema':
        args.command = 'schema'
        // Optional destination; defaults to the repo/cwd root.
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) args.target = argv[++i]
        break
      case 'mcp':
        args.command = 'mcp'
        // `mcp import` copies inherited servers into the user config.
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) args.target = argv[++i]
        break
      case 'connect':
      case 'disconnect':
        args.command = a
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) args.target = argv[++i]
        break
      case 'auth':
      case 'connections':
        args.command = 'auth'
        break
      case 'import':
        args.command = 'import'
        if (argv[i + 1] && !argv[i + 1].startsWith('-')) args.target = argv[++i]
        break
      case '--from':
        args.target = argv[++i]
        break
      case '--enable':
      case '--enable-mcp':
        args.enableMcp = true
        break
      default:
        if (!a.startsWith('-') && args.prompt === undefined && args.command === undefined) {
          args.prompt = argv.slice(i).join(' ')
          i = argv.length
        }
    }
  }
  return args
}

const HELP = `ByteCode ${BYTECODE_VERSION} — multi-provider agent harness (command: bytecode)

Usage
  bytecode                          interactive session
  bytecode "prompt"                 run one turn and print the answer
  bytecode -p "prompt"              same, explicit
  bytecode init                     write a starter config (imports opencode providers if found)
  bytecode models                   list configured provider/model refs
  bytecode config                   show resolved config sources
  bytecode schema [file]            write the JSON Schema of the config file
  bytecode mcp                      connect MCP servers and list what they expose
  bytecode mcp import [--enable]    copy servers declared in opencode/Claude Code
                                    into the user config (secrets stay as {env:VAR})
  bytecode sessions                 list saved sessions for this directory
  bytecode doctor                   show which files are read, ignored, and why
  bytecode setup                    create ByteCode's own config/state structure
                                    (--import-opencode also copies its credentials)
  bytecode connect [provider]       add an LLM provider from the models.dev catalog
                                    (--key / --base-url make it non-interactive)
  bytecode disconnect [provider]    remove a stored credential
  bytecode auth                     list connected providers
  bytecode import [--from <file>]   copy provider/mcp blocks from an opencode config
                                    into the user config (~/.config/bytecode/bytecode.jsonc)

Options
  -c, --continue                 resume the most recent session here
  -r, --resume [#id]             resume a session; no id opens the picker
  -m, --model <provider/model>   model for this run
      --mode <mode>              default | plan | acceptEdits | dontAsk | bypassPermissions
  -C, --cwd <dir>                working directory
      --workflows                enable multi-agent orchestration (off by default)
  -h, --help                     this help
  -v, --version                  version

Config is merged from (low to high):
  ~/.config/bytecode/bytecode.jsonc -> <ancestors>/bytecode.jsonc
  -> ./.bytecode/bytecode.local.jsonc -> $BYTECODE_CONFIG -> flags
The legacy \`hx.jsonc\`, \`.hx/\` and \`HX_*\` names are still read, so nothing breaks.
Skills, agents, commands and CLAUDE.md come from .claude/, .bytecode/ and .hx/ trees.
`

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))

  if (args.command === 'help') {
    process.stdout.write(HELP)
    return
  }
  if (args.command === 'version') {
    process.stdout.write(`${BYTECODE_VERSION}\n`)
    return
  }
  if (args.command === 'init') {
    await initConfig(args.cwd)
    return
  }
  if (args.command === 'import') {
    await importProviders(args.target, args.enableMcp)
    return
  }

  const overrides: Partial<Config> = {}
  if (args.model) overrides.model = args.model
  if (args.mode) overrides.permissions = { defaultMode: args.mode }
  if (args.workflows) overrides.workflows = { enabled: true }

  if (args.command === 'connect' || args.command === 'disconnect' || args.command === 'auth') {
    const io = createCliIO()
    // Providers from the config are connectable too, not just catalog ones.
    const declared = (await loadConfig(args.cwd, overrides)).config.provider
    try {
      if (args.command === 'connect')
        await runConnect(io, {
          provider: args.target,
          key: args.key,
          baseURL: args.baseURL,
          local: declared,
        })
      else if (args.command === 'disconnect') await runDisconnect(io, args.target)
      else await listConnections(io)
    } finally {
      io.close()
    }
    return
  }

  const loaded = await loadConfig(args.cwd, overrides)
  const sources = loaded.sources
  // Providers connected with `bytecode connect` are materialised from the catalog.
  const config = await withConnectedProviders(loaded.config)

  if (args.command === 'config') {
    process.stdout.write(`sources (low to high precedence):\n`)
    for (const s of sources) process.stdout.write(`  ${s}\n`)
    process.stdout.write(`\nresolved:\n${JSON.stringify(config, null, 2)}\n`)
    return
  }
  if (args.command === 'schema') {
    const target = args.target
      ? path.resolve(args.cwd, args.target)
      : path.join(args.cwd, `${CLI}.schema.json`)
    await fs.writeFile(target, configSchemaText(), 'utf8')
    process.stdout.write(
      `Wrote ${target}
Point your config at it with "$schema": "./${path.basename(target)}".
`,
    )
    return
  }
  if (args.command === 'models') {
    const models = listModels(config)
    process.stdout.write(models.length ? models.join('\n') + '\n' : 'no providers configured\n')
    return
  }
  if (args.command === 'mcp') {
    if (args.target === 'import') await importMcp(config, args.cwd, args.enableMcp === true)
    else await inspectMcp(config, args.cwd)
    return
  }
  if (args.command === 'sessions') {
    await printSessions(config, args.cwd)
    return
  }
  if (args.command === 'doctor') {
    await printDoctor(config, args.cwd)
    return
  }
  if (args.command === 'setup') {
    for (const line of await runSetup()) process.stdout.write(`  ${line}\n`)
    if (args.importOpenCode) {
      const result = await importOpenCodeCredentials()
      process.stdout.write(
        result.providers.length > 0
          ? `  importadas ${result.providers.length} credencial(is) do opencode: ${result.providers.join(', ')}\n`
          : '  nenhuma credencial nova no store do opencode\n',
      )
    }
    process.stdout.write(`\nRode \`${CLI} doctor\` para conferir o que passou a ser usado.\n`)
    return
  }

  const modelRef = config.model ?? listModels(config)[0]
  if (!modelRef) {
    process.stderr.write(
      'No model configured. Run `bytecode init` to create a config, then set "model".\n',
    )
    process.exitCode = 1
    return
  }

  applyTheme(config.theme)

  // Writes always go to ~/.bytecode; ~/.hx stays readable. Said once, so a
  // machine with pre-rename data knows why it still sees it.
  if (hasLegacyState()) {
    process.stderr.write(
      `Reading also from ~/.${'hx'} (from before the rename); new data goes to ~/.bytecode. ` +
        `Run \`${CLI} setup\` to copy it over.\n`,
    )
  }

  const session = new Session({ config, cwd: args.cwd, modelRef, mode: args.mode })
  // MCP servers connect during init, before the UI owns stdout.
  await session.init(text => process.stderr.write(`${text}\n`))
  registerTools(session)

  try {
    session.resolveModel()
  } catch (err) {
    process.stderr.write(`${String(err)}\n`)
    process.exitCode = 1
    return
  }

  // Resuming before SessionStart so hooks see the transcript actually in use.
  const resumeTarget =
    args.continue === true ? 'latest' : typeof args.resume === 'string' ? args.resume : null
  if (resumeTarget) {
    splashStage('retomando a sessão')
    const state =
      resumeTarget === 'latest'
        ? await latestSession(config, args.cwd)
        : await loadSession(config, args.cwd, resumeTarget)
    if (!state) {
      process.stderr.write(
        resumeTarget === 'latest'
          ? 'No saved session for this directory yet.\n'
          : `No session matching "${resumeTarget}" in this directory. Try \`bytecode sessions\`.\n`,
      )
      process.exitCode = 1
      return
    }
    session.resumeFrom(state)
    process.stderr.write(
      `Resumed #${state.id.slice(0, 8)} — ${state.messages.length} messages, model ${session.modelRef}.\n`,
    )
  }

  await session.hooks.run(
    'SessionStart',
    {
      session_id: session.transcript.sessionId,
      transcript_path: session.transcript.file,
      cwd: session.cwd,
      permission_mode: session.mode,
    },
    resumeTarget ? 'resume' : 'startup',
  )

  // The launcher started an animation before any of this was loaded; it stops
  // here, once there is something ready to take the screen. Stopping earlier
  // would leave the terminal blank for the rest of the setup.
  if (args.prompt) {
    stopSplash()
    await runHeadless(session, args.prompt)
  } else if (args.simple || !process.stdin.isTTY || !process.stdout.isTTY) {
    // The full-screen UI needs raw mode; piped or redirected IO falls back.
    stopSplash()
    await runTui(session)
  } else {
    // The alternate screen goes straight from the splash to the UI, with no
    // frame in between showing the shell again.
    stopSplash(true)
    // `--resume` with no id lands on the session list with the newest selected.
    await runFullscreenTui(session, { focusSessions: args.resume === true })
  }

  await session.hooks.run('SessionEnd', {
    session_id: session.transcript.sessionId,
    transcript_path: session.transcript.file,
    cwd: session.cwd,
    permission_mode: session.mode,
  })
  await session.mcp.close()
  await session.transcript.flush()
}

async function printDoctor(config: Config, cwd: string): Promise<void> {
  const report = await runDoctor(config, cwd)
  const mark = (f: { exists: boolean; used: boolean }) =>
    f.used ? (f.exists ? '[usado]  ' : '[vazio]  ') : f.exists ? '[IGNORADO]' : '[-]      '

  process.stdout.write('Arquivos, na ordem em que são lidos:\n\n')
  for (const file of report.files) {
    process.stdout.write(`  ${mark(file).padEnd(11)} ${file.path}\n              ${file.note}\n`)
  }

  process.stdout.write('\nDe onde vem a credencial de cada provider:\n\n')
  for (const { provider, source } of report.credentials) {
    process.stdout.write(`  ${provider.padEnd(18)} ${source.kind.padEnd(7)} ${source.detail}\n`)
  }

  process.stdout.write(`\nModelo: ${report.model.ref}\n  ${report.model.note}\n`)

  if (report.mcp.length > 0) {
    process.stdout.write('\nServidores MCP:\n\n')
    for (const s of report.mcp) {
      process.stdout.write(
        `  ${(s.used ? '[usado]' : '[não]').padEnd(8)} ${s.name.padEnd(20)} ${s.source.padEnd(9)} ${s.note}\n`,
      )
    }
  }

  if (report.warnings.length > 0) {
    process.stdout.write('\nAvisos:\n')
    for (const w of report.warnings) process.stdout.write(`  ! ${w}\n`)
  }

  process.stdout.write(
    `\nByteCode não precisa do opencode instalado. Os arquivos dele só são lidos\n` +
      `com "openCodeAuth": true na config — atualmente ${config.openCodeAuth ? 'LIGADO' : 'desligado'}.\n`,
  )
}

async function printSessions(config: Config, cwd: string): Promise<void> {
  const all = await listSessions(config, cwd)
  if (all.length === 0) {
    process.stdout.write(`No saved sessions for ${cwd}.\n`)
    return
  }
  process.stdout.write(`${all.length} session(s) for ${cwd}:\n\n`)
  for (const s of all) {
    const turns = `${s.turns} turn${s.turns === 1 ? '' : 's'}`
    process.stdout.write(
      `  #${s.short}  ${formatWhen(s.updated).padEnd(12)} ${turns.padEnd(10)} ${s.title}\n`,
    )
  }
  process.stdout.write(
    '\nResume with `bytecode --resume #id` or `bytecode --continue` for the newest.\n',
  )
}

/** Servers available from opencode/Claude Code that `inheritMcp` is not picking up. */
async function reportInheritable(config: Config, cwd: string): Promise<void> {
  const extra = await inheritableMcpServers(config, cwd)
  if (extra.length === 0) return
  const wanted = new Set<string>(
    config.inheritMcp === true ? ['opencode', 'claude'] : (config.inheritMcp || []),
  )
  const off = extra.filter(s => !wanted.has(s.source))
  if (off.length === 0) return
  process.stdout.write(
    `\n${off.length} server(s) declared elsewhere and not inherited:\n` +
      off.map(s => `  ${s.name}  (${s.source})  ${s.file ?? ''}\n`).join('') +
      `Set "inheritMcp": true to use them as they are, or run \`${CLI} mcp import\` to copy them here.\n`,
  )
}

async function inspectMcp(config: Config, cwd: string): Promise<void> {
  const found = await discoverMcpServers(config, cwd)
  if (found.length === 0) {
    process.stdout.write('No MCP servers configured. Add an "mcp" block to bytecode.jsonc.\n')
    await reportInheritable(config, cwd)
    return
  }

  const manager = new McpManager(undefined, cwd)
  manager.use(
    Object.fromEntries(found.map(s => [s.name, s.config])),
    Object.fromEntries(found.map(s => [s.name, s.source])),
  )
  await manager.connect(text => process.stderr.write(`${text}\n`))
  const registry = new ToolRegistry()
  manager.registerInto(registry)

  for (const server of manager.status()) {
    const from = server.source && server.source !== 'own' ? ` [from ${server.source}]` : ''
    if (server.disabled) {
      process.stdout.write(`${server.name}: disabled ("enabled": false)${from}\n`)
      continue
    }
    if (!server.connected) {
      process.stdout.write(`${server.name}: FAILED — ${server.error}${from}\n`)
      continue
    }
    process.stdout.write(`${server.name}: connected, ${server.toolCount} tool(s)${from}\n`)
    const prefix = `mcp__${server.name.replace(/[^A-Za-z0-9_]/g, '_')}__`
    for (const tool of registry.all()) {
      if (!tool.name.startsWith(prefix)) continue
      const state = tool.deferred ? 'deferred' : 'eager'
      process.stdout.write(`  ${tool.name}  ${state}  ${tool.kind}\n`)
    }
    if (server.instructions) {
      const head = server.instructions.split('\n')[0].slice(0, 100)
      process.stdout.write(`  instructions: ${head}...\n`)
    }
  }

  await manager.close()
  await reportInheritable(config, cwd)
}

/**
 * Copies servers declared in opencode/Claude Code into the *user* config, so a
 * project `bytecode.jsonc` is never rewritten.
 */
async function importMcp(config: Config, cwd: string, enable: boolean): Promise<void> {
  const target = path.join(userConfigDir(), `${CLI}.jsonc`)
  const result = await importMcpServers(config, cwd, { target, enable })

  if (result.imported.length === 0) {
    process.stdout.write(
      result.skipped.length > 0
        ? `Nothing new: ${result.skipped.join(', ')} already declared here.\n`
        : 'No MCP servers found in opencode or Claude Code configs.\n',
    )
    return
  }

  process.stdout.write(
    `Imported ${result.imported.length} MCP server(s) into ${result.file}\n` +
      `  ${result.imported.join(', ')}\n` +
      (enable
        ? 'They are enabled.\n'
        : `They are disabled — flip "enabled": true or re-run with --enable.\n`),
  )
  if (result.envVars.length > 0) {
    process.stdout.write(
      `\nCredentials were left as references instead of being copied, so no secret was\n` +
        `duplicated into the config. Export these before enabling the server(s):\n` +
        result.envVars.map(v => `  ${v}\n`).join(''),
    )
  }
  if (result.skipped.length > 0) {
    process.stdout.write(`\nAlready declared here, left alone: ${result.skipped.join(', ')}\n`)
  }
}

async function runHeadless(session: Session, prompt: string): Promise<void> {
  let failed = false
  session.emit = event => {
    if (event.type === 'text') process.stdout.write(event.text)
    if (event.type === 'error') {
      failed = true
      process.stderr.write(`${event.text}\n`)
    }
    if (event.type === 'tool-start') {
      process.stderr.write(`[${event.name}] ${event.summary}\n`)
    }
    if (event.type === 'notice') process.stderr.write(`[notice] ${event.text}\n`)
  }
  // Headless runs never prompt; anything requiring approval is denied so the
  // model gets a clear signal instead of the process hanging.
  session.requestPermission = async req => {
    process.stderr.write(
      `[denied] ${req.tool} ${req.summary} — allow it in config or run interactively\n`,
    )
    return false
  }
  await runTurn(session, prompt)
  process.stdout.write('\n')
  if (failed) process.exitCode = 1
}

const STARTER: Config = {
  $schema: './bytecode.schema.json',
  model: 'anthropic/opus',
  provider: {
    anthropic: {
      npm: '@ai-sdk/anthropic',
      name: 'Anthropic',
      env: ['ANTHROPIC_API_KEY'],
      models: {
        opus: { id: 'claude-opus-5', name: 'Claude Opus 5', limit: { context: 1000000, output: 64000 } },
        sonnet: { id: 'claude-sonnet-5', name: 'Claude Sonnet 5', limit: { context: 1000000, output: 64000 } },
      },
    },
  },
  permissions: {
    allow: ['Read(**)', 'Glob(**)', 'Grep(**)', 'LS(**)'],
    ask: ['Write(**)', 'Edit(**)', 'Bash(*)', 'PowerShell(*)'],
    deny: ['Read(**/.env)', 'Read(**/*.pem)', 'Bash(rm -rf:*)'],
    defaultMode: 'default',
  },
  subagentDepth: 1,
}

/**
 * Re-syncs providers (and MCP servers) from an opencode config. They are written
 * to the *user* config rather than the project one, so a project `bytecode.jsonc` —
 * comments and all — is never rewritten, and its entries still win on merge.
 */
async function importProviders(from?: string, enableMcp = false): Promise<void> {
  const source = from
    ? path.resolve(from)
    : path.join(homedir(), '.config', 'opencode', 'opencode.jsonc')

  const raw = await readTextIfExists(source)
  if (!raw) {
    process.stderr.write(`no config at ${source}\n`)
    process.exitCode = 1
    return
  }

  let parsed: Config
  try {
    parsed = normalizeAliases(parseJsonc(raw, source) as Config)
  } catch (err) {
    process.stderr.write(`${describeError(err)}\n`)
    process.exitCode = 1
    return
  }

  const target = path.join(userConfigDir(), `${CLI}.jsonc`)
  const existingRaw = await readTextIfExists(target)
  const existing = existingRaw ? (parseJsonc(existingRaw, target) as Config) : {}

  // MCP servers arrive disabled: importing a config should not start spawning
  // processes and using credentials the user has not opted into here.
  const importedMcp = Object.fromEntries(
    Object.entries(parsed.mcp ?? {}).map(([name, server]) => [
      name,
      { ...server, enabled: enableMcp ? server.enabled !== false : false },
    ]),
  )

  const merged: Config = {
    ...existing,
    provider: { ...(existing.provider ?? {}), ...(parsed.provider ?? {}) },
    ...(parsed.mcp ? { mcp: { ...(existing.mcp ?? {}), ...importedMcp } } : {}),
    ...(parsed.disabledProviders ? { disabledProviders: parsed.disabledProviders } : {}),
  }

  await ensureDir(path.dirname(target))
  await fs.writeFile(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')

  const providers = Object.keys(parsed.provider ?? {})
  const models = listModels(merged)
  process.stdout.write(
    `Imported ${providers.length} provider(s) from ${source}\n` +
      `  ${providers.join(', ')}\n` +
      `Written to ${target}\n` +
      (parsed.mcp
        ? `MCP servers: ${Object.keys(parsed.mcp).join(', ')}` +
          (enableMcp ? ' (enabled)\n' : ' — imported disabled, use --enable-mcp or flip "enabled"\n')
        : '') +
      `\n${models.length} model(s) available:\n${models.map(m => `  ${m}`).join('\n')}\n`,
  )
}

async function initConfig(cwd: string): Promise<void> {
  const target = path.join(cwd, `${CLI}.jsonc`)
  if (await exists(target)) {
    process.stdout.write(`${target} already exists — leaving it alone.\n`)
    return
  }

  const config: Config = JSON.parse(JSON.stringify(STARTER))

  // Reuse opencode's provider block when present: same shape, same semantics.
  const openCodePath = path.join(homedir(), '.config', 'opencode', 'opencode.jsonc')
  const raw = await readTextIfExists(openCodePath)
  if (raw) {
    try {
      const oc = parseJsonc(raw, openCodePath) as Config
      if (oc.provider && Object.keys(oc.provider).length > 0) {
        config.provider = { ...config.provider, ...oc.provider }
        const firstProvider = Object.keys(oc.provider)[0]
        const firstModel = Object.keys(oc.provider[firstProvider].models ?? {})[0]
        if (firstProvider && firstModel) config.model = `${firstProvider}/${firstModel}`
        process.stdout.write(`Imported ${Object.keys(oc.provider).length} provider(s) from ${openCodePath}\n`)
      }
    } catch (err) {
      process.stderr.write(`Could not read opencode config: ${String(err)}\n`)
    }
  }

  await ensureDir(cwd)
  await fs.writeFile(target, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  process.stdout.write(
    `Wrote ${target}\nRun \`${CLI} models\` to check, then \`${CLI}\` to start.\n`,
  )
}

// A CLI should report a failure in one line, not dump a provider stack trace.
// HX_DEBUG=1 restores the full stack.
function report(err: unknown, label: string): void {
  const detail =
    process.env.HX_DEBUG && err instanceof Error ? err.stack : describeError(err)
  process.stderr.write(`${label}: ${detail}\n`)
  process.exitCode = 1
}

process.on('unhandledRejection', err => report(err, 'unhandled rejection'))
process.on('uncaughtException', err => report(err, 'uncaught exception'))

main().catch(err => report(err, 'error'))
