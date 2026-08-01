/** One-line, actionable rendering of provider and runtime errors. */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    const e = err as Error & { statusCode?: number; url?: string; responseBody?: string }
    const parts = [e.name]
    if (e.statusCode) parts.push(`HTTP ${e.statusCode}`)
    parts.push(e.message)
    if (e.statusCode === 401 || e.statusCode === 403) {
      parts.push(
        'No usable credential. Set the provider env var, `options.apiKey`, or ~/.bytecode/auth.json.',
      )
    }
    // SDK wrappers such as "No output generated" hide the real failure in `cause`.
    const cause = (e as { cause?: unknown }).cause
    if (cause instanceof Error && cause.message && !e.message.includes(cause.message)) {
      parts.push(`cause: ${cause.message}`)
    }
    return parts.join(' — ')
  }
  if (typeof err === 'string') return err
  try {
    return JSON.stringify(err)
  } catch {
    return String(err)
  }
}
