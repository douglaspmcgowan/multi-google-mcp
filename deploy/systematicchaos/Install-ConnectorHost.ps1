#Requires -Version 7
<#
.SYNOPSIS
  Installs the multi-google remote connector on this Windows host (SYSTEMATICCHAOS). Idempotent; supports -WhatIf.
.DESCRIPTION
  1. Checks node, npm, tailscale, and that MULTI_GOOGLE_STORE_KEY exists in the User environment (by name only; the value is never read).
  2. npm ci + npm run build.
  3. Sets User env PUBLIC_BASE_URL to this node's Tailscale Funnel URL and PORT.
  4. Registers Scheduled Task "multi-google-connector": at the current user's logon, interactive token (no stored password),
     restart every minute on failure, no time limit. Starts it.
  5. tailscale funnel --bg --https=443 http://127.0.0.1:<Port>
  6. Prints the connector URL to paste into claude.ai Settings > Connectors.
  No password, autologon or stored credential is used or written.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [int]$Port = 8787,
  [string]$TaskName = 'multi-google-connector'
)
$ErrorActionPreference = 'Stop'

foreach ($cmd in 'node', 'npm', 'tailscale') {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd is not on PATH." }
}
$userEnvNames = (Get-Item 'HKCU:\Environment').GetValueNames()
if ($userEnvNames -notcontains 'MULTI_GOOGLE_STORE_KEY') {
  throw "MULTI_GOOGLE_STORE_KEY is not in the User environment. Run 'npm run store:keygen' then 'npm run store:migrate' in $RepoPath first."
}
if ($userEnvNames -notcontains 'ALLOWED_EMAILS') {
  Write-Warning "ALLOWED_EMAILS is not set in the User environment: the connector will refuse every sign-in until it is (see deploy/README.md)."
}

$status = tailscale status --json | ConvertFrom-Json
$dnsName = ([string]$status.Self.DNSName).TrimEnd('.')
if (-not $dnsName) { throw 'Could not read this node''s Tailscale DNS name (is Tailscale logged in?).' }
$publicBaseUrl = "https://$dnsName"

if ($PSCmdlet.ShouldProcess($RepoPath, 'npm ci; npm run build')) {
  Push-Location -LiteralPath $RepoPath
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  } finally { Pop-Location }
}

if ($PSCmdlet.ShouldProcess('User environment', "Set PUBLIC_BASE_URL=$publicBaseUrl, PORT=$Port")) {
  [Environment]::SetEnvironmentVariable('PUBLIC_BASE_URL', $publicBaseUrl, 'User')
  [Environment]::SetEnvironmentVariable('PORT', [string]$Port, 'User')
}

$pwsh = (Get-Command pwsh).Source
$startScript = Join-Path $PSScriptRoot 'Start-Connector.ps1'
$user = "$env:USERDOMAIN\$env:USERNAME"
if ($PSCmdlet.ShouldProcess($TaskName, 'Register Scheduled Task (at logon, restart on failure)')) {
  $action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$startScript`" -RepoPath `"$RepoPath`"" -WorkingDirectory $RepoPath
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
  $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
  $settings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $TaskName
}

if ($PSCmdlet.ShouldProcess("https://$dnsName", "tailscale funnel --bg --https=443 http://127.0.0.1:$Port")) {
  tailscale funnel --bg --https=443 "http://127.0.0.1:$Port"
  if ($LASTEXITCODE -ne 0) { throw 'tailscale funnel failed. Enable Funnel for this node in the Tailscale admin console (deploy/README.md step 1).' }
}

Write-Host ''
Write-Host "Connector URL (claude.ai > Settings > Connectors > Add custom connector):"
Write-Host "  $publicBaseUrl/mcp"
Write-Host "Google OAuth redirect URI to add in Google Cloud console:"
Write-Host "  $publicBaseUrl/oauth/google/callback"
