import type { ToolDefinition } from '../core/tools.ts'
import type { Session } from '../core/session.ts'
import { readSkillBody } from '../assets/index.ts'
import { runTurn } from '../core/loop.ts'
import { parseStructured, repairInstruction, schemaInstruction } from '../core/structured.ts'
import { describeError } from '../util/error.ts'

/** Distinguishes concurrent runs of the same agent in the progress strip. */
let agentRuns = 0

/**
 * Agent files written for Claude Code say `model: opus` / `sonnet` / `haiku`, not
 * `provider/model`. Rejecting those made every such agent fail on the first call.
 *
 * The session's **own provider is searched first**. That is what keeps a subagent
 * on the provider that is already authenticated: matching `sonnet` against every
 * provider in config order sent agents to whichever one happened to declare that
 * key, so a session running fine on one endpoint spawned children that 401'd on
 * another.
 */
export function resolveAgentModel(session: Session, requested: unknown): string {
  const wanted = typeof requested === 'string' ? requested.trim() : ''
  if (!wanted) return session.modelRef
  if (wanted.includes('/')) return wanted

  const lower = wanted.toLowerCase()
  const all = Object.entries(session.config.provider ?? {})
  const ownId = session.modelRef.split('/')[0]
  const own = all.filter(([id]) => id === ownId)
  const others = all.filter(([id]) => id !== ownId)

  const exact = (entries: typeof all) => {
    for (const [providerId, provider] of entries) {
      for (const key of Object.keys(provider.models ?? {})) {
        if (key.toLowerCase() === lower) return `${providerId}/${key}`
      }
    }
    return null
  }
  const fuzzy = (entries: typeof all) => {
    for (const [providerId, provider] of entries) {
      for (const key of Object.keys(provider.models ?? {})) {
        const id = String(provider.models?.[key]?.id ?? key).toLowerCase()
        if (key.toLowerCase().startsWith(lower) || id.includes(lower)) {
          return `${providerId}/${key}`
        }
      }
    }
    return null
  }

  return (
    exact(own) ?? fuzzy(own) ?? exact(others) ?? fuzzy(others) ?? session.modelRef
  )
}

// Tools that act on the harness itself: loading skills on demand, spawning
// subagents, loading deferred tool schemas, and tracking a todo list.

export const toolSearchTool: ToolDefinition = {
  name: 'ToolSearch',
  kind: 'meta',
  parallelSafe: true,
  description:
    'Load the schemas of deferred tools so they become callable. Use "select:A,B" to load exact ' +
    'tools by name, or keywords to search. Until loaded, a deferred tool cannot be invoked.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '"select:Name1,Name2" or search keywords' },
      max_results: { type: 'number' },
    },
    required: ['query'],
    additionalProperties: false,
  },
  summary: i => `load tools: ${i.query}`,
  async execute(input, ctx) {
    const loaded = ctx.session.registry.load(
      String(input.query),
      Number(input.max_results ?? 8),
    )
    if (loaded.length === 0) {
      const query = String(input.query)
      // A `select:` of something already loaded is not a failed search — the
      // tool is right there, callable. Reporting "No tools matched" sent the
      // model looking for a name it had just used successfully.
      if (query.startsWith('select:')) {
        const asked = query.slice('select:'.length).split(',').map(n => n.trim()).filter(Boolean)
        const known = asked.filter(name => ctx.session.registry.get(name))
        const unknown = asked.filter(name => !ctx.session.registry.get(name))
        if (unknown.length === 0) {
          return { text: `Already loaded and callable: ${known.join(', ')}` }
        }
        return {
          text:
            `No tool named ${unknown.join(', ')}.` +
            (known.length > 0 ? ` Already loaded: ${known.join(', ')}.` : '') +
            ` Still deferred: ${ctx.session.registry.deferredNames().join(', ') || 'none'}`,
          isError: true,
        }
      }
      const remaining = ctx.session.registry.deferredNames()
      return {
        text:
          'No tools matched. Still deferred: ' + (remaining.join(', ') || 'none'),
        isError: true,
      }
    }
    const lines = loaded.map(
      t => `${t.name}: ${t.description}\n  input: ${JSON.stringify(t.inputSchema)}`,
    )
    return { text: `Loaded ${loaded.length} tool(s):\n\n${lines.join('\n\n')}` }
  },
}

export const skillTool: ToolDefinition = {
  name: 'Skill',
  kind: 'meta',
  description:
    'Load a skill. Skills are packaged instructions for a kind of task; only their name and ' +
    'description are in context until you call this. Follow the returned instructions.',
  inputSchema: {
    type: 'object',
    properties: {
      skill: { type: 'string', description: 'Exact skill name from the roster' },
      args: { type: 'string' },
    },
    required: ['skill'],
    additionalProperties: false,
  },
  subject: i => String(i.skill ?? ''),
  summary: i => `skill ${i.skill}`,
  async execute(input, ctx) {
    const name = String(input.skill)
    const skill = ctx.session.assets.skills.find(s => s.name === name)
    if (!skill) {
      const known = ctx.session.assets.skills.map(s => s.name).join(', ')
      return { text: `Unknown skill "${name}". Available: ${known}`, isError: true }
    }
    const body = await readSkillBody(skill)
    const argLine = input.args ? `\n\nArguments: ${String(input.args)}` : ''
    return {
      text:
        `Skill "${skill.name}" loaded from ${skill.file}. Follow these instructions for this task.` +
        `${argLine}\n\n---\n\n${body}`,
      metadata: { dir: skill.dir },
    }
  },
}

export const agentTool: ToolDefinition = {
  name: 'Agent',
  kind: 'meta',
  // Not `parallelSafe` — a subagent writes, so it must not race a Read emitted
  // beside it. Its own group, so a fan-out of four runs as a fan-out instead of
  // a queue: four 30 s agents cost 30 s, not 120 s.
  parallelGroup: 'agent',
  description:
    'Launch a subagent with its own context and restricted tool set. Its final text is the return ' +
    'value — relay what matters. Use for broad searches or work you want isolated from this context.',
  inputSchema: {
    type: 'object',
    properties: {
      subagent_type: { type: 'string', description: 'Agent name from the roster' },
      prompt: { type: 'string', description: 'The task for the agent' },
      description: { type: 'string', description: 'Short 3-5 word label' },
      model: { type: 'string', description: 'Override model, as provider/model' },
      schema: {
        type: 'object',
        description:
          'JSON Schema. When present the agent must answer with matching JSON and this tool ' +
          'returns the parsed object instead of prose.',
      },
    },
    required: ['subagent_type', 'prompt'],
    additionalProperties: false,
  },
  subject: i => String(i.subagent_type ?? ''),
  summary: i => `agent ${i.subagent_type}: ${String(i.description ?? '').slice(0, 40)}`,
  async execute(input, ctx) {
    const maxDepth = ctx.session.config.subagentDepth ?? 1
    if (ctx.depth >= maxDepth) {
      return { text: `Subagent depth limit (${maxDepth}) reached.`, isError: true }
    }

    const name = String(input.subagent_type)
    const def = ctx.session.assets.agents.find(a => a.name === name)
    if (!def) {
      const known = ctx.session.assets.agents.map(a => a.name).join(', ')
      return { text: `Unknown agent "${name}". Available: ${known}`, isError: true }
    }

    const child = ctx.session.child({
      modelRef: resolveAgentModel(ctx.session, input.model ?? def.model),
      agentType: name,
    })
    await child.init()

    const { registerTools } = await import('./index.ts')
    registerTools(child, def.tools.length > 0 ? def.tools : undefined)

    // The call id, so the UI can tie the finished `Agent` line in the transcript
    // back to the agent whose session it should open.
    const runId = ctx.callId ?? `agent-${name}-${++agentRuns}`
    const label = String(input.description ?? '').trim() || name

    let collected = ''
    // The child's own tool calls never become blocks in the parent transcript:
    // they surface as live progress and, when the user opens the agent, as its
    // own view. Only the returned text becomes history.
    child.emit = event => {
      if (event.type === 'text') collected += event.text
      ctx.session.emit({ type: 'agent-event', id: runId, event })
    }
    child.requestPermission = ctx.session.requestPermission

    ctx.session.emit({ type: 'agent-start', id: runId, agentType: name, label })

    await ctx.session.hooks.run(
      'SubagentStart',
      {
        session_id: child.transcript.sessionId,
        transcript_path: child.transcript.file,
        cwd: child.cwd,
        permission_mode: child.mode,
        agent_type: name,
      },
      name,
    )

    const schema = asSchema(input.schema)
    const suffix = schema ? schemaInstruction(schema) : ''

    // Esc stops the turn that spawned this agent; without forwarding it, the
    // child keeps streaming and calling tools against a session the user already
    // walked away from. `child.abort` is created by `runTurn`, so the listener
    // reads it when it fires rather than capturing it now — which also covers
    // the repair turn below.
    const stopChild = (): void => child.abort?.abort()
    ctx.signal?.addEventListener('abort', stopChild)

    let ok = true
    try {
      await runTurn(child, `${def.prompt}\n\n---\n\n# Task\n\n${String(input.prompt)}${suffix}`)
    } catch (err) {
      ok = false
      collected = collected || describeError(err)
    }

    // The repair turn has to happen while `child.emit` is still wired and before
    // the session is parked, and it must read only the text produced *after* the
    // failed attempt: `collected` is append-only, and `parseStructured` takes the
    // first `{` it finds — so a naive retry would happily return the prose from
    // attempt one and call it a success.
    let structured: { value: unknown } | null = null
    let schemaError = ''
    if (schema && ok && !ctx.signal?.aborted) {
      const first = readStructured(collected)
      if (first.ok) {
        structured = { value: first.value }
      } else {
        const mark = collected.length
        try {
          await runTurn(child, repairInstruction(schema, first.error))
          const second = readStructured(collected.slice(mark))
          if (second.ok) structured = { value: second.value }
          else schemaError = second.error
        } catch (err) {
          schemaError = describeError(err)
        }
      }
      if (!structured) ok = false
    }

    ctx.signal?.removeEventListener('abort', stopChild)
    ctx.session.emit({ type: 'agent-end', id: runId, ok, chars: collected.length })

    await ctx.session.hooks.run(
      'SubagentStop',
      {
        session_id: child.transcript.sessionId,
        transcript_path: child.transcript.file,
        cwd: child.cwd,
        permission_mode: child.mode,
        agent_type: name,
      },
      name,
    )

    // Parked last: `park` clears `child.emit`, which the repair turn above still
    // needs. Doing it earlier makes the retry read an empty string and fail for a
    // reason that has nothing to do with the model.
    park(ctx.session, runId, { session: child, agentType: name, label })

    if (schema) {
      if (!structured) {
        return {
          text:
            `The agent did not answer with JSON matching the schema (${schemaError}). ` +
            `Its text was:\n\n${collected.trim().slice(0, 4000)}`,
          isError: true,
        }
      }
      const body = JSON.stringify(structured.value, null, 2)
      // Past the loop's output ceiling the result comes back with a
      // `[truncated N chars]` note appended, which turns valid JSON into invalid
      // JSON on the caller's side. Better to say so than to hand over a fragment.
      if (body.length > MAX_STRUCTURED_CHARS) {
        return {
          text:
            `The agent's JSON is ${body.length} chars, over the ${MAX_STRUCTURED_CHARS} limit — it ` +
            `would be truncated into invalid JSON. Ask for a narrower schema or fewer items.`,
          isError: true,
        }
      }
      // No `agent_id` line here: the contract with a schema is "the whole text is
      // the JSON", and a caller running `JSON.parse` on it must not have to strip
      // anything first.
      return { text: body }
    }

    const text = collected.trim() || '(subagent returned no text)'
    return {
      text: ok ? `${text}\n\n[agent_id: ${runId} — AgentResume continues this agent's context]` : text,
      isError: !ok,
    }
  },
}

/** `input.schema` as an object, or null when the model sent something else. */
function asSchema(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function readStructured(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseStructured(text) }
  } catch (err) {
    return { ok: false, error: describeError(err) }
  }
}

/**
 * Serialised JSON above this would be truncated by the loop, and truncated JSON
 * is worse than no JSON — it parses as an error on the caller's side instead of
 * as a missing result. Kept a little under `MAX_TOOL_OUTPUT_CHARS` so the note
 * this tool returns instead still fits.
 */
const MAX_STRUCTURED_CHARS = 28_000

export type ParkedAgent = {
  session: Session
  agentType: string
  label: string
  /** Set while a resume is running, so two of them cannot share one abort controller. */
  busy: boolean
  at: number
}

/**
 * Subagent sessions kept alive after they answered, so a follow-up question does
 * not pay for the exploration twice.
 *
 * This deliberately **inverts** the decision recorded next to the todo lists
 * below ("the value side holds no `Session` reference, so a finished subagent is
 * still collectable"). That rule still holds for todos; here the whole point is
 * to hold the session. The price is memory — a session that read a dozen files
 * is a few hundred KB of history — so the store is small, bounded, and keyed by
 * the **root** session, which the UI already outlives.
 */
const parkedState = new WeakMap<Session, Map<string, ParkedAgent>>()

/** Kept alive at once. A hard constant, like the other ceilings in the harness. */
const MAX_PARKED = 4

function park(session: Session, id: string, entry: Omit<ParkedAgent, 'busy' | 'at'>): void {
  const root = rootOf(session)
  const parked = parkedState.get(root) ?? new Map<string, ParkedAgent>()
  // Nothing else listens once the turn that spawned it is over, and the closure
  // captures the parent session — dropping it is what keeps the entry cheap.
  entry.session.emit = () => {}
  parked.set(id, { ...entry, busy: false, at: Date.now() })
  // Oldest out first; a Map iterates in insertion order, so the first key is it.
  while (parked.size > MAX_PARKED) {
    const oldest = parked.keys().next().value
    if (oldest === undefined) break
    parked.delete(oldest)
  }
  parkedState.set(root, parked)
}

export function parkedAgents(session: Session): (ParkedAgent & { id: string })[] {
  const parked = parkedState.get(rootOf(session))
  if (!parked) return []
  return [...parked].map(([id, entry]) => ({ id, ...entry }))
}

/** Called by `/clear`: the plan is gone, and so is the context these carry. */
export function clearParkedAgents(session: Session): void {
  parkedState.delete(rootOf(session))
}

export const agentResumeTool: ToolDefinition = {
  name: 'AgentResume',
  kind: 'meta',
  parallelGroup: 'agent',
  description:
    "Ask a follow-up of a subagent that already ran, keeping everything it read and concluded. " +
    'Use the id from that agent\'s result instead of launching a new agent for the same subject — ' +
    'a new one starts from nothing and repeats the exploration.',
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'The id from a previous Agent result' },
      prompt: { type: 'string', description: 'The follow-up question' },
      schema: {
        type: 'object',
        description: 'JSON Schema, same contract as Agent: the answer comes back parsed.',
      },
    },
    required: ['agent_id', 'prompt'],
    additionalProperties: false,
  },
  subject: i => String(i.agent_id ?? ''),
  summary: i => `resume ${String(i.agent_id ?? '').slice(0, 24)}`,
  async execute(input, ctx) {
    // Same ceiling as `Agent`: resuming runs a full turn in another session, so a
    // subagent doing it would drive a second context the depth limit never saw.
    const maxDepth = ctx.session.config.subagentDepth ?? 1
    if (ctx.depth >= maxDepth) {
      return { text: `Subagent depth limit (${maxDepth}) reached.`, isError: true }
    }

    const id = String(input.agent_id)
    const parked = parkedState.get(rootOf(ctx.session))
    const entry = parked?.get(id)
    if (!entry) {
      const known = [...(parked?.keys() ?? [])]
      return {
        text:
          `No agent kept under "${id}". ` +
          (known.length > 0
            ? `Still available: ${known.join(', ')}. Only the last ${MAX_PARKED} are kept.`
            : `None are kept right now — launch a new Agent instead.`),
        isError: true,
      }
    }
    if (entry.busy) {
      return { text: `Agent "${id}" is already answering something else.`, isError: true }
    }

    const child = entry.session
    const schema = asSchema(input.schema)
    let collected = ''
    entry.busy = true
    child.emit = event => {
      if (event.type === 'text') collected += event.text
      ctx.session.emit({ type: 'agent-event', id, event })
    }
    child.requestPermission = ctx.session.requestPermission

    // Same id as the original run, so the UI reuses the entry it already has and
    // the continued conversation is readable as one thing.
    ctx.session.emit({ type: 'agent-start', id, agentType: entry.agentType, label: entry.label })

    // Esc on the parent turn has to reach the agent it is waiting on.
    const stopChild = (): void => child.abort?.abort()
    ctx.signal?.addEventListener('abort', stopChild)

    let ok = true
    try {
      await runTurn(child, `${String(input.prompt)}${schema ? schemaInstruction(schema) : ''}`)
    } catch (err) {
      ok = false
      collected = collected || describeError(err)
    } finally {
      ctx.signal?.removeEventListener('abort', stopChild)
      entry.busy = false
      child.emit = () => {}
      ctx.session.emit({ type: 'agent-end', id, ok, chars: collected.length })
    }

    if (schema && ok) {
      const parsedResult = readStructured(collected)
      if (!parsedResult.ok) {
        return {
          text: `The agent did not answer with JSON (${parsedResult.error}). Its text was:\n\n${collected.trim().slice(0, 4000)}`,
          isError: true,
        }
      }
      const body = JSON.stringify(parsedResult.value, null, 2)
      if (body.length > MAX_STRUCTURED_CHARS) {
        return { text: `The agent's JSON is ${body.length} chars, over the ${MAX_STRUCTURED_CHARS} limit.`, isError: true }
      }
      return { text: body }
    }

    const text = collected.trim() || '(subagent returned no text)'
    return {
      text: ok ? `${text}\n\n[agent_id: ${id} — still resumable]` : text,
      isError: !ok,
    }
  },
}

export type Todo = { content: string; status: 'pending' | 'in_progress' | 'completed' }
/** Owner label, so a list written by a subagent says whose it is. */
export type TodoGroup = { owner: string; todos: Todo[] }

/**
 * Todo lists of a whole session tree, keyed by the **root** session.
 *
 * A subagent runs as a child `Session`, so a list written inside it used to land
 * on an object the UI never looks at: the tasks appeared in the transcript and
 * `ctrl+t` stayed empty. Rolling them up to the root fixes that.
 *
 * Grouped by owner rather than concatenated: two agents working at once have two
 * lists, and merging them would read as one plan with contradictory progress. The
 * value side holds no `Session` reference, so a finished subagent is still
 * collectable — the reason this is not a `Map<Session, …>`.
 */
const todoState = new WeakMap<Session, Map<string, Todo[]>>()

function rootOf(session: Session): Session {
  let root = session
  while (root.parent) root = root.parent
  return root
}

/** `main` for the session the user drives, otherwise the agent's own name. */
function ownerOf(session: Session): string {
  return session.parent ? (session.agentType ?? 'subagent') : 'main'
}

export const todoTool: ToolDefinition = {
  name: 'TodoWrite',
  kind: 'meta',
  description:
    'Replace the session todo list. Use for multi-step work: mark exactly one item in_progress, ' +
    'and complete items as you finish them.',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
    additionalProperties: false,
  },
  summary: () => 'update todos',
  async execute(input, ctx) {
    const todos = (input.todos ?? []) as Todo[]
    const root = rootOf(ctx.session)
    const groups = todoState.get(root) ?? new Map<string, Todo[]>()
    const owner = ownerOf(ctx.session)
    if (todos.length === 0) groups.delete(owner)
    else groups.set(owner, todos)
    todoState.set(root, groups)

    const marks = { pending: '[ ]', in_progress: '[~]', completed: '[x]' }
    const rendered = todos.map(t => `${marks[t.status] ?? '[ ]'} ${t.content}`).join('\n')
    ctx.session.emit({ type: 'notice', text: `todos:\n${rendered}` })
    return { text: rendered || '(empty list)' }
  },
}

/** Every list in the session tree, flattened — what the counter and modal show. */
export function getTodos(session: Session): Todo[] {
  return todoGroups(session).flatMap(g => g.todos)
}

/** The same lists, still separated by who wrote them. */
export function todoGroups(session: Session): TodoGroup[] {
  const groups = todoState.get(rootOf(session))
  if (!groups) return []
  return [...groups].map(([owner, todos]) => ({ owner, todos }))
}

/** Called by `/clear`: a new context should not keep the old plan. */
export function clearTodos(session: Session): void {
  todoState.delete(rootOf(session))
}

export const metaTools = [toolSearchTool, skillTool, agentTool, agentResumeTool, todoTool]
