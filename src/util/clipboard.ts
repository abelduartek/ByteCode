import { spawn } from 'node:child_process'
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
    child.on('error', () => done(false))
    child.on('close', code => done(code === 0))
    try {
      child.stdin?.end(candidate.encode(text))
    } catch {
      done(false)
    }
    setTimeout(() => done(false), 3000)
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
