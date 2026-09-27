# Rodada agendada do coletor (chamada pelo Agendador de Tarefas; ver install-task.ps1).
# 1. Coleta os 8 trechos x 5 dias (npm run collect -- --legs all --days 5 --notify).
#    Em quarentena por bloqueio (24 h, collector\.quarantine.json), não abre página nenhuma.
#    Inclui as datas monitoradas no app (--watched), até 30 dias.
# 2. Atende os pedidos "atualizar agora" pendentes (npm run worker -- --once).
# 3. Avalia os alertas das datas monitoradas e avisa no Telegram (npm run alerts).
# Log em collector\logs\AAAA-MM-DD_HHMM.log; mantém só os 30 mais recentes.
$ErrorActionPreference = 'Continue'

$collector = Split-Path -Parent $PSScriptRoot
$logs = Join-Path $collector 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
$log = Join-Path $logs ((Get-Date -Format 'yyyy-MM-dd_HHmm') + '.log')

function Write-Log([string]$msg) {
  Add-Content -Path $log -Encoding UTF8 -Value ('[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $msg)
}

# Roda um comando npm pelo cmd, anexando stdout+stderr ao log (bytes UTF-8 do Node, sem conversão).
function Invoke-Npm([string]$npmArgs) {
  Write-Log "npm $npmArgs"
  & cmd.exe /d /c "npm $npmArgs >> `"$log`" 2>&1"
  return $LASTEXITCODE
}

Set-Location $collector
Write-Log 'Início da rodada agendada'

$code = Invoke-Npm 'run collect -- --legs all --days 5 --watched --notify'
Write-Log "collect terminou com código $code"

if ($code -eq 3) {
  # Bloqueio: regra do CLAUDE.md, não insistir. Quarentena de 24 h; os pedidos ficam na fila.
  Write-Log 'Bloqueio detectado: pedidos pendentes não serão atendidos agora.'
} else {
  $wcode = Invoke-Npm 'run worker -- --once'
  Write-Log "worker --once terminou com código $wcode"
  if ($code -eq 0 -and $wcode -ne 0) { $code = $wcode }
}

# Alertas só leem o banco (nenhum site): rodam mesmo depois de um bloqueio.
$acode = Invoke-Npm 'run alerts'
Write-Log "alerts terminou com código $acode"

# Mantém só os 30 logs mais recentes (o nome já ordena por data).
Get-ChildItem -Path $logs -Filter '*.log' | Sort-Object Name -Descending |
  Select-Object -Skip 30 | Remove-Item -Force

Write-Log 'Fim'
exit $code
