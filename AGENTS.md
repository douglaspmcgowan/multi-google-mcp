# Project instructions

<!-- agent-harness:portable:v4:start -->
<!-- agent-harness:portable:content ad10c025a3ed16d5 -->
## Portable operating rules

**Every sentence is paid for on every future read. Write less.** Say a thing once, in the document that owns it, then stop. Cut whatever changes no reader's action — preamble, restating the request, a closing summary, a bullet list repeating the paragraph above it. Never cut a prohibition, a measured number, a path, a version pin, a named owner, or the failure a rule prevents; relocate those to their owner instead.

Use subagents immediately for every independent, file-disjoint workstream. This is explicit authorization to parallelize. Keep only destructive or dependent final gates serial. Every brief satisfies `.agents/DISPATCH-CHECKLIST.md` → **Before dispatching**, which owns the reporting contract, the tier, the owned paths, the proving command, and the harness-defect route.

Agents may create local commits for in-scope work without asking. Never push, merge, force-update, discard, delete a worktree, or remove a task workspace unless the user explicitly authorizes that action.

- Answer questions first. Emit zero text between tool calls, no exception — only a completed task, a status update after a long stretch, a decision the user must make, or a direct answer to a question earns a message, each landing in the turn's final message. Tool calls of your own are for orchestration only — verify, check, steer — never production, which routes to subagents whose every brief demands zero narration. Durable reader-facing results follow `.agents/VAULT-PROTOCOL.md` → **7. Briefs**.
- A decision, ruling, or blocker needing the user's judgment is recorded the moment it is found: as an open block in the active vault's `05 Decisions\<Project> - Open Decisions.md` when a vault is reachable, and in authoritative task state either way. Chat is not a queue, and the vault document is the record. `.agents/VAULT-PROTOCOL.md` → **8. Decisions — authored in the vault, answered in the vault** owns the block format, the stable id, and the sync; the ruling then goes to the owning project's `LOG.md` in the same work unit.
- Never invent facts, paths, APIs, versions, measurements, source content, credential state, or passing results. Verify inherited claims against repository, Git, runtime, or current primary evidence.
- Preserve unrelated changes, keep work within the request, and treat a plan request as plan-only. Inspect exact targets before destructive work, archive by default, and delete only with explicit direction. Preserve active application process trees and confirm before a whole-app restart. Never read, display, log, export, or commit credential values.
- Before creating, replacing, renaming, or removing an artifact, search the repository and available shared harness for its owner, equivalents, consumers, wiring, tests, and documentation. Extend the closest adequate owner, make the touch list, and record the result in authoritative task state.
- Resolve `~` and `$HOME` at runtime. Use the repository's tracked `.agents/` material when a fresh machine or cloud container has no `~/.agents`; do not vendor another copy. In the shared harness (`~/.agents/`, or `.agents/` in the harness repository): `INDEX.md` is the canonical skills catalogue, `WORKTREE-PROTOCOL.md` owns isolated worktrees, `VAULT-PROTOCOL.md` owns vault work, briefs, and decisions, and `DOCKET-PROTOCOL.md` owns cards and mass review. `.agents/manifests/capability-router.json` gives each delegation CLI its exact invocation; read it directly when no session hook surfaced it, and confirm the binary before dispatching, because its `present` flags describe whichever device generated the file.
- Read a named or matching skill in full. Use `brainstorming` for creative or underspecified work, `test-driven-development` for implementation, `systematic-debugging` for bugs, and `requesting-code-review` plus `verification-before-completion` before completion. Route independent, file-disjoint work through `dispatching-parallel-agents`; use the `correct` skill for the narrowest verifiable safeguard after a recurring correction. Reproduce a reported failure and add a regression test when practical before fixing it. Never edit a third-party skill's body or frontmatter to add a local rule — that is what a projection-only overlay is for.
- Use one build loop: product or feature work starts from current specification; personal systems and one-off work use project intent plus observable acceptance. Materialize work, verify it, then re-read the resulting project state against the original intent; when they diverge, re-enter the loop at the earliest stale stage.

## Start and task state

1. Read this file, current task state, recent `LOG.md`, and `INTENT.md` when present.
2. Run `git status --short --branch`, inspect worktrees, then read `MAP.md` — including **Search surfaces** when looking for information — and `DESIGN.md` when relevant.

A project's remote is its truth. Pull before editing and treat work as unfinished while `git status` is dirty or `git log origin/main..HEAD` is non-empty.

3. Read what other agents filed against this project before choosing work. Enrolled: `Add-ProjectIntake.ps1 -List`, or the generated `BACKBURNER.md`. Legacy: the `agent-harness:intake:v1` block. The session-start hook surfaces open intake in both modes where the hooks are installed. `Get-WorkResume.ps1` never enumerates the queue. Reject an item with its reason; delete nothing to shrink a count.

If the exact project path `.agents/work/state.json` exists, Work Scope is enrolled and that structured file is authoritative. Load and follow the `work-scope` skill, including its guard, ownership, evidence, and handoff rules. Resolve those tools from `.agents/tools/` in the harness copy that skill loaded from, not from the skill package. Run `Test-WorkState.ps1`, `Get-WorkResume.ps1`, and `Reconcile-WorkState.ps1` before changing task state. `PROJECT.md`, `TRACKS.md`, `TASK.md`, `BACKBURNER.md`, and `LOG.md` are generated read-only views — never hand-edit a generated projection or view, change its canonical owner and rerun that owner's generator. Route work through `Test-WorkScopeGuard.ps1`, `Update-WorkState.ps1`, `Invoke-WorkScopeEvidence.ps1`, `Capture-WorkDiscovery.ps1`, and `New-WorkHandoff.ps1`; invalid state fails closed.

When `.agents/work/state.json` is absent, legacy `TASK.md`, `BACKBURNER.md`, and `LOG.md` retain their owners. Durable capability state belongs in the project's `MAP.md`, or in the map it points at when that is only a pointer; `STATUS.md` is retired. To file a finding against another project, use `Add-ProjectIntake.ps1`; the target project owns the repair unless it blocks assigned work or Douglas explicitly redirects it.

**File a harness defect the moment you hit it, before your next tool call.** A hook that refused safe input, a harness tool that crashed or returned a wrong verdict, a generated projection that disagrees with its owner, a router entry whose CLI does not run as written — each is a defect in `agent-harness`, never an obstacle to route around. A hook block goes to `node <harness>/task-hooks/tools/report-hook-misfire.js --hook=<name> --reason="<why the input was safe>"`; every other harness or CLI defect goes to `Add-ProjectIntake.ps1 -Project agent-harness`. This is not conditional on the defect blocking your task and is not deferred to the end of it: a workaround you did not record refuses the same safe input in every future session, and nobody can see the pattern because the only trace was your transcript.

## Safety and boundaries

- Do not infer authority for pushes, merges, force updates, deletions, credential use, spending, or publishing. On unattended work, record reversible assumptions and batch approvals rather than stopping safe work.
- Before vault work, read `VAULT-PROTOCOL.md` and the active vault's `IA.md`. Exclude vault-root `AI Reference\`, `40_Reference\AI Reference.md`, vault-root `26_Sensitive\`, `31_Business\Other People Reference.md`, and `Actual Documents\Identity` under the Google Drive root from reads, searches, globs, edits, links, mirrors, and delegated work. Only with Douglas's explicit authorization may a file move one way into `26_Sensitive\`; never read, open, list, enumerate, glob, grep, preview, diff, hash, link, mirror, back up, commit, copy, export, rename, restore, extract, or move anything out, and report only the source and destination folder.
- For interface work, use `impeccable`, follow `DESIGN.md` and `.agents/design/LIBRARIES.md`, and consult the design-language registry before creating a visual language. Run the browser or end-to-end verifier for browser-visible changes. Update affected routing documents in the same work unit, run relevant tests and the repository verifier, then finish with `git diff --check`. When files change, finish by listing only the files worth opening, each as a clickable repository-relative path, plus one or two lines on what changed.

## What is managed here, and what is yours

Everything above the closing marker is generated from `.agents/templates/AGENTS.md` in the harness repository: change a portable rule there and re-render with `Manage-Harness.ps1 -Action EnsureProject`, never by editing this file, and keep the result inside the ceiling `Test-ContractBudget.ps1` enforces. Everything below the marker is project-owned: identity, real commands, local boundaries, and product adapters.
<!-- agent-harness:portable:v4:end -->

## Project identity

- Name: `multi-google-mcp`
- Purpose: `<one sentence>`
- Default branch: `main`

## Commands

- Setup: `<command>`
- Test: `<command>`
- Lint: `<command>`
- Build: `<command>`
- End-to-end: `<command>`

## Project-specific rules

- Add only rules required by this repository.

## Product adapters

- Claude loads `CLAUDE.md`, which imports this file.
- Codex loads this file.
- Cursor loads `.cursor\rules\00-project-contract.mdc`, which points here.
