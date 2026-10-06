# Secret manifest

Project: multi-google-mcp

This generated view contains variable names and operating metadata only. Secret values, vault session keys, recovery keys, and access tokens are forbidden.

| Variable | Purpose | Provider | Trust boundary | Owner | Rotation | Consumers | Status |
|---|---|---|---|---|---|---|---|
| `PROJECT_DATA_ROOT` | TODO: classify | Bitwarden Secrets Manager or deployment platform | development | Douglas | on compromise, ownership change, or provider policy |  | needs-classification |
| `MULTI_GOOGLE_CONFIG` | Path (not a secret) of the config file the server and consent CLI use; the file holds the OAuth client id and secret and per-account refresh tokens. Default ~/.config/multi-google-mcp/config.json; config.readonly.json beside it holds read-only grants and carries readOnly: true. | none (a file path) | development | Douglas | not applicable; rotate the tokens in the file by re-running add-account | src/config.ts, src/setup.ts, src/index.ts | classified |

Canonical source: `secret-manifest.json`
Refresh: `%USERPROFILE%\.agents\tools\Update-SecretManifest.cmd -Repository <repo>`
