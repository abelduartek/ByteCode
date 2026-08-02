// Revisão de código do diff atual, em duas fases.
//
// Este workflow existe para ser lido tanto quanto para ser rodado: ele é o
// exemplo de como usar `pipeline()` e de por que a verificação adversarial vale
// o custo. Copie e adapte — os números aqui são escolhas, não constantes
// sagradas.
//
//   bytecode --workflows
//   > rode o workflow code-review
//
// Passe `args` para revisar outra coisa:
//   { "base": "origin/main" }   compara com outro ponto
//   { "files": ["src/a.ts"] }   revisa uma lista explícita

export const meta = {
  name: 'code-review',
  description: 'Revisa o diff atual por dimensão e verifica cada achado adversarialmente',
  phases: [
    { title: 'Revisar', detail: 'um agente por dimensão, sobre os arquivos alterados' },
    { title: 'Verificar', detail: '3 votos por achado; 2 refutações matam' },
  ],
}

// As dimensões são separadas porque um agente só, com quatro perguntas, responde
// as quatro mal. Cada uma vira um agente com um enunciado estreito.
const DIMENSOES = [
  {
    chave: 'correção',
    pergunta:
      'Bugs de lógica: condição invertida, off-by-one, caso vazio não tratado, estado que ' +
      'sobrevive quando não devia, tipo que mente sobre o que carrega.',
  },
  {
    chave: 'erro',
    pergunta:
      'Tratamento de erro: rejeição não capturada, catch que engole a causa, recurso que ' +
      'vaza quando o caminho falha, operação que pendura sem timeout.',
  },
  {
    chave: 'segurança',
    pergunta:
      'Segredo em log ou em disco, entrada não validada chegando a shell/SQL/caminho de ' +
      'arquivo, permissão que falha aberta, dado de terceiro tratado como confiável.',
  },
  {
    chave: 'teste',
    pergunta:
      'Comportamento novo sem teste, teste que afirma sobre chamada em vez de resultado, ' +
      'caso de borda descrito no código e ausente na suíte.',
  },
]

const ACHADOS = {
  type: 'object',
  required: ['achados'],
  properties: {
    achados: {
      type: 'array',
      items: {
        type: 'object',
        required: ['arquivo', 'linha', 'severidade', 'titulo', 'cenario'],
        properties: {
          arquivo: { type: 'string', description: 'caminho relativo ao repositório' },
          linha: { type: 'integer' },
          severidade: { enum: ['crítico', 'alto', 'médio', 'baixo'] },
          titulo: { type: 'string', description: 'uma linha, o defeito em si' },
          cenario: {
            type: 'string',
            description: 'entradas ou estado concretos → comportamento errado. Sem isso não é achado.',
          },
        },
      },
    },
  },
}

const VEREDITO = {
  type: 'object',
  required: ['refuta', 'porque'],
  properties: {
    refuta: { type: 'boolean', description: 'true se o defeito não existe ou não é alcançável' },
    porque: { type: 'string', description: 'a evidência no código, não uma impressão' },
  },
}

const alvo = args?.files?.length
  ? `nos arquivos: ${args.files.join(', ')}`
  : `no diff contra ${args?.base ?? 'HEAD'}`

phase('Revisar')

// `pipeline` e não `parallel`: cada dimensão segue para a verificação assim que
// termina, em vez de esperar a mais lenta das quatro. Com uma barreira, metade
// da frota fica ociosa olhando a fase anterior fechar.
const porDimensao = await pipeline(
  DIMENSOES,

  dim =>
    agent(
      `Revise o código ${alvo}, procurando **apenas** por: ${dim.pergunta}\n\n` +
        `Leia os arquivos alterados por inteiro antes de afirmar qualquer coisa — um diff ` +
        `esconde o contexto que decide se algo é defeito.\n\n` +
        `Relate só o que você consegue demonstrar com um cenário concreto. Nada de estilo, ` +
        `nada de "considere extrair", nada de elogio.`,
      { label: `revisar:${dim.chave}`, phase: 'Revisar', schema: ACHADOS },
    ),

  (revisao, dim) => {
    if (!revisao?.achados?.length) return []
    return parallel(
      revisao.achados.map(achado => () => julgar(achado, dim.chave)),
    )
  },
)

// Três votos, e são precisos **dois para matar**. A assimetria é deliberada: o
// default é manter. Numa revisão, deixar passar um defeito real custa mais que
// gastar a leitura de um falso positivo — então o sistema só descarta quando a
// maioria consegue refutar.
async function julgar(achado, dimensao) {
  const lentes = [
    'O cenário descrito é alcançável a partir de como esta função é chamada de verdade?',
    'Existe alguma guarda em outro lugar — no chamador, num wrapper, num tipo — que já impede isto?',
    'A linha e o arquivo citados contêm mesmo o que o achado afirma?',
  ]

  const votos = await parallel(
    lentes.map(lente => () =>
      agent(
        `Tente **refutar** este achado de revisão. Na dúvida, refute.\n\n` +
          `Arquivo: ${achado.arquivo}:${achado.linha}\n` +
          `Defeito: ${achado.titulo}\n` +
          `Cenário: ${achado.cenario}\n\n` +
          `Sua lente: ${lente}\n\n` +
          `Leia o código antes de responder.`,
        { label: `verificar:${achado.arquivo}`, phase: 'Verificar', schema: VEREDITO },
      ),
    ),
  )

  const refutacoes = votos.filter(Boolean).filter(v => v.refuta).length
  return {
    ...achado,
    dimensao,
    sobreviveu: refutacoes < 2,
    refutacoes,
    porques: votos.filter(Boolean).map(v => v.porque),
  }
}

const todos = porDimensao.flat().filter(Boolean)
const confirmados = todos.filter(a => a.sobreviveu)
const ordem = { crítico: 0, alto: 1, médio: 2, baixo: 3 }

log(`${confirmados.length} confirmados de ${todos.length} achados brutos`)

return {
  alvo,
  confirmados: confirmados.sort((a, b) => ordem[a.severidade] - ordem[b.severidade]),
  descartados: todos
    .filter(a => !a.sobreviveu)
    .map(a => ({ arquivo: a.arquivo, titulo: a.titulo, refutacoes: a.refutacoes })),
}
