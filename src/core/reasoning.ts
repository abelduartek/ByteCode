// Some OpenAI-compatible proxies (9router among them) stream the model's
// reasoning as literal `<think>...</think>` inside the normal content channel
// instead of using a separate reasoning part. Left alone it lands in the answer.
//
// This splits a token stream into visible text and reasoning, holding back any
// trailing fragment that might be the start of a tag so a tag split across two
// deltas is still recognised.

const OPEN = ['<think>', '<thinking>', '<reasoning>']
const CLOSE = ['</think>', '</thinking>', '</reasoning>']
const MAX_TAG = Math.max(...[...OPEN, ...CLOSE].map(t => t.length))

export type Split = { text: string; reasoning: string }

function firstMatch(haystack: string, tags: string[]): { index: number; tag: string } {
  let best = { index: -1, tag: '' }
  for (const tag of tags) {
    const index = haystack.indexOf(tag)
    if (index !== -1 && (best.index === -1 || index < best.index)) best = { index, tag }
  }
  return best
}

/**
 * How much of `buffer` can be released now: everything except a trailing run
 * that could still grow into one of `tags`.
 */
function releasable(buffer: string, tags: string[]): number {
  const max = Math.min(MAX_TAG - 1, buffer.length)
  for (let keep = max; keep > 0; keep--) {
    const tail = buffer.slice(buffer.length - keep)
    if (tags.some(tag => tag.startsWith(tail))) return buffer.length - keep
  }
  return buffer.length
}

export class ThinkFilter {
  private inside = false
  private buffer = ''
  private readonly enabled: boolean

  constructor(opts: { enabled?: boolean } = {}) {
    this.enabled = opts.enabled !== false
  }

  push(chunk: string): Split {
    if (!this.enabled) return { text: chunk, reasoning: '' }
    this.buffer += chunk
    let text = ''
    let reasoning = ''

    for (;;) {
      const tags = this.inside ? CLOSE : OPEN
      const hit = firstMatch(this.buffer, tags)

      if (hit.index === -1) {
        const upto = releasable(this.buffer, tags)
        if (this.inside) reasoning += this.buffer.slice(0, upto)
        else text += this.buffer.slice(0, upto)
        this.buffer = this.buffer.slice(upto)
        break
      }

      if (this.inside) reasoning += this.buffer.slice(0, hit.index)
      else text += this.buffer.slice(0, hit.index)
      this.buffer = this.buffer.slice(hit.index + hit.tag.length)
      this.inside = !this.inside
    }

    return { text, reasoning }
  }

  /** Releases whatever is still held back once the stream ends. */
  flush(): Split {
    const rest = this.buffer
    this.buffer = ''
    const split = this.inside ? { text: '', reasoning: rest } : { text: rest, reasoning: '' }
    this.inside = false
    return split
  }

  get isThinking(): boolean {
    return this.inside
  }
}

/** One-shot cleanup for text that is already complete. */
export function stripThinking(text: string): string {
  const filter = new ThinkFilter()
  const a = filter.push(text)
  const b = filter.flush()
  return (a.text + b.text).trim()
}
