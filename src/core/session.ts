import path from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import type { ModelMessage } from 'ai'
import type { Config, PermissionMode, ResolvedModel } from '../config/types.ts'
import type { AgentDefinition, AssetBundle } from '../assets/index.ts'
import { loadAssets } from '../assets/index.ts'
import { createLanguageModel, resolveModel } from '../provider/registry.ts'
import { cachePolicy } from './cache.ts'
import { HookRunner } from './hooks.ts'
import { McpManager } from '../mcp/client.ts'
import { discoverMcpServers } from '../mcp/discover.ts'
import { Transcript } from './transcript.ts'
import { ToolRegistry } from './tools.ts'
import { evaluate } from './permissions.ts'
import type { PermissionQuery, PermissionVerdict } from './permissions.ts'
import type { SessionState } from './sessions.ts'
import { ensureDir } from '../util/fs.ts'
import { CLI, VERSION, envOption, stateFile } from '../util/paths.ts'

export { VERSION as BYTECODE_VERSION } from '../util/paths.ts'

export type ToolStat = { calls: number; ok: number; fail: number; ms: number }

/** Everything measurable about one user turn: the leadtime record. */
export type TurnStats = {
  startedAt: number
  endedAt?: number
  /**
   * First line of what was asked. Without it a session report is a column of
   * durations with nothing to attach them to — the question behind "what did
   * this cost" is always "what did *what* cost".
   */
  label?: string
  /** Model calls made to satisfy the turn. */
  steps: number
  /** Stream failures that were retried rather than surfaced. */
  retries: number
  tools: Record<string, ToolStat>
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export function emptyTurnStats(startedAt = Date.now()): TurnStats {
  return {
    startedAt,
    steps: 0,
    retries: 0,
    tools: {},
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }
}

export type UIEvent =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-start'; id: string; name: string; summary: string; subject?: string }
  | { type: 'tool-end'; id: string; name: string; ok: boolean; preview: string }
  | { type: 'notice'; text: string }
  | { type: 'error'; text: string }
  | { type: 'usage'; input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
  | { type: 'turn-end'; stats?: TurnStats }
  // Subagent lifecycle. The UI shows these live in a pinned strip instead of
  // interleaving a child's tool calls into the parent transcript. `agent-event`
  // forwards the child's own events verbatim, so its session can be opened and
  // rendered with the same block renderer as the main one.
  | { type: 'agent-start'; id: string; agentType: string; label: string }
  | { type: 'agent-event'; id: string; event: UIEvent }
  | { type: 'agent-end'; id: string; ok: boolean; chars: number }

export type PermissionRequest = {
  tool: string
  summary: string
  subject?: string
  verdict: PermissionVerdict
  input: Record<string, unknown>
  /**
   * Which agent is asking, when it is not the main session. With subagents
   * running concurrently, "Edit x.ts — allow?" without a name is a question the
   * user cannot answer.
   */
  agent?: string
}

export type SessionOptions = {
  config: Config
  cwd: string
  modelRef: string
  mode?: PermissionMode
  depth?: number
  parent?: Session
  agentType?: string
  /** Reuse an existing transcript instead of starting a new one. */
  sessionId?: string
}

export class Session {
  readonly config: Config
  readonly cwd: string
  readonly registry = new ToolRegistry()
  /** Replaced by `resumeFrom`, so a resumed session keeps writing to its own file. */
  transcript: Transcript
  readonly hooks: HookRunner
  readonly depth: number
  readonly agentType?: string
  readonly id: string
  /** Shared with child sessions: one connection set per process. */
  readonly mcp: McpManager
  /** Set on subagent sessions, so their cost rolls up into the parent's turn. */
  readonly parent?: Session

  assets: AssetBundle = { instructions: [], skills: [], agents: [], commands: [] }
  messages: ModelMessage[] = []
  mode: PermissionMode
  modelRef: string
  bootstrapped = false
  abort: AbortController | null = null
  /**
   * Last provider-reported prompt size, with the message count it covered.
   * Anything appended after that count is estimated instead of guessed at.
   */
  tokenBaseline?: { messageCount: number; inputTokens: number }
  /** Set when a compaction attempt failed, so it is not retried every step. */
  compactionSuspended = false
  /**
   * Primary agent the session is acting as, opencode-style. Null means the plain
   * harness behaviour. Switching one replaces the prompt, may switch the model,
   * and overlays the agent's own permission rules.
   */
  primaryAgent: AgentDefinition | null = null
  /** Metrics for the turn in flight. */
  turn: TurnStats | null = null
  /** Metrics for the last finished turn, and the running session total. */
  lastTurn: TurnStats | null = null
  sessionStats: TurnStats = emptyTurnStats()
  /**
   * Every finished turn, newest last, capped. A long session is many turns, and
   * reporting only the last one answers "what did the last thing cost" when the
   * question was "what did the afternoon cost".
   */
  readonly turns: TurnStats[] = []

  /** Replaced by the UI. Default sink keeps headless runs quiet. */
  emit: (event: UIEvent) => void = () => {}
  /** Replaced by the UI. Default denies, so headless runs never hang. */
  requestPermission: (req: PermissionRequest) => Promise<boolean> = async () => false

  private resolved?: ResolvedModel
  private languageModel?: unknown
  /** Model in effect before a primary agent overrode it. */
  private baseModelRef?: string
  private gitRepo?: boolean

  constructor(opts: SessionOptions) {
    this.config = opts.config
    this.cwd = opts.cwd
    this.modelRef = opts.modelRef
    this.mode = opts.mode ?? opts.config.permissions?.defaultMode ?? 'default'
    this.depth = opts.depth ?? 0
    this.agentType = opts.agentType
    this.hooks = new HookRunner(opts.config.hooks, opts.cwd)
    this.id =
      opts.parent?.transcript.sessionId ??
      `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.parent = opts.parent
    this.transcript =
      opts.parent?.transcript ??
      new Transcript({
        sessionId: opts.sessionId,
        cwd: opts.cwd,
        version: VERSION,
        dataDir: opts.config.dataDir,
      })
    this.mcp = opts.parent?.mcp ?? new McpManager(opts.config.mcp, opts.cwd)
  }

  /**
   * Adopts a saved session: its history, its model and its transcript file.
   *
   * The permission mode is deliberately **not** restored — silently coming back
   * in `bypassPermissions` because a past session was in it would be an
   * escalation the user never asked for.
   */
  resumeFrom(state: SessionState): void {
    this.transcript = new Transcript({
      sessionId: state.id,
      cwd: this.cwd,
      version: VERSION,
      dataDir: this.config.dataDir,
    })
    this.messages = state.messages
    this.tokenBaseline = state.tokenBaseline
    this.compactionSuspended = false
    // The restored history already contains the bootstrap reminders, so sending
    // them again would duplicate every roster in the context.
    this.bootstrapped = true
    if (state.modelRef && state.modelRef !== this.modelRef) {
      try {
        this.setModel(state.modelRef)
        this.resolveModel()
      } catch {
        // The saved model may no longer be configured; keep the current one.
        this.setModel(this.modelRef)
      }
    }
  }

  /**
   * Adds to this turn's metrics and to every ancestor's, so a parent turn that
   * spawned subagents reports what the whole tree actually cost.
   */
  record(apply: (stats: TurnStats) => void): void {
    for (let s: Session | undefined = this; s; s = s.parent) {
      if (s.turn) apply(s.turn)
      apply(s.sessionStats)
    }
  }

  get scratchpad(): string {
    return path.join(tmpdir(), CLI, this.transcript.sessionId)
  }

  /** Cached: this was a synchronous `existsSync` on every step of the loop. */
  get isGitRepo(): boolean {
    if (this.gitRepo === undefined) this.gitRepo = existsSync(path.join(this.cwd, '.git'))
    return this.gitRepo
  }

  async init(onNotice?: (text: string) => void): Promise<void> {
    // A child inherits the parent's assets by reference. Re-scanning cost 17.5ms
    // of readdir/readFile per subagent on this machine — a 100-step workflow paid
    // ~1.8s for a roster that cannot change while the turn runs. `/reload` is the
    // only thing that should re-read them.
    if (this.parent) this.assets = this.parent.assets
    else this.assets = await loadAssets(this.config, this.cwd)
    await ensureDir(this.scratchpad)
    // Own `mcp` block plus, only when `inheritMcp` says so, servers declared in
    // opencode or Claude Code. A child shares the parent's manager, so this runs
    // once per process.
    //
    // `BYTECODE_NO_MCP=1` skips the whole thing. Config is merged from the user
    // directory upwards, so a session started anywhere can inherit servers that
    // spawn processes and take seconds to hand shake — the switch exists so that
    // can be taken out of the picture, for a fast start, for bisecting a hanging
    // server, and so the test suites never spawn whatever this machine configured.
    if (!this.parent) {
      if (envOption('NO_MCP')) {
        this.mcp.use(undefined)
      } else {
        const found = await discoverMcpServers(this.config, this.cwd)
        this.mcp.use(
          found.length > 0 ? Object.fromEntries(found.map(s => [s.name, s.config])) : this.config.mcp,
          Object.fromEntries(found.map(s => [s.name, s.source])),
        )
      }
    }
    await this.mcp.connect(onNotice ?? (text => this.emit({ type: 'notice', text })))
    if (this.config.deferredTools?.length) {
      this.registry.markDeferred(this.config.deferredTools)
    }
    for (const name of this.config.disabledTools ?? []) this.registry.remove(name)
  }

  async reloadAssets(): Promise<void> {
    this.assets = await loadAssets(this.config, this.cwd)
  }

  resolveModel(): ResolvedModel {
    if (!this.resolved) this.resolved = resolveModel(this.config, this.modelRef)
    return this.resolved
  }

  async model(): Promise<unknown> {
    if (!this.languageModel) {
      this.languageModel = await createLanguageModel(this.resolveModel(), {
        openCodeAuth: this.config.openCodeAuth,
        // A provider that cannot carry the breakpoint through the SDK gets it
        // written into the request body, which means the decision has to be made
        // here, where the model instance is built.
        cache: cachePolicy(this.config, this.resolveModel()),
      })
    }
    return this.languageModel
  }

  setModel(ref: string): void {
    this.modelRef = ref
    this.resolved = undefined
    this.languageModel = undefined
  }

  get maxOutputTokens(): number | undefined {
    const perModel = this.resolveModel().model.limit?.output
    return this.config.maxOutputTokens ?? perModel
  }

  /**
   * Session rules, with the active agent's rules layered **over** them.
   *
   * Not a union: unioning put an agent's `edit: allow` next to the config's
   * `ask` for the same tool, and since ask outranks allow the agent's rule could
   * never take effect — which is the whole reason it is written. So:
   *
   *   1. a config `deny` always wins — it is the hard guardrail
   *   2. then the agent's own rules, if any of them matches
   *   3. then the config's rules
   */
  evaluatePermission(query: PermissionQuery): PermissionVerdict {
    const config = this.config.permissions
    const agent = this.primaryAgent?.permissions

    const base = evaluate(config, this.mode, query)
    if (!agent) return base
    if (base.decision === 'deny' && base.rule) return base

    const fromAgent = evaluate({ ...agent, defaultMode: config?.defaultMode }, this.mode, query)
    // `rule` is set only when one of the agent's own patterns matched; without it
    // the verdict is just the kind's default and carries no intent.
    return fromAgent.rule ? fromAgent : base
  }

  /**
   * Switches the session into a primary agent, or back out with null. The model
   * follows the agent when it names one; the previous model is restored on exit.
   */
  setPrimaryAgent(agent: AgentDefinition | null): void {
    if (agent && !this.baseModelRef) this.baseModelRef = this.modelRef
    this.primaryAgent = agent

    const wanted = agent?.model
    if (wanted) {
      try {
        this.setModel(wanted.includes('/') ? wanted : this.modelRef)
        this.resolveModel()
      } catch {
        // An agent naming a model this machine has no provider for must not make
        // the agent unusable — keep the current one.
        this.setModel(this.baseModelRef ?? this.modelRef)
      }
    } else if (!agent && this.baseModelRef) {
      this.setModel(this.baseModelRef)
      this.baseModelRef = undefined
    }
  }

  /** Spawns a child session that shares the transcript but has its own context. */
  child(opts: { modelRef?: string; agentType?: string }): Session {
    return new Session({
      config: this.config,
      cwd: this.cwd,
      modelRef: opts.modelRef ?? this.config.smallModel ?? this.modelRef,
      mode: this.mode,
      depth: this.depth + 1,
      parent: this,
      agentType: opts.agentType,
    })
  }
}

export function defaultDataDir(): string {
  return stateFile('projects')
}
