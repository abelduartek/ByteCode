import type { Session } from '../core/session.ts'
import { fsTools } from './fs.ts'
import { shellTools } from './shell.ts'
import { metaTools } from './meta.ts'
import { webTools } from './web.ts'
import { workflowTool } from './workflow.ts'

export const allTools = [...fsTools, ...shellTools, ...metaTools, ...webTools]

/**
 * Populates a session's registry. `only` restricts to a named subset — this is
 * how a subagent's `tools:` front-matter line is enforced.
 */
export function registerTools(session: Session, only?: string[]): void {
  const allow = only ? new Set(only) : null
  for (const tool of allTools) {
    if (allow && !allow.has(tool.name)) continue
    session.registry.register({ ...tool })
  }
  // Declarative, not additive: called again with a narrower list — a slash
  // command's `allowed-tools` for one turn — the tools left out have to *leave*
  // the registry. Registering only the allowed ones left the rest in place, so
  // the restriction silently did nothing on an already-populated session.
  if (allow) {
    for (const tool of allTools) {
      if (!allow.has(tool.name) && tool.name !== 'ToolSearch') session.registry.remove(tool.name)
    }
  }
  // ToolSearch stays available so a restricted agent can still load deferred tools.
  if (allow && !allow.has('ToolSearch')) {
    const search = allTools.find(t => t.name === 'ToolSearch')
    if (search) session.registry.register({ ...search })
  }

  // Opt-in only: a workflow can spawn many subagents, so the model should not
  // even see the tool unless the user enabled it. Subagents never get it.
  if (session.config.workflows?.enabled && session.depth === 0 && (!allow || allow.has('Workflow'))) {
    session.registry.register({ ...workflowTool })
  } else {
    session.registry.remove('Workflow')
  }

  // MCP tools land in the same registry as native ones, so permissions, hooks
  // and deferral apply to them unchanged.
  session.mcp.registerInto(session.registry)
  if (allow) {
    for (const tool of session.registry.all()) {
      if (tool.name.startsWith('mcp__') && !allow.has(tool.name)) {
        session.registry.remove(tool.name)
      }
    }
  }
  for (const name of session.config.disabledTools ?? []) session.registry.remove(name)
  if (session.config.deferredTools?.length) {
    session.registry.markDeferred(session.config.deferredTools)
  }
}

export { fsTools, shellTools, metaTools, webTools, workflowTool }
