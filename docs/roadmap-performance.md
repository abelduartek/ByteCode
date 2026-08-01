# O que falta, o que está lento e o que atrapalha

> Levantamento de 2026-07-31, sobre a árvore em `C:\Repositories\harness` com a suíte verde e
> `tsc --noEmit` limpo. Todo número aqui foi medido nesta máquina; o que não foi medido está
> marcado como tal. P1, P2, P3, P4, Q1, Q2 e Q3 já foram implementados nesta data — a suíte fechou em
> **1134 asserções, 18 suítes**.

## Resumo

O harness já tem paridade funcional com o Claude Code no núcleo do loop (ver
`claude-code-vs-bytecode.md`). O que separava ele de "melhor que os outros" não era funcionalidade
faltando — eram quatro coisas concretas: **subagents que rodavam em fila**, **cache de prompt que não
ligava no provider realmente usado**, **um `Grep` que bufferizava 6 MB para devolver 27 KB** e a
**ausência de rede de segurança** (guarda de escrita, desfazer) que só doía em sessão longa.

Os onze itens deste levantamento foram implementados em 2026-07-31 (P1, P2, P3, P4, Q1, Q2, Q3, U1,
U2, Q4a, Q4b); `WebSearch` foi fechada como "não vale, com o número". Sobram do levantamento antigo
apenas U3 (tasks com dependência e persistência) e U4 (a colisão de `ctrl+g`), que são decisões, não
implementações pendentes.

---

## 1. Performance

### ~~P1 — Subagents rodam em série~~ — FEITO em 2026-07-31

Resolvido com grupos de concorrência (`parallelGroup: 'agent'`), teto em `subagentConcurrency`
(padrão `min(8, cpus−2)`) e uma **fila de permissão** na TUI — sem ela, dois subagentes perguntando
ao mesmo tempo faziam o segundo sobrescrever o modal do primeiro e travar aquele subagente para
sempre. Descrição do problema original abaixo, mantida como registro.

`agentTool` em `src/tools/meta.ts:131` não declara `parallelSafe`. `executeCalls`
(`src/core/loop.ts:563`) só executa em paralelo runs **adjacentes** de tools marcadas como seguras,
então quatro chamadas `Agent` emitidas no mesmo step viram quatro execuções sequenciais.

O resto do sistema já está pronto para a concorrência:

- a UI guarda agents num `Map` por id (`src/tui/fullscreen.ts:1847`), não numa variável única;
- o comentário de `agentRuns` (`src/tools/meta.ts:8`) existe justamente para "distinguir runs
  concorrentes do mesmo agente";
- `Session.record` (`src/core/session.ts:198`) soma métricas subindo a árvore, sem estado
  compartilhado mutável;
- `changes.ts` já registra **quem** escreveu cada arquivo (`by: string[]`).

Só o loop serializa. Um fan-out de 4 agents de 30 s custa 120 s hoje e custaria 30 s.

**Risco real**: dois subagents escrevendo o mesmo arquivo. Mitigação: teto de concorrência (a mesma
fórmula que o `Workflow` já usa em `src/core/workflow.ts:342` — `min(8, cpus-2)`) e não estender a
paralelização ao `Workflow` tool, que já tem limiter próprio.

### ~~P2 — Prompt caching é no-op no provider que a config usa~~ — FEITO em 2026-07-31

A política ganhou **estilo**: `sdk` (marcador via `providerOptions`, só `@ai-sdk/anthropic`) e `wire`
(marcador escrito no corpo do request por `src/provider/promptcache.ts`). Continua opt-in fora do
Anthropic. Se o proxy à frente não repassar o campo, `/leadtime` mostra `cache lido` zerado — é o
número que diz se rendeu. Diagnóstico original abaixo.

`hx.jsonc:3` define `"model": "selbetti/sonnet"`, cujo `npm` é `@ai-sdk/openai-compatible`.

`cachePolicy` (`src/core/cache.ts:30`) só liga sozinho para `@ai-sdk/anthropic`. Até aí é o desenho.
O problema é o caminho forçado: mesmo com `"cache": { "enabled": true }`, o provider
openai-compatible lê provider options **só** sob a chave `openaiCompatible` —

```js
// node_modules/@ai-sdk/openai-compatible/dist/index.js:113
function getOpenAIMetadata(message) {
  return message?.providerOptions?.openaiCompatible ?? {}
}
```

— e `providerOptions.anthropic.cacheControl` é descartado em silêncio. A linha 23 de
`docs/claude-code-vs-bytecode.md` ("forçáveis com `cache.enabled`") está **errada** para esse
caminho: liga a flag, muda o formato do request e não cacheia nada.

O conserto existe e é pequeno. O mesmo arquivo do provider espalha a metadata no objeto da mensagem
e em cada bloco de texto:

```js
// linha 133
messages.push({ role: "system", content, ...metadata })
// linha 152
return { type: "text", text: part.text, ...partMetadata }
```

Então emitir

```ts
providerOptions: { openaiCompatible: { cache_control: { type: 'ephemeral' } } }
```

produz `{"role":"system","content":"…","cache_control":{"type":"ephemeral"}}` na rede — exatamente o
formato que LiteLLM e OpenRouter repassam para a Anthropic.

**Impacto**: input cacheado é cobrado a ~10% e o time-to-first-token cai. Numa sessão de 100k+ de
contexto, essa é a maior alavanca isolada de custo e de latência. Requer o breakpoint duplo que
`cache.ts` já implementa — só a chave do provider muda.

### ~~P3 — `Grep` bufferiza a saída inteira do ripgrep~~ — FEITO em 2026-07-31

Corte global contando linhas conforme chegam, `child.kill()` no limite e truncagem de linha em 250
caracteres. No caminho real da tool: 298 ms → **128 ms**. Descrição original abaixo.

`src/tools/fs.ts:454`: o `-m` do ripgrep é **por arquivo**, não global. Com `head_limit: 200` num
diretório de 1.200 arquivos, o rg pode emitir 240.000 linhas; tudo isso é concatenado em `out` e só
depois cortado em JS, no `close`.

Medido em `node_modules` deste repo, padrão `function`, `head_limit: 200`, mediana de 5 execuções:

| variante | mediana | bufferizado | devolvido |
|---|---|---|---|
| atual (`out += String(d)`, corta no fim) | **422 ms** | **6,18 MB** | 27 KB |
| corte global + `child.kill()` na 200ª linha | **140 ms** | **337 KB** | idem |

3× mais rápido e 18× menos memória, e a diferença cresce com o tamanho do repositório.

Achado colateral: 200 linhas de JS minificado dão 336 KB de texto. Isso passa pelo
`MAX_TOOL_OUTPUT_CHARS` (30.000, `src/core/loop.ts:23`) e come contexto sem informar nada. Truncar
cada linha em ~250 caracteres resolve.

### ~~P4 — MCP: quase tudo serializa~~ — FEITO em 2026-07-31

`"parallelSafe": true` ou uma lista de nomes no bloco do servidor. O default conservador continua, e
o que o servidor declara sozinho vale mesmo fora da lista. Diagnóstico original abaixo.

`src/mcp/client.ts:333` marca `parallelSafe: readOnly`, e `readOnly` exige
`annotations.readOnlyHint === true`. Essa anotação é **opcional** no protocolo e raramente
preenchida pelos servidores. Na prática, todo `list_*`/`get_*` de MCP roda um de cada vez, mesmo
quando o modelo os emite juntos.

O default conservador está certo — não dá para presumir que uma tool desconhecida é segura. O que
falta é a saída: `"mcp": { "<servidor>": { "parallelSafe": true } }` na config, para o usuário
declarar o que ele sabe sobre o servidor que ele mesmo configurou.

### P5 — Medido e descartado

Para não voltar: o `Promise.all` de 1187 `fs.stat` do `Glob` custa **14 ms**. Os 147 ms de
`Glob src/**/*.ts` são spawn do ripgrep, não o stat. Não há nada a otimizar ali.

---

## 2. Qualidade e correção

### ~~Q1 — `Edit` sem `Read` prévio, e sem detectar alteração externa~~ — FEITO em 2026-07-31

`src/core/filestate.ts`: `Write` sobre arquivo não lido e qualquer escrita sobre arquivo que mudou
no disco desde a leitura são recusados. `Edit` em arquivo não lido continua permitido — ele já falha
alto no `old_string not found`. Desliga com `"fileGuard": false`. Diagnóstico original abaixo.

Não existe rastro de leitura em lugar nenhum (`readFiles`, `lastRead`, `mtime` não aparecem em
`src/tools/fs.ts` fora do ordenador do `Glob`). Duas consequências:

1. o modelo pode editar um arquivo que nunca leu, com `old_string` inventado — falha barulhenta, ok;
2. numa sessão longa com o VS Code aberto do lado, `Edit` **sobrescreve silenciosamente** a alteração
   que a pessoa acabou de salvar. Isso não falha: grava.

O Claude Code exige `Read` antes de `Edit` e revalida o mtime. Custo aqui: um `WeakMap` por sessão
com `{ file → { mtime, size } }`, preenchido no `Read` e conferido no `Edit`/`Write`.

### ~~Q2 — `/rewind` está a um passo~~ — FEITO em 2026-07-31

`revertChange` em `changes.ts`, tecla `r` na tela do `ctrl+g`, `/rewind` como atalho para a mesma
tela. Confirma antes, recusa se o arquivo mudou no disco. Diagnóstico original abaixo.

`src/core/changes.ts` já guarda o `before` de cada arquivo — o conteúdo **anterior à primeira
escrita da sessão**, não à última. Restaurar é escrever esse `before` de volta. Hoje esse dado só
alimenta a tela de leitura do `ctrl+g`.

Para desenvolvimento demorado, "desfaz tudo o que o agente fez em `src/x.ts`" é a rede de segurança
que falta, e ela já está em memória.

### ~~Q3 — `MAX_STEPS = 64` termina o turno com erro~~ — FEITO em 2026-07-31

Aviso ao modelo em 75% do teto, e no teto o turno para com notice em vez de erro — histórico
intacto, `continue` segue. Teto em `maxSteps`. Diagnóstico original abaixo.

`src/core/loop.ts:21` e `:201`. Um refactor longo bate no teto e o turno acaba com
`stopped after 64 steps`, sem opção de continuar de onde parou. Melhor: avisar em ~48 e, no teto,
encerrar de forma continuável em vez de como erro.

### Q4 — Tools ausentes que pesam no dia a dia

- **`WebFetch` / `WebSearch`**: sem elas o agente só sabe o que está no repositório. Ler a doc de uma
  biblioteca é operação diária.
- **Execução em background** (`run_in_background` + leitura do output): já é o gap #1 conhecido, e é
  o que permite rodar a suíte enquanto a conversa continua — exatamente o caso "desenvolvimento
  demorado".

---

## 3. Usabilidade: subagents e tasks

### ~~U1 — Subagent devolve prosa, não dado~~ — FEITO em 2026-07-31

`agentTool` retornava `collected`, o texto concatenado do filho. Agora aceita `schema` e devolve o
objeto.

**Correção de uma afirmação errada desta seção**: dizia que o `Workflow` "força uma resposta JSON
validada". Não força e não valida. O mecanismo eram duas funções de 15 linhas
(`src/core/workflow.ts:263-277`, antes da extração): um sufixo de prompt e um `JSON.parse` do
primeiro `{` do texto. Qualquer JSON parseável passava, violando o schema ou não. Um validador
recursivo foi considerado e **cortado**: no único call site existente ele não mudaria comportamento
nenhum, porque a regra de compatibilidade teria de deixar o objeto passar de qualquer jeito. O que
faltava de verdade era a segunda chance quando o parse estoura — que é o modo de falha real: o
modelo escreve "Claro! Vou explicar antes" e só depois o JSON.

### ~~U2 — Não dá para continuar um subagent~~ — FEITO em 2026-07-31

`AgentResume` continua um subagente guardado; teto de 4, descarte do mais antigo, `busy` por
entrada. Diagnóstico original abaixo.

O child morria no fim do `execute`. Uma segunda pergunta ao mesmo investigador refaz toda a
exploração. Guardar as sessões-filho vivas por id (com teto e descarte por idade) permitiria um
`SendMessage` equivalente ao do Claude Code — em sessão demorada, isso é a diferença entre pagar a
exploração uma vez ou cinco.

### U3 — Tasks são só uma lista volátil

`TodoWrite` (`src/tools/meta.ts:259`) guarda por owner num `WeakMap` da sessão raiz. Não há
dependência entre itens (`blockedBy`), não há persistência entre sessões, e o `/clear` zera. Para
trabalho de vários dias, task com dependência e estado no transcript vale mais que a lista atual.

### U4 — `ctrl+g` colide com o Claude Code

`ctrl+g` é `chat:externalEditor` lá. Já registrado em `PENDENCIAS.md`; a decisão de remapear é do
usuário.

---

## 4. Ordem sugerida

Por impacto medido dividido por esforço:

| # | item | por que primeiro | risco |
|---|---|---|---|
| ~~1~~ | ~~P3 — corte global no `Grep`~~ | **feito** — 298 ms → 128 ms | — |
| ~~2~~ | ~~P1 — subagents em paralelo~~ | **feito** — grupos + teto + fila de permissão | — |
| ~~3~~ | ~~P2 — caching no openai-compatible~~ | **feito** — estilo `wire`, marcador no corpo | — |
| ~~4~~ | ~~Q1 — guarda de `Read`/mtime~~ | **feito** — `filestate.ts` | — |
| ~~5~~ | ~~Q2 — `/rewind` a partir de `changes.ts`~~ | **feito** — tecla `r`, com confirmação | — |
| ~~6~~ | ~~P4 — `parallelSafe` de MCP por config~~ | **feito** — por servidor ou por lista de nomes | — |
| ~~7~~ | ~~Q3 — orçamento de steps continuável~~ | **feito** — aviso em 75%, notice no teto | — |
| ~~8~~ | ~~U1/U2 — `schema` e continuação de subagent~~ | **feito** — `structured.ts` + `AgentResume` | — |
| ~~9~~ | ~~Q4a — `WebFetch`~~ | **feito** — guarda anti-SSRF dentro da tool, redirect revalidado | — |
| ~~10~~ | ~~Q4b — execução em background~~ | **feito** — sem colheita no loop; polling por `BashOutput` | — |
| — | ~~Q4a — `WebSearch`~~ | **não vale** — 0 linhas via MCP contra ~60 e um adaptador, mesma chave | — |

Os itens 1 a 3 são os que mudam a percepção de velocidade. Os itens 4 e 5 são os que fazem uma
sessão de oito horas ser segura.
