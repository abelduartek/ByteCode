import { spawn } from 'node:child_process'
import type { HookDefinition, HookMatcherGroup } from '../config/types.ts'
import { killTree } from './jobs.ts'
import { ruleMatches, parseRule } from './permissions.ts'
import type { ToolKind } from './permissions.ts'

// Wire contract is Claude Code's, so existing hook scripts run unchanged:
// JSON on stdin, exit 0 = ok (stdout parsed as a control object, or treated as
// injected context for the prompt-ish events), exit 2 = blocking error with
// stderr fed back to the model, anything else = non-blocking error.

export type HookEvent =
  | 'SessionStart'
  | 'SessionEnd'
  | 'UserPromptSubmit'
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'PostToolBatch'
  // Permission lifecycle. `PermissionRequest` fires *before* the user is asked
  // and can answer for them with `permissionDecision`; `PermissionDenied` fires
  // after a refusal, whichever side refused, so an audit script sees both.
  | 'PermissionRequest'
  | 'PermissionDenied'
  /** Fired when the turn is about to block waiting on the user. */
  | 'Notification'
  | 'Stop'
  | 'SubagentStart'
  | 'SubagentStop'
  | 'PreCompact'
  | 'PostCompact'

/** Events whose plain stdout is injected as context rather than logged. */
const STDOUT_IS_CONTEXT = new Set<HookEvent>([
  'SessionStart',
  'UserPromptSubmit',
])

export type HookSpecificOutput = {
  hookEventName?: string
  additionalContext?: string
  permissionDecision?: 'allow' | 'deny' | 'ask'
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  updatedToolOutput?: string
}

export type HookControl = {
  continue?: boolean
  stopReason?: string
  suppressOutput?: boolean
  systemMessage?: string
  decision?: 'block'
  reason?: string
  hookSpecificOutput?: HookSpecificOutput
}

export type HookResult = {
  hook: HookDefinition
  exitCode: number
  stdout: string
  stderr: string
  control?: HookControl
  /** Context to inject, from `additionalContext` or plain stdout. */
  context?: string
  blocked: boolean
}

export type HookInput = {
  session_id: string
  prompt_id?: string
  transcript_path: string
  cwd: string
  permission_mode: string
  effort?: { level: string }
  hook_event_name: HookEvent
  agent_id?: string
  agent_type?: string
  [key: string]: unknown
}

const MAX_CONTEXT_CHARS = 10_000

function matcherMatches(matcher: string | undefined, value: string | undefined): boolean {
  if (!matcher || matcher === '*' || matcher === '') return true
  if (value === undefined) return false
  if (/^[a-zA-Z0-9_\-, |]+$/.test(matcher)) {
    return matcher
      .split(/[|,]/)
      .map(s => s.trim())
      .filter(Boolean)
      .includes(value)
  }
  try {
    return new RegExp(matcher).test(value)
  } catch {
    return false
  }
}

function ifMatches(rule: string | undefined, input: HookInput): boolean {
  if (!rule) return true
  const tool = typeof input.tool_name === 'string' ? input.tool_name : undefined
  if (!tool) return false
  const toolInput = (input.tool_input ?? {}) as Record<string, unknown>
  const subject =
    (typeof toolInput.command === 'string' && toolInput.command) ||
    (typeof toolInput.file_path === 'string' && toolInput.file_path) ||
    (typeof toolInput.path === 'string' && toolInput.path) ||
    (typeof toolInput.url === 'string' && toolInput.url) ||
    undefined
  // The kind decides whether `*` may cross a separator, so it has to agree with
  // what the permission engine would use for the same tool — a hook that matches
  // more (or less) than the rule engine is worse than no hook. `net` is
  // segmented, like paths: `WebFetch(https://x/**)` crosses `/`, `.../*` does not.
  const ruleTool = parseRule(rule).tool
  const kind: ToolKind = ruleTool.match(/Bash|PowerShell|Shell/)
    ? 'exec'
    : ruleTool.startsWith('Web')
      ? 'net'
      : 'write'
  return ruleMatches(rule, { tool, kind, subject })
}

export class HookRunner {
  private groups: Record<string, HookMatcherGroup[]>
  private cwd: string

  constructor(groups: Record<string, HookMatcherGroup[]> | undefined, cwd: string) {
    this.groups = groups ?? {}
    this.cwd = cwd
  }

  has(event: HookEvent): boolean {
    return (this.groups[event]?.length ?? 0) > 0
  }

  async run(
    event: HookEvent,
    input: Omit<HookInput, 'hook_event_name'>,
    matcherValue?: string,
  ): Promise<HookResult[]> {
    const groups = this.groups[event] ?? []
    if (groups.length === 0) return []

    const payload = { ...input, hook_event_name: event } as HookInput
    const results: HookResult[] = []

    // Concurrently: hooks are independent by construction — `summarize` reduces
    // whatever they return, and the strictest permission decision wins whatever
    // order they finish in. Run one at a time, three hooks on `PreToolUse` paid
    // three process spawns in series before every single tool call.
    const pending: Promise<HookResult>[] = []
    for (const group of groups) {
      if (!matcherMatches(group.matcher, matcherValue)) continue
      for (const hook of group.hooks ?? []) {
        if (!ifMatches(hook.if, payload)) continue
        pending.push(this.execute(event, hook, payload))
      }
    }
    results.push(...(await Promise.all(pending)))
    return results
  }

  private execute(
    event: HookEvent,
    hook: HookDefinition,
    payload: HookInput,
  ): Promise<HookResult> {
    return new Promise(resolve => {
      const timeoutMs = (hook.timeout ?? (event === 'UserPromptSubmit' ? 30 : 600)) * 1000
      // Both spellings: a hook written for the old name keeps resolving.
      const command = hook.command.replace(
        /\$\{(?:BYTECODE|HX|CLAUDE)_PROJECT_DIR\}/g,
        this.cwd,
      )

      // Three forms:
      //   args present        -> exec directly, no shell
      //   shell: 'powershell' -> powershell.exe -Command (it has no -c flag)
      //   otherwise           -> the platform default shell (cmd.exe on Windows),
      //                          which parses `"C:\path\node.exe" "script.js"`
      //                          the way ported Claude Code hooks expect.
      const child = hook.args
        ? spawn(command, hook.args, { cwd: this.cwd, windowsHide: true })
        : hook.shell === 'powershell'
          ? spawn(
              'powershell.exe',
              ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command],
              { cwd: this.cwd, windowsHide: true },
            )
          : spawn(command, {
              cwd: this.cwd,
              shell: hook.shell === 'bash' ? 'bash' : true,
              windowsHide: true,
            })

      let stdout = ''
      let stderr = ''
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        // The tree, not just the shell: a hook that runs `npm test` through
        // cmd.exe left the whole suite running after the timeout said it had
        // been stopped.
        killTree(child, 'SIGKILL')
        resolve({
          hook,
          exitCode: -1,
          stdout,
          stderr: `hook timed out after ${timeoutMs / 1000}s`,
          blocked: false,
        })
      }, timeoutMs)

      child.stdout?.on('data', d => (stdout += String(d)))
      child.stderr?.on('data', d => (stderr += String(d)))
      child.on('error', err => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ hook, exitCode: -1, stdout, stderr: err.message, blocked: false })
      })
      child.on('close', code => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(interpret(event, hook, code ?? 0, stdout, stderr))
      })

      // A hook that never reads stdin makes the write fail with EPIPE, which is
      // normal and not the hook's problem — but as an unhandled stream error it
      // became a process-level error and an exit code of 1 for a hook that had
      // done its job. The `try` alone did not catch it: the write is async.
      child.stdin?.on('error', () => {})
      try {
        child.stdin?.write(JSON.stringify(payload))
        child.stdin?.end()
      } catch {
        /* hook may not read stdin */
      }
    })
  }
}

function interpret(
  event: HookEvent,
  hook: HookDefinition,
  exitCode: number,
  stdout: string,
  stderr: string,
): HookResult {
  if (exitCode === 2) {
    return { hook, exitCode, stdout, stderr, blocked: true }
  }
  if (exitCode !== 0) {
    return { hook, exitCode, stdout, stderr, blocked: false }
  }

  const trimmed = stdout.trim()
  let control: HookControl | undefined
  if (trimmed.startsWith('{')) {
    try {
      control = JSON.parse(trimmed) as HookControl
    } catch {
      control = undefined
    }
  }

  let context = control?.hookSpecificOutput?.additionalContext
  if (!context && !control && STDOUT_IS_CONTEXT.has(event) && trimmed) {
    context = trimmed
  }
  if (context && context.length > MAX_CONTEXT_CHARS) {
    context = context.slice(0, MAX_CONTEXT_CHARS)
  }

  return {
    hook,
    exitCode,
    stdout,
    stderr,
    control,
    context,
    blocked: control?.decision === 'block',
  }
}

/** Collapses hook results into the fields the loop acts on. */
export function summarize(results: HookResult[]): {
  contexts: string[]
  blocked: boolean
  blockReasons: string[]
  stop: boolean
  stopReason?: string
  systemMessages: string[]
  permission?: 'allow' | 'deny' | 'ask'
  permissionReason?: string
  updatedInput?: Record<string, unknown>
  updatedToolOutput?: string
} {
  /** deny > ask > allow, the same order the rules in the config are read in. */
  const RANK = { deny: 3, ask: 2, allow: 1 } as const
  const outranks = (
    next: 'allow' | 'deny' | 'ask',
    current: 'allow' | 'deny' | 'ask' | undefined,
  ): boolean => current === undefined || RANK[next] > RANK[current]

  const contexts: string[] = []
  const blockReasons: string[] = []
  const systemMessages: string[] = []
  let blocked = false
  let stop = false
  let stopReason: string | undefined
  let permission: 'allow' | 'deny' | 'ask' | undefined
  let permissionReason: string | undefined
  let updatedInput: Record<string, unknown> | undefined
  let updatedToolOutput: string | undefined

  for (const r of results) {
    if (r.context) contexts.push(r.context)
    if (r.control?.systemMessage) systemMessages.push(r.control.systemMessage)
    if (r.blocked) {
      blocked = true
      blockReasons.push(r.control?.reason ?? (r.stderr.trim() || 'blocked by hook'))
    }
    if (r.control?.continue === false) {
      stop = true
      stopReason = r.control.stopReason ?? 'stopped by hook'
    }
    const hso = r.control?.hookSpecificOutput
    if (hso?.permissionDecision && outranks(hso.permissionDecision, permission)) {
      // Strictest wins, not last. Order came from the config file, so a hook
      // written to block something was silently undone by any later hook that
      // said `allow` — and the order that decided it was not visible anywhere.
      permission = hso.permissionDecision
      permissionReason = hso.permissionDecisionReason
    }
    if (hso?.updatedInput) updatedInput = hso.updatedInput
    if (hso?.updatedToolOutput !== undefined) updatedToolOutput = hso.updatedToolOutput
  }

  return {
    contexts,
    blocked,
    blockReasons,
    stop,
    stopReason,
    systemMessages,
    permission,
    permissionReason,
    updatedInput,
    updatedToolOutput,
  }
}
