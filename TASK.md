# Task

## Intent

Add Drive metadata and sharing tools to the multi-account Google MCP server, then safely share the four specified Berkeley Drive files when an already-authorized Drive-scoped token permits it.

## Specs

- [ ] The OAuth scopes contain the narrowest scope that supports metadata reads and permission creation for these pre-existing Berkeley file IDs.
- [ ] `src/tools/drive.ts` exposes file metadata and permission-creation tools and `src/index.ts` registers them with the existing tool collections.
- [ ] `npm run build` completes successfully with its real output recorded.
- [ ] The authorization URL is generated without completing OAuth consent or handling credential values.
- [ ] Each requested file is shared with `oneredfox21@gmail.com` as a reader only when a valid Berkeley token already has the required Drive scope; otherwise the exact scope failure is recorded and no share is attempted.
- [ ] The branch and pull request state are recorded without pushing or merging into `main`.

## Goal

Implement and verify Drive support, generate the safe OAuth URL, and perform the four authorized shares if possible.

## Active

- [~] Implement Drive scope, tools, registration, tests, build, OAuth URL generation, and conditional Berkeley sharing — done when the specs above have observable evidence.

## Queue

- [ ] Inspect the existing implementation and current Google Drive authorization requirements — done when the scope choice and API shape are evidenced by repository code and current Google documentation.
- [ ] Add failing Drive tests before production code — done when the focused test fails because `drive.ts` is missing.
- [ ] Implement Drive scope, metadata, permission creation, and registration — done when the focused test and build pass.
- [ ] Generate and print the authorization URL without completing consent — done when the URL is captured without credential values.
- [ ] Check the existing Berkeley token scope and conditionally share the four file IDs — done when each result is recorded or the precise authorization blocker is recorded.
- [ ] Commit the implementation, push the owned branch, and open a pull request — done when remote branch and PR evidence are available.

## Blocked

<!-- Record externally blocked work here. -->

## Needs decision

<!-- Record items requiring a user decision here. -->

## Completed

- [x] Task state reconciled from the request before implementation.

## Verification

- Next: `npm test -- --test-reporter=spec` focused on `test/drive.test.ts`, then `npm run build`; record OAuth and Drive API outcomes without credential values.

<!--
Markers use a space for queued work, a tilde for active work, x for complete,
an exclamation mark for blocked work, and a question mark for decisions.
Required delegated work may be nested under its parent with agent provenance.
Optional discoveries belong in BACKBURNER.md.
Parallel mode applies to three or more independent, file-disjoint items.
-->
