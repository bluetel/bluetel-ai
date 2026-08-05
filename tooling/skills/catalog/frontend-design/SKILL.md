---
name: frontend-design
description: "Create distinctive, production-grade frontend interfaces with high design quality. Use when: building or styling web components, pages, layouts, or applications (landing pages, dashboards, React components, HTML/CSS), or beautifying any web UI. Works from the app's DESIGN.md and gates token changes on design-lint."
---

# Frontend Design

Implements real working code with exceptional attention to aesthetic detail, avoiding generic "AI
slop" aesthetics. In this repo, the aesthetic is **already decided and written down** — it lives in
the app's `DESIGN.md`. Read that first; invent only where it is silent.

## 1. DESIGN.md is the source of truth

Each app records its visual system in `apps/<app>/DESIGN.md`, conforming to the
[DESIGN.md spec](https://github.com/google-labs-code/design.md/blob/main/docs/spec.md)
(`version: alpha`). Check `apps/<app>/DESIGN.md` for the app you're working in before writing any UI.

Before writing any UI:

1. Read the front matter — `colors`, `typography`, `spacing`, `rounded`, `components`.
2. Build from those tokens. A literal hex, font size or radius in a component is a bug.
3. If the design needs something with no token, **add the token to `DESIGN.md` first**, then
   consume it. Do not fork the system inside a component.
4. Precedence when they disagree: `DESIGN.md` → `tailwind.config.js` / `globals.css` → components.
   The document wins; change the code, not the document.
5. Reference composites rather than restating them: `{typography.label-button}`, `{colors.primary}`.

The eight `##` body sections, each **at most once**, in order — a duplicate heading is a hard error:

> Overview · Colors · Typography · Layout · Elevation & Depth · Shapes · Components · Do's and Don'ts

An intentionally absent section goes in `omitted:` (bare string, or `{ section, reason }`) — never
an empty heading. The `Do's and Don'ts` section is where the system's non-negotiables live; read it
before proposing anything that contradicts it.

## 2. When there is no DESIGN.md

Only then does the aesthetic direction below apply in full — and the direction you choose gets
written up as a `DESIGN.md` alongside the code, not left implicit in class names.

### Design Thinking

Commit to a BOLD aesthetic direction:

- **Purpose**: What problem does this interface solve? Who uses it?
- **Tone**: Pick an extreme — brutally minimal, maximalist chaos, retro-futuristic, organic,
  luxury/refined, playful, editorial/magazine, brutalist, art deco, soft/pastel,
  industrial/utilitarian. Use these for inspiration; design one true to the direction.
- **Constraints**: Framework, performance, accessibility.
- **Differentiation**: What makes this UNFORGETTABLE? What is the one thing someone remembers?

**CRITICAL**: Choose a clear conceptual direction and execute it with precision. Bold maximalism and
refined minimalism both work — the key is intentionality, not intensity.

### Frontend Aesthetics Guidelines

- **Typography**: Fonts that are beautiful, unique and interesting. Avoid generic fonts like Arial
  and Inter; opt for distinctive, characterful choices. Pair a display font with a refined body font.
- **Color & Theme**: Commit to a cohesive palette via CSS variables. Dominant colours with sharp
  accents outperform timid, evenly-distributed palettes.
- **Motion**: Animations for effects and micro-interactions. CSS-only for HTML; Motion for React
  when available. Favour high-impact moments — one orchestrated page load with staggered reveals
  (`animation-delay`) beats scattered micro-interactions. Scroll triggers and surprising hovers.
- **Spatial Composition**: Unexpected layouts. Asymmetry, overlap, diagonal flow, grid-breaking
  elements. Generous negative space OR controlled density.
- **Backgrounds & Visual Details**: Atmosphere and depth over solid fills — gradient meshes, noise
  and grain, geometric patterns, layered transparencies, dramatic shadows, decorative borders,
  custom cursors.

NEVER use generic AI-generated aesthetics: overused font families (Inter, Roboto, Arial, system
fonts), cliched colour schemes (particularly purple gradients on white), predictable layouts and
component patterns, cookie-cutter design lacking context-specific character. Vary between light and
dark, different fonts, different aesthetics; never converge on common choices (Space Grotesk, for
example) across generations.

**IMPORTANT**: Match implementation complexity to the vision. Maximalist designs need elaborate code
with extensive animation; minimalist designs need restraint, precision and careful spacing.

## 3. Gate the change on `design-lint`

Any change to `DESIGN.md` — or to the CSS/Tailwind tokens derived from it — must pass the format's
own linter before the work is done:

```bash
design.md lint DESIGN.md
```

Run that from the app's directory, or via whatever your package/build manager wraps it in (an
npm/pnpm/yarn script, an Nx/Turborepo target, a Makefile rule) — so it runs alongside the app's
other checks (lint, typecheck, test) instead of being a step someone has to remember separately.

**Zero errors is the bar.** A residual warning is acceptable only if the document's own prose
explains it — suppressing it silently is not.

| Finding                                                                           | Action                                                                             |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Contrast error on a component's `textColor`/`backgroundColor`                     | Real WCAG AA failure. Fix the token — do not relax the check.                      |
| Unknown component property (`borderColor`, `borderWidth`, `hoverBackgroundColor`) | Accepted with a warning by the spec. Explain it in the Components prose.           |
| `orphaned-tokens` on theme variants (e.g. `-dark` suffixes)                       | Inherent to expressing two themes in a flat token map. Explain once; not a defect. |
| Missing-section warning                                                           | Add the section, or declare it in `omitted:` with a reason.                        |
| Unknown extra `##` section                                                        | Preserved without error — fine to keep.                                            |

If an app has no `design-lint` task yet, add one the same way its other per-app tasks (lint,
typecheck, test) are already defined. For a plain `package.json` script:

```json
"scripts": {
  "design-lint": "design.md lint DESIGN.md"
}
```

For a task runner with its own config (Nx shown as an example — adapt to whatever yours uses):

```json
"design-lint": {
  "executor": "nx:run-commands",
  "options": { "command": "design.md lint DESIGN.md", "cwd": "apps/<app>" },
  "cache": true,
  "inputs": ["{projectRoot}/DESIGN.md"]
}
```

`@google/design.md` must be a **pinned devDependency of that app** — never `npx`, which resolves
outside the lockfile and is invisible to your package/build manager's dependency-tracking graph.

---

Adapted from [boraoztunc/skills → frontend-design](https://github.com/boraoztunc/skills/tree/main/frontend-design)
(Apache-2.0, see `LICENSE.txt`). Modified to make the app's `DESIGN.md` the source of truth and to
gate changes on the `design-lint` Nx target.
