# Manual do ByteCode

> Este arquivo era o README até a versão 0.1. Ele é o registro longo — cada tela, cada
> decisão de desenho, cada medição, e as armadilhas encontradas pelo caminho. O README
> na raiz é a porta de entrada; este é o material de referência.
>
> Alguns números aqui são do momento em que cada seção foi escrita. Os números atuais da
> árvore estão no README e no documento de arquitetura.

Um harness de agente de terminal com a **semântica do Claude Code** (loop, permissões, hooks,
skills, subagents, transcript em árvore) e a **camada de provider do opencode** (pacotes AI SDK
carregados por npm, modelos `provider/model`, endpoints OpenAI-compatible).

> **Renomeado de `hx` para `bytecode`.** Comando, config, diretório de estado e variáveis de
> ambiente todos mudaram — mas **nada do que existia foi movido ou perdido**: os nomes antigos
> continuam sendo lidos como fallback. Ver [Rename](#rename-de-hx-para-bytecode).

Referência da engenharia reversa que originou este projeto:
`../claude-config/docs/harness-claude-code.md`.

## Estado

v0.1 — núcleo completo e verificado localmente. **A chamada ao modelo ainda não foi executada
ponta a ponta nesta máquina** porque nenhuma credencial estava disponível na sessão (ver
[Verificação](#verificação)).

## Requisitos

- Node **≥ 22.6** (Node 24 roda `.ts` nativamente — sem build) ou Bun.
- `npm install` na raiz.

Roda em macOS, Linux e Windows. Nada aponta para caminho fixo: os binários externos são
descobertos por `PATH` e por variáveis de ambiente do sistema.

### Binários externos

| binário | para quê | como é encontrado | sem ele |
|---|---|---|---|
| **ripgrep** | `Glob` e `Grep` | `BYTECODE_RG` → `@vscode/ripgrep` (optionalDependency, baixa o binário da plataforma) → `rg` no `PATH` | cai no scanner em JS; mesmo resultado, bem mais lento |
| **bash** | tool `Bash` no Windows | `BYTECODE_BASH` → `bin/bash.exe` ao lado do `git` do `PATH` → `%ProgramFiles%`/`%ProgramW6432%`/`%ProgramFiles(x86)%`/`%LOCALAPPDATA%\Programs` + `\Git\bin\bash.exe` → `bash` no `PATH` | a tool `Bash` **não é registrada**; sobra `PowerShell` |

No macOS e no Linux a tool `Bash` usa `/bin/sh` direto — não há descoberta a fazer.

O launcher do WSL (`System32\bash.exe`) é ignorado de propósito: ele roda noutro namespace de
arquivos (`/mnt/c/...`), então o `cwd` da sessão e os caminhos gerados não bateriam.

`BYTECODE_NO_RG=1` desliga o ripgrep e força o scanner em JS — útil para comparar os dois caminhos.

O `-m` do ripgrep é um limite **por arquivo**, não um total, então o `head_limit` do `Grep` é
aplicado contando as linhas conforme elas chegam: alcançado o limite, o processo é morto. Medido
contra o `node_modules` deste repositório com `head_limit: 200`, isso é **128 ms** em vez de 298 ms,
e 337 KB bufferizados em vez de 6,18 MB. Cada linha de match também é cortada em 250 caracteres —
um bundle minificado é uma linha só, e 200 delas seriam um terço de megabyte de nada.

## Uso

```bash
node bin/bytecode.mjs init                 # cria bytecode.jsonc (importa os providers do opencode se existirem)
node bin/bytecode.mjs connect              # conecta um provider do catálogo models.dev
node bin/bytecode.mjs models               # lista provider/model configurados
node bin/bytecode.mjs                      # sessão interativa (TUI full-screen)
node bin/bytecode.mjs --simple             # UI de linha, sem alt-screen
node bin/bytecode.mjs -p "explique X"      # um turno, headless
node bin/bytecode.mjs -m 9router/sonnet5 -p "..."
node bin/bytecode.mjs config               # mostra a config resolvida e as fontes
node bin/bytecode.mjs sessions             # lista as sessões salvas deste diretório
node bin/bytecode.mjs --continue           # retoma a última sessão daqui
node bin/bytecode.mjs --resume 4be9e48c    # retoma uma sessão específica
```

Com Bun: `bun src/index.ts` (mesmos argumentos).

### Credenciais

Ordem de resolução por provider:

1. `provider.<id>.options.apiKey` na config (aceita `{env:VAR}`)
2. cada nome em `provider.<id>.env`
3. `<PROVIDER_ID>_API_KEY` no ambiente
4. `~/.bytecode/auth.json` — `{ "<providerId>": { "type": "api", "key": "..." } }`
5. `~/.local/share/opencode/auth.json` **apenas** se `"openCodeAuth": true` na config

Nada é lido do store do opencode sem esse opt-in explícito. `bytecode doctor` mostra, por provider,
de qual desses cinco a chave está vindo — ou que não está vindo de nenhum.

Três formas de colocar uma chave, do mais efêmero ao mais permanente:

```bash
# 1. só nesta shell
$env:SELBETTI_API_KEY = "sk-..."          # PowerShell
export SELBETTI_API_KEY=sk-...            # bash/zsh

# 2. gravado em ~/.bytecode/auth.json (chmod 600), sobrevive a reinício
bytecode connect selbetti --key sk-...

# 3. na config, referenciando a env var — nunca a chave literal
#    "provider": { "selbetti": { "options": { "apiKey": "{env:SELBETTI_API_KEY}" } } }
```

Um 401 agora **diz qual provider e qual variável**, em vez de "set the provider env var":

```
AI_APICallError — HTTP 401 — Authentication Error, No api key passed in.
Sem credencial para selbetti/sonnet. Escolha uma:
  1. $SELBETTI_API_KEY ou $SELBETTI_API_KEY no ambiente
  2. bytecode connect selbetti   (grava em ~/.bytecode/auth.json)
  3. "provider": { "selbetti": { "options": { "apiKey": "{env:SELBETTI_API_KEY}" } } } na config
```

Isso importa mais no subagente do que na sessão: o modelo que falhou muitas vezes **não é** o da
sessão, e a mensagem antiga não dizia qual era.

## Config

Precedência (menor → maior), merge profundo; listas de permissão fazem união:

```
~/.config/bytecode/bytecode.jsonc → <ancestrais>/bytecode.jsonc
→ ./.bytecode/bytecode.local.jsonc → $BYTECODE_CONFIG → $BYTECODE_CONFIG_CONTENT → flags de CLI
```

Em cada nível o nome novo é procurado primeiro e o antigo (`hx.jsonc`, `.hx/`) depois, então um
repo com o arquivo velho continua carregando.

Substituição em qualquer string: `{env:VAR}` e `{file:caminho}`.

```jsonc
{
  "model": "selbetti/opus",
  "smallModel": "selbetti-free/qwen36",
  "provider": {
    "selbetti": {
      "npm": "@ai-sdk/openai-compatible",
      "env": ["SELBETTI_API_KEY"],
      "options": { "baseURL": "https://vllm-oracle.selbetti.tech/v1" },
      "models": {
        "opus": {
          "id": "claude-opus-4-7",
          "headers": { "x-litellm-tags": "hx,cobranca_team" },
          "limit": { "context": 250000, "output": 16384 }
        }
      }
    }
  },
  "permissions": {
    "allow": ["Read(**)", "Glob(**)", "Grep(**)", "LS(**)"],
    "ask": ["Write(**)", "Edit(**)", "Bash(*)", "PowerShell(*)"],
    "deny": ["Read(**/.env)", "Bash(rm -rf:*)"],
    "defaultMode": "default"
  },
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "node ~/.claude/hooks/caveman-mode-tracker.js", "timeout": 5 }] }
    ]
  },
  "deferredTools": ["PowerShell"],
  "subagentDepth": 1,
  "subagentConcurrency": 8,
  "maxSteps": 64,
  "fileGuard": true,
  "cache": { "enabled": true, "ttl": "1h" }
}
```

O arquivo declara `"$schema": "./bytecode.schema.json"`, gerado por `bytecode schema` e escrito
também pelo `bytecode init` — assim a referência nunca aponta para o vazio. O editor valida e
completa as chaves; `test/schema.test.ts` falha se alguém adicionar opção em `config/types.ts` sem
declarar no schema, que foi exatamente o que aconteceu com seis chaves numa única tarde.

| chave | padrão | o que faz |
|---|---|---|
| `subagentDepth` | `1` | profundidade máxima de `Agent`; `0` desliga subagents |
| `subagentConcurrency` | `min(8, cpus−2)` | subagents do mesmo step rodando juntos; `1` volta à fila |
| `maxSteps` | `64` | chamadas ao modelo por turno; em 75% o modelo é mandado convergir |
| `fileGuard` | `true` | recusa escrita cega e escrita sobre arquivo alterado no disco |
| `cache` | ligado só no Anthropic | prompt caching; `enabled: true` liga no OpenAI-compatible |

`providerOptions` por modelo é repassado cru ao AI SDK — é assim que se liga thinking/effort sem
o loop conhecer nenhum provider:

```jsonc
"models": {
  "opus": { "id": "claude-opus-5", "providerOptions": { "anthropic": { "thinking": { "type": "adaptive" } } } }
}
```

## Design

A TUI segue a spec em `design/hx-tui.dc.html` (10 telas: hoje, splash, sessão, composer,
permissão, /connect, diff, listas, compactação, degradação + tokens).

**Tokens** — índice xterm-256 · hex · fallback 16, em `src/tui/theme.ts`:

| token | 256 | hex | uso |
|---|---|---|---|
| `bg` / `bar` | 235 / 236 | `#262626` / `#303030` | fundo · header e status (únicas linhas com background) |
| `fg` / `bright` | 252 / 255 | `#d0d0d0` / `#f0f0f0` | corpo · ênfase |
| `dim` / `faint` / `rule` | 245 / 240 / 237 | `#8a8a8a` / `#585858` / `#3f3f3f` | secundário · terciário · réguas |
| `accent` | preset | — | marca, rail do usuário, composer, prompt `❯` |
| `info` | 109 | `#87afaf` | escolha neutra: picker, input, spinner, código inline |
| `ok` / `warn` / `danger` | 108 / 179 / 167 | `#87af87` / `#d7af5f` / `#d75f5f` | sucesso · decisão pendente · falha e AUTO |
| `meta` | 139 | `#af87af` | git, divisor de compactação |

**Paleta** — o `accent` vem de um preset trocável, porque o terracota da spec é a cor do Claude:

| preset | accent | |
|---|---|---|
| `violet` | 141 `#af87ff` | **default** |
| `azure` | 75 `#5fafd7` | |
| `emerald` | 78 `#5fd787` | |
| `amber` | 214 `#ffaf00` | |
| `terracotta` | 173 `#d7875f` | spec original |

`/theme` troca ao vivo (com picker); `"theme": { "preset": "azure" }` no `bytecode.jsonc` fixa. Também dá
para sobrescrever índices soltos: `"theme": { "tokens": { "accent": 99, "meta": 176 } }`.

**Glifos** — box `╭ ─ ╮ │ ╰ ╯ ┬ ┴`, sub-régua `╌`, rail `▌ ▏`, estado `✔ ✕ ▲ ● ○`,
prompt `❯`, expandir `⌄ ⌃`, git `⎇`, cursor `▉`, spinner braille, sparkline `▁▂▃▄▅▆▇█`.

**Raciocínio do modelo** — alguns proxies OpenAI-compatible (o 9router entre eles) mandam o
raciocínio como `<think>…</think>` **dentro do canal de conteúdo**, em vez de usar a parte de
reasoning. `src/core/reasoning.ts` separa isso no streaming e manda para o indicador de "pensando":
a tag nunca aparece na resposta nem no transcript, e tags partidas entre deltas (`<th` + `ink>`) são
reconhecidas.

**Header fixo** — o wordmark e a identidade (modelo, janela de contexto, cwd, branch) ficam
**pinados** no topo em 3 linhas, não no transcript — mandar mensagem não faz sumir. Sem background:
`barLine` abria o fundo uma vez, mas cada cor interna termina com RESET, que **também apaga o
fundo** — sobrava uma mancha cinza atrás do logo e nada no resto da linha. A status bar, que mantém
o fundo, agora reabre ele depois de cada reset, então é uma barra de verdade e não meio pintada.
Duas linhas em branco separam o header do primeiro bloco: uma só lê como acidente de render, duas
leem como espaço deliberado. O splash de SessionStart cobre o que não cabe no header: assets, MCP e
as teclas.

**Bloco de tool** — a chamada lê como chamada, com o resultado numa **bolinha** que substitui o
check: verde ok, vermelha falha, spinner enquanto roda. O detalhe pendura embaixo, e o corpo só
aparece com `ctrl+r`:

```
● Edit(src/tui/fullscreen.ts)                                        ⌄ ctrl+r
  └ Added 2 lines, removed 1 line
        2102     '- `ctrl+r` expande/colapsa a última tool',
        2103 -   '- roda do mouse rola',
        2103 +   '- `ctrl+a` foca a faixa de subagents',
        2104 +   '- de dentro de um subagent, `esc` volta',
        2105     '- clique sem arrastar não copia nada',
```

Uma bolinha só, na margem: check **e** bolinha diziam a mesma coisa duas vezes. O detalhe sai da
linha da chamada para o `└` porque um resumo longo brigava com o nome do arquivo pela mesma linha.

**Expandir qualquer uma, não só a última** — `ctrl+r` sozinho pega a última tool, que é o caso comum.
Para escolher outra: **clique na linha dela**, ou `alt+↑↓` para andar entre as tools sem mouse. A
focada ganha `❯` na margem e o `ctrl+r` em accent, então dá para ver onde a tecla vai bater.

Detalhe que só apareceu no teste: um `ctrl+r` simples **não** fixa o foco. Se fixasse, o foco grudava
na primeira tool expandida e todo `ctrl+r` seguinte continuaria batendo naquela chamada velha em vez
da que acabou de rodar. Foco só é tomado por escolha explícita — clique ou `alt+↑↓`. E o foco é
zerado ao retomar sessão ou `/clear`, senão o índice sobrevivia apontando para outro bloco.

`Edit` e `Write` passaram a devolver **diff numerado** em vez de `Applied 1 replacement(s)`: acham a
região que mudou (prefixo/sufixo comuns), contam as linhas e emitem 3 de contexto de cada lado no
formato `<número> <+|-|espaço> <texto>`. O render dá coluna própria ao número e estende o fundo pela
**linha inteira**, então a mudança lê como faixa e não como texto colorido. Arquivo novo reporta
`Created N lines`; troca sem efeito reporta `No line changed` em vez de fingir sucesso.

Isso exigiu o preview do `tool-end` deixar de ser só a primeira linha — agora vai a cabeça da saída
(40 linhas / 4000 chars), que a UI mantém colapsada.

O wordmark soletra o nome numa fonte de bloco de 3 linhas, cada glifo com 3 células e uma de
tracking (31 colunas no total). `BYTE` sai no accent, `CODE` em dim:

```
█▀▄ █ █ ▀█▀ █▀▀ ▄▀▀ ▄▀▄ █▀▄ █▀▀   v0.1  ·  multi-provider agent harness
█▀▄ ▀▄▀  █  █▀▀ █   █ █ █ █ █▀▀   anthropic/opus5  ·  200k ctx
█▄▀  █   █  █▄▄ ▀▄▄ ▀▄▀ █▄▀ █▄▄   C:\Repositories\harness  ⎇ main
```

Como a arte já diz o nome, a coluna de texto não repete — leva versão, modelo e caminho. Terminal
com menos de 26 linhas, ou estreito demais para sobrar espaço ao lado da arte, colapsa sozinho para
a identidade de uma linha (aí o nome aparece em texto). Cada linha é truncada na largura da coluna:
um `cwd` comprido antes empurraria o layout inteiro uma linha para baixo.

**Uma linha é uma linha** — cada linha do quadro passa por `oneLine`, que troca todo controle C0 por
espaço **menos o ESC** (que abre toda sequência SGR). Não é cosmético: `draw()` posiciona o cursor com
`CSI <linha>;1H` e escreve a linha, então um `\n` no meio empurra o resto para a linha física seguinte
**sem marcador de posição** — e tudo abaixo desanha. O sintoma era fragmento órfão na coluna 0. Um
comando de shell multilinha (heredoc, `echo "a\nb"`) provocava isso; agora o `subject` do Bash também
já chega colapsado, então `Bash(...)` é sempre um título de uma linha.

**Render** — o quadro é desenhado **incrementalmente**: só as linhas que mudaram são reescritas
(~330 B por quadro em vez dos ~20 KB de um repaint inteiro, que é o que fazia o streaming travar no
console do Windows). Cada bloco tem cache por assinatura, e só os blocos **visíveis** são
renderizados — uma sessão longa desenha tão rápido quanto uma recém-aberta.

**Mouse e cópia** — arraste com o botão esquerdo para selecionar **do primeiro ao último caractere**,
não a linha inteira: a seleção começa na coluna onde você apertou e termina na coluna onde soltou.
Arrastar por várias linhas pega o fim da primeira, as do meio inteiras e o começo da última —
como qualquer editor. Arrastar de trás para frente dá o mesmo trecho. Ao soltar, o texto (sem
códigos ANSI) vai para a área de transferência e a status bar confirma com a contagem.

**Clique sem arrastar não faz nada** — não pinta seleção, não copia, não mexe no clipboard. Isso vale
inclusive no campo de digitação: clicar ali não sequestra o que você já tinha copiado.

`/copy` copia a tela inteira. Com a captura do mouse ligada o terminal não faz mais a seleção nativa
— `/mouse off` devolve (perde roda e cópia automática), `/mouse` liga de volta. Clipboard: `clip` no
Windows (UTF-16 com BOM, para não estragar acento), `pbcopy` no macOS, `wl-copy`/`xclip`/`xsel` no
Linux. `BYTECODE_FAKE_CLIPBOARD=1` faz a cópia virar no-op (testes e CI não mexem no clipboard real).

**Rolagem** — roda do mouse (SGR mouse reporting), `pgup`/`pgdn` (10 linhas), `home`/`ctrl+home` vão
ao início, `end`/`ctrl+end` voltam ao fim. As duas codificações de End/Home são aceitas
(`CSI F`/`CSI 1;5F`/`CSI 4~`/`CSI 8~`/`SS3 F` e as equivalentes de Home), porque terminais discordam.
Enquanto está rolado, a status bar mostra `rolado N linhas`; qualquer bloco novo gruda de volta no fim.

Se alguma tecla não funcionar no seu terminal, `/keys` liga o eco: cada tecla aparece com a sequência
e os bytes que o terminal enviou (esc sai). Nota: com mouse reporting ligado, alguns terminais exigem
**Shift** para seleção de texto com o mouse.

**Fila de mensagens** — dá para digitar e enviar durante um turno. A mensagem entra na fila e aparece
**invertida na largura toda** (fundo claro, texto escuro) com `na fila` à direita:

```
 ❯ e depois roda os testes                                          na fila ▏
```

Quando a vez dela chega, o destaque sai e ela vira uma mensagem normal, com o rail `▌` — o mesmo
bloco, sem duplicar. Comando enfileirado (`/mode`) roda como comando e **não** deixa bolha.

Antes essas linhas iam para uma fila interna com **nada na tela** dizendo que existiam: você digitava,
apertava enter e parecia que a mensagem tinha sido engolida.

**Indicador de trabalho** — durante um turno, o lugar da linha em branco acima do composer é ocupado
por `Fermentando… (28s · ↓ 1.2k tokens · esc interrompe)` mais uma dica rotativa. O verbo troca a cada
~20s para um turno longo não parecer travado. A linha em branco **continua ali**: antes o indicador
substituía o respiro e ficava colado na última linha do chat.

**Composer** — o campo **cresce** com o conteúdo em vez de esconder. Linha longa faz soft-wrap
(quebra em espaço quando há um no último terço da linha, senão corta à força — um path ou token não
tem onde quebrar e ainda precisa ser lido); bloco colado mantém a forma; até 10 linhas visíveis com
`… N linhas acima` acima disso. Quando a última linha enche exatamente a largura, uma linha extra
nasce para o cursor não sentar na borda.

Antes o campo fazia `truncate` e aparecia `…`: escondia exatamente os caracteres que estavam sendo
digitados, que é a única parte que **tem** que ficar visível.

**Largura** — por padrão a coluna **ocupa o terminal inteiro**. `/width 120` limita e centraliza (é o
que a spec original pede), `/width full` volta; `"ui": { "maxWidth": 120 }` no `bytecode.jsonc` fixa.
Modais continuam com teto de 78 colunas em qualquer largura.

**Regras de layout** — uma linha em branco entre blocos,
nunca duas · tool call em 1 linha até `ctrl+r` · modal centrado com máx. 78 colunas, borda colorida
pelo tipo de decisão (âmbar decide, teal escolhe, vermelho alerta) · texto informativo à direita
sempre `faint`.

**Degradação** — 256 → 16 pela coluna de fallback · `NO_COLOR` / `TERM=dumb` mantém glifos e usa
bold/dim · `BYTECODE_ASCII=1` troca box-drawing por `+-|` e braille por `|/-\` · saída redirecionada
(pipe/arquivo) sai sem nenhuma sequência de escape.

## Abrir pelo Explorer (Windows)

`scripts\windows-context-menu.ps1` põe **"Abrir com … aqui"** no menu de contexto de pasta, ao lado
de "Open Git Bash here". Serve para **ByteCode, opencode e Claude Code** — cada um com sua própria
chave, então convivem no mesmo menu.

```powershell
# confere o que faria, sem escrever nada
powershell -ExecutionPolicy Bypass -File scripts\windows-context-menu.ps1 -Tool all -DryRun

# instala o que estiver presente na máquina
powershell -ExecutionPolicy Bypass -File scripts\windows-context-menu.ps1 -Tool all

# uma só, ou desfazer
powershell -ExecutionPolicy Bypass -File scripts\windows-context-menu.ps1 -Tool opencode
powershell -ExecutionPolicy Bypass -File scripts\windows-context-menu.ps1 -Tool all -Remove
```

Escreve **duas** chaves por ferramenta, e só em `HKCU` — sem admin, sem tocar em `HKLM`:

| chave | quando aparece |
|---|---|
| `Directory\shell\<Nome>` | botão direito **em** uma pasta |
| `Directory\Background\shell\<Nome>` | botão direito **dentro** de uma pasta, no vazio |

São duas porque o Windows trata os dois cliques como contextos diferentes — é por isso que o Git
instala "Open Git Bash here" nos dois lugares. `%V` é a pasta clicada em ambos.

Decisões que importam para quem for distribuir o arquivo:

- **aponta para o `.exe` dentro de `node_modules`**, não para o atalho do npm. O atalho `nome` é um
  script sh e o `nome.cmd` sobe um `cmd.exe`: medido, o shim sh custa ~310 ms e o `.cmd` ~32 ms por
  execução, e o menu de contexto pode pular os dois;
- **Windows Terminal quando existir** (`-d "%V"` abre a aba já no diretório), senão PowerShell com
  `Set-Location`. Nos dois o shell fica **aberto depois que a ferramenta sai** — sem isso, um erro de
  inicialização fecharia a janela antes de dar tempo de ler;
- **`-Tool all` pula o que não está instalado**, dizendo o quê e por quê, e sai com 0 — quem não tem
  o ByteCode instala opencode e Claude do mesmo jeito. Pedir explicitamente uma que falta
  (`-Tool bytecode`) sai com 1 e uma frase, sem stack trace;
- **`-BytecodePath`** para quem tem o repositório em outro lugar e recebeu só o `.ps1`. Não há
  adivinhação de caminho: um palpite errado gravaria um atalho que abre outra coisa, o que é pior
  do que não gravar;
- **nada fica preso à máquina de origem**: o caminho do ByteCode sai do próprio `$PSScriptRoot`, e os
  outros dois são procurados em `%APPDATA%
pm
ode_modules` e no `npm` do `PATH`. Mover a pasta e
  rodar de novo conserta o atalho;
- o arquivo tem **BOM**: sem ele o PowerShell 5.1 lê `.ps1` na codepage ANSI e o acento sai corrompido.

No Windows 11 o item fica em **"Mostrar mais opções"** — `shift+F10` abre o menu clássico direto.

## Tela de carregamento

O launcher desenha uma tela centrada — nome, uma barra que varre e uma frase — **antes** de importar
qualquer módulo pesado. A ordem é o ponto: os módulos pelos quais se espera incluem tudo que sabe
desenhar, então o que carrega depois não consegue mostrar que está carregando.

Detalhes que são decisão, não enfeite:

- **a barra varre, não enche.** Carregamento de módulo não reporta progresso; uma porcentagem teria
  de ser inventada, e uma barra que pula para 100% no fim é uma mentira dita com simpatia;
- **desenha na tela alternativa e a entrega para a TUI** em vez de sair e entrar de novo — sair
  mostraria o shell do usuário por um frame entre as duas telas;
- **a cor sai do `theme.ts`**, não de um número copiado: o accent do preset padrão pinta o primeiro
  frame na hora, e o preset real da config (leitura de ~14 ms de disco) corrige um frame depois.
  `BYTECODE_THEME=emerald` força um preset sem tocar na config;
- **não aparece onde atrapalharia**: sem TTY (pipe, CI), em `--version`/`-p` e nos subcomandos que
  imprimem e saem, ou com `BYTECODE_NO_SPLASH=1`. O timer é `unref`'d, então nunca é o motivo de o
  processo continuar vivo.

No mesmo passo caiu o respawn do launcher: ele subia um segundo processo Node só para passar
`--experimental-strip-types`, que o Node 23+ não precisa. **73 ms medidos**, pagos em toda execução.

## Modos de permissão

**Shift+Tab** (ou **Alt+M**) cicla o modo na TUI, igual ao Claude Code. Alt+Tab não serve: o Windows
intercepta antes do terminal, a sequência nunca chega ao processo.

| Ciclo | `mode` | Efeito |
|---|---|---|
| `ask` | `default` | pergunta antes de escrever arquivo ou rodar comando |
| `plan` | `plan` | somente leitura: nega qualquer escrita ou execução |
| `AUTO` | `bypassPermissions` | roda sem perguntar |

Fora do ciclo, por `/mode`: `acceptEdits` (edita arquivo sem perguntar, comando ainda pergunta) e
`dontAsk` (o que pediria confirmação é negado).

O modo aparece na status bar, com `AUTO` em vermelho. **As regras `deny` da config valem em todos os
modos, inclusive AUTO** — `rm -rf`, `git push --force`, leitura de `.env` continuam bloqueadas.

Para começar já em um modo: `hx --mode bypassPermissions`, ou `permissions.defaultMode` na config.
Na UI de linha (`--simple`) use `/mode`.

### O padrão de cada tipo de tool

Sem regra que case, o veredito vem do **kind** da tool. É isso que define o que acontece quando você
não escreveu nada na config:

| kind | tools | padrão | no plan mode |
|---|---|---|---|
| `read` | `Read`, `Glob`, `Grep`, `LS`, `BashOutput`, MCP com `readOnlyHint` | allow | permitido |
| `meta` | `Agent`, `AgentResume`, `Skill`, `ToolSearch`, `TodoWrite` | allow | permitido |
| `net` | `WebFetch` | **ask** | **permitido** — ler doc é a maior parte de planejar |
| `write` | `Write`, `Edit` | ask | negado |
| `exec` | `Bash`, `PowerShell`, `KillShell`, `Workflow`, MCP sem anotação | ask | negado |

`net` é kind próprio e não um dos outros por um motivo prático: `exec` tornaria impossível consultar
documentação enquanto se planeja, e `read` liberaria egresso de rede sem perguntar nada.

## Vindo do opencode

O bloco `provider` é **o mesmo** dos dois lados — dá para colar a config do opencode direto no
`bytecode.jsonc`. As chaves snake_case do opencode são aceitas e normalizadas: `disabled_providers`,
`small_model`, `subagent_depth`, `max_output_tokens`, `data_dir`, `deferred_tools`, `disabled_tools`.
Campos que o hx ainda não usa (`modalities`, `cost` detalhado) são ignorados sem erro.

Para sincronizar sem copiar à mão:

```bash
node bin/bytecode.mjs import                       # lê ~/.config/opencode/opencode.jsonc
node bin/bytecode.mjs import --from ./outro.jsonc  # de outro arquivo
```

Escreve em `~/.config/hx/bytecode.jsonc` (config de usuário) e **não** toca no `bytecode.jsonc` do projeto — que
continua vencendo no merge, com os comentários intactos. Servidores MCP são importados
**desabilitados** (importar uma config não deve começar a subir processo e usar credencial sem você
pedir); `--enable-mcp` importa ligados, ou troque `"enabled": true` depois.

## Conectar qualquer LLM (`/connect`)

Igual ao opencode: o catálogo do **models.dev** (174 providers) descreve pacote AI SDK, endpoint,
variável de ambiente e todos os modelos com limite de contexto e preço. Conectar exige só a chave —
nada de editar config.

```bash
node bin/bytecode.mjs connect                       # interativo: busca provider, pede chave
node bin/bytecode.mjs connect groq                  # já com o provider
node bin/bytecode.mjs connect groq --key sk-... --base-url https://...   # não-interativo
node bin/bytecode.mjs auth                          # lista conexões (chave mascarada)
node bin/bytecode.mjs disconnect groq
```

Na TUI o fluxo é todo em modal, sem sair da tela: `/connect` abre o picker dos 174 providers com
filtro por digitação, pede a chave com a entrada **mascarada**, pergunta a baseURL e já lista os
modelos. `/disconnect` e `/auth` idem. O provider fica utilizável na hora, sem reiniciar.

- Credenciais em `~/.bytecode/auth.json` (`chmod 600` onde o SO suporta), fora de qualquer repo.
- Catálogo cacheado em `~/.bytecode/models-dev.json`, revalidado a cada 24 h; sem rede, usa o cache.
- Providers do arquivo de config sempre vencem os derivados do catálogo.
- Se o pacote AI SDK do provider não estiver instalado, o fluxo avisa com o `npm install` exato.
- Resolução de chave: `options.apiKey` → `provider.env[]` → `<PROVIDER>_API_KEY` → `~/.bytecode/auth.json`
  → store do opencode (só com `"openCodeAuth": true`).

## MCP

Servidores MCP entram no bloco `mcp`. Transportes: **stdio** (`type: "local"`) e **HTTP**
(`type: "remote"` — tenta Streamable HTTP e cai para SSE em servidor antigo).

```jsonc
"mcp": {
  "azure-devops": {
    "type": "local",
    "command": ["npx", "-y", "@azure-devops/mcp", "selbettidev", "--authentication", "pat"],
    "environment": { "ADO_PAT": "{env:ADO_PAT}" },
    "timeout": 60
  },
  "algum-remoto": {
    "type": "remote",
    "url": "https://mcp.exemplo.com/mcp",
    "headers": { "Authorization": "Bearer {env:MCP_TOKEN}" }
  }
}
```

Comportamento:

- Tools viram `mcp__<servidor>__<tool>` no **mesmo registro** das nativas — permissões, hooks e
  transcript valem sem exceção.
- **Deferred por padrão**: só o nome vai ao contexto; o schema carrega via `ToolSearch`
  (`select:mcp__x__y`). `"eager": true` manda o schema de cara.
- Permissão derivada da anotação do servidor: `readOnlyHint: true` → `read` (allow por padrão);
  qualquer outra → `exec` (ask por padrão). Regras `mcp__servidor__tool(...)` sobrescrevem.
- O bloco `instructions` do servidor é injetado como `<system-reminder>`.
- Capacidade de resources vira `mcp__<servidor>__list_resources` e `__read_resource`.
- `allowedTools: [...]` restringe o que é exposto; `enabled: false` desliga o servidor.
- `parallelSafe: true` (ou uma lista de nomes) deixa as tools desse servidor rodarem concorrentes.
  Sem isso, só quem declara `readOnlyHint` entra no lote — e essa anotação é opcional no protocolo,
  então na prática todo `list_*`/`get_*` roda um de cada vez.
- Falha de conexão **não derruba a sessão**: vira aviso e o servidor fica marcado como failed.
- **Credencial ausente é dita, não discada**: `{env:VAR}` sem valor substitui para string vazia, e
  subir o servidor assim gastaria o handshake para morrer com `Connection closed` — que não diz nada.
  Entrada de `environment` que resolve vazia vira falha imediata nomeando a variável.
- **O ambiente do processo é herdado**, como no opencode (`MCP.connectLocal` spawna com
  `{...process.env, ...environment}`) — o `getDefaultEnvironment()` do SDK repassa só um whitelist
  (PATH, HOME, APPDATA, TEMP…) e derruba credencial ambiente, quebrando config escrita para outra
  ferramenta com um erro que não nomeia nada. `"inheritEnv": false` volta ao whitelist para um
  servidor que não deve ver o resto do ambiente. `environment` sempre vence o herdado.
- **`BYTECODE_NO_MCP=1`** pula MCP inteiro: início rápido, bissecção de servidor que trava, e suíte de
  teste que não sobe o que a máquina tiver configurado.
- **O stderr do servidor entra na mensagem de erro.** `Connection closed` não diz nada; a causa está no
  que o servidor imprimiu antes de morrer. O stream é **pipe** (nunca `inherit`, que corromperia o
  quadro) e drenado para um buffer limitado — sem drenar, servidor falante trava quando o pipe enche.
  Na falha, a última linha significativa é anexada, desembrulhando o campo `message` de log em JSON:
  `MCP error -32000: Connection closed — o servidor disse: Environment variable 'PERSONAL_ACCESS_TOKEN'
  is not set or empty.`

> **Azure DevOps** — `@azure-devops/mcp` 2.7.0 com `-a pat` lê **`PERSONAL_ACCESS_TOKEN`**, e o valor
> é usado direto como credencial Basic: precisa ser `base64(":" + PAT)`. `-a envvar` lê
> `ADO_MCP_AUTH_TOKEN` como **Bearer** (token Entra, não PAT) e `-a azcli` exige Azure CLI logado.
> Medido nesta máquina: com `-a azcli` sem `az` instalado o handshake **passa** e só a primeira
> chamada falha (`ChainedTokenCredential authentication failed`) — por isso a config usa `pat`.
>
> Guarde o PAT **cru** num arquivo fora do repo e deixe a config codificar:
> `"PERSONAL_ACCESS_TOKEN": "{base64::{file:~/.bytecode/ado-pat}}"`.

Além de `{env:VAR}` e `{file:path}`, qualquer string da config aceita **`{base64:texto}`**, resolvido
**por último** — então ele codifica o que os outros dois produziram. Existe porque codificar segredo à
mão é passo que falha calado: encoding errado autentica como ninguém e o servidor responde 401 sem
dizer por quê. Referência que não resolve deixa o resultado **vazio** em vez de `base64("")`, para a
credencial ausente continuar parecendo ausente lá na frente.

Inspeção sem abrir sessão:

```bash
node bin/bytecode.mjs mcp     # conecta, lista tools/estado/instructions e desconecta
```

Na TUI: `/mcp`.

### Herdar servidores do opencode e do Claude Code

Quem já configurou MCP em outra ferramenta não precisa redeclarar. `inheritMcp` reaproveita
servidores que **não existem** no bloco `mcp` desta config — o nome declarado aqui sempre vence, a
herança só preenche lacuna:

```jsonc
"inheritMcp": true                  // opencode + Claude Code
"inheritMcp": ["opencode"]          // só uma origem
```

**Desligado por padrão**, e não por preciosismo: herdar significa subir o processo que a config da
outra ferramenta aponta, com o ambiente que ela declara. Config escrita para outra ferramenta não é
consentimento para executá-la a partir daqui.

De onde cada origem é lida:

| origem | arquivos | formato |
|---|---|---|
| opencode | `./.opencode/opencode.{jsonc,json}`, `./opencode.{jsonc,json}`, `~/.config/opencode/opencode.{jsonc,json}` | idêntico ao nosso (`mcp`, `type: local\|remote`) |
| Claude Code | `./.mcp.json`, `~/.claude.json` (global e a entrada do cwd) | `mcpServers`, `type: stdio\|sse\|http` — traduzido |

Precedência dentro de cada origem: config do projeto antes da do usuário; no `~/.claude.json`, a
entrada do **cwd** antes da global (as barras são normalizadas, porque o mesmo diretório aparece com
`\` e com `/` naquele arquivo). Servidor do Claude sem `command` nem `url` é descartado.

Para trazer de vez, em vez de depender do arquivo alheio:

```bash
node bin/bytecode.mjs mcp import            # copia para ~/.config/bytecode/bytecode.jsonc, desligados
node bin/bytecode.mjs mcp import --enable   # já ligados
```

O import **nunca copia credencial em texto puro**: valor literal em chave que parece segredo
(`*PAT*`, `*TOKEN*`, `*KEY*`, `*SECRET*`…) vira `{env:NOME}` e o comando lista as variáveis que
passam a precisar de valor. Isso é deliberado — `~/.claude.json` guarda um PAT do Azure DevOps em
texto puro em 15 entradas de projeto, e copiar isso para um segundo arquivo espalharia o segredo em
vez de migrá-lo.

`bytecode mcp` e `bytecode doctor` dizem a origem de cada servidor (`own`, `opencode`, `claude`) e
avisam quando existe servidor em outra ferramenta que **não** está sendo usado — a ausência de uma
tool tem que parecer configuração, não bug. O modal `ctrl+p` mostra a origem ao lado do nome e
marca os `enabled: false` como desligados em vez de escondê-los.

## Workflows (orquestração multi-agente) — **desligado por padrão**

Um script JS decide o controle de fluxo (fan-out, pipeline, laço) e cada passo roda como subagente
com contexto próprio. Determinístico onde importa, model-driven só nos passos.

Está **desligado por padrão** — um workflow pode disparar dezenas de agentes, então habilitar é uma
decisão explícita. Enquanto desligado, a tool `Workflow` **nem aparece** para o modelo:

```bash
node bin/bytecode.mjs --workflows          # só nesta execução
```
```jsonc
"workflows": { "enabled": true, "maxConcurrency": 8, "maxAgents": 1000, "tokenBudget": 500000 }
```
Na TUI: `/workflows on` / `/workflows off` (registra e remove a tool na hora). **`/workflows` sozinho
abre o visualizador** — a rodada em andamento, agrupada por fase, com o passo que está rodando, o log
e o orçamento. O toggle ficou atrás do `on`/`off` de propósito: ver o progresso não pode desligar a
orquestração sem querer.

```
workflow · review-diff · 4/9 · 32s
 Achar
  ✓ find:bugs                    2.1k chars
  ◐ find:segurança                    7s
 ▸ deep-scan Varredura
  ✓ scan:1                       1.4k chars
 orçamento 18.2k/500k tokens de saída
```

Dentro do script (`await` e `return` no topo funcionam):

| | |
|---|---|
| `agent(prompt, opts?)` | roda um subagente; `opts`: `label`, `phase`, `model`, `agentType`, `schema` |
| `parallel(thunks)` | concorrente, falha vira `null` |
| `pipeline(items, ...stages)` | cada item percorre os estágios sem barreira entre eles |
| `workflow(nome \| {scriptPath}, args?)` | roda outro workflow como passo deste |
| `phase(title)` / `log(msg)` | progresso na UI |
| `budget` | `{ total, spent(), remaining() }` em tokens de saída |
| `args` | valor passado na chamada da tool |

Com `schema` (JSON Schema) o passo tem de responder JSON e o objeto parseado é devolvido.
`agentType` usa um agent do disco — herdando prompt e `tools:` do frontmatter.

**Workflow dentro de workflow.** `workflow('nome')` procura o script salvo em
`.bytecode/workflows/`, `.claude/workflows/` (projeto e `$HOME`, projeto ganha) e roda com o **mesmo**
limitador, contador de agentes, journal e orçamento da rodada de fora — aninhar não dobra a
concorrência nem reinicia a numeração. As fases do filho aparecem prefixadas (`▸ nome fase`) e a fase
do pai é restaurada quando ele volta. **Um nível só**: uma cadeia de sub-workflows produz um fan-out
que ninguém consegue ler na tela nem estimar antes de aprovar. A tool também aceita `name:` direto,
sem passar o script.

**Orçamento.** `tokenBudget` na config, ou `budget` na chamada da tool, é um **teto duro** em tokens
de saída, medidos pelo que o provider reporta — não uma estimativa sobre o texto. O passo que
cruzaria o teto falha em vez de rodar, então um laço escrito contra `remaining()` não passa do limite.
Sem teto, `budget.total` é `null` e `remaining()` é `Infinity` — laços precisam checar `total` antes:

```js
while (budget.total && budget.remaining() > 50_000) {
  achados.push(...(await agent('Ache mais bugs', { schema: BUGS })).bugs)
}
```

```js
export const meta = { name: 'review', description: 'Revisa o diff por dimensão',
  phases: [{ title: 'Achar' }, { title: 'Verificar' }] }

phase('Achar')
const achados = await pipeline(
  ['bugs', 'segurança', 'testes'],
  d => agent(`Revise o diff olhando ${d}`, { phase: 'Achar', schema: ACHADOS }),
  r => parallel(r.itens.map(i => () =>
    agent(`Tente refutar: ${i.titulo}`, { phase: 'Verificar', schema: VEREDITO }))),
)
return achados.flat().filter(Boolean)
```

Cada execução grava o script e um journal em `~/.bytecode/workflows/<runId>.{js,jsonl}`.
`resumeFromRunId` reaproveita os passos cujo par (prompt, opts) não mudou — o casamento é por **id
da chamada + chave**, porque o journal é escrito em ordem de conclusão, que com concorrência não é a
ordem das chamadas. Subagentes nunca recebem a tool `Workflow` (sem recursão) — sub-workflow só pelo
`workflow()` de dentro do script, que compartilha os limites da rodada.

## Compactação de contexto

Quando o prompt chega perto do `limit.context` do modelo, o histórico antigo é substituído por um
resumo denso e a sessão continua.

```jsonc
"compaction": {
  "enabled": true,          // default
  "threshold": 0.85,        // fração da janela de contexto que dispara
  "keepRecentTurns": 4,     // turnos de usuário mantidos na íntegra
  "model": "selbetti-free/qwen36",  // opcional; default: smallModel, depois o modelo da sessão
  "maxOutputTokens": 4000
}
```

Invariante que não pode quebrar: **o corte acontece só imediatamente antes de um turno `user` real**.
Cortar no meio de um round-trip de tool deixaria um `tool-result` órfão, e o provider rejeita o
request inteiro. `findCutIndex` garante isso, com teste dedicado.

Outras salvaguardas:

- Se o resumo falhar (rede, provider, 401), **o histórico é preservado** e a compactação é reportada
  como pulada — nunca se perde contexto por causa de uma chamada que deu errado.
- Se o resumo não ficar menor que o trecho que substitui, a troca é abortada.
- `PreCompact` pode bloquear (exit 2 ou `decision: "block"`); `PostCompact` recebe
  `tokens_before`/`tokens_after`.
- Cada compactação vira um registro `compaction` no transcript, com o resumo e as contagens.
- Contagem de tokens usa o `inputTokens` reportado pelo provider como linha de base e só estima o
  que foi anexado depois — não é chute sobre a conversa inteira.
- O resumo é gerado por **streaming**; alguns proxies OpenAI-compatible respondem corpo não-JSON a
  requests sem `stream: true` (foi o caso do 9router aqui).

Na TUI: `/context` mostra o uso estimado, `/compact [foco]` compacta na hora.

## Prompt caching

Um loop agêntico reenvia o histórico inteiro a cada step. Com cache, esse prefixo custa ~10% do
input — o ganho mais barato que existe no design.

```jsonc
"cache": { "enabled": true, "ttl": "1h" }   // ttl opcional: "5m" (default do provider) ou "1h"
```

**Ligado sozinho** quando o provider é `@ai-sdk/anthropic`. Em qualquer outro, fica desligado a menos
que `enabled: true` — para proxy que fala o dialeto da Anthropic por trás de superfície
OpenAI-compatible (LiteLLM, OpenRouter). `enabled: false` desliga mesmo no Anthropic (cache write
custa 1,25×; a decisão é sua).

**Dois breakpoints, nunca mais:**

1. **fim do system prompt** — estável por sessão (cwd, modelo, modo), é o prefixo que sempre repete;
2. **fim do request** — o rolante: o cache que este step escreve é o prefixo que o próximo lê.

A Anthropic aceita quatro. Marcar cada mensagem escreveria quatro caches por step para ler um.

### Dois estilos, porque dois provider precisam de coisas diferentes

| estilo | quando | onde o marcador é escrito |
|---|---|---|
| `sdk` | `@ai-sdk/anthropic` | `providerOptions.anthropic.cacheControl`, carregado pelo AI SDK |
| `wire` | qualquer outro, com `enabled: true` | no **corpo do request**, por um `fetch` que embrulha o do provider (`src/provider/promptcache.ts`) |

O estilo `wire` existe porque o caminho pelo SDK **não funciona** ali: o
`@ai-sdk/openai-compatible` lê provider options só sob a chave `openaiCompatible`
(`dist/index.js:113`) e emite o system prompt como string pura (`dist/index.js:133`) — não há bloco
de conteúdo onde pendurar `cache_control`. `providerOptions.anthropic` era descartado em silêncio:
a flag ligava, o formato do request mudava e nada era cacheado. Agora o corpo sai com o marcador
dentro de uma parte de texto, que é a forma documentada por LiteLLM e OpenRouter:

```jsonc
{ "role": "system", "content": [{ "type": "text", "text": "…", "cache_control": { "type": "ephemeral" } }] }
```

Regra do módulo: nenhuma forma inesperada de corpo derruba a chamada. Corpo que não é JSON, forma sem
`messages`, mensagem sem nada marcável — tudo passa reto, sem reserializar.

O que a regra **não** cobre é o contrato do proxy: `cache_control` é extensão, e transformar
`content` de string em lista de partes é a forma que LiteLLM e OpenRouter documentam, mas não é
universal. Por isso é opt-in. Se o servidor à frente não aceitar, a falha é **imediata e barulhenta**
— o primeiro turno volta com 400 —, não silenciosa; desligue com `"cache": { "enabled": false }`.

Duas armadilhas que o código evita:

- No estilo `sdk` o system vira uma `SystemModelMessage` (única forma que carrega `providerOptions`).
  Enfiar um `role: 'system'` dentro de `messages` **derruba o turno**: o AI SDK v7 responde `System
  messages are not allowed in the prompt or messages fields`.
- `session.messages` não é mutado — o marcador é assunto de fio, não histórico; gravá-lo no
  transcript sujaria o resume.

**Como saber se rendeu**: `/leadtime` mostra `cache lido / escrito`. Para isso o provider precisa
reportar `usage`, e um servidor OpenAI-compatible só manda isso em stream se o request pedir — o
ByteCode passa `includeUsage: true` por padrão nesse pacote (`"options": { "includeUsage": false }`
desliga, para um proxy que rejeite o campo). Se o número vier zerado com
`enabled: true`, o proxy à frente não repassa `cache_control` — desligue. Prompt curto também não é
cacheável (mínimo de 1024 ou 4096 tokens, conforme o modelo): marcar não dá erro, só não rende.

## ByteCode não depende do opencode

**Nenhum arquivo do opencode é lido por padrão.** O que o ByteCode pegou emprestado do opencode é a
*forma* da camada de provider (pacotes AI SDK por npm, refs `provider/model`, catálogo models.dev) —
não os arquivos dele, e não o binário. O opencode não precisa estar instalado.

Estrutura própria:

| | caminho |
|---|---|
| config do usuário | `~/.config/bytecode/bytecode.jsonc` |
| config do projeto | `<repo>/bytecode.jsonc`, `.bytecode/bytecode.local.jsonc` |
| credenciais | `~/.bytecode/auth.json` (chmod 600) |
| sessões e transcripts | `~/.bytecode/projects/` |
| workflows | `~/.bytecode/workflows/` |

**`bytecode setup`** cria essa estrutura. Copia da estrutura legada (`~/.hx`, `~/.config/hx`) quando
existe, é idempotente, e **não move nada** — o caminho antigo continua legível.

O opencode entra só de duas formas, ambas explícitas:

- **`bytecode import`** copia as *definições de provider* do `opencode.jsonc` para a config própria.
  Uma vez, com data. Depois disso a config é sua.
- **`bytecode setup --import-opencode`** copia as *credenciais* do store do opencode para
  `~/.bytecode/auth.json`. Também uma vez.
- **`"openCodeAuth": true`** é o único jeito de ler o store do opencode **em tempo de execução**.
  Desligado por padrão.

### `bytecode doctor`

Perguntado "onde fica o auth.json que o bytecode lê?", um modelo rodou `find` no home, achou o
arquivo do opencode e concluiu que o ByteCode roda sobre o backend dele. **Não roda.** Uma varredura
de disco não distingue arquivo ignorado de arquivo usado — só a ordem de resolução distingue, então
`doctor` imprime ela:

```
Arquivos, na ordem em que são lidos:
  [usado]     ~/.config/bytecode/bytecode.jsonc      config do usuário (própria)
  [vazio]     ~/.config/hx/hx.jsonc                  config legada (fallback)
  [usado]     ~/.bytecode/auth.json                  credenciais do ByteCode
  [IGNORADO]  ~/.local/share/opencode/auth.json      openCodeAuth não está ligado

De onde vem a credencial de cada provider:
  9router            env     $ROUTER_API_KEY
  selbetti           store   ~/.bytecode/auth.json
  anthropic          none    nenhuma credencial resolvida
```

`store`/`env`/`config`/`none` espelham exatamente a ordem que o registry usa. **Nenhum segredo é
impresso** — só o nome da variável ou o caminho do arquivo. Também avisa chave em texto puro na
config e estado ainda no diretório antigo.

## Rename de `hx` para `bytecode`

Tudo foi renomeado, e **nada foi movido**. Cada lookup tenta o nome novo e cai no antigo:

| o que | novo | antigo, ainda lido |
|---|---|---|
| comando | `bytecode` (e `bc`) | — |
| config | `bytecode.jsonc` · `.bytecode/` | `hx.jsonc` · `.hx/` |
| config do usuário | `~/.config/bytecode/` | `~/.config/hx/` |
| credenciais, sessões, workflows | `~/.bytecode/` | `~/.hx/` |
| env | `BYTECODE_CONFIG`, `BYTECODE_RG`, `BYTECODE_BASH`, `BYTECODE_ASCII`, … | `HX_*` equivalentes |
| instruções | `BYTECODE.md` | `HX.md` |
| hook template | `${BYTECODE_PROJECT_DIR}` | `${HX_PROJECT_DIR}`, `${CLAUDE_PROJECT_DIR}` |

O diretório de estado é o ponto delicado: ele guarda `auth.json` (chaves de API) e as sessões
salvas. A regra é **escreve no novo, lê do antigo**:

- toda escrita vai para `~/.bytecode/` — sempre, sem exceção
- toda leitura procura em `~/.bytecode/` e depois em `~/.hx/`
- em conflito (mesmo provider ou mesma sessão nos dois), o novo vence — é onde se escreve
- nada é movido: `~/.hx/` continua intacto até você decidir

Uma versão anterior fazia o contrário — "se `~/.hx` existe, continua usando `~/.hx`" — e o efeito era
que **o rename nunca acontecia de fato**: `connect` gravava no diretório antigo para sempre. Toda a
lógica está em `src/util/paths.ts`.

`bytecode setup` termina a migração: copia o que falta de `~/.hx` para `~/.bytecode`, **mescla** em
vez de sobrescrever (uma credencial já presente no novo é mantida), e rodar duas vezes não muda nada.

## Tela inicial: chat no centro, sessões numa janela à direita

Ao abrir, o layout é diferente do da conversa: header em cima na largura toda, o conteúdo no
**centro** da coluna esquerda, e as sessões numa **janela desenhada à direita** com busca.

```
█▀▄ █ █ ▀█▀ █▀▀ ▄▀▀ ▄▀▄ █▀▄ █▀▀   v0.1 · multi-provider agent harness
█▀▄ ▀▄▀  █  █▀▀ █   █ █ █ █ █▀▀   9router/sonnet5 · 1000k ctx
█▄▀  █   █  █▄▄ ▀▄▄ ▀▄▀ █▄▀ █▄▄   C:\Repositories\harness  ⎇ main

    compact   em 85% da janela          ╭─ sessões ───────────────────────────╮
    assets    27 skills · 26 agents     │ ❯ retry                     7 de 30 │
    mcp       ● everything 13 tools     │ ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ │
                                        │ ❯ #bbbbbbbb retry do loop  2t · agora│
    digite / para comandos              │   #aaaaaaaa backoff        1t · ontem│
                                        │ ▏ ↑↓ navega · enter abre             │
                                        ╰──────────────────────────────────────╯
  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯ retry                                                                  │
  ╰──────────────────────────────────────────────────────────────────────────╯
```

O que está carregado (`compact`, `assets`, `mcp`) fica **ancorado no topo**, encostado no wordmark —
não flutuando no meio de uma tela vazia. A janela ocupa ~42% da largura (44–72 colunas), e a coluna
de data tem largura fixa, então só o título é cortado: `há 37 m…` não diz nada a ninguém.

**A busca é um campo próprio**, aberto com `ctrl+f`. Antes ela era o próprio composer — e o resultado
era que **uma tecla aparecia em dois lugares ao mesmo tempo**, com a tela parecendo ter dois campos
de input. Agora exatamente uma coisa tem cursor a cada momento:

| tecla | |
|---|---|
| digitar | vai **só** para o composer; a lista não é filtrada |
| `ctrl+f` | abre a busca — daí em diante as teclas vão só para ela |
| `↑↓` | navega a lista (filtrada, se a busca estiver aberta) |
| `enter` | abre a sessão destacada; na busca sem destaque, abre a primeira |
| `esc` | fecha a busca e devolve o teclado ao composer |
| clique | abre a sessão daquela linha |

O cursor do composer fica quieto enquanto a busca está aberta, então nunca há dois piscando.

Abaixo de 92 colunas não há espaço para a janela lateral: a lista vai para baixo do conteúdo, em
largura cheia. Notices e erros disparados antes da primeira mensagem (`/theme`, `/width`, uma
permissão negada) aparecem na coluna esquerda — a tela inicial não engole o retorno dos próprios
comandos dela.

Depois da primeira mensagem, ou ao abrir uma sessão, a tela inicial sai e o layout de conversa
assume. `/sessions` traz ela de volta.

## Fonte

**Um TUI não escolhe a própria fonte** — quem decide é o emulador de terminal. A spec HTML pede
JetBrains Mono (400/500/700) com fallback `ui-monospace, monospace`; aqui isso é uma configuração
sua:

- Windows Terminal → Settings → Profile → Appearance → Font face → `JetBrains Mono`
- iTerm2/Terminal.app → Preferences → Profiles → Text → Font
- VS Code → `"terminal.integrated.fontFamily": "JetBrains Mono"`

O que o harness faz é ser verificável: **`/font`** imprime cada grupo de glifos que o design usa
(moldura, trilhos, estado, prompt, spinner braille, sparkline, wordmark). Se algum sair como caixa
vazia, a fonte não cobre ele — e `BYTECODE_ASCII=1` troca o conjunto inteiro por ASCII puro.

Sobre "texto menor fora do quadro": um terminal tem **uma única altura de célula**, então tamanho
de fonte variável não existe. A hierarquia que a spec expressa com corpo menor sai aqui como peso
de cor — `bright` → `fg` → `dim` → `faint`.

## Markdown e diff no terminal

A resposta do modelo passa por um renderer próprio, não é despejada crua.

**Tabela.** Antes o markdown de tabela caía no wrap de texto: os `|` apareciam, a linha `|---|`
aparecia, e cada linha quebrava no meio. Agora vira coluna de verdade:

```
provider  │ modelo             │  janela │ custo in │ custo out
──────────┼────────────────────┼─────────┼──────────┼──────────
anthropic │ claude-opus-5      │ 1000000 │     5.00 │     25.00
9router   │ cc/claude-sonnet-5 │ 1000000 │     3.00 │     15.00
```

- Largura por coluna, encolhendo **a mais larga** primeiro. Escala proporcional foi testada e é
  pior: come as colunas curtas (`12` virando `1…`) enquanto a coluna de texto continua sem caber.
- Célula que não cabe **quebra em várias linhas**; nada de `…` no meio do único dado que importava.
  Quando alguma linha quebra, entra um separador fino entre linhas — sem isso elas se misturam.
- Alinhamento do markdown (`:--`, `--:`, `:-:`) respeitado; coluna sem alinhamento declarado e só com
  número vai para a direita sozinha.
- `\|` escapado é conteúdo, não coluna nova — tabela de regex ou de pipeline sobrevive.
- **Estreito demais vira registro**, com rótulo por campo, em vez de picar `provider` em `provid/er`:

```
▌ anthropic
  modelo     claude-opus-5
  janela     1000000
```

  O gatilho olha a maior **palavra indivisível** de cada coluna, não a largura total: texto longo o
  wrap resolve, palavra maior que a coluna não.

Também entraram: lista ordenada com recuo pendurado, `- [x]`/`- [ ]` com ✔/○, `---` virando régua,
`*ênfase*`, `~~riscado~~` e `[texto](url)` com a URL visível (terminal não tem hover). `_` **não** é
ênfase — `tool_input` e `__init__` ficariam picados no meio.

**Diff.** Layout de editor: cabeçalho com o arquivo, faixa por hunk, numeração dos **dois** lados e
banda cobrindo a linha inteira.

```
─── BoletoService.java ──────────────────────────────────
─── 1,26 ──> 1,39 public class BoletoService ────────────
   1    1   package com.confesol.service;
        3 + import java.math.BigDecimal;
  21      -     public void cancelar(Long id) {
       32 +     public void cancelar(Long id, String motivo) {
```

Vale para os três lugares onde um diff aparece: preview de tool, **bloco de código na resposta**
(```` ```diff ````, ou qualquer cerca cujo conteúdo tenha `@@ -1,9 +1,12 @@` / `diff --git`) e diff
colado solto no texto. Era o buraco mais visível: o modelo rodava `git diff` e colava a saída, que
saía como código cinza atrás de um trilho — sem número, sem cor, sem banda.

**`ctrl+y` alterna agrupado ↔ lado a lado**, e **clicar no `ctrl+y` da régua** faz o mesmo. O alvo do
clique é o rótulo, não o bloco: tratar "o bloco tem um diff" como alvo fazia um clique em qualquer
linha de uma resposta longa — prosa inclusive — remontar o diff sem ninguém ter pedido. Lado a lado precisa de 72 colunas; abaixo
disso o pedido cai para agrupado em vez de renderizar duas colunas mais estreitas que o código.

```
   1   package com.confesol.service;   │   1   package com.confesol.service;
   7 -     private final Repo repo;    │   8 +     private final BoletoRepository repository;
```

Cada coluna numera o **seu** arquivo: a esquerda é o antes, a direita é o depois, então uma linha de
contexto legitimamente carrega dois números diferentes. Remoções e adições são pareadas para que as
duas versões da mesma linha fiquem na mesma altura.

Cores como as de uma ferramenta de review: banda **pastel clara com texto escuro** só na linha
alterada — contexto fica no fundo do terminal —, e o trecho que mudou recebe um pastel mais forte.
24 bits quando o terminal aceita, senão os pastéis do cubo 256 (194/224). A primeira versão usava
verde e vermelho escuros saturados (xterm 22/52) e, atrás de código, aquilo lê como marca-texto.

- `index`, `---`, `+++` somem: o caminho já está no cabeçalho.
- **Realce dentro da linha**: num par de uma removida com uma adicionada, prefixo e sufixo comuns
  ficam na cor da linha e só o trecho que mudou vai a bright+bold. Bloco de 1 removida com 2
  adicionadas é reescrita, não edição — aí não há realce para inventar.
- Quebra de linha longa **preserva a indentação** e pendura a continuação sob o código. O `wrap()`
  de texto não serve aqui: ele remonta a linha a partir das palavras e destrói o recuo, que é
  justamente o que se usa para ler código.
- A banda reabre o fundo depois de cada reset ANSI. Sem isso ela parava na primeira cor da linha e o
  `+` virava uma canaleta verde com o código sem cor ao lado.

## Alterações da sessão: `ctrl+g`

Tudo que `Write` e `Edit` tocaram, numa tela só: **arquivos à esquerda agrupados pelo caminho, diff do
selecionado à direita**.

```
▌ alterações · 3 arquivos   ↑↓ arquivo ▏ ctrl+y layout ▏ r desfaz ▏ esc volta
────────────────────────────────────────────────────────────────────────
src/core            │ ─── src/core/loop.ts ──── ctrl+y lado a lado ─────
❯ loop.ts   +12 -3  │ ─── 448,6 ──> 448,9 ─────────────────────────────
  cache.ts  +68 -0  │   448  448   const usage = await result.usage
src/tui             │        449 + const policy = cachePolicy(session)
  render.ts +9 -2   │   449  450   session.emit({ type: 'usage' })
```

- **Diff da sessão inteira, não do último edit.** O conteúdo anterior é gravado na **primeira** vez
  que o arquivo é tocado; cinco edições no mesmo arquivo continuam sendo uma alteração para revisar.
- `↑↓` troca de arquivo, `ctrl+y` alterna agrupado ↔ lado a lado ali dentro, `r` desfaz o arquivo
  selecionado (com confirmação — ver [Desfazer](#desfazer-ctrlg-e-a-tecla-r)), `esc` volta.
  `/changes` e `/rewind` abrem a mesma tela.
- A status bar ganha `ctrl+g alterações(3)` — só quando existe alteração, senão seria mais um número
  disputando espaço sem ter o que dizer.
- Escrita feita **dentro de um subagent** aparece aqui, com o nome do agente ao lado do arquivo
  (`nota.md  dispatcher +9 -0`). O registro fica na sessão raiz — que é a janela que o usuário tem
  aberta — e a origem só é impressa quando não é a sessão principal, senão seria uma coluna repetindo
  `main`. Arquivo tocado pelos dois lista os dois.

**Entrar não interrompe nada.** É uma *view* sobre a sessão, como o visualizador de subagent: o turno
continua rodando, os subagents continuam trabalhando, o contexto não é tocado e nenhuma mensagem é
gravada. Sair é `esc` e a conversa está onde estava.

O diff é gerado aqui, não por `git`: prefixo e sufixo comuns são cortados e o miolo passa por um LCS,
que é barato porque uma edição mexe em poucas linhas de um arquivo quase idêntico. Acima de 1500
linhas no miolo o bloco vira "remove tudo, insere tudo" — uma tabela quadrática sobre um arquivo de
20 mil linhas travaria a UI, e ninguém lê um diff desse tamanho linha a linha.

## Agentes primary: `tab` troca quem está no volante

Como no opencode. `tab` cicla entre **build** (o comportamento padrão do harness) e todo agente que
declare `mode: primary` no frontmatter. A status bar mostra o atalho ao lado do valor que ele muda:

```
shift+tab ask ▏ tab dispatcher ▏ ctrl+t tasks(5) ▏ ctx 12%                /help
```

Cada atalho fica ao lado do que ele muda ou abre — mais barato que procurar em `/help`.

`/agent` abre um picker, `/agent <nome>` vai direto, `/agent build` sai. Trocar de agente:

- substitui o **prompt de sistema** (entra como `# Active agent: <nome>`, não no turno do usuário —
  então trocar no meio da sessão muda o comportamento da próxima chamada sem reescrever histórico)
- segue o **`model:`** do agente, e restaura o modelo anterior ao sair
- reconstrói o **tool set** quando o agente declara `tools:`
- sobrepõe as **permissões** do agente

O `tab` só cicla agente quando o popup de comandos está fechado; com ele aberto, `tab` continua
completando.

### Lendo `.opencode/` sem conversão

Agents são descobertos em `.claude/agents`, `.bytecode/agents`, `.hx/agents` **e `.opencode/agents`**
(mais `agent/` no singular, que é como o opencode documenta) — no home e no projeto. Nada é copiado
nem convertido. Nesta máquina, `C:\Repositories\Cobrança\.opencode\agents` dá 36 agents, 3 deles
`primary`: `dispatcher`, `lean`, `technical-writer`.

O bloco `permission:` do opencode é traduzido para as regras deste harness:

```yaml
permission:
  edit: allow                                  # -> Edit(*) allow
  task: deny                                   # -> Agent(*) deny   (task = subagente no opencode)
  bash:
    "powershell -Command \"Get-Date*\"": allow # -> Bash(...) e PowerShell(...) allow
    "*": ask                                   # -> Bash(*) e PowerShell(*) ask
```

Nomes de tool são mapeados por tabela (`task`→`Agent`, `todowrite`→`TodoWrite`, `patch`/`multiedit`
→`Edit`, `list`→`LS`, …); um nome desconhecido vira uma regra inerte em vez de um palpite.

**As regras do agente ficam por cima, não ao lado.** Unir as duas listas não funcionava: um
`edit: allow` do agente ficava lado a lado com um `ask` da config para a mesma tool e, como `ask`
vence `allow`, a regra do agente nunca valia — que é justo o motivo de ela existir. A ordem é:
`deny` da config (guardrail duro) → regras do agente → regras da config.

## MCP: `ctrl+p`, e `/context-all` para o resto

`ctrl+p` (ou `/mcp`) abre um modal com os servidores MCP: estado, quantas tools cada um expõe, se
tem resources, o erro quando falhou, e quantos chars de `instructions` ele injeta no contexto. A
status bar mostra `ctrl+p mcp(2)` — verde quando todos conectaram, amarelo em `mcp(1/2)`.

> Não é `ctrl+m`: o terminal manda `0x0D` para ele, indistinguível de Enter.

**`/context-all`** responde "cheio de quê" — `/context` só responde "quão cheio". Saída real deste
repo, com o projeto Cobrança como cwd:

```
| modelo | 9router/sonnet5 |
| janela | 1.000.000 tokens |
| em uso | 0 · 0% ░░░░░░░░░░░░░░░░░░░░ |
| origem | estimado (nenhuma chamada ainda) |
| agente | build |

## setup — 8.815 tokens
| system           | prompt base do harness |   330 |
| instruções       | no próximo turno       | 2.256 |
| roster de agents | no próximo turno       | 3.671 |
| roster de skills | no próximo turno       | 2.502 |
| ambiente         | no próximo turno       |    56 |

## tools — 12 ativas, 0 deferred
## mcp — 0/0 conectados
## assets — 30 skills, 36 agents, 3 primary
**primary** (tab cicla) `dispatcher` → selbetti/sonnet · `lean` · `technical-writer`
```

Mostra também a conversa quebrada por papel, as tools deferred (só o nome está no contexto), e se o
total é **medido** pelo provider ou estimado. Serve para responder coisas como "por que 8.8k tokens
antes de eu falar nada" — nesta máquina, 3.671 deles são o roster de 36 agents.

## Tasks: `ctrl+t`

O modelo quebra o trabalho com `TodoWrite`; as tasks ficam visíveis em dois lugares:

- **status bar**: `ctrl+t tasks(5)` — o atalho junto do contador, ao lado do agente. Amarelo enquanto
  houver task aberta, verde quando todas fecham, e `tasks(0)` em faint antes de existir alguma (o
  atalho aparece de qualquer jeito, senão ninguém descobre que ele existe)
- **`ctrl+t`** abre o modal com a lista — `✔` concluída, spinner na que está em andamento, `○`
  pendente. `esc` ou `ctrl+t` fecha. `/tasks` faz o mesmo.

**Task escrita dentro de um subagent conta também.** O estado é agrupado na sessão **raiz**, por autor
(`main`, ou o nome do agente), e o cabeçalho de autor só aparece quando há mais de uma lista — duas
listas concatenadas leriam como um plano só com progresso contraditório. Antes o estado ficava preso na
`Session` filha: as tasks apareciam no transcript e o `ctrl+t` ficava vazio.

## Sessões: voltar para a mesma conversa

O transcript JSONL é append-only e serve para auditoria. Retomar precisa do
`ModelMessage[]` **exato** que o provider viu, com os ids de tool-call intactos — reconstruir isso
da projeção do transcript orfanaria `tool_result`s e o provider rejeitaria o request. Então cada
sessão grava, ao fim de cada turno, dois arquivos ao lado do `.jsonl`:

| arquivo | conteúdo |
|---|---|
| `<id>.state.json` | o array de mensagens completo (escrito em temp + rename) |
| `<id>.meta.json` | resumo pequeno: título, turnos, `updatedAt`, modelo |

Arquivos por sessão, não um índice compartilhado: duas instâncias de `bytecode` no mesmo projeto
disputariam um único arquivo e apagariam a entrada uma da outra.

O título sai da primeira mensagem do usuário, **sem** os blocos do harness — `<system-reminder>`,
`<command-args>` e afins são removidos, senão todo título seria o roster de skills.

**Tela inicial** — ao abrir, o composer já está pronto e as últimas 6 sessões aparecem listadas com
id curto, número de turnos e quando foram usadas (`agora`, `há 12 min`, `hoje 14:32`, `ontem 09:11`,
`11 mar`, `02/12/2025`):

```
  sessões recentes · 3                      ↑↓ navega · enter abre · clique também
❯ #bbbbbbbb  conversa nova sobre seleção            2 turnos  ·  hoje 15:04
  #aaaaaaaa  conversa antiga sobre retry            1 turno   ·  ontem 22:41
```

`↑↓` navega e `enter` abre **só enquanto o composer está vazio** — no instante em que você digita,
as setas e o Enter voltam a ser do prompt, então nunca se reabre uma conversa antiga por engano.
`esc` desmarca. Clicar numa linha abre também (o clique casa o `#id` no texto da linha, então não há
mapa de coordenadas para dessincronizar).

- `/sessions` traz a lista de volta a qualquer momento · `/resume [#id]` abre direto.
- `bytecode sessions` lista no terminal · `bytecode --continue` retoma a última · `bytecode --resume [#id]` escolhe.
- Prefixo de 8 caracteres basta; um prefixo ambíguo dá erro em vez de abrir a errada.

**O modo de permissão não é restaurado.** Voltar para uma sessão que estava em AUTO e reativar AUTO
sozinho seria uma escalação que o usuário não pediu — a sessão retomada usa o modo atual, e a status
bar diz qual é.

Subagentes não geram sessão retomável: o contexto de um filho é rascunho do turno que o criou.

## Subagents: faixa abaixo do input, com sessão própria

As tool calls de um subagente **nunca** entram no transcript do pai. Um fan-out de dez agentes
enterraria a conversa que ele deveria servir. Enquanto rodam, aparecem numa faixa **abaixo do
composer** — o prompt fica parado enquanto agentes entram e saem, em vez de o input pular a cada um:

```
  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ❯ pergunte, cole um erro, ou / para comandos                              │
  ╰──────────────────────────────────────────────────────────────────────────╯
    subagents · 7 rodando, 1 pronto(s)                        +3 · ctrl+a foca
  ❯ ⠹ code-reviewer │ revisar o loop                  Grep · 12s · 1.4k ch
    ✔ test-engineer │ cobrir o retry                       pronto · 8s
```

Cada linha traz o tipo, o label (vem do `description` da chamada), a tool corrente, o tempo e o
tamanho da saída. Teto de 5 linhas; o excedente vira `+N`.

**Abrir a sessão de um subagente:**

| tecla | |
|---|---|
| `ctrl+a` | foca a faixa e anda por ela; ao passar do último, solta o foco |
| `↑↓` | move o foco dentro da faixa |
| `enter` | abre a sessão do agente focado, em lugar do transcript principal |
| `esc` ou `ctrl+a` | volta para a sessão principal |

A sessão do agente é renderizada com **o mesmo block renderer** da principal — as tools dele
expandem com `ctrl+r`, o texto sai formatado, tudo igual. Isso sai de graça porque o filho encaminha
os próprios eventos (`agent-event`) em vez de um resumo.

**Rodando fica só na faixa; terminado vai para o transcript.** Enquanto roda, o subagente **não**
gera linha na conversa — a faixa já mostra, e duas linhas diziam a mesma coisa. Ao terminar ele sai
da faixa e ganha a linha no transcript:

```
● Agent(code-reviewer)
  └ 12 linhas · clique para abrir a sessão
```

Clicar nessa linha abre a sessão do agente — não expande um preview. Ler o que ele fez é a razão da
linha existir. Ela continua clicável **depois do fim do turno**, que é justo quando se quer ler;
os dados ficam guardados para os últimos 20 agentes da sessão. Agentes de workflow usam a mesma
faixa e o mesmo viewer.

**Modelo curto no frontmatter** — agent files escritos para o Claude Code dizem `model: opus`, não
`provider/model`. Isso estourava `model must be "provider/model", got "opus"` e **matava o subagente
na primeira chamada**. Agora um nome curto é casado contra os modelos configurados e, se nada casar,
cai no modelo da sessão em vez de falhar.

A busca começa **pelo provider da própria sessão**. Sem isso, `model: sonnet` ia para qualquer
provider que declarasse essa chave — então uma sessão rodando bem num endpoint gerava filhos que
**401 num outro**. Ordem: chave exata no provider da sessão → prefixo/id no provider da sessão →
exata em qualquer provider → prefixo/id em qualquer provider → modelo da sessão. Um `provider/model`
completo é sempre respeitado como está.

Na UI de linha (`--simple`), que não tem faixa nem viewer, o subagente ganha uma linha ao começar e
uma ao voltar — nunca o rastro de tools inteiro.

## Leadtime: quanto custou o turno

Cada turno é medido: duração, chamadas ao modelo, retries, tokens (entrada, saída, cache lido e
escrito) e uma linha por tool com número de chamadas, falhas e tempo somado. Custo em USD sai
quando o modelo declara `cost` na config — leitura de cache entra a 0.1x da tarifa de entrada e
escrita a 1.25x.

- `/leadtime` mostra o relatório do último turno.
- O fim de cada turno imprime a versão de uma linha: `6m 15s · 12 steps · ↑ 84k · ↓ 3.1k · $0.31`.
- Vai também para o transcript, como registro `leadtime`.

Subagentes e workflows sobem os números para o turno do pai, então o total cobre a árvore inteira.
O tempo por tool é **somado**: chamadas paralelas se sobrepõem, então a soma pode passar da duração
do turno.

## Resiliência a falha do provider

Uma falha de stream não mata mais o turno. O passo é repetido com backoff (1s, 2s, 4s), respeitando
`retry-after` / `retry-after-ms` quando o provider manda.

Só repete quando repetir pode dar certo:

- **Repete**: 429, 5xx, `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, timeouts do undici, `socket hang up`.
- **Não repete**: 4xx, `ENOTFOUND`, `ECONNREFUSED`, certificado inválido, contexto estourado — o
  mesmo request falharia igual.
- **Não repete** se qualquer texto já foi mostrado: o retry duplicaria a resposta na tela.
- **Não repete** depois de `esc` — o backoff acorda no abort.

O código de erro real vem da cadeia de `cause` (o `fetch failed` do undici esconde ele lá dentro).

## Comando em background: rodar a suíte sem parar a conversa

`Bash`/`PowerShell` aceitam `run_in_background: true` e voltam na hora com um id (`bash_1`).
`BashOutput({ bash_id })` lê o que apareceu **desde a última leitura**; `KillShell` para o job e
tudo que ele iniciou.

Quatro decisões que são o motivo do arquivo existir:

- **o job não herda o `AbortSignal` do turno.** É o que se passaria naturalmente (`Bash` já passa
  `ctx.signal`), e então um esc na conversa mataria a suíte de quinze minutos lançada nela. Um job
  em background só para com `KillShell` ou com o fim do processo;
- **leitura por cursor, não opção.** O resultado de uma tool é cortado em 30.000 caracteres, e num
  teste o pedaço que sumiria é o final — exatamente onde está o veredito;
- **buffer com teto que declara o que perdeu.** Sem timeout para limitá-lo, um `tail -f` cresceria
  sem fim. O buffer é um anel de 200.000 caracteres e a leitura diz `[dropped N chars from the
  head]` — perder o início de uma suíte em silêncio é como um verde vira vermelho;
- **`taskkill /T /F` no Windows.** `child.kill()` sinaliza só o filho direto: `powershell -Command
  npm test` deixaria `node.exe` rodando, e um `KillShell` que mente sobre ter matado é pior que não
  existir. E `killAllJobs` roda no teardown da TUI e no fim do headless, porque um filho vivo com
  stdio em pipe transforma "sair" em "travar" — para quem talvez nunca tenha usado a feature.

O job **não acorda o modelo** quando termina: ele avisa na tela, e o modelo consulta com
`BashOutput`. Reentrar no loop com o turno já encerrado exige alguém rodando fora do turno, e esse
alguém só existe na TUI — não no headless, não dentro de um subagent, não dentro de um workflow.
Polling funciona nos quatro. A colheita automática fica para quando valer os outros três.

## `WebFetch`: ler a rede sem virar porta de entrada

Busca uma URL e devolve o texto. HTML vira texto legível; JSON e texto puro voltam como estão; link
`github.com/.../blob/...` é buscado direto no raw. `kind: 'net'` — pede permissão por padrão, e é
**liberado no plan mode**, porque ler documentação é a maior parte de planejar.

A guarda anti-SSRF mora **dentro da tool**, nunca como regra de permissão. O motivo é concreto: as
regras casam a *string que o modelo escreveu*, então um `deny WebFetch(http://169.254.169.254/**)` é
contornado por `169.254.169.254.nip.io`, por IP decimal, por encurtador, ou por qualquer host
público cujo DNS aponte para dentro. E em `bypassPermissions` toda regra `ask` vira `allow`. Então:

- o host é **resolvido** e todos os endereços da resposta têm de ser públicos — loopback, 10/8,
  172.16/12, 192.168/16, CGNAT 100.64/10, link-local 169.254/16 (a metadata da nuvem), ULA `fc00::/7`,
  multicast e IPv4 mapeado em IPv6 são recusados;
- `redirect: 'manual'` com no máximo 5 hops e **revalidação a cada hop**. O veredito de permissão é
  calculado uma vez, com a URL do input, e nunca recalculado: seguir redirect automaticamente
  significaria aprovar um host e alcançar outro. A URL final vai no cabeçalho da resposta;
- só `http` e `https`; nenhum cabeçalho vindo do modelo (sem `Authorization`, sem cookie);
- teto de 2 MiB no corpo, ajustável em `web.maxBytes`;
- o texto vem precedido de um aviso de que é **dado, não instrução**. É mitigação, não garantia.

`"web": { "allowPrivateHosts": ["wiki.interno"] }` libera nome por nome — abrir a rede interna tem
de ser decisão explícita, como `inheritMcp`.

**Duas limitações ditas, não escondidas.** (1) A conversão HTML→texto não executa JavaScript e não
remove navegação ou rodapé: numa página que só existe com JS, o retorno é curto — que é a resposta
correta. Só as ~10 entidades nomeadas comuns são decodificadas (as numéricas, todas); uma rara fica
como veio, legível, em vez de virar caractere errado. (2) DNS rebinding continua aberto: a guarda
resolve o host, mas o `fetch` global resolve de novo por conta própria e o Node não expõe um
resolvedor customizado sem `undici`.

**Sintaxe de regra que pega**: `WebFetch(ruim.com:*)` **não** casa uma URL — `:*` é o idioma de
comando. Use `WebFetch(https://ruim.com/**)`. Um `*` sozinho não cruza `/`.

`WebSearch` não existe e não vai existir nativamente: um servidor MCP de busca dá o mesmo por 0
linhas aqui, com as mesmas permissões e hooks, e exigindo a mesma chave de API. Está em
`PENDENCIAS.md`, com o argumento.

## Subagents: resposta em JSON e continuação

**`schema` na tool `Agent`.** Com um JSON Schema no argumento, o subagente responde JSON e o
resultado volta parseado — o texto inteiro é o objeto, sem prosa em volta. Quando o modelo escreve
"Claro! Vou explicar antes" e só depois o JSON, um **turno de reparo** pede de novo, lendo só o
texto novo (o acumulador é append-only, e sem o offset o reparo devolveria a prosa da primeira
tentativa achando que deu certo). JSON acima de 28.000 chars vira erro explícito em vez de resultado:
o corte do loop anexaria `[truncated N chars]` e transformaria JSON válido em inválido do outro lado.

> Nota honesta: não existe validação contra o schema, nem aqui nem no `Workflow`, que sempre
> funcionou assim. O schema vai no prompt e a resposta passa por `JSON.parse`. Um validador foi
> considerado e descartado — está em `PENDENCIAS.md`, com o argumento.

**`AgentResume`.** O resultado de um `Agent` sem schema termina com `[agent_id: …]`. Passar esse id
para `AgentResume` faz a pergunta seguinte na **mesma** sessão, com tudo que ela leu e concluiu — em
vez de um agente novo repetindo a exploração inteira. Os 4 últimos ficam guardados; o mais antigo
sai; `/clear` zera.

## Orçamento de steps: o turno acaba com relatório, não com erro

Um turno faz no máximo `maxSteps` chamadas ao modelo (padrão **64**). Duas coisas acontecem no
caminho:

- em **75% do teto**, um `<system-reminder>` entra no histórico dizendo quantas chamadas já foram e
  mandando convergir: terminar a alteração em curso, dizer o que está feito e o que falta, e não
  começar nada novo;
- no teto, o turno **para com um aviso**, não com um erro. Nada falhou — o orçamento acabou. O
  histórico fica intacto, então `continue` no turno seguinte segue de onde parou.

Antes disso o turno morria em `stopped after 64 steps`, sem aviso prévio e sem caminho de volta: um
refactor longo perdia junto o resumo do que já tinha feito.

## Guarda de escrita: o agente não apaga o que você acabou de salvar

Dois acidentes silenciosos, os dois fechados:

1. **`Write` sobre arquivo que a sessão nunca leu.** `Write` substitui o arquivo inteiro; fazer isso
   com um arquivo que o modelo não viu descarta conteúdo que ele não sabe nomear. Recusado, com a
   instrução de ler antes.
2. **Escrita sobre arquivo alterado no disco depois da leitura.** Numa sessão longa o arquivo também
   está aberto no editor. Um salvamento lá move o arquivo debaixo do agente, e o `Edit` seguinte
   grava o conteúdo antigo por cima — sem erro, sem diff, o trabalho simplesmente some. Recusado
   para `Write` **e** para `Edit`, com "leia de novo".

O que **não** é bloqueado: `Edit` num arquivo não lido. Ele já falha alto quando erra o alvo
(`old_string not found`), então exigir leitura custaria um round trip para provar o que o match já
prova — e o modelo costuma ter a linha exata vinda de um `Grep`.

O escopo é a **raiz** da sessão: arquivo lido por um subagent conta como lido pela árvore, porque a
pergunta "alguém aqui olhou isso" tem uma resposta por workspace, não uma por contexto. `/clear`
esquece as leituras junto com o contexto. Desliga com `"fileGuard": false`.

## Desfazer: `ctrl+g` e a tecla `r`

A tela de alterações guarda o conteúdo de **antes da primeira escrita da sessão** em cada arquivo.
Com `r` sobre o arquivo selecionado, ele volta a esse estado — cinco edits são uma alteração para
desfazer, não cinco. Arquivo que a sessão criou é apagado. `/rewind` abre a mesma tela.

Escreve no disco, então pede confirmação nomeando o arquivo e dizendo qual dos dois vai acontecer
(restaurar ou apagar). E recusa se o arquivo mudou no disco depois da última escrita da sessão —
restaurar por cima disso seria exatamente o clobber que a guarda acima existe para impedir.

## Execução paralela de tools

Chamadas vizinhas do **mesmo grupo de concorrência** rodam juntas; o resto roda em série. O
agrupamento é por vizinhança, não pelo lote inteiro: um `Read` que o modelo emitiu depois de um
`Edit` continua rodando depois daquele `Edit` e enxerga a escrita. A ordem dos resultados devolvidos
ao modelo é sempre a ordem das chamadas.

| Grupo | Quem está nele | Teto |
|---|---|---|
| leitura (`parallelSafe`) | `Read`, `Grep`, `Glob`, `LS`, `ToolSearch`, tools MCP liberadas (ver abaixo) | sem teto |
| `agent` (`parallelGroup`) | `Agent` | `subagentConcurrency`, padrão `min(8, cpus−2)` |
| — | todo o resto (`Edit`, `Write`, `Bash`, `PowerShell`, `Workflow`, MCP sem anotação) | uma por vez |

Os dois grupos são separados de propósito: um subagente **escreve**, então não pode correr junto de
um `Read` emitido ao lado dele — mas quatro subagentes emitidos juntos são exatamente o fan-out que
foi pedido, e antes custavam quatro janelas em vez de uma. `"subagentConcurrency": 1` volta ao
comportamento antigo.

### MCP: `readOnlyHint` quase nunca vem

Uma tool MCP só entra no lote de leitura se o servidor declarar `annotations.readOnlyHint`. Essa
anotação é **opcional no protocolo** e a maioria dos servidores não preenche, então na prática todo
`list_*`/`get_*` roda um de cada vez. A saída é declarar na config, por servidor — quem configurou o
servidor é quem sabe se as tools dele podem se sobrepor:

```jsonc
"mcp": {
  "azure-devops": { "parallelSafe": true },                         // todas
  "outro":        { "parallelSafe": ["list_items", "get_item"] }    // só essas
}
```

O que o servidor declara continua valendo mesmo fora da lista.

Com subagentes concorrentes, dois pedidos de permissão podem chegar no mesmo instante. Eles entram
numa **fila** — a tela só mostra um, diz qual agente está pedindo e quantos esperam atrás. Sem a
fila, o segundo pedido sobrescrevia o modal do primeiro e o subagente que perguntou antes ficava
esperando para sempre.

## Assets: reaproveita o que já existe

Skills, agents, commands e instruções são lidos de **`.claude/` e `.hx/`**, no home e no projeto —
sem conversão. Nesta máquina isso significou, sem nenhum passo extra:

| Asset | Origem | Qtd |
|---|---|---|
| Skills (`<nome>/SKILL.md`) | `~/.claude/skills` | 27 |
| Agents (`<nome>.md`) | `~/.claude/agents` | 26 |
| Commands (`<nome>.md` → `/nome`) | `~/.claude/commands` | 13 |
| Instruções | `~/.claude/CLAUDE.md` + `CLAUDE.md` dos ancestrais | 2 |

Skills entram no contexto **só como `nome: description`**; o corpo do `SKILL.md` é carregado quando
o modelo chama `Skill(nome)` ou o usuário digita `/nome`.

### Commands: `/nome argumentos`

O corpo do arquivo vira a mensagem, envelopada em `<command-name>` / `<command-args>` como no Claude
Code. Subpasta vira namespace: `commands/git/pr.md` → `/git:pr`.

| no corpo | vira |
|---|---|
| `$ARGUMENTS` | tudo que veio depois do nome |
| `$1` … `$9` | os argumentos separados por espaço; ausente vira **vazio**, não fica `$2` na tela |

Frontmatter (todos opcionais):

```yaml
---
description: Analisa uma User Story        # aparece na lista do `/`
argument-hint: <numero-da-us>              # aparece ao lado do nome
model: sonnet                              # roda o turno noutro modelo
allowed-tools: Read, Grep, Glob            # restringe o roster do turno
---
```

`model:` e `allowed-tools:` valem **só naquele turno** e são desfeitos no `finally` — um `/revisar`
barato não pode deixar a próxima pergunta no modelo errado, nem sem as tools. `model:` aceita o nome
curto (`sonnet`), resolvido primeiro dentro do provider em que a sessão já está autenticada.

## Arquitetura

```
src/
  index.ts              CLI: init / setup / doctor / models / config / sessions / headless / TUI
  config/
    types.ts            modelo de configuração
    schema.ts           JSON Schema da config (bytecode schema escreve no disco)
    load.ts             precedência, JSONC, {env:} {file:}, nomes novos + legados
  core/
    session.ts          estado da sessão, modelo, assets, modo, agente primary, sessão filha
    loop.ts             loop agêntico: stream → tool_use → hooks → permissão → tool_result
    context.ts          system prompt + blocos <system-reminder>
    permissions.ts      matcher Tool(padrão), deny > ask > allow, modos
    compaction.ts       corte seguro do histórico + resumo + PreCompact/PostCompact
    hooks.ts            barramento de eventos com o contrato do Claude Code
    tools.ts            registro de tools + deferred + grupos de concorrência
    changes.ts          arquivos alterados na sessão, diff unificado e desfazer
    structured.ts       pedir JSON ao modelo e ler o que voltou (Agent e Workflow)
    filestate.ts        o que a sessão leu/escreveu; guarda contra escrita cega
    cache.ts            política de prompt caching (estilo sdk ou wire)
    transcript.ts       JSONL em árvore (parentUuid, isSidechain)
    sessions.ts         persistência e retomada (state.json + meta.json)
    leadtime.ts         métricas por turno: tempo, tools, tokens, custo
    contextreport.ts    /context-all: de que o contexto está cheio
    doctor.ts           quais arquivos são lidos, ignorados e por quê + setup
    reasoning.ts        filtro de <think> vindo no canal de conteúdo
    workflow.ts         orquestração multi-agente (script determinístico)
  provider/
    registry.ts         import dinâmico do pacote AI SDK, resolução provider/model, credenciais
    catalog.ts          models.dev: fetch + cache memoizado + busca + derivação
    auth.ts             ~/.bytecode/auth.json (gravação, listagem, máscara)
    connect.ts          fluxo /connect e /disconnect, reusável por CLI e TUI
    promptcache.ts      cache_control no corpo do request (provider OpenAI-compatible)
  assets/
    index.ts            descoberta em .claude/, .bytecode/, .hx/ e .opencode/
    frontmatter.ts      parser mínimo de YAML front-matter
    jobs.ts             comandos em background: buffer com teto, kill em árvore
  tools/web.ts          WebFetch: guarda anti-SSRF, redirect revalidado, html→texto
  mcp/client.ts         stdio + StreamableHTTP + SSE, tools deferred, resources
  tools/                fs (Read/Write/Edit/LS/Glob/Grep)
                        shell (Bash/PowerShell/BashOutput/KillShell)
                        meta (Agent/AgentResume/Skill/ToolSearch/TodoWrite)
                        web (WebFetch), workflow
  tui/
    fullscreen.ts       UI full-screen: raw mode, viewport, composer, modais, seleção
    render.ts           wrap ANSI-aware, markdown, diff, box, oneLine
    theme.ts            tokens de cor, presets, glifos, degradação
    app.ts              UI de linha (fallback para pipe/redirect e --simple)
    prompt.ts           readline com input mascarado
    ansi.ts             sequências e símbolos básicos
  util/
    paths.ts            nomes e caminhos (novo + legado), env BYTECODE_*/HX_*
    binaries.ts         descoberta de ripgrep e bash por PATH/env
    clipboard.ts        clip / pbcopy / wl-copy / xclip / xsel
    fs.ts               helpers de leitura, slug de cwd, BOM
    error.ts            mensagem de erro de uma linha, acionável

test/
  helpers.ts            SRC/ROOT/fixtures derivados de import.meta.url, config por env
  run.mjs               runner: um processo por suíte, agrega o resultado
  *.test.ts             as 24 suítes
  fixtures/             providers simulados + assets de agent
```

O loop é dirigido pelo harness, não pelo AI SDK: as tools são declaradas **sem `execute`**, então
`streamText` para depois de emitir as chamadas e devolve o controle. É esse ponto que abre espaço
para hooks, gate de permissão e escrita no transcript entre a chamada e a execução.

## Paridade com o Claude Code

| Peça | Status |
|---|---|
| Loop agêntico + tool calls paralelas | ✅ |
| Camada multi-provider (AI SDK, npm dinâmico) | ✅ (supera o original) |
| Permissões `Tool(padrão)`, deny > ask > allow, 5 modos | ✅ |
| Hooks com contrato stdin/exit-code/JSON | ✅ 15 eventos dos 30 |
| Skills com progressive disclosure | ✅ |
| Subagents com tool set restrito + profundidade | ✅ |
| Deferred tools + `ToolSearch` | ✅ |
| Transcript JSONL em árvore | ✅ |
| Slash commands de disco (frontmatter, `$1..$9`, namespace) | ✅ |
| Prompt caching (breakpoint no system + rolante) | ✅ |
| TUI full-screen (alt-screen, viewport, composer, modais) | ✅ |
| `/connect` multi-provider via catálogo models.dev | ✅ (não existe no Claude Code) |
| MCP (stdio + HTTP, tools/resources/instructions, deferred) | ✅ |
| Herdar/importar MCP do opencode e do Claude Code | ✅ (não existe no Claude Code) |
| Compactação de contexto (auto + `/compact`, PreCompact/PostCompact) | ✅ |
| Plugins/marketplaces | ❌ ainda não |
| Background tasks / workflows | ❌ ainda não |

Hooks implementados (15 dos 30): `SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`,
`PostToolUse`, `PostToolUseFailure`, `PostToolBatch`, `PermissionRequest`, `PermissionDenied`,
`Notification`, `Stop`, `SubagentStart`, `SubagentStop`, `PreCompact`, `PostCompact`.

Os três de permissão:

| evento | quando | o que pode fazer |
|---|---|---|
| `PermissionRequest` | a regra deu `ask`, **antes** do modal aparecer | responder pelo usuário com `hookSpecificOutput.permissionDecision` (`allow`/`deny`) |
| `Notification` | o turno vai mesmo parar e esperar gente | notificar (desktop, som, webhook) — recebe `message` |
| `PermissionDenied` | qualquer recusa | auditar; `source` diz quem recusou: `policy`, `hook` ou `user` |

`Notification` só dispara quando o modal vai realmente aparecer: se um `PermissionRequest` já
decidiu, ninguém foi interrompido e notificar seria mentira.

## Verificação

```bash
npm test          # 24 suítes, 1324 asserções, um processo por suíte
npm run typecheck # tsc --noEmit
npm run check     # os dois
npm test tui      # filtra por nome
npm test -- --verbose
```

As suítes vivem em `test/` e não dependem de nenhum caminho absoluto: `SRC`, `ROOT` e as fixtures
saem de `import.meta.url`, e a config de cada suíte é montada em JS e injetada por
`BYTECODE_CONFIG_CONTENT` — o campo `npm` do provider precisa de uma URL absoluta para o mock, que só
existe em runtime. Cada suíte roda em **processo próprio**: várias leem env no import (nível de cor,
ASCII, HOME), trocam `process.stdout.write` ou tomam o stdin em raw mode.

Nada toca no estado real: `dataDir` e `HOME` apontam para `node_modules/.bytecode-test/<suíte>`, e
`BYTECODE_FAKE_CLIPBOARD=1` impede que um teste sobrescreva a área de transferência.

Executado nesta máquina:

- `tsc --noEmit` limpo.
- `bytecode init` importou 3 providers do `~/.config/opencode/opencode.jsonc`; `bytecode models` lista 9 refs.
- Carga de assets: 27 skills, 26 agents, 13 commands, 2 arquivos de instrução.
- Motor de permissões: `Read(.../y.ts)`→allow, `Read(.../.env)`→deny, `Bash(rm -rf /)`→deny,
  `Bash(git status)`→ask, `Write(...)`→ask.
- Tools `Glob` e `Grep` executadas de verdade; `ToolSearch select:Bash` carregou uma tool deferred.
- System prompt 1.300 chars + 4 blocos de bootstrap (~25 KB).
- **MCP contra o servidor oficial `@modelcontextprotocol/server-everything` (stdio, npx no Windows):**
  13 tools + 2 de resources descobertas e registradas deferred; `readOnlyHint` mapeado
  (`echo`→read→allow, `gzip-file-as-resource`→exec→ask); `ToolSearch select:mcp__everything__echo`
  ativou a tool; chamadas reais `echo` → `"Echo: hx works"` e `get-sum(40,2)` → `"The sum of 40 and 2 is 42."`;
  `list_resources`/`read_resource` leram `demo://resource/static/document/architecture.md`;
  erro do servidor (`MCP error -32602`) chegou como `isError: true`; bloco de instructions injetado
  (1.726 chars); `close()` limpo, exit 0.

### Verificação ao vivo (9router / `cc/claude-sonnet-5`)

- **Texto**: `hx -p "Responda exatamente: OK"` → `OK`.
- **Loop de tool completo**: `hx -p "Use Glob com pattern src/**/*.ts e responda so o numero."` →
  `[Glob] glob src/**/*.ts` executado, `tool_result` devolvido, segunda chamada ao modelo, resposta
  numérica. (O Glob devolveu a contagem correta, conferida contra `Get-ChildItem`; o modelo errou
  por um na soma — comportamento do modelo, não do harness.)
- **Compactação automática**: com `limit.context` de 12.000 e threshold 0,5, disparou em ~6.267
  tokens e **recusou cortar** — só havia um turno de usuário, logo não existia ponto seguro.
  Comportamento correto: seguiu sem compactar em vez de orfanar tool results.
- **Compactação com histórico grande**: `5.659 → 371 tokens`, 10 → 5 mensagens, resumo real
  preservando decisões (inclusive a de não usar o MCP do Azure DevOps por PAT comprometido).
- **Suite de compactação**: 29 asserções, todas passando (corte seguro para keep=1/2/3/4/10,
  contabilidade de tokens, threshold, sucesso, falha preservando histórico, bloqueio por PreCompact).
- **`/connect`**: catálogo baixado (174 providers), `connect groq --key ...` gravou credencial
  mascarada em `~/.bytecode/auth.json`, `bytecode models` passou a listar `groq/*` **derivado do catálogo sem
  nenhuma edição de config**, `disconnect` removeu. Aviso correto de pacote AI SDK ausente.
- **Render da TUI**: 14 asserções (largura ANSI-aware, wrap, truncate, markdown, diff, box).
- **Ciclo de modo por Shift+Tab** (14 asserções dentro da suite da TUI): `ask -> plan -> AUTO -> ask`,
  Alt+M idem, status bar refletindo cada um, e o efeito real no motor de permissões —
  `default` pergunta no Bash, `plan` nega, `AUTO` permite, e **`AUTO` continua negando `rm -rf /`**.
- **Fidelidade ao design** (TTY simulado, 53 asserções): índices 256 corretos por token
  (173/109/179/167/139, bg 236, seleção 237), coluna centrada, splash com wordmark, box-drawing sem
  ASCII, popup sem borda própria, rail `▌` do usuário, modal de permissão âmbar com comando
  destacado e regra citada, picker teal com filtro e contador, `ctrl+r` expandindo a tool, divisor
  de compactação em magenta.
- **Workflows** (52 asserções, `workflowprobe`, provider simulado): `meta` lido sem executar o
  script (e recusado quando não é literal puro); **tool ausente por padrão**, presente com
  `enabled`, `kind: exec` (pede permissão), e **nunca** entregue a subagente; `parallel` de 3,
  `pipeline` de 2 itens × 2 estágios, passo com `schema` devolvendo objeto — 8 agentes ao todo;
  `maxConcurrency: 3` respeitado (pico medido no provider); journal com uma entrada por agente;
  **resume não chama o modelo de novo** e devolve o mesmo resultado; erro do script sobe com contexto.
  A rodada ao vivo que o `/workflows` lê: passo por agente, fase, log, tokens, e **subagente
  enxergando a rodada da raiz**. Sub-workflow: resultado do filho, contador e journal compartilhados,
  fase prefixada e a do pai restaurada, resolução por nome com erro listando o que existe, e
  **segundo nível recusado**. Orçamento: teto corta a rodada no passo que estouraria, `budget.total`
  e `remaining()` visíveis no script, `Infinity` quando não há teto.
- **Paridade com o Claude Code** (46 asserções, `parity`, provider simulado): política de cache
  (liga sozinho no `@ai-sdk/anthropic`, `enabled` força/desliga, `ttl` repassado), breakpoints
  (system marcado, fim do request marcado, meio intacto, **histórico não mutado**), e o loop de
  verdade — turno sem cache não marca nada, turno com cache marca system e fim **sem quebrar**.
  Hooks de permissão com processos reais: `PermissionRequest` negando (usuário nunca é perguntado, o
  motivo do hook chega ao modelo, o arquivo não é escrito), permitindo (a tool roda mesmo), e a
  recusa humana (`Notification` **antes** do prompt, `PermissionDenied` depois). Comandos: frontmatter
  (`description`, `argument-hint`, `model`, `allowed-tools`), `commands/git/pr.md` → `/git:pr`,
  `$1`/`$2`/`$ARGUMENTS`, posicional ausente virando vazio, e o override de roster/modelo sendo
  desfeito no fim do turno.
- **Subagents** (18 asserções, `agentprobe`, provider simulado carregado pelo registry real):
  agent lido do disco com `tools:` do frontmatter, pai delega pela tool `Agent`, **o filho enxerga só
  as tools declaradas** (sem `Bash`, sem `Agent` — não há recursão) e uma tool fora da lista volta
  como `Unknown tool`; o texto do subagente **não vaza** para a resposta do pai, chega como
  `tool_result`; transcript único com registros `isSidechain` e `agentId`; `subagentDepth: 0` recusa
  delegar.
- **Filtro de `<think>`** (14 asserções, `thinkprobe`): tag inteira, **partida entre deltas**,
  `<thinking>`/`<reasoning>`, bloco não fechado não vaza para o texto, `<` solto preservado, e um
  turno completo com modelo simulado — texto visível, canal de reasoning e transcript sem tag.
- **Largura**: cheia por padrão (header e composer atravessam a tela), `/width 120` centraliza e
  estreita, `/width full` volta, largura inválida vira erro em vez de quebrar o layout.
- **Custo de quadro** (transcript de 360 blocos, 60 deltas de streaming): **331 B por desenho**,
  19 KB no total — contra ~20 KB *por quadro* do repaint completo anterior.
- **Rolagem**: pgup rola, roda do mouse rola, `ctrl+end` volta ao fim, `ctrl+home` vai ao início,
  scroll não fica negativo, indicador `rolado N linhas` na status bar.
- **Degradação** (3 processos): 256 cores 22/22 · `NO_COLOR` 7/7 · `BYTECODE_ASCII=1` 6/6.
- **TUI dirigida por teclas** (TTY simulado em processo, 42 asserções): layout centrado com teto de
  120 colunas, conteúdo ancorado no rodapé, popup de comandos com hints, **Enter roda o comando
  destacado**, picker de modo por setas, Esc fecha modal, e o **fluxo `/connect` inteiro** —
  picker de provider → chave mascarada na tela → baseURL → credencial salva → modelos do catálogo
  listados → `/disconnect`.
- **Fallback**: com stdin/stdout redirecionados, cai na UI de linha automaticamente.
- **Agentes primary e `.opencode/`** (29 asserções, `agentmodeprobe`, árvore `.opencode` sintética com
  CRLF e quotes escapadas como no repo real): descobre `.opencode/agents`, lê `mode`, `model` e
  `tools`, e arquivo sem frontmatter ainda carrega como subagent; o bloco `permission:` aninhado é
  traduzido (`edit: allow`→`Edit(*)`, `bash` para Bash **e** PowerShell, desescapando as quotes,
  `"*": ask`, `task: deny`→`Agent(*)`, `todowrite`→`TodoWrite`); trocar de agente assume o prompt,
  segue o `model`, aplica a permissão do agente, **`task: deny` bloqueia o Agent de verdade**,
  restaura o modelo ao sair, reconstrói o registry com as `tools` restritas, e um `model:` inexistente
  não derruba o agente.
- **MCP e `/context-all`** (26 asserções): status bar mostra `ctrl+p mcp(N)` **ao lado das tasks**;
  `ctrl+p` abre e fecha o modal, `/mcp` abre o mesmo, `esc` fecha. Relatório: nomeia modelo, janela,
  origem (medido × estimado) e agente ativo; separa `## setup` com uma linha por bloco, `## conversa`
  por papel, `## tools` ativas/deferred, `## mcp` e `## assets`; e **o rótulo do setup não mente** —
  os nomes vinham de uma lista posicional e `bootstrapBlocks` descarta blocos vazios, então tudo
  depois do primeiro ausente ficava com o nome errado (o bloco de ambiente aparecia como
  "instruções MCP").
- **Herança e import de MCP** (65 asserções, `mcp.test.ts`, HOME isolada e configs sintéticas de
  opencode/Claude): sem `inheritMcp` **nada** é herdado; ligado, nome próprio nunca é sobrescrito e a
  herança só preenche lacuna; `["opencode"]`/`["claude"]` filtram e origem desconhecida é ignorada;
  config do projeto vence a do usuário, a entrada do **cwd** vence a global **mesmo com a barra
  trocada**, projeto de outro diretório não entra e `.mcp.json` é lido. Tradução: `stdio`→`local` com
  `command`+`args` virando um argv, `env` vazio não cria `environment`, `sse`→`remote` preservando
  url e headers, entrada sem `command` nem `url` descartada. JSONC com comentário passa e config
  ilegível **não derruba** a descoberta. `redactForConfig`: PAT literal vira `{env:NOME}`, valor curto
  e chave que não é segredo ficam, referência existente não é mexida, e **o literal não aparece em
  lugar nenhum**. `mcp import` preserva o resto da config, traz desligado (`--enable` liga), não
  duplica na segunda rodada e **não copia o PAT em texto puro**. `McpManager.use` carrega origem,
  marca `enabled: false` como desligado sem contar como falha, e é ignorado depois de conectar.
- **Paste vai para quem tem o teclado** (10 asserções dentro da suite da TUI): com o modal do
  `connect` aberto, colar uma chave **não** escreve no composer atrás dele — o valor não aparece em
  texto puro em nenhuma linha, o modal mostra só `•`, e a quebra de linha do paste não confirma nada;
  `esc` cancela sem gravar. Em picker o paste vai para o filtro; sem modal, volta a ser o composer.
  Conectar provider **já declarado na config** abre o prompt sem baixar o catálogo.
- **Fila de mensagens** (16 asserções): com um turno em voo, duas mensagens digitadas aparecem na
  ordem, dizem `na fila`, têm fundo invertido (`48;5;255` + `38;5;235`) cobrindo a linha inteira, e a
  que **já** foi enviada não tem destaque; quando a vez chega, o destaque sai, o rail `▌` aparece, o
  `na fila` desaparece e **a mensagem não é duplicada**; ao fim nenhuma linha fica destacada. Comando
  enfileirado roda e não deixa bolha.
- **Comando multilinha não corrompe o quadro** (9 asserções): o `subject` do Bash já vem em uma linha;
  com um comando contendo `\n` renderizado, **nenhuma linha do quadro contém newline, CR ou tab**, a
  altura não muda, a chamada ocupa uma linha só e não sobra fragmento órfão na coluna 0. `oneLine`
  troca newline/CR/tab por espaço e **preserva** as sequências ANSI.
- **`tab`, tasks e respiro do indicador** (25 asserções dentro da suite da TUI): status bar mostra
  `build` por padrão com o atalho ao lado; `tab` entra no primeiro primary, anda, e volta para build;
  **subagent não entra no ciclo**; a permissão do agente ativo é aplicada; com o popup aberto `tab`
  volta a completar; `/agent <nome>`, `/agent build` e nome inválido avisando. Tasks: `tasks(0)` antes
  de existir alguma, `ctrl+t tasks(3)` depois — **ao lado do agente**, `ctrl+t` abre mesmo vazio e
  explica, o modal lista as três com `✔`/spinner/`○`, `esc` e `/tasks` funcionam. Indicador: com um
  turno realmente em voo, há **linha em branco entre a última linha do chat e o indicador**, e o
  composer segue abaixo dele.
- **Escreve no novo, lê do antigo** (13 asserções dentro do `doctorprobe`): com só `~/.hx` no disco,
  a credencial antiga **é lida** mas `stateDir()` continua sendo `~/.bytecode`; gravar cria o
  diretório novo e **não toca** no arquivo antigo; as duas aparecem juntas e o novo vence em conflito.
  Sessões: a salva no diretório antigo aparece na lista e **abre**, a nova é gravada no diretório novo,
  e a lista traz as duas. `setup` mescla em vez de sobrescrever e a segunda rodada não copia nada.
- **Independência do opencode e estrutura própria** (37 asserções, `doctorprobe`, HOME isolado):
  com o `auth.json` do opencode presente no disco, `doctor` marca ele **IGNORADO** e a credencial
  **não** é usada; com `openCodeAuth: true` passa a `usado` e resolve dele, dizendo qual arquivo; a
  ordem env → config → store é reportada corretamente e **nenhum segredo aparece no relatório**;
  `setup` cria `~/.bytecode/{projects,workflows,auth.json}` + `~/.config/bytecode/bytecode.jsonc`,
  copia credencial e config legadas, **não move o legado**, é idempotente (não sobrescreve auth
  existente), e depois dele o diretório próprio passa a ser o vivo; `--import-opencode` importa com
  data e reimportar não duplica.
- **Sessões** (46 asserções, `sessionprobe`, data dir isolado): grava no fim do turno e **não**
  duplica no turno seguinte (`createdAt` preservado, `updatedAt` avança, turnos acumulam); título
  ignora `<system-reminder>` e desembrulha `<command-name>`; retomar restaura o histórico com os
  tool-calls intactos, aponta o transcript para o mesmo id e continua gravando nele; prefixo de 8
  resolve, id inexistente devolve `null`, prefixo ambíguo lança; `latestSession` devolve a mais nova;
  **retomar não reativa `bypassPermissions`**; turno de subagente não cria sessão; e as 7 faixas de
  `formatWhen`.
- **Faixa e viewer de subagents** (33 asserções): a faixa fica **abaixo** do composer e o composer
  não desce quando ela aparece; a status bar segue sendo a última linha; a tool do filho alimenta a
  faixa mas **não** vira bloco do transcript do pai; `ctrl+a` foca (`subagent 1/8`), `↑↓` move,
  `enter` abre a sessão do agente com o texto e as tools dele, `esc` e `ctrl+a` voltam. Ciclo de vida:
  enquanto roda **não há linha** no transcript, ao terminar sai da faixa e a linha aparece, clicar
  nela **abre a sessão** (não expande preview), a faixa desaparece quando nada roda, e a linha segue
  clicável **depois do `turn-end`**.
- **Modelo curto de agent** (6 asserções): `model: tiny` no frontmatter resolve para `provider/model`
  e o subagente responde; nome inexistente cai no modelo da sessão em vez de estourar; com **dois
  providers declarando a mesma chave**, `model: sonnet` fica no provider da sessão, um modelo que só
  existe no outro ainda é achado, e um `provider/model` completo é respeitado como está.
- **401 acionável** (6 asserções): a mensagem nomeia `provider/modelo`, a env var convencional, o
  comando `connect`, o caminho do `auth.json` e a forma na config — e um erro que **não** é de auth
  não ganha a dica.
- **Composer que não trunca** (15 asserções): a matemática do wrap (não perde caractere, nenhuma
  linha passa da largura, quebra em espaço quando há, token gigante cortado à força) e o fluxo real —
  digitar 270 caracteres num terminal de 140 colunas **não** produz `…`, o **fim** do texto fica
  visível, quebra em várias linhas, nada é perdido, a borda direita sobrevive, e uma linha cheia não
  joga o cursor sobre a borda.
- **Expandir a tool escolhida** (13 asserções): com três tools na tela, `ctrl+r` sem foco pega a
  **última**; clicar na primeira expande **aquela** e não a última, marca `❯` na linha, e clicar de
  novo colapsa; `ctrl+r` passa a seguir a focada; `alt+↓`/`alt+↑` movem o foco e o `ctrl+r` acompanha;
  clique em linha vazia não expande nem toca no clipboard.
- **Bloco de tool e diff** (22 asserções): formato `Name(subject)`, spinner enquanto roda, bolinha
  **no início** ao terminar (verde `38;5;108` / vermelha `38;5;167`), **uma só** por linha e sem `✔`
  sobrando; detalhe na linha do `└`; corpo colapsado até `ctrl+r`, e aberto mostra número de linha
  com fundo verde (`48;5;22`) no adicionado, vermelho (`48;5;52`) no removido, faixa cobrindo a
  largura. Diff real do `Edit`/`Write`: resumo contando linhas, marcadores `+`/`-` nos números
  certos, 3 linhas de contexto de cada lado, coluna alinhada, `Created N lines` em arquivo novo e
  `No line changed` quando a troca não muda nada.
- **Tela inicial e faixa de subagents** (45 asserções dentro da suite da TUI): a janela lateral é
  desenhada com título e rodapé, fica **na metade direita** com o conteúdo à esquerda na mesma linha,
  nada preselecionado; `↑↓` navega, `enter` abre, `esc` desmarca. **Busca separada do composer:**
  digitar sem `ctrl+f` vai só para o composer e o painel **não ecoa nem filtra**; `ctrl+f` abre a
  busca e daí o texto vai só para ela, com o composer permanecendo vazio; **nunca dois cursores na
  tela**; filtro conta `N de M`, esconde quem não casa, avisa quando nada casa, `↑↓` navega dentro do
  filtro, apagar traz todas de volta, e `esc` devolve o teclado ao composer. Retomar mostra o
  histórico e sai da lista; `/sessions` relista, clique numa linha abre aquela
  sessão, `/resume` por prefixo funciona e id inexistente vira erro visível. Faixa: aparece acima do
  composer, conta quantos rodam, mostra a tool corrente, teto de 5 linhas com `+N sem espaço`,
  **rouba altura do viewport e não do composer**, a tool do filho não vira bloco do transcript, e
  `turn-end` limpa fantasma.
- **Wordmark** (10 asserções): as 3 linhas da arte batem caractere por caractere e têm a mesma
  largura, `BYTE` e `CODE` saem em cores diferentes, o nome **não** é repetido em texto ao lado da
  arte, o header não estoura a largura, e terminal estreito colapsa para a identidade textual —
  voltando para a arte ao alargar.
- **Seleção por caractere** (21 asserções dentro da suite da TUI): matemática do span (vazio sem
  arrasto, normalização de arrasto reverso, faixa da primeira/meio/última linha), e o fluxo real com
  eventos SGR — arrastar 5 colunas copia **exatamente** esses 5 caracteres, o destaque não pega a
  linha toda, arrasto reverso dá o mesmo trecho, e **clique sem arrastar não pinta, não copia e não
  toca no clipboard** (verificado também no campo de digitação).
- **Shell, busca, retry, leadtime e paralelismo** (65 asserções, `perfprobe`): bash real descoberto
  (e o launcher do WSL rejeitado), `$0` expandindo e `ls` existindo dentro da tool `Bash`, comando
  ausente devolvendo dica para `Glob`; **rg e scanner JS achando exatamente o mesmo conjunto** (com
  `BYTECODE_NO_RG` forçando os dois caminhos) e glob raso sem vazar subdiretório; retry recuperando de
  429+503 sem duplicar texto, 401 não repetindo, saída parcial não repetindo, e 10 casos de
  classificação de erro de rede pela cadeia de `cause`; paralelismo em 3 ondas (medido) com ordem
  dos resultados preservada; leadtime somando steps, tokens, cache e tools, com custo descontando
  cache e tokens de subagente subindo para o pai.

Defeitos reais encontrados por esses testes, todos corrigidos:

1. `apiKey` placeholder fazia o LiteLLM devolver mensagem enganosa.
2. **AI SDK v7 entrega falha de stream pelo callback `onError`** — sem ele, o handler default
   derruba o processo com stack em vez de o loop tratar.
3. Hooks com `shell: powershell` eram invocados com `-c` (flag que não existe no PowerShell), então
   um hook nunca conseguia bloquear via exit 2. Agora: shell padrão da plataforma, e `-Command`
   quando PowerShell for pedido explicitamente.
4. Compactação usava `generateText`; o proxy 9router responde corpo não-JSON sem `stream: true`.
   Passou a usar streaming.
5. Resumo podia ficar maior que o trecho substituído — agora a troca é abortada nesse caso.
6. **A tool `Bash` no Windows não era bash.** `spawn(cmd, { shell: true })` resolve para o `ComSpec`,
   ou seja `cmd.exe`: `ls` e `cat` não existem e `find` é outro programa. O modelo gastava chamadas
   redescobrindo isso. Agora um bash real é localizado, ou a tool não é oferecida.
7. **Cache de tokens estava sendo lido pelo nome errado.** No AI SDK v7 a contagem vive em
   `usage.inputTokenDetails.cacheReadTokens`/`cacheWriteTokens`; `cachedInputTokens` é a forma antiga
   (ainda aceita como fallback). Pego pela suíte de leadtime, que reportava 0.
8. **`ENOTFOUND` estava classificado como transitório**, então um host errado virava 7s de backoff
   antes do erro. A classificação passou a olhar a cadeia de `cause` e trata DNS inexistente,
   conexão recusada e certificado inválido como permanentes. Pego pela suíte da TUI, cujo provider
   de teste aponta para um host inválido de propósito.

Quirk conhecido do proxy: esse endpoint emite `<think></think>` vazio dentro do conteúdo. No resumo
de compactação isso é removido (só as tags vazias); na resposta corrente o texto do modelo não é
alterado.

## Próximos passos sugeridos

1. Retomar sessão de **outro** diretório (hoje a lista é por projeto, como o `--resume` do Claude Code).
2. Colheita automática de job em background (hoje o modelo consulta com `BashOutput`; a reentrada no loop só é possível na TUI).
3. OAuth para MCP remoto (o SDK expõe `authProvider`; hoje só header estático).
4. Plugins/marketplaces.
5. Empacotamento: `bun build --compile` para binário único.
