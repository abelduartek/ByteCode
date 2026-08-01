import { randomUUID } from 'node:crypto'
import { cpus } from 'node:os'
import { streamText, jsonSchema } from 'ai'
import type { LanguageModel, ModelMessage, ToolSet } from 'ai'
import type { Session, TurnStats } from './session.ts'
import { emptyTurnStats } from './session.ts'
import { summarize } from './hooks.ts'
import { maybeCompact } from './compaction.ts'
import { cachePolicy, cachedSystem, withCacheControl } from './cache.ts'
import { ThinkFilter } from './reasoning.ts'
import { bootstrapBlocks, buildSystemPrompt, modeReminder } from './context.ts'
import { saveSessionState } from './sessions.ts'
import { authPath, brokenAuthFiles } from '../provider/auth.ts'
import { CLI } from '../util/paths.ts'
import { describeError } from '../util/error.ts'

// The loop is driven here rather than by the AI SDK: tools are declared without
// an `execute` function, so `streamText` stops after emitting tool calls and
// hands control back. That is what makes room for hooks, the permission gate,
// and transcript writes between the call and the execution.

const MAX_STEPS = 64
/** Fraction of the budget after which the model is told to converge. */
const WARN_AT = 0.75
const MAX_STOP_RETRIES = 3
const MAX_TOOL_OUTPUT_CHARS = 30_000
/** Backoff for transient provider failures. Length is the retry budget. */
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000]

type PendingCall = {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

/**
 * How many times the same read may run inside one turn before the loop stops
 * paying for it.
 *
 * Two, not one: a second look is often legitimate — a file re-read after an
 * edit, a search repeated with fresh eyes. What is never legitimate is the
 * third identical `Grep` returning `No matches` for the third time, which is
 * what a stuck model actually does. Seen in the wild: the same
 * `Grep(156501|US156501)` four times over three and a half minutes.
 */
const REPEAT_LIMIT = 2

/** What a turn remembers about itself, so it can notice it is going in circles. */
type TurnMemory = { calls: Map<string, { runs: number; text: string }> }

/**
 * Identity of a call. Keys are sorted so the same arguments in a different
 * order are still the same call — the model does not always serialise them
 * consistently.
 */
function callKey(call: PendingCall): string {
  const input = call.input ?? {}
  const ordered = Object.keys(input)
    .sort()
    .map(k => `${k}=${JSON.stringify(input[k])}`)
    .join(' ')
  return `${call.toolName} ${ordered}`
}

type CallResult = {
  toolCallId: string
  toolName: string
  text: string
  isError: boolean
}

/** An image attached to the user's turn, already decoded. */
export type TurnImage = { data: Buffer; mediaType: string }

export type TurnOptions = {
  /** Extra `<system-reminder>` blocks for this turn only. */
  extraBlocks?: string[]
  promptId?: string
  /**
   * Images pasted with the prompt. They travel as content parts, so the text
   * stays a plain string whenever there are none — which is almost always.
   */
  images?: TurnImage[]
}

export async function runTurn(
  session: Session,
  userText: string,
  opts: TurnOptions = {},
): Promise<void> {
  const promptId = opts.promptId ?? randomUUID()
  session.abort = new AbortController()
  const stats = emptyTurnStats()
  stats.label = turnLabel(userText)
  session.turn = stats
  // A new user turn adds material, so a previously impossible compaction may
  // now have something safe to summarise.
  session.compactionSuspended = false

  const hookResults = await session.hooks.run('UserPromptSubmit', {
    session_id: session.transcript.sessionId,
    prompt_id: promptId,
    transcript_path: session.transcript.file,
    cwd: session.cwd,
    permission_mode: session.mode,
    effort: session.config.effort ? { level: session.config.effort } : undefined,
    prompt: userText,
  })
  const hook = summarize(hookResults)
  for (const msg of hook.systemMessages) session.emit({ type: 'notice', text: msg })
  if (hook.blocked) {
    session.emit({ type: 'error', text: hook.blockReasons.join('; ') })
    session.emit({ type: 'turn-end', stats: finishTurn(session, stats) })
    return
  }

  const blocks: string[] = []
  // Announced when it changes, since it is no longer in the system prompt: a
  // line that moves cannot live inside the cached prefix.
  if (session.announcedMode !== session.mode) {
    blocks.push(modeReminder(session.mode))
    session.announcedMode = session.mode
  }
  if (!session.bootstrapped) {
    blocks.push(
      ...bootstrapBlocks(
        session.assets,
        session.registry.deferredNames(),
        session.scratchpad,
        session.mcp.instructions(),
      ),
    )
    session.bootstrapped = true
  }
  blocks.push(...(opts.extraBlocks ?? []))
  for (const ctx of hook.contexts) {
    blocks.push(`<system-reminder>\nUserPromptSubmit hook context:\n${ctx}\n</system-reminder>`)
  }

  const promptText = [...blocks, userText].join('\n\n')
  const images = opts.images ?? []
  const content = (
    images.length === 0
      ? promptText
      : [
          { type: 'text', text: promptText },
          ...images.map(image => ({
            type: 'image',
            image: image.data,
            mediaType: image.mediaType,
          })),
        ]
  ) as ModelMessage['content']
  session.messages.push({ role: 'user', content } as ModelMessage)
  // Base64 image bytes would bloat every transcript line and every session
  // snapshot, so what is recorded is the text plus a note of what came with it.
  session.transcript.append(
    'user',
    {
      message: { role: 'user', content: promptText },
      promptId,
      ...(images.length > 0
        ? { attachments: images.map(i => ({ mediaType: i.mediaType, bytes: i.data.length })) }
        : {}),
    },
    { isSidechain: session.depth > 0, agentId: session.agentType },
  )

  try {
    await drive(session, promptId)
  } finally {
    const finished = finishTurn(session, stats)
    session.transcript.append(
      'leadtime',
      { stats: finished, promptId },
      { isSidechain: session.depth > 0, agentId: session.agentType },
    )
    // Only the root session is resumable: a subagent's context is scratch work
    // that belongs to the turn that spawned it.
    if (session.depth === 0) {
      try {
        await saveSessionState(session.config, {
          id: session.transcript.sessionId,
          cwd: session.cwd,
          modelRef: session.modelRef,
          messages: session.messages,
          tokenBaseline: session.tokenBaseline,
          parentId: session.forkedFrom,
          forkedAtMessage: session.forkedAtMessage,
        })
      } catch (err) {
        session.emit({ type: 'notice', text: `sessão não pôde ser salva: ${describeError(err)}` })
      }
    }
    session.emit({ type: 'turn-end', stats: finished })
  }
}

/** Turns kept for the session report. Each is a few hundred bytes. */
const MAX_TURN_HISTORY = 200

const LABEL_CHARS = 60

/**
 * First real line of the prompt. A pasted stack trace or a slash command's
 * expanded body both start with something recognisable, and anything longer than
 * a table cell is noise in a report.
 */
function turnLabel(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? ''
  const clean = line.trim().replace(/\s+/g, ' ')
  return clean.length > LABEL_CHARS ? `${clean.slice(0, LABEL_CHARS - 1)}…` : clean
}

function finishTurn(session: Session, stats: TurnStats): TurnStats {
  stats.endedAt = Date.now()
  session.turn = null
  session.lastTurn = stats
  session.turns.push(stats)
  if (session.turns.length > MAX_TURN_HISTORY) session.turns.shift()
  return stats
}

async function drive(session: Session, promptId: string): Promise<void> {
  let stopRetries = 0
  const maxSteps = Math.max(1, session.config.maxSteps ?? MAX_STEPS)
  const warnAt = Math.max(1, Math.floor(maxSteps * WARN_AT))
  let warned = false
  // Scoped to the turn: what was pointless to repeat here may be exactly right
  // in the next turn, after the user says something new.
  const memory: TurnMemory = { calls: new Map() }

  for (let step = 0; step < maxSteps; step++) {
    await maybeCompact(session)
    const calls = await streamStep(session)

    if (calls.length === 0) {
      const stopResults = await session.hooks.run('Stop', {
        session_id: session.transcript.sessionId,
        prompt_id: promptId,
        transcript_path: session.transcript.file,
        cwd: session.cwd,
        permission_mode: session.mode,
      })
      const stop = summarize(stopResults)
      if (stop.blocked && stopRetries < MAX_STOP_RETRIES) {
        stopRetries++
        const reason = stop.blockReasons.join('; ')
        session.messages.push({ role: 'user', content: reason })
        session.emit({ type: 'notice', text: `Stop hook: ${reason}` })
        continue
      }
      return
    }

    const results = await executeCalls(session, calls, promptId, memory)

    session.messages.push({
      role: 'tool',
      content: results.map(r => ({
        type: 'tool-result' as const,
        toolCallId: r.toolCallId,
        toolName: r.toolName,
        output: r.isError
          ? { type: 'error-text' as const, value: r.text }
          : { type: 'text' as const, value: r.text },
      })),
    })
    session.transcript.append(
      'tool_result',
      { results: results.map(r => ({ ...r, text: truncate(r.text, 2000) })) },
      { isSidechain: session.depth > 0, agentId: session.agentType },
    )

    const batch = summarize(
      await session.hooks.run('PostToolBatch', {
        session_id: session.transcript.sessionId,
        prompt_id: promptId,
        transcript_path: session.transcript.file,
        cwd: session.cwd,
        permission_mode: session.mode,
        tool_names: results.map(r => r.toolName),
      }),
    )
    if (batch.blocked) {
      session.emit({ type: 'error', text: batch.blockReasons.join('; ') })
      return
    }
    if (batch.stop) {
      session.emit({ type: 'notice', text: batch.stopReason ?? 'stopped by hook' })
      return
    }

    // Told once, before the budget runs out, so the turn ends with a report
    // instead of being cut mid-change. Reaching the ceiling with no warning is
    // how a long refactor loses the summary of what it had already done.
    if (!warned && step + 1 >= warnAt) {
      warned = true
      session.messages.push({
        role: 'user',
        content:
          `<system-reminder>\nThis turn has used ${step + 1} of ${maxSteps} model calls. ` +
          `Start converging: finish the change in flight, then say what is done and what is left. ` +
          `Do not begin new work — the user can continue in the next turn.\n</system-reminder>`,
      })
    }
  }

  // Not an error: nothing failed, the budget ran out. The history is intact, so
  // the next user turn picks up exactly where this one stopped.
  session.emit({
    type: 'notice',
    text:
      `turno parado em ${maxSteps} chamadas ao modelo — o contexto está intacto, ` +
      `peça "continue" para seguir. Ajuste o teto com "maxSteps" na config.`,
  })
}

/**
 * A turn that ended because the model call failed, not because the model was
 * done.
 *
 * `shown` says the message already reached the user through a `error` event, so
 * a UI that catches this should not print it a second time — while a subagent or
 * a workflow step, which has no screen of its own, still learns that its result
 * is not an answer.
 */
export class TurnFailure extends Error {
  readonly shown: boolean
  constructor(message: string, opts: { shown: boolean }) {
    super(message)
    this.name = 'TurnFailure'
    this.shown = opts.shown
  }
}

type StepOutcome =
  | { ok: true; calls: PendingCall[] }
  /** `emitted` means output already reached the user, so a retry would duplicate it. */
  | { ok: false; failure: string; error: unknown; emitted: boolean }

/**
 * One model call, retried on transient provider failures.
 *
 * A retry is only safe while nothing has been shown: nothing shown means nothing
 * was added to `session.messages` either, so re-running produces one clean
 * answer instead of a second half of one. Once text has reached the user it is
 * kept — and this stops retrying.
 */
/**
 * Whether this session's provider is one that writes reasoning into the content
 * channel as `<think>` tags. `reasoning.inlineThinkTags` in the config forces it
 * either way for a provider this guess gets wrong.
 */
function usesInlineThinkTags(session: Session): boolean {
  const configured = session.config.reasoning?.inlineThinkTags
  if (typeof configured === 'boolean') return configured
  try {
    const { provider } = session.resolveModel()
    return (provider.npm ?? '@ai-sdk/openai-compatible') === '@ai-sdk/openai-compatible'
  } catch {
    return true
  }
}

async function streamStep(session: Session): Promise<PendingCall[]> {
  for (let attempt = 0; ; attempt++) {
    const outcome = await streamOnce(session)
    if (outcome.ok) return outcome.calls

    const budgetLeft = attempt < RETRY_DELAYS_MS.length
    const retryable =
      budgetLeft &&
      !outcome.emitted &&
      !session.abort?.signal.aborted &&
      isTransient(outcome.failure, outcome.error)

    if (!retryable) {
      // Esc is not a provider failure. The stream rejects with an abort error,
      // and reporting that verbatim told the user their own interruption was
      // something going wrong. The partial answer is already in the history.
      if (session.abort?.signal.aborted) {
        session.emit({ type: 'notice', text: 'interrompido' })
        return []
      }
      const status = (outcome.error as { statusCode?: number })?.statusCode
      const unauthorised = status === 401 || status === 403 || /\b401\b|no api key/i.test(outcome.failure)
      const text = unauthorised ? `${outcome.failure}${credentialHint(session)}` : outcome.failure
      session.emit({ type: 'error', text })
      // Thrown, not swallowed. Returning no calls is how a turn says "the model
      // is done talking", so a provider that never answered looked exactly like
      // one that finished: a subagent reported success with empty output, and a
      // workflow step journaled that as its result.
      throw new TurnFailure(text, { shown: true })
    }

    const wait = retryAfterMs(outcome.error) ?? RETRY_DELAYS_MS[attempt]
    session.record(s => void s.retries++)
    session.emit({
      type: 'notice',
      text: `provider falhou (${firstLine(outcome.failure)}) — tentando de novo em ${Math.round(
        wait / 1000,
      )}s [${attempt + 1}/${RETRY_DELAYS_MS.length}]`,
    })
    await sleep(wait, session.abort?.signal)
    if (session.abort?.signal.aborted) return []
  }
}

// Retrying only pays when the same request could succeed unchanged. A hostname
// that does not resolve, a refused port or a rejected certificate will fail the
// same way every time, so they are classified as permanent even though they
// arrive as "network errors".
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETRESET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
])
const PERMANENT_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'CERT_HAS_EXPIRED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
])

const TRANSIENT = /\b(429|500|502|503|504)\b|rate.?limit|too many requests|overloaded|capacity|timed? ?out|timeout|socket hang up|stream (closed|error)|premature close|service unavailable|bad gateway/i
const PERMANENT = /\b(400|401|403|404|422)\b|invalid.?api.?key|unauthorized|forbidden|not found|context length|too long|maximum context|content.?filter|invalid.?request/i

/** Every `code` in the error's cause chain — undici hides the real one there. */
function errorCodes(error: unknown): string[] {
  const codes: string[] = []
  let current = error
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string') codes.push(code.toUpperCase())
    current = (current as { cause?: unknown }).cause
  }
  return codes
}

function isTransient(message: string, error: unknown): boolean {
  const codes = errorCodes(error)
  if (codes.some(code => PERMANENT_CODES.has(code))) return false
  if (codes.some(code => TRANSIENT_CODES.has(code))) return true

  const status = (error as { statusCode?: number })?.statusCode
  if (typeof status === 'number') {
    if (status === 429 || status >= 500) return true
    if (status >= 400) return false
  }

  if (PERMANENT.test(message)) return false
  return TRANSIENT.test(message)
}

/** Honours `retry-after`, which a rate limiter knows better than any backoff table. */
function retryAfterMs(error: unknown): number | null {
  const headers = (error as { responseHeaders?: Record<string, string> })?.responseHeaders
  if (!headers) return null
  const ms = headers['retry-after-ms'] ?? headers['x-ratelimit-reset-after-ms']
  if (ms && Number.isFinite(Number(ms))) return Math.min(Number(ms), 60_000)
  const seconds = headers['retry-after']
  if (seconds && Number.isFinite(Number(seconds))) return Math.min(Number(seconds) * 1000, 60_000)
  return null
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })
}

/** One model call. Streams to the UI and returns the tool calls it emitted. */
async function streamOnce(session: Session): Promise<StepOutcome> {
  const model = (await session.model()) as LanguageModel
  const tools = buildToolSet(session)

  const agent = session.primaryAgent
  const system = buildSystemPrompt({
    cwd: session.cwd,
    isGitRepo: session.isGitRepo,
    model: session.modelRef,
    effort: session.config.effort,
    permissionMode: session.mode,
    shell: process.platform === 'win32' ? 'powershell' : 'bash',
    // The active primary agent's prompt goes in `system`, not the user turn:
    // switching agents mid-session then changes behaviour from the next call on
    // without rewriting history.
    extra: agent ? `# Active agent: ${agent.name}\n\n${agent.prompt}` : undefined,
  })

  const calls: PendingCall[] = []
  // Only where the problem exists. The proxies that stream reasoning as literal
  // `<think>` inside the content channel are the OpenAI-compatible ones; a
  // provider with a real reasoning channel never does it, and filtering there
  // silently ate the tags out of a legitimate answer — asking an Anthropic model
  // to explain `<thinking>` blocks returned an answer with the subject removed.
  const think = new ThinkFilter({ enabled: usesInlineThinkTags(session) })
  let assistantText = ''
  let failure: string | null = null
  let failureError: unknown = null
  // Captured before the call: `usage.inputTokens` describes exactly this many messages.
  const promptMessageCount = session.messages.length

  // With SDK-level caching the system prompt is sent as a system *message*, the
  // only shape that carries provider options; without it the plain string goes
  // out exactly as before. The `wire` style marks the body instead, inside the
  // provider's fetch, so nothing changes here.
  const policy = cachePolicy(session.config, session.resolveModel())
  const viaSdk = policy?.style === 'sdk' ? policy : null

  const result = streamText({
    model,
    system: viaSdk ? [cachedSystem(system, viaSdk)] : system,
    messages: viaSdk ? withCacheControl(session.messages, viaSdk) : session.messages,
    tools,
    maxOutputTokens: session.maxOutputTokens,
    abortSignal: session.abort?.signal,
    providerOptions: session.resolveModel().model.providerOptions as never,
    // AI SDK v7 delivers stream failures here rather than by rejecting the
    // iteration. Without an onError the default handler tears down the process.
    onError: ({ error }: { error: unknown }) => {
      failure = describeError(error)
      failureError = error
    },
  })

  try {
    for await (const part of result.fullStream as AsyncIterable<Record<string, unknown>>) {
      switch (part.type) {
        case 'text-delta': {
          const delta = (part.text ?? part.textDelta ?? '') as string
          // Proxies that stream reasoning as <think> inside the content channel
          // would otherwise dump it into the answer.
          const split = think.push(delta)
          if (split.text) {
            assistantText += split.text
            session.emit({ type: 'text', text: split.text })
          }
          if (split.reasoning) session.emit({ type: 'reasoning', text: split.reasoning })
          break
        }
        case 'reasoning-delta': {
          const text = (part.text ?? part.textDelta ?? '') as string
          session.emit({ type: 'reasoning', text })
          break
        }
        case 'tool-call': {
          calls.push({
            toolCallId: part.toolCallId as string,
            toolName: part.toolName as string,
            input: ((part.input ?? part.args) ?? {}) as Record<string, unknown>,
          })
          break
        }
        case 'error': {
          failure = describeError(part.error)
          failureError = part.error
          break
        }
        default:
          break
      }
    }
  } catch (err) {
    failure = describeError(err)
    failureError = err
  }

  const tail = think.flush()
  if (tail.text) {
    assistantText += tail.text
    session.emit({ type: 'text', text: tail.text })
  }

  /**
   * Keeps what the user already read.
   *
   * The history is only written from the provider's `response`, which a failed
   * or interrupted stream never produces — so half an answer stayed on screen
   * while the conversation behaved as if it had never been said. The next turn
   * then answered a question the user believed was already half answered.
   */
  const keepPartial = (): void => {
    if (assistantText.trim()) session.messages.push({ role: 'assistant', content: assistantText })
  }

  // A failed stream also rejects `response` and `usage`. Both must be consumed
  // or Node tears the process down with an unhandled rejection.
  if (failure !== null) {
    void Promise.resolve(result.response).catch(() => {})
    void Promise.resolve(result.usage).catch(() => {})
    keepPartial()
    return {
      ok: false,
      failure,
      error: failureError,
      emitted: assistantText.length > 0 || calls.length > 0,
    }
  }

  let response: { messages: unknown[] }
  try {
    response = (await result.response) as { messages: unknown[] }
  } catch (err) {
    void Promise.resolve(result.usage).catch(() => {})
    keepPartial()
    return {
      ok: false,
      failure: describeError(err),
      error: err,
      emitted: assistantText.length > 0 || calls.length > 0,
    }
  }
  session.messages.push(...(response.messages as ModelMessage[]))
  session.record(s => void s.steps++)

  const usage = await Promise.resolve(result.usage).catch(() => undefined)
  if (usage) {
    const { cacheRead, cacheWrite } = cacheTokens(usage)
    session.record(s => {
      s.inputTokens += usage.inputTokens ?? 0
      s.outputTokens += usage.outputTokens ?? 0
      s.cacheReadTokens += cacheRead ?? 0
      s.cacheWriteTokens += cacheWrite ?? 0
    })
    session.emit({
      type: 'usage',
      input: usage.inputTokens ?? undefined,
      output: usage.outputTokens ?? undefined,
      cacheRead: cacheRead ?? undefined,
      cacheWrite: cacheWrite ?? undefined,
    })
    if (typeof usage.inputTokens === 'number') {
      session.tokenBaseline = {
        messageCount: promptMessageCount,
        inputTokens: usage.inputTokens,
      }
    }
  }

  session.transcript.append(
    'assistant',
    {
      message: { role: 'assistant', text: assistantText, toolCalls: calls },
      model: session.modelRef,
      usage,
    },
    { isSidechain: session.depth > 0, agentId: session.agentType },
  )

  return { ok: true, calls }
}

/**
 * Names the provider, the variable and the file when a call comes back
 * unauthenticated. "Set the provider env var" is useless without saying *which*
 * one — and with a subagent the failing model is often not the session's.
 */
function credentialHint(session: Session): string {
  let resolved
  try {
    resolved = session.resolveModel()
  } catch {
    return ''
  }
  const { providerId, modelKey, provider } = resolved
  const conventional = `${providerId.replace(/[^A-Za-z0-9]/g, '_').toUpperCase()}_API_KEY`
  const vars = [...new Set([...(provider.env ?? []), conventional])]

  // A store that failed to parse reads as empty, so say that instead of listing
  // three ways to add a key that is probably already there.
  const broken = brokenAuthFiles()
  if (broken.length > 0) {
    return (
      `\n${broken.map(b => `${b.file} não é JSON válido: ${b.error}`).join('\n')}\n` +
      `As credenciais desse arquivo estão sendo ignoradas — corrija o JSON.`
    )
  }

  return (
    `\nSem credencial para ${providerId}/${modelKey}. Escolha uma:\n` +
    `  1. ${vars.map(v => `$${v}`).join(' ou ')} no ambiente\n` +
    `  2. ${CLI} connect ${providerId}   (grava em ${authPath()})\n` +
    `  3. "provider": { "${providerId}": { "options": { "apiKey": "{env:${vars[0]}}" } } } na config`
  )
}

function readNumber(source: unknown, key: string): number | undefined {
  const value = (source as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'number' ? value : undefined
}

/**
 * Cache accounting moved into `inputTokenDetails` in AI SDK v7. The flat
 * `cachedInputTokens` is the older shape, still emitted by some providers, so
 * both are accepted.
 */
function cacheTokens(usage: unknown): { cacheRead?: number; cacheWrite?: number } {
  const details = (usage as { inputTokenDetails?: unknown })?.inputTokenDetails
  return {
    cacheRead: readNumber(details, 'cacheReadTokens') ?? readNumber(usage, 'cachedInputTokens'),
    cacheWrite: readNumber(details, 'cacheWriteTokens'),
  }
}

function buildToolSet(session: Session): ToolSet {
  const out: Record<string, unknown> = {}
  for (const tool of session.registry.active()) {
    out[tool.name] = {
      description: tool.description,
      inputSchema: jsonSchema(tool.inputSchema as never),
    }
  }
  return out as ToolSet
}

/** Read-only tools: they mix with each other freely and with nothing else. */
const READ_GROUP = 'read'

/**
 * Which calls may run together. `null` means "alone".
 *
 * Two groups exist today: the read-only batch, and subagents. They are kept
 * apart on purpose — a subagent writes, so folding it into the read batch would
 * let it race a Read the model emitted beside it.
 */
function groupOf(session: Session, call: PendingCall): string | null {
  const tool = session.registry.get(call.toolName)
  if (!tool) return null
  if (tool.parallelSafe) return READ_GROUP
  return tool.parallelGroup ?? null
}

/**
 * Ceiling for one group. Subagents are network-bound, but each is a whole
 * context and a whole cost, so a model that emitted twenty `Agent` calls should
 * not open twenty conversations at once.
 */
function groupLimit(session: Session, group: string): number {
  if (group !== 'agent') return Infinity
  const fallback = Math.min(8, Math.max(1, cpus().length - 2))
  return Math.max(1, session.config.subagentConcurrency ?? fallback)
}

/** `Promise.all` with a ceiling, preserving input order in the output. */
async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  if (limit >= items.length) return Promise.all(items.map(run))
  const out = new Array<R>(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      out[index] = await run(items[index])
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return out
}

/**
 * Runs each consecutive run of same-group calls concurrently, everything else
 * one at a time.
 *
 * Batching only *adjacent* calls is what keeps this sound: a Read that the model
 * emitted after an Edit still runs after that Edit, so it observes the write.
 * Requiring the whole batch to be safe — the original rule — meant one Bash
 * anywhere in the list serialised every Read around it.
 */
/**
 * Which model call each batch belongs to, per session. Counted here rather than
 * read off `TurnStats.steps` so it stays unique regardless of where the step
 * counter happens to be incremented, and so a subagent numbers its own calls.
 */
const stepCounter = new WeakMap<Session, number>()

export async function executeCalls(
  session: Session,
  calls: PendingCall[],
  promptId: string,
  memory: TurnMemory = { calls: new Map() },
): Promise<CallResult[]> {
  const out: CallResult[] = new Array(calls.length)
  const step = (stepCounter.get(session) ?? 0) + 1
  stepCounter.set(session, step)

  let i = 0
  while (i < calls.length) {
    const group = groupOf(session, calls[i])
    if (group === null) {
      out[i] = await executeCall(session, calls[i], promptId, memory, step)
      i++
      continue
    }
    let end = i
    while (end < calls.length && groupOf(session, calls[end]) === group) end++
    const batch = await mapWithLimit(
      calls.slice(i, end),
      groupLimit(session, group),
      call => executeCall(session, call, promptId, memory, step),
    )
    for (let k = 0; k < batch.length; k++) out[i + k] = batch[k]
    i = end
  }

  return out
}

async function executeCall(
  session: Session,
  call: PendingCall,
  promptId: string,
  memory: TurnMemory,
  step: number,
): Promise<CallResult> {
  const base = {
    session_id: session.transcript.sessionId,
    prompt_id: promptId,
    transcript_path: session.transcript.file,
    cwd: session.cwd,
    permission_mode: session.mode,
    agent_type: session.agentType,
  }

  const tool = session.registry.get(call.toolName)
  if (!tool) {
    const known = session.registry
      .active()
      .map(t => t.name)
      .join(', ')
    return {
      ...call,
      isError: true,
      text:
        `Unknown tool "${call.toolName}". Available: ${known}. ` +
        `Deferred (load with ToolSearch first): ${session.registry.deferredNames().join(', ') || 'none'}`,
    }
  }

  // A read that already ran twice in this turn with these exact arguments will
  // return the same thing a third time. Running it again costs a round trip and,
  // worse, hands the model the same answer that got it stuck — so it is told
  // plainly that it is repeating itself.
  //
  // Only reads: a repeated `Bash` may be a poll or a retry that is meant to see
  // something change, and a write is never a no-op.
  const repeatKey = callKey(call)
  const seen = memory.calls.get(repeatKey)
  if (tool.kind === 'read' && seen && seen.runs >= REPEAT_LIMIT) {
    seen.runs++
    return {
      ...call,
      isError: true,
      text:
        `This exact call already ran ${REPEAT_LIMIT} times in this turn and was not run again. ` +
        `It returned:\n\n${truncate(seen.text, 1000)}\n\n` +
        `Repeating it will not change the answer. Change the approach — a different pattern or ` +
        `path, a different tool, or ask the user for the missing piece.`,
    }
  }

  let input = call.input

  const pre = summarize(
    await session.hooks.run(
      'PreToolUse',
      { ...base, tool_name: call.toolName, tool_input: input },
      call.toolName,
    ),
  )
  if (pre.updatedInput) input = pre.updatedInput
  if (pre.blocked) {
    return { ...call, isError: true, text: pre.blockReasons.join('; ') }
  }

  const subject = tool.subject?.(input)
  const summaryText = tool.summary?.(input) ?? subject ?? ''
  const verdict =
    pre.permission === 'allow'
      ? { decision: 'allow' as const, reason: pre.permissionReason }
      : pre.permission === 'deny'
        ? { decision: 'deny' as const, reason: pre.permissionReason }
        : pre.permission === 'ask'
          ? { decision: 'ask' as const, reason: pre.permissionReason }
          : session.evaluatePermission({ tool: tool.name, kind: tool.kind, subject })

  const denied = async (reason: string, source: 'policy' | 'user' | 'hook') => {
    await session.hooks.run(
      'PermissionDenied',
      { ...base, tool_name: call.toolName, tool_input: input, reason, source },
      call.toolName,
    )
  }

  if (verdict.decision === 'deny') {
    const reason = verdict.reason ?? verdict.rule ?? 'blocked by policy'
    await denied(reason, pre.permission === 'deny' ? 'hook' : 'policy')
    return {
      ...call,
      isError: true,
      text: `Permission denied: ${reason}. Do not retry this call unchanged.`,
    }
  }
  if (verdict.decision === 'ask') {
    // Asked before the prompt is drawn, so a hook can answer for the user —
    // the same `permissionDecision` contract `PreToolUse` already uses.
    const asked = summarize(
      await session.hooks.run(
        'PermissionRequest',
        {
          ...base,
          tool_name: call.toolName,
          tool_input: input,
          tool_summary: summaryText,
          permission_reason: verdict.reason ?? verdict.rule,
        },
        call.toolName,
      ),
    )
    if (asked.blocked || asked.permission === 'deny') {
      const reason = asked.permissionReason ?? asked.blockReasons.join('; ') ?? 'denied by hook'
      await denied(reason, 'hook')
      return { ...call, isError: true, text: `Permission denied: ${reason}. Do not retry this call unchanged.` }
    }

    if (asked.permission !== 'allow') {
      // The turn is about to stop and wait for a human: that is exactly what a
      // desktop-notification hook exists for.
      await session.hooks.run(
        'Notification',
        {
          ...base,
          message: `${tool.name} precisa de permissão${summaryText ? `: ${summaryText}` : ''}`,
          tool_name: call.toolName,
          tool_input: input,
        },
        call.toolName,
      )
      const granted = await session.requestPermission({
        tool: tool.name,
        summary: summaryText,
        subject,
        verdict,
        input,
        agent: session.agentType,
      })
      if (!granted) {
        await denied('the user declined', 'user')
        return {
          ...call,
          isError: true,
          text: 'The user declined this tool call. Adjust the approach or ask what they prefer.',
        }
      }
    }
  }

  session.emit({
    type: 'tool-start',
    id: call.toolCallId,
    name: tool.name,
    summary: summaryText,
    subject,
    step,
  })

  const startedAt = Date.now()
  let text: string
  let isError = false
  try {
    const output = await tool.execute(input, {
      session,
      cwd: session.cwd,
      signal: session.abort?.signal,
      agentId: session.agentType,
      depth: session.depth,
      callId: call.toolCallId,
    })
    text = truncate(output.text, MAX_TOOL_OUTPUT_CHARS)
    isError = output.isError ?? false
  } catch (err) {
    text = describeError(err)
    isError = true
  }

  const post = summarize(
    await session.hooks.run(
      isError ? 'PostToolUseFailure' : 'PostToolUse',
      { ...base, tool_name: call.toolName, tool_input: input, tool_output: text },
      call.toolName,
    ),
  )
  if (post.updatedToolOutput !== undefined) text = post.updatedToolOutput
  if (post.blocked) {
    text = `${text}\n\n[hook] ${post.blockReasons.join('; ')}`
    isError = true
  }

  // Recorded after the hooks have had their say, so what is remembered is what
  // the model actually received.
  memory.calls.set(repeatKey, { runs: (seen?.runs ?? 0) + 1, text })

  const elapsed = Date.now() - startedAt
  session.record(stats => {
    const entry = (stats.tools[tool.name] ??= { calls: 0, ok: 0, fail: 0, ms: 0 })
    entry.calls++
    entry.ms += elapsed
    if (isError) entry.fail++
    else entry.ok++
  })

  session.emit({
    type: 'tool-end',
    id: call.toolCallId,
    name: tool.name,
    ok: !isError,
    // The whole head of the output, not just the first line: the UI keeps it
    // collapsed and only shows it on ctrl+r, and a diff needs every line.
    preview: previewOf(text),
  })

  return { toolCallId: call.toolCallId, toolName: call.toolName, text, isError }
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n\n[truncated ${text.length - max} chars]`
}

function firstLine(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? ''
  return line.length > 120 ? `${line.slice(0, 117)}...` : line
}

const PREVIEW_LINES = 40
const PREVIEW_CHARS = 4000

/** Head of a tool's output, capped so a huge result cannot bloat the UI state. */
function previewOf(text: string): string {
  const lines = text.split('\n').slice(0, PREVIEW_LINES)
  const head = lines.join('\n')
  return head.length > PREVIEW_CHARS ? `${head.slice(0, PREVIEW_CHARS)}\n…` : head
}

export { describeError }
