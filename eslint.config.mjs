import { base, withTypeChecking } from '@bluetel-ai/eslint-config-base'

export default [...base, ...withTypeChecking(import.meta.dirname)]
