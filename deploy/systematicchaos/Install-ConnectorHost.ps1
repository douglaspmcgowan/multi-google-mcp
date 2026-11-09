#Requires -Version 7
<#
.SYNOPSIS
  Installs the multi-google remote connector on this Windows host (SYSTEMATICCHAOS). Idempotent; supports -WhatIf.
.DESCRIPTION
  1. Checks node, npm, tailscale, and that MULTI_GOOGLE_STORE_KEY exists in the User environment (by name only; the value is never read).
  2. npm ci + npm run build.
  3. Sets User env MULTI_GOOGLE_PUBLIC_BASE_URL (this node's Funnel URL) and MULTI_GOOGLE_PORT. No generic variable
     (PORT, PUBLIC_BASE_URL) is written: other dev servers read those, and one landing on the Funnel port would be served
     publicly without auth. Removes PORT / PUBLIC_BASE_URL User values that the previous installer version wrote
     (only when they still hold the values it wrote: PORT=8787, PUBLIC_BASE_URL=this node's Funnel URL).
  4. Registers Scheduled Task "multi-google-connector": at the current user's logon, interactive token (no stored password),
     restart every minute on failure, no time limit. Starts it. Start-Connector.ps1 turns the Funnel mount on only once
     node listens, and off whenever node exits.
  5. Prints the connector URL to paste into claude.ai Settings > Connectors.
  No password, autologon or stored credential is used or written.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$RepoPath = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path,
  [int]$Port = 47887,
  [string]$TaskName = 'multi-google-connector'
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FunnelMount.psm1') -Force

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

$rootProxy = Get-FunnelRootProxy
$legacyTarget = 'http://127.0.0.1:8787'
if ($rootProxy -and $rootProxy.TrimEnd('/') -notin @("http://127.0.0.1:$Port", $legacyTarget)) {
  throw "https:443 / already serves $rootProxy; not replacing it."
}

if ($PSCmdlet.ShouldProcess($RepoPath, 'npm ci; npm run build')) {
  Push-Location -LiteralPath $RepoPath
  try {
    npm ci
    if ($LASTEXITCODE -ne 0) { throw 'npm ci failed' }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  } finally { Pop-Location }
}

if ($PSCmdlet.ShouldProcess('User environment', "Set MULTI_GOOGLE_PUBLIC_BASE_URL=$publicBaseUrl, MULTI_GOOGLE_PORT=$Port")) {
  [Environment]::SetEnvironmentVariable('MULTI_GOOGLE_PUBLIC_BASE_URL', $publicBaseUrl, 'User')
  [Environment]::SetEnvironmentVariable('MULTI_GOOGLE_PORT', [string]$Port, 'User')
}

# Previous version wrote generic PORT / PUBLIC_BASE_URL. Remove them only if they still hold its values.
$legacy = @{ PORT = '8787'; PUBLIC_BASE_URL = $publicBaseUrl }
foreach ($name in $legacy.Keys) {
  $value = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($null -ne $value -and $value -eq $legacy[$name]) {
    if ($PSCmdlet.ShouldProcess("User environment $name", 'Remove value written by the previous installer')) {
      [Environment]::SetEnvironmentVariable($name, $null, 'User')
    }
  } elseif ($null -ne $value) {
    Write-Warning "User env $name is set to a value this installer did not write; left unchanged. The connector ignores it."
  }
}

# Previous version published 127.0.0.1:8787; drop that mount (the start wrapper publishes the new port).
if ($rootProxy -and $rootProxy.TrimEnd('/') -eq $legacyTarget) {
  if ($PSCmdlet.ShouldProcess('https:443 /', "Remove legacy funnel mount $legacyTarget")) { [void](Disable-ConnectorFunnel 8787) }
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
  # The task inherits the User environment written above.
  Start-ScheduledTask -TaskName $TaskName
}

Write-Host ''
Write-Host "Connector URL (claude.ai > Settings > Connectors > Add custom connector):"
Write-Host "  $publicBaseUrl/mcp"
Write-Host "Google OAuth redirect URI to add in Google Cloud console:"
Write-Host "  $publicBaseUrl/oauth/google/callback"
Write-Host "After adding the connector, approve it on this host (deploy/README.md step 7)."
