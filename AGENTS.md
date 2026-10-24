# Project instructions

<!-- agent-harness:portable:v4:start -->
<!-- agent-harness:portable:content 4b2dbfc4aa97ef7a -->
<!-- contract-priority: P1; annotation only, applicability is unchanged -->
**CONCISE, CONCISE. USE LESS WORDS. USE MINIMAL WORDS. IF I NEED MORE EXPLANATION, I'LL ASK.**

<!-- contract-priority: P2; annotation only, applicability is unchanged -->
## Portable operating rules

**Every sentence is paid for on every future read. Write less.** Never cut a prohibition, a measured number, a path, a version pin, a named owner, or the failure a rule prevents; relocate those to their owner instead.

**Load the shared contract first; this block never restates it.** The marked safety floor below is the one exception. It is `~/.agents/AGENTS.md`. Each product's global loader injects it (`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, Cursor's global rule, `~/.config/opencode/AGENTS.md`, `~/.gemini/config/AGENTS.md`), and in a container `.agents/cloud/setup.sh` installs it and those loaders from the harness commit pinned in `.agents/cloud/harness-pin.sh`, fetched read-only and never vendored; setup fails when it cannot, and Claude and Codex then refuse tool use. If it is not already in your context, read it now; if it cannot be read, stop and report, because no work is safe without it. Every rule below is one that contract does not carry, and every rule it carries lives there alone (spec `the-two-contracts-do-not-restate-each-other`, gated by `Test-ContractBudget.ps1` and `Test-ContractLoaderChain.ps1`).

<!-- agent-harness:safety-floor:v1:start -->
**Safety floor for products with no shared-contract loader (Jules, Cursor cloud agents); the one sanctioned restatement.**
- Never read, display, log, export, or commit credential values.
- Without the shared contract loaded, stay out of Douglas's vault entirely; it names the reserved paths no session may touch.
- Never push to, merge into, or force-update the default branch without Douglas's explicit authorization.
- Never delete a branch without Douglas's explicit authorization.
- Git hygiene: A project's remote is its truth. Keep one stable checkout per remote, pull before editing, and treat work as unfinished while `git status` is dirty or `git log origin/main..HEAD` is non-empty. Isolation, cloud-synced-folder exclusions, and worktree cleanup follow `.agents/AGENTS.md` → **Git and branches** in full.
<!-- agent-harness:safety-floor:v1:end -->

Masterminds coordinate many projects at the Fleet Atlas level; conductors drive one project through Work Scope and apply tacticians to tracks; each tactician owns one track and its task queue, deploying builders, scouts, advisors, and reviewers. One writer per working directory; every lane gets its own worktree under `.agents/WORKTREE-PROTOCOL.md`, and `.agents/tools/Dispatch-Lane.ps1` owns the lane lifecycle.

A lane that created a worktree removes it once its work is committed and reachable from the remote and its tree is clean; a lane dispatched through `.agents/tools/Dispatch-Lane.ps1` removes it with `-Action Complete`, which refuses a worktree that is dirty, locked, still in flight, or neither merged nor held by origin on its own `agent/*` or `cloud/*` branch. Never remove a dirty or unpushed worktree: it may hold the only copy of real work.

**Reaping a finished worktree is pre-authorized and automatic. Never ask for it.** A worktree is finished when its working tree is clean, its HEAD is held by origin on its own `agent/*` or `cloud/*` branch or by the default branch, and no lane is live in it; removing it then destroys nothing. Reap without being told, at three moments: when your own lane finishes, whenever you are about to create a worktree, and at session start. Sweep every worktree, not only your own — `git worktree list` is the input, and `Dispatch-Lane.ps1 -Action Complete` / `Invoke-WorktreeReaper.ps1` decide; a bare `git branch -r --contains <HEAD>` is not the test, because it also matches a fresh worktree that holds nothing yet. Land what is landable first: commit, push, and open a pull request for a lane whose work is real but unpushed, rather than leaving it to accumulate. Report by count and name what you reaped and what you kept, with the reason for each keep. This rule exists because the instruction above was written and never enforced: abandoned worktrees accumulated until the device ran out of disk and every lane on it failed.

- **A new request while you are mid-task is an addition, never a replacement.** Start on what the user just asked for, and still finish what was already running — in parallel when the two are independent, immediately afterwards when they are not. Never drop, defer indefinitely, or silently abandon the earlier work because a newer ask arrived; if the new request genuinely cannot run alongside the old one, say which you are doing first and why, in that turn.
- **A finished request the user has to ask about twice was not delivered.** When a request is only partly done, say which part and what remains.
- **WHEN I ASK FOR A WORK UPDATE, UPDATE ME ON ALL OPEN, CLOSED AND PENDING WORK.**
- **DON'T MAKE RANDOM BRIEFS OR OUTPUT FILES THAT AREN'T NECESSARY OR THAT NO ONE WILL READ.** Only when the user asks, or for a small update to a status file. Durable reader-facing results follow `.agents/VAULT-PROTOCOL.md` → **7. Briefs**.
- **A unit counts only when its commit is reachable from the default branch and its pull request is closed.** A branch, a report, a simulation, a probe and a handoff all count as zero. Within one lane, land a unit before starting that lane's next one; independent lanes still run in parallel.
- **A dispatched agent writes and refreshes its status file via `Write-FleetAgentStatus.ps1`; any session checking delegated work reads `Get-FleetAgentStatus.ps1` rather than waiting for the agent to exit.** Only a fresh heartbeat proves liveness, and this prevents silent stalls from blocking dispatch. `.agents/AGENT-STATUS-PROTOCOL.md` owns the file contract.
- **A wait names the specific thing it waits for — a PID, a lane id, an agent id, a marker file, or a commit sha. Never a global process name.** Any unrelated process of that name satisfies the wait early or holds it open forever, and neither outcome is distinguishable from the one you meant. `codex.exe`, `node.exe` and `pwsh.exe` are running on this machine for reasons that have nothing to do with your lane.
- **A delegated agent's status is not its result, and a status label is never evidence.** Finished, succeeded, READY and green all say the agent stopped, not that it produced anything. Before counting delegated work, dispatching more on top of it, or reporting it to the user, verify the artifact itself: the branch exists on the remote, the diff is non-empty, the pull request is open. `.agents/DISPATCH-CHECKLIST.md` → **Before claiming anything** owns the measurement behind this rule.
- **Before logging a decision, read `INTENT.md` and the owning `SPEC.md`, and try to decide from them first (`intent-decide-from-intent-and-spec`).** The ruling and its quote live in `INTENT.md` under that id. Name the intent line or spec checkbox the answer comes from, record the decision and that citation in task state, and continue. A blocker reaches the user only when intent and specification together genuinely do not determine the answer -- not when deciding merely feels above your pay grade. Unattended, this is the difference between a night of work and a night of waiting. A blocker also names the file:line that enforces it, verified this session -- never inherited from a summary or a previous turn. If you cannot name it, it is a guess, not a blocker, and restating one unchanged is not progress. A blocker that remains is recorded the moment it is found, in authoritative task state as well as the vault, because chat is not a queue; `.agents/VAULT-PROTOCOL.md` → **8. Decisions — authored in the vault, answered in the vault** owns the block format, the stable id, and the sync, and the ruling then goes to the owning project's `LOG.md` in the same work unit.
- **Surface every permission a plan or task will need AHEAD OF TIME, in one batch at the start** (allow-tags, approvals, credentials, elevated runs), so the work never stalls midway on a prompt.
- **Every review dispatch names the exact artifact under review, points to the owner, intent or specification, prior rulings, and measurements that decide correctness, and grants access to all of them; otherwise the reviewer reports `could-not-tell` rather than guessing, because isolated review misses governing context.** When a review is needed, run one xhigh review pass, never a fleet.
- A command handed to Douglas targets one shell only — PowerShell, his default, and say so — never mixed cmd/bash syntax; it runs error-free pasted from any directory (absolute paths, quoted, no cwd reliance); `&&` chaining is fine if error-free. Test the command yourself first when safe, or dry-run it, and check preconditions (e.g. the target still exists). If it cannot be directory-independent, say why and name the required directory. (Douglas, 2026-09-10; supersedes the `C:\\Users\\dougl>` `Start-AppSupervisor.ps1` failure — his correction was “STOP ALLOWING ERRORS.”)
- A document may live in both a repository and the vault. When it does, give Douglas the link that rule `intent-reported-links-resolve` prescribes and name the vault path alongside it; vault paths are outside repositories and do not render as links.
- Resolve `~` and `$HOME` at runtime. `.agents/manifests/capability-router.json` gives each delegation CLI its exact invocation; read it directly when no session hook surfaced it, and confirm the binary before dispatching, because its `present` flags describe whichever device generated the file.
- **List the skills before running one, every time.** Run every listed skill the work in hand needs — a request that names one skill is not a licence to run only that one, and the other skills a piece of work needs are visible in the listing and nowhere else. Check a skill's description for applicability before opening its full `SKILL.md`; load an applicable skill immediately before the action it governs. Prompt-signal matches are candidates, not requirements, and a brief may explicitly rule one out. Check exact input paths early when a brief says stop if missing, before loading unrelated workflows. Use `brainstorming` for creative or underspecified work, `test-driven-development` for implementation, `systematic-debugging` for bugs, and `review` plus `verification-before-completion` before completion. Route independent, file-disjoint work through `swe`. Vault and worktree protocols remain mandatory before their respective actions. `correct` turns a recurring correction into the narrowest verifiable safeguard; it runs only when the user invokes it, so do not reach for it on your own. Never edit a third-party skill's body or frontmatter to add a local rule — that is what a projection-only overlay is for.
- **Three documents, and no field appears in two.** `PRODUCT.md` says why it exists and who it is for. `SPEC.md` says what it must do, as criteria observable by running it. `DESIGN.md` says what it must look like and how it must behave, tokens included. A field written in two of them drifts, and then neither reader can tell which copy is current. One document's owner may edit another's file only on an explicit trigger, changing only the field that trigger names: `~/.agents/skills/stack/SKILL.md` § 4 owns the two crossing rules, the quoted ruling behind them, and the stack-selection record that lives in `DESIGN.md` § *Stack selection* and that every design and review skill reads.

<!-- contract-priority: P0; annotation only, applicability is unchanged -->
## Start and task state

1. Read the current routing mode by resolving `Get-AgentMode.ps1` at runtime the same way the shared contract resolves every other harness tool: `~/.agents/tools/Get-AgentMode.ps1` where a shared harness is installed, otherwise `.agents/tools/Get-AgentMode.ps1` from the harness repository `pyrgos-ai/doug-harness` (this repository's own copy when it is the harness) cloned read-only and never vendored into this project -- there is no project-local copy of this script. Run it with `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File <resolved-path>` (in a container drop the `& '<path>'` prefix and call `pwsh <resolved-path>`); stop if it fails.
2. Before interface or design work, invoke `craft`, which routes all design work. Read `.agents/INDEX.md` **Search surfaces** when looking for information.
3. Read the grouped whole open set before choosing work: `Get-WorkLanes.ps1` and `Add-ProjectIntake.ps1 -List` or generated `BACKBURNER.md` when enrolled, otherwise the `agent-harness:intake:v1` block. Reject with a reason and delete nothing to shrink a count.

The hook misfire reporter's canonical installed route is `~/.agents/tools/report-hook-misfire.js`; inside the harness repository itself the tracked source is `.agents/task-hooks/tools/report-hook-misfire.js`, which is what the printed command shows. An enrolled project receives no `task-hooks/` tree, so that repo-relative path will not resolve there — run the resolved path the hook prints on its next line, which is authoritative over the printed command.

<!-- contract-priority: P0; annotation only, applicability is unchanged -->
## Safety and boundaries

- The current spending threshold is zero: initiate no spend unless Douglas's own current message contains `allow-spend`; `allow-all` never authorizes spending. Raising the threshold requires a new ruling.
- Enter `craft` for interface work; craft routes implementation to `impeccable` and completion to `design-review`. `impeccable` opens `DESIGN.md`, `.agents/design/LIBRARIES.md`, the dashboard rules, and the matching sibling workflow. `design-review` holds the completion bar: inspected multi-viewport renders, a real-browser primary flow, direction review, and fresh eyes. Update affected owners, run relevant and repository checks, and finish with `git diff --check`.

<!-- contract-priority: P1; annotation only, applicability is unchanged -->
## What is managed here, and what is yours

`~/.agents/CONTRACT-AUTHORING.md` (repository fallback: `.agents/CONTRACT-AUTHORING.md`) owns how a rule is admitted, written, projected, and verified.

Everything above the closing marker is generated from `.agents/templates/AGENTS.md` in the harness repository: change a portable rule there and re-render with `Manage-Harness.ps1 -Action EnsureProject`, never by editing this file. There is no size ceiling on this contract, by Douglas's ruling recorded in `INTENT.md`; `Test-ContractBudget.ps1` gates its shape — history and dated claims belong in their owning document, not here — and presence, while measuring size and count without gating them. Everything below the marker is project-owned: identity, real commands, local boundaries, and product adapters.
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
