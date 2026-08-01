import type { Session, TurnStats } from './session.ts'

// Leadtime reporting. The loop already receives everything a provider tells us
// about a turn; without somewhere to put it, that data was being discarded and
// "how long did this take and what did it cost" was unanswerable after the fact.

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const totalSeconds = ms / 1000
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = Math.round(totalSeconds % 60)
  if (minutes < 60) return `${minutes}m ${String(seconds).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

export function durationOf(stats: TurnStats): number {
  return (stats.endedAt ?? Date.now()) - stats.startedAt
}

/**
 * USD for a turn, when the model declares prices. Cached reads bill at a
 * fraction of the input rate, so they are counted separately rather than folded
 * into `inputTokens`.
 */
export function costOf(session: Session, stats: TurnStats): number | null {
  let cost: { input?: number; output?: number } | undefined
  try {
    cost = session.resolveModel().model.cost
  } catch {
    return null
  }
  if (!cost || (cost.input === undefined && cost.output === undefined)) return null

  const inputRate = cost.input ?? 0
  const outputRate = cost.output ?? 0
  const fresh = Math.max(0, stats.inputTokens - stats.cacheReadTokens)
  return (
    (fresh * inputRate +
      stats.cacheReadTokens * inputRate * 0.1 +
      stats.cacheWriteTokens * inputRate * 1.25 +
      stats.outputTokens * outputRate) /
    1_000_000
  )
}

function toolRows(stats: TurnStats): string[] {
  const entries = Object.entries(stats.tools).sort((a, b) => b[1].calls - a[1].calls)
  if (entries.length === 0) return ['| _nenhuma_ | | | |']
  return entries.map(([name, stat]) => {
    const failures = stat.fail > 0 ? `${stat.fail} falha(s)` : 'ok'
    return `| ${name} | ${stat.calls} | ${failures} | ${formatDuration(stat.ms)} |`
  })
}

/** One line for the status bar / end-of-turn footer. */
export function summarizeTurn(session: Session, stats: TurnStats): string {
  const parts = [
    formatDuration(durationOf(stats)),
    `${stats.steps} step${stats.steps === 1 ? '' : 's'}`,
    `↑ ${formatCount(stats.inputTokens)}`,
    `↓ ${formatCount(stats.outputTokens)}`,
  ]
  if (stats.cacheReadTokens > 0) parts.push(`cache ${formatCount(stats.cacheReadTokens)}`)
  if (stats.retries > 0) parts.push(`${stats.retries} retry`)
  const cost = costOf(session, stats)
  if (cost !== null && cost > 0) parts.push(`$${cost.toFixed(4)}`)
  return parts.join(' · ')
}

function totals(stats: TurnStats): { calls: number; failures: number } {
  const values = Object.values(stats.tools)
  return {
    calls: values.reduce((sum, t) => sum + t.calls, 0),
    failures: values.reduce((sum, t) => sum + t.fail, 0),
  }
}

/** The numbers block, shared by the turn and the session. */
function statsTable(session: Session, stats: TurnStats): string[] {
  const cost = costOf(session, stats)
  const { calls, failures } = totals(stats)
  const lines = [
    `| | |`,
    `|---|---|`,
    `| duração | **${formatDuration(durationOf(stats))}** |`,
    `| chamadas ao modelo | ${stats.steps}${stats.retries > 0 ? ` (+${stats.retries} retry)` : ''} |`,
    `| tokens entrada | ${formatCount(stats.inputTokens)} |`,
    `| tokens saída | ${formatCount(stats.outputTokens)} |`,
  ]
  if (stats.cacheReadTokens > 0 || stats.cacheWriteTokens > 0) {
    lines.push(
      `| cache lido / escrito | ${formatCount(stats.cacheReadTokens)} / ${formatCount(stats.cacheWriteTokens)} |`,
    )
  }
  lines.push(`| tool calls | ${calls}${failures > 0 ? ` (${failures} com erro)` : ''} |`)
  if (cost !== null) lines.push(`| custo estimado | $${cost.toFixed(4)} |`)
  return lines
}

/** Turns listed in the session report; older ones are summarised as a count. */
const TURNS_SHOWN = 12

function turnRows(session: Session, turns: TurnStats[]): string[] {
  const shown = turns.slice(-TURNS_SHOWN)
  const offset = turns.length - shown.length
  return shown.map((turn, i) => {
    const cost = costOf(session, turn)
    const { calls } = totals(turn)
    // The pipe is the table's own separator, so a prompt containing one would
    // split into phantom columns.
    const label = (turn.label ?? '').replace(/\|/g, '¦') || '_(sem texto)_'
    return `| ${offset + i + 1} | ${label} | ${formatDuration(durationOf(turn))} | ${turn.steps} | ${calls} | ${cost === null ? '—' : `$${cost.toFixed(2)}`} |`
  })
}

export function formatLeadtime(session: Session, stats: TurnStats, title = 'leadtime'): string {
  const lines = [
    `# ${title}`,
    '',
    ...(stats.label ? [`_${stats.label}_`, ''] : []),
    ...statsTable(session, stats),
    '',
    '| tool | calls | resultado | tempo somado |',
    '|---|---|---|---|',
    ...toolRows(stats),
  ]

  // Only the root session gets the session report: a subagent's "session" is one
  // turn deep, so it would repeat the block above with the same numbers.
  if (session.depth === 0) {
    const turns = session.turns
    lines.push(
      '',
      `## sessão${turns.length > 0 ? ` · ${turns.length} turno${turns.length === 1 ? '' : 's'}` : ''}`,
      '',
      ...statsTable(session, session.sessionStats),
    )
    if (Object.keys(session.sessionStats.tools).length > 0) {
      lines.push(
        '',
        '| tool | calls | resultado | tempo somado |',
        '|---|---|---|---|',
        ...toolRows(session.sessionStats),
      )
    }
    if (turns.length > 0) {
      lines.push(
        '',
        '| # | pedido | duração | steps | tools | custo |',
        '|---|---|---|---|---|---|',
        ...turnRows(session, turns),
      )
      if (turns.length > TURNS_SHOWN) {
        lines.push('', `_${turns.length - TURNS_SHOWN} turno(s) anteriores omitidos._`)
      }
    }
    lines.push(
      '',
      '_tempo por tool é somado; chamadas paralelas se sobrepõem, então a soma pode passar da duração do turno. Subagents entram no total._',
    )
  }
  return lines.join('\n')
}
