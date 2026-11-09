# Remote connector host (SYSTEMATICCHAOS)

Runs multi-google as a remote MCP server that claude.ai and Claude Code cloud sessions add as a custom connector.
Only Google accounts listed in `ALLOWED_EMAILS` can sign in. Stdio mode (`npm start`) is unchanged.

All commands are PowerShell 7.

## Douglas's one-time steps, in order

1. **Enable Funnel for the node.** Tailscale admin console → Access controls: allow the `funnel` node attribute for SYSTEMATICCHAOS (and HTTPS certificates under DNS). Funnel docs: https://tailscale.com/kb/1223/funnel
2. **Create the store key and migrate tokens** (key goes straight to the User environment, never printed):
   ```powershell
   Set-Location -LiteralPath 'C:\Users\dougl\multi-google-mcp'; npm ci; npm run store:keygen
   ```
   Open a new PowerShell window, then:
   ```powershell
   Set-Location -LiteralPath 'C:\Users\dougl\multi-google-mcp'; npm run store:migrate
   ```
3. **Set `ALLOWED_EMAILS`** (comma list; empty refuses everyone):
   ```powershell
   [Environment]::SetEnvironmentVariable('ALLOWED_EMAILS', 'you@example.com', 'User')
   ```
4. **Install the host** (dry run first):
   ```powershell
   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File 'C:\Users\dougl\multi-google-mcp\deploy\systematicchaos\Install-ConnectorHost.ps1' -WhatIf
   & 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File 'C:\Users\dougl\multi-google-mcp\deploy\systematicchaos\Install-ConnectorHost.ps1'
   ```
   It prints the connector URL and the Google redirect URI.
5. **Add the Google redirect URI.** Google Cloud console → APIs & Services → Credentials → the OAuth client already in `config.json` → Authorized redirect URIs: add `https://<node>.<tailnet>.ts.net/oauth/google/callback` (printed by step 4).
6. **Add the connector.** claude.ai → Settings → Connectors → Add custom connector → URL `https://<node>.<tailnet>.ts.net/mcp`. Leave client ID/secret empty (the server supports dynamic registration). Sign in with an allowed Google account.

## What runs

- Scheduled Task `multi-google-connector`: starts at your logon (interactive, no stored password), restarts every minute on failure.
- Server: `node dist/index.js --http` on `127.0.0.1:8787` only; Funnel publishes it on 443.
- State: `%USERPROFILE%\.config\multi-google-mcp\store.enc` (AES-256-GCM; key `MULTI_GOOGLE_STORE_KEY`).
- Audit: `%USERPROFILE%\.config\multi-google-mcp\audit.log`, one JSON line per tool call (time, tool, account, ok).
- In remote mode, tools that read or write a file on the host (downloads, uploads, attachments, thumbnails) are refused.

## Environment

| Variable | Meaning |
|---|---|
| `MULTI_GOOGLE_STORE_KEY` | 32-byte base64 key; HTTP mode refuses to start without it |
| `PUBLIC_BASE_URL` | Funnel origin, set by the installer |
| `ALLOWED_EMAILS` | comma list of Google accounts allowed to sign in |
| `PORT` | default 8787 |
| `MULTI_GOOGLE_STORE`, `MULTI_GOOGLE_AUDIT_LOG` | optional path overrides |

## Remove

```powershell
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File 'C:\Users\dougl\multi-google-mcp\deploy\systematicchaos\Uninstall-ConnectorHost.ps1'
```
To revoke every issued connector token, stop the task and delete `store.enc`, then re-run `npm run store:migrate`.
