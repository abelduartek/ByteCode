# Workflows — o que falta para a paridade com o Claude Code

> Levantamento de 2026-08-01, sobre `main` em `C:\Repositories\ByteCode` (commit `5db3aa2`).
> O lado do Claude Code foi lido do binário instalado — `@anthropic-ai/claude-code@2.1.220`,
> `bin/claude.exe` — por extração de strings. Toda citação entre aspas neste documento é
> literal do binário. As estimativas de esforço **não foram medidas**; estão marcadas como
> estimativa.

## Resumo

O motor de workflows do ByteCode já tem o núcleo do Claude Code: script determinístico
decidindo o fluxo, cada passo um subagente com contexto próprio, `schema` transformando
resposta em objeto, journal, resume, viewer ao vivo, budget de tokens.

Em dois pontos o ByteCode é **melhor desenhado**: `parallel()`/`pipeline()` como primitivas
nomeadas (o Claude Code parece usar JavaScript cru), e resume com chave por conteúdo em vez
de por posição.

O que falta é quase todo **governança** — as travas que existem porque o Claude Code roda em
empresa, onde alguém precisa provar o que foi aprovado e limitar o que os outros gastam.
Cinco itens, nenhum exigindo refatorar `runWorkflow`.

## Tabela de paridade

| | Claude Code 2.1.220 | ByteCode `main` |
|---|---|---|
| script determinístico + agentes | sim | sim |
| `agent/phase/log/budget/schema` | sim | sim |
| `parallel()` / `pipeline()` explícitos | não | **sim** |
| sub-workflow composto | não | **sim** (1 nível) |
| resume | por posição | **por conteúdo** `(prompt, options)` |
| hash do script aprovado | sim | **não** → W1 |
| aprovação mostrando as fases | sim | **não** → W2 |
| diretriz de tamanho | sim | **não** → W3 |
| `ultracode` | sim | **não** → W4 |
| workflows embutidos | sim (`deep-research`) | **não** → W5 |
| políticas de organização | sim | não — recusado, ver "O que não fazer" |

---

## W1 — Hash do script aprovado

**Prioridade: alta. É a única lacuna de segurança do conjunto.**

O Claude Code hasheia o script no momento da aprovação e recusa retomar se o conteúdo mudou:

> `script content changed since it was approved; resume via the Workflow tool to re-approve`
>
> `adopted workflow scriptSha256 mismatch`

No ByteCode não existe — `grep -rn "sha256" src/core/workflow.ts` retorna zero. O script é
gravado em `~/.bytecode/workflows/<runId>.js` (`src/core/workflow.ts:469`) e o resume lê o
journal do run anterior (`src/core/workflow.ts:477`) sem verificar que o script atual é o
mesmo que produziu aquele journal.

Consequência concreta: um workflow aprovado como "ler e resumir arquivos" pode ser retomado
com um corpo diferente, reaproveitando os passos já pagos. A aprovação vale para uma
intenção, não para um artefato.

**Implementação**

1. Em `runWorkflow` (`src/core/workflow.ts:461`), antes de `runScript`, calcular
   `createHash('sha256').update(opts.script).digest('hex')`.
2. Gravar como primeira linha do journal: `{ type: 'begin', sha256, name }`.
3. No ramo de resume, ler o `begin` do journal anterior e comparar. Divergiu, erro claro
   nomeando o run e sugerindo rodar de novo sem `resumeFromRunId`.
4. Journal antigo sem o campo replaya normalmente — mesmo tratamento que já foi dado ao `ok`
   em `src/core/workflow.ts:668`.

**Esforço estimado:** ~20 linhas, um arquivo. **Risco: baixo** — só adiciona verificação.

**Teste:** rodar um workflow, alterar uma linha do script salvo, tentar resume, esperar erro.

---

## W2 — Aprovação mostrando as fases

**Prioridade: alta. Custo quase zero.**

O Claude Code descreve o que vai acontecer antes de pedir o "sim":

> `This dynamic workflow will spin up multiple subagents across the following phases:`

No ByteCode, `summary` devolve `workflow <nome>` (`src/tools/workflow.ts:53-60`). O usuário
aprova um `exec` sem saber quantos agentes virão nem em quantas fases.

O dado já está disponível e **já é lido sem executar o script**: `WorkflowMeta` tem
`phases?: { title, detail? }[]` (`src/core/workflow.ts:22`), e `extractMeta`
(`src/core/workflow.ts:311`) usa o parser de literal de `readLiteral`
(`src/core/workflow.ts:140`) — que existe justamente para que listar workflows não execute
código. Só falta apresentar.

**Implementação**

Alterar `summary` em `src/tools/workflow.ts` para montar, quando `meta.phases` existir:

```
workflow bytecode-full-review
Este workflow vai criar subagentes nestas fases:
  1 Review — 7 revisores, 100% dos arquivos
  2 Verify — verificação adversarial
```

O ponto de enxerto já existe no loop: `tool.summary?.(input)` em `src/core/loop.ts:900`
alimenta o `requestPermission` de `src/core/loop.ts:962`. Nada no motor de permissões muda.

**Esforço estimado:** ~15 linhas, um arquivo. **Risco: nenhum** — é apresentação.

---

## W3 — Diretriz de tamanho, e o default de `maxAgents`

**Prioridade: média. Duas mudanças pequenas e independentes.**

### W3a — Baixar `DEFAULT_MAX_AGENTS`

`src/core/workflow.ts:90` define `1000`. A ~100k tokens por agente — a ordem observada numa
rodada real de 7 agentes — é um teto que não protege de nada. Sugestão: **50**, alinhado ao
teto de `large` do Claude Code.

**Risco: baixo, mas é mudança de comportamento.** Quem tiver workflow de mais de 50 agentes
passa a precisar configurar `workflows.maxAgents`. Merece linha no CHANGELOG.

### W3b — `sizeGuideline`

O Claude Code separa duas coisas que o ByteCode hoje mistura numa só:

> `Advisory size guideline for the dynamic workflows Claude writes: "small" aims for fewer
> than 5 agents, "medium" (the default) fewer than 15, "large" fewer than 50, and
> "unrestricted" sends no guideline.`

`maxAgents` é freio de emergência — quem estoura, morre com erro. `sizeGuideline` é **sinal
de custo ao modelo**, injetado na descrição da tool para orientar quantos agentes escrever.
O ByteCode só tem o primeiro, e frouxo.

**Implementação**

1. Campo `sizeGuideline` em `workflowsConfig` (`src/config/schema.ts:139`) e no tipo
   (`src/config/types.ts:201`), enum `small` | `medium` | `large` | `unrestricted`,
   default `medium`.
2. Em `registerTools` (`src/tools/index.ts:37`), concatenar a frase correspondente ao
   `DESCRIPTION` da tool antes de registrar.

**Esforço estimado:** ~25 linhas, três arquivos. **Risco: baixo.**

---

## W4 — `ultracode`

**Prioridade: média para a parte A. A parte B fica recusada por ora.**

### W4a — O comando

> `Set effort level to ultracode (this session only): xhigh + dynamic workflow orchestration`
>
> `Enable ultracode for the session: xhigh effort plus standing dynamic-workflow orchestration.`

São dois efeitos que o ByteCode já sabe fazer separadamente: `effort` aceita `xhigh`
(`src/config/types.ts:15`) e `/workflows on` liga a tool (`src/tui/fullscreen.ts:4713`).
Falta o comando que faz os dois de uma vez, no escopo da sessão.

Copiar também as duas guardas, que existem por bom motivo:

> `Ultracode needs dynamic workflows enabled (see /config). Valid options are:`
>
> `Ultracode runs at xhigh effort, which is restricted by your organization`

A primeira importa: se `workflows.enabled` estiver desligado por config do projeto, o comando
deve **avisar**, não ligar por baixo dos panos.

**Esforço estimado:** ~15 linhas em `src/tui/fullscreen.ts`. **Risco: baixo.**

### W4b — O gatilho por palavra-chave — RECUSADO por ora

> `Enable the "ultracode" keyword trigger: including the keyword in a prompt opts that turn
> into the Workflow tool. Set to false to disable the trigger. Default: true.`

Escrever a palavra no meio de um prompt força o turno para a Workflow tool. É a feature com
maior chance de disparar sem intenção — o próprio Claude Code precisou de um setting só para
desligá-la. Ganho pequeno, superfície de irritação grande. Reabrir se W4a for usado de fato.

---

## W5 — Um workflow embutido

**Prioridade: baixa em código, alta em valor de exemplo.**

O Claude Code traz `deep-research` pronto, com as fases declaradas e o padrão adversarial
codificado:

> `Deep research harness — fan-out web searches, fetch sources, adversarially verify claims,
> synthesize a cited report.`
>
> fases: `URL-dedup, fetch top 15 sources, extract falsifiable claims` →
> `3-vote adversarial verification per claim (need 2/3 refutes to kill)` →
> `Merge semantic dupes, rank by confidence, cite sources`

Repare na assimetria: são necessários **2 de 3 votos para matar** um achado. O default é
manter — o sistema prefere falso positivo a falso negativo. Numa revisão de segurança é a
escolha certa, e é o tipo de decisão que ninguém acerta improvisando.

Hoje o ByteCode não traz nenhum workflow, então todo usuário reinventa esse padrão — mal.

**Proposta:** um só, `code-review`, em `.bytecode/workflows/code-review.js`. Fase 1 lê os
arquivos do diff; fase 2 verifica cada achado adversarialmente com regra de 2/3. Usando
`pipeline()` em vez de `parallel()` — que é exatamente onde o ByteCode tem vantagem, e o que
a descrição da tool já recomenda (`src/tools/workflow.ts:34`).

Vira exemplo executável e documentação ao mesmo tempo.

**Esforço:** arquivo novo, sem risco. O trabalho é de conteúdo, não de código.

---

## O que não fazer

### Copiar a proibição de `Math.random()` / `Date.now()`

O Claude Code proíbe:

> `Workflow scripts must be deterministic: Date.now()/Math.random()/new Date() are
> unavailable (breaks resume). Stamp results after the workflow returns, or pass timestamps
> via args.`

O motivo está no parênteses: o resume dele casa por posição, então rodar de novo tem que
produzir a mesma sequência de chamadas.

O ByteCode não tem esse problema. A chave de cache é o par `(prompt, options)` serializado, e
o comentário em `src/core/workflow.ts:471` explica a decisão:

> *"Resume matches on the exact (prompt, options) pair, never on position or call id: the
> journal is written in completion order, and with concurrent stages even the call order
> varies between runs."*

Chave por conteúdo tolera reordenação e concorrência. Adotar a proibição seria pagar o custo
de um design que não temos.

### Políticas de organização

`disableWorkflows` como managed setting, sessão travada em workflows nomeados, política de
org. Isso existe porque o Claude Code roda em empresa com admin e precisa responder a
auditoria. Sem esse contexto, é complexidade sem demanda.

### Nesting além de um nível

Já está recusado no código, com a razão certa (`src/core/workflow.ts:722`):

> *"a chain of sub-workflows is a script calling a script calling a script, and no one can
> read the resulting fan-out — nor bound its cost before approving it."*

Manter como está.

---

## Ordem sugerida

**W1 → W2 → W3 → W4a → W5.**

Os três primeiros são pequenos, independentes entre si, e juntos entregam a governança que
falta: você passa a aprovar um texto exato (W1), sabendo o que ele vai fazer (W2), com um
teto que significa alguma coisa (W3).

Tudo cabe em três arquivos — `src/core/workflow.ts`, `src/tools/workflow.ts`,
`src/config/schema.ts` — mais um arquivo novo no W5. A suíte existente cobre workflow;
validar com `node test/run.mjs workflow` e `npm run check`.

## Nota de contexto

Este levantamento nasceu de uma sessão em que o **Claude Code** revisou o repo do ByteCode
com `ultracode` ligado: 14 agentes, 2 fases, `727.8k tokens` em `7m15s` com `0/7 agents done`
e metade da frota `idle` — esperando a barreira da fase virar.

Dois números para guardar. O custo é **multiplicativo**, não aditivo: 14 agentes a ~100k
tokens é ordem de 1.4M de entrada. E o `idle` em barreira de fase é o argumento prático a
favor do `pipeline()` sobre o `parallel()` — o ByteCode já tem a primitiva certa; falta o
workflow de exemplo (W5) que a use.
