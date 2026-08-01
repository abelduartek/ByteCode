import readline from 'node:readline'
import type { ConnectIO } from '../provider/connect.ts'

// Small readline wrapper with masked input, used by the CLI connect flow.

export type CliIO = ConnectIO & { close: () => void }

/** The private bits of a readline interface this file has to reach into. */
type RawInterface = {
  _writeToOutput?: (s: string) => void
  _prompt?: string
  history?: string[]
}

/**
 * Asks without echoing the answer, showing one marker per character typed.
 *
 * Nothing about a secret may reach the screen or the scrollback: an API key
 * echoed in cleartext is one screen-share away from being someone else's. The
 * marker exists so the user can still tell that the terminal is receiving what
 * they type — a prompt that stays perfectly still reads as frozen, and the usual
 * reaction is to type the key a second time.
 */
function maskedQuestion(rl: readline.Interface, text: string): Promise<string> {
  const iface = rl as unknown as RawInterface
  const original = iface._writeToOutput

  iface._writeToOutput = function (s: string): void {
    const prompt = iface._prompt ?? ''
    if (s.startsWith(prompt)) {
      // A full-line refresh: the prompt, then the line as markers.
      original?.call(rl, prompt + '*'.repeat(Math.max(0, s.length - prompt.length)))
      return
    }
    // A single keystroke. Control sequences (backspace, arrows) are swallowed
    // rather than guessed at: the next refresh redraws the line correctly.
    if (s.length === 1 && s >= ' ') process.stdout.write('*')
  }

  const restore = (): void => {
    if (original) iface._writeToOutput = original
    else delete iface._writeToOutput
  }

  return new Promise(resolve => {
    // A closed stdin (Ctrl+D, piped input that ran out) has to read as
    // "cancelled". Without this the promise never settles and the flow that is
    // awaiting it hangs with no prompt on screen and no way back.
    const onClose = (): void => {
      restore()
      resolve('')
    }
    rl.once('close', onClose)
    rl.question(text, answer => {
      rl.removeListener('close', onClose)
      restore()
      forgetLastLine(rl)
      process.stdout.write('\n')
      resolve(answer)
    })
  })
}

/** Asks, and treats a closed interface as an empty answer rather than a hang. */
function question(rl: readline.Interface, text: string): Promise<string> {
  return new Promise(resolve => {
    const onClose = (): void => resolve('')
    rl.once('close', onClose)
    rl.question(text, answer => {
      rl.removeListener('close', onClose)
      resolve(answer)
    })
  })
}

/**
 * Drops the last answer from the interface's history.
 *
 * In terminal mode readline keeps every submitted line, so a key typed at a
 * prompt comes back to the next person who presses the up arrow.
 */
function forgetLastLine(rl: readline.Interface): void {
  const history = (rl as unknown as RawInterface).history
  if (Array.isArray(history) && history.length > 0) history.shift()
}

export function createCliIO(): CliIO {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  let closed = false
  rl.on('close', () => (closed = true))

  return {
    write: text => process.stdout.write(text),
    ask: text => (closed ? Promise.resolve('') : question(rl, text)),
    askSecret: text => (closed ? Promise.resolve('') : maskedQuestion(rl, text)),
    close: () => {
      if (!closed) rl.close()
    },
  }
}

/** Wraps an existing readline interface (the TUI's) as a ConnectIO. */
export function ioFromReadline(rl: readline.Interface): ConnectIO {
  return {
    write: text => process.stdout.write(text),
    ask: text => {
      rl.resume()
      return question(rl, text)
    },
    // Masked here too: this is the path `/connect` takes from inside a session,
    // and it used to echo the key in cleartext straight into the transcript the
    // user is looking at, and into the line history.
    askSecret: text => {
      rl.resume()
      return maskedQuestion(rl, text)
    },
  }
}
