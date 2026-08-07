import { base, withTypeChecking } from '@bluetel-ai/eslint-config-base'

// `.sst/` is the deployment tool's generated type tree. It has to be *compiled*
// — the ambient `sst.*` / `aws.*` globals are declared nowhere else, so
// excluding it from `tsconfig.json` would stop this package resolving them — but
// it is not ours to style, and linting it reports thousands of problems in code
// no one here can change. Compiled, loosely type-checked, never linted: all
// three, or the gate either breaks or silently stops checking (FR-198).
export default [{ ignores: ['.sst/**'] }, ...base, ...withTypeChecking(import.meta.dirname)]
