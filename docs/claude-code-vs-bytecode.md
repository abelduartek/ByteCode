# ByteCode vs. Claude Code — de→para e anatomia da chamada

> Baseado em `harness/README.md`, `src/core/{context,loop,session,hooks,compaction}.ts`,
> `src/provider/registry.ts`, `hx.jsonc`, `PENDENCIAS.md` e no doc de engenharia reversa
> `claude-config/docs/harness-claude-code.md`. Gerado em 2026-07-31.

## 1. De → Para

| Peça | Claude Code faz | ByteCode hoje | Gap |
|---|---|---|---|
| System prompt | Bloco fixo, estável por sessão → prefixo cacheável (§3.1 do doc) | `buildSystemPrompt()` em `context.ts:21` — igualmente estático, cwd/git/model/effort/permission mode | **Paridade** — só falta `cache_control` no fim do system (ver #4) |
| CLAUDE.md/skills/agents | Injetados como `<system-reminder>` na 1ª mensagem `user`, **não** no system | `bootstrapBlocks()` em `context.ts:138` faz exatamente isso: `instructionsBlock`, `agentsBlock`, `skillsBlock` como `<system-reminder>` | **Paridade** |
| Deferred tools | Só nome vai ao prompt; `ToolSearch("select:A,B")` carrega schema sob demanda | `ToolRegistry.deferredNames()` (`tools.ts:78`) + bloco `deferredToolsBlock()` — mesmo mecanismo | **Paridade** |
| Skills (progressive disclosure) | Só `name`+`description`; corpo carrega ao chamar `Skill(nome)` | `skillsBlock()` — mesmo texto/formato | **Paridade** |
| Roster de agents | `name`+`description`+`tools` no prompt, subagent roda em loop próprio | `agentsBlock()` + `Agent` tool — igual | **Paridade** |
| Hooks | 30 eventos, protocolo stdin JSON / exit 0-2 / `hookSpecificOutput` completo (permissionDecision, updatedInput, updatedToolOutput, worktreePath, sessionTitle…) | `hooks.ts` implementa **15 eventos**: os 12 anteriores mais `PermissionRequest`, `PermissionDenied` e `Notification` (implementados em 2026-07-31) | Faltam `TaskCreated/Completed`, `ConfigChange`, `CwdChanged`, `FileChanged`, `Elicitation*`, `WorktreeCreate/Remove` — todos ligados a features que o ByteCode não tem (background tasks, worktree, elicitation MCP), então não são dívida isolada |
| Permissões | `Tool(padrão)`, `deny > ask > allow`, modos incl. `auto` (classificador) | `permissions.ts` com os mesmos padrões + os mesmos modos (`default/plan/acceptEdits/bypassPermissions/dontAsk`) — **sem** modo `auto` classificador-baseado | Menor: `auto` do Claude decide sozinho por heurística; ByteCode não tem esse modo (só binário ask/allow/deny) |
| Compactação | `PreCompact`/`PostCompact`, desligável | `compaction.ts` — implementado e **medido** (tabela de perf no PENDENCIAS.md) | **Paridade**, inclusive testada |
| Transcript | JSONL em árvore (`parentUuid`, `isSidechain`, `isMeta`), replay de `thinking.signature` | `Transcript.append()` grava jsonl por sessão, com `isSidechain`/`agentId` (`loop.ts:97`, `104`) | Falta preservar `signature` de thinking para replay (não crítico p/ providers OpenAI-compat, que não emitem signature) |
| Workflows | Não documentado como feature nativa do Claude Code (é do opencode/modelado no ByteCode) | Implementado com visualizador, orçamento, aninhamento — **acima** da paridade, já com testes | **ByteCode supera** aqui |
| Provider | Só Anthropic, 1 endpoint | Camada AI SDK multi-provider, 174 providers via models.dev, `/connect` interativo | **ByteCode supera** — é o ponto explícito do design (§16 do doc) |
| MCP | stdio+HTTP, deferred, `instructions` injetado, resources | Implementado igual, **mais**: herda config do opencode/Claude Code (`inheritMcp`), stderr do processo capturado e anexado ao erro (Claude Code ignora stderr) | **ByteCode supera** em diagnosticabilidade |
| Prompt caching | TTL de 1h documentado, cache automático por ser Anthropic nativo | **Implementado** (`core/cache.ts`): dois breakpoints — fim do system e fim do request (rolante) — ligados sozinhos quando o provider é `@ai-sdk/anthropic`, forçáveis com `"cache": { "enabled": true, "ttl": "1h" }` | **Fechado** — dois estilos. `sdk` em `@ai-sdk/anthropic` (marcador via `providerOptions`); `wire` no resto, escrevendo `cache_control` no corpo do request (`provider/promptcache.ts`), porque o `@ai-sdk/openai-compatible` lê provider options só sob a chave `openaiCompatible` (`dist/index.js:113`) e descartava `providerOptions.anthropic` em silêncio — a versão anterior deste doc afirmava que `cache.enabled` bastava, e não bastava |
| Execução em background | `run_in_background`, notificação reentra no loop | **Implementado** (`core/jobs.ts`): `run_in_background`, `BashOutput` por cursor, `KillShell` com `taskkill /T` no Windows, `killAllJobs` no teardown | **Parcial de propósito** — sem a reentrada automática no loop: ela exige alguém rodando fora do turno, que só existe na TUI. O modelo consulta com `BashOutput`, que funciona também no headless, dentro de subagent e dentro de workflow |
| Tools de rede | `WebFetch`/`WebSearch` | `WebFetch` implementado (`tools/web.ts`) com `kind: 'net'`, guarda anti-SSRF resolvendo o host e redirect revalidado a cada hop. `WebSearch` fechada como "não vale": um servidor MCP de busca entrega o mesmo por 0 linhas | **Paridade no que importa** |
| Memória em arquivo (`MEMORY.md`) | Sistema de memória persistente entre sessões, frontmatter tipado | Não existe no ByteCode | Gap — não há nenhuma referência a "memory" no código |
| Slash commands (`~/.claude/commands/*.md`) | Vira `/nome`, corpo entra como mensagem envelopada, com `$ARGUMENTS`/`$1..$9`, frontmatter e namespace por subpasta | **Já rodava** — `loadCommands()` + `expandCommand()` na TUI e no headless, envelope `<command-name>`/`<command-args>` idêntico. A linha anterior desta tabela estava errada. Faltavam só os detalhes, entregues em 2026-07-31: `$1..$9`, `description`/`argument-hint` na lista, `model:` e `allowed-tools:` valendo pelo turno, e `commands/git/pr.md` → `/git:pr` | Falta a execução de `` !`comando` `` embutida no corpo (o Claude roda o shell antes de enviar) |
| Plugins/marketplaces | Empacota skills+hooks+agents+commands+MCP num pacote instalável | Não implementado (próximo passo #4) | Gap |
| OAuth para MCP remoto | — | SDK expõe `authProvider`, hoje só header estático (próximo passo #3) | Gap |

## 2. Priorização — status em 2026-07-31

Os três primeiros itens foram implementados nesta data; a suíte `test/parity.test.ts` (46 asserções)
cobre os três.

1. ~~**Prompt caching**~~ — feito. `core/cache.ts`: o system vira uma `SystemModelMessage` (única
   forma que carrega `providerOptions`; um `role: 'system'` dentro de `messages` é **rejeitado** pelo
   AI SDK v7 e derruba o turno inteiro) e a última mensagem do request leva o breakpoint rolante — o
   cache que este step escreve é o prefixo que o próximo lê. Dois dos quatro breakpoints da Anthropic,
   nunca mais: marcar cada mensagem escreveria quatro caches por step para ler um.
2. ~~**Slash commands de usuário**~~ — a linha da tabela estava errada, já funcionavam. O que faltava
   de verdade (`$1..$9`, frontmatter útil, namespace por subpasta) foi entregue. Achado do caminho:
   `registerTools()` só **somava** tools, então `allowed-tools` numa sessão já populada não restringia
   nada — agora a função é declarativa e remove o que ficou de fora.
3. ~~**Hooks de permissão**~~ — `PermissionRequest` (pode responder pelo usuário com
   `permissionDecision`), `Notification` (dispara só quando o turno vai mesmo parar esperando gente) e
   `PermissionDenied` (com `source: policy | hook | user`, os três caminhos de recusa).
4. ~~**Background execution**~~ — feito. `core/jobs.ts`, sem o scheduler que reentra no loop: essa
   reentrada exige alguém rodando fora do turno, e esse alguém só existe na TUI. O modelo consulta
   com `BashOutput`, que funciona também no headless, dentro de subagent e dentro de workflow.
5. **Memória em arquivo** — feature nova, maior esforço; só vale a pena investir se de fato o
   `MEMORY.md` for usado no dia a dia. **Gap real restante**, junto com plugins/marketplaces, OAuth
   para MCP remoto e o `` !`comando` `` dentro de um slash command.

## 3. Exemplo completo de request/response

O ByteCode fala com o provider via `@ai-sdk/openai-compatible` (`provider/registry.ts:161`), que monta o body em `getArgs()` e faz `POST {baseURL}/chat/completions` (`openai-compatible/dist/index.js:621`). Reconstrução exata do que sairia hoje, num turno com `model: "9router/sonnet5"`, primeiro turno da sessão, pedindo para ler um arquivo.

### Request (headers)

```http
POST https://9router.iasandbox.dev/v1/chat/completions
Content-Type: application/json
Authorization: Bearer sk-router-xxxxxxxxxxxxxxxx
User-Agent: ai-sdk/openai-compatible/3.0.16
```

Headers vêm de `createOpenAICompatible()` — `Authorization: Bearer ${apiKey}` + `provider.options.headers` mesclado com `model.headers` (`registry.ts:178-180`).

### Request (body)

```jsonc
{
  "model": "cc/claude-sonnet-5",
  "stream": true,
  "max_tokens": 116384,
  "messages": [
    {
      "role": "system",
      "content": "You are ByteCode (bytecode), a terminal coding agent operating in the user's working directory.\n\n# Harness\n- Your output is rendered as GitHub-flavored markdown in a terminal.\n- Tool calls pass through a permission engine; a denied call means the user declined it — adjust, do not retry the same call verbatim.\n- Hooks may intercept, rewrite, or block tool calls. Treat hook output as user-authored feedback.\n- Prefer the dedicated file tools (Read/Edit/Write/Glob/Grep) over shelling out when one fits.\n- Independent tool calls may be emitted together in one turn; they run in parallel.\n- Tools listed as deferred are advertised by name only. Call ToolSearch to load their schemas before using them.\n\n# Working agreement\n- Act when you have enough information. Do not re-derive facts already established, and do not narrate options you will not pursue.\n- Deliver the requested scope. Do not quietly narrow, widen, or transform it. State assumptions instead of inventing requirements.\n- Confirm before irreversible or outward-facing actions unless already authorised.\n- Report outcomes faithfully: if a command failed, say so and show the output.\n\n# Environment\n- Working directory: C:\\Repositories\\harness\n- Git repository: no\n- Platform: win32\n- Shell: powershell\n- Model: 9router/sonnet5\n- Permission mode: bypassPermissions"
    },
    {
      "role": "user",
      "content": "<system-reminder>\n# Project instructions\n\nThese instructions come from the user and the repository. They override default behaviour and you must follow them.\n\nContents of C:\\Users\\abel.duarte\\.claude\\CLAUDE.md:\n\n...\n</system-reminder>\n\n<system-reminder>\nAvailable agent types for the Agent tool. Each runs in its own context with its own tool set;\nits final text is the return value. Launch independent agents in a single turn so they run concurrently.\n\n- backend-architect: ...\n</system-reminder>\n\n<system-reminder>\nThe following skills are available via the Skill tool. Only the name and description are loaded;\ncalling Skill(name) loads the full instructions. Invoke a skill when the task matches its description,\nor when the user types /<name>.\n\n- branch-new: ...\n</system-reminder>\n\n<system-reminder>\nThe following tools are deferred: their schemas are NOT loaded, so calling them directly fails.\nUse ToolSearch with query \"select:<name>[,<name>...]\" to load them first.\n\nmcp__azure_devops__core_list_projects, ...\n</system-reminder>\n\n<system-reminder>\n# currentDate\n2026-07-31\n\n# scratchpad\nUse C:\\Users\\...\\Temp\\bytecode\\<uuid> for temporary files instead of the system temp directory.\n</system-reminder>\n\nleia o arquivo README.md"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "Read",
        "description": "Read a file from the filesystem. Returns numbered lines. Use offset/limit for large files. Always read a file before editing it.",
        "parameters": {
          "type": "object",
          "properties": {
            "file_path": { "type": "string", "description": "Absolute or cwd-relative path" },
            "offset": { "type": "number", "description": "1-indexed first line to read" },
            "limit": { "type": "number", "description": "Number of lines to read" }
          },
          "required": ["file_path"],
          "additionalProperties": false
        }
      }
    },
    {
      "type": "function",
      "function": {
        "name": "Bash",
        "description": "Run a shell command...",
        "parameters": { "type": "object", "properties": { "command": { "type": "string" } }, "required": ["command"] }
      }
    }
    // ... demais tools ativas (não-deferred) de session.registry.active()
  ],
  "tool_choice": "auto"
}
```

Pontos que o código realmente injeta (não é suposição):

- `system` é **um bloco string único** (`streamText({ system, ... })`), montado por `buildSystemPrompt()`. Com cache ligado ele vira `[{ role: 'system', content, providerOptions: { anthropic: { cacheControl: { type: 'ephemeral' } } } }]` e a última mensagem do request ganha o mesmo marcador; no provider Anthropic isso vira `cache_control` no último bloco de conteúdo de cada uma.
- Os `<system-reminder>` **não vão no system**, vão concatenados no `content` da 1ª mensagem `user` (`loop.ts:75-93`: `blocks.push(...bootstrapBlocks(...))` seguido de `[...blocks, userText].join('\n\n')`).
- `tools[].function.parameters` = exatamente o `inputSchema` (JSON Schema) de cada `ToolDefinition` (`tools.ts:32`), repassado cru via `jsonSchema()` (`loop.ts:542`).
- `max_tokens` vem de `session.maxOutputTokens`, que resolve do `limit.output` configurado no `hx.jsonc` (116384 para `9router/sonnet5`).
- `stream: true` é forçado pelo AI SDK porque `streamText` é usado (não `generateText`) — o `PENDENCIAS.md` registra que isso foi corrigido justamente porque o 9router "responde corpo não-JSON sem `stream: true`".

### Turno seguinte (com `tool_result`)

Depois que o modelo devolve um `tool_call`, o ByteCode executa a tool e reenvia:

```jsonc
{
  "model": "cc/claude-sonnet-5",
  "stream": true,
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "...prompt inicial + reminders..." },
    {
      "role": "assistant",
      "content": null,
      "tool_calls": [
        { "id": "toolu_01abc", "type": "function", "function": { "name": "Read", "arguments": "{\"file_path\":\"README.md\"}" } }
      ]
    },
    {
      "role": "tool",
      "tool_call_id": "toolu_01abc",
      "content": "1\t# ByteCode...\n2\t...\n[conteúdo lido, truncado em 30000 chars por loop.ts:22]"
    }
  ],
  "tools": [ /* mesmo catálogo */ ]
}
```

Mapeamento `role: 'tool'` com `content[].type: 'tool-result'` → `convertToOpenAICompatibleChatMessages` em `openai-compatible/dist/index.js:290-298`, formato exato de `executeCalls`/`session.messages.push` em `loop.ts:163-173`.

### Response (streaming, SSE)

```
data: {"choices":[{"delta":{"role":"assistant"},"index":0}]}

data: {"choices":[{"delta":{"content":"<think>"},"index":0}]}

data: {"choices":[{"delta":{"content":"vou ler o arquivo pedido"},"index":0}]}

data: {"choices":[{"delta":{"content":"</think>"},"index":0}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"toolu_01abc","type":"function","function":{"name":"Read","arguments":""}}]},"index":0}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"file_path\""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":\"README.md\"}"}}]}}]}

data: {"choices":[{"finish_reason":"tool_calls","index":0}],"usage":{"prompt_tokens":4213,"completion_tokens":41}}

data: [DONE]
```

O trecho `<think>...</think>` no `content` é o quirk documentado do 9router (README linha 190-194 e 1356): `ThinkFilter` em `src/core/reasoning.ts` intercepta esses deltas no `text-delta` do `fullStream` (`loop.ts:375-385`) e os desvia para `session.emit({type:'reasoning'})` — nunca chegam à resposta final nem ao transcript como texto.

O `usage` vem no evento final e é lido em `loop.ts:448-470`, com fallback de forma (`inputTokenDetails.cacheReadTokens` vs. `cachedInputTokens`) documentado no `PENDENCIAS.md` como bug já corrigido.

---

## Resumo

Nos pontos centrais do loop agêntico — system prompt estático, `<system-reminder>` fora do system, deferred tools + `ToolSearch`, skills com progressive disclosure, permissões `deny>ask>allow`, compactação, transcript em árvore — o ByteCode já é **paridade funcional** com o Claude Code, verificado no próprio código.

Depois das rodadas de 2026-07-31 sobraram como gaps reais:

1. **Memória em arquivo** (`MEMORY.md` com frontmatter tipado).
2. **Plugins/marketplaces** e **OAuth para MCP remoto**.
3. Detalhe de comando: `` !`comando` `` executado antes do envio.
4. Meia-paridade consciente: execução em background existe, sem a reentrada automática no loop.

Fechados nesta rodada: prompt caching, hooks de permissão (`PermissionRequest`, `PermissionDenied`,
`Notification`) e o acabamento dos slash commands de usuário — que, ao contrário do que a versão
anterior deste doc dizia, **já rodavam**.

MCP e camada de provider o ByteCode já **supera** o Claude Code por design (multi-provider, herança de config, diagnóstico de stderr).
