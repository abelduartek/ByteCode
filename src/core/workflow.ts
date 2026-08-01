import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir, cpus } from 'node:os'
import path from 'node:path'
import type { Session } from './session.ts'
import { runTurn } from './loop.ts'
// Shared with the `Agent` tool, so the two ways of asking for JSON cannot drift.
// No repair turn here on purpose: the budget ceiling throws rather than warns,
// so a retry could abort a whole run to fix one step's formatting.
import { parseStructured, schemaInstruction } from './structured.ts'
import { ensureDir, readTextIfExists, resolvePath } from '../util/fs.ts'
import { PROJECT_DIRS, stateFile } from '../util/paths.ts'
import { describeError } from '../util/error.ts'

// Deterministic multi-agent orchestration: a plain JS script decides the control
// flow (fan-out, pipelines, loops) and each step is a subagent with its own
// context. The script is the deterministic part; only the steps are model-driven.
//
// Off by default — it can spawn a lot of agents, so enabling it is an explicit
// decision (`workflows.enabled`, `/workflows on`, or `--workflows`).

export type WorkflowMeta = {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
}

export type AgentOptions = {
  label?: string
  phase?: string
  model?: string
  agentType?: string
  /** JSON Schema. When present the step must answer with matching JSON. */
  schema?: Record<string, unknown>
}

export type WorkflowProgress =
  | { type: 'phase'; title: string }
  | { type: 'log'; message: string }
  | { type: 'agent-start'; id: number; label: string; phase?: string }
  | { type: 'agent-end'; id: number; label: string; ok: boolean; chars: number }

/** One step in the live view: an agent call and what became of it. */
export type WorkflowStep = {
  id: number
  label: string
  phase?: string
  state: 'running' | 'ok' | 'fail' | 'cached'
  chars: number
  startedAt: number
  endedAt?: number
}

/**
 * A run as the UI sees it. Kept apart from `WorkflowResult` on purpose: the
 * result is what the tool returns at the end, this is what `/workflows` reads
 * while the thing is still moving.
 */
export type WorkflowRun = {
  runId: string
  name: string
  description: string
  startedAt: number
  endedAt?: number
  steps: WorkflowStep[]
  logs: string[]
  errors: string[]
  /** Output tokens spent by the steps, and the ceiling if one was set. */
  tokens: number
  budget: number | null
  done: boolean
  ok: boolean
}

export type WorkflowResult = {
  runId: string
  meta: WorkflowMeta
  result: unknown
  agents: number
  tokens: number
  scriptPath: string
  journalPath: string
  errors: string[]
}

/** A script saved on disk under `workflows/`, callable by name. */
export type SavedWorkflow = { name: string; description: string; file: string }

const DEFAULT_MAX_AGENTS = 1000
/** Runs kept for the viewer. Old ones fall off so a long session stays bounded. */
const MAX_KEPT_RUNS = 5
/** Log lines kept per run, for the same reason. */
const MAX_KEPT_LOGS = 50

function workflowDir(): string {
  return stateFile('workflows')
}

function rootOf(session: Session): Session {
  let root = session
  while (root.parent) root = root.parent
  return root
}

/**
 * Live runs of a session tree, keyed by the **root** session — the same shape as
 * the todo lists, and for the same reason: a run started inside a subagent still
 * has to be visible in the one window the user is looking at.
 */
const liveRuns = new WeakMap<Session, WorkflowRun[]>()

/** What `/workflows` renders: newest run last, as they started. */
export function workflowRuns(session: Session): WorkflowRun[] {
  return liveRuns.get(rootOf(session)) ?? []
}

function trackRun(session: Session, run: WorkflowRun): void {
  const root = rootOf(session)
  const runs = liveRuns.get(root) ?? []
  runs.push(run)
  while (runs.length > MAX_KEPT_RUNS) runs.shift()
  liveRuns.set(root, runs)
}

/**
 * Reads a JavaScript object literal **without running it**.
 *
 * `meta` is what the user is shown to decide whether to approve a workflow, so
 * getting it must not execute the file: `new Function('return (' + literal + ')')`
 * runs whatever is between the braces, and `{ get name() { … } }` is enough to
 * make merely *listing* the workflows in `~/.claude/workflows` execute code.
 * Only the literal subset is accepted — objects, arrays, strings, numbers,
 * booleans, null — which is also exactly what a pure literal `meta` can contain.
 *
 * Being a real reader rather than a brace counter, it also skips comments: the
 * previous scanner counted braces and quotes inside line and block comments, so
 * an apostrophe in a comment ("don't") swallowed the rest of the literal.
 */
function readLiteral(src: string, from: number): unknown {
  let i = from

  function fail(what: string): never {
    const line = src.slice(0, i).split('\n').length
    throw new Error(`${what} (line ${line})`)
  }

  function skip(): void {
    for (;;) {
      const ch = src[i]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
        i++
        continue
      }
      if (ch === '/' && src[i + 1] === '/') {
        while (i < src.length && src[i] !== '\n') i++
        continue
      }
      if (ch === '/' && src[i + 1] === '*') {
        const close = src.indexOf('*/', i + 2)
        if (close === -1) fail('unterminated comment')
        i = close + 2
        continue
      }
      return
    }
  }

  function escape(): string {
    const ch = src[i++]
    if (ch === 'n') return '\n'
    if (ch === 't') return '\t'
    if (ch === 'r') return '\r'
    if (ch === 'b') return '\b'
    if (ch === 'f') return '\f'
    if (ch === 'v') return '\v'
    if (ch === '0') return '\0'
    if (ch === '\n') return ''
    if (ch === 'x') {
      const hex = src.slice(i, i + 2)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) fail('bad \\x escape')
      i += 2
      return String.fromCharCode(parseInt(hex, 16))
    }
    if (ch === 'u') {
      if (src[i] === '{') {
        const close = src.indexOf('}', i)
        const hex = close === -1 ? '' : src.slice(i + 1, close)
        if (!/^[0-9a-fA-F]{1,6}$/.test(hex)) fail('bad \\u escape')
        i = close + 1
        return String.fromCodePoint(parseInt(hex, 16))
      }
      const hex = src.slice(i, i + 4)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('bad \\u escape')
      i += 4
      return String.fromCharCode(parseInt(hex, 16))
    }
    return ch ?? ''
  }

  function string(): string {
    const quote = src[i++]
    let out = ''
    for (;;) {
      const ch = src[i]
      if (ch === undefined) fail('unterminated string')
      if (ch === '\\') {
        i++
        out += escape()
        continue
      }
      if (ch === quote) {
        i++
        return out
      }
      // A template that interpolates is an expression, not a literal.
      if (quote === '`' && ch === '$' && src[i + 1] === '{') fail('`${}` is not a literal')
      out += ch
      i++
    }
  }

  function object(): Record<string, unknown> {
    i++ // {
    const out: Record<string, unknown> = {}
    for (;;) {
      skip()
      if (src[i] === '}') {
        i++
        return out
      }
      if (src[i] === undefined) fail('meta literal is not closed')
      const quote = src[i]
      let key: string
      if (quote === '"' || quote === "'" || quote === '`') key = string()
      else {
        const name = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(src.slice(i))
        if (!name) fail('expected a property name')
        i += name[0].length
        key = name[0]
      }
      skip()
      if (src[i] !== ':') fail('expected `:` after a property name')
      i++
      out[key] = value()
      skip()
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === '}') {
        i++
        return out
      }
      fail('expected `,` or `}`')
    }
  }

  function array(): unknown[] {
    i++ // [
    const out: unknown[] = []
    for (;;) {
      skip()
      if (src[i] === ']') {
        i++
        return out
      }
      if (src[i] === undefined) fail('meta literal is not closed')
      out.push(value())
      skip()
      if (src[i] === ',') {
        i++
        continue
      }
      if (src[i] === ']') {
        i++
        return out
      }
      fail('expected `,` or `]`')
    }
  }

  function value(): unknown {
    skip()
    const ch = src[i]
    if (ch === undefined) fail('unexpected end of meta literal')
    if (ch === '{') return object()
    if (ch === '[') return array()
    if (ch === '"' || ch === "'" || ch === '`') return string()
    if (src.startsWith('true', i)) return (i += 4), true
    if (src.startsWith('false', i)) return (i += 5), false
    if (src.startsWith('null', i)) return (i += 4), null
    if (src.startsWith('undefined', i)) return (i += 9), undefined
    const num = /^[+-]?(?:0[xX][0-9a-fA-F]+|(?:\d[\d_]*)?\.?\d[\d_]*(?:[eE][+-]?\d+)?)/.exec(src.slice(i))
    if (num) {
      i += num[0].length
      return Number(num[0].replace(/_/g, ''))
    }
    fail('meta must be a plain literal — no variables, calls or spreads')
  }

  skip()
  if (src[i] !== '{') fail('meta must be an object literal')
  return object()
}

/**
 * `meta` must be a pure object literal, so it can be read without running the
 * script — the user sees what a workflow does before approving it.
 */
export function extractMeta(script: string): WorkflowMeta {
  const start = script.search(/export\s+const\s+meta\s*=\s*\{/)
  if (start === -1) throw new Error('workflow script must start with `export const meta = { ... }`')

  let meta: WorkflowMeta
  try {
    meta = readLiteral(script, script.indexOf('{', start)) as WorkflowMeta
  } catch (err) {
    throw new Error(`workflow meta is not a plain literal: ${describeError(err)}`)
  }
  if (!meta?.name || !meta?.description) {
    throw new Error('workflow meta needs at least { name, description }')
  }
  return meta
}

/**
 * Where a workflow called by name is looked up. Same trees as the other assets,
 * so a script lives next to the agents and skills it drives.
 */
export function workflowSearchDirs(cwd: string): string[] {
  const home = homedir()
  return [
    path.join(cwd, '.claude', 'workflows'),
    ...PROJECT_DIRS.map(dir => path.join(cwd, dir, 'workflows')),
    path.join(home, '.claude', 'workflows'),
    ...PROJECT_DIRS.map(dir => path.join(home, dir, 'workflows')),
  ]
}

/** Run artifacts share the directory with saved scripts; they are not workflows. */
function isRunArtifact(file: string): boolean {
  return path.basename(file).startsWith('wf_')
}

/** Named workflows found on disk, for `/workflows` and for `workflow('name')`. */
export async function listWorkflows(cwd: string): Promise<SavedWorkflow[]> {
  const found = new Map<string, SavedWorkflow>()
  for (const dir of workflowSearchDirs(cwd)) {
    let entries: string[]
    try {
      entries = await fs.readdir(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) continue
      if (isRunArtifact(entry)) continue
      const file = path.join(dir, entry)
      const script = await readTextIfExists(file)
      if (!script) continue
      try {
        const meta = extractMeta(script)
        // A project script wins over one with the same name in `$HOME`.
        if (!found.has(meta.name)) found.set(meta.name, { ...meta, file })
      } catch {
        /* a file that is not a workflow just is not listed */
      }
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Accepts a name, a path, or `{ scriptPath }` — what the script's `workflow()` takes. */
export async function resolveWorkflowScript(
  ref: unknown,
  cwd: string,
): Promise<{ file: string; script: string }> {
  const asPath =
    typeof ref === 'object' && ref !== null && 'scriptPath' in ref
      ? String((ref as { scriptPath: unknown }).scriptPath)
      : typeof ref === 'string' && /[\\/]|\.m?js$/.test(ref)
        ? ref
        : null

  if (asPath) {
    const file = resolvePath(asPath, cwd)
    const script = await readTextIfExists(file)
    if (!script) throw new Error(`workflow script not found: ${asPath}`)
    return { file, script }
  }

  const name = String(ref ?? '').trim()
  if (!name) throw new Error('workflow() needs a name or { scriptPath }')
  for (const dir of workflowSearchDirs(cwd)) {
    for (const ext of ['.js', '.mjs']) {
      const file = path.join(dir, `${name}${ext}`)
      const script = await readTextIfExists(file)
      if (script) return { file, script }
    }
  }
  const known = (await listWorkflows(cwd)).map(w => w.name).join(', ')
  throw new Error(`unknown workflow "${name}"${known ? ` — available: ${known}` : ''}`)
}

/** Caps how many subagents run at once. */
function createLimiter(limit: number) {
  let active = 0
  const queue: (() => void)[] = []

  return async function run<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) await new Promise<void>(resolve => queue.push(resolve))
    active++
    try {
      return await task()
    } finally {
      active--
      queue.shift()?.()
    }
  }
}

export type RunOptions = {
  script: string
  args?: unknown
  resumeFromRunId?: string
  /** Output-token ceiling for the whole run. Overrides `workflows.tokenBudget`. */
  budget?: number
  onProgress?: (event: WorkflowProgress) => void
  /**
   * The turn's signal. A fan-out can be hundreds of agents deep by the time the
   * user presses esc; without it, the tool call returns and the fleet keeps
   * running — spending tokens on an answer nobody is waiting for.
   */
  signal?: AbortSignal
}

/**
 * Everything a script's globals need, shared by a nested `workflow()` call: one
 * agent counter, one limiter, one journal, one budget. Nesting must not double
 * the concurrency or restart the numbering.
 */
type RunContext = {
  session: Session
  cwd: string
  runId: string
  journalPath: string
  limiter: <T>(task: () => Promise<T>) => Promise<T>
  cached: Map<string, unknown[]>
  errors: string[]
  emit: (event: WorkflowProgress) => void
  record: WorkflowRun
  maxAgents: number
  budgetTotal: number | null
  agents: number
  tokens: number
  phase?: string
  signal?: AbortSignal
}

export async function runWorkflow(session: Session, opts: RunOptions): Promise<WorkflowResult> {
  const meta = extractMeta(opts.script)
  const runId = `wf_${Date.now().toString(36)}${randomUUID().slice(0, 6)}`
  const dir = workflowDir()
  await ensureDir(dir)

  const scriptPath = path.join(dir, `${runId}.js`)
  const journalPath = path.join(dir, `${runId}.jsonl`)
  await fs.writeFile(scriptPath, opts.script, 'utf8')

  // Resume matches on the exact (prompt, options) pair, never on position or
  // call id: the journal is written in completion order, and with concurrent
  // stages even the call order varies between runs. An identical key means
  // identical inputs, so replaying is sound. Duplicate keys are queued so a
  // step that legitimately runs twice replays twice.
  const cached = new Map<string, unknown[]>()
  if (opts.resumeFromRunId) {
    const raw = await readTextIfExists(path.join(dir, `${opts.resumeFromRunId}.jsonl`))
    for (const line of (raw ?? '').split('\n').filter(Boolean)) {
      try {
        const entry = JSON.parse(line) as { type: string; key: string; ok?: boolean; result: unknown }
        if (entry.type !== 'agent') continue
        // A step that failed is exactly what a resume exists to run again.
        // Journals written before `ok` was recorded have no flag; those replay,
        // as they did before.
        if (entry.ok === false) continue
        const queue = cached.get(entry.key) ?? []
        queue.push(entry.result)
        cached.set(entry.key, queue)
      } catch {
        /* a truncated journal just means fewer replayable steps */
      }
    }
  }

  const config = session.config.workflows ?? {}
  const limit = Math.max(1, config.maxConcurrency ?? Math.min(8, Math.max(1, cpus().length - 2)))
  const budgetTotal = opts.budget ?? config.tokenBudget ?? null

  const record: WorkflowRun = {
    runId,
    name: meta.name,
    description: meta.description,
    startedAt: Date.now(),
    steps: [],
    logs: [],
    errors: [],
    tokens: 0,
    budget: budgetTotal,
    done: false,
    ok: true,
  }
  trackRun(session, record)

  const ctx: RunContext = {
    session,
    cwd: session.cwd,
    runId,
    journalPath,
    limiter: createLimiter(limit),
    cached,
    errors: record.errors,
    emit: event => opts.onProgress?.(event),
    record,
    maxAgents: config.maxAgents ?? DEFAULT_MAX_AGENTS,
    budgetTotal,
    agents: 0,
    tokens: 0,
    signal: opts.signal,
  }

  let result: unknown
  try {
    result = await runScript(ctx, opts.script, opts.args, 0)
  } catch (err) {
    record.ok = false
    ctx.errors.push(describeError(err))
    throw new Error(`workflow "${meta.name}" failed: ${describeError(err)}`)
  } finally {
    record.done = true
    record.endedAt = Date.now()
    await appendJournal(ctx, { type: 'end', agents: ctx.agents, tokens: ctx.tokens, errors: ctx.errors })
  }

  return {
    runId,
    meta,
    result,
    agents: ctx.agents,
    tokens: ctx.tokens,
    scriptPath,
    journalPath,
    errors: ctx.errors,
  }
}

async function appendJournal(ctx: RunContext, entry: Record<string, unknown>): Promise<void> {
  await fs.appendFile(ctx.journalPath, `${JSON.stringify(entry)}\n`, 'utf8')
}

/**
 * Runs one script body against a context. Called once for the top-level script
 * and again, with the same context, for every nested `workflow()`.
 *
 * `prefix` labels the nested run's phases (`▸ name`), so a fan-out inside a
 * sub-workflow is still readable as belonging to it.
 */
async function runScript(
  ctx: RunContext,
  script: string,
  args: unknown,
  depth: number,
  prefix?: string,
): Promise<unknown> {
  async function agent(prompt: string, options: AgentOptions = {}): Promise<unknown> {
    // Checked here rather than only inside the limiter: a fan-out queues every
    // step up front, and after an esc none of the queued ones should start.
    if (ctx.signal?.aborted) throw new Error('workflow interrupted')
    if (ctx.agents >= ctx.maxAgents) throw new Error(`workflow exceeded ${ctx.maxAgents} agents`)
    // A hard ceiling, not a hint: once the budget is gone no further step runs,
    // otherwise a loop written against `remaining()` could overshoot forever.
    if (ctx.budgetTotal !== null && ctx.tokens >= ctx.budgetTotal) {
      throw new Error(`workflow spent its ${ctx.budgetTotal} output-token budget`)
    }

    const id = ++ctx.agents
    const label = options.label ?? `step ${id}`
    const phase = options.phase ? withPrefix(options.phase, prefix) : ctx.phase
    const key = JSON.stringify({ prompt, options })

    const step: WorkflowStep = {
      id,
      label,
      phase,
      state: 'running',
      chars: 0,
      startedAt: Date.now(),
    }
    ctx.record.steps.push(step)

    const queue = ctx.cached.get(key)
    if (queue && queue.length > 0) {
      const result = queue.shift()
      step.state = 'cached'
      step.endedAt = Date.now()
      ctx.emit({ type: 'agent-start', id, label: `${label} (cache)`, phase })
      ctx.emit({ type: 'agent-end', id, label, ok: true, chars: 0 })
      await appendJournal(ctx, { type: 'agent', id, label, key, ok: true, result })
      return result
    }

    ctx.emit({ type: 'agent-start', id, label, phase })

    return ctx.limiter(async () => {
      if (ctx.signal?.aborted) throw new Error('workflow interrupted')
      const child = ctx.session.child({
        modelRef: options.model ?? ctx.session.config.smallModel ?? ctx.session.modelRef,
        agentType: options.agentType ?? 'workflow',
      })
      await child.init(() => {})

      const { registerTools } = await import('../tools/index.ts')
      const definition = options.agentType
        ? ctx.session.assets.agents.find(a => a.name === options.agentType)
        : undefined
      registerTools(child, definition && definition.tools.length > 0 ? definition.tools : undefined)

      let text = ''
      // Forwarded so a workflow step can be opened in the agent viewer too. The
      // usage events are also what the budget is measured from — output tokens
      // reported by the provider, not an estimate over the collected text.
      child.emit = event => {
        if (event.type === 'text') text += event.text
        if (event.type === 'usage' && event.output) {
          ctx.tokens += event.output
          ctx.record.tokens = ctx.tokens
        }
        ctx.session.emit({ type: 'agent-event', id: `wf-${id}`, event })
      }
      child.requestPermission = ctx.session.requestPermission

      const preamble = definition ? `${definition.prompt}\n\n---\n\n` : ''
      const suffix = options.schema ? schemaInstruction(options.schema) : ''

      // The step's own turn has its own controller; esc on the turn that started
      // the workflow has to reach it.
      const stopChild = (): void => child.abort?.abort()
      ctx.signal?.addEventListener('abort', stopChild)

      let result: unknown = null
      let ok = true
      try {
        await runTurn(child, `${preamble}${prompt}${suffix}`)
        result = options.schema ? parseStructured(text) : text.trim()
      } catch (err) {
        ok = false
        ctx.errors.push(`${label}: ${describeError(err)}`)
        result = null
      } finally {
        ctx.signal?.removeEventListener('abort', stopChild)
      }

      await child.transcript.flush()
      step.state = ok ? 'ok' : 'fail'
      step.chars = text.length
      step.endedAt = Date.now()
      ctx.emit({ type: 'agent-end', id, label, ok, chars: text.length })
      // `ok` is what keeps a resume honest: a step that failed wrote `null` here
      // and, replayed as a cache hit, the retry would "succeed" with that null
      // without ever calling the model again.
      await appendJournal(ctx, { type: 'agent', id, label, key, ok, result })
      return result
    })
  }

  async function parallel(thunks: (() => Promise<unknown>)[]): Promise<unknown[]> {
    return Promise.all(
      thunks.map(async thunk => {
        try {
          return await thunk()
        } catch (err) {
          ctx.errors.push(describeError(err))
          return null
        }
      }),
    )
  }

  async function pipeline(
    items: unknown[],
    ...stages: ((prev: unknown, item: unknown, index: number) => Promise<unknown>)[]
  ): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let value: unknown = item
        for (const stage of stages) {
          try {
            value = await stage(value, item, index)
          } catch (err) {
            ctx.errors.push(describeError(err))
            return null
          }
        }
        return value
      }),
    )
  }

  function phase(title: string): void {
    const full = withPrefix(title, prefix)
    ctx.phase = full
    ctx.emit({ type: 'phase', title: full })
  }

  function log(message: string): void {
    const line = prefix ? `${prefix} ${message}` : message
    ctx.record.logs.push(line)
    while (ctx.record.logs.length > MAX_KEPT_LOGS) ctx.record.logs.shift()
    ctx.emit({ type: 'log', message: line })
  }

  /**
   * Runs another workflow as a step of this one. One level only: a chain of
   * sub-workflows is a script calling a script calling a script, and no one can
   * read the resulting fan-out — nor bound its cost before approving it.
   */
  async function nested(ref: unknown, childArgs?: unknown): Promise<unknown> {
    if (depth >= 1) throw new Error('workflow() só aninha um nível')
    const { script: source } = await resolveWorkflowScript(ref, ctx.cwd)
    const childMeta = extractMeta(source)
    log(`▸ ${childMeta.name}`)
    // The child's phases must not outlive it: whatever the parent does after the
    // call belongs to the parent's phase, not to the last one the child set.
    const outer = ctx.phase
    try {
      return await runScript(ctx, source, childArgs, depth + 1, `▸ ${childMeta.name}`)
    } finally {
      ctx.phase = outer
    }
  }

  const budget = {
    get total(): number | null {
      return ctx.budgetTotal
    },
    spent: () => ctx.tokens,
    remaining: () =>
      ctx.budgetTotal === null ? Number.POSITIVE_INFINITY : Math.max(0, ctx.budgetTotal - ctx.tokens),
  }

  // `export const meta` becomes a plain const, and the body runs inside an async
  // function — which is what makes top-level `await` and `return` work.
  const body = script.replace(/export\s+const\s+meta\s*=/, 'const meta =')
  const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (
    ...args: string[]
  ) => (...values: unknown[]) => Promise<unknown>

  const fn = new AsyncFunction(
    'agent',
    'parallel',
    'pipeline',
    'phase',
    'log',
    'workflow',
    'budget',
    'args',
    body,
  )
  return fn(agent, parallel, pipeline, phase, log, nested, budget, args)
}

function withPrefix(title: string, prefix?: string): string {
  return prefix ? `${prefix} ${title}` : title
}
