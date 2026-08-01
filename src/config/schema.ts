import { CLI } from '../util/paths.ts'

// JSON Schema for the config file, so an editor validates and completes it.
//
// Hand-written rather than generated: there is no build step here (Node strips
// the types at load time, so nothing ever reflects on them), and a generator
// that parses TypeScript would be a bigger, more fragile thing than the schema
// it produces.
//
// What keeps it honest is `test/schema.test.ts`: it reads `config/types.ts` and
// fails when a key exists there and not here. Adding a config option without
// declaring it is the only realistic drift, and that test catches exactly it.

const str = { type: 'string' } as const
const bool = { type: 'boolean' } as const
const num = { type: 'number' } as const
const strings = { type: 'array', items: str } as const

function obj(
  properties: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { type: 'object', properties, ...extra }
}

const modelLimit = obj({
  context: { ...num, description: 'Context window in tokens' },
  output: { ...num, description: 'Max output tokens' },
})

const modelCost = obj({
  input: { ...num, description: 'USD per 1M input tokens' },
  output: { ...num, description: 'USD per 1M output tokens' },
})

const modelConfig = obj({
  id: { ...str, description: 'Provider-side model id. Defaults to the map key.' },
  name: str,
  headers: obj({}, { additionalProperties: str }),
  limit: modelLimit,
  cost: modelCost,
  reasoning: bool,
  providerOptions: obj(
    {},
    {
      additionalProperties: obj({}, { additionalProperties: true }),
      description: 'Passed straight to the AI SDK, keyed by provider slug.',
    },
  ),
})

const providerConfig = obj(
  {
    npm: { ...str, description: 'npm package implementing the AI SDK provider factory' },
    name: str,
    env: { ...strings, description: 'Env var names checked for an API key, in order' },
    options: obj({}, { additionalProperties: true }),
    models: obj({}, { additionalProperties: modelConfig }),
  },
  { required: ['models'] },
)

const hookDefinition = obj(
  {
    type: { const: 'command' },
    command: str,
    args: strings,
    if: { ...str, description: 'Permission-rule filter, e.g. `Bash(git *)`' },
    timeout: { ...num, description: 'Seconds' },
    statusMessage: str,
    shell: { enum: ['bash', 'powershell'] },
  },
  { required: ['type', 'command'] },
)

const hookMatcherGroup = obj(
  {
    matcher: {
      ...str,
      description: '`*`/omitted = all; `A|B` = exact list; anything else = regex',
    },
    hooks: { type: 'array', items: hookDefinition },
  },
  { required: ['hooks'] },
)

const permissionsConfig = obj({
  allow: strings,
  ask: strings,
  deny: strings,
  defaultMode: { enum: ['default', 'plan', 'acceptEdits', 'dontAsk', 'bypassPermissions'] },
})

const assetsConfig = obj({
  skills: { ...strings, description: 'Directories holding `<name>/SKILL.md`' },
  agents: { ...strings, description: 'Directories holding `<name>.md` agent definitions' },
  commands: { ...strings, description: 'Directories holding `<name>.md` slash commands' },
})

const mcpServerConfig = obj({
  type: { enum: ['local', 'remote'] },
  command: { anyOf: [strings, str] },
  environment: obj({}, { additionalProperties: str }),
  inheritEnv: {
    ...bool,
    description: 'Forward this process environment to the server. Default true.',
  },
  cwd: str,
  url: { ...str, description: 'Remote: endpoint URL' },
  headers: obj({}, { additionalProperties: str }),
  enabled: bool,
  timeout: { ...num, description: 'Seconds for handshake and each tool call. Default 60.' },
  eager: { ...bool, description: 'Send tool schemas up front instead of deferring them' },
  allowedTools: strings,
  parallelSafe: {
    anyOf: [bool, strings],
    description:
      'Let this server tools run concurrently. Without it, only tools declaring readOnlyHint ' +
      'are batched — and that annotation is optional, so most servers set nothing.',
  },
})

const webConfig = obj({
  allowPrivateHosts: {
    ...strings,
    description: 'Hosts WebFetch may reach even though they resolve to a private address',
  },
  maxBytes: { ...num, description: 'Body bytes read before the fetch is cut off. Default 2 MiB.' },
})

const compactionConfig = obj({
  enabled: bool,
  threshold: { ...num, description: 'Fraction of the context window that triggers compaction' },
  keepRecentTurns: num,
  model: str,
  maxOutputTokens: num,
})

const workflowsConfig = obj({
  enabled: bool,
  maxConcurrency: { ...num, description: 'Subagents at once. Defaults to min(8, cores - 2).' },
  maxAgents: { ...num, description: 'Hard stop for runaway loops. Defaults to 1000.' },
  tokenBudget: { ...num, description: 'Output-token ceiling per run. A hard stop, not a hint.' },
})

const themeConfig = obj({
  preset: {
    ...str,
    description: '`terracotta` | `violet` | `azure` | `emerald` | `amber`, or use `tokens`',
  },
  tokens: obj({}, { additionalProperties: num, description: 'Explicit xterm-256 indices' }),
})

const uiConfig = obj({
  maxWidth: { ...num, description: '0 uses the full terminal width' },
})

/** The schema object, so the CLI and the tests read the same thing. */
export function configSchema(): Record<string, unknown> {
  return {
    $schema: 'https://json-schema.org/draft-07/schema#',
    $id: `https://bytecode.local/${CLI}.schema.json`,
    title: 'ByteCode configuration',
    type: 'object',
    additionalProperties: false,
    properties: {
      $schema: str,
      model: { ...str, description: '`provider/model`, e.g. `selbetti/opus`' },
      smallModel: { ...str, description: 'Cheap model for titles, classification, subagents' },
      provider: obj({}, { additionalProperties: providerConfig }),
      disabledProviders: strings,
      instructions: { ...strings, description: 'Files/globs injected as <system-reminder>' },
      assets: assetsConfig,
      permissions: permissionsConfig,
      hooks: obj({}, { additionalProperties: { type: 'array', items: hookMatcherGroup } }),
      mcp: obj({}, { additionalProperties: mcpServerConfig }),
      inheritMcp: {
        anyOf: [bool, { type: 'array', items: { enum: ['opencode', 'claude'] } }],
        description: 'Reuse MCP servers declared by opencode or Claude Code. Off by default.',
      },
      compaction: compactionConfig,
      cache: obj({
        enabled: bool,
        ttl: { enum: ['5m', '1h'] },
      }),
      workflows: workflowsConfig,
      theme: themeConfig,
      ui: uiConfig,
      deferredTools: { ...strings, description: 'Advertised by name only until ToolSearch loads them' },
      disabledTools: strings,
      effort: { enum: ['low', 'medium', 'high', 'xhigh', 'max'] },
      reasoning: {
        type: 'object',
        additionalProperties: false,
        properties: {
          inlineThinkTags: {
            ...bool,
            description:
              'Whether the provider streams reasoning as literal <think> tags inside the content. ' +
              'Guessed from the provider package when unset.',
          },
        },
      },
      maxOutputTokens: num,
      fileGuard: {
        ...bool,
        description:
          'Refuse a write that would clobber a file the session never read, or one that changed ' +
          'on disk since it did. On by default.',
      },
      maxSteps: {
        ...num,
        description: 'Model calls one turn may make. Default 64; at 75% the model is told to converge.',
      },
      web: webConfig,
      subagentDepth: { ...num, description: 'How deep Agent may nest. 0 disables subagents.' },
      subagentConcurrency: {
        ...num,
        description: 'Subagents of one step running at once. Defaults to min(8, cpus - 2).',
      },
      dataDir: str,
      openCodeAuth: {
        ...bool,
        description: "Read opencode's credential store as a fallback. Off by default.",
      },
    },
  }
}

export function configSchemaText(): string {
  return `${JSON.stringify(configSchema(), null, 2)}\n`
}
