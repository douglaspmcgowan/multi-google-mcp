# Project map

## Core documents

| File | Owns |
|---|---|
| `AGENTS.md` | Portable project behavior |
| `CLAUDE.md` | Claude import |
| `.cursor/rules/00-project-contract.mdc` | Cursor project pointer |
| `TASK.md` | Active goal, queue, blockers, completed evidence, next verifier |
| `LOG.md` | Append-only completed work |
| `BACKBURNER.md` | Parked work |
| `Outputs/00 - Outputs Index.md` | Complete index of recurring project deliverables |
| `MAP.md` | This architecture and navigation map, plus durable capability state |
| `DESIGN.md` | Universal and project interface rules |
| `PRODUCT.md` | Optional product intent |
| `MEMORY.md` | Lean durable-reference index |
| `skills-manifest.json` | Canonical skill bindings |
| `data-manifest.yaml` | External-data authorities, adapters, and restore rules |
| `secret-manifest.json` | Value-free secret inventory and trust boundaries |

## Search surfaces

Use the surface whose contents match the question. Scope every search to allowed roots; `VAULT-PROTOCOL.md` → **5. Prohibited paths** and `AGENTS.md` → **Safety and boundaries** own excluded vault and Drive locations.

- **This repository** — source, contracts, fixtures, task state, and documentation. Resolve with `git rev-parse --show-toplevel`; search tracked content with `git grep`. Git is required to obtain a fresh Windows checkout and is present in the pinned cloud environment.
- **Shared harness** — canonical skills, tools, protocols, and maps. Resolve `~/.agents/` when present, otherwise this repository's `.agents/`. A checkout searches tracked content with `git grep`; an installed copy may lack `.git`, so search the selected allowed root with scoped `Get-ChildItem -File -Recurse | Select-String`. Read `INDEX.md` before concluding a skill or workflow is absent.
- **Obsidian vault** — authored knowledge, decisions, and links. Resolve with `.agents/tools/VaultResolver.psm1` → `Resolve-ActiveVault`; read `VAULT-PROTOCOL.md` and the resolved vault's `IA.md` before the safe cited query route. Host only.
- **Google Drive** — synchronized external documents and project data. Resolve with `.agents/tools/HomeResolver.psm1`: `Resolve-GoogleDriveRoot` honors `GOOGLE_DRIVE_ROOT`, while `Get-GoogleDriveMountRoots` checks the resolved home and filesystem drive roots for `My Drive*`. A container with no resolved mount reports it unavailable. Read `data-manifest.yaml` before using a project data adapter.

## Architecture

| Component | Purpose | Entry point | Owner |
|---|---|---|---|
| `<component>` | `<purpose>` | `<path or command>` | `<owner>` |

## Important paths

| Path | Purpose | Generated | Committed |
|---|---|---|---|
| `<path>` | `<purpose>` | `<yes/no>` | `<yes/no>` |

## Data flow

Describe inputs, transformations, stores, outputs, and trust-boundary crossings.

## Integrations

| System | Direction | Credential name | Failure behavior |
|---|---|---|---|
| `<system>` | `<in/out/both>` | `<name only>` | `<behavior>` |

## Ownership and concurrency

Record component owners, shared mutable resources, worktree constraints, ports, test databases, and deployment targets.

## Update rule

Update this file when a component boundary, data flow, owner, integration, core document, or important path changes.
