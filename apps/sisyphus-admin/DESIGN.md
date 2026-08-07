---
version: alpha
name: Sisyphus Panel
description: >-
  Instrumentation, not intelligence. The operator console for a fleet of autonomous coding
  agents, drawn from engineering instrument panels rather than the AI register of gradients,
  glows and orbs. Light (sheet) and dark (ink) are peer themes.
colors:
  signal: '#1B4FE0'
  signal-deep: '#14369C'
  signal-wash: 'rgba(27,79,224,0.08)'
  ink: '#0B1015'
  graphite: '#4E5A63'
  sheet: '#F1F2EE'
  paper: '#FFFFFF'
  paper-2: '#FAFAF8'
  hairline: 'rgba(11,16,21,0.14)'
  hairline-hi: 'rgba(11,16,21,0.30)'
  amber: '#99600A'
  verdigris: '#1F6E63'
  rust: '#A83A22'
  on-signal: '#FFFFFF'
  keycap: 'rgba(0,0,0,0.30)'
  signal-dark: '#5C86FF'
  signal-deep-dark: '#4A78F4'
  signal-wash-dark: 'rgba(92,134,255,0.13)'
  ink-dark: '#E7EAE6'
  graphite-dark: '#8B99A2'
  sheet-dark: '#0B1015'
  paper-dark: '#141B21'
  paper-2-dark: '#101720'
  hairline-dark: 'rgba(231,234,230,0.14)'
  hairline-hi-dark: 'rgba(231,234,230,0.32)'
  amber-dark: '#E0A03C'
  verdigris-dark: '#4FB3A2'
  rust-dark: '#E0715A'
  on-signal-dark: '#06090C'
  keycap-dark: 'rgba(0,0,0,0.45)'
typography:
  display:
    fontFamily: Archivo
    fontSize: 54px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-0.038em'
  heading:
    fontFamily: Archivo
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.25
    letterSpacing: '-0.025em'
  body:
    fontFamily: Archivo
    fontSize: 15px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: '-0.005em'
  label-mono:
    fontFamily: IBM Plex Mono
    fontSize: 10.5px
    fontWeight: 500
    lineHeight: 1.2
    letterSpacing: '0.11em'
  data-mono:
    fontFamily: IBM Plex Mono
    fontSize: 11.5px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: '0em'
  label-button:
    fontFamily: Archivo
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1
    letterSpacing: '-0.01em'
  code:
    fontFamily: IBM Plex Mono
    fontSize: 12.5px
    fontWeight: 400
    lineHeight: 1.5
spacing:
  hair: 2px
  tight: 7px
  close: 12px
  default: 18px
  section: 28px
  band: 52px
  gutter: 28px
  maxWidth: 1120px
rounded:
  sm: 3px
  md: 6px
  lg: 10px
components:
  page:
    backgroundColor: '{colors.sheet}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    padding: '{spacing.gutter}'
    width: '{spacing.maxWidth}'
  button-primary:
    backgroundColor: '{colors.signal}'
    textColor: '{colors.on-signal}'
    typography: '{typography.label-button}'
    rounded: '{rounded.sm}'
    padding: '{spacing.close}'
    shadowColor: '{colors.keycap}'
  button-primary-hover:
    backgroundColor: '{colors.signal-deep}'
    textColor: '{colors.on-signal}'
  button-primary-active:
    backgroundColor: '{colors.signal-deep}'
    textColor: '{colors.on-signal}'
  button-secondary:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.label-button}'
    rounded: '{rounded.sm}'
    padding: '{spacing.close}'
    borderColor: '{colors.hairline-hi}'
  button-secondary-hover:
    backgroundColor: '{colors.paper-2}'
    textColor: '{colors.ink}'
    borderColor: '{colors.ink}'
  button-quiet:
    textColor: '{colors.graphite}'
    typography: '{typography.label-button}'
    rounded: '{rounded.sm}'
    padding: '{spacing.close}'
  button-quiet-hover:
    backgroundColor: '{colors.signal-wash}'
  button-danger:
    textColor: '{colors.rust}'
    typography: '{typography.label-button}'
    rounded: '{rounded.sm}'
    padding: '{spacing.close}'
    borderColor: '{colors.rust}'
  button-danger-hover:
    backgroundColor: '{colors.rust}'
    textColor: '{colors.paper}'
  state-chip:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.graphite}'
    typography: '{typography.label-mono}'
    rounded: 2px
    padding: '{spacing.hair}'
    size: 6px
    borderColor: '{colors.hairline-hi}'
  state-chip-queued:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.signal}'
  state-chip-running:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.amber}'
  state-chip-passed:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.verdigris}'
  state-chip-failed:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.rust}'
  state-chip-parked:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.graphite}'
  field-control:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.sm}'
    padding: '{spacing.close}'
    borderColor: '{colors.hairline-hi}'
  field-control-hover:
    borderColor: '{colors.ink}'
  field-control-focus:
    borderColor: '{colors.signal}'
    ringColor: '{colors.signal-wash}'
  field-label:
    textColor: '{colors.graphite}'
    typography: '{typography.label-mono}'
  field-error:
    textColor: '{colors.rust}'
    typography: '{typography.data-mono}'
    borderColor: '{colors.rust}'
  panel-note:
    textColor: '{colors.graphite}'
    typography: '{typography.data-mono}'
  card:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    typography: '{typography.body}'
    rounded: '{rounded.md}'
    padding: '{spacing.default}'
    borderColor: '{colors.hairline}'
  card-header:
    backgroundColor: '{colors.paper-2}'
    textColor: '{colors.ink}'
    typography: '{typography.label-mono}'
    padding: '{spacing.close}'
    borderColor: '{colors.hairline}'
  raised:
    backgroundColor: '{colors.paper}'
    textColor: '{colors.ink}'
    rounded: '{rounded.lg}'
    padding: '{spacing.close}'
    boxShadow: 0 1px 2px rgba(11,16,21,0.06), 0 8px 24px -12px rgba(11,16,21,0.18)
  meter:
    backgroundColor: '{colors.hairline}'
    height: 4px
    rounded: '{rounded.sm}'
    fillColor: '{colors.signal}'
  log-viewer:
    backgroundColor: '{colors.paper-2}'
    textColor: '{colors.ink}'
    typography: '{typography.code}'
    rounded: '{rounded.md}'
    padding: '{spacing.close}'
  focus-ring:
    ringColor: '{colors.signal}'
---

# Sisyphus Panel

## Overview

The panel is an operator console. People come to it to answer three questions — what is running,
what needs me, and what did it cost — and they come back to it many times a day. It is read far
more often than it is admired, so the governing rule is **instrumentation, not intelligence**.

The vocabulary is borrowed from engineering instrument panels: hairline rules, mono readouts,
status LEDs, measured type, keys that compress when pressed. It is deliberately not the register
the industry has settled on for anything with a model behind it — gradients, glows, orbs,
iridescent borders, ambient motion. Those signal "something clever is happening here". This
product's claim is the opposite: something _legible_ is happening here, and you can audit it.

**Every interactive element reports its state.** A control that can be busy shows whether it is
busy; a control that can be refused shows why. The signature of the system is the state chip — a
6px square LED beside a mono readout — and it turns up wherever state exists, in buttons, in
fields, in card headers and in page headers.

Light (`sheet`) and dark (`ink`) are **peer themes**, not a default and an afterthought. Both are
specified to the same standard, both meet WCAG AA, and neither is derived from the other by
inversion. Operators run this console on a wall display at midday and on a laptop at 23:00; the
dark theme is the second of those, not a novelty.

The panel is dense but not cramped. Density comes from removing decoration, not from shrinking
type or tightening leading below what is comfortable to read.

## Colors

The palette is one brand colour and three machine colours, each defined for both themes.

- **Signal (`#1B4FE0` light / `#5C86FF` dark)** — every action, link and focus ring. This is the
  only decorative use of colour the system permits. `signal-deep` is its pressed/active state and
  `signal-wash` its selected-row tint.
- **Ink (`#0B1015` light / `#E7EAE6` dark)** — text. A blue-green undertone, never pure black,
  because pure black on a cool paper grey reads as a printing error.
- **Graphite (`#4E5A63` light / `#8B99A2` dark)** — secondary text and metadata.
- **Sheet (`#F1F2EE` light / `#0B1015` dark)** — the page base. A cool paper grey, deliberately
  not a warm cream; warmth would soften a document that is fundamentally a readout.
- **Paper / Paper-2 (`#FFFFFF` and `#FAFAF8` light; `#141B21` and `#101720` dark)** — card
  surface and inset surface.
- **Hairline / Hairline-hi** — structure. Borders do the work shadows would do elsewhere.
- **Amber (`#99600A` light / `#E0A03C` dark)** — **in flight**: running, validating, pending
  review.
- **Verdigris (`#1F6E63` light / `#4FB3A2` dark)** — **passed**: healthy, deployed. Muted, never
  celebratory; a green that congratulates you is a green you stop reading.
- **Rust (`#A83A22` light / `#E0715A` dark)** — **failed and destructive**. Earthy, so failure
  reads as a fact rather than an alarm.

### The locked-state rule

`amber`, `verdigris` and `rust` may **only** report machine state. A state colour used
decoratively is a defect, not a matter of taste. Nothing on this page is amber because amber
looks nice. That single constraint is what lets a document this technical stay legible with
almost no illustration: when colour appears, it means something, so the eye can trust it.

### Mapping to workflow state

A state chip's colour is derived from `workflow_state`. It is never an ad-hoc choice at the call
site, and a component that picks its own colour for a state is a review failure.

| `workflow_state`                    | Colour      |
| ----------------------------------- | ----------- |
| `queued`                            | `signal`    |
| `provisioning`, `running`, `paused` | `amber`     |
| `succeeded`                         | `verdigris` |
| `failed`, `capped`                  | `rust`      |
| `needs_attention`                   | `amber`     |
| `parked_resumable`, `cancelled`     | `graphite`  |

### Two themes in one flat token map

The token format is a flat map, so the dark theme is expressed as a `-dark` twin of every light
token (`ink` / `ink-dark`, `paper-2` / `paper-2-dark`, and so on). The theme layer selects a set;
nothing in a component ever names a `-dark` token directly.

This has one visible consequence at lint time. The `orphaned-tokens` rule reports a colour that
no component references, and **every `-dark` twin is reported**, because components are declared
once against the light names. Those warnings are inherent to expressing two themes in a flat
token map — they are not dead tokens, and removing them would delete the dark theme. This
paragraph is the explanation for all fifteen of them.

For the same reason the linter's `missing-primary` warning is expected and correct to leave
standing: this system's brand colour is called `signal`, not `primary`, because `signal` states
what the colour is _for_. Renaming it to satisfy a naming convention would cost the one thing the
palette has going for it — that every token name is a job description.

### Contrast

All text meets WCAG AA (4.5:1) in **both** themes, and two contract values were adjusted upward
to get there rather than relaxing the check:

- **`amber` light** is `#99600A` (was `#B4700F`). The original measured 3.99:1 on `paper` and
  3.55:1 on `sheet` — a failure in the single most-read chip in the product, the one that says
  `RUNNING`. The corrected value holds the same hue and measures 5.21:1 on `paper`, 4.98:1 on
  `paper-2` and 4.63:1 on `sheet`.
- **`signal-deep-dark`** is `#4A78F4` (was `#3A64E8`). In the dark theme the primary button's
  label is `on-signal-dark` (`#06090C`), so a _darker_ pressed fill loses contrast rather than
  gaining it; the original measured 3.96:1. The corrected value measures 5.02:1 and still reads
  as a distinct pressed state against `signal-dark`.

Measured worst cases at AA after those changes: `signal` on `paper` 6.48:1, `graphite` on `sheet`
6.30:1, `rust` on `paper` 6.38:1, `verdigris` on `paper` 6.05:1; in dark, `signal-dark` on
`paper-dark` 5.22:1, `rust-dark` on `paper-dark` 5.53:1, `graphite-dark` on `paper-dark` 5.94:1.

## Typography

Two families, split by **authorship**. Archivo is used for anything a person wrote. IBM Plex Mono
is used for anything a machine produced. A reader should be able to tell, without reading, which
of the two they are looking at.

- **Display and heading** — Archivo Semi-Bold, tightly tracked. `display` is specified here at
  its 54px ceiling; in implementation it is fluid, `clamp(33px, 5.4vw, 54px)`, because the token
  format takes a single dimension and the ceiling is the value worth pinning.
- **Body** — Archivo Regular at 15px/1.55, set to roughly a 52-character measure. Prose in this
  product is explanatory, not marketing, and a short measure is what makes it skimmable.
- **`label-mono`** — IBM Plex Mono at 10.5px, uppercase, 0.11em tracked. Field labels, eyebrows
  and table headers. Uppercase is a property of the token's usage rather than of the token
  itself, since the format has no case property; it is set by the primitive that consumes it.
- **`data-mono`** — IBM Plex Mono at 11.5px. Run ids, durations, counts, latencies. Tabular
  figures, so a column of numbers aligns.
- **`code`** — IBM Plex Mono at 12.5px/1.5, for the log viewer.
- **`label-button`** — Archivo Semi-Bold at 14px, **sentence case**.

**The split is a rule, not a texture.** Uppercase mono is reserved for labels, metadata and
state, which is exactly why **buttons stay sentence-case in Archivo**. Mono button labels look
sharp in a screenshot and scan badly in use — and a button is a thing a person is doing, not a
thing a machine reported.

## Layout

A single fixed-max-width column of `1120px` (`spacing.maxWidth`) with a `28px` gutter. The panel
is a document, not a dashboard grid: the fleet view is a table, the workflow view is a stack of
cards, and neither benefits from a masonry of tiles.

The spacing scale is deliberately not a doubling scale. It is eight named steps chosen for a
dense readout:

| Token      | Value    | Use                                              |
| ---------- | -------- | ------------------------------------------------ |
| `hair`     | `2px`    | Optical nudges, chip inner padding               |
| `tight`    | `7px`    | Within a control — icon to label, LED to readout |
| `close`    | `12px`   | Control padding, card header padding             |
| `default`  | `18px`   | Card padding, gap between related rows           |
| `section`  | `28px`   | Between sections within a page                   |
| `band`     | `52px`   | Between major bands of a page                    |
| `gutter`   | `28px`   | Page gutter                                      |
| `maxWidth` | `1120px` | Column ceiling                                   |

Named steps beat a numeric scale here because the names carry the intent: `tight` is what you
reach for inside a control and `section` is what you reach for between them, so the wrong choice
looks wrong while you are writing it. A design need with no token means the token gets added to
this document **first**, and consumed second.

## Elevation & Depth

**Surfaces are border-led, not shadow-led.** Hierarchy is carried by hairline rules and by the
`sheet` → `paper` → `paper-2` tonal progression. A card is a card because it is a lighter plane
inside a 1px hairline, not because it is floating.

Exactly **one** elevation step exists, `raised`:
`0 1px 2px rgba(11,16,21,0.06), 0 8px 24px -12px rgba(11,16,21,0.18)`. It is reserved for things
that genuinely float and will go away again — menus, popovers, modals. Keeping it to one step is
what preserves its meaning: on this page, a shadow means **temporary**. The moment a card gets a
shadow "for hierarchy", the shadow stops being information.

The one place depth is physical rather than optical is the button's 2px inset bottom shade
(`keycap`), which compresses on press. That is not elevation — nothing is floating — it is a key
with travel.

## Shapes

**Instruments have small radii.** Three levels, no more:

- `sm: 3px` — data elements and fields. The default.
- `md: 6px` — containers and cards.
- `lg: 10px` — floating surfaces, which is to say `raised`.

**Nothing is a full pill.** There is no `full` radius in this system and adding one would be a
change to this document, not a local styling decision. The roundest thing on the page is a radio
button. The state chip's LED is a 6px square with a 1px radius — square, because a round dot
reads as a bullet and a square reads as an indicator lamp.

Borders are uniformly `1px`; the variation is in the colour (`hairline` for structure,
`hairline-hi` for controls, `signal` for focus, `rust` for error), never in the width. Border
width is therefore stated once here rather than declared per component.

## Components

Every component below is declared in the front matter against the **light** token names and
references composites (`{typography.label-mono}`, `{colors.signal}`) rather than restating
values. All UI is built from one shared primitive set with variants expressed through `cva`, and
class composition goes through a single shared `cn`.

### Signature element — the state chip

The **state chip** is a 6px square LED plus a `label-mono` readout inside a 1px `currentColor`
border on a `paper` background, radius 2px. It appears everywhere state exists — `IDLE`,
`QUEUED 3`, `RUNNING 04:21`, `PASSED 1,284`, `FAILED 2`. Its five colour variants
(`state-chip-queued`, `-running`, `-passed`, `-failed`, `-parked`) are the front-matter encoding
of the `workflow_state` mapping table above; the base `state-chip` is the graphite idle case.

### Buttons

`button-primary` carries a 2px inset bottom shade in `keycap` that compresses on press, with a
1px downward translation — tactile, like a panel key. **No hover lift, no glow, no gradient
fill.** Those read as consumer SaaS and they undermine the claim the rest of the page is making.
One primary per view.

An in-flight button's label becomes a **live readout** rather than a spinner: `Running 04:21`,
not an indeterminate ring. A spinner tells you that something is happening, which you already
knew; the readout tells you how long it has been happening, which is the thing you actually
wanted.

`button-secondary` is a `paper` fill inside a `hairline-hi` border with a `hairline` inset shade.
`button-quiet` has no fill and no border. `button-danger` is transparent with a `rust` border and
`rust` label, filling with `rust` on hover.

### Fields

`field-label` is `label-mono` in `graphite`, **above** the control — never a placeholder standing
in for a label, and never floating. `field-control` focuses to a `signal` border plus a 2px
`signal-wash` ring. `field-error` puts a `rust` border on the control and help text that carries
a **machine code and a next action**, because "invalid input" is not a next action.

### Loading, empty and error

Every screen defines four states, not one. `panel-note` is the single line a card shows where its
rows would be — `data-mono` in `graphite` — and it has exactly two meanings, marked by `data-note`:
**loading** (`reading the user list`) and **empty** (`no users match that search`). They are the
same element in the same place at the same leading, so the moment a read settles nothing on the page
moves; the reading one carries `role="status"` because it appears without the operator acting.

There is no spinner, for the reason there is none in a button: an indeterminate ring says something
is happening, which the reader already knew. A card header's chip reads `reading` and the body says
what is being read.

The **error** state is `field-error` — a code and a next action — and it suppresses the empty note
rather than sitting above it. "No changes recorded" printed beside a refusal is the panel asserting
that nothing happened to somebody who came to find out whether something did.

### Why some of these carry lint warnings

Two classes of `design.md lint` warning are expected here and are documented rather than
suppressed.

**Unknown component properties.** The format's component sub-tokens are `backgroundColor`,
`textColor`, `typography`, `rounded`, `padding`, `size`, `height` and `width`. This system is
border-led, so `borderColor` is load-bearing on ten components; `shadowColor`, `boxShadow`,
`ringColor` and `fillColor` are similarly the actual definition of `button-primary`, `raised`,
`field-control-focus`, `focus-ring` and `meter`. The spec accepts unknown properties with a
warning, and losing them to silence the linter would mean the document no longer described the
components. They are declared as token references so they stay in the dependency graph.

**Translucent colours as backgrounds.** `signal-wash`, `hairline` and `keycap` are alpha overlays
that composite over an opaque surface at paint time. The linter's contrast check compares raw
values and cannot composite, so `button-quiet-hover` declares its `signal-wash` background
without a `textColor`: the pair that actually ships is `ink` over `signal-wash` composited on
`paper`, which is `#EDF1FC` and measures 18.1:1 — well past AA. Declaring it as a literal pair
would produce a false 2.95:1 failure and teach the next reader to distrust the check.

### Motion

`160ms` on state change, `60ms` on press, easing `cubic-bezier(.2,.7,.2,1)`.

The **only** looping animation in the system is the LED pulse, and it only ever means "working".
So when something on this page moves, it is because a machine is doing work — no scroll-triggered
reveals, no ambient gradients, no shimmer. Under `prefers-reduced-motion` the pulse stops and the
colour stays, so the information survives the animation being removed.

## Do's and Don'ts

- **Do** derive every state colour from `workflow_state` through the mapping table. **Don't**
  pick `amber` because a thing feels in-progress.
- **Do** use `amber`, `verdigris` and `rust` only to report machine state. **Don't** use them
  decoratively — not in an illustration, not in a marketing band, not in a chart series.
- **Do** consume tokens. **Don't** write a literal colour, font size, spacing value or radius in
  a component; if the need has no token, add the token to this document first.
- **Do** keep button labels sentence-case Archivo. **Don't** set them in uppercase mono — mono
  uppercase is reserved for labels, metadata and state.
- **Do** put a real readout in an in-flight button (`Running 04:21`). **Don't** use a spinner.
- **Do** let borders carry hierarchy. **Don't** add a shadow to a card; `raised` is for things
  that float and then disappear.
- **Do** keep one primary action per view. **Don't** put two `button-primary` instances on the
  same screen.
- **Do** label every field with `field-label` above the control. **Don't** use a placeholder as a
  label.
- **Do** give error help text a machine code and a next action. **Don't** ship "Something went
  wrong".
- **Do** keep radii at `sm`/`md`/`lg`. **Don't** introduce a pill; nothing is fully rounded.
- **Do** meet 4.5:1 in both themes and fix the **token** when a pair fails. **Don't** relax the
  check or nudge a component off its token.
- **Do** keep motion to the LED pulse. **Don't** add hover lifts, glows, gradient fills or
  ambient animation.
