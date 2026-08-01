import type { Session } from './session.ts'
import {
  agentsBlock,
  buildSystemPrompt,
  deferredToolsBlock,
  environmentBlock,
  instructionsBlock,
  mcpInstructionsBlock,
  skillsBlock,
} from './context.ts'
import { contextLimit, contextTokens, estimateTokens, estimateTokensForChars } from './compaction.ts'

// What is actually in the context window, broken down. `/context` answers "how
// full is it"; this answers "full of what" — which is the question you have when
// the answer to the first one is uncomfortable.

export type ContextSlice = {
  label: string
  detail: string
  tokens: number
}

export type ContextReport = {
  slices: ContextSlice[]
  /** Provider-reported prompt size when there is one, estimate otherwise. */
  total: number
  limit?: number
  /** True when `total` came from the provider rather than an estimate. */
  measured: boolean
  skills: { name: string; description: string }[]
  agents: { name: string; mode: string; model?: string }[]
  mcp: {
    name: string
    connected: boolean
    tools: number
    instructions: number
    error?: string
    /** `own`, or the tool the server was inherited from. */
    source: string
    disabled: boolean
  }[]
  tools: { active: string[]; deferred: string[] }
  messages: { role: string; count: number; tokens: number }[]
}

function sliceOf(label: string, detail: string, text: string): ContextSlice {
  return { label, detail, tokens: estimateTokens(text) }
}

export function contextReport(session: Session): ContextReport {
  const system = buildSystemPrompt({
    cwd: session.cwd,
    isGitRepo: session.isGitRepo,
    model: session.modelRef,
    effort: session.config.effort,
    permissionMode: session.mode,
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
    extra: session.primaryAgent
      ? `# Active agent: ${session.primaryAgent.name}\n\n${session.primaryAgent.prompt}`
      : undefined,
  })

  const slices: ContextSlice[] = [
    sliceOf('system', 'prompt base do harness', system),
  ]

  if (session.primaryAgent) {
    slices.push(
      sliceOf('agente ativo', session.primaryAgent.name, session.primaryAgent.prompt),
    )
  }

  // Each block is asked for by name rather than walked positionally:
  // `bootstrapBlocks` drops the ones that are empty, so indexing into a fixed
  // label list mislabelled everything after the first missing block.
  const when = session.bootstrapped ? 'enviado' : 'no próximo turno'
  const named: [string, string | null][] = [
    ['instruções', instructionsBlock(session.assets)],
    ['roster de agents', agentsBlock(session.assets)],
    ['roster de skills', skillsBlock(session.assets)],
    ['instruções MCP', mcpInstructionsBlock(session.mcp.instructions())],
    ['tools deferred', deferredToolsBlock(session.registry.deferredNames())],
    ['ambiente', environmentBlock(session.scratchpad)],
  ]
  for (const [label, block] of named) {
    if (block) slices.push(sliceOf(label, when, block))
  }

  const byRole = new Map<string, { count: number; chars: number }>()
  for (const message of session.messages) {
    const entry = byRole.get(message.role) ?? { count: 0, chars: 0 }
    entry.count++
    entry.chars +=
      typeof message.content === 'string'
        ? message.content.length
        : JSON.stringify(message.content ?? '').length
    byRole.set(message.role, entry)
  }

  const messages = [...byRole.entries()].map(([role, v]) => ({
    role,
    count: v.count,
    tokens: Math.ceil(v.chars / 4),
  }))

  return {
    slices,
    total: contextTokens(session),
    limit: contextLimit(session),
    measured: session.tokenBaseline !== undefined,
    skills: session.assets.skills.map(s => ({ name: s.name, description: s.description })),
    agents: session.assets.agents.map(a => ({ name: a.name, mode: a.mode, model: a.model })),
    mcp: session.mcp.status().map(s => ({
      name: s.name,
      connected: s.connected,
      tools: s.toolCount,
      instructions: s.instructions?.length ?? 0,
      error: s.error,
      source: s.source ?? 'own',
      disabled: s.disabled === true,
    })),
    tools: {
      active: session.registry.active().map(t => t.name),
      deferred: session.registry.deferredNames(),
    },
    messages,
  }
}

function bar(fraction: number, width = 20): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`
}

/** Markdown for the TUI. Kept here so both UIs render the same report. */
export function formatContextReport(session: Session): string {
  const r = contextReport(session)
  const pct = r.limit ? r.total / r.limit : 0
  const setup = r.slices.reduce((sum, s) => sum + s.tokens, 0)

  const out: string[] = [
    '# context',
    '',
    `| | |`,
    `|---|---|`,
    `| modelo | \`${session.modelRef}\` |`,
    `| janela | ${r.limit ? `${r.limit.toLocaleString('pt-BR')} tokens` : 'não declarada'} |`,
    `| em uso | **${r.total.toLocaleString('pt-BR')}**${r.limit ? ` · ${Math.round(pct * 100)}% \`${bar(pct)}\`` : ''} |`,
    `| origem | ${r.measured ? 'reportado pelo provider' : 'estimado (nenhuma chamada ainda)'} |`,
    `| agente | ${session.primaryAgent?.name ?? 'build'} |`,
    '',
    `## setup — ${setup.toLocaleString('pt-BR')} tokens`,
    '',
    '| bloco | o que é | tokens |',
    '|---|---|---|',
    ...r.slices.map(s => `| ${s.label} | ${s.detail} | ${s.tokens.toLocaleString('pt-BR')} |`),
  ]

  if (r.messages.length > 0) {
    out.push(
      '',
      '## conversa',
      '',
      '| papel | mensagens | tokens |',
      '|---|---|---|',
      ...r.messages.map(m => `| ${m.role} | ${m.count} | ${m.tokens.toLocaleString('pt-BR')} |`),
    )
  }

  out.push(
    '',
    `## tools — ${r.tools.active.length} ativas, ${r.tools.deferred.length} deferred`,
    '',
    r.tools.active.length > 0 ? `**ativas** ${r.tools.active.map(t => `\`${t}\``).join(' ')}` : '_nenhuma ativa_',
  )
  if (r.tools.deferred.length > 0) {
    out.push(
      '',
      `**deferred** (só o nome no contexto, schema carrega via ToolSearch) ` +
        r.tools.deferred.map(t => `\`${t}\``).join(' '),
    )
  }

  const dialled = r.mcp.filter(s => !s.disabled)
  out.push('', `## mcp — ${dialled.filter(s => s.connected).length}/${dialled.length} conectados`, '')
  if (r.mcp.length === 0) {
    out.push('_nenhum servidor configurado_')
  } else {
    out.push('| servidor | origem | estado | tools | instruções |', '|---|---|---|---|---|')
    for (const s of r.mcp) {
      const state = s.disabled ? '○ desligado' : s.connected ? '● ok' : `✕ ${s.error ?? 'falhou'}`
      out.push(
        `| ${s.name} | ${s.source} | ${state} | ${s.tools} | ` +
          // From the count, not from a string built to be measured: allocating a
          // copy of the instructions just to divide its length by four.
          `${s.instructions > 0 ? `${estimateTokensForChars(s.instructions)} tokens` : '—'} |`,
      )
    }
  }

  const primary = r.agents.filter(a => a.mode === 'primary')
  out.push(
    '',
    `## assets — ${r.skills.length} skills, ${r.agents.length} agents, ${primary.length} primary`,
    '',
    primary.length > 0
      ? `**primary** (tab cicla) ${primary.map(a => `\`${a.name}\`${a.model ? ` → ${a.model}` : ''}`).join(' · ')}`
      : '_nenhum agente primary_',
  )
  if (r.skills.length > 0) {
    out.push('', '**skills carregadas**', '')
    for (const skill of r.skills) {
      out.push(`- \`${skill.name}\` ${skill.description.slice(0, 80)}`)
    }
    out.push(
      '',
      '_só nome e descrição estão no contexto; o corpo carrega quando a skill é chamada._',
    )
  }

  return out.join('\n')
}
