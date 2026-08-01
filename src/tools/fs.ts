import { createReadStream, promises as fs } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { spawn } from 'node:child_process'
import type { ToolDefinition } from '../core/tools.ts'
import { recordChange } from '../core/changes.ts'
import { guardWrite, noteFile } from '../core/filestate.ts'
import { resolvePath } from '../util/fs.ts'
import { ripgrepPath } from '../util/binaries.ts'

const MAX_READ_LINES = 2000
/** Files a single `Glob` answers with; the rest are counted, not listed. */
const GLOB_MAX_RESULTS = 300
/** Context lines kept on each side of a change in the diff a write reports. */
const DIFF_CONTEXT = 3

function abs(p: string, cwd: string): string {
  return resolvePath(p, cwd)
}

/** Above this, a windowed read streams instead of loading the whole file. */
const STREAM_THRESHOLD_BYTES = 2 * 1024 * 1024

/**
 * The requested window of lines.
 *
 * A small file is read whole — simplest, and `split` on a few hundred KB is
 * nothing. A large one is streamed and abandoned as soon as the window is full,
 * so reading 50 lines out of a 200 MB log costs 50 lines instead of 200 MB.
 * The trade-off: the streamed path cannot report the total line count without
 * reading to the end, so it says "more lines below" instead of an exact number.
 */
async function readLines(
  file: string,
  offset: number,
  limit: number,
): Promise<{ slice: string[]; totalLines: number; truncated: boolean }> {
  const size = await fs.stat(file).then(s => s.size, () => 0)

  if (size <= STREAM_THRESHOLD_BYTES) {
    // `\r` dropped, as the streamed path below already does: leaving it on every
    // line of a CRLF file means the model quotes it back in an `Edit`, and the
    // exact-match lookup fails against the same text it was just shown.
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/)
    return {
      slice: lines.slice(offset - 1, offset - 1 + limit),
      totalLines: lines.length,
      truncated: false,
    }
  }

  const stream = createReadStream(file, { encoding: 'utf8' })
  const reader = createInterface({ input: stream, crlfDelay: Infinity })
  const slice: string[] = []
  let seen = 0
  try {
    for await (const line of reader) {
      seen++
      if (seen < offset) continue
      slice.push(line)
      if (slice.length >= limit) break
    }
  } finally {
    reader.close()
    stream.destroy()
  }
  // Truncated only if we stopped early; a short file simply ran out of lines.
  return { slice, totalLines: seen, truncated: slice.length >= limit }
}

/** Counts without materialising a fragment array of the whole file. */
function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count++
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * A numbered diff of the changed region, in the shape the TUI renders as a
 * tinted band: `  <line> <+|-|space> <text>`.
 *
 * Deliberately not a full unified diff — the caller already knows which file
 * changed, and one contiguous region covers the overwhelming majority of edits.
 */
function describeChange(before: string, after: string): { summary: string; diff: string } {
  const oldLines = before.split('\n')
  const newLines = after.split('\n')

  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) {
    start++
  }
  let fromEnd = 0
  while (
    fromEnd < oldLines.length - start &&
    fromEnd < newLines.length - start &&
    oldLines[oldLines.length - 1 - fromEnd] === newLines[newLines.length - 1 - fromEnd]
  ) {
    fromEnd++
  }

  const removed = oldLines.slice(start, oldLines.length - fromEnd)
  const added = newLines.slice(start, newLines.length - fromEnd)

  const parts: string[] = []
  if (added.length > 0) parts.push(`Added ${added.length} line${added.length === 1 ? '' : 's'}`)
  if (removed.length > 0) {
    parts.push(
      `${parts.length > 0 ? 'removed' : 'Removed'} ${removed.length} line${removed.length === 1 ? '' : 's'}`,
    )
  }
  const summary = parts.join(', ') || 'No line changed'

  const row = (n: number, marker: string, text: string) => `${String(n).padStart(6)} ${marker} ${text}`
  const body: string[] = []

  const contextStart = Math.max(0, start - DIFF_CONTEXT)
  for (let i = contextStart; i < start; i++) body.push(row(i + 1, ' ', newLines[i]))
  for (let i = 0; i < removed.length; i++) body.push(row(start + i + 1, '-', removed[i]))
  for (let i = 0; i < added.length; i++) body.push(row(start + i + 1, '+', added[i]))

  const tailStart = newLines.length - fromEnd
  for (let i = tailStart; i < Math.min(newLines.length, tailStart + DIFF_CONTEXT); i++) {
    body.push(row(i + 1, ' ', newLines[i]))
  }

  return { summary, diff: body.join('\n') }
}

export const readTool: ToolDefinition = {
  name: 'Read',
  kind: 'read',
  parallelSafe: true,
  description:
    'Read a file from the filesystem. Returns numbered lines. Use offset/limit for large files. ' +
    'Always read a file before editing it.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'Absolute or cwd-relative path' },
      offset: { type: 'number', description: '1-indexed first line to read' },
      limit: { type: 'number', description: 'Number of lines to read' },
    },
    required: ['file_path'],
    additionalProperties: false,
  },
  subject: i => String(i.file_path ?? ''),
  summary: i => `read ${i.file_path}`,
  async execute(input, ctx) {
    const file = abs(String(input.file_path), ctx.cwd)
    const offset = Math.max(1, Number(input.offset ?? 1))
    const limit = Math.min(Number(input.limit ?? MAX_READ_LINES), MAX_READ_LINES)

    const { slice, totalLines, truncated } = await readLines(file, offset, limit)
    // Recorded even for an empty read: "this session has looked at the file" is
    // what the write guard asks, and an empty file is a legitimate answer.
    await noteFile(ctx.session, file)
    if (slice.length === 0) return { text: `${file} is empty or offset is past EOF.` }

    const body = slice.map((l, i) => `${offset + i}\t${l}`).join('\n')
    const consumed = offset - 1 + slice.length
    const more = truncated
      ? `\n\n[more lines below]`
      : totalLines > consumed
        ? `\n\n[${totalLines - consumed} more lines]`
        : ''
    return { text: body + more }
  },
}

export const writeTool: ToolDefinition = {
  name: 'Write',
  kind: 'write',
  description:
    'Write a file, creating or fully overwriting it. For partial changes use Edit instead. ' +
    'Overwriting a file this session has not read is refused, as is writing to one that changed ' +
    'on disk after you read it — read it again first.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['file_path', 'content'],
    additionalProperties: false,
  },
  subject: i => String(i.file_path ?? ''),
  summary: i => `write ${i.file_path}`,
  async execute(input, ctx) {
    const file = abs(String(input.file_path), ctx.cwd)
    const content = String(input.content)

    const guard = await guardWrite(ctx.session, file, { whole: true })
    if (!guard.ok) return { text: guard.reason, isError: true }

    // `null` means "did not exist", which is what a revert undoes by deleting the
    // file. An existing but empty file is not that: reverting a write to one used
    // to delete a file the user had created.
    const before = await fs.readFile(file, 'utf8').catch(() => null)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, content, 'utf8')

    recordChange(ctx.session, { file, before, after: content })
    // The session has now seen this exact content, so the next write is measured
    // against what it just wrote instead of against a stale reading.
    await noteFile(ctx.session, file)

    const lines = content.split('\n').length
    if (before === null) {
      return {
        text: `Created ${lines} line${lines === 1 ? '' : 's'} (${Buffer.byteLength(content)} bytes)`,
        metadata: { file, created: true },
      }
    }
    const change = describeChange(before, content)
    return { text: `${change.summary}\n${change.diff}`, metadata: { file } }
  },
}

export const editTool: ToolDefinition = {
  name: 'Edit',
  kind: 'write',
  description:
    'Exact string replacement in a file. `old_string` must match exactly and be unique unless ' +
    'replace_all is set; the edit fails otherwise.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string' },
      old_string: { type: 'string' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean' },
    },
    required: ['file_path', 'old_string', 'new_string'],
    additionalProperties: false,
  },
  subject: i => String(i.file_path ?? ''),
  summary: i => `edit ${i.file_path}`,
  async execute(input, ctx) {
    const file = abs(String(input.file_path), ctx.cwd)
    const oldStr = String(input.old_string)
    const newStr = String(input.new_string)

    const guard = await guardWrite(ctx.session, file, { whole: false })
    if (!guard.ok) return { text: guard.reason, isError: true }

    const raw = await fs.readFile(file, 'utf8')

    const count = countOccurrences(raw, oldStr)
    if (count === 0) {
      return { text: `old_string not found in ${file}. Read the file and retry.`, isError: true }
    }
    if (count > 1 && !input.replace_all) {
      return {
        text: `old_string matches ${count} times in ${file}. Add more context or set replace_all.`,
        isError: true,
      }
    }
    // Replaced through a function, so `$&`, `` $` ``, `$'`, `$1` and `$$` in the
    // new text stay literal. Passed as a string, `String.replace` reads them as
    // replacement patterns: writing `const price = '$&'` silently produced the
    // matched text instead, corrupting the file the edit claimed to fix.
    const next = input.replace_all
      ? raw.split(oldStr).join(newStr)
      : raw.replace(oldStr, () => newStr)
    await fs.writeFile(file, next, 'utf8')
    recordChange(ctx.session, { file, before: raw, after: next })
    await noteFile(ctx.session, file)

    const change = describeChange(raw, next)
    return {
      text: `${change.summary}\n${change.diff}`,
      metadata: { replacements: input.replace_all ? count : 1, file },
    }
  },
}

export const lsTool: ToolDefinition = {
  name: 'LS',
  kind: 'read',
  parallelSafe: true,
  description: 'List the entries of a directory, marking subdirectories with a trailing slash.',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
  subject: i => String(i.path ?? ''),
  summary: i => `ls ${i.path}`,
  async execute(input, ctx) {
    const dir = abs(String(input.path), ctx.cwd)
    const entries = await fs.readdir(dir, { withFileTypes: true })
    if (entries.length === 0) return { text: `${dir} is empty` }
    const lines = entries
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(e => (e.isDirectory() ? `${e.name}/` : e.name))
    return { text: lines.join('\n') }
  },
}

export const globTool: ToolDefinition = {
  name: 'Glob',
  kind: 'read',
  parallelSafe: true,
  description:
    'Find files by glob pattern (e.g. "src/**/*.ts"), newest first. Use it to locate files by name.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string', description: 'Directory to search in; defaults to cwd' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  subject: i => String(i.pattern ?? ''),
  summary: i => `glob ${i.pattern}`,
  async execute(input, ctx) {
    const root = abs(String(input.path ?? '.'), ctx.cwd)
    const matches = await globFiles(root, String(input.pattern))
    if (matches.length === 0) return { text: 'No files matched.' }
    const shown = matches.slice(0, GLOB_MAX_RESULTS)
    // Said out loud: a silently cut list reads as the whole answer, and
    // "there are only 300 files like this" is a wrong thing to conclude.
    const more =
      matches.length > shown.length
        ? `\n\n[${matches.length - shown.length} more matched — showing the ${shown.length} most recent]`
        : ''
    return { text: shown.join('\n') + more }
  },
}

const IGNORED_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.venv', '__pycache__'])

/**
 * Candidate files, newest first.
 *
 * ripgrep does the directory walk when it is available — it is orders of
 * magnitude faster than a JS walk on a large repository, and it already honours
 * .gitignore. Its `-g` matching is gitignore-style (looser than this glob
 * dialect), so the result is filtered through the same regex either way and the
 * two paths return the same set.
 */
async function globFiles(root: string, pattern: string): Promise<string[]> {
  const rx = globToRegExp(pattern)
  const viaRg = await ripgrepFiles(root, pattern)
  const candidates = viaRg ?? (await walkFiles(root))

  const matched = candidates.filter(file => {
    const rel = path.relative(root, file).split(path.sep).join('/')
    return rx.test(rel)
  })

  // Only the matched set is stat'd, so the cost scales with the answer rather
  // than with the size of the tree — and in bounded batches, because a pattern
  // that matches every file in a monorepo opened one file handle per match at
  // once and hit EMFILE.
  const withTimes = await mapLimit(matched, 64, async file => {
    try {
      return { file, mtime: (await fs.stat(file)).mtimeMs }
    } catch {
      return { file, mtime: 0 }
    }
  })
  return withTimes.sort((a, b) => b.mtime - a.mtime).map(o => o.file)
}

/** `Promise.all` with a ceiling on how many run at once. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

function ripgrepFiles(root: string, pattern: string): Promise<string[] | null> {
  const rg = ripgrepPath()
  if (!rg) return Promise.resolve(null)

  return new Promise(resolve => {
    const args = ['--files', '--hidden', '--glob', '!.git/**', '--glob', pattern, root]
    // Matched the same way as the fallback walk, so which one ran does not
    // change the answer. An older ripgrep without the flag exits non-zero and
    // the fallback takes over, which is the same result by another route.
    if (GLOB_CASE_INSENSITIVE) args.unshift('--glob-case-insensitive')
    let out = ''
    const child = spawn(rg, args, { windowsHide: true })
    child.on('error', () => resolve(null))
    child.stdout?.on('data', d => (out += String(d)))
    child.on('close', code => {
      // 1 means "no matches", which is a valid empty answer rather than a failure.
      if (code === 0 || code === 1) resolve(out.split('\n').map(l => l.trim()).filter(Boolean))
      else resolve(null)
    })
  })
}

async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = []

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue
        await walk(full, depth + 1)
        continue
      }
      out.push(full)
    }
  }

  await walk(root, 0)
  return out
}

/**
 * Whether a name matches regardless of case, following the filesystem: on Linux
 * `README` and `readme` are two files, and a pattern that matched both would
 * return files the caller did not ask for.
 */
const GLOB_CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin'

function globToRegExp(pattern: string): RegExp {
  return new RegExp(`^${globBody(pattern)}$`, GLOB_CASE_INSENSITIVE ? 'i' : '')
}

/** The index of the `}` closing the `{` at `from`, or -1. */
function closingBrace(pattern: string, from: number): number {
  let depth = 0
  for (let i = from; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++
    else if (pattern[i] === '}' && --depth === 0) return i
  }
  return -1
}

/** Splits `ts,tsx,{a,b}` on the commas that are not inside a nested brace. */
function splitAlternatives(body: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of body) {
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  parts.push(current)
  return parts
}

function globBody(pattern: string): string {
  let src = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        src += '.*'
        i++
        if (pattern[i + 1] === '/') i++
      } else {
        src += '[^/]*'
      }
      continue
    }
    if (c === '?') {
      src += '[^/]'
      continue
    }
    // `**/*.{ts,tsx}` is the ordinary way to write this, and ripgrep already
    // understands it — so the walk found the files and this filter, reading the
    // braces as literal characters, threw every one of them away and answered
    // "No files matched".
    if (c === '{') {
      const close = closingBrace(pattern, i)
      if (close !== -1) {
        const alternatives = splitAlternatives(pattern.slice(i + 1, close))
        src += `(?:${alternatives.map(globBody).join('|')})`
        i = close
        continue
      }
    }
    src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return src
}

export const grepTool: ToolDefinition = {
  name: 'Grep',
  kind: 'read',
  parallelSafe: true,
  description:
    'Search file contents with a regular expression. Uses ripgrep when available and falls back ' +
    'to a built-in scanner. Prefer this over shelling out to grep.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: { type: 'string' },
      path: { type: 'string' },
      glob: { type: 'string', description: 'Restrict to files matching this glob' },
      '-i': { type: 'boolean', description: 'Case insensitive' },
      head_limit: { type: 'number' },
    },
    required: ['pattern'],
    additionalProperties: false,
  },
  subject: i => String(i.pattern ?? ''),
  summary: i => `grep ${i.pattern}`,
  async execute(input, ctx) {
    const root = abs(String(input.path ?? '.'), ctx.cwd)
    const limit = Number(input.head_limit ?? 200)
    const viaRg = await ripgrep(String(input.pattern), root, {
      glob: input.glob ? String(input.glob) : undefined,
      insensitive: Boolean(input['-i']),
      limit,
    })
    if (viaRg !== null) return { text: viaRg || 'No matches.' }

    const rx = new RegExp(String(input.pattern), input['-i'] ? 'i' : '')
    const files = await globFiles(root, input.glob ? String(input.glob) : '**/*')
    const lines: string[] = []
    for (const file of files) {
      if (lines.length >= limit) break
      let content: string
      try {
        content = await fs.readFile(file, 'utf8')
      } catch {
        continue
      }
      content.split('\n').forEach((line, idx) => {
        if (lines.length < limit && rx.test(line)) {
          lines.push(clampLine(`${file}:${idx + 1}:${line.trim()}`))
        }
      })
    }
    return { text: lines.join('\n') || 'No matches.' }
  },
}

/**
 * Longest match line kept. A minified bundle is one 300 KB line, and 200 of
 * those is a third of a megabyte of nothing — it would be spent on the model's
 * context window and then truncated anyway by `MAX_TOOL_OUTPUT_CHARS`.
 */
const MAX_MATCH_LINE_CHARS = 250

function clampLine(line: string): string {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line
  if (text.length <= MAX_MATCH_LINE_CHARS) return text
  return `${text.slice(0, MAX_MATCH_LINE_CHARS)}… [+${text.length - MAX_MATCH_LINE_CHARS} chars]`
}

/**
 * Matches, capped **globally**.
 *
 * `-m` is ripgrep's per-file limit, not a total, so a common pattern over a
 * large tree emits `limit × files` lines. Buffering all of it and slicing after
 * `close` — the previous shape — measured 6,18 MB and 422 ms against this
 * repository's `node_modules` for a limit of 200, to return 27 KB. Counting
 * lines as they arrive and killing the child at the limit: 337 KB and 140 ms.
 */
function ripgrep(
  pattern: string,
  root: string,
  opts: { glob?: string; insensitive?: boolean; limit: number },
): Promise<string | null> {
  const rg = ripgrepPath()
  if (!rg) return Promise.resolve(null)

  return new Promise(resolve => {
    const args = ['-n', '--no-heading', '--color', 'never', '-m', String(opts.limit)]
    if (opts.insensitive) args.push('-i')
    if (opts.glob) args.push('-g', opts.glob)
    args.push(pattern, root)

    const lines: string[] = []
    let rest = ''
    let enough = false
    const child = spawn(rg, args, { windowsHide: true })

    child.on('error', () => resolve(null))
    child.stdout?.on('data', d => {
      if (enough) return
      rest += String(d)
      const parts = rest.split('\n')
      // The last fragment has no newline yet: it belongs to the next chunk.
      rest = parts.pop() ?? ''
      for (const part of parts) {
        lines.push(clampLine(part))
        if (lines.length >= opts.limit) {
          enough = true
          child.kill()
          return
        }
      }
    })
    child.on('close', code => {
      // The kill makes the exit code meaningless, so a complete answer outranks
      // it. Otherwise 0 and 1 ("no matches") are both valid outcomes.
      if (enough) return resolve(lines.join('\n'))
      if (code === 0 || code === 1) {
        if (rest.trim()) lines.push(clampLine(rest))
        return resolve(lines.join('\n').trim())
      }
      resolve(null)
    })
  })
}

export const fsTools = [readTool, writeTool, editTool, lsTool, globTool, grepTool]
