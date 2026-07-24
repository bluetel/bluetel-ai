import { base, withTypeChecking } from '@chalkboard/eslint-config-internal'

export default [...base, ...withTypeChecking(import.meta.dirname)]
