# Multi-Google MCP

Connect multiple Google accounts to Claude Code at the same time. Read Gmail, send email, and manage Google Calendar across any number of accounts — personal, work, school, whatever.

Claude Code's built-in Google integrations only connect one account at a time. This is a local MCP server that fixes that.

---

## What You Get

Every tool takes an `account` parameter so Claude knows which Google account to use. Drive, Slides and Sheets tools are also registered; see `src/tools/`.

**Gmail**
- `gmail_search` — search emails using Gmail query syntax
- `gmail_read` — read a specific email by ID
- `gmail_send` — send an email
- `gmail_draft` — create a draft
- `gmail_list_labels` — list all Gmail labels

**Calendar**
- `calendar_list_events` — list upcoming events
- `calendar_create_event` — create an event
- `calendar_update_event` — update an existing event
- `calendar_delete_event` — delete an event
- `calendar_list_calendars` — list all calendars in the account

**Docs** (tab-aware: every tab has its own index space, and a request without a tabId edits the first tab)
- `docs_get_structure` — every tab's paragraphs with index ranges, styles and list nesting; `tab_id` for one tab
- `docs_list_tabs` — tabId, title, index, nesting and end index per tab
- `docs_add_tab`, `docs_rename_tab`, `docs_delete_tab` — tab management (delete requires `confirm_title`)
- `docs_write_tab` — replace one tab's body from structured paragraphs (style, bullet/numbered, level); indices computed for you
- `docs_write_markdown` — markdown to real formatting (headings, nested bullets, numbered, bold, italic, code, links); replace a tab (`document_id` + `tab_id`) or create a new Doc (`title`, optional `parent_id`)
- `docs_append_to_tab` — append markdown or paragraphs to the end of a tab without touching existing content; optional `heading` and `date_prefix`
- `docs_read_markdown` — a doc or one tab back as compact markdown
- `docs_heading_link` — deep link to a heading (`?tab=<tabId>#heading=h.xxx`), by heading text or id; no match argument lists every heading
- `docs_replace_text` — find/replace, all tabs or one `tab_id`
- `docs_batch_update` — raw Docs API requests; `tab_id` is injected into every location/range lacking one

**Comments** (any Drive file; Drive API comments/replies)
- `docs_list_comments` — comments with replies; `include_resolved` for resolved ones
- `docs_add_comment` — unanchored, or with `quoted_text`/`anchor` (Docs/Sheets/Slides display API comments as unanchored — a Google limitation)
- `docs_reply_comment`, `docs_resolve_comment` (`reopen: true` to reopen)

**Drive additions**
- `drive_share` — `email` for one or `emails` for many; per-email `{email, ok, permissionId | error}`; `notify`, `message`
- `drive_list_recent` — files in a folder changed since a date, newest first; `recursive` walks subfolders

**Google Chat** (needs the chat scopes and a configured Chat app — see below)
- `chat_list_spaces`, `chat_post_message` (optional thread), `chat_list_members`, `chat_add_members` (`email` or `emails`)

**Google Forms** (needs the Forms API enabled)
- `forms_create` — form plus questions (short_text, paragraph, multiple_choice, checkboxes, dropdown, scale, date, time); published unless `publish: false`
- `forms_list_responses` — answers keyed by question title; optional `since`

**Utility**
- `google_list_accounts` — list all connected accounts

---

## Quick Start (with Claude Code)

The fastest way to set this up is to let Claude Code walk you through it. Clone this repo, open the folder in Claude Code, and run the skill:

```
/setup-multi-google
```

Claude Code will handle the install, guide you through the Google Cloud Console setup, and verify everything works. This is the recommended path if you're new to any of this.

---

## Manual Setup

If you'd rather run the steps yourself, here's the full process.

### Prerequisites

- **Node.js v18 or newer** — check with `node --version`. If you don't have it, install from [nodejs.org](https://nodejs.org/) or with Homebrew: `brew install node`
- **Claude Code** — installed and working
- **A Google account** (or several) that you want to connect

### Step 1: Install

```bash
git clone https://github.com/chaymore/multi-google-mcp.git ~/multi-google-mcp
cd ~/multi-google-mcp
npm install
```

### Step 2: Create Google OAuth Credentials

You only need to do this once, even if you're connecting multiple accounts. It takes about 3 minutes.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/)
2. **Create a new project:** click the project dropdown at the top → "New Project" → name it "Claude MCP" → Create
3. **Enable the APIs:** go to **APIs & Services → Library**, search for **Gmail API**, click it, click Enable. Repeat for **Google Calendar API**, **Google Drive API**, **Google Docs API**, **Google Slides API**, **Google Sheets API**, **Google Forms API** and **Google Chat API** (Chat also needs its Configuration page filled in).
4. **Configure the consent screen:** go to **APIs & Services → OAuth consent screen** → External → Create. Fill in:
   - App name: "Claude MCP" (or whatever)
   - User support email: your email
   - Developer contact email: your email
   - Click Save and Continue through the remaining pages
   - On the **Test users** page, click **+ Add Users** and add every Google email address you plan to connect. This is required while the app is in "Testing" mode.
5. **Create the credentials:** go to **APIs & Services → Credentials** → Create Credentials → OAuth client ID → Application type: **Desktop app** → Create. Copy the Client ID and Client Secret — you'll paste them in the next step.

### Step 3: Run the Setup Script

```bash
npm run setup
```

This will:
1. Ask you to paste your Client ID and Client Secret
2. Ask for a label for your first account (e.g. `personal`, `work`)
3. Open your browser to sign in to Google
4. Ask if you want to add another account

**When Google shows the "This app isn't verified" warning:** click **Advanced → Go to Claude MCP (unsafe)**. It's your own app, so this is safe. Google shows this warning for every personal-use app that isn't publicly listed.

When the script finishes, it automatically builds the project and registers the MCP server in Claude Code's settings.

### Step 4: Restart Claude Code

Close and reopen Claude Code so it picks up the new MCP server. The multi-google tools will be available in any new session.

---

## Adding More Accounts Later

To connect another Google account after the initial setup:

```bash
cd ~/multi-google-mcp
npm run add-account
```

Give it a new label, click through the Google sign-in, and restart Claude Code. You can connect as many accounts as you want.

> **Don't forget:** before the new account can sign in, you need to add its email address to the **Test users** list in the OAuth consent screen of your Google Cloud project. Otherwise Google will block the sign-in with a "this app hasn't completed verification" error.

---

## Usage

Once the server is connected, you can use natural language in Claude Code:

- "Search my personal Gmail for emails from Kristen this week"
- "Read the top email in my work inbox"
- "Create a calendar event on my work calendar for Friday at 3pm called Team Sync"
- "Draft an email to caleb@example.com from my personal account"

Claude Code will pick the right tool and use the account label you specified.

---

## Troubleshooting

**"This app hasn't completed the Google verification process"**
You're trying to sign in with a Google account that isn't added as a test user. Go to **APIs & Services → OAuth consent screen**, scroll to **Test users**, click **+ Add Users**, add the email, and save. Then re-run `npm run add-account`.

**"Port 3847 is already in use"**
Something else is using the port the OAuth flow needs. Find it with `lsof -i :3847` and close it, then try again.

**"Authentication expired for account X"**
Your tokens expired or were revoked. Re-authenticate that label (see below).

**"Re-auth needed: account X was authorized before scope Y was added"**
The Chat tools need scopes added on 2026-09-23, and tokens granted earlier do not carry them. Re-authorize the account (PowerShell, from any directory):

```powershell
cd "$env:USERPROFILE\multi-google-mcp"; npm run add-account -- --account berkeley
```

Replace `berkeley` with the label (`personal`, `bhouse`, `berkeley`, `pyrgos`). It skips the prompts, opens the Google sign-in, overwrites that account's token with one carrying the current `SCOPES`, and leaves the other accounts alone. Restart Claude Code afterwards. Chat also requires, in the Cloud project: **Google Chat API** enabled and its **Configuration** page filled in (app name, avatar URL, description) — Google requires a configured Chat app even for user-authenticated calls. Forms requires the **Google Forms API** enabled; its tools already work with the existing `drive` scope, so they need no re-auth.

**Tools don't show up in Claude Code**
Make sure you restarted Claude Code after setup. You can verify the server is registered by checking `~/.claude/settings.json` — you should see a `multi-google` entry under `mcpServers`.

**"No authorization code received"**
You probably closed the browser tab too early, or denied permissions. Re-run `npm run add-account` and complete the sign-in all the way through.

---

## How It Works

The server runs locally on your machine. It stores OAuth tokens in `~/.config/multi-google-mcp/config.json` with file permissions set to 0600 (only you can read it). Tokens are refreshed automatically when they expire.

Each tool takes an `account` parameter — when you call `gmail_search` with `account: "work"`, the server loads the tokens for the "work" account, builds an authenticated Google API client, and runs the search. Nothing leaves your machine except the direct API calls to Google.

Don't publish your Google Cloud project to production — keep it in "Testing" mode. Testing mode allows up to 100 test users and your refresh tokens won't expire prematurely, which is exactly what you want for personal use.

---

## Security Notes

- Your OAuth tokens are stored locally in `~/.config/multi-google-mcp/config.json`. Don't commit this file or share it.
- The server runs locally and only communicates with Google's APIs. No third-party services are involved.
- The scopes requested are: Gmail modify/compose/labels, Calendar read/write, Drive, Chat (`chat.spaces`, `chat.messages`, `chat.memberships`) and Forms (`forms.body`, `forms.responses.readonly`). If you want to reduce these, edit `SCOPES` in `src/config.ts` and re-run setup. A tool whose scope a stored token lacks refuses with the re-auth command rather than calling Google.
- Revoke access any time at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
