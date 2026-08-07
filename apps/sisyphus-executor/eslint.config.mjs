import { base, withTypeChecking } from '@bluetel-ai/eslint-config-base'

export default [{ ignores: ['dist/**'] }, ...base, ...withTypeChecking(import.meta.dirname)]
