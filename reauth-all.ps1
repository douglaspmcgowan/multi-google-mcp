# Re-consents every account in turn. Each sign-in opens in the browser with the
# right address pre-selected; the next one starts as soon as the last finishes.
# Usage: pwsh -File reauth-all.ps1            (all four)
#        pwsh -File reauth-all.ps1 berkeley   (only the labels named)
param([string[]]$Only)

$accounts = [ordered]@{
  berkeley = 'dpm5970@berkeley.edu'
  personal = 'douglaspmcgowan@gmail.com'
  pyrgos   = 'douglas@pyrgos.ai'
  bhouse   = '1636berkeley@gmail.com'
}

Set-Location $PSScriptRoot
$results = [ordered]@{}
foreach ($label in $accounts.Keys) {
  if ($Only -and $label -notin $Only) { continue }
  Write-Host "`n=== $label ($($accounts[$label])) ===" -ForegroundColor Cyan
  npx tsx src/setup.ts --add-account --account $label --login-hint $accounts[$label] --timeout-seconds 600
  $results[$label] = if ($LASTEXITCODE -eq 0) { 'ok' } else { 'FAILED' }
}

Write-Host "`n=== Summary ===" -ForegroundColor Cyan
$results.GetEnumerator() | ForEach-Object { Write-Host ("{0,-10} {1}" -f $_.Key, $_.Value) }
Write-Host "`nRestart Claude Code to load the new tokens and tools."
if ($results.Values -contains 'FAILED') { exit 1 }
