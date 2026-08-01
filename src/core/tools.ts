import type { ToolKind } from './permissions.ts'
import type { Session } from './session.ts'

export type JSONSchema = {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
  additionalProperties?: boolean
}

export type ToolContext = {
  session: Session
  cwd: string
  signal?: AbortSignal
  /** Set when the call originates inside a subagent. */
  agentId?: string
  depth: number
  /** Id of the tool call being executed, so the UI can correlate side channels. */
  callId?: string
}

export type ToolOutput = {
  text: string
  isError?: boolean
  metadata?: Record<string, unknown>
}

export type ToolDefinition = {
  name: string
  description: string
  kind: ToolKind
  inputSchema: JSONSchema
  /** Value matched against permission rule patterns. */
  subject?: (input: Record<string, unknown>) => string | undefined
  /** Short line shown in the UI while the tool runs. */
  summary?: (input: Record<string, unknown>) => string
  execute: (input: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutput>
  /** Deferred tools are advertised by name only until ToolSearch loads them. */
  deferred?: boolean
  /** Safe to run concurrently with other parallel-safe tools. */
  parallelSafe?: boolean
  /**
   * Calls that may run concurrently **with each other**, but must not be folded
   * into the read-only batch.
   *
   * `parallelSafe` means "read-only, mixes with anything". A subagent is neither:
   * it writes, so it cannot race a Read the model emitted next to it, but four
   * of them are exactly the fan-out the user asked for. A named group keeps both
   * properties — same group runs together, a different one is a barrier.
   */
  parallelGroup?: string
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>()
  private loaded = new Set<string>()

  register(tool: ToolDefinition): void {
    this.tools.set(tool.name, tool)
    if (!tool.deferred) this.loaded.add(tool.name)
  }

  remove(name: string): void {
    this.tools.delete(name)
    this.loaded.delete(name)
  }

  /** Empties the registry, so switching primary agent can rebuild its tool set. */
  clear(): void {
    this.tools.clear()
    this.loaded.clear()
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  all(): ToolDefinition[] {
    return [...this.tools.values()]
  }

  /** Tools whose full schema is currently sent to the model. */
  active(): ToolDefinition[] {
    return this.all().filter(t => this.loaded.has(t.name))
  }

  /** Deferred tools not yet loaded — advertised as bare names. */
  deferredNames(): string[] {
    return this.all()
      .filter(t => t.deferred && !this.loaded.has(t.name))
      .map(t => t.name)
  }

  markDeferred(names: string[]): void {
    for (const name of names) {
      const tool = this.tools.get(name)
      if (!tool) continue
      tool.deferred = true
      this.loaded.delete(name)
    }
  }

  /** Loads deferred tools by name or keyword; returns the ones newly loaded. */
  load(query: string, max = 8): ToolDefinition[] {
    const out: ToolDefinition[] = []

    if (query.startsWith('select:')) {
      for (const name of query.slice('select:'.length).split(',')) {
        const tool = this.tools.get(name.trim())
        if (tool && !this.loaded.has(tool.name)) {
          this.loaded.add(tool.name)
          out.push(tool)
        }
      }
      return out
    }

    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map(t => t.replace(/^\+/, ''))
      .filter(Boolean)

    const scored = this.all()
      .filter(t => t.deferred && !this.loaded.has(t.name))
      .map(t => {
        const hay = `${t.name} ${t.description}`.toLowerCase()
        const score = terms.reduce((acc, term) => acc + (hay.includes(term) ? 1 : 0), 0)
        return { tool: t, score }
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, max)

    for (const { tool } of scored) {
      this.loaded.add(tool.name)
      out.push(tool)
    }
    return out
  }
}
