import type { Stream } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import type { McpServerConfig } from '../config/types.ts'
import type { JSONSchema, ToolDefinition, ToolRegistry } from '../core/tools.ts'
import type { ToolKind } from '../core/permissions.ts'
import { CLI, VERSION } from '../util/paths.ts'

// MCP servers are the reason deferred tools exist: a single server can add
// dozens of schemas. Tools are therefore registered deferred by default —
// advertised by name, with the schema loaded on demand through ToolSearch.

const CLIENT_INFO = { name: CLI, version: VERSION }
const DEFAULT_TIMEOUT_S = 60

export type ServerStatus = {
  name: string
  connected: boolean
  toolCount: number
  resourceCount: number
  error?: string
  instructions?: string
  /** `own` for this config's `mcp` block, otherwise the tool it was inherited from. */
  source?: string
  /** Declared but `enabled: false`, so never dialled. */
  disabled?: boolean
}

type RemoteTool = {
  name: string
  description?: string
  inputSchema?: unknown
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string }
}

type ContentBlock = {
  type: string
  text?: string
  data?: string
  mimeType?: string
  uri?: string
  resource?: { uri?: string; text?: string; mimeType?: string }
}

/** `mcp__<server>__<tool>`, with the server name reduced to a safe slug. */
export function mcpToolName(server: string, tool: string): string {
  const slug = server.replace(/[^A-Za-z0-9_]/g, '_')
  return `mcp__${slug}__${tool}`
}

/**
 * Environment for a local server.
 *
 * The MCP SDK's `getDefaultEnvironment()` forwards a **whitelist** (PATH, HOME,
 * APPDATA, TEMP, …) and drops everything else. That is stricter than every peer
 * tool and it breaks configs written for them: opencode spawns with
 * `{...process.env, ...environment}` (verified in `MCP.connectLocal`, 1.18.9), so a
 * server relying on an ambient credential works there and dies here with a
 * handshake error that names nothing.
 *
 * So the parent environment is inherited by default. A config entry that names a
 * command to execute already carries more authority than any env var it could
 * read, so withholding variables from it is not containment — it is only surprise.
 * `"inheritEnv": false` restores the whitelist for a server that should not see
 * the rest of the environment.
 *
 * Values shaped like exported shell functions are dropped either way, which is
 * what the SDK's own filter does.
 */
export function childEnv(cfg: McpServerConfig): Record<string, string> {
  const out: Record<string, string> = { ...getDefaultEnvironment() }
  if (cfg.inheritEnv !== false) {
    for (const [key, value] of Object.entries(process.env)) {
      if (typeof value !== 'string' || value.startsWith('()')) continue
      out[key] = value
    }
  }
  const merged = { ...out, ...(cfg.environment ?? {}) }
  if (process.platform !== 'win32') return merged

  // Windows environment variables are case-insensitive, but a plain object is
  // not: `getDefaultEnvironment()` contributes `PATH` while `process.env`
  // spells it `Path`, and a config that sets one of them left the other in the
  // object too. Which one the child saw was up to the OS, so a `PATH` written
  // to point at a specific toolchain was silently ignored half the time.
  const folded: Record<string, string> = {}
  const seen = new Map<string, string>()
  for (const [key, value] of Object.entries(merged)) {
    const lower = key.toLowerCase()
    const existing = seen.get(lower)
    if (existing !== undefined) delete folded[existing]
    seen.set(lower, key)
    folded[key] = value
  }
  return folded
}

/** A stop for a server whose `nextCursor` never ends. */
const MAX_TOOL_PAGES = 50

/** Environment names that carry a credential, so an empty one is a failure. */
const SECRET_ENV_NAME = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|AUTH)/i

/** Bytes of server stderr kept for the failure message. */
const STDERR_TAIL_BYTES = 4096
const STDERR_IN_ERROR = 300

/**
 * Drains the server's stderr into a bounded buffer.
 *
 * Draining is not optional: with a piped stream and nobody reading, a chatty
 * server blocks once the pipe buffer fills. The tail is what turns
 * "Connection closed" into the line the server actually printed.
 */
function captureStderr(transport: { stderr: Stream | null }): () => string {
  const stream = transport.stderr
  if (!stream) return () => ''
  let buffer = ''
  stream.on('data', (chunk: unknown) => {
    buffer = (buffer + String(chunk)).slice(-STDERR_TAIL_BYTES)
  })
  stream.on('error', () => {})
  return () => buffer
}

/**
 * Last meaningful line of the server's output, appended to the client's error.
 *
 * Many servers log JSON; the `message` field is the part a human needs, so it is
 * unwrapped when present.
 */
export function explainFailure(err: unknown, stderr: string): Error {
  const base = err instanceof Error ? err : new Error(String(err))
  const lines = stderr.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const said = lines
    .reverse()
    .map(line => {
      if (!line.startsWith('{')) return line
      try {
        const parsed = JSON.parse(line) as { message?: unknown; level?: unknown }
        return typeof parsed.message === 'string' ? parsed.message : ''
      } catch {
        return ''
      }
    })
    .find(Boolean)
  if (!said) return base
  const trimmed = said.length > STDERR_IN_ERROR ? `${said.slice(0, STDERR_IN_ERROR)}…` : said
  return new Error(`${base.message} — the server said: ${trimmed}`)
}

/**
 * Splits a command written as one string, respecting quotes.
 *
 * `"C:\\Program Files\\node\\node.exe" server.js` is one program and one
 * argument; split on whitespace it became `C:\Program` with three arguments,
 * and the server failed to start on the only platform where that path is
 * normal. Use the array form to avoid the question entirely.
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let quoted = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      quoted = true
      continue
    }
    if (/\s/.test(ch)) {
      if (current || quoted) parts.push(current)
      current = ''
      quoted = false
      continue
    }
    current += ch
  }
  if (current || quoted) parts.push(current)
  return parts
}

function asArgv(command: string[] | string): { command: string; args: string[] } {
  const parts = Array.isArray(command) ? command : splitCommand(command)
  if (parts.length === 0) throw new Error('mcp: empty command')
  return { command: parts[0], args: parts.slice(1) }
}

/** Whether the config says this server's tool may overlap with its siblings. */
function declaredParallel(config: McpServerConfig, toolName: string): boolean {
  const declared = config.parallelSafe
  if (declared === true) return true
  if (Array.isArray(declared)) return declared.includes(toolName)
  return false
}

function toJsonSchema(schema: unknown): JSONSchema {
  const s = (schema ?? {}) as Record<string, unknown>
  if (s.type === 'object' && typeof s.properties === 'object') {
    return {
      type: 'object',
      properties: s.properties as Record<string, unknown>,
      required: Array.isArray(s.required) ? (s.required as string[]) : undefined,
    }
  }
  // Servers occasionally omit `properties`; the model still needs a valid object schema.
  return { type: 'object', properties: {} }
}

function renderContent(content: ContentBlock[] | undefined): string {
  if (!content || content.length === 0) return '(no content)'
  const parts: string[] = []
  for (const block of content) {
    switch (block.type) {
      case 'text':
        parts.push(block.text ?? '')
        break
      case 'image':
        parts.push(`[image ${block.mimeType ?? 'unknown'}, ${block.data?.length ?? 0} b64 chars]`)
        break
      case 'audio':
        parts.push(`[audio ${block.mimeType ?? 'unknown'}]`)
        break
      case 'resource_link':
        parts.push(`[resource link ${block.uri ?? ''}]`)
        break
      case 'resource':
        parts.push(
          block.resource?.text ?? `[resource ${block.resource?.uri ?? ''} (${block.resource?.mimeType ?? '?'})]`,
        )
        break
      default:
        parts.push(`[${block.type}]`)
    }
  }
  return parts.join('\n').trim() || '(no content)'
}

type Connection = {
  name: string
  client: Client
  config: McpServerConfig
  tools: RemoteTool[]
  instructions?: string
  hasResources: boolean
}

export class McpManager {
  private connections: Connection[] = []
  private failures: { name: string; error: string }[] = []
  private disabled: string[] = []
  private connected = false

  private servers: Record<string, McpServerConfig> | undefined
  private sources: Record<string, string> = {}
  private cwd: string

  constructor(servers: Record<string, McpServerConfig> | undefined, cwd: string) {
    this.servers = servers
    this.cwd = cwd
  }

  /**
   * Replaces the server set before connecting, so discovery (own block plus
   * anything inherited from opencode/Claude Code) can be resolved asynchronously
   * while the constructor stays synchronous. Ignored once connected.
   */
  use(servers: Record<string, McpServerConfig> | undefined, sources?: Record<string, string>): void {
    if (this.connected) return
    this.servers = servers
    this.sources = sources ?? {}
  }

  get isEmpty(): boolean {
    return !this.servers || Object.keys(this.servers).length === 0
  }

  /** Connects every enabled server. Failures are recorded, never thrown. */
  async connect(onNotice?: (text: string) => void): Promise<void> {
    if (this.connected || this.isEmpty) return
    this.connected = true

    const all = Object.entries(this.servers ?? {})
    const enabled = all.filter(([, cfg]) => cfg.enabled !== false)
    this.disabled = all.filter(([, cfg]) => cfg.enabled === false).map(([name]) => name)

    // A `{env:VAR}` with no value substitutes to an empty string, so a server
    // whose credential is missing would be spawned, refuse to authenticate and
    // die — costing the handshake and reporting "Connection closed", which says
    // nothing about the actual cause. Named up front instead.
    const entries: [string, McpServerConfig][] = []
    for (const [name, cfg] of enabled) {
      // Only variables that were *meant* to hold a credential. A server that
      // legitimately passes an empty value — `NO_COLOR: ""`, a flag whose
      // presence is the point — was refused as if its credential were missing.
      const blank = Object.entries(cfg.environment ?? {})
        .filter(([key, value]) => value === '' && SECRET_ENV_NAME.test(key))
        .map(([key]) => key)
      if (blank.length > 0) {
        const error =
          `missing credential: ${blank.join(', ')} is empty — the {env:…} or {file:…} reference ` +
          `in "environment" did not resolve`
        this.failures.push({ name, error })
        onNotice?.(`mcp "${name}": ${error}`)
        continue
      }
      entries.push([name, cfg])
    }

    await Promise.all(
      entries.map(async ([name, cfg]) => {
        try {
          this.connections.push(await this.open(name, cfg))
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err)
          this.failures.push({ name, error: message })
          onNotice?.(`mcp "${name}" unavailable: ${message}`)
        }
      }),
    )
  }

  private async open(name: string, cfg: McpServerConfig): Promise<Connection> {
    const timeoutMs = (cfg.timeout ?? DEFAULT_TIMEOUT_S) * 1000
    const client = new Client(CLIENT_INFO, { capabilities: {} })
    const kind = cfg.type ?? (cfg.url ? 'remote' : 'local')

    if (kind === 'local') {
      if (!cfg.command) throw new Error('local server needs "command"')
      const { command, args } = asArgv(cfg.command)
      const transport = new StdioClientTransport({
        command,
        args,
        cwd: cfg.cwd ?? this.cwd,
        env: childEnv(cfg),
        // Piped, never inherited: the server's log must not reach the terminal (it
        // would corrupt the streamed frame), but discarding it threw away the only
        // explanation there is. A server that refuses a credential says so on
        // stderr and then exits, and the client sees just "Connection closed".
        stderr: 'pipe',
      })
      const stderrTail = captureStderr(transport)
      try {
        await client.connect(transport, { timeout: timeoutMs })
      } catch (err) {
        throw explainFailure(err, stderrTail())
      }
    } else {
      if (!cfg.url) throw new Error('remote server needs "url"')
      const url = new URL(cfg.url)
      const requestInit = cfg.headers ? { headers: cfg.headers } : undefined
      const streamable = new StreamableHTTPClientTransport(url, { requestInit })
      try {
        await client.connect(streamable, { timeout: timeoutMs })
      } catch (streamableError) {
        // Older servers only speak the HTTP+SSE transport. The failed one is
        // closed first — left open it kept a socket and a reconnect timer alive
        // for a transport nothing would ever read again.
        await streamable.close().catch(() => {})
        try {
          await client.connect(new SSEClientTransport(url, { requestInit }), {
            timeout: timeoutMs,
          })
        } catch (sseError) {
          // Both spoken for: an SSE error alone reads as "this server is not
          // there", when the real reason is usually in the first attempt.
          const first = streamableError instanceof Error ? streamableError.message : String(streamableError)
          const second = sseError instanceof Error ? sseError.message : String(sseError)
          throw new Error(`streamable HTTP failed (${first}); SSE fallback failed (${second})`)
        }
      }
    }

    // Every page. `tools/list` is paginated in the protocol, and a server with
    // more tools than fit in one page had the rest silently missing — a config
    // could name a tool in `allowedTools` that simply never appeared.
    let tools: RemoteTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
      const listed = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs })
      tools.push(...((listed.tools ?? []) as RemoteTool[]))
      cursor = listed.nextCursor
      if (!cursor) break
    }
    if (cfg.allowedTools?.length) {
      const allow = new Set(cfg.allowedTools)
      tools = tools.filter(t => allow.has(t.name))
    }

    return {
      name,
      client,
      config: cfg,
      tools,
      instructions: client.getInstructions(),
      hasResources: Boolean(client.getServerCapabilities()?.resources),
    }
  }

  /** Adds one harness tool per remote tool, plus resource tools when offered. */
  registerInto(registry: ToolRegistry): void {
    for (const conn of this.connections) {
      const timeoutMs = (conn.config.timeout ?? DEFAULT_TIMEOUT_S) * 1000

      for (const remote of conn.tools) {
        const readOnly = remote.annotations?.readOnlyHint === true
        const kind: ToolKind = readOnly ? 'read' : 'exec'

        const tool: ToolDefinition = {
          name: mcpToolName(conn.name, remote.name),
          kind,
          // The server's own annotation, or the user saying so in the config —
          // `readOnlyHint` is optional in the protocol and most servers omit it,
          // which left every `list_*`/`get_*` running one at a time.
          parallelSafe: readOnly || declaredParallel(conn.config, remote.name),
          deferred: !conn.config.eager,
          description:
            `[mcp:${conn.name}] ${remote.description ?? remote.annotations?.title ?? remote.name}`,
          inputSchema: toJsonSchema(remote.inputSchema),
          summary: input => `${conn.name}/${remote.name} ${compact(input)}`,
          subject: () => `${conn.name}/${remote.name}`,
          async execute(input) {
            const result = (await conn.client.callTool(
              { name: remote.name, arguments: input },
              undefined,
              { timeout: timeoutMs },
            )) as { content?: ContentBlock[]; isError?: boolean }
            return { text: renderContent(result.content), isError: result.isError === true }
          },
        }
        registry.register(tool)
      }

      if (conn.hasResources) {
        registry.register(this.resourceListTool(conn, timeoutMs))
        registry.register(this.resourceReadTool(conn, timeoutMs))
      }
    }
  }

  private resourceListTool(conn: Connection, timeoutMs: number): ToolDefinition {
    return {
      name: mcpToolName(conn.name, 'list_resources'),
      kind: 'read',
      parallelSafe: true,
      deferred: !conn.config.eager,
      description: `[mcp:${conn.name}] List resources exposed by this server.`,
      inputSchema: { type: 'object', properties: {} },
      summary: () => `${conn.name}/list_resources`,
      subject: () => `${conn.name}/list_resources`,
      async execute() {
        const res = await conn.client.listResources(undefined, { timeout: timeoutMs })
        const items = (res.resources ?? []) as { uri: string; name?: string; mimeType?: string }[]
        if (items.length === 0) return { text: '(no resources)' }
        return {
          text: items.map(r => `${r.uri}${r.name ? ` — ${r.name}` : ''}`).join('\n'),
        }
      },
    }
  }

  private resourceReadTool(conn: Connection, timeoutMs: number): ToolDefinition {
    return {
      name: mcpToolName(conn.name, 'read_resource'),
      kind: 'read',
      parallelSafe: true,
      deferred: !conn.config.eager,
      description: `[mcp:${conn.name}] Read one resource by URI.`,
      inputSchema: {
        type: 'object',
        properties: { uri: { type: 'string', description: 'Resource URI' } },
        required: ['uri'],
      },
      summary: input => `${conn.name}/read_resource ${String(input.uri ?? '')}`,
      subject: input => String(input.uri ?? ''),
      async execute(input) {
        const res = await conn.client.readResource(
          { uri: String(input.uri) },
          { timeout: timeoutMs },
        )
        const contents = (res.contents ?? []) as { text?: string; blob?: string; uri?: string }[]
        const text = contents
          .map(c => c.text ?? (c.blob ? `[binary ${c.blob.length} b64 chars]` : ''))
          .join('\n')
        return { text: text.trim() || '(empty resource)' }
      },
    }
  }

  /** Server-provided `instructions`, injected into the session context. */
  instructions(): { server: string; text: string }[] {
    return this.connections
      .filter(c => c.instructions?.trim())
      .map(c => ({ server: c.name, text: c.instructions as string }))
  }

  status(): ServerStatus[] {
    const ok = this.connections.map(c => ({
      name: c.name,
      connected: true,
      toolCount: c.tools.length,
      resourceCount: c.hasResources ? 1 : 0,
      instructions: c.instructions,
      source: this.sources[c.name],
    }))
    const bad = this.failures.map(f => ({
      name: f.name,
      connected: false,
      toolCount: 0,
      resourceCount: 0,
      error: f.error,
      source: this.sources[f.name],
    }))
    const off = this.disabled.map(name => ({
      name,
      connected: false,
      toolCount: 0,
      resourceCount: 0,
      disabled: true,
      source: this.sources[name],
    }))
    return [...ok, ...bad, ...off]
  }

  async close(): Promise<void> {
    await Promise.all(
      this.connections.map(c => c.client.close().catch(() => undefined)),
    )
    this.connections = []
    this.connected = false
  }
}

function compact(input: Record<string, unknown>): string {
  try {
    const s = JSON.stringify(input)
    return s.length > 80 ? `${s.slice(0, 77)}...` : s
  } catch {
    return ''
  }
}
