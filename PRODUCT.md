# Product

## Problem

## Users and jobs

## Outcomes

## Scope

## Non-goals

## Current product evidence

Keep product intent and the system record here. Put interface rules in `DESIGN.md`, active work in `TASK.md`, and harness workflow discovery in `.agents/INDEX.md`.

## System record

### Core documents

| File | Owns |
|---|---|
| `AGENTS.md` | Portable project behavior |
| `CLAUDE.md` | Claude import |
| `.cursor/rules/00-project-contract.mdc` | Cursor project pointer |
| `TASK.md`, `LOG.md`, `BACKBURNER.md` | Legacy task state when Work Scope is absent; generated views when enrolled |
| `DESIGN.md` | Universal and project interface rules |
| `PRODUCT.md` | Product intent, architecture, navigation, and durable capability state |
| `MEMORY.md` | Lean durable-reference index |
| `.agents/INDEX.md` | Canonical harness skills, tools, owners, and search routes |
| `skills-manifest.json` | Canonical skill bindings |
| `data-manifest.yaml` | External-data authorities, adapters, and restore rules |
| `secret-manifest.json` | Value-free secret inventory and trust boundaries |

### Architecture

| Component | Purpose | Entry point | Owner |
|---|---|---|---|
| `<component>` | `<purpose>` | `<path or command>` | `<owner>` |

### Important paths

| Path | Purpose | Generated | Committed |
|---|---|---|---|
| `<path>` | `<purpose>` | `<yes/no>` | `<yes/no>` |

### Data flow

Describe inputs, transformations, stores, outputs, and trust-boundary crossings.

### Integrations

| System | Direction | Credential name | Failure behavior |
|---|---|---|---|
| `<system>` | `<in/out/both>` | `<name only>` | `<behavior>` |

### Ownership and concurrency

Record component owners, shared mutable resources, worktree constraints, ports, test databases, and deployment targets.

Update this record when a component boundary, data flow, owner, integration, core document, or important path changes.
