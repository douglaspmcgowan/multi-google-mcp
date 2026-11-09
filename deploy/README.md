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
   It prints the connector URL and the Google redirect URI. Upgrading from the first version: it removes the `PORT=8787` / `PUBLIC_BASE_URL` User variables that version wrote (only if unchanged) and its `127.0.0.1:8787` Funnel mount.
5. **Add the Google redirect URI.** Google Cloud console → APIs & Services → Credentials → the OAuth client already in `config.json` → Authorized redirect URIs: add `https://<node>.<tailnet>.ts.net/oauth/google/callback` (printed by step 4).
6. **Add the connector.** claude.ai → Settings → Connectors → Add custom connector → URL `https://<node>.<tailnet>.ts.net/mcp`. Leave client ID/secret empty (the server supports dynamic registration). Click Connect: the page says the client **awaits approval on the host** and shows its client id and registration time.
7. **Approve the client on the host** (works while the server runs), then click Connect again and sign in with an allowed Google account:
   ```powershell
   Set-Location -LiteralPath 'C:\Users\dougl\multi-google-mcp'; npm run clients:list
   Set-Location -LiteralPath 'C:\Users\dougl\multi-google-mcp'; npm run clients:approve -- <client_id>
   ```
   Approve only an id whose registration time matches your click. Unapproved registrations expire after 24 h.

## Clients

| Command | Effect |
|---|---|
| `npm run clients:list` | every registered client: id, PENDING/approved, name, registration time, redirect host, live tokens |
| `npm run clients:approve -- <client_id>` | lets that client complete sign-in |
| `npm run clients:revoke -- <client_id>` | deletes the client and every code and token issued to it |

All three, and `store:migrate`, are safe while the server runs: each write takes a lock file beside the store and re-reads it first, and the server re-reads the store when it changes.

## What runs

- Scheduled Task `multi-google-connector`: starts at your logon (interactive, no stored password), restarts every minute on failure. **The connector runs only after you log in to SYSTEMATICCHAOS**; after a reboot it is down until then.
- Server: `node dist/index.js --http` on `127.0.0.1:47887` only. `Start-Connector.ps1` turns the Funnel mount (`https:443 /`) on only once node itself owns that socket and off whenever node exits, so nothing else on the port is ever published. Install and uninstall touch only that mount, and only while it points at the connector's port.
- State: `%USERPROFILE%\.config\multi-google-mcp\store.enc` (AES-256-GCM; key `MULTI_GOOGLE_STORE_KEY`). The key sits in your HKCU User environment on the same machine as the store, so encryption protects a leaked copy of the file (backups, sync, a copied folder), **not** a compromise of your logged-in account.
- Sign-in: `/authorize` sets an HttpOnly, Secure, SameSite=Lax cookie; consent is a POST and the Google callback requires the same cookie, so a sign-in link sent from someone else's session cannot complete in your browser. Clients need host approval (step 7).
- Rate limits: key on the client IP. Funnel sets `X-Forwarded-For` to the public client IP ([tailscale `serve.go` `addProxyForwardedHeaders`](https://github.com/tailscale/tailscale/blob/62d055f4c38b610d63a8cee7fa4a7e65b01564eb/ipn/ipnlocal/serve.go#L1155-L1163)); Express trusts that header only from loopback.
- Audit: `%USERPROFILE%\.config\multi-google-mcp\audit.log`, one JSON line per tool call (time, tool, account, ok).
- In remote mode, tools that read or write a file on the host (downloads, uploads, attachments, thumbnails) are refused.

## Environment

| Variable | Meaning |
|---|---|
| `MULTI_GOOGLE_STORE_KEY` | 32-byte base64 key; HTTP mode refuses to start without it |
| `MULTI_GOOGLE_PUBLIC_BASE_URL` | Funnel origin, set by the installer |
| `ALLOWED_EMAILS` | comma list of Google accounts allowed to sign in; removing one ends its grants on the next call or refresh |
| `MULTI_GOOGLE_PORT` | default 47887. Generic `PORT` / `PUBLIC_BASE_URL` are ignored |
| `MULTI_GOOGLE_STORE`, `MULTI_GOOGLE_AUDIT_LOG` | optional path overrides |

## Remove

```powershell
& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File 'C:\Users\dougl\multi-google-mcp\deploy\systematicchaos\Uninstall-ConnectorHost.ps1'
```
To end one client's access: `npm run clients:revoke -- <client_id>`. To revoke every issued connector token, stop the task and delete `store.enc`, then re-run `npm run store:migrate`.
