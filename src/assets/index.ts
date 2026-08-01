import path from 'node:path'
import { homedir } from 'node:os'
import { promises as fs } from 'node:fs'
import type { AssetsConfig, Config, PermissionsConfig } from '../config/types.ts'
import { ancestorDirs, isDirectory, listDir, readTextIfExists, resolvePath } from '../util/fs.ts'
import { asList, asString, parseFrontMatter } from './frontmatter.ts'
import { PROJECT_DIRS } from '../util/paths.ts'

// Assets are read from `.claude/`, `.bytecode/` and the legacy `.hx/` trees by
// default so an existing Claude Code library (skills, agents, commands,
// CLAUDE.md) works here without being copied or converted.

const INSTRUCTIONS_FILE = 'BYTECODE.md'
const LEGACY_INSTRUCTIONS_FILE = 'HX.md'

/**
 * opencode's tool names mapped onto this harness's. `task` is the important one:
 * in opencode that is the subagent tool, so `task: deny` means "this agent may
 * not delegate" — which here is the `Agent` tool.
 */
const OPENCODE_TOOL_NAMES: Record<string, string[]> = {
  edit: ['Edit'],
  patch: ['Edit'],
  multiedit: ['Edit'],
  write: ['Write'],
  bash: ['Bash', 'PowerShell'],
  read: ['Read'],
  list: ['LS'],
  glob: ['Glob'],
  grep: ['Grep'],
  webfetch: ['WebFetch'],
  task: ['Agent'],
  todowrite: ['TodoWrite'],
  todoread: ['TodoWrite'],
  skill: ['Skill'],
}

export type Instruction = { file: string; content: string }

export type Skill = {
  name: string
  description: string
  file: string
  dir: string
  allowedTools: string[]
}

export type AgentDefinition = {
  name: string
  description: string
  tools: string[]
  model?: string
  prompt: string
  file: string
  /**
   * opencode's `mode`. `primary` agents are ones you *switch into* — they replace
   * the session's own behaviour, like opencode's build/plan. `subagent` (the
   * default) can only be delegated to through the Agent tool.
   */
  mode: 'primary' | 'subagent'
  /** opencode's per-agent `permission` block, overlaid on the session's rules. */
  permissions?: PermissionsConfig
}

export type SlashCommand = {
  name: string
  body: string
  file: string
  /** Frontmatter `description`, shown in the command list. */
  description?: string
  /** Frontmatter `argument-hint`, shown after the name while typing. */
  argumentHint?: string
  /** Frontmatter `model`: runs this command's turn on another model. */
  model?: string
  /** Frontmatter `allowed-tools`: restricts the turn to these tools. */
  allowedTools?: string[]
}

export type AssetBundle = {
  instructions: Instruction[]
  skills: Skill[]
  agents: AgentDefinition[]
  commands: SlashCommand[]
}

function defaultRoots(cwd: string): string[] {
  const home = homedir()
  // `.claude` first so an existing Claude Code setup is picked up unchanged, then
  // this project's own directories, then `.opencode` — an existing opencode setup
  // (agents, skills) works here without being copied or converted either.
  return [
    path.join(home, '.claude'),
    ...PROJECT_DIRS.map(dir => path.join(home, dir)),
    path.join(home, '.opencode'),
    path.join(home, '.config', 'opencode'),
    path.join(cwd, '.claude'),
    ...PROJECT_DIRS.map(dir => path.join(cwd, dir)),
    path.join(cwd, '.opencode'),
  ]
}

/**
 * opencode writes `agent/`, this machine's repo writes `agents/`, and Claude Code
 * writes `agents/`. Both spellings are searched so neither setup needs renaming.
 */
function assetDirAliases(kind: keyof AssetsConfig): string[] {
  return kind === 'agents' ? ['agents', 'agent'] : [kind]
}

function assetDirs(kind: keyof AssetsConfig, config: Config, cwd: string): string[] {
  const configured = config.assets?.[kind]
  if (configured && configured.length > 0) {
    return configured.map(p => resolvePath(p, cwd))
  }
  const aliases = assetDirAliases(kind)
  return defaultRoots(cwd).flatMap(root => aliases.map(name => path.join(root, name)))
}

/**
 * Files matching a glob pattern, sorted so the order is the same every run.
 *
 * Deliberately small: instruction patterns are things like `docs/*.md` or
 * `.bytecode/rules/**​/*.md`, not a query language. `**` crosses directories,
 * `*` and `?` stay inside one name.
 */
async function expandGlob(pattern: string): Promise<string[]> {
  const normalised = pattern.replace(/\\/g, '/')
  const firstWildcard = normalised.search(/[*?]/)
  const rootEnd = normalised.lastIndexOf('/', firstWildcard)
  const root = rootEnd <= 0 ? '/' : normalised.slice(0, rootEnd)
  const rest = normalised.slice(rootEnd + 1)

  const source = rest
    .split('/')
    .map(part =>
      part === '**'
        ? '.*'
        : part
            .replace(/[.+^${}()|[\]\\]/g, '\\$&')
            .replace(/\*/g, '[^/]*')
            .replace(/\?/g, '[^/]'),
    )
    .join('/')
    .replace(/\.\*\//g, '(?:.*/)?')
  const rx = new RegExp(`^${source}$`, process.platform === 'win32' ? 'i' : '')

  const out: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, depth + 1)
        continue
      }
      const relative = path.relative(root, full).replace(/\\/g, '/')
      if (rx.test(relative)) out.push(full)
    }
  }
  await walk(root, 0)
  return out.sort()
}

export async function loadInstructions(config: Config, cwd: string): Promise<Instruction[]> {
  const files: string[] = []

  if (config.instructions && config.instructions.length > 0) {
    // Globs are expanded, as the config schema advertises: an entry like
    // `docs/*.md` was resolved as a path with a literal `*` in it, which reads
    // as no file at all — so a documented form silently loaded nothing.
    for (const entry of config.instructions) {
      const resolved = resolvePath(entry, cwd)
      if (!/[*?]/.test(entry)) {
        files.push(resolved)
        continue
      }
      files.push(...(await expandGlob(resolved)))
    }
  } else {
    files.push(path.join(homedir(), '.claude', 'CLAUDE.md'))
    for (const dir of PROJECT_DIRS) files.push(path.join(homedir(), dir, INSTRUCTIONS_FILE))
    for (const dir of ancestorDirs(cwd)) {
      files.push(path.join(dir, 'CLAUDE.md'))
      files.push(path.join(dir, INSTRUCTIONS_FILE))
      files.push(path.join(dir, LEGACY_INSTRUCTIONS_FILE))
    }
  }

  const out: Instruction[] = []
  const seen = new Set<string>()
  for (const file of files) {
    if (seen.has(file)) continue
    seen.add(file)
    const content = await readTextIfExists(file)
    if (content && content.trim()) out.push({ file, content: content.trim() })
  }
  return out
}

export async function loadSkills(config: Config, cwd: string): Promise<Skill[]> {
  const out = new Map<string, Skill>()
  for (const dir of assetDirs('skills', config, cwd)) {
    if (!(await isDirectory(dir))) continue
    for (const entry of await listDir(dir)) {
      const skillDir = path.join(dir, entry)
      if (!(await isDirectory(skillDir))) continue
      const file = path.join(skillDir, 'SKILL.md')
      const raw = await readTextIfExists(file)
      if (!raw) continue
      const { data } = parseFrontMatter(raw)
      const name = asString(data.name) ?? entry
      out.set(name, {
        name,
        description: asString(data.description) ?? '',
        file,
        dir: skillDir,
        allowedTools: asList(data['allowed-tools']),
      })
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * opencode's nested `permission:` block, mapped onto this harness's rule lists:
 *
 *   permission:
 *     edit: allow
 *     bash:
 *       "git status*": allow
 *       "*": ask
 *
 * The nesting is two levels deep, which the flat front-matter parser does not
 * model — so it is read straight from the raw text. `edit`/`write` map to the
 * Edit and Write tools, `bash` to Bash and PowerShell, `webfetch` to WebFetch.
 */
function agentPermissions(raw: string): PermissionsConfig | undefined {
  const head = raw.match(/^(?:﻿)?---\r?\n([\s\S]*?)\r?\n---/)?.[1]
  if (!head) return undefined

  // Line-based on purpose. A regex with a `\s*$` lookahead ended the block at the
  // first line break — `edit: allow` was read and the nested `bash:` rules under
  // it were silently dropped.
  const headLines = head.split(/\r?\n/)
  const start = headLines.findIndex(l => /^permission\s*:\s*$/.test(l))
  if (start === -1) return undefined

  const blockLines: string[] = []
  for (let i = start + 1; i < headLines.length; i++) {
    const line = headLines[i]
    // A non-indented, non-empty line is the next front-matter key.
    if (line.trim() && !/^\s/.test(line)) break
    blockLines.push(line)
  }
  const block = blockLines.join('\n')
  if (!block.trim()) return undefined

  const buckets: PermissionsConfig = {}
  const push = (verdict: 'allow' | 'ask' | 'deny', rule: string) => {
    const list = (buckets[verdict] ??= [])
    if (!list.includes(rule)) list.push(rule)
  }
  const toolsFor = (kind: string): string[] => {
    const mapped = OPENCODE_TOOL_NAMES[kind.toLowerCase()]
    if (mapped) return mapped
    // Unknown name: title-case it and let the rule simply never match rather than
    // guess. `Foo(*)` against no tool called Foo is inert.
    return [kind[0].toUpperCase() + kind.slice(1)]
  }

  let currentKind: string | null = null
  for (const line of block.split(/\r?\n/)) {
    if (!line.trim()) continue
    const scalar = line.match(/^\s{2}([A-Za-z_]+)\s*:\s*(allow|ask|deny)\s*$/)
    if (scalar) {
      for (const tool of toolsFor(scalar[1])) push(scalar[2] as 'allow', `${tool}(*)`)
      currentKind = null
      continue
    }
    const parent = line.match(/^\s{2}([A-Za-z_]+)\s*:\s*$/)
    if (parent) {
      currentKind = parent[1]
      continue
    }
    // The quoted key may itself contain escaped quotes — opencode writes
    // `"powershell -Command \"Get-Date*\"": allow` — so a naive `"[^"]*"` stops
    // at the first inner quote and the rule is silently dropped.
    const nested = line.match(
      /^\s{4,}("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^:]+?)\s*:\s*(allow|ask|deny)\s*$/,
    )
    if (nested && currentKind) {
      const pattern = nested[1]
        .replace(/^["']|["']$/g, '')
        .replace(/\\(["'\\])/g, '$1')
        .trim()
      for (const tool of toolsFor(currentKind)) push(nested[2] as 'allow', `${tool}(${pattern})`)
    }
  }

  return Object.keys(buckets).length > 0 ? buckets : undefined
}

export async function loadAgents(config: Config, cwd: string): Promise<AgentDefinition[]> {
  const out = new Map<string, AgentDefinition>()
  for (const dir of assetDirs('agents', config, cwd)) {
    if (!(await isDirectory(dir))) continue
    for (const entry of await listDir(dir)) {
      if (!entry.endsWith('.md')) continue
      const file = path.join(dir, entry)
      const raw = await readTextIfExists(file)
      if (!raw) continue
      const { data, body } = parseFrontMatter(raw)
      const name = asString(data.name) ?? entry.replace(/\.md$/, '')
      out.set(name, {
        name,
        description: asString(data.description) ?? '',
        tools: asList(data.tools),
        model: asString(data.model),
        prompt: body.trim(),
        file,
        mode: asString(data.mode) === 'primary' ? 'primary' : 'subagent',
        permissions: agentPermissions(raw),
      })
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Command files, including the ones in subdirectories: Claude Code namespaces
 * `commands/git/pr.md` as `/git:pr`, and a library organised in folders would
 * otherwise load as nothing at all.
 */
async function commandFiles(dir: string, prefix = ''): Promise<{ name: string; file: string }[]> {
  const out: { name: string; file: string }[] = []
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry)
    if (entry.endsWith('.md')) {
      out.push({ name: `${prefix}${entry.replace(/\.md$/, '')}`, file: full })
    } else if (await isDirectory(full)) {
      out.push(...(await commandFiles(full, `${prefix}${entry}:`)))
    }
  }
  return out
}

export async function loadCommands(config: Config, cwd: string): Promise<SlashCommand[]> {
  const out = new Map<string, SlashCommand>()
  for (const dir of assetDirs('commands', config, cwd)) {
    if (!(await isDirectory(dir))) continue
    for (const { name, file } of await commandFiles(dir)) {
      const raw = await readTextIfExists(file)
      if (!raw) continue
      const { data, body } = parseFrontMatter(raw)
      const allowed = asList(data['allowed-tools'] ?? data.allowedTools)
      out.set(name, {
        name,
        body: body.trim() || raw.trim(),
        file,
        description: asString(data.description),
        argumentHint: asString(data['argument-hint']) ?? asString(data.argumentHint),
        model: asString(data.model),
        // An empty list means "no frontmatter", not "no tools" — restricting the
        // turn to nothing because a key was absent would break every command.
        allowedTools: allowed.length > 0 ? allowed : undefined,
      })
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/**
 * Fills a command body's placeholders: `$ARGUMENTS` is everything after the
 * name, `$1`…`$9` the whitespace-separated positionals. A positional with no
 * value becomes empty rather than staying as `$2` on screen — a literal
 * placeholder reaching the model reads as an instruction to invent one.
 */
export function expandCommandBody(body: string, args: string): string {
  const positional = args.split(/\s+/).filter(Boolean)
  // One pass, with the substitutions inserted through a function: run as two
  // `replace` calls with string replacements, an argument containing `$&` was
  // rewritten by the second pass, and `$ARGUMENTS` holding something like
  // `fix $1` had that `$1` expanded as if the user had written a placeholder.
  return body.replace(/\$ARGUMENTS|\$([1-9])/g, (_, digit?: string) =>
    digit === undefined ? args : (positional[Number(digit) - 1] ?? ''),
  )
}

export async function loadAssets(config: Config, cwd: string): Promise<AssetBundle> {
  const [instructions, skills, agents, commands] = await Promise.all([
    loadInstructions(config, cwd),
    loadSkills(config, cwd),
    loadAgents(config, cwd),
    loadCommands(config, cwd),
  ])
  return { instructions, skills, agents, commands }
}

/** Reads a skill body on demand — the progressive-disclosure half of skills. */
export async function readSkillBody(skill: Skill): Promise<string> {
  const raw = await fs.readFile(skill.file, 'utf8')
  const { body } = parseFrontMatter(raw)
  return body.trim()
}
