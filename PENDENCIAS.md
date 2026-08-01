# Pendências — status (revisado em 2026-07-30)

O levantamento anterior foi feito por análise estática. Nesta revisão cada item de performance foi
**medido** antes de mexer, e a medição mudou a conclusão de vários: a análise acertou a *forma* do
problema (O(n²), falta de memoização) e errou a *magnitude*. Itens negligenciáveis foram fechados
como "não vale", com o número que sustenta a decisão.

## Resolvido

### Tela de carregamento, e o respawn que não precisava existir

O launcher subia **um segundo processo Node** só para passar `--experimental-strip-types` — flag que
o Node 23+ não precisa. Medido: **73 ms** em toda execução, gastos para nada. Agora só o caminho de
Node antigo respawna.

A tela de carregamento (`src/tui/splash.ts`) tem uma restrição que define o desenho inteiro: ela roda
**antes** dos imports pesados, porque os módulos pelos quais se espera incluem tudo que sabe
desenhar. Por isso ela importa quase nada — a única exceção é `theme.ts` (~35 ms), e essa se paga:
a alternativa era copiar os números da paleta para cá, exatamente o tipo de duplicata que fica velha
na primeira vez que um preset muda.

A barra varre em vez de encher porque carregamento de módulo não reporta progresso; inventar uma
porcentagem e pular para 100% no fim seria mentira. Desenha na tela alternativa e **entrega** essa
tela para a TUI em vez de sair e entrar de novo — sair mostraria o shell por um frame no meio.

Dois defeitos do primeiro rascunho, achados olhando o resultado na tela e não o código: a tela ficava
colada no rodapé de um terminal sujo (faltava limpar e centralizar) e o accent estava chumbado em
rosa em vez de vir do tema. Um terceiro saiu do teste: `palette()` consultava `process.stdout` em vez
do stream que recebia, então respondia sobre um lugar diferente daquele onde ia escrever.

### Dois defeitos que só uma sessão real mostrou

Vieram de um `/ado-workitem 156501` rodado de verdade, não de análise.

**1. `/leadtime` reportava 0 tokens e $0,00 com 8 chamadas ao modelo.** Não era o leadtime: um
servidor OpenAI-compatible **não manda `usage` numa resposta em stream** a menos que o request peça,
e o SDK só pede quando recebe `includeUsage` (`@ai-sdk/openai-compatible/dist/index.js:701` →
`stream_options: { include_usage: true }`). O ByteCode nunca passava.

O estrago ia além do relatório: sem `usage`, `session.tokenBaseline` nunca era preenchido, então
`contextTokens()` caía na estimativa pura e **o gatilho de compactação passava a decidir por
estimativa**; e `cache lido` ficava zerado, que é exatamente o número que o README manda olhar para
saber se o prompt caching está rendendo. Ou seja: a única forma documentada de verificar o item P2
não podia funcionar. Agora `includeUsage: true` é o default para o pacote openai-compatible, com a
config do usuário vencendo.

**2. Saída do PowerShell com acento corrompida** — `PIX---Expans�o`. O PowerShell 5.1 escreve na
codepage do console (medida nesta máquina: **850**) e este processo decodifica UTF-8. Node não tem
tabela CP850 (não está no conjunto WHATWG, verificado com `TextDecoder` em quatro rótulos), então o
conserto tem de ser do lado do PowerShell: um preâmbulo `[Console]::OutputEncoding=[Text.Encoding]::UTF8`
antes do comando, e a linha injetada é removida da saída para o modelo nunca ver. Exit code
preservado, stderr também corrigido. O `Bash` já vinha certo e continua.

`test/shell.test.ts` cobre os dois, com o texto acentuado indo e voltando pelo shell de verdade.

### `$schema` apontava para arquivo que não existia

`hx.jsonc` declarava `"$schema": "./hx.schema.json"` e o `bytecode init` escrevia
`"./bytecode.schema.json"` — **nenhum dos dois existia**. Todo editor que abrisse a config mostrava
referência não resolvida na linha 2, e as chaves novas de hoje (`fileGuard`, `maxSteps`,
`subagentConcurrency`, `web`, `cache`, `mcp.*.parallelSafe`) não tinham validação nem autocomplete
em lugar nenhum.

`src/config/schema.ts` escreve o schema à mão — não há build step aqui, então nada reflete sobre os
tipos, e um gerador que parseasse TypeScript seria maior e mais frágil que o schema que produz.
`bytecode schema [arquivo]` grava no disco, o `init` passou a gravar junto com a config, e o
`bytecode.schema.json` da raiz é versionado.

O que impede o schema de envelhecer é `test/schema.test.ts`: ele lê `config/types.ts`, extrai as
chaves de `Config`, `McpServerConfig`, `ProviderConfig`, `ModelConfig`, `PermissionsConfig`,
`AssetsConfig`, `WebConfig`, `CompactionConfig` e `HookDefinition`, e falha nos dois sentidos —
chave no tipo que falta no schema, e chave no schema que o tipo não tem. Parsear fonte é frágil em
geral, mas a pergunta aqui é estreita e o custo de errar é um teste vermelho.

Dois checks a mais que transformam o schema em algo que vale a pena ter: o `bytecode.schema.json` do
disco tem de bater byte a byte com o módulo, e o `hx.jsonc` do repositório tem de validar contra ele
(`additionalProperties: false`, então chave a mais é vermelho no editor de quem abrir). Foi esse
teste que pegou o `$schema` pendurado.

### Execução em background (Q4b do roadmap)

Era o gap #1 do `claude-code-vs-bytecode.md`. `run_in_background` no `Bash`/`PowerShell`,
`BashOutput` por cursor, `KillShell`, e `src/core/jobs.ts` com o registro.

O que o levantamento mandou cortar e foi cortado: a **colheita no `drive()`**. Reentrar no loop com
o turno encerrado exige alguém rodando fora do turno; esse alguém só existe na TUI (`submitLine`),
não no headless, não dentro de subagent, não dentro de workflow. Polling com `BashOutput` funciona
nos quatro. O job avisa na tela quando termina — só não fala pelo usuário.

Quatro armadilhas fechadas, todas apontadas antes de virarem bug:

1. **`AbortSignal` do turno.** Passar `ctx.signal` era o caminho natural — e então um esc na
   conversa mataria a suíte lançada por ela. O job é spawnado sem signal, e isso está comentado no
   código para não ser "consertado" depois.
2. **Corte de 30.000 chars do `executeCall`.** Devolver o buffer inteiro perderia o fim, que é onde
   está o veredito do teste. Leitura por cursor é o comportamento, não uma opção.
3. **Buffer sem teto.** Sem timeout para limitá-lo, um `tail -f` cresceria para sempre. Anel de
   200.000 chars, e a leitura declara `[dropped N chars from the head]`.
4. **`kill` no Windows.** `child.kill()` sinaliza só o filho direto: `powershell -Command npm test`
   deixaria `node.exe` órfão. `taskkill /PID x /T /F` no win32, e `killAllJobs` no teardown da TUI e
   no fim do headless — filho vivo com stdio em pipe transforma sair em travar, para quem talvez
   nunca tenha usado a feature.

`KillShell` recebe id de job, nunca pid: aceitar pid transformaria uma tool que o modelo já tem num
jeito de matar qualquer processo da máquina.

### `WebFetch` (Q4a do roadmap)

O harness não tinha nenhuma tool de rede: só sabia o que estava no repositório. `src/tools/web.ts`
fecha isso, e a maior parte do arquivo é a guarda, não o fetch.

`kind: 'net'` novo, em vez de reaproveitar os existentes: `exec` tornaria impossível pesquisar
documentação no plan mode, e `read` liberaria egresso de rede sem prompt nenhum. Pede permissão por
padrão e é liberado no plan mode.

A guarda anti-SSRF vive **dentro da tool**, incondicionalmente, e o motivo não é preferência: as
regras de permissão casam a string que o modelo escreveu, então `deny WebFetch(http://169.254.169.254/**)`
cai com `169.254.169.254.nip.io`, com IP decimal ou com qualquer host público cujo DNS aponte para
dentro — e em `bypassPermissions` toda regra `ask` vira `allow`. Então o host é resolvido e todos os
endereços têm de ser públicos, e o redirect é revalidado a cada hop (`redirect: 'manual'`, máx. 5),
porque o veredito de permissão é calculado uma vez com a URL do input e nunca recalculado.

**O teste achou um bug real da guarda**: `new URL('http://[::ffff:127.0.0.1]/')` normaliza o host
para `[::ffff:7f00:1]`, e a regex só reconhecia a forma pontuada — loopback passava por IPv4 mapeado
em hexa. Corrigido decodificando os dois hextets.

Duas limitações documentadas em vez de escondidas: a conversão HTML→texto não executa JavaScript nem
remove navegação, e DNS rebinding continua aberto porque o `fetch` global do Node resolve de novo por
conta própria, sem resolvedor customizável sem `undici`.

Achado colateral: a sugestão do levantamento para o `ifMatches` dos hooks (tratar URL como `exec`)
deixaria o **hook mais permissivo que o motor de permissão**, que trata `net` como segmentado. Os
dois passaram a usar `net`, e a suíte fixa isso: `**` cruza `/`, `*` não.

### Subagent devolvia prosa e morria no fim do turno (U1 e U2 do roadmap)

Duas coisas no mesmo bloco de 25 linhas do `agentTool.execute`, feitas juntas porque disputam o
mesmo acumulador.

**`schema` na tool `Agent`.** O mecanismo saiu de `workflow.ts` para `src/core/structured.ts`, que os
dois call sites agora usam. Pelo caminho, uma afirmação que este repositório vinha repetindo estava
**errada**: o `schema` do `Workflow` nunca validou nada. Eram um sufixo de prompt e um `JSON.parse`
do primeiro `{` do texto; qualquer JSON parseável passava, respeitando o schema ou não.

Um validador de JSON Schema foi considerado e **cortado com o argumento**: no único call site que
existia, a regra de compatibilidade necessária (deixar o objeto passar mesmo inválido, senão
scripts existentes quebram) faria a validação não mudar comportamento nenhum. O que faltava de
verdade era a **segunda chance** quando o parse estoura — que é o modo de falha real, o modelo
escrevendo "Claro! Vou explicar antes" e só depois o JSON.

Três detalhes que são o desenho, não acidente:

- o turno de reparo lê **só o texto novo**. `collected` é append-only e `parseStructured` pega o
  primeiro `{`: sem o offset, o reparo devolveria a prosa da primeira tentativa e chamaria de
  sucesso — falha silenciosa, a pior espécie;
- JSON acima de 28.000 chars vira **erro explícito** em vez de resultado. O `truncate` do loop anexa
  `[truncated N chars]` e transformaria JSON válido em inválido do lado de quem chamou;
- o reparo **não** foi para o `Workflow`. O orçamento de lá é um teto que lança, não avisa: um turno
  extra pode empurrar o run acima do limite e abortar o workflow inteiro. Lá continua byte a byte
  como era.

**`AgentResume`.** As sessões-filho ficam guardadas por id (o `callId` que já ia no `agent_id` do
resultado), teto de 4, descarte do mais antigo, `busy` por entrada para dois resumes não
compartilharem o mesmo `AbortController`. O `emit` é zerado ao guardar, senão o closure segura a
sessão pai.

Isso **inverte** conscientemente a decisão registrada ao lado das listas de todo ("o lado do valor
não guarda referência a `Session`"). Lá continua valendo; aqui segurar a sessão é o ponto. Custo
medido pelo levantamento: 0,3–0,6 MB por investigador típico, teto 4.

Conflito real que a investigação pegou antes de virar bug: `Agent` com `schema` **não** anexa a linha
`[agent_id: …]` ao texto. Com schema, o contrato é "o texto inteiro é o JSON", e quem chama
`JSON.parse` não pode ter de descascar nada antes.

### MCP serializava quase tudo (P4 do roadmap)

`parallelSafe` de uma tool MCP exigia `annotations.readOnlyHint === true`. A anotação é opcional no
protocolo e a maioria dos servidores não preenche, então todo `list_*`/`get_*` rodava um de cada vez
mesmo quando o modelo os emitia juntos.

O default conservador continua — não dá para presumir que uma tool desconhecida é segura. O que
faltava era a saída: `"parallelSafe": true` ou uma lista de nomes no bloco do servidor. É uma decisão
por servidor porque só quem o configurou sabe se as tools dele podem se sobrepor. O que o servidor
declara sozinho continua valendo mesmo fora da lista.

### Teto de steps matava o turno com erro (Q3 do roadmap)

`MAX_STEPS = 64` fixo, e ao bater nele o turno terminava com `stopped after 64 steps` — erro, sem
aviso prévio, sem caminho de volta. Um refactor longo perdia junto o resumo do que já tinha feito.

Agora: em 75% do teto entra um `<system-reminder>` no histórico dizendo quantas chamadas já foram e
mandando convergir (terminar o que está em curso, relatar, não começar nada novo); no teto o turno
para com **aviso**, não erro, porque nada falhou — o orçamento acabou. O histórico fica intacto, então
`continue` segue de onde parou. Teto configurável em `maxSteps`.

### Escrita silenciosa por cima de trabalho humano (Q1 do roadmap)

Não havia rastro nenhum de leitura: `Write` substituía qualquer arquivo, e `Edit` gravava por cima
de alteração externa sem erro nenhum. O segundo caso é o grave — numa sessão longa o arquivo está
aberto no editor, um salvamento move o arquivo debaixo do agente, e o `Edit` seguinte devolve o
conteúdo antigo. Nada falha, nada aparece no diff, o trabalho some.

`src/core/filestate.ts` guarda `{mtimeMs, size}` do que a sessão leu ou escreveu, com escopo na
sessão raiz — arquivo lido por um subagent conta como lido pela árvore. Regras:

| situação | veredito |
|---|---|
| criar arquivo novo | livre |
| `Write` em arquivo existente que ninguém leu | recusado |
| `Write`/`Edit` em arquivo cujo mtime/size mudou desde a leitura | recusado |
| `Edit` em arquivo não lido | **permitido** |

A última é deliberada: um `Edit` já falha alto no `old_string not found`, então exigir leitura
custaria um round trip para provar o que o match prova, e a linha exata costuma vir de um `Grep`.
`/clear` esquece as leituras junto com o contexto; `"fileGuard": false` desliga tudo.

A suíte `perf` pegou o primeiro verdadeiro-positivo: ela reescrevia um arquivo por fora entre duas
chamadas de `Edit`. O teste passou a reler — que é exatamente o que a guarda pede.

### Desfazer alteração da sessão (Q2 do roadmap)

O dado já estava em memória: `changes.ts` guarda o conteúdo anterior à **primeira** escrita da
sessão. `revertChange` escreve isso de volta (ou apaga, quando a sessão criou o arquivo), e a tela
do `ctrl+g` ganhou a tecla `r`; `/rewind` abre a mesma tela.

Três cuidados, porque a operação é destrutiva: pede confirmação nomeando o arquivo e dizendo qual
dos dois vai acontecer; recusa se o arquivo mudou no disco depois da última escrita da sessão
(restaurar por cima seria o mesmo clobber do item anterior); e atualiza o `filestate` depois, para
o arquivo poder ser reescrito sem exigir uma leitura que já não faz sentido.

O comando **não** desfaz tudo de uma vez de propósito. Escolher o arquivo é a parte que torna a
operação revisável.

### Prompt caching não chegava na rede no provider usado (P2 do roadmap)

A config aponta para `selbetti/sonnet`, que é `@ai-sdk/openai-compatible`. Nesse caminho o
`cache.enabled: true` **ligava e não cacheava nada**: o provider lê provider options só sob a chave
`openaiCompatible` (`dist/index.js:113`) e descarta `providerOptions.anthropic` sem avisar. O
resultado era o pior dos dois mundos — o formato do request mudava (system virava mensagem) e o
cache continuava desligado. O `docs/claude-code-vs-bytecode.md` afirmava o contrário; a linha foi
corrigida.

A política agora tem **estilo**. `sdk` para `@ai-sdk/anthropic`, onde o AI SDK carrega o marcador.
`wire` para o resto, onde ele é escrito no corpo do request por um `fetch` que embrulha o do provider
(`src/provider/promptcache.ts`). O corpo sai com `cache_control` dentro de uma parte de texto, que é
a forma documentada por LiteLLM e OpenRouter — e a única possível, já que o system prompt sai como
string pura, sem bloco onde pendurar nada.

Continua **opt-in** fora do Anthropic: `cache_control` é extensão e transformar `content` de string
em lista de partes, embora seja a forma documentada por LiteLLM e OpenRouter, não é universal. Um
servidor OpenAI estrito não deve começar a receber isso por causa de um default.

Dois modos de falha, os dois visíveis: se o proxy **rejeitar** a forma, o primeiro turno volta com
400 — barulhento, e o remédio é `"cache": { "enabled": false }`. Se ele **aceitar e ignorar**,
`/leadtime` mostra `cache lido` zerado. Não foi possível verificar o contrato do LiteLLM nesta
máquina (o pacote não está instalado aqui), então a documentação diz exatamente isso em vez de
afirmar que funciona.

Dentro do módulo a regra é que nenhuma forma inesperada de corpo derruba a chamada: corpo que não é
JSON, forma sem `messages` ou mensagem sem nada marcável passam reto, sem nem reserializar.

### Subagents rodavam em fila (P1 do roadmap)

`agentTool` não declarava concorrência, e `executeCalls` só agrupava tools `parallelSafe`. Quatro
`Agent` emitidos no mesmo step viravam quatro execuções sequenciais — quatro janelas de 30 s onde
cabia uma. O resto do sistema já estava pronto: a UI guarda agents num `Map` por id, `Session.record`
soma métricas subindo a árvore sem estado compartilhado, `Transcript.append` serializa as escritas
numa fila de promessas e não move `lastUuid` em registro de sidechain.

O que **não** estava pronto era a permissão. `session.requestPermission` atribuía o `modal` direto;
dois subagentes perguntando no mesmo instante faziam o segundo sobrescrever o primeiro, e o `resolve`
perdido travava aquele subagente — e com ele o turno inteiro — para sempre. Agora os pedidos entram
numa fila, o modal diz qual agente está perguntando e quantos esperam atrás, e o ticker de 80 ms é a
rede de segurança caso o microtask que abre o próximo não rode.

Concorrência é por **grupo**, não por um booleano: `parallelSafe` continua significando "somente
leitura, mistura com qualquer coisa", e `parallelGroup: 'agent'` significa "roda junto com outros
iguais, nunca com o lote de leitura". Um subagente escreve, então não pode correr ao lado de um
`Read` que o modelo emitiu junto. Teto em `subagentConcurrency` (padrão `min(8, cpus−2)`; `1`
restaura o comportamento antigo).

### `Grep` bufferizava a saída inteira do ripgrep (P3 do roadmap)

`-m` é o limite **por arquivo** do ripgrep, não um total, e o corte para `head_limit` só acontecia em
JS depois do `close`. Contra o `node_modules` deste repositório, `head_limit: 200`:

| | mediana | bufferizado | devolvido |
|---|---|---|---|
| antes | 422 ms | 6,18 MB | 27 KB |
| depois | 140 ms | 337 KB | idem |

No caminho real da tool (com spawn e formatação), 298 ms → **128 ms**. As linhas passaram a ser
contadas conforme chegam e o processo é morto ao atingir o limite; cada linha é cortada em 250
caracteres, porque um bundle minificado é uma linha só e 200 delas custariam 336 KB de contexto para
não dizer nada.

`test/schedule.test.ts` (15 asserções) cobre os dois: sobreposição real das janelas de execução,
barreira entre grupos, teto de concorrência, ordem dos resultados, corte global do `Grep` e truncagem
de linha longa.

### Testes agora vivem no repo

Era o item mais grave: as suítes existiam só num diretório temporário, com caminhos `C:\...`
embutidos. Rodavam numa máquina só e desapareceriam com a limpeza do temp.

- `test/` no repositório, 13 suítes, **793 asserções**, `npm test`.
- `test/helpers.ts` deriva `SRC`/`ROOT`/fixtures de `import.meta.url`; a config de cada suíte é
  montada em JS e injetada por `BYTECODE_CONFIG_CONTENT`.
- `test/run.mjs` roda **um processo por suíte** (várias leem env no import, trocam
  `process.stdout.write` ou tomam o stdin em raw mode) e agrega o resultado.
- Isolamento: `dataDir`/`HOME` em `node_modules/.bytecode-test/<suíte>` e
  `BYTECODE_FAKE_CLIPBOARD=1`.

### MCP herdado do opencode e do Claude Code

`inheritMcp` (desligado por padrão) reaproveita servidor que não existe no bloco `mcp` — o nome
declarado aqui sempre vence. `bytecode mcp import [--enable]` copia de vez. Detalhe que mudou a
implementação: `~/.claude.json` guarda o PAT do Azure DevOps **em texto puro em 15 entradas de
projeto**, então o import troca valor literal de chave-que-parece-segredo por `{env:NOME}` e lista as
variáveis que passam a precisar de valor — copiar espalharia o segredo em vez de migrá-lo.

`bytecode mcp`, `doctor`, `/context-all` e o modal `ctrl+p` passaram a mostrar a origem (`own`,
`opencode`, `claude`) e a marcar `enabled: false` como desligado em vez de esconder. Servidor
desligado saiu da razão `mcp(0/1)` da status bar: não é falha.

Medido na máquina: em `C:\Repositories\harness` o Claude Code não tem entrada (os 15 projetos com MCP
são outros diretórios), então nada é herdado aqui; em `C:\Repositories` a descoberta acha
`mcp__azure-devops` (opencode), `azure-devops` e `caveman-shrink` (Claude), com o PAT já convertido
para referência.

### MCP do Azure DevOps: nome de env var errado

`Connection closed` era falta de credencial com nome errado. `@azure-devops/mcp` 2.7.0 com `-a pat` lê
**`PERSONAL_ACCESS_TOKEN`** (e usa o valor direto como credencial Basic, então precisa ser
`base64(":" + PAT)`); a config declarava `ADO_PAT`, nome que essa versão nunca lê. Capturado rodando o
servidor com o stderr visível — o `McpManager` usa `stderr: 'ignore'` para não corromper o quadro da
TUI, então a mensagem real (`Environment variable 'PERSONAL_ACCESS_TOKEN' is not set or empty`) ficava
invisível.

`hx.jsonc` do repo corrigido: `PERSONAL_ACCESS_TOKEN: {base64::{file:~/.bytecode/ado-pat}}`, ligado. O
que vai versionado é um **caminho**, não um segredo; o arquivo fica fora do repositório e sobrevive a
terminal novo, ao contrário de uma env var. Verificado com PAT falso: **conecta e expõe 34 tools** como
`mcp__azure_devops__*`; removido o arquivo, volta a `credencial ausente`.

Para isso a substituição da config ganhou **`{base64:texto}`**, resolvido depois de `{env:}`/`{file:}`.
Codificar credencial à mão é passo que falha calado — `base64(":" + PAT)` errado autentica como ninguém
e o servidor responde 401 sem dizer por quê. Agora o arquivo guarda o PAT **cru** (uma linha, dá para
salvar no Notepad) e a config monta a credencial Basic. Referência que não resolve deixa vazio em vez de
`base64("")`, senão a guarda de credencial ausente deixaria de disparar.

Alternativas descartadas com medição: `-a envvar` (`ADO_MCP_AUTH_TOKEN`) manda o token como **Bearer**,
o que não serve para PAT; `-a azcli` **passa no handshake** e só falha na primeira chamada
(`ChainedTokenCredential authentication failed`, `az` não instalado) — pior, porque parece funcionar.

Junto: `McpManager.connect` passou a **não discar** servidor cujo `environment` tem valor vazio,
reportando `credencial ausente: <VAR> vazio`. Antes, `{env:VAR}` sem valor substituía para `""`, o
servidor subia, recusava a auth e morria — custando handshake por sessão e escondendo a causa.

### Por que funcionava no opencode e não aqui: o ambiente

Com a mesma config (`environment` vazio), opencode conectava e ByteCode não. Extraído do binário
(`opencode-ai@1.18.9`, `MCP.connectLocal`):

```js
new R2({ stderr:"pipe", command:Z, args:N, cwd:E,
         env: { ...process.env, ...(Z==="opencode"?{BUN_BE_BUN:"1"}:{}), ...F.environment } })
```

Ele repassa o **ambiente inteiro**; nós passávamos só o `getDefaultEnvironment()` do SDK, que é um
whitelist (PATH, HOME, APPDATA, TEMP…). Esta máquina tem `PERSONAL_ACCESS_TOKEN` como variável de
usuário — o opencode achava, o nosso descartava. Agora `childEnv()` herda por padrão, com
`"inheritEnv": false` para restringir. Config que nomeia um comando a executar já carrega mais
autoridade do que qualquer variável que ele leria, então esconder variáveis dele não é contenção, é só
surpresa.

Medido depois: a variável de **usuário** (persistente, 112 chars) devolve **401**; a que existe só no
ambiente do terminal atual (152 chars) autentica e lista 8 projetos. Ou seja, o "funciona no opencode"
dependia do terminal onde ele foi aberto.

### O servidor tinha a resposta e ninguém lia

Diagnosticar o 401/`Connection closed` exigiu rodar o servidor à mão com o stderr visível — o
`McpManager` usava `stderr: 'ignore'` para não corromper o quadro da TUI, e com isso jogava fora a única
explicação existente. Agora é `pipe` (nunca `inherit`) com dreno para um buffer de 4 KB: sem drenar,
servidor falante trava quando o pipe enche. Na falha, a última linha significativa vai para a mensagem,
desembrulhando o `message` de log em JSON:

```
azure-devops: FAILED — MCP error -32000: Connection closed — o servidor disse:
  Fatal error in main(): Environment variable 'PERSONAL_ACCESS_TOKEN' is not set or empty.
```

### Tasks de subagent não chegavam no `ctrl+t`

`TodoWrite` guardava a lista num `WeakMap<Session, Todo[]>` com a **instância** da sessão como chave.
Subagent roda numa `Session` filha, então a lista ficava num objeto que a UI nunca consulta: as tasks
apareciam no transcript e o `ctrl+t` continuava vazio (foi o que aconteceu rodando o `dispatcher`).

Agora o estado é agrupado na sessão **raiz**, `WeakMap<Session, Map<owner, Todo[]>>` — agrupado por
autor, não concatenado, porque dois agentes trabalhando ao mesmo tempo são dois planos e juntá-los
leria como um só com progresso contraditório. O lado do valor não guarda referência para `Session`,
então subagent terminado continua coletável. `owner` é `main` ou o nome do agente; o cabeçalho por
autor só aparece quando há mais de uma lista. Lista zerada remove o grupo em vez de deixar um vazio, e
`/clear` limpa o plano junto com o contexto.

### Workflows: visualizador, aninhamento e orçamento

Faltavam três coisas que o Claude Code tem. As três entraram:

- **`/workflows` virou visualizador.** A rodada é registrada num `WeakMap` na sessão **raiz** (mesmo
  padrão das tasks, mesmo motivo: rodada iniciada dentro de subagent tem de aparecer na janela que o
  usuário está olhando), com passo, fase, estado, chars e tokens. O modal agrupa por fase na ordem em
  que elas apareceram e mostra o **rabo** da lista quando não cabe — o que está rodando agora é o que
  se abriu o modal para ver. O ticker de 80 ms já marca `dirty` com modal aberto, então atualiza
  sozinho. O toggle foi para trás de `on`/`off`: olhar o progresso não pode desligar a orquestração.
- **`workflow(nome | {scriptPath}, args?)` dentro do script.** Compartilha limitador, contador,
  journal e orçamento — aninhar não podia dobrar a concorrência nem reiniciar a numeração. Um nível
  só. A fase do filho vem prefixada (`▸ nome`) e a do pai é **restaurada** no `finally`: sem isso o
  passo seguinte do pai herdava a última fase do filho (foi o que o teste pegou).
- **Orçamento em tokens de saída** (`workflows.tokenBudget` ou `budget` na chamada), teto duro: o
  passo que cruzaria falha em vez de rodar. Medido pelos eventos `usage` do provider.

Achado de tabela: o provider simulado dos testes emitia `usage` na forma **flat**
(`{inputTokens: 3}`), que é a do nível core; o nível provider (`LanguageModelV4`) usa aninhado
(`{inputTokens: {total, noCache, …}}`). Com a forma errada o SDK reportava tokens indefinidos, e foi
o que escondeu o gasto dos passos por uma rodada inteira de depuração. Fixture corrigida.

Não implementado do que o Claude Code tem aqui: rodada em background com notificação, `effort` por
passo, isolamento em worktree, e `whenToUse` dos workflows salvos indo para o contexto do modelo.

### Paridade com o Claude Code: caching, hooks de permissão, comandos

Fechados os três primeiros itens do `docs/claude-code-vs-bytecode.md`:

- **Prompt caching** (`core/cache.ts`). Dois breakpoints: fim do system e fim do request (rolante — o
  cache que este step escreve é o prefixo que o próximo lê). Liga sozinho no `@ai-sdk/anthropic`,
  forçável com `"cache": { "enabled": true, "ttl": "1h" }`.
- **Hooks de permissão**: `PermissionRequest` (decide pelo usuário), `Notification` (só quando o
  turno vai mesmo parar) e `PermissionDenied` (com `source`: `policy`, `hook` ou `user`).
- **Comandos de usuário**: `$1..$9`, `description`/`argument-hint` na lista, `model:` e
  `allowed-tools:` valendo pelo turno, `commands/git/pr.md` → `/git:pr`.

Duas correções do próprio doc, que estava errado: comandos de `~/.claude/commands/*.md` **já
rodavam** (`loadCommands` + `expandCommand`, envelope idêntico ao do Claude Code) — faltava só o
acabamento; e a contagem de hooks era 12, não 11.

Dois bugs encontrados só porque o teste rodou o loop de verdade:

- `role: 'system'` dentro de `messages` é **recusado** pelo AI SDK v7 (`System messages are not
  allowed in the prompt or messages fields`), e o `onError` do loop engolia a exceção: o turno
  falhava calado e a asserção via o prompt do turno anterior. O system passou a ir como
  `SystemModelMessage` no parâmetro `system`, que é a única forma que carrega `providerOptions`.
- `registerTools()` só **somava** tools. Numa sessão já populada, `allowed-tools` de um comando não
  restringia nada — ficou declarativa: o que está fora da lista sai do registry (menos `ToolSearch`).

### Tabela e diff saíam quebrados na tela

`renderMarkdown` não tinha **nenhum** tratamento de tabela: a linha caía no wrap de texto, então os
`|`, a linha `|---|` e a quebra no meio da célula iam para a tela. Agora há um renderer de tabela
(colunas, alinhamento, célula que quebra em vez de truncar, `\|` escapado, fallback para registro
quando nem a maior palavra de uma coluna caberia) e o resto do markdown que faltava: lista ordenada,
task list, régua, ênfase, riscado e link com URL visível.

O diff virou layout de editor: cabeçalho de arquivo, faixa de hunk com contexto, numeração dos dois
lados, realce do trecho que mudou dentro da linha, e quebra que **preserva indentação**.

E passou a valer nos três lugares onde diff aparece, não só no preview de tool: bloco de código na
resposta e diff colado solto no texto também são detectados. Era o buraco que aparecia na prática —
o modelo rodava `git diff`, colava a saída numa cerca, e ela saía como código cinza atrás do trilho.

Depois veio o `ctrl+y` (e o clique) alternando agrupado ↔ lado a lado, com a dica do atalho na régua
do arquivo, e a paleta trocada para banda pastel clara com texto escuro — só na linha alterada, com
um pastel mais forte no trecho que mudou.

Três bugs achados no caminho:

- **O `ctrl+y` alternava o estado e a tela não mudava**: `renderCached` guarda as linhas por bloco com
  uma assinatura que tinha largura e versão do tema, mas não o layout do diff. O cache servia as
  linhas renderizadas antes do toggle. O layout entrou na assinatura.
- `tint()` não reabria o fundo depois de um reset ANSI, então a banda de `+`/`-` parava na primeira
  cor da linha — o mesmo defeito que `barLine()` já tratava desde antes.
- O regex de link casava o `[` de uma sequência ANSI já injetada (`ESC[3m`), engolindo a formatação
  até o `](url)` seguinte. Links passaram a ser resolvidos **antes** de qualquer cor entrar.

### Tela de alterações (`ctrl+g`)

Arquivos que `Write`/`Edit` tocaram, agrupados pelo caminho, com o diff do selecionado ao lado —
agrupado ou lado a lado, o mesmo renderer do `git diff`.

- O baseline é gravado na **primeira** escrita de cada arquivo, então a tela mostra o diff da sessão
  inteira e não do último edit.
- Estado na sessão **raiz** (mesmo padrão de tasks e workflows): escrita dentro de subagent aparece
  na janela que o usuário tem aberta.
- É uma view, não um modo: abrir não pausa o turno, não mexe no contexto e não grava mensagem.
- Atalho `ctrl+g`. **Colide com o Claude Code**, onde `ctrl+g` é `chat:externalEditor` (medido no
  binário 2.1.220) — aqui o slot está livre porque não existe edição em editor externo, mas quem vem
  de lá com memória muscular vai estranhar. Trocar é uma linha.
- O clique só alterna o layout quando cai **no rótulo `ctrl+y`** da régua. A primeira versão usava "o
  bloco contém um diff" como alvo, e aí clicar em qualquer linha da resposta remontava o diff.
- Diff próprio (corte de prefixo/sufixo + LCS no miolo, teto de 1500 linhas), sem depender de `git` —
  o repo do usuário pode não ser um.
- Cada arquivo guarda **quem escreveu** (`main` ou o nome do agente); a tela imprime a origem só
  quando há subagent envolvido.

### Três defeitos de quadro achados na tela

- **Coluna direita perdendo caractere.** O orçamento de código subtraía uma célula a menos que a
  calha real (`1234 + `), então cada linha quebrada saía uma coluna além do quadro e o `truncate`
  final comia o fim do texto. Valia para os dois layouts.
- **Cursor depois do placeholder.** O caret era desenhado *após* o texto de ajuda, o que fazia o
  placeholder parecer texto já digitado esperando edição. Agora ele vem antes, onde o primeiro
  caractere vai cair.
- **Assinatura oculta** no canto superior direito: SGR 8 (conceal) + fundo como cor de frente, dois
  mecanismos porque conceal é opcional. Só aparece ao selecionar a linha.

### Suítes subiam os MCP reais da máquina

O `hx.jsonc` do repo com `azure-devops` ligado fez a suíte da TUI **subir dois servidores npx de
verdade** (68 tools no relatório do `/context-all`, que passou a não caber na tela). A config é mesclada
do diretório do usuário para cima, então nenhuma suíte estava isolada disso — só não aparecia porque os
servidores falhavam. `BYTECODE_NO_MCP=1` agora desliga MCP na sessão; `test/run.mjs` define para todas
as suítes, e a da TUI afirma `## mcp — 0/0`.

Fica aberto o mesmo problema para **assets**: a suíte da TUI enxerga os agents reais da máquina
(`dispatcher`, `lean` vindos de `.opencode` de diretórios acima). Não quebra hoje, mas é a mesma classe
de vazamento.

### Paste ia para o campo errado

Colar dentro do modal do `connect` escrevia no composer atrás dele: o ramo de bracketed paste rodava
**antes** do `handleModalKey` e acrescentava em `input` sem olhar quem tinha o teclado. Uma chave de
API colada aparecia em texto puro na tela em vez de ir para o campo mascarado. Agora o paste é
roteado (modal de input → picker → busca de sessão → composer), campo de uma linha descarta a quebra
de linha que quase sempre vem no fim de uma chave copiada, e modal read-only **engole** o paste em
vez de deixar vazar para baixo.

De quebra: `connect` de provider já declarado na config não baixa mais o catálogo models.dev antes de
pedir a chave — a ordem estava invertida, o que impedia conectar offline algo que já está declarado.

### Housekeeping

- Removidos a pasta `-p/` e o arquivo `$null` da raiz (sobra de comando de shell mal interpretado).
- `package-lock.json` regenerado: `"name"` era `hx`, agora `bytecode`.
- `.gitignore` cobre `.bytecode/`, `.hx/`, `bytecode.local.jsonc` e `auth.json` — antes o diretório
  de estado novo não estava listado.
- Diagrama de arquitetura do README reescrito: faltavam `assets/`, `mcp/`, `util/` e sete módulos de
  `core/` que existem e são usados.
- `hx.jsonc` da raiz **auditado**: nenhuma chave literal, só `{env:ADO_PAT}`. Seguro versionar.

### Performance, com medição

| item | antes | depois |
|---|---|---|
| `loadAssets` por subagente (`Session.child`) | 14,8 ms × cada agente → **1,5 s** num workflow de 100 | herda do pai por referência: **0** |
| `loadCatalog` (cache de 3,2 MB) | 24,8 ms × ~4 por sessão | memoizado: **0,0 ms** |
| `contextTokens` com baseline | passada completa e descartada | só o trecho pós-baseline |
| `Transcript.append` | `mkdir` recursivo em toda gravação | uma vez por transcript |
| `isGitRepo` | `existsSync` **síncrono** por step do loop | cacheado |
| `saveSessionState` | lia `meta.json` do disco a cada turno | `createdAt` em memória |
| `Read` com offset/limit | lia o arquivo inteiro | stream acima de 2 MB, para na janela |
| `Edit` contagem | `split` alocando o arquivo inteiro | `indexOf` incremental |
| `readGitBranch` | `execSync` bloqueando o primeiro paint | `spawn`, header preenche depois |

Todos com teste: `test/perf.test.ts` cobre janela de `Read` (incluindo o caminho de stream em 4 MB),
herança de assets, memoização do catálogo, contagem de ocorrências (com caso sobreposto) e
`contextTokens` com e sem baseline.

## Fechado como "não vale" — com o número

- **Tool `WebSearch` nativa.** Um servidor MCP de busca entra no mesmo registry, com as mesmas
  permissões, hooks e deferral: **0 linhas** neste repositório. A versão nativa custaria ~60 linhas
  mais um adaptador de provedor para manter — e nos dois caminhos o usuário tem de obter a mesma
  chave de API, então a versão nativa não remove nem o atrito que a justificaria. `WebFetch` é outra
  história e continua na fila: essa não tem equivalente de zero linha.
- **Validador de JSON Schema em `structured.ts`.** No único call site que existia, a regra de
  compatibilidade necessária faria a validação não mudar comportamento nenhum — e a suíte de
  workflow já congela que chave extra tem de sobreviver. Ver o item de U1 acima.

- **Re-render do bloco vivo durante streaming.** A alegação de O(n²) está certa na forma. Medido:
  uma resposta de 20.000 chars custa **84 ms somados** ao longo de todo o streaming (0,17 ms por
  render). Uma resposta desse tamanho leva vários segundos para chegar. Otimizar isso é complexidade
  para economizar 84 ms diluídos.
- **`contextTokens` chamado por `draw()`.** Medido: **0,006 ms** por chamada com 400 mensagens →
  0,2 ms/s a 30 fps. A passada duplicada foi removida por ser trabalho morto óbvio, não por custo.
  Memoizar por chave seria complexidade sem retorno.
- **Memoizar `patternToRegExp`.** Medido: **0,0009 ms** para avaliar 6 regras. É o caminho mais
  quente do harness e continua irrelevante.
- **Cache de `buildToolSet` por step.** Reconstrói um objeto de ~12 entradas. Só faria sentido se o
  catálogo de tools ativas crescesse muito.
- **Paralelizar o fallback do `Grep` sem ripgrep.** O ripgrep é dependência opcional e é encontrado
  na prática; o caminho lento é raro. Se um dia importar, usar `Promise.all` com concorrência
  limitada.
- **Cache de `Read` por `(caminho, mtime)`.** Economiza I/O de disco mas não tokens de prompt — o
  conteúdo volta ao modelo de qualquer forma. O próprio levantamento já o classificava como baixo.
- **Throttle da escrita de `saveSessionState`.** O custo é O(turnos²) em I/O acumulado, mas é o preço
  da retomabilidade, e adiar a escrita troca custo por risco de perder o último turno. Ficou como
  está (escrita atômica em `.tmp` + `rename`), só sem a leitura redundante do `meta.json`.

## Aberto — decisão do usuário

- [ ] **Repositório Git.** `C:\Repositories\harness` não é um repo. Com `test/` e `.gitignore`
      prontos, `git init` é o passo natural — mas criar repositório é decisão de quem vai versionar.
- [ ] **`mcp__azure-devops` ligado e quebrado** em `~/.config/hx/hx.jsonc` (cópia da config do
      opencode). Mesmo defeito já corrigido no `hx.jsonc` do repo, mas o arquivo está fora do
      repositório, então a edição aguarda autorização. Dois problemas: `environment` vazio (nenhuma
      credencial chega ao servidor) e o nome `mcp__azure-devops`, que vira
      `mcp__mcp__azure_devops__<tool>` no registry. Patch: renomear para `azure-devops` e usar
      `"environment": { "PERSONAL_ACCESS_TOKEN": "{env:ADO_PAT_B64}" }` — ou apagar a entrada, já que a
      do projeto cobre.
- [ ] **Nove sessões de teste em `~/.hx/projects`** criadas por execuções antigas das suítes
      (`mock/tiny`, `fake/tiny`). Poluem a tela inicial. As suítes já não escrevem lá; a limpeza
      envolve apagar arquivos no diretório do usuário, então fica aguardando autorização. Há uma
      sessão real no meio (`#d3cc6f9a`, `9router/sonnet5`) que **não** deve ser tocada.
