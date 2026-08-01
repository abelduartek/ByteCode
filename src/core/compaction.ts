import { streamText } from 'ai'
import type { LanguageModel, ModelMessage } from 'ai'
import type { Session } from './session.ts'
import { summarize } from './hooks.ts'
import { createLanguageModel, resolveModel } from '../provider/registry.ts'
import { describeError } from '../util/error.ts'

// Compaction replaces the old part of the conversation with a summary so a long
// session keeps running inside the model's context window.
//
// The one invariant that must not break: a `tool` message is only valid when the
// assistant message carrying its `tool-call` is still present. So history is only
// ever cut immediately before a real `user` turn — never in the middle of a
// tool round trip, which providers reject outright.

const DEFAULT_THRESHOLD = 0.85
const DEFAULT_KEEP_TURNS = 4
/**
 * Messages kept when a single turn is the whole history and there is no user
 * turn to cut between. Enough to hold the shape of what is in flight — the last
 * few calls and their results — without keeping the run that filled the window.
 */
const KEEP_MESSAGES_FALLBACK = 20
const DEFAULT_SUMMARY_TOKENS = 4000
const CHARS_PER_TOKEN = 4

export type CompactionResult = {
  compacted: boolean
  before: number
  after: number
  summary?: string
  reason?: string
}

export function estimateTokens(text: string): number {
  return estimateTokensForChars(text.length)
}

/** The same estimate when only the size is known, without building the string. */
export function estimateTokensForChars(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Some OpenAI-compatible proxies emit reasoning markers into `content`. Empty
 * ones carry no information and would be stored in the summary forever.
 * Only empty tags are removed — real reasoning text is left alone.
 */
export function stripEmptyThinkTags(text: string): string {
  return text.replace(/<think>\s*<\/think>/gi, '').trim()
}

/**
 * Image bytes are not text and must not be counted as if they were: a 300 KB
 * screenshot serialised to JSON reads as ~150k tokens, which would trip
 * compaction on a session nowhere near full. What a provider actually charges
 * for an image is closer to a fixed cost, so a flat estimate stands in.
 */
const IMAGE_TOKEN_ESTIMATE = 1_600

function imageAsSize(key: string, value: unknown): unknown {
  if (key !== 'image' && key !== 'data') return value
  // A Buffer serialises as a byte array; either shape is stopped here.
  if (typeof value === 'string' || value instanceof Uint8Array || Array.isArray(value)) {
    return '.'.repeat(IMAGE_TOKEN_ESTIMATE * CHARS_PER_TOKEN)
  }
  return value
}

/** Rough size of a message list. Serialisation cost is close enough for a threshold. */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const message of messages) {
    if (typeof message.content === 'string') {
      chars += message.content.length
    } else {
      try {
        chars += JSON.stringify(message.content, imageAsSize).length
      } catch {
        chars += 0
      }
    }
    chars += 8 // per-message envelope
  }
  return Math.ceil(chars / CHARS_PER_TOKEN)
}

/**
 * Current prompt size. The provider's reported `inputTokens` from the last call
 * is authoritative for everything sent so far; only the messages appended since
 * then are estimated.
 */
export function contextTokens(session: Session): number {
  const baseline = session.tokenBaseline
  // The full pass used to run unconditionally and then be discarded whenever a
  // baseline existed — which is the normal case after the first call.
  if (!baseline) return estimateMessagesTokens(session.messages)
  return baseline.inputTokens + estimateMessagesTokens(session.messages.slice(baseline.messageCount))
}

export function contextLimit(session: Session): number | undefined {
  return session.resolveModel().model.limit?.context
}

export function shouldCompact(session: Session): boolean {
  const cfg = session.config.compaction
  if (cfg?.enabled === false || session.compactionSuspended) return false
  const limit = contextLimit(session)
  if (!limit) return false
  const threshold = cfg?.threshold ?? DEFAULT_THRESHOLD
  return contextTokens(session) >= limit * threshold
}

/**
 * Index of the first message to keep. Walks back over `keepTurns` user turns;
 * returns 0 when there is nothing safe to drop.
 */
export function findCutIndex(messages: ModelMessage[], keepTurns: number): number {
  if (keepTurns < 1) return 0
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue
    seen++
    // The `keepTurns`-th user turn from the end is the first one kept. Cutting
    // one turn later than that kept `keepTurns + 1`, so a configured 2 meant 3.
    if (seen === keepTurns) return i
  }
  return 0
}

/**
 * Where to cut when there are not enough user turns to cut between.
 *
 * One long agentic turn — a single question that ran fifty tool calls — has one
 * user message, so the turn-based cut always answered 0 and compaction declined
 * for the whole run. The session then died on a context-length error from the
 * provider, which is the outcome compaction exists to prevent. Cutting by
 * message count instead keeps the last `keepMessages`, moved forward to the
 * first message that is not a tool result so no result is orphaned from the
 * call that produced it.
 */
export function findFallbackCut(messages: ModelMessage[], keepMessages: number): number {
  if (messages.length <= keepMessages) return 0
  for (let i = messages.length - keepMessages; i < messages.length; i++) {
    if (messages[i].role !== 'tool') return i
  }
  return 0
}

async function summaryModel(session: Session): Promise<LanguageModel> {
  const ref = session.config.compaction?.model ?? session.config.smallModel
  if (!ref || ref === session.modelRef) return (await session.model()) as LanguageModel
  try {
    const resolved = resolveModel(session.config, ref)
    return (await createLanguageModel(resolved, {
      openCodeAuth: session.config.openCodeAuth,
    })) as LanguageModel
  } catch {
    return (await session.model()) as LanguageModel
  }
}

const SUMMARY_SYSTEM = `You compact an agent conversation so work can continue after the transcript is truncated.

Write a dense handoff for an agent that will keep working and cannot see the original messages. Be exhaustive about state, terse about prose. Cover, using these headings and omitting any that do not apply:

## Task
What the user asked for, in their terms, including constraints and explicit preferences.

## Decisions
Choices already made and why. Include options that were rejected, so they are not revisited.

## Work done
Files created or modified with full paths, commands run and their outcome, findings that were verified.

## Current state
What is working, what is broken, what was left half-done.

## Open items
Unanswered questions, known bugs, and the next concrete steps.

Rules: preserve exact identifiers — file paths, function names, commands, error strings, versions, IDs. Never invent progress. If something was attempted and failed, say so with the error. Do not address the user; this is notes to a successor.`

export async function compact(
  session: Session,
  opts: { instructions?: string; trigger?: 'auto' | 'manual' } = {},
): Promise<CompactionResult> {
  const trigger = opts.trigger ?? 'auto'
  const before = contextTokens(session)

  const hookBase = {
    session_id: session.transcript.sessionId,
    transcript_path: session.transcript.file,
    cwd: session.cwd,
    permission_mode: session.mode,
    trigger,
    tokens: before,
  }

  const pre = summarize(await session.hooks.run('PreCompact', hookBase, trigger))
  if (pre.blocked) {
    return { compacted: false, before, after: before, reason: pre.blockReasons.join('; ') }
  }

  const keepTurns = session.config.compaction?.keepRecentTurns ?? DEFAULT_KEEP_TURNS
  const cut =
    findCutIndex(session.messages, keepTurns) ||
    findFallbackCut(session.messages, KEEP_MESSAGES_FALLBACK)
  if (cut === 0) {
    return {
      compacted: false,
      before,
      after: before,
      reason: 'nothing safe to summarise yet — the recent turns already span the whole history',
    }
  }

  const older = session.messages.slice(0, cut)
  const tail = session.messages.slice(cut)

  let summary: string
  try {
    const model = await summaryModel(session)
    const focus = opts.instructions
      ? `\n\nThe user asked the summary to focus on: ${opts.instructions}`
      : ''

    // Streaming, not generateText: some OpenAI-compatible proxies only answer
    // correctly with `stream: true` and return a non-JSON body otherwise.
    let streamError: string | null = null
    const result = streamText({
      model,
      system: SUMMARY_SYSTEM,
      maxOutputTokens: session.config.compaction?.maxOutputTokens ?? DEFAULT_SUMMARY_TOKENS,
      messages: [
        ...older,
        {
          role: 'user',
          content:
            'Compact the conversation above into the handoff described in your instructions.' +
            focus,
        },
      ],
      onError: ({ error }: { error: unknown }) => {
        streamError = describeError(error)
      },
    })

    let text = ''
    try {
      text = await result.text
    } catch (err) {
      // The stream may reject with a generic wrapper; onError carries the detail.
      if (!streamError) streamError = describeError(err)
    }
    void Promise.resolve(result.usage).catch(() => {})
    if (streamError) throw new Error(streamError)
    summary = text.trim()
  } catch (err) {
    // Losing history to a failed summary would be worse than staying oversized.
    return {
      compacted: false,
      before,
      after: before,
      reason: `summary call failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  summary = stripEmptyThinkTags(summary)
  if (!summary) {
    return { compacted: false, before, after: before, reason: 'summary came back empty' }
  }

  const block: ModelMessage = {
    role: 'user',
    content:
      `<compaction-summary>\n` +
      `The earlier part of this conversation was compacted to stay inside the context window. ` +
      `The messages are gone; this summary is the only record of them. Continue from here.\n\n` +
      `${summary}\n` +
      `</compaction-summary>`,
  }

  const next = [block, ...tail]

  // A verbose summary of a short history can be larger than what it replaces.
  // Swapping it in would lose detail and save nothing, so keep the original.
  const beforeEstimate = estimateMessagesTokens(session.messages)
  const afterEstimate = estimateMessagesTokens(next)
  if (afterEstimate >= beforeEstimate) {
    return {
      compacted: false,
      before,
      after: before,
      reason: `summary (~${afterEstimate} tokens) is not smaller than the history it replaces (~${beforeEstimate})`,
    }
  }

  session.messages = next
  // The provider's old input-token count no longer describes this prompt.
  session.tokenBaseline = undefined
  const after = contextTokens(session)

  session.transcript.append(
    'compaction',
    {
      trigger,
      tokensBefore: before,
      tokensAfter: after,
      messagesSummarised: older.length,
      messagesKept: tail.length,
      summary,
    },
    { isSidechain: session.depth > 0, agentId: session.agentType },
  )

  await session.hooks.run(
    'PostCompact',
    { ...hookBase, tokens_before: before, tokens_after: after },
    trigger,
  )

  return { compacted: true, before, after, summary }
}

/** Called before each model call; compacts only when over the threshold. */
export async function maybeCompact(session: Session): Promise<void> {
  if (!shouldCompact(session)) return
  const limit = contextLimit(session)
  session.emit({
    type: 'notice',
    text: `context at ~${contextTokens(session)} tokens of ${limit} — compacting`,
  })
  const result = await compact(session, { trigger: 'auto' })
  session.emit({
    type: 'notice',
    text: result.compacted
      ? `compacted: ~${result.before} -> ~${result.after} tokens`
      : `compaction skipped: ${result.reason}`,
  })
  if (!result.compacted) {
    // Do not retry every step; a blocked or impossible compaction stays blocked.
    session.compactionSuspended = true
  }
}
