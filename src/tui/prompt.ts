import readline from 'node:readline'
import type { ConnectIO } from '../provider/connect.ts'

// Small readline wrapper with masked input, used by the CLI connect flow.

export type CliIO = ConnectIO & { close: () => void }

export function createCliIO(): CliIO {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
  })

  const state = { muted: false }
  const original = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput
  ;(rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = function (s: string) {
    if (!state.muted) {
      original?.call(rl, s)
      return
    }
    // Echo a fixed marker instead of the key, keeping the prompt visible.
    const prompt = (rl as unknown as { _prompt?: string })._prompt ?? ''
    if (s.startsWith(prompt)) process.stdout.write(prompt)
  }

  // A closed stdin (piped input that ran out, Ctrl+D) must read as "cancelled",
  // not as an exception thrown from inside the flow.
  let closed = false
  rl.on('close', () => (closed = true))

  const question = (text: string, muted: boolean): Promise<string> =>
    new Promise(resolve => {
      if (closed) {
        resolve('')
        return
      }
      const onClose = () => resolve('')
      rl.once('close', onClose)
      state.muted = muted
      rl.question(text, answer => {
        rl.removeListener('close', onClose)
        state.muted = false
        if (muted) process.stdout.write('\n')
        resolve(answer)
      })
    })

  return {
    write: text => process.stdout.write(text),
    ask: text => question(text, false),
    askSecret: text => question(text, true),
    close: () => {
      state.muted = false
      if (!closed) rl.close()
    },
  }
}

/** Wraps an existing readline interface (the TUI's) as a ConnectIO. */
export function ioFromReadline(rl: readline.Interface): ConnectIO {
  return {
    write: text => process.stdout.write(text),
    ask: question =>
      new Promise(resolve => {
        rl.resume()
        rl.question(question, answer => resolve(answer))
      }),
    askSecret: question =>
      new Promise(resolve => {
        rl.resume()
        rl.question(question, answer => resolve(answer))
      }),
  }
}
