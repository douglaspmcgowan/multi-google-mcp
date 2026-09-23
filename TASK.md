# Task

## Intent

Add Drive metadata and sharing tools to the multi-account Google MCP server, then safely share the four specified Berkeley Drive files when an already-authorized Drive-scoped token permits it.

## Specs

- [x] The OAuth scopes contain the narrowest scope that supports metadata reads and permission creation for these pre-existing Berkeley file IDs.
- [x] `src/tools/drive.ts` exposes file metadata and permission-creation tools and `src/index.ts` registers them with the existing tool collections.
- [x] `npm run build` completes successfully with its real output recorded.
- [ ] The authorization URL is generated without completing OAuth consent or handling credential values.
- [ ] Each requested file is shared with `oneredfox21@gmail.com` as a reader only when a valid Berkeley token already has the required Drive scope; otherwise the exact scope failure is recorded and no share is attempted.
- [ ] The branch and pull request state are recorded without pushing or merging into `main`.

## Goal

Implement and verify Drive support, generate the safe OAuth URL, and perform the four authorized shares if possible.

## Active

- [~] Implement Drive scope, tools, registration, tests, build, OAuth URL generation, and conditional Berkeley sharing — done when the specs above have observable evidence.

## Queue

- [x] Inspect the existing implementation and current Google Drive authorization requirements — done when the scope choice and API shape are evidenced by repository code and current Google documentation.
- [x] Add failing Drive tests before production code — done when the focused test fails because `drive.ts` is missing.
- [x] Implement Drive scope, metadata, permission creation, and registration — done when the focused test and build pass.
- [ ] Generate and print the authorization URL without completing consent — done when the URL is captured without credential values.
- [ ] Check the existing Berkeley token scope and conditionally share the four file IDs — done when each result is recorded or the precise authorization blocker is recorded.
- [!] Commit, push, and open a pull request — blocked on: GitHub rejected the authorized branch push with HTTP 403; no remote branch or PR exists.

## Blocked

- [!] Generate the authorization URL and perform four Berkeley shares — blocked on: could-not-tell whether a valid Drive-scoped Berkeley token exists; protected credential-bearing host access was rejected. No share was attempted.


## AY26-27 follow-on, 2026-09-16

Douglas: *"change the multi-google-mcp so it allows you to do more stuff in drive plz. you should not
be doing this in browser in the future."*

- [x] Drive write tools: `drive_create`, `drive_update_content`, `drive_upload`, `drive_export`,
      `drive_rename`, `drive_move`, `drive_copy`, `drive_trash`, `drive_untrash`, `drive_unshare`.
      `npm run build` clean; `npx tsx --test test/drive.test.ts` 11/11 pass.
- [x] Formatted Google Docs without the Docs API: `html` passed to `drive_create` or
      `drive_update_content` is converted by Drive with headings, bold, links and tables intact.
      Proved live against `dpm5970@berkeley.edu` by rewriting doc
      `13aZjfGzoeYBbPTq6OAZfkP5ypiuDbVBCLR-ZBcuaMMY`.
- [x] No permanent-delete tool. Trash is the whole delete surface, so nothing is unrecoverable.
- [x] No re-consent needed: `SCOPES` already requested full `auth/drive` and the `berkeley`,
      `personal` and `pyrgos` tokens carry it. **`bhouse` does not** and needs `npm run add-account`
      before any Drive call.
- [x] Documented in `~/.agents/references/multi-google.md`, and `~/.agents/AGENTS.md` now says Drive
      work never goes through a browser.

## Needs decision

<!-- Record items requiring a user decision here. -->

## Completed

- [x] Task state reconciled from the request before implementation.
- [x] Drive implementation committed locally as `68f8c28`; focused tests passed and build passed.

## Verification

- Evidence: `node --experimental-strip-types --test test/drive.test.ts`; `npm run build`.

<!--
Markers use a space for queued work, a tilde for active work, x for complete,
an exclamation mark for blocked work, and a question mark for decisions.
Required delegated work may be nested under its parent with agent provenance.
Optional discoveries belong in BACKBURNER.md.
Parallel mode applies to three or more independent, file-disjoint items.
-->
