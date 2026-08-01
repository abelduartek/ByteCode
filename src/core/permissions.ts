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
  const m = raw.match(/^([A-Za-z0-9_]+)\((.*)\)$/)
  if (!m) return { raw, tool: raw.trim() }
  return { raw, tool: m[1], pattern: m[2] }
}

/**
 * `*` matches within a path segment, `**` crosses separators, and a trailing
 * `:*` means "this prefix followed by anything" (the `Bash(git log:*)` idiom).
 * Command subjects are not path-segmented, so `*` crosses everything there.
 */
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
  return new RegExp(`^${src}$`, 'i')
}

export function ruleMatches(raw: string, query: PermissionQuery): boolean {
  const rule = parseRule(raw)
  if (rule.tool !== query.tool && rule.tool !== '*') return false
  if (rule.pattern === undefined || rule.pattern === '' || rule.pattern === '*') return true
  const subject = query.subject ?? ''
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
