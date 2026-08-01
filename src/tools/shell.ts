import { spawn } from 'node:child_process'
import path from 'node:path'
import type { ToolDefinition } from '../core/tools.ts'
import { describeJob, getJob, killJob, listJobs, readJob, startJob } from '../core/jobs.ts'
import { posixShell } from '../util/binaries.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000

/** One display line for a command that may span several. */
function oneLineCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim()
}

/**
 * Windows PowerShell 5.1 writes in the console output codepage — 850 on a
 * pt-BR machine, 437 on a US one — and this process decodes as UTF-8, so every
 * accented character came back as `Expans�o`. Node's `TextDecoder` has no
 * CP850 table (it is not in the WHATWG set), so the fix has to be on the
 * PowerShell side: tell it to emit UTF-8.
 *
 * On its own line rather than after a `;` so it reads as setup, not as part of
 * the command. PowerShell still echoes the whole script in a native error
 * record, which is why `stripPreamble` exists.
 */
const UTF8_PREAMBLE = '[Console]::OutputEncoding=[Text.Encoding]::UTF8'

/** Removes the line we injected, so the model never sees it in an error. */
function stripPreamble(text: string): string {
  return text.split('\n').filter(line => !line.includes(UTF8_PREAMBLE)).join('\n')
}

type RunResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean }

function spawnFor(
  command: string,
  shell: 'posix' | 'powershell',
  cwd: string,
): ReturnType<typeof spawn> {
  if (shell === 'powershell') {
    return spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        `${UTF8_PREAMBLE}\n${command}`,
      ],
      { cwd, windowsHide: true },
    )
  }

  const posix = posixShell()
  if (posix) {
    // Explicit executable rather than `shell: true`: on Windows the latter
    // resolves to cmd.exe, which silently turns a POSIX command line into
    // something else entirely.
    const env = posix.toolPath
      ? { ...process.env, PATH: `${posix.toolPath}${path.delimiter}${process.env.PATH ?? ''}` }
      : process.env
    return spawn(posix.file, ['-c', command], { cwd, windowsHide: true, env })
  }

  // macOS and Linux: `shell: true` is /bin/sh, which is what we want.
  return spawn(command, { cwd, shell: true, windowsHide: true })
}

function run(
  command: string,
  opts: { cwd: string; shell: 'posix' | 'powershell'; timeoutMs: number; signal?: AbortSignal },
): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawnFor(command, opts.shell, opts.cwd)

    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, Math.min(opts.timeoutMs, MAX_TIMEOUT_MS))

    const onAbort = () => child.kill()
    opts.signal?.addEventListener('abort', onAbort, { once: true })

    child.stdout?.on('data', d => (stdout += String(d)))
    child.stderr?.on('data', d => (stderr += String(d)))
    child.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code: -1, stdout, stderr: err.message, timedOut })
    })
    child.on('close', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout, stderr, timedOut })
    })
    child.stdin?.end()
  })
}

const MISSING_COMMAND =
  /(command not found|n[aã]o (é|e) reconhecido|is not recognized|No such file or directory)/i

/**
 * A missing command costs a whole round-trip to rediscover. Naming the tool that
 * does the job turns that into a single retry.
 */
function hintFor(result: RunResult, shell: 'posix' | 'powershell'): string | null {
  if (result.code === 0 || !MISSING_COMMAND.test(result.stderr)) return null
  if (shell === 'powershell') {
    return 'Hint: this is PowerShell, not a POSIX shell. Use Glob to find files, Grep to search contents, and Get-ChildItem/Select-String for anything else.'
  }
  return 'Hint: use Glob to find files by name and Grep to search contents instead of shelling out.'
}

function format(result: RunResult, shell: 'posix' | 'powershell'): { text: string; isError?: boolean } {
  const parts: string[] = []
  const stdout = shell === 'powershell' ? stripPreamble(result.stdout) : result.stdout
  const stderr = shell === 'powershell' ? stripPreamble(result.stderr) : result.stderr
  if (stdout.trim()) parts.push(stdout.trimEnd())
  if (stderr.trim()) parts.push(`[stderr]\n${stderr.trimEnd()}`)
  if (result.timedOut) parts.push('[timed out]')
  if (result.code !== 0) parts.push(`[exit code ${result.code}]`)
  const hint = hintFor(result, shell)
  if (hint) parts.push(hint)
  const text = parts.join('\n\n') || `[no output] (exit ${result.code})`
  return { text, isError: result.code !== 0 || result.timedOut }
}

function bashDescription(): string {
  const posix = posixShell()
  const where =
    process.platform === 'win32'
      ? `Runs ${posix ? posix.file : 'bash'} — a real POSIX shell, not cmd.exe. Use forward slashes and /c/ style paths; \`$VAR\`, not \`%VAR%\`. For Windows-native work use PowerShell instead. `
      : 'Runs /bin/sh. '
  return (
    `Run a shell command. ${where}` +
    'Working directory is the session cwd. ' +
    'Do not use it for find, grep, cat, head, tail, ls, sed or awk — Glob, Grep, Read and LS do those ' +
    'faster and their output is easier to act on.'
  )
}

/**
 * Starts the command and returns immediately with its job id.
 *
 * The child is spawned **without** `ctx.signal`: that controller belongs to the
 * turn, so passing it would mean an esc on the turn that launched a fifteen
 * minute suite kills the suite.
 */
function background(
  session: import('../core/session.ts').Session,
  command: string,
  shell: 'posix' | 'powershell',
  cwd: string,
): { text: string } {
  const child = spawnFor(command, shell, cwd)
  const job = startJob(session, { command: oneLineCommand(command), shell, child })
  return {
    text:
      `Started ${job.id} in the background.\n` +
      `Read its output with BashOutput({ bash_id: "${job.id}" }) — each call returns only what is ` +
      `new since the last one. Stop it with KillShell.`,
  }
}

const BACKGROUND_INPUT = {
  run_in_background: {
    type: 'boolean',
    description:
      'Return immediately with a job id instead of waiting. Use for anything long (test suites, ' +
      'builds, watchers) so the conversation can continue; poll with BashOutput.',
  },
}

export const bashTool: ToolDefinition = {
  name: 'Bash',
  kind: 'exec',
  description: bashDescription(),
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string', description: 'Short active-voice description' },
      timeout: { type: 'number', description: 'Milliseconds, max 600000' },
      ...BACKGROUND_INPUT,
    },
    required: ['command'],
    additionalProperties: false,
  },
  // Collapsed to one line: a heredoc or multi-line script is shown as a single
  // `Bash(...)` title, and permission rules match a predictable single line.
  subject: i => oneLineCommand(String(i.command ?? '')),
  summary: i => oneLineCommand(String(i.description ?? i.command ?? '')),
  async execute(input, ctx) {
    if (input.run_in_background === true) {
      return background(ctx.session, String(input.command), 'posix', ctx.cwd)
    }
    const result = await run(String(input.command), {
      cwd: ctx.cwd,
      shell: 'posix',
      timeoutMs: Number(input.timeout ?? DEFAULT_TIMEOUT_MS),
      signal: ctx.signal,
    })
    return format(result, 'posix')
  },
}

export const powershellTool: ToolDefinition = {
  name: 'PowerShell',
  kind: 'exec',
  description:
    'Run a PowerShell command. Windows-native operations, git, npm, docker. ' +
    'No `&&` chaining in Windows PowerShell 5.1 — use `;` or `if ($?) { }`. ' +
    'Prefer Glob, Grep, Read and LS for finding, searching and reading files.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      description: { type: 'string' },
      timeout: { type: 'number' },
      ...BACKGROUND_INPUT,
    },
    required: ['command'],
    additionalProperties: false,
  },
  // Collapsed to one line: a heredoc or multi-line script is shown as a single
  // `Bash(...)` title, and permission rules match a predictable single line.
  subject: i => oneLineCommand(String(i.command ?? '')),
  summary: i => oneLineCommand(String(i.description ?? i.command ?? '')),
  async execute(input, ctx) {
    if (input.run_in_background === true) {
      return background(ctx.session, String(input.command), 'powershell', ctx.cwd)
    }
    const result = await run(String(input.command), {
      cwd: ctx.cwd,
      shell: 'powershell',
      timeoutMs: Number(input.timeout ?? DEFAULT_TIMEOUT_MS),
      signal: ctx.signal,
    })
    return format(result, 'powershell')
  },
}

export const bashOutputTool: ToolDefinition = {
  name: 'BashOutput',
  kind: 'read',
  parallelSafe: true,
  description:
    'Read new output from a background job started with run_in_background. Each call returns only ' +
    'what appeared since the last one, plus whether the job is still running.',
  inputSchema: {
    type: 'object',
    properties: { bash_id: { type: 'string', description: 'The id the Bash call returned' } },
    required: ['bash_id'],
    additionalProperties: false,
  },
  subject: i => String(i.bash_id ?? ''),
  summary: i => `read ${i.bash_id}`,
  async execute(input, ctx) {
    const job = getJob(ctx.session, String(input.bash_id))
    if (!job) {
      const known = listJobs(ctx.session).map(j => j.id)
      return {
        text:
          `No background job "${String(input.bash_id)}". ` +
          (known.length > 0 ? `Running or finished: ${known.join(', ')}.` : 'None were started.'),
        isError: true,
      }
    }
    const { text, lost } = readJob(job)
    const head = describeJob(job)
    const dropped = lost > 0 ? `\n[dropped ${lost} chars from the head — the job outran the buffer]` : ''
    if (!text) {
      return {
        text: `${head}${dropped}\n\n(no new output${job.state === 'running' ? ' yet' : ''})`,
      }
    }
    return { text: `${head}${dropped}\n\n${text}`, isError: job.state === 'exited' && job.exitCode !== 0 }
  },
}

export const killShellTool: ToolDefinition = {
  name: 'KillShell',
  kind: 'exec',
  // Subject is the job id, never a pid: taking a pid would turn this into a way
  // to kill any process on the machine through a tool the model already has.
  subject: i => String(i.bash_id ?? ''),
  description: 'Stop a background job, and everything it started, by its id.',
  inputSchema: {
    type: 'object',
    properties: { bash_id: { type: 'string' } },
    required: ['bash_id'],
    additionalProperties: false,
  },
  summary: i => `kill ${i.bash_id}`,
  async execute(input, ctx) {
    const job = getJob(ctx.session, String(input.bash_id))
    if (!job) return { text: `No background job "${String(input.bash_id)}".`, isError: true }
    if (job.state !== 'running') return { text: `${describeJob(job)} — already finished.` }
    killJob(job)
    return { text: `Killing ${job.id} and its children.` }
  },
}

/**
 * Windows without a POSIX shell gets PowerShell only. Advertising a Bash tool
 * that would run cmd.exe just invites commands that cannot work.
 */
export const shellTools =
  process.platform === 'win32'
    ? posixShell()
      ? [bashTool, powershellTool, bashOutputTool, killShellTool]
      : [powershellTool, bashOutputTool, killShellTool]
    : [bashTool, bashOutputTool, killShellTool]
