import { DEFAULT_PRESET, PRESETS } from './theme.ts'

// The loading screen shown while the harness loads.
//
// It imports nothing heavy on purpose: this file runs *before* the modules it is
// waiting on, which is the only way anything can be on screen while they load.
// `theme.ts` is the one exception (~35 ms) and it earns it — the alternative is
// copying the palette numbers here, which is precisely the kind of duplicate
// that goes stale the first time a preset changes.
//
// It draws on the alternate screen, centred, and hands that screen over to the
// TUI instead of leaving and re-entering — leaving would flash the user's
// terminal back for one frame between the two.
//
// The bar sweeps rather than fills. A percentage would have to be invented —
// module loading reports no progress — and a bar that jumps to 100% at the end
// is a lie told in a friendly voice.

const ESC = '\x1b['
const HIDE = `${ESC}?25l`
const SHOW = `${ESC}?25h`
const ALT_ON = `${ESC}?1049h`
const ALT_OFF = `${ESC}?1049l`
const CLEAR = `${ESC}2J${ESC}H`
const CLEAR_LINE = `${ESC}2K`
const at = (row: number, col: number) => `${ESC}${row};${col}H`

const WORDMARK = [
  '█▀▄ █ █ ▀█▀ █▀▀ ▄▀▀ ▄▀▄ █▀▄ █▀▀',
  '█▀▄ ▀▄▀  █  █▀▀ █   █ █ █ █ █▀▀',
  '█▄▀  █   █  █▄▄ ▀▄▄ ▀▄▀ █▄▀ █▄▄',
]
const WORDMARK_WIDTH = 31
/** Column where `CODE` starts, so the two halves can be tinted apart. */
const WORDMARK_SPLIT = 15

const TAGLINE = 'Relaxa que eu não vou dominar o mundo, ou melhor, ainda não.'

const BAR_WIDTH = 31
/** Frame time. Eight or nine frames over a ~500 ms load — enough to read as motion. */
const FRAME_MS = 60

/**
 * Same switch the rest of the TUI uses. No platform guessing here: the terminal
 * that draws the main screen's box characters draws these too, and assuming
 * Windows cannot would degrade a perfectly capable one.
 */
function ascii(): boolean {
  // Both spellings, like every other option: a machine configured before the
  // rename kept getting box characters it had asked not to receive.
  return process.env.BYTECODE_ASCII === '1' || process.env.HX_ASCII === '1'
}

function accentOf(preset: string): number {
  return PRESETS[preset]?.accent ?? PRESETS[DEFAULT_PRESET]?.accent ?? 141
}

type Palette = { accent: string; dim: string; faint: string; reset: string }

function palette(accent: number, out: NodeJS.WriteStream): Palette {
  // The same switches the theme honours, checked the same way: `NO_COLOR` counts
  // when it is *set*, empty value included — the convention — and `TERM=dumb`
  // means the terminal cannot do this at all. Read as a truthy value, `NO_COLOR=`
  // left the splash in full colour on a screen the rest of the UI kept plain.
  //
  // Decided from the stream it was handed, never from `process.stdout`: the
  // function has to answer about where it will actually write.
  if (process.env.NO_COLOR !== undefined || process.env.TERM === 'dumb' || !out.isTTY) {
    return { accent: '', dim: '', faint: '', reset: '' }
  }
  // 16-colour terminals, and anyone who asked for 16 explicitly.
  const forced16 =
    process.env.BYTECODE_COLOR === '16' ||
    process.env.HX_COLOR === '16' ||
    (!process.env.COLORTERM &&
      process.platform !== 'win32' &&
      !/256|kitty|alacritty|wezterm/i.test(process.env.TERM ?? ''))
  if (forced16) {
    return { accent: `${ESC}35m`, dim: `${ESC}37m`, faint: `${ESC}90m`, reset: `${ESC}0m` }
  }
  return {
    accent: `${ESC}38;5;${accent}m`,
    dim: `${ESC}38;5;250m`,
    faint: `${ESC}38;5;244m`,
    reset: `${ESC}0m`,
  }
}

/**
 * A wave crossing the bar, so the eye has something moving without the code
 * claiming to know how far along it is.
 */
function bar(frame: number, width: number, c: Palette): string {
  const [full, mid, empty] = ascii() ? ['#', '=', '-'] : ['█', '▓', '░']
  const head = frame % (width + 8)
  let out = ''
  for (let i = 0; i < width; i++) {
    const d = head - i
    if (d === 0 || d === 1) out += `${c.accent}${full}`
    else if (d === 2 || d === 3) out += `${c.dim}${mid}`
    else if (d === 4) out += `${c.faint}${mid}`
    else out += `${c.faint}${empty}`
  }
  return out + c.reset
}

export type StopOptions = {
  /**
   * Leave the alternate screen active for the caller. The full-screen UI is
   * about to paint on it; anything else has to get the user's terminal back.
   */
  keepAltScreen?: boolean
}

export type Splash = {
  stop: (opts?: StopOptions) => void
  /**
   * What is being loaded right now. Every label must be set immediately before
   * the work it names actually starts — a stage line that narrates instead of
   * reporting is the same lie as a fake percentage, just in words.
   */
  stage: (label: string) => void
}

const NOOP: Splash = { stop: () => {}, stage: () => {} }

/**
 * Starts the animation, or does nothing when there is no terminal to draw on.
 *
 * Returns something with `stop()` in every case, so the caller never has to ask
 * whether it started.
 */
export function startSplash(out: NodeJS.WriteStream = process.stdout): Splash {
  if (!out.isTTY || process.env.BYTECODE_NO_SPLASH === '1') return NOOP

  const cols = out.columns ?? 80
  const rows = out.rows ?? 24
  const block = !ascii() && cols >= WORDMARK_WIDTH + 4

  let c = palette(accentOf(process.env.BYTECODE_THEME ?? DEFAULT_PRESET), out)
  // The real preset lives in the config, and reading it costs ~14 ms of disk.
  // Paying that before the first frame would delay the very thing being shown,
  // so the default paints immediately and the answer corrects it a frame later.
  void resolvePreset().then(preset => {
    if (preset) c = palette(accentOf(preset), out)
  })

  const barWidth = Math.max(10, Math.min(BAR_WIDTH, cols - 6))
  const tagline = TAGLINE.length + 4 <= cols ? TAGLINE : 'Relaxa.'
  const width = Math.max(block ? WORDMARK_WIDTH : 8, barWidth, tagline.length)
  const titleRows = block ? WORDMARK.length : 1
  // Rows, in order: title · blank · bar · stage · blank · tagline. The two blank
  // rows are the whole reason this is a layout and not three lines stacked.
  const height = titleRows + 5
  const top = Math.max(1, Math.floor((rows - height) / 2) + 1)
  const left = Math.max(1, Math.floor((cols - width) / 2) + 1)
  /** Centres a piece inside the block, so every part shares an axis. */
  const col = (pieceWidth: number) => left + Math.floor((width - pieceWidth) / 2)

  const barRow = top + titleRows + 1
  const stageRow = barRow + 1
  const taglineRow = stageRow + 2

  let frame = 0
  let stopped = false
  let stage = ''
  out.write(ALT_ON + HIDE + CLEAR)

  const draw = (): void => {
    if (stopped) return
    let s = ''
    if (block) {
      WORDMARK.forEach((row, i) => {
        s +=
          at(top + i, col(WORDMARK_WIDTH)) +
          c.accent +
          row.slice(0, WORDMARK_SPLIT) +
          c.dim +
          row.slice(WORDMARK_SPLIT) +
          c.reset
      })
    } else {
      s += at(top, col(8)) + c.accent + 'Byte' + c.dim + 'Code' + c.reset
    }
    s += at(barRow, col(barWidth)) + bar(frame, barWidth, c)
    // The stage line is cleared whole every frame: a shorter label written over
    // a longer one would leave the tail of the previous stage on screen.
    const label = stage.length > width ? `${stage.slice(0, width - 1)}…` : stage
    s += at(stageRow, 1) + CLEAR_LINE
    if (label) s += at(stageRow, col(label.length)) + c.dim + label + c.reset
    s += at(taglineRow, col(tagline.length)) + c.faint + tagline + c.reset
    out.write(s)
    frame++
  }

  draw()
  const timer = setInterval(draw, FRAME_MS)
  // The splash must never be the reason the process stays alive.
  timer.unref?.()

  let handedOver = false

  const stop = (opts: StopOptions = {}): void => {
    if (stopped) return
    stopped = true
    clearInterval(timer)
    // Cleared either way: the UI taking over inherits a blank alternate screen
    // instead of having to paint over a wordmark.
    out.write(CLEAR)
    if (opts.keepAltScreen) handedOver = true
    else out.write(ALT_OFF + SHOW)
  }

  // A crash before the handover would leave the terminal on the alternate screen
  // with no cursor — the shell would look broken.
  //
  // `handedOver` covers the gap after it: the splash stopped but left the screen
  // on for the full-screen UI, and anything that throws between here and that
  // UI's own `finally` — building the session tree, the first frame — used to
  // exit with the shell still on the alternate screen. Restoring twice does
  // nothing, so the UI's own restore is not disturbed by this one.
  process.once('exit', () => {
    if (!stopped || handedOver) out.write(CLEAR + ALT_OFF + SHOW)
  })

  return {
    stop,
    stage: (label: string) => {
      if (stopped) return
      stage = label
      // Painted at once instead of waiting for the tick: a stage that only
      // appears 60 ms later would sometimes never be seen at all.
      draw()
    },
  }
}

/** The configured theme preset, or null when it cannot be read cheaply. */
async function resolvePreset(): Promise<string | null> {
  try {
    const { loadConfig } = await import('../config/load.ts')
    const { config } = await loadConfig(process.cwd())
    return config.theme?.preset ?? null
  } catch {
    // A broken or missing config must not break a loading animation.
    return null
  }
}
