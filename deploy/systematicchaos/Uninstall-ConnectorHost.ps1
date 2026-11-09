#Requires -Version 7
<#
.SYNOPSIS
  Stops and removes the multi-google connector host: the Scheduled Task and the Funnel on 443.
  Leaves the encrypted store, MULTI_GOOGLE_STORE_KEY and config.json in place. Supports -WhatIf.
#>
[CmdletBinding(SupportsShouldProcess)]
param([string]$TaskName = 'multi-google-connector')
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  if ($PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister Scheduled Task')) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  }
} else {
  Write-Host "Scheduled Task $TaskName not present."
}
if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  if ($PSCmdlet.ShouldProcess('tailscale funnel', 'Turn off https:443')) {
    tailscale funnel --https=443 off
  }
}
Write-Host 'Connector host removed. The encrypted store and keys were left untouched.'
