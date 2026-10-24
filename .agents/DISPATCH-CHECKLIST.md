# Dispatch checklist

Claude may review freely; any Claude building dispatch outside a mode that admits Claude requires Douglas's `allow-builder` authorization; Codex, agy, Jules, opencode and cursor builders need no tag. For a Claude builder, pass `-AllowBuilder` to `Invoke-FleetRoute.ps1` (`& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Invoke-FleetRoute.ps1 -Root <value> -BriefFile <value>`), which the PreToolUse hook admits only while the tag is live.

Every requirement below was violated in one session on 2026-08-23; each line names the violation that
put it here. `.agents/tools/Test-DispatchCompliance.ps1` (`& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Test-DispatchCompliance.ps1 -RepoRoot <value> -CodexProfileDirectory <value>`) checks the mechanical half; the rest is on
the agent.

**This file starts after the unit of work is decided.** `.agents/CLUSTERING.md` owns that decision —
what a cluster is, how the set is derived, which clusters can leave the machine, and the refusal that
stops a second agent landing on a live cluster. Read it before you write briefs, not after.

## Interface work route

Interface work routes the worker through `.agents/DESIGN.md` → `.agents/design/dashboards.md` for
dashboard-shaped work, which also requires `.agents/design/mission-control/REPRESENTATIONS.md` and
`.agents/design/mission-control/AESTHETIC-OPTIONS.md`; the worker records the chosen representation's
nine → ninety answer. Before claiming completion, use `verification-before-completion`'s visual-work gate:
its rendered screenshots, browser flow, and design review are required evidence.

**A brief that asks whether an app is good must carry the recipe for running it: the exact start
command, the port, and the URL of the first screen.** Measured 2026-09-05 across twelve
production-readiness reviews dispatched without one: the five that opened the app were exactly the
five whose app already happened to be listening on a port, and the reviewer that found the worst
defect found it in a screenshot, not in source. Every reviewer that met a connection refusal wrote a
plan from source instead, because starting an unfamiliar app in a sandbox is harder than reasoning
about its code and nothing in the brief said which one was the job. Name the skills too --
`design-review`, `user`, `probe`, `hone`, and `spar` all carry `disable-model-invocation: true`, so a
worker never reaches them on its own, and a delegate outside Claude has no skill mechanism at all and
will only read a skill file it is explicitly pointed at.

**An `impeccable` brief declares `Work-class: design` and carries craft's design brief lines: `Impeccable-command`, `Target`, `Must-stay`, `Mode`, `Start`, `URL`, `Screenshots`, and `Review` naming `design-review` with a fresh reviewer; a reviewer brief carries `Target`, `Start`, `URL` and `Screenshots`.** `Invoke-FleetRoute.ps1` (`design-brief-incomplete`) and `claude-agent-gate-dispatch.js` refuse one that lacks a line. `craft` § *Design completion loop* owns the template and the build, review, fix loop (max 3 rounds); `roles/classes.json` `dispatch_routing.claude_work_class_rule.design_work` owns the field list. Douglas, 2026-10-20: "how can we adjust how impeccable skills are run (or adjust craft skill) to make sure this always happens?"

**A review of a running interface goes to an agent type that has a browser, or that may run a headless-browser script and write screenshots to a temp directory; the `reviewer` agent type (Read, Grep, Glob, Bash only) cannot open a page, and the brief names the fallback (`design-review` § Headless browser fallback).** Measured 2026-10-06: a design review sent to `reviewer` returned `could-not-complete` without opening the page.

## Before dispatching

Load the `fleet` skill, then launch only through `.agents/tools/Invoke-FleetRoute.ps1`. This checklist
owns the brief and evidence gates; the router owns provider selection, launch, and fall-through.

**Install the harness in the target repository before the first brief goes to it:**
`.agents/tools/Manage-Harness.ps1 -Action EnsureProject -Repository <path>`, then `-Action VerifyProject`.
Measured 2026-09-05: `hci-260` had received lane briefs for days with no `AGENTS.md` at all, so nothing
routed those workers to any skill, protocol, or task state, and the review dispatched there judged the
app without ever running it.

**Know what your delegate can actually reach before you rely on a skill name.**
`SKILL-PORTABILITY-CONTRACT.md` is the authority: Codex reads `~/.agents/skills/<name>/SKILL.md` directly
and reaches every installed skill, under the same manual-only policy Claude uses -- so a
`disable-model-invocation` skill has to be named in the brief for either of them. Antigravity and
OpenCode have **no verified harness-skill loader at all**, so a brief that merely names a skill to an
`agy` or muse-spark lane names nothing; inline what that lane must do, or send the work to a delegate
that can reach the skill.

0. **Every brief opens with its stage. First line, before anything else, no exceptions:**

   ```
   Stage: execute — gpt-6-luna at xhigh (cheap)
   ```

   The form is `Stage: <outline|tactics|execute|review>` followed by the (model, effort) pair the
   dispatch will actually use and that pair's spend posture from `pair_postures`, on one line: a stage
   without its pair is a label nobody has to keep, and a pair without its stage is a number nobody can
   check.

   This is the only line in a brief a machine reads. `Test-DispatchCompliance.ps1 -RepoRoot <repo>` (above) parses it,
   joins stage → `stage_posture_matches` → `pair_postures`, and FAILS the call site when the declared
   stage does not admit the pair's posture: `execute` admits `cheapest` and `cheap`, `tactics` admits
   `mid`, `outline` and `review` admit `expensive`. A dispatch with no Stage line is `unknown`, which
   gates the verifier exactly as a failure does, so omitting it is not the cheap option. Stage is never
   inferred -- not from the profile name, the role, the prompt wording, or the file path. Declare it or
   the gate stops the commit.

1. **Name the stage, then take the first qualified pair walking the active mode's worker ladder providers in order, ranked within a provider by its role ladder, at the role's per-model effort; cost only breaks ties.**
   `.agents/roles/classes.json` is the authority:
   `stages[].models` records which (model, effort) pairs each stage qualifies, `roles.<role>.effort`
   gives the effort per model, and the ladder is the active mode's `model_ladder.roles.<role>` in
   `.agents/manifests/agent-modes.json`, read through `Get-AgentMode.ps1 -Json`. Read the registry;
   never copy its pair list here. Review runs at xhigh, except the Claude reviewer, which is Sonnet 5.5 at
   medium by ruling. **Haiku 5.5 at medium is the Claude builder for routine work, Sonnet 5.5 the builder after it and for hard work only** -- Douglas 2026-10-11 17:14 PDT: "note that haiku 5.5 is now a good builder. have that be used, with sonnet 5.5 as an option but only after haiku 5.5. sonnet builders can be launched for hard tasks and haiku 5.5 can be used for non-hard tasks. and then when a task fails twice you can give it to an opus tactician." The last sentence is a permission only: when a task fails twice you can give it to an opus tactician, and nothing counts failures. **Long-running work is tactician work, never a builder task** -- Douglas 2026-10-11 22:40 PDT: "long-running work goes to tacticians in general. taht's not q builder task." A builder dispatch whose brief carries `Work-class: long-running` is refused `long-running-is-tactician-work` by the ladder resolver, the router (forced, unforced and named alike) and the Claude agent gate; route it with `-Role tactician`. Scout and reviewer are as before (he did not speak to them). **Sonnet 5.5 at medium is the Claude scout and reviewer** -- Douglas 2026-09-29 22:54 PDT: "use sonnet 5.5 med reasoning as a builder for most execution. now opus 5.5 is only tactician." (narrowing his same-day
   "no lift the ban. i want sonnet 5.5 as the new main worker agent for most things that aren't difficult, long-running work."). **Sonnet 5.5 at medium is the default Claude tactician; `Work-class: hard` upgrades it to Opus 5.5 at medium** -- Douglas 2026-10-21: "no builders should be sonnet 5.5 at medium. and both opus 5.5 on low/med and sonnet 5.5 on med should be allowed as tacticians, with sononet 5.5 med as the default, and there can be an upgrade if the work is hard." A long-running tactician takes the default. The design builder floor is Sonnet 5.5 at medium and Opus is not a reviewer. Sonnet never takes
   conductor, mastermind or advisor; a brief carrying `Work-class: long-running` outside the tactician role, `Work-class: hard` outside the builder role, or a hard tactician
   never goes to Sonnet (`classes.json` `dispatch_routing.claude_work_class_rule`, `tactician_rule`). Older Sonnet ids stay refused by the Agent gate.
   *Violated 2026-08-23: six workflows dispatched ~31 agents of execute-stage work at Opus, burning
   3.21M subagent tokens. The registry, authored 2026-08-22, was simply never opened at dispatch time.*

   | Assignment | Posture/role | Work Scope authority |
   |---|---|---|
   | Project or declared area; agent decides tracks and frontier | conductor posture (skill; non-dispatchable binding) | Sole project-state owner under CLUSTERING.md |
   | Assigned track, task queue or frontier; shape already settled | tactician (tactics) | Consumes state; queues findings for conductor |
   | Decomposition only, without project-state stewardship | mastermind (outline) | Produces seams; no implied project ownership |

   Give the conductor intent, docs, tools, ownership and acceptance evidence, not a sequence of moves.
   The conductor posture's pairs are in the registry's non-dispatchable `roles.conductor` binding; .agents/CLUSTERING.md owns collision checks.

2. **Follow the active mode's `worker_ladder`; free rungs come first in the modes whose ladder lists
   them (`claude-pilots-codex`, `codex-conductor`); `burn-*` ladders deliberately exclude them.** The
   ladder is in `.agents/manifests/agent-modes.json`, read through `Get-AgentMode.ps1 -Json`; the `cost_rank` in
   `.agents/manifests/fleet-surfaces.json` is only a tie-break between rungs the ladder leaves equal.
   - **claude-ssh is Claude on the other computer.** Its peer is resolved from `COMPUTERNAME` through
     that surface's `peer_host_by_machine` in `fleet-surfaces.json`. SYSTEMATICCHAOS's other computer
     is SEEK_TO_SERVE; an empty entry for the current machine means the rung has no peer there. It is
     admitted under `.agents/roles/classes.json` `dispatch_routing.claude_builder_rule`: read-only
     roles are free in every mode, and any other role needs a mode that admits Claude or a live
     `allow-builder`, which is valid in every mode.
   - **Codex Cloud (subscription; after free rungs):** routed by `Invoke-FleetRoute.ps1` through the
     `codex-cloud` adapter; environment ids are in `.agents/conductor/cloud-environments.json`;
     `CLOUD-PROTOCOL.md` owns the run.
   - **Browser and e2e suites run on cloud.** A local run must pass the shared heavy-test admission
     gate: `.agents/tools/Invoke-HeavyTestAdmission.ps1 -Command "<suite>" -Run`.
   - **Local placement names one of `.agents/roles/classes.json` `dispatch_routing.local_exceptions`.**
     The free local rungs (agy, opencode) need no exception (Douglas's 2026-09-10 free-first ruling,
     confirmed 2026-09-26 as survey decision 22), and neither does a rung the active mode's ladder
     names when that ladder has no cloud rung for the role, nor a local rung a `cloud_first` mode
     (burn-claude, burn-codex) falls back to after its cloud rung refuses
     (`dispatch_routing.no_cloud_rung_rule`). "It felt faster locally" is never one.
   *Measured 2026-08-30: a host at 369 processes failed a delegate launch with a process-startup
   exhaustion code, and a full day of clustered work sat undispatched while the cloud environment was
   idle.* The document-routing exemption rules and their audit switch are in
   [`DOC-ROUTING.md`](../DOC-ROUTING.md).

   **A cloud agent sees the remote, and nothing else.** A cloud lane never regenerates
   `.agents/manifests/capability-router.json`, whose `availability_by_machine` rows describe real
   devices, so cloud briefs exclude it from owned paths. Four preconditions, every dispatch:

   - **Push first**: unpushed commits do not exist to a container. *Measured 2026-08-30: `master`
     was 38 commits ahead of origin with 78 unmerged branches while seven cloud agents reasoned about
     the older tree.* If a push is unauthorized, say so and treat the staleness as a stated assumption.
   - **Verify every path the brief names** at the pushed commit: `git cat-file -e origin/master:<path>`.
     Under Git Bash on the Windows host, run it as `MSYS_NO_PATHCONV=1 git cat-file -e origin/master:<path>`
     or from PowerShell: MSYS rewrites the `rev:path` argument into a Windows path, so the bare command
     reports every path absent (`cat-file-path-check-reports-absent-under-git-bash-20260831`).
     *An audit pointed at a clusters document that existed only in an unpushed commit lost its
     population.*
   - **Declare what the container will not have**: host-only paths, Work Scope state (its absolute
     root does not resolve), sibling `agent/*` and `cloud/*` branches in a shallow clone, and any local
     process. A Codex Cloud container also has no remote branch graph: it cannot fetch remote heads (a Claude cloud container can; measured 2026-10-06, `.agents/references/claude-cloud.md`), so branch,
     pull-request and merge-state triage must never be dispatched to cloud
     (`cloud-container-cannot-fetch-remote-heads-20260831`). An untold agent takes an ordinary-looking clone as complete and reports absent where the
     honest verdict is could-not-tell. *Measured 2026-08-30: a shallow single-ref clone turned 124 of
     139 revalidation verdicts into could-not-tell.* The deepen-and-print-`git history state` step lives
     in `.agents/cloud/setup.sh`, but Codex Cloud runs its environment settings' own setup script,
     which prints `SETUP_MARKER=v3` and never a `[setup]`-prefixed line, so the clone stays shallow and
     single-ref until that script calls it.
   - **Pin and verify the remote branch.** `codex cloud exec --branch` defaults to the current local
     branch (the earlier poisoned-container-cache diagnosis was wrong). Pass `--branch` explicitly, only
     after `git ls-remote --heads origin <branch>` returns a ref; push a missing branch first or fail
     naming it; refuse detached HEAD. `[ERROR] ... no diff` maps to this check and reports the requested
     branch, never an unexplained cloud failure. *Measured 2026-09-03: the same environment returned
     `[ERROR] no diff` without `--branch`, then `[READY] +1/-0` with `--branch master`; the diff
     contained `CLOUDOK C3SNP4A0`.*

   **Every brief tells the delegate to reconcile on its own branch before reporting done.** An agent
   owns its `agent/*` or `cloud/*` branch: it merges the default branch INTO it, resolves conflicts
   there, and hands back something that lands cleanly. It does not push the default branch or merge
   into it unless an explicit authorization for that action is live: a typed `allow-merge` or
   `allow-push`, a named merge grant (`INTENT.md` `intent-named-merge-grant`), or the zero-failure
   gate in `intent-survey-approved-20260926` (the pull request's relevant tests ran against its branch
   in the same session with zero failures). *Ruled by Douglas 2026-08-30; the merge exception by the
   2026-09-26 ruling. Measured the same day: 78 branches were left for one conductor
   to reconcile, 44 of them conflicting, over five files that ten branches had each edited.*
   **What needs no tag, and what still does:** `security-checks-fast.js#gp_mergeIntoOwnBranch` and
   `#gp_pushOwnBranchOnly` implement that ruling: merging the default branch INTO an owned `agent/*` or
   `cloud/*` branch, and pushing that branch non-destructively, need no `allow-merge` or `allow-push`
   tag. Pushing or merging the default branch (`master`/`main`/`trunk`/default, case-insensitive), or
   any history-rewriting push (`--force`, `--force-with-lease`, `--delete`, `--mirror`, `--all`, or a
   leading `+` refspec), still requires one. *Ruled by Douglas 2026-08-30; 27 passing cases in
   `.agents/task-hooks/tests/merge-into-own-branch.test.js`.* The guard judges an own-branch push by the
   `agent/*` or `cloud/*` NAME PATTERN and the push form alone (it cannot verify who created a branch),
   so a local-only branch never yet on the remote pushes with no tag, while `claude/*`, `codex/*`, a bare
   feature name, a delete, `--all`/`--mirror`/`--tags`, and any refspec the guard cannot resolve still
   need one. *Fixed 2026-09-02 after `agent/pr69-landing`, a branch the agent had just created, was
   refused; 49 passing cases in `.agents/task-hooks/tests/push-own-branch.test.js`.*

   **Ask for exact literal tokens, not plain English.** The security guards honour only the literal
   tokens listed in `.agents/AUTH-TAGS.md` (`allow-push`, `allow-merge`, `allow-kill`, `allow-delete`,
   `allow-env`, etc.; brackets optional) in a human message of the CURRENT turn. Plain English ("you can
   push", "go ahead and merge") satisfies no guard; the one catalogued exception is the spoken merge
   alias listed in `AUTH-TAGS.md`. Read `AUTH-TAGS.md` before requesting authorization and ask for the
   exact token the guard expects. *Measured 2026-09-01: three authorization round trips because the
   agent asked "may I push?" instead of asking for `allow-push`.*

3. **Never leave `model` unset.** An omitted model inherits the session model — "I did not decide" and
   "I chose the most expensive option" are the same act.
   *Violated: four workflows, every agent, no model field.*

   **Delegate to the provider the active usage mode's ladder names, on the surface
   `.agents/roles/classes.json` `dispatch_routing` resolves** (cloud default, `local_exceptions`,
   `read_only_roles` and their `read_only_surface_bindings`). **Claude subagent admission is
   `.agents/roles/classes.json` `dispatch_routing.claude_builder_rule`: read-only roles (`scout`,
   `advisor`, `reviewer`) are free on Claude in every mode; any other Claude role needs
   `allow-builder` outside `burn-claude`, and `allow-builder` is valid in every mode; under
   `burn-claude` Claude is the ladder's own pick.** *Ruled by Douglas 2026-09-21 (`INTENT.md`
   `intent-ws-claude-subagent-modes`).* History: the 2026-08-31 ruling said "Codex", then the default
   external provider, and kept Claude subagents to explicit requests; the usage mode now sets which
   provider comes first (Douglas, 2026-09-20: "the order should depend on the agent usage mode"), and
   the 2026-09-21 ruling freed read-only roles. Everything a mid-tier model can do reliably —
   mechanical edits, sweeps, measurement, inventories, test runs, documentation, routine repairs —
   goes to the mode's ladder.

   **`isolation: "remote"` can fall back to a local run without saying so.** The 2026-09-01 finding
   that Claude's Agent tool silently ran it in a LOCAL worktree is historical; it was re-measured 2026-10-05 and
   still ran locally (detail: `CLOUD-PROTOCOL.md` section 1.1), and the gate allows the call. A PostToolUse check now detects a fallback and says
   "isolation 'remote' ran LOCALLY, not in the cloud", so heed that message and do not count the work as
   offloaded. The verified cloud path is the RemoteTrigger routines API:
   create a routine with a far-future cron or `run_once_at`, optionally disabled, fire it with
   `run`, and verify by reading `list_runs` then `get_run_log` and confirming the branch exists on the remote. The routine's connectors are stripped to the set the brief names before it fires.
   `.agents/CLOUD-PROTOCOL.md` §1.1 owns that path and that step. Through the router it is surface
   `claude-cloud`: `Invoke-FleetRoute.ps1` returns a `launch_plan` the session executes, and mode
   `cloud-only` resolves every dispatchable role there (tactician on `claude-sonnet-5-5`, `claude-opus-5-5` for hard work; routine
   builder on `claude-haiku-5-5` then `claude-sonnet-5-5` (hard builder on Sonnet only), scout and reviewer on `claude-sonnet-5-5`; long-running work (refused for a builder: `long-running-is-tactician-work`), and hard work outside the builder role, only as a
   tactician; the conductor stays a non-dispatchable posture binding); a local launch under it
   names its `-LocalException`. Fan-out and waiting: `Invoke-ClaudeCloudFanOut.ps1`, `Invoke-ClaudeCloudHarvest.ps1 -Wait`.
   *Historical, measured 2026-09-01: `isolation: "remote"` returned a local worktree path, not a cloud session id.*

   The provider ladder, its measured reality check, and the Cursor Cloud finding are under
   [Ordered provider ladder](#ordered-provider-ladder-for-builder-scout-and-browser-dispatch) below.

3a. **Declare placement before choosing a local machine or remote slot.** Every brief repeats the
   task's `placement` object: `required_machine` (`SEEK_TO_SERVE`, `SYSTEMATICCHAOS`, or `either`),
   `reason` (the enum in `.agents/work/schema.json` `placement.reason`), and `current_machine`. A
   local dispatch also names its `dispatch_routing.local_exceptions` entry unless item 2 exempts it (a free local rung, or a mode ladder with no cloud rung for the role). Dispatch refuses a conflicting placement; `REMOTE-MACHINE-PROTOCOL.md` owns
   the route and completion check. *Violated 2026-09-03: GPU, credential, filesystem, and
   memory-bound work was dispatched from a brief author's memory instead of a checked constraint.*

4. **Every brief says: emit no narration.** Nobody reads a subagent's progress commentary.

4a. **Every brief says: in an isolated worktree, one plain command per call with absolute literal paths.** No heredocs, loops, `$VAR`, substitution pipelines, `cd && git`, `git -C .`, `sed -i` or awk; multi-step logic goes in a script file written with the Write tool and run as one simple command; prefer Read/Grep/Glob/Edit over shell, and the PowerShell tool for scripted work. Claude Code's Bash command-shape check cannot be turned off (`references/claude-code.md`). *Measured 2026-10-03: about 44 isolation-guard refusals in one session.*

4b. **Every brief says: never `sleep` or poll in the foreground; use `run_in_background` or Monitor.** *Measured 2026-10-03: 9 sleep/poll blocks in one session.*

5. **Every editing brief says: commit every intended file before leaving the worktree.** The final
   result includes the commit SHA; uncommitted output is not delivered work.

6. **Every brief says: a harness defect gets filed, not worked around.** A subagent that hits a hook
   refusing safe input, a harness tool that crashes, or a router CLI that does not run as written must
   record it before its next tool call — `node <harness>/task-hooks/tools/report-hook-misfire.js
   --hook=<name> --reason="<why the input was safe>"` for a block, `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Add-ProjectIntake.ps1 -Project agent-harness -Id <id> -Title <text> -From <reporting-project> -Evidence "<what was observed>" -FixRecommendation "<recommended repair>" -FixLocation "<file plus function or symbol>" -FixRationale "<why this repair fits the evidence>"` for anything else — and say so in its report.
   A worker's transcript is discarded; a routed-around defect is never seen again.
   *Measured 2026-08-24: `report-hook-misfire.js` was named in no contract and no block message, and
   all three misfires on file were entered by hand after a human noticed the block.*
   Both routes run the shared filing dedup check first: `duplicate` files nothing, prints
   `duplicate-of:` and the existing record's path, counts the sighting, exits 0; `near-duplicate` files
   nothing, prints each candidate with its score, exits 3 (`-Force`/`--force` files anyway and keeps the
   link); `new` files as before; `could-not-tell` exits 4 rather than filing against a store it could
   not read. `-Force` never overrides the exact tier.
   *Measured 2026-09-02: filing was append-only with no lookup, so the open set reached 164 items
   and 513 misfire records — `checkCheckoutRestore` filed three times in one session, the
   `work-scope` stop-hook timeout repeatedly.*

6a. **Every brief requires finding repair fields and queue-only reporting.** A finding brief provides
   `FixRecommendation`, `FixLocation` (file plus function or symbol), and `FixRationale` (why that fits
   over alternatives). The worker queues findings via `Capture-WorkDiscovery.ps1` or
   `Add-ProjectIntake.ps1` (`& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Add-ProjectIntake.ps1 -Project <value> -Id <value>`), reports **queued** with the queue path, and keeps that distinct from
   **filed** until drain confirmation. Both run the dedup check above against every record already on
   file, open and closed alike, so a finding a previous session already filed is reported as
   `duplicate-of:` rather than queued again. Workers never run `Update-WorkState.ps1`, `Reconcile-WorkState.ps1`,
   or another task-state writer for findings. Only the orchestrator runs
   `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Capture-WorkDiscovery.ps1 -Root <project-root> -Drain`.

7. **Every brief declares its cluster and names its owned paths; siblings share neither.** Path
   intersection is the checkable symptom; cluster identity is the cause — two agents can hold one
   defect while touching different files, rediscover it twice, and land two half-fixes. A
   brief that cannot name its cluster is refused. `.agents/CLUSTERING.md` owns the rule; its enforcement
   belongs in `.agents/tools/Invoke-FleetRoute.ps1 -Role <role>`, which does not check clusters yet (Repair Shop
   slice RS-3), so until then the conductor checks the live population itself.
   *Violated 2026-08-30: eleven briefs across six clusters, four agents on one of them. A finished,
   tested feature died unreported on one of four sibling branches working the same area.*

   A brief that creates, replaces, or routes capability work also carries the existing-owner packet:
   the `.agents/INDEX.md` catalogue lookup, closest owner, consumers, owner tests, and exact touch list.
   An absent owner search makes the packet incomplete; the worker records the search result before acting.

   Before writing the brief, look for an existing branch, worktree or pull request for that work
   (`git branch -a`, `git worktree list`, `gh pr list`) and name what you find in the brief, or say none.
   *Measured 2026-09-28: a router lane nearly redid work that already had a worktree, two commits and
   an open pull request.*

7a. **Every review brief carries the review-context packet required by the reviewer role:**
    the exact artifact, owner, governing intent, specification, prior rulings, measurements that decide
    correctness, and access to reach each source. A missing pointer makes the dispatch incomplete; the
    reviewer reports `could-not-tell` for unreachable context rather than guessing. The portable
    contract and `.agents/roles/reviewer.yaml` own the behavior; this checklist owns the dispatch gate.

7b. **Every brief names the repository it is for — name, remote URL, or clone path.** More than one
    repository on this machine carries a tracked `.agents/` tree, so a brief owning `.agents/...`
    paths resolves plausibly in the wrong checkout and "current `origin/master`" silently means
    another repository's master. `Invoke-FleetRoute.ps1` refuses a brief without it as
    `brief-missing-repository`, and refuses one naming a repository other than the checkout it is
    routed against as `brief-repository-mismatch`.
    *Violated 2026-09-27: a brief owning `.agents/DESIGN.md` and two `.agents/skills/` trees was
    launched from a `general-ai` worktree. Nothing errored; the lane built a worktree in the wrong
    repository, caught it itself, and discarded the work.*

8. **Every brief names the command that proves the work done.** A packet with no named check cannot be
   closed honestly. A test path in a brief is one you just listed in the target tree, not one you
   remember; a remembered path that no longer exists sends the delegate hunting for its own finish line.

22. **Every brief names the specs for its owned paths, and the builder reads them and lists them as `Specs checked:` in the PR body.**
    (Numbered 22 so existing item references stay stable; it belongs here, beside the owned paths and
    the proving command.) For each owned path, the brief names the `INTENT.md` entries and the `SPEC.md`
    or `specs.jsonl` entries that govern it, copied from the file you just listed, not from memory. The
    builder reads every one before its first edit and writes a `Specs checked:` list in the PR body, one
    entry per line, naming the entry id or heading and the rule it constrains; "none apply" is an
    entry only when the brief shows the search that found none. `.agents/tools/Test-PrSpecsChecked.ps1
    -Pr <n>` fails a PR whose body lacks a non-empty list. The failure that put it here, 2026-09-30:
    PR 2255 set `roles.mastermind.effort` to one role-wide value against the standing rule "effort is a
    map read model -> surface -> default, never a role-wide constant" (Douglas: "the effort value
    shouldn't be universal per role, it should be model dependent"), because the builder never read
    `INTENT.md` or the spec and no gate caught it. Douglas: "but why didn't the bulder reference spec
    when making the pr. YOU NEED TO FXI THAT TOO."

9. **Every brief posts status-board updates for each event.** Post on start, each completed sub-step,
   any block, and finish — not on a timer. Root: `<repo-root>/.agents/work/statusboard`.
   Post with `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File <repo-root>/.agents/tools/Update-StatusBoard.ps1
   -Action post -BoardPath <repo-root>/.agents/work/statusboard -Agent <agent> -State <state> -Message
   '<one line>'`. The orchestrator reads it once; omitting
   updates recreates fixed-cadence polling. The router polls the board every `-StatusPollSeconds`
   (default 120): heartbeat plus this stall window is the primary bound, and advancing status keeps a
   lane alive whatever its elapsed time. `-StallPolls` unchanged reads (default 5) no longer kill a
   lane by themselves (S-stall-check-reads-evidence, survey C17, decision 23): they open a stall check,
   due once the status has been silent for `-StallCheckSeconds` (default `StatusPollSeconds*StallPolls`
   clamped to 15-30 minutes). The check reads the lane's own evidence -- its git worktree (HEAD, diff,
   untracked files) and its transcript (adapter stdout/stderr). Evidence that moved since the last
   status change keeps the lane alive and re-arms the check; only a lane silent on both is ended,
   reported as `stalled-no-status-progress: evidence unchanged at the stall check ...` with the last
   status line. The urgency ceiling is only the fallback for a lane whose heartbeat was never
   observed, reported as `absolute-ceiling`.
   The board is not the check-in: item 14 owns the ruled 15-30 minute check-in inside the router's
   background waiter; the evidence-reading stall check above is the part of it the router implements.

10. **Route production away from yourself.** An orchestrator's own tool calls verify, check, measure,
   and steer; a series of edits you are about to make yourself should have been dispatched. *Violated: hand-ran CLI probes, hand-edited the router generator, hand-wrote
   wrapper scripts.*

10a. **Load `.agents/CLOUD-PROTOCOL.md` for every Codex Cloud task.** It owns remote preflight,
    dispatch, completion detection, diff landing, container boundaries, host verification, and
    remote-ref continuation. A local `codex exec` background launch closes stdin explicitly; a log
    file or exit 0 alone proves nothing.

10aa. **For existing desktop slots, follow `conductor/REMOTE-DISPATCH.md`.** It owns the launcher,
      queried slot target, lane isolation, log evidence, and bundle retrieval through the shipped
      SlotBoard surface. Keep host/session prerequisites in `REMOTE-MACHINE-PROTOCOL.md`.

10b. **Route interface packets through `craft`.** Enter `craft` for interface work; craft routes
    implementation to `impeccable` and completion to `design-review`. `impeccable` opens `.agents/DESIGN.md`, `.agents/design/LIBRARIES.md`,
    `.agents/design/mission-control/REPRESENTATIONS.md`, and
    `.agents/design/mission-control/AESTHETIC-OPTIONS.md` when applicable; `design-review` supplies the
    rendered multi-viewport, real-browser, direction, and fresh-eyes bar.

11. **Make the runtime configuration explicit in every brief:**
    - `Stage:` — required, first line, with its pair. Item 0 owns the form and the gate.
    - `model` + `effort`: the first qualified pair walking the active mode's worker ladder providers in order, ranked within a provider by its role ladder (item 1), with effort from `.agents/roles/classes.json` `roles.<role>.effort[model]` (its `default` only when the model has no entry); cost only breaks ties. These are the pair the Stage line names, and the checker compares them against the stage's admitted postures.
    - `tools` or `disallowedTools`: default to inherited subagent tools; the denylist applies before an allowlist.
    - `skills`: default to none; each named skill injects full content at startup, while other skills remain invocable through `Skill`.
    - `Required skills and when to load them`: list only applicable skills and the governed action; check each description before opening its full file and load it immediately before that action. When supplied sources are complete and the task only produces an artifact, write `deep-search: not applicable` unless new or current source gathering is required.
    - `Input-path stop`: name exact required input paths and check them before loading unrelated workflows; a missing required path stops the lane.
    - `maxTurns`: default unset; choose a ceiling that permits iteration.
    - `isolation: worktree`: required for every dispatched repository lane. Give it its own linked worktree; never run its Git commands in the primary checkout. Use an explicit absolute `git -C <own-worktree>` target, including status and verifiers. `conductor/Invoke-FleetWorker.ps1` enforces linked-worktree admission before Git, leases, or launch; direct CLI launches and later commands targeting another checkout remain governed by this rule. A sandboxed surface that cannot write the linked-worktree index gets a standalone clone or an `--add-dir` grant for `.git/worktrees/<name>`, so the delegate commits its own work; `WORKTREE-PROTOCOL.md` → *Sandboxed delegates* owns the rule, and an orchestrator commit is a recorded fallback only.
    - `memory`: default none; choose `user`, `project`, or `local` only for reusable knowledge.

12. **Shape work for one end-to-end fixing area, and count agents by defect rather than by capacity.**
    The honest number of agents is the number of consolidated defects — never tickets, never free
    executor slots. Capacity is a ceiling, not a target; dispatching to fill it is the failure.
    `.agents/CLUSTERING.md` carries the signatures of over- and under-spread.

    A multi-agent Workflow run follows `ORCHESTRATION-PROTOCOL.md` § *Workflow runs*: a canary phase before any fan-out, one shared live-agent budget in waves of 3-4, one batch integration agent that runs the slow checks once per batch, and merges done by the main session, never by a workflow agent.

    Measured on this Windows host, 2026-09-05 at 09:21:07: eleven simultaneous Codex lanes exhausted process slots (`dofork: child -1 - CreateProcessW failed` for `bash.exe`, `errno 11`; `fork: retry: Resource temporarily unavailable`). A killed Git process orphaned the primary index lock. That is an observed failure at eleven; a safe concurrency ceiling has not been measured. Keep dispatch behind the existing lease admission and do not treat that failure point as an admissible target.

13. **Prefer one iterating agent.** Resume the same Codex lane, or a Claude session on `claude-local`, with
   `.agents/tools/Invoke-FleetRoute.ps1 -ResumeSessionId <id>` or `-ResumeLast` (mutually exclusive),
   keeping the same proving brief until its command is green. The router returns
   `resumable_session_id` from the Codex `thread.started` JSON event; a Claude resume names its account
   (`.agents/references/fleet.md` § *Claude session resume*). Other surfaces are refused as
   `could-not-resume: <surface> <reason>`; repeated fresh briefs discard
   context.

14. **Make evidence mechanically honest, and wait by notification.** Require `present`, `absent`, or `could-not-tell` plus population size; capture the process exit directly; give every suite at least a 600-second ceiling; use one bounded backoff watcher and never retry an unchanged blocked operation.
    Never sleep-poll a lane. Under `run_in_background`, either launch with `Invoke-FleetRoute.ps1 -Wait`
    (blocks until the outcome is judged, prints one final record) or run one batch waiter per wave:
    `Receive-FleetRoute.ps1 -DispatchId <id1>,<id2>,... [-Any] -TimeoutMinutes <n>` prints one JSON
    record when every dispatch is terminal, or at the first failure with `-Any` (exit 0 all terminal, 1
    a failure, 2 an unknown id, 3 timeout). Either way one completion notification wakes the session.
    Await a Claude subagent by its completion notification, never by polling (`TaskOutput`, `Monitor`,
    `SendMessage` pings, `ListAgents`, re-reading its output file, a scheduled wake-up): one status read
    to answer a question is a check; a loop of them is polling. The ruled 15-30 minute check-in on a running
    lane belongs inside that background waiter, not in the conductor's turn (not yet implemented
    there), and a lane is reported ended only after a check that reads its own git and transcript
    evidence -- until the waiter does that check, the conductor does it (item 17a). `ORCHESTRATION-PROTOCOL.md` →
    *Waiting and fan-out* owns the measurement.

15. **Use skills with an explicit cost decision.** Douglas's 2026-08-29 measurement counted 49
    auto-loadable skill descriptions costing 20,542 bytes in every session. Stored before-snapshot: 49
    skills, 6,979 UTF-8 listing bytes; current tree: 50 skills, 7,115 bytes — byte cost and population
    reconciliation are `could-not-tell`. Disabling model invocation on 45 skills was reverted because
    11 are routed by the always-loaded contract. Preloading named skills injects their full content into
    one subagent's startup context; it neither reduces session-wide cost nor prevents other skill
    discovery. A skill marked `disable-model-invocation: true` cannot be preloaded.

16. **Assign memory only to agents that accumulate reusable knowledge.** Use `project` for a
    repository reviewer or other project-specific long-lived specialist, `user` for knowledge shared
    across projects, `local` for project knowledge that stays out of version control, none for
    one-shot workers. `MEMORY.md` (`user`: `~/.claude/agent-memory/<name-of-agent>/`; `project`:
    `.claude/agent-memory/<name-of-agent>/`; `local`: `.claude/agent-memory-local/<name-of-agent>/`)
    stores durable conventions, locations, recurring issues, and architectural insights;
    `.agents/work/state.json` stores task and scope state; `.agents/tools/Update-StatusBoard.ps1 -Action <action>` (item 9)
    stores ephemeral progress. When enabled, the first 200 lines or 25 KB of `MEMORY.md`, whichever
    comes first, loads and Read/Write/Edit enable automatically. No effect when auto memory is
    disabled with `autoMemoryEnabled: false` or `CLAUDE_CODE_DISABLE_AUTO_MEMORY`.

17. **Every editing brief ends with reconcile, push, and a pull request — on the delegate's own branch; a read-only brief declares `-ExpectArtifact none`.**
    The delegate merges master into its own `agent/*` or `cloud/*` branch, pushes it, and opens a pull
    request with `gh pr create`, for example:
    `git -C <worktree> checkout agent/<task> && git -C <worktree> merge master && git -C <worktree>
    push -u origin agent/<task> && gh pr create --base master --head agent/<task> --title "<title>"
    --body "<body>"`. Neither step needs a tag (item 2). The delegate returns the branch name and the PR
    URL, not just "done"; an output without both is unverifiable. A caller may pass
    `-ExpectArtifact pull-request` (the default), `-ExpectArtifact commit` (accepts confirmed new
    commits), or `-ExpectArtifact none` (skips artifact confirmation and relies on the adapter
    outcome); the brief must name the expectation.
    Exception: a Codex Cloud brief ends with a local commit only; the host lands it through
    `CLOUD-PROTOCOL.md` §7 (`Publish-CloudTask.ps1`), and the dispatch declares `-ExpectArtifact commit`.

    **The command that proves it is `.agents/cloud/Test-DispatchLanded.ps1`.** A unit counts only when
    its commit is reachable from the default branch and its pull request is closed; read the artifact,
    never the status: `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/cloud/Test-DispatchLanded.ps1 -Branch
    "agent/a,agent/b" -RecordPath .agents/cloud/dispatch-landed.jsonl`. Every branch comes back
    `landed`, `empty`, or `could-not-tell` and never two; an unreachable remote is `could-not-tell`,
    never `empty`. Exit 0 means every branch landed. Run it before dispatching the next wave —
    `Submit-CloudTask.ps1` refuses with `previous-wave-unclassified` (exit 4) while an earlier wave's
    branch has no `landed` or `empty` record, because `could-not-tell` is not a result.
    *Violated 2026-08-31 (item 18's measurement): the eight READY cloud tasks had pushed no branch, and
    nine more were dispatched before anyone looked at the artifact.*

    **A merge gates on locally run relevant tests with zero failures, plus
    `Manage-Harness.ps1 -Action VerifyProject`.** Record each command and its result in the pull
    request. GitHub Actions is off and is never a gate: never wait on it or recommend fixing its
    billing (`INTENT.md` `intent-github-actions-off`).

    **Before merging any harness pull request, run the pins-repo check on its head:**
    `Test-HarnessHealth.ps1 -Quick`, or `Manage-Harness.ps1 -Action InstallGlobal -DryRun`. A PR's own
    suite does not re-hash pinned scripts. *Measured 2026-09-28: #2133 changed the pinned
    `Invoke-FleetRoute.ps1`, merged on its own suite (578 passed, 0 failed), and master's
    `InstallGlobal` then refused on pins-repo.*

## When a route is down

The router sends a tactician for you (Douglas, 2026-09-18). A free surface that fails, or is skipped as down, gets one `Start-RouteRepairLane.ps1` lane on its own `agent/route-repair-*` branch. That lane fixes the adapter or catalogue, adds a test, and updates the providers `.agents/references/<provider>.md`. Read `route_repairs` in the route result. Do not launch a second, hand-written repair for the same surface.

## Before claiming anything

3 of 7 providers showed mergeable PR delivery (`opencode / muse spark`, `agy`, `cursor-agent`); the historical Codex Cloud probe had no diff. `CLOUD-PROTOCOL.md` §7 owns READY-task landing.

17a. **A delegated agent's status is not its result, and a status label is never evidence.** Finished,
    succeeded, READY and green all say the agent stopped, not that it produced anything. Before counting
    delegated work, dispatching more on top of it, or reporting it to Douglas, verify the artifact: the
    branch exists on the remote, the diff is non-empty, the pull request is open. The always-loaded
    contract states this rule without a date; item 18 carries the measurement.

17b. **MERGED is not landed, and a pull request based on another agent branch is how a unit is lost.**
    A child pull request merges into its BASE BRANCH. When that base reached the default branch
    first -- the normal order, because it was opened first and reviewed first -- the child's merge
    lands on a branch nothing points at any more. GitHub marks it MERGED, closes it, and shows no
    warning on any surface. Open against the default branch; if a stack is unavoidable, re-point the
    child's base before it is merged. `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Test-MergedUnitsLanded.ps1`
    answers it after the fact with one `git merge-base --is-ancestor` per merged pull request.
    *Measured 2026-09-20: five pull requests merged inside twenty seconds, the two stacked ones --
    #1539 and #1543 -- into base branches merged four and six seconds earlier. Neither merge commit
    is an ancestor of master. The loss surfaced an hour later and by accident, when a verifier the
    missing change was supposed to have made green came back red.*

18. **Run the thing that proves it, then quote its real output.** Never report a result you did not
   observe. *Violated: claimed a vault block and a queue item were closed when the CLI merely started
   working, which made them closable and nothing more.*
   This checklist owns the measurement behind item 17a's rule. *Measured 2026-08-31: eight cloud tasks
   reported READY, every one of them printed `no diff`, not one had pushed a branch, and nine more were
   dispatched on top of that assumption before anybody looked at the artifact.*

19. **A number in a claim is the number a command printed**, not a tally kept while reading.
   *Violated: told Douglas 32 decisions would reach him; the rollup delivered 18.*
   A pull request body's pass count is a claim about one commit; after any later commit, re-measure
   before repeating it (measured 2026-09-28).

20. **Register a check you can actually execute.** A task whose acceptance check cannot run has no
    honest route to closed.
    *Violated: registered three tasks against a bare CLI name with no arguments, which byte-matching
    would have refused at closure.*
    Order the check so it can run in a fresh worktree: in a Next.js app `npm run typecheck` fails until
    a build has generated `.next/types`, so list `build` before `typecheck` (measured 2026-09-28).

20a. **A nested (depth-2) builder commits its work-in-progress at checkpoints, not only at completion,
    so a hand-back surviving its tactician does not depend on the tactician's own turn outlasting it.**
    When a tactician dispatches a builder and that builder's brief spans more than one meaningful step
    (a fix plus its regression test, or several files touched in sequence), the builder makes a local WIP
    commit on its own branch after each step lands, before starting the next one -- not just a single
    commit at the very end. If the tactician's turn ends first, the builder's branch already carries
    everything finished up to the last checkpoint instead of nothing. This does not relax `18`: a
    checkpoint commit is still unverified until its proving command has actually run against it.
    *Violated 2026-09-28: a depth-2 builder under a Coursebook conductor finished real work, but its
    tactician ended its turn before relaying the report, and with no intermediate commit the hand-back
    was dropped entirely (`nested-builder-report-dropped-20260928`, general-ai session a3b5d2d9).*

## Ordered provider ladder for builder, scout, and browser dispatch

This section explains the policy the `fleet` skill and `.agents/tools/Invoke-FleetRoute.ps1 -Role <role>` (command
at the top of this file) implement; it is not a menu of direct launch commands.

The ladder is mode-resolved and this section does not restate it. Read the active mode's
`worker_ladder`, `model_ladder`, and `placement_preference` from
`.agents/manifests/agent-modes.json` through `Get-AgentMode.ps1 -Json`; `fleet-surfaces.json`
`cost_rank` only breaks ties. A provider whose
`.agents/state/provider-status.json` entry is `exhausted` is skipped; continue in manifest order and
record the skip and selected runner.

### Placement is part of the dispatch, not an afterthought

`placement_preference` in the same manifest is ordered, and its LAST entry is the one that needs
justifying: local has the least setup friction, so a location re-decided on every dispatch lands local
without ever having been decided. Every brief states its execution location and, when local, which
of `.agents/roles/classes.json` `dispatch_routing.local_exceptions` applies; the free local rungs
(agy, opencode) and a mode ladder with no cloud rung for the role need none (item 2). What cannot be pushed is host-only state, such as
`.agents/state/` and the vault, not a repository. **"Faster to set up" is not an exception.**

Check two quiet remote failures before routing. Two checkouts of one repository sit on **different
branches with different files**, so a brief written against one machine's filesystem produces
confident garbage on the other: state the branch and verify it on the target. An SSH session on a
remote Windows host **cannot see GUI or credential state**, so anything touching git or a credential
goes through a desktop-slot job, not plain SSH; `REMOTE-MACHINE-PROTOCOL.md` owns that bridge. When
the remote genuinely lacks unpushable files, say so in the final message and run local — never route
local silently.

`Set-AgentMode.ps1 -Mode <name> -Scope <machine|project|session>` sets a scope. Precedence: environment
`AGENT_MODE`, then session, project, machine, and the manifest default. Machine state stays at
`.agents/state/agent-mode.json`, ignored by Git. Project state uses the machine-local Fleet repository
directory keyed by the origin owner/name, so linked worktrees share one setting. Session state uses a
machine-local session-keyed file and accepts `-SessionId` or the host session environment. `-Clear`
removes the selected scope. A scheduled machine follow-on applies when Task Scheduler exists; expiry for
every scope is also resolved lazily by
`Get-AgentMode.ps1` (`& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Get-AgentMode.ps1 -Json`).

Claude and Codex tacticians use this ladder once per builder, scout, or browser child dispatch. Read
`core.clis[].availability_by_machine.<hostname>` in `.agents/manifests/capability-router.json`. That
entry carries **three states, and undetermined is not absent**:

| Entry | Meaning | What the rung does |
|---|---|---|
| `present: true`, `verdict: present` | measured working on that machine | run the rung, if `context_available` is true or absent |
| `present: false`, `verdict: absent` | measured missing or broken there | fall through to the next rung |
| `present: null`, `verdict: could-not-tell`, or the hostname is missing | **not measured** — `failure_reason` says why | measure it, then decide |

`context_available: false` falls through on any verdict. Terminal rung: stop with `no-eligible-surface`, run the `evolve` repair, and record it; the orchestrator does not produce the work itself.

Never treat undetermined as absent; folding the two silently removes a working CLI from the ladder.
Measured on SEEK_TO_SERVE 2026-09-02: all five delegation CLIs read `present: false` while
`Get-Command` resolved every one of them in the same runtime, and a reader of that record would have
dropped straight to the terminal rung with four healthy workers installed. An undetermined rung is measured
first — `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Build-CapabilityRouter.ps1 -ProbeDelegationCli <name>`
runs that CLI's own advertised invocation and records the verdict. If the measurement cannot be run
here, fall through and record the rung as **undetermined, not measured** — never as unavailable.
Record every attempted/skipped rung, its reason, its recorded verdict, and the actual runner in the
dispatch record.

Per-surface notes follow. Their order is not the ladder; `worker_ladder` is.

- **Jules async delegate:** `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Invoke-JulesTask.ps1 -Repo <owner/name> -BriefFile <brief> -Branch <remote-branch>`. Requires `JULES_API_KEY`, a connected Jules source, the roster entry's browser plan-approval gate, and artifact verification through its pull-request-only delivery.
- **agy:** When Codex holds a fanned-out production unit, give each child its own brief and working directory, then run `& 'C:\Program Files\PowerShell\7\pwsh.exe' -NoProfile -NonInteractive -File .agents/tools/Invoke-AgySquad.ps1 -ManifestFile <json>`. The runner uses `--mode accept-edits`, an explicit `--print-timeout`, safe flag order, concurrent processes, and Git artifacts—not exit codes—to classify every child. `WORKTREE-PROTOCOL.md` owns directory isolation; `.agents/references/agy.md` owns measured CLI behavior.
- **Muse spark:** `opencode run --model opencode/muse-spark-1.3-contributor-free --dir <dir> "<brief>"`. Permission flag: none — writes by default. **Use only when sensitivity is proven absent.** Legal material, personal or financial records, credentials, and anything from the reserved vault locations defined by `.agents/VAULT-PROTOCOL.md` are sensitive. Unknown sensitivity skips Muse.
- **cursor auto:** route through `.agents/conductor/Invoke-FleetWorker.ps1 -Cli cursor-agent`; it measures Git before and after, runs the proving command, and rejects exit 0 with no work. The direct `cursor-agent` process exit is never delivery evidence.
- **Codex (local):** `codex.exe exec --skip-git-repo-check -s workspace-write --add-dir <dir> -C <dir> "<prompt>"`. Permission flag: `-s workspace-write`.
   Dispatches that may need Python also carry `--add-dir <Python install directory>`; the Codex
   adapter resolves and adds it automatically. A hand-rolled `codex exec` invocation does not get
   this grant for free; see `.agents/references/codex.md` for the measurement.

   **Headless app verification is available to Codex.** A Codex agent can be required to interact with a running web app through CDP; use `.agents/references/codex.md` → *`codex exec` CAN drive a real browser* and copy `skills/chrome-cdp/scripts/cdp-drive.js` into its lane. The bundled browser plugin is not that route. Start with no `--add-dir`; add only a measured need, one flag at a time, and re-check a trivial command after each addition.

   For an explicitly authorized local full-access Codex run, follow `.agents/task-hooks/CODEX-NATIVE-HOOKS.md` and its `config/codex-hooks.example.json`; the native `PreToolUse` hook must remain wired to the shared `security-dispatch.js`.
- **Terminal rung:** stop with `no-eligible-surface`, run the `evolve` repair, and record it; the orchestrator does not produce the work itself (`AGENTS.md`: own tool calls are for orchestration only).

The commands and permission flags above are the measured non-interactive forms from
`.agents/REMOTE-MACHINE-PROTOCOL.md`. Its CLI-and-machine entry owns each timeout, elapsed time, and
context-availability state. A measurement on another machine does not qualify a rung here.

### Provider reality check — 2026-09-03

The following host probes used inert, generated values. Delivery claims require the recorded PR API
readback; `UNKNOWN` is an observed GitHub response and does not count as mergeable. In the table,
*prior* = established prior evidence, *probe* = could-not-tell — run the throwaway delivery probe,
*Spoon-Knife* = could-not-tell — the separate Spoon-Knife lane owns proof, and *readback* =
could-not-tell — `gh pr view <n> --json mergeable,mergeStateStatus`.

| Provider | Installed | Authenticated | Non-interactive dispatch | Real work | Commit | Push | PR | Mergeable |
|---|---|---|---|---|---|---|---|---|
| codex | prior | prior | prior | prior | probe | probe | probe | readback |
| Codex Cloud | prior | prior | observed — `codex cloud exec --env 6a93c7a60bac81918fb5afa92e389bdc` returned a task URL | observed — this historical probe returned `no diff` | no diff | no diff | could-not-tell — no diff to land | could-not-tell — route a READY task through `CLOUD-PROTOCOL.md` §7 |
| jules | prior | observed prior evidence | prior | Spoon-Knife | Spoon-Knife | Spoon-Knife | Spoon-Knife | readback |
| opencode / muse spark | observed — `opencode` resolved `C:\Users\dougl\AppData\Roaming\npm\opencode.ps1` | observed — `opencode auth list` reported zero stored credentials and provider handles | observed — `opencode run --model opencode/muse-spark-1.2-contributor-free` exited 0 | observed — `PROOF_FILE_BYTES=32`, generated inert value written | observed — `a309f590f5308384e53d263f3c498409a2adaa88` | observed — feature branch pushed | observed — [PR 1](https://github.com/douglaspmcgowan/cliprobe-delivery-c1dd0e3d65c84cf094d91cd9edb3540f/pull/1) | observed — `CLEAN`, `MERGEABLE` |
| agy | observed — `C:\Users\dougl\AppData\Local\agy\bin\agy.exe`, version `1.1.24` | observed — `agy models` returned models without exposing credentials | observed — headless probe exited 0 | observed — output contained generated `eeabf25f971845cd99ca65d60ab98460` | observed — `684ddf786b98d709bae493f0c12ef847db4dc296` | observed — `agy-proof-552720` pushed | observed — [PR 1](https://github.com/douglaspmcgowan/cliprobe-agy-638330/pull/1) | observed — `CLEAN`, `MERGEABLE` |
| cursor-agent | observed — version `2026.08.31-4057e58` | observed — authenticated | observed — auto dispatch exited 0; explicit `gpt-5.6-luna` failed `ActionRequiredError` | observed — auto proof passed with generated inert value | observed — throwaway commit | observed — throwaway branch pushed | observed — [PR 1](https://github.com/douglaspmcgowan/cliprobe-20260903-082841201c5b/pull/1) | observed — `CLEAN`, `MERGEABLE` |
| Cursor Cloud | observed — existing scripts | observed — API reached | observed — submission reached API | could-not-tell — API returned HTTP 400 before run creation | no run | no run | no run | could-not-tell — no PR exists |

### Cursor Cloud API finding — 2026-09-03

Fetched 2026-09-02 from [Cursor Cloud Agents API](https://prod.cursor.com/docs/cloud-agent/api/endpoints).
The documented create fields match `New-CursorCloudAgentPayload`: `prompt.text`, `repos[].url`,
optional `repos[].startingRef`, `workOnCurrentBranch`, `autoCreatePR`, and optional `model.id`.
The response documents `workOnCurrentBranch` as agent metadata, while also accepting it on create.
`https://api.cursor.com/v1/models` returned `default`/`auto`, `composer-2.5`, `gpt-5.6-luna`, and
other current IDs; the configured `gpt-5.6-luna` is present.

The redacted live POST body was:

```json
{"prompt":{"text":"Probe request shape only; do not modify anything."},"repos":[{"url":"https://github.com/douglaspmcgowan/cursor-cloud-probe-20260903-7f3e"}],"autoCreatePR":true}
```

The verbatim response body was:

```json
{"error":{"code":"usage_limit_exceeded","message":"Usage-based pricing required. Background Agent requires at least $2 remaining until your hard limit. Enable usage-based pricing and set a Spend Limit at https://www.cursor.com/dashboard?tab=settings."}}
```

No request field was wrong. `CursorCloud.psm1` now preserves the response body, classifies this as
`cursor-usage-limit-exceeded`, and logs redacted request/response bodies through
`CURSOR_CLOUD_HTTP_LOG`, which the submit and status drivers enable by default. Per the API
documentation, `workOnCurrentBranch: false` creates a new `cursor/...` branch and each agent gets a
dedicated VM, isolating branch and checkout across concurrent dispatches.

## Codex host update — 2026-09-03

On `SEEK_TO_SERVE`, `codex-cli 0.151.0` is installed. Background launches close stdin, and local
concurrency follows live host-load admission and each surface's capacity, with no numerical mode cap
in `.agents/manifests/agent-modes.json`. The live Codex hook smoke confirmed the allow path and filed a
required misfire for the refusal path; details and transcript are in `REMOTE-MACHINE-PROTOCOL.md`.

## After the turn

21. **Re-read this file against what you just did.** The failure that produced this document was never
    ignorance of a rule — it was never checking whether it had been followed.
