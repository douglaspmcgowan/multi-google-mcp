---
name: setup-multi-google
description: Walks the user through setting up the multi-google MCP server so they can connect one or more Google accounts to Claude Code. Use when the user wants to install, configure, or add accounts to multi-google-mcp. Handles prerequisites, Google Cloud Console guidance, credential entry, OAuth sign-in, and final registration with Claude Code.
---

# Multi-Google MCP Setup Skill

You are helping a user who is new to most of this. They may not have used a terminal before, may not know what OAuth is, and may get stuck on the Google Cloud Console. Be patient, explain things as you go, and verify state at each step instead of assuming things worked.

## Your job

Walk the user through setting up the `multi-google-mcp` server from start to finish. The end state is: the server is installed, one or more Google accounts are connected, and the server is registered in Claude Code so the user can use the Gmail and Calendar tools.

## Important constraints

- **The `npm run setup` script is interactive.** It prompts for credentials and account labels via stdin. You cannot pipe responses into it from Claude Code's Bash tool reliably. So for the actual setup command, instruct the user to run it in their own terminal (a separate Terminal.app or iTerm window), not via the `!` prefix in Claude Code. You can help them with everything before and after, but the interactive script itself runs outside of Claude Code.
- **Never skip the Google Cloud Console verification.** Beginners will think "I already did that" when they actually didn't. Always ask them to confirm they've added the specific Google email they want to connect as a test user.
- **Don't rush the OAuth consent screen warning.** Make sure the user knows to click "Advanced → Go to [app name] (unsafe)" — a lot of beginners bail here because it looks scary.

## Step-by-step flow

### Step 0: Figure out where the user is

Before you do anything, check the current state. Run these checks and report what you find:

1. Find the project directory. Check the current working directory first — if `package.json` exists here and its `name` is `multi-google-mcp`, you're already in it. Otherwise check `~/multi-google-mcp`. Store whichever path you find as the project directory for all subsequent steps.
2. Is Node.js installed? (Check with Bash: `node --version`)
3. Does the config file already exist at `~/.config/multi-google-mcp/config.json`? If so, read it and see if it has a `clientId` and any connected accounts. This tells you whether this is a first-time install or adding-an-account flow.

Based on what you find, take one of these paths:
- **No project found** → help them clone it (Step 1)
- **Project exists, no config yet** → first-time setup (Steps 2-6)
- **Project exists, config has credentials but few/zero accounts** → add-account flow (skip to Step 5 with `npm run add-account`)
- **Project exists, config has everything** → confirm it's working and stop (Step 7)

### Step 1: Clone or install the project

If the project isn't available locally yet, ask the user where they want it and how they'd like to get it (git clone, download, etc.). Default install path is `~/multi-google-mcp`. Once the project is in place, `cd` into it and run `npm install`.

Check that `node --version` returns v18 or higher. If Node.js is missing, tell them to install it from [nodejs.org](https://nodejs.org/) or via Homebrew (`brew install node`) and come back.

Verify `npm install` completed successfully — look for a `node_modules` directory.

### Step 2: Google Cloud Console walkthrough

This is the part beginners struggle with most. Do NOT copy-paste a giant block of instructions and walk away. Go step by step, and at each step ask the user to confirm before moving on.

Tell the user: "You're about to spend about 3 minutes in Google Cloud Console creating an OAuth app. This app is yours — it lives in your Google account — and it's what lets this server talk to your Gmail and Calendar. You only do this once, no matter how many Google accounts you end up connecting."

Then walk them through, one step at a time:

1. **Open** [console.cloud.google.com](https://console.cloud.google.com/) — "Let me know when you're logged in and looking at the dashboard."
2. **Create a new project** — "Click the project dropdown at the top of the page (it might say 'Select a project' or show an existing project name). Click 'New Project'. Name it 'Claude MCP' and click Create. Let me know when you see the new project selected in the dropdown."
3. **Enable Gmail API** — "Go to the menu (☰ icon top left) → APIs & Services → Library. In the search bar, type 'Gmail API'. Click the Gmail API result, then click the blue Enable button. Let me know when you see 'API enabled'."
4. **Enable Calendar API** — "Go back to the Library (back button or menu again). Search for 'Google Calendar API'. Click it, click Enable. Let me know when it's enabled."
5. **Configure the consent screen** — "In the left sidebar, click 'OAuth consent screen'. Choose 'External' and click Create. Fill in App name = 'Claude MCP', User support email = your email, Developer contact = your email. Click Save and Continue. On the Scopes page, just click Save and Continue (don't add anything). On the Test Users page, click '+ Add Users' and add every Google email you want to connect. Then click Save and Continue." — Wait for them to confirm they added their email(s). This is critical.
6. **Create credentials** — "Go to 'Credentials' in the left sidebar. Click '+ Create Credentials' at the top, then 'OAuth client ID'. Application type = 'Desktop app'. Name it 'Claude MCP Desktop'. Click Create. A popup will show your Client ID and Client Secret — keep that popup open, you'll need those in a second."

### Step 3: Run the setup script (user runs this in their own terminal)

Now tell the user to open a regular terminal window (Terminal.app on macOS, not Claude Code's command bar) and `cd` into the project directory, then run:

```bash
npm run setup
```

Tell them exactly what to expect:
1. It'll print instructions they can ignore (they're in the middle of them already).
2. It'll ask for Client ID → paste from the Google popup.
3. It'll ask for Client Secret → paste from the Google popup.
4. It'll ask for an account label → suggest `personal` or `work` or whatever makes sense.
5. A browser tab will open to Google sign-in. They should sign in with the Google account they want to connect. **Warn them explicitly:** "Google will show a red warning screen that says 'This app isn't verified'. This is normal because it's your personal app, not a published one. Click Advanced, then 'Go to Claude MCP (unsafe)'. This is safe — it's your own app."
6. They'll see a Google permissions screen. Click Allow.
7. The browser should show "Account connected" and they can close the tab.
8. Back in the terminal, it'll ask "Add another account? (y/N)". If they want to connect a second Google account, they'll say `y` and repeat the sign-in with the other Google account. Otherwise `n`.
9. The script will finish by building the project and registering it in Claude Code.

Wait for the user to tell you they finished. Don't proceed until they confirm.

### Step 4: Verify the setup

Once the user says the script finished, verify it actually worked:

1. Read `~/.config/multi-google-mcp/config.json` and confirm it has `clientId`, `clientSecret`, and at least one entry in `accounts`.
2. Read `~/.claude/settings.json` and confirm there's a `mcpServers.multi-google` entry pointing to the project's `dist/index.js`.
3. Check that `dist/index.js` exists in the project directory.

If any of these fail, diagnose the problem with the user. Common issues:
- If `config.json` is missing, the script probably crashed before saving. Ask them for the error output.
- If `settings.json` doesn't have the entry, the build step may have failed. Run `npm run build` manually and check the output.
- If `dist/index.js` is missing, run `npm run build`.

### Step 5: Restart Claude Code

Tell the user: "The setup is complete. You need to close and reopen Claude Code now so it picks up the new MCP server. After you restart, you'll have Gmail and Calendar tools available for every Google account you connected."

### Step 6: Test

After they restart, they can verify by asking Claude Code to run `google_list_accounts`. This should return the labels of all connected accounts.

## Common errors and how to handle them

- **"This app hasn't completed the Google verification process"** → They didn't add the Google email they're signing in with as a test user. Walk them back to the OAuth consent screen in Google Cloud Console and help them add it.
- **"Port 3847 is already in use"** → Something else is using the port. Tell them to run `lsof -i :3847` to find it and close that process.
- **"Token has been expired or revoked"** (later, during use) → Their tokens expired. Tell them to run `npm run add-account` and use the same label to re-authenticate.
- **Tools don't appear in Claude Code after restart** → Verify `~/.claude/settings.json` has the `multi-google` entry. If it does, check the `dist/index.js` file actually exists. If both look right, they may need to fully quit Claude Code (not just close the window).

## Adding-an-account-only flow

If the user already has the server set up and just wants to add another Google account:

1. Remind them to first add the new Google email as a test user in the OAuth consent screen (go to console.cloud.google.com → APIs & Services → OAuth consent screen → Test users → Add Users).
2. Have them run `npm run add-account` in a regular terminal.
3. Walk them through the same OAuth sign-in flow as above.
4. Have them restart Claude Code.

## Tone

Be encouraging. This is many users' first time dealing with OAuth and Google Cloud Console. When they hit an error, don't dump a wall of text — figure out exactly what went wrong, explain it in one or two sentences, and give them a single clear next action. Celebrate small wins ("Nice — credentials saved. Next step…"). Don't lecture.
