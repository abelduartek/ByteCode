import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { Session } from './session.ts'
import { guardWrite, noteFile } from './filestate.ts'

// Every file the session wrote, with the content it had **before the session
// touched it**. That is what makes the changes screen show a session-wide diff
// instead of the last edit: five edits to one file are one change to review.

export type FileChange = {
  /** Absolute path. */
  file: string
  /** Content before the first write of this session; null when it was created. */
  before: string | null
  after: string
  edits: number
  at: number
  /**
   * Who wrote it: `main` for the session the user drives, otherwise the agent's
   * own name. A list, because a file can be started by a subagent and finished
   * by the main loop — and "who touched this" is the first question when a diff
   * shows something nobody remembers asking for.
   */
  by: string[]
}

const changeState = new WeakMap<Session, Map<string, FileChange>>()

function rootOf(session: Session): Session {
  let root = session
  while (root.parent) root = root.parent
  return root
}

/** `main` for the session the user drives, otherwise the agent's own name. */
function ownerOf(session: Session): string {
  return session.parent ? (session.agentType ?? 'subagent') : 'main'
}

/**
 * Recorded on the root session, like the todo lists: a file written inside a
 * subagent is still a file the user has to review, and the screen they open is
 * the main one.
 */
export function recordChange(
  session: Session,
  entry: { file: string; before: string | null; after: string },
): void {
  const root = rootOf(session)
  const files = changeState.get(root) ?? new Map<string, FileChange>()
  const existing = files.get(entry.file)
  const owner = ownerOf(session)
  files.set(entry.file, {
    file: entry.file,
    // Only the first write establishes the baseline; later ones move `after`.
    before: existing ? existing.before : entry.before,
    after: entry.after,
    edits: (existing?.edits ?? 0) + 1,
    at: Date.now(),
    by: existing?.by.includes(owner) ? existing.by : [...(existing?.by ?? []), owner],
  })
  changeState.set(root, files)
}

/** Changed files, sorted by path so the grouping is stable between draws. */
export function changedFiles(session: Session): FileChange[] {
  const files = changeState.get(rootOf(session))
  if (!files) return []
  return [...files.values()].sort((a, b) => a.file.localeCompare(b.file))
}

export function clearChanges(session: Session): void {
  changeState.delete(rootOf(session))
}

export type RevertResult =
  | { ok: true; action: 'restored' | 'deleted'; file: string }
  | { ok: false; reason: string }

/**
 * Puts a file back the way the session found it.
 *
 * The baseline is the content from **before the first write of the session**, so
 * one revert undoes the whole session's work on that file rather than the last
 * edit — which is the question actually being asked ("undo what the agent did
 * here"), and the reason `before` is kept from the first write.
 *
 * Refuses when the file changed on disk after the session last wrote it: that
 * change came from somewhere else, and restoring over it would be the exact
 * silent clobber the write guard exists to prevent.
 */
export async function revertChange(session: Session, file: string): Promise<RevertResult> {
  const root = rootOf(session)
  const files = changeState.get(root)
  const change = files?.get(file)
  if (!change) return { ok: false, reason: `${file} não está na lista de alterações da sessão` }

  const guard = await guardWrite(session, file, { whole: true })
  if (!guard.ok) return { ok: false, reason: guard.reason }

  try {
    if (change.before === null) {
      // The session created it, so putting it back means it should not exist.
      // Already gone is the same outcome, not a failure.
      await fs.rm(file, { force: true })
      files?.delete(file)
      await noteFile(session, file)
      return { ok: true, action: 'deleted', file }
    }
    await fs.writeFile(file, change.before, 'utf8')
    files?.delete(file)
    await noteFile(session, file)
    return { ok: true, action: 'restored', file }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

/** Files grouped by directory, relative to `cwd` — what the file pane lists. */
export function groupByDirectory(
  changes: FileChange[],
  cwd: string,
): { dir: string; files: { change: FileChange; name: string }[] }[] {
  const groups = new Map<string, { change: FileChange; name: string }[]>()
  for (const change of changes) {
    const rel = path.relative(cwd, change.file) || path.basename(change.file)
    // A path outside the project keeps its absolute form: `../../..` says less
    // about where the file is than the path itself.
    const shown = rel.startsWith('..') ? change.file : rel
    const dir = path.dirname(shown)
    const list = groups.get(dir) ?? []
    list.push({ change, name: path.basename(shown) })
    groups.set(dir, list)
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([dir, files]) => ({ dir: dir === '.' ? '' : dir, files }))
}

export type LineOp = { marker: ' ' | '-' | '+'; text: string }

/** Above this, the LCS table costs more than the diff is worth. */
const MAX_LCS_LINES = 1500
/** Lines of context kept around each hunk. */
const CONTEXT = 3

/**
 * Line diff: common prefix and suffix are trimmed first, then an LCS over what
 * is left. The trim is what keeps this cheap on the common case — an edit
 * touches a handful of lines in the middle of a file that is otherwise identical.
 *
 * Past `MAX_LCS_LINES` the middle is reported as one delete followed by one
 * insert. A quadratic table over a 20k-line file would stall the UI, and nobody
 * reads a 20k-line diff line by line anyway.
 */
export function diffLines(before: string[], after: string[]): LineOp[] {
  let start = 0
  while (start < before.length && start < after.length && before[start] === after[start]) start++
  let tail = 0
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail++
  }

  const head = before.slice(0, start).map(text => ({ marker: ' ' as const, text }))
  const foot = before.slice(before.length - tail).map(text => ({ marker: ' ' as const, text }))
  const oldMid = before.slice(start, before.length - tail)
  const newMid = after.slice(start, after.length - tail)

  if (oldMid.length === 0 && newMid.length === 0) return [...head, ...foot]

  if (oldMid.length > MAX_LCS_LINES || newMid.length > MAX_LCS_LINES) {
    return [
      ...head,
      ...oldMid.map(text => ({ marker: '-' as const, text })),
      ...newMid.map(text => ({ marker: '+' as const, text })),
      ...foot,
    ]
  }

  // Classic LCS table over the middle only.
  const rows = oldMid.length + 1
  const cols = newMid.length + 1
  const table = new Int32Array(rows * cols)
  for (let i = oldMid.length - 1; i >= 0; i--) {
    for (let j = newMid.length - 1; j >= 0; j--) {
      table[i * cols + j] =
        oldMid[i] === newMid[j]
          ? table[(i + 1) * cols + j + 1] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + j + 1])
    }
  }

  const middle: LineOp[] = []
  let i = 0
  let j = 0
  while (i < oldMid.length && j < newMid.length) {
    if (oldMid[i] === newMid[j]) {
      middle.push({ marker: ' ', text: oldMid[i] })
      i++
      j++
    } else if (table[(i + 1) * cols + j] >= table[i * cols + j + 1]) {
      middle.push({ marker: '-', text: oldMid[i] })
      i++
    } else {
      middle.push({ marker: '+', text: newMid[j] })
      j++
    }
  }
  while (i < oldMid.length) middle.push({ marker: '-', text: oldMid[i++] })
  while (j < newMid.length) middle.push({ marker: '+', text: newMid[j++] })

  return [...head, ...middle, ...foot]
}

/**
 * A real unified diff, so the same renderer that draws `git diff` draws this —
 * grouped or side by side, with line numbers on both sides.
 */
export function unifiedDiff(change: FileChange, label: string): string {
  const before = change.before === null ? [] : change.before.split('\n')
  const after = change.after.split('\n')
  const ops = diffLines(before, after)

  const out = [`diff --git a/${label} b/${label}`]
  if (change.before === null) out.push('new file mode 100644')

  let oldLine = 1
  let newLine = 1
  let index = 0

  while (index < ops.length) {
    // Skip context until the next change, keeping the numbering in step.
    if (ops[index].marker === ' ') {
      const nextChange = ops.findIndex((op, k) => k >= index && op.marker !== ' ')
      if (nextChange === -1) break
      const skip = Math.max(0, nextChange - index - CONTEXT)
      for (let k = 0; k < skip; k++) {
        oldLine++
        newLine++
        index++
      }
    }

    const hunk: LineOp[] = []
    const oldStart = oldLine
    const newStart = newLine
    let oldCount = 0
    let newCount = 0
    let trailing = 0

    while (index < ops.length) {
      const op = ops[index]
      if (op.marker === ' ') {
        // Close the hunk once enough context has followed the last change — but
        // only if more changes are not sitting right after it, or the file would
        // come out as many one-line hunks.
        trailing++
        const upcoming = ops.slice(index, index + CONTEXT + 1).some(o => o.marker !== ' ')
        if (trailing > CONTEXT && !upcoming) break
      } else {
        trailing = 0
      }
      hunk.push(op)
      if (op.marker !== '+') {
        oldLine++
        oldCount++
      }
      if (op.marker !== '-') {
        newLine++
        newCount++
      }
      index++
    }

    if (hunk.length === 0) break
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const op of hunk) out.push(`${op.marker}${op.text}`)
  }

  return out.join('\n')
}

/** `+12 -3`, the counter the file list shows next to each name. */
export function changeStats(change: FileChange): { added: number; removed: number } {
  const ops = diffLines(change.before === null ? [] : change.before.split('\n'), change.after.split('\n'))
  return {
    added: ops.filter(op => op.marker === '+').length,
    removed: ops.filter(op => op.marker === '-').length,
  }
}
