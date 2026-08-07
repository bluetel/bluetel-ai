/**
 * The Bun/Node boundary between the deployment tool's generated type tree and
 * our own code.
 *
 * ---------------------------------------------------------------------------
 * What goes wrong without this
 * ---------------------------------------------------------------------------
 * The generated tree has to be compiled — the ambient `sst.*` / `aws.*` globals
 * are declared nowhere else — and one file in it, `.sst/platform/src/config.ts`,
 * does `import type { Shell } from 'bun'`. That single import loads `@types/bun`
 * out of `.sst/platform/node_modules`, and `@types/bun` redeclares the runtime
 * globals: `Headers`, `Response`, `fetch`. From that point on, every one of our
 * Node source files is checked against Bun's DOM types instead of `@types/node`'s
 * — so a `Headers` built by `undici` no longer satisfies a parameter typed
 * `Headers`, and a `fetch` returning a Node `Response` no longer satisfies a
 * library expecting one. The errors surface in *our* files, nowhere near the
 * generated code that caused them, and they cannot be filtered by the loose
 * check without adding hand-written source to the loosely-checked globs — which
 * SC-061 forbids.
 *
 * ---------------------------------------------------------------------------
 * Why a stub is the right answer rather than a suppression
 * ---------------------------------------------------------------------------
 * The deployment tool's platform runs on Bun. Our deployables run on Node and on
 * Lambda. Those are two different runtimes that happen to be compiled in one
 * program, and the boundary is real: Bun's globals genuinely do not describe the
 * environment our code executes in. Naming that boundary is more accurate than
 * letting the last type declaration loaded decide what `fetch` returns.
 *
 * Each project's `tsconfig.json` maps the `bun` module here through `paths`. The
 * one symbol the generated tree actually imports is declared; nothing global is,
 * which is the entire point.
 */

/**
 * Placeholder for Bun's shell. The generated tree only mentions the type in a
 * field it never asks us to populate, so nothing is lost by leaving it opaque —
 * and giving it a real shape would mean redeclaring another runtime's API.
 */
export type Shell = unknown
