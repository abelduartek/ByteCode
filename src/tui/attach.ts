import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModelMessage } from 'ai'
import { sniffImageType } from '../util/clipboard.ts'

// Attachments keep the composer readable when the input is not really text: a
// screenshot, or a thousand-line stack trace. Both are replaced in the input by
// a short placeholder and carried alongside it, then reassembled at submit time.
//
// The placeholder is the contract between the three places that care: the
// composer draws it, the user can delete it like any other text, and `expand`
// only re-attaches what is still present in the line. Deleting the placeholder
// is therefore how you drop an attachment — no separate command needed.

/** A paste longer than this is folded into a placeholder instead of shown. */
export const PASTE_FOLD_CHARS = 900
/** ...or one taller than this, since 40 short lines also swamp the composer. */
export const PASTE_FOLD_LINES = 12

export type TextAttachment = {
  kind: 'text'
  id: number
  text: string
  lines: number
}

export type ImageAttachment = {
  kind: 'image'
  id: number
  data: Buffer
  mediaType: string
  /** Set when it came from a file path rather than the clipboard. */
  origin?: string
}

export type Attachment = TextAttachment | ImageAttachment

/**
 * Placeholders are matched by id, not by scanning for their text, so a label
 * containing regex metacharacters (a Windows path, say) cannot break the match.
 */
export function placeholderFor(attachment: Attachment): string {
  if (attachment.kind === 'image') return `[Image #${attachment.id}]`
  return `[Pasted text #${attachment.id} +${attachment.lines} lines]`
}

/** Human-sized byte count for the composer hint. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Short description shown under the composer, one per live attachment. */
export function describeAttachment(attachment: Attachment): string {
  if (attachment.kind === 'image') {
    const type = attachment.mediaType.replace('image/', '')
    const where = attachment.origin ? ` ${path.basename(attachment.origin)}` : ''
    return `#${attachment.id} imagem${where} ${type} ${formatBytes(attachment.data.length)}`
  }
  return `#${attachment.id} texto ${attachment.lines} linhas ${formatBytes(attachment.text.length)}`
}

/** Whether a paste is big enough to be worth folding away. */
export function shouldFold(text: string): boolean {
  if (text.length >= PASTE_FOLD_CHARS) return true
  return countLines(text) > PASTE_FOLD_LINES
}

export function countLines(text: string): number {
  let lines = 1
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') lines++
  return lines
}

/**
 * Holds the attachments of the composer as it is being typed.
 *
 * Ids never repeat within a session even after a submit, so a placeholder left
 * in the history cannot silently pick up a different attachment later.
 */
export class AttachmentStore {
  private items = new Map<number, Attachment>()
  private nextId = 1

  addText(text: string): TextAttachment {
    const attachment: TextAttachment = {
      kind: 'text',
      id: this.nextId++,
      text,
      lines: countLines(text),
    }
    this.items.set(attachment.id, attachment)
    return attachment
  }

  addImage(data: Buffer, mediaType: string, origin?: string): ImageAttachment {
    const attachment: ImageAttachment = {
      kind: 'image',
      id: this.nextId++,
      data,
      mediaType,
      ...(origin ? { origin } : {}),
    }
    this.items.set(attachment.id, attachment)
    return attachment
  }

  get(id: number): Attachment | undefined {
    return this.items.get(id)
  }

  get size(): number {
    return this.items.size
  }

  /** Attachments still referenced by `input`, in the order they appear in it. */
  live(input: string): Attachment[] {
    const out: Attachment[] = []
    for (const ref of references(input)) {
      const attachment = this.items.get(ref.id)
      if (attachment && !out.includes(attachment)) out.push(attachment)
    }
    return out
  }

  /**
   * Forgets anything no longer referenced. Called after a submit so a long
   * session does not hold every screenshot it was ever shown in memory.
   */
  sweep(input: string): void {
    const alive = new Set(references(input).map(r => r.id))
    for (const id of [...this.items.keys()]) {
      if (!alive.has(id)) this.items.delete(id)
    }
  }

  clear(): void {
    this.items.clear()
  }
}

const IMAGE_REF = /\[Image #(\d+)\]/g
const TEXT_REF = /\[Pasted text #(\d+) \+\d+ lines\]/g

export type Reference = { id: number; from: number; to: number; kind: 'text' | 'image' }

/** Every placeholder in a line, in order of appearance. */
export function references(input: string): Reference[] {
  const out: Reference[] = []
  for (const [pattern, kind] of [
    [IMAGE_REF, 'image'],
    [TEXT_REF, 'text'],
  ] as const) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = pattern.exec(input))) {
      out.push({
        id: Number(match[1]),
        from: match.index,
        to: match.index + match[0].length,
        kind,
      })
    }
  }
  return out.sort((a, b) => a.from - b.from)
}

/**
 * The line as the model should see it: text placeholders become the text they
 * stand for, image placeholders stay as a marker and travel as image parts.
 *
 * Returns `null` for `images` when there are none, so the common case keeps
 * sending a plain string and nothing downstream has to learn about parts.
 */
export function expand(
  input: string,
  store: AttachmentStore,
): { text: string; images: ImageAttachment[] } {
  const images: ImageAttachment[] = []
  let text = ''
  let at = 0

  for (const ref of references(input)) {
    const attachment = store.get(ref.id)
    if (!attachment) continue
    text += input.slice(at, ref.from)
    at = ref.to

    if (attachment.kind === 'text') {
      text += attachment.text
    } else {
      // The marker stays in the text so the model can tell *where* in the
      // sentence the image belongs when several are attached.
      text += placeholderFor(attachment)
      if (!images.includes(attachment)) images.push(attachment)
    }
  }
  text += input.slice(at)
  return { text, images }
}

/** A user message carrying images, in the AI SDK's content-part shape. */
export function userContent(
  text: string,
  images: ImageAttachment[],
): ModelMessage['content'] {
  if (images.length === 0) return text
  return [
    { type: 'text' as const, text },
    ...images.map(image => ({
      type: 'image' as const,
      image: image.data,
      mediaType: image.mediaType,
    })),
  ] as ModelMessage['content']
}

/** Extensions worth trying to attach when a path is pasted or dropped. */
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'])

/**
 * A path to an image, as terminals produce when a file is dragged in: possibly
 * quoted, possibly backslash-escaped for spaces, possibly with a trailing
 * newline. Returns null for anything that is not a lone path.
 */
export function imagePathIn(raw: string): string | null {
  const text = raw.trim()
  if (!text || text.includes('\n')) return null

  let candidate = text
  const quoted = /^(['"])([\s\S]+)\1$/.exec(candidate)
  if (quoted) candidate = quoted[2]
  // iTerm and GNOME Terminal escape spaces when dropping a file.
  else if (candidate.includes('\\ ')) candidate = candidate.replace(/\\ /g, ' ')

  if (candidate.startsWith('file://')) {
    try {
      candidate = decodeURIComponent(new URL(candidate).pathname)
      if (process.platform === 'win32') candidate = candidate.replace(/^\//, '')
    } catch {
      return null
    }
  }

  if (!IMAGE_EXTENSIONS.has(path.extname(candidate).toLowerCase())) return null
  return candidate
}

/** Largest image accepted, before base64 expansion. Providers reject far less. */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

export type ImageReadResult =
  | { ok: true; data: Buffer; mediaType: string }
  | { ok: false; reason: string }

/** Reads an image file, refusing anything that is not really an image. */
export async function readImageFile(file: string, cwd: string): Promise<ImageReadResult> {
  const resolved = path.isAbsolute(file) ? file : path.resolve(cwd, file)
  try {
    const stat = await fs.stat(resolved)
    if (!stat.isFile()) return { ok: false, reason: 'não é um arquivo' }
    if (stat.size > MAX_IMAGE_BYTES) {
      return { ok: false, reason: `imagem grande demais (${formatBytes(stat.size)})` }
    }
    const data = await fs.readFile(resolved)
    const mediaType = sniffImageType(data)
    if (!mediaType) return { ok: false, reason: 'formato de imagem não reconhecido' }
    return { ok: true, data, mediaType }
  } catch {
    return { ok: false, reason: 'não consegui ler o arquivo' }
  }
}
