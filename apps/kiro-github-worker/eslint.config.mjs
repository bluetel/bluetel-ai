import { base, withTypeChecking } from '@chalkboard/eslint-config-base'

export default [{ ignores: ['dist/**'] }, ...base, ...withTypeChecking(import.meta.dirname)]
