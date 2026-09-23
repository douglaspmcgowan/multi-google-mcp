# Project design rules

<!-- agent-harness:universal-design:v1:start -->
## Universal interface rules

The authority is `~/.agents/DESIGN.md`, and it is fuller than this. What follows is
carried here rather than only linked because a cloud or container session has no
`~/.agents` to reach — so the rules that actually change what gets built have to survive
in the repository itself.

### Anti-default discipline

Quoted verbatim from the authority rather than paraphrased, because this is the section an
agent most needs and a paraphrase is a second copy that drifts.

The model's house style is recognizable, and reaching for it reads as machine-made. Never
default to: purple-blue gradients, a centered hero over a dark mesh background, three equal
feature cards, ubiquitous glassmorphism, or Inter with slate everywhere. The
beige-brass-espresso "premium consumer" palette is the same tell; rotate off it.

- Lock one accent color page-wide, and one gray family per project.
- Lock one corner-radius system per page. Mix radii only under a rule you can state.
- Keep one theme per page. Sections do not invert light and dark mid-scroll except as a single deliberate composition device.
- A section layout family appears at most once per page. At most two consecutive image-text zigzag splits. At most one small uppercase eyebrow label per three sections.
- Where a brief reads as an established design system, use that system's official package rather than approximating it. One system per project.
- The brief wins. Honor a pinned aesthetic even when it is not the choice you would make; redirecting a clear brief toward your own taste is failure, not judgment.

### Names that appear here only to be forbidden

The rules above and below name specific typefaces in order to ban them. A project that
scans its own source for banned font names will find those names *here* and report this
file as the violation — measured on `base-flight-finder`, 2026-08-07, whose typography
policy test failed against text whose whole purpose is to forbid the thing it names.

**If you write such a scan, exclude the region between the two `agent-harness:universal-design`
marker comments.** That region is generated and is replaced wholesale on every sync, so
nothing a project owns ever lives inside it. The names are also declared machine-readably
on the next line, so a scanner can subtract them without parsing prose. `Test-DesignBlockScanSafety.ps1`
fails the build if any of them appears outside the markers, which is what makes the
exclusion sufficient rather than merely conventional.

**Match on word boundaries, not substrings.** `Inter` is a prefix of interaction,
interface, internal and interval, so a bare substring scan reports a violation on ordinary
English. That is a second, independent cause of the same false positive, and it lives on
your side of the line rather than in this block — the check above hit it on its own first
run, against the heading "Interaction and accessibility" a few sections down.

<!-- agent-harness:design-prohibited-names: IBM Plex Mono, Inter, Fraunces, Instrument Serif -->

### Everything else

- Never use IBM Plex Mono.
- Default to a sans display face. Use serif only with an articulated reason; `Fraunces` and `Instrument Serif` are banned as defaults specifically because they are the common machine-made choice.
- Hero discipline: the hero fits the first viewport, the headline runs at most two lines, subtext stays under roughly twenty words, and no more than four text elements sit inside it. Trust marks and logo walls go below the hero, never in it.
- A grid has exactly as many cells as there is content for. Reshape the grid rather than pasting in a blank tile.
- Every animation names what it communicates — hierarchy, sequence, feedback, or state change. An animation that names nothing gets cut.
- Reread every visible string before shipping. Never invent a precise-sounding number.
- Use a proportional body face for prose, navigation, labels, dates, names, and human-readable metadata.
- Reserve monospace for code, commands, identifiers, timestamps, and genuinely tabular numeric data.
- Define explicit body, display, and monospace roles. Use tabular numerals on the proportional face for aligned quantities.
- Establish hierarchy through size, weight, spacing, and placement before decoration.
- Give each screen a clear primary action or reading path. Use spacing and alignment to show relationships.
- Reuse existing tokens and components before adding variants.
- Cover relevant default, hover, focus, active, disabled, loading, empty, error, and success states.
- Use semantic structure and native controls, visible keyboard focus, logical tab order, accessible names, sufficient contrast, and non-color state cues.
- Support narrow, medium, and wide layouts, zoom, text resizing, touch targets, and reduced motion.
- A design skill's silence on accessibility is not an exemption. Seven of the sixteen design-adjacent skill packages carry no accessibility content at all, so the two bullets above are the floor whichever skill is driving.
- A visual world is chosen, not accumulated. Template packs, style presets, and named aesthetics contradict each other by construction — `retro-windows` bans every rounded corner where `capsule` requires a 9999px radius. Commit to one, take its taste entire, and treat the others as unread. The rules here apply to all of them.
- Inspect the existing design system, screenshots, and implementation before proposing a new rule or component.
- Verify browser-visible work with browser or end-to-end tests across responsive, keyboard, loading, empty, and error behavior.

### Design libraries

Concrete things to reach for — animation packages and working skeletons, icon kits, typeface pools, design-system install commands and canonical documentation. Read the leaf you need; each one loads on its own.

- **Index** `~/.agents/design/LIBRARIES.md`
- **Motion** `~/.agents/design/animation/` — `libraries.md`, `sticky-stack.md`, `horizontal-pan.md`, `scroll-reveal.md`, `liquid-glass.md` (frosted glass), `forbidden.md`
- **Icons** `~/.agents/design/icons/libraries.md`
- **Type** `~/.agents/design/type/families.md`
- **Design systems** `~/.agents/design/systems/install.md` and `sources.md`
- **Design languages** `~/.agents/design/languages/registry.md` — read it before committing a visual world or generating a new design language, and register the world committed for this project there in the same work unit
- **Surface craft** `~/.agents/design/craft/` — `high-end.md` (surface construction), `from-reference.md` (building faithfully from a reference image), `from-code.md` (reading a design system out of a live product's own CSS), `device-mockups.md`
- **Fundamentals** `~/.agents/design/fundamentals.md` — the arithmetic under a decision: palette construction (60-30-10, one accent, warm neutrals, the colourblind-safe sets and the grayscale test), type-scale ratios with a worked scale and measure, and grid selection. Read it when the palette or scale is not already decided
- **Slides and posters** `~/.agents/design/slides-and-posters.md` — the only leaf addressing a non-web medium: deck frameworks, PowerPoint craft, HTML deck frameworks, and the academic poster including A0 sizing and the ≥24pt body floor
- **Pre-ship matrix** `~/.agents/design/preflight.md` — the mechanical finish check for landing, marketing and portfolio surfaces; not dashboards, not product UI
- **Dashboards and data-dense product UI** `~/.agents/design/dashboards.md` — the full system for the surface this tree used to leave uncovered: the three dashboard kinds and why building one while thinking of another causes most of the mistakes, information architecture and the three reading distances, density targets set against marketing spacing, typography and colour for data (sequential, diverging, categorical and semantic scales), chart selection ordered by the Cleveland-McGill perceptual ranking, chart and table craft, the six states every data region has, filters and URL state, interaction, real-time cadence, renderer choice by point count, the charting-library table, the anti-patterns, and a §18 pre-ship matrix that is the entry above's equivalent for this medium. This line used to say the tree did not own dashboards and pointed at the `/design-review` rubric, which critiques a running app rather than generating one; that gap closed on 2026-08-09
- **Mobile, touch and responsive** `~/.agents/design/mobile.md` — the medium, not a surface type: the three kinds of mobile thing and why a responsive site should not get a bottom tab bar, the viewport and its moving parts (`svh`/`lvh`/`dvh`, `viewport-fit=cover`, `env(safe-area-inset-*)` with the `max()` fallback that is the part people omit), the three touch-target floors — WCAG 2.2's 24px, Material's 48dp, Apple's 44pt — and which to design to, thumb reach and what it decides, mobile type including the 16px threshold below which iOS zooms a focused input, breakpoints and container queries, navigation patterns, forms with `inputmode`/`autocomplete`/`enterkeyhint` and the keyboard that covers your action bar, the gestures the OS has already reserved, the states that do not exist without a pointer, scrolling, the motion budget on a mid-tier device, images, offline, touch accessibility, the anti-patterns, a §18 pre-ship matrix, and §19 on the four checks emulation cannot answer. It does not restate `impeccable`'s `reference/adapt.md`, which owns converting an existing surface between contexts

The full universal rules are `~/.agents/DESIGN.md`. Where a library entry and a rule disagree, the rule wins.

**This list is enumerated because it has to be.** A cloud or container session has no `~/.agents` to walk, so this block is the only routing it gets — which also means a leaf missing here is a leaf that session cannot reach at all. `craft/` and `preflight.md` were absent until 2026-08-07 and every project copy inherited the gap. `Test-DesignLibraryIndex.ps1` now fails the build when this list falls behind the tree.
<!-- agent-harness:universal-design:v1:end -->

## Product-specific typography

- Body:
- Display:
- Monospace:

## Tokens and components

- Record project-specific tokens, established components, and allowed variants.

## Interaction and accessibility

- Record project-specific states, motion, responsive behavior, and accessibility constraints.

## Exceptions

- Record a universal-rule exception only with the evidence and verifier that justify it.
