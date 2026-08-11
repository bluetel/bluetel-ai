# Contract: Design Tokens (`apps/sisyphus-admin/DESIGN.md`)

> **DEPRECATED (2026-08-11):** The Sisyphus workflow platform — including the executor, control plane, admin app, and agent credential pool described in this document — has been deprecated in favour of the Claude Code GitHub Action. This was because the GitHub Action is easier to maintain and configure, and more customizable than the bespoke infrastructure it replaced. This document is retained as a historical design record only; the packages and apps it describes have been removed from the repository.

**Feature**: `specs/002-sisyphus-workflow-platform` | **Date**: 2026-08-05

The token set the panel's `DESIGN.md` must declare, and the structural rules `design-lint` enforces. This is the
**contract**; the panel's `DESIGN.md` is the artifact, and it additionally carries the eight prose sections.

## Document structure

Front matter declaring `colors`, `typography`, `spacing`, `rounded`, `components`, then **exactly** these eight
`##` sections, each at most once, in this order (FR-020):

> Overview · Colors · Typography · Layout · Elevation & Depth · Shapes · Components · Do's and Don'ts

A duplicate heading is a hard error. An intentionally absent section goes in `omitted:` with a reason — never an
empty heading. Composites are referenced (`{typography.label-mono}`, `{colors.signal}`), not restated.

## The governing rule

**Instrumentation, not intelligence.** Hairline rules, mono readouts, status LEDs, measured type — borrowed from
engineering instrument panels, not the AI register of gradients, glows and orbs. **Every interactive element
reports its state** (FR-023).

Light (`sheet`) and dark (`ink`) are peer themes, not a primary and an afterthought.

## `colors`

One brand colour; three machine colours **locked to state**, each defined for both themes (FR-024).

| Token         | Light                 | Dark                    | Meaning                                                                        |
| ------------- | --------------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `signal`      | `#1B4FE0`             | `#5C86FF`               | Every action, link and focus ring. The only decorative use of colour permitted |
| `signal-deep` | `#14369C`             | `#3A64E8`               | Pressed / active                                                               |
| `signal-wash` | `rgba(27,79,224,.08)` | `rgba(92,134,255,.13)`  | Selected and highlighted rows                                                  |
| `ink`         | `#0B1015`             | `#E7EAE6`               | Text. Blue-green undertone, never pure black                                   |
| `graphite`    | `#4E5A63`             | `#8B99A2`               | Secondary text and metadata                                                    |
| `sheet`       | `#F1F2EE`             | `#0B1015`               | Page base. A cool paper grey, deliberately not warm cream                      |
| `paper`       | `#FFFFFF`             | `#141B21`               | Card surface                                                                   |
| `paper-2`     | `#FAFAF8`             | `#101720`               | Inset surface                                                                  |
| `hairline`    | `rgba(11,16,21,.14)`  | `rgba(231,234,230,.14)` | Structure — borders do the work shadows would                                  |
| `hairline-hi` | `rgba(11,16,21,.30)`  | `rgba(231,234,230,.32)` | Emphasised hairline, control borders                                           |
| `amber`       | `#B4700F`             | `#E0A03C`               | **In flight** — running, validating, pending review                            |
| `verdigris`   | `#1F6E63`             | `#4FB3A2`               | **Passed** — healthy, deployed. Muted, never celebratory                       |
| `rust`        | `#A83A22`             | `#E0715A`               | **Failed / destructive** — earthy, so failure reads as fact not alarm          |
| `on-signal`   | `#FFFFFF`             | `#06090C`               | Text on a signal fill                                                          |
| `keycap`      | `rgba(0,0,0,.30)`     | `rgba(0,0,0,.45)`       | The button's inset bottom shade                                                |

**Locked-state rule (FR-025).** `amber`, `verdigris` and `rust` may **only** report machine state. Using a state
colour decoratively is a defect. Nothing is amber because amber looks nice — that single constraint is what lets
a page this technical stay legible with almost no illustration.

**Mapping to workflow state.** The state chip's colour derives from `workflow_state`, never from ad-hoc choice:

| State                               | Colour      |
| ----------------------------------- | ----------- |
| `queued`                            | `signal`    |
| `provisioning`, `running`, `paused` | `amber`     |
| `succeeded`                         | `verdigris` |
| `failed`, `capped`                  | `rust`      |
| `needs_attention`                   | `amber`     |
| `parked_resumable`, `cancelled`     | `graphite`  |

## `typography`

Two families, split by authorship: **Archivo** for anything a person wrote, **IBM Plex Mono** for anything a
machine produced (FR-026).

| Token          | Family        | Size / weight                                   | Use                                   |
| -------------- | ------------- | ----------------------------------------------- | ------------------------------------- |
| `display`      | Archivo       | 600, −0.038em, clamp(33px, 5.4vw, 54px), lh 1.0 | Page titles                           |
| `heading`      | Archivo       | 600, 20px, −0.025em                             | Section headings                      |
| `body`         | Archivo       | 400, 15px / 1.55, −0.005em, ~52ch measure       | Prose                                 |
| `label-mono`   | IBM Plex Mono | 500, 10.5px, uppercase, 0.11em                  | Field labels, eyebrows, table headers |
| `data-mono`    | IBM Plex Mono | 500, 11.5px                                     | Run ids, durations, counts, latencies |
| `label-button` | Archivo       | 600, 14px, −0.01em                              | Button labels — **sentence case**     |
| `code`         | IBM Plex Mono | 400, 12.5px / 1.5                               | Log viewer                            |

**The split is a rule, not a texture.** Uppercase mono is reserved for labels, metadata and state — which is
exactly why **buttons stay sentence-case in Archivo**. Mono button labels look sharp and scan badly.

## `spacing`

`hair: 2px`, `tight: 7px`, `close: 12px`, `default: 18px`, `section: 28px`, `band: 52px`,
`gutter: 28px`, `maxWidth: 1120px`.

## `rounded`

`sm: 3px` (data elements, fields), `md: 6px` (containers, cards), `lg: 10px` (floating surfaces).

**Instruments have small radii.** The roundest thing on the page is a radio button; **nothing is a full pill**
(FR-027).

## `components`

Declared in front matter, referencing token composites rather than restating values.

| Component          | Definition                                                                                                                                            |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `button-primary`   | `signal` fill, `on-signal` text, `label-button`, `rounded.sm`, `inset 0 -2px 0 keycap`. Hover → `signal-deep`. Active → 1px shade + `translateY(1px)` |
| `button-secondary` | `paper` fill, `hairline-hi` border, `inset 0 -2px 0 hairline`. Hover → `ink` border, `paper-2` fill                                                   |
| `button-quiet`     | No fill or border, `graphite` text. Hover → `ink` text on `signal-wash`                                                                               |
| `button-danger`    | Transparent, `rust` border and text. Hover → `rust` fill, `paper` text                                                                                |
| `state-chip`       | 6px square LED (`rounded` 1px) + `label-mono` readout, 1px `currentColor` border, `rounded` 2px, `paper` background                                   |
| `field-control`    | `paper` fill, `hairline-hi` border, `rounded.sm`, 10px/12px padding. Hover → `ink` border. Focus → `signal` border + 2px `signal-wash` ring           |
| `field-label`      | `label-mono` in `graphite`, above the control (FR-031)                                                                                                |
| `field-error`      | `rust` border; help text carries a **machine code and a next action**                                                                                 |
| `card`             | `paper` fill, 1px `hairline`, `rounded.md`, tinted `paper-2` header strip with 1px bottom hairline                                                    |
| `raised`           | `0 1px 2px rgba(11,16,21,.06), 0 8px 24px -12px rgba(11,16,21,.18)` — **the one elevation step**                                                      |
| `meter`            | 4px track in `hairline`, fill in `signal`                                                                                                             |
| `focus-ring`       | `2px solid signal` at `2px` offset — every focusable element                                                                                          |

**Signature element** (FR-030). The **state chip** — 6px square LED plus mono readout — appears everywhere state exists:
in buttons, fields, cards and headers (`IDLE`, `QUEUED 3`, `RUNNING 04:21`, `PASSED 1,284`, `FAILED 2`).

**Buttons** (FR-029). A 2px inset bottom shade that compresses on press — tactile, like a panel key. **No hover lift, no
glow, no gradient fill**; those read as consumer SaaS. One primary per view. An in-flight button's label becomes
a live readout rather than showing a spinner, because a spinner tells you nothing.

**Surfaces are border-led, not shadow-led.** Exactly one elevation step exists, reserved for things that genuinely
float — menus, popovers, modals — so elevation still means "temporary" (FR-028).

## Motion

`160ms` on state change, `60ms` on press, easing `cubic-bezier(.2,.7,.2,1)`.

The **only** looping animation in the system is the LED pulse, and it only ever means "working" — so when
something on the page moves, it is because a machine is doing work. No scroll-triggered reveals, no ambient
gradients. Under `prefers-reduced-motion` the pulse stops and the colour stays (FR-032).

## Implementation constraints

| Constraint                                                                                                   | Requirement    |
| ------------------------------------------------------------------------------------------------------------ | -------------- |
| Tokens as CSS variables consumed through the Tailwind theme (v3 is pinned workspace-wide, so no v4 `@theme`) | FR-021         |
| Zero literal colours, font sizes, spacing or radii in components                                             | FR-021, SC-015 |
| A design need with no token ⇒ add the token to `DESIGN.md` **first**, then consume                           | FR-021         |
| All UI from one shared primitive set; variants via `cva`                                                     | FR-033         |
| Class composition through a single shared `cn` (`clsx` + `tailwind-merge`)                                   | FR-033         |
| Precedence `DESIGN.md` → theme tokens → components; the document wins                                        | FR-021         |
| WCAG AA (4.5:1) for all text in **both** themes                                                              | FR-034, SC-015 |

## `design-lint`

Cached Nx target on the panel; linter a **pinned devDependency** — never `npx`, which resolves outside the
lockfile and is invisible to the affected graph (FR-022).

```json
"design-lint": {
  "executor": "nx:run-commands",
  "options": { "command": "design.md lint DESIGN.md", "cwd": "apps/sisyphus-admin" },
  "cache": true,
  "inputs": ["{projectRoot}/DESIGN.md"]
}
```

**Bar: zero errors** (FR-022). Expected findings and their dispositions:

| Finding                                                                           | Disposition                                                                        |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Contrast error on a component's text/background                                   | Real WCAG AA failure — fix the **token**, never relax the check                    |
| Unknown component property (`borderColor`, `borderWidth`, `hoverBackgroundColor`) | Accepted with a warning by the spec — explain in the Components prose              |
| `orphaned-tokens` on theme variants (dark pairs)                                  | Inherent to expressing two themes in a flat token map — explain once; not a defect |
| Missing-section warning                                                           | Add the section, or declare it in `omitted:` with a reason                         |
| Unknown extra `##` section                                                        | Preserved without error — fine to keep                                             |

A residual warning is acceptable **only** where the document's own prose explains it. Silent suppression is not.
