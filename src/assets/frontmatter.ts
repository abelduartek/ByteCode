// Minimal YAML front-matter parser.
//
// Scope is deliberately small: the keys used by SKILL.md / agent files are
// scalars and simple inline lists. Pulling in a YAML dependency to read
// `name:` and `description:` is not worth the install.

export type FrontMatter = {
  data: Record<string, string | string[]>
  body: string
}

const DELIM = /^---\r?\n/

export function parseFrontMatter(input: string): FrontMatter {
  // A BOM before the opening `---` would make the delimiter test fail and the
  // whole front matter be treated as body.
  const raw = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  if (!DELIM.test(raw)) return { data: {}, body: raw }

  const rest = raw.replace(DELIM, '')
  const end = rest.search(/^---\s*$/m)
  if (end === -1) return { data: {}, body: raw }

  const head = rest.slice(0, end)
  const body = rest.slice(end).replace(/^---\s*\r?\n?/, '')

  const data: Record<string, string | string[]> = {}
  let currentKey: string | null = null

  // Indexed rather than iterated: a block scalar consumes the lines under it.
  const headLines = head.split(/\r?\n/)
  for (let index = 0; index < headLines.length; index++) {
    const line = headLines[index]
    if (!line.trim() || line.trim().startsWith('#')) continue

    // Block list item: `  - value`
    const item = line.match(/^\s*-\s+(.*)$/)
    if (item && currentKey) {
      const prev = data[currentKey]
      const list = Array.isArray(prev) ? prev : prev ? [prev] : []
      list.push(unquote(item[1]))
      data[currentKey] = list
      continue
    }

    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/)
    if (!kv) continue

    const key = kv[1]
    const value = kv[2].trim()
    currentKey = key

    if (value === '') {
      data[key] = []
      continue
    }
    // `key: |` and `key: >` introduce a block scalar, whose text is the indented
    // lines under it. Read as an ordinary value, the field became the literal
    // string "|" — so a multi-line `description:` came out as one character.
    if (value === '|' || value === '>' || value === '|-' || value === '>-') {
      const collected: string[] = []
      let indent: number | null = null
      while (index + 1 < headLines.length) {
        const next = headLines[index + 1]
        if (next.trim() === '') {
          collected.push('')
          index++
          continue
        }
        const width = next.length - next.trimStart().length
        if (indent === null) {
          // The first non-blank line sets the block's indentation; anything less
          // indented is the next key, not part of this value.
          if (width === 0) break
          indent = width
        } else if (width < indent) {
          break
        }
        collected.push(next.slice(indent))
        index++
      }
      while (collected.length > 0 && collected[collected.length - 1] === '') collected.pop()
      const folded = value.startsWith('>')
        ? collected.join(' ').replace(/\s+/g, ' ').trim()
        : collected.join('\n')
      data[key] = folded
      continue
    }
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map(s => unquote(s.trim()))
        .filter(Boolean)
      continue
    }
    data[key] = unquote(value)
  }

  return { data, body }
}

export function asString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined
  return Array.isArray(v) ? v.join(', ') : v
}

/**
 * Reads a field that may be written either as a YAML list or `a, b, c`.
 *
 * Splitting happens on commas that separate *entries*, not on commas inside
 * one: a permission rule like `Bash(git commit -m "a, b")` is a single entry,
 * and cutting it in half produced two rules that match nothing.
 */
export function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  if (Array.isArray(v)) return v

  const out: string[] = []
  let current = ''
  let depth = 0
  let quote: '"' | "'" | null = null
  for (const ch of v) {
    if (quote) {
      if (ch === quote) quote = null
      current += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === '(' || ch === '[') depth++
    if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    if (ch === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += ch
  }
  out.push(current)
  return out.map(s => s.trim()).filter(Boolean)
}

function unquote(s: string): string {
  const t = s.trim()
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    return t.slice(1, -1)
  }
  return t
}
