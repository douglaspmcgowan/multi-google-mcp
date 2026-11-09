#Requires -Version 7
<#
.SYNOPSIS
  Stops and removes the multi-google connector host: the Scheduled Task and this connector's Funnel mount
  (https:443 "/" only while it proxies to the connector's port; other serve/funnel config is untouched).
  Leaves the encrypted store, MULTI_GOOGLE_STORE_KEY and config.json in place. Supports -WhatIf.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [string]$TaskName = 'multi-google-connector',
  [int]$Port = $(if ([Environment]::GetEnvironmentVariable('MULTI_GOOGLE_PORT', 'User')) { [int][Environment]::GetEnvironmentVariable('MULTI_GOOGLE_PORT', 'User') } else { 47887 })
)
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'FunnelMount.psm1') -Force
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister Scheduled Task')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
} else {
  Write-Host "Scheduled Task $TaskName not present."
}
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  if ($PSCmdlet.ShouldProcess("https:443 / -> http://127.0.0.1:$Port", 'Remove this connector''s funnel mount')) {
    if (Disable-ConnectorFunnel $Port) { Write-Host 'Funnel mount removed.' }
    else { Write-Host "No funnel mount for http://127.0.0.1:$Port; other serve config left as is." }
  }
}
Write-Host 'Connector host removed. The encrypted store and keys were left untouched.'
