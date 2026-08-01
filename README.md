# ByteCode

Um harness de agente de código para o terminal. Ele dá a um modelo de linguagem as
ferramentas para ler, escrever e rodar comandos no seu repositório — e mantém você no
controle de quem autorizou o quê.

A semântica é a do Claude Code: o mesmo laço, o mesmo formato de permissões, o mesmo
contrato de hooks, os mesmos arquivos de skills, agents e comandos. A camada de provider é
a do opencode: pacotes do AI SDK carregados por nome, modelos escritos como
`provider/modelo`, qualquer endpoint no formato OpenAI. Um script de hook escrito para o
Claude Code roda aqui sem alteração; um bloco `provider` do opencode é lido como está.

```
Node ≥ 22.6 · sem build · 52 módulos · 20.507 linhas · 4 dependências · 1.562 asserções
```

**[Como funciona por dentro →](https://claude.ai/code/artifact/ffa8182b-58e2-41df-81ff-4e8a1de4cd83)**
— 18 capítulos sobre a arquitetura, incluindo o de→para com o Claude Code e o opencode.

---

## Instalação

```bash
git clone https://github.com/abelduartek/ByteCode.git
cd ByteCode
npm install
node bin/bytecode.mjs --help
```

Não existe etapa de build. O Node ≥ 22.6 apaga os tipos do TypeScript ao carregar, então
`src/index.ts` é executado como está. O pacote `typescript` serve só para o `tsc --noEmit`
checar tipos.

Roda em Windows, macOS e Linux. Nada aponta para caminho fixo: os binários externos são
descobertos pelo `PATH` e por variáveis de ambiente.

| binário | para quê | sem ele |
|---|---|---|
| ripgrep | `Glob` e `Grep` | cai num scanner em JS — mesmo resultado, bem mais lento |
| bash | a tool `Bash` no Windows | a tool não é registrada; sobra `PowerShell` |

O ripgrep vem do `@vscode/ripgrep` (dependência opcional) ou do `PATH`. No macOS e no Linux
a tool `Bash` usa `/bin/sh` direto.

## Primeiro uso

```bash
node bin/bytecode.mjs init          # escreve bytecode.jsonc e o JSON Schema dele
node bin/bytecode.mjs connect       # credencia um provider do catálogo models.dev
node bin/bytecode.mjs               # sessão interativa
```

O `connect` pergunta o provider, aceita a chave e a grava em `~/.bytecode/auth.json` com
permissão `600` — nunca no arquivo de config, que costuma estar sob controle de versão.

Sem interação:

```bash
node bin/bytecode.mjs connect anthropic --key sk-ant-...
node bin/bytecode.mjs -m anthropic/opus -p "explique src/core/loop.ts"
```

## Comandos

| comando | o que faz |
|---|---|
| `bytecode` | sessão interativa em tela cheia |
| `bytecode "pergunta"` | um turno, imprime a resposta e sai |
| `bytecode --simple` | interface de linha, sem tela alternativa |
| `bytecode init` | config inicial + JSON Schema |
| `bytecode connect [provider]` | credencia um provider do catálogo models.dev |
| `bytecode disconnect [provider]` | remove a credencial guardada |
| `bytecode auth` | lista os providers conectados |
| `bytecode models` | lista os refs `provider/modelo` configurados |
| `bytecode config` | mostra a config resolvida e de onde veio cada parte |
| `bytecode doctor` | mostra quais arquivos são lidos, quais são ignorados, e por quê |
| `bytecode mcp` | conecta os servidores MCP e lista o que expõem |
| `bytecode mcp import [--enable]` | copia servidores do opencode/Claude Code para a sua config |
| `bytecode sessions` | lista as sessões salvas deste diretório |
| `bytecode schema [arquivo]` | escreve o JSON Schema da config |
| `bytecode setup` | cria a estrutura de config e estado |

Opções: `-c/--continue`, `-r/--resume [#id]`, `-m/--model`, `--mode`, `-C/--cwd`,
`--workflows`, `-p/--print`, `-h`, `-v`.

Nenhuma credencial aparece na saída de `config` ou de `doctor`: valores de campos com nome
de segredo saem como `[redacted]`.

## Configuração

O arquivo é `bytecode.jsonc` — JSON com comentários e vírgula final. A precedência vai de
baixo para cima:

```
~/.config/bytecode/bytecode.jsonc
  → <diretórios ancestrais>/bytecode.jsonc
  → ./.bytecode/bytecode.local.jsonc
  → $BYTECODE_CONFIG
  → flags da linha de comando
```

Os nomes antigos `hx.jsonc`, `.hx/` e `HX_*` continuam sendo lidos, com precedência menor
que a dos novos.

```jsonc
{
  "$schema": "./bytecode.schema.json",
  "model": "anthropic/opus",

  "provider": {
    "anthropic": {
      "npm": "@ai-sdk/anthropic",
      "env": ["ANTHROPIC_API_KEY"],
      "models": { "opus": { "id": "claude-opus-5" } }
    },
    "meu-gateway": {
      "npm": "@ai-sdk/openai-compatible",
      "options": { "baseURL": "https://gateway.interno/v1" },
      "models": { "sonnet": { "id": "claude-sonnet-5" } }
    }
  },

  "permissions": {
    "allow": ["Read(**)", "Glob(**)", "Grep(**)"],
    "ask":   ["Write(**)", "Edit(**)", "Bash(*)"],
    "deny":  ["Read(**/.env)", "Bash(rm -rf:*)"],
    "defaultMode": "default"
  }
}
```

A credencial é procurada nesta ordem: `options.apiKey` da config, as variáveis nomeadas em
`env`, a convenção `<PROVIDER>_API_KEY`, e por fim `~/.bytecode/auth.json`. Se você recusou
a variável de ambiente durante o `connect`, essa recusa fica registrada e a variável deixa
de ganhar da chave que você digitou.

Valores podem ser montados de fora do arquivo: `{env:VAR}`, `{file:~/caminho}` e
`{base64:...}`, resolvidos nessa ordem.

## Permissões

A sintaxe é `Tool(padrão)` e a precedência é **deny > ask > allow**. Sem regra que case, o
veredito vem do tipo da tool:

| tipo | padrão | no modo `plan` |
|---|---|---|
| `read`, `meta` | allow | permitido |
| `net` | ask | permitido |
| `write`, `exec` | ask | negado |

Cinco modos, alternados com `shift+tab`: `default` pergunta antes de escrever ou executar;
`plan` nega qualquer efeito colateral; `acceptEdits` libera edição mas não comando;
`dontAsk` nega o que perguntaria; `bypassPermissions` não pergunta.

Regras `deny` valem em todos os modos. A guarda anti-SSRF do `WebFetch` não é uma regra:
ela mora dentro da tool, resolve o host uma vez e conecta no endereço que passou pela
checagem — regra casa a string que o modelo escreveu, e isso não sobrevive a um domínio que
resolve para um IP interno.

## O que vem junto

**Tools nativas** — `Read`, `Write`, `Edit`, `LS`, `Glob`, `Grep`, `Bash`, `PowerShell`,
`BashOutput`, `KillShell`, `WebFetch`, `Agent`, `AgentResume`, `Skill`, `ToolSearch`,
`TodoWrite` e, quando ligado, `Workflow`.

**Guarda de escrita** — sobrescrever um arquivo que a sessão não leu é recusado, e escrever
sobre um arquivo que mudou no disco depois da leitura também. `ctrl+g` abre a tela de
alterações da sessão, com diff por arquivo e desfazer.

**Subagents** — `Agent` roda uma sessão filha com contexto e conjunto de tools próprios; só
o texto final volta para o pai. `AgentResume` continua a conversa com um agente que já
rodou, sem refazer a exploração.

**Workflows** — um script JavaScript decide o fluxo (`parallel`, `pipeline`, laços, fases) e
cada passo é um subagente, com orçamento de tokens e visualizador ao vivo. Desligado por
padrão: `--workflows` ou `"workflows": { "enabled": true }`.

**MCP** — stdio, HTTP e SSE. As tools entram no mesmo registro das nativas, então
permissões, hooks e transcript valem para elas. São `deferred` por padrão: só o nome vai ao
prompt, e o schema entra quando o modelo chama `ToolSearch`.

**Hooks** — 15 eventos com o contrato do Claude Code: JSON na entrada padrão, saída 0
significa ok, 2 significa bloqueio com o stderr voltando para o modelo.

**Skills, agents e comandos** — lidos de `.claude/`, `.bytecode/` e `.hx/`, no projeto e no
home. Um comando em `commands/git/pr.md` vira `/git:pr`, com `$ARGUMENTS` e `$1..$9`.

**Sessões** — cada turno é salvo. `--continue` retoma a última deste diretório, `--resume`
abre o seletor. O transcript é JSONL em árvore, ligado por `parentUuid`.

**Compactação** — acima de 85% da janela, o histórico antigo vira um resumo estruturado. O
corte nunca separa uma chamada de tool do seu resultado.

**Prompt caching** — dois marcadores, no fim do system e no fim do request. Ligado sozinho
no `@ai-sdk/anthropic`; nos demais, o marcador é escrito no corpo do request, o que faz o
cache funcionar atrás de proxies no formato OpenAI.

## Atalhos da interface

| tecla | ação |
|---|---|
| `shift+tab` | alterna o modo de permissão |
| `tab` | troca o agente primary (entre turnos) |
| `ctrl+r` | expande a chamada de tool em foco |
| `ctrl+g` | tela de alterações da sessão |
| `ctrl+y` | alterna o diff entre agrupado e lado a lado |
| `ctrl+t` | tarefas |
| `ctrl+p` | servidores MCP |
| `ctrl+s` | árvore de sessões |
| `ctrl+f` | busca nas sessões, na tela inicial |
| `esc` | interrompe o turno; volta, dentro de uma tela |
| `ctrl+c` duas vezes | sai |

## Desenvolvimento

```bash
npm run typecheck    # tsc --noEmit
npm test             # 1.562 asserções, 26 execuções de suíte
npm run check        # os dois
```

O runner é próprio, 130 linhas, um processo por execução de suíte — várias delas leem
variáveis de ambiente no carregamento, substituem `process.stdout.write` ou tomam o stdin
em modo bruto, e compartilhar um processo faria uma interferir na outra.

Para rodar uma suíte só: `node test/run.mjs tui` (`--verbose` mostra cada asserção).

As asserções verificam comportamento observável, não chamadas: o teste de concorrência mede
a sobreposição real das janelas de execução, e o teste de tela reconstrói o quadro a partir
dos patches ANSI — um mini emulador de terminal — para afirmar sobre posição e largura.

## Estrutura

```
bin/bytecode.mjs     launcher: escolhe o modo do Node e mostra a tela de carregamento
src/
  index.ts           CLI, subcomandos, modo headless
  core/              laço, sessão, permissões, hooks, compactação, transcript, workflows
  provider/          registro de providers, catálogo models.dev, credenciais, caching
  tools/             as tools nativas
  tui/               interface de tela cheia, renderização, tema
  mcp/               cliente MCP
  assets/            descoberta de skills, agents, comandos e instruções
  config/            leitura, escrita e schema da config
test/                as suítes e o runner
docs/                manual longo, comparativo e roadmap de performance
```

## Documentação

- **[Arquitetura](https://claude.ai/code/artifact/ffa8182b-58e2-41df-81ff-4e8a1de4cd83)** —
  como o harness funciona por dentro, em 18 capítulos, com o comparativo contra o Claude
  Code e o opencode.
- [`docs/manual.md`](docs/manual.md) — o registro longo: cada tela, cada decisão, cada
  medição.
- [`docs/claude-code-vs-bytecode.md`](docs/claude-code-vs-bytecode.md) — de→para detalhado
  e a anatomia de uma chamada ao provider.
- [`docs/roadmap-performance.md`](docs/roadmap-performance.md) — o que foi medido, o que foi
  otimizado e o que foi recusado com o número na mão.
- [`PENDENCIAS.md`](PENDENCIAS.md) — histórico de decisões, com o que ficou aberto.

## Licença e autoria

Desenvolvido por Abel Duarte.
