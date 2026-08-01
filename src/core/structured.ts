// Getting a model to answer with JSON, and reading what came back.
//
// There is no schema *validation* here, and that is deliberate: what fails in
// practice is the model wrapping the answer in prose or a code fence, not the
// model inventing a field. A recursive validator would be code that changes no
// behaviour at the only call sites that exist — the check is `JSON.parse`, and
// what was missing was a second chance when that throws.
//
// Shared by `Workflow` (which has had this since it shipped) and the `Agent`
// tool, so the two cannot drift.

/**
 * The suffix appended to the prompt.
 *
 * The literal `JSON Schema` is load-bearing beyond the prompt: the workflow test
 * fixture branches on it to decide whether to answer with JSON, so rewording
 * this sentence silently changes what that suite exercises.
 */
export function schemaInstruction(schema: Record<string, unknown>): string {
  return (
    '\n\n---\n\nReturn ONLY a JSON object matching this JSON Schema. No prose, no code fence:\n' +
    JSON.stringify(schema)
  )
}

/**
 * The JSON inside a model's answer. Throws when there is none.
 *
 * A fenced block wins, then the first `{` or `[` — models routinely lead with
 * "Here is the JSON you asked for:" no matter how the prompt is worded.
 */
export function parseStructured(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenced ? fenced[1] : text).trim()
  const start = candidate.search(/[{[]/)
  if (start === -1) throw new Error('no JSON found in the response')
  const body = candidate.slice(start)
  return JSON.parse(body)
}

/** What to say to a model that answered with something unparseable. */
export function repairInstruction(schema: Record<string, unknown>, error: string): string {
  return (
    `Your previous answer could not be read as JSON (${error}). ` +
    'Answer again with the JSON object only — no explanation before or after it, no code fence.' +
    `\n\nThe schema:\n${JSON.stringify(schema)}`
  )
}
