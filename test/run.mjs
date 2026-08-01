#!/usr/bin/env node
// Runs every suite in its own process and aggregates the result.
//
// Separate processes on purpose: several suites read `process.env` at module load
// (colour level, ASCII glyphs, HOME), patch `process.stdout.write`, or take over
// stdin in raw mode. Sharing one process would make them interfere.
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const major = Number(process.versions.node.split('.')[0])
const nodeArgs = major >= 23 ? [] : ['--experimental-strip-types']

/**
 * Suites that need a specific environment. The render suite is run three times,
 * once per degradation track, because the theme reads env at import time.
 */
const RUNS = [
  { suite: 'render.test.ts', label: 'render:256', argv: ['256'], env: { COLORTERM: 'truecolor' } },
  { suite: 'render.test.ts', label: 'render:nocolor', argv: ['nocolor'], env: { NO_COLOR: '1' } },
  { suite: 'render.test.ts', label: 'render:ascii', argv: ['ascii'], env: { BYTECODE_ASCII: '1' } },
]

const SKIP = new Set(['helpers.ts', 'run.mjs'])

function runOne({ suite, label, argv = [], env = {} }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [...nodeArgs, path.join(here, suite), ...argv], {
      cwd: path.resolve(here, '..'),
      env: {
        ...process.env,
        NO_COLOR: undefined,
        BYTECODE_ASCII: undefined,
        COLORTERM: 'truecolor',
        // Tests must never touch the real clipboard or the real state directory.
        BYTECODE_FAKE_CLIPBOARD: '1',
        // Config merges from the user directory upwards, so a suite would otherwise
        // spawn whatever MCP servers this machine has configured — slow, and the
        // report it renders changes with the machine.
        BYTECODE_NO_MCP: '1',
        ...env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let out = ''
    child.stdout.on('data', d => (out += String(d)))
    child.stderr.on('data', d => (out += String(d)))
    child.on('close', code => {
      const summary = out.match(/(\d+) passed, (\d+) failed/)
      resolve({
        label: label ?? suite.replace('.test.ts', ''),
        code,
        passed: summary ? Number(summary[1]) : 0,
        failed: summary ? Number(summary[2]) : 0,
        output: out,
        parsed: Boolean(summary),
      })
    })
  })
}

const only = process.argv.slice(2).filter(a => !a.startsWith('-'))
const verbose = process.argv.includes('--verbose')

const discovered = (await fs.readdir(here))
  .filter(f => f.endsWith('.test.ts') && !SKIP.has(f))
  .filter(f => f !== 'render.test.ts')
  .map(suite => ({ suite }))

const plan = [...discovered, ...RUNS].filter(
  r => only.length === 0 || only.some(o => (r.label ?? r.suite).includes(o)),
)

let passed = 0
let failed = 0
const broken = []

for (const run of plan) {
  const result = await runOne(run)
  passed += result.passed
  failed += result.failed

  const status = result.failed === 0 && result.code === 0 ? 'ok  ' : 'FAIL'
  process.stdout.write(
    `${status} ${result.label.padEnd(16)} ${String(result.passed).padStart(4)} passed` +
      (result.failed ? `, ${result.failed} failed` : '') +
      (result.parsed ? '' : '   (sem linha de resumo)') +
      '\n',
  )

  if (result.failed > 0 || result.code !== 0 || !result.parsed) {
    broken.push(result)
    if (verbose) process.stdout.write(result.output)
    else {
      for (const line of result.output.split('\n').filter(l => l.includes('FAIL'))) {
        process.stdout.write(`       ${line.trim()}\n`)
      }
    }
  }
}

process.stdout.write(
  `\n${passed} passed, ${failed} failed across ${plan.length} suite(s)` +
    (broken.length ? ` — ${broken.length} suite(s) com problema\n` : '\n'),
)
process.exit(broken.length === 0 ? 0 : 1)
