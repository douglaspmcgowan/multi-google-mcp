#Requires -Version 7
<#
  Funnel helpers shared by the installer, the start wrapper and the uninstaller. They touch only the
  https:443 "/" mount and only while it proxies to this connector's loopback port, so any other serve or
  funnel configuration on the node is left alone. Removal uses `tailscale funnel --https=443 --set-path=/ off`,
  which deletes that one handler (tailscale cmd/tailscale/cli/serve_v2.go removeWebServe).
#>

function Get-ConnectorTarget([int]$Port) { "http://127.0.0.1:$Port" }

function Get-FunnelRootProxy {
  <# The proxy target of the https:443 "/" handler on this node, or $null. #>
  $json = tailscale serve status --json 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $json) { return $null }
  $cfg = $json | ConvertFrom-Json -AsHashtable
  if (-not $cfg -or -not $cfg.ContainsKey('Web') -or -not $cfg.Web) { return $null }
  foreach ($hp in $cfg.Web.Keys) {
    if ($hp -notmatch ':443$') { continue }
    $handlers = $cfg.Web[$hp].Handlers
    if ($handlers -and $handlers.ContainsKey('/')) { return [string]$handlers['/'].Proxy }
  }
  return $null
}

function Enable-ConnectorFunnel([int]$Port) {
  <# Publishes 127.0.0.1:<Port> on https:443 "/". Refuses when "/" already serves something else. #>
  $current = Get-FunnelRootProxy
  $target = Get-ConnectorTarget $Port
  if ($current -and $current.TrimEnd('/') -ne $target) {
    throw "https:443 / already serves $current; not replacing it. Remove that mount or pick another node."
  }
  tailscale funnel --bg --https=443 --set-path=/ $target | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'tailscale funnel failed. Enable Funnel for this node in the Tailscale admin console (deploy/README.md step 1).' }
}

function Disable-ConnectorFunnel([int]$Port) {
  <# Removes the https:443 "/" mount only when it proxies to this connector's port. Returns $true when removed. #>
  $current = Get-FunnelRootProxy
  if (-not $current -or $current.TrimEnd('/') -ne (Get-ConnectorTarget $Port)) { return $false }
  tailscale funnel --https=443 --set-path=/ off | Out-Null
  return ($LASTEXITCODE -eq 0)
}

Export-ModuleMember -Function Get-FunnelRootProxy, Enable-ConnectorFunnel, Disable-ConnectorFunnel
