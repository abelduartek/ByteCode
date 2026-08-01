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

    const line = JSON.stringify(record) + '\n'
    this.queue = this.queue.then(async () => {
      // Once per transcript, not once per record: a turn writes user, assistant
      // per step, every tool result and the leadtime line.
      if (!this.dirEnsured) {
        await ensureDir(path.dirname(this.file))
        this.dirEnsured = true
      }
      await fs.appendFile(this.file, line, 'utf8')
    })
    return uuid
  }

  /** Resolves once every queued write has hit disk. */
  flush(): Promise<void> {
    return this.queue
  }

  async read(): Promise<TranscriptRecord[]> {
    try {
      const raw = await fs.readFile(this.file, 'utf8')
      return raw
        .split('\n')
        .filter(Boolean)
        .map(l => JSON.parse(l) as TranscriptRecord)
    } catch {
      return []
    }
  }
}
