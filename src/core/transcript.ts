import { promises as fs } from 'node:fs'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { ensureDir, slugForCwd } from '../util/fs.ts'
import { stateFile } from '../util/paths.ts'

// One JSONL object per line, linked by `parentUuid`. Keeping the tree shape
// (rather than a flat array) is what makes rewind, fork and sidechain replay
// possible later without a migration.

export type TranscriptRecord = {
  type: string
  uuid: string
  parentUuid: string | null
  timestamp: string
  sessionId: string
  cwd: string
  version: string
  /** True for records produced inside a subagent. */
  isSidechain?: boolean
  /** True for harness-synthesised turns (reminders, hook context). */
  isMeta?: boolean
  agentId?: string
  [key: string]: unknown
}

export class Transcript {
  readonly sessionId: string
  readonly file: string
  private cwd: string
  private version: string
  private lastUuid: string | null = null
  private queue: Promise<void> = Promise.resolve()
  private dirEnsured = false
  private failures = 0
  private lastFailure?: Error
  private linkToDisk = false

  constructor(opts: {
    sessionId?: string
    cwd: string
    version: string
    dataDir?: string
  }) {
    this.sessionId = opts.sessionId ?? randomUUID()
    this.cwd = opts.cwd
    this.version = opts.version
    const root = opts.dataDir ?? stateFile('projects')
    this.file = path.join(root, slugForCwd(opts.cwd), `${this.sessionId}.jsonl`)
  }

  /** Appends a record and returns its uuid. Writes are serialised. */
  append(
    type: string,
    payload: Record<string, unknown>,
    opts: { parentUuid?: string | null; isSidechain?: boolean; agentId?: string } = {},
  ): string {
    const uuid = randomUUID()
    const record: TranscriptRecord = {
      type,
      uuid,
      parentUuid: opts.parentUuid !== undefined ? opts.parentUuid : this.lastUuid,
      timestamp: new Date().toISOString(),
      sessionId: this.sessionId,
      cwd: this.cwd,
      version: this.version,
      ...(opts.isSidechain ? { isSidechain: true } : {}),
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
      ...payload,
    }
    if (!opts.isSidechain) this.lastUuid = uuid

    this.queue = this.queue.then(async () => {
      // Once per transcript, not once per record: a turn writes user, assistant
      // per step, every tool result and the leadtime line.
      if (!this.dirEnsured) {
        await ensureDir(path.dirname(this.file))
        this.dirEnsured = true
      }
      // A resumed session appends to a file that already has records, and its
      // first one linked to nothing — so the tree read back from disk showed two
      // roots and the resumed half looked like a separate conversation. Resolved
      // here, where reading the file is not on the caller's path.
      if (this.linkToDisk) {
        this.linkToDisk = false
        const last = await this.lastUuidOnDisk()
        if (last && record.parentUuid === null) record.parentUuid = last
      }
      await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8')
    })
    // The chain is what serialises the writes; it must not also be what carries
    // the failure. Left unhandled, one failed append — a full disk, a directory
    // that went away — rejected the queue permanently, so every later record in
    // the session was dropped, and `flush()` rejected into whatever awaited it.
    this.queue = this.queue.catch(err => {
      this.failures++
      this.lastFailure = err instanceof Error ? err : new Error(String(err))
      // The directory may be the thing that failed; the next write re-creates it.
      this.dirEnsured = false
    })
    return uuid
  }

  /**
   * Says this transcript continues a file that already exists, so the next
   * record links to the last one already on disk instead of starting a root.
   */
  continueChain(): void {
    this.linkToDisk = true
  }

  /** The uuid of the last well-formed record already in the file, if any. */
  private async lastUuidOnDisk(): Promise<string | null> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch {
      return null
    }
    const lines = raw.split('\n').filter(l => l.trim())
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const uuid = (JSON.parse(lines[i]) as TranscriptRecord).uuid
        if (uuid) return uuid
      } catch {
        /* a torn line is not a parent */
      }
    }
    return null
  }

  /** How many records could not be written, and why the last one failed. */
  get writeFailures(): { count: number; last?: Error } {
    return { count: this.failures, last: this.lastFailure }
  }

  /** Resolves once every queued write has hit disk. */
  flush(): Promise<void> {
    return this.queue
  }

  async read(): Promise<TranscriptRecord[]> {
    let raw: string
    try {
      raw = await fs.readFile(this.file, 'utf8')
    } catch {
      return []
    }
    // Per line, because a transcript is append-only and the process can be
    // killed mid-write: one torn last line used to throw out the entire
    // session's history, which is the moment it matters most.
    const records: TranscriptRecord[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line) as TranscriptRecord)
      } catch {
        /* a torn line costs that line */
      }
    }
    return records
  }
}
