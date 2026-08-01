import { spawn } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { PermissionMode, ProviderConfig } from '../config/types.ts'
import { addModel, addProvider, findConfigTarget, findProviderFile } from '../config/write.ts'
import type { PermissionRequest, Session, UIEvent } from '../core/session.ts'
import { runTurn, TurnFailure } from '../core/loop.ts'
import { compact, contextLimit, contextTokens } from '../core/compaction.ts'
import { formatLeadtime, summarizeTurn } from '../core/leadtime.ts'
import { formatContextReport } from '../core/contextreport.ts'
import {
  flattenTree,
  formatWhen,
  listSessions,
  loadSession,
  saveSessionState,
  sessionTree,
  visibleUserText,
} from '../core/sessions.ts'
import type { SessionNode, SessionSummary } from '../core/sessions.ts'
import type { AgentDefinition, SlashCommand } from '../assets/index.ts'
import { expandCommandBody } from '../assets/index.ts'
import { clearParkedAgents, clearTodos, getTodos, resolveAgentModel, todoGroups } from '../tools/meta.ts'
import { forgetFiles } from '../core/filestate.ts'
import { killAllJobs } from '../core/jobs.ts'
import { changeStats, changedFiles, groupByDirectory, revertChange, unifiedDiff } from '../core/changes.ts'
import type { SavedWorkflow, WorkflowStep } from '../core/workflow.ts'
import { listWorkflows, workflowRuns } from '../core/workflow.ts'
import { registerTools } from '../tools/index.ts'
import type { ModelMessage } from 'ai'
import { listModels, withConnectedProviders } from '../provider/registry.ts'
import { authPath, connectedProviders, maskKey, readAuth, removeCredential, saveCredential } from '../provider/auth.ts'
import { loadCatalog } from '../provider/catalog.ts'
import { topModels } from '../provider/connect.ts'
import { PERMISSION_MODES } from '../core/permissions.ts'
import { DEFAULT_PRESET, PRESETS, applyTheme, ascii, barLine, c, g, hidden, queued, selected, sparkline, strong } from './theme.ts'
import { box, gauge, oneLine, pad, renderDiff, renderMarkdown, rule, split, SPLIT_MIN_WIDTH, stripAnsi, truncate, visibleWidth, wrap } from './render.ts'
import type { DiffLayout } from './render.ts'
import { copyToClipboard, readImageFromClipboard } from '../util/clipboard.ts'
import {
  AttachmentStore,
  describeAttachment,
  expand as expandAttachments,
  imagePathIn,
  placeholderFor,
  readImageFile,
  shouldFold,
  userContent,
} from './attach.ts'
import type { ImageAttachment } from './attach.ts'
import { describeError } from '../util/error.ts'
import { CLI } from '../util/paths.ts'

// Full-screen TUI implementing the ByteCode design spec: centred column capped at
// 120 columns, header and status as the only lines with a background, one blank
// line between blocks (never two), tool calls collapsed to a single line until
// ctrl+r, and modals whose border colour carries the kind of decision being
// asked for — amber decides, teal chooses, red warns.

const ESC = String.fromCharCode(27)
const CSI = `${ESC}[`
const ALT_ON = `${CSI}?1049h`
const ALT_OFF = `${CSI}?1049l`
const CURSOR_HIDE = `${CSI}?25l`
const CURSOR_SHOW = `${CSI}?25h`
/** Command rows the `/` popup shows at once; it scrolls past this. */
const COMPLETION_ROWS = 7
const CLEAR_LINE = `${CSI}K`
// `CSI K` erases with the *current* background on any terminal with background
// colour erase, so a row that ends mid-colour would paint its background across
// the rest of the line. Closing every row first costs 4 bytes and removes the
// class.
const RESET = `${CSI}0m`
const CLEAR_SCREEN = `${CSI}2J`
const HOME = `${CSI}H`
// 1002 reports press, drag and release (needed for selection); 1006 is the SGR
// encoding: CSI < button ; col ; row M for press/drag, m for release.
const MOUSE_ON = `${CSI}?1002h${CSI}?1006h`
const MOUSE_OFF = `${CSI}?1006l${CSI}?1002l${CSI}?1000l`
// Bracketed paste: the terminal wraps pasted text in these markers, so a paste
// with newlines arrives as text instead of a burst of Enter presses.
const PASTE_ON = `${CSI}?2004h`
const PASTE_OFF = `${CSI}?2004l`
const PASTE_START = `${CSI}200~`
const PASTE_END = `${CSI}201~`

/**
 * How long an `ESC` waits for the rest of its sequence before it is taken to be
 * the Esc key. Long enough that a sequence split across two reads is reassembled,
 * short enough that pressing Esc still feels immediate.
 */
const ESC_HOLD_MS = 40

/** Narrowest column the layout draws; anything less has no room for a row. */
const MIN_WIDTH = 40

/** Enter alone submits; these all insert a line break instead. */
const NEWLINE_KEYS = new Set([
  '\n', // ctrl+J, and what many terminals send for shift+enter
  `${ESC}\r`, // alt+enter
  `${ESC}\n`,
  `${CSI}13;2u`, // shift+enter with CSI-u reporting
  `${CSI}13;5u`, // ctrl+enter
  `${CSI}27;2;13~`,
  `${CSI}27;5;13~`,
])

/** Modals stay narrow whatever the column does — a 200-column dialog is unusable. */
const MAX_MODAL_WIDTH = 78
/** Composer rows shown for a long paste; the rest is summarised above. */
const MAX_COMPOSER_LINES = 10

const MODE_CYCLE: PermissionMode[] = ['default', 'plan', 'bypassPermissions']

// Terminals disagree on End/Home: xterm sends CSI F / CSI H, with modifiers as
// CSI 1;5F; the VT sequences are CSI 4~ / CSI 8~ and CSI 1~ / CSI 7~.
const END_KEY = /^\x1b\[(?:\d+(?:;\d+)?)?F$|^\x1b\[(?:4|8)~$|^\x1bOF$/
const HOME_KEY = /^\x1b\[(?:\d+(?:;\d+)?)?H$|^\x1b\[(?:1|7)~$|^\x1bOH$/

/** Human-readable rendering of a raw key sequence, for `/keys`. */
function describeKey(key: string): string {
  const readable = key.replace(/\x1b/g, 'ESC').replace(/\r/g, 'CR').replace(/\n/g, 'LF').replace(/\t/g, 'TAB')
  const codes = [...key].map(ch => ch.charCodeAt(0)).join(' ')
  return `${JSON.stringify(readable)}  bytes[${codes}]`
}

const MODE_LABEL: Record<PermissionMode, string> = {
  default: 'ask',
  plan: 'plan',
  acceptEdits: 'auto-edit',
  dontAsk: 'no-ask',
  bypassPermissions: 'AUTO',
}

const MODE_HELP: Record<PermissionMode, string> = {
  default: 'pergunta antes de escrever ou rodar',
  plan: 'só leitura',
  acceptEdits: 'edita, comandos ainda perguntam',
  dontAsk: 'o que perguntaria é negado',
  bypassPermissions: 'roda sem perguntar',
}

function paintMode(mode: PermissionMode): string {
  if (mode === 'bypassPermissions') return c.danger(strong(MODE_LABEL[mode]))
  if (mode === 'plan') return c.info(MODE_LABEL[mode])
  if (mode === 'acceptEdits') return c.warn(MODE_LABEL[mode])
  return c.dim(MODE_LABEL[mode])
}

type Block =
  | { kind: 'splash' }
  /** `pending` while the line is queued behind a running turn. */
  | { kind: 'user'; text: string; pending?: boolean }
  | { kind: 'assistant'; text: string }
  | { kind: 'thinking'; since: number }
  | {
      kind: 'tool'
      name: string
      summary: string
      /** What the call acted on — shown as `Name(subject)`. */
      subject?: string
      detail?: string
      status: 'running' | 'ok' | 'fail'
      /**
       * The tool call this line belongs to. Read-group tools run in parallel, so
       * two `Read` calls are in flight at once routinely; closing "the last
       * running block with this name" attached each result to whichever of them
       * happened to be started last.
       */
      callId?: string
      preview?: string
      expanded?: boolean
      /** Set on a finished `Agent` call: clicking the line opens that session. */
      agentId?: string
      /** Model call that asked for it; calls sharing one are drawn as one line. */
      step?: number
    }
  | { kind: 'notice'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'divider'; label: string; detail?: string }
  /** Recent-session picker shown at startup, above the composer. */
  | { kind: 'home'; sessions: SessionSummary[] }

/** One subagent: the strip row plus its own transcript, for the viewer. */
type LiveAgent = {
  id: string
  agentType: string
  label: string
  since: number
  tool?: string
  chars: number
  done: boolean
  ok: boolean
  /** Rendered with the same block renderer as the main session. */
  blocks: Block[]
  live: Block | null
}

/**
 * Soft-wraps one composer line into visual rows.
 *
 * Wrapped on a word boundary when there is one in the last third of the row, so
 * a sentence does not split mid-word; otherwise hard-split, because a long path
 * or token has no boundary and must still be readable. Never drops characters —
 * that is the whole point.
 */
export function wrapInput(line: string, width: number): string[] {
  if (line.length <= width) return [line]

  const rows: string[] = []
  let rest = line
  while (rest.length > width) {
    const slice = rest.slice(0, width)
    const space = slice.lastIndexOf(' ')
    const cut = space > Math.floor(width * 0.66) ? space + 1 : width
    rows.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  rows.push(rest)
  return rows
}

/** Numbered rows (`  12 + text`) or unified-diff markers. */
function looksLikeDiff(text: string): boolean {
  return /(^|\n)\s*(\d+ [+\- ]|[+\-@])/.test(text)
}

/** How many subagents get their own row before the strip summarises the rest. */
const AGENT_STRIP_ROWS = 5
/** Subagents whose captured output is kept for the viewer. */
/** Drawn hidden in the top-right corner; only a selection reveals it. */
const SIGNATURE = 'Desenvolvido por Abel Duarte'

const MAX_KEPT_AGENTS = 20
/** Sessions offered on the startup screen. */
const HOME_SESSIONS = 30
/** Below this width the side panel would squeeze the chat column; stack instead. */
const HOME_SPLIT_MIN_COLS = 92
const HOME_PANEL_MIN = 44
const HOME_PANEL_MAX = 72

type PickerItem = { label: string; value: string; hint?: string }

/**
 * One row of a `form` modal. `placeholder` doubles as the default: a field left
 * empty yields it, so the common provider can be added by pressing enter through
 * the form instead of retyping what the harness already assumes.
 */
type FormField = {
  name: string
  label: string
  value: string
  placeholder?: string
  hint?: string
  masked?: boolean
  /** Blank is rejected and the field cannot be skipped past on submit. */
  required?: boolean
}

/** A cell on screen. Both are 1-based, matching what SGR mouse reports send. */
type Point = { row: number; col: number }

function beforeOrEqual(a: Point, b: Point): boolean {
  return a.row < b.row || (a.row === b.row && a.col <= b.col)
}

/** Ordered ends of a selection, plus whether it covers anything at all. */
export function spanOf(sel: { anchor: Point; head: Point }): {
  start: Point
  end: Point
  empty: boolean
} {
  const forward = beforeOrEqual(sel.anchor, sel.head)
  const start = forward ? sel.anchor : sel.head
  const end = forward ? sel.head : sel.anchor
  return { start, end, empty: start.row === end.row && start.col === end.col }
}

/**
 * Column range selected on one row of a span, as [from, to) zero-based.
 * Rows between the ends are covered edge to edge.
 */
export function rowRange(
  row: number,
  start: Point,
  end: Point,
  cols: number,
): { from: number; to: number } {
  return {
    from: row === start.row ? start.col - 1 : 0,
    // The head sits *on* a cell, so that cell is part of the selection.
    to: row === end.row ? Math.min(end.col, cols) : cols,
  }
}

type Modal =
  | { kind: 'permission'; request: PermissionRequest; resolve: (ok: boolean) => void }
  | {
      kind: 'picker'
      title: string
      all: PickerItem[]
      filter: string
      index: number
      resolve: (value: string | null) => void
    }
  | {
      kind: 'input'
      title: string
      prompt: string
      detail?: string
      footer?: string
      value: string
      masked: boolean
      resolve: (value: string | null) => void
    }
  | {
      kind: 'form'
      title: string
      detail?: string
      footer?: string
      fields: FormField[]
      index: number
      /** Set by validation, shown under the fields until the next keystroke. */
      error?: string
      resolve: (values: Record<string, string> | null) => void
    }
  | { kind: 'busy'; title: string; message: string }
  /** Read-only list of what the model broke the work into. */
  | { kind: 'tasks' }
  /** Read-only list of MCP servers and what each one exposes. */
  | { kind: 'mcp' }
  /** Fork tree of this project sessions; enter opens the highlighted one. */
  | { kind: 'sessionTree'; roots: SessionNode[]; index: number }
  /** Live progress of the workflow runs, plus the scripts saved on disk. */
  | { kind: 'workflows'; saved: SavedWorkflow[] }
  | null

const BUILTIN_COMMANDS: { name: string; hint: string }[] = [
  { name: 'help', hint: 'teclas e comandos' },
  { name: 'model', hint: 'troca o modelo' },
  { name: 'models', hint: 'lista os modelos' },
  { name: 'connect', hint: 'adiciona um provider de LLM' },
  { name: 'add-provider', hint: 'declara um provider novo na config (modal)' },
  { name: 'add-model', hint: 'adiciona um modelo a um provider existente' },
  { name: 'disconnect', hint: 'remove uma credencial' },
  { name: 'auth', hint: 'lista as conexões' },
  { name: 'mode', hint: 'modo de permissão' },
  { name: 'theme', hint: 'paleta de cores' },
  { name: 'font', hint: 'testa se a fonte do terminal cobre os glifos' },
  { name: 'width', hint: 'largura da coluna (full ou N)' },
  { name: 'agent', hint: 'troca o agente ativo (tab também)' },
  { name: 'tasks', hint: 'tasks que o modelo criou (ctrl+t)' },
  { name: 'changes', hint: 'arquivos alterados na sessão (ctrl+g)' },
  { name: 'rewind', hint: 'desfaz um arquivo alterado — mesma tela, tecla r' },
  { name: 'resume', hint: 'volta para uma sessão anterior' },
  { name: 'fork', hint: 'continua daqui numa sessão nova (ctrl+s vê a árvore)' },
  { name: 'tree', hint: 'árvore de sessões e forks (ctrl+s)' },
  { name: 'sessions', hint: 'lista as sessões deste projeto' },
  { name: 'context', hint: 'uso da janela de contexto' },
  { name: 'context-all', hint: 'detalha o contexto: setup, skills, mcp, tools' },
  { name: 'leadtime', hint: 'tempo, tools e tokens do último turno' },
  { name: 'compact', hint: 'resume o histórico agora' },
  { name: 'skills', hint: 'skills carregadas' },
  { name: 'agents', hint: 'agents carregados' },
  { name: 'commands', hint: 'arquivos de comando' },
  { name: 'tools', hint: 'tools ativas e deferred' },
  { name: 'mcp', hint: 'servidores MCP' },
  { name: 'workflows', hint: 'progresso dos workflows · on/off liga e desliga' },
  { name: 'mouse', hint: 'liga/desliga captura do mouse' },
  { name: 'copy', hint: 'copia a tela inteira' },
  { name: 'keys', hint: 'mostra a sequência que cada tecla envia' },
  { name: 'reload', hint: 'recarrega os assets' },
  { name: 'clear', hint: 'zera o contexto' },
  { name: 'transcript', hint: 'caminho do transcript' },
  { name: 'exit', hint: 'sai' },
]

/**
 * "BYTECODE" in a three-row block font — the mark in the pinned header.
 * Every glyph is 3 cells wide with one cell of tracking, so `BYTE` occupies the
 * first 15 columns and the two halves can be tinted separately.
 */
const WORDMARK = [
  '█▀▄ █ █ ▀█▀ █▀▀ ▄▀▀ ▄▀▄ █▀▄ █▀▀',
  '█▀▄ ▀▄▀  █  █▀▀ █   █ █ █ █ █▀▀',
  '█▄▀  █   █  █▄▄ ▀▄▄ ▀▄▀ █▄▀ █▄▄',
]
const WORDMARK_WIDTH = Math.max(...WORDMARK.map(row => row.length))
/** Column where `CODE` starts, including the space that separates the halves. */
const WORDMARK_SPLIT = 15

/** Whimsical gerunds for the working indicator, rotated during long turns. */
const WORKING_VERBS = [
  'Garimpando',
  'Destrinchando',
  'Tricotando',
  'Fermentando',
  'Peneirando',
  'Alinhavando',
  'Decantando',
  'Lapidando',
  'Desemaranhando',
  'Orquestrando',
  'Rabiscando',
  'Serpenteando',
  'Burilando',
  'Vasculhando',
  'Amassando',
  'Costurando',
]

const TIPS = [
  'shift+tab alterna o modo de permissão',
  'clique numa tool para expandir aquela · alt+↑↓ move o foco',
  'arraste com o mouse para selecionar o trecho exato — solta e já vai pro clipboard',
  'ctrl+end volta ao fim da conversa',
  '/compact resume o histórico quando o contexto aperta',
  '/leadtime mostra tempo, tools e tokens do último turno',
  'ctrl+a foca os subagents · enter abre a sessão de um deles',
  'ctrl+y põe o diff lado a lado — antes à esquerda, depois à direita',
  'ctrl+g lista o que foi alterado na sessão, com o diff de cada arquivo',
  '/theme troca a paleta · /width full ocupa a tela toda',
  '/workflows on liga a orquestração multi-agente · /workflows mostra o progresso',
  '/keys mostra a sequência que sua tecla envia',
  'esc interrompe o turno sem matar a sessão',
  '/model abre o seletor de modelos',
]

function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

function formatCount(value: number): string {
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(1)}k`
}

export type FullscreenOptions = {
  /** Start with the recent-session list focused, as `bytecode --resume` does. */
  focusSessions?: boolean
}

export async function runFullscreenTui(
  session: Session,
  options: FullscreenOptions = {},
): Promise<void> {
  const out = process.stdout
  const blocks: Block[] = [{ kind: 'splash' }]
  const history: string[] = []

  let input = ''
  /** What was being typed before the history was walked into. */
  let draft = ''
  let historyIndex = -1
  let scroll = 0
  let busy = false
  let modal: Modal = null
  let dirty = true
  let spinner = 0
  let blinkOn = true
  let interrupts = 0
  let exiting = false
  let statusMessage = ''
  let completionIndex = 0
  let themeVersion = 0
  let maxScroll = 0
  let keyEcho = false
  let mouseEnabled = true
  // View preference, not content: it applies to every diff on screen, so the same
  // keystroke means the same thing wherever the eye happens to be.
  let diffLayout: DiffLayout = 'unified'
  // Anchor is where the drag started, head is where the pointer is now — either
  // can be the earlier point, so every read normalises them first.
  let selection: { anchor: Point; head: Point } | null = null
  let selecting = false
  let pasting = false
  /**
   * Bracketed paste arrives as a burst of key events. They are collected here
   * instead of going straight into the composer, so the whole paste can be
   * measured *before* anything is drawn — a 4000-line log used to be appended
   * one character at a time, redrawing the screen for each one.
   */
  let pasteBuffer = ''
  /** An escape sequence the last stdin read cut in half. */
  let pendingKeys = ''
  let pendingKeyTimer: NodeJS.Timeout | undefined
  const keyDecoder = new StringDecoder('utf8')
  const attachments = new AttachmentStore()
  let busySince = 0
  let busyChars = 0
  let busyTokens = 0
  let verbSeed = Math.floor(Math.random() * WORKING_VERBS.length)
  let tipSeed = Math.floor(Math.random() * TIPS.length)
  let liveAssistant: Block | null = null
  /** Body rows the last frame had, so a scrolled-back view can stay anchored. */
  let lastViewportTotal = 0
  /** Points kept for the context sparkline; it draws the last seven. */
  const MAX_USAGE_TRAIL = 64
  const usageTrail: number[] = []
  /**
   * Every subagent of this session, running and finished. Kept past the end of
   * the turn so the transcript line stays clickable — the point of that line is
   * to be read *after* the agent is done.
   */
  const agents = new Map<string, LiveAgent>()
  /** Highlighted row of the startup session list; -1 when nothing is selected. */
  let homeIndex = -1
  /**
   * Session search text, or null when the search is not active.
   *
   * It used to be the composer's own text, which meant one keystroke appeared in
   * two places at once and the screen looked like it had two input fields. The
   * search is now its own field, entered with ctrl+f, so exactly one thing has a
   * cursor at any moment.
   */
  let homeSearch: string | null = null
  /** Highlighted row of the subagent strip; -1 when the strip has no focus. */
  let agentIndex = -1
  /** Id of the subagent whose session is open, replacing the main transcript. */
  let viewingAgent: string | null = null
  // The changes screen is a view over the session, not a mode: opening it does
  // not pause the turn, drop the context, or touch a running subagent.
  let viewingChanges = false
  let changesIndex = 0
  /** First visible row of the file list; it follows the selection. */
  let listScroll = 0
  /** Body rows each block occupies in the frame just drawn, for click targeting. */
  const blockRows: { index: number; from: number; to: number }[] = []
  /** Row of the body inside the frame, so a screen row maps to a body row. */
  let bodyTop = 0
  /** Row of the subagent strip's header, and the agents drawn under it. */
  let stripTop = 0
  let strip: LiveAgent[] = []
  /** Block the expand shortcut acts on. Null means "the last tool", as before. */
  let focusedTool: number | null = null
  /** Blocks already on screen for lines waiting behind the running turn, in order. */
  const queuedLines: Block[] = []

  let gitBranch: string | null = null
  readGitBranch(session.cwd, branch => {
    gitBranch = branch
    dirty = true
  })
  const startedAt = Date.now()

  /**
   * A new block does not move the view.
   *
   * `scroll` is the distance from the bottom, so a reader who has not scrolled
   * is already following the tail and needs nothing done. One who *has* scrolled
   * back was yanked to the bottom by every arriving block — which, during a
   * streaming turn, made the scrollback impossible to read at all. Jumping to
   * the bottom is what the explicit `scroll = 0` on submit and ctrl+end is for.
   */
  function push(block: Block): void {
    blocks.push(block)
    dirty = true
  }

  /**
   * Runs a handler whose result nobody awaits, reporting a failure instead of
   * letting it escape.
   *
   * A rejected promise from a key handler reached the process-level handler,
   * which writes a stack trace to stderr — straight over the alt screen, with
   * the frame differ still believing it knows what is on it.
   */
  function detach(work: () => Promise<unknown>): void {
    work().catch((err: unknown) => {
      push({ kind: 'error', text: describeError(err) })
      dirty = true
    })
  }

  const say = (text: string) => push({ kind: 'notice', text })

  function homeBlock(): { kind: 'home'; sessions: SessionSummary[] } | null {
    const found = blocks.find(b => b.kind === 'home')
    return found?.kind === 'home' ? found : null
  }

  function dropStartupBlocks(): void {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === 'splash' || blocks[i].kind === 'home') blocks.splice(i, 1)
    }
    homeIndex = -1
    homeSearch = null
  }

  /** Rebuilds a readable transcript from a restored message array. */
  function blocksFromMessages(messages: ModelMessage[]): Block[] {
    const out: Block[] = []
    for (const message of messages) {
      if (message.role === 'user') {
        const text = visibleUserText(message)
        if (text) out.push({ kind: 'user', text })
        continue
      }
      if (message.role !== 'assistant') continue
      const content = message.content
      const text =
        typeof content === 'string'
          ? content
          : (content as { type: string; text?: string }[])
              .filter(part => part.type === 'text')
              .map(part => part.text ?? '')
              .join('')
      if (text.trim()) out.push({ kind: 'assistant', text: text.trim() })
    }
    return out
  }

  async function resumeSession(idOrPrefix: string): Promise<boolean> {
    let state
    try {
      state = await loadSession(session.config, session.cwd, idOrPrefix)
    } catch (err) {
      push({ kind: 'error', text: String(err) })
      return false
    }
    if (!state) {
      push({ kind: 'error', text: `sessão "${idOrPrefix}" não encontrada neste projeto` })
      return false
    }

    session.resumeFrom(state)
    blocks.length = 0
    // The focus is an index into `blocks`; keeping it across a replacement would
    // silently point ctrl+r at an unrelated block.
    focusedTool = null
    blocks.push(...blocksFromMessages(state.messages))
    blocks.push({
      kind: 'divider',
      label: 'sessão retomada',
      detail: `#${state.id.slice(0, 8)} ${g.sep} ${state.messages.length} mensagens ${g.sep} ${session.modelRef}`,
    })

    liveAssistant = null
    homeIndex = -1
    scroll = 0
    statusMessage = `retomada #${state.id.slice(0, 8)} — o modo de permissão continua ${MODE_LABEL[session.mode]}`
    dirty = true
    return true
  }

  /**
   * A click activates whatever is under it: a session row resumes, a tool row
   * expands. Anything else does nothing — and in no case is the clipboard touched.
   */
  function activateRowAt(row: number): boolean {
    // The live strip first: it sits below everything and its rows are the only
    // place a *running* agent can be reached by mouse.
    const inStrip = row - 1 - stripTop - 1
    if (inStrip >= 0 && inStrip < strip.length) {
      openAgent(strip[inStrip])
      return true
    }

    const home = homeBlock()
    if (home) {
      const match = frameRow(row, layout().cols).match(/#([0-9a-f]{8})\b/i)
      if (!match) return false
      const index = home.sessions.findIndex(s => s.short === match[1].toLowerCase())
      if (index < 0) return false
      homeIndex = index
      dirty = true
      detach(() => resumeSession(home.sessions[index].id))
      return true
    }

    // Only the hint itself toggles the diff layout. Treating "the block contains
    // a diff" as the target meant clicking any line of a long answer — prose
    // included — silently reflowed the diff further down.
    if (frameRow(row, layout().cols).includes('ctrl+y')) {
      toggleDiffLayout()
      return true
    }

    const target = blockAtRow(row)
    if (target === null) return false
    const block = blocks[target]
    if (block?.kind !== 'tool') return false

    // A finished subagent opens its session instead of expanding a preview —
    // reading what it actually did is the reason the line is there.
    if (block.agentId) {
      const agent = agents.get(block.agentId)
      if (agent) {
        openAgent(agent)
        return true
      }
    }
    if (!block.preview) return false
    toggleTool(target)
    return true
  }

  /**
   * Layout plus the hint that advertises the toggle. The hint is dropped when the
   * column is too narrow for two columns — offering a view that will not render
   * is worse than not mentioning it.
   */
  function diffOptions(width: number): { layout: DiffLayout; hint?: string } {
    if (width < SPLIT_MIN_WIDTH) return { layout: 'unified' }
    return {
      layout: diffLayout,
      hint: diffLayout === 'split' ? 'ctrl+y agrupado' : 'ctrl+y lado a lado',
    }
  }

  function toggleDiffLayout(): void {
    diffLayout = diffLayout === 'split' ? 'unified' : 'split'
    const narrow = layout().width < SPLIT_MIN_WIDTH
    statusMessage =
      diffLayout === 'split'
        ? narrow
          ? `lado a lado precisa de ${SPLIT_MIN_WIDTH} colunas — seguindo agrupado`
          : 'diff lado a lado — antes à esquerda, depois à direita'
        : 'diff agrupado'
    dirty = true
  }

  // ---------------------------------------------------------------- rendering

  function layout(): { cols: number; rows: number; width: number; indent: string } {
    const cols = Math.max(MIN_WIDTH, out.columns ?? 80)
    const rows = Math.max(12, out.rows ?? 24)
    // Fill the terminal by default; a configured cap centres the column instead.
    // The cap has the same floor as the terminal: a column narrower than this
    // holds no readable row, and a config file could ask for one.
    const cap = session.config.ui?.maxWidth
    const width = cap && cap > 0 ? Math.min(cols, Math.max(MIN_WIDTH, cap)) : cols
    const indent = ' '.repeat(Math.max(0, Math.floor((cols - width) / 2)))
    return { cols, rows, width, indent }
  }

  function frameLines(): string[] {
    const { cols, rows, width, indent } = layout()

    const completions = currentCompletions()
    // The composer grows with pasted lines and the working indicator, so it is
    // measured rather than predicted.
    const composerLines = composer(width - 2, completions)
    const head = headerLines(width - 2)
    // The strip sits *under* the composer: the prompt stays put while agents
    // come and go, instead of the input jumping every time one starts.
    const agentLines = agentStrip(width - 2)
    // Two blank lines between the header bar and the first block — one reads as
    // a rendering accident, two reads as deliberate space.
    const headGap = modal ? 0 : 2
    const viewportHeight = Math.max(
      3,
      rows - head.length - composerLines.length - agentLines.length - headGap - 1,
    )

    const home = !modal && !busy && !viewingAgent && !viewingChanges ? homeBlock() : null
    const open = viewedAgent()
    const body = modal
      ? renderModal(modal, width, viewportHeight)
      : viewingChanges
        ? changesViewport(width - 2, viewportHeight).map(l => ` ${l}`)
        : open
          ? agentViewport(open, width - 2, viewportHeight).map(l => ` ${l}`)
          : home
            ? homeScreen(width - 2, viewportHeight).map(l => ` ${l}`)
            : renderViewport(width - 2, viewportHeight).map(l => ` ${l}`)

    bodyTop = head.length + headGap
    // First row of the strip's *header*; the agents start one row below it.
    stripTop = head.length + headGap + body.length + composerLines.length
    const lines = [
      // No background behind the header: the wordmark is solid block glyphs, and
      // a bar behind them read as a grey patch around the logo.
      ...head.map(l => pad(` ${l}`, width)),
      ...Array.from({ length: headGap }, () => ''),
      ...body,
      // Built one column narrower because each line carries a leading space;
      // at full width the extra column would be truncated off the right border.
      ...composerLines.map(l => ` ${l}`),
      ...agentLines.map(l => ` ${l}`),
      barLine(pad(` ${status(width - 2)}`, width)),
    ].map(line => indent + line)

    while (lines.length < rows) lines.splice(lines.length - 1, 0, '')

    // Signature in the far top-right, drawn to be unseen: it is in the buffer,
    // so selecting that row reveals and copies it, and it costs the layout
    // nothing because it only goes in when the row has the columns to spare.
    // Measured on the *content*, not on the row: the header is already padded to
    // the full width, so asking "does the row have room" always answered no.
    // One column of slack on the right. Flush against the last cell, the final
    // letter only came out if the drag ended exactly on it — the head selects
    // *up to* its own cell, and that cell is the hardest one on the row to hit,
    // on text that is invisible by design. It came back as "Abel Duart".
    const first = (lines[0] ?? '').replace(/[ ]+$/, '')
    if (visibleWidth(first) + SIGNATURE.length + 3 <= cols) {
      lines[0] = `${pad(first, cols - SIGNATURE.length - 1)}${hidden(SIGNATURE)}`
    }

    // `oneLine` last: a stray control character anywhere upstream would move the
    // cursor mid-row and desynchronise every row below it.
    return lines.slice(0, rows).map(l => truncate(oneLine(l), cols))
  }

  /**
   * The wordmark is pinned in the header instead of living in the transcript,
   * where the first message would scroll it away. Terminals too short to spare
   * three rows fall back to the single identity line.
   */
  function headerLines(width: number): string[] {
    const branch = gitBranch ? `${c.faint(` ${g.sep} `)}${c.meta(`${g.git} ${gitBranch}`)}` : ''
    const limit = contextLimit(session)

    // Short terminals, and narrow ones where the mark would leave no room for
    // anything beside it, get the one-line identity instead.
    if ((out.rows ?? 24) < 26 || width < WORDMARK_WIDTH + 20) {
      const left = `${c.accent(strong('ByteCode'))}${c.faint(` ${g.sep} `)}${c.info(session.modelRef)}`
      return [split(left, c.dim(path.basename(session.cwd)) + branch, width)]
    }

    // The mark spells the name, so the text column carries version and context
    // rather than repeating it.
    const right = [
      `${c.faint('v0.1')}${c.faint(`  ${g.sep}  `)}${c.dim('multi-provider agent harness')}`,
      `${c.info(session.modelRef)}${limit ? c.faint(`  ${g.sep}  ${Math.round(limit / 1000)}k ctx`) : ''}`,
      `${c.dim(session.cwd)}${branch}`,
    ]
    return WORDMARK.map((art, i) => {
      const row = pad(art, WORDMARK_WIDTH)
      const mark = c.accent(row.slice(0, WORDMARK_SPLIT)) + c.dim(row.slice(WORDMARK_SPLIT))
      // Truncate rather than overflow: a long cwd would wrap and push the whole
      // layout down by a row.
      return truncate(`${mark}   ${right[i]}`, width)
    })
  }

  function status(width: number): string {
    const used = contextTokens(session)
    const limit = contextLimit(session)
    const fraction = limit ? used / limit : 0
    const pctText = limit ? `${Math.round(fraction * 100)}%` : `${used}t`
    const pct = fraction >= 0.85 ? c.danger(pctText) : fraction >= 0.5 ? c.warn(pctText) : c.ok(pctText)
    const trail = usageTrail.length > 1 ? ` ${c.faint(sparkline(usageTrail.slice(-7)))}` : ''
    const todos = getTodos(session)
    const openTodos = todos.filter(t => t.status !== 'completed').length
    const agentName = session.primaryAgent?.name ?? 'build'

    // Each key sits next to the thing it opens or changes. Cheaper than making
    // someone find the shortcut in /help, and it doubles as the task counter.
    const tasks =
      todos.length === 0
        ? c.faint('tasks(0)')
        : openTodos > 0
          ? c.warn(`tasks(${todos.length})`)
          : c.ok(`tasks(${todos.length})`)

    // A server left `enabled: false` is not a failure, so it stays out of the
    // ratio — otherwise an inherited-but-disabled server reads as broken.
    const servers = session.mcp.status().filter(s => !s.disabled)
    const mcp = servers.filter(s => s.connected).length
    const mcpLabel =
      servers.length === 0
        ? c.faint('mcp(0)')
        : mcp === servers.length
          ? c.ok(`mcp(${mcp})`)
          : c.warn(`mcp(${mcp}/${servers.length})`)

    // Only shown once something was written: an always-there `alt(0)` would be
    // one more thing competing for the bar with nothing to say.
    const changes = changedFiles(session).length
    const changed = changes > 0 ? c.faint('ctrl+g ') + c.meta(`alterações(${changes})`) + c.faint(` ${g.sep} `) : ''

    // "Onde estou" tem de estar visível sem abrir nada: numa sessão raiz isto
    // diz (main); num fork, o id curto — que é o que distingue duas telas com a
    // mesma conversa até o ponto da bifurcação.
    const sessionLabel = session.forkedFrom
      ? c.warn(`fork(#${session.transcript.sessionId.slice(0, 8)})`)
      : c.faint('(main)')

    const left =
      c.faint('shift+tab ') +
      paintMode(session.mode) +
      c.faint(` ${g.sep} `) +
      c.faint('tab ') +
      c.meta(agentName) +
      c.faint(` ${g.sep} `) +
      c.faint('ctrl+t ') +
      tasks +
      c.faint(` ${g.sep} `) +
      changed +
      c.faint('ctrl+p ') +
      mcpLabel +
      c.faint(` ${g.sep} `) +
      c.faint('ctrl+s ') +
      sessionLabel +
      c.faint(` ${g.sep} `) +
      c.dim('ctx ') +
      pct +
      trail

    const right = scroll > 0
      ? c.warn(`rolado ${scroll} linhas`) + c.faint(` ${g.sep} ctrl+end volta ao fim`)
      : busy
        ? c.warn(statusMessage || 'trabalhando') + c.faint(` ${g.sep} esc interrompe`)
        : statusMessage
          ? c.warn(statusMessage)
          : c.faint('/help')

    return split(left, right, width)
  }

  // Rendering a block is the expensive part (wrapping + markdown), and during
  // streaming only the tail block changes. Caching by a cheap signature keeps a
  // frame at O(changed blocks) instead of O(whole transcript).
  const blockCache = new WeakMap<object, { sig: string; lines: string[] }>()

  function blockSignature(block: Block, width: number, list: Block[] = blocks): string {
    const frame = spinner % g.spinner.length
    // Cached lines carry their colours **and their layout**, so a palette change
    // or a diff-layout toggle must invalidate all of them; both ride in every
    // signature. Without the layout, `ctrl+y` flipped the state and the screen
    // kept serving the lines rendered before it.
    width = width + themeVersion * 100_000 + (diffLayout === 'split' ? 1_000_000 : 0)
    switch (block.kind) {
      case 'splash':
        return `s|${width}|${session.modelRef}|${session.mode}`
      case 'user':
        return `u|${width}|${block.text.length}|${block.pending ? 1 : 0}`
      case 'assistant':
        return `a|${width}|${block.text.length}`
      case 'thinking':
        return `k|${width}|${frame}|${Math.round((Date.now() - block.since) / 1000)}`
      case 'tool': {
        // The fold depends on the neighbours, so it belongs in the key — without
        // it a run that grew by one call would redraw from cache as the old count.
        const fold = foldOf(block, list)
        return `t|${width}|${block.subject ?? block.summary}|${block.detail ?? ''}|${block.status}|${
          block.expanded ? 1 : 0
        }|${focusedTool !== null && blocks[focusedTool] === block ? 1 : 0}|${
          block.preview?.length ?? 0
        }|${(fold?.status ?? block.status) === 'running' ? frame : 0}|${
          fold ? `${fold.last ? 'l' : 'h'}${fold.count}${fold.status ?? ''}${fold.label ?? ''}` : ''
        }`
      }
      case 'notice':
        return `n|${width}|${block.text.length}`
      case 'error':
        return `e|${width}|${block.text.length}`
      case 'divider':
        return `d|${width}|${block.label}|${block.detail ?? ''}`
      case 'home':
        return `h|${width}|${block.sessions.length}|${homeIndex}`
    }
  }

  function renderCached(block: Block, width: number, list: Block[] = blocks): string[] {
    const sig = blockSignature(block, width, list)
    const hit = blockCache.get(block as object)
    if (hit && hit.sig === sig) return hit.lines
    const lines = renderBlock(block, width, list)
    blockCache.set(block as object, { sig, lines })
    return lines
  }

  /** Consecutive calls to the same tool from which the list starts folding. */
  const FOLD_FROM = 4

  type Fold = {
    last: boolean
    count: number
    /** Present on a batch fold: the sentence that replaces `Name(subject)`. */
    label?: string
    /** Outcome of the whole batch, when the fold covers one. */
    status?: 'running' | 'ok' | 'fail'
  }

  /**
   * Extent of a run of tool blocks around `at`, under a predicate on neighbours.
   */
  function runAround(
    list: Block[],
    at: number,
    same: (a: Extract<Block, { kind: 'tool' }>) => boolean,
  ): { start: number; end: number } {
    let start = at
    while (start > 0) {
      const prev = list[start - 1]
      if (prev.kind !== 'tool' || !same(prev)) break
      start--
    }
    let end = at
    while (end + 1 < list.length) {
      const next = list[end + 1]
      if (next.kind !== 'tool' || !same(next)) break
      end++
    }
    return { start, end }
  }

  /** Someone is looking inside this run, so it stays open. */
  function opened(list: Block[], start: number, end: number): boolean {
    for (let i = start; i <= end; i++) {
      const b = list[i]
      if (b.kind !== 'tool') continue
      if (b.expanded) return true
      if (list === blocks && focusedTool !== null && blocks[focusedTool] === b) return true
    }
    return false
  }

  /**
   * How a batch of calls is described in one line. The model fired them in a
   * single decision, so they read as one action: "buscando 1 padrão, lendo 3
   * arquivos e rodando 1 comando".
   */
  const BATCH_WORDS: Record<string, { verb: string; one: string; many: string }> = {
    Grep: { verb: 'buscando', one: 'padrão', many: 'padrões' },
    Glob: { verb: 'procurando', one: 'arquivo', many: 'arquivos' },
    Read: { verb: 'lendo', one: 'arquivo', many: 'arquivos' },
    LS: { verb: 'listando', one: 'diretório', many: 'diretórios' },
    Bash: { verb: 'rodando', one: 'comando', many: 'comandos' },
    BashOutput: { verb: 'lendo', one: 'job', many: 'jobs' },
    Write: { verb: 'escrevendo', one: 'arquivo', many: 'arquivos' },
    Edit: { verb: 'editando', one: 'arquivo', many: 'arquivos' },
    WebFetch: { verb: 'buscando', one: 'página', many: 'páginas' },
    TodoWrite: { verb: 'atualizando', one: 'task', many: 'tasks' },
    Agent: { verb: 'rodando', one: 'subagente', many: 'subagentes' },
  }

  function batchLabel(names: string[]): string {
    // Order of first appearance: it is the order the model wrote the calls in,
    // and reordering would invent a sequence that never happened.
    const counted: { name: string; n: number }[] = []
    for (const name of names) {
      const seen = counted.find(c => c.name === name)
      if (seen) seen.n++
      else counted.push({ name, n: 1 })
    }
    const parts = counted.map(({ name, n }) => {
      const words = BATCH_WORDS[name]
      // An MCP tool or anything else unknown keeps its own name: inventing a
      // verb for it would describe the wrong thing.
      if (!words) return n === 1 ? name : `${n} × ${name}`
      return `${words.verb} ${n} ${n === 1 ? words.one : words.many}`
    })
    if (parts.length === 1) return parts[0]
    return `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}`
  }

  /**
   * One line in place of several, in two shapes.
   *
   * **Batch** — calls the model asked for in the *same* step. It decided once,
   * so it reads as one action, and it folds while still running: watching four
   * lines appear and then collapse is worse than one line that was always one.
   *
   * **Run** — consecutive calls to the same tool across *different* steps. A
   * model hunting for a file fires eight `Glob`s one after another, each after
   * seeing the last result; eight lines saying "No files matched" bury the one
   * thing that mattered.
   *
   * The blocks are kept as they are — only the drawing folds — so `ctrl+r` still
   * reaches any single call, and the fold breaks as soon as one is focused or
   * expanded: someone looking inside the run wants to see the run.
   */
  /**
   * `list.indexOf(block)`, without the scan.
   *
   * `foldOf` runs for every tool block of every frame, and the frame is rebuilt
   * on every streamed chunk — so a linear search per block made drawing a long
   * transcript quadratic in the number of blocks, at exactly the moment the
   * transcript is longest and the UI busiest.
   */
  let indexedList: Block[] | null = null
  let indexedAt = new Map<Block, number>()

  function indexIn(list: Block[], block: Block): number {
    if (indexedList !== list || indexedAt.size !== list.length) {
      indexedAt = new Map(list.map((b, i) => [b, i] as const))
      indexedList = list
    }
    return indexedAt.get(block) ?? -1
  }

  function foldOf(block: Block, list: Block[] = blocks): Fold | null {
    if (block.kind !== 'tool') return null
    const at = indexIn(list, block)
    if (at === -1) return null

    if (block.step !== undefined) {
      const step = block.step
      const { start, end } = runAround(list, at, b => b.step === step)
      const count = end - start + 1
      if (count >= 2 && !opened(list, start, end)) {
        const members = list.slice(start, end + 1) as Extract<Block, { kind: 'tool' }>[]
        // The whole batch carries one outcome: still going, or something in it
        // failed, or all of it worked.
        const status = members.some(b => b.status === 'running')
          ? ('running' as const)
          : members.some(b => b.status === 'fail')
            ? ('fail' as const)
            : ('ok' as const)
        return { last: at === end, count, label: batchLabel(members.map(b => b.name)), status }
      }
    }

    const { start, end } = runAround(list, at, b => b.name === block.name)
    const count = end - start + 1
    // Judgement call, stated as one: the value of a line per call falls as the
    // run grows. Three `Read`s of three files are a narrative — which files were
    // opened, in what order. Eight `Glob`s that all missed are noise. Four is
    // where one turns into the other.
    if (count < FOLD_FROM) return null

    for (let i = start; i <= end; i++) {
      const b = list[i]
      if (b.kind !== 'tool') continue
      // A run spans several model calls, so one of them is still in flight while
      // the rest are done: folding then would hide the only live line.
      if (b.status === 'running') return null
    }
    if (opened(list, start, end)) return null
    // The *last* block draws the fold, not the first: `ctrl+r` with nothing
    // focused acts on the last expandable tool, so this way the line you see and
    // the line the key acts on are the same block.
    return { last: at === end, count }
  }

  /** A blank line separates blocks, except between adjacent tool calls. */
  function gapBefore(i: number): number {
    if (i === 0) return 0
    return blocks[i - 1].kind === 'tool' && blocks[i].kind === 'tool' ? 0 : 1
  }

  /**
   * Measuring and slicing are separate on purpose. The total line count has to
   * cover the whole transcript — otherwise the scroll range is capped at
   * whatever the last pass happened to collect — while the concatenation, which
   * is the expensive half, only touches the blocks inside the window.
   */
  /**
   * Live subagents, pinned just above the composer.
   *
   * A subagent's own tool calls deliberately never enter the transcript: a
   * fan-out of ten agents would bury the conversation it was meant to serve.
   * They live here while they run and vanish when they return, leaving only the
   * one `Agent` line the parent already logs.
   */
  function agentStrip(width: number): string[] {
    const running = agentList()
    if (running.length === 0) {
      strip = []
      return []
    }

    const shown = running.slice(0, AGENT_STRIP_ROWS)
    const hidden = running.length - shown.length
    // Recorded so a click can be mapped back to the agent on that row.
    strip = shown

    const header = split(
      c.faint(`  subagents ${g.sep} ${running.length} rodando`),
      c.faint(
        [hidden > 0 ? `+${hidden}` : '', viewingAgent ? 'esc volta' : 'ctrl+a foca'].filter(Boolean).join(` ${g.sep} `),
      ),
      width,
    )

    const rows = shown.map((agent, i) => {
      const focused = i === agentIndex
      const open = agent.id === viewingAgent
      const secs = Math.max(1, Math.round((Date.now() - agent.since) / 1000))
      const mark = c.info(g.spinner[spinner % g.spinner.length])
      const marker = focused ? c.accent(g.prompt) : open ? c.accent(g.railThick) : ' '
      const what = agent.tool ? c.dim(agent.tool) : c.faint('pensando')
      const name = focused || open ? strong(agent.agentType) : c.meta(agent.agentType)
      const left = `${marker} ${mark} ${name} ${c.faint(g.sep)} ${truncate(agent.label, Math.max(8, width - 46))}`
      const right = `${what} ${c.faint(`${g.sep} ${secs}s`)}${
        agent.chars > 0 ? c.faint(` ${g.sep} ${formatTokens(agent.chars)} ch`) : ''
      }`
      const row = pad(truncate(split(left, right, width), width), width)
      return focused ? selected(row) : row
    })

    return [header, ...rows]
  }

  /** The open subagent's own session, in place of the main transcript. */
  function agentViewport(agent: LiveAgent, width: number, height: number): string[] {
    const title = split(
      `${c.accent(g.railThick)} ${strong(agent.agentType)} ${c.faint(g.sep)} ${c.dim(agent.label)}`,
      c.faint(
        `${agent.done ? (agent.ok ? 'terminou' : 'falhou') : 'rodando'} ${g.sep} esc volta`,
      ),
      width,
    )

    const rendered: string[] = []
    // A mesma dobra da sessão principal, sobre a lista do subagente: um agente
    // caçando arquivo dispara a mesma rajada, e a tela dele é ainda mais estreita.
    for (const block of agent.blocks) {
      rendered.push(...renderCached(block, width - 2, agent.blocks).map(l => ` ${l}`))
    }
    if (rendered.length === 0) rendered.push(c.faint('  (ainda sem saída)'))

    const body = [title, c.rule(g.boxH.repeat(width)), ...rendered]
    maxScroll = Math.max(0, body.length - height)
    if (scroll > maxScroll) scroll = maxScroll
    const end = body.length - scroll
    const window = body.slice(Math.max(0, end - height), end)
    return [...window, ...Array.from({ length: Math.max(0, height - window.length) }, () => '')]
  }

  /**
   * The changes screen: files on the left, the diff of the selected one on the
   * right. It is a **view**, not a mode — the turn keeps running, subagents keep
   * working, and nothing about the session is touched by opening it.
   */
  function changesViewport(width: number, height: number): string[] {
    const changes = changedFiles(session)
    const groups = groupByDirectory(changes, session.cwd)
    if (changes.length === 0) {
      return [
        `${c.accent(g.railThick)} ${strong('alterações')}`,
        '',
        `  ${c.faint('nenhum arquivo alterado nesta sessão ainda')}`,
        '',
        `  ${c.faint('Write e Edit entram aqui — inclusive os de um subagent')}`,
      ]
    }

    if (changesIndex >= changes.length) changesIndex = changes.length - 1
    const current = changes[changesIndex]

    // The file pane takes a third, capped: past that it is whitespace, and the
    // diff is what the screen exists for.
    const listWidth = Math.max(22, Math.min(38, Math.floor(width / 3)))
    const diffWidth = width - listWidth - 3

    const list: string[] = []
    let selectedRow = 0
    for (const group of groups) {
      list.push(group.dir ? c.faint(truncate(group.dir, listWidth)) : c.faint('.'))
      for (const { change, name } of group.files) {
        const stats = changeStats(change)
        const isSelected = change.file === current.file
        // Origin only when a subagent is involved: tagging everything `main`
        // would be a column of the same word.
        const authors = change.by.filter(who => who !== 'main')
        const origin = authors.length > 0 ? `${c.meta(authors.join('+'))} ` : ''
        const counts = `${origin}${c.ok(`+${stats.added}`)} ${c.danger(`-${stats.removed}`)}`
        const label = `${isSelected ? c.accent(g.prompt) : ' '} ${
          isSelected ? strong(name) : c.fg(name)
        }`
        const row = pad(split(label, `${counts} `, listWidth), listWidth)
        if (isSelected) selectedRow = list.length
        list.push(isSelected ? selected(row) : row)
      }
      list.push('')
    }

    const label = path.relative(session.cwd, current.file) || path.basename(current.file)
    const diff = renderDiff(
      unifiedDiff(current, label.startsWith('..') ? current.file : label),
      diffWidth,
      diffOptions(diffWidth),
    )

    const header = split(
      `${c.accent(g.railThick)} ${strong('alterações')} ${c.faint(`${g.sep} ${changesIndex + 1} de ${changes.length} arquivo${changes.length === 1 ? '' : 's'}`)}`,
      c.faint(`↑↓ arquivo ${g.sep} ctrl+y layout ${g.sep} r desfaz ${g.sep} esc volta`),
      width,
    )

    const bodyHeight = Math.max(1, height - 2)
    maxScroll = Math.max(0, diff.length - bodyHeight)
    if (scroll > maxScroll) scroll = maxScroll
    const start = Math.max(0, Math.min(maxScroll, maxScroll - scroll))
    const window = diff.slice(start, start + bodyHeight)

    // The list follows the selection instead of always starting at the top: with
    // 47 changed files the selected row sat below the fold, so `↑↓` moved
    // something that was not on screen. One row of margin on each side keeps the
    // neighbours visible, which is what makes the movement readable.
    const margin = 1
    let listTop = listScroll
    if (selectedRow - margin < listTop) listTop = selectedRow - margin
    if (selectedRow + margin >= listTop + bodyHeight) listTop = selectedRow + margin - bodyHeight + 1
    listTop = Math.max(0, Math.min(listTop, Math.max(0, list.length - bodyHeight)))
    listScroll = listTop

    const rows: string[] = [header, c.rule(g.boxH.repeat(width))]
    for (let i = 0; i < bodyHeight; i++) {
      const left = pad(list[listTop + i] ?? '', listWidth)
      const right = window[i] ?? ''
      rows.push(`${left} ${c.rule(g.boxV)} ${right}`)
    }
    return rows
  }

  function homeFilter(): string {
    return (homeSearch ?? '').trim().toLowerCase()
  }

  function searching(): boolean {
    return homeSearch !== null && Boolean(homeBlock())
  }

  function homeMatches(): SessionSummary[] {
    const home = homeBlock()
    if (!home) return []
    const term = homeFilter()
    if (!term) return home.sessions
    return home.sessions.filter(s => `${s.title} ${s.short}`.toLowerCase().includes(term))
  }

  /** Only one caret at a time: the composer's goes quiet while the search owns it. */
  function composerCursor(): string {
    if (searching() || busy) return ''
    return blinkOn ? c.accent(g.cursor) : ' '
  }

  /** Stacked variant, for terminals too narrow for a side panel. */
  function renderHome(sessions: SessionSummary[], width: number): string[] {
    const matches = homeMatches()
    const title = split(
      c.faint(`  sessões recentes ${g.sep} ${matches.length} de ${sessions.length}`),
      c.rule('↑↓ navega · enter abre · ctrl+f busca'),
      width,
    )
    return [title, ...sessionRows(matches, width, 8)]
  }

  function sessionRows(matches: SessionSummary[], width: number, limit: number): string[] {
    if (matches.length === 0) {
      return [c.faint(`  nenhuma sessão casa com "${homeFilter()}"`)]
    }
    // The window follows the selection. Fixed at the first `limit` rows, the
    // highlight vanished as soon as `↓` walked past the last visible one — and
    // enter then opened a session that was not on screen.
    const start =
      homeIndex < limit
        ? 0
        : Math.max(0, Math.min(homeIndex - limit + 1, Math.max(0, matches.length - limit)))
    return matches.slice(start, start + limit).map((s, offset) => {
      const i = start + offset
      const active = i === homeIndex
      const marker = active ? c.accent(`${g.prompt} `) : '  '
      const id = c.faint(`#${s.short}`)
      // The meta column is fixed width so only the title is ever clipped — a
      // truncated "há 37 m…" tells the reader nothing.
      const when = formatWhen(s.updated)
      const meta = pad(`${c.dim(`${s.turns}t`)} ${c.faint(g.sep)} ${c.info(when)}`, 18)
      const titleRoom = Math.max(8, width - 18 - 13)
      const label = active ? strong(truncate(s.title, titleRoom)) : c.fg(truncate(s.title, titleRoom))
      const row = pad(truncate(split(`${marker}${id} ${label}`, meta, width), width), width)
      return active ? selected(row) : row
    })
  }

  /**
   * Startup screen: the conversation column sits in the middle of the screen and
   * the sessions live in their own drawn window on the right. The first message —
   * or opening a session — drops it and the normal transcript layout takes over.
   */
  function homeScreen(width: number, height: number): string[] {
    const home = homeBlock()
    if (!home) return []

    const panelWidth = Math.min(HOME_PANEL_MAX, Math.max(HOME_PANEL_MIN, Math.floor(width * 0.42)))
    const split = width >= HOME_SPLIT_MIN_COLS
    const leftWidth = split ? width - panelWidth - 2 : width

    // Anything that happened before the first message — a `/theme` confirmation,
    // an error, a permission notice — still has to be visible, or the startup
    // screen would swallow the feedback for its own commands.
    const feedback: string[] = []
    for (const block of blocks) {
      if (block.kind === 'splash' || block.kind === 'home') continue
      feedback.push('', ...renderCached(block, leftWidth))
    }

    const content = [
      ...renderSplash(leftWidth),
      ...feedback,
      ...(split ? [] : ['', ...renderHome(home.sessions, leftWidth)]),
    ]
    // Anchored to the top, right under the wordmark: what is loaded belongs next
    // to the identity, not floating in the middle of an empty screen.
    const left =
      content.length >= height
        ? content.slice(content.length - height)
        : [...content, ...Array.from({ length: height - content.length }, () => '')]

    if (!split) return left
    const right = sessionsPanel(home.sessions, panelWidth, height)
    return left.map((line, i) => `${pad(line, leftWidth)}  ${right[i] ?? ''}`)
  }

  function sessionsPanel(sessions: SessionSummary[], width: number, height: number): string[] {
    const matches = homeMatches()
    const term = homeFilter()
    const inner = width - 4

    const rows = sessionRows(matches, inner, Math.max(1, height - 7))
    // The search line only carries a prompt and a cursor while it is the active
    // field; otherwise it is a hint, so there is never a second blinking caret.
    const searchLine = searching()
      ? `${c.accent(g.prompt)} ${strong(homeSearch ?? '')}${blinkOn ? c.accent(g.cursor) : ' '}` +
        c.faint(` ${g.sep} ${matches.length} de ${sessions.length}`)
      : c.faint(`ctrl+f busca ${g.sep} ${sessions.length} salvas`)

    const body: string[] = [
      searchLine,
      c.rule(g.subRule.repeat(inner)),
      ...rows,
      '',
      c.faint(`${g.sep} ↑↓ navega · enter abre${searching() ? ' · esc sai da busca' : ''}`),
    ]

    const framed = box(body.map(l => truncate(l, inner)), width, {
      title: c.info(strong('sessões')),
      paint: c.info,
    })
    // Pad to the body height so the two columns stay aligned row by row.
    while (framed.length < height) framed.push(' '.repeat(width))
    return framed.slice(0, height)
  }

  function centreVertically(lines: string[], height: number): string[] {
    if (lines.length >= height) return lines.slice(0, height)
    const top = Math.floor((height - lines.length) / 2)
    return [
      ...Array.from({ length: top }, () => ''),
      ...lines,
      ...Array.from({ length: height - lines.length - top }, () => ''),
    ]
  }

  function renderViewport(width: number, height: number): string[] {
    const perBlock: string[][] = []
    let total = 0
    for (let i = 0; i < blocks.length; i++) {
      const lines = renderCached(blocks[i], width)
      perBlock.push(lines)
      total += gapBefore(i) + lines.length
    }

    // Anchored while scrolled back: `scroll` counts rows from the bottom, so
    // rows arriving below would slide the window down and carry the passage
    // being read off the top. Growing it by the same amount keeps the reader on
    // the same rows while the turn streams underneath.
    if (scroll > 0 && total > lastViewportTotal) scroll += total - lastViewportTotal
    lastViewportTotal = total

    maxScroll = Math.max(0, total - height)
    if (scroll > maxScroll) scroll = maxScroll

    // Which block owns which row of the drawn body. Rebuilt every frame, because
    // a click has to hit the block that is *now* under the pointer.
    blockRows.length = 0
    const mark = (index: number, from: number, count: number) => {
      if (count > 0) blockRows.push({ index, from, to: from + count - 1 })
    }

    // While everything fits, sit at the top: a nearly empty session should not
    // push three lines of content to the bottom of an empty screen.
    if (total <= height) {
      const all: string[] = []
      for (let i = 0; i < blocks.length; i++) {
        if (gapBefore(i)) all.push('')
        mark(i, all.length, perBlock[i].length)
        all.push(...perBlock[i])
      }
      return [...all, ...Array.from({ length: height - all.length }, () => '')]
    }

    const end = total - scroll
    const start = end - height
    const window: string[] = []
    let pos = total

    for (let i = blocks.length - 1; i >= 0 && pos > start; i--) {
      const lines = perBlock[i]
      const linesStart = pos - lines.length
      const from = Math.max(0, start - linesStart)
      const to = Math.min(lines.length, end - linesStart)
      if (to > from) {
        window.unshift(...lines.slice(from, to))
        // Rows are prepended, so every earlier entry shifts down by this many.
        for (const row of blockRows) {
          row.from += to - from
          row.to += to - from
        }
        mark(i, 0, to - from)
      }
      pos = linesStart

      if (gapBefore(i)) {
        pos -= 1
        if (pos >= start && pos < end) {
          window.unshift('')
          for (const row of blockRows) {
            row.from += 1
            row.to += 1
          }
        }
      }
    }

    return window
  }

  function renderBlock(block: Block, width: number, list: Block[] = blocks): string[] {
    switch (block.kind) {
      case 'splash':
        return renderSplash(width)

      case 'user': {
        if (block.pending) {
          // Full-width inverted rows: a queued message has to be unmistakably
          // "not sent yet", and a marker on the left alone was too easy to miss.
          const rows = wrap(block.text, width - 12)
          return rows.map((line, i) =>
            queued(
              pad(
                i === 0
                  ? split(` ${g.prompt} ${line}`, `na fila ${g.sep} `, width)
                  : `   ${line}`,
                width,
              ),
            ),
          )
        }
        return wrap(block.text, width - 2).map(l => `${c.accent(g.railThick)} ${strong(l)}`)
      }

      case 'assistant':
        return renderMarkdown(block.text, width, diffOptions(width))

      case 'thinking': {
        const secs = Math.max(1, Math.round((Date.now() - block.since) / 1000))
        return [`${c.info(g.spinner[spinner % g.spinner.length])} ${c.dim('pensando')} ${c.faint(`${g.sep} ${secs}s`)}`]
      }

      case 'tool': {
        const fold = foldOf(block, list)
        // Everything before the last of a folded run is drawn by that last one.
        if (fold && !fold.last) return []

        // One dot carries the outcome: green done, red failed, spinner running.
        // A separate check plus a dot said the same thing twice. A batch answers
        // for all of its calls, so it uses the outcome of the whole batch.
        const status = fold?.status ?? block.status
        const mark =
          status === 'running'
            ? c.info(g.spinner[spinner % g.spinner.length])
            : status === 'ok'
              ? c.ok(g.dotOn)
              : c.danger(g.dotOn)

        // `Name(subject)` reads as a call, which is what it is. A folded run
        // keeps the subject of the last call and adds the count: hiding the
        // subject too would trade noise for mystery.
        const subject = block.subject ?? block.summary
        const shown = subject
          ? `${strong(block.name)}${c.dim(`(${truncate(subject, Math.max(12, width - 34))})`)}`
          : strong(block.name)
        // A batch was one decision, so it gets one sentence instead of the name
        // of whichever call happened to be last.
        const title = fold?.label
          ? `${c.fg(truncate(fold.label, Math.max(20, width - 16)))}${status === 'running' ? c.dim('…') : ''}`
          : fold
            ? `${shown} ${c.faint(`${g.sep} ${fold.count} chamadas`)}`
            : shown
        const focused = focusedTool !== null && blocks[focusedTool] === block
        const right = block.preview
          ? focused
            ? c.accent(`${block.expanded ? g.collapse : g.expand} ctrl+r`)
            : c.faint(`${block.expanded ? g.collapse : g.expand} ctrl+r`)
          : ''
        const cursor = focused ? c.accent(g.prompt) : ' '
        const lines = [split(`${cursor}${mark} ${title}`, right, width)]

        // The detail hangs off the call on its own line, so a long summary never
        // fights the file name for the same row. A folded run has no single
        // detail worth showing.
        if (block.detail && !fold) {
          lines.push(`   ${c.faint(g.treeEnd)} ${c.dim(truncate(block.detail, width - 7))}`)
        }

        if (block.expanded && block.preview) {
          const body = looksLikeDiff(block.preview)
            ? renderDiff(block.preview, width - 5, diffOptions(width - 5))
            : block.preview.split('\n').map(l => c.dim(truncate(l, width - 5)))
          lines.push(...body.slice(0, 24).map(l => `     ${l}`))
        }
        return lines
      }

      case 'notice':
        return wrap(block.text, width - 2).map((l, i) =>
          i === 0 ? `${c.warn(g.warn)} ${c.warn(l)}` : `  ${c.warn(l)}`,
        )

      case 'error':
        return wrap(block.text, width - 2).map((l, i) =>
          i === 0 ? `${c.danger(g.fail)} ${c.danger(l)}` : `  ${c.danger(l)}`,
        )

      case 'divider':
        return [rule(width, { label: block.label, detail: block.detail, paint: c.meta })]

      case 'home':
        return renderHome(block.sessions, width)
    }
  }

  // Identity now lives in the pinned header, so the splash only carries what the
  // header has no room for: what is loaded, and how to drive it.
  function renderSplash(width: number): string[] {
    const mcp = session.mcp.status().filter(s => s.connected)
    const label = (text: string) => c.faint(pad(`   ${text}`, 11))

    return [
      `${label('compact')} ${c.dim(
        `em ${Math.round((session.config.compaction?.threshold ?? 0.85) * 100)}% da janela · node 24 · sem build`,
      )}`,
      `${label('assets')} ${c.fg(String(session.assets.skills.length))} ${c.dim('skills')} ${c.faint('·')} ` +
        `${c.fg(String(session.assets.agents.length))} ${c.dim('agents')} ${c.faint('·')} ` +
        `${c.fg(String(session.assets.commands.length))} ${c.dim('commands')}`,
      ...(mcp.length > 0
        ? [
            `${label('mcp')} ` +
              mcp
                .map(s => `${c.ok(g.dotOn)} ${c.fg(s.name)} ${c.dim(`${s.toolCount} tools`)}`)
                .join(c.faint(' · ')),
          ]
        : []),
      '',
      c.faint(`   digite `) +
        c.accent('/') +
        c.faint(' para comandos · ') +
        c.dim('shift+tab') +
        c.faint(' alterna o modo · ') +
        c.dim('ctrl+c') +
        c.faint(' interrompe'),
    ].map(l => truncate(l, width))
  }

  /**
   * `Garimpando… (1m 12s · ↓ 4.2k tokens · esc interrompe)` plus a rotating tip,
   * so a long turn shows elapsed time and how much has come back.
   */
  function workingLines(width: number): string[] {
    const elapsed = Date.now() - busySince
    // The verb changes every ~20s so a long turn does not look frozen.
    const verb = WORKING_VERBS[(verbSeed + Math.floor(elapsed / 20000)) % WORKING_VERBS.length]
    const tokens = busyTokens || Math.round(busyChars / 4)
    const detail = [formatElapsed(elapsed), `↓ ${formatCount(tokens)} tokens`, 'esc interrompe']

    return [
      truncate(
        `${c.info(g.spinner[spinner % g.spinner.length])} ${c.fg(verb)}${c.dim('…')} ` +
          c.faint(`(${detail.join(' · ')})`),
        width,
      ),
      truncate(
        `${c.faint('Dica:')} ${c.faint(TIPS[(tipSeed + Math.floor(elapsed / 25000)) % TIPS.length])}`,
        width,
      ),
      '',
    ]
  }

  function composer(width: number, completions: PickerItem[]): string[] {
    // The idle composer gets one blank line above it; the working indicator used
    // to *replace* that line, so it ended up glued to the last tool line.
    const lines: string[] = busy ? ['', ...workingLines(width)] : ['']

    if (completions.length > 0) {
      // The popup has no border of its own: it hangs off the composer.
      const index = completionIndex % completions.length
      // The window follows the cursor. It used to be a fixed `slice(0, 7)` with
      // the highlight taken modulo 7, so `↓` past the seventh entry moved a
      // selection that was already off the list and the other forty commands
      // were reachable only by typing their name.
      const top = Math.max(0, Math.min(index - COMPLETION_ROWS + 1, completions.length - COMPLETION_ROWS))
      const shown = completions.slice(Math.max(0, top), Math.max(0, top) + COMPLETION_ROWS)
      const first = Math.max(0, top)
      const more = completions.length - first - shown.length
      const position =
        completions.length > COMPLETION_ROWS
          ? `${index + 1} de ${completions.length}`
          : `${completions.length} de ${BUILTIN_COMMANDS.length + session.assets.commands.length}`
      lines.push(
        split(
          c.faint(`  comandos ${g.sep} ${position}`),
          c.rule('↑↓ move · tab completa · enter roda'),
          width,
        ),
      )
      shown.forEach((item, i) => {
        const at = first + i
        const isCurrent = at === index
        const name = isCurrent ? strong(item.label) : c.fg(item.label)
        const hint = isCurrent ? c.dim(item.hint ?? '') : c.faint(item.hint ?? '')
        const marker = isCurrent ? c.accent(`${g.prompt} `) : '  '
        const row = pad(split(`${marker}${name}`, hint, width), width)
        lines.push(isCurrent ? selected(row) : row)
      })
      // Without this the list simply stopped, and a stopped list reads as the
      // end of the list.
      if (first > 0 || more > 0) {
        const above = first > 0 ? `↑ ${first}` : ''
        const below = more > 0 ? `↓ ${more}` : ''
        lines.push(c.faint(`  ${[above, below].filter(Boolean).join(`  ${g.sep}  `)}`))
      }
      lines.push('')
    }

    const cursor = composerCursor()
    const head = busy ? c.info(g.spinner[spinner % g.spinner.length]) : c.accent(g.prompt)

    if (!input) {
      const hint = searching()
        ? 'buscando sessões — esc volta para cá'
        : 'pergunte, cole um erro, ou / para comandos'
      // The caret goes **before** the placeholder, where the first character will
      // land. Sitting after it, the hint read as text already typed — with a
      // cursor blinking at its end, waiting to be edited.
      lines.push(...box([` ${head} ${cursor}${c.faint(hint)}`], width, { paint: c.accent }))
      return lines
    }

    // Multi-line input: a pasted block keeps its shape, and a long line **wraps**
    // instead of being truncated. Truncating hid exactly the characters being
    // typed — the one part of the input that has to stay visible.
    const raw = input.split('\n')
    const room = Math.max(8, width - 6)
    const rows = raw.flatMap(line => wrapInput(line, room))
    // A row filled to the edge gets an extra one, so the cursor never sits on
    // top of the border.
    if ((rows.at(-1)?.length ?? 0) >= room) rows.push('')

    const visible = rows.slice(-MAX_COMPOSER_LINES)
    const hidden = rows.length - visible.length
    const body = visible.map((line, i) => {
      const marker = i === 0 && hidden === 0 ? `${head} ` : '  '
      const isLast = i === visible.length - 1
      return ` ${marker}${c.fg(line)}${isLast ? cursor : ''}`
    })
    if (hidden > 0) {
      body.unshift(` ${head} ${c.faint(`${g.ellipsis} ${hidden} linha${hidden > 1 ? 's' : ''} acima`)}`)
    }

    lines.push(
      ...box(body, width, {
        paint: c.accent,
        title:
          raw.length > 1
            ? c.faint(`${raw.length} linhas · enter envia · alt+enter quebra`)
            : undefined,
      }),
    )

    // What the placeholders in the line stand for. Without this the composer
    // shows `[Image #1]` and nothing says whether anything was actually read.
    for (const attachment of attachments.live(input)) {
      lines.push(c.faint(`   ${g.sep} ${describeAttachment(attachment)}`))
    }
    return lines
  }

  function renderModal(current: NonNullable<Modal>, width: number, height: number): string[] {
    const modalWidth = Math.min(width - 4, MAX_MODAL_WIDTH)
    const inner = modalWidth - 4
    let title = ''
    let lines: string[] = []
    let paint = c.info

    if (current.kind === 'permission') {
      const req = current.request
      paint = c.warn
      // With concurrent subagents the question is not only "may I", it is "who
      // is asking" — and how many more are behind this one.
      const waiting = permissionQueue.length - 1
      title =
        c.warn(strong('permissão')) +
        (req.agent ? c.faint(` ${g.sep} ${req.agent}`) : '') +
        (waiting > 0 ? c.faint(` ${g.sep} +${waiting} na fila`) : '')
      lines = [
        ` ${strong(req.tool)} ${c.dim(req.summary)}`,
        '',
        ...(req.subject
          ? [selected(pad(` ${c.ok('$')} ${c.fg(truncate(req.subject, inner - 4))}`, inner))]
          : []),
        ` ${c.faint(`cwd ${path.basename(session.cwd)} · regra `)}${c.dim(req.verdict.rule ?? `${req.tool}(*)`)}${c.faint(' → ask')}`,
        '',
        ` ${c.ok('y')} ${c.fg('permitir uma vez')}   ${c.ok('a')} ${c.fg(`permitir ${req.tool} na sessão`)}   ${c.danger('n')} ${c.fg('negar')}`,
        ` ${c.faint('cansado de perguntas? esc, depois shift+tab 2× para ')}${c.danger('AUTO')}`,
      ]
    } else if (current.kind === 'input') {
      title = c.info(strong(current.title))
      const shown = current.masked ? '•'.repeat(current.value.length) : current.value
      lines = [
        ` ${c.dim(current.prompt)}${current.detail ? ` ${c.faint(`· ${current.detail}`)}` : ''}`,
        '',
        ` ${c.info(g.prompt)} ${c.fg(truncate(shown, inner - 4))}${blinkOn ? c.info(g.cursor) : ' '}`,
        '',
        ` ${c.faint(current.footer ?? 'enter confirma · esc cancela')}`,
      ]
    } else if (current.kind === 'form') {
      title = c.info(strong(current.title))
      // The whole form stays on screen, unlike the chain of single-value prompts
      // `/connect` uses: filling one field is a decision made in view of the
      // others, and fixing a typo two rows up must not mean starting over.
      const labelWidth = Math.max(...current.fields.map(f => f.label.length))
      lines = [
        ...(current.detail ? [` ${c.faint(current.detail)}`, ''] : []),
        ...current.fields.flatMap((field, i) => {
          const active = i === current.index
          const shown = field.masked ? '•'.repeat(field.value.length) : field.value
          const label = pad(field.label, labelWidth)
          const body = shown ? c.fg(shown) : c.faint(field.placeholder ?? '')
          const caret = active && blinkOn ? c.info(g.cursor) : ' '
          const marker = active ? c.info(`${g.prompt} `) : '  '
          const required = field.required ? c.danger('*') : ' '
          const row = pad(
            truncate(`${marker}${active ? strong(label) : c.dim(label)} ${required} ${body}${caret}`, inner),
            inner,
          )
          // The hint belongs to the field being edited; showing every hint at
          // once buries the fields under their own documentation.
          return active && field.hint
            ? [selected(row), `   ${c.faint(truncate(field.hint, inner - 4))}`]
            : [row]
        }),
        '',
        ...(current.error ? [` ${c.danger(truncate(current.error, inner - 2))}`, ''] : []),
        ` ${c.faint(current.footer ?? 'tab/↑↓ move · enter avança, no último salva · esc cancela')}`,
      ]
    } else if (current.kind === 'busy') {
      title = c.info(strong(current.title))
      lines = [` ${c.info(g.spinner[spinner % g.spinner.length])} ${c.fg(current.message)}`]
    } else if (current.kind === 'tasks') {
      const groups = todoGroups(session)
      const todos = groups.flatMap(gr => gr.todos)
      const done = todos.filter(t => t.status === 'completed').length
      paint = c.meta
      title = c.meta(strong(`tasks ${g.sep} ${done}/${todos.length}`))

      const row = (todo: { content: string; status: string }) => {
        const mark =
          todo.status === 'completed'
            ? c.ok(g.ok)
            : todo.status === 'in_progress'
              ? c.info(g.spinner[spinner % g.spinner.length])
              : c.faint(g.dotOff)
        const text =
          todo.status === 'completed'
            ? c.faint(todo.content)
            : todo.status === 'in_progress'
              ? strong(todo.content)
              : c.fg(todo.content)
        return ` ${mark} ${truncate(text, inner - 4)}`
      }

      // O cabeçalho de quem escreveu só entra quando há mais de uma lista: com uma
      // só ele seria ruído, com duas é o que impede ler dois planos como um.
      const budget = Math.max(4, height - 8)
      lines =
        todos.length === 0
          ? [
              ` ${c.faint('o modelo ainda não quebrou o trabalho em tasks')}`,
              '',
              ` ${c.faint('elas aparecem aqui quando ele usa TodoWrite — inclusive as de um subagent')}`,
            ]
          : groups.length === 1
            ? groups[0].todos.slice(0, budget).map(row)
            : groups
                .flatMap(gr => [
                  split(
                    ` ${c.meta(gr.owner)}`,
                    `${c.faint(`${gr.todos.filter(t => t.status === 'completed').length}/${gr.todos.length}`)} `,
                    inner,
                  ),
                  ...gr.todos.map(row),
                  '',
                ])
                .slice(0, budget)
      lines.push('', ` ${c.faint('esc ou ctrl+t fecha')}`)
    } else if (current.kind === 'mcp') {
      const servers = session.mcp.status()
      const dialled = servers.filter(s => !s.disabled)
      const up = dialled.filter(s => s.connected).length
      paint = c.info
      title = c.info(strong(`mcp ${g.sep} ${up}/${dialled.length} conectados`))

      lines =
        servers.length === 0
          ? [
              ` ${c.faint('nenhum servidor MCP configurado')}`,
              '',
              ` ${c.faint('adicione um bloco "mcp" no bytecode.jsonc')}`,
              ` ${c.faint(`ou herde de outra ferramenta: "inheritMcp": true · \`${CLI} mcp import\``)}`,
            ]
          : servers.flatMap(server => {
              // Where it came from matters: a server this config never declared
              // still spawns a process, so the origin is on screen.
              const from =
                server.source && server.source !== 'own' ? c.meta(` ${g.sep} ${server.source}`) : ''
              const head = server.disabled
                ? split(` ${c.faint(g.dotOff)} ${c.dim(server.name)}${from}`, `${c.faint('desligado')} `, inner)
                : server.connected
                  ? split(
                      ` ${c.ok(g.dotOn)} ${strong(server.name)}${from}`,
                      `${c.dim(`${server.toolCount} tools`)}${server.resourceCount > 0 ? c.faint(` ${g.sep} resources`) : ''} `,
                      inner,
                    )
                  : ` ${c.danger(g.fail)} ${strong(server.name)}${from}`
              const rows = [head]
              if (!server.connected && !server.disabled && server.error) {
                rows.push(`   ${c.danger(truncate(server.error, inner - 4))}`)
              }
              if (server.connected && server.instructions) {
                rows.push(`   ${c.faint(`instruções: ${server.instructions.length} chars no contexto`)}`)
              }
              return rows
            })
      lines.push('', ` ${c.faint('esc ou ctrl+p fecha · /context-all detalha o contexto')}`)
    } else if (current.kind === 'sessionTree') {
      const rows = flattenTree(current.roots)
      const forks = rows.filter(r => r.depth > 0).length
      paint = c.meta
      title = c.meta(
        strong(`sessões ${g.sep} ${rows.length}`) +
          (forks > 0 ? c.faint(` ${g.sep} ${forks} fork${forks === 1 ? '' : 's'}`) : ''),
      )

      if (rows.length === 0) {
        lines = [` ${c.faint('nenhuma sessão salva neste projeto ainda')}`]
      } else {
        // A janela acompanha a seleção, como no picker: uma árvore de trinta
        // sessões não cabe, e cortar sempre o fim esconderia justamente o fork
        // recém-criado, que fica embaixo.
        const room = Math.max(4, Math.min(14, height - 10))
        const start = Math.max(0, Math.min(current.index - Math.floor(room / 2), rows.length - room))
        const visible = rows.slice(Math.max(0, start), Math.max(0, start) + room)

        lines = visible.map(node => {
          const active = rows[current.index]?.id === node.id
          const here = node.id === session.transcript.sessionId
          // O recuo é o que faz a hierarquia ser legível de relance; o `└─` marca
          // que aquela linha pende da de cima.
          const indent = node.depth === 0 ? '' : `${'  '.repeat(node.depth - 1)}${g.treeEnd} `
          const badge = node.depth === 0 ? c.meta('(main)') : c.faint(`(fork${node.forkedAtMessage !== undefined ? ` @${node.forkedAtMessage}` : ''})`)
          // "onde estou" tem de ser visível sem precisar contar: é a pergunta que
          // faz alguém abrir esta tela.
          const mark = here ? c.ok(g.dotOn) : active ? c.info(g.prompt) : ' '
          const name = here ? c.ok(strong(node.title)) : active ? strong(node.title) : c.fg(node.title)
          const row = pad(
            split(
              ` ${mark} ${c.faint(`#${node.short}`)} ${indent}${truncate(name, Math.max(8, inner - 34))} ${badge}`,
              `${c.faint(formatWhen(node.updated))} `,
              inner,
            ),
            inner,
          )
          return active ? selected(row) : row
        })

        if (start > 0) lines.unshift(` ${c.faint(`… ${start} acima`)}`)
        const below = rows.length - (Math.max(0, start) + room)
        if (below > 0) lines.push(` ${c.faint(`… ${below} abaixo`)}`)
      }

      lines.push(
        '',
        ` ${c.faint('↑↓ move · enter abre · /fork cria um fork daqui · esc ou ctrl+s fecha')}`,
      )
    } else if (current.kind === 'workflows') {
      const runs = workflowRuns(session)
      const run = runs.at(-1)
      const enabled = Boolean(session.config.workflows?.enabled)
      paint = c.meta

      if (!run) {
        title = c.meta(strong(`workflows ${g.sep} ${enabled ? 'ligados' : 'desligados'}`))
        lines = [
          ` ${c.faint(
            enabled
              ? 'a tool Workflow está no roster — nenhuma rodada nesta sessão ainda'
              : 'a tool Workflow está fora do roster desta sessão',
          )}`,
          '',
          ...(current.saved.length === 0
            ? [` ${c.faint('nenhum script salvo · crie .bytecode/workflows/<nome>.js')}`]
            : [
                ` ${c.dim('salvos')}`,
                ...current.saved
                  .slice(0, 8)
                  .map(w =>
                    split(` ${c.fg(w.name)}`, `${c.faint(truncate(w.description, inner - 24))} `, inner),
                  ),
              ]),
          '',
          ` ${c.faint(enabled ? 'a rodada aparece aqui enquanto anda' : '/workflows on liga a orquestração')}`,
        ]
      } else {
        const finished = run.steps.filter(s => s.state !== 'running').length
        const elapsed = formatElapsed((run.endedAt ?? Date.now()) - run.startedAt)
        title = c.meta(
          strong(`workflow ${g.sep} ${run.name} ${g.sep} ${finished}/${run.steps.length} ${g.sep} ${elapsed}`),
        )

        // Grouped by phase in the order the phases appeared, so the shape of the
        // script — fan-out, then verify — is what shows on screen.
        const phases: { title: string; steps: WorkflowStep[] }[] = []
        for (const step of run.steps) {
          const key = step.phase ?? ''
          const group = phases.find(p => p.title === key)
          if (group) group.steps.push(step)
          else phases.push({ title: key, steps: [step] })
        }

        const stepRow = (step: WorkflowStep) => {
          const mark =
            step.state === 'running'
              ? c.info(g.spinner[spinner % g.spinner.length])
              : step.state === 'ok'
                ? c.ok(g.ok)
                : step.state === 'cached'
                  ? c.faint(g.ok)
                  : c.danger(g.fail)
          const right =
            step.state === 'cached'
              ? c.faint('cache')
              : step.state === 'running'
                ? c.faint(formatElapsed(Date.now() - step.startedAt))
                : step.chars > 0
                  ? c.faint(`${formatCount(step.chars)} chars`)
                  : ''
          const label = step.state === 'running' ? strong(step.label) : c.fg(step.label)
          return split(`  ${mark} ${truncate(label, inner - 16)}`, right ? `${right} ` : '', inner)
        }

        const body = phases.flatMap(group => [
          ...(group.title ? [` ${c.meta(truncate(group.title, inner - 4))}`] : []),
          ...group.steps.map(stepRow),
        ])

        // The tail, not the head: what is running now is what the user opened
        // this for, and a fan-out of forty steps does not fit anywhere.
        const room = Math.max(4, height - 12)
        lines = body.length > room ? [` ${c.faint(`… ${body.length - room} linhas acima`)}`, ...body.slice(-room)] : body

        const tail: string[] = ['']
        if (run.budget !== null) {
          tail.push(
            ` ${c.faint('orçamento')} ${c.dim(`${formatCount(run.tokens)}/${formatCount(run.budget)}`)} ${c.faint('tokens de saída')}`,
          )
        } else if (run.tokens > 0) {
          tail.push(` ${c.faint('tokens de saída')} ${c.dim(formatCount(run.tokens))}`)
        }
        const lastLog = run.logs.at(-1)
        if (lastLog) tail.push(` ${c.faint(truncate(lastLog, inner - 4))}`)
        if (run.errors.length > 0) {
          tail.push(` ${c.danger(truncate(`${run.errors.length} erro(s): ${run.errors.at(-1)}`, inner - 4))}`)
        }
        if (runs.length > 1) tail.push(` ${c.faint(`+${runs.length - 1} rodada(s) antes desta`)}`)
        tail.push(
          ` ${c.faint(run.done ? 'terminado · esc fecha' : 'em andamento · esc fecha, a rodada continua')}`,
        )
        lines.push(...tail)
      }
    } else {
      title = c.info(strong(current.title))
      const items = filterItems(current.all, current.filter)
      const listHeight = Math.max(3, Math.min(10, height - 9))
      const start = Math.max(0, Math.min(current.index - Math.floor(listHeight / 2), items.length - listHeight))
      const visible = items.slice(Math.max(0, start), Math.max(0, start) + listHeight)

      lines = [
        split(
          ` ${c.faint('filtro')} ${c.fg(current.filter)}${blinkOn ? c.info(g.cursor) : ' '}`,
          c.faint(`${items.length} de ${current.all.length} `),
          inner,
        ),
        '',
        ...(visible.length === 0
          ? [` ${c.faint('nenhum resultado')}`]
          : visible.map(item => {
              const isSelected = items[current.index]?.value === item.value
              const name = isSelected ? strong(item.label) : c.fg(item.label)
              const hint = isSelected ? c.dim(item.hint ?? '') : c.faint(item.hint ?? '')
              const marker = isSelected ? c.info(`${g.prompt} `) : '  '
              const row = pad(split(`${marker}${name}`, `${hint} `, inner), inner)
              return isSelected ? selected(row) : row
            })),
        '',
        ` ${c.faint('↑↓ move · digite para filtrar · enter seleciona · esc cancela')}`,
      ]
    }

    const rendered = box(lines, modalWidth, { title, paint })
    const indent = ' '.repeat(Math.max(0, Math.floor((width - modalWidth) / 2)))
    const top = Math.max(0, Math.floor((height - rendered.length) / 2))
    const result = [...Array.from({ length: top }, () => ''), ...rendered.map(l => indent + l)]
    while (result.length < height) result.push('')
    return result.slice(0, height)
  }

  function filterItems(items: PickerItem[], filter: string): PickerItem[] {
    const f = filter.trim().toLowerCase()
    if (!f) return items
    return items.filter(i => i.label.toLowerCase().includes(f) || i.value.toLowerCase().includes(f))
  }

  function currentCompletions(): PickerItem[] {
    // Not gated on `busy`: a command typed during a turn already goes to the
    // queue and runs when the turn ends, so hiding the list mid-turn only hid
    // the names — the feature worked, you just could not see what to type.
    if (modal) return []
    if (!input.startsWith('/') || input.includes(' ')) return []
    const typed = input.slice(1).toLowerCase()
    const builtin = BUILTIN_COMMANDS.map(cmd => ({ label: `/${cmd.name}`, value: cmd.name, hint: cmd.hint }))
    const fromDisk = session.assets.commands.map(cmd => ({
      label: `/${cmd.name}${cmd.argumentHint ? ` ${cmd.argumentHint}` : ''}`,
      value: cmd.name,
      // The file's own `description:` is what tells one of thirteen commands
      // from another; "command file" said nothing.
      hint: cmd.description ?? 'command file',
    }))
    const matches = [...builtin, ...fromDisk].filter(cmd => cmd.value.toLowerCase().startsWith(typed))
    if (!typed) return matches
    return matches.sort((a, b) => {
      const aExact = a.value.toLowerCase() === typed ? 0 : 1
      const bExact = b.value.toLowerCase() === typed ? 0 : 1
      if (aExact !== bExact) return aExact - bExact
      if (a.value.length !== b.value.length) return a.value.length - b.value.length
      return a.value.localeCompare(b.value)
    })
  }

  let lastDraw = 0
  let previousFrame: string[] = []

  /**
   * Only the rows that actually changed are rewritten. Repainting the whole
   * screen every frame is what made streaming stutter: at 140x34 that is ~20 KB
   * per frame, and a Windows console cannot absorb that 30 times a second.
   * During streaming this usually writes one or two lines.
   */
  /**
   * A frame that cannot be built must not take the session down with it.
   *
   * `draw` runs from the ticker and from every keystroke, so an exception
   * escaping here reaches the process-level handler, which prints a stack trace
   * straight over the alt screen — on every tick, forever, with the frame never
   * repainting again. Painting the error on the last row instead keeps the UI
   * usable, which is what lets the user undo whatever caused it.
   */
  function draw(): void {
    if (!dirty) return
    dirty = false
    lastDraw = Date.now()
    try {
      paint()
    } catch (err) {
      previousFrame = []
      const { rows, cols } = layout()
      const row = truncate(c.danger(`render error: ${describeError(err)}`), cols)
      out.write(`${CSI}${rows};1H${row}${RESET}${CLEAR_LINE}`)
    }
  }

  function paint(): void {
    const next = frameLines()
    if (selection) {
      const { start, end, empty } = spanOf(selection)
      // A click with no drag selects nothing, so nothing is highlighted and
      // nothing is copied — the pointer stays a pointer.
      if (!empty) {
        const cols = layout().cols
        const first = Math.max(0, start.row - 1)
        const last = Math.min(next.length - 1, end.row - 1)
        for (let i = first; i <= last; i++) {
          // The touched row drops its own colours: keeping them would mean
          // rewriting every reset so it restores the selection background.
          const plain = pad(stripAnsi(next[i]), cols)
          const { from, to } = rowRange(i + 1, start, end, cols)
          next[i] =
            plain.slice(0, from) + selected(plain.slice(from, to)) + plain.slice(to)
        }
      }
    }
    if (previousFrame.length !== next.length) previousFrame = []

    // One frame row is one physical line, and nothing here re-anchors the cursor
    // mid-row: a row wider than the terminal wraps, so the row below lands one
    // line down and the frame differ then compares rows against the wrong
    // positions. Clamping here makes that impossible no matter which builder
    // miscounted — the alternative is auditing every row builder forever.
    const cols = layout().cols
    let patch = ''
    for (let i = 0; i < next.length; i++) {
      if (previousFrame[i] === next[i]) continue
      const row = truncate(next[i], cols)
      // Rows that already close themselves — the status bar, a selected row —
      // don't get a second reset: it would be dead bytes on every frame, and it
      // hides whether the row actually closes its own colour.
      const close = row.endsWith(RESET) ? '' : RESET
      patch += `${CSI}${i + 1};1H${row}${close}${CLEAR_LINE}`
    }
    previousFrame = next
    if (patch) out.write(patch)
  }

  function repaint(): void {
    previousFrame = []
    dirty = true
    out.write(CLEAR_SCREEN + HOME)
    draw()
  }

  /**
   * Streaming used to wait for the 80 ms ticker, so text arrived in visible
   * chunks. Drawing straight from the event, capped at ~30 fps, makes it read
   * as it is produced without redrawing faster than a terminal can paint.
   */
  function scheduleDraw(): void {
    if (Date.now() - lastDraw >= 32) draw()
  }

  // ------------------------------------------------------- modal primitives

  function pick(title: string, items: PickerItem[]): Promise<string | null> {
    return new Promise(resolve => {
      modal = { kind: 'picker', title, all: items, filter: '', index: 0, resolve }
      dirty = true
    })
  }

  function askInput(
    title: string,
    prompt: string,
    opts: { masked?: boolean; detail?: string; footer?: string } = {},
  ): Promise<string | null> {
    return new Promise(resolve => {
      modal = {
        kind: 'input',
        title,
        prompt,
        detail: opts.detail,
        footer: opts.footer,
        value: '',
        masked: opts.masked ?? false,
        resolve,
      }
      dirty = true
    })
  }

  /**
   * Multi-field modal. Resolves with every field keyed by `name`, or null when
   * cancelled — a blank field yields its placeholder, so the defaults the
   * harness already assumes do not have to be retyped.
   */
  function askForm(
    title: string,
    fields: FormField[],
    opts: { detail?: string; footer?: string } = {},
  ): Promise<Record<string, string> | null> {
    return new Promise(resolve => {
      modal = {
        kind: 'form',
        title,
        detail: opts.detail,
        footer: opts.footer,
        fields,
        index: 0,
        resolve,
      }
      dirty = true
    })
  }

  async function withBusyModal<T>(title: string, message: string, work: () => Promise<T>): Promise<T> {
    modal = { kind: 'busy', title, message }
    dirty = true
    try {
      return await work()
    } finally {
      if (modal?.kind === 'busy') modal = null
      dirty = true
    }
  }

  // ------------------------------------------------------------------- events

  session.emit = (event: UIEvent) => {
    switch (event.type) {
      case 'text':
        dropThinking()
        if (!liveAssistant || liveAssistant.kind !== 'assistant') {
          liveAssistant = { kind: 'assistant', text: '' }
          blocks.push(liveAssistant)
        }
        liveAssistant.text += event.text
        busyChars += event.text.length
        dirty = true
        break
      case 'reasoning':
        if (!blocks.some(b => b.kind === 'thinking')) push({ kind: 'thinking', since: Date.now() })
        dirty = true
        break
      case 'tool-start':
        dropThinking()
        liveAssistant = null
        // A running subagent already has a row in the strip below the composer;
        // a second line here said the same thing twice. It enters the transcript
        // when it finishes, and that line is what you click to open its session.
        if (event.name === 'Agent') break
        push({
          kind: 'tool',
          name: event.name,
          summary: event.summary,
          subject: event.subject,
          status: 'running',
          callId: event.id,
          step: event.step,
        })
        break
      case 'tool-end': {
        // A subagent has no running line to close: it gets its transcript line
        // now that it is done, carrying the id so a click opens its session.
        if (event.name === 'Agent') {
          const agent = agents.get(event.id)
          push({
            kind: 'tool',
            name: 'Agent',
            summary: agent?.label ?? '',
            subject: agent?.agentType ?? event.name,
            status: event.ok ? 'ok' : 'fail',
            preview: event.preview,
            detail: agent
              ? `${summarisePreview(event.preview) ?? 'sem saída'} · clique para abrir a sessão`
              : summarisePreview(event.preview),
            agentId: agent ? event.id : undefined,
          })
          dirty = true
          break
        }
        // Matched by call id. The name is only a fallback, for a block pushed
        // before ids were carried — two parallel `Read`s otherwise swap results,
        // and the transcript shows one file's content under the other's name.
        for (let i = blocks.length - 1; i >= 0; i--) {
          const b = blocks[i]
          if (b.kind !== 'tool' || b.status !== 'running') continue
          if (b.callId ? b.callId !== event.id : b.name !== event.name) continue
          b.status = event.ok ? 'ok' : 'fail'
          b.preview = event.preview
          b.detail = summarisePreview(event.preview)
          break
        }
        dirty = true
        break
      }
      case 'notice':
        dropThinking()
        liveAssistant = null
        if (event.text.startsWith('compacted:') || event.text.startsWith('context at')) {
          push({ kind: 'divider', label: 'contexto compactado', detail: event.text })
        } else {
          push({ kind: 'notice', text: event.text })
        }
        break
      case 'error':
        dropThinking()
        liveAssistant = null
        push({ kind: 'error', text: event.text })
        break
      case 'usage':
        if (event.output) busyTokens += event.output
        if (event.output) statusMessage = `${formatTokens(event.input)} in / ${formatTokens(event.output)} out`
        if (event.input) {
          const limit = contextLimit(session)
          usageTrail.push(limit ? Math.min(1, event.input / limit) : 0)
          // The sparkline shows the tail; everything before it was kept forever,
          // one number per model call, for a session that can run all day.
          if (usageTrail.length > MAX_USAGE_TRAIL) usageTrail.splice(0, usageTrail.length - MAX_USAGE_TRAIL)
        }
        dirty = true
        break
      case 'agent-start':
        agents.set(event.id, {
          id: event.id,
          agentType: event.agentType,
          label: event.label,
          since: Date.now(),
          chars: 0,
          done: false,
          ok: true,
          blocks: [],
          live: null,
        })
        // Old agents keep their transcript entry but their captured output is
        // dropped, so a long session cannot grow without bound. Only *finished*
        // ones: a fan-out of twenty parallel agents evicted the ones still
        // running, and their live rows and output vanished mid-run.
        while (agents.size > MAX_KEPT_AGENTS) {
          const oldest = [...agents.values()].find(a => a.done)
          if (!oldest) break
          agents.delete(oldest.id)
        }
        dirty = true
        break
      case 'agent-event':
        applyAgentEvent(agents.get(event.id), event.event)
        dirty = true
        break
      case 'agent-end': {
        const agent = agents.get(event.id)
        if (agent) {
          // Done means it leaves the strip; the transcript line takes over.
          agent.done = true
          agent.ok = event.ok
          agent.chars = event.chars
          agent.tool = undefined
          agent.live = null
        }
        if (agentIndex >= 0) agentIndex = -1
        dirty = true
        break
      }
      case 'turn-end':
        dropThinking()
        // A turn can create a branch, check one out, or commit — and the header
        // said whatever the branch was when the session started, for the rest of
        // the session.
        readGitBranch(session.cwd, branch => {
          if (branch === gitBranch) return
          gitBranch = branch
          dirty = true
        })
        // A crashed turn must not leave a running ghost pinned to the composer,
        // but finished agents stay readable.
        for (const agent of agents.values()) agent.done = true
        agentIndex = -1
        if (event.stats) statusMessage = summarizeTurn(session, event.stats)
        dirty = true
        break
    }
    scheduleDraw()
  }

  function dropThinking(): void {
    const i = blocks.findIndex(b => b.kind === 'thinking')
    if (i >= 0) blocks.splice(i, 1)
  }

  /** Builds a subagent's own transcript from the events it emits. */
  function applyAgentEvent(agent: LiveAgent | undefined, event: UIEvent): void {
    if (!agent) return
    switch (event.type) {
      case 'text':
        if (!agent.live || agent.live.kind !== 'assistant') {
          agent.live = { kind: 'assistant', text: '' }
          agent.blocks.push(agent.live)
        }
        agent.live.text += event.text
        agent.chars += event.text.length
        break
      case 'tool-start':
        agent.live = null
        agent.tool = event.name
        agent.blocks.push({
          kind: 'tool',
          name: event.name,
          summary: event.summary,
          subject: event.subject,
          status: 'running',
          callId: event.id,
          step: event.step,
        })
        break
      case 'tool-end':
        // By call id, for the same reason as the main transcript above.
        for (let i = agent.blocks.length - 1; i >= 0; i--) {
          const block = agent.blocks[i]
          if (block.kind !== 'tool' || block.status !== 'running') continue
          if (block.callId ? block.callId !== event.id : block.name !== event.name) continue
          block.status = event.ok ? 'ok' : 'fail'
          block.preview = event.preview
          block.detail = summarisePreview(event.preview)
          break
        }
        agent.tool = undefined
        break
      case 'notice':
        agent.live = null
        agent.blocks.push({ kind: 'notice', text: event.text })
        break
      case 'error':
        agent.live = null
        agent.blocks.push({ kind: 'error', text: event.text })
        break
      default:
        break
    }
  }

  /** The strip shows what is *running*; finished agents live in the transcript. */
  function agentList(): LiveAgent[] {
    return [...agents.values()].filter(a => !a.done)
  }

  function focusedAgent(): LiveAgent | null {
    const list = agentList()
    return agentIndex >= 0 ? (list[agentIndex] ?? null) : null
  }

  function viewedAgent(): LiveAgent | null {
    return viewingAgent ? (agents.get(viewingAgent) ?? null) : null
  }

  /** ctrl+a: focus the strip, step through it, then release it. */
  function cycleAgentFocus(): void {
    const list = agentList()
    if (list.length === 0) {
      statusMessage = 'nenhum subagent rodando'
      agentIndex = -1
    } else {
      agentIndex = agentIndex + 1 >= list.length ? -1 : agentIndex + 1
      statusMessage =
        agentIndex >= 0
          ? `subagent ${agentIndex + 1}/${list.length} — enter abre, esc solta`
          : 'foco de volta no composer'
    }
    dirty = true
  }

  function openAgent(agent: LiveAgent): void {
    viewingAgent = agent.id
    scroll = 0
    statusMessage = `${agent.agentType} — esc ou ctrl+a volta para a sessão principal`
    dirty = true
  }

  /** `ctrl+g`: the changes screen. Opening it changes nothing about the session. */
  function toggleChangesView(): void {
    if (viewingChanges) {
      viewingChanges = false
      scroll = 0
      statusMessage = 'de volta na sessão principal'
      dirty = true
      return
    }
    const changes = changedFiles(session)
    if (changes.length === 0) {
      statusMessage = 'nenhum arquivo alterado nesta sessão ainda'
      dirty = true
      return
    }
    viewingChanges = true
    viewingAgent = null
    scroll = 0
    if (changesIndex >= changes.length) changesIndex = 0
    statusMessage = `${changes.length} arquivo${changes.length === 1 ? '' : 's'} alterado${changes.length === 1 ? '' : 's'} — ↑↓ escolhe, esc volta`
    dirty = true
  }

  /** Moves the file selection inside the changes screen. */
  function moveChangeSelection(delta: number): void {
    const total = changedFiles(session).length
    if (total === 0) return
    changesIndex = (changesIndex + delta + total) % total
    // A new file starts at the top of its own diff, not at the previous scroll.
    scroll = 0
    dirty = true
  }

  /**
   * Puts the selected file back the way the session found it.
   *
   * Confirmed first, and the question says which of the two things will happen:
   * a file the session created is **deleted**, and there is no second copy of it
   * anywhere. `revertChange` refuses on its own if the file moved on disk since
   * the session wrote it.
   */
  async function revertSelectedChange(): Promise<void> {
    const changes = changedFiles(session)
    const current = changes[changesIndex]
    if (!current) return

    const label = path.relative(session.cwd, current.file) || path.basename(current.file)
    const stats = changeStats(current)
    const created = current.before === null
    const granted = await session.requestPermission({
      tool: 'desfazer',
      summary: created
        ? `apagar ${label} — a sessão criou este arquivo`
        : `restaurar ${label} como estava antes da sessão (+${stats.added} −${stats.removed} desfeitos)`,
      subject: label,
      verdict: { decision: 'ask', reason: 'desfazer escreve no disco' },
      input: { file: current.file },
    })
    if (!granted) {
      statusMessage = 'desfazer cancelado'
      dirty = true
      return
    }

    const result = await revertChange(session, current.file)
    statusMessage = result.ok
      ? `${label} ${result.action === 'deleted' ? 'apagado' : 'restaurado'}`
      : `não deu para desfazer: ${result.reason}`
    if (changedFiles(session).length === 0) {
      viewingChanges = false
      scroll = 0
    } else if (changesIndex >= changedFiles(session).length) {
      changesIndex = changedFiles(session).length - 1
    }
    dirty = true
  }

  function leaveAgentView(): boolean {
    if (!viewingAgent) return false
    viewingAgent = null
    scroll = 0
    statusMessage = 'de volta na sessão principal'
    dirty = true
    return true
  }

  /**
   * Permission requests waiting for the screen.
   *
   * Only one modal exists, and with subagents running concurrently two requests
   * can arrive in the same tick. Assigning `modal` twice used to drop the first
   * one's `resolve` on the floor: the subagent that asked first would wait
   * forever, and with it the whole turn. So they queue, and the user answers
   * them one at a time.
   */
  const permissionQueue: { request: PermissionRequest; resolve: (ok: boolean) => void }[] = []

  /** Called after every answer, and by the ticker, so a queued ask cannot stall. */
  function showNextPermission(): void {
    if (modal || permissionQueue.length === 0) return
    const next = permissionQueue[0]
    modal = {
      kind: 'permission',
      request: next.request,
      resolve: (ok: boolean) => {
        permissionQueue.shift()
        next.resolve(ok)
        // The key handler clears `modal` right after calling this, so the next
        // one can only take the screen once that has happened.
        queueMicrotask(showNextPermission)
      },
    }
    dirty = true
  }

  session.requestPermission = (request: PermissionRequest) =>
    new Promise<boolean>(resolve => {
      permissionQueue.push({ request, resolve })
      showNextPermission()
    })

  // --------------------------------------------------------------- key input

  /**
   * A submitted line, with whatever it had attached.
   *
   * `line` is what the user sees and what history replays: the placeholders,
   * not the thousand lines behind them. `text` and `images` are what the model
   * gets. Keeping both is what lets the transcript stay readable while the
   * prompt stays complete.
   */
  type Submission = { line: string; text: string; images: ImageAttachment[] }

  const pending: Submission[] = []
  let waiter: ((line: Submission | null) => void) | null = null

  function submitLine(line: Submission): void {
    if (waiter) {
      const w = waiter
      waiter = null
      w(line)
    } else {
      pending.push(line)
    }
  }

  function nextLine(): Promise<Submission | null> {
    if (pending.length > 0) return Promise.resolve(pending.shift() as Submission)
    return new Promise(resolve => (waiter = resolve))
  }

  /** Primary agents, plus the plain harness as the first entry (opencode's "build"). */
  function primaryAgents(): (AgentDefinition | null)[] {
    return [null, ...session.assets.agents.filter(a => a.mode === 'primary')]
  }

  function applyPrimaryAgent(agent: AgentDefinition | null): void {
    session.setPrimaryAgent(agent)
    // The agent's `tools:` list restricts the registry, so it has to be rebuilt.
    session.registry.clear()
    registerTools(session, agent && agent.tools.length > 0 ? agent.tools : undefined)

    statusMessage = agent
      ? `agente ${agent.name}${agent.model ? ` ${g.sep} ${session.modelRef}` : ''}`
      : 'agente build (padrão do harness)'
    dirty = true
  }

  function cyclePrimaryAgent(): void {
    const list = primaryAgents()
    if (list.length === 1) {
      statusMessage = 'nenhum agente primary encontrado (mode: primary no frontmatter)'
      dirty = true
      return
    }
    const current = list.findIndex(a => a?.name === session.primaryAgent?.name)
    applyPrimaryAgent(list[(current + 1) % list.length] ?? null)
  }

  function setMode(mode: PermissionMode): void {
    session.mode = mode
    statusMessage = `${MODE_LABEL[mode]} — ${MODE_HELP[mode]}`
    dirty = true
  }

  function cycleMode(): void {
    const index = MODE_CYCLE.indexOf(session.mode)
    setMode(MODE_CYCLE[(index + 1) % MODE_CYCLE.length] ?? MODE_CYCLE[0])
  }

  function expandableTools(): number[] {
    return blocks.reduce<number[]>((acc, block, i) => {
      if (block.kind === 'tool' && block.preview) acc.push(i)
      return acc
    }, [])
  }

  /**
   * ctrl+r acts on the focused tool, or on the last one when nothing is focused.
   *
   * A plain ctrl+r deliberately does **not** take focus: if it did, the focus
   * would stick to whatever was expanded first and every later ctrl+r would keep
   * hitting that old call instead of the one that just ran. Focus is only taken
   * by an explicit pick — a click or alt+↑↓.
   */
  function toggleTool(index?: number): void {
    const target = index ?? focusedTool ?? expandableTools().at(-1)
    if (target === undefined) return
    const block = blocks[target]
    if (block?.kind !== 'tool' || !block.preview) return
    block.expanded = !block.expanded
    if (index !== undefined) focusedTool = index
    dirty = true
  }

  /** Walks the focus between tool blocks, for when the mouse is not an option. */
  function moveToolFocus(delta: number): void {
    const tools = expandableTools()
    if (tools.length === 0) {
      statusMessage = 'nenhuma tool para expandir'
      dirty = true
      return
    }
    const current = focusedTool === null ? -1 : tools.indexOf(focusedTool)
    const next =
      current === -1
        ? delta > 0
          ? 0
          : tools.length - 1
        : (current + delta + tools.length) % tools.length
    focusedTool = tools[next]
    const block = blocks[focusedTool]
    statusMessage =
      block?.kind === 'tool'
        ? `${block.name}${block.subject ? `(${truncate(block.subject, 40)})` : ''} — ctrl+r expande`
        : ''
    // Bring it into view: focusing something off-screen would look like nothing.
    scroll = 0
    dirty = true
  }

  /** Block under a screen row, using the ranges recorded by the last draw. */
  function blockAtRow(row: number): number | null {
    const bodyRow = row - 1 - bodyTop
    const hit = blockRows.find(r => bodyRow >= r.from && bodyRow <= r.to)
    return hit ? hit.index : null
  }

  /**
   * A pasted character goes to whatever owns the keyboard, not always the
   * composer. Pasting an API key into the `connect` prompt used to land in the
   * main input behind the modal — the key ended up on screen and in the prompt
   * instead of in `auth.json`.
   *
   * Single-line fields drop newlines rather than inserting them: a copied
   * credential almost always carries a trailing one.
   */
  function pasteKey(key: string): void {
    const newline = key === '\r' || key === '\n'
    const printable = key.length === 1 && key >= ' '
    if (!newline && !printable && key !== '\t') return

    if (modal?.kind === 'input') {
      if (printable) modal.value += key
      else if (key === '\t') modal.value += ' '
      return
    }
    // Pasting a key or a base URL into the focused field is the whole point of
    // the form, and a newline inside the paste must not submit it early.
    if (modal?.kind === 'form') {
      const field = modal.fields[modal.index]
      if (field && printable) field.value += key
      else if (field && key === '\t') field.value += ' '
      return
    }
    if (modal?.kind === 'picker') {
      if (printable) modal.filter += key
      modal.index = 0
      return
    }
    // Read-only and permission modals swallow the paste: there is nowhere to put
    // it, and leaking it into the composer underneath is what caused the bug.
    if (modal) return

    if (searching()) {
      if (printable) homeSearch = (homeSearch ?? '') + key
      homeIndex = -1
      return
    }

    if (newline) input += '\n'
    else if (key === '\t') input += '  '
    else input += key
  }

  /**
   * A finished bracketed paste.
   *
   * Three shapes matter: a path to an image (which is exactly what terminals
   * send when a file is dropped in), a block big enough to swamp the composer,
   * and ordinary text. Only the first two are transformed; anything else lands
   * verbatim, because a two-line paste turned into a placeholder would be worse
   * than no folding at all.
   */
  /**
   * A line break inside a bracketed paste arrives as CR, not LF — that is what
   * the terminal sends. Counting on the raw buffer therefore found exactly one
   * line, and a 300-line stack trace folded into `+1 lines`. Normalising here
   * fixes the count, the fold decision and the text the model receives, all
   * from a single place.
   */
  function normalizePaste(text: string): string {
    // The BOM rides along with anything copied out of a Windows editor.
    return text.replace(/\r\n?/g, '\n').replace(/^\uFEFF/, '')
  }

  function commitPaste(raw: string): void {
    const text = normalizePaste(raw)
    if (!text) return
    // A modal owns the keyboard: no folding and no attachments there, just the
    // characters into whichever field is focused.
    if (modal || searching()) {
      for (const ch of text) pasteKey(ch)
      return
    }

    const file = imagePathIn(text)
    if (file) {
      detach(() => attachImageFile(file))
      return
    }

    if (shouldFold(text)) {
      const attachment = attachments.addText(text)
      input += placeholderFor(attachment)
      statusMessage = `anexado ${describeAttachment(attachment)} ${g.sep} apague o marcador para remover`
      return
    }

    for (const ch of text) pasteKey(ch)
  }

  async function attachImageFile(file: string): Promise<void> {
    const result = await readImageFile(file, session.cwd)
    if (!result.ok) {
      // The path may well have been meant as text; keeping it is the safe
      // reading of an ambiguous paste.
      input += file
      statusMessage = `${result.reason} ${g.sep} colei como texto`
      dirty = true
      return
    }
    const attachment = attachments.addImage(result.data, result.mediaType, file)
    input += placeholderFor(attachment)
    statusMessage = `anexado ${describeAttachment(attachment)}`
    dirty = true
  }

  /** ctrl+v: the clipboard holds bytes no terminal will ever send as keys. */
  async function attachClipboardImage(): Promise<void> {
    statusMessage = 'lendo imagem do clipboard...'
    dirty = true
    let image
    try {
      image = await readImageFromClipboard()
    } catch {
      image = null
    }
    if (!image) {
      statusMessage = 'nenhuma imagem no clipboard'
      dirty = true
      return
    }
    const attachment = attachments.addImage(image.data, image.mediaType)
    input += placeholderFor(attachment)
    statusMessage = `anexado ${describeAttachment(attachment)}`
    dirty = true
  }

  function handleModalKey(key: string): boolean {
    if (!modal) return false
    if (modal.kind === 'busy') {
      // Everything is swallowed while the work runs, *except* the two keys that
      // exist to get out of something: ctrl+c and esc. A modal that eats them
      // leaves a session with a hung network call and no way to interrupt it or
      // to quit — the only exit was killing the terminal.
      if (key === '\x03' || key === ESC) return false
      return true
    }
    // Navegável, ao contrário das outras: aqui enter tem consequência — abre a
    // sessão destacada — então ele não pode significar "fechei de olhar".
    if (modal.kind === 'sessionTree') {
      const tree = modal
      const rows = flattenTree(tree.roots)
      if (key === ESC || key === 'q' || key === '\x13') {
        modal = null
      } else if (key === `${CSI}A` || key === `${ESC}OA`) {
        tree.index = Math.max(0, tree.index - 1)
      } else if (key === `${CSI}B` || key === `${ESC}OB`) {
        tree.index = Math.min(Math.max(0, rows.length - 1), tree.index + 1)
      } else if (key === '\r' || key === '\n') {
        const chosen = rows[tree.index]
        modal = null
        // Reabrir a sessão em que já se está reconstruiria a tela inteira para
        // chegar exatamente onde ela já estava.
        if (chosen && chosen.id !== session.transcript.sessionId) detach(() => resumeSession(chosen.id))
        else if (chosen) say('você já está nesta sessão')
      }
      dirty = true
      return true
    }

    if (modal.kind === 'tasks' || modal.kind === 'mcp' || modal.kind === 'workflows') {
      // Read-only: anything that means "done looking" closes it, including the
      // shortcut that opened it. `ctrl+m` is not usable as a shortcut anywhere —
      // the terminal sends 0x0D for it, which is indistinguishable from Enter.
      const own = modal.kind === 'tasks' ? '\x14' : modal.kind === 'mcp' ? '\x10' : ''
      if (key === ESC || key === '\r' || key === 'q' || (own && key === own)) {
        modal = null
        dirty = true
      }
      return true
    }

    if (modal.kind === 'permission') {
      const k = key.toLowerCase()
      if (k === 'y' || key === '\r' || key === '\n') {
        modal.resolve(true)
        modal = null
      } else if (k === 'a') {
        const tool = modal.request.tool
        session.config.permissions ??= {}
        session.config.permissions.allow ??= []
        // Ahead of what is already there, and the matching `ask` rules go: an
        // `ask` outranks an `allow`, so appending made "allow for the session"
        // ask again on the very next call — the answer had no effect at all.
        session.config.permissions.allow.unshift(tool)
        session.config.permissions.ask = (session.config.permissions.ask ?? []).filter(
          rule => rule !== tool && !rule.startsWith(`${tool}(`),
        )
        modal.resolve(true)
        modal = null
      } else if (k === 'n' || key === ESC) {
        modal.resolve(false)
        modal = null
      }
      dirty = true
      return true
    }

    if (modal.kind === 'input') {
      if (key === '\r' || key === '\n') {
        const value = modal.value
        const done = modal.resolve
        modal = null
        done(value)
      } else if (key === ESC) {
        const done = modal.resolve
        modal = null
        done(null)
      } else if (key === '\x7f' || key === '\b') {
        modal.value = modal.value.slice(0, -1)
      } else if (key.length === 1 && key >= ' ') {
        modal.value += key
      }
      dirty = true
      return true
    }

    if (modal.kind === 'form') {
      const form = modal
      const field = form.fields[form.index]
      const move = (delta: number) => {
        form.index = (form.index + delta + form.fields.length) % form.fields.length
      }
      // Any keystroke means the user is acting on the complaint, so it stops
      // being shown — a stale error beside a field already fixed reads as a
      // second, different failure.
      form.error = undefined

      if (key === ESC) {
        const done = form.resolve
        modal = null
        done(null)
      } else if (key === '\t' || key === `${CSI}B` || key === `${ESC}OB`) {
        move(1)
      } else if (key === `${CSI}Z` || key === `${CSI}A` || key === `${ESC}OA`) {
        move(-1)
      } else if (key === '\r' || key === '\n') {
        // Enter advances while there is anywhere to advance to, and only submits
        // from the last field. Submitting from the middle would let a stray
        // Enter on row two write a provider with rows three onward empty.
        if (form.index < form.fields.length - 1) {
          move(1)
        } else {
          const missing = form.fields.find(f => f.required && !f.value.trim() && !f.placeholder)
          if (missing) {
            form.error = `${missing.label} é obrigatório`
            form.index = form.fields.indexOf(missing)
          } else {
            const values = Object.fromEntries(
              form.fields.map(f => [f.name, f.value.trim() || f.placeholder?.trim() || '']),
            )
            const done = form.resolve
            modal = null
            done(values)
          }
        }
      } else if (key === '\x7f' || key === '\b') {
        if (field) field.value = field.value.slice(0, -1)
      } else if (key === '\x15') {
        // ctrl+u clears the field: a pasted key is long enough that fixing it
        // one backspace at a time is its own small punishment.
        if (field) field.value = ''
      } else if (key.length === 1 && key >= ' ') {
        if (field) field.value += key
      }
      dirty = true
      return true
    }

    const items = filterItems(modal.all, modal.filter)
    if (key === `${CSI}A`) modal.index = Math.max(0, modal.index - 1)
    else if (key === `${CSI}B`) modal.index = Math.min(Math.max(0, items.length - 1), modal.index + 1)
    else if (key === `${CSI}5~`) modal.index = Math.max(0, modal.index - 10)
    else if (key === `${CSI}6~`) modal.index = Math.min(Math.max(0, items.length - 1), modal.index + 10)
    else if (key === '\r' || key === '\n') {
      const chosen = items[modal.index]?.value ?? null
      const done = modal.resolve
      modal = null
      done(chosen)
    } else if (key === ESC) {
      const done = modal.resolve
      modal = null
      done(null)
    } else if (key === '\x7f' || key === '\b') {
      modal.filter = modal.filter.slice(0, -1)
      modal.index = 0
    } else if (key.length === 1 && key >= ' ') {
      modal.filter += key
      modal.index = 0
    }
    dirty = true
    return true
  }

  function scrollBy(delta: number): void {
    scroll = Math.max(0, Math.min(maxScroll, scroll + delta))
    // The selection is anchored to screen cells, so scrolling would leave it
    // highlighting text that is no longer there.
    selection = null
    selecting = false
    dirty = true
  }

  /**
   * Wheel scrolls; left-drag selects a character range and copies it on release.
   * The app owns the mouse while reporting is on, so the terminal's own
   * click-drag selection is unavailable — `/mouse off` hands it back.
   */
  function handleMouse(key: string): void {
    const match = key.match(/^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/)
    if (!match) return
    const button = Number(match[1])
    const col = Number(match[2])
    const row = Number(match[3])
    const press = match[4] === 'M'

    if (button & 64) {
      if (!modal) scrollBy(button & 1 ? -3 : 3)
      return
    }
    if (modal) return

    const isLeft = (button & 3) === 0
    const isDrag = (button & 32) !== 0

    if (press && isLeft && !isDrag) {
      selection = { anchor: { row, col }, head: { row, col } }
      selecting = true
      dirty = true
      return
    }
    if (press && isDrag && selecting && selection) {
      selection = { anchor: selection.anchor, head: { row, col } }
      dirty = true
      return
    }
    if (!press && selecting) {
      selecting = false
      const sel = selection
      // A click (no drag) activates a session row if it landed on one, and does
      // nothing anywhere else — it never touches the clipboard.
      if (!sel || spanOf(sel).empty) {
        selection = null
        dirty = true
        if (sel) activateRowAt(sel.anchor.row)
        return
      }
      detach(() => finishSelection())
    }
  }

  /** Plain, full-width text of a drawn row, so columns line up with the mouse. */
  function frameRow(row: number, cols: number): string {
    return pad(stripAnsi(previousFrame[row - 1] ?? ''), cols)
  }

  function selectedText(sel: { anchor: Point; head: Point }): string {
    const { start, end, empty } = spanOf(sel)
    if (empty) return ''
    const cols = layout().cols
    const out: string[] = []
    for (let row = Math.max(1, start.row); row <= Math.min(previousFrame.length, end.row); row++) {
      const { from, to } = rowRange(row, start, end, cols)
      out.push(frameRow(row, cols).slice(from, to).replace(/\s+$/, ''))
    }
    return out.join('\n')
  }

  async function finishSelection(): Promise<void> {
    if (!selection) return
    const current = selection
    const text = selectedText(current)
    selection = null
    dirty = true

    // Nothing was dragged over: leave the clipboard alone and say nothing. A
    // click in the composer should not silently replace what the user copied.
    if (!text.trim()) return

    const copied = await copyToClipboard(text)
    const lines = text.split('\n').length
    const label =
      lines > 1
        ? `${lines} linhas copiadas`
        : `${text.length} caractere${text.length === 1 ? '' : 's'} copiado${text.length === 1 ? '' : 's'}`
    statusMessage = copied ? label : 'sem ferramenta de clipboard disponível'
    dirty = true
  }

  function onKey(chunk: Buffer): void {
    // Decoded across reads: a multi-byte character split between two chunks
    // decoded as two replacement characters and typed as such.
    const { keys, pending } = splitKeys(pendingKeys + keyDecoder.write(chunk))
    pendingKeys = pending
    if (pendingKeyTimer) clearTimeout(pendingKeyTimer)
    // A real Esc keypress is indistinguishable from the start of a sequence
    // until either the rest arrives or it does not. Nothing after this long is
    // taken to be the key itself, so Esc still answers immediately enough to
    // feel like a key and a split sequence is still reassembled.
    if (pending) {
      pendingKeyTimer = setTimeout(() => {
        const held = pendingKeys
        pendingKeys = ''
        pendingKeyTimer = undefined
        // A lone ESC that never grew into a sequence is the Esc key. A sequence
        // that never finished is dropped: half of one is not a keystroke.
        if (held === ESC) handleKeys([ESC])
      }, ESC_HOLD_MS)
      pendingKeyTimer.unref?.()
    }
    handleKeys(keys)
  }

  function handleKeys(keys: string[]): void {
    for (const key of keys) {
      // Inside a bracketed paste everything is literal text — no submit, no
      // command interpretation, newlines preserved.
      if (key === PASTE_START) {
        pasting = true
        pasteBuffer = ''
        continue
      }
      if (key === PASTE_END) {
        pasting = false
        const pasted = pasteBuffer
        pasteBuffer = ''
        commitPaste(pasted)
        completionIndex = 0
        dirty = true
        continue
      }
      if (pasting) {
        // Collected whole and folded once. Feeding it through per character
        // redrew the frame for every byte, so a big paste crawled and flickered.
        pasteBuffer += key
        continue
      }

      if (key.startsWith(`${CSI}<`)) {
        handleMouse(key)
        continue
      }

      if (handleModalKey(key)) continue

      // A terminal cannot send image bytes as keys, so this asks the OS
      // clipboard directly; text pastes still arrive as a bracketed burst.
      //
      // Two bindings on purpose: most terminals swallow ctrl+v as their own
      // paste and it never reaches us, so alt+v is the one that always works.
      if (key === '\x16' || key === `${ESC}v` || key === `${ESC}V`) {
        detach(() => attachClipboardImage())
        continue
      }

      if (keyEcho) {
        if (key === ESC) {
          keyEcho = false
          say('eco de teclas desligado')
        } else {
          say(`tecla: ${describeKey(key)}`)
        }
        continue
      }

      // End / Home, with or without modifiers, in either encoding terminals use.
      if (END_KEY.test(key)) {
        scroll = 0
        dirty = true
        continue
      }
      if (HOME_KEY.test(key)) {
        scroll = maxScroll
        dirty = true
        continue
      }

      if (key === '\x03') {
        if (busy) {
          session.abort?.abort()
          statusMessage = 'interrompido'
        } else if (input) {
          input = ''
        } else {
          interrupts++
          statusMessage = interrupts >= 2 ? 'tchau' : 'ctrl+c de novo para sair'
          if (interrupts >= 2) {
            exiting = true
            submitLine({ line: '', text: '', images: [] })
          }
        }
        dirty = true
        continue
      }
      if (key === '\x04' && !input) {
        exiting = true
        submitLine({ line: '', text: '', images: [] })
        continue
      }
      interrupts = 0

      if (key === `${CSI}Z` || key === `${ESC}m` || key === `${ESC}M`) {
        cycleMode()
        continue
      }
      // ctrl+a walks the subagent strip; from inside a viewer it goes back.
      if (key === '\x01') {
        if (viewingAgent) leaveAgentView()
        else cycleAgentFocus()
        continue
      }
      if (key === '\x12') {
        toggleTool()
        continue
      }
      // ctrl+g: the changed files and their diffs.
      if (key === '\x07') {
        toggleChangesView()
        continue
      }
      // Inside the changes screen the arrows pick the file instead of walking
      // the input history — the composer is not where the eye is.
      if (viewingChanges && (key === `${CSI}A` || key === `${ESC}OA`)) {
        moveChangeSelection(-1)
        continue
      }
      if (viewingChanges && (key === `${CSI}B` || key === `${ESC}OB`)) {
        moveChangeSelection(1)
        continue
      }
      // `r` desfaz o arquivo selecionado — só dentro da tela, e só com confirmação.
      if (viewingChanges && (key === 'r' || key === 'R')) {
        detach(() => revertSelectedChange())
        continue
      }
      // alt+↑/↓ walks the tool blocks so ctrl+r can hit any of them, not just
      // the last — the same thing a click does, without the mouse.
      if (key === `${CSI}1;3A` || key === `${ESC}${CSI}A`) {
        moveToolFocus(-1)
        continue
      }
      if (key === `${CSI}1;3B` || key === `${ESC}${CSI}B`) {
        moveToolFocus(1)
        continue
      }

      if (NEWLINE_KEYS.has(key)) {
        input += '\n'
        completionIndex = 0
        dirty = true
        continue
      }

      // ctrl+y: grouped diff <-> side by side. Clicking a diff does the same.
      if (key === '\x19') {
        toggleDiffLayout()
        continue
      }
      // ctrl+t: the task list the model built, on demand.
      if (key === '\x14') {
        modal = modal?.kind === 'tasks' ? null : { kind: 'tasks' }
        dirty = true
        continue
      }
      // ctrl+p: MCP servers. Not ctrl+m — that arrives as 0x0D, same as Enter.
      if (key === '\x10') {
        modal = modal?.kind === 'mcp' ? null : { kind: 'mcp' }
        dirty = true
        continue
      }
      // ctrl+s: a árvore de sessões e forks deste projeto.
      if (key === '') {
        if (modal?.kind === 'sessionTree') {
          modal = null
          dirty = true
        } else {
          detach(() => openSessionTree())
        }
        continue
      }
      // Tab cycles the primary agent, opencode-style — but only when the command
      // popup is not open, where Tab already means "complete".
      if (key === '\t' && currentCompletions().length === 0) {
        // Not while a turn is running: switching rebuilds the tool registry and
        // can change the model, and the loop re-reads both between steps. A
        // stray Tab mid-turn took away a tool the model was in the middle of
        // using — the next call came back `Unknown tool` — and could finish the
        // turn on a different model than it started on.
        if (busy) {
          statusMessage = 'troque de agente entre turnos — um turno está rodando'
          dirty = true
          continue
        }
        cyclePrimaryAgent()
        continue
      }

      // ctrl+f opens (and closes) the session search on the startup screen.
      if (key === '\x06') {
        if (homeBlock()) {
          homeSearch = homeSearch === null ? '' : null
          homeIndex = -1
          statusMessage = homeSearch === null ? '' : 'buscando sessões — esc sai'
          dirty = true
        } else {
          statusMessage = 'a busca de sessões só existe na tela inicial (/sessions)'
          dirty = true
        }
        continue
      }

      // While the search owns the keyboard, every printable key goes to it — the
      // composer is untouched, so a keystroke never lands in two places.
      if (searching()) {
        const matches = homeMatches()
        if (key === '\r') {
          const chosen = homeIndex >= 0 ? matches[homeIndex] : matches[0]
          if (chosen) {
            homeSearch = null
            detach(() => resumeSession(chosen.id))
          }
          continue
        }
        if (key === ESC) {
          homeSearch = null
          homeIndex = -1
          statusMessage = ''
          dirty = true
          continue
        }
        if (key === '\x7f' || key === '\b') {
          homeSearch = (homeSearch ?? '').slice(0, -1)
          homeIndex = -1
          dirty = true
          continue
        }
        if (key === `${CSI}A`) {
          if (matches.length > 0) homeIndex = homeIndex <= 0 ? matches.length - 1 : homeIndex - 1
          dirty = true
          continue
        }
        if (key === `${CSI}B`) {
          if (matches.length > 0) homeIndex = homeIndex + 1 >= matches.length ? 0 : homeIndex + 1
          dirty = true
          continue
        }
        if (key.length === 1 && key >= ' ') {
          homeSearch = (homeSearch ?? '') + key
          homeIndex = -1
          dirty = true
          continue
        }
        // Anything else (ctrl+c, mode cycling, scrolling) falls through.
      }

      const completions = currentCompletions()
      // The arrows navigate the startup list while the composer is empty; a slash
      // command still gives the popup precedence.
      const home = completions.length === 0 && !input ? homeBlock() : null
      const matches = home ? homeMatches() : []

      if (key === '\r') {
        // A focused subagent wins: that is what ctrl+a was for.
        const agent = focusedAgent()
        if (agent) {
          openAgent(agent)
          agentIndex = -1
          continue
        }
        // Only an explicitly highlighted row opens a session; otherwise Enter
        // sends what was typed, so filtering never hijacks a prompt.
        if (home && homeIndex >= 0 && matches[homeIndex]) {
          detach(() => resumeSession(matches[homeIndex].id))
          continue
        }
        if (completions.length > 0) {
          input = `/${completions[completionIndex % completions.length].value}`
        }
        const line = input.trim()
        // Placeholders are resolved here, while the store still holds them, and
        // not at the point of use: by then the composer has been cleared.
        const { text: expandedText, images } = expandAttachments(line, attachments)
        input = ''
        completionIndex = 0
        if (line) {
          history.unshift(line)
          historyIndex = -1
          // Typed during a turn: it goes in the queue, and the queue is visible.
          // It used to sit in `pending` with nothing on screen to say so.
          if (busy) {
            const block: Block = { kind: 'user', text: line, pending: true }
            queuedLines.push(block)
            push(block)
          }
          submitLine({ line, text: expandedText, images })
          // Anything no longer referenced by the composer can go; the submission
          // already holds what it needs.
          attachments.sweep('')
        }
        dirty = true
        continue
      }
      if (key === '\t') {
        if (completions.length > 0) {
          input = `/${completions[completionIndex % completions.length].value} `
          completionIndex = 0
        }
        dirty = true
        continue
      }
      if (key === '\x7f' || key === '\b') {
        input = input.slice(0, -1)
        completionIndex = 0
        if (homeIndex >= 0) homeIndex = -1
        dirty = true
        continue
      }
      if (key === `${CSI}A`) {
        if (completions.length > 0) {
          completionIndex = (completionIndex - 1 + completions.length) % completions.length
        } else if (agentIndex >= 0) {
          const list = agentList()
          agentIndex = agentIndex <= 0 ? list.length - 1 : agentIndex - 1
        } else if (home && matches.length > 0) {
          homeIndex = homeIndex <= 0 ? matches.length - 1 : homeIndex - 1
        } else if (historyIndex + 1 < history.length) {
          // What was being typed is put aside on the way into the history, and
          // handed back on the way out. Without it, one arrow key destroyed a
          // half-written message with no undo of any kind.
          if (historyIndex === -1) draft = input
          historyIndex++
          input = history[historyIndex]
        }
        dirty = true
        continue
      }
      if (key === `${CSI}B`) {
        if (completions.length > 0) {
          completionIndex = (completionIndex + 1) % completions.length
        } else if (agentIndex >= 0) {
          const list = agentList()
          agentIndex = agentIndex + 1 >= list.length ? 0 : agentIndex + 1
        } else if (home && matches.length > 0) {
          homeIndex = homeIndex + 1 >= matches.length ? 0 : homeIndex + 1
        } else if (historyIndex > 0) {
          historyIndex--
          input = history[historyIndex]
        } else if (historyIndex === 0) {
          historyIndex = -1
          input = draft
          draft = ''
        }
        dirty = true
        continue
      }
      if (key === ESC) {
        // Leaving a view — subagent or changes — or releasing the strip comes
        // before the interrupt: esc there means "go back", not "kill the turn".
        if (viewingChanges) {
          toggleChangesView()
          continue
        }
        if (leaveAgentView()) continue
        if (agentIndex >= 0) {
          agentIndex = -1
          statusMessage = 'foco de volta no composer'
          dirty = true
          continue
        }
        if (busy) session.abort?.abort()
        // Esc on the startup screen means "none of these, new session".
        if (home && homeIndex >= 0) homeIndex = -1
        input = ''
        completionIndex = 0
        dirty = true
        continue
      }
      if (key === `${CSI}5~`) {
        scrollBy(10)
        continue
      }
      if (key === `${CSI}6~`) {
        scrollBy(-10)
        continue
      }
      if (key.length === 1 && key >= ' ') {
        input += key
        completionIndex = 0
        // Typing re-filters the startup list, so any previous highlight is stale
        // — and Enter must send the prompt, not reopen whatever was selected.
        if (homeIndex >= 0) homeIndex = -1
        dirty = true
      }
    }
    // Typing must feel immediate, so keys bypass the throttle.
    draw()
  }

  // ------------------------------------------------------------ connect flow

  async function connectFlow(preset?: string): Promise<void> {
    // A provider already in the config only needs a credential, so this runs
    // before the catalog: downloading models.dev to connect something already
    // declared here would fail on a machine that is offline or behind a proxy.
    if (preset && session.config.provider?.[preset]) {
      const declared = session.config.provider[preset]
      const key = await askInput(`connect ${preset}`, 'API key', {
        masked: true,
        detail: [declared.env?.[0], declared.options?.baseURL].filter(Boolean).join(' · '),
        footer: `grava em ${authPath()} · enter confirma · esc cancela`,
      })
      if (!key) {
        say('connect cancelado')
        return
      }
      const file = await saveCredential(preset, { type: 'api', key })
      say(`${preset} conectado · ${maskKey(key)} em ${file}`)
      return
    }

    let catalog
    try {
      catalog = await withBusyModal('connect', 'baixando catálogo de providers…', () => loadCatalog())
    } catch (err) {
      push({ kind: 'error', text: String(err) })
      return
    }

    const items: PickerItem[] = Object.values(catalog)
      .map(p => ({
        label: p.id,
        value: p.id,
        hint: `${p.name ?? p.id} · ${Object.keys(p.models ?? {}).length} models`,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))

    const providerId = preset && catalog[preset] ? preset : await pick('connect provider', items)
    if (!providerId) return

    const provider = catalog[providerId]
    if (!provider) {
      push({ kind: 'error', text: `provider desconhecido "${providerId}"` })
      return
    }

    const envName = provider.env?.[0]
    let key = envName ? process.env[envName] : undefined
    if (key) {
      say(`usando ${envName} do ambiente`)
    } else {
      key =
        (await askInput(`connect ${providerId}`, 'API key', {
          masked: true,
          detail: [envName, provider.api].filter(Boolean).join(' · '),
          footer: `grava em ${authPath()} (chmod 600) · enter confirma · esc cancela`,
        })) ?? undefined
      if (!key) {
        say('connect cancelado')
        return
      }
    }

    const baseAnswer = await askInput(`connect ${providerId}`, 'base URL', {
      detail: `branco mantém ${provider.api || 'o default do provider'}`,
    })
    if (baseAnswer === null) {
      say('connect cancelado')
      return
    }

    const file = await saveCredential(providerId, {
      type: 'api',
      key,
      baseURL: baseAnswer.trim() || undefined,
    })
    session.config.provider = (await withConnectedProviders(session.config)).provider

    const models = topModels(provider, 3)
    push({
      kind: 'assistant',
      text: [
        `**${providerId} conectado** · ${maskKey(key)} em \`${file}\``,
        '',
        ...models.map(m => `- \`${providerId}/${m}\``),
        '',
        'use `/model` para trocar. nenhuma edição de config foi necessária.',
      ].join('\n'),
    })
  }

  /**
   * `/add-provider`: declares a provider in the config file, which is what
   * `/connect` deliberately does *not* do — that one stores a credential for a
   * provider models.dev already describes. A private gateway, a vLLM box or an
   * internal proxy is in no catalog, so until now it meant editing JSONC by hand
   * and restarting.
   *
   * The API key is the one field that does not go into the config: it goes to
   * `auth.json`, so the file stays committable.
   */
  async function addProviderFlow(preset?: string): Promise<void> {
    const target = await findConfigTarget(session.cwd)
    const shown = target.present ? target.file : `${target.file} (será criado)`

    const values = await askForm(
      'add provider',
      [
        {
          name: 'id',
          label: 'id',
          value: preset ?? '',
          required: true,
          hint: 'usado no /model como <id>/<modelo> — minúsculas, sem espaço',
        },
        { name: 'name', label: 'nome', value: '', hint: 'rótulo exibido; em branco usa o id' },
        {
          name: 'baseURL',
          label: 'base URL',
          value: '',
          placeholder: 'https://…/v1',
          required: true,
          hint: 'endpoint compatível com OpenAI, incluindo o /v1',
        },
        {
          name: 'npm',
          label: 'npm',
          value: '',
          placeholder: '@ai-sdk/openai-compatible',
          hint: 'pacote do AI SDK que implementa o provider',
        },
        {
          name: 'env',
          label: 'env',
          value: '',
          hint: 'nome da variável de ambiente com a chave; em branco só usa o auth.json',
        },
        {
          name: 'modelKey',
          label: 'modelo',
          value: '',
          required: true,
          hint: 'apelido curto usado no /model, ex. sonnet',
        },
        {
          name: 'modelId',
          label: 'id do modelo',
          value: '',
          required: true,
          hint: 'id exato que o servidor espera, ex. claude-sonnet-5',
        },
        {
          name: 'context',
          label: 'contexto',
          value: '',
          placeholder: '128000',
          hint: 'janela de contexto em tokens',
        },
        {
          name: 'output',
          label: 'saída',
          value: '',
          placeholder: '16384',
          hint: 'teto de tokens de saída por resposta',
        },
        {
          name: 'key',
          label: 'API key',
          value: '',
          masked: true,
          hint: `opcional · vai para ${authPath()}, nunca para o arquivo de config`,
        },
      ],
      {
        detail: `grava em ${shown}`,
        footer: 'tab/↑↓ move · enter avança, no último salva · ctrl+u limpa o campo · esc cancela',
      },
    )
    if (!values) {
      say('add-provider cancelado')
      return
    }

    const id = values.id.trim()
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(id)) {
      push({
        kind: 'error',
        text: `id inválido "${id}" — use letras, números, ponto, hífen ou underscore`,
      })
      return
    }
    // The check is against the merged config, not just the file: a provider from
    // the user-level config would be shadowed silently, and the resulting
    // "unknown model" would point at the wrong file entirely.
    if (session.config.provider?.[id]) {
      push({
        kind: 'error',
        text: `provider "${id}" já existe nesta configuração — use outro id ou edite ${target.file}`,
      })
      return
    }

    const context = Number(values.context)
    const output = Number(values.output)
    if (!Number.isFinite(context) || !Number.isFinite(output) || context <= 0 || output <= 0) {
      push({ kind: 'error', text: 'contexto e saída precisam ser números positivos' })
      return
    }

    const provider: ProviderConfig = {
      npm: values.npm,
      ...(values.name ? { name: values.name } : {}),
      ...(values.env ? { env: [values.env] } : {}),
      options: { baseURL: values.baseURL },
      models: {
        [values.modelKey]: {
          id: values.modelId,
          limit: { context, output },
        },
      },
    }

    let file: string
    try {
      file = await addProvider(target.file, id, provider)
    } catch (err) {
      push({ kind: 'error', text: `não deu para gravar em ${target.file}: ${describeError(err)}` })
      return
    }

    let keyNote = ''
    if (values.key) {
      const authFile = await saveCredential(id, { type: 'api', key: values.key })
      keyNote = `chave ${maskKey(values.key)} salva em \`${authFile}\``
    }

    // Applied in memory too, so `/model` reaches it in this session instead of
    // after a restart — the config file is the record, not the mechanism.
    session.config.provider = { ...(session.config.provider ?? {}), [id]: provider }

    const ref = `${id}/${values.modelKey}`
    push({
      kind: 'assistant',
      text: [
        `**${id} adicionado** em \`${file}\``,
        '',
        `- \`${ref}\` ${g.sep} ${values.modelId}`,
        `- baseURL \`${values.baseURL}\``,
        ...(values.env ? [`- chave lida de \`${values.env}\``] : []),
        ...(keyNote ? [`- ${keyNote}`] : []),
        ...(values.key || values.env
          ? []
          : ['- sem credencial ainda — rode `/connect ' + id + '` quando tiver a chave']),
        '',
        `Use com \`/model ${ref}\`.`,
      ].join('\n'),
    })
  }

  /**
   * `/add-model`: um modelo novo num provider que já existe.
   *
   * O picker vem primeiro porque a escolha do provider determina o resto —
   * inclusive em qual arquivo isso vai ser gravado, que não é necessariamente o
   * config do projeto: o provider pode estar declarado no config do usuário, e
   * escrever no do projeto criaria uma segunda declaração parcial dele.
   */
  async function addModelFlow(preset?: string): Promise<void> {
    const declared = Object.entries(session.config.provider ?? {})
    if (declared.length === 0) {
      say('nenhum provider configurado — use /add-provider primeiro')
      return
    }

    const providerId =
      preset && session.config.provider?.[preset]
        ? preset
        : await pick(
            'em qual provider',
            declared.map(([id, p]) => {
              const count = Object.keys(p.models ?? {}).length
              const base = (p.options?.baseURL as string | undefined) ?? ''
              return {
                label: id,
                value: id,
                hint: `${count} modelo${count === 1 ? '' : 's'}${base ? ` ${g.sep} ${base}` : ''}`,
              }
            }),
          )
    if (!providerId) return

    const provider = session.config.provider?.[providerId]
    if (!provider) {
      push({ kind: 'error', text: `provider desconhecido "${providerId}"` })
      return
    }

    const file = await findProviderFile(session.cwd, providerId)
    if (!file) {
      push({
        kind: 'error',
        text:
          `"${providerId}" não está declarado em nenhum arquivo de config — ele veio do ` +
          `catálogo via \`/connect\`. Use \`/add-provider\` para declará-lo antes de adicionar modelos.`,
      })
      return
    }

    // Os limites do último modelo viram o default: um provider costuma ter a
    // mesma janela em toda a família, e redigitar 128000 é onde o erro entra.
    const siblings = Object.values(provider.models ?? {})
    const last = siblings[siblings.length - 1]
    const existing = Object.keys(provider.models ?? {})

    const values = await askForm(
      `add model ${g.sep} ${providerId}`,
      [
        {
          name: 'modelKey',
          label: 'apelido',
          value: '',
          required: true,
          hint:
            `usado no /model como ${providerId}/<apelido>` +
            (existing.length ? ` · já existem: ${existing.join(', ')}` : ''),
        },
        {
          name: 'modelId',
          label: 'id do modelo',
          value: '',
          required: true,
          hint: 'id exato que o servidor espera, ex. claude-sonnet-5',
        },
        { name: 'name', label: 'nome', value: '', hint: 'rótulo exibido; em branco usa o apelido' },
        {
          name: 'context',
          label: 'contexto',
          value: '',
          placeholder: String(last?.limit?.context ?? 128000),
          hint: 'janela de contexto em tokens',
        },
        {
          name: 'output',
          label: 'saída',
          value: '',
          placeholder: String(last?.limit?.output ?? 16384),
          hint: 'teto de tokens de saída por resposta',
        },
      ],
      {
        detail: `grava em ${file}`,
        footer: 'tab/↑↓ move · enter avança, no último salva · ctrl+u limpa o campo · esc cancela',
      },
    )
    if (!values) {
      say('add-model cancelado')
      return
    }

    const modelKey = values.modelKey.trim()
    if (provider.models?.[modelKey]) {
      push({ kind: 'error', text: `"${providerId}" já tem um modelo "${modelKey}"` })
      return
    }

    const context = Number(values.context)
    const output = Number(values.output)
    if (!Number.isFinite(context) || !Number.isFinite(output) || context <= 0 || output <= 0) {
      push({ kind: 'error', text: 'contexto e saída precisam ser números positivos' })
      return
    }

    const model = {
      id: values.modelId,
      ...(values.name ? { name: values.name } : {}),
      limit: { context, output },
    }

    try {
      await addModel(file, providerId, modelKey, model)
    } catch (err) {
      push({ kind: 'error', text: `não deu para gravar em ${file}: ${describeError(err)}` })
      return
    }

    // Em memória também, para o `/model` alcançar sem reiniciar.
    session.config.provider = {
      ...(session.config.provider ?? {}),
      [providerId]: { ...provider, models: { ...(provider.models ?? {}), [modelKey]: model } },
    }

    const ref = `${providerId}/${modelKey}`
    push({
      kind: 'assistant',
      text: [
        `**${ref} adicionado** em \`${file}\``,
        '',
        `- id \`${values.modelId}\``,
        `- contexto ${context} ${g.sep} saída ${output}`,
        '',
        `Use com \`/model ${ref}\`.`,
      ].join('\n'),
    })
  }

  // ------------------------------------------------------------- fork / árvore

  /**
   * Abre a árvore de sessões com a atual já destacada — quem abre isto quer
   * saber onde está antes de escolher para onde ir.
   */
  async function openSessionTree(): Promise<void> {
    const all = await listSessions(session.config, session.cwd)
    const roots = sessionTree(all)
    const rows = flattenTree(roots)
    const here = rows.findIndex(r => r.id === session.transcript.sessionId)
    modal = { kind: 'sessionTree', roots, index: here >= 0 ? here : 0 }
    dirty = true
  }

  /**
   * `/fork`: continua daqui numa sessão nova, deixando esta intacta.
   *
   * O histórico é copiado, então as duas divergem a partir deste ponto — é o
   * caso de "quero tentar outro caminho sem perder o que já foi construído".
   * A sessão é salva em disco na hora: sem isso ela só existiria em memória até
   * o primeiro turno, e um fork abandonado antes disso sumiria da árvore.
   */
  async function forkFlow(): Promise<void> {
    const parentTitle = titleOfCurrent()
    const { id, parentId, atMessage } = session.forkFrom()

    try {
      await saveSessionState(session.config, {
        id,
        cwd: session.cwd,
        modelRef: session.modelRef,
        messages: session.messages,
        parentId,
        forkedAtMessage: atMessage,
      })
    } catch (err) {
      push({ kind: 'error', text: `fork criado mas não pôde ser salvo: ${describeError(err)}` })
    }

    push({
      kind: 'divider',
      label: 'fork',
      detail:
        `#${id.slice(0, 8)} ${g.sep} de #${parentId.slice(0, 8)}` +
        `${parentTitle ? ` (${truncate(parentTitle, 40)})` : ''} ${g.sep} ${atMessage} mensagens`,
    })
    statusMessage = `fork #${id.slice(0, 8)} — a sessão anterior continua salva`
    dirty = true
  }

  /** Título da sessão atual, do primeiro texto de usuário que ela tiver. */
  function titleOfCurrent(): string {
    for (const message of session.messages) {
      if (message.role !== 'user') continue
      const text = visibleUserText(message)
      if (text) return text.slice(0, 72)
    }
    return ''
  }

  async function disconnectFlow(preset?: string): Promise<void> {
    const connected = await connectedProviders()
    if (connected.length === 0) {
      say('nada conectado')
      return
    }
    const target =
      preset && connected.includes(preset)
        ? preset
        : await pick('disconnect provider', connected.map(id => ({ label: id, value: id })))
    if (!target) return
    say((await removeCredential(target)) ? `${target} desconectado` : `${target} não estava conectado`)
  }

  async function authList(): Promise<void> {
    const store = await readAuth()
    const ids = Object.keys(store).sort()
    push({
      kind: 'assistant',
      text:
        ids.length === 0
          ? 'Nenhum provider conectado — rode `/connect`.'
          : ids
              .map(id => {
                const entry = store[id]
                const key = entry.key ?? entry.apiKey ?? entry.token ?? ''
                return `- **${id}** ${key ? maskKey(key) : '(sem chave)'}${entry.baseURL ? ` @ ${entry.baseURL}` : ''}`
              })
              .join('\n'),
    })
  }

  // --------------------------------------------------------------- lifecycle

  out.write(ALT_ON + CURSOR_HIDE + MOUSE_ON + PASTE_ON + CLEAR_SCREEN)
  process.stdin.setRawMode?.(true)
  process.stdin.resume()
  process.stdin.on('data', onKey)
  // A resize invalidates every cached row, so the screen is repainted whole.
  const onResize = () => repaint()
  out.on('resize', onResize)

  let ticks = 0
  const ticker = setInterval(() => {
    ticks++
    // Safety net for the permission queue: whatever happens to the microtask
    // that should have opened the next one, it opens here within 80 ms.
    showNextPermission()
    if (busy || modal) {
      spinner++
      dirty = true
    }
    // ~1.1s blink, matching the design's cursor cadence.
    if (ticks % 7 === 0) {
      blinkOn = !blinkOn
      dirty = true
    }
    draw()
  }, 80)

  draw()

  // The startup screen: composer ready to type, and the recent sessions listed
  // beside it so coming back to one is a keypress rather than a flag.
  try {
    const recent = (await listSessions(session.config, session.cwd)).slice(0, HOME_SESSIONS)
    if (recent.length > 0) {
      blocks.push({ kind: 'home', sessions: recent })
      // Nothing is preselected by default, so a first Enter sends the prompt
      // instead of silently reopening an old conversation.
      if (options.focusSessions) homeIndex = 0
      dirty = true
      draw()
    }
  } catch {
    // No history yet, or an unreadable data dir — the composer still works.
  }

  try {
    while (!exiting) {
      const submission = await nextLine()
      if (exiting || submission === null) break
      const line = submission.line
      if (!line) continue

      // The block for this line already exists if it waited in the queue; its
      // turn has come, so it stops being highlighted rather than being re-added.
      const fromQueue =
        queuedLines[0]?.kind === 'user' && queuedLines[0].text === line
          ? (queuedLines.shift() as Extract<Block, { kind: 'user' }>)
          : undefined

      if (line.startsWith('/')) {
        // A queued slash command is a command, not a message: drop its bubble.
        if (fromQueue) {
          const at = blocks.indexOf(fromQueue)
          if (at >= 0) blocks.splice(at, 1)
        }
        // A command that throws must not end the session. `/connect` writing to
        // a read-only `auth.json`, `/reload` on an unreadable asset, `/sessions`
        // on a broken data directory — any of those used to escape this loop,
        // taking the UI down and skipping the shutdown with it.
        let result: 'handled' | 'passthrough' | 'exit'
        try {
          result = await handleCommand(line)
        } catch (err) {
          push({ kind: 'error', text: describeError(err) })
          continue
        }
        if (result === 'exit') break
        if (result === 'handled') continue
      }

      const expanded = line.startsWith('/') ? expandCommand(line) : null
      if (line.startsWith('/') && expanded === null) continue
      // A slash command expands from the raw line; everything else uses the text
      // with its attachments already substituted in.
      const text = expanded ? expanded.text : submission.text

      // The splash and the session list belong to the startup screen only; once
      // the conversation starts they are noise.
      dropStartupBlocks()

      if (fromQueue) {
        fromQueue.pending = false
      } else {
        push({ kind: 'user', text: line })
      }
      // Sending something is the one moment the view *should* jump: the answer
      // to what was just asked is at the bottom.
      scroll = 0
      dirty = true
      // O foco numa tool era deliberado, mas do turno que acabou. Mantê-lo faz o
      // `ctrl+r` continuar abrindo uma chamada de vinte tools atrás, em vez da
      // que o usuário está olhando agora.
      focusedTool = null
      busy = true
      busySince = Date.now()
      busyChars = 0
      busyTokens = 0
      verbSeed = Math.floor(Math.random() * WORKING_VERBS.length)
      tipSeed = Math.floor(Math.random() * TIPS.length)
      statusMessage = ''
      dirty = true
      const undoOverrides = expanded ? applyCommandOverrides(expanded.command) : null
      try {
        await runTurn(session, text, { images: submission.images })
      } catch (err) {
        // A failure the loop already showed is not repeated here.
        if (!(err instanceof TurnFailure && err.shown)) push({ kind: 'error', text: describeError(err) })
      } finally {
        undoOverrides?.()
      }
      busy = false
      liveAssistant = null
      dirty = true
    }
  } finally {
    clearInterval(ticker)
    // Um job de background vivo segura o event loop com stdio em pipe: sem isso,
    // sair vira travar — para quem talvez nunca tenha usado a feature.
    killAllJobs(session)
    process.stdin.off('data', onKey)
    out.off('resize', onResize)
    process.stdin.setRawMode?.(false)
    process.stdin.pause()
    out.write(PASTE_OFF + MOUSE_OFF + CURSOR_SHOW + ALT_OFF)
    await session.transcript.flush()
  }

  // ---------------------------------------------------------------- commands

  function expandCommand(line: string): { text: string; command: SlashCommand } | null {
    const [name, ...rest] = line.slice(1).split(/\s+/)
    const args = rest.join(' ')
    const command = session.assets.commands.find(cmd => cmd.name === name)
    if (!command) {
      push({ kind: 'error', text: `comando desconhecido /${name} — digite / para ver a lista` })
      return null
    }
    const text = [
      `<command-name>/${name}</command-name>`,
      args ? `<command-args>${args}</command-args>` : '',
      expandCommandBody(command.body, args),
    ]
      .filter(Boolean)
      .join('\n')
    return { text, command }
  }

  /**
   * Applies a command's `model:` and `allowed-tools:` for its turn only, and
   * returns the undo. Scoped rather than sticky: `/revisar` running on a cheap
   * model must not leave the next question there too.
   */
  function applyCommandOverrides(command: SlashCommand): (() => void) | null {
    if (!command.model && !command.allowedTools) return null
    const previousModel = session.modelRef
    // The agent that is running, if any, is what the registry has to go back to:
    // rebuilding it unrestricted handed the session every tool again, quietly
    // undoing the `tools:` list the active agent was chosen for.
    const agent = session.primaryAgent
    const restore = agent && agent.tools.length > 0 ? agent.tools : undefined
    if (command.model) {
      try {
        session.setModelChecked(resolveAgentModel(session, command.model))
      } catch (err) {
        push({ kind: 'error', text: `${command.name}: ${describeError(err)}` })
      }
    }
    if (command.allowedTools) registerTools(session, command.allowedTools)
    return () => {
      if (command.model) session.setModel(previousModel)
      if (command.allowedTools) registerTools(session, restore)
    }
  }

  async function handleCommand(line: string): Promise<'handled' | 'passthrough' | 'exit'> {
    const [name, ...rest] = line.slice(1).split(/\s+/)
    const arg = rest.join(' ')

    switch (name) {
      case 'exit':
      case 'quit':
        return 'exit'

      case 'help':
        push({
          kind: 'assistant',
          text: [
            '# teclas',
            `- \`/\` abre a lista · enter roda o destacado`,
            '- `tab` troca o agente ativo (build → agentes `mode: primary`) · `/agent` abre o picker',
            '- `ctrl+t` abre as tasks que o modelo criou · `/tasks` também',
            '- `ctrl+p` abre os servidores MCP conectados · `/mcp` também',
            '- `ctrl+s` abre a árvore de sessões e forks · `↑↓` escolhe · `enter` entra · `/tree` também',
            '- `/fork` continua daqui numa sessão nova; a atual fica salva e intacta',
            '- `/context-all` detalha o contexto: setup, conversa, tools, mcp, skills',
            '- `shift+tab` alterna o modo de permissão',
            '- `ctrl+r` expande/colapsa a tool focada (a última, se nenhuma estiver)',
            '- **clique numa linha de tool** expande aquela · `alt+↑↓` move o foco sem mouse',
            '- `ctrl+y` alterna o diff entre agrupado e lado a lado · **clicar no `ctrl+y` da régua** faz o mesmo',
            '- `ctrl+g` abre os arquivos alterados: lista à esquerda, diff à direita · `/changes` também',
            '- `ctrl+a` foca a faixa de subagents · `↑↓` escolhe · `enter` abre a sessão dele',
            '- de dentro de um subagent, `esc` ou `ctrl+a` volta para a sessão principal',
            '- roda do mouse, `pgup/pgdn` rolam · `ctrl+end` volta ao fim · `ctrl+home` vai ao início',
            '- arraste com o mouse para selecionar do primeiro ao último caractere — ao soltar, copia',
            '- clique sem arrastar não seleciona nem copia nada',
            '- `/mouse off` devolve a seleção nativa do terminal · `/copy` copia a tela toda',
            '- `esc` limpa o composer',
            '- `ctrl+c` interrompe · 2× no vazio sai',
            '',
            '# sessões',
            '- na tela inicial, `↑↓` navega as sessões recentes e `enter` abre a destacada',
            '- `ctrl+f` busca sessões por nome — a busca é um campo próprio, não o composer',
            '- clicar numa linha também abre · `esc` volta para sessão nova',
            '- `/sessions` traz a lista de volta · `/resume [#id]` abre direto',
            '- fora da TUI: `hx --continue` retoma a última, `hx --resume [#id]` escolhe',
            '- o modo de permissão **não** é restaurado junto — retomar nunca reativa AUTO sozinho',
            '',
            '# providers',
            '- `/connect` guarda a credencial de um provider que o catálogo já conhece',
            '- `/add-provider` declara um que ele não conhece (gateway interno, vLLM, proxy) no arquivo de config',
            '- `/add-model` acrescenta um modelo a um provider já declarado — escolha o provider na lista',
            '- num formulário, `tab`/`↑↓` move entre campos, `ctrl+u` limpa o campo, `enter` no último salva',
            '- a chave nunca vai para o arquivo de config: ela vai para o `auth.json`',
            '',
            '# modos de permissão',
            ...PERMISSION_MODES.map(m => `- \`${MODE_LABEL[m]}\` ${MODE_HELP[m]}`),
            '',
            'Regras `deny` valem em **todos** os modos, AUTO incluído.',
          ].join('\n'),
        })
        return 'handled'

      case 'model': {
        const target =
          arg || (await pick('select model', listModels(session.config).map(m => ({ label: m, value: m }))))
        if (!target) return 'handled'
        try {
          session.setModelChecked(target)
          say(`model → ${target}`)
        } catch (err) {
          push({ kind: 'error', text: String(err) })
        }
        return 'handled'
      }

      case 'models':
        push({ kind: 'assistant', text: listModels(session.config).map(m => `- \`${m}\``).join('\n') })
        return 'handled'

      // `/connect` credencia um provider que o catálogo já descreve; este declara
      // um que ele nunca vai descrever — gateway interno, vLLM, proxy próprio.
      case 'add-provider':
        await addProviderFlow(arg.trim() || undefined)
        return 'handled'

      // Um modelo novo num provider que já existe: o picker escolhe qual.
      // Continua daqui numa sessão nova, deixando esta intacta.
      // Mesma modal do ctrl+s: um lugar só responde "onde estou e o que existe".
      case 'tree':
        await openSessionTree()
        return 'handled'

      case 'fork':
        await forkFlow()
        return 'handled'

      case 'add-model':
        await addModelFlow(arg.trim() || undefined)
        return 'handled'

      case 'connect':
        await connectFlow(arg || undefined)
        return 'handled'

      case 'disconnect':
        await disconnectFlow(arg || undefined)
        return 'handled'

      case 'auth':
        await authList()
        return 'handled'

      case 'mode': {
        const target =
          arg && (PERMISSION_MODES as string[]).includes(arg)
            ? arg
            : await pick(
                'permission mode',
                PERMISSION_MODES.map(m => ({ label: MODE_LABEL[m], value: m, hint: MODE_HELP[m] })),
              )
        if (!target) return 'handled'
        setMode(target as PermissionMode)
        return 'handled'
      }

      case 'skills':
        push({
          kind: 'assistant',
          text: `# skills\n${session.assets.skills.map(s => `- **${s.name}** ${s.description.slice(0, 60)}`).join('\n')}`,
        })
        return 'handled'

      case 'agents':
        push({
          kind: 'assistant',
          text: `# agents\n${session.assets.agents.map(a => `- **${a.name}** ${a.description.slice(0, 60)}`).join('\n')}`,
        })
        return 'handled'

      case 'commands':
        push({ kind: 'assistant', text: `# commands\n${session.assets.commands.map(cmd => `- \`/${cmd.name}\``).join('\n')}` })
        return 'handled'

      case 'tools':
        push({
          kind: 'assistant',
          text:
            `# tools\n- **ativas** ${session.registry.active().map(t => t.name).join(' ')}\n` +
            `- **deferred** ${session.registry.deferredNames().join(' ') || '(nenhuma)'}`,
        })
        return 'handled'

      // Same modal as ctrl+p: one place that answers "what is connected".
      case 'mcp':
        modal = { kind: 'mcp' }
        dirty = true
        return 'handled'

      case 'context-all':
        push({ kind: 'assistant', text: formatContextReport(session) })
        return 'handled'

      case 'context': {
        const used = contextTokens(session)
        const limit = contextLimit(session)
        const fraction = limit ? used / limit : 0
        const { width } = layout()
        push({
          kind: 'assistant',
          text:
            `# context\n${gauge(fraction, Math.min(24, width - 20))} ` +
            `**${Math.round(fraction * 100)}%** ${formatTokens(used)} / ${limit ? formatTokens(limit) : '?'} · ` +
            `${session.messages.length} msgs · sessão ${Math.round((Date.now() - startedAt) / 60000)}min`,
        })
        return 'handled'
      }

      case 'agent': {
        const list = primaryAgents()
        if (arg) {
          const wanted = arg.trim().toLowerCase()
          if (wanted === 'build' || wanted === 'none') {
            applyPrimaryAgent(null)
            return 'handled'
          }
          const found = list.find(a => a?.name.toLowerCase() === wanted)
          if (!found) {
            push({
              kind: 'error',
              text:
                `agente primary "${arg}" não encontrado. Disponíveis: ` +
                list.map(a => a?.name ?? 'build').join(', '),
            })
            return 'handled'
          }
          applyPrimaryAgent(found)
          return 'handled'
        }

        const chosen = await pick(
          'agente ativo',
          list.map(a => ({
            label: a?.name ?? 'build',
            value: a?.name ?? 'build',
            hint: a
              ? `${a.model ?? 'modelo da sessão'} · ${a.description.slice(0, 60)}`
              : 'comportamento padrão do harness',
          })),
        )
        if (chosen) applyPrimaryAgent(list.find(a => (a?.name ?? 'build') === chosen) ?? null)
        return 'handled'
      }

      case 'tasks':
        modal = { kind: 'tasks' }
        dirty = true
        return 'handled'

      case 'resume': {
        if (arg) {
          await resumeSession(arg.trim())
          return 'handled'
        }
        const all = await listSessions(session.config, session.cwd)
        if (all.length === 0) {
          say('nenhuma sessão salva ainda neste projeto')
          return 'handled'
        }
        const chosen = await pick(
          'retomar sessão',
          all.map(s => ({
            label: `#${s.short}  ${s.title}`,
            value: s.id,
            hint: `${s.turns} turno${s.turns === 1 ? '' : 's'} · ${formatWhen(s.updated)}`,
          })),
        )
        if (chosen) await resumeSession(chosen)
        return 'handled'
      }

      case 'sessions': {
        const all = await listSessions(session.config, session.cwd)
        if (all.length === 0) {
          say('nenhuma sessão salva ainda neste projeto')
          return 'handled'
        }
        // Pushing the block back makes it navigable and clickable again.
        dropStartupBlocks()
        blocks.push({ kind: 'home', sessions: all.slice(0, HOME_SESSIONS) })
        homeSearch = null
        homeIndex = 0
        scroll = 0
        dirty = true
        return 'handled'
      }

      case 'leadtime': {
        const stats = session.lastTurn
        if (!stats) {
          say('nenhum turno concluído ainda')
          return 'handled'
        }
        push({ kind: 'assistant', text: formatLeadtime(session, stats) })
        return 'handled'
      }

      case 'compact': {
        const result = await withBusyModal('compact', 'resumindo o histórico…', () =>
          compact(session, { instructions: arg, trigger: 'manual' }),
        )
        if (result.compacted) {
          push({
            kind: 'divider',
            label: 'contexto compactado',
            detail: `${formatTokens(result.before)} → ${formatTokens(result.after)} tokens`,
          })
        } else {
          say(`não compactou: ${result.reason}`)
        }
        return 'handled'
      }

      // A terminal app cannot choose its own font — the emulator owns that. What
      // it can do is show every glyph the design uses, so a missing one is
      // visible immediately instead of showing up as a stray box mid-session.
      case 'font': {
        const rows = [
          ['moldura', `${g.boxTopLeft}${g.boxH}${g.boxTopRight} ${g.boxV} ${g.boxBottomLeft}${g.boxH}${g.boxBottomRight} ${g.boxTDown} ${g.boxTUp} ${g.subRule}`],
          ['trilhos', `${g.railThick} ${g.railThin} ${g.sep}`],
          ['estado', `${g.ok} ${g.fail} ${g.warn} ${g.dotOn} ${g.dotOff}`],
          ['prompt', `${g.prompt} ${g.cursor} ${g.expand} ${g.collapse} ${g.git} ${g.ellipsis}`],
          ['spinner', g.spinner.join(' ')],
          ['sparkline', g.spark.join('')],
          ['wordmark', WORDMARK[0]],
        ]
        push({
          kind: 'assistant',
          text: [
            '# font',
            '',
            'Cada linha usa um grupo de glifos. Se algum aparecer como caixa vazia ou',
            '`?`, a fonte do terminal não cobre ele.',
            '',
            ...rows.map(([label, sample]) => `- **${label}** \`${sample}\``),
            '',
            `Recomendada: **JetBrains Mono** (400/500/700), fallback \`ui-monospace, monospace\` —`,
            'a mesma família da spec. A fonte se configura **no terminal**, não aqui:',
            'Windows Terminal → Settings → Profile → Appearance → Font face.',
            '',
            'Se faltar glifo, `BYTECODE_ASCII=1` troca tudo por ASCII puro',
            `(atualmente: ${ascii ? '**ASCII**' : 'unicode'}).`,
            '',
            'Um terminal tem uma única altura de célula, então "texto menor" não existe —',
            'a hierarquia da spec vira peso de cor aqui: `bright` → `fg` → `dim` → `faint`.',
          ].join('\n'),
        })
        return 'handled'
      }

      case 'theme': {
        const target =
          arg && PRESETS[arg]
            ? arg
            : await pick(
                'theme',
                Object.keys(PRESETS).map(name => ({
                  label: name,
                  value: name,
                  hint: name === DEFAULT_PRESET ? 'default' : name === 'terracotta' ? 'spec original' : '',
                })),
              )
        if (!target) return 'handled'
        applyTheme({ preset: target })
        themeVersion++
        session.config.theme = { ...(session.config.theme ?? {}), preset: target }
        say(`theme → ${target} · fixe com "theme": { "preset": "${target}" } no bytecode.jsonc`)
        return 'handled'
      }

      case 'width': {
        const cols = layout().cols
        if (!arg) {
          const current = session.config.ui?.maxWidth
          say(
            `largura: ${current && current > 0 ? `${current} colunas (centralizado)` : `cheia (${cols})`}` +
              ` · use /width full ou /width 120`,
          )
          return 'handled'
        }
        const value = arg.trim().toLowerCase()
        const parsed = value === 'full' || value === 'cheia' || value === '0' ? 0 : Number(value)
        // A width below the layout's own floor is not a narrower column, it is an
        // unusable one: `/width 12` left a screen with no room for a single row
        // of content, and the way back was to type a command into it.
        if (!Number.isFinite(parsed) || parsed < 0 || (parsed > 0 && parsed < MIN_WIDTH)) {
          push({
            kind: 'error',
            text: `largura inválida "${arg}" — use "full" ou um número a partir de ${MIN_WIDTH}`,
          })
          return 'handled'
        }
        session.config.ui = { ...(session.config.ui ?? {}), maxWidth: parsed }
        repaint()
        say(
          parsed === 0
            ? `largura → cheia (${cols} colunas)`
            : `largura → ${parsed} colunas · fixe com "ui": { "maxWidth": ${parsed} } no bytecode.jsonc`,
        )
        return 'handled'
      }

      case 'changes':
      // `/rewind` é a mesma tela: desfazer é escolher um arquivo e apertar `r`,
      // não um comando que decide sozinho o que apagar.
      case 'rewind':
        toggleChangesView()
        return 'handled'

      case 'workflows': {
        // Bare `/workflows` opens the live view, as Claude Code does; the toggle
        // moved behind an explicit `on`/`off` so watching a run cannot switch the
        // orchestration off by accident.
        if (!arg) {
          modal =
            modal?.kind === 'workflows'
              ? null
              : { kind: 'workflows', saved: await listWorkflows(session.cwd) }
          dirty = true
          return 'handled'
        }
        const wanted = ['on', 'sim', 'true', '1'].includes(arg.trim().toLowerCase())
        session.config.workflows = { ...(session.config.workflows ?? {}), enabled: wanted }
        const { registerTools } = await import('../tools/index.ts')
        registerTools(session)
        session.bootstrapped = false // o roster de tools muda, reenvia o contexto
        say(
          wanted
            ? 'workflows ligados — a tool Workflow está disponível nesta sessão'
            : 'workflows desligados — a tool Workflow foi removida',
        )
        return 'handled'
      }

      case 'mouse': {
        const wanted = arg ? arg.trim().toLowerCase() !== 'off' : !mouseEnabled
        mouseEnabled = wanted
        out.write(mouseEnabled ? MOUSE_ON : MOUSE_OFF)
        selection = null
        selecting = false
        say(
          mouseEnabled
            ? 'mouse ligado — arraste para selecionar o trecho e copiar; roda rola'
            : 'mouse desligado — seleção nativa do terminal de volta (sem roda nem cópia automática)',
        )
        return 'handled'
      }

      case 'copy': {
        const text = previousFrame
          .map(line => stripAnsi(line).replace(/\s+$/, ''))
          .join('\n')
          .replace(/^\n+|\n+$/g, '')
        say((await copyToClipboard(text)) ? 'tela copiada' : 'sem ferramenta de clipboard disponível')
        return 'handled'
      }

      case 'keys':
        keyEcho = true
        say('eco de teclas ligado — pressione teclas para ver a sequência que o terminal envia, esc para sair')
        return 'handled'

      case 'reload':
        await session.reloadAssets()
        session.bootstrapped = false
        say('assets recarregados')
        return 'handled'

      case 'clear':
        session.messages = []
        session.bootstrapped = false
        session.tokenBaseline = undefined
        session.compactionSuspended = false
        // O plano era do contexto que acabou de ser zerado.
        clearTodos(session)
        // O que foi lido também: sem o contexto, o modelo não viu nada, e a
        // guarda de escrita passaria a atestar leituras que ninguém mais tem.
        forgetFiles(session)
        // E os subagents guardados: o id deles só existia no contexto que sumiu.
        clearParkedAgents(session)
        blocks.length = 0
        focusedTool = null
        blocks.push({ kind: 'splash' })
        dirty = true
        return 'handled'

      case 'transcript':
        say(session.transcript.file)
        return 'handled'

      default:
        return 'passthrough'
    }
  }
}

/**
 * The `└` line under a call. A tool that already says what it did in its first
 * line (`Added 2 lines`, `Wrote 40 lines`) gets that verbatim; anything else
 * gets a size, which is all a raw dump can honestly claim.
 */
function summarisePreview(preview: string | undefined): string | undefined {
  if (!preview) return undefined
  const lines = preview.split('\n').filter(l => l.trim())
  if (lines.length === 0) return undefined

  const head = lines[0].trim()
  if (/^(Added|Removed|Created|Wrote|No line changed|Applied)\b/i.test(head)) return head
  if (lines.length === 1) return head.length > 90 ? `${head.slice(0, 87)}…` : head
  return `${lines.length} linhas`
}

function formatTokens(value: number | undefined): string {
  if (value === undefined) return '?'
  if (value < 1000) return String(value)
  return `${(value / 1000).toFixed(1)}k`
}

/**
 * Splits a raw stdin chunk into key events, keeping an unfinished escape
 * sequence back as `pending`.
 *
 * A terminal does not promise that a sequence arrives in one read: over SSH, in
 * a Windows conpty, and above all during mouse reporting — which emits hundreds
 * of `ESC[<32;x;yM` per second while dragging — the split lands mid-sequence
 * routinely. Parsed chunk-by-chunk, the half that ends in `ESC` became a bare
 * Esc keypress, which aborts the running turn or wipes the composer, and the
 * other half was typed into the composer as garbage.
 */
function splitKeys(data: string): { keys: string[]; pending: string } {
  const keys: string[] = []
  let i = 0
  while (i < data.length) {
    if (data[i] === ESC) {
      const rest = data.slice(i)
      const seq = rest.match(/^\x1b(\[[<0-9;]*[A-Za-z~]|O[A-Za-z])/)
      if (seq) {
        keys.push(seq[0])
        i += seq[0].length
        continue
      }
      // The chunk ended inside a sequence: `ESC`, `ESC[`, `ESC[<32;12` with no
      // final byte yet, or `ESC O` with no letter. Hold it for the next read.
      if (/^\x1b(\[[<0-9;]*|O)?$/.test(rest)) return { keys, pending: rest }
      // Alt+<char> is ESC immediately followed by the character — including
      // alt+enter, where that character is a control code below space.
      const next = rest[1]
      if (
        rest.length > 1 &&
        next !== '[' &&
        next !== 'O' &&
        (next >= ' ' || next === '\r' || next === '\n')
      ) {
        keys.push(ESC + next)
        i += 2
        continue
      }
      keys.push(ESC)
      i++
      continue
    }
    keys.push(data[i])
    i++
  }
  return { keys, pending: '' }
}

/**
 * Asynchronous on purpose: `execSync` here delayed the very first paint by as
 * long as git took to answer. The header simply has no branch until it does.
 */
function readGitBranch(cwd: string, onBranch: (branch: string) => void): void {
  const child = spawn('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  let out = ''
  child.on('error', () => {})
  child.stdout?.on('data', (chunk: unknown) => (out += String(chunk)))
  child.on('close', (code: number | null) => {
    const branch = out.trim()
    if (code === 0 && branch) onBranch(branch)
  })
}
