#Requires -Version 7
<#
.SYNOPSIS
  Runs the multi-google connector in HTTP mode. Launched by the "multi-google-connector" Scheduled Task.
.DESCRIPTION
  The Funnel is on only while this connector is the process listening on its port:
  1. Removes this connector's Funnel mount (left over from a crash or a stopped task).
  2. Starts node; once node itself owns the listening socket on 127.0.0.1:<port>, publishes it with Funnel.
  3. When node exits (any code), removes the mount again, then exits with node's code so the task's
     restart-on-failure applies. No other process can be served unauthenticated in the restart window.
  Port comes from MULTI_GOOGLE_PORT (default 47887); generic PORT is ignored.
  Logs: %USERPROFILE%\.config\multi-google-mcp\connector.log (startup lines only; the server logs no secrets).
#>
param([string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FunnelMount.psm1') -Force
$logDir = Join-Path $env:USERPROFILE '.config\multi-google-mcp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$log = Join-Path $logDir 'connector.log'
function Write-Log([string]$m) { Add-Content -LiteralPath $log -Value "$(Get-Date -Format o) [start-connector] $m" }

$port = if ($env:MULTI_GOOGLE_PORT) { [int]$env:MULTI_GOOGLE_PORT } else { 47887 }
$env:MULTI_GOOGLE_PORT = [string]$port
$env:MCP_TRANSPORT = 'http'

if (Disable-ConnectorFunnel $port) { Write-Log 'removed a stale funnel mount before start' }

Set-Location -LiteralPath $RepoPath
$node = (Get-Command node).Source
$proc = Start-Process -FilePath $node -ArgumentList @((Join-Path $RepoPath 'dist\index.js'), '--http') `
  -WorkingDirectory $RepoPath -NoNewWindow -PassThru `
  -RedirectStandardError (Join-Path $logDir 'connector.stderr.log') -RedirectStandardOutput (Join-Path $logDir 'connector.stdout.log')
$null = $proc.Handle # cache the handle so ExitCode is readable after exit

$funnelOn = $false
try {
  # Publish only once node itself listens on the port (never another process that grabbed it).
  $deadline = (Get-Date).AddSeconds(60)
  while (-not $proc.HasExited -and (Get-Date) -lt $deadline) {
    $owner = Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1 -ExpandProperty OwningProcess
    if ($owner -eq $proc.Id) {
      Enable-ConnectorFunnel $port
      $funnelOn = $true
      Write-Log "listening on 127.0.0.1:$port (pid $($proc.Id)); funnel on"
      break
    }
    Start-Sleep -Milliseconds 500
  }
  if (-not $funnelOn -and -not $proc.HasExited) {
    Write-Log "node did not listen on 127.0.0.1:$port within 60 s; stopping it"
    Stop-Process -Id $proc.Id -Force
  }
  $proc.WaitForExit()
} finally {
  if (Disable-ConnectorFunnel $port) { Write-Log 'funnel off' }
}
$code = if ($funnelOn) { $proc.ExitCode } else { [Math]::Max(1, $proc.ExitCode) }
Write-Log "node exited with $($proc.ExitCode)"
exit $code
