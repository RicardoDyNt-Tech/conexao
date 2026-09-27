# Registra no Agendador de Tarefas a rodada diária do coletor (padrão: 07:00, 1x por dia).
# - Só roda com o usuário logado (Chrome precisa da sessão do usuário).
# - StartWhenAvailable: se o PC estava desligado no horário, roda assim que possível.
# Uso (PowerShell normal, sem precisar de administrador):
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-task.ps1
param(
  [string]$TaskName = 'Conexao - coletor',
  [string[]]$Times = @('07:00'),
  # Atraso aleatório de até N minutos em cada horário (coleta mais "humana"). 0 desliga.
  [int]$RandomDelayMinutes = 10
)
$ErrorActionPreference = 'Stop'

$script = Join-Path $PSScriptRoot 'run-scheduled.ps1'
$collector = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path $script)) { throw "Não achei $script" }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm não está no PATH deste usuário.' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`"" `
  -WorkingDirectory $collector

$triggers = foreach ($t in $Times) {
  $trigger = New-ScheduledTaskTrigger -Daily -At $t
  if ($RandomDelayMinutes -gt 0) { $trigger.RandomDelay = 'PT{0}M' -f $RandomDelayMinutes }
  $trigger
}

$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

$settings = New-ScheduledTaskSettingsSet `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2)

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $triggers `
  -Principal $principal -Settings $settings -Force `
  -Description 'Conexão: coleta ClickBus (8 trechos x 5 dias) + pedidos "atualizar agora". Ver collector/README.md.' |
  Out-Null

$info = Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo
Write-Host "Tarefa '$TaskName' registrada para $user nos horários $($Times -join ', ')."
Write-Host "Próxima execução: $($info.NextRunTime)"
Write-Host "Logs: $(Join-Path $collector 'logs')"
