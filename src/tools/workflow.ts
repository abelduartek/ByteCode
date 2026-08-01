import path from 'node:path'
import type { ToolDefinition } from '../core/tools.ts'
import { extractMeta, resolveWorkflowScript, runWorkflow } from '../core/workflow.ts'

// Registered only when workflows are enabled, so the model cannot reach for
// multi-agent orchestration unless the user turned it on.

const DESCRIPTION = `Run a deterministic multi-agent workflow: a JavaScript script decides the control flow (fan-out, pipelines, loops) and each step runs as a subagent with its own context.

Use it for work that is worth decomposing — reviewing many files along different dimensions, migrating a list of call sites, researching a question from several angles — not for a single question you can answer directly.

The script must start with a pure object literal:

  export const meta = { name: 'review', description: 'Review the diff', phases: [{ title: 'Find' }] }

Available inside the script (top-level await and return both work):
  agent(prompt, opts?)      -> run one subagent, returns its final text
                               opts: { label, phase, model, agentType, schema }
                               with "schema" (JSON Schema) the step must answer
                               JSON and the parsed object is returned
  parallel(thunks)          -> run thunks concurrently, failures become null
  pipeline(items, ...stages)-> push each item through the stages independently,
                               no barrier between stages
  workflow(name|{scriptPath}, args?) -> run a saved workflow as a step and return
                               its result; shares this run's concurrency cap,
                               agent counter, journal and budget. One level only
  phase(title)              -> label the following steps
  log(message)              -> progress line for the user
  budget                    -> { total, spent(), remaining() } in output tokens.
                               "total" is null when no ceiling was set and
                               remaining() is Infinity — guard loops on it
  args                      -> the value passed in "args"

Prefer pipeline() over parallel() unless a stage genuinely needs every previous result at once.`

export const workflowTool: ToolDefinition = {
  name: 'Workflow',
  kind: 'exec',
  description: DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', description: 'The workflow script, inline' },
      scriptPath: { type: 'string', description: 'Path to a script file, instead of `script`' },
      name: { type: 'string', description: 'Name of a saved workflow, instead of `script`' },
      args: { description: 'Value exposed to the script as `args`' },
      budget: { type: 'number', description: 'Output-token ceiling for this run' },
      resumeFromRunId: { type: 'string', description: 'Replay the unchanged prefix of a previous run' },
    },
    additionalProperties: false,
  },
  subject: input => String(input.name ?? input.scriptPath ?? 'inline script'),
  summary: input => {
    const source = input.script ?? ''
    try {
      return `workflow ${extractMeta(String(source)).name}`
    } catch {
      return `workflow ${String(input.name ?? input.scriptPath ?? '')}`
    }
  },
  async execute(input, ctx) {
    let script = typeof input.script === 'string' ? input.script : undefined
    if (!script && (input.scriptPath || input.name)) {
      try {
        script = (await resolveWorkflowScript(input.scriptPath ?? input.name, ctx.cwd)).script
      } catch (err) {
        return { text: err instanceof Error ? err.message : String(err), isError: true }
      }
    }
    if (!script) return { text: 'provide `script`, `scriptPath` or `name`', isError: true }

    try {
      const run = await runWorkflow(ctx.session, {
        script,
        args: input.args,
        budget: typeof input.budget === 'number' ? input.budget : undefined,
        resumeFromRunId: input.resumeFromRunId ? String(input.resumeFromRunId) : undefined,
        // Esc has to stop the fan-out, not just the call waiting on it.
        signal: ctx.signal,
        // Workflow agents use the same live strip as the Agent tool, so a
        // fan-out of twenty steps does not write forty lines into the transcript.
        onProgress: event => {
          if (event.type === 'phase') {
            ctx.session.emit({ type: 'notice', text: `workflow · ${event.title}` })
          } else if (event.type === 'log') {
            ctx.session.emit({ type: 'notice', text: `workflow · ${event.message}` })
          } else if (event.type === 'agent-start') {
            ctx.session.emit({
              type: 'agent-start',
              id: `wf-${event.id}`,
              agentType: event.phase ?? 'workflow',
              label: event.label,
            })
          } else {
            ctx.session.emit({
              type: 'agent-end',
              id: `wf-${event.id}`,
              ok: event.ok,
              chars: event.chars,
            })
          }
        },
      })

      const body =
        typeof run.result === 'string' ? run.result : JSON.stringify(run.result, null, 2)

      return {
        text:
          `Workflow "${run.meta.name}" finished — ${run.agents} agent(s), ` +
          `${run.tokens} output tokens, runId ${run.runId}\n` +
          (run.errors.length > 0 ? `Errors:\n${run.errors.map(e => `- ${e}`).join('\n')}\n` : '') +
          `Script: ${run.scriptPath}\nJournal: ${path.basename(run.journalPath)}\n\nResult:\n${body}`,
        metadata: { runId: run.runId, agents: run.agents, tokens: run.tokens },
      }
    } catch (err) {
      return { text: err instanceof Error ? err.message : String(err), isError: true }
    }
  },
}
