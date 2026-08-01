// Configuration model.
//
// Shape is deliberately a hybrid: the `provider` block follows opencode
// (npm-loaded AI SDK packages, `provider/model` ids), while `permissions` and
// `hooks` follow Claude Code's contract so existing rules and hook scripts port
// over unchanged.

export type PermissionMode =
  | 'default'
  | 'plan'
  | 'acceptEdits'
  | 'dontAsk'
  | 'bypassPermissions'

export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type ModelLimit = {
  context?: number
  output?: number
}

export type ModelCost = {
  /** USD per 1M input tokens. */
  input?: number
  /** USD per 1M output tokens. */
  output?: number
}

export type ModelConfig = {
  /** Provider-side model id, e.g. `claude-opus-4-7`. Defaults to the map key. */
  id?: string
  /** Display name. */
  name?: string
  /** Extra HTTP headers for requests using this model. */
  headers?: Record<string, string>
  limit?: ModelLimit
  cost?: ModelCost
  /** Whether the model accepts `reasoning`/thinking configuration. */
  reasoning?: boolean
  /**
   * Passed straight through to the AI SDK as `providerOptions`, keyed by
   * provider slug — e.g. `{ "anthropic": { "thinking": { "type": "adaptive" } } }`.
   * Kept generic so the loop never needs provider-specific branches.
   */
  providerOptions?: Record<string, Record<string, unknown>>
}

export type ProviderConfig = {
  /** npm package implementing the AI SDK provider factory. */
  npm?: string
  name?: string
  /** Env var names checked for an API key, in order. */
  env?: string[]
  /** Passed to the provider factory (baseURL, apiKey, headers, ...). */
  options?: Record<string, unknown>
  models: Record<string, ModelConfig>
}

export type HookDefinition = {
  type: 'command'
  /** Executable (with `args`) or shell line (without `args`). */
  command: string
  args?: string[]
  /** Permission-rule filter, e.g. `Bash(git *)`. */
  if?: string
  /** Seconds. */
  timeout?: number
  statusMessage?: string
  /** Omit for the platform default shell (cmd.exe on Windows, sh elsewhere). */
  shell?: 'bash' | 'powershell'
}

export type HookMatcherGroup = {
  /** `*`/omitted = all; plain word or `A|B` = exact list; anything else = regex. */
  matcher?: string
  hooks: HookDefinition[]
}

export type PermissionsConfig = {
  allow?: string[]
  ask?: string[]
  deny?: string[]
  defaultMode?: PermissionMode
}

export type AssetsConfig = {
  /** Directories holding `<name>/SKILL.md`. */
  skills?: string[]
  /** Directories holding `<name>.md` agent definitions. */
  agents?: string[]
  /** Directories holding `<name>.md` slash commands. */
  commands?: string[]
}

export type McpServerConfig = {
  /** `local` spawns a process over stdio; `remote` talks HTTP. */
  type?: 'local' | 'remote'
  /** Local: argv, e.g. `["npx","-y","@azure-devops/mcp","org"]`. */
  command?: string[] | string
  /** Local: extra environment for the child process. */
  environment?: Record<string, string>
  /**
   * Local: forward this process's environment to the server. Default **true**,
   * which is what opencode and Claude Code do — a config written for them often
   * relies on an ambient credential and would otherwise fail with an opaque
   * handshake error. Set to `false` to hand the server only the transport's safe
   * defaults (PATH, HOME, TEMP, …) plus `environment`.
   */
  inheritEnv?: boolean
  /** Local: working directory. Defaults to the session cwd. */
  cwd?: string
  /** Remote: endpoint URL. */
  url?: string
  /** Remote: extra HTTP headers. */
  headers?: Record<string, string>
  enabled?: boolean
  /** Seconds allowed for handshake and for each tool call. Default 60. */
  timeout?: number
  /**
   * Send tool schemas up front instead of deferring them.
   * Default is to defer: MCP servers are the main reason deferral exists.
   */
  eager?: boolean
  /** Only expose these tool names. */
  allowedTools?: string[]
  /**
   * Let this server's tools run concurrently with each other.
   *
   * By default only tools that declare `readOnlyHint` are batched — and that
   * annotation is optional in the protocol, so most servers set nothing and
   * every `list_*`/`get_*` ends up running one at a time. This is the way out,
   * and it is a per-server decision because only whoever configured the server
   * knows whether its tools are safe to overlap.
   *
   * `true` marks all of them; a list marks only those names (plus anything the
   * server itself declares read-only).
   */
  parallelSafe?: boolean | string[]
}

export type WebConfig = {
  /**
   * Hosts `WebFetch` may reach even though they resolve to a private address —
   * an internal wiki, a docs server on localhost. Empty by default: opening the
   * internal network has to be an explicit decision, like `inheritMcp`.
   */
  allowPrivateHosts?: string[]
  /** Body bytes read before the fetch is cut off. Default 2 MiB. */
  maxBytes?: number
}

export type CompactionConfig = {
  /** Default true. */
  enabled?: boolean
  /** Fraction of the model context window that triggers compaction. Default 0.85. */
  threshold?: number
  /** User turns kept verbatim after the summary. Default 4. */
  keepRecentTurns?: number
  /** Model used to write the summary. Defaults to `smallModel`, then the session model. */
  model?: string
  /** Hard cap on summary length. Default 4000. */
  maxOutputTokens?: number
}

export type Config = {
  $schema?: string
  /** `provider/model`, e.g. `selbetti/opus`. */
  model?: string
  /** Cheap model for titles, classification, subagent defaults. */
  smallModel?: string
  provider?: Record<string, ProviderConfig>
  /** Provider ids to ignore even when declared or connected. */
  disabledProviders?: string[]
  /** Files/globs injected as `<system-reminder>` context (CLAUDE.md chain). */
  instructions?: string[]
  assets?: AssetsConfig
  permissions?: PermissionsConfig
  hooks?: Record<string, HookMatcherGroup[]>
  mcp?: Record<string, McpServerConfig>
  /**
   * Reuse MCP servers declared in opencode or Claude Code when this config does
   * not declare a server of the same name. `true` means both.
   *
   * Off by default on purpose: inheriting means spawning whatever process the
   * other tool's config points at, and a config written for another tool is not
   * consent to run it from here. `bytecode mcp` lists what is available.
   */
  inheritMcp?: boolean | ('opencode' | 'claude')[]
  compaction?: CompactionConfig
  /**
   * Prompt caching. On by default for providers whose SDK speaks Anthropic's
   * `cacheControl`; `enabled: true` forces it for a proxy that speaks the same
   * dialect behind another surface.
   */
  cache?: { enabled?: boolean; ttl?: '5m' | '1h' }
  /**
   * Multi-agent orchestration. Off by default: a workflow can spawn many
   * subagents, so it is an explicit decision rather than something the model
   * can reach for on its own.
   */
  workflows?: {
    enabled?: boolean
    /** Subagents running at once. Defaults to min(8, cores - 2). */
    maxConcurrency?: number
    /** Hard stop for runaway loops. Defaults to 1000. */
    maxAgents?: number
    /**
     * Output-token ceiling per run. A hard stop, not a hint: the step that would
     * cross it fails instead of running. Unset means no ceiling.
     */
    tokenBudget?: number
  }
  /** `terracotta` | `violet` | `azure` | `emerald` | `amber`, or explicit xterm-256 indices. */
  theme?: { preset?: string; tokens?: Record<string, number> }
  ui?: {
    /**
     * Width of the app column. 0 or absent fills the terminal; a positive value
     * caps and centres it (the design spec uses 120).
     */
    maxWidth?: number
  }
  /** Tool names sent as name-only until `ToolSearch` loads their schema. */
  deferredTools?: string[]
  /** Tool names removed from the registry entirely. */
  disabledTools?: string[]
  effort?: EffortLevel
  reasoning?: {
    /**
     * Whether this provider streams its reasoning as literal `<think>` tags in
     * the content channel, which the loop then has to split out. Guessed from
     * the provider package when unset — on for OpenAI-compatible endpoints, off
     * for providers with a real reasoning channel, where filtering would eat the
     * tags out of an answer that is legitimately about them.
     */
    inlineThinkTags?: boolean
  }
  maxOutputTokens?: number
  /**
   * Refuse a write that would clobber a file the session never read, or one that
   * changed on disk since it did. On by default; `false` restores the old
   * behaviour of writing whatever was asked.
   */
  fileGuard?: boolean
  /**
   * Model calls one user turn may make before it stops. Default 64. At 75% of it
   * the model is told to converge; at the ceiling the turn ends with the history
   * intact, so "continue" resumes it.
   */
  maxSteps?: number
  /** How deep `Agent` may nest. 0 disables subagents. */
  subagentDepth?: number
  web?: WebConfig
  /**
   * How many subagents emitted in the same step may run at once. Defaults to
   * `min(8, cpus - 2)`; 1 restores the old one-at-a-time behaviour.
   */
  subagentConcurrency?: number
  /** Where transcripts are written. Defaults to `~/.bytecode/projects`. */
  dataDir?: string
  /**
   * Read API keys from opencode's credential store as a last resort.
   * Off by default — enable only if you want bytecode to share opencode's logins.
   */
  openCodeAuth?: boolean
}

export type ResolvedModel = {
  providerId: string
  modelKey: string
  /** Wire id sent to the provider. */
  modelId: string
  provider: ProviderConfig
  model: ModelConfig
}
