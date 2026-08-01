import readline from 'node:readline'
import type { Session, UIEvent, PermissionRequest } from '../core/session.ts'
import { runTurn } from '../core/loop.ts'
import { compact, contextLimit, contextTokens } from '../core/compaction.ts'
import { formatLeadtime, summarizeTurn } from '../core/leadtime.ts'
import { formatWhen, listSessions, loadSession } from '../core/sessions.ts'
import { formatContextReport } from '../core/contextreport.ts'
import { expandCommandBody } from '../assets/index.ts'
import { listModels, withConnectedProviders } from '../provider/registry.ts'
import { listConnections, runConnect, runDisconnect } from '../provider/connect.ts'
import { ioFromReadline } from './prompt.ts'
import { nextMode, PERMISSION_MODES } from '../core/permissions.ts'
import type { PermissionMode } from '../config/types.ts'
import { c, g } from './theme.ts'
import { color, symbols } from './ansi.ts'

// Deliberately dependency-free: one readline interface, paused while a turn
// streams so tool lines and assistant text can be written directly, resumed to
// read the next prompt. Permission questions reuse the same interface, which is
// safe because a turn is always awaited before the next line is read.

export async function runTui(session: Session): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })

  let streaming = false
  let lineOpen = false
  let sawReasoning = false
  let interrupts = 0

  const write = (s: string) => process.stdout.write(s)
  const endLine = () => {
    if (lineOpen) {
      write('\n')
      lineOpen = false
    }
  }

  session.emit = (event: UIEvent) => {
    switch (event.type) {
      case 'text':
        if (sawReasoning) {
          endLine()
          sawReasoning = false
        }
        write(event.text)
        lineOpen = !event.text.endsWith('\n')
        break
      case 'reasoning':
        if (!sawReasoning) {
          endLine()
          write(color.gray('thinking '))
          sawReasoning = true
        }
        write(color.gray('.'))
        lineOpen = true
        break
      case 'tool-start':
        endLine()
        write(`${color.blue(symbols.tool)} ${color.bold(event.name)} ${color.gray(event.summary)}\n`)
        break
      case 'tool-end':
        write(
          `  ${event.ok ? color.green(symbols.ok) : color.red(symbols.fail)} ${color.gray(
            event.preview,
          )}\n`,
        )
        break
      case 'notice':
        endLine()
        write(`${color.yellow(symbols.note)} ${event.text}\n`)
        break
      case 'error':
        endLine()
        write(`${color.red(symbols.fail)} ${color.red(event.text)}\n`)
        break
      case 'usage':
        if (event.input || event.output) {
          endLine()
          write(color.gray(`  tokens: ${event.input ?? '?'} in / ${event.output ?? '?'} out\n`))
        }
        break
      // No pinned strip in the line UI, so a subagent gets one line when it
      // starts and one when it returns — never its whole tool trace.
      case 'agent-start':
        endLine()
        write(`${color.blue('⤷')} ${color.bold(event.agentType)} ${color.gray(event.label)}\n`)
        break
      // The line UI has no strip and no viewer, so a child's events are dropped
      // rather than interleaved into the parent's output.
      case 'agent-event':
        break
      case 'agent-end':
        write(
          `  ${event.ok ? color.green(symbols.ok) : color.red(symbols.fail)} ${color.gray(
            `subagent ${event.chars} chars`,
          )}\n`,
        )
        break
      case 'turn-end':
        endLine()
        if (event.stats) write(color.gray(`  ${summarizeTurn(session, event.stats)}\n`))
        break
    }
  }

  session.requestPermission = (req: PermissionRequest) =>
    askPermission(rl, session, req)

  process.on('SIGINT', () => {
    if (streaming) {
      session.abort?.abort()
      endLine()
      write(color.yellow('\n[interrupted]\n'))
      interrupts = 0
      return
    }
    interrupts++
    if (interrupts >= 2) {
      write('\n')
      rl.close()
      process.exit(0)
    }
    write(color.gray('\n(press Ctrl+C again to exit)\n'))
    prompt()
  })

  // Screen 09 of the design: no bars, no viewport — one identity line, then the
  // same glyph vocabulary as the full-screen UI.
  function banner(): void {
    write(
      `${c.accent('bytecode')} ${c.faint(
        `${session.modelRef} · ${session.mode} · ${session.assets.skills.length} skills · /help`,
      )}\n\n`,
    )
  }

  function prompt(): void {
    rl.setPrompt(`${c.accent(g.prompt)} `)
    rl.prompt()
  }

  banner()
  prompt()

  for await (const raw of rl) {
    const line = raw.trim()
    if (!line) {
      prompt()
      continue
    }
    interrupts = 0

    if (line.startsWith('/')) {
      const handled = await handleCommand(session, line, write, rl)
      if (handled === 'exit') break
      if (handled === 'handled') {
        prompt()
        continue
      }
    }

    const text = line.startsWith('/') ? await expandCommand(session, line) : line
    if (text === null) {
      prompt()
      continue
    }

    streaming = true
    rl.pause()
    try {
      await runTurn(session, text)
    } catch (err) {
      endLine()
      write(`${color.red(symbols.fail)} ${color.red(String(err))}\n`)
    }
    streaming = false
    // The design's --simple screen has no rulers: a blank line separates turns.
    write('\n')
    rl.resume()
    prompt()
  }

  rl.close()
  await session.transcript.flush()
}

function askPermission(
  rl: readline.Interface,
  session: Session,
  req: PermissionRequest,
): Promise<boolean> {
  return new Promise(resolve => {
    const subject = req.subject ? `\n  ${color.gray(req.subject)}` : ''
    process.stdout.write(
      `\n${color.yellow('permission')} ${color.bold(req.tool)} ${req.summary}${subject}\n` +
        color.gray('  [y] allow once  [a] allow this tool for the session  [n] deny\n'),
    )
    rl.resume()
    rl.question(`${color.yellow('?')} `, answer => {
      const a = answer.trim().toLowerCase()
      if (a === 'a') {
        session.config.permissions ??= {}
        session.config.permissions.allow ??= []
        session.config.permissions.allow.push(req.tool)
        resolve(true)
        return
      }
      resolve(a === 'y' || a === 'yes' || a === '')
    })
  })
}

type CommandResult = 'handled' | 'passthrough' | 'exit'

async function handleCommand(
  session: Session,
  line: string,
  write: (s: string) => void,
  rl: readline.Interface,
): Promise<CommandResult> {
  const [name, ...rest] = line.slice(1).split(/\s+/)
  const arg = rest.join(' ')

  switch (name) {
    case 'exit':
    case 'quit':
      return 'exit'

    case 'help':
      write(
        [
          `${color.bold('/help')}            this list`,
          `${color.bold('/model')} [ref]     show or switch model (provider/model)`,
          `${color.bold('/models')}          list configured models`,
          `${color.bold('/connect')} [prov]  add an LLM provider (models.dev catalog)`,
          `${color.bold('/disconnect')}      remove a stored credential`,
          `${color.bold('/auth')}            list connected providers`,
          `${color.bold('/mode')} [name]     permission mode: ${PERMISSION_MODES.join(', ')}`,
          `${color.bold('/skills')}          list loaded skills`,
          `${color.bold('/agents')}          list loaded agents`,
          `${color.bold('/commands')}        list slash commands from disk`,
          `${color.bold('/tools')}           list active and deferred tools`,
          `${color.bold('/mcp')}             MCP server status`,
          `${color.bold('/reload')}          re-read instructions, skills, agents, commands`,
          `${color.bold('/context')}         estimated context usage`,
          `${color.bold('/context-all')}     full breakdown: setup, tools, mcp, skills`,
          `${color.bold('/leadtime')}        time, tools and tokens for the last turn`,
          `${color.bold('/sessions')}        list saved sessions for this directory`,
          `${color.bold('/resume')} #id      reopen a saved session`,
          `${color.bold('/compact')} [foco]  summarise history now, keeping recent turns`,
          `${color.bold('/clear')}           reset conversation context`,
          `${color.bold('/transcript')}      path of the session transcript`,
          `${color.bold('/exit')}            quit`,
          '',
          color.gray('Any other /name runs the matching command file from disk.'),
        ].join('\n') + '\n',
      )
      return 'handled'

    case 'model':
      if (!arg) {
        write(`${session.modelRef}\n`)
        return 'handled'
      }
      try {
        session.setModel(arg)
        session.resolveModel()
        write(color.green(`model → ${arg}\n`))
      } catch (err) {
        write(color.red(`${String(err)}\n`))
      }
      return 'handled'

    case 'models':
      write(listModels(session.config).map(m => `  ${m}`).join('\n') + '\n')
      return 'handled'

    case 'connect': {
      const io = ioFromReadline(rl)
      const result = await runConnect(io, { provider: arg || undefined })
      if (result) {
        // Make the new provider usable without restarting.
        session.config.provider = (await withConnectedProviders(session.config)).provider
        write(color.green(`connected ${result.providerId}\n`))
      }
      return 'handled'
    }

    case 'disconnect':
      await runDisconnect(ioFromReadline(rl), arg || undefined)
      return 'handled'

    case 'connections':
    case 'auth':
      await listConnections(ioFromReadline(rl))
      return 'handled'

    case 'mode': {
      if (!arg) {
        session.mode = nextMode(session.mode)
      } else if ((PERMISSION_MODES as string[]).includes(arg)) {
        session.mode = arg as PermissionMode
      } else {
        write(color.red(`unknown mode "${arg}"\n`))
        return 'handled'
      }
      write(color.green(`mode → ${session.mode}\n`))
      return 'handled'
    }

    case 'skills':
      write(
        session.assets.skills
          .map(s => `  ${color.bold(s.name)} ${color.gray(s.description.slice(0, 90))}`)
          .join('\n') + '\n',
      )
      return 'handled'

    case 'agents':
      write(
        session.assets.agents
          .map(a => `  ${color.bold(a.name)} ${color.gray(a.description.slice(0, 90))}`)
          .join('\n') + '\n',
      )
      return 'handled'

    case 'commands':
      write(session.assets.commands.map(cmd => `  /${cmd.name}`).join('\n') + '\n')
      return 'handled'

    case 'tools': {
      const active = session.registry.active().map(t => t.name)
      const deferred = session.registry.deferredNames()
      write(`  active:   ${active.join(', ')}\n`)
      write(`  deferred: ${deferred.join(', ') || '(none)'}\n`)
      return 'handled'
    }

    case 'mcp': {
      const servers = session.mcp.status()
      if (servers.length === 0) {
        write(color.gray('  no MCP servers configured\n'))
        return 'handled'
      }
      for (const s of servers) {
        if (!s.connected) {
          write(`  ${color.red(s.name)} ${color.gray(s.error ?? 'failed')}\n`)
          continue
        }
        write(`  ${color.green(s.name)} ${color.gray(`${s.toolCount} tool(s)`)}\n`)
      }
      return 'handled'
    }

    case 'reload':
      await session.reloadAssets()
      session.bootstrapped = false
      write(color.green('assets reloaded; context blocks will be re-sent\n'))
      return 'handled'

    case 'clear':
      session.messages = []
      session.bootstrapped = false
      session.tokenBaseline = undefined
      session.compactionSuspended = false
      write(color.green('context cleared\n'))
      return 'handled'

    case 'context': {
      const used = contextTokens(session)
      const limit = contextLimit(session)
      const pct = limit ? ` (${Math.round((used / limit) * 100)}% of ${limit})` : ''
      write(`  ~${used} tokens${pct} across ${session.messages.length} messages\n`)
      return 'handled'
    }

    case 'context-all':
      write(`${formatContextReport(session)}\n`)
      return 'handled'

    case 'sessions': {
      const all = await listSessions(session.config, session.cwd)
      if (all.length === 0) {
        write(color.gray('  nenhuma sessão salva neste projeto\n'))
        return 'handled'
      }
      for (const s of all) {
        write(
          `  ${color.bold(`#${s.short}`)} ${color.gray(formatWhen(s.updated).padEnd(12))} ` +
            `${color.gray(`${s.turns}t`.padEnd(5))} ${s.title}\n`,
        )
      }
      return 'handled'
    }

    case 'resume': {
      if (!arg) {
        write(color.gray('  informe o id: /resume #abc12345 (veja /sessions)\n'))
        return 'handled'
      }
      let state
      try {
        state = await loadSession(session.config, session.cwd, arg.replace(/^#/, ''))
      } catch (err) {
        write(color.red(`${String(err)}\n`))
        return 'handled'
      }
      if (!state) {
        write(color.red(`sessão "${arg}" não encontrada neste projeto\n`))
        return 'handled'
      }
      session.resumeFrom(state)
      write(
        color.green(
          `retomada #${state.id.slice(0, 8)} — ${state.messages.length} mensagens, modelo ${session.modelRef}\n`,
        ),
      )
      write(color.gray(`  o modo de permissão continua ${session.mode}\n`))
      return 'handled'
    }

    case 'leadtime': {
      const stats = session.lastTurn
      if (!stats) {
        write(color.gray('  nenhum turno concluído ainda\n'))
        return 'handled'
      }
      write(`${formatLeadtime(session, stats)}\n`)
      return 'handled'
    }

    case 'compact': {
      write(color.gray('compacting...\n'))
      const result = await compact(session, { instructions: arg, trigger: 'manual' })
      write(
        result.compacted
          ? color.green(`compacted: ~${result.before} -> ~${result.after} tokens\n`)
          : color.yellow(`not compacted: ${result.reason}\n`),
      )
      return 'handled'
    }

    case 'transcript':
      write(`${session.transcript.file}\n`)
      return 'handled'

    default:
      return 'passthrough'
  }
}

/** Turns `/name args` into the command file's body, mirroring Claude Code. */
async function expandCommand(session: Session, line: string): Promise<string | null> {
  const [name, ...rest] = line.slice(1).split(/\s+/)
  const args = rest.join(' ')
  const command = session.assets.commands.find(cmd => cmd.name === name)
  if (!command) {
    process.stdout.write(color.red(`unknown command /${name} — try /help\n`))
    return null
  }
  const body = expandCommandBody(command.body, args)
  return [
    `<command-name>/${name}</command-name>`,
    args ? `<command-args>${args}</command-args>` : '',
    body,
  ]
    .filter(Boolean)
    .join('\n')
}
