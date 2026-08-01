<#
.SYNOPSIS
  Coloca "Abrir com <ferramenta> aqui" no menu de contexto de pasta do Explorer.

.DESCRIPTION
  Funciona para ByteCode, opencode e Claude Code. Cada um usa um nome de chave
  próprio, então podem conviver no mesmo menu — como Git GUI e Git Bash convivem.

  Escreve duas chaves por ferramenta, e só em HKCU (o seu usuário, sem admin):

    Directory\shell\<Nome>              botão direito EM uma pasta
    Directory\Background\shell\<Nome>   botão direito DENTRO de uma pasta, no vazio

  São duas porque o Windows trata os dois cliques como contextos diferentes — é
  por isso que o Git instala "Open Git Bash here" nos dois lugares.

  Nada fora de HKCU é tocado, e -Remove desfaz exatamente o que foi criado.
  Rode com -DryRun primeiro: ele imprime o que faria e não escreve nada.

.PARAMETER Tool
  bytecode, opencode, claude, ou all (todas as que estiverem instaladas).

.PARAMETER Remove
  Apaga as chaves em vez de criar.

.PARAMETER DryRun
  Mostra o que seria escrito e não escreve nada.

.PARAMETER Label
  Texto do item no menu. Padrão: "Abrir com <Ferramenta> aqui".
  Ignorado com -Tool all, que usa o padrão de cada uma.

.EXAMPLE
  .\windows-context-menu.ps1 -Tool all -DryRun
  .\windows-context-menu.ps1 -Tool all
  .\windows-context-menu.ps1 -Tool opencode
  .\windows-context-menu.ps1 -Tool all -Remove
#>
[CmdletBinding()]
param(
  [ValidateSet('bytecode', 'opencode', 'claude', 'all')]
  [string]$Tool = 'all',
  [switch]$Remove,
  [switch]$DryRun,
  [string]$Label,
  # Para quem tem o ByteCode em outro lugar que não a pasta acima deste script —
  # o caso de quem recebeu só o .ps1 por mensagem.
  [string]$BytecodePath
)

$ErrorActionPreference = 'Stop'

<#
  Caminho do .exe de um CLI instalado por npm.

  Aponta para dentro de node_modules, não para o atalho na raiz do npm: o atalho
  `nome` é um script sh e o `nome.cmd` sobe um cmd.exe. Medido: o shim sh custa
  ~310 ms e o .cmd ~32 ms por execução. O menu de contexto pode pular os dois.
#>
function Resolve-NpmExe {
  param([string]$Package, [string]$Exe)

  $roots = @()
  if ($env:APPDATA) { $roots += (Join-Path $env:APPDATA 'npm\node_modules') }
  $npm = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npm) { $roots += (Join-Path (Split-Path -Parent $npm.Source) 'node_modules') }

  foreach ($root in $roots) {
    $candidate = Join-Path $root "$Package\bin\$Exe"
    if (Test-Path $candidate) { return $candidate }
  }

  # Sem o .exe no lugar esperado, o nome no PATH resolve (pagando o shim).
  $onPath = Get-Command $Exe -ErrorAction SilentlyContinue
  if ($onPath) { return $onPath.Source }
  return $null
}

<#
  Descrição de uma ferramenta, ou $null quando ela não está instalada nesta
  máquina. `Missing` explica o que falta, para o -Tool all poder pular dizendo
  o porquê em vez de falhar em silêncio.
#>
function Get-ToolSpec {
  param([string]$Name)

  switch ($Name) {
    'bytecode' {
      # Ordem: o caminho que a pessoa passou, depois o repositório em volta deste
      # script. Nada de adivinhar em C:\ — um palpite errado grava um atalho que
      # abre outra coisa, o que é pior do que não gravar nada.
      $repo = if ($BytecodePath) { $BytecodePath } else { Split-Path -Parent $PSScriptRoot }
      $entry = Join-Path $repo 'bin\bytecode.mjs'
      if (-not (Test-Path $entry)) {
        return @{
          Missing = "não achei bin\bytecode.mjs em $repo. " +
            'Rode de dentro do repositório do ByteCode, ou passe -BytecodePath C:\caminho\do\harness'
        }
      }
      $node = Get-Command node.exe -ErrorAction SilentlyContinue
      if (-not $node) {
        return @{ Missing = 'o ByteCode precisa do Node no PATH, e não achei node.exe' }
      }
      return @{
        Key  = 'ByteCode'
        Nice = 'ByteCode'
        # Aspas simples no caminho: com aspas duplas ele fecharia a string do
        # -Command e o comando chegaria partido ao shell.
        Inner = "node '$entry'"
        Icon = $node.Source
      }
    }
    'opencode' {
      $exe = Resolve-NpmExe -Package 'opencode-ai' -Exe 'opencode.exe'
      if (-not $exe) { return @{ Missing = 'opencode não encontrado (npm i -g opencode-ai)' } }
      return @{ Key = 'OpenCode'; Nice = 'opencode'; Inner = "& '$exe'"; Icon = $exe }
    }
    'claude' {
      $exe = Resolve-NpmExe -Package '@anthropic-ai\claude-code' -Exe 'claude.exe'
      if (-not $exe) { return @{ Missing = 'Claude Code não encontrado (npm i -g @anthropic-ai/claude-code)' } }
      return @{ Key = 'ClaudeCode'; Nice = 'Claude Code'; Inner = "& '$exe'"; Icon = $exe }
    }
  }
}

# Windows Terminal quando existir: abre numa aba já no diretório certo (-d "%V").
# Sem ele, PowerShell direto. Nos dois casos o shell fica aberto depois que a
# ferramenta sai — senão um erro de inicialização fecharia a janela antes de dar
# tempo de ler.
$wt = Get-Command wt.exe -ErrorAction SilentlyContinue

function Build-Command {
  param([string]$Inner)
  if ($wt) {
    return "`"$($wt.Source)`" -d `"%V`" powershell.exe -NoExit -Command `"$Inner`""
  }
  return "powershell.exe -NoExit -Command `"Set-Location -LiteralPath '%V'; $Inner`""
}

$wanted = if ($Tool -eq 'all') { @('bytecode', 'opencode', 'claude') } else { @($Tool) }
$feito = 0

foreach ($name in $wanted) {
  $spec = Get-ToolSpec -Name $name

  if ($spec.Missing) {
    # Com -Remove a chave pode existir mesmo sem a ferramenta (desinstalada
    # depois), então o nome da chave é fixo e a limpeza continua possível.
    if (-not $Remove) {
      if ($Tool -eq 'all') { Write-Output "pulando $name : $($spec.Missing)"; continue }
      # Mensagem limpa em vez de `throw`: o stack trace do PowerShell não ajuda
      # quem só quer o item no menu.
      Write-Output "Não dá para instalar $name : $($spec.Missing)"
      exit 1
    }
    $spec = @{ Key = @{ bytecode = 'ByteCode'; opencode = 'OpenCode'; claude = 'ClaudeCode' }[$name]; Nice = $name }
  }

  $keys = @(
    "HKCU:\Software\Classes\Directory\shell\$($spec.Key)",
    "HKCU:\Software\Classes\Directory\Background\shell\$($spec.Key)"
  )

  if ($Remove) {
    foreach ($key in $keys) {
      if (Test-Path $key) {
        if ($DryRun) { Write-Output "removeria $key" }
        else {
          Remove-Item -Path $key -Recurse -Force
          Write-Output "removido  $key"
        }
      } else {
        Write-Output "já não existe $key"
      }
    }
    $feito++
    continue
  }

  $texto = if ($Tool -eq 'all' -or -not $Label) { "Abrir com $($spec.Nice) aqui" } else { $Label }
  $command = Build-Command -Inner $spec.Inner

  Write-Output ''
  Write-Output "$($spec.Nice)"
  Write-Output "  menu    : $texto"
  Write-Output "  comando : $command"

  foreach ($key in $keys) {
    if ($DryRun) {
      Write-Output "  criaria : $key"
      continue
    }
    New-Item -Path $key -Force | Out-Null
    New-ItemProperty -Path $key -Name '(Default)' -Value $texto -PropertyType String -Force | Out-Null
    if ($spec.Icon) {
      New-ItemProperty -Path $key -Name 'Icon' -Value $spec.Icon -PropertyType String -Force | Out-Null
    }
    $cmdKey = Join-Path $key 'command'
    New-Item -Path $cmdKey -Force | Out-Null
    New-ItemProperty -Path $cmdKey -Name '(Default)' -Value $command -PropertyType String -Force | Out-Null
    Write-Output "  criado  : $key"
  }
  $feito++
}

Write-Output ''
if ($feito -eq 0) {
  Write-Output 'Nada a fazer — nenhuma das ferramentas foi encontrada.'
} elseif ($DryRun) {
  Write-Output 'Simulação: nada foi escrito. Rode de novo sem -DryRun para aplicar.'
} elseif (-not $Remove) {
  Write-Output 'Pronto. No Windows 11 o item fica em "Mostrar mais opções" (shift+F10 abre o menu clássico direto).'
  Write-Output 'Para desfazer: -Remove'
}
