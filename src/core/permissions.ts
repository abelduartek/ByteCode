import type { PermissionMode, PermissionsConfig } from '../config/types.ts'

// Rule syntax is Claude Code's: `Tool(pattern)`, or bare `Tool` for every call.
// Precedence is deny > ask > allow; the mode is applied on top of the verdict.

export type PermissionDecision = 'allow' | 'ask' | 'deny'

export type PermissionVerdict = {
  decision: PermissionDecision
  /** The rule that produced the verdict, for display. */
  rule?: string
  reason?: string
}

/**
 * `net` is its own kind rather than folded into the others: `exec` would make a
 * documentation lookup impossible in plan mode, and `read` would let the harness
 * egress to the network with no prompt at all.
 */
export type ToolKind = 'read' | 'write' | 'exec' | 'meta' | 'net'

export type PermissionQuery = {
  tool: string
  kind: ToolKind
  /** Command line for exec tools, path for file tools, else undefined. */
  subject?: string
}

type ParsedRule = {
  raw: string
  tool: string
  pattern?: string
}

export function parseRule(raw: string): ParsedRule {
  // Hyphens and dots belong in a tool name: an MCP server contributes tools like
  // `mcp__claude-in-chrome__navigate`, and a rule naming one used to fail this
  // match and be read as a bare tool name with a `(...)` glued to it — a rule
  // that matches nothing, silently, which for a `deny` means it fails open.
  const m = raw.match(/^([A-Za-z0-9_*][A-Za-z0-9_.*-]*)\(([\s\S]*)\)$/)
  if (!m) return { raw, tool: raw.trim() }
  return { raw, tool: m[1], pattern: m[2] }
}

/** `domain:example.com`, the syntax Claude Code's WebFetch rules are written in. */
const DOMAIN_PREFIX = 'domain:'

function hostOf(subject: string): string | null {
  try {
    return new URL(subject).hostname.toLowerCase()
  } catch {
    // Bare host, or a subject that is not a URL at all.
    const trimmed = subject.trim().toLowerCase()
    return /^[a-z0-9.-]+$/.test(trimmed) ? trimmed : null
  }
}

/**
 * A host against a `domain:` pattern. Subdomains count: a rule about
 * `example.com` that let `anything.example.com` through would be a deny rule
 * with a one-label bypass.
 */
function domainMatches(pattern: string, subject: string): boolean {
  const host = hostOf(subject)
  if (!host) return false
  const want = pattern.replace(/^\*\./, '').trim().toLowerCase()
  if (!want) return false
  return host === want || host.endsWith(`.${want}`)
}

/**
 * `*` matches within a path segment, `**` crosses separators, and a trailing
 * `:*` means "this prefix followed by anything" (the `Bash(git log:*)` idiom).
 * Command subjects are not path-segmented, so `*` crosses everything there.
 */
/**
 * Whether a path pattern should ignore case.
 *
 * On Linux `src/Secrets.ts` and `src/secrets.ts` are two different files, so a
 * case-insensitive rule matches paths it was never written for — and a rule that
 * matches more than intended is an `allow` that grants more than intended.
 * Windows and the default macOS filesystem do fold case, so there a rule that
 * did not would miss the very file it names.
 */
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin'

export function patternToRegExp(pattern: string, segmented: boolean): RegExp {
  let src = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        src += '.*'
        i++
        if (pattern[i + 1] === '/' || pattern[i + 1] === '\\') i++
      } else {
        src += segmented ? '[^/\\\\]*' : '.*'
      }
      continue
    }
    if (c === ':' && pattern[i + 1] === '*' && i + 2 === pattern.length) {
      src += '(?:\\s.*)?'
      i++
      continue
    }
    if (c === '/' || c === '\\') {
      src += '[/\\\\]'
      continue
    }
    src += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  }
  // A command line is not a path: `Bash(GIT push:*)` matching `git push` is the
  // expected reading, and shells on every platform are matched the same way.
  return new RegExp(`^${src}$`, !segmented || CASE_INSENSITIVE_PATHS ? 'i' : '')
}

export function ruleMatches(raw: string, query: PermissionQuery): boolean {
  const rule = parseRule(raw)
  if (rule.tool !== query.tool && rule.tool !== '*') return false
  if (rule.pattern === undefined || rule.pattern === '' || rule.pattern === '*') return true
  const subject = query.subject ?? ''
  if (rule.pattern.startsWith(DOMAIN_PREFIX)) {
    return domainMatches(rule.pattern.slice(DOMAIN_PREFIX.length), subject)
  }
  const segmented = query.kind !== 'exec'
  return patternToRegExp(rule.pattern, segmented).test(subject)
}

const DEFAULT_BY_KIND: Record<ToolKind, PermissionDecision> = {
  read: 'allow',
  meta: 'allow',
  write: 'ask',
  exec: 'ask',
  net: 'ask',
}

export function evaluate(
  permissions: PermissionsConfig | undefined,
  mode: PermissionMode,
  query: PermissionQuery,
): PermissionVerdict {
  for (const raw of permissions?.deny ?? []) {
    if (ruleMatches(raw, query)) {
      return { decision: 'deny', rule: raw, reason: 'matched a deny rule' }
    }
  }

  // `net` is allowed while planning: a GET has no local side effect, and reading
  // the docs is most of what planning is.
  if (mode === 'plan' && query.kind !== 'read' && query.kind !== 'meta' && query.kind !== 'net') {
    return { decision: 'deny', reason: 'plan mode: no side effects' }
  }

  let decision: PermissionDecision | undefined
  let rule: string | undefined

  for (const raw of permissions?.ask ?? []) {
    if (ruleMatches(raw, query)) {
      decision = 'ask'
      rule = raw
      break
    }
  }
  if (!decision) {
    for (const raw of permissions?.allow ?? []) {
      if (ruleMatches(raw, query)) {
        decision = 'allow'
        rule = raw
        break
      }
    }
  }
  if (!decision) decision = DEFAULT_BY_KIND[query.kind]

  if (decision === 'ask') {
    if (mode === 'bypassPermissions') return { decision: 'allow', rule, reason: 'bypass mode' }
    if (mode === 'dontAsk') return { decision: 'deny', rule, reason: 'dontAsk mode' }
    if (mode === 'acceptEdits' && query.kind === 'write') {
      return { decision: 'allow', rule, reason: 'acceptEdits mode' }
    }
  }

  return { decision, rule }
}

export const PERMISSION_MODES: PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'dontAsk',
  'bypassPermissions',
]

export function nextMode(mode: PermissionMode): PermissionMode {
  const i = PERMISSION_MODES.indexOf(mode)
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]
}
