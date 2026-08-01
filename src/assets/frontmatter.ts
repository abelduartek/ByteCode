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

  for (const line of head.split(/\r?\n/)) {
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

/** Reads a field that may be written either as a YAML list or `a, b, c`. */
export function asList(v: string | string[] | undefined): string[] {
  if (v === undefined) return []
  if (Array.isArray(v)) return v
  return v
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
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
