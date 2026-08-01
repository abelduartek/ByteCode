// Compatibility surface over the design tokens, so the line-oriented UI keeps
// its colour-name call sites while rendering with the same palette and glyphs
// as the full-screen one.

import { c, g, strong } from './theme.ts'

export const color = {
  bold: strong,
  dim: c.dim,
  italic: (s: string) => s,
  red: c.danger,
  green: c.ok,
  yellow: c.warn,
  blue: c.info,
  magenta: c.meta,
  cyan: c.info,
  gray: c.faint,
}

export const symbols = {
  prompt: g.prompt,
  tool: g.dotOn,
  ok: g.ok,
  fail: g.fail,
  note: g.warn,
  agent: g.dotOn,
}

export function hr(width = process.stdout.columns ?? 80): string {
  return c.rule(g.boxH.repeat(Math.max(10, Math.min(width, 100))))
}
