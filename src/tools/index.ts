import type { Session } from '../core/session.ts'
import { fsTools } from './fs.ts'
import { shellTools } from './shell.ts'
import { metaTools } from './meta.ts'
import { webTools } from './web.ts'
import { workflowTool } from './workflow.ts'

export const allTools = [...fsTools, ...shellTools, ...metaTools, ...webTools]

/**
 * A frase de orçamento que acompanha a tool Workflow.
 *
 * Um teto que mata (`maxAgents`) e um alvo que orienta são coisas diferentes:
 * quem só tem o primeiro escreve um workflow de trinta agentes e descobre o
 * problema quando ele morre no meio. `unrestricted` não manda frase nenhuma.
 */
export function sizeGuidelineText(
  size: 'small' | 'medium' | 'large' | 'unrestricted' = 'medium',
): string | null {
  const alvo = { small: 5, medium: 15, large: 50 }[size as 'small' | 'medium' | 'large']
  if (!alvo) return null
  return (
    `This session's workflow size guideline is **${size}**: aim for fewer than ${alvo} agents ` +
    `in a run. It is a guideline, not a hard limit — follow it unless the user's prompt calls ` +
    `for a different scale.`
  )
}

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
    // A diretriz de tamanho vai na descrição da tool porque é lá que o modelo
    // lê antes de escrever o script. `maxAgents` mata quem passa do teto; isto
    // é o que faz não chegar perto dele.
    const guideline = sizeGuidelineText(session.config.workflows.sizeGuideline)
    session.registry.register({
      ...workflowTool,
      description: guideline ? `${workflowTool.description}\n\n${guideline}` : workflowTool.description,
    })
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
