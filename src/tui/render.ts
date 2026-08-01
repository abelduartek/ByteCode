import { c, diffMark, diffNumber, diffText, em, g, level, strike, strong, tint, tintSpan } from './theme.ts'

// Text shaping for the TUI: width-aware wrapping that ignores ANSI sequences,
// a small markdown renderer, and the box / rule primitives from the design.
//
// Escape sequences are built from a char code so this source stays ASCII apart
// from the glyphs it re-exports.

const ESC = String.fromCharCode(27)
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, 'g')
const ANSI_HEAD = new RegExp(`^${ESC}\\[[0-9;]*m`)

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

// Every C0 control **except** ESC (0x1b), which is how each SGR sequence starts.
// The range stops at 0x1a and resumes at 0x1c for exactly that reason; tab is
// included on purpose, since a tab inside a row misaligns every column after it.
const CONTROLS = new RegExp('[\u0000-\u001a\u001c-\u001f\u007f]', 'g')

/**
 * Collapses anything that would move the cursor on its own.
 *
 * A newline inside a frame row is not a cosmetic problem: `draw()` positions the
 * cursor with `CSI <row>;1H` and writes the row, so an embedded `\n` pushes the
 * rest of that row onto the next physical line with no position marker, and every
 * row below is drawn one off. The symptom is orphan fragments of a previous line
 * sitting at column 0 — which is exactly what a multi-line Bash command produced.
 */
export function oneLine(text: string): string {
  return text.replace(CONTROLS, ' ')
}

export function visibleWidth(text: string): number {
  return text.replace(ANSI, '').length
}

export function truncate(text: string, width: number): string {
  if (visibleWidth(text) <= width) return text
  const tail = g.ellipsis
  const budget = width - tail.length
  if (budget <= 0) return ''
  let out = ''
  let count = 0
  let i = 0
  while (i < text.length && count < budget) {
    const match = text.slice(i).match(ANSI_HEAD)
    if (match) {
      out += match[0]
      i += match[0].length
      continue
    }
    out += text[i]
    count++
    i++
  }
  return out + tail
}

export function pad(text: string, width: number): string {
  const gap = width - visibleWidth(text)
  return gap > 0 ? text + ' '.repeat(gap) : text
}

/**
 * Left text, right text, filler between — the design's dominant row shape.
 *
 * The left side is truncated when the two do not fit. Returning a row wider than
 * `width` is not a cosmetic overflow: `draw()` writes one row per physical line,
 * so the excess wraps onto the next line and every row below is painted one off.
 * That is what a long filename beside its `+n -n` counts produced in the changes
 * list — a black stub of leftover paint under each long name.
 */
export function split(left: string, right: string, width: number): string {
  const room = width - visibleWidth(right) - 1
  const head = visibleWidth(left) > room ? truncate(left, Math.max(0, room)) : left
  const gap = Math.max(1, width - visibleWidth(head) - visibleWidth(right))
  return head + ' '.repeat(gap) + right
}

export function wrap(text: string, width: number): string[] {
  if (width <= 0) return [text]
  const out: string[] = []

  for (const rawLine of text.split('\n')) {
    if (visibleWidth(rawLine) <= width) {
      out.push(rawLine)
      continue
    }
    let line = ''
    let lineWidth = 0
    for (const word of rawLine.split(' ')) {
      const wordWidth = visibleWidth(word)
      if (lineWidth > 0 && lineWidth + 1 + wordWidth > width) {
        out.push(line)
        line = ''
        lineWidth = 0
      }
      if (wordWidth > width) {
        let rest = word
        while (visibleWidth(rest) > width) {
          out.push(rest.slice(0, width))
          rest = rest.slice(width)
        }
        line = rest
        lineWidth = visibleWidth(rest)
        continue
      }
      line = lineWidth === 0 ? word : `${line} ${word}`
      lineWidth += lineWidth === 0 ? wordWidth : wordWidth + 1
    }
    if (line) out.push(line)
  }
  return out
}

const BOLD = /\*\*([^*]+)\*\*/g
const CODE = /`([^`]+)`/g
const STRIKE = /~~([^~]+)~~/g
const LINK = new RegExp(`\\[([^\\]\\n${ESC}]+)\\]\\(([^)\\s]+)\\)`, 'g')
// Only `*emphasis*`, never `_emphasis_`: `_` shows up inside identifiers all day
// (`tool_input`, `__init__`) and italicising half a symbol name is worse than not
// supporting the spelling. The guards keep `**bold**` and `2 * 3` out.
const EM = /(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g

type Align = 'left' | 'right' | 'center'

/** `|---|:--:|` and friends — the row that makes the one above it a header. */
const TABLE_RULE = /^\s*\|?(\s*:?-{2,}:?\s*\|)+\s*:?-{2,}:?\s*\|?\s*$/
/** Narrowest a column may get before the shrink loop gives up on it. */
const MIN_COLUMN = 4
/** Right-aligned automatically when the separator row said nothing. */
const NUMERIC = /^[\s\d.,%+\-–—$R$€£()x×/]+$/

/**
 * Cells of one row. `\|` is an escaped pipe, not a column break — a table of
 * regexes or shell pipelines is otherwise shredded into extra columns.
 */
function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '')
  const cells: string[] = []
  let cur = ''
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === '\\' && body[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '|') {
      cells.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  cells.push(cur.trim())
  return cells
}

function alignments(rule: string): (Align | null)[] {
  return tableCells(rule).map(cell => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

function alignCell(text: string, width: number, align: Align): string {
  const gap = width - visibleWidth(text)
  if (gap <= 0) return text
  if (align === 'right') return ' '.repeat(gap) + text
  if (align === 'center') {
    const left = Math.floor(gap / 2)
    return ' '.repeat(left) + text + ' '.repeat(gap - left)
  }
  return text + ' '.repeat(gap)
}

/**
 * Column widths that fit `width`, shrinking the widest column one cell at a time.
 *
 * Proportional scaling was the obvious alternative and it is worse: it shaves the
 * narrow columns — `12` becoming `1…` — while the prose column that actually
 * needs the room is still too wide. Taking from the widest converges on "long
 * text wraps, short values stay intact", which is what a reader wants.
 */
function columnWidths(rows: string[][], count: number, width: number): number[] {
  const widths = Array.from({ length: count }, (_, i) =>
    Math.max(1, ...rows.map(row => visibleWidth(row[i] ?? ''))),
  )
  const gap = 3 // ` │ `
  const total = () => widths.reduce((sum, w) => sum + w, 0) + gap * (count - 1)

  while (total() > width) {
    let widest = 0
    for (let i = 1; i < count; i++) if (widths[i] > widths[widest]) widest = i
    if (widths[widest] <= MIN_COLUMN) break
    widths[widest]--
  }
  return widths
}

/** Below this per column, a grid stops being readable and becomes confetti. */
const READABLE_COLUMN = 12

/** Widest token that cannot be broken by wrapping. */
function longestWord(text: string): number {
  return Math.max(0, ...text.split(/\s+/).map(visibleWidth))
}

/**
 * Wide table, narrow terminal: one block per row, `label  value`, instead of
 * columns two characters wide. Six columns in 44 cells cannot be a grid — it
 * breaks `provider` into `provid/er` and every value with it. Records lose the
 * column-to-column comparison and keep the data legible, which is the better
 * half of the trade at that size.
 */
function renderRecords(header: string[], rows: string[][], width: number): string[] {
  const labels = header.slice(1)
  const labelWidth = Math.min(
    Math.max(1, ...labels.map(visibleWidth)),
    Math.max(4, Math.floor(width / 3)),
  )
  const out: string[] = []

  rows.forEach((row, index) => {
    if (index > 0) out.push('')
    out.push(`${c.rule(g.railThick)} ${strong(row[0] ?? '')}`)
    labels.forEach((label, i) => {
      const value = row[i + 1] ?? ''
      if (!value) return
      const indent = 2 + labelWidth + 2
      const [first, ...rest] = wrap(value, Math.max(1, width - indent))
      out.push(`  ${c.faint(pad(truncate(label, labelWidth), labelWidth))}  ${first ?? ''}`)
      for (const line of rest) out.push(`${' '.repeat(indent)}${line}`)
    })
  })
  return out
}

/**
 * A markdown table as aligned columns with a faint header rule — no outer box.
 *
 * Cells **wrap** instead of truncating: a table is usually the densest thing in
 * an answer, and `…` in the middle of the one column that carried the answer is
 * the failure this whole function exists to fix.
 */
export function renderTable(lines: string[], width: number): string[] {
  const header = tableCells(lines[0]).map(inline)
  const aligns = alignments(lines[1])
  const body = lines.slice(2).map(line => tableCells(line).map(inline))
  const count = Math.max(header.length, ...body.map(row => row.length), 1)

  // The decision is made on the longest *unbreakable* token per column, not on
  // total width: wrapping handles long prose fine, but a column narrower than its
  // widest word gets that word chopped in half, and a table full of `provid/er`
  // is worse than no table. One monstrous URL is capped at half the width, since
  // it has to break wherever it lands anyway.
  const needed =
    Array.from({ length: count }, (_, i) =>
      Math.min(
        Math.max(READABLE_COLUMN, ...[header, ...body].map(row => longestWord(row[i] ?? ''))),
        Math.floor(width / 2),
      ),
    ).reduce((sum, w) => sum + w, 0) +
    3 * (count - 1)

  if (count > 2 && needed > width) return renderRecords(header, body, width)

  const widths = columnWidths([header, ...body], count, width)
  const resolved: Align[] = Array.from({ length: count }, (_, i) => {
    if (aligns[i]) return aligns[i] as Align
    const values = body.map(row => stripAnsi(row[i] ?? '')).filter(Boolean)
    return values.length > 0 && values.every(v => NUMERIC.test(v)) ? 'right' : 'left'
  })

  const divider = c.rule(` ${g.boxV} `)
  const row = (cells: string[]): string[] => {
    const columns = widths.map((w, i) => wrap(cells[i] ?? '', w))
    const height = Math.max(...columns.map(col => col.length), 1)
    return Array.from({ length: height }, (_, line) =>
      widths
        .map((w, i) => alignCell(columns[i][line] ?? '', w, resolved[i]))
        .join(divider)
        .replace(/\s+$/, ''),
    )
  }

  const out = [row(header.map(strong)).join('\n')]
  out.push(c.rule(widths.map(w => g.boxH.repeat(w)).join(`${g.boxH}${g.boxCross}${g.boxH}`)))

  const rendered = body.map(row)
  // Multi-line rows blur into each other, so they get a thin separator; when every
  // row is one line the table stays airy and the separators would be noise.
  const wrapped = rendered.some(r => r.length > 1)
  rendered.forEach((r, i) => {
    if (wrapped && i > 0) {
      out.push(c.rule(widths.map(w => g.subRule.repeat(w)).join(`${g.subRule}${g.boxCross}${g.subRule}`)))
    }
    out.push(...r)
  })
  return out.flatMap(line => line.split('\n'))
}

/** Lines that still belong to a diff block: content, metadata, or blank context. */
const DIFF_BODY = /^([ +\-@\\]|diff --git |index [0-9a-f]|$)/

/** A unified diff, whatever the fence says it is. Hunk header or nothing. */
export function looksLikeUnifiedDiff(text: string): boolean {
  return /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/m.test(text) || /^diff --git /m.test(text)
}

/**
 * A fenced block. A diff inside a fence is rendered **as a diff** — line numbers,
 * bands, intra-line highlight — instead of as grey code behind a rail: `git diff`
 * pasted into an answer is the most common diff on screen, and it was the one
 * getting the least treatment.
 */
function renderFence(lang: string, body: string[], width: number, diff: DiffOptions): string[] {
  const text = body.join('\n')
  if (lang === 'diff' || lang === 'patch' || looksLikeUnifiedDiff(text)) {
    return renderDiff(text, width, diff)
  }
  // Everything else sits inside a faint gutter rather than a ruler of dashes.
  return body.map(line => `${c.rule(g.railThin)} ${c.info(line)}`)
}

export function renderMarkdown(text: string, width: number, diff: DiffOptions = {}): string[] {
  const out: string[] = []
  const lines = text.split('\n').map(l => l.replace(/\r$/, ''))
  let inFence = false
  let fenceLang = ''
  let fenceBody: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.trimStart().startsWith('```')) {
      if (inFence) {
        out.push(...renderFence(fenceLang, fenceBody, width, diff))
        inFence = false
        fenceBody = []
      } else {
        inFence = true
        fenceLang = line.trim().slice(3).trim().toLowerCase()
        fenceBody = []
      }
      continue
    }
    if (inFence) {
      fenceBody.push(line)
      continue
    }

    // A diff pasted into the answer without a fence — which is how a model that
    // just ran `git diff` usually reports it. Anchored on a real header, so a
    // paragraph that happens to start with `-` is never swallowed.
    if (/^diff --git /.test(line) || /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line)) {
      const block: string[] = []
      let j = i
      while (j < lines.length && DIFF_BODY.test(lines[j])) {
        block.push(lines[j])
        j++
      }
      out.push(...renderDiff(block.join('\n'), width, diff))
      i = j - 1
      continue
    }

    // A table is only a table when the next line is its separator: a lone row of
    // pipes is prose about pipes.
    if (line.includes('|') && lines[i + 1] && TABLE_RULE.test(lines[i + 1])) {
      const block = [line, lines[i + 1]]
      let j = i + 2
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        block.push(lines[j])
        j++
      }
      out.push(...renderTable(block, width))
      i = j - 1
      continue
    }

    const heading = line.match(/^(#{1,6})\s+(.*?)\s*#*$/)
    if (heading) {
      const body = inline(heading[2])
      const rendered =
        heading[1].length <= 2 ? strong(c.accent(body)) : c.meta(body)
      out.push(...wrap(rendered, width))
      // Only the top level gets a rule: on `##` and below it turns a section
      // break into a hedge of lines.
      if (heading[1].length === 1) out.push(rule(Math.min(width, visibleWidth(body) + 8)))
      continue
    }

    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) {
      out.push(rule(width))
      continue
    }

    const quote = line.match(/^>\s?(.*)$/)
    if (quote) {
      out.push(...wrap(inline(quote[1]), width - 2).map(l => `${c.faint(g.railThin)} ${c.dim(l)}`))
      continue
    }

    const task = line.match(/^(\s*)[-*]\s+\[([ xX])\]\s+(.*)$/)
    if (task) {
      const done = task[2].toLowerCase() === 'x'
      const body = done ? c.faint(inline(task[3])) : inline(task[3])
      const mark = done ? c.ok(g.ok) : c.faint(g.dotOff)
      const [first, ...rest] = wrap(body, Math.max(1, width - task[1].length - 3))
      out.push(`${task[1]}${mark} ${first ?? ''}`)
      for (const r of rest) out.push(`${task[1]}  ${r}`)
      continue
    }

    const bullet = line.match(/^(\s*)[-*]\s+(.*)$/)
    if (bullet) {
      const body = inline(bullet[2])
      const [first, ...rest] = wrap(body, Math.max(1, width - bullet[1].length - 3))
      out.push(`${bullet[1]}${c.faint(g.railThin)} ${first ?? ''}`)
      for (const r of rest) out.push(`${bullet[1]}  ${r}`)
      continue
    }

    // Ordered lists keep their own numbers — renumbering a list the model wrote
    // as `1. 1. 1.` would be inventing structure — and hang under the marker.
    const ordered = line.match(/^(\s*)(\d{1,3})[.)]\s+(.*)$/)
    if (ordered) {
      const marker = `${ordered[2]}.`
      const indent = ' '.repeat(ordered[1].length + marker.length + 1)
      const [first, ...rest] = wrap(inline(ordered[3]), Math.max(1, width - indent.length))
      out.push(`${ordered[1]}${c.faint(marker)} ${first ?? ''}`)
      for (const r of rest) out.push(`${indent}${r}`)
      continue
    }

    out.push(...wrap(inline(line), width))
  }
  // An answer cut off mid-block still has to render what it did produce.
  if (inFence && fenceBody.length > 0) out.push(...renderFence(fenceLang, fenceBody, width, diff))
  return out
}

function inline(text: string): string {
  return (
    text
      // Links first, and only on raw text. Every SGR sequence starts with `ESC[`,
      // so once a colour has been injected the `[` of `ESC[3m` is a candidate
      // opening bracket: the link pattern then swallowed from there to the real
      // `](url)` and ate the styling in between.
      .replace(LINK, (_, label: string, url: string) =>
        // The URL stays visible: a terminal has no hover, and a link whose target
        // cannot be seen is a link nobody can check.
        label === url ? c.info(url) : `${c.info(label)} ${c.faint(url)}`,
      )
      .replace(CODE, (_, inner: string) => c.info(inner))
      .replace(BOLD, (_, inner: string) => strong(inner))
      .replace(STRIKE, (_, inner: string) => strike(inner))
      .replace(EM, (_, before: string, inner: string) => `${before}${em(inner)}`)
  )
}

/** `╭─ title ─────────╮` … `╰─────────╯` with a caller-chosen accent. */
export function box(
  lines: string[],
  width: number,
  opts: { title?: string; paint?: (s: string) => string } = {},
): string[] {
  const paint = opts.paint ?? c.rule
  const inner = Math.max(1, width - 2)

  const top = opts.title
    ? paint(`${g.boxTopLeft}${g.boxH} `) +
      opts.title +
      paint(` ${g.boxH.repeat(Math.max(0, inner - visibleWidth(opts.title) - 3))}${g.boxTopRight}`)
    : paint(`${g.boxTopLeft}${g.boxH.repeat(inner)}${g.boxTopRight}`)

  const bottom = paint(`${g.boxBottomLeft}${g.boxH.repeat(inner)}${g.boxBottomRight}`)
  const body = lines.map(l => `${paint(g.boxV)}${truncate(pad(l, inner), inner)}${paint(g.boxV)}`)
  return [top, ...body, bottom]
}

/** `─── label  detail ───────────` full-width divider. */
export function rule(
  width: number,
  opts: { label?: string; detail?: string; paint?: (s: string) => string; char?: string } = {},
): string {
  const paint = opts.paint ?? c.rule
  const char = opts.char ?? g.boxH
  const head = paint(char.repeat(3))
  if (!opts.label) return paint(char.repeat(width))

  const label = ` ${opts.label} `
  const detail = opts.detail ? `${c.faint(opts.detail)} ` : ''
  const used = 3 + visibleWidth(label) + visibleWidth(detail)
  return head + paint(label) + detail + paint(char.repeat(Math.max(0, width - used)))
}

/** Horizontal usage gauge: filled ok, warning band, then rule. */
export function gauge(fraction: number, width: number, warnAt = 0.75): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)))
  const warnStart = Math.round(warnAt * width)
  const okPart = Math.min(filled, warnStart)
  const warnPart = Math.max(0, filled - warnStart)
  const rest = width - okPart - warnPart
  return (
    c.ok(g.spark[7].repeat(okPart)) +
    c.warn(g.spark[7].repeat(warnPart)) +
    c.rule(g.spark[7].repeat(Math.max(0, rest)))
  )
}

/** `  2103 + text` — a numbered diff row, as the file tools emit them. */
const NUMBERED = /^\s*(\d+) ([+\- ]) ?(.*)$/

const DIFF_FILE = /^diff --git a\/(.+?) b\/(.+)$/
/** Metadata rows nobody reads: the path is already in the file header. */
const DIFF_NOISE = /^(index [0-9a-f]|--- |\+\+\+ |new file mode|deleted file mode|old mode|new mode|similarity index|rename (from|to)|Binary files)/
const DIFF_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

type DiffRow = { old?: number; now?: number; marker: '+' | '-' | ' '; text: string }

/** `unified` stacks the versions; `split` puts before and after side by side. */
export type DiffLayout = 'unified' | 'split'
export type DiffOptions = {
  layout?: DiffLayout
  /** Shortcut hint printed on the first rule, so the toggle is discoverable. */
  hint?: string
}

/** Narrower than this, two columns hold less code than one. */
export const SPLIT_MIN_WIDTH = 72

/**
 * Painters for a diff row. Inside a band the text is dark on light, so a changed
 * row cannot reuse the palette a context row uses — that is the whole difference
 * between "coloured text on the terminal background" and a review-tool band.
 */
function codePaint(marker: DiffRow['marker']): (s: string) => string {
  return marker === ' ' ? c.dim : diffText
}

function numberPaint(marker: DiffRow['marker']): (s: string) => string {
  return marker === ' ' ? c.faint : diffNumber
}

function markerGlyph(marker: DiffRow['marker']): string {
  if (marker === ' ') return ' '
  return diffMark(marker === '+' ? 'add' : 'del', marker)
}

/**
 * Where two versions of the same line actually differ, as `[start, endOld,
 * endNew)`. Common prefix and suffix are matched by character, which is what
 * turns "this line changed" into "this **argument** changed".
 */
function innerChange(before: string, after: string): { start: number; endOld: number; endNew: number } | null {
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
  const endOld = before.length - tail
  const endNew = after.length - tail
  // Two lines that share almost nothing are a rewrite, not an edit: highlighting
  // "everything after column 4" says less than leaving the row plain.
  const shared = start + tail
  if (shared < Math.min(before.length, after.length) * 0.3) return null
  return { start, endOld, endNew }
}

/**
 * Wraps a line of **code**: `wrap()` cannot be used here because it rebuilds the
 * line from words separated by single spaces, which destroys indentation — the
 * one thing a reader uses to follow code. Pieces carry their offset so the
 * character-level highlight can be projected onto each of them.
 *
 * Continuations hang under the original indent, as an editor's word-wrap does.
 */
function wrapCode(text: string, width: number): { text: string; offset: number; hang: number }[] {
  const indent = text.match(/^\s*/)?.[0].length ?? 0
  const hang = Math.max(0, Math.min(indent + 2, width - 8))
  const out: { text: string; offset: number; hang: number }[] = []
  let pos = 0

  while (pos < text.length || out.length === 0) {
    const room = Math.max(1, out.length === 0 ? width : width - hang)
    if (text.length - pos <= room) {
      out.push({ text: text.slice(pos), offset: pos, hang: out.length === 0 ? 0 : hang })
      break
    }
    const limit = pos + room
    const space = text.lastIndexOf(' ', limit)
    // Break on a word only when the word boundary is late enough that the line
    // does not end half empty; otherwise cut at the column, like an editor.
    const cut = space > pos + Math.floor(room * 0.6) ? space + 1 : limit
    out.push({ text: text.slice(pos, cut), offset: pos, hang: out.length === 0 ? 0 : hang })
    pos = cut
  }
  return out
}

/** Pairs a run of removed lines with the run of added lines right after it. */
function pairRuns(rows: DiffRow[]): Map<number, number> {
  const pairs = new Map<number, number>()
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].marker !== '-') continue
    let removed = i
    while (removed < rows.length && rows[removed].marker === '-') removed++
    let added = removed
    while (added < rows.length && rows[added].marker === '+') added++
    const count = removed - i
    if (added - removed === count) {
      for (let k = 0; k < count; k++) pairs.set(i + k, removed + k)
    }
    i = added - 1
  }
  return pairs
}

/**
 * Unified diff, laid out like an editor: both line numbers in the gutter, the
 * marker, and the tint spanning the **whole row** so a change reads as a band
 * rather than as coloured text.
 *
 * Long lines wrap with an empty gutter instead of being truncated — code is the
 * one thing where the tail of the line is often the whole point — and the
 * character-level highlight marks what changed inside a modified line.
 */
export function renderDiff(text: string, width: number, opts: DiffOptions = {}): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  // Two columns need room for two gutters and two code bodies; below this the
  // split is narrower than the code it shows, so the request quietly downgrades
  // instead of rendering something unreadable.
  const split = opts.layout === 'split' && width >= SPLIT_MIN_WIDTH
  let hint = opts.hint

  // `12 + text` rows come from the file tools, not from git: one number, no hunks.
  if (lines.some(l => NUMBERED.test(l))) {
    for (const line of lines) {
      const numbered = line.match(NUMBERED)
      if (!numbered) {
        out.push(...wrap(c.dim(line), width - 2).map(l => `${c.rule(g.boxV)} ${l}`))
        continue
      }
      const [, number, marker, body] = numbered
      const row = pad(truncate(`${number.padStart(6)} ${marker} ${body}`, width), width)
      // Same palette as the git path: inside a light band the text has to be
      // dark, so the row cannot keep the terminal's own foreground.
      const gutter = row.slice(0, 8)
      const rest = row.slice(8)
      if (marker === '+') {
        out.push(tint('add', `${diffNumber(gutter.slice(0, 7))}${diffMark('add', gutter.slice(7))}${diffText(rest)}`))
      } else if (marker === '-') {
        out.push(tint('del', `${diffNumber(gutter.slice(0, 7))}${diffMark('del', gutter.slice(7))}${diffText(rest)}`))
      } else {
        out.push(`${c.faint(gutter)}${c.dim(rest)}`)
      }
    }
    return out
  }

  const NUM = 4
  // `1234 5678 + ` — two numbers, their spaces, the marker and its space. Twelve
  // cells, not eleven: undercounting it pushed every row one column past the
  // frame, and the outer truncate silently ate the last character of the code.
  const gutterWidth = NUM * 2 + 4
  const body = Math.max(8, width - gutterWidth)

  const band = (marker: DiffRow['marker'], line: string, columnWidth: number): string => {
    const padded = pad(line, columnWidth)
    if (marker === '+') return tint('add', padded)
    if (marker === '-') return tint('del', padded)
    return padded
  }

  /**
   * One version of a line for the split view: number, marker, code. The number
   * comes from the side being drawn — the left column is the *old* file and the
   * right one the new, so a context line legitimately carries two different
   * numbers.
   */
  const sideLines = (row: DiffRow | null, columnWidth: number, side: 'old' | 'now'): string[] => {
    // `1234 + ` — number, space, marker, space. The code budget has to subtract
    // exactly this: counting one cell less made every wrapped row one column too
    // wide, and the frame's final truncate ate the last characters of it.
    const gutter = NUM + 3
    if (!row) return [pad('', columnWidth)]
    const paint = codePaint(row.marker)
    const number = side === 'old' ? row.old : row.now
    const head = `${numberPaint(row.marker)(String(number ?? '').padStart(NUM))} ${markerGlyph(row.marker)} `
    return wrapCode(row.text, Math.max(4, columnWidth - gutter)).map((piece, i) =>
      band(
        row.marker,
        // Continuations keep the band but drop the number: repeating it would
        // claim the wrapped tail is its own line.
        `${i === 0 ? head : ' '.repeat(gutter)}${' '.repeat(piece.hang)}${paint(piece.text)}`,
        columnWidth,
      ),
    )
  }

  /**
   * Before and after in two columns. Removed and added runs are zipped so the
   * two versions of the same line sit on the same row — which is the only reason
   * to give up half the width for this view.
   */
  const flushSplit = (rows: DiffRow[]): void => {
    const leftWidth = Math.floor((width - 3) / 2)
    // The odd cell goes to the new side, so the row reaches the right edge and
    // the band does not stop one column short of it.
    const rightWidth = width - 3 - leftWidth
    const gap = c.rule(` ${g.boxV} `)
    const emit = (left: DiffRow | null, right: DiffRow | null) => {
      const l = sideLines(left, leftWidth, 'old')
      const r = sideLines(right, rightWidth, 'now')
      // Filler keeps the band rectangular when one side wraps further than the
      // other; an empty side stays plain, so a gap never reads as a change.
      const fillLeft = left ? band(left.marker, '', leftWidth) : pad('', leftWidth)
      const fillRight = right ? band(right.marker, '', rightWidth) : pad('', rightWidth)
      for (let i = 0; i < Math.max(l.length, r.length); i++) {
        out.push(`${l[i] ?? fillLeft}${gap}${r[i] ?? fillRight}`)
      }
    }

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]
      if (row.marker === ' ') {
        emit(row, row)
        continue
      }
      let removedEnd = i
      while (removedEnd < rows.length && rows[removedEnd].marker === '-') removedEnd++
      let addedEnd = removedEnd
      while (addedEnd < rows.length && rows[addedEnd].marker === '+') addedEnd++

      const removed = rows.slice(i, removedEnd)
      const added = rows.slice(removedEnd, addedEnd)
      for (let k = 0; k < Math.max(removed.length, added.length); k++) {
        emit(removed[k] ?? null, added[k] ?? null)
      }
      i = addedEnd - 1
    }
  }

  const flushRows = (rows: DiffRow[]): void => {
    if (split) {
      flushSplit(rows)
      return
    }
    const pairs = pairRuns(rows)
    const partner = new Map<number, number>()
    for (const [from, to] of pairs) {
      partner.set(from, to)
      partner.set(to, from)
    }

    rows.forEach((row, index) => {
      const other = partner.get(index)
      const counterpart = other === undefined ? null : rows[other].text
      const change = counterpart === null ? null : innerChange(
        row.marker === '-' ? row.text : counterpart,
        row.marker === '-' ? counterpart : row.text,
      )

      const paint = codePaint(row.marker)
      const number = numberPaint(row.marker)
      const numbers =
        `${number(String(row.old ?? '').padStart(NUM))} ` +
        `${number(String(row.now ?? '').padStart(NUM))} ` +
        `${markerGlyph(row.marker)} `

      // The changed span is emphasised inside the row; the rest keeps the band.
      const from = change && row.marker !== ' ' ? change.start : -1
      const to = change ? (row.marker === '-' ? change.endOld : change.endNew) : -1
      const paintPiece = (piece: string, offset: number): string => {
        if (from < 0) return paint(piece)
        const start = Math.max(0, Math.min(piece.length, from - offset))
        const end = Math.max(0, Math.min(piece.length, to - offset))
        if (start >= end) return paint(piece)
        // The changed span gets the stronger pastel, the way a review tool marks
        // the edited token inside an edited line.
        const kind = row.marker === '+' ? 'add' : 'del'
        return (
          paint(piece.slice(0, start)) +
          tintSpan(kind, piece.slice(start, end)) +
          paint(piece.slice(end))
        )
      }

      for (const [i, piece] of wrapCode(row.text, body).entries()) {
        const head = i === 0 ? numbers : ' '.repeat(gutterWidth)
        const line = `${head}${' '.repeat(piece.hang)}${paintPiece(piece.text, piece.offset)}`
        // Only changed rows are padded: the band has to reach the right edge, but
        // padding context rows would put trailing spaces into every copy.
        if (row.marker === '+') out.push(tint('add', pad(line, width)))
        else if (row.marker === '-') out.push(tint('del', pad(line, width)))
        else out.push(line)
      }
    })
  }

  let rows: DiffRow[] = []
  let oldNo = 0
  let newNo = 0

  for (const line of lines) {
    const file = line.match(DIFF_FILE)
    if (file) {
      flushRows(rows)
      rows = []
      // `a/x b/y` differ only on a rename, and then both names matter.
      const label = file[1] === file[2] ? file[2] : `${file[1]} → ${file[2]}`
      out.push(rule(width, { label: strong(label), detail: hint, paint: c.accent }))
      // The hint belongs to the block, not to every file inside it.
      hint = undefined
      continue
    }
    if (DIFF_NOISE.test(line)) continue

    const hunk = line.match(DIFF_HUNK)
    if (hunk) {
      flushRows(rows)
      rows = []
      oldNo = Number(hunk[1])
      newNo = Number(hunk[3])
      const span = `${hunk[1]},${hunk[2] ?? '1'} ${g.boxH}${g.boxH}${'>'} ${hunk[3]},${hunk[4] ?? '1'}`
      // A bare hunk with no `diff --git` above it still has to advertise the
      // toggle, so the hint lands on whichever rule comes first.
      const detail = [hunk[5]?.trim() || '', hint ?? ''].filter(Boolean).join(` ${g.sep} `)
      out.push(rule(width, { label: c.meta(span), detail: detail || undefined, paint: c.rule }))
      hint = undefined
      continue
    }
    // `\ No newline at end of file` is about the previous row, not a row itself.
    if (line.startsWith('\\')) continue

    if (line.startsWith('+')) rows.push({ now: newNo++, marker: '+', text: line.slice(1) })
    else if (line.startsWith('-')) rows.push({ old: oldNo++, marker: '-', text: line.slice(1) })
    else rows.push({ old: oldNo++, now: newNo++, marker: ' ', text: line.replace(/^ /, '') })
  }
  flushRows(rows)
  return out
}

export const SPINNER = g.spinner
export { level as colorLevel }
