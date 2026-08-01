import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { Session } from './session.ts'

// Commands that outlive the turn that started them.
//
// The use case is one: run the test suite while the conversation continues.
// Everything here exists to make that not break something else.
//
// What this deliberately does NOT do is wake the model up when a job finishes.
// "Re-enter the loop" needs someone running outside the turn, and that someone
// only exists in the TUI — not in headless, not inside a subagent, not inside a
// workflow step. Rather than a feature that works in one of four contexts, the
// model polls with `BashOutput`, which works in all of them. The finished job
// still announces itself on screen; it just does not speak for the user.

export type JobState = 'running' | 'exited' | 'killed'

export type Job = {
  id: string
  command: string
  shell: 'posix' | 'powershell'
  startedAt: number
  endedAt?: number
  exitCode: number | null
  state: JobState
  /** Absolute count of characters ever produced, dropped ones included. */
  produced: number
  /** Characters discarded from the head of the buffer. */
  dropped: number
  /** Absolute index of the first character not yet handed to the model. */
  cursor: number
  buffer: string
  child: ChildProcess
}

/**
 * Output kept per job. A background job has no timeout to bound it — a `tail -f`
 * would grow forever — so the buffer is a ring and the *amount discarded* is
 * reported. Silently losing the head of a test run is how a green suite gets
 * read as a failure.
 */
const MAX_JOB_BUFFER = 200_000

const jobState = new WeakMap<Session, Map<string, Job>>()
let counter = 0

function rootOf(session: Session): Session {
  let root = session
  while (root.parent) root = root.parent
  return root
}

function table(session: Session): Map<string, Job> {
  const root = rootOf(session)
  const existing = jobState.get(root)
  if (existing) return existing
  const created = new Map<string, Job>()
  jobState.set(root, created)
  return created
}

function append(job: Job, chunk: string): void {
  job.produced += chunk.length
  job.buffer += chunk
  if (job.buffer.length > MAX_JOB_BUFFER) {
    const excess = job.buffer.length - MAX_JOB_BUFFER
    job.buffer = job.buffer.slice(excess)
    job.dropped += excess
  }
}

/**
 * Registers an already-spawned child as a background job.
 *
 * The child is spawned by the caller and **without an abort signal** on purpose:
 * the natural thing to pass is `ctx.signal`, which is the *turn's* controller,
 * and then pressing esc on the turn that launched a fifteen-minute suite would
 * kill it. A background job is only stopped by `KillShell` or by process exit.
 */
export function startJob(
  session: Session,
  entry: { command: string; shell: 'posix' | 'powershell'; child: ChildProcess },
): Job {
  const id = `bash_${++counter}`
  const job: Job = {
    id,
    command: entry.command,
    shell: entry.shell,
    startedAt: Date.now(),
    exitCode: null,
    state: 'running',
    produced: 0,
    dropped: 0,
    cursor: 0,
    buffer: '',
    child: entry.child,
  }

  entry.child.stdout?.on('data', d => append(job, String(d)))
  entry.child.stderr?.on('data', d => append(job, String(d)))
  entry.child.on('error', err => {
    append(job, `\n[spawn failed] ${err.message}\n`)
    if (job.state === 'running') job.state = 'exited'
    job.exitCode = -1
    job.endedAt = Date.now()
  })
  entry.child.on('close', code => {
    job.exitCode = code
    if (job.state !== 'killed') job.state = 'exited'
    job.endedAt = Date.now()
    session.emit({
      type: 'notice',
      text: `${id} terminou (exit ${code}) — BashOutput lê a saída`,
    })
  })
  entry.child.stdin?.end()

  table(session).set(id, job)
  return job
}

export function getJob(session: Session, id: string): Job | undefined {
  return table(session).get(id)
}

export function listJobs(session: Session): Job[] {
  return [...table(session).values()]
}

/**
 * Output produced since the last read.
 *
 * Cursor-based rather than "the whole buffer", and not as an option: the loop
 * truncates a tool result at 30.000 characters, and for a test run the part that
 * would be cut is the end — exactly where the verdict is.
 */
export function readJob(job: Job): { text: string; lost: number } {
  const lost = Math.max(0, job.dropped - job.cursor)
  const from = Math.max(job.cursor, job.dropped)
  const text = job.buffer.slice(from - job.dropped)
  job.cursor = job.produced
  return { text, lost }
}

/**
 * Stops a job and everything it started.
 *
 * On Windows `child.kill()` signals only the direct child: `powershell.exe
 * -Command "npm test"` leaves `node.exe` running, and a `KillShell` that lies
 * about having killed something is worse than not having one. `taskkill /T`
 * walks the tree.
 */
export function killJob(job: Job): void {
  if (job.state !== 'running') return
  job.state = 'killed'
  if (process.platform === 'win32' && job.child.pid) {
    const killer = spawn('taskkill', ['/PID', String(job.child.pid), '/T', '/F'], {
      windowsHide: true,
    })
    killer.on('error', () => job.child.kill())
    return
  }
  job.child.kill()
}

/**
 * Called when the harness is shutting down. A live child with piped stdio keeps
 * the event loop alive, so without this a single background job turns "exit"
 * into "hang" — for a user who may never have used the feature.
 */
export function killAllJobs(session: Session): void {
  for (const job of table(session).values()) killJob(job)
}

export function describeJob(job: Job): string {
  const ran = Math.round(((job.endedAt ?? Date.now()) - job.startedAt) / 1000)
  const status =
    job.state === 'running'
      ? `running for ${ran}s`
      : job.state === 'killed'
        ? `killed after ${ran}s`
        : `exited ${job.exitCode} after ${ran}s`
  return `${job.id} · ${status} · ${job.command}`
}
