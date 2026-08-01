import type { AssetBundle } from '../assets/index.ts'
import type { EffortLevel, PermissionMode } from '../config/types.ts'

// Two-part context, exactly as documented for Claude Code:
//   1. a stable system prompt (cacheable prefix)
//   2. `<system-reminder>` blocks injected into the user turn — instructions,
//      rosters, deferred tool names, hook output.
// Keeping rosters out of `system` is what lets the prefix stay byte-stable
// while assets are reloaded mid-session.

export type SystemPromptInput = {
  cwd: string
  isGitRepo: boolean
  model: string
  effort?: EffortLevel
  permissionMode: PermissionMode
  shell: string
  extra?: string
}

export function buildSystemPrompt(input: SystemPromptInput): string {
  return [
    'You are ByteCode (bytecode), a terminal coding agent operating in the user\'s working directory.',
    '',
    '# Harness',
    '- Your output is rendered as GitHub-flavored markdown in a terminal.',
    '- Tool calls pass through a permission engine; a denied call means the user declined it — adjust, do not retry the same call verbatim.',
    '- Hooks may intercept, rewrite, or block tool calls. Treat hook output as user-authored feedback.',
    '- Prefer the dedicated file tools (Read/Edit/Write/Glob/Grep) over shelling out when one fits.',
    '- Independent tool calls may be emitted together in one turn; they run in parallel.',
    '- Tools listed as deferred are advertised by name only. Call ToolSearch to load their schemas before using them.',
    '',
    '# Working agreement',
    '- Act when you have enough information. Do not re-derive facts already established, and do not narrate options you will not pursue.',
    '- Deliver the requested scope. Do not quietly narrow, widen, or transform it. State assumptions instead of inventing requirements.',
    '- Confirm before irreversible or outward-facing actions unless already authorised.',
    '- Report outcomes faithfully: if a command failed, say so and show the output.',
    '',
    '# Environment',
    `- Working directory: ${input.cwd}`,
    `- Git repository: ${input.isGitRepo ? 'yes' : 'no'}`,
    `- Platform: ${process.platform}`,
    `- Shell: ${input.shell}`,
    `- Model: ${input.model}`,
    ...(input.effort ? [`- Effort: ${input.effort}`] : []),
    // The permission mode is deliberately **not** here. It is the one line in
    // this prompt that changes mid-session — shift+tab toggles it — and the
    // system prompt is what the provider's cache breakpoint covers, so every
    // toggle threw away the whole cached prefix and the next call paid full
    // price for it. `modeReminder` carries it in the turn instead.
    ...(input.extra ? ['', input.extra] : []),
  ].join('\n')
}

export function reminder(body: string): string {
  return `<system-reminder>\n${body}\n</system-reminder>`
}

/**
 * The current permission mode, as a turn-level note.
 *
 * Sent when it changes rather than every turn: it belongs in the conversation,
 * where a new block costs nothing, instead of in the cached system prefix.
 */
export function modeReminder(mode: PermissionMode): string {
  return reminder(`Permission mode is now: ${mode}`)
}

export function instructionsBlock(assets: AssetBundle): string | null {
  if (assets.instructions.length === 0) return null
  const parts = assets.instructions.map(
    i => `Contents of ${i.file}:\n\n${i.content}`,
  )
  return reminder(
    [
      '# Project instructions',
      '',
      'These instructions come from the user and the repository. They override default behaviour and you must follow them.',
      '',
      ...parts,
    ].join('\n'),
  )
}

export function skillsBlock(assets: AssetBundle): string | null {
  if (assets.skills.length === 0) return null
  const lines = assets.skills.map(s => `- ${s.name}: ${s.description}`)
  return reminder(
    [
      'The following skills are available via the Skill tool. Only the name and description are loaded;',
      'calling Skill(name) loads the full instructions. Invoke a skill when the task matches its description,',
      'or when the user types /<name>.',
      '',
      ...lines,
    ].join('\n'),
  )
}

export function agentsBlock(assets: AssetBundle): string | null {
  if (assets.agents.length === 0) return null
  const lines = assets.agents.map(a => {
    const tools = a.tools.length > 0 ? ` (Tools: ${a.tools.join(', ')})` : ''
    return `- ${a.name}: ${a.description}${tools}`
  })
  return reminder(
    [
      'Available agent types for the Agent tool. Each runs in its own context with its own tool set;',
      'its final text is the return value. Launch independent agents in a single turn so they run concurrently.',
      '',
      ...lines,
    ].join('\n'),
  )
}

export function deferredToolsBlock(names: string[]): string | null {
  if (names.length === 0) return null
  return reminder(
    [
      'The following tools are deferred: their schemas are NOT loaded, so calling them directly fails.',
      'Use ToolSearch with query "select:<name>[,<name>...]" to load them first.',
      '',
      names.join(', '),
    ].join('\n'),
  )
}

export function mcpInstructionsBlock(
  instructions: { server: string; text: string }[],
): string | null {
  if (instructions.length === 0) return null
  return reminder(
    [
      '# MCP server instructions',
      '',
      'The following MCP servers provided usage instructions for their tools.',
      '',
      ...instructions.map(i => `## ${i.server}\n\n${i.text}`),
    ].join('\n'),
  )
}

export function environmentBlock(scratchpad: string): string {
  return reminder(
    [
      `# currentDate\n${new Date().toISOString().slice(0, 10)}`,
      `# scratchpad\nUse ${scratchpad} for temporary files instead of the system temp directory.`,
    ].join('\n\n'),
  )
}

/** Blocks prepended to the first user turn of a session. */
export function bootstrapBlocks(
  assets: AssetBundle,
  deferred: string[],
  scratchpad: string,
  mcpInstructions: { server: string; text: string }[] = [],
): string[] {
  return [
    instructionsBlock(assets),
    agentsBlock(assets),
    skillsBlock(assets),
    mcpInstructionsBlock(mcpInstructions),
    deferredToolsBlock(deferred),
    environmentBlock(scratchpad),
  ].filter((b): b is string => b !== null)
}
