# Remove a tarefa do coletor do Agendador de Tarefas.
#   powershell -ExecutionPolicy Bypass -File .\scripts\uninstall-task.ps1
param([string]$TaskName = 'Conexao - coletor')
$ErrorActionPreference = 'Stop'

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "Tarefa '$TaskName' removida."
} else {
  Write-Host "Tarefa '$TaskName' não encontrada (nada a remover)."
}
