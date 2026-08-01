import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { envOption } from './paths.ts'

// Clipboard without a dependency. Each platform gets the tool it actually has;
// on Windows `clip` reads UTF-16LE, so a BOM-prefixed buffer is what keeps
// accented text intact.

type Candidate = { command: string; args: string[]; encode: (text: string) => Buffer }

const UTF8 = (text: string) => Buffer.from(text, 'utf8')
const UTF16 = (text: string) => Buffer.from(`﻿${text}`, 'utf16le')

function candidates(): Candidate[] {
  if (process.platform === 'win32') {
    return [
      { command: 'clip', args: [], encode: UTF16 },
      {
        command: 'powershell.exe',
        args: ['-NoProfile', '-Command', '$input | Set-Clipboard'],
        encode: UTF8,
      },
    ]
  }
  if (process.platform === 'darwin') {
    return [{ command: 'pbcopy', args: [], encode: UTF8 }]
  }
  return [
    { command: 'wl-copy', args: [], encode: UTF8 },
    { command: 'xclip', args: ['-selection', 'clipboard'], encode: UTF8 },
    { command: 'xsel', args: ['--clipboard', '--input'], encode: UTF8 },
  ]
}

function tryCopy(candidate: Candidate, text: string): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
    }

    const child = spawn(candidate.command, candidate.args, { windowsHide: true })
    // A clipboard helper that never reads stdin makes this fail with EPIPE,
    // which as an unhandled stream error would take the process down.
    child.stdin?.on('error', () => done(false))
    child.on('error', () => done(false))
    child.on('close', code => {
      clearTimeout(timer)
      done(code === 0)
    })
    try {
      child.stdin?.end(candidate.encode(text))
    } catch {
      done(false)
    }
    // A helper that hangs is given up on — and killed, rather than left holding
    // a pipe. The timer is cleared on a normal exit and unref'd either way, so
    // it cannot be the reason the process stays alive for three more seconds.
    const timer = setTimeout(() => {
      child.kill()
      done(false)
    }, 3000)
    timer.unref?.()
  })
}

/** Last text handed to the clipboard. Lets tests assert without a real one. */
let lastCopied: string | null = null

export function lastClipboardWrite(): string | null {
  return lastCopied
}

/** Returns false when no clipboard tool is available. */
export async function copyToClipboard(text: string): Promise<boolean> {
  lastCopied = text
  // Tests and CI must not clobber the real clipboard.
  if (envOption('FAKE_CLIPBOARD')) return true

  for (const candidate of candidates()) {
    if (await tryCopy(candidate, text)) return true
  }
  return false
}

// ------------------------------------------------------------------ images

export type ClipboardImage = { data: Buffer; mediaType: string }

/** Magic-number sniff. The clipboard tools all hand back a real encoded file. */
export function sniffImageType(data: Buffer): string | null {
  if (data.length < 12) return null
  if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) return 'image/png'
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) return 'image/gif'
  if (
    data.toString('ascii', 0, 4) === 'RIFF' &&
    data.toString('ascii', 8, 12) === 'WEBP'
  ) {
    return 'image/webp'
  }
  if (data[0] === 0x42 && data[1] === 0x4d) return 'image/bmp'
  return null
}

/**
 * Windows has no CLI that writes clipboard image bytes to stdout, so the
 * PowerShell path saves a PNG to a temp file and we read that back. Writing to
 * stdout would also corrupt the bytes: PowerShell re-encodes its output stream.
 */
const WIN_IMAGE_SCRIPT = (file: string) =>
  `Add-Type -AssemblyName System.Windows.Forms,System.Drawing > $null
$img = [System.Windows.Forms.Clipboard]::GetImage()
if ($img -eq $null) {
  $files = [System.Windows.Forms.Clipboard]::GetFileDropList()
  if ($files -ne $null -and $files.Count -gt 0) {
    $p = $files[0]
    if ([System.IO.Path]::GetExtension($p) -in '.png','.jpg','.jpeg','.gif','.bmp','.webp') { Copy-Item -LiteralPath $p -Destination '${file}'; exit 0 }
  }
  exit 1
}
$img.Save('${file}', [System.Drawing.Imaging.ImageFormat]::Png)
exit 0`

function runCapture(
  command: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number | null; stdout: Buffer }> {
  return new Promise(resolve => {
    let settled = false
    const chunks: Buffer[] = []
    const done = (code: number | null) => {
      if (settled) return
      settled = true
      resolve({ code, stdout: Buffer.concat(chunks) })
    }

    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { windowsHide: true })
    } catch {
      done(null)
      return
    }
    child.on('error', () => done(null))
    child.stdout?.on('data', (c: Buffer) => chunks.push(Buffer.from(c)))
    child.on('close', code => done(code))
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      done(null)
    }, timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
  })
}

async function readImageWindows(): Promise<ClipboardImage | null> {
  const file = path.join(
    os.tmpdir(),
    `bytecode-clip-${process.pid}-${Date.now()}.png`,
  )
  try {
    const result = await runCapture(
      'powershell.exe',
      ['-NoProfile', '-STA', '-Command', WIN_IMAGE_SCRIPT(file.replace(/'/g, "''"))],
      8000,
    )
    if (result.code !== 0) return null
    const data = await fs.readFile(file)
    const mediaType = sniffImageType(data)
    return mediaType ? { data, mediaType } : null
  } catch {
    return null
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

async function readImageMac(): Promise<ClipboardImage | null> {
  // `pngpaste` is not installed by default, so osascript is the fallback that
  // always exists. Both end up as a file we read back.
  const file = path.join(os.tmpdir(), `bytecode-clip-${process.pid}-${Date.now()}.png`)
  try {
    const direct = await runCapture('pngpaste', ['-'])
    if (direct.code === 0 && direct.stdout.length > 0) {
      const mediaType = sniffImageType(direct.stdout)
      if (mediaType) return { data: direct.stdout, mediaType }
    }
    const script = `set f to (open for access POSIX file "${file}" with write permission)
try
  write (the clipboard as «class PNGf») to f
  close access f
on error
  close access f
  error "no image"
end try`
    const result = await runCapture('osascript', ['-e', script])
    if (result.code !== 0) return null
    const data = await fs.readFile(file)
    const mediaType = sniffImageType(data)
    return mediaType ? { data, mediaType } : null
  } catch {
    return null
  } finally {
    await fs.rm(file, { force: true }).catch(() => {})
  }
}

async function readImageLinux(): Promise<ClipboardImage | null> {
  const targets = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
  for (const target of targets) {
    for (const attempt of [
      { command: 'wl-paste', args: ['--type', target] },
      { command: 'xclip', args: ['-selection', 'clipboard', '-t', target, '-o'] },
    ]) {
      const result = await runCapture(attempt.command, attempt.args)
      if (result.code === 0 && result.stdout.length > 0) {
        const mediaType = sniffImageType(result.stdout)
        if (mediaType) return { data: result.stdout, mediaType }
      }
    }
  }
  return null
}

/** Test seam: what `readImageFromClipboard` returns when faking. */
let fakeImage: ClipboardImage | null = null

export function setFakeClipboardImage(image: ClipboardImage | null): void {
  fakeImage = image
}

/**
 * Image currently on the clipboard, or null when there is none — which is the
 * common case, so every path stays quiet and cheap on failure.
 */
export async function readImageFromClipboard(): Promise<ClipboardImage | null> {
  if (envOption('FAKE_CLIPBOARD')) return fakeImage

  if (process.platform === 'win32') return readImageWindows()
  if (process.platform === 'darwin') return readImageMac()
  return readImageLinux()
}
