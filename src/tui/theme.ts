// Design tokens for the ByteCode TUI.
//
// Taken from the design spec: xterm-256 indices with a 16-colour fallback, and
// a glyph set that degrades to ASCII. Three axes of degradation:
//   NO_COLOR / TERM=dumb  -> no colour, glyphs kept, weight carried by bold/dim
//   no 256-colour support  -> the fallback column
//   BYTECODE_ASCII=1       -> box-drawing becomes +-| and braille becomes |/-\
//
// Escape sequences are assembled from a char code so this file stays ASCII
// except for the glyph table itself.

import { envOption } from '../util/paths.ts'

const ESC = String.fromCharCode(27)
const CSI = `${ESC}[`
const RESET = `${CSI}0m`

export type ColorLevel = 0 | 1 | 2

function detectLevel(): ColorLevel {
  if (process.env.NO_COLOR !== undefined) return 0
  if (process.env.TERM === 'dumb') return 0
  if (!process.stdout.isTTY) return 0
  if (envOption('COLOR') === '16') return 1
  const term = process.env.TERM ?? ''
  if (process.env.COLORTERM || /256|kitty|alacritty|wezterm/i.test(term)) return 2
  // Windows Terminal and modern conhost handle 256 colours.
  if (process.platform === 'win32') return 2
  return term ? 1 : 0
}

export const level: ColorLevel = detectLevel()

/**
 * 24-bit colour, used only where the 256-colour cube has nothing usable: its
 * darkest greens and reds (22 and 52) are fully saturated, which is why the diff
 * bands read as neon instead of as a tint behind code.
 */
function detectTrueColor(): boolean {
  if (level < 2) return false
  if (/truecolor|24bit/i.test(process.env.COLORTERM ?? '')) return true
  if (/direct|kitty|wezterm|alacritty/i.test(process.env.TERM ?? '')) return true
  // Windows Terminal and current conhost both take 24-bit SGR.
  return process.platform === 'win32'
}

export const trueColor = detectTrueColor()
export const ascii = envOption('ASCII') === '1'

/**
 * At level 0 the design still carries weight through bold/dim — but only on a
 * real terminal. Redirected output must stay free of escape sequences so a
 * captured log or a piped file is plain text.
 */
const useAttributes = Boolean(process.stdout.isTTY)

type Token = {
  /** xterm-256 index. */
  x: number
  /** 16-colour SGR foreground code. */
  fallback: number
  /** Extra SGR attribute for the no-colour path (1 bold, 2 dim). */
  attr?: number
}

const TOKENS: Record<string, Token> = {
  bg: { x: 235, fallback: 39 },
  bar: { x: 236, fallback: 39 },
  fg: { x: 252, fallback: 39 },
  bright: { x: 255, fallback: 39, attr: 1 },
  dim: { x: 245, fallback: 37, attr: 2 },
  faint: { x: 240, fallback: 90, attr: 2 },
  rule: { x: 237, fallback: 90, attr: 2 },
  accent: { x: 173, fallback: 33 },
  info: { x: 109, fallback: 36 },
  ok: { x: 108, fallback: 32 },
  warn: { x: 179, fallback: 33 },
  danger: { x: 167, fallback: 31 },
  meta: { x: 139, fallback: 35 },
}

/**
 * Palettes keep the design's roles and only move the hue of the two identity
 * colours. `terracotta` is the original spec; it reads as Claude's brand, so it
 * is not the default.
 */
export const PRESETS: Record<string, Partial<Record<string, number>>> = {
  terracotta: { accent: 173, meta: 139 },
  violet: { accent: 141, meta: 139 },
  azure: { accent: 75, meta: 140 },
  emerald: { accent: 78, meta: 139 },
  amber: { accent: 214, meta: 139 },
}

export const DEFAULT_PRESET = 'violet'

/** Applied once at startup from the config; painters read TOKENS per call. */
export function applyTheme(opts: { preset?: string; tokens?: Record<string, number> } = {}): void {
  const preset = PRESETS[opts.preset ?? DEFAULT_PRESET] ?? PRESETS[DEFAULT_PRESET]
  for (const [name, index] of Object.entries({ ...preset, ...(opts.tokens ?? {}) })) {
    const token = TOKENS[name]
    if (token && typeof index === 'number') token.x = index
  }
}

export type TokenName =
  | 'bg'
  | 'bar'
  | 'fg'
  | 'bright'
  | 'dim'
  | 'faint'
  | 'rule'
  | 'accent'
  | 'info'
  | 'ok'
  | 'warn'
  | 'danger'
  | 'meta'

function fg(token: Token): string {
  if (level === 2) return `${CSI}38;5;${token.x}m`
  return `${CSI}${token.fallback}m`
}

function bg(token: Token): string {
  if (level === 2) return `${CSI}48;5;${token.x}m`
  return `${CSI}${token.fallback + 10}m`
}

function paint(name: TokenName, text: string): string {
  const token = TOKENS[name]
  if (level === 0) {
    if (!useAttributes) return text
    if (token.attr === 1) return `${CSI}1m${text}${CSI}22m`
    if (token.attr === 2) return `${CSI}2m${text}${CSI}22m`
    return text
  }
  return `${fg(token)}${text}${RESET}`
}

type Painter = (text: string) => string

export const c = Object.fromEntries(
  (Object.keys(TOKENS) as TokenName[]).map(name => [name, (text: string) => paint(name, text)]),
) as Record<TokenName, Painter>

export function bold(text: string): string {
  if (level === 0 && !useAttributes) return text
  return `${CSI}1m${text}${CSI}22m`
}

/**
 * Text that is *there* but not seen: SGR 8 (conceal) plus a foreground set to
 * the background tone. Two mechanisms because conceal is optional — a terminal
 * that ignores it still renders near-invisible dark-on-dark, and one that honours
 * it hides the text outright. Selecting the row reveals it, which is the point.
 */
export function hidden(text: string): string {
  if (level === 0) return text
  return `${CSI}8m${fg(TOKENS.bg)}${text}${RESET}`
}

/** Markdown `*emphasis*`. Attribute-only: it must survive `NO_COLOR`. */
export function em(text: string): string {
  if (level === 0 && !useAttributes) return text
  return `${CSI}3m${text}${CSI}23m`
}

/** Markdown `~~struck~~`. */
export function strike(text: string): string {
  if (level === 0 && !useAttributes) return text
  return `${CSI}9m${text}${CSI}29m`
}

/** Emphasised foreground: the design uses #f0f0f0 + weight for "said by user". */
export function strong(text: string): string {
  return level === 0 ? bold(text) : `${fg(TOKENS.bright)}${CSI}1m${text}${RESET}`
}

/**
 * A row with a background, used by the status bar.
 *
 * Every inner colour span ends with a RESET, which also clears the background —
 * so the bar used to be painted only up to the first coloured token and looked
 * like a grey patch instead of a bar. The background is therefore re-opened
 * after each reset.
 */
export function barLine(text: string): string {
  if (level === 0) return text
  const open = bg(TOKENS.bar)
  return `${open}${text.split(RESET).join(`${RESET}${open}`)}${RESET}`
}

/**
 * Selected row inside a popup or picker. Inner resets re-open the background:
 * without that the highlight stopped at the first coloured token, so a row like
 * `▸ Arquivo.java +40 -0` was painted for two characters and bare after that.
 */
export function selected(text: string): string {
  if (level === 0) return text
  const open = bg(TOKENS.rule)
  return `${open}${text.split(RESET).join(`${RESET}${open}`)}${RESET}`
}

/**
 * A row that is queued but not sent yet: inverted, so it cannot be mistaken for
 * something already in the conversation. Inner resets re-open the background, or
 * the highlight would stop at the first coloured token.
 */
export function queued(text: string): string {
  if (level === 0) return bold(text)
  const open = `${bg(TOKENS.bright)}${fg(TOKENS.bg)}`
  return `${open}${text.split(RESET).join(`${RESET}${open}`)}${RESET}`
}

/**
 * Diff palette, matching what a code review UI does: a **light pastel band with
 * dark text** for the changed line, and a stronger pastel behind the span that
 * actually changed. Only changed rows get a band — context stays on the
 * terminal's own background, so the eye lands on the edit instead of on a wall
 * of colour.
 *
 * The first attempt used dark saturated bands (xterm 22 / 52). Behind code they
 * read as highlighter, not as a tint.
 */
const DIFF = {
  add: { band: [230, 255, 236], span: [166, 240, 186], mark: [26, 127, 55], band256: 194, span256: 157 },
  del: { band: [255, 235, 233], span: [255, 199, 195], mark: [207, 34, 46], band256: 224, span256: 217 },
  /** Text inside a band: dark, because the band is light. */
  text: [36, 41, 47],
  text256: 235,
  /** Line numbers inside a band. */
  number: [110, 119, 129],
  number256: 244,
}

function bgRgb([r, g, b]: number[]): string {
  return `${CSI}48;2;${r};${g};${b}m`
}

function fgRgb([r, g, b]: number[]): string {
  return `${CSI}38;2;${r};${g};${b}m`
}

/** Re-opens `open` after every inner reset, or the band stops at the first span. */
function band(open: string, text: string): string {
  return `${open}${text.split(RESET).join(`${RESET}${open}`)}${RESET}`
}

/**
 * Added / removed line tint inside a diff. Inner resets re-open the background,
 * or the band stops at the first coloured span — which made a `+` row look like
 * a green gutter with an uncoloured line next to it instead of a filled band.
 */
export function tint(kind: 'add' | 'del', text: string): string {
  if (level === 0) return text
  const tone = DIFF[kind]
  const open = trueColor
    ? bgRgb(tone.band)
    : level === 2
      ? `${CSI}48;5;${tone.band256}m`
      : `${CSI}${kind === 'add' ? 42 : 41}m`
  return band(open, text)
}

/** The span that actually changed, one step stronger than the row's band. */
export function tintSpan(kind: 'add' | 'del', text: string): string {
  if (level === 0) return bold(text)
  const tone = DIFF[kind]
  const open = trueColor ? bgRgb(tone.span) : level === 2 ? `${CSI}48;5;${tone.span256}m` : `${CSI}1m`
  return band(open, level === 1 ? text : diffText(text))
}

/** Code inside a band. Dark, since the band is light. */
export function diffText(text: string): string {
  if (level === 0) return text
  return trueColor ? `${fgRgb(DIFF.text)}${text}${RESET}` : level === 2 ? `${CSI}38;5;${DIFF.text256}m${text}${RESET}` : text
}

/** Line number inside a band. */
export function diffNumber(text: string): string {
  if (level === 0) return c.faint(text)
  return trueColor
    ? `${fgRgb(DIFF.number)}${text}${RESET}`
    : level === 2
      ? `${CSI}38;5;${DIFF.number256}m${text}${RESET}`
      : c.faint(text)
}

/** The `+` / `-` marker: the one saturated thing inside the band. */
export function diffMark(kind: 'add' | 'del', text: string): string {
  if (level === 0) return text
  return trueColor
    ? `${fgRgb(DIFF[kind].mark)}${CSI}1m${text}${RESET}`
    : level === 2
      ? `${CSI}38;5;${kind === 'add' ? 28 : 124}m${text}${RESET}`
      : text
}

const UNICODE = {
  boxTopLeft: '╭',
  boxTopRight: '╮',
  boxBottomLeft: '╰',
  boxBottomRight: '╯',
  boxH: '─',
  boxV: '│',
  boxTDown: '┬',
  boxTUp: '┴',
  boxCross: '┼',
  subRule: '╌',
  treeEnd: '└',
  railThick: '▌',
  railThin: '▏',
  ok: '✔',
  fail: '✕',
  warn: '▲',
  dotOn: '●',
  dotOff: '○',
  prompt: '❯',
  expand: '⌄',
  collapse: '⌃',
  git: '⎇',
  cursor: '▉',
  sep: '▏',
  ellipsis: '…',
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  spark: ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'],
}

const ASCII = {
  boxTopLeft: '+',
  boxTopRight: '+',
  boxBottomLeft: '+',
  boxBottomRight: '+',
  boxH: '-',
  boxV: '|',
  boxTDown: '+',
  boxTUp: '+',
  boxCross: '+',
  subRule: '-',
  treeEnd: '`-',
  railThick: '|',
  railThin: '|',
  ok: 'v',
  fail: 'x',
  warn: '!',
  dotOn: '*',
  dotOff: 'o',
  prompt: '>',
  expand: 'v',
  collapse: '^',
  git: '@',
  cursor: '_',
  sep: '|',
  ellipsis: '...',
  spinner: ['|', '/', '-', '\\'],
  spark: ['_', '.', '-', '=', '+', '*', '#', '#'],
}

export const g = ascii ? ASCII : UNICODE

/** Eight-level block sparkline, used for context usage. */
export function sparkline(values: number[]): string {
  return values
    .map(v => g.spark[Math.max(0, Math.min(g.spark.length - 1, Math.round(v * (g.spark.length - 1))))])
    .join('')
}
