#Requires -Version 7
<#
.SYNOPSIS
  Runs the multi-google connector in HTTP mode. Launched by the "multi-google-connector" Scheduled Task.
  Exits with node's exit code so the task's restart-on-failure applies. Logs go to
  %USERPROFILE%\.config\multi-google-mcp\connector.log (startup lines only; the server logs no secrets).
#>
param([string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path)
$ErrorActionPreference = 'Stop'
$logDir = Join-Path $env:USERPROFILE '.config\multi-google-mcp'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$env:MCP_TRANSPORT = 'http'
if (-not $env:PORT) { $env:PORT = '8787' }
Set-Location -LiteralPath $RepoPath
& node (Join-Path $RepoPath 'dist\index.js') --http *>> (Join-Path $logDir 'connector.log')
exit $LASTEXITCODE
