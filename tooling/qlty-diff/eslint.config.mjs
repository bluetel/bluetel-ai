import { base, withTypeChecking } from '@bluetel-ai/eslint-config-internal'

export default [...base, ...withTypeChecking(import.meta.dirname)]
