import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Session } from './session.ts'

// What the session has *seen* of each file, so a write can tell the difference
// between "I am changing what I read" and "I am destroying something I never
// looked at".
//
// Two hazards, both silent without this:
//
//   1. `Write` fully replaces a file. Doing that to a file nobody read discards
//      content the model cannot even name.
//   2. During a long session the file is also open in an editor. A save there
//      moves the file under the agent, and the next `Edit` writes the old
//      content back over it — no error, no diff, the work is simply gone.
//
// Scoped to the **root** session, like the change log: a file a subagent read is
// a file the tree has seen, and the question "did anyone here look at this" has
// one answer per workspace, not one per context.

export type SeenFile = { mtimeMs: number; size: number; at: number }

const seenState = new WeakMap<Session, Map<string, SeenFile>>()

function rootOf(session: Session): Session {
  let root = session
  while (root.parent) root = root.parent
  return root
}

/**
 * Windows paths differ only by case for the same file, and the model will use
 * whichever spelling it saw. Matching case-sensitively there would report a
 * stale file as unread.
 */
function keyOf(file: string): string {
  const resolved = path.resolve(file)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

function table(session: Session): Map<string, SeenFile> {
  const root = rootOf(session)
  const existing = seenState.get(root)
  if (existing) return existing
  const created = new Map<string, SeenFile>()
  seenState.set(root, created)
  return created
}

/** Records the file as seen, from its current state on disk. Never throws. */
export async function noteFile(session: Session, file: string): Promise<void> {
  try {
    const stat = await fs.stat(file)
    table(session).set(keyOf(file), { mtimeMs: stat.mtimeMs, size: stat.size, at: Date.now() })
  } catch {
    // Gone or unreadable: forget it, so the next write is checked from scratch.
    table(session).delete(keyOf(file))
  }
}

export function seenFile(session: Session, file: string): SeenFile | undefined {
  return table(session).get(keyOf(file))
}

export function forgetFiles(session: Session): void {
  seenState.delete(rootOf(session))
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string }

const OK: GuardVerdict = { ok: true }

/**
 * Whether a write may proceed.
 *
 * `whole` marks a full replacement (`Write`), which is held to the stricter
 * rule: an `Edit` at least has to match text it was given, so it cannot silently
 * destroy a file it never saw — it fails loudly on `old_string not found`.
 *
 * Deliberately **not** blocking an `Edit` of an unread file: the model may have
 * the exact line from a `Grep`, and refusing that would cost a round trip to
 * prove something the match already proved.
 */
export async function guardWrite(
  session: Session,
  file: string,
  opts: { whole: boolean },
): Promise<GuardVerdict> {
  if (session.config.fileGuard === false) return OK

  let stat: { mtimeMs: number; size: number }
  try {
    stat = await fs.stat(file)
  } catch {
    // Creating a file cannot clobber anything.
    return OK
  }

  const seen = seenState.get(rootOf(session))?.get(keyOf(file))

  if (!seen) {
    if (!opts.whole) return OK
    return {
      ok: false,
      reason:
        `${file} exists and has not been read in this session. Write replaces the whole file, ` +
        `so read it first and keep what should survive.`,
    }
  }

  if (stat.mtimeMs !== seen.mtimeMs || stat.size !== seen.size) {
    return {
      ok: false,
      reason:
        `${file} changed on disk after you read it — someone else (an editor, a formatter, a ` +
        `build step) wrote to it. Read it again before writing, or the change will be lost.`,
    }
  }

  return OK
}
